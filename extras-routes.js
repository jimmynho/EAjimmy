// Eaji — fonctions complémentaires :
//  1. Rémunération mensuelle (2 $ / 1 000 abonnés) : préparée automatiquement chaque mois,
//     créditée sur les gains des créateurs quand l'administrateur principal valide.
//  2. Mot de passe oublié (code par email ou SMS) + réinitialisation par l'administrateur.
//  3. Recherche de créateurs et de publications.
//  4. Notifications dans l'application (abonné, message, cadeau, paiement, live, rémunération).

const crypto = require('crypto');
const { calculateMonthlyPayout } = require('./rate-engine');
const { dialOf } = require('./world-countries');

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS notifications (
     id BIGSERIAL PRIMARY KEY,
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     link TEXT,
     read_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS notifications_creator_idx ON notifications (creator_id, id DESC)',
  `CREATE TABLE IF NOT EXISTS monthly_payouts (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     period TEXT NOT NULL,
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     subscribers INTEGER NOT NULL,
     views INTEGER NOT NULL,
     amount_usd NUMERIC(12,2) NOT NULL,
     status TEXT NOT NULL DEFAULT 'propose' CHECK (status IN ('propose', 'credite', 'annule')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     credited_at TIMESTAMPTZ,
     UNIQUE (period, creator_id))`,
  // Détail du calcul : vues du mois, abonnés payés (règle des 70 %), montant avant budget, part du budget.
  'ALTER TABLE monthly_payouts ADD COLUMN IF NOT EXISTS monthly_views INTEGER',
  'ALTER TABLE monthly_payouts ADD COLUMN IF NOT EXISTS paid_subscribers INTEGER',
  'ALTER TABLE monthly_payouts ADD COLUMN IF NOT EXISTS base_amount_usd NUMERIC(12,2)',
  'ALTER TABLE monthly_payouts ADD COLUMN IF NOT EXISTS budget_factor NUMERIC(6,4)',
  `CREATE TABLE IF NOT EXISTS password_resets (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     code_hash TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     used BOOLEAN NOT NULL DEFAULT FALSE,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ',
];

// Mois précédent au format AAAA-MM (la rémunération d'octobre est préparée début novembre).
function previousPeriod(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Numéro au format international (+243812345678), quelle que soit la façon de l'écrire :
// 0812 345 678, 812345678, 243812345678, 00243…, +243 812-345-678. null si ce n'est pas un numéro.
function normalizePhone(raw, countryCode) {
  let num = String(raw || '').trim().replace(/[\s.()\-\/]/g, '');
  if (num.startsWith('00')) num = '+' + num.slice(2);
  if (!/^\+?\d{6,15}$/.test(num)) return null;
  const dial = dialOf(countryCode);
  const d = dial ? dial.slice(1) : null;
  if (num.startsWith('+')) {
    // +243 0812… : le 0 du numéro local écrit après l'indicatif est retiré.
    if (d && num.startsWith('+' + d + '0')) return '+' + d + num.slice(d.length + 1).replace(/^0+/, '');
    return num;
  }
  if (d && num.startsWith(d) && num.length >= d.length + 8) return '+' + num;   // 243812345678
  const local = num.replace(/^0+/, '');
  return d ? '+' + d + local : num;
}
// Les 9 derniers chiffres (ou moins pour un numéro court) : identiques quelle que soit l'écriture du numéro.
function phoneTail(raw) {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 6 ? digits.slice(-9) : null;
}
const DIGITS_SQL = "regexp_replace(phone, '[^0-9]', '', 'g')";

// Retrouve un compte avec son email OU son numéro de téléphone, écrit de n'importe quelle façon
// (0812 345 678, 812345678, +243812345678, 00243…), même si le numéro a été enregistré autrement.
// countryCode (pays de l'appareil) départage deux comptes de pays différents.
async function findAccount(db, identifier, countryCode, { excludeId = null } = {}) {
  const raw = String(identifier || '').trim();
  if (!raw) return { creator: null, via: 'email' };
  if (raw.includes('@')) {
    return { creator: await db.query('SELECT * FROM creators WHERE lower(email) = lower($1)', [raw]), via: 'email' };
  }
  const num = raw.replace(/[\s.()\-\/]/g, '').replace(/^00/, '+');
  if (!/^\+?\d{6,15}$/.test(num)) return { creator: null, via: 'telephone' };
  const canon = normalizePhone(num, countryCode);
  const tail = phoneTail(num);
  const rows = await db.all(
    `SELECT * FROM creators WHERE (phone = $1 OR phone = $2 OR right(${DIGITS_SQL}, length($3)) = $3)
       AND ($4::uuid IS NULL OR id <> $4) LIMIT 10`, [canon, num, tail, excludeId]);
  if (rows.length <= 1) return { creator: rows[0] || null, via: 'telephone' };
  // Plusieurs comptes finissent par les mêmes chiffres : le même numéro exact d'abord, puis le pays.
  const digitsOf = (p) => String(p || '').replace(/\D/g, '');
  const exact = rows.filter((r) => r.phone === canon || r.phone === num || (canon && digitsOf(r.phone) === digitsOf(canon)));
  if (exact.length === 1) return { creator: exact[0], via: 'telephone' };
  const cc = String(countryCode || '').toUpperCase();
  const same = (exact.length ? exact : rows).filter((r) => r.country_code === cc);
  if (same.length === 1) return { creator: same[0], via: 'telephone' };
  return { creator: null, via: 'telephone', ambiguous: true };
}

// opts : { title, body } pour le texte affiché sur le téléphone, inApp:false pour ne rien mettre dans la cloche.
function makeNotifier(db, sendPush) {
  return async function notify(creatorId, kind, text, link = null, opts = {}) {
    if (!creatorId) return;
    if (opts.inApp !== false) {
      try {
        await db.query('INSERT INTO notifications (creator_id, kind, text, link) VALUES ($1, $2, $3, $4)', [creatorId, kind, String(text).slice(0, 300), link]);
      } catch (e) { console.error('[Eaji] Notification non enregistrée :', e.message); }
    }
    // Sur l'appareil (écran verrouillé compris), sans faire attendre la personne qui agit.
    if (sendPush) sendPush(creatorId, { kind, link, title: opts.title, body: opts.body || text, urgent: kind === 'appel' }).catch(() => {});
  };
}

function register({ app, db, bcrypt, requireAuth, requireAdminPrincipal, requireAdminPermission, optionalViewerId,
  createDownloadUrl, isMonetizedCreator, trySendEmail, sendSms, notify }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ==================== 1. RÉMUNÉRATION MENSUELLE ====================
  // Budget : la rémunération totale d'un mois ne dépasse jamais ce pourcentage de ce qu'Eaji a gagné
  // ce mois-là (réglable par l'administrateur principal). Si les montants calculés dépassent le budget,
  // chaque créateur reçoit la même proportion de son montant.
  const DEFAULT_BUDGET_PERCENT = 30;
  async function budgetPercent() {
    const r = await db.query("SELECT value FROM app_settings WHERE key = 'payout_budget_percent'");
    const v = r ? Number(r.value) : DEFAULT_BUDGET_PERCENT;
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_BUDGET_PERCENT;
  }
  async function eajiRevenueOf(period) {
    const r = await db.query(
      `SELECT COALESCE(SUM(amount_usd), 0)::float AS total FROM revenue_ledger
       WHERE beneficiary = 'eaji' AND created_at >= ($1 || '-01')::date AND created_at < ($1 || '-01')::date + interval '1 month'`, [period]);
    return Math.round((r ? r.total : 0) * 100) / 100;
  }
  async function budgetOf(period) {
    const percent = await budgetPercent();
    const revenue = await eajiRevenueOf(period);
    const budget = Math.round(revenue * percent) / 100;
    const used = await db.query("SELECT COALESCE(SUM(amount_usd), 0)::float AS total FROM monthly_payouts WHERE period = $1 AND status <> 'annule'", [period]);
    return { percent, revenue, budget, used: Math.round((used ? used.total : 0) * 100) / 100 };
  }

  async function prepareMonthlyPayouts(period) {
    const rows = await db.all(
      `SELECT c.id, c.country_code, c.phone,
              GREATEST(COALESCE((SELECT subscriber_count FROM subscriber_counts WHERE creator_id = c.id ORDER BY verified_at DESC LIMIT 1), 0),
                       (SELECT COUNT(*)::int FROM follows WHERE followed_id = c.id)) AS subscribers,
              -- Les vues des contenus créés par IA ne comptent jamais pour la rémunération.
              (SELECT COALESCE(SUM(view_count), 0)::int FROM content_items WHERE creator_id = c.id AND NOT ai_generated) AS views,
              (SELECT COUNT(*)::int FROM content_view_log v WHERE v.creator_id = c.id
                 AND v.day >= ($1 || '-01')::date AND v.day < ($1 || '-01')::date + interval '1 month'
                 AND NOT EXISTS (SELECT 1 FROM content_items ci WHERE ci.id = v.content_id AND ci.ai_generated)) AS monthly_views,
              EXISTS (SELECT 1 FROM premium_subscriptions ps WHERE ps.creator_id = c.id AND ps.ends_at > now()) AS premium,
              EXISTS (SELECT 1 FROM monthly_payouts mp WHERE mp.creator_id = c.id AND mp.period = $1) AS already
       FROM creators c WHERE c.account_status = 'actif'`, [period]);
    const candidates = [];
    for (const r of rows) {
      if (r.already) continue;
      if (!isMonetizedCreator(r.country_code, r.phone)) continue;
      if (!r.premium) continue; // rémunération réservée aux comptes Premium
      // Paliers des grands comptes + règle des 70 % de vues du mois.
      const p = calculateMonthlyPayout({ subscribers: Number(r.subscribers), views: Number(r.views), monthlyViews: Number(r.monthly_views), currency: 'USD' });
      if (!p.eligible || !(p.amount > 0)) continue;
      candidates.push({ r, p });
    }
    if (!candidates.length) return 0;
    // Budget du mois : ce qui reste après les lignes déjà préparées.
    const b = await budgetOf(period);
    const remaining = Math.max(0, b.budget - b.used);
    const totalBase = candidates.reduce((s, c) => s + c.p.amount, 0);
    const factor = totalBase > remaining ? remaining / totalBase : 1;
    let created = 0;
    for (const { r, p } of candidates) {
      const amount = Math.floor(p.amount * factor * 100) / 100;
      const ins = await db.query(
        `INSERT INTO monthly_payouts (period, creator_id, subscribers, views, amount_usd, monthly_views, paid_subscribers, base_amount_usd, budget_factor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (period, creator_id) DO NOTHING RETURNING id`,
        [period, r.id, r.subscribers, r.views, amount, r.monthly_views, p.paidSubscribers, p.amount, Math.round(factor * 10000) / 10000]);
      if (ins) created++;
    }
    return created;
  }

  // Chaque mois, la liste du mois écoulé est préparée toute seule (vérifié au démarrage puis toutes les 6 h).
  async function autoPrepare() {
    try {
      const period = previousPeriod();
      const done = await db.query("SELECT value FROM app_settings WHERE key = 'payouts_prepared'");
      if (done && done.value === period) return;
      const n = await prepareMonthlyPayouts(period);
      await db.query(
        `INSERT INTO app_settings (key, value) VALUES ('payouts_prepared', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [period]);
      console.log(`[Eaji] Rémunération ${period} préparée : ${n} créateur(s) éligible(s).`);
    } catch (e) { console.error('[Eaji] Préparation de la rémunération mensuelle impossible :', e.message); }
  }
  // Remplacé par la rémunération par période d'abonnement (cycles-routes.js) : plus de calcul par mois civil,
  // pour ne jamais payer deux fois. Les anciennes lignes de mois restent consultables et créditables.
  void autoPrepare;

  app.get('/api/admin/payouts', requireAdminPrincipal, async (req, res) => {
    const period = /^\d{4}-\d{2}$/.test(String(req.query.period || '')) ? req.query.period : previousPeriod();
    const items = await db.all(
      `SELECT m.id, m.period, m.subscribers, m.views, m.amount_usd, m.status, m.credited_at, cr.name, cr.country_code,
              m.monthly_views, m.paid_subscribers, m.base_amount_usd, m.budget_factor
       FROM monthly_payouts m JOIN creators cr ON cr.id = m.creator_id
       WHERE m.period = $1 ORDER BY m.amount_usd DESC`, [period]);
    const periods = (await db.all('SELECT DISTINCT period FROM monthly_payouts ORDER BY period DESC LIMIT 24')).map((p) => p.period);
    const sum = (st) => items.filter((i) => i.status === st).reduce((s, i) => s + Number(i.amount_usd), 0);
    const all = await db.query("SELECT COALESCE(SUM(amount_usd), 0)::float AS total FROM monthly_payouts WHERE status = 'credite'");
    res.json({ period, periods, items, toCredit: Math.round(sum('propose') * 100) / 100, credited: Math.round(sum('credite') * 100) / 100, creditedAllTime: all.total,
      budget: await budgetOf(period) });
  });

  // Pourcentage des revenus d'Eaji consacré chaque mois à la rémunération des créateurs.
  app.put('/api/admin/payouts/budget', requireAdminPrincipal, async (req, res) => {
    const percent = Number(req.body.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return res.status(400).json({ error: 'Le pourcentage doit être entre 0 et 100.' });
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('payout_budget_percent', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [String(Math.round(percent * 10) / 10)]);
    res.json({ percent: await budgetPercent() });
  });

  // Recalcule (ajoute les nouveaux éligibles) pour une période donnée.
  app.post('/api/admin/payouts/prepare', requireAdminPrincipal, async (req, res) => {
    if (true) return res.status(410).json({ error: 'La rémunération est maintenant calculée automatiquement à chaque période d\'abonnement des créateurs.' });
    const period = /^\d{4}-\d{2}$/.test(String(req.body.period || '')) ? req.body.period : previousPeriod();
    const created = await prepareMonthlyPayouts(period);
    res.json({ period, created });
  });

  // Corriger le montant proposé d'un créateur (erreur de calcul) avant de créditer le mois.
  app.patch('/api/admin/payouts/:id', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const amount = Math.round(Number(req.body.amountUsd) * 100) / 100;
    if (!(amount >= 0) || amount > 1000000) return res.status(400).json({ error: 'Montant invalide.' });
    const r = await db.query("UPDATE monthly_payouts SET amount_usd = $1 WHERE id = $2 AND status = 'propose' RETURNING id", [amount, req.params.id]);
    if (!r) return res.status(404).json({ error: 'Ligne introuvable ou déjà créditée (pour une ligne créditée, corrige les gains du créateur).' });
    res.json({ updated: true, amountUsd: amount });
  });

  app.post('/api/admin/payouts/:id/cancel', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const r = await db.query("UPDATE monthly_payouts SET status = 'annule' WHERE id = $1 AND status = 'propose' RETURNING id", [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Ligne introuvable ou déjà créditée.' });
    res.json({ cancelled: true });
  });

  // Crédite d'un coup toute la rémunération proposée du mois sur les gains des créateurs.
  app.post('/api/admin/payouts/credit', requireAdminPrincipal, async (req, res) => {
    const period = /^\d{4}-\d{2}$/.test(String(req.body.period || '')) ? req.body.period : previousPeriod();
    const credited = await db.all(
      `UPDATE monthly_payouts SET status = 'credite', credited_at = now()
       WHERE period = $1 AND status = 'propose' RETURNING id, creator_id, amount_usd`, [period]);
    for (const c of credited) {
      if (!(Number(c.amount_usd) > 0)) continue; // budget du mois épuisé : rien à ajouter
      await db.query(
        "INSERT INTO revenue_ledger (beneficiary, creator_id, source, amount_usd) VALUES ('createur', $1, 'remuneration', $2)",
        [c.creator_id, c.amount_usd]);
      await notify(c.creator_id, 'remuneration', `💰 Ta rémunération de ${period} (${Number(c.amount_usd).toFixed(2)} $) a été ajoutée à tes gains.`, 's-paiements');
    }
    const total = credited.reduce((s, c) => s + Number(c.amount_usd), 0);
    res.json({ period, creators: credited.length, total: Math.round(total * 100) / 100 });
  });

  // ==================== 2. MOT DE PASSE OUBLIÉ ====================
  app.post('/api/auth/forgot', async (req, res) => {
    const found = await findAccount(db, req.body.identifier || req.body.email, req.body.countryCode);
    const byPhone = found.via === 'telephone';
    const generic = { message: byPhone && !sendSms
      ? "Pour un compte créé avec un numéro de téléphone, contacte l'administrateur Eaji : après vérification, il te donnera un mot de passe provisoire."
      : "Si un compte existe, un code vient d'être envoyé (regarde aussi les spams). Sans réponse, contacte l'administrateur Eaji.", noCode: byPhone && !sendSms };
    const creator = found.creator && found.creator.account_status === 'actif' ? found.creator : null;
    if (!creator) return res.json(generic);
    // Ni email ni SMS possible : aucun code n'est créé (il ne doit jamais s'afficher à l'écran).
    if (!sendSms && (byPhone || !creator.email)) return res.json(generic);
    const recent = await db.query("SELECT 1 FROM password_resets WHERE creator_id = $1 AND created_at > now() - interval '1 minute'", [creator.id]);
    if (recent) return res.json(generic);
    const code = crypto.randomInt(100000, 999999).toString();
    await db.query(
      "INSERT INTO password_resets (creator_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
      [creator.id, await bcrypt.hash(code, 10)]);
    const text = `Eaji — code pour choisir un nouveau mot de passe : ${code} (valable 15 minutes). Si tu n'as rien demandé, ignore ce message.`;
    // Par sécurité, ce code n'est JAMAIS affiché à l'écran : il part seulement par email ou SMS.
    if (creator.email && !byPhone) await trySendEmail(creator.email, 'Eaji — nouveau mot de passe', text);
    if (sendSms) sendSms(creator.phone, text).catch(() => {});
    res.json(generic);
  });

  app.post('/api/auth/reset', async (req, res) => {
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 8) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
    const creator = (await findAccount(db, req.body.identifier || req.body.email, req.body.countryCode)).creator;
    const reset = creator && await db.query(
      `SELECT * FROM password_resets WHERE creator_id = $1 AND used = FALSE AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`, [creator.id]);
    if (!reset || reset.attempts >= 5) return res.status(400).json({ error: 'Code invalide ou expiré. Demande un nouveau code.' });
    if (!(await bcrypt.compare(code, reset.code_hash))) {
      await db.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [reset.id]);
      return res.status(400).json({ error: 'Code invalide ou expiré. Demande un nouveau code.' });
    }
    await db.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);
    await db.query('UPDATE creators SET password_hash = $1, session_version = session_version + 1 WHERE id = $2', [await bcrypt.hash(newPassword, 12), creator.id]);
    res.json({ updated: true });
  });

  // L'administrateur peut donner un mot de passe provisoire (après avoir vérifié l'identité par téléphone).
  app.post('/api/admin/creators/:id/reset-password', requireAdminPermission('gerer_comptes_utilisateurs'), async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let temp = ''; for (const b of crypto.randomBytes(10)) temp += alphabet[b % alphabet.length];
    const r = await db.query('UPDATE creators SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING name', [await bcrypt.hash(temp, 12), req.params.id]);
    if (!r) return res.status(404).json({ error: 'Compte introuvable.' });
    res.json({ temporaryPassword: temp, name: r.name });
  });

  // ==================== 3. RECHERCHE ====================
  app.get('/api/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.json({ creators: [], contents: [] });
    const viewerId = optionalViewerId(req);
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const notBlocked = (col) => `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${col} AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = ${col}))`;
    const creators = await db.all(
      `SELECT c.id, c.name, c.country_code, c.photo_url, c.phone,
              (SELECT COUNT(*)::int FROM follows WHERE followed_id = c.id) AS followers
       FROM creators c WHERE c.account_status = 'actif' AND c.name ILIKE $1 AND ${notBlocked('c.id')}
       ORDER BY followers DESC, c.name LIMIT 20`, [like, viewerId]);
    for (const c of creators) {
      c.photoUrl = await createDownloadUrl(c.photo_url).catch(() => null);
      c.monetized = isMonetizedCreator(c.country_code, c.phone);
      delete c.photo_url; delete c.phone;
    }
    const contents = await db.all(
      `SELECT ci.id, ci.title, ci.content_type, ci.created_at, cr.id AS creator_id, cr.name AS creator_name
       FROM content_items ci JOIN creators cr ON cr.id = ci.creator_id
       WHERE ci.status = 'actif' AND cr.account_status = 'actif' AND ci.visibility_scope = 'public'
         AND ci.title ILIKE $1 AND ${notBlocked('cr.id')}
       ORDER BY ci.view_count DESC, ci.created_at DESC LIMIT 20`, [like, viewerId]);
    res.json({ creators, contents });
  });

  // ==================== 4. NOTIFICATIONS ====================
  app.get('/api/notifications', requireAuth, async (req, res) => {
    const items = await db.all(
      'SELECT id, kind, text, link, read_at, created_at FROM notifications WHERE creator_id = $1 ORDER BY id DESC LIMIT 50', [req.creatorId]);
    const unread = await db.query('SELECT COUNT(*)::int AS n FROM notifications WHERE creator_id = $1 AND read_at IS NULL', [req.creatorId]);
    res.json({ items, unread: unread.n });
  });

  app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
    await db.query('UPDATE notifications SET read_at = now() WHERE creator_id = $1 AND read_at IS NULL', [req.creatorId]);
    res.json({ ok: true });
  });

  return { prepareMonthlyPayouts, previousPeriod };
}

module.exports = { register, MIGRATIONS, makeNotifier, previousPeriod, findAccount, normalizePhone, phoneTail };
