// Eaji — « Annoncer sur Eaji » : page ouverte à tous (même sans compte) pour les entreprises qui découvrent Eaji.
//  • Les vrais chiffres d'audience (totaux uniquement, jamais de données personnelles), recalculés toutes les 10 minutes.
//  • Les offres du compte Entreprise, dont l'essai à 3 $ pour 5 jours (une seule fois par compte).
//  • Le contact WhatsApp de l'administrateur principal et un formulaire qui arrive dans l'administration.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHATSAPP = '+243850171480'; // contact « Annoncer sur Eaji » choisi par l'administrateur principal

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS advertise_requests (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID REFERENCES creators(id) ON DELETE SET NULL,
     name TEXT NOT NULL,
     company TEXT NOT NULL,
     contact TEXT NOT NULL,
     country_code TEXT,
     message TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'nouveau' CHECK (status IN ('nouveau', 'traite')),
     admin_note TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     handled_at TIMESTAMPTZ)`,
  'CREATE INDEX IF NOT EXISTS advertise_requests_status ON advertise_requests (status, created_at DESC)',
];

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

function register({ app, db, requireAdminPrincipal, optionalViewerId, rateLimit, notifyAdmins = async () => {}, M }) {
  // ---------- Chiffres d'audience (cache 10 minutes) ----------
  let cache = null, cacheAt = 0;
  async function audience() {
    if (cache && Date.now() - cacheAt < 10 * 60 * 1000) return cache;
    const r = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM creators WHERE account_status = 'actif' AND last_seen_at > now() - interval '30 days') AS active30,
              (SELECT COUNT(*)::int FROM creators WHERE account_status = 'actif' AND last_seen_at > now() - interval '7 days') AS active7,
              (SELECT COUNT(*)::int FROM creators WHERE account_status = 'actif') AS accounts,
              (SELECT COUNT(DISTINCT country_code)::int FROM creators WHERE account_status = 'actif' AND country_code IS NOT NULL) AS countries,
              (SELECT COUNT(*)::int FROM content_view_log WHERE day > CURRENT_DATE - 30) AS views30,
              (SELECT COUNT(*)::int FROM content_items WHERE status = 'actif' AND created_at > now() - interval '30 days') AS posts30`);
    const top = await db.all(
      `SELECT country_code AS code, COUNT(*)::int AS n FROM creators
       WHERE account_status = 'actif' AND last_seen_at > now() - interval '30 days' AND country_code IS NOT NULL
       GROUP BY country_code ORDER BY n DESC LIMIT 5`);
    cache = { ...r, topCountries: top, updatedAt: new Date().toISOString() };
    cacheAt = Date.now();
    return cache;
  }

  app.get('/api/advertise/info', async (req, res) => {
    const plans = M.BUSINESS_PLANS;
    let trialAvailable = true;
    const viewer = optionalViewerId(req);
    if (viewer) trialAvailable = !(await trialUsed(viewer));
    res.json({
      audience: await audience(),
      whatsapp: WHATSAPP,
      plans: Object.entries(plans).map(([id, p]) => ({ id, price: p.price, days: p.days, months: p.months, label: p.label, trial: Boolean(p.trial) })),
      trialAvailable,
      loggedIn: Boolean(viewer),
    });
  });

  // L'essai Entreprise (3 $ pour 5 jours) : une seule fois, pour un compte qui n'a jamais eu le compte Entreprise.
  async function trialUsed(creatorId) {
    const r = await db.query(
      `SELECT EXISTS (SELECT 1 FROM premium_subscriptions WHERE creator_id = $1 AND plan LIKE 'entreprise%')
           OR EXISTS (SELECT 1 FROM payment_requests WHERE payer_id = $1 AND purpose = 'entreprise_essai'
                        AND (status = 'confirme' OR (status = 'en_attente' AND created_at > now() - interval '1 hour'))) AS used`, [creatorId]);
    return Boolean(r && r.used);
  }

  // ---------- Écrire à l'administrateur (avec ou sans compte) ----------
  app.post('/api/advertise/contact',
    rateLimit('annonce-contact', 5, 60 * 60 * 1000, 'Trop de messages envoyés depuis ce réseau. Réessaie dans une heure, ou écris-nous sur WhatsApp.'),
    async (req, res) => {
      const b = req.body || {};
      const name = clean(b.name, 80), company = clean(b.company, 120), contact = clean(b.contact, 120), message = clean(b.message, 1500);
      const country = /^[A-Z]{2}$/.test(String(b.countryCode || '').toUpperCase()) ? String(b.countryCode).toUpperCase() : null;
      if (name.length < 2) return res.status(400).json({ error: 'Indique ton nom.' });
      if (company.length < 2) return res.status(400).json({ error: "Indique le nom de ton entreprise." });
      const digits = contact.replace(/\D/g, '');
      if (!(digits.length >= 8 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact))) return res.status(400).json({ error: 'Indique un numéro de téléphone (WhatsApp) ou une adresse email pour te répondre.' });
      if (message.length < 5) return res.status(400).json({ error: 'Écris ton message (ce que tu veux annoncer).' });
      const viewer = optionalViewerId(req);
      const row = await db.query(
        `INSERT INTO advertise_requests (creator_id, name, company, contact, country_code, message) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [viewer && UUID_RE.test(String(viewer)) ? viewer : null, name, company, contact, country, message]);
      notifyAdmins({ title: `📣 Annonceur : ${company}`, body: `${name} (${contact}) : ${message.slice(0, 140)}`, link: 'admin:v-advertise', kind: 'annonceur' });
      res.status(201).json({ sent: true, id: row.id });
    });

  // ---------- Administration (administrateur principal) ----------
  app.get('/api/admin/advertise/requests', requireAdminPrincipal, async (req, res) => {
    const rows = await db.all(
      `SELECT a.*, cr.name AS account_name,
              EXISTS (SELECT 1 FROM premium_subscriptions ps WHERE ps.creator_id = a.creator_id AND ps.plan LIKE 'entreprise%' AND ps.ends_at > now()) AS is_business
       FROM advertise_requests a LEFT JOIN creators cr ON cr.id = a.creator_id
       ORDER BY CASE WHEN a.status = 'nouveau' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 300`);
    const k = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM advertise_requests WHERE status = 'nouveau') AS pending,
              (SELECT COUNT(*)::int FROM advertise_requests) AS total,
              (SELECT COUNT(*)::int FROM premium_subscriptions WHERE plan = 'entreprise_essai') AS trials,
              (SELECT COUNT(DISTINCT t.creator_id)::int FROM premium_subscriptions t
                 WHERE t.plan = 'entreprise_essai' AND EXISTS (SELECT 1 FROM premium_subscriptions p2 WHERE p2.creator_id = t.creator_id AND p2.plan IN ('entreprise_mois', 'entreprise_annee'))) AS trials_converted,
              (SELECT COUNT(DISTINCT creator_id)::int FROM premium_subscriptions WHERE plan LIKE 'entreprise%' AND ends_at > now()) AS active_business`);
    res.json({ requests: rows, ...k, audience: await audience(), whatsapp: WHATSAPP });
  });
  app.post('/api/admin/advertise/requests/:id/done', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const r = await db.query(
      `UPDATE advertise_requests SET status = 'traite', handled_at = now(), admin_note = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, clean(req.body && req.body.note, 500) || null]);
    if (!r) return res.status(404).json({ error: 'Demande introuvable.' });
    res.json({ done: true });
  });

  return { trialUsed, audience };
}

module.exports = { MIGRATIONS, register, WHATSAPP };
