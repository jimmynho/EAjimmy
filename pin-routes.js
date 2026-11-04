// Eaji — code secret de 5 chiffres, contacts du téléphone.
//
//  • Code secret (un par compte) : ouvre le PORTEFEUILLE (solde, gains, retraits, transferts, paiements avec le solde,
//    mode de retrait) et, si la personne le veut, ses GROUPES (groupes et conversations avec ses contacts).
//    C'est le serveur qui le vérifie : sans le code, ces informations ne sont pas envoyées (réponse 423 « pin_requis »),
//    même à quelqu'un qui bricole le téléphone. Le code est gardé chiffré (bcrypt) ; 5 erreurs = bloqué 15 minutes.
//    Code oublié : on le change avec le mot de passe du compte.
//  • Contacts du téléphone : l'appli envoie les numéros choisis par la personne ; le serveur répond seulement quels
//    comptes Eaji correspondent (nom et photo, jamais le numéro). Les numéros ne sont pas gardés.
//    Chacun peut refuser d'être trouvé par son numéro (Profil → Confidentialité).
const crypto = require('crypto');

const PIN_MINUTES = Number(process.env.EAJI_PIN_MINUTES) || 10;   // le portefeuille reste ouvert 10 minutes
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MINUTES = 15;
const MAX_PHONES = 500;

const MIGRATIONS = [
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS pin_hash TEXT',
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS pin_failed INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ',
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS groups_locked BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS findable_by_phone BOOLEAN NOT NULL DEFAULT TRUE',
  `CREATE TABLE IF NOT EXISTS phone_contacts (
     owner_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     contact_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (owner_id, contact_id)
   )`,
];

const PIN_RE = /^\d{5}$/;
// Codes trop faciles à deviner : 11111, 12345, 54321…
function weakPin(p) {
  if (/^(\d)\1{4}$/.test(p)) return true;
  const d = p.split('').map(Number);
  const up = d.every((x, i) => i === 0 || x === d[i - 1] + 1), down = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  return up || down;
}

// Chemins du portefeuille protégés par le code.
const WALLET_PATHS = [
  /^\/api\/earnings(\/|$)/, /^\/api\/wallet(\/|$)/, /^\/api\/payouts\/withdraw$/, /^\/api\/creators\/me\/payout-account$/,
  /^\/api\/creators\/me\/transactions$/, /^\/api\/payments\/[^/]+\/pay-with-(balance|earnings)$/,
];

function register({ app, db, bcrypt, requireAuth, rateLimit, decodeSessionToken, notify = async () => {}, security, normalizePhone, phoneTail, createDownloadUrl, isBlockedBetween }) {
  const secret = process.env.SESSION_SECRET || 'eaji-pin';
  const sign = (s) => crypto.createHmac('sha256', secret).update('pin:' + s).digest('base64url');
  function makeToken(creatorId, sid) {
    const body = Buffer.from(JSON.stringify({ c: creatorId, s: sid || null, e: Date.now() + PIN_MINUTES * 60000 })).toString('base64url');
    return `${body}.${sign(body)}`;
  }
  function tokenOk(token, creatorId, sid) {
    try {
      const [body, sig] = String(token || '').split('.');
      if (!body || !sig) return false;
      const a = Buffer.from(sign(body)), b = Buffer.from(sig);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
      const d = JSON.parse(Buffer.from(body, 'base64url').toString());
      return d.c === creatorId && (d.s || null) === (sid || null) && d.e > Date.now();
    } catch (e) { return false; }
  }
  const pinRow = (id) => db.query('SELECT pin_hash, pin_failed, pin_locked_until, groups_locked, findable_by_phone, password_hash FROM creators WHERE id = $1', [id]);
  // Le code a-t-il été donné (ou n'existe pas encore) pour cette demande ?
  async function unlocked(req, row) {
    const r = row || await pinRow(req.creatorId);
    if (!r || !r.pin_hash) return true;
    return tokenOk(req.headers['x-eaji-pin'], req.creatorId, req.sessionId);
  }
  // Identité de la personne à partir de sa session (pour les contrôles placés avant les routes).
  function who(req) {
    try {
      const d = decodeSessionToken(String(req.headers.authorization || '').replace('Bearer ', ''));
      return d.typ === 'admin' ? null : { id: d.sub, sid: d.sid || null };
    } catch (e) { return null; }
  }
  const PIN_REQUIRED = (res, what) => res.status(423).json({ code: 'pin_requis', what,
    error: what === 'groupes' ? 'Tes groupes sont protégés : entre ton code secret.' : 'Ton portefeuille est protégé : entre ton code secret.' });

  // ---------- Contrôle du portefeuille (avant les routes de l'argent) ----------
  app.use(async (req, res, next) => {
    try {
      const p = String(req.path || '');
      if (!WALLET_PATHS.some((re) => re.test(p))) return next();
      const w = who(req);
      if (!w) return next(); // pas connecté : la route répond elle-même « connecte-toi »
      req.creatorId = req.creatorId || w.id; req.sessionId = req.sessionId || w.sid;
      const r = await pinRow(w.id);
      if (!r || !r.pin_hash || tokenOk(req.headers['x-eaji-pin'], w.id, w.sid)) return next();
      return PIN_REQUIRED(res, 'portefeuille');
    } catch (e) { return next(); }
  });
  // ---------- Contrôle des groupes protégés ----------
  // Groupes (messages, membres, appels) et conversations avec les contacts du téléphone.
  app.use(async (req, res, next) => {
    try {
      const p = String(req.path || '');
      const g = /^\/api\/groups\/[0-9a-f-]{36}(\/|$)/i.test(p);
      const dm = /^\/api\/messages\/([0-9a-f-]{36})$/i.exec(p);
      if (!g && !dm) return next();
      const w = who(req);
      if (!w) return next();
      const r = await pinRow(w.id);
      if (!r || !r.pin_hash || !r.groups_locked || tokenOk(req.headers['x-eaji-pin'], w.id, w.sid)) return next();
      if (dm && !(await db.query('SELECT 1 FROM phone_contacts WHERE owner_id = $1 AND contact_id = $2', [w.id, dm[1]]))) return next();
      return PIN_REQUIRED(res, 'groupes');
    } catch (e) { return next(); }
  });

  // ---------- Code secret ----------
  app.get('/api/pin/status', requireAuth, async (req, res) => {
    const r = await pinRow(req.creatorId);
    res.json({ hasPin: Boolean(r && r.pin_hash), groupsLocked: Boolean(r && r.groups_locked), findable: !r || r.findable_by_phone !== false,
      unlocked: await unlocked(req, r), lockedUntil: r && r.pin_locked_until && new Date(r.pin_locked_until) > new Date() ? r.pin_locked_until : null, minutes: PIN_MINUTES });
  });
  const pinLimit = rateLimit('pin', 30, 15 * 60 * 1000, 'Trop d\'essais. Attends quelques minutes.', (req) => req.creatorId || req.ip);
  // Créer (première fois) ou changer le code. Changer : ancien code OU mot de passe du compte.
  app.post('/api/pin/set', requireAuth, pinLimit, async (req, res) => {
    const pin = String(req.body.pin || '');
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Le code secret doit avoir exactement 5 chiffres.' });
    if (weakPin(pin)) return res.status(400).json({ error: 'Code trop facile à deviner (11111, 12345…). Choisis-en un autre.' });
    const r = await pinRow(req.creatorId);
    if (r.pin_hash) {
      const byPin = req.body.currentPin && await bcrypt.compare(String(req.body.currentPin), r.pin_hash);
      const byPassword = req.body.password && r.password_hash && await bcrypt.compare(String(req.body.password), r.password_hash);
      if (!byPin && !byPassword) return res.status(403).json({ code: 'pin_ancien', error: 'Ancien code ou mot de passe incorrect.' });
    }
    await db.query('UPDATE creators SET pin_hash = $2, pin_failed = 0, pin_locked_until = NULL WHERE id = $1', [req.creatorId, await bcrypt.hash(pin, 10)]);
    if (r.pin_hash) {
      if (security && security.log) security.log('code_secret_change', 'info', { creatorId: req.creatorId, ip: req.ip, detail: 'Code secret changé' }).catch(() => {});
      await notify(req.creatorId, 'securite', '🔐 Ton code secret Eaji vient d\'être changé. Si ce n\'est pas toi, change ton mot de passe tout de suite.', 's-profil', { inApp: true });
    }
    res.json({ ok: true, token: makeToken(req.creatorId, req.sessionId), minutes: PIN_MINUTES });
  });
  // Vérifier le code : donne un accès de quelques minutes à ce téléphone.
  app.post('/api/pin/verify', requireAuth, pinLimit, async (req, res) => {
    const r = await pinRow(req.creatorId);
    if (!r.pin_hash) return res.status(400).json({ code: 'pin_absent', error: 'Crée d\'abord ton code secret.' });
    if (r.pin_locked_until && new Date(r.pin_locked_until) > new Date()) {
      const min = Math.ceil((new Date(r.pin_locked_until) - Date.now()) / 60000);
      return res.status(429).json({ code: 'pin_bloque', until: r.pin_locked_until, error: `Trop d'erreurs : code bloqué encore ${min} min. Tu peux aussi le changer avec ton mot de passe.` });
    }
    if (await bcrypt.compare(String(req.body.pin || ''), r.pin_hash)) {
      await db.query('UPDATE creators SET pin_failed = 0, pin_locked_until = NULL WHERE id = $1', [req.creatorId]);
      return res.json({ ok: true, token: makeToken(req.creatorId, req.sessionId), minutes: PIN_MINUTES });
    }
    const fails = Number(r.pin_failed || 0) + 1;
    if (fails >= PIN_MAX_FAILS) {
      await db.query(`UPDATE creators SET pin_failed = 0, pin_locked_until = now() + interval '${PIN_LOCK_MINUTES} minutes' WHERE id = $1`, [req.creatorId]);
      if (security && security.log) security.log('code_secret_bloque', 'alerte', { creatorId: req.creatorId, ip: req.ip, detail: `${PIN_MAX_FAILS} erreurs de code secret` }).catch(() => {});
      await notify(req.creatorId, 'securite', `⚠️ ${PIN_MAX_FAILS} codes secrets faux ont été essayés sur ton compte : ton portefeuille est bloqué ${PIN_LOCK_MINUTES} minutes. Si ce n'est pas toi, change ton mot de passe.`, 's-profil', { inApp: true });
      return res.status(429).json({ code: 'pin_bloque', error: `Trop d'erreurs : code bloqué ${PIN_LOCK_MINUTES} minutes.` });
    }
    await db.query('UPDATE creators SET pin_failed = $2 WHERE id = $1', [req.creatorId, fails]);
    res.status(403).json({ code: 'pin_faux', left: PIN_MAX_FAILS - fails, error: `Code faux. Encore ${PIN_MAX_FAILS - fails} essai(s).` });
  });
  // Code oublié : nouveau code avec le mot de passe du compte.
  app.post('/api/pin/reset', requireAuth, pinLimit, async (req, res) => {
    const pin = String(req.body.pin || '');
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Le code secret doit avoir exactement 5 chiffres.' });
    if (weakPin(pin)) return res.status(400).json({ error: 'Code trop facile à deviner (11111, 12345…). Choisis-en un autre.' });
    const r = await pinRow(req.creatorId);
    if (!req.body.password || !r.password_hash || !(await bcrypt.compare(String(req.body.password), r.password_hash))) {
      return res.status(403).json({ error: 'Mot de passe incorrect. Mot de passe oublié ? Utilise « Mot de passe oublié » sur l\'écran de connexion.' });
    }
    await db.query('UPDATE creators SET pin_hash = $2, pin_failed = 0, pin_locked_until = NULL WHERE id = $1', [req.creatorId, await bcrypt.hash(pin, 10)]);
    if (security && security.log) security.log('code_secret_change', 'info', { creatorId: req.creatorId, ip: req.ip, detail: 'Code secret remplacé avec le mot de passe' }).catch(() => {});
    await notify(req.creatorId, 'securite', '🔐 Ton code secret Eaji a été remplacé avec ton mot de passe. Si ce n\'est pas toi, change ton mot de passe tout de suite.', 's-profil', { inApp: true });
    res.json({ ok: true, token: makeToken(req.creatorId, req.sessionId), minutes: PIN_MINUTES });
  });
  // Protéger (ou non) les groupes avec le code.
  app.post('/api/pin/groups-lock', requireAuth, async (req, res) => {
    const r = await pinRow(req.creatorId);
    if (!r.pin_hash) return res.status(400).json({ code: 'pin_absent', error: 'Crée d\'abord ton code secret.' });
    const on = req.body.on === true;
    if (!on && !(await unlocked(req, r))) return PIN_REQUIRED(res, 'groupes');
    await db.query('UPDATE creators SET groups_locked = $2 WHERE id = $1', [req.creatorId, on]);
    res.json({ groupsLocked: on });
  });

  // ---------- Contacts du téléphone ----------
  app.post('/api/phone-contacts/findable', requireAuth, async (req, res) => {
    await db.query('UPDATE creators SET findable_by_phone = $2 WHERE id = $1', [req.creatorId, req.body.on !== false]);
    res.json({ findable: req.body.on !== false });
  });
  // L'appli envoie les numéros choisis ; réponse : les comptes Eaji trouvés (jamais leur numéro).
  app.post('/api/phone-contacts/match', requireAuth, rateLimit('contacts', 20, 60 * 60 * 1000, 'Trop de recherches de contacts. Réessaie dans une heure.', (req) => req.creatorId || req.ip), async (req, res) => {
    const list = Array.isArray(req.body.phones) ? req.body.phones.slice(0, MAX_PHONES) : [];
    const me = await db.query('SELECT country_code FROM creators WHERE id = $1', [req.creatorId]);
    const wanted = new Map(); // numéro international → positions dans la liste envoyée
    const intl = new Set();   // numéros écrits avec leur indicatif (+243…, 00243…) : le pays est sûr
    list.forEach((raw, i) => {
      const n = normalizePhone(raw, me && me.country_code); if (!n) return;
      if (!wanted.has(n)) wanted.set(n, []); wanted.get(n).push(i);
      if (/^\s*(\+|00)/.test(String(raw))) intl.add(n);
    });
    if (!wanted.size) return res.json({ found: [] });
    const tails = [...new Set([...wanted.keys()].map(phoneTail).filter(Boolean))];
    const rows = await db.all(
      `SELECT id, name, photo_url, phone, country_code FROM creators
       WHERE account_status = 'actif' AND findable_by_phone AND id <> $1 AND phone IS NOT NULL
         AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ANY($2::text[]) LIMIT 1000`, [req.creatorId, tails]);
    // Même numéro écrit de deux façons (0812…, +243 812…, 243812…), même si le pays de mon compte n'est pas le bon :
    // on compare les 9 derniers chiffres ; si le numéro du carnet est écrit avec son indicatif, il doit être le même.
    const byTail = new Map();
    for (const n of wanted.keys()) { const t = phoneTail(n); if (t) { if (!byTail.has(t)) byTail.set(t, []); byTail.get(t).push(n); } }
    const found = [];
    for (const r of rows) {
      const rn = normalizePhone(r.phone, r.country_code || (me && me.country_code));
      const cands = rn ? byTail.get(phoneTail(rn)) || [] : [];
      const same = cands.filter((w) => w === rn || !intl.has(w) || !w.startsWith('+') || !rn.startsWith('+'));
      if (!same.length) continue;
      if (isBlockedBetween && await isBlockedBetween(req.creatorId, r.id)) continue;
      await db.query('INSERT INTO phone_contacts (owner_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.creatorId, r.id]);
      found.push({ id: r.id, name: r.name, photoUrl: await createDownloadUrl(r.photo_url).catch(() => null), indexes: [...new Set(same.flatMap((w) => wanted.get(w)))] });
    }
    res.json({ found, checked: wanted.size });
  });
  // Mes contacts sur Eaji (ordre alphabétique, avec leur photo), avec le dernier message (caché si les groupes sont protégés et pas encore ouverts).
  app.get('/api/phone-contacts', requireAuth, async (req, res) => {
    const r = await pinRow(req.creatorId);
    const open = !r.groups_locked || await unlocked(req, r);
    const rows = await db.all(
      `SELECT cr.id, cr.name, cr.photo_url, cr.last_seen_at, lm.text AS last_text, lm.file_name AS last_file, lm.audio AS last_audio, lm.created_at AS last_at,
              lm.mine AS last_mine,
              (SELECT COUNT(*)::int FROM direct_messages d WHERE d.sender_id = cr.id AND d.recipient_id = $1 AND d.read_at IS NULL) AS unread
       FROM phone_contacts pc JOIN creators cr ON cr.id = pc.contact_id AND cr.account_status = 'actif'
       LEFT JOIN LATERAL (SELECT CASE WHEN deleted_at IS NOT NULL THEN '🚫 Message supprimé' ELSE text END AS text, file_name, audio_key IS NOT NULL AS audio, created_at, sender_id = $1 AS mine
                          FROM direct_messages WHERE (sender_id = $1 AND recipient_id = cr.id) OR (sender_id = cr.id AND recipient_id = $1)
                          ORDER BY created_at DESC LIMIT 1) lm ON TRUE
       WHERE pc.owner_id = $1
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = cr.id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = cr.id))
       ORDER BY lower(cr.name), cr.name LIMIT 500`, [req.creatorId]); // ordre alphabétique
    const contacts = [];
    for (const c of rows) {
      contacts.push({ id: c.id, name: c.name, photoUrl: await createDownloadUrl(c.photo_url).catch(() => null),
        online: Boolean(c.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 70000), unread: c.unread, lastAt: c.last_at,
        last: open ? (c.last_audio ? '🎤 Message vocal' : (c.last_text || (c.last_file ? '📎 ' + c.last_file : ''))) : (c.last_at ? '🔒' : ''), lastMine: c.last_mine });
    }
    res.json({ contacts, locked: !open });
  });
  app.delete('/api/phone-contacts/:id', requireAuth, async (req, res) => {
    await db.query('DELETE FROM phone_contacts WHERE owner_id = $1 AND contact_id::text = $2', [req.creatorId, String(req.params.id)]);
    res.json({ removed: true });
  });

  async function groupsOpen(req) { const r = await pinRow(req.creatorId); return !r || !r.groups_locked || unlocked(req, r); }
  return { unlocked, groupsOpen, pinRow, isContact: async (owner, other) => Boolean(await db.query('SELECT 1 FROM phone_contacts WHERE owner_id = $1 AND contact_id = $2', [owner, other])) };
}

module.exports = { MIGRATIONS, register, WALLET_PATHS, weakPin };
