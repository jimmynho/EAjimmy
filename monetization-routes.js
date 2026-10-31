// Eaji — routes « argent » : paiements (manuels en attendant l'agrégateur), premium,
// vidéos payantes, ventes de contenus, cadeaux, dons, publicité des entreprises,
// gains des créateurs et portefeuille de transfert.
//
// PAIEMENT MANUEL : l'utilisateur envoie l'argent sur le numéro mobile money affiché
// (réglé par l'administrateur principal), avec la référence EJ-XXXXXX. L'administrateur
// vérifie la réception puis clique « Confirmer » : l'achat s'active automatiquement.

const crypto = require('crypto');
const M = require('./monetization');
const G = require('./payment-gateways');
const { isMonetizedCreator, ZONES, zoneOf } = require('./world-countries');

// SOLDE EAJI : chacun peut déposer de l'argent (2 % de frais) et l'utiliser DANS Eaji
// (cadeaux, vidéos, achats, premium, publicité) sans attendre de confirmation à chaque fois.
// Le transfert d'argent entre personnes et le retrait du solde en argent exigent normalement
// un agrément de la Banque Centrale : ils restent éteints tant que TRANSFERS_ENABLED=true
// n'est pas mis sur Railway.
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
     ('premium_mois','premium_trimestre','premium_annee','entreprise_mois','entreprise_annee','video','achat','cadeau','cadeau_live','don','annonce','depot'))`,
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
  'ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS note TEXT', // raison d'une correction faite par l'administrateur
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
  'ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_kind_check',
  `ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN
     ('depot','envoi','reception','retrait','remboursement','achat'))`,
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
  // Paiements en ligne réels (pawaPay mobile money, PayPal carte/compte).
  'ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS method TEXT',
  'ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS gateway_status TEXT',
  'ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS gateway_failure TEXT',
  `CREATE TABLE IF NOT EXISTS payment_attempts (
     gateway_id TEXT PRIMARY KEY,
     payment_id UUID NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
     gateway TEXT NOT NULL CHECK (gateway IN ('pawapay', 'paypal')),
     provider TEXT,
     amount TEXT NOT NULL,
     currency TEXT NOT NULL,
     phone TEXT,
     status TEXT NOT NULL DEFAULT 'INITIE',
     failure TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS payment_attempts_payment ON payment_attempts (payment_id)',
  // Retraits des revenus d'Eaji par l'administrateur principal.
  `CREATE TABLE IF NOT EXISTS admin_payouts (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     admin_id UUID,
     amount_usd NUMERIC(12,2) NOT NULL,
     method TEXT NOT NULL CHECK (method IN ('mobile_money', 'banque')),
     destination TEXT NOT NULL,
     provider TEXT,
     gateway_id TEXT UNIQUE,
     status TEXT NOT NULL CHECK (status IN ('en_cours', 'a_faire', 'paye', 'echoue')),
     note TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     done_at TIMESTAMPTZ)`,
  // Retraits des créateurs envoyés automatiquement par pawaPay.
  'ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS gateway_id TEXT',
  'ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS gateway_status TEXT',
  // Sécurité des retraits (anti-piratage) : retrait mis en attente 24 h après un changement de numéro de retrait
  // ou depuis un appareil nouveau pour le compte ; le vrai propriétaire peut tout annuler.
  'ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ',
  'ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS hold_reason TEXT',
  `CREATE TABLE IF NOT EXISTS payout_changes (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     old_provider TEXT, old_aggregator TEXT, old_account TEXT, new_account TEXT,
     device_key TEXT, session_id UUID,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     cancelled_at TIMESTAMPTZ)`,
  'CREATE INDEX IF NOT EXISTS payout_changes_creator ON payout_changes (creator_id, created_at DESC)',
  // CinetPay (mobile money RDC + cartes Visa/Mastercard) en plus de pawaPay et PayPal.
  'ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_gateway_check',
  "ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_gateway_check CHECK (gateway IN ('pawapay', 'paypal', 'cinetpay'))",
  // Espace publicitaire (formules basique / standard / illimité) payé en ligne comme le reste.
  'ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_purpose_check',
  `ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_purpose_check CHECK (purpose IN
     ('premium_mois','premium_trimestre','premium_annee','entreprise_mois','entreprise_annee','video','achat','cadeau','cadeau_live','don','annonce','depot',
      'pub_basique','pub_standard','pub_illimite'))`,
  // Argent non réel (paiements confirmés à la main, commissions d'ouverture jamais payées) : retiré des soldes,
  // mais gardé ici pour l'historique.
  'ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS non_reel BOOLEAN NOT NULL DEFAULT FALSE',
  `CREATE TABLE IF NOT EXISTS money_cleanup_archive (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     kind TEXT NOT NULL,
     data JSONB NOT NULL,
     admin_id UUID,
     cleaned_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'ALTER TABLE ad_payments ADD COLUMN IF NOT EXISTS payment_id UUID',
  // Essai Entreprise (premier mois, une seule fois par compte).
  'ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_purpose_check',
  `ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_purpose_check CHECK (purpose IN
     ('premium_mois','premium_trimestre','premium_annee','entreprise_essai','entreprise_mois','entreprise_annee','video','achat','cadeau','cadeau_live','don','annonce','depot',
      'pub_basique','pub_standard','pub_illimite'))`,
  // Essais du premier mois : Premium 2 $, espace publicitaire 5 $ (une seule fois par compte).
  'ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_purpose_check',
  `ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_purpose_check CHECK (purpose IN
     ('premium_essai','premium_mois','premium_trimestre','premium_annee','entreprise_essai','entreprise_mois','entreprise_annee','video','achat','cadeau','cadeau_live','don','annonce','depot',
      'pub_essai','pub_basique','pub_standard','pub_illimite'))`,
  // Abonnement Montage IA (10 $ / mois, 30 $ / 3 mois, 100 $ / an).
  'ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_purpose_check',
  `ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_purpose_check CHECK (purpose IN
     ('premium_essai','premium_mois','premium_trimestre','premium_annee','entreprise_essai','entreprise_mois','entreprise_annee','video','achat','cadeau','cadeau_live','don','annonce','depot',
      'pub_essai','pub_basique','pub_standard','pub_illimite','montage_mois','montage_trimestre','montage_annee'))`,
  `CREATE TABLE IF NOT EXISTS montage_subscriptions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     plan TEXT NOT NULL,
     starts_at TIMESTAMPTZ NOT NULL,
     ends_at TIMESTAMPTZ NOT NULL,
     payment_id UUID,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS montage_subscriptions_creator ON montage_subscriptions (creator_id, ends_at)',
  // Ciblage des publicités d'entreprise : une ville, un pays, un continent ou partout.
  'ALTER TABLE business_ads ADD COLUMN IF NOT EXISTS target_scope TEXT',
  'ALTER TABLE business_ads ADD COLUMN IF NOT EXISTS target_city TEXT',
  'ALTER TABLE business_ads ADD COLUMN IF NOT EXISTS target_city_norm TEXT',
  'ALTER TABLE business_ads ADD COLUMN IF NOT EXISTS target_continent TEXT',
  // Publicités d'avant : un pays précis, ou « Partout ».
  "UPDATE business_ads SET target_scope = CASE WHEN country_code = 'ALL' THEN 'partout' ELSE 'pays' END WHERE target_scope IS NULL",
];
// Nom de ville comparable : sans accents, majuscules ni espaces en trop (« Kinshasa », « kinshasa ») .
const cityNorm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const AD_SCOPES = ['ville', 'pays', 'continent', 'partout'];
// Moyens de paiement en ligne réels : seuls ceux-là font entrer de l'argent.
const ONLINE_METHODS = ['mobile_money', 'paypal', 'cinetpay'];
// Formules de l'espace publicitaire (mêmes prix qu'avant, maintenant payées en ligne).
const AD_SPACE_PLANS = {
  // Essai : le premier mois de la formule Standard à 5 $, une seule fois (compte qui n'a jamais eu d'espace publicitaire).
  pub_essai: { tier: 'standard', price: 5, articleLimit: 30, days: 30, trial: true, label: 'Essai Espace publicitaire 1 mois' },
  pub_basique: { tier: 'basique', price: 5, articleLimit: 5, days: 14, label: 'Espace publicitaire Basique (14 jours)' },
  pub_standard: { tier: 'standard', price: 20, articleLimit: 30, days: 30, label: 'Espace publicitaire Standard (30 jours)' },
  pub_illimite: { tier: 'illimite', price: 100, articleLimit: null, days: 180, label: 'Espace publicitaire Illimité (6 mois)' },
};

const PURPOSE_LABELS = {
  premium_essai: 'Essai Premium 1 mois', premium_mois: 'Abonnement premium 1 mois', premium_trimestre: 'Abonnement premium 3 mois', premium_annee: 'Abonnement premium 1 an',
  entreprise_essai: 'Essai Entreprise 1 mois', entreprise_mois: 'Compte Entreprise 1 mois', entreprise_annee: 'Compte Entreprise 1 an',
  video: 'Vidéo payante', achat: 'Achat de contenu', cadeau: 'Cadeau à un créateur', cadeau_live: 'Cadeau pendant un live',
  don: 'Don à Eaji', annonce: 'Publicité entreprise', depot: 'Dépôt sur le portefeuille',
  pub_essai: AD_SPACE_PLANS.pub_essai.label, pub_basique: AD_SPACE_PLANS.pub_basique.label, pub_standard: AD_SPACE_PLANS.pub_standard.label, pub_illimite: AD_SPACE_PLANS.pub_illimite.label,
  // Les conditions s'affichent au moment du paiement (10 montages par jour, total de la formule).
  ...Object.fromEntries(Object.entries(M.MONTAGE_PLANS).map(([k, v]) => [k, `${v.label} (${v.conditions})`])),
};

function newReference() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let ref = 'EJ-';
  for (const b of crypto.randomBytes(6)) ref += alphabet[b % alphabet.length];
  return ref;
}

function register({ app, db, pool, requireAuth, requireAdminPrincipal, optionalViewerId, createDownloadUrl, convertFromUSD, isSupportedCurrency, notify = async () => {}, isIdentityVerified = async () => true, bcrypt = null, notifyAdmins = async () => {}, cycles = null }) {
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

  // Essai Entreprise déjà utilisé (ou compte Entreprise déjà eu, offert compris), ou un essai en cours de paiement.
  async function businessTrialUsed(creatorId) {
    const r = await db.query(
      `SELECT EXISTS (SELECT 1 FROM premium_subscriptions WHERE creator_id = $1 AND plan LIKE 'entreprise%')
           OR EXISTS (SELECT 1 FROM payment_requests WHERE payer_id = $1 AND purpose = 'entreprise_essai'
                        AND (status = 'confirme' OR (status = 'en_attente' AND created_at > now() - interval '1 hour'))) AS used`, [creatorId]);
    return Boolean(r && r.used);
  }
  // Essai Premium déjà utilisé : le compte a déjà eu le Premium (ou Entreprise, offert compris), ou un essai en cours de paiement.
  async function premiumTrialUsed(creatorId) {
    const r = await db.query(
      `SELECT EXISTS (SELECT 1 FROM premium_subscriptions WHERE creator_id = $1)
           OR EXISTS (SELECT 1 FROM payment_requests WHERE payer_id = $1 AND purpose = 'premium_essai'
                        AND (status = 'confirme' OR (status = 'en_attente' AND created_at > now() - interval '1 hour'))) AS used`, [creatorId]);
    return Boolean(r && r.used);
  }
  // Essai de l'espace publicitaire déjà utilisé : le compte a déjà eu un espace publicitaire, ou un essai en cours de paiement.
  async function adSpaceTrialUsed(creatorId) {
    const r = await db.query(
      `SELECT EXISTS (SELECT 1 FROM ad_subscriptions WHERE creator_id = $1)
           OR EXISTS (SELECT 1 FROM payment_requests WHERE payer_id = $1 AND purpose = 'pub_essai'
                        AND (status = 'confirme' OR (status = 'en_attente' AND created_at > now() - interval '1 hour'))) AS used`, [creatorId]);
    return Boolean(r && r.used);
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
    // Les pourcentages (parts, frais, taux) restent réservés à l'administrateur principal.
    const { eajiShare, creatorShare, earningsWithdrawalFee, walletDepositFee, walletWithdrawalFee, ...prices } = M.pricingSummary();
    res.json({
      ...prices,
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
    // Uniquement des paiements réels : en ligne (mobile money, carte, PayPal), ou avec ses gains / son solde Eaji.
    // Plus de paiement « déclaré » à la main.
    const me = await db.query('SELECT id, gift_currency, phone FROM creators WHERE id = $1', [req.creatorId]);
    if (!me) return res.status(401).json({ error: 'Session invalide ou expirée.' });

    let amountUsd;
    let description = PURPOSE_LABELS[purpose];

    if (M.PREMIUM_PLANS[purpose]) {
      amountUsd = M.PREMIUM_PLANS[purpose].price;
      if (M.PREMIUM_PLANS[purpose].trial && await premiumTrialUsed(me.id)) {
        return res.status(409).json({ code: 'essai_deja_utilise', error: "L'essai Premium (2 $ le premier mois) est réservé aux comptes qui n'ont jamais eu le Premium. Choisis 1 mois, 3 mois ou 1 an." });
      }
    } else if (M.BUSINESS_PLANS[purpose]) {
      amountUsd = M.BUSINESS_PLANS[purpose].price;
      if (M.BUSINESS_PLANS[purpose].trial && await businessTrialUsed(me.id)) {
        return res.status(409).json({ code: 'essai_deja_utilise', error: "L'essai Entreprise (10 $ le premier mois) est réservé aux comptes qui n'ont jamais eu le compte Entreprise. Choisis la formule 1 mois ou 1 an." });
      }
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
        // Cadeaux sur les publications : réservés aux créateurs Premium (les autres reçoivent ceux de leurs lives).
        if (!(await premiumUntil(content.creator_id))) {
          return res.status(400).json({ error: "Ce créateur a un compte gratuit : il reçoit les cadeaux seulement pendant ses lives. Les cadeaux sur les publications sont réservés aux créateurs Premium." });
        }
        amountUsd = M.round2(req.body.amount);
        if (!M.isValidGiftAmount(amountUsd)) return res.status(400).json({ error: `Le cadeau doit être entre ${M.GIFT_MIN} $ et ${M.GIFT_MAX} $.` });
        description = `Cadeau à ${content.creator_name}`;
      } else {
        const access = (await accessMap(req.creatorId, [content])).get(content.id);
        if (!access.locked) return res.status(400).json({ error: 'Tu as déjà accès à ce contenu.' });
        amountUsd = access.price;
        description = `${access.forSale ? 'Achat' : 'Vidéo'} : « ${content.title} »`;
      }
    } else if (purpose === 'cadeau_live') {
      // Cadeau envoyé pendant un direct.
      const live = await db.query(
        `SELECT l.id, l.creator_id, cr.name AS creator_name, cr.country_code, cr.phone FROM live_sessions l
         JOIN creators cr ON cr.id = l.creator_id WHERE l.id = $1 AND l.status = 'en_cours'`, [targetId]);
      if (!live) return res.status(404).json({ error: 'Ce live est terminé.' });
      if (live.creator_id === req.creatorId) return res.status(400).json({ error: "Tu ne peux pas t'envoyer un cadeau." });
      // Les cadeaux en direct sont ouverts aux créateurs de TOUS les pays (Eaji garde 40 %),
      // même hors des pays monétisés : ce revenu aide à financer les créateurs des pays éligibles.
      amountUsd = M.round2(req.body.amount);
      if (!M.isValidGiftAmount(amountUsd)) return res.status(400).json({ error: `Le cadeau doit être entre ${M.GIFT_MIN} $ et ${M.GIFT_MAX} $.` });
      description = `Cadeau en direct à ${live.creator_name}`;
    } else if (purpose === 'don') {
      amountUsd = M.round2(req.body.amount);
      if (!(amountUsd >= M.DONATION_MIN) || amountUsd > 10000) return res.status(400).json({ error: `Le don minimum est de ${M.DONATION_MIN} $.` });
    } else if (purpose === 'annonce') {
      const ad = await db.query("SELECT * FROM business_ads WHERE id = $1 AND owner_id = $2 AND status = 'en_attente'", [targetId, req.creatorId]);
      if (!ad) return res.status(404).json({ error: 'Annonce introuvable.' });
      amountUsd = M.BUSINESS_AD_PLANS[ad.plan].price;
      description = `Publicité « ${ad.company} » (${M.BUSINESS_AD_PLANS[ad.plan].label})`;
    } else if (purpose === 'depot') {
      amountUsd = M.round2(req.body.amount);
      if (!(amountUsd >= 1) || amountUsd > 10000) return res.status(400).json({ error: 'Montant de dépôt invalide.' });
    } else if (M.MONTAGE_PLANS[purpose]) {
      amountUsd = M.MONTAGE_PLANS[purpose].price;
    } else if (AD_SPACE_PLANS[purpose]) {
      amountUsd = AD_SPACE_PLANS[purpose].price;
      if (AD_SPACE_PLANS[purpose].trial && await adSpaceTrialUsed(me.id)) {
        return res.status(409).json({ code: 'essai_deja_utilise', error: "L'essai de l'espace publicitaire (5 $ le premier mois) est réservé aux comptes qui n'en ont jamais eu. Choisis Basique, Standard ou Illimité." });
      }
    }

    if (!onlinePayments()) {
      const own = purpose === 'depot' ? 0 : Math.max((await earningsOf(req.creatorId)).available, await walletBalance(req.creatorId));
      if (!(own >= amountUsd)) {
        return res.status(503).json({ code: 'paiement_non_active', error: "Le paiement en ligne n'est pas encore activé sur Eaji. Réessaie un peu plus tard." });
      }
    }
    // Payé depuis une republication (publication partagée par un autre compte) : l'argent revient à Eaji.
    let viaRepost = null;
    if (req.body.repostId && ['video', 'achat', 'cadeau'].includes(purpose) && UUID_RE.test(String(req.body.repostId))) {
      const rp = await db.query('SELECT id FROM content_reposts WHERE id = $1 AND content_id = $2', [req.body.repostId, targetId]).catch(() => null);
      viaRepost = rp ? rp.id : null;
    }
    // Une demande identique déjà en attente est réutilisée (pas de doublon).
    const existing = await db.query(
      `SELECT * FROM payment_requests WHERE payer_id = $1 AND purpose = $2 AND target_id IS NOT DISTINCT FROM $3
         AND amount_usd = $4 AND status = 'en_attente' AND via_repost_id IS NOT DISTINCT FROM $5 ORDER BY created_at DESC LIMIT 1`,
      [req.creatorId, purpose, targetId, amountUsd, viaRepost]);
    const local = toLocal(amountUsd, me.gift_currency);
    const payment = existing || await db.query(
      `INSERT INTO payment_requests (reference, payer_id, purpose, target_id, amount_usd, amount_local, currency, description, payer_phone, via_repost_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [newReference(), req.creatorId, purpose, targetId, amountUsd, local.amount, local.currency, description, me.phone, viaRepost]);
    res.status(existing ? 200 : 201).json({ payment: publicPayment(payment), paymentNumbers: null, methods: await methodsFor(req.creatorId) });
  });

  function publicPayment(p) {
    return {
      id: p.id, reference: p.reference, purpose: p.purpose, targetId: p.target_id, description: p.description,
      amountUsd: Number(p.amount_usd), amountLocal: Number(p.amount_local), currency: p.currency,
      status: p.status, proof: p.proof, payerPhone: p.payer_phone, adminNote: p.admin_note, createdAt: p.created_at,
      method: p.method || null, gatewayStatus: p.gateway_status || null, gatewayFailure: p.gateway_failure || null,
      nonReel: !!p.non_reel,
    };
  }

  // L'utilisateur indique le numéro utilisé et l'identifiant de transaction reçu par SMS.
  // Ancien paiement « déclaré » (identifiant de transaction tapé à la main) : arrêté, car il permettait
  // d'activer des achats sans argent réel. Tout passe par le paiement en ligne.
  app.post('/api/payments/:id/proof', requireAuth, async (req, res) => {
    if (true) return res.status(410).json({ error: 'Le paiement se fait maintenant directement en ligne (mobile money, carte ou PayPal), confirmé par ton code secret.' });
    const proof = String(req.body.proof || '').trim().slice(0, 120);
    const payerPhone = String(req.body.payerPhone || '').trim().slice(0, 30);
    if (proof.length < 4) return res.status(400).json({ error: "Indique l'identifiant de la transaction reçu par SMS." });
    const updated = await db.query(
      `UPDATE payment_requests SET proof = $1, payer_phone = COALESCE(NULLIF($2, ''), payer_phone)
       WHERE id = $3 AND payer_id = $4 AND status = 'en_attente' RETURNING *`,
      [proof, payerPhone, req.params.id, req.creatorId]);
    if (!updated) return res.status(404).json({ error: 'Paiement introuvable ou déjà traité.' });
    notifyAdmins({ title: '💳 Paiement à vérifier', body: `${updated.reference} — ${Number(updated.amount_usd).toFixed(2)} $ : ${updated.description}. Vérifie que l'argent est bien arrivé.`, link: 'admin:v-payments', kind: 'paiement' });
    res.json({ payment: publicPayment(updated) });
  });

  app.post('/api/payments/:id/cancel', requireAuth, async (req, res) => {
    const pending = await db.query(
      "SELECT 1 FROM payment_attempts WHERE payment_id = $1 AND gateway = 'pawapay' AND status IN ('INITIE','ACCEPTED','PROCESSING','IN_RECONCILIATION') AND created_at > now() - interval '15 minutes'",
      [req.params.id]);
    if (pending) return res.status(409).json({ error: 'Une demande de paiement attend ta validation sur ton téléphone : valide-la ou refuse-la d\'abord.' });
    const updated = await db.query(
      "UPDATE payment_requests SET status = 'annule' WHERE id = $1 AND payer_id = $2 AND status = 'en_attente' RETURNING id",
      [req.params.id, req.creatorId]);
    if (!updated) return res.status(404).json({ error: 'Paiement introuvable ou déjà traité.' });
    res.json({ cancelled: true });
  });

  // Payer une demande en attente avec son solde Eaji : immédiat, sans vérification manuelle.
  app.post('/api/payments/:id/pay-with-balance', requireAuth, async (req, res) => {
    const outcome = await withAccountLock(req.creatorId, async () => {
      const p = await db.query(
        "SELECT * FROM payment_requests WHERE id = $1 AND payer_id = $2 AND status = 'en_attente'", [req.params.id, req.creatorId]);
      if (!p) return { status: 404, error: 'Paiement introuvable ou déjà traité.' };
      if (p.purpose === 'depot') return { status: 400, error: 'Un dépôt se paie par mobile money.' };
      const balance = await walletBalance(req.creatorId);
      if (Number(p.amount_usd) > balance) return { status: 400, error: `Solde insuffisant (disponible : ${balance} $). Fais d'abord un dépôt.` };
      const done = await db.query(
        `UPDATE payment_requests SET status = 'confirme', confirmed_at = now(), proof = 'solde Eaji', admin_note = 'Payé avec le solde'
         WHERE id = $1 AND status = 'en_attente' RETURNING *`, [p.id]);
      if (!done) return { status: 404, error: 'Paiement déjà traité.' };
      await db.query(
        "INSERT INTO wallet_entries (creator_id, amount_usd, kind, payment_id, note) VALUES ($1, $2, 'achat', $3, $4)",
        [req.creatorId, -Number(p.amount_usd), p.id, p.description]);
      try {
        await fulfill(done);
      } catch (e) {
        // En cas d'échec, on rembourse et on remet le paiement en attente.
        await db.query("DELETE FROM wallet_entries WHERE payment_id = $1 AND kind = 'achat'", [p.id]);
        await db.query("UPDATE payment_requests SET status = 'en_attente', confirmed_at = NULL, proof = NULL, admin_note = NULL WHERE id = $1", [p.id]);
        throw e;
      }
      return { status: 200, balance: await walletBalance(req.creatorId) };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ paid: true, balance: outcome.balance });
  });

  app.get('/api/payments/mine', requireAuth, async (req, res) => {
    const rows = await db.all('SELECT * FROM payment_requests WHERE payer_id = $1 ORDER BY created_at DESC LIMIT 50', [req.creatorId]);
    res.json({ payments: rows.map(publicPayment) });
  });

  // ---------- Premium ----------
  app.get('/api/premium/status', requireAuth, async (req, res) => {
    const until = await premiumUntil(req.creatorId);
    res.json({ active: Boolean(until), endsAt: until, plans: M.PREMIUM_PLANS, trialAvailable: !(await premiumTrialUsed(req.creatorId)) });
  });
  // Espace publicitaire : l'essai du premier mois est-il encore possible pour ce compte ?
  app.get('/api/ads/space/status', requireAuth, async (req, res) => {
    res.json({ trialAvailable: !(await adSpaceTrialUsed(req.creatorId)), trial: AD_SPACE_PLANS.pub_essai });
  });

  // ---------- Compte Entreprise : statistiques et message à tous les abonnés ----------
  app.get('/api/business/status', requireAuth, async (req, res) => {
    const until = await businessUntil(req.creatorId);
    res.json({ active: Boolean(until), endsAt: until, plans: M.BUSINESS_PLANS, trialAvailable: !(await businessTrialUsed(req.creatorId)) });
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

    if (M.PREMIUM_PLANS[p.purpose]) {
      const plan = M.PREMIUM_PLANS[p.purpose];
      const from = (await premiumUntil(p.payer_id)) || new Date();
      await db.query(
        `INSERT INTO premium_subscriptions (creator_id, plan, starts_at, ends_at, payment_id)
         VALUES ($1, $2, $3::timestamptz, $3::timestamptz + ($4 || ' months')::interval, $5)`,
        // Expire le même jour du mois suivant (ou 3 mois / 1 an plus tard), comme la date d'activation.
        [p.payer_id, p.purpose, new Date(from).toISOString(), plan.months || Math.round(plan.days / 30), p.id]);
      await ledger('eaji', null, 'premium', amount);
    } else if (M.MONTAGE_PLANS[p.purpose]) {
      // Abonnement Montage IA : s'ajoute à la suite d'un abonnement Montage en cours.
      const plan = M.MONTAGE_PLANS[p.purpose];
      const cur = await db.query('SELECT MAX(ends_at) AS e FROM montage_subscriptions WHERE creator_id = $1 AND ends_at > now()', [p.payer_id]);
      const from = cur && cur.e ? cur.e : new Date();
      await db.query(
        `INSERT INTO montage_subscriptions (creator_id, plan, starts_at, ends_at, payment_id)
         VALUES ($1, $2, $3::timestamptz, $3::timestamptz + ($4 || ' months')::interval, $5)`,
        [p.payer_id, p.purpose, new Date(from).toISOString(), plan.months, p.id]);
      await ledger('eaji', null, 'montage', amount);
      await notify(p.payer_id, 'paiement', `🤖 ${plan.label} activé : ${plan.conditions}.`, 's-contenu').catch(() => {});
    } else if (M.BUSINESS_PLANS[p.purpose]) {
      // Le compte Entreprise s'ajoute à la suite d'un éventuel abonnement Entreprise en cours.
      const plan = M.BUSINESS_PLANS[p.purpose];
      const from = (await businessUntil(p.payer_id)) || new Date();
      // Expire le même jour du mois suivant (ou 1 an plus tard), comme la date d'activation ; l'essai dure 1 mois.
      const span = plan.months ? `${plan.months} months` : `${plan.days} days`;
      await db.query(
        `INSERT INTO premium_subscriptions (creator_id, plan, starts_at, ends_at, payment_id)
         VALUES ($1, $2, $3::timestamptz, $3::timestamptz + $4::interval, $5)`,
        [p.payer_id, p.purpose, new Date(from).toISOString(), span, p.id]);
      await ledger('eaji', null, 'entreprise', amount);
    } else if (p.purpose === 'video' || p.purpose === 'achat' || p.purpose === 'cadeau') {
      const content = await db.query('SELECT creator_id, ai_generated FROM content_items WHERE id = $1', [p.target_id]);
      const split = M.splitForCreator(amount);
      // Payé depuis une republication : l'achat est débloqué, mais tout l'argent va à Eaji
      // (seule la publication originale rapporte à son auteur).
      if (p.via_repost_id) {
        const source = { video: 'video', achat: 'vente', cadeau: 'cadeau' }[p.purpose] + '_republication';
        if (p.purpose !== 'cadeau') {
          await db.query('INSERT INTO content_access (content_id, creator_id, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [p.target_id, p.payer_id, p.id]);
        }
        await ledger('eaji', null, source, amount);
        return;
      }
      // Contenu créé par intelligence artificielle : jamais rémunéré, tout l'argent va à Eaji
      // (pour favoriser les contenus originaux et couvrir les frais).
      if (content && content.ai_generated) {
        const source = { video: 'video', achat: 'vente', cadeau: 'cadeau' }[p.purpose] + '_ia';
        if (p.purpose !== 'cadeau') {
          await db.query('INSERT INTO content_access (content_id, creator_id, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [p.target_id, p.payer_id, p.id]);
        }
        await ledger('eaji', null, source, amount);
        const who = await db.query('SELECT name FROM creators WHERE id = $1', [p.payer_id]);
        await notify(content.creator_id, 'vente', `🤖 ${who ? who.name : 'Quelqu\'un'} a payé sur ton contenu créé par IA. Les contenus créés par intelligence artificielle ne sont pas rémunérés sur Eaji : publie des contenus originaux pour gagner de l'argent.`, 's-paiements');
        return;
      }
      // Part du créateur selon l'ancienneté et l'originalité du contenu (règle interne : cycles-routes.js).
      const share = cycles && content ? await cycles.creatorShareFor(p.target_id) : { rate: 0.6, tag: '' };
      const creatorPart = M.round2(amount * share.rate), eajiPart = M.round2(amount - creatorPart);
      if (p.purpose === 'cadeau') {
        const recipient = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [content.creator_id]);
        const local = toLocal(creatorPart, recipient ? recipient.gift_currency : 'USD');
        await db.query(
          'INSERT INTO gifts (from_creator_id, to_creator_id, content_id, amount, currency) VALUES ($1, $2, $3, $4, $5)',
          [p.payer_id, content.creator_id, p.target_id, local.amount, local.currency]);
      } else {
        await db.query(
          'INSERT INTO content_access (content_id, creator_id, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [p.target_id, p.payer_id, p.id]);
      }
      const source = { video: 'video', achat: 'vente', cadeau: 'cadeau' }[p.purpose];
      // Monétisation réservée au Premium : la vidéo d'un créateur au compte gratuit reste payante pour
      // le spectateur, mais Eaji garde tout tant que le créateur n'est pas Premium.
      if (p.purpose !== 'cadeau' && content && !(await premiumUntil(content.creator_id))) {
        const who = await db.query('SELECT name FROM creators WHERE id = $1', [p.payer_id]);
        const what = p.purpose === 'video' ? 'a payé pour regarder ta vidéo' : 'a acheté ton contenu';
        await notify(content.creator_id, 'vente', `💡 ${who ? who.name : 'Quelqu\'un'} ${what}. Passe au Premium pour être payé sur tes contenus (tu aurais reçu ${split.creator} $ ici).`, 's-paiements');
        await ledger('eaji', null, source, amount);
        return;
      }
      if (content && creatorPart > 0) {
        const who = await db.query('SELECT name FROM creators WHERE id = $1', [p.payer_id]);
        const what = { video: 'a payé pour regarder ta vidéo', achat: 'a acheté ton contenu', cadeau: `t'a envoyé un cadeau de ${amount} $` }[p.purpose];
        await notify(content.creator_id, p.purpose === 'cadeau' ? 'cadeau' : 'vente', `🎁 ${who ? who.name : 'Quelqu\'un'} ${what} (+${creatorPart} $ pour toi).`, 's-paiements');
      }
      await ledger('eaji', null, source + share.tag, eajiPart);
      await ledger('createur', content ? content.creator_id : null, source, creatorPart);
    } else if (p.purpose === 'cadeau_live') {
      const live = await db.query('SELECT creator_id FROM live_sessions WHERE id = $1', [p.target_id]);
      const split = M.splitForCreator(amount);
      const recipient = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [live.creator_id]);
      const local = toLocal(split.creator, recipient ? recipient.gift_currency : 'USD');
      await db.query(
        'INSERT INTO gifts (from_creator_id, to_creator_id, live_session_id, amount, currency) VALUES ($1, $2, $3, $4, $5)',
        [p.payer_id, live.creator_id, p.target_id, local.amount, local.currency]);
      await ledger('eaji', null, 'cadeau', split.eaji);
      await ledger('createur', live.creator_id, 'cadeau', split.creator);
      const payer = await db.query('SELECT name FROM creators WHERE id = $1', [p.payer_id]);
      await db.query(
        "INSERT INTO live_events (live_id, author_id, kind, text, amount_usd) VALUES ($1, $2, 'cadeau', $3, $4)",
        [p.target_id, p.payer_id, `${payer ? payer.name : 'Quelqu\'un'} a envoyé un cadeau de ${amount} $ 🎁`, amount]);
      await notify(live.creator_id, 'cadeau', `🎁 ${payer ? payer.name : 'Quelqu\'un'} t'a envoyé un cadeau de ${amount} $ pendant ton live (+${split.creator} $ pour toi).`, 's-paiements');
    } else if (p.purpose === 'don') {
      await ledger('eaji', null, 'don', amount);
    } else if (p.purpose === 'annonce') {
      const ad = await db.query('SELECT plan FROM business_ads WHERE id = $1', [p.target_id]);
      const days = M.BUSINESS_AD_PLANS[ad.plan].days;
      await db.query(
        `UPDATE business_ads SET status = 'actif', starts_at = now(), ends_at = now() + ($1 || ' days')::interval WHERE id = $2`,
        [days, p.target_id]);
      await ledger('eaji', null, 'publicite', amount);
    } else if (AD_SPACE_PLANS[p.purpose]) {
      const plan = AD_SPACE_PLANS[p.purpose];
      const sub = await db.query(
        `INSERT INTO ad_subscriptions (creator_id, tier, article_limit, price, currency, ends_at)
         VALUES ($1, $2, $3, $4, 'USD', now() + ($5 || ' days')::interval) RETURNING id`,
        [p.payer_id, plan.tier, plan.articleLimit, plan.price, plan.days]);
      await db.query('INSERT INTO ad_payments (ad_subscription_id, amount, currency, payment_id) VALUES ($1, $2, $3, $4)', [sub.id, amount, 'USD', p.id]);
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
  // Frais de retrait des gains : petits comptes 5 %, grands comptes 20 % (réglables par l'administrateur principal).
  const FEE_DEFAULTS = { withdraw_fee_small: 5, withdraw_fee_big: 20, big_account_subscribers: 100000 };
  async function feeSettings() {
    const rows = await db.all("SELECT key, value FROM app_settings WHERE key IN ('withdraw_fee_small', 'withdraw_fee_big', 'big_account_subscribers')");
    const out = { ...FEE_DEFAULTS };
    rows.forEach((r) => { const v = Number(r.value); if (Number.isFinite(v) && v >= 0) out[r.key] = v; });
    return out;
  }
  async function subscribersOf(creatorId) {
    const r = await db.query(
      `SELECT GREATEST(COALESCE((SELECT subscriber_count FROM subscriber_counts WHERE creator_id = $1 ORDER BY verified_at DESC LIMIT 1), 0),
                       (SELECT COUNT(*)::int FROM follows WHERE followed_id = $1)) AS n`, [creatorId]);
    return r ? Number(r.n) : 0;
  }
  async function gainsFeeRate(creatorId) {
    const f = await feeSettings();
    const big = (await subscribersOf(creatorId)) >= f.big_account_subscribers;
    return (big ? f.withdraw_fee_big : f.withdraw_fee_small) / 100;
  }
  async function feeFor(creatorId, amountUsd, source) {
    if (source !== 'gains') return M.withdrawalFee(amountUsd, source);
    const rate = await gainsFeeRate(creatorId);
    const fee = M.round2(amountUsd * rate);
    return { fee, net: M.round2(amountUsd - fee), rate };
  }

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
      `SELECT id, source, amount_usd, fee_usd, net_usd, net_local, currency, method, status, created_at, hold_until, hold_reason
       FROM withdrawal_requests WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.creatorId]);
    // Ce que les contenus rapportent jour après jour (fuseau du téléphone, par défaut Kinshasa).
    const tz = /^(UTC|[A-Za-z_]+\/[A-Za-z_\-]+(\/[A-Za-z_\-]+)?)$/.test(String(req.query.tz || '')) ? String(req.query.tz) : 'Africa/Kinshasa';
    let daily = [];
    try {
      daily = await db.all(
        `SELECT to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, SUM(amount_usd)::float AS amount, COUNT(*)::int AS n
         FROM revenue_ledger WHERE beneficiary = 'createur' AND creator_id = $1 AND amount_usd > 0
           AND created_at > now() - interval '31 days'
         GROUP BY 1 ORDER BY 1 DESC`, [req.creatorId, tz]);
    } catch (err) { daily = []; }
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const today = daily.find((d) => d.day === todayKey);
    const byContent = await db.all(
      `SELECT c.id, c.title, SUM(l.amount_usd)::float AS amount, COUNT(*)::int AS n
       FROM revenue_ledger l JOIN payment_requests p ON p.id = l.payment_id JOIN content_items c ON c.id = p.target_id
       WHERE l.beneficiary = 'createur' AND l.creator_id = $1 AND l.amount_usd > 0 AND l.created_at > now() - interval '31 days'
       GROUP BY c.id, c.title ORDER BY amount DESC LIMIT 10`, [req.creatorId]).catch(() => []);
    const nextPayoutAt = cycles && cycles.nextPayoutAt ? await cycles.nextPayoutAt(req.creatorId).catch(() => null) : null;
    // Vues et abonnés : montant « en attente » qui grandit chaque jour, disponible le jour du versement.
    const pending = cycles && cycles.pendingOf ? await cycles.pendingOf(req.creatorId).catch((err) => { console.error('[Eaji] En attente :', err.message); return null; }) : null;
    const warnings = cycles && cycles.warningsOf ? await cycles.warningsOf(req.creatorId, 3).catch(() => []) : [];
    res.json({
      ...e, availableLocal: toLocal(e.available, me.gift_currency),
      minimum: M.WITHDRAWAL_MIN,
      today: M.round2(today ? today.amount : 0), todayLocal: toLocal(M.round2(today ? today.amount : 0), me.gift_currency),
      daily: daily.map((d) => ({ day: d.day, amount: M.round2(d.amount), count: d.n })),
      byContent: byContent.map((c) => ({ id: c.id, title: c.title, amount: M.round2(c.amount), count: c.n })),
      nextPayoutAt,
      pending: pending ? { ...pending, local: toLocal(pending.amount, me.gift_currency) } : null,
      warnings,
      history, withdrawals: withdrawals.map(({ fee_usd, ...w }) => w), payoutAccount: await payoutAccountOf(req.creatorId),
      security: await securityAlert(req).catch(() => null),
    });
  });

  // Payer directement avec ses gains (abonnement, cadeau, vidéo, publicité…) : immédiat, sans retrait.
  app.post('/api/payments/:id/pay-with-earnings', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const outcome = await withAccountLock(req.creatorId, async () => {
      const p = await db.query("SELECT * FROM payment_requests WHERE id = $1 AND payer_id = $2 AND status = 'en_attente'", [req.params.id, req.creatorId]);
      if (!p) return { status: 404, error: 'Paiement introuvable ou déjà traité.' };
      if (p.purpose === 'depot') return { status: 400, error: 'Tes gains se dépensent directement : pas besoin de les déposer sur le solde.' };
      const e = await earningsOf(req.creatorId);
      if (Number(p.amount_usd) > e.available) return { status: 400, error: `Gains insuffisants (disponible : ${e.available} $).` };
      const done = await db.query(
        `UPDATE payment_requests SET status = 'confirme', confirmed_at = now(), proof = 'gains Eaji', method = 'gains', admin_note = 'Payé avec les gains'
         WHERE id = $1 AND status = 'en_attente' RETURNING *`, [p.id]);
      if (!done) return { status: 404, error: 'Paiement déjà traité.' };
      await db.query(
        "INSERT INTO revenue_ledger (payment_id, beneficiary, creator_id, source, amount_usd, note) VALUES ($1, 'createur', $2, 'paiement_gains', $3, $4)",
        [p.id, req.creatorId, -Number(p.amount_usd), p.description]);
      try { await fulfill(done); }
      catch (err) {
        await db.query("DELETE FROM revenue_ledger WHERE payment_id = $1 AND source = 'paiement_gains'", [p.id]);
        await db.query("UPDATE payment_requests SET status = 'en_attente', confirmed_at = NULL, proof = NULL, method = NULL, admin_note = NULL WHERE id = $1", [p.id]);
        throw err;
      }
      return { status: 200, available: (await earningsOf(req.creatorId)).available };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ paid: true, available: outcome.available });
  });

  // Ce que la personne recevra vraiment (montant net), sans afficher de pourcentage.
  app.post('/api/earnings/withdraw-preview', requireAuth, async (req, res) => {
    const amountUsd = M.round2(req.body.amount);
    if (!(amountUsd >= M.WITHDRAWAL_MIN)) return res.status(400).json({ error: `Le retrait minimum est de ${M.WITHDRAWAL_MIN} $.` });
    const me = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [req.creatorId]);
    const { net } = await feeFor(req.creatorId, amountUsd, 'gains');
    const local = toLocal(net, me.gift_currency);
    res.json({ amountUsd, netUsd: net, netLocal: local.amount, currency: local.currency });
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

  // ==================== SÉCURITÉ DES RETRAITS ====================
  const HOLD_HOURS = Number(process.env.EAJI_RETRAIT_ATTENTE_HEURES) || 24;
  const fmtKin = (d) => new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const agoText = (d) => { const h = Math.max(0, (Date.now() - new Date(d).getTime()) / 3600000); return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h)} h`; };
  // Appareil nouveau pour ce compte : vu pour la première fois il y a moins de HOLD_HOURS heures, alors que le
  // compte utilisait déjà un autre appareil avant (le tout premier téléphone d'un compte n'est jamais « nouveau »).
  async function newDeviceSince(req) {
    if (req.deviceKey) {
      const d = await db.query(
        `SELECT COALESCE((SELECT first_seen FROM device_links WHERE creator_id = $1 AND device_key = $2), now()) AS first_seen,
                EXISTS (SELECT 1 FROM device_links o WHERE o.creator_id = $1 AND o.device_key <> $2
                        AND o.first_seen < COALESCE((SELECT first_seen FROM device_links WHERE creator_id = $1 AND device_key = $2), now()) - interval '1 hour') AS others`,
        [req.creatorId, req.deviceKey]).catch(() => null);
      return d && d.others && new Date(d.first_seen) > new Date(Date.now() - HOLD_HOURS * 3600000) ? new Date(d.first_seen) : null;
    }
    if (req.sessionId) { // ancienne appli sans identifiant d'appareil : on regarde l'âge de la connexion
      const d = await db.query(
        `SELECT s.created_at, EXISTS (SELECT 1 FROM user_sessions o WHERE o.creator_id = s.creator_id AND o.id <> s.id AND o.created_at < s.created_at - interval '1 hour') AS others
         FROM user_sessions s WHERE s.id = $1 AND s.creator_id = $2`, [req.sessionId, req.creatorId]).catch(() => null);
      return d && d.others && new Date(d.created_at) > new Date(Date.now() - HOLD_HOURS * 3600000) ? new Date(d.created_at) : null;
    }
    return null;
  }
  async function securityHold(req) {
    const reasons = []; let until = 0;
    const ch = await db.query(
      `SELECT created_at FROM payout_changes WHERE creator_id = $1 AND cancelled_at IS NULL AND created_at > now() - make_interval(hours => $2)
       ORDER BY created_at DESC LIMIT 1`, [req.creatorId, HOLD_HOURS]).catch(() => null);
    if (ch) { reasons.push(`numéro de retrait changé il y a ${agoText(ch.created_at)}`); until = Math.max(until, new Date(ch.created_at).getTime() + HOLD_HOURS * 3600000); }
    const nd = await newDeviceSince(req);
    if (nd) { reasons.push(`nouvel appareil, connecté il y a ${agoText(nd)}`); until = Math.max(until, nd.getTime() + HOLD_HOURS * 3600000); }
    return until > Date.now() ? { until: new Date(until), reason: reasons.join(' ; ') } : null;
  }
  // Ce que voit la personne dans Paiements : alerte avec le bouton « Ce n'est pas moi ».
  async function securityAlert(req) {
    const ch = await db.query(
      `SELECT created_at, new_account FROM payout_changes WHERE creator_id = $1 AND cancelled_at IS NULL AND created_at > now() - make_interval(hours => $2)
       ORDER BY created_at DESC LIMIT 1`, [req.creatorId, HOLD_HOURS * 2]).catch(() => null);
    const held = await db.all(
      `SELECT id, net_usd, hold_until, hold_reason FROM withdrawal_requests WHERE creator_id = $1 AND status = 'en_attente' AND hold_until IS NOT NULL AND gateway_id IS NULL
       ORDER BY created_at DESC`, [req.creatorId]).catch(() => []);
    if (!ch && !held.length) return null;
    const mask = (a) => (a ? '•••' + String(a).slice(-4) : '');
    return { payoutChangedAt: ch ? ch.created_at : null, newAccount: ch ? mask(ch.new_account) : null,
      held: held.map((w) => ({ id: w.id, netUsd: Number(w.net_usd), until: w.hold_until, reason: w.hold_reason })),
      canCancel: !(await newDeviceSince(req)) };
  }

  async function createWithdrawal(req, res, source) {
    const amountUsd = M.round2(req.body.amount);
    if (!(amountUsd >= M.WITHDRAWAL_MIN)) return res.status(400).json({ error: `Le retrait minimum est de ${M.WITHDRAWAL_MIN} $.` });
    // Identité vérifiée obligatoire avant tout retrait (pièce d'identité, adresse, photo en direct).
    if (!(await isIdentityVerified(req.creatorId))) {
      return res.status(403).json({ error: "Vérifie d'abord ton identité (onglet Paiements → Vérifier mon identité) avant de retirer ton argent.", needIdentity: true });
    }
    const account = await payoutAccountOf(req.creatorId);
    if (!account) return res.status(400).json({ error: 'Enregistre d\'abord ton mode de retrait (Profil → Mode de retrait).' });
    const me = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [req.creatorId]);
    const hold = await securityHold(req);
    const outcome = await withAccountLock(req.creatorId, async () => {
      const available = source === 'gains' ? (await earningsOf(req.creatorId)).available : await walletBalance(req.creatorId);
      if (amountUsd > available) return { error: `Solde insuffisant (disponible : ${available} $).` };
      const { fee, net } = await feeFor(req.creatorId, amountUsd, source);
      const local = toLocal(net, me.gift_currency);
      const method = account.provider === 'mobile_money' ? `Mobile money${account.aggregator ? ' (' + account.aggregator + ')' : ''}` : 'Virement bancaire';
      const w = await db.query(
        `INSERT INTO withdrawal_requests (creator_id, source, amount_usd, fee_usd, net_usd, currency, net_local, method, account, hold_until, hold_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [req.creatorId, source, amountUsd, fee, net, local.currency, local.amount, method, account.external_account_id,
         hold ? hold.until : null, hold ? hold.reason : null]);
      if (source === 'portefeuille') {
        await db.query(
          "INSERT INTO wallet_entries (creator_id, amount_usd, kind, note) VALUES ($1, $2, 'retrait', $3)",
          [req.creatorId, -amountUsd, `Retrait ${w.id}`]);
      }
      return { withdrawal: w };
    });
    if (outcome.error) return res.status(400).json({ error: outcome.error });
    const w = outcome.withdrawal;
    if (hold) {
      notifyAdmins({ title: '⏳ Retrait en attente de sécurité', body: `${Number(w.net_usd).toFixed(2)} $ (${w.method}) — ${hold.reason}. À payer après le ${fmtKin(hold.until)} ; vérifie avec le créateur.`, link: 'admin:v-payments', kind: 'retrait' });
      await notify(req.creatorId, 'securite', `⏳ Retrait de ${Number(w.net_usd).toFixed(2)} $ demandé (${hold.reason}). Pour ta sécurité, il sera envoyé après le ${fmtKin(hold.until)}. Ce n'est pas toi ? Paiements → « Ce n'est pas moi ».`, 's-paiements',
        { title: 'Sécurité Eaji : retrait en attente', body: `Retrait de ${Number(w.net_usd).toFixed(2)} $ en attente 24 h. Ce n'est pas toi ? Ouvre Paiements.` });
    } else {
      notifyAdmins({ title: '💸 Retrait à payer', body: `${Number(w.net_usd).toFixed(2)} $ à envoyer (${w.method}).`, link: 'admin:v-payments', kind: 'retrait' });
    }
    res.status(201).json({
      withdrawalId: w.id, amountUsd: Number(w.amount_usd), netUsd: Number(w.net_usd),
      netLocal: Number(w.net_local), currency: w.currency, status: w.status,
      ...(hold ? { holdUntil: hold.until, holdReason: hold.reason,
        message: `Pour ta sécurité (${hold.reason}), ce retrait sera envoyé après le ${fmtKin(hold.until)}.` } : {}),
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
      depositEnabled: true, enabled: TRANSFERS_ENABLED, transfersEnabled: TRANSFERS_ENABLED,
      message: TRANSFERS_ENABLED ? null : TRANSFERS_DISABLED_MESSAGE,
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
    const sendHold = await securityHold(req);
    if (sendHold) return res.status(403).json({ code: 'retrait_en_attente', error: `Pour ta sécurité (${sendHold.reason}), l'envoi d'argent sera possible après le ${fmtKin(sendHold.until)}.` });
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

  // « Ce n'est pas moi » : l'ancien numéro de retrait revient, les retraits en attente sont annulés (l'argent reste
  // sur le compte) et les appareils connectés récemment sont déconnectés. Seulement depuis un appareil habituel.
  app.post('/api/payouts/security-cancel', requireAuth, async (req, res) => {
    if (await newDeviceSince(req)) {
      return res.status(403).json({ error: "Pour ta sécurité, fais-le depuis ton téléphone habituel (celui que tu utilisais avant), ou écris à l'équipe Eaji." });
    }
    const out = await withAccountLock(req.creatorId, async () => {
      const ch = await db.query(
        `SELECT * FROM payout_changes WHERE creator_id = $1 AND cancelled_at IS NULL AND created_at > now() - make_interval(hours => $2)
         ORDER BY created_at ASC LIMIT 1`, [req.creatorId, HOLD_HOURS * 3]);
      if (ch) {
        await db.query('DELETE FROM payout_accounts WHERE creator_id = $1', [req.creatorId]);
        if (ch.old_account) {
          await db.query('INSERT INTO payout_accounts (creator_id, provider, aggregator, external_account_id) VALUES ($1, $2, $3, $4)',
            [req.creatorId, ch.old_provider, ch.old_aggregator, ch.old_account]);
          if (ch.old_provider === 'mobile_money') await db.query('UPDATE creators SET withdrawal_phone = $1 WHERE id = $2', [ch.old_account, req.creatorId]);
        }
        await db.query('UPDATE payout_changes SET cancelled_at = now() WHERE creator_id = $1 AND cancelled_at IS NULL', [req.creatorId]);
      }
      const refused = await db.all(
        `UPDATE withdrawal_requests SET status = 'refuse', processed_at = now(), admin_note = 'Annulé par le propriétaire du compte (sécurité)'
         WHERE creator_id = $1 AND status = 'en_attente' AND hold_until IS NOT NULL AND gateway_id IS NULL RETURNING *`, [req.creatorId]);
      for (const w of refused) {
        if (w.source === 'portefeuille') {
          await db.query("INSERT INTO wallet_entries (creator_id, amount_usd, kind, note) VALUES ($1, $2, 'remboursement', 'Retrait annulé (sécurité)')", [req.creatorId, w.amount_usd]);
        }
      }
      return { ch, refused };
    });
    if (!out.ch && !out.refused.length) return res.status(404).json({ error: 'Rien à annuler : aucun changement de numéro ni retrait en attente.' });
    const gone = await db.all(
      `UPDATE user_sessions SET revoked_at = now() WHERE creator_id = $1 AND revoked_at IS NULL AND created_at > now() - make_interval(hours => $2)
         AND id IS DISTINCT FROM $3::uuid RETURNING id`, [req.creatorId, HOLD_HOURS * 3, req.sessionId || null]).catch(() => []);
    if (gone.length) await db.query('DELETE FROM push_subscriptions WHERE session_id = ANY($1::uuid[])', [gone.map((g) => g.id)]).catch(() => {});
    notifyAdmins({ title: '🚨 Piratage évité : retrait annulé par le propriétaire', body: `${out.refused.length} retrait(s) annulé(s)${out.ch ? ', ancien numéro remis' : ''}, ${gone.length} appareil(s) déconnecté(s).`,
      link: 'admin:v-payments', kind: 'securite', urgent: true });
    res.json({ restored: Boolean(out.ch), refused: out.refused.length, disconnected: gone.length,
      message: `C'est annulé${out.ch ? ' : ton ancien numéro de retrait est remis' : ''}${out.refused.length ? `, ${out.refused.length} retrait(s) bloqué(s) (l'argent reste sur ton compte)` : ''}${gone.length ? `, ${gone.length} appareil(s) déconnecté(s)` : ''}. Change ton mot de passe maintenant (Profil → Sécurité).` });
  });

  // ---------- Publicité des entreprises ----------
  app.post('/api/business-ads', requireAuth, async (req, res) => {
    const company = String(req.body.company || '').trim().slice(0, 80);
    const message = String(req.body.message || '').trim().slice(0, 200);
    const linkUrl = String(req.body.linkUrl || '').trim().slice(0, 300);
    let countryCode = String(req.body.countryCode || '').toUpperCase();
    const { plan, mediaKey, mediaType } = req.body;
    if (!company) return res.status(400).json({ error: "Indique le nom de l'entreprise." });
    if (!M.BUSINESS_AD_PLANS[plan]) return res.status(400).json({ error: 'Choisis une durée de publicité.' });
    // Où montrer la publicité : une ville, un pays, un continent ou partout (sans choix : le pays, ou partout si « ALL »).
    const scope = AD_SCOPES.includes(req.body.targetScope) ? req.body.targetScope : (countryCode === 'ALL' ? 'partout' : 'pays');
    const city = String(req.body.targetCity || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const continent = String(req.body.targetContinent || '');
    if (scope === 'ville' || scope === 'pays') {
      if (!/^[A-Z]{2}$/.test(countryCode)) return res.status(400).json({ error: 'Choisis le pays de diffusion.' });
      if (scope === 'ville' && cityNorm(city).length < 2) return res.status(400).json({ error: 'Écris le nom de la ville.' });
    } else if (scope === 'continent') {
      if (!ZONES.includes(continent)) return res.status(400).json({ error: 'Choisis le continent.' });
      countryCode = 'ALL';
    } else countryCode = 'ALL';
    if (!/^[A-Z]{2}$/.test(countryCode) && countryCode !== 'ALL') return res.status(400).json({ error: 'Choisis le pays de diffusion.' });
    if (!['image', 'video'].includes(mediaType) || !mediaKey) return res.status(400).json({ error: 'Ajoute une bannière (image) ou une vidéo.' });
    if (!String(mediaKey).startsWith(`${req.creatorId}/`)) return res.status(403).json({ error: 'Fichier non autorisé.' });
    if (linkUrl && !/^https?:\/\//i.test(linkUrl)) return res.status(400).json({ error: 'Le lien doit commencer par https://' });
    const ad = await db.query(
      `INSERT INTO business_ads (owner_id, company, message, media_key, media_type, link_url, country_code, plan,
                                 target_scope, target_city, target_city_norm, target_continent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [req.creatorId, company, message || null, mediaKey, mediaType, linkUrl || null, countryCode, plan,
       scope, scope === 'ville' ? city : null, scope === 'ville' ? cityNorm(city) : null, scope === 'continent' ? continent : null]);
    res.status(201).json({ adId: ad.id, price: M.BUSINESS_AD_PLANS[plan].price });
  });

  app.get('/api/business-ads/mine', requireAuth, async (req, res) => {
    const ads = await db.all(
      `SELECT id, company, message, media_type, link_url, country_code, target_scope, target_city, target_continent, plan, status, starts_at, ends_at, impressions, clicks, created_at
       FROM business_ads WHERE owner_id = $1 ORDER BY created_at DESC`, [req.creatorId]);
    res.json({ ads });
  });

  // Une vue est comptée quand la publicité est réellement affichée (fin de vidéo, bas du fil).
  app.post('/api/business-ads/:id/view', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    await db.query("UPDATE business_ads SET impressions = impressions + 1 WHERE id = $1 AND status = 'actif'", [req.params.id]);
    res.json({ counted: true });
  });

  app.post('/api/business-ads/:id/click', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    await db.query('UPDATE business_ads SET clicks = clicks + 1 WHERE id = $1', [req.params.id]);
    res.json({ counted: true });
  });

  // Annonces à placer dans le fil, selon l'endroit où se trouve la personne qui regarde :
  // « Partout » pour tous ; un continent, un pays ou une ville seulement pour les personnes de cet endroit.
  // viewer = { country, city } (profil de la personne connectée, ou pays de l'appareil) ; un simple code pays est aussi accepté.
  async function adsForFeed(viewer) {
    const v = typeof viewer === 'string' || viewer == null ? { country: viewer } : viewer;
    const country = /^[A-Z]{2}$/.test(String(v.country || '')) ? String(v.country) : null;
    const zone = country ? zoneOf(country) : null;
    const city = cityNorm(v.city) || null;
    const ads = await db.all(
      `SELECT id, company, message, media_key, media_type, link_url, country_code FROM business_ads
       WHERE status = 'actif' AND ends_at > now()
         AND (COALESCE(target_scope, CASE WHEN country_code = 'ALL' THEN 'partout' ELSE 'pays' END) = 'partout'
              OR (target_scope IS DISTINCT FROM 'ville' AND target_scope IS DISTINCT FROM 'continent' AND country_code = $1)
              OR (target_scope = 'continent' AND target_continent = $2)
              OR (target_scope = 'ville' AND country_code = $1 AND target_city_norm = $3))
       ORDER BY random() LIMIT 5`, [country, zone, city]);
    for (const ad of ads) {
      ad.mediaUrl = await createDownloadUrl(ad.media_key).catch(() => null);
      delete ad.media_key;
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
    // Plus aucune confirmation à la main (c'est ce qui créait de l'argent non réel) : un achat s'active
    // seulement quand pawaPay, CinetPay ou PayPal a vraiment reçu l'argent.
    if (true) return res.status(410).json({ error: 'Les paiements ne se confirment plus à la main : seul un paiement en ligne réellement reçu (pawaPay, CinetPay ou PayPal) active un achat.' });
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
    await notify(p.payer_id, 'paiement', `✅ Paiement ${p.reference} confirmé : ${p.description}.`, 's-paiements');
    res.json({ confirmed: true });
  });

  app.post('/api/admin/payments/:id/refuse', requireAdminPrincipal, async (req, res) => {
    const p = await db.query(
      `UPDATE payment_requests SET status = 'refuse', admin_id = $2, admin_note = $3
       WHERE id = $1 AND status = 'en_attente' RETURNING id`,
      [req.params.id, req.adminId, String(req.body.note || '').slice(0, 200) || 'Paiement non reçu.']);
    if (!p) return res.status(404).json({ error: 'Paiement introuvable ou déjà traité.' });
    const refused = await db.query('SELECT payer_id, reference, admin_note FROM payment_requests WHERE id = $1', [p.id]);
    await notify(refused.payer_id, 'paiement', `❌ Paiement ${refused.reference} refusé : ${refused.admin_note}`, 's-paiements');
    res.json({ refused: true });
  });

  app.get('/api/admin/withdrawals', requireAdminPrincipal, async (req, res) => {
    const sending = await db.all("SELECT * FROM withdrawal_requests WHERE status = 'en_attente' AND gateway_id IS NOT NULL");
    for (const w of sending) await settleCreatorPayout(w).catch(() => {});
    const status = ['en_attente', 'paye', 'refuse'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.all(
      `SELECT w.*, cr.name AS creator_name, cr.phone AS creator_phone FROM withdrawal_requests w
       JOIN creators cr ON cr.id = w.creator_id
       WHERE ($1::text IS NULL OR w.status = $1) ORDER BY w.created_at DESC LIMIT 200`, [status]);
    res.json({ withdrawals: rows });
  });

  // Retrait en attente de sécurité : l'administrateur doit confirmer (« payer quand même ») avant la fin du délai.
  async function heldCheck(req, res) {
    if (req.body && req.body.force === true) return false;
    const h = await db.query("SELECT hold_until, hold_reason FROM withdrawal_requests WHERE id::text = $1 AND status = 'en_attente' AND hold_until > now()", [String(req.params.id)]).catch(() => null);
    if (!h) return false;
    res.status(409).json({ code: 'retrait_en_attente', holdUntil: h.hold_until, reason: h.hold_reason,
      error: `Retrait en attente de sécurité jusqu'au ${fmtKin(h.hold_until)} (${h.hold_reason}). Vérifie avec le créateur avant de payer.` });
    return true;
  }
  app.post('/api/admin/withdrawals/:id/paid', requireAdminPrincipal, async (req, res) => {
    if (await heldCheck(req, res)) return;
    const w = await db.query(
      `UPDATE withdrawal_requests SET status = 'paye', processed_at = now(), admin_id = $2, admin_note = $3
       WHERE id = $1 AND status = 'en_attente' RETURNING *`,
      [req.params.id, req.adminId, String(req.body.note || '').slice(0, 200) || null]);
    if (!w) return res.status(404).json({ error: 'Retrait introuvable ou déjà traité.' });
    await db.query(
      'INSERT INTO revenue_ledger (beneficiary, creator_id, source, amount_usd) VALUES ($1, $2, $3, $4)',
      ['eaji', w.creator_id, w.source === 'portefeuille' ? 'frais_retrait_portefeuille' : 'frais_retrait', w.fee_usd]);
    await notify(w.creator_id, 'retrait', `💸 Ton retrait de ${Number(w.net_usd).toFixed(2)} $ a été envoyé (${w.method}).`, 's-paiements');
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
    await notify(w.creator_id, 'retrait', `❌ Ton retrait a été refusé${w.admin_note ? ' : ' + w.admin_note : ''}. Le montant reste disponible.`, 's-paiements');
    res.json({ refused: true });
  });

  // L'administrateur principal peut offrir le Premium ou le compte Entreprise (essai gratuit).
  app.post('/api/admin/creators/:id/grant', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const kind = req.body.kind === 'entreprise' ? 'entreprise' : 'premium';
    const days = Math.round(Number(req.body.days));
    if (!(days >= 1 && days <= 3650)) return res.status(400).json({ error: 'Durée invalide (1 à 3650 jours).' });
    const creator = await db.query('SELECT id FROM creators WHERE id = $1', [req.params.id]);
    if (!creator) return res.status(404).json({ error: 'Compte introuvable.' });
    const current = kind === 'entreprise' ? await businessUntil(creator.id) : await premiumUntil(creator.id);
    const from = current || new Date();
    const row = await db.query(
      `INSERT INTO premium_subscriptions (creator_id, plan, starts_at, ends_at)
       VALUES ($1, $2, $3::timestamptz, $3::timestamptz + ($4 || ' days')::interval) RETURNING ends_at`,
      [creator.id, `${kind}_offert`, new Date(from).toISOString(), days]);
    await notify(creator.id, 'offre', `🎉 L'équipe Eaji t'offre ${kind === 'entreprise' ? 'le compte Entreprise' : 'le Premium'} pendant ${days} jours !`, 's-paiements');
    res.status(201).json({ granted: kind, endsAt: row.ends_at });
  });

  app.post('/api/admin/creators/:id/revoke-gift', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    await db.query(
      "UPDATE premium_subscriptions SET ends_at = now() WHERE creator_id = $1 AND plan LIKE '%_offert' AND ends_at > now()", [req.params.id]);
    res.json({ revoked: true });
  });

  app.get('/api/admin/business-ads', requireAdminPrincipal, async (req, res) => {
    const ads = await db.all(
      `SELECT a.id, a.company, a.message, a.media_type, a.link_url, a.country_code, a.target_scope, a.target_city, a.target_continent, a.plan, a.status,
              a.starts_at, a.ends_at, a.impressions, a.clicks, a.created_at, cr.name AS owner_name
       FROM business_ads a JOIN creators cr ON cr.id = a.owner_id ORDER BY a.created_at DESC LIMIT 200`);
    res.json({ ads });
  });

  app.post('/api/admin/business-ads/:id/remove', requireAdminPrincipal, async (req, res) => {
    const ad = await db.query("UPDATE business_ads SET status = 'retire' WHERE id = $1 RETURNING id", [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Annonce introuvable.' });
    res.json({ removed: true });
  });

  // ---------- Tarifs et pourcentages : visibles et réglables par l'administrateur principal uniquement ----------
  app.get('/api/admin/rates', requireAdminPrincipal, async (req, res) => {
    const f = await feeSettings();
    const s = M.pricingSummary();
    const budget = await db.query("SELECT value FROM app_settings WHERE key = 'payout_budget_percent'");
    res.json({
      creatorSharePercent: Math.round(s.creatorShare * 100), eajiSharePercent: Math.round(s.eajiShare * 100),
      withdrawFeeSmall: f.withdraw_fee_small, withdrawFeeBig: f.withdraw_fee_big, bigAccountSubscribers: f.big_account_subscribers,
      walletDepositFeePercent: Math.round(s.walletDepositFee * 100), walletWithdrawalFeePercent: Math.round(s.walletWithdrawalFee * 100),
      payoutTiers: [{ upTo: 100000, usdPer1000: 2 }, { upTo: 1000000, usdPer1000: 1 }, { upTo: null, usdPer1000: 0.5 }],
      monthlyViewsPercent: 70, payoutBudgetPercent: budget ? Number(budget.value) : 30,
      eligibility: { subscribers: 1000, views: 1000 },
      premiumPlans: s.premiumPlans, businessPlans: s.businessPlans, videoPriceSteps: s.videoPriceSteps,
    });
  });
  app.put('/api/admin/rates', requireAdminPrincipal, async (req, res) => {
    const vals = { withdraw_fee_small: req.body.withdrawFeeSmall, withdraw_fee_big: req.body.withdrawFeeBig, big_account_subscribers: req.body.bigAccountSubscribers };
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      const okRange = k === 'big_account_subscribers' ? (Number.isInteger(n) && n >= 1000) : (n >= 0 && n <= 50);
      if (!okRange) return res.status(400).json({ error: k === 'big_account_subscribers' ? 'Seuil des grands comptes : au moins 1 000 abonnés.' : 'Les frais de retrait doivent être entre 0 et 50 %.' });
      await db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [k, String(n)]);
    }
    const f = await feeSettings();
    res.json({ withdrawFeeSmall: f.withdraw_fee_small, withdrawFeeBig: f.withdraw_fee_big, bigAccountSubscribers: f.big_account_subscribers });
  });

  // ---------- Correction des gains d'un créateur (erreur de versement) ----------
  app.get('/api/admin/creators/:id/earnings', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const e = await earningsOf(req.params.id);
    const fixes = await db.all(
      `SELECT amount_usd, note, created_at FROM revenue_ledger WHERE beneficiary = 'createur' AND creator_id = $1 AND source = 'correction'
       ORDER BY created_at DESC LIMIT 20`, [req.params.id]);
    res.json({ ...e, corrections: fixes });
  });
  app.post('/api/admin/creators/:id/adjust-earnings', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const amount = M.round2(req.body.amountUsd);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!amount || Math.abs(amount) > 100000) return res.status(400).json({ error: 'Montant invalide (exemple : 5 pour ajouter, -5 pour retirer).' });
    if (reason.length < 3) return res.status(400).json({ error: 'Indique la raison de la correction.' });
    const who = await db.query('SELECT id FROM creators WHERE id = $1', [req.params.id]);
    if (!who) return res.status(404).json({ error: 'Compte introuvable.' });
    const outcome = await withAccountLock(req.params.id, async () => {
      const e = await earningsOf(req.params.id);
      if (e.available + amount < 0) return { error: `Impossible : il ne reste que ${e.available} $ de gains disponibles (l'argent déjà retiré ne peut pas être repris ici).` };
      await db.query(
        "INSERT INTO revenue_ledger (beneficiary, creator_id, source, amount_usd, note) VALUES ('createur', $1, 'correction', $2, $3)",
        [req.params.id, amount, reason]);
      return { available: M.round2(e.available + amount) };
    });
    if (outcome.error) return res.status(400).json({ error: outcome.error });
    await notify(req.params.id, 'paiement', `🛠️ Correction de tes gains par l'équipe Eaji : ${amount > 0 ? '+' : ''}${amount} $ (${reason}).`, 's-paiements');
    res.status(201).json({ adjusted: true, available: outcome.available });
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


  // =================== PAIEMENTS EN LIGNE RÉELS ===================
  const onlinePayments = () => G.pawapayConfigured() || G.paypalConfigured() || G.cinetpayConfigured();
  const PENDING = ['INITIE', 'ACCEPTED', 'PROCESSING', 'IN_RECONCILIATION', 'ENQUEUED', 'CREATED', 'APPROVED', 'UNKNOWN'];

  async function methodsFor(creatorId) {
    const me = await db.query('SELECT country_code, phone FROM creators WHERE id = $1', [creatorId]);
    const cc = me ? me.country_code : null;
    const providers = G.pawapayConfigured() ? G.providersFor(cc) : [];
    const msisdn = me && G.normalizeMsisdn(cc, me.phone);
    return {
      mobileMoney: providers.length ? { providers: providers.map((p) => ({ code: p.code, name: p.name })), dial: G.DIAL[cc], phone: msisdn ? msisdn.slice(G.DIAL[cc].length) : '', suggested: G.guessProvider(cc, msisdn) } : null,
      card: G.paypalConfigured(),
      cinetpay: G.cinetpayConfigured(),
      earnings: (await earningsOf(creatorId)).available,
      manual: false,
      online: onlinePayments(),
    };
  }
  app.get('/api/payments/methods', requireAuth, async (req, res) => res.json(await methodsFor(req.creatorId)));

  const FAILURES = {
    PAYER_NOT_FOUND: 'Ce numéro n\'a pas de compte mobile money chez cet opérateur.',
    PAYMENT_NOT_APPROVED: 'Paiement non validé sur le téléphone (code secret non saisi ou refusé).',
    INSUFFICIENT_BALANCE: 'Solde insuffisant sur ton compte mobile money.',
    PAYER_LIMIT_REACHED: 'Limite de ton compte mobile money atteinte.',
    TRANSACTION_ALREADY_IN_PROCESS: 'Une autre opération est déjà en cours sur ce numéro. Réessaie dans un instant.',
    UNSPECIFIED_FAILURE: 'L\'opérateur a refusé le paiement.',
    WALLET_LIMIT_REACHED: 'Limite de ton compte mobile money atteinte.',
    INVALID_PHONE_NUMBER: 'Numéro de téléphone invalide.',
    PROVIDER_TEMPORARILY_UNAVAILABLE: 'L\'opérateur est momentanément indisponible. Réessaie plus tard.',
  };
  const failureText = (f) => (f && (FAILURES[f.failureCode] || FAILURES.UNSPECIFIED_FAILURE)) || FAILURES.UNSPECIFIED_FAILURE;

  // Paiement réellement reçu : on active l'achat (une seule fois, même si pawaPay prévient deux fois).
  async function finalizePayment(paymentId, proof) {
    const done = await db.query(
      `UPDATE payment_requests SET status = 'confirme', confirmed_at = now(), proof = $2, admin_note = 'Paiement en ligne vérifié',
         gateway_status = 'COMPLETED', gateway_failure = NULL
       WHERE id = $1 AND status IN ('en_attente', 'annule') RETURNING *`, [paymentId, proof]);
    if (!done) return false;
    try { await fulfill(done); }
    catch (e) {
      await db.query("UPDATE payment_requests SET status = 'en_attente', confirmed_at = NULL WHERE id = $1", [paymentId]);
      throw e;
    }
    await notify(done.payer_id, 'paiement', `✅ Paiement reçu : ${done.description}.`, 's-paiements');
    notifyAdmins({ title: `💰 Paiement reçu : ${Number(done.amount_usd).toFixed(2)} $`, body: `${done.description} (${done.method === 'paypal' ? 'carte / PayPal' : done.method === 'cinetpay' ? 'CinetPay' : 'mobile money'})`, link: 'admin:v-finance', kind: 'paiement' });
    return true;
  }

  // Redemande à pawaPay / PayPal le résultat de chaque tentative (jamais sur la parole de l'utilisateur).
  async function settleAttempt(a) {
    if (!PENDING.includes(a.status)) return;
    let status = 'UNKNOWN', failure = null, proof = null;
    if (a.gateway === 'pawapay') {
      const d = await G.pawapayCheck('deposits', a.gateway_id).catch(() => ({ status: 'UNKNOWN' }));
      if (d.status === 'COMPLETED') {
        const same = Number(d.amount) === Number(a.amount) && String(d.currency) === a.currency;
        status = same ? 'COMPLETED' : 'FAILED';
        failure = same ? null : `Montant reçu différent (${d.amount} ${d.currency}).`;
        proof = `pawaPay ${d.providerTransactionId || a.gateway_id}`;
      } else if (d.status === 'FAILED') { status = 'FAILED'; failure = failureText(d.failureReason); }
      else if (d.status === 'NOT_FOUND') {
        // Jamais arrivée chez pawaPay : abandonnée après 5 minutes.
        if (Date.now() - new Date(a.created_at).getTime() > 5 * 60 * 1000) { status = 'FAILED'; failure = 'La demande n\'a pas abouti. Réessaie.'; }
        else status = a.status;
      } else status = d.status || 'UNKNOWN';
    } else if (a.gateway === 'cinetpay') {
      const d = await G.cinetpayCheck(a.gateway_id).catch(() => ({ status: 'PENDING' }));
      if (d.status === 'COMPLETED') {
        const same = Number(d.amount) === Number(a.amount) && String(d.currency).toUpperCase() === a.currency;
        status = same ? 'COMPLETED' : 'FAILED';
        failure = same ? null : `Montant reçu différent (${d.amount} ${d.currency}).`;
        proof = `CinetPay ${d.operatorId || a.gateway_id}${d.method ? ' (' + d.method + ')' : ''}`;
      } else if (d.status === 'FAILED') { status = 'FAILED'; failure = 'Paiement non abouti ou annulé sur la page CinetPay.'; }
      else if (Date.now() - new Date(a.created_at).getTime() > 2 * 24 * 3600 * 1000) { status = 'FAILED'; failure = 'Paiement jamais terminé.'; }
      else status = 'PROCESSING';
    } else {
      const d = await G.paypalSettle(a.gateway_id).catch(() => ({ status: 'PENDING' }));
      if (d.status === 'COMPLETED') {
        const same = Number(d.amount) === Number(a.amount) && d.currency === a.currency;
        status = same ? 'COMPLETED' : 'FAILED';
        failure = same ? null : `Montant reçu différent (${d.amount} ${d.currency}).`;
        proof = `PayPal ${d.captureId}`;
      } else if (d.status === 'FAILED') { status = 'FAILED'; failure = 'Paiement PayPal annulé.'; }
      else status = a.status;
    }
    await db.query('UPDATE payment_attempts SET status = $2, failure = $3, updated_at = now() WHERE gateway_id = $1', [a.gateway_id, status, failure]);
    if (status === 'COMPLETED') await finalizePayment(a.payment_id, proof);
    else if (status === 'FAILED') {
      await db.query("UPDATE payment_requests SET gateway_status = 'FAILED', gateway_failure = $2 WHERE id = $1 AND status = 'en_attente'", [a.payment_id, failure]);
    } else await db.query("UPDATE payment_requests SET gateway_status = $2 WHERE id = $1 AND status = 'en_attente'", [a.payment_id, status]);
  }
  async function settlePayment(paymentId) {
    const attempts = await db.all('SELECT * FROM payment_attempts WHERE payment_id = $1 ORDER BY created_at', [paymentId]);
    for (const a of attempts) await settleAttempt(a);
  }
  async function ownPendingPayment(req, res) {
    if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Identifiant invalide.' }); return null; }
    const p = await db.query('SELECT * FROM payment_requests WHERE id = $1 AND payer_id = $2', [req.params.id, req.creatorId]);
    if (!p) { res.status(404).json({ error: 'Paiement introuvable.' }); return null; }
    if (p.status !== 'en_attente') { res.status(409).json({ error: 'Ce paiement est déjà traité.', payment: publicPayment(p) }); return null; }
    return p;
  }

  // Mobile money : demande envoyée au téléphone, validée par le code secret de l'acheteur.
  app.post('/api/payments/:id/mobile-money', requireAuth, async (req, res) => {
    if (!G.pawapayConfigured()) return res.status(503).json({ error: 'Le paiement mobile money en ligne n\'est pas encore activé.' });
    const p = await ownPendingPayment(req, res); if (!p) return;
    await settlePayment(p.id);
    const again = await db.query("SELECT status FROM payment_requests WHERE id = $1", [p.id]);
    if (again.status !== 'en_attente') return res.json({ paid: true });
    const busy = await db.query(
      `SELECT 1 FROM payment_attempts WHERE payment_id = $1 AND gateway = 'pawapay' AND status IN ('INITIE','ACCEPTED','PROCESSING','IN_RECONCILIATION')
         AND created_at > now() - interval '3 minutes'`, [p.id]);
    if (busy) return res.status(409).json({ error: 'Une demande attend déjà ta validation sur ton téléphone. Valide-la avec ton code secret, ou attends 3 minutes pour recommencer.' });
    const me = await db.query('SELECT country_code FROM creators WHERE id = $1', [req.creatorId]);
    const prov = G.providersFor(me.country_code).find((x) => x.code === req.body.provider);
    if (!prov) return res.status(400).json({ error: 'Choisis ton opérateur mobile money.' });
    const msisdn = G.normalizeMsisdn(me.country_code, req.body.phone);
    if (!msisdn) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
    const amt = G.mobileAmount(prov, p.amount_usd, convertFromUSD);
    const depositId = G.newId();
    // Enregistré AVANT l'appel : même si la réponse se perd, l'argent est retrouvé.
    await db.query(
      `INSERT INTO payment_attempts (gateway_id, payment_id, gateway, provider, amount, currency, phone) VALUES ($1, $2, 'pawapay', $3, $4, $5, $6)`,
      [depositId, p.id, prov.code, amt.amount, amt.currency, msisdn]);
    await db.query("UPDATE payment_requests SET method = 'mobile_money', gateway_status = 'INITIE', gateway_failure = NULL, payer_phone = $2 WHERE id = $1", [p.id, '+' + msisdn]);
    let r;
    try { r = await G.pawapayDeposit({ depositId, amount: amt.amount, currency: amt.currency, msisdn, provider: prov.code, description: `Eaji ${p.reference}` }); }
    catch (e) { r = { status: 'UNKNOWN' }; }
    if (r.status === 'REJECTED') {
      const failure = failureText(r.failureReason);
      await db.query("UPDATE payment_attempts SET status = 'FAILED', failure = $2 WHERE gateway_id = $1", [depositId, failure]);
      await db.query("UPDATE payment_requests SET gateway_status = 'FAILED', gateway_failure = $2 WHERE id = $1", [p.id, failure]);
      return res.status(400).json({ error: failure });
    }
    await db.query('UPDATE payment_attempts SET status = $2 WHERE gateway_id = $1', [depositId, r.status === 'DUPLICATE_IGNORED' ? 'ACCEPTED' : (r.status || 'UNKNOWN')]);
    const shown = amt.currency === 'USD' ? `${amt.amount} $` : `${amt.amount} ${amt.currency}`;
    res.json({ waiting: true, message: `Une demande de paiement de ${shown} a été envoyée au +${msisdn}. Valide-la sur ton téléphone avec ton code secret ${prov.name}.` });
  });

  // Carte bancaire ou PayPal : page sécurisée de PayPal.
  app.post('/api/payments/:id/paypal', requireAuth, async (req, res) => {
    if (!G.paypalConfigured()) return res.status(503).json({ error: 'Le paiement par carte n\'est pas encore activé.' });
    const p = await ownPendingPayment(req, res); if (!p) return;
    const site = (process.env.PUBLIC_SITE_URL || 'https://eaji.org').replace(/\/$/, '');
    let order;
    try {
      order = await G.paypalCreateOrder({ amountUsd: p.amount_usd, reference: `${p.reference}-${Date.now()}`, description: `Eaji — ${p.description}`,
        returnUrl: `${site}/paiement-termine.html?ok=1`, cancelUrl: `${site}/paiement-termine.html?annule=1` });
    } catch (e) { return res.status(502).json({ error: e.message }); }
    await db.query(
      `INSERT INTO payment_attempts (gateway_id, payment_id, gateway, amount, currency, status) VALUES ($1, $2, 'paypal', $3, 'USD', 'CREATED')`,
      [order.id, p.id, Number(p.amount_usd).toFixed(2)]);
    await db.query("UPDATE payment_requests SET method = 'paypal', gateway_status = 'CREATED', gateway_failure = NULL WHERE id = $1", [p.id]);
    res.json({ approveUrl: order.approveUrl });
  });

  // CinetPay : page sécurisée où l'acheteur choisit mobile money (Orange, Airtel, M-Pesa… avec son code secret)
  // ou carte Visa / Mastercard (avec la vérification de sa banque).
  app.post('/api/payments/:id/cinetpay', requireAuth, async (req, res) => {
    if (!G.cinetpayConfigured()) return res.status(503).json({ error: 'Le paiement CinetPay n\'est pas encore activé.' });
    const p = await ownPendingPayment(req, res); if (!p) return;
    const me = await db.query('SELECT name, phone, email, city, country_code, language FROM creators WHERE id = $1', [req.creatorId]);
    const site = (process.env.PUBLIC_SITE_URL || 'https://eaji.org').replace(/\/$/, '');
    const api = (process.env.PUBLIC_API_URL || `${req.protocol || 'https'}://${req.get('host')}`).replace(/\/$/, '');
    const amt = G.cinetpayAmount(p.amount_usd, convertFromUSD);
    const transactionId = 'EAJI' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
    // Enregistré AVANT l'appel : même si la réponse se perd, l'argent est retrouvé.
    await db.query(
      `INSERT INTO payment_attempts (gateway_id, payment_id, gateway, amount, currency, phone, status) VALUES ($1, $2, 'cinetpay', $3, $4, $5, 'CREATED')`,
      [transactionId, p.id, String(amt.amount), amt.currency, me && me.phone]);
    let r;
    try {
      r = await G.cinetpayInit({ transactionId, amount: amt.amount, currency: amt.currency, description: `Eaji ${p.reference}`,
        notifyUrl: `${api}/api/cinetpay/notification`, returnUrl: `${api}/api/cinetpay/retour`,
        customer: { name: me && me.name, phone: me && me.phone, email: me && me.email, city: me && me.city, country: me && me.country_code, lang: me && me.language } });
    } catch (e) {
      await db.query("UPDATE payment_attempts SET status = 'FAILED', failure = $2 WHERE gateway_id = $1", [transactionId, e.message]);
      return res.status(502).json({ error: e.message });
    }
    await db.query("UPDATE payment_requests SET method = 'cinetpay', gateway_status = 'CREATED', gateway_failure = NULL WHERE id = $1", [p.id]);
    const shown = amt.currency === 'USD' ? `${amt.amount} $` : `${amt.amount} ${amt.currency}`;
    res.json({ paymentUrl: r.paymentUrl, amount: amt.amount, currency: amt.currency, message: `Paiement de ${shown} sur la page sécurisée CinetPay.` });
  });

  // Avis de paiement de CinetPay (formulaire POST avec cpm_trans_id). Le contenu n'est pas cru : Eaji revérifie.
  async function readFormBody(req) {
    if (req.body && Object.keys(req.body).length) return req.body;
    if (req.readableEnded || req.complete && !req.readable) return {};
    const raw = await new Promise((resolve) => {
      let data = ''; req.setEncoding && req.setEncoding('utf8');
      req.on('data', (c) => { data += c; if (data.length > 20000) req.destroy(); });
      req.on('end', () => resolve(data)); req.on('error', () => resolve(''));
      setTimeout(() => resolve(data), 3000);
    });
    try { return Object.fromEntries(new URLSearchParams(raw)); } catch (e) { return {}; }
  }
  const cinetpayNotice = async (req, res) => {
    const body = req.method === 'POST' ? await readFormBody(req) : {};
    const id = String(body.cpm_trans_id || body.transaction_id || req.query.cpm_trans_id || '').slice(0, 80);
    if (id) {
      const a = await db.query("SELECT * FROM payment_attempts WHERE gateway_id = $1 AND gateway = 'cinetpay'", [id]).catch(() => null);
      if (a) await settleAttempt(a).catch(() => {});
    }
    res.json({ received: true });
  };
  // (Adresse hors de /api/payments/:id/… pour ne jamais tomber sur une route qui demande la connexion.)
  app.post('/api/cinetpay/notification', cinetpayNotice);
  app.get('/api/cinetpay/notification', cinetpayNotice); // CinetPay teste parfois l'adresse en GET
  // Retour de l'acheteur après la page CinetPay (souvent en POST, que le site GitHub Pages refuse) :
  // on vérifie le paiement puis on le renvoie vers la page « paiement terminé » du site.
  const cinetpayReturn = async (req, res) => {
    const body = req.method === 'POST' ? await readFormBody(req) : {};
    const id = String(body.transaction_id || body.cpm_trans_id || req.query.transaction_id || '').slice(0, 80);
    if (id) {
      const a = await db.query("SELECT * FROM payment_attempts WHERE gateway_id = $1 AND gateway = 'cinetpay'", [id]).catch(() => null);
      if (a) await settleAttempt(a).catch(() => {});
    }
    const site = (process.env.PUBLIC_SITE_URL || 'https://eaji.org').replace(/\/$/, '');
    res.redirect(303, `${site}/paiement-termine.html?ok=1`);
  };
  app.post('/api/cinetpay/retour', cinetpayReturn);
  app.get('/api/cinetpay/retour', cinetpayReturn);

  // Où en est le paiement ? (l'application demande toutes les quelques secondes)
  app.get('/api/payments/:id/status', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    let p = await db.query('SELECT * FROM payment_requests WHERE id = $1 AND payer_id = $2', [req.params.id, req.creatorId]);
    if (!p) return res.status(404).json({ error: 'Paiement introuvable.' });
    if (p.status === 'en_attente') {
      await settlePayment(p.id);
      p = await db.query('SELECT * FROM payment_requests WHERE id = $1', [p.id]);
    }
    res.json({ payment: publicPayment(p), balance: await walletBalance(req.creatorId) });
  });

  // pawaPay prévient Eaji (dépôts et envois). Le contenu du message n'est pas cru : Eaji revérifie.
  app.post('/api/payments/callback/pawapay', async (req, res) => {
    const id = String((req.body && (req.body.depositId || req.body.payoutId)) || '');
    if (id) {
      const a = await db.query('SELECT * FROM payment_attempts WHERE gateway_id = $1', [id]).catch(() => null);
      if (a) await settleAttempt(a).catch(() => {});
      else {
        const ap = await db.query('SELECT * FROM admin_payouts WHERE gateway_id = $1', [id]).catch(() => null);
        if (ap) await settleAdminPayout(ap).catch(() => {});
        const w = await db.query('SELECT * FROM withdrawal_requests WHERE gateway_id = $1', [id]).catch(() => null);
        if (w) await settleCreatorPayout(w).catch(() => {});
      }
    }
    res.json({ received: true });
  });

  // Toutes les 2 minutes : les paiements dont la réponse s'est perdue sont revérifiés.
  if (process.env.NODE_ENV !== 'test') setInterval(async () => {
    if (!require('./leader').isLeader()) return; // seulement sur le serveur « chef »
    try {
      const rows = await db.all(
        `SELECT * FROM payment_attempts WHERE status IN ('INITIE','ACCEPTED','PROCESSING','IN_RECONCILIATION','UNKNOWN','CREATED','APPROVED')
           AND created_at > now() - interval '2 days' ORDER BY created_at LIMIT 50`);
      for (const a of rows) await settleAttempt(a).catch(() => {});
    } catch (e) { /* base indisponible : prochain tour */ }
  }, 120000).unref();

  // =================== ARGENT DE L'ADMINISTRATEUR PRINCIPAL ===================
  async function financeSummary() {
    const t = await db.query(
      `SELECT
         COALESCE((SELECT SUM(amount_usd) FROM revenue_ledger WHERE beneficiary = 'eaji'), 0)::float AS eaji_total,
         COALESCE((SELECT SUM(l.amount_usd) FROM revenue_ledger l JOIN payment_requests p ON p.id = l.payment_id
                    WHERE l.beneficiary = 'eaji' AND COALESCE(p.method, 'manuel') NOT IN ('mobile_money', 'paypal', 'cinetpay')), 0)::float AS received_manually,
         COALESCE((SELECT SUM(amount_usd) FROM admin_payouts WHERE status IN ('en_cours', 'a_faire', 'paye')), 0)::float AS withdrawn,
         COALESCE((SELECT SUM(amount_usd) FROM payment_requests WHERE status = 'confirme' AND method IN ('mobile_money', 'paypal', 'cinetpay')), 0)::float AS online_received`);
    const available = M.round2(t.eaji_total - t.received_manually - t.withdrawn);
    return { eajiTotal: M.round2(t.eaji_total), receivedManually: M.round2(t.received_manually), withdrawn: M.round2(t.withdrawn),
      onlineReceived: M.round2(t.online_received), available: Math.max(0, available) };
  }
  // ---------- Argent non réel ----------
  // Est « non réel » tout argent qui n'a pas été reçu par pawaPay, CinetPay ou PayPal : paiements confirmés
  // à la main (identifiant tapé par l'utilisateur), achats payés avec un solde rempli de cette façon,
  // commissions d'ouverture de compte (personne ne les a jamais payées) et anciens abonnements publicitaires sans paiement.
  async function findNonRealPayments() {
    const manual = await db.all(
      `SELECT id FROM payment_requests WHERE status = 'confirme' AND NOT non_reel
         AND COALESCE(method, '') NOT IN ('mobile_money', 'paypal', 'cinetpay') AND COALESCE(proof, '') NOT IN ('solde Eaji', 'gains Eaji')`);
    const fake = new Set(manual.map((r) => r.id));
    // Achats payés avec le solde : réels seulement si le solde venait de dépôts réellement payés en ligne.
    const events = await db.all(
      `SELECT w.creator_id, w.amount_usd, w.kind, w.payment_id FROM wallet_entries w ORDER BY w.creator_id, w.created_at, w.id`);
    let cur = null, real = 0;
    for (const e of events) {
      if (e.creator_id !== cur) { cur = e.creator_id; real = 0; }
      const amt = Number(e.amount_usd);
      if (e.payment_id && fake.has(e.payment_id)) continue; // dépôt non réel : n'ajoute rien
      if (e.kind === 'achat' && e.payment_id) {
        if (real + 0.005 >= -amt) real += amt; else fake.add(e.payment_id);
        continue;
      }
      real += amt;
    }
    return [...fake];
  }
  async function nonRealMoney() {
    const ids = await findNonRealPayments();
    const t = await db.query(
      `SELECT
         COALESCE((SELECT SUM(amount_usd) FROM revenue_ledger WHERE beneficiary = 'eaji' AND payment_id = ANY($1::uuid[])), 0)::float AS eaji,
         COALESCE((SELECT SUM(amount_usd) FROM revenue_ledger WHERE beneficiary = 'createur' AND payment_id = ANY($1::uuid[])), 0)::float AS createurs,
         COALESCE((SELECT SUM(amount_usd) FROM wallet_entries WHERE payment_id = ANY($1::uuid[])), 0)::float AS soldes,
         (SELECT COUNT(*)::int FROM payment_requests WHERE status = 'en_attente' AND proof IS NOT NULL AND COALESCE(method, '') NOT IN ('mobile_money', 'paypal', 'cinetpay')) AS declares`,
      [ids]);
    const commissions = await db.all(
      "SELECT currency, SUM(amount)::float AS total, COUNT(*)::int AS n FROM admin_commissions WHERE type = 'ouverture' GROUP BY currency").catch(() => []);
    const ads = await db.all('SELECT currency, SUM(amount)::float AS total, COUNT(*)::int AS n FROM ad_payments WHERE payment_id IS NULL GROUP BY currency').catch(() => []);
    return { payments: ids.length, eaji: M.round2(t.eaji), createurs: M.round2(t.createurs), soldes: M.round2(t.soldes), declares: t.declares,
      commissions, ads, empty: !ids.length && !commissions.length && !ads.length && !t.declares };
  }
  app.get('/api/admin/finance/non-reel', requireAdminPrincipal, async (req, res) => res.json(await nonRealMoney()));
  // Retire tout l'argent non réel des soldes (Eaji, créateurs, portefeuilles). Rien n'est perdu : chaque ligne
  // retirée est gardée dans money_cleanup_archive. Les abonnements déjà activés ne sont pas touchés.
  app.post('/api/admin/finance/non-reel/clean', requireAdminPrincipal, async (req, res) => {
    if (!(await checkAdminPassword(req.adminId, req.body.password))) return res.status(403).json({ error: 'Mot de passe administrateur incorrect.' });
    const before = await nonRealMoney();
    const ids = await findNonRealPayments();
    const archive = async (kind, sql, params) => {
      const rows = await db.all(sql, params);
      for (const r of rows) await db.query('INSERT INTO money_cleanup_archive (kind, data, admin_id) VALUES ($1, $2, $3)', [kind, JSON.stringify(r), req.adminId]);
      return rows.length;
    };
    if (ids.length) {
      await archive('revenue_ledger', 'DELETE FROM revenue_ledger WHERE payment_id = ANY($1::uuid[]) RETURNING *', [ids]);
      await archive('wallet_entries', 'DELETE FROM wallet_entries WHERE payment_id = ANY($1::uuid[]) RETURNING *', [ids]);
      await db.query(
        `UPDATE payment_requests SET non_reel = TRUE, admin_note = 'Argent non réel retiré le ' || to_char(now(), 'DD/MM/YYYY') WHERE id = ANY($1::uuid[])`, [ids]);
    }
    await archive('admin_commissions', "DELETE FROM admin_commissions WHERE type = 'ouverture' RETURNING *", []).catch(() => 0);
    await archive('ad_payments', 'DELETE FROM ad_payments WHERE payment_id IS NULL RETURNING *', []).catch(() => 0);
    await db.query(
      `UPDATE payment_requests SET status = 'annule', admin_note = 'Paiement déclaré à la main : annulé (seuls les paiements en ligne sont acceptés)'
       WHERE status = 'en_attente' AND proof IS NOT NULL AND COALESCE(method, '') NOT IN ('mobile_money', 'paypal', 'cinetpay')`);
    res.json({ cleaned: true, removed: before, finance: await financeSummary() });
  });

  async function settleAdminPayout(ap) {
    if (ap.status !== 'en_cours' || !ap.gateway_id) return;
    const d = await G.pawapayCheck('payouts', ap.gateway_id).catch(() => ({ status: 'UNKNOWN' }));
    if (d.status === 'COMPLETED') await db.query("UPDATE admin_payouts SET status = 'paye', done_at = now(), note = $2 WHERE id = $1", [ap.id, `pawaPay ${d.providerTransactionId || ''}`.trim()]);
    else if (d.status === 'FAILED' || (d.status === 'NOT_FOUND' && Date.now() - new Date(ap.created_at).getTime() > 5 * 60 * 1000)) {
      await db.query("UPDATE admin_payouts SET status = 'echoue', done_at = now(), note = $2 WHERE id = $1", [ap.id, d.failureReason ? d.failureReason.failureMessage || d.failureReason.failureCode : 'Envoi échoué']);
    }
  }
  async function checkAdminPassword(adminId, password) {
    if (!bcrypt) return false;
    const a = await db.query('SELECT password_hash FROM admins WHERE id = $1', [adminId]);
    return Boolean(a && a.password_hash && password && await bcrypt.compare(String(password), a.password_hash));
  }

  app.get('/api/admin/finance', requireAdminPrincipal, async (req, res) => {
    const pending = await db.all("SELECT * FROM admin_payouts WHERE status = 'en_cours'");
    for (const ap of pending) await settleAdminPayout(ap).catch(() => {});
    const payouts = await db.all('SELECT * FROM admin_payouts ORDER BY created_at DESC LIMIT 100');
    const bySource = await db.all(
      `SELECT source, SUM(amount_usd)::float AS total FROM revenue_ledger WHERE beneficiary = 'eaji' GROUP BY source ORDER BY total DESC`);
    res.json({ ...(await financeSummary()), bySource, payouts,
      gateways: { pawapay: G.pawapayConfigured(), paypal: G.paypalConfigured(), cinetpay: G.cinetpayConfigured() },
      nonReel: await nonRealMoney(),
      providers: G.providersFor('CD').map((p) => ({ code: p.code, name: p.name })) });
  });

  // L'administrateur retire l'argent d'Eaji : mobile money (envoi automatique par pawaPay) ou banque.
  app.post('/api/admin/finance/withdraw', requireAdminPrincipal, async (req, res) => {
    if (!(await checkAdminPassword(req.adminId, req.body.password))) return res.status(403).json({ error: 'Mot de passe administrateur incorrect.' });
    const amount = M.round2(req.body.amountUsd);
    if (!(amount >= 1)) return res.status(400).json({ error: 'Montant invalide (1 $ minimum).' });
    const sum = await financeSummary();
    if (amount > sum.available) return res.status(400).json({ error: `Montant trop élevé : ${sum.available} $ disponibles en ligne.` });
    if (req.body.method === 'mobile_money') {
      const prov = G.providersFor('CD').find((p) => p.code === req.body.provider);
      const msisdn = G.normalizeMsisdn('CD', req.body.phone);
      if (!prov || !msisdn) return res.status(400).json({ error: 'Choisis l\'opérateur et un numéro valide.' });
      if (!G.pawapayConfigured()) {
        const ap = await db.query(
          `INSERT INTO admin_payouts (admin_id, amount_usd, method, destination, provider, status, note) VALUES ($1, $2, 'mobile_money', $3, $4, 'a_faire', $5) RETURNING *`,
          [req.adminId, amount, '+' + msisdn, prov.code, 'pawaPay non configuré : envoi à faire depuis ton compte de paiement.']);
        return res.status(201).json({ payout: ap });
      }
      const payoutId = G.newId();
      const ap = await db.query(
        `INSERT INTO admin_payouts (admin_id, amount_usd, method, destination, provider, gateway_id, status) VALUES ($1, $2, 'mobile_money', $3, $4, $5, 'en_cours') RETURNING *`,
        [req.adminId, amount, '+' + msisdn, prov.code, payoutId]);
      let r; try { r = await G.pawapayPayout({ payoutId, amount: amount.toFixed(2), currency: 'USD', msisdn, provider: prov.code }); } catch (e) { r = { status: 'UNKNOWN' }; }
      if (r.status === 'REJECTED') {
        await db.query("UPDATE admin_payouts SET status = 'echoue', done_at = now(), note = $2 WHERE id = $1", [ap.id, failureText(r.failureReason)]);
        return res.status(400).json({ error: failureText(r.failureReason) });
      }
      return res.status(201).json({ payout: await db.query('SELECT * FROM admin_payouts WHERE id = $1', [ap.id]) });
    }
    if (req.body.method === 'banque') {
      const bank = ['bankName', 'accountName', 'accountNumber'].map((k) => String(req.body[k] || '').trim().slice(0, 80));
      if (bank.some((x) => !x)) return res.status(400).json({ error: 'Indique la banque, le titulaire et le numéro de compte.' });
      const swift = String(req.body.swift || '').trim().slice(0, 20);
      const ap = await db.query(
        `INSERT INTO admin_payouts (admin_id, amount_usd, method, destination, status, note) VALUES ($1, $2, 'banque', $3, 'a_faire', $4) RETURNING *`,
        [req.adminId, amount, `${bank[0]} — ${bank[1]} — ${bank[2]}${swift ? ' — SWIFT ' + swift : ''}`,
         'Virement à demander depuis le tableau de bord pawaPay ou PayPal vers ce compte, puis à marquer « fait ».']);
      return res.status(201).json({ payout: ap });
    }
    res.status(400).json({ error: 'Choisis mobile money ou banque.' });
  });
  app.post('/api/admin/finance/payouts/:id/done', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const ap = await db.query("UPDATE admin_payouts SET status = 'paye', done_at = now() WHERE id = $1 AND status = 'a_faire' RETURNING id", [req.params.id]);
    if (!ap) return res.status(404).json({ error: 'Retrait introuvable ou déjà traité.' });
    res.json({ done: true });
  });
  app.post('/api/admin/finance/payouts/:id/cancel', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const ap = await db.query("UPDATE admin_payouts SET status = 'echoue', done_at = now(), note = 'Annulé' WHERE id = $1 AND status = 'a_faire' RETURNING id", [req.params.id]);
    if (!ap) return res.status(404).json({ error: 'Retrait introuvable ou déjà traité.' });
    res.json({ cancelled: true });
  });

  // Retrait d'un créateur envoyé directement sur son mobile money par pawaPay.
  const OPERATOR_CODES = { mpesa: 'VODACOM_MPESA_COD', vodacom_mpesa: 'VODACOM_MPESA_COD', orange_money: 'ORANGE_COD', airtel_money: 'AIRTEL_COD' };
  async function markWithdrawalPaid(w, adminId, note) {
    const done = await db.query(
      `UPDATE withdrawal_requests SET status = 'paye', processed_at = now(), admin_id = COALESCE($2, admin_id), admin_note = $3, gateway_status = 'COMPLETED'
       WHERE id = $1 AND status = 'en_attente' RETURNING *`, [w.id, adminId || null, note]);
    if (!done) return;
    await db.query('INSERT INTO revenue_ledger (beneficiary, creator_id, source, amount_usd) VALUES ($1, $2, $3, $4)',
      ['eaji', done.creator_id, done.source === 'portefeuille' ? 'frais_retrait_portefeuille' : 'frais_retrait', done.fee_usd]);
    await notify(done.creator_id, 'retrait', `💸 Ton retrait de ${Number(done.net_usd).toFixed(2)} $ a été envoyé sur ton mobile money.`, 's-paiements');
  }
  async function settleCreatorPayout(w) {
    if (w.status !== 'en_attente' || !w.gateway_id || w.gateway_status === 'COMPLETED') return;
    const d = await G.pawapayCheck('payouts', w.gateway_id).catch(() => ({ status: 'UNKNOWN' }));
    if (d.status === 'COMPLETED') await markWithdrawalPaid(w, null, `Envoyé par pawaPay ${d.providerTransactionId || ''}`.trim());
    else if (d.status === 'FAILED') await db.query("UPDATE withdrawal_requests SET gateway_status = 'FAILED', gateway_id = NULL, admin_note = $2 WHERE id = $1", [w.id, 'Envoi automatique échoué : ' + (d.failureReason ? d.failureReason.failureCode : 'erreur')]);
    else await db.query('UPDATE withdrawal_requests SET gateway_status = $2 WHERE id = $1', [w.id, d.status]);
  }
  app.post('/api/admin/withdrawals/:id/send-mobile', requireAdminPrincipal, async (req, res) => {
    if (!G.pawapayConfigured()) return res.status(503).json({ error: 'pawaPay n\'est pas configuré : paie à la main puis clique « Payé ».' });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    if (await heldCheck(req, res)) return;
    const w = await db.query(
      `SELECT w.*, cr.country_code FROM withdrawal_requests w JOIN creators cr ON cr.id = w.creator_id WHERE w.id = $1 AND w.status = 'en_attente'`, [req.params.id]);
    if (!w) return res.status(404).json({ error: 'Retrait introuvable ou déjà traité.' });
    if (w.gateway_id && w.gateway_status !== 'FAILED') return res.status(409).json({ error: 'Envoi déjà en cours.' });
    const acc = await db.query('SELECT aggregator, external_account_id FROM payout_accounts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1', [w.creator_id]);
    const msisdn = acc && G.normalizeMsisdn(w.country_code, acc.external_account_id);
    const providers = G.providersFor(w.country_code);
    const code = (acc && OPERATOR_CODES[acc.aggregator]) || G.guessProvider(w.country_code, msisdn);
    const prov = providers.find((p) => p.code === code);
    if (!msisdn || !prov) return res.status(400).json({ error: 'Numéro ou opérateur du créateur non pris en charge par pawaPay : paie-le à la main.' });
    const amt = G.mobileAmount(prov, w.net_usd, convertFromUSD);
    const payoutId = G.newId();
    await db.query("UPDATE withdrawal_requests SET gateway_id = $2, gateway_status = 'INITIE', admin_id = $3 WHERE id = $1", [w.id, payoutId, req.adminId]);
    let r; try { r = await G.pawapayPayout({ payoutId, amount: amt.amount, currency: amt.currency, msisdn, provider: prov.code }); } catch (e) { r = { status: 'UNKNOWN' }; }
    if (r.status === 'REJECTED') {
      await db.query("UPDATE withdrawal_requests SET gateway_status = 'FAILED', gateway_id = NULL WHERE id = $1", [w.id]);
      return res.status(400).json({ error: failureText(r.failureReason) });
    }
    await db.query('UPDATE withdrawal_requests SET gateway_status = $2 WHERE id = $1', [w.id, r.status || 'UNKNOWN']);
    res.json({ sending: true, message: `Envoi de ${amt.amount} ${amt.currency} au +${msisdn} (${prov.name}) en cours.` });
  });

  return { accessMap, premiumUntil, businessUntil, adsForFeed, MAX_VIDEO_SECONDS: M.MAX_VIDEO_SECONDS };
}

module.exports = { register, MIGRATIONS, TRANSFERS_ENABLED };
