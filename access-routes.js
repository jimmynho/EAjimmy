// Eaji — accès au compte (ajouts) :
//  1. Date de naissance (inscription) : elle sert à retrouver son compte.
//  2. Nouveau mot de passe automatique : nom complet + numéro (ou email) + date de naissance corrects
//     → un mot de passe provisoire part SEULEMENT vers l'email du compte (ou par SMS) : jamais à l'écran,
//     car le nom et la date de naissance ne sont pas secrets. Sans email ni SMS, la demande va à l'administrateur.
//     L'ancien mot de passe reste valable tant que le provisoire n'a pas servi (personne ne peut bloquer un compte).
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
  // Appareil (identifiant envoyé par l'appli) de chaque connexion : un appareil déjà connu du compte.
  'ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS device_key TEXT',
  'CREATE INDEX IF NOT EXISTS user_sessions_device_idx ON user_sessions (creator_id, device_key)',
  // Mot de passe provisoire en attente (envoyé par email ou SMS) : actif seulement quand il sert.
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS pending_temp_hash TEXT',
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS pending_temp_until TIMESTAMPTZ',
  // « Mot de passe oublié » : chaque envoi du mot de passe provisoire (pour limiter les envois par compte).
  `CREATE TABLE IF NOT EXISTS password_reset_sends (
    id BIGSERIAL PRIMARY KEY,
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS password_reset_sends_idx ON password_reset_sends (creator_id, created_at DESC)',
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
      'INSERT INTO user_sessions (creator_id, session_version, device, ip, device_key) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [creatorId, c ? c.v : 0, deviceLabel(req && req.headers && req.headers['user-agent']), String((req && req.ip) || '').slice(0, 60),
       (req && req.deviceKey) || null]);
    return r.id;
  }
  // Appareil déjà connecté à ce compte depuis le dernier changement de mot de passe, et pas déconnecté à distance.
  async function knownDevice(creatorId, deviceKey) {
    if (!deviceKey) return false;
    const r = await db.query(
      `SELECT 1 FROM user_sessions s JOIN creators c ON c.id = s.creator_id
       WHERE s.creator_id = $1 AND s.device_key = $2 AND s.revoked_at IS NULL AND s.session_version = COALESCE(c.session_version, 0) LIMIT 1`,
      [creatorId, deviceKey]);
    return Boolean(r);
  }
  // Autres appareils où le compte est ouvert en ce moment (pour y envoyer le code de connexion).
  async function activeDevices(creatorId) {
    return db.all(
      `SELECT s.id, s.device FROM user_sessions s JOIN creators c ON c.id = s.creator_id
       WHERE s.creator_id = $1 AND s.revoked_at IS NULL AND s.session_version = COALESCE(c.session_version, 0)
         AND s.last_used_at > now() - interval '60 days'
       ORDER BY s.last_used_at DESC LIMIT 5`, [creatorId]);
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
  return { createSession, isRevoked, touch, loadRevoked, knownDevice, activeDevices };
}

function register({ app, db, bcrypt, requireAuth, rateLimit, findAccount, trySendEmail, notify, security, sealTemp, getSecret,
  signSessionToken, sessions, sendSms = null, notifyAdmins = async () => 0, whatsapp = null, normalizePhone = null, getFirebase = () => null }) {
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
    // Nouvelle page : la personne CHOISIT où recevoir son mot de passe provisoire (email, SMS, WhatsApp,
    // notification sur son autre téléphone, ou à l'écran si ce téléphone est déjà connu du compte).
    if (b.choose) {
      return res.json({ verified: true, ticket: makeTicket(creator.id), channels: await resetChannels(creator, req, b.identifier, b.countryCode) });
    }
    // Ancienne page (encore en cache sur certains téléphones) : comme avant.
    // Bonnes informations : un mot de passe provisoire part vers l'email du compte (ou par SMS), JAMAIS à l'écran :
    // le nom et la date de naissance ne sont pas secrets (n'importe qui peut les connaître).
    // Il reste « en attente » 30 minutes : l'ancien mot de passe marche encore tant qu'il n'a pas servi.
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let temp = ''; for (const x of crypto.randomBytes(10)) temp += alphabet[x % alphabet.length];
    const text = `Eaji — ton nouveau mot de passe provisoire : ${temp}\nIl est valable 30 minutes. Connecte-toi avec, puis choisis ton propre mot de passe. Si tu n'as rien demandé, ignore ce message : ton mot de passe actuel reste valable.`;
    let sentTo = null;
    if (creator.email && await trySendEmail(creator.email, 'Eaji — ton nouveau mot de passe', text)) sentTo = maskEmail(creator.email);
    else if (sendSms && creator.phone && await sendSms(creator.phone, text).then(() => true, () => false)) sentTo = 'SMS';
    if (!sentTo) {
      // Ni email ni SMS : l'administrateur vérifie l'identité par téléphone puis donne un mot de passe provisoire.
      const pending = await db.query("SELECT 1 FROM password_help_requests WHERE creator_id = $1 AND status = 'en_attente' AND created_at > now() - interval '30 minutes'", [creator.id]).catch(() => null);
      if (!pending) {
        await db.query('INSERT INTO password_help_requests (creator_id, identifier) VALUES ($1, $2)', [creator.id, String(b.identifier).slice(0, 120)]).catch(() => {});
        Promise.resolve(notifyAdmins({ title: `🔑 Mot de passe oublié : ${creator.name}`,
          body: `${creator.phone || ''} demande un nouveau mot de passe (nom et date de naissance corrects, mais aucun email). Vérifie son identité par téléphone, puis donne-lui un mot de passe provisoire.`,
          link: 'admin:v-creators', kind: 'mot_de_passe', permission: 'gerer_comptes_utilisateurs', urgent: true })).catch(() => {});
      }
      slog('mot_de_passe_oublie', 'info', { creatorId: creator.id, ip: req.ip, detail: 'Nouveau mot de passe demandé (sans email) : transmis à l\'administrateur' });
      return res.json({ reset: false, toAdmin: true, message: 'Par sécurité, le nouveau mot de passe ne s\'affiche jamais à l\'écran. Ton compte n\'a pas d\'email : ta demande est envoyée à l\'administrateur Eaji, qui va vérifier ton identité et t\'envoyer un mot de passe provisoire sur ton numéro.' });
    }
    await db.query(
      `UPDATE creators SET pending_temp_hash = $1, pending_temp_until = now() + interval '30 minutes', temp_password_enc = $3, temp_password_at = now() WHERE id = $2`,
      [await bcrypt.hash(temp, 12), creator.id, sealTemp(temp, getSecret())]);
    slog('mot_de_passe_oublie', 'info', { creatorId: creator.id, ip: req.ip, detail: `Mot de passe provisoire envoyé (${sentTo === 'SMS' ? 'SMS' : 'email'})` });
    tell(creator.id, 'securite', '🔑 Un nouveau mot de passe provisoire vient d\'être demandé pour ton compte. Si ce n\'est pas toi, ignore-le : ton mot de passe actuel reste valable.', 's-profil');
    res.json({ reset: true, sentTo, message: sentTo === 'SMS'
      ? 'Ton nouveau mot de passe provisoire a été envoyé par SMS au numéro de ton compte. Il est valable 30 minutes.'
      : `Ton nouveau mot de passe provisoire a été envoyé par email à ${sentTo}. Regarde aussi dans les spams. Il est valable 30 minutes.` });
  });

  // ---------- « Mot de passe oublié » : choisir où recevoir le mot de passe provisoire ----------
  const TICKET_MIN = 15;
  const sign = (x) => crypto.createHmac('sha256', String(getSecret())).update('reset|' + x).digest('base64url');
  function makeTicket(creatorId) {
    const body = `${creatorId}.${Date.now() + TICKET_MIN * 60000}.${crypto.randomBytes(6).toString('hex')}`;
    return `${body}.${sign(body)}`;
  }
  function readTicket(t) {
    const parts = String(t || '').split('.');
    if (parts.length !== 4) return null;
    const body = parts.slice(0, 3).join('.');
    const a = Buffer.from(sign(body)), b = Buffer.from(parts[3]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (!(Number(parts[1]) > Date.now()) || !UUID_RE.test(parts[0])) return null;
    return parts[0];
  }
  const maskPhone = (p) => { const d = String(p || '').replace(/[^\d+]/g, ''); return d.length > 6 ? `${d.slice(0, 4)} ••• ••• ${d.slice(-2)}` : '•••'; };
  const e164 = (c) => (normalizePhone ? normalizePhone(c.phone, c.country_code) : null) || null;
  async function otherDevices(creatorId, deviceKey) {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM user_sessions s JOIN creators c ON c.id = s.creator_id
       WHERE s.creator_id = $1 AND s.revoked_at IS NULL AND s.session_version = COALESCE(c.session_version, 0)
         AND s.last_used_at > now() - interval '60 days' AND s.device_key IS DISTINCT FROM $2`, [creatorId, deviceKey || null]).catch(() => null);
    return r ? r.n : 0;
  }
  // Les moyens possibles pour ce compte, sur ce téléphone.
  async function resetChannels(creator, req, identifier, countryCode) {
    const list = [];
    if (creator.email) list.push({ id: 'email', label: maskEmail(creator.email) });
    const phone = creator.phone ? e164(creator) : null;
    const fb = getFirebase();
    if (creator.phone && sendSms) list.push({ id: 'sms', label: maskPhone(phone || creator.phone) });
    else if (phone && fb && fb.enabled() && normalizePhone && normalizePhone(identifier, countryCode || creator.country_code) === phone
      && await fb.canUse(creator, 'telephone').catch(() => false)) {
      // SMS de Google (Firebase) : le numéro est celui que la personne vient d'écrire elle-même.
      list.push({ id: 'sms', via: 'firebase', label: maskPhone(phone), firebasePhone: phone });
    }
    if (phone && whatsapp && whatsapp.enabled()) list.push({ id: 'whatsapp', label: maskPhone(phone) });
    const n = await otherDevices(creator.id, req.deviceKey);
    if (n > 0) list.push({ id: 'appareil', count: n });
    if (await sessions.knownDevice(creator.id, req.deviceKey).catch(() => false)) list.push({ id: 'ecran' });
    list.push({ id: 'admin' });
    return list;
  }
  async function saveTemp(creatorId, temp) {
    await db.query(
      `UPDATE creators SET pending_temp_hash = $1, pending_temp_until = now() + interval '30 minutes', temp_password_enc = $3, temp_password_at = now() WHERE id = $2`,
      [await bcrypt.hash(temp, 12), creatorId, sealTemp(temp, getSecret())]);
  }
  const newTemp = () => { const al = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let t = ''; for (const x of crypto.randomBytes(10)) t += al[x % al.length]; return t; };
  async function askAdmin(creator, identifier, req) {
    const pending = await db.query("SELECT 1 FROM password_help_requests WHERE creator_id = $1 AND status = 'en_attente' AND created_at > now() - interval '30 minutes'", [creator.id]).catch(() => null);
    if (!pending) {
      await db.query('INSERT INTO password_help_requests (creator_id, identifier) VALUES ($1, $2)', [creator.id, String(identifier || creator.phone || '').slice(0, 120)]).catch(() => {});
      Promise.resolve(notifyAdmins({ title: `🔑 Mot de passe oublié : ${creator.name}`,
        body: `${creator.phone || ''} demande un nouveau mot de passe (nom et date de naissance corrects). Vérifie son identité par téléphone, puis donne-lui un mot de passe provisoire.`,
        link: 'admin:v-creators', kind: 'mot_de_passe', permission: 'gerer_comptes_utilisateurs', urgent: true })).catch(() => {});
    }
    slog('mot_de_passe_oublie', 'info', { creatorId: creator.id, ip: req.ip, detail: 'Nouveau mot de passe demandé : transmis à l\'administrateur' });
  }
  const loadCreator = (id) => db.query("SELECT id, name, email, phone, country_code, account_status FROM creators WHERE id = $1 AND account_status = 'actif'", [id]);
  async function tooMany(creatorId) {
    const r = await db.query("SELECT COUNT(*)::int AS n FROM password_reset_sends WHERE creator_id = $1 AND created_at > now() - interval '1 hour'", [creatorId]);
    return r.n >= 5;
  }

  app.post('/api/auth/auto-reset/send', rateLimit('autoresetsend', 15, 60 * 60 * 1000, 'Trop d\'essais depuis ce réseau. Réessaie dans une heure.'), async (req, res) => {
    const id = readTicket(req.body && req.body.ticket);
    const expired = { code: 'ticket_expire', error: 'Cette demande a expiré : remplis à nouveau les trois cases.' };
    if (!id) return res.status(400).json(expired);
    const creator = await loadCreator(id);
    if (!creator) return res.status(400).json(expired);
    const channel = String(req.body.channel || '');
    const allowed = await resetChannels(creator, req, req.body.identifier, req.body.countryCode);
    const ch = allowed.find((c) => c.id === channel);
    if (!ch) return res.status(400).json({ error: 'Ce moyen n\'est pas disponible pour ton compte. Choisis-en un autre.' });
    if (await tooMany(creator.id)) return res.status(429).json({ code: 'trop_envois', error: 'Trop d\'envois pour ce compte en une heure. Réessaie plus tard.' });
    if (ch.via === 'firebase') {
      // C'est la page Eaji qui demande à Google d'envoyer le SMS (code à 6 chiffres) ; on compte l'envoi (limite gratuite du jour).
      const fb = getFirebase();
      await fb.noteSent(creator.id).catch(() => {});
      await db.query('INSERT INTO password_reset_sends (creator_id, channel) VALUES ($1, $2)', [creator.id, 'sms']);
      return res.json({ sent: false, channel, firebase: true, firebasePhone: ch.firebasePhone,
        message: `Code envoyé par SMS au ${ch.label}. Tape-le ci-dessous : il arrive en quelques secondes.` });
    }
    if (channel === 'admin') {
      await askAdmin(creator, req.body.identifier, req);
      await db.query('INSERT INTO password_reset_sends (creator_id, channel) VALUES ($1, $2)', [creator.id, channel]);
      return res.json({ sent: true, channel, toAdmin: true, message: 'Ta demande est envoyée à l\'administrateur Eaji : il va vérifier ton identité et t\'envoyer un mot de passe provisoire sur ton numéro.' });
    }
    const temp = newTemp();
    const text = `Eaji — ton mot de passe provisoire : ${temp}\nIl est valable 30 minutes. Connecte-toi avec, puis choisis ton propre mot de passe. Si tu n'as rien demandé, ignore ce message : ton mot de passe actuel reste valable.`;
    let ok = false;
    try {
      if (channel === 'email') ok = Boolean(await trySendEmail(creator.email, 'Eaji — ton nouveau mot de passe', text));
      else if (channel === 'sms') ok = await sendSms(creator.phone, text).then(() => true, () => false);
      else if (channel === 'whatsapp') ok = await whatsapp.sendCode(e164(creator), temp).then(() => true, (e) => { console.error('[whatsapp]', e.message); return false; });
      else if (channel === 'appareil') {
        await notify(creator.id, 'securite', `🔑 Ton mot de passe provisoire Eaji : ${temp} — valable 30 minutes. Si ce n'est pas toi qui l'as demandé, ignore ce message : ton mot de passe actuel reste valable.`, 's-profil');
        ok = true;
      } else if (channel === 'ecran') ok = true;
    } catch (e) { ok = false; }
    if (!ok) return res.status(502).json({ code: 'envoi_rate', error: 'L\'envoi n\'a pas marché. Choisis un autre moyen.' });
    await saveTemp(creator.id, temp);
    await db.query('INSERT INTO password_reset_sends (creator_id, channel) VALUES ($1, $2)', [creator.id, channel]);
    slog('mot_de_passe_oublie', 'info', { creatorId: creator.id, ip: req.ip, detail: `Mot de passe provisoire envoyé (${channel})` });
    if (channel !== 'appareil') tell(creator.id, 'securite', '🔑 Un nouveau mot de passe provisoire vient d\'être demandé pour ton compte. Si ce n\'est pas toi, ignore-le : ton mot de passe actuel reste valable.', 's-profil');
    const msg = {
      email: `Ton mot de passe provisoire a été envoyé par email à ${ch.label}. Regarde aussi dans les spams. Il est valable 30 minutes.`,
      sms: `Ton mot de passe provisoire a été envoyé par SMS au ${ch.label}. Il est valable 30 minutes.`,
      whatsapp: `Ton mot de passe provisoire a été envoyé sur WhatsApp au ${ch.label}. Il est valable 30 minutes.`,
      appareil: 'Ton mot de passe provisoire a été envoyé en notification sur ton autre téléphone connecté à Eaji. Il est valable 30 minutes.',
      ecran: 'Voici ton mot de passe provisoire, valable 30 minutes. Connecte-toi avec, puis choisis ton propre mot de passe.',
    }[channel];
    res.json({ sent: true, channel, message: msg, ...(channel === 'ecran' ? { password: temp } : {}) });
  });

  // SMS de Google (Firebase) : la personne a tapé le code reçu par SMS sur le numéro du compte → mot de passe provisoire à l'écran.
  app.post('/api/auth/auto-reset/firebase', rateLimit('autoresetfb', 15, 60 * 60 * 1000), async (req, res) => {
    const id = readTicket(req.body && req.body.ticket);
    if (!id) return res.status(400).json({ code: 'ticket_expire', error: 'Cette demande a expiré : remplis à nouveau les trois cases.' });
    const creator = await loadCreator(id);
    const fb = getFirebase();
    if (!creator || !fb || !fb.verify) return res.status(400).json({ error: 'Ce moyen n\'est pas disponible.' });
    let t;
    try { t = await fb.verify(req.body.idToken); } catch (e) { return res.status(400).json({ error: 'La vérification du code par SMS a échoué. Réessaie.' }); }
    if (!t.phone_number || t.phone_number !== e164(creator)) {
      slog('firebase_autre_numero', 'critique', { creatorId: creator.id, ip: req.ip, detail: 'Mot de passe oublié : code SMS validé pour un AUTRE numéro que celui du compte, refusé.' });
      return res.status(400).json({ error: 'Ce code a été envoyé à un autre numéro que celui du compte.' });
    }
    const temp = newTemp();
    await saveTemp(creator.id, temp);
    slog('mot_de_passe_oublie', 'info', { creatorId: creator.id, ip: req.ip, detail: 'Mot de passe provisoire donné après code SMS (Google)' });
    tell(creator.id, 'securite', '🔑 Un nouveau mot de passe provisoire vient d\'être demandé pour ton compte (code SMS validé). Si ce n\'est pas toi, change ton mot de passe.', 's-profil');
    res.json({ sent: true, channel: 'sms', password: temp, message: 'Code SMS correct. Voici ton mot de passe provisoire, valable 30 minutes. Connecte-toi avec, puis choisis ton propre mot de passe.' });
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
