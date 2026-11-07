// Codes de connexion par SMS avec Firebase (Google) — remplace Twilio, beaucoup moins cher :
// les 10 premiers SMS de chaque jour sont gratuits, puis environ 0,13 $ le SMS vers la RDC (Twilio : 0,30 $).
//
// Comment ça marche :
//  1. le mot de passe est bon, le téléphone est nouveau, le compte n'a pas d'email (ou l'email n'est pas parti) ;
//  2. le serveur répond « channel: firebase » : c'est la page Eaji qui demande à Firebase d'envoyer le SMS ;
//  3. la personne tape le code reçu ; Firebase le vérifie et donne un « jeton » signé par Google ;
//  4. le serveur vérifie la signature de Google et que le numéro du jeton est bien celui du compte → connecté.
//
// Variables (Railway ET Render) — ce ne sont PAS des secrets, Google les met dans la page :
//   FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_APP_ID
//   FIREBASE_SMS_MAX_PER_DAY (facultatif, 10 par défaut = toujours gratuit). Au-delà, le code part autrement
//   (notification sur l'autre téléphone, ou à l'écran en dernier recours).
const crypto = require('crypto');

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS firebase_sms_log (
    id BIGSERIAL PRIMARY KEY,
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS firebase_sms_log_day_idx ON firebase_sms_log (created_at)',
  // Nouveau moyen d'envoi du code : « firebase » (en plus de « sms » et « gmail »).
  'ALTER TABLE account_verifications DROP CONSTRAINT IF EXISTS account_verifications_channel_check',
  "ALTER TABLE account_verifications ADD CONSTRAINT account_verifications_channel_check CHECK (channel IN ('sms', 'gmail', 'firebase'))",
];

function config() {
  const c = {
    apiKey: process.env.FIREBASE_API_KEY, authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID, appId: process.env.FIREBASE_APP_ID,
  };
  return c.apiKey && c.authDomain && c.projectId && c.appId ? c : null;
}
const maxPerDay = () => Math.max(0, Number(process.env.FIREBASE_SMS_MAX_PER_DAY || 10));

// Clés publiques de Google qui signent les jetons Firebase (renouvelées par Google ; gardées le temps indiqué).
const CERTS_URL = () => process.env.FIREBASE_CERTS_URL || 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certs = { keys: {}, until: 0 };
async function googleCerts(force = false) {
  if (!force && certs.until > Date.now() && Object.keys(certs.keys).length) return certs.keys;
  const r = await fetch(CERTS_URL());
  if (!r.ok) throw new Error('clés Google injoignables (' + r.status + ')');
  const maxAge = Number((/max-age=(\d+)/.exec(r.headers.get('cache-control') || '') || [])[1] || 3600);
  certs = { keys: await r.json(), until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  return certs.keys;
}

// Vérifie un jeton Firebase (RS256, émis par securetoken.google.com/<projet>) et renvoie ses informations.
async function verifyIdToken(idToken) {
  const cfg = config();
  if (!cfg) throw new Error('Firebase non configuré');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('jeton mal formé');
  const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  const header = dec(parts[0]), p = dec(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('jeton : signature inattendue');
  let keys = await googleCerts();
  if (!keys[header.kid]) keys = await googleCerts(true);
  const pem = keys[header.kid];
  if (!pem) throw new Error('jeton : clé inconnue');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(pem, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('jeton : signature fausse');
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== cfg.projectId || p.iss !== `https://securetoken.google.com/${cfg.projectId}`) throw new Error('jeton : autre projet');
  if (!p.sub || typeof p.sub !== 'string') throw new Error('jeton : utilisateur absent');
  if (!(p.exp > now) || !(p.iat <= now + 300) || !(p.auth_time <= now + 300)) throw new Error('jeton expiré');
  if (now - Number(p.auth_time) > 15 * 60) throw new Error('jeton trop ancien');
  if (!p.phone_number) throw new Error('jeton sans numéro');
  return p;
}

function register({ app, db, rateLimit, normalizePhone, finishLogin, security }) {
  // La page demande la configuration publique de Firebase (rien de secret).
  app.get('/api/auth/firebase-config', (req, res) => {
    const c = config();
    res.json(c ? { enabled: true, config: c } : { enabled: false });
  });

  // Peut-on envoyer un SMS Firebase maintenant (Firebase réglé, connexion avec le numéro, limite du jour) ?
  async function canUse(creator, via) {
    if (!config() || via !== 'telephone' || !creator.phone) return false;
    const n = await db.query("SELECT COUNT(*)::int AS n FROM firebase_sms_log WHERE created_at > date_trunc('day', now())");
    return (n ? n.n : 0) < maxPerDay();
  }
  async function noteSent(creatorId) { await db.query('INSERT INTO firebase_sms_log (creator_id) VALUES ($1)', [creatorId]); }

  // Le code SMS a été validé par Firebase : on vérifie le jeton de Google et que c'est bien le numéro du compte.
  app.post('/api/auth/login/verify-firebase', rateLimit('otpfb', 60, 15 * 60 * 1000), async (req, res) => {
    const creatorId = String(req.body.creatorId || '');
    if (!/^[0-9a-f-]{36}$/i.test(creatorId)) return res.status(401).json({ error: 'Code invalide.' });
    // Il faut une connexion en cours avec le BON mot de passe (demande de moins de 30 minutes).
    const record = await db.query(
      "SELECT * FROM account_verifications WHERE creator_id = $1 AND verified = FALSE ORDER BY created_at DESC LIMIT 1", [creatorId]);
    if (!record || record.channel !== 'firebase' || new Date() > new Date(record.expires_at) || Number(record.attempts || 0) >= 5) {
      return res.status(401).json({ code: 'code_expire', error: 'Ce code n\'est plus valable : recommence la connexion.' });
    }
    let t;
    try { t = await verifyIdToken(req.body.idToken); } catch (e) {
      await db.query('UPDATE account_verifications SET attempts = attempts + 1 WHERE id = $1', [record.id]);
      console.error('[firebase] jeton refusé :', e.message);
      return res.status(401).json({ error: 'La vérification du code par SMS a échoué. Réessaie.' });
    }
    const c = await db.query('SELECT phone, country_code FROM creators WHERE id = $1', [creatorId]);
    const mine = c && normalizePhone(c.phone, c.country_code);
    if (!mine || mine !== t.phone_number) {
      await db.query('UPDATE account_verifications SET attempts = attempts + 1 WHERE id = $1', [record.id]);
      await (security && security.log ? security.log('firebase_autre_numero', 'critique', { creatorId, ip: req.ip, detail: 'Code SMS validé pour un AUTRE numéro que celui du compte : refusé.' }) : Promise.resolve()).catch(() => {});
      return res.status(401).json({ error: 'Ce code a été envoyé à un autre numéro que celui du compte.' });
    }
    res.json(await finishLogin(creatorId, record.id, req));
  });

  return { canUse, noteSent, enabled: () => Boolean(config()) };
}

module.exports = { MIGRATIONS, register, verifyIdToken };
