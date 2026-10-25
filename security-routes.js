// Eaji — centre de sécurité : activités suspectes et tentatives de piratage des comptes.
//
// Ce qui est surveillé : mots de passe faux répétés, codes de confirmation faux, comptes verrouillés,
// une même adresse internet qui essaie beaucoup de comptes différents (attaque), connexions depuis un
// nouvel appareil, tentatives sur l'administration. L'administrateur voit tout et peut bloquer une
// adresse, déconnecter un compte de partout, ou le suspendre.

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS security_events (
     id BIGSERIAL PRIMARY KEY,
     kind TEXT NOT NULL,
     level TEXT NOT NULL CHECK (level IN ('info', 'alerte', 'critique')),
     creator_id UUID REFERENCES creators(id) ON DELETE SET NULL,
     identifier TEXT,
     ip_address TEXT,
     device TEXT,
     detail TEXT NOT NULL,
     resolved BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS security_events_time ON security_events (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS security_events_ip ON security_events (ip_address, created_at)',
  'ALTER TABLE security_blocklist ADD COLUMN IF NOT EXISTS blocked_by UUID',
];

const LABELS = {
  connexion_echouee: 'Mot de passe faux', compte_verrouille: 'Compte verrouillé (trop d\'essais)', code_faux: 'Code de confirmation faux',
  attaque_ip: 'Attaque : une adresse essaie beaucoup de comptes', nouvelle_connexion: 'Connexion depuis un nouvel appareil',
  ip_bloquee: 'Accès refusé (adresse bloquée)', admin_connexion_echouee: 'Tentative sur l\'administration',
  mot_de_passe_change: 'Mot de passe changé', mot_de_passe_oublie: 'Demande de nouveau mot de passe', deconnexion_forcee: 'Déconnecté de partout par l\'équipe',
  essais_repetes: 'Plusieurs mots de passe faux',
};

function makeSecurity({ db, notify = async () => {}, notifyAdmins = async () => {} }) {
  const recentlyWarned = new Map(); // limite les alertes répétées (par compte / adresse)
  const once = (key, ms) => { const t = recentlyWarned.get(key) || 0; if (Date.now() - t < ms) return false; recentlyWarned.set(key, Date.now()); return true; };

  async function log(kind, level, { creatorId = null, identifier = null, ip = null, device = null, detail }) {
    await db.query(
      'INSERT INTO security_events (kind, level, creator_id, identifier, ip_address, device, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [kind, level, creatorId, identifier ? String(identifier).slice(0, 120) : null, ip, device ? String(device).slice(0, 200) : null, detail || LABELS[kind] || kind]).catch(() => {});
    // Alerte grave : prévenir l'administrateur tout de suite (au plus une fois toutes les 10 min par sujet).
    if (level === 'critique' && once(`adm:${kind}:${ip || creatorId || identifier}`, 10 * 60 * 1000)) {
      notifyAdmins({ title: '🚨 Alerte sécurité Eaji', body: `${LABELS[kind] || kind}${ip ? ' — adresse ' + ip : ''}`, link: 'admin:v-threats', kind: 'securite', permission: 'gerer_comptes_utilisateurs', urgent: true });
    }
  }

  // Connexion ratée : mot de passe faux (compte connu ou non).
  async function loginFailed({ creatorId, identifier, ip, device }) {
    await log('connexion_echouee', 'info', { creatorId, identifier, ip, device, detail: creatorId ? 'Mot de passe faux' : 'Compte inconnu' });
    if (creatorId) {
      const r = await db.query(
        "SELECT COUNT(*)::int AS n FROM login_attempts WHERE creator_id = $1 AND success = FALSE AND created_at > now() - interval '15 minutes'", [creatorId]);
      if (r.n >= 3 && once('warn:' + creatorId, 60 * 60 * 1000)) {
        await log('essais_repetes', 'alerte', { creatorId, ip, device, detail: `${r.n} mots de passe faux en 15 minutes` });
        await notify(creatorId, 'securite', '⚠️ Quelqu\'un a essayé plusieurs fois de se connecter à ton compte avec un mauvais mot de passe. Si ce n\'est pas toi, change ton mot de passe dans Profil → Sécurité.', 's-profil',
          { title: 'Alerte de sécurité Eaji', body: 'Tentatives de connexion sur ton compte.' });
      }
    }
    // Une même adresse qui essaie beaucoup de comptes différents : attaque (vol de comptes en série).
    if (ip) {
      const r = await db.query(
        `SELECT COUNT(DISTINCT COALESCE(creator_id::text, identifier))::int AS n FROM security_events
         WHERE kind = 'connexion_echouee' AND ip_address = $1 AND created_at > now() - interval '15 minutes'`, [ip]);
      if (r.n >= 10 && once('attack:' + ip, 60 * 60 * 1000)) {
        await log('attaque_ip', 'critique', { ip, device, detail: `${r.n} comptes différents essayés en 15 minutes depuis cette adresse` });
      }
    }
  }
  async function accountLocked({ creatorId, ip, device }) {
    if (once('locked:' + creatorId, 15 * 60 * 1000)) await log('compte_verrouille', 'critique', { creatorId, ip, device, detail: 'Trop de mots de passe faux : connexion bloquée 15 minutes' });
  }
  async function codeFailed({ creatorId, ip, attempts }) {
    await log('code_faux', attempts >= 4 ? 'alerte' : 'info', { creatorId, ip, detail: `Code de confirmation faux (essai ${attempts + 1} sur 5)` });
  }
  // Connexion réussie : un appareil ou une adresse jamais vus pour ce compte → le propriétaire est prévenu.
  async function loginSucceeded({ creatorId, ip, device }) {
    const seen = await db.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE (device_fingerprint IS NOT DISTINCT FROM $2) OR ip_address = $3)::int AS same
       FROM (SELECT device_fingerprint, ip_address FROM login_attempts WHERE creator_id = $1 AND success = TRUE
             ORDER BY created_at DESC OFFSET 1 LIMIT 200) t`, [creatorId, device || null, ip]); // (la connexion en cours est exclue)
    if (seen.n > 0 && seen.same === 0) {
      await log('nouvelle_connexion', 'info', { creatorId, ip, device, detail: 'Connexion depuis un appareil ou une adresse jamais vus' });
      await notify(creatorId, 'securite', '🔐 Nouvelle connexion à ton compte depuis un autre appareil. Si ce n\'est pas toi, change ton mot de passe tout de suite (Profil → Sécurité).', 's-profil',
        { title: 'Nouvelle connexion Eaji', body: 'Ton compte vient d\'être ouvert sur un autre appareil.' });
    }
  }
  async function isBlocked(ip, device) {
    if (!ip && !device) return false;
    const hit = await db.query('SELECT 1 FROM security_blocklist WHERE (ip_address IS NOT NULL AND ip_address = $1) OR (device_fingerprint IS NOT NULL AND device_fingerprint = $2)',
      [ip || null, device || null]).catch(() => null);
    return Boolean(hit);
  }
  return { log, loginFailed, accountLocked, codeFailed, loginSucceeded, isBlocked, LABELS };
}

function register({ app, db, requireAdminPermission, security, notify = async () => {} }) {
  const canSee = requireAdminPermission('gerer_comptes_utilisateurs');
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  app.get('/api/admin/security/overview', canSee, async (req, res) => {
    const level = ['alerte', 'critique'].includes(req.query.level) ? req.query.level : null;
    const k = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM security_events WHERE kind = 'connexion_echouee' AND created_at > now() - interval '24 hours') AS failed24h,
         (SELECT COUNT(*)::int FROM security_events WHERE level IN ('alerte', 'critique') AND NOT resolved) AS open_alerts,
         (SELECT COUNT(*)::int FROM security_events WHERE kind = 'attaque_ip' AND created_at > now() - interval '24 hours') AS attacks24h,
         (SELECT COUNT(*)::int FROM security_events WHERE kind = 'compte_verrouille' AND created_at > now() - interval '24 hours') AS locked24h,
         (SELECT COUNT(*)::int FROM security_blocklist) AS blocked`);
    const events = await db.all(
      `SELECT e.*, cr.name AS creator_name, cr.phone AS creator_phone, cr.account_status,
              EXISTS (SELECT 1 FROM security_blocklist b WHERE b.ip_address = e.ip_address) AS ip_blocked
       FROM security_events e LEFT JOIN creators cr ON cr.id = e.creator_id
       WHERE ($1::text IS NULL AND e.kind <> 'connexion_echouee' OR e.level = $1 OR ($1 = 'alerte' AND e.level = 'critique'))
       ORDER BY e.created_at DESC LIMIT 150`, [level]);
    events.forEach((e) => { e.label = security.LABELS[e.kind] || e.kind; });
    const topIps = await db.all(
      `SELECT ip_address, COUNT(*)::int AS failures, COUNT(DISTINCT COALESCE(creator_id::text, identifier))::int AS accounts, MAX(created_at) AS last_at,
              EXISTS (SELECT 1 FROM security_blocklist b WHERE b.ip_address = e.ip_address) AS blocked
       FROM security_events e WHERE kind = 'connexion_echouee' AND created_at > now() - interval '24 hours' AND ip_address IS NOT NULL
       GROUP BY ip_address HAVING COUNT(*) >= 3 ORDER BY failures DESC LIMIT 30`);
    const targeted = await db.all(
      `SELECT e.creator_id, cr.name, cr.phone, cr.account_status, COUNT(*)::int AS failures, COUNT(DISTINCT e.ip_address)::int AS ips, MAX(e.created_at) AS last_at
       FROM security_events e JOIN creators cr ON cr.id = e.creator_id
       WHERE e.kind = 'connexion_echouee' AND e.created_at > now() - interval '24 hours'
       GROUP BY e.creator_id, cr.name, cr.phone, cr.account_status HAVING COUNT(*) >= 3 ORDER BY failures DESC LIMIT 30`);
    const blocklist = await db.all('SELECT id, ip_address, device_fingerprint, reason, blocked_at FROM security_blocklist ORDER BY blocked_at DESC LIMIT 100');
    res.json({ kpis: k, events, topIps, targeted, blocklist });
  });

  app.post('/api/admin/security/block-ip', canSee, async (req, res) => {
    const ip = String(req.body.ip || '').trim().slice(0, 60);
    if (!/^[0-9a-fA-F:.]{3,60}$/.test(ip)) return res.status(400).json({ error: 'Adresse invalide.' });
    const exists = await db.query('SELECT id FROM security_blocklist WHERE ip_address = $1', [ip]);
    if (exists) return res.json({ blocked: true, id: exists.id });
    const b = await db.query('INSERT INTO security_blocklist (ip_address, reason, blocked_by) VALUES ($1, $2, $3) RETURNING id',
      [ip, String(req.body.reason || 'Bloquée par l\'administrateur (activité suspecte)').slice(0, 200), req.adminId]);
    await db.query("UPDATE security_events SET resolved = TRUE WHERE ip_address = $1 AND level IN ('alerte', 'critique')", [ip]);
    res.status(201).json({ blocked: true, id: b.id });
  });
  app.delete('/api/admin/security/block/:id', canSee, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Blocage introuvable.' });
    const b = await db.query('DELETE FROM security_blocklist WHERE id = $1 RETURNING id', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Blocage introuvable.' });
    res.json({ unblocked: true });
  });
  // Déconnecte le compte sur tous les téléphones (le voleur perd l'accès) ; le propriétaire se reconnecte.
  app.post('/api/admin/security/creators/:id/logout-all', canSee, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Compte introuvable.' });
    const c = await db.query('UPDATE creators SET session_version = COALESCE(session_version, 0) + 1 WHERE id = $1 RETURNING id', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Compte introuvable.' });
    await db.query('DELETE FROM push_subscriptions WHERE creator_id = $1', [c.id]).catch(() => {});
    await security.log('deconnexion_forcee', 'info', { creatorId: c.id, detail: 'Déconnecté de tous les appareils par l\'équipe Eaji' });
    await db.query("UPDATE security_events SET resolved = TRUE WHERE creator_id = $1 AND level IN ('alerte', 'critique')", [c.id]);
    await notify(c.id, 'securite', '🔐 Par sécurité, l\'équipe Eaji t\'a déconnecté de tous tes appareils. Reconnecte-toi et change ton mot de passe.', 's-profil');
    res.json({ loggedOut: true });
  });
  app.post('/api/admin/security/events/:id/resolve', canSee, async (req, res) => {
    const e = await db.query('UPDATE security_events SET resolved = TRUE WHERE id::text = $1 RETURNING id', [String(req.params.id)]);
    if (!e) return res.status(404).json({ error: 'Alerte introuvable.' });
    res.json({ resolved: true });
  });
  app.get('/api/admin/security/count', canSee, async (req, res) => {
    const r = await db.query("SELECT COUNT(*)::int AS n FROM security_events WHERE level IN ('alerte', 'critique') AND NOT resolved");
    res.json({ open: r.n });
  });
}

module.exports = { MIGRATIONS, makeSecurity, register, LABELS };
