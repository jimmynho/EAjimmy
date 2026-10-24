// Eaji — accès au compte (ajouts) :
//  1. Date de naissance (inscription) : elle sert à retrouver son compte.
//  2. Nouveau mot de passe automatique : nom complet + numéro (ou email) + date de naissance corrects
//     → un mot de passe provisoire est créé tout de suite (par email si on a écrit son email, à l'écran
//     si on a écrit son numéro). Il faut ensuite choisir son propre mot de passe à la connexion.
//  3. « Mes connexions » : la liste des appareils connectés au compte, et la déconnexion à distance
//     d'un appareil (téléphone volé ou perdu).
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AUTO_FAILS = 5; // essais ratés par compte et par 24 h

const MIGRATIONS = [
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS birth_date DATE',
  `CREATE TABLE IF NOT EXISTS user_sessions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     session_version INTEGER NOT NULL DEFAULT 0,
     device TEXT,
     ip TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     revoked_at TIMESTAMPTZ)`,
  'CREATE INDEX IF NOT EXISTS user_sessions_creator_idx ON user_sessions (creator_id, last_used_at DESC)',
  'ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS session_id UUID',
  `CREATE TABLE IF NOT EXISTS password_auto_attempts (
     id BIGSERIAL PRIMARY KEY,
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     success BOOLEAN NOT NULL,
     ip TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS password_auto_attempts_idx ON password_auto_attempts (creator_id, created_at DESC)',
];

// « 1990-05-21 » → la même chaîne si c'est une vraie date passée (après 1900), sinon null.
function parseBirthDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt.getTime() > Date.now()) return null;
  return m[0];
}
const ymd = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Nom comparé sans accents, majuscules ni espaces en trop, et dans n'importe quel ordre (« Komba Jimmy » = « Jimmy Komba »).
function nameKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ؀-ۿऀ-ॿ一-鿿]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
}
// Nom simple de l'appareil à partir du navigateur : « Android · Chrome », « iPhone · Safari », « Windows · Edge »…
function deviceLabel(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Appareil';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  return `${os} · ${br}`;
}
const maskIp = (ip) => {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.').slice(0, 2).join('.') + '.x.x';
  return s ? s.split(':').slice(0, 2).join(':') + ':…' : '';
};
const maskEmail = (e) => { const [u, d] = String(e).split('@'); return d ? `${u.slice(0, Math.min(2, u.length))}***@${d}` : ''; };

// Connexions coupées à distance : gardées en mémoire pour refuser leur jeton tout de suite, partout.
const REVOKED = new Set();

function create({ db }) {
  // Nouvelle connexion (après le code de confirmation, ou par code QR) : un identifiant d'appareil dans le jeton.
  async function createSession(creatorId, req) {
    const c = await db.query('SELECT COALESCE(session_version, 0) AS v FROM creators WHERE id = $1', [creatorId]);
    const r = await db.query(
      'INSERT INTO user_sessions (creator_id, session_version, device, ip) VALUES ($1, $2, $3, $4) RETURNING id',
      [creatorId, c ? c.v : 0, deviceLabel(req && req.headers && req.headers['user-agent']), String((req && req.ip) || '').slice(0, 60)]);
    return r.id;
  }
  function isRevoked(sid) { return Boolean(sid && REVOKED.has(sid)); }
  const USED = new Map();
  function touch(sid) {
    if (!sid || !UUID_RE.test(sid)) return;
    const now = Date.now();
    if (now - (USED.get(sid) || 0) < 60000) return;
    USED.set(sid, now);
    if (USED.size > 50000) USED.clear();
    db.query('UPDATE user_sessions SET last_used_at = now() WHERE id = $1', [sid]).catch(() => {});
  }
  async function loadRevoked() {
    try {
      const rows = await db.all("SELECT id FROM user_sessions WHERE revoked_at IS NOT NULL AND revoked_at > now() - interval '120 days'");
      rows.forEach((r) => REVOKED.add(r.id));
    } catch (e) { /* table pas encore créée */ }
  }
  // Deux serveurs : chacun relit la liste des appareils coupés toutes les minutes.
  const sync = setInterval(() => { loadRevoked(); }, 60000);
  if (sync.unref) sync.unref();
  return { createSession, isRevoked, touch, loadRevoked };
}

function register({ app, db, bcrypt, requireAuth, rateLimit, findAccount, trySendEmail, notify, security, sealTemp, getSecret,
  signSessionToken, sessions }) {
  // Journal de sécurité et notification : jamais bloquants.
  const slog = (...a) => { try { Promise.resolve(security && security.log(...a)).catch(() => {}); } catch (e) { /* rien */ } };
  const tell = (...a) => { try { Promise.resolve(notify(...a)).catch(() => {}); } catch (e) { /* rien */ } };
  // ==================== Nouveau mot de passe automatique ====================
  app.post('/api/auth/auto-reset', rateLimit('autoreset', 20, 60 * 60 * 1000, 'Trop d\'essais depuis ce réseau. Réessaie dans une heure.'), async (req, res) => {
    const b = req.body || {};
    const birth = parseBirthDate(b.birthDate);
    if (!String(b.name || '').trim() || !String(b.identifier || '').trim() || !birth) {
      return res.status(400).json({ error: 'Remplis les trois cases : nom complet, numéro de téléphone (ou email) et date de naissance.' });
    }
    const found = await findAccount(db, b.identifier, b.countryCode);
    const creator = found.creator && found.creator.account_status === 'actif' ? found.creator : null;
    const wrong = { code: 'infos_incorrectes', error: 'Ces informations ne correspondent à aucun compte. Vérifie ton nom complet (comme à l\'inscription), ton numéro (ou ton email) et ta date de naissance.' };
    if (!creator) return res.status(400).json(wrong);
    if (!creator.birth_date) {
      return res.status(409).json({ code: 'sans_date', error: 'Ce compte a été créé avant la date de naissance : la réinitialisation automatique n\'est pas possible. Utilise « M\'envoyer un code » ci-dessous ou écris à l\'administrateur.' });
    }
    const fails = await db.query(
      "SELECT COUNT(*)::int AS n FROM password_auto_attempts WHERE creator_id = $1 AND success = FALSE AND created_at > now() - interval '24 hours'", [creator.id]);
    if (fails.n >= MAX_AUTO_FAILS) {
      return res.status(429).json({ code: 'trop_essais', error: 'Trop d\'essais ratés pour ce compte : réessaie demain, ou écris à l\'administrateur Eaji.' });
    }
    const ok = nameKey(b.name) === nameKey(creator.name) && ymd(creator.birth_date) === birth;
    await db.query('INSERT INTO password_auto_attempts (creator_id, success, ip) VALUES ($1, $2, $3)', [creator.id, ok, String(req.ip || '').slice(0, 60)]);
    if (!ok) {
      if (fails.n + 1 >= 3) slog('mot_de_passe_oublie', 'alerte', { creatorId: creator.id, ip: req.ip, detail: `Réinitialisation automatique : ${fails.n + 1} essai(s) raté(s)` });
      return res.status(400).json(wrong);
    }
    // Bonnes informations : nouveau mot de passe provisoire, tous les appareils sont déconnectés.
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let temp = ''; for (const x of crypto.randomBytes(10)) temp += alphabet[x % alphabet.length];
    await db.query(
      `UPDATE creators SET password_hash = $1, session_version = session_version + 1,
         temp_password_enc = $3, temp_password_at = now(), must_change_password = TRUE WHERE id = $2`,
      [await bcrypt.hash(temp, 12), creator.id, sealTemp(temp, getSecret())]);
    await db.query("UPDATE password_help_requests SET status = 'traitee', handled_at = now() WHERE creator_id = $1 AND status = 'en_attente'", [creator.id]).catch(() => {});
    slog('mot_de_passe_oublie', 'info', { creatorId: creator.id, ip: req.ip, detail: 'Nouveau mot de passe automatique (nom, contact et date de naissance vérifiés)' });
    tell(creator.id, 'securite', '🔑 Ton mot de passe a été réinitialisé (nom, contact et date de naissance). Si ce n\'est pas toi, change-le tout de suite dans Profil et écris à l\'équipe Eaji.', 's-profil');
    const byEmail = found.via !== 'telephone' && Boolean(creator.email);
    const text = `Eaji — ton nouveau mot de passe provisoire : ${temp}\nConnecte-toi avec, puis choisis ton propre mot de passe. Si tu n'as rien demandé, écris tout de suite à l'équipe Eaji.`;
    if (byEmail) {
      const sent = await trySendEmail(creator.email, 'Eaji — ton nouveau mot de passe', text);
      if (sent) return res.json({ reset: true, sentTo: maskEmail(creator.email), message: `Ton nouveau mot de passe a été envoyé par email à ${maskEmail(creator.email)}. Regarde aussi dans les spams.` });
      return res.json({ reset: true, password: temp, emailFailed: true, message: 'L\'email n\'a pas pu être envoyé pour le moment : voici ton nouveau mot de passe.' });
    }
    // Avec le numéro : le mot de passe s'affiche à l'écran. Si le compte a un email, son propriétaire est prévenu.
    if (creator.email) trySendEmail(creator.email, 'Eaji — ton mot de passe a été réinitialisé', 'Ton mot de passe Eaji vient d\'être réinitialisé avec ton numéro de téléphone. Si ce n\'est pas toi, écris tout de suite à l\'équipe Eaji.').catch(() => {});
    res.json({ reset: true, password: temp, message: 'Voici ton nouveau mot de passe. Connecte-toi avec, puis choisis ton propre mot de passe.' });
  });

  // ==================== Mes connexions ====================
  app.get('/api/auth/sessions', requireAuth, async (req, res) => {
    const c = await db.query('SELECT COALESCE(session_version, 0) AS v FROM creators WHERE id = $1', [req.creatorId]);
    const rows = await db.all(
      `SELECT id, device, ip, created_at, last_used_at FROM user_sessions
       WHERE creator_id = $1 AND revoked_at IS NULL AND session_version = $2 AND created_at > now() - interval '60 days'
       ORDER BY last_used_at DESC LIMIT 30`, [req.creatorId, c.v]);
    res.json({
      current: req.sessionId || null,
      items: rows.map((r) => ({ id: r.id, device: r.device, ip: maskIp(r.ip), createdAt: r.created_at, lastUsedAt: r.last_used_at, current: r.id === req.sessionId })),
    });
  });

  // Supprimer la connexion d'un appareil (volé, perdu, prêté) : il est déconnecté tout de suite.
  app.delete('/api/auth/sessions/:id', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    if (req.params.id === req.sessionId) return res.status(400).json({ error: 'C\'est l\'appareil que tu utilises : pour le quitter, appuie sur « Se déconnecter ».' });
    const r = await db.query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND creator_id = $2 AND revoked_at IS NULL RETURNING id, device',
      [req.params.id, req.creatorId]);
    if (!r) return res.status(404).json({ error: 'Connexion introuvable.' });
    REVOKED.add(r.id);
    await db.query('DELETE FROM push_subscriptions WHERE session_id = $1', [r.id]).catch(() => {});
    slog('deconnexion_forcee', 'info', { creatorId: req.creatorId, ip: req.ip, detail: `Appareil déconnecté à distance par le propriétaire : ${r.device || ''}` });
    res.json({ removed: true });
  });

  // Déconnecter tous les autres appareils (y compris les anciennes connexions d'avant cette liste).
  app.post('/api/auth/sessions/revoke-others', requireAuth, async (req, res) => {
    const row = await db.query('UPDATE creators SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version', [req.creatorId]);
    const others = await db.all('UPDATE user_sessions SET revoked_at = now() WHERE creator_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2::uuid RETURNING id',
      [req.creatorId, req.sessionId || null]);
    others.forEach((o) => REVOKED.add(o.id));
    let sid = req.sessionId;
    if (sid) await db.query('UPDATE user_sessions SET session_version = $2 WHERE id = $1', [sid, row.session_version]);
    else sid = await sessions.createSession(req.creatorId, req);
    await db.query('DELETE FROM push_subscriptions WHERE creator_id = $1 AND session_id IS DISTINCT FROM $2::uuid', [req.creatorId, sid]).catch(() => {});
    await db.query('UPDATE push_subscriptions SET session_version = $2 WHERE creator_id = $1', [req.creatorId, row.session_version]).catch(() => {});
    slog('deconnexion_forcee', 'info', { creatorId: req.creatorId, ip: req.ip, detail: 'Tous les autres appareils déconnectés par le propriétaire' });
    res.json({ revoked: others.length, token: signSessionToken(req.creatorId, { v: row.session_version, sid }) });
  });
}

module.exports = { MIGRATIONS, create, register, parseBirthDate, nameKey, deviceLabel };
