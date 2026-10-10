// Eaji — routes « argent » : paiements (manuels en attendant l'agrégateur), premium,
// vidéos payantes, ventes de contenus, cadeaux, dons, publicité des entreprises,
// gains des créateurs et portefeuille de transfert.
//
// PAIEMENT MANUEL : l'utilisateur envoie l'argent sur le numéro mobile money affiché
// (réglé par l'administrateur principal), avec la référence EJ-XXXXXX. L'administrateur
// vérifie la réception puis clique « Confirmer » : l'achat s'active automatiquement.

const crypto = require('crypto');
const M = require('./monetization');
const { isMonetizedCreator } = require('./world-countries');

// Le transfert d'argent entre personnes exige normalement un agrément de la Banque Centrale.
// Il reste éteint tant que TRANSFERS_ENABLED=true n'est pas mis sur Railway.
const TRANSFERS_ENABLED = process.env.TRANSFERS_ENABLED === 'true';
const TRANSFERS_DISABLED_MESSAGE =
  "Le transfert d'argent n'est pas encore ouvert. Il le sera dès que l'autorisation nécessaire sera obtenue.";

const MIGRATIONS = [
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS duration_seconds INTEGER',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,2)',
  `CREATE TABLE IF NOT EXISTS app_settings (
     key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS payment_requests (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     reference TEXT UNIQUE NOT NULL,
     payer_id UUID REFERENCES creators(id) ON DELETE SET NULL,
     purpose TEXT NOT NULL,
     target_id UUID,
     amount_usd NUMERIC(12,2) NOT NULL,
     amount_local NUMERIC(16,2) NOT NULL,
     currency TEXT NOT NULL,
     description TEXT NOT NULL,
     payer_phone TEXT,
     proof TEXT,
     status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente','confirme','refuse','annule')),
     admin_id UUID,
     admin_note TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     confirmed_at TIMESTAMPTZ)`,
  'ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_purpose_check',
  `ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_purpose_check CHECK (purpose IN
     ('premium_mois','premium_annee','entreprise_mois','entreprise_annee','video','achat','cadeau','don','annonce','depot'))`,
  `CREATE TABLE IF NOT EXISTS business_broadcasts (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     recipients INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS revenue_ledger (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     payment_id UUID,
     beneficiary TEXT NOT NULL CHECK (beneficiary IN ('eaji','createur')),
     creator_id UUID REFERENCES creators(id) ON DELETE SET NULL,
     source TEXT NOT NULL,
     amount_usd NUMERIC(12,2) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS premium_subscriptions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     plan TEXT NOT NULL,
     starts_at TIMESTAMPTZ NOT NULL,
     ends_at TIMESTAMPTZ NOT NULL,
     payment_id UUID,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS content_access (
     content_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     payment_id UUID,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (content_id, creator_id))`,
  `CREATE TABLE IF NOT EXISTS business_ads (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     company TEXT NOT NULL,
     message TEXT,
     media_key TEXT NOT NULL,
     media_type TEXT NOT NULL CHECK (media_type IN ('image','video')),
     link_url TEXT,
     country_code TEXT NOT NULL,
     plan TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente','actif','refuse','retire')),
     starts_at TIMESTAMPTZ,
     ends_at TIMESTAMPTZ,
     impressions INTEGER NOT NULL DEFAULT 0,
     clicks INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS wallet_entries (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     amount_usd NUMERIC(12,2) NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('depot','envoi','reception','retrait','remboursement')),
     counterpart_id UUID,
     payment_id UUID,
     note TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS withdrawal_requests (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     source TEXT NOT NULL CHECK (source IN ('gains','portefeuille')),
     amount_usd NUMERIC(12,2) NOT NULL,
     fee_usd NUMERIC(12,2) NOT NULL,
     net_usd NUMERIC(12,2) NOT NULL,
     currency TEXT NOT NULL,
     net_local NUMERIC(16,2) NOT NULL,
     method TEXT NOT NULL,
     account TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente','paye','refuse')),
     admin_id UUID,
     admin_note TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     processed_at TIMESTAMPTZ)`,
];

const PURPOSE_LABELS = {
  premium_mois: 'Abonnement premium 1 mois', premium_annee: 'Abonnement premium 1 an',
  entreprise_mois: 'Compte Entreprise 1 mois', entreprise_annee: 'Compte Entreprise 1 an',
  video: 'Vidéo payante', achat: 'Achat de contenu', cadeau: 'Cadeau à un créateur',
  don: 'Don à Eaji', annonce: 'Publicité entreprise', depot: 'Dépôt sur le portefeuille',
};

function newReference() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let ref = 'EJ-';
  for (const b of crypto.randomBytes(6)) ref += alphabet[b % alphabet.length];
  return ref;
}

function register({ app, db, pool, requireAuth, requireAdminPrincipal, optionalViewerId, createDownloadUrl, convertFromUSD, isSupportedCurrency }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Montant en devise locale (repli en dollars si le taux manque).
  function toLocal(usd, currency) {
    const c = String(currency || 'USD').toUpperCase();
    try { return { amount: convertFromUSD(Number(usd), c), currency: c }; }
    catch (e) { return { amount: Number(usd), currency: 'USD' }; }
  }

  async function getSetting(key) {
    const row = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return row ? row.value : null;
  }

  async function premiumUntil(creatorId) {
    if (!creatorId) return null;
    const row = await db.query(
      'SELECT MAX(ends_at) AS ends_at FROM premium_subscriptions WHERE creator_id = $1 AND ends_at > now()', [creatorId]);
    return row && row.ends_at ? row.ends_at : null;
  }

  async function businessUntil(creatorId) {
    if (!creatorId) return null;
    const row = await db.query(
      "SELECT MAX(ends_at) AS ends_at FROM premium_subscriptions WHERE creator_id = $1 AND ends_at > now() AND plan LIKE 'entreprise%'",
      [creatorId]);
    return row && row.ends_at ? row.ends_at : null;
  }

  // Le spectateur a-t-il accès à ce contenu payant ?
  //  - le créateur lui-même : toujours ;
  //  - premium : toutes les vidéos payantes selon la durée (mais pas les contenus mis en vente) ;
  //  - sinon : seulement s'il a payé (content_access).
  async function accessMap(viewerId, items) {
    const result = new Map();
    const isPremium = Boolean(await premiumUntil(viewerId));
    const paidIds = new Set();
    if (viewerId && items.length) {
      const rows = await db.all(
        'SELECT content_id FROM content_access WHERE creator_id = $1 AND content_id = ANY($2::uuid[])',
        [viewerId, `{${items.map((i) => i.id).join(',')}}`]);
      rows.forEach((r) => paidIds.add(r.content_id));
    }
    // Les créateurs hors des pays monétisés publient toujours gratuitement.
    const unknown = items.filter((i) => i.creator_monetized === undefined).map((i) => i.creator_id);
    const monetizedById = new Map();
    if (unknown.length) {
      const rows = await db.all('SELECT id, country_code, phone FROM creators WHERE id = ANY($1::uuid[])', [`{${[...new Set(unknown)].join(',')}}`]);
      rows.forEach((r) => monetizedById.set(r.id, isMonetizedCreator(r.country_code, r.phone)));
    }
    for (const item of items) {
      const monetized = item.creator_monetized !== undefined ? item.creator_monetized : Boolean(monetizedById.get(item.creator_id));
      const price = monetized ? M.accessPriceFor(item) : 0;
      const forSale = monetized && item.sale_price != null && Number(item.sale_price) > 0;
      const has = price === 0 || item.creator_id === viewerId || paidIds.has(item.id) || (isPremium && !forSale);
      result.set(item.id, { price, forSale, locked: !has });
    }
    return result;
  }

  // ---------- Tarifs (affichés dans l'application) ----------
  app.get('/api/pricing', async (req, res) => {
    const viewerId = optionalViewerId(req);
    let currency = String(req.query.currency || '').toUpperCase();
    if (!isSupportedCurrency(currency) && viewerId) {
      const me = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [viewerId]);
      currency = me ? me.gift_currency : 'USD';
    }
    if (!isSupportedCurrency(currency)) currency = 'USD';
    const rate = toLocal(1000000, currency);
    res.json({
      ...M.pricingSummary(),
      currency: rate.currency,
      usdRate: rate.amount / 1000000,
      transfersEnabled: TRANSFERS_ENABLED,
      paymentNumbers: await getSetting('payment_numbers'),
    });
  });

  // ---------- Paiements ----------
  app.post('/api/payments', requireAuth, async (req, res) => {
    const { purpose } = req.body;
    const targetId = req.body.targetId || null;
    if (!PURPOSE_LABELS[purpose]) return res.status(400).json({ error: 'Type de paiement inconnu.' });
    if (targetId && !UUID_RE.test(targetId)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const numbers = await getSetting('payment_numbers');
    if (!numbers) {
      return res.status(503).json({ error: "Le paiement n'est pas encore configuré. Réessaie un peu plus tard." });
    }
    const me = await db.query('SELECT id, gift_currency, phone FROM creators WHERE id = $1', [req.creatorId]);
    if (!me) return res.status(401).json({ error: 'Session invalide ou expirée.' });

    let amountUsd;
    let description = PURPOSE_LABELS[purpose];

    if (purpose === 'premium_mois' || purpose === 'premium_annee') {
      amountUsd = M.PREMIUM_PLANS[purpose].price;
    } else if (M.BUSINESS_PLANS[purpose]) {
      amountUsd = M.BUSINESS_PLANS[purpose].price;
    } else if (purpose === 'video' || purpose === 'achat' || purpose === 'cadeau') {
      if (!targetId) return res.status(400).json({ error: 'Contenu manquant.' });
      const content = await db.query(
        `SELECT c.*, cr.name AS creator_name, cr.country_code AS creator_country, cr.phone AS creator_phone FROM content_items c JOIN creators cr ON cr.id = c.creator_id
         WHERE c.id = $1 AND c.status = 'actif' AND cr.account_status = 'actif'`, [targetId]);
      if (!content) return res.status(404).json({ error: 'Contenu introuvable.' });
      if (content.creator_id === req.creatorId) {
        return res.status(400).json({ error: purpose === 'cadeau' ? "Tu ne peux pas t'envoyer un cadeau." : 'Ce contenu est déjà à toi.' });
      }
      content.creator_monetized = isMonetizedCreator(content.creator_country, content.creator_phone);
      if (purpose === 'cadeau') {
        if (!content.creator_monetized) {
          return res.status(400).json({ error: "Ce créateur ne peut pas encore recevoir de cadeaux : la monétisation n'est pas ouverte dans son pays." });
        }
        amountUsd = Number(req.body.amount);
        if (!M.GIFT_AMOUNTS.includes(amountUsd)) return res.status(400).json({ error: 'Montant de cadeau invalide.' });
        description = `Cadeau à ${content.creator_name}`;
      } else {
        const access = (await accessMap(req.creatorId, [content])).get(content.id);
        if (!access.locked) return res.status(400).json({ error: 'Tu as déjà accès à ce contenu.' });
        amountUsd = access.price;
        description = `${access.forSale ? 'Achat' : 'Vidéo'} : « ${content.title} »`;
      }
    } else if (purpose === 'don') {
      amountUsd = M.round2(req.body.amount);
      if (!(amountUsd >= M.DONATION_MIN) || amountUsd > 10000) return res.status(400).json({ error: `Le don minimum est de ${M.DONATION_MIN} $.` });
    } else if (purpose === 'annonce') {
      const ad = await db.query("SELECT * FROM business_ads WHERE id = $1 AND owner_id = $2 AND status = 'en_attente'", [targetId, req.creatorId]);
      if (!ad) return res.status(404).json({ error: 'Annonce introuvable.' });
      amountUsd = M.BUSINESS_AD_PLANS[ad.plan].price;
      description = `Publicité « ${ad.company} » (${M.BUSINESS_AD_PLANS[ad.plan].label})`;
    } else if (purpose === 'depot') {
      if (!TRANSFERS_ENABLED) return res.status(503).json({ error: TRANSFERS_DISABLED_MESSAGE });
      amountUsd = M.round2(req.body.amount);
      if (!(amountUsd >= 1) || amountUsd > 10000) return res.status(400).json({ error: 'Montant de dépôt invalide.' });
    }

    // Une demande identique déjà en attente est réutilisée (pas de doublon).
    const existing = await db.query(
      `SELECT * FROM payment_requests WHERE payer_id = $1 AND purpose = $2 AND target_id IS NOT DISTINCT FROM $3
         AND amount_usd = $4 AND status = 'en_attente' ORDER BY created_at DESC LIMIT 1`,
      [req.creatorId, purpose, targetId, amountUsd]);
    const local = toLocal(amountUsd, me.gift_currency);
    const payment = existing || await db.query(
      `INSERT INTO payment_requests (reference, payer_id, purpose, target_id, amount_usd, amount_local, currency, description, payer_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [newReference(), req.creatorId, purpose, targetId, amountUsd, local.amount, local.currency, description, me.phone]);
    res.status(existing ? 200 : 201).json({ payment: publicPayment(payment), paymentNumbers: numbers });
  });

  function publicPayment(p) {
    return {
      id: p.id, reference: p.reference, purpose: p.purpose, targetId: p.target_id, description: p.description,
      amountUsd: Number(p.amount_usd), amountLocal: Number(p.amount_local), currency: p.currency,
      status: p.status, proof: p.proof, payerPhone: p.payer_phone, adminNote: p.admin_note, createdAt: p.created_at,
    };
  }

  // L'utilisateur indique le numéro utilisé et l'identifiant de transaction reçu par SMS.
  app.post('/api/payments/:id/proof', requireAuth, async (req, res) => {
    const proof = String(req.body.proof || '').trim().slice(0, 120);
    const payerPhone = String(req.body.payerPhone || '').trim().slice(0, 30);
    if (proof.length < 4) return res.status(400).json({ error: "Indique l'identifiant de la transaction reçu par SMS." });
    const updated = await db.query(
      `UPDATE payment_requests SET proof = $1, payer_phone = COALESCE(NULLIF($2, ''), payer_phone)
       WHERE id = $3 AND payer_id = $4 AND status = 'en_attente' RETURNING *`,
      [proof, payerPhone, req.params.id, req.creatorId]);
    if (!updated) return res.status(404).json({ error: 'Paiement introuvable ou déjà traité.' });
    res.json({ payment: publicPayment(updated) });
  });

  app.post('/api/payments/:id/cancel', requireAuth, async (req, res) => {
    const updated = await db.query(
      "UPDATE payment_requests SET status = 'annule' WHERE id = $1 AND payer_id = $2 AND status = 'en_attente' RETURNING id",
      [req.params.id, req.creatorId]);
    if (!updated) return res.status(404).json({ error: 'Paiement introuvable ou déjà traité.' });
    res.json({ cancelled: true });
  });

  app.get('/api/payments/mine', requireAuth, async (req, res) => {
    const rows = await db.all('SELECT * FROM payment_requests WHERE payer_id = $1 ORDER BY created_at DESC LIMIT 50', [req.creatorId]);
    res.json({ payments: rows.map(publicPayment) });
  });

  // ---------- Premium ----------
  app.get('/api/premium/status', requireAuth, async (req, res) => {
    const until = await premiumUntil(req.creatorId);
    res.json({ active: Boolean(until), endsAt: until, plans: M.PREMIUM_PLANS });
  });

  // ---------- Compte Entreprise : statistiques et message à tous les abonnés ----------
  app.get('/api/business/status', requireAuth, async (req, res) => {
    const until = await businessUntil(req.creatorId);
    res.json({ active: Boolean(until), endsAt: until, plans: M.BUSINESS_PLANS });
  });

  async function requireBusiness(req, res, next) {
    if (!(await businessUntil(req.creatorId))) {
      return res.status(403).json({ error: 'Réservé aux comptes Entreprise.' });
    }
    next();
  }

  app.get('/api/business/stats', requireAuth, requireBusiness, async (req, res) => {
    const totals = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM follows WHERE followed_id = $1) AS followers,
         (SELECT COUNT(*)::int FROM follows WHERE followed_id = $1 AND created_at > now() - interval '30 days') AS new_followers_30d,
         (SELECT COALESCE(SUM(view_count), 0)::int FROM content_items WHERE creator_id = $1 AND status = 'actif') AS views,
         (SELECT COUNT(*)::int FROM content_likes l JOIN content_items c ON c.id = l.content_id WHERE c.creator_id = $1) AS likes,
         (SELECT COUNT(*)::int FROM content_comments m JOIN content_items c ON c.id = m.content_id WHERE c.creator_id = $1) AS comments,
         (SELECT COUNT(*)::int FROM content_items WHERE creator_id = $1 AND status = 'actif') AS contents`,
      [req.creatorId]);
    const top = await db.all(
      `SELECT c.title, c.view_count,
              (SELECT COUNT(*)::int FROM content_likes WHERE content_id = c.id) AS likes,
              (SELECT COUNT(*)::int FROM content_comments WHERE content_id = c.id) AS comments
       FROM content_items c WHERE c.creator_id = $1 AND c.status = 'actif'
       ORDER BY c.view_count DESC, c.created_at DESC LIMIT 10`, [req.creatorId]);
    const byCountry = await db.all(
      `SELECT cr.country_code, COUNT(*)::int AS followers FROM follows f JOIN creators cr ON cr.id = f.follower_id
       WHERE f.followed_id = $1 GROUP BY cr.country_code ORDER BY followers DESC LIMIT 10`, [req.creatorId]);
    const last = await db.query(
      'SELECT created_at FROM business_broadcasts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1', [req.creatorId]);
    res.json({ ...totals, top, byCountry, lastBroadcastAt: last ? last.created_at : null });
  });

  app.post('/api/business/broadcast', requireAuth, requireBusiness, async (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Message vide.' });
    const recent = await db.query(
      `SELECT 1 FROM business_broadcasts WHERE creator_id = $1 AND created_at > now() - ($2 || ' hours')::interval`,
      [req.creatorId, M.BROADCAST_EVERY_HOURS]);
    if (recent) return res.status(429).json({ error: 'Un seul message groupé par jour. Réessaie demain.' });
    // Envoyé à chaque abonné, sauf aux comptes bloqués dans un sens ou dans l'autre.
    const sent = await db.all(
      `INSERT INTO direct_messages (sender_id, recipient_id, text)
       SELECT $1, f.follower_id, $2 FROM follows f
       JOIN creators cr ON cr.id = f.follower_id AND cr.account_status = 'actif'
       WHERE f.followed_id = $1
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = f.follower_id)
                                                  OR (b.blocker_id = f.follower_id AND b.blocked_id = $1))
       RETURNING id`, [req.creatorId, text]);
    await db.query('INSERT INTO business_broadcasts (creator_id, text, recipients) VALUES ($1, $2, $3)', [req.creatorId, text, sent.length]);
    res.status(201).json({ sent: sent.length });
  });

  // ---------- Exécution d'un paiement confirmé ----------
  async function fulfill(p) {
    const ledger = (beneficiary, creatorId, source, amount) => amount > 0 && db.query(
      'INSERT INTO revenue_ledger (payment_id, beneficiary, creator_id, source, amount_usd) VALUES ($1, $2, $3, $4, $5)',
      [p.id, beneficiary, creatorId, source, amount]);
    const amount = Number(p.amount_usd);

    if (p.purpose === 'premium_mois' || p.purpose === 'premium_annee') {
      const plan = M.PREMIUM_PLANS[p.purpose];
      const from = (await premiumUntil(p.payer_id)) || new Date();
      await db.query(
        `INSERT INTO premium_subscriptions (creator_id, plan, starts_at, ends_at, payment_id)
         VALUES ($1, $2, $3::timestamptz, $3::timestamptz + ($4 || ' days')::interval, $5)`,
        [p.payer_id, p.purpose, new Date(from).toISOString(), plan.days, p.id]);
      await ledger('eaji', null, 'premium', amount);
    } else if (M.BUSINESS_PLANS[p.purpose]) {
      // Le compte Entreprise s'ajoute à la suite d'un éventuel abonnement Entreprise en cours.
      const plan = M.BUSINESS_PLANS[p.purpose];
      const from = (await businessUntil(p.payer_id)) || new Date();
      await db.query(
        `INSERT INTO premium_subscriptions (creator_id, plan, starts_at, ends_at, payment_id)
         VALUES ($1, $2, $3::timestamptz, $3::timestamptz + ($4 || ' days')::interval, $5)`,
        [p.payer_id, p.purpose, new Date(from).toISOString(), plan.days, p.id]);
      await ledger('eaji', null, 'entreprise', amount);
    } else if (p.purpose === 'video' || p.purpose === 'achat' || p.purpose === 'cadeau') {
      const content = await db.query('SELECT creator_id FROM content_items WHERE id = $1', [p.target_id]);
      const split = M.splitForCreator(amount);
      if (p.purpose === 'cadeau') {
        const recipient = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [content.creator_id]);
        const local = toLocal(split.creator, recipient ? recipient.gift_currency : 'USD');
        await db.query(
          'INSERT INTO gifts (from_creator_id, to_creator_id, content_id, amount, currency) VALUES ($1, $2, $3, $4, $5)',
          [p.payer_id, content.creator_id, p.target_id, local.amount, local.currency]);
      } else {
        await db.query(
          'INSERT INTO content_access (content_id, creator_id, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [p.target_id, p.payer_id, p.id]);
      }
      const source = { video: 'video', achat: 'vente', cadeau: 'cadeau' }[p.purpose];
      await ledger('eaji', null, source, split.eaji);
      await ledger('createur', content ? content.creator_id : null, source, split.creator);
    } else if (p.purpose === 'don') {
      await ledger('eaji', null, 'don', amount);
    } else if (p.purpose === 'annonce') {
      const ad = await db.query('SELECT plan FROM business_ads WHERE id = $1', [p.target_id]);
      const days = M.BUSINESS_AD_PLANS[ad.plan].days;
      await db.query(
        `UPDATE business_ads SET status = 'actif', starts_at = now(), ends_at = now() + ($1 || ' days')::interval WHERE id = $2`,
        [days, p.target_id]);
      await ledger('eaji', null, 'publicite', amount);
    } else if (p.purpose === 'depot') {
      const { fee, credited } = M.depositFee(amount);
      await db.query(
        "INSERT INTO wallet_entries (creator_id, amount_usd, kind, payment_id, note) VALUES ($1, $2, 'depot', $3, $4)",
        [p.payer_id, credited, p.id, `Dépôt ${p.reference} (frais ${fee} $)`]);
      await ledger('eaji', null, 'frais_depot', fee);
    }
  }

  // ---------- Gains des créateurs (60 % des cadeaux, vidéos et ventes) ----------
  async function earningsOf(creatorId) {
    const row = await db.query(
      `SELECT
         COALESCE((SELECT SUM(amount_usd) FROM revenue_ledger WHERE beneficiary = 'createur' AND creator_id = $1), 0) AS earned,
         COALESCE((SELECT SUM(amount_usd) FROM withdrawal_requests WHERE creator_id = $1 AND source = 'gains' AND status <> 'refuse'), 0) AS withdrawn`,
      [creatorId]);
    return { earned: Number(row.earned), withdrawn: Number(row.withdrawn), available: M.round2(Number(row.earned) - Number(row.withdrawn)) };
  }

  async function walletBalance(creatorId) {
    const row = await db.query('SELECT COALESCE(SUM(amount_usd), 0) AS balance FROM wallet_entries WHERE creator_id = $1', [creatorId]);
    return M.round2(row.balance);
  }

  async function payoutAccountOf(creatorId) {
    return db.query(
      'SELECT provider, aggregator, external_account_id FROM payout_accounts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1',
      [creatorId]);
  }

  app.get('/api/earnings', requireAuth, async (req, res) => {
    const me = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [req.creatorId]);
    const e = await earningsOf(req.creatorId);
    const history = await db.all(
      `SELECT source, amount_usd, created_at FROM revenue_ledger WHERE beneficiary = 'createur' AND creator_id = $1
       ORDER BY created_at DESC LIMIT 50`, [req.creatorId]);
    const withdrawals = await db.all(
      `SELECT id, source, amount_usd, fee_usd, net_usd, net_local, currency, method, status, created_at
       FROM withdrawal_requests WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.creatorId]);
    res.json({
      ...e, availableLocal: toLocal(e.available, me.gift_currency),
      feeRate: M.withdrawalFee(1, 'gains').rate, minimum: M.WITHDRAWAL_MIN,
      history, withdrawals, payoutAccount: await payoutAccountOf(req.creatorId),
    });
  });

  // Une seule opération d'argent à la fois par compte (évite de retirer deux fois le même solde).
  async function withAccountLock(creatorId, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) l', [String(creatorId)]);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function createWithdrawal(req, res, source) {
    const amountUsd = M.round2(req.body.amount);
    if (!(amountUsd >= M.WITHDRAWAL_MIN)) return res.status(400).json({ error: `Le retrait minimum est de ${M.WITHDRAWAL_MIN} $.` });
    const account = await payoutAccountOf(req.creatorId);
    if (!account) return res.status(400).json({ error: 'Enregistre d\'abord ton mode de retrait (Profil → Mode de retrait).' });
    const me = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [req.creatorId]);
    const outcome = await withAccountLock(req.creatorId, async () => {
      const available = source === 'gains' ? (await earningsOf(req.creatorId)).available : await walletBalance(req.creatorId);
      if (amountUsd > available) return { error: `Solde insuffisant (disponible : ${available} $).` };
      const { fee, net } = M.withdrawalFee(amountUsd, source);
      const local = toLocal(net, me.gift_currency);
      const method = account.provider === 'mobile_money' ? `Mobile money${account.aggregator ? ' (' + account.aggregator + ')' : ''}` : 'Virement bancaire';
      const w = await db.query(
        `INSERT INTO withdrawal_requests (creator_id, source, amount_usd, fee_usd, net_usd, currency, net_local, method, account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [req.creatorId, source, amountUsd, fee, net, local.currency, local.amount, method, account.external_account_id]);
      if (source === 'portefeuille') {
        await db.query(
          "INSERT INTO wallet_entries (creator_id, amount_usd, kind, note) VALUES ($1, $2, 'retrait', $3)",
          [req.creatorId, -amountUsd, `Retrait ${w.id}`]);
      }
      return { withdrawal: w };
    });
    if (outcome.error) return res.status(400).json({ error: outcome.error });
    const w = outcome.withdrawal;
    res.status(201).json({
      withdrawalId: w.id, amountUsd: Number(w.amount_usd), feeUsd: Number(w.fee_usd), netUsd: Number(w.net_usd),
      netLocal: Number(w.net_local), currency: w.currency, status: w.status,
    });
  }

  app.post('/api/earnings/withdraw', requireAuth, (req, res) => createWithdrawal(req, res, 'gains'));

  // ---------- Portefeuille (transfert d'argent) — éteint par défaut ----------
  function requireTransfers(req, res, next) {
    if (!TRANSFERS_ENABLED) return res.status(503).json({ error: TRANSFERS_DISABLED_MESSAGE });
    next();
  }

  app.get('/api/wallet', requireAuth, async (req, res) => {
    const me = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [req.creatorId]);
    const balance = await walletBalance(req.creatorId);
    const entries = await db.all(
      `SELECT w.amount_usd, w.kind, w.note, w.created_at, cr.name AS counterpart_name
       FROM wallet_entries w LEFT JOIN creators cr ON cr.id = w.counterpart_id
       WHERE w.creator_id = $1 ORDER BY w.created_at DESC LIMIT 50`, [req.creatorId]);
    res.json({
      enabled: TRANSFERS_ENABLED, message: TRANSFERS_ENABLED ? null : TRANSFERS_DISABLED_MESSAGE,
      balance, balanceLocal: toLocal(balance, me.gift_currency),
      depositFee: 0.02, withdrawalFee: 0.04, entries,
    });
  });

  app.post('/api/wallet/send', requireAuth, requireTransfers, async (req, res) => {
    const amountUsd = M.round2(req.body.amount);
    const to = String(req.body.to || '').trim();
    if (!(amountUsd >= 0.5)) return res.status(400).json({ error: 'Montant invalide.' });
    const recipient = await db.query(
      "SELECT id, name FROM creators WHERE (lower(email) = lower($1) OR phone = $2) AND account_status = 'actif'",
      [to, to.replace(/[\s.-]/g, '')]);
    if (!recipient) return res.status(404).json({ error: 'Aucun compte Eaji avec cet email ou ce numéro.' });
    if (recipient.id === req.creatorId) return res.status(400).json({ error: "Tu ne peux pas t'envoyer de l'argent." });
    const outcome = await withAccountLock(req.creatorId, async () => {
      const balance = await walletBalance(req.creatorId);
      if (amountUsd > balance) return { error: `Solde insuffisant (disponible : ${balance} $).` };
      await db.query(
        "INSERT INTO wallet_entries (creator_id, amount_usd, kind, counterpart_id) VALUES ($1, $2, 'envoi', $3)",
        [req.creatorId, -amountUsd, recipient.id]);
      await db.query(
        "INSERT INTO wallet_entries (creator_id, amount_usd, kind, counterpart_id) VALUES ($1, $2, 'reception', $3)",
        [recipient.id, amountUsd, req.creatorId]);
      return {};
    });
    if (outcome.error) return res.status(400).json({ error: outcome.error });
    res.status(201).json({ sent: true, to: recipient.name, amountUsd });
  });

  app.post('/api/wallet/withdraw', requireAuth, requireTransfers, (req, res) => createWithdrawal(req, res, 'portefeuille'));

  // ---------- Publicité des entreprises ----------
  app.post('/api/business-ads', requireAuth, async (req, res) => {
    const company = String(req.body.company || '').trim().slice(0, 80);
    const message = String(req.body.message || '').trim().slice(0, 200);
    const linkUrl = String(req.body.linkUrl || '').trim().slice(0, 300);
    const countryCode = String(req.body.countryCode || '').toUpperCase();
    const { plan, mediaKey, mediaType } = req.body;
    if (!company) return res.status(400).json({ error: "Indique le nom de l'entreprise." });
    if (!M.BUSINESS_AD_PLANS[plan]) return res.status(400).json({ error: 'Choisis une durée de publicité.' });
    if (!/^[A-Z]{2}$/.test(countryCode) && countryCode !== 'ALL') return res.status(400).json({ error: 'Choisis le pays de diffusion.' });
    if (!['image', 'video'].includes(mediaType) || !mediaKey) return res.status(400).json({ error: 'Ajoute une bannière (image) ou une vidéo.' });
    if (!String(mediaKey).startsWith(`${req.creatorId}/`)) return res.status(403).json({ error: 'Fichier non autorisé.' });
    if (linkUrl && !/^https?:\/\//i.test(linkUrl)) return res.status(400).json({ error: 'Le lien doit commencer par https://' });
    const ad = await db.query(
      `INSERT INTO business_ads (owner_id, company, message, media_key, media_type, link_url, country_code, plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.creatorId, company, message || null, mediaKey, mediaType, linkUrl || null, countryCode, plan]);
    res.status(201).json({ adId: ad.id, price: M.BUSINESS_AD_PLANS[plan].price });
  });

  app.get('/api/business-ads/mine', requireAuth, async (req, res) => {
    const ads = await db.all(
      `SELECT id, company, message, media_type, link_url, country_code, plan, status, starts_at, ends_at, impressions, clicks, created_at
       FROM business_ads WHERE owner_id = $1 ORDER BY created_at DESC`, [req.creatorId]);
    res.json({ ads });
  });

  app.post('/api/business-ads/:id/click', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    await db.query('UPDATE business_ads SET clicks = clicks + 1 WHERE id = $1', [req.params.id]);
    res.json({ counted: true });
  });

  // Annonces à placer dans le fil (pays choisi, ou toutes si « Partout »).
  async function adsForFeed(country) {
    const ads = await db.all(
      `SELECT id, company, message, media_key, media_type, link_url, country_code FROM business_ads
       WHERE status = 'actif' AND ends_at > now() AND ($1::text IS NULL OR country_code = $1 OR country_code = 'ALL')
       ORDER BY random() LIMIT 5`, [country]);
    for (const ad of ads) {
      ad.mediaUrl = await createDownloadUrl(ad.media_key).catch(() => null);
      delete ad.media_key;
    }
    if (ads.length) {
      await db.query('UPDATE business_ads SET impressions = impressions + 1 WHERE id = ANY($1::uuid[])', [`{${ads.map((a) => a.id).join(',')}}`]);
    }
    return ads;
  }

  // ---------- Administration (administrateur principal uniquement) ----------
  app.get('/api/admin/settings/payment-numbers', requireAdminPrincipal, async (req, res) => {
    res.json({ paymentNumbers: await getSetting('payment_numbers') });
  });

  app.put('/api/admin/settings/payment-numbers', requireAdminPrincipal, async (req, res) => {
    const value = String(req.body.paymentNumbers || '').trim().slice(0, 500);
    if (!value) {
      await db.query("DELETE FROM app_settings WHERE key = 'payment_numbers'");
    } else {
      await db.query(
        `INSERT INTO app_settings (key, value) VALUES ('payment_numbers', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [value]);
    }
    res.json({ saved: true });
  });

  app.get('/api/admin/payments', requireAdminPrincipal, async (req, res) => {
    const status = ['en_attente', 'confirme', 'refuse', 'annule'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.all(
      `SELECT p.*, cr.name AS payer_name, cr.email AS payer_email FROM payment_requests p
       LEFT JOIN creators cr ON cr.id = p.payer_id
       WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.created_at DESC LIMIT 200`, [status]);
    res.json({ payments: rows.map((p) => ({ ...publicPayment(p), payerName: p.payer_name, payerEmail: p.payer_email, confirmedAt: p.confirmed_at })) });
  });

  app.post('/api/admin/payments/:id/confirm', requireAdminPrincipal, async (req, res) => {
    // Le passage « en attente → confirmé » est atomique : un double clic ne compte jamais deux fois.
    const p = await db.query(
      `UPDATE payment_requests SET status = 'confirme', confirmed_at = now(), admin_id = $2, admin_note = $3
       WHERE id = $1 AND status = 'en_attente' RETURNING *`,
      [req.params.id, req.adminId, String(req.body.note || '').slice(0, 200) || null]);
    if (!p) return res.status(404).json({ error: 'Paiement introuvable ou déjà traité.' });
    try {
      await fulfill(p);
    } catch (e) {
      await db.query("UPDATE payment_requests SET status = 'en_attente', confirmed_at = NULL WHERE id = $1", [p.id]);
      throw e;
    }
    res.json({ confirmed: true });
  });

  app.post('/api/admin/payments/:id/refuse', requireAdminPrincipal, async (req, res) => {
    const p = await db.query(
      `UPDATE payment_requests SET status = 'refuse', admin_id = $2, admin_note = $3
       WHERE id = $1 AND status = 'en_attente' RETURNING id`,
      [req.params.id, req.adminId, String(req.body.note || '').slice(0, 200) || 'Paiement non reçu.']);
    if (!p) return res.status(404).json({ error: 'Paiement introuvable ou déjà traité.' });
    res.json({ refused: true });
  });

  app.get('/api/admin/withdrawals', requireAdminPrincipal, async (req, res) => {
    const status = ['en_attente', 'paye', 'refuse'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.all(
      `SELECT w.*, cr.name AS creator_name, cr.phone AS creator_phone FROM withdrawal_requests w
       JOIN creators cr ON cr.id = w.creator_id
       WHERE ($1::text IS NULL OR w.status = $1) ORDER BY w.created_at DESC LIMIT 200`, [status]);
    res.json({ withdrawals: rows });
  });

  app.post('/api/admin/withdrawals/:id/paid', requireAdminPrincipal, async (req, res) => {
    const w = await db.query(
      `UPDATE withdrawal_requests SET status = 'paye', processed_at = now(), admin_id = $2, admin_note = $3
       WHERE id = $1 AND status = 'en_attente' RETURNING *`,
      [req.params.id, req.adminId, String(req.body.note || '').slice(0, 200) || null]);
    if (!w) return res.status(404).json({ error: 'Retrait introuvable ou déjà traité.' });
    await db.query(
      'INSERT INTO revenue_ledger (beneficiary, creator_id, source, amount_usd) VALUES ($1, $2, $3, $4)',
      ['eaji', w.creator_id, w.source === 'portefeuille' ? 'frais_retrait_portefeuille' : 'frais_retrait', w.fee_usd]);
    res.json({ paid: true });
  });

  app.post('/api/admin/withdrawals/:id/refuse', requireAdminPrincipal, async (req, res) => {
    const w = await db.query(
      `UPDATE withdrawal_requests SET status = 'refuse', processed_at = now(), admin_id = $2, admin_note = $3
       WHERE id = $1 AND status = 'en_attente' RETURNING *`,
      [req.params.id, req.adminId, String(req.body.note || '').slice(0, 200) || null]);
    if (!w) return res.status(404).json({ error: 'Retrait introuvable ou déjà traité.' });
    if (w.source === 'portefeuille') {
      await db.query(
        "INSERT INTO wallet_entries (creator_id, amount_usd, kind, note) VALUES ($1, $2, 'remboursement', 'Retrait refusé')",
        [w.creator_id, w.amount_usd]);
    }
    res.json({ refused: true });
  });

  app.get('/api/admin/business-ads', requireAdminPrincipal, async (req, res) => {
    const ads = await db.all(
      `SELECT a.id, a.company, a.message, a.media_type, a.link_url, a.country_code, a.plan, a.status,
              a.starts_at, a.ends_at, a.impressions, a.clicks, a.created_at, cr.name AS owner_name
       FROM business_ads a JOIN creators cr ON cr.id = a.owner_id ORDER BY a.created_at DESC LIMIT 200`);
    res.json({ ads });
  });

  app.post('/api/admin/business-ads/:id/remove', requireAdminPrincipal, async (req, res) => {
    const ad = await db.query("UPDATE business_ads SET status = 'retire' WHERE id = $1 RETURNING id", [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Annonce introuvable.' });
    res.json({ removed: true });
  });

  app.get('/api/admin/revenue', requireAdminPrincipal, async (req, res) => {
    const bySource = await db.all(
      `SELECT source, SUM(amount_usd)::float AS total, COUNT(*)::int AS count FROM revenue_ledger
       WHERE beneficiary = 'eaji' GROUP BY source ORDER BY total DESC`);
    const totals = await db.query(
      `SELECT
         COALESCE((SELECT SUM(amount_usd) FROM revenue_ledger WHERE beneficiary = 'eaji'), 0)::float AS eaji_total,
         COALESCE((SELECT SUM(amount_usd) FROM revenue_ledger WHERE beneficiary = 'createur'), 0)::float AS creators_earned,
         COALESCE((SELECT SUM(amount_usd) FROM withdrawal_requests WHERE status = 'paye'), 0)::float AS paid_out,
         COALESCE((SELECT SUM(net_usd) FROM withdrawal_requests WHERE status = 'en_attente'), 0)::float AS pending_withdrawals,
         (SELECT COUNT(*)::int FROM withdrawal_requests WHERE status = 'en_attente') AS pending_withdrawal_count,
         (SELECT COUNT(*)::int FROM payment_requests WHERE status = 'en_attente') AS pending_payments,
         (SELECT COUNT(DISTINCT creator_id)::int FROM premium_subscriptions WHERE ends_at > now() AND plan LIKE 'premium%') AS premium_members,
         (SELECT COUNT(DISTINCT creator_id)::int FROM premium_subscriptions WHERE ends_at > now() AND plan LIKE 'entreprise%') AS business_members,
         (SELECT COUNT(*)::int FROM business_ads WHERE status = 'actif' AND ends_at > now()) AS active_ads,
         COALESCE((SELECT SUM(amount_usd) FROM wallet_entries), 0)::float AS wallets_total`);
    res.json({ ...totals, bySource, transfersEnabled: TRANSFERS_ENABLED });
  });

  return { accessMap, premiumUntil, businessUntil, adsForFeed, MAX_VIDEO_SECONDS: M.MAX_VIDEO_SECONDS };
}

module.exports = { register, MIGRATIONS, TRANSFERS_ENABLED };
