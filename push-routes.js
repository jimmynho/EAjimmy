// Eaji — notifications sur l'appareil (Web Push), même écran verrouillé ou application fermée.
// Norme utilisée par Chrome/Android (l'APK Eaji), Firefox, Edge et iPhone (application ajoutée à
// l'écran d'accueil, iOS 16.4+). Aucun service payant : Google/Apple/Mozilla transmettent gratuitement.
// Implémenté avec le module « crypto » de Node (aucune dépendance à installer) :
//  - clés VAPID (signature ES256) : variables VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, sinon créées une
//    fois pour toutes et gardées dans la base (app_settings) ;
//  - chiffrement du contenu « aes128gcm » (RFC 8291) : seul le téléphone peut lire le message.
// Sécurité : on n'envoie qu'aux vrais services de notification (pas d'adresse interne → pas de SSRF),
// pas aux comptes suspendus, et plus aux anciens appareils après un changement de mot de passe.

const crypto = require('crypto');
const https = require('https');
const http = require('http');

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     endpoint TEXT UNIQUE NOT NULL,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     session_version INTEGER NOT NULL DEFAULT 0,
     user_agent TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_ok_at TIMESTAMPTZ)`,
  'CREATE INDEX IF NOT EXISTS push_sub_creator_idx ON push_subscriptions (creator_id)',
  // Téléphones des administrateurs (application Eaji Admin) : paiements à vérifier, support, alertes de sécurité.
  `CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     admin_id UUID NOT NULL,
     endpoint TEXT UNIQUE NOT NULL,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_ok_at TIMESTAMPTZ)`,
];

// Services de notification officiels (Google/Android, Mozilla, Microsoft, Apple).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];
const MAX_DEVICES = 10;
const TITLES = {
  message: '💬 Nouveau message', appel: '📞 Appel entrant', groupe: '👥 Groupe', cadeau: '🎁 Cadeau reçu',
  abonne: '👤 Nouvel abonné', live: '🔴 En direct', paiement: '💳 Paiement', retrait: '💸 Retrait', vente: '💰 Vente',
  identite: '🪪 Identité', offre: '⭐ Eaji', commentaire: '💬 Commentaire', jaime: '❤️ J\'aime',
};

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// En-tête d'autorisation VAPID (jeton signé ES256, valable 12 h).
function vapidHeader(endpoint, keys, subject) {
  const unsigned = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))}`;
  const pub = unb64u(keys.publicKey);
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.publicKey}`;
}

// Chiffrement RFC 8291 (aes128gcm) : seul l'appareil abonné peut lire le contenu.
function encryptPayload(text, p256dh, authSecret) {
  const uaPublic = unb64u(p256dh), auth = unb64u(authSecret);
  if (uaPublic.length !== 65 || auth.length !== 16) throw new Error('Clés de l\'appareil invalides.');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

function endpointAllowed(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch (e) { return false; }
  const testPrefix = process.env.PUSH_TEST_ENDPOINT_PREFIX; // tests automatiques uniquement
  if (testPrefix && String(endpoint).startsWith(testPrefix)) return true;
  return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

function postEndpoint(endpoint, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'POST', headers: { ...headers, 'Content-Length': body.length }, timeout: 10000 }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

function create(db) {
  let keys = null;
  async function vapidKeys() {
    if (keys) return keys;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      keys = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() };
      return keys;
    }
    const row = await db.query("SELECT value FROM app_settings WHERE key = 'vapid_keys'");
    if (row && row.value) { keys = JSON.parse(row.value); return keys; }
    const fresh = generateVapidKeys();
    await db.query("INSERT INTO app_settings (key, value) VALUES ('vapid_keys', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(fresh)]);
    const again = await db.query("SELECT value FROM app_settings WHERE key = 'vapid_keys'");
    keys = JSON.parse(again.value);
    return keys;
  }
  const subject = () => process.env.VAPID_SUBJECT || 'https://jimmynho.github.io/Eaji-site/';

  // Envoie un message chiffré à une liste d'appareils ; oublie ceux qui se sont désabonnés.
  async function deliver(subs, payload, table, urgent, ttl) {
    const k = await vapidKeys();
    let sent = 0;
    for (const s of subs) {
      if (!endpointAllowed(s.endpoint)) { await db.query(`DELETE FROM ${table} WHERE id = $1`, [s.id]); continue; }
      let enc;
      try { enc = encryptPayload(payload, s.p256dh, s.auth); } catch (e) { await db.query(`DELETE FROM ${table} WHERE id = $1`, [s.id]); continue; }
      const status = await postEndpoint(s.endpoint, {
        'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm',
        TTL: String(ttl != null ? ttl : (urgent ? 60 : 24 * 3600)), Urgency: urgent ? 'high' : 'normal',
        Authorization: vapidHeader(s.endpoint, k, subject()),
      }, enc);
      if (status >= 200 && status < 300) { sent++; db.query(`UPDATE ${table} SET last_ok_at = now() WHERE id = $1`, [s.id]).catch(() => {}); }
      else if ([401, 403, 404, 410].includes(status)) await db.query(`DELETE FROM ${table} WHERE id = $1`, [s.id]);
    }
    return sent;
  }

  // Notification aux administrateurs : le principal reçoit tout ; un secondaire seulement ce qui
  // correspond à sa permission (ex. « répondre aux signalements » pour le support).
  async function sendToAdmins({ title, body, link = null, kind = 'admin', permission = null, urgent = false } = {}) {
    try {
      const subs = await db.all(
        `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM admin_push_subscriptions s JOIN admins a ON a.id = s.admin_id
         WHERE a.status = 'actif' AND (a.role = 'admin_principal'
           OR ($1::text IS NOT NULL AND EXISTS (SELECT 1 FROM admin_permissions p WHERE p.admin_id = a.id AND p.permission = $1)))`, [permission]);
      if (!subs.length) return 0;
      const payload = JSON.stringify({ title: String(title || 'Eaji Admin').slice(0, 80), body: String(body || '').slice(0, 240), link, kind, tag: kind, at: Date.now() });
      return await deliver(subs, payload, 'admin_push_subscriptions', urgent);
    } catch (e) { console.error('[Eaji] Notification administrateur non envoyée :', e.message); return 0; }
  }

  // Envoie une notification à tous les appareils actifs d'un compte (sans bloquer la requête).
  async function sendTo(creatorId, { title, body, link = null, kind = 'info', tag = null, urgent = false, ttl } = {}) {
    if (!creatorId) return 0;
    try {
      const subs = await db.all(
        `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN creators c ON c.id = s.creator_id
         WHERE s.creator_id = $1 AND c.account_status = 'actif' AND s.session_version = COALESCE(c.session_version, 0)`, [creatorId]);
      if (!subs.length) return 0;
      const k = await vapidKeys();
      const payload = JSON.stringify({ title: String(title || TITLES[kind] || 'Eaji').slice(0, 80), body: String(body || '').slice(0, 240),
        link, kind, tag: tag || link || kind, at: Date.now() });
      let sent = 0;
      for (const s of subs) {
        if (!endpointAllowed(s.endpoint)) { await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); continue; }
        let enc;
        try { enc = encryptPayload(payload, s.p256dh, s.auth); } catch (e) { await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); continue; }
        const status = await postEndpoint(s.endpoint, {
          'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm',
          TTL: String(ttl != null ? ttl : (urgent ? 60 : 24 * 3600)), Urgency: urgent ? 'high' : 'normal',
          Authorization: vapidHeader(s.endpoint, k, subject()),
        }, enc);
        if (status >= 200 && status < 300) { sent++; db.query('UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1', [s.id]).catch(() => {}); }
        else if (status === 404 || status === 410 || status === 401 || status === 403) await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); // appareil désabonné
      }
      return sent;
    } catch (e) { console.error('[Eaji] Notification appareil non envoyée :', e.message); return 0; }
  }

  function registerRoutes({ app, requireAuth, requireAdmin = null }) {
    app.get('/api/push/public-key', async (req, res) => { res.json({ publicKey: (await vapidKeys()).publicKey }); });

    app.post('/api/push/subscribe', requireAuth, async (req, res) => {
      const sub = req.body.subscription || req.body;
      const endpoint = String(sub.endpoint || '');
      const p256dh = String(sub.keys?.p256dh || ''), auth = String(sub.keys?.auth || '');
      if (endpoint.length > 1000 || !endpointAllowed(endpoint)) return res.status(400).json({ error: 'Service de notification non reconnu.' });
      if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) return res.status(400).json({ error: 'Clés de notification invalides.' });
      const c = await db.query('SELECT COALESCE(session_version, 0) AS v FROM creators WHERE id = $1', [req.creatorId]);
      await db.query(
        `INSERT INTO push_subscriptions (creator_id, endpoint, p256dh, auth, session_version, user_agent) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (endpoint) DO UPDATE SET creator_id = $1, p256dh = $3, auth = $4, session_version = $5, user_agent = $6, created_at = now()`,
        [req.creatorId, endpoint, p256dh, auth, c.v, String(req.headers['user-agent'] || '').slice(0, 200)]);
      // Appareil (« Mes connexions ») : s'il est déconnecté à distance, il ne reçoit plus les notifications.
      if (req.sessionId) await db.query('UPDATE push_subscriptions SET session_id = $2 WHERE endpoint = $1', [endpoint, req.sessionId]).catch(() => {});
      // appareils d'avant un changement de mot de passe : définitivement oubliés
      await db.query('DELETE FROM push_subscriptions WHERE creator_id = $1 AND session_version <> $2', [req.creatorId, c.v]);
      // pas plus de 10 appareils par compte : on oublie les plus anciens
      await db.query(
        `DELETE FROM push_subscriptions WHERE creator_id = $1 AND id NOT IN
           (SELECT id FROM push_subscriptions WHERE creator_id = $1 ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`, [req.creatorId]);
      res.status(201).json({ subscribed: true });
    });

    app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND creator_id = $2', [String(req.body.endpoint || ''), req.creatorId]);
      res.json({ unsubscribed: true });
    });

    // Application Eaji Admin : le téléphone de l'administrateur s'abonne aux alertes.
    if (requireAdmin) app.post('/api/admin/push/subscribe', requireAdmin, async (req, res) => {
      const sub = req.body.subscription || req.body;
      const endpoint = String(sub.endpoint || '');
      const p256dh = String(sub.keys?.p256dh || ''), auth = String(sub.keys?.auth || '');
      if (endpoint.length > 1000 || !endpointAllowed(endpoint)) return res.status(400).json({ error: 'Service de notification non reconnu.' });
      if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) return res.status(400).json({ error: 'Clés de notification invalides.' });
      await db.query(
        `INSERT INTO admin_push_subscriptions (admin_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET admin_id = $1, p256dh = $3, auth = $4, created_at = now()`, [req.adminId, endpoint, p256dh, auth]);
      res.status(201).json({ subscribed: true });
    });
    if (requireAdmin) app.post('/api/admin/push/test', requireAdmin, async (req, res) => {
      const subs = await db.all('SELECT id, endpoint, p256dh, auth FROM admin_push_subscriptions WHERE admin_id = $1', [req.adminId]);
      const sent = subs.length ? await deliver(subs, JSON.stringify({ title: '🔔 Eaji Admin', body: 'Les alertes arrivent bien sur ce téléphone.', link: 'admin:v-overview', kind: 'admin', tag: 'test', at: Date.now() }), 'admin_push_subscriptions') : 0;
      res.json({ sent });
    });

    app.post('/api/push/test', requireAuth, async (req, res) => {
      const sent = await sendTo(req.creatorId, { title: '🔔 Eaji', body: 'Les notifications fonctionnent sur cet appareil.', kind: 'info', link: 's-profil', tag: 'test' });
      res.json({ sent });
    });
  }

  return { sendTo, sendToAdmins, registerRoutes, vapidKeys };
}

module.exports = { create, MIGRATIONS, TITLES, encryptPayload, vapidHeader, generateVapidKeys, endpointAllowed };
