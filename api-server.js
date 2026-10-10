/**
 * API backend — Eaji
 * -----------------------------------------------------------------
 * Relie les modules déjà écrits (rate-engine, payment-provider-router,
 * admin-commission-engine) au schéma de données (schema.sql) via une
 * API REST Express.
 *
 * NOTE : les appels `db.query(...)` sont des espaces réservés — à
 * brancher sur un vrai client PostgreSQL (ex: `pg`) pointant vers les
 * tables de schema.sql. Ce fichier définit le contrat des routes et
 * la logique métier, pas la connexion base de données elle-même.
 */

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { calculateEligibility, calculateMonthlyPayout } = require('./rate-engine');
const { isSupportedCurrency, convertFromUSD, payoutInCurrency, openingCommissionInCurrency, currencyCatalog } = require('./currencies');
const { resolvePaymentProvider, PROVIDER } = require('./payment-provider-router');
const { calculateOpeningCommission, calculateWithdrawalCommission, buildCommissionRecord } = require('./admin-commission-engine');
const { validateFileSize, isLiveEligible, LIVE_SUBSCRIBER_THRESHOLD } = require('./content-limits');
const { STORAGE_CONNECTED, buildStorageKey, createUploadUrl, createDownloadUrl, uploadThroughServer, tryEnableBrowserUploads } = require('./storage');
const { deleteCreatorAccount } = require('./account-deletion');
const moneyRoutes = require('./monetization-routes');
const { ZONES, MONETIZED_COUNTRIES, isKnownCountry, zoneOf, isMonetizedCreator, monetizationReason } = require('./world-countries');
const { SALE_PRICE_MIN, SALE_PRICE_MAX, VIDEO_TYPES, MAX_VIDEO_SECONDS, round2 } = require('./monetization');

const app = express();
app.use(cors()); // Autorise les appels depuis Netlify (à restreindre à ton domaine précis plus tard si besoin).
app.use(express.json());

// Filet de sécurité : une erreur dans une route (base de données, etc.) renvoie un message
// propre au lieu de faire planter tout le serveur.
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => {
    if (handlers.length === 0) return original(path); // app.get('réglage') d'Express
    return original(path, ...handlers.map((h) =>
      typeof h === 'function' && h.length < 4
        ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
        : h
    ));
  };
}

const { Pool } = require('pg');

// db : connexion réelle à PostgreSQL via la variable d'environnement DATABASE_URL
// (fournie automatiquement par Railway une fois la base de données ajoutée au projet).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

// Mises à jour de la base appliquées automatiquement au démarrage du serveur.
// Chacune est sans risque si elle a déjà été faite (IF NOT EXISTS).
// Aucun argent ne doit être annoncé comme encaissé ou versé tant qu'un vrai prestataire de
// paiement (mobile money / Stripe) n'est pas branché. Mettre PAYMENTS_ENABLED=true sur Railway
// seulement à ce moment-là.
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === 'true';
const PAYMENTS_DISABLED_MESSAGE =
  "Les paiements en ligne ne sont pas encore activés. Ils le seront dès l'ouverture du compte de paiement (mobile money / Stripe).";
function requirePayments(req, res, next) {
  if (!PAYMENTS_ENABLED) return res.status(503).json({ error: PAYMENTS_DISABLED_MESSAGE });
  next();
}

async function runStartupMigrations() {
  const steps = [
    // Compteur de vues par contenu : nécessaire à la règle « 1 000 vues ».
    'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0',
    // Comptes bloqués par un créateur (ne peuvent plus le suivre, lui écrire ni commenter).
    `CREATE TABLE IF NOT EXISTS blocks (
       blocker_id UUID NOT NULL REFERENCES creators(id),
       blocked_id UUID NOT NULL REFERENCES creators(id),
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (blocker_id, blocked_id)
     )`,
    // Messages vocaux : fichier audio rattaché à un message privé.
    'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS audio_key TEXT',
    // Appels audio/vidéo : la mise en relation des deux téléphones passe par ici.
    `CREATE TABLE IF NOT EXISTS calls (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       caller_id UUID NOT NULL REFERENCES creators(id),
       callee_id UUID NOT NULL REFERENCES creators(id),
       kind TEXT NOT NULL CHECK (kind IN ('audio', 'video')),
       offer_sdp TEXT NOT NULL,
       answer_sdp TEXT,
       status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'accepted', 'rejected', 'ended', 'missed')),
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    // Tous les pays du monde : zones Afrique, Caraïbes, Amérique, Asie, Europe, Océanie.
    // L'ancienne zone « Europe centrale » est regroupée dans « Europe ».
    'ALTER TABLE creators DROP CONSTRAINT IF EXISTS creators_zone_check',
    "UPDATE creators SET zone = 'europe' WHERE zone = 'europe_centrale'",
    `ALTER TABLE creators ADD CONSTRAINT creators_zone_check CHECK (zone IN
       ('afrique', 'caraibes', 'amerique', 'asie', 'europe', 'oceanie'))`,
    // Argent : paiements, premium, vidéos payantes, ventes, publicité, portefeuille (monetization-routes.js).
    ...moneyRoutes.MIGRATIONS,
  ];
  for (const sql of steps) {
    try { await pool.query(sql); }
    catch (e) { console.error('[Eaji] Mise à jour de la base ignorée :', e.message); }
  }
}
runStartupMigrations();
tryEnableBrowserUploads();

const db = {
  // Retourne la première ligne du résultat (adapté à la plupart des requêtes de ce fichier,
  // qui attendent un seul enregistrement — un créateur, un admin, etc.).
  query: async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result.rows[0];
  },
  // Retourne toutes les lignes du résultat (pour les listes : fil de contenus, commentaires...).
  all: async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result.rows;
  },
};

// Route de test simple : permet de vérifier que l'API répond, en ouvrant
// simplement ton domaine dans un navigateur.
app.get('/', (req, res) => {
  res.json({ status: 'Eaji API en ligne', time: new Date().toISOString() });
});

// ==================== MIDDLEWARES ====================

// Identifie le visiteur s'il est connecté, sans l'exiger (fil public, profils publics...).
function optionalViewerId(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  try { return verifySessionToken(token); } catch { return null; }
}

// Vrai si l'un des deux a bloqué l'autre.
async function isBlockedBetween(a, b) {
  if (!a || !b) return false;
  const row = await db.query(
    'SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
    [a, b]
  );
  return Boolean(row);
}

const VALID_ZONES = ZONES;
const VALID_CURRENCIES = ['USD', 'EUR', 'CDF'];

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });
  try {
    req.creatorId = verifySessionToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
}

// Vérifie le jeton signé envoyé par le tableau de bord admin et renvoie
// l'id admin qu'il contient — jamais fait confiance à un en-tête non signé.
async function authenticateAdminToken(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new Error('Authentification admin requise.');
  const adminId = verifySessionToken(token); // lève une erreur si invalide/expiré
  const admin = await db.query('SELECT * FROM admins WHERE id = $1', [adminId]);
  if (!admin || admin.status !== 'actif') throw new Error('Administrateur inconnu ou suspendu.');
  return admin;
}

async function requireAdminPrincipal(req, res, next) {
  try {
    const admin = await authenticateAdminToken(req);
    if (admin.role !== 'admin_principal') {
      return res.status(403).json({ error: "Seul l'administrateur principal peut effectuer cette action." });
    }
    req.adminId = admin.id;
    next();
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}

// Laisse passer l'admin principal (accès total) ou un admin secondaire qui
// détient explicitement la permission demandée.
function requireAdminPermission(permission) {
  return async (req, res, next) => {
    try {
      const admin = await authenticateAdminToken(req);
      if (admin.role === 'admin_principal') { req.adminId = admin.id; return next(); }
      const granted = await db.query(
        'SELECT 1 FROM admin_permissions WHERE admin_id = $1 AND permission = $2',
        [admin.id, permission]
      );
      if (!granted) return res.status(403).json({ error: `Permission "${permission}" non accordée à cet administrateur.` });
      req.adminId = admin.id;
      next();
    } catch (e) {
      res.status(401).json({ error: e.message });
    }
  };
}

// Jeton de session signé (sans dépendance externe type JWT) : contient l'id du
// créateur + une expiration, signés avec une clé secrète. Si le jeton est modifié,
// la signature ne correspond plus et il est rejeté.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET manquant — définis une variable d\'environnement SESSION_SECRET longue et aléatoire sur Railway avant d\'accepter de vrais utilisateurs.');
}
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function signSessionToken(creatorId) {
  const payload = Buffer.from(JSON.stringify({ sub: creatorId, exp: Date.now() + SESSION_DURATION_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET || 'dev-secret-non-securise').update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('Jeton malformé.');
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET || 'dev-secret-non-securise').update(payload).digest('base64url');
  if (signature !== expectedSignature) throw new Error('Signature invalide.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (Date.now() > data.exp) throw new Error('Jeton expiré.');
  return data.sub;
}

// ==================== AUTHENTIFICATION & 2FA ====================

// Inscription : crée le compte, déclenche l'envoi des deux codes de vérification.
app.post('/api/auth/register', async (req, res) => {
  const { name, phone, password, countryCode, primaryContentType, language, currency } = req.body;
  const email = String(req.body.email || '').trim().toLowerCase();
  // La zone est déduite du pays (tous les pays du monde sont acceptés).
  const zone = zoneOf(req.body.countryCode);

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Indique ton nom.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide (exemple : nom@gmail.com).' });
  if (!phone || String(phone).replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  if (!isKnownCountry(countryCode) || !VALID_ZONES.includes(zone)) return res.status(400).json({ error: 'Choisis ton pays.' });

  const passwordHash = await bcrypt.hash(password, 12);
  const giftCurrency = isSupportedCurrency(currency) ? String(currency).toUpperCase() : 'USD';

  const creator = await db.query(
    `INSERT INTO creators (name, email, phone, password_hash, country_code, zone, primary_content_type, language, gift_currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, country_code`,
    [String(name).trim(), email, String(phone).replace(/[\s.-]/g, ''), passwordHash, String(countryCode).toUpperCase(), zone,
     primaryContentType || 'video_courte', language || 'fr', giftCurrency]
  );
  // Pas d'envoi de code ici : le site enchaîne aussitôt sur la connexion, qui envoie UN seul code.
  // (Avant, deux codes différents partaient par email, et le premier ne marchait plus.)
  const smsCode = null;

  // Commission d'ouverture de compte (2 $ / 2 € / 5 000 FC) créditée à l'administrateur principal.
  // Ne bloque jamais l'inscription si l'enregistrement échoue.
  try {
    const principal = await db.query("SELECT id FROM admins WHERE role = 'admin_principal' LIMIT 1");
    if (principal) {
      const commission = openingCommissionInCurrency(giftCurrency);
      await db.query(
        `INSERT INTO admin_commissions (admin_id, creator_id, type, amount, currency)
         VALUES ($1, $2, 'ouverture', $3, $4)`,
        [principal.id, creator.id, commission.amount, commission.currency]
      );
    }
  } catch (e) {
    console.error('[Eaji] Commission d\'ouverture non enregistrée :', e.message);
  }

  res.status(201).json({
    creatorId: creator.id,
    message: 'Compte créé.',
    ...(smsCode ? { devCode: smsCode, devWarning: 'Mode test — aucun SMS réel envoyé. À retirer avant le vrai lancement.' } : {}),
  });
});

// Vérifie un des deux canaux (sms ou gmail). Le compte est actif
// seulement quand les deux sont vérifiés.
app.post('/api/auth/verify', async (req, res) => {
  const { creatorId, channel, code } = req.body;
  const record = await db.query(
    'SELECT * FROM account_verifications WHERE creator_id = $1 AND channel = $2 AND verified = FALSE ORDER BY created_at DESC LIMIT 1',
    [creatorId, channel]
  );
  if (!record || !(await bcrypt.compare(code, record.code_hash)) || new Date() > record.expires_at) {
    return res.status(400).json({ error: 'Code invalide ou expiré.' });
  }
  await db.query('UPDATE account_verifications SET verified = TRUE WHERE id = $1', [record.id]);
  res.json({ verified: true, channel });
});

// Connexion étape 1 : mot de passe. Déclenche l'envoi d'un OTP (2ème facteur).
app.post('/api/auth/login', async (req, res) => {
  const { email, password, ipAddress, deviceFingerprint } = req.body;
  const creator = await db.query('SELECT * FROM creators WHERE lower(email) = lower($1)', [String(email || '').trim()]);

  const passwordOk = creator && (await bcrypt.compare(password || '', creator.password_hash));

  await logLoginAttempt({ creatorId: creator?.id, ipAddress, deviceFingerprint, success: !!passwordOk });

  if (!passwordOk) return res.status(401).json({ error: 'Identifiants invalides.' });
  if (creator.account_status && creator.account_status !== 'actif') {
    return res.status(403).json({ error: 'Ce compte est suspendu. Contacte l\'administrateur.' });
  }

  const { code: devCode, channel } = await sendLoginOtp(creator);
  const channelLabel = { gmail: 'par email', sms: 'par SMS', demo: '(mode test)' }[channel];
  res.json({
    creatorId: creator.id,
    message: `Code de vérification envoyé ${channelLabel}.`,
    ...(devCode ? { devCode, devWarning: "L'email n'a pas pu être envoyé : le code est affiché ici." } : {}),
  });
});

// Connexion étape 2 : validation de l'OTP → émission de la session.
// Peu importe le canal utilisé (email ou SMS) — on prend le dernier code non vérifié.
app.post('/api/auth/login/verify-2fa', async (req, res) => {
  const { creatorId, code } = req.body;
  const record = await db.query(
    "SELECT * FROM account_verifications WHERE creator_id = $1 AND verified = FALSE ORDER BY created_at DESC LIMIT 1",
    [creatorId]
  );
  if (!record || !(await bcrypt.compare(code, record.code_hash))) {
    return res.status(401).json({ error: 'Code invalide.' });
  }
  await db.query('UPDATE account_verifications SET verified = TRUE WHERE id = $1', [record.id]);
  const token = signSessionToken(creatorId);
  res.json({ token });
});

// SMS réel via Twilio — s'active automatiquement dès que les 3 variables
// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER sont présentes
// sur Railway. Tant qu'elles n'y sont pas, le code reste exposé en clair dans
// la réponse API (mode test) pour que l'inscription/connexion reste testable.
// ⚠️ Ne jamais ouvrir de vrais paiements tant que SMS_PROVIDER_CONNECTED n'est
// pas vrai — sinon n'importe qui connaissant un téléphone peut usurper un compte.
const SMS_PROVIDER_CONNECTED = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

let twilioClient = null;
if (SMS_PROVIDER_CONNECTED) {
  twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️  Twilio non configuré — les codes de vérification restent en mode test (exposés dans la réponse API, jamais envoyés par vrai SMS).');
}

async function sendSmsReal(toPhone, body) {
  await twilioClient.messages.create({
    to: toPhone,
    from: process.env.TWILIO_PHONE_NUMBER,
    body,
  });
}

// Email réel et GRATUIT via Gmail — s'active dès que GMAIL_USER et
// GMAIL_APP_PASSWORD sont présents sur Railway. GMAIL_APP_PASSWORD n'est PAS
// le mot de passe normal du compte Gmail : c'est un "mot de passe d'application"
// à 16 caractères, généré depuis myaccount.google.com/apppasswords (nécessite
// la validation en 2 étapes activée sur ce compte Gmail — gratuit, aucune carte
// bancaire requise).
// Deux façons d'envoyer les emails :
//  - Brevo (recommandé) : passe par le web (HTTPS), jamais bloqué par Railway, gratuit jusqu'à 300 emails/jour.
//    Variables : BREVO_API_KEY et BREVO_SENDER_EMAIL (l'adresse d'expéditeur validée chez Brevo).
//  - Gmail (SMTP) : bloqué par Railway sauf sur l'offre Pro.
const BREVO_CONNECTED = !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
const GMAIL_CONNECTED = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const EMAIL_PROVIDER_CONNECTED = BREVO_CONNECTED || GMAIL_CONNECTED;

let mailTransporter = null;
if (GMAIL_CONNECTED && !BREVO_CONNECTED) {
  mailTransporter = require('nodemailer').createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    // Échouer vite si l'hébergeur bloque l'envoi (au lieu d'attendre plusieurs minutes).
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000,
  });
}
if (BREVO_CONNECTED) console.log('[Eaji] Emails envoyés via Brevo.');
else if (GMAIL_CONNECTED) console.warn('[Eaji] Emails via Gmail (SMTP) : Railway le bloque hors offre Pro. Si les codes n\'arrivent pas, ils s\'afficheront à l\'écran.');
else console.warn('⚠️  Aucun envoi d\'email configuré — les codes s\'affichent à l\'écran.');

// Après un échec d'envoi, on n'essaie plus pendant 10 minutes : le code s'affiche tout de suite.
let emailBrokenUntil = 0;

// Gmail (SMTP) : on vérifie dès le démarrage, puis toutes les 10 minutes, si l'envoi est possible.
// S'il est bloqué, les codes s'affichent directement à l'écran, sans faire attendre personne.
async function checkSmtpReachable() {
  if (!mailTransporter) return;
  try {
    await Promise.race([mailTransporter.verify(), new Promise((_, r) => setTimeout(() => r(new Error('délai dépassé')), 6000))]);
    emailBrokenUntil = 0;
  } catch (e) {
    emailBrokenUntil = Date.now() + 11 * 60 * 1000;
    console.warn('[Eaji] Envoi Gmail impossible depuis ce serveur (' + e.message + ') : les codes seront affichés à l\'écran.');
  }
}
checkSmtpReachable();
setInterval(checkSmtpReachable, 10 * 60 * 1000).unref();

async function sendEmailReal(toEmail, subject, text) {
  if (BREVO_CONNECTED) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: process.env.BREVO_SENDER_EMAIL, name: 'Eaji' },
        to: [{ email: toEmail }],
        subject,
        textContent: text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status} : ${(await res.text()).slice(0, 200)}`);
    return;
  }
  await mailTransporter.sendMail({ from: process.env.GMAIL_USER, to: toEmail, subject, text });
}

// Envoie un email en attendant au plus 8 secondes. Renvoie true si c'est parti.
async function trySendEmail(toEmail, subject, text) {
  if (!EMAIL_PROVIDER_CONNECTED || Date.now() < emailBrokenUntil) return false;
  try {
    await Promise.race([
      sendEmailReal(toEmail, subject, text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('délai dépassé')), 6000)),
    ]);
    return true;
  } catch (e) {
    console.error('[Eaji] Échec envoi email :', e.message);
    emailBrokenUntil = Date.now() + 10 * 60 * 1000;
    return false;
  }
}

// Choisit le meilleur canal disponible pour un code de connexion, en
// privilégiant toujours le gratuit (email) tant que Twilio n'est pas payé.
// Écrit dans account_verifications avec le canal réellement utilisé, pour
// que verify-2fa retrouve le bon enregistrement peu importe le canal.
async function sendLoginOtp(creator) {
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, 10);

  let channel = 'demo';
  if (EMAIL_PROVIDER_CONNECTED) channel = 'gmail';
  else if (SMS_PROVIDER_CONNECTED) channel = 'sms';

  // La base n'accepte que 'sms' ou 'gmail' comme canal : en mode test (aucun envoi
  // configuré), on enregistre 'gmail' — le code reste valable de la même façon.
  await db.query(
    `INSERT INTO account_verifications (creator_id, channel, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [creator.id, channel === 'sms' ? 'sms' : 'gmail', codeHash]
  );

  // Email : si l'envoi échoue (ou est bloqué), le code est affiché à l'écran au lieu de bloquer la personne.
  if (channel === 'gmail') {
    const sent = await trySendEmail(creator.email, 'Eaji — ton code de connexion', `Ton code de vérification : ${code} (valable 10 minutes).`);
    return sent ? { code: null, channel } : { code, channel: 'demo' };
  } else if (channel === 'sms') {
    sendSmsReal(creator.phone, `Eaji — ton code de vérification : ${code} (valable 10 minutes).`)
      .catch((e) => console.error('Échec envoi SMS Twilio :', e.message));
    return { code: null, channel };
  }

  return { code, channel: 'demo' }; // repli mode test si rien n'est configuré ou que l'envoi échoue
}

async function sendVerificationCode(creatorId, channel, destination) {
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, 10);
  await db.query(
    `INSERT INTO account_verifications (creator_id, channel, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [creatorId, channel, codeHash]
  );

  if (channel === 'sms' && SMS_PROVIDER_CONNECTED) {
    try {
      await sendSmsReal(destination, `Eaji — ton code de vérification : ${code} (valable 10 minutes).`);
    } catch (e) {
      console.error('Échec envoi SMS Twilio :', e.message);
      // On ne bloque pas l'inscription/connexion si Twilio échoue temporairement,
      // mais le code n'a alors été transmis nulle part — à surveiller en prod.
    }
    return null;
  }

  if (channel === 'gmail' && EMAIL_PROVIDER_CONNECTED) {
    try {
      await sendEmailReal(destination, 'Eaji — confirme ton compte', `Ton code de vérification : ${code} (valable 10 minutes).`);
    } catch (e) {
      console.error('Échec envoi email Gmail :', e.message);
    }
    return null;
  }

  return code; // mode test : aucun des deux canaux n'est configuré pour ce type d'envoi
}

async function logLoginAttempt({ creatorId, ipAddress, deviceFingerprint, success }) {
  const suspicious = await isSuspiciousAttempt(creatorId, ipAddress, deviceFingerprint);
  await db.query(
    `INSERT INTO login_attempts (creator_id, ip_address, device_fingerprint, success, flagged)
     VALUES ($1, $2, $3, $4, $5)`,
    [creatorId, ipAddress, deviceFingerprint, success, suspicious]
  );
  if (suspicious) await notifyAccountOwnerImmediately(creatorId);
}

async function isSuspiciousAttempt(creatorId, _ipAddress, _deviceFingerprint) {
  const recentFailures = await db.query(
    "SELECT COUNT(*) FROM login_attempts WHERE creator_id = $1 AND success = FALSE AND created_at > now() - interval '15 minutes'",
    [creatorId]
  );
  return recentFailures?.count >= 3; // seuil à ajuster
}

async function notifyAccountOwnerImmediately(_creatorId) {
  // Brancher notification push + email immédiate ici.
}

// ==================== PROFIL & CONFIDENTIALITÉ ====================

// Le solde n'est jamais renvoyé à quelqu'un d'autre que le propriétaire.
// Historique réel des paiements du créateur connecté.
app.get('/api/creators/me/transactions', requireAuth, async (req, res) => {
  const transactions = await db.all(
    'SELECT amount, currency, status, period_start, period_end, created_at FROM transactions WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.creatorId]
  );
  res.json({ transactions });
});

app.get('/api/creators/:id', requireAuth, async (req, res) => {
  const creator = await db.query('SELECT * FROM creators WHERE id = $1', [req.params.id]);
  if (!creator) return res.status(404).json({ error: 'Compte introuvable.' });
  const isOwner = req.creatorId === req.params.id;

  const publicProfile = {
    id: creator.id,
    name: creator.name,
    zone: creator.zone,
    photoUrl: await createDownloadUrl(creator.photo_url).catch(() => null),
    subscriberCount: creator.subscriber_count_public || isOwner ? creator.subscriber_count : undefined,
  };

  if (isOwner) {
    const balance = await db.query('SELECT * FROM creator_balances WHERE creator_id = $1', [creator.id]);
    // Un compte neuf n'a pas encore de ligne de solde : on renvoie 0 au lieu de planter.
    publicProfile.balance = balance ? balance.balance : 0;
    publicProfile.currency = balance ? balance.currency : 'USD';
    publicProfile.withdrawalPhone = creator.withdrawal_phone;
    publicProfile.countryCode = creator.country_code;
    publicProfile.primaryContentType = creator.primary_content_type;
    publicProfile.verificationStatus = creator.verification_status;
    publicProfile.email = creator.email;
    publicProfile.phone = creator.phone;
    publicProfile.language = creator.language;
    publicProfile.giftCurrency = creator.gift_currency;
    publicProfile.profileVisibility = creator.profile_visibility;
    publicProfile.subscriberCountPublic = creator.subscriber_count_public;
    publicProfile.premiumUntil = await money.premiumUntil(creator.id);
    publicProfile.monetized = isMonetizedCreator(creator.country_code, creator.phone);
    publicProfile.monetizationReason = monetizationReason(creator.country_code, creator.phone);
  }

  res.json(publicProfile);
});

app.patch('/api/creators/me/visibility', requireAuth, async (req, res) => {
  const { profileVisibility, subscriberCountPublic } = req.body;
  await db.query(
    'UPDATE creators SET profile_visibility = COALESCE($1, profile_visibility), subscriber_count_public = COALESCE($2, subscriber_count_public) WHERE id = $3',
    [profileVisibility, subscriberCountPublic, req.creatorId]
  );
  res.json({ updated: true });
});

// Changement de mot de passe : exige l'ancien mot de passe avant d'accepter le nouveau.
// Fonctionne pour un créateur (requireAuth) comme pour un administrateur (à adapter avec requireAdminAuth
// si un système de session admin séparé est mis en place).
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
  }

  const creator = await db.query('SELECT password_hash FROM creators WHERE id = $1', [req.creatorId]);
  const currentOk = creator && (await bcrypt.compare(currentPassword, creator.password_hash));
  if (!currentOk) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  await db.query('UPDATE creators SET password_hash = $1 WHERE id = $2', [newHash, req.creatorId]);
  res.json({ updated: true });
});

// ==================== RÉMUNÉRATION & PAIEMENTS ====================

// Monétisation réservée aux créateurs des pays éligibles (voir world-countries.js).
async function monetizationOf(creatorId) {
  const c = await db.query('SELECT country_code, phone FROM creators WHERE id = $1', [creatorId]);
  if (!c) return { monetized: false, reason: 'pays' };
  return { monetized: isMonetizedCreator(c.country_code, c.phone), reason: monetizationReason(c.country_code, c.phone) };
}

app.get('/api/creators/:id/eligibility', requireAuth, async (req, res) => {
  const { subscribers, views } = await getLatestMetrics(req.params.id);
  const m = await monetizationOf(req.params.id);
  const result = calculateEligibility(subscribers, views);
  res.json({ ...result, eligible: m.monetized && result.eligible, monetized: m.monetized, monetizationReason: m.reason });
});

app.get('/api/creators/:id/payout-preview', requireAuth, async (req, res) => {
  const { subscribers, views } = await getLatestMetrics(req.params.id);
  const currency = isSupportedCurrency(req.query.currency) ? String(req.query.currency).toUpperCase() : 'USD';
  const m = await monetizationOf(req.params.id);
  const payout = payoutInCurrency({ subscribers, views, currency });
  if (!m.monetized) {
    return res.json({ subscribers, views, ...payout, eligible: false, amount: 0, monetized: false, monetizationReason: m.reason });
  }
  res.json({ subscribers, views, ...payout, monetized: true });
});

// Liste des pays où les créateurs peuvent gagner de l'argent.
app.get('/api/countries/monetized', (req, res) => {
  res.json({ monetized: [...MONETIZED_COUNTRIES] });
});

app.post('/api/payouts/withdraw', requireAuth, requirePayments, async (req, res) => {
  const { amount, currency } = req.body;
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Indique un montant de retrait positif.' });
  }
  const creator = await db.query('SELECT country_code FROM creators WHERE id = $1', [req.creatorId]);
  const providerConfig = resolvePaymentProvider(creator.country_code);

  if (providerConfig.provider === PROVIDER.MANUAL_REVIEW) {
    return res.status(422).json({ error: 'Pays non encore configuré pour les retraits — revue manuelle nécessaire.' });
  }

  const commission = calculateWithdrawalCommission(amount, currency);
  // await db.query('INSERT INTO admin_commissions ...', buildCommissionRecord({ ... }));
  // Déclencher ensuite le virement réel via providerConfig.provider / providerConfig.aggregator.

  res.json({ status: 'pending', provider: providerConfig.provider, netToCreator: commission.netToCreator });
});

async function getLatestMetrics(creatorId) {
  const row = await db.query(
    'SELECT subscriber_count FROM subscriber_counts WHERE creator_id = $1 ORDER BY verified_at DESC LIMIT 1',
    [creatorId]
  );
  const views = await db.query(
    'SELECT COALESCE(SUM(view_count), 0) AS total FROM content_items WHERE creator_id = $1',
    [creatorId]
  );
  // Abonnés : ceux qui suivent le créateur sur Eaji (ou un chiffre vérifié plus élevé s'il existe).
  const followers = await db.query('SELECT COUNT(*)::int AS total FROM follows WHERE followed_id = $1', [creatorId]);
  return {
    subscribers: Math.max(Number(row?.subscriber_count || 0), Number(followers?.total || 0)),
    views: Number(views?.total || 0),
  };
}

// ==================== CONTENUS & MODÉRATION ====================

// Étape 1 de l'envoi d'un fichier : le site demande une adresse temporaire,
// puis envoie le fichier directement au stockage (B2), puis appelle POST /api/content.
app.post('/api/content/upload-url', requireAuth, async (req, res) => {
  if (!STORAGE_CONNECTED) {
    return res.status(503).json({ error: "Le stockage de fichiers n'est pas encore activé sur le serveur." });
  }
  const { contentType, fileName, mimeType, fileSizeBytes } = req.body;
  const sizeCheck = validateFileSize(contentType, fileSizeBytes);
  if (!sizeCheck.valid) return res.status(400).json({ error: sizeCheck.error });

  const storageKey = buildStorageKey(req.creatorId, fileName);
  const uploadUrl = await createUploadUrl(storageKey, mimeType);
  res.json({ uploadUrl, storageKey });
});

// Chemin relais : si le navigateur ne peut pas envoyer directement à B2, il envoie le
// fichier ici et le serveur le transmet. La clé doit avoir été délivrée à ce créateur.
const MAX_RELAY_BYTES = 1024 * 1024 * 1024; // 1 Go, la plus grande limite (vidéos)
app.put('/api/content/upload-proxy', requireAuth, async (req, res) => {
  if (!STORAGE_CONNECTED) {
    return res.status(503).json({ error: "Le stockage de fichiers n'est pas encore activé sur le serveur." });
  }
  const storageKey = String(req.query.key || '');
  if (!storageKey.startsWith(`${req.creatorId}/`) || storageKey.includes('..')) {
    return res.status(403).json({ error: 'Envoi non autorisé pour ce fichier.' });
  }
  const length = Number(req.headers['content-length']);
  if (!length || length > MAX_RELAY_BYTES) {
    return res.status(400).json({ error: 'Taille de fichier invalide ou trop grande.' });
  }
  await uploadThroughServer(storageKey, req.headers['content-type'], req, length);
  res.json({ uploaded: true });
});

app.post('/api/content', requireAuth, async (req, res) => {
  const { contentType, title, storageUrl, visibilityScope, fileSizeBytes } = req.body;

  const sizeCheck = validateFileSize(contentType, fileSizeBytes);
  if (!sizeCheck.valid) return res.status(400).json({ error: sizeCheck.error });

  // Durée des vidéos (lue par le téléphone avant l'envoi) : 60 minutes au maximum.
  const durationSeconds = Number(req.body.durationSeconds) > 0 ? Math.round(Number(req.body.durationSeconds)) : null;
  if (VIDEO_TYPES.includes(contentType) && durationSeconds > MAX_VIDEO_SECONDS) {
    return res.status(400).json({ error: 'Une vidéo ne peut pas dépasser 60 minutes.' });
  }
  const sale = await parseSalePrice(req.body.salePrice, req.creatorId);
  if (sale.error) return res.status(400).json({ error: sale.error });

  const content = await db.query(
    `INSERT INTO content_items (creator_id, content_type, title, storage_url, file_size_bytes, visibility_scope, duration_seconds, sale_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [req.creatorId, contentType, title, storageUrl, fileSizeBytes || null, visibilityScope || 'public', durationSeconds, sale.skip ? null : sale.value]
  );
  res.status(201).json({ contentId: content.id });
});

// Le live se débloque à 500 abonnés (distinct du seuil de rémunération à 1000).
app.get('/api/creators/:id/live-eligibility', requireAuth, async (req, res) => {
  const { subscribers } = await getLatestMetrics(req.params.id);
  res.json({ eligible: isLiveEligible(subscribers), threshold: LIVE_SUBSCRIBER_THRESHOLD, subscribers });
});

app.post('/api/live/start', requireAuth, async (req, res) => {
  const { subscribers } = await getLatestMetrics(req.creatorId);
  if (!isLiveEligible(subscribers)) {
    return res.status(403).json({ error: `Live réservé aux créateurs ayant au moins ${LIVE_SUBSCRIBER_THRESHOLD} abonnés.` });
  }
  const session = await db.query(
    'INSERT INTO live_sessions (creator_id) VALUES ($1) RETURNING id',
    [req.creatorId]
  );
  res.status(201).json({ liveSessionId: session.id });
});

app.post('/api/live/:id/end', requireAuth, async (req, res) => {
  await db.query("UPDATE live_sessions SET status = 'termine', ended_at = now() WHERE id = $1", [req.params.id]);
  res.json({ ended: true });
});

// Cadeau en argent — toujours versé dans la devise choisie par le destinataire (gift_currency).
app.post('/api/gifts', requireAuth, requirePayments, async (req, res) => {
  const { toCreatorId, contentId, liveSessionId, amount } = req.body;
  if (!contentId && !liveSessionId) {
    return res.status(400).json({ error: 'Un cadeau doit être associé à un contenu ou à un live.' });
  }
  const recipient = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [toCreatorId]);
  if (!recipient) return res.status(404).json({ error: 'Compte introuvable.' });
  // Les montants proposés (1 $, 5 $, ...) sont convertis au taux du jour dans la devise du destinataire.
  let currency = recipient.gift_currency;
  let converted;
  try { converted = convertFromUSD(Number(amount), currency); }
  catch (e) { currency = 'USD'; converted = Number(amount); }
  const gift = await db.query(
    `INSERT INTO gifts (from_creator_id, to_creator_id, content_id, live_session_id, amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.creatorId, toCreatorId, contentId || null, liveSessionId || null, converted, currency]
  );
  res.status(201).json({ giftId: gift.id, currency, amount: converted });
});

// Fil de contenus publics (découverte) : les plus récents en premier,
// avec le nom du créateur et les compteurs likes/commentaires.
app.get('/api/feed', async (req, res) => {
  const viewerId = optionalViewerId(req);
  const country = /^[A-Z]{2}$/.test(String(req.query.country || '')) ? req.query.country : null;
  const items = await db.all(
    `SELECT c.id, c.title, c.content_type, c.created_at, c.visibility_scope,
            c.storage_url, c.duration_seconds, c.sale_price,
            cr.id AS creator_id, cr.name AS creator_name, cr.country_code AS creator_country, cr.photo_url AS creator_photo_key,
            cr.phone AS creator_phone,
            EXISTS (SELECT 1 FROM premium_subscriptions ps WHERE ps.creator_id = cr.id AND ps.ends_at > now()) AS creator_premium,
            EXISTS (SELECT 1 FROM premium_subscriptions ps WHERE ps.creator_id = cr.id AND ps.ends_at > now() AND ps.plan LIKE 'entreprise%') AS creator_business,
            (SELECT COUNT(*) FROM content_likes WHERE content_id = c.id) AS like_count,
            (SELECT COUNT(*) FROM content_comments WHERE content_id = c.id) AS comment_count
     FROM content_items c
     JOIN creators cr ON cr.id = c.creator_id
     WHERE c.status = 'actif' AND cr.account_status = 'actif'
       AND ($1::text IS NULL OR cr.country_code = $1)
       AND (c.visibility_scope = 'public'
            OR c.creator_id = $2
            OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followed_id = c.creator_id))
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = c.creator_id AND b.blocked_id = $2)
                                                OR (b.blocker_id = $2 AND b.blocked_id = c.creator_id))
     -- Les membres premium gagnent en visibilité : leurs publications de la semaine passent devant.
     ORDER BY (EXISTS (SELECT 1 FROM premium_subscriptions ps WHERE ps.creator_id = cr.id AND ps.ends_at > now())
               AND c.created_at > now() - interval '7 days') DESC,
              c.created_at DESC
     LIMIT 50`,
    [country, viewerId]
  );
  for (const item of items) {
    // Le numéro n'est jamais envoyé : il sert seulement à savoir si le créateur est monétisé.
    item.creator_monetized = isMonetizedCreator(item.creator_country, item.creator_phone);
    delete item.creator_phone;
  }
  const access = await money.accessMap(viewerId, items);
  for (const item of items) {
    const a = access.get(item.id);
    item.price = a.price;
    item.for_sale = a.forSale;
    item.locked = a.locked;
    // Contenu payant pas encore débloqué : le fichier n'est pas envoyé.
    item.fileUrl = a.locked ? null : await createDownloadUrl(item.storage_url).catch(() => null);
    item.creator_photo = await createDownloadUrl(item.creator_photo_key).catch(() => null);
    delete item.storage_url;
    delete item.creator_photo_key;
  }
  let following = [];
  if (viewerId) {
    following = (await db.all('SELECT followed_id FROM follows WHERE follower_id = $1', [viewerId])).map((r) => r.followed_id);
  }
  const ads = await money.adsForFeed(country).catch(() => []);
  res.json({ items, following, ads });
});

// 6. Profil public d'un créateur : visible par tous, abonnés ou non, pour pouvoir s'abonner.
app.get('/api/creators/:id/public', async (req, res) => {
  const viewerId = optionalViewerId(req);
  const creator = await db.query(
    "SELECT * FROM creators WHERE id = $1 AND account_status = 'actif'", [req.params.id]
  );
  if (!creator || (await isBlockedBetween(viewerId, creator.id))) {
    return res.status(404).json({ error: 'Compte introuvable.' });
  }
  const followers = await db.query('SELECT COUNT(*)::int AS total FROM follows WHERE followed_id = $1', [creator.id]);
  const isFollowing = viewerId
    ? Boolean(await db.query('SELECT 1 FROM follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, creator.id]))
    : false;
  const contents = await db.all(
    `SELECT id, title, content_type, created_at, duration_seconds, sale_price, creator_id, $4::boolean AS creator_monetized FROM content_items
     WHERE creator_id = $1 AND status = 'actif'
       AND (visibility_scope = 'public' OR $2::boolean OR creator_id = $3)
     ORDER BY created_at DESC LIMIT 50`,
    [creator.id, isFollowing, viewerId, isMonetizedCreator(creator.country_code, creator.phone)]
  );
  res.json({
    monetized: isMonetizedCreator(creator.country_code, creator.phone),
    id: creator.id,
    name: creator.name,
    countryCode: creator.country_code,
    zone: creator.zone,
    primaryContentType: creator.primary_content_type,
    photoUrl: await createDownloadUrl(creator.photo_url).catch(() => null),
    subscriberCount: creator.subscriber_count_public || viewerId === creator.id ? followers.total : null,
    isFollowing,
    isMe: viewerId === creator.id,
    premium: Boolean(await money.premiumUntil(creator.id)),
    business: Boolean(await money.businessUntil(creator.id)),
    contents: await (async () => {
      const access = await money.accessMap(viewerId, contents);
      return contents.map((c) => {
        const a = access.get(c.id);
        return { id: c.id, title: c.title, content_type: c.content_type, created_at: c.created_at,
                 duration_seconds: c.duration_seconds, price: a.price, for_sale: a.forSale, locked: a.locked };
      });
    })(),
  });
});

// Une vue est comptée quand quelqu'un regarde/écoute/ouvre un contenu.
// Les vues du créateur sur ses propres contenus ne comptent pas.
app.post('/api/content/:id/view', async (req, res) => {
  let viewerId = null;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) { try { viewerId = verifySessionToken(token); } catch { /* visiteur non connecté */ } }
  await db.query(
    `UPDATE content_items SET view_count = view_count + 1
     WHERE id = $1 AND status = 'actif' AND creator_id IS DISTINCT FROM $2`,
    [req.params.id, viewerId]
  );
  res.json({ counted: true });
});

app.post('/api/content/:id/like', requireAuth, async (req, res) => {
  await db.query(
    `INSERT INTO content_likes (content_id, creator_id) VALUES ($1, $2)
     ON CONFLICT (content_id, creator_id) DO NOTHING`,
    [req.params.id, req.creatorId]
  );
  res.status(201).json({ liked: true });
});

app.delete('/api/content/:id/like', requireAuth, async (req, res) => {
  await db.query('DELETE FROM content_likes WHERE content_id = $1 AND creator_id = $2', [req.params.id, req.creatorId]);
  res.json({ liked: false });
});

app.get('/api/content/:id/comments', async (req, res) => {
  const comments = await db.all(
    `SELECT cc.id, cc.text, cc.created_at, cr.name AS creator_name
     FROM content_comments cc JOIN creators cr ON cr.id = cc.creator_id
     WHERE cc.content_id = $1 ORDER BY cc.created_at ASC`,
    [req.params.id]
  );
  res.json({ comments });
});

app.post('/api/content/:id/comments', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Commentaire vide.' });
  const target = await db.query('SELECT creator_id FROM content_items WHERE id = $1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'Contenu introuvable.' });
  if (await isBlockedBetween(req.creatorId, target.creator_id)) return res.status(403).json({ error: 'Tu ne peux pas commenter ce contenu.' });
  const comment = await db.query(
    'INSERT INTO content_comments (content_id, creator_id, text) VALUES ($1, $2, $3) RETURNING id',
    [req.params.id, req.creatorId, text]
  );
  res.status(201).json({ commentId: comment.id });
});

app.post('/api/creators/:id/follow', requireAuth, async (req, res) => {
  if (req.params.id === req.creatorId) {
    return res.status(400).json({ error: 'Tu ne peux pas t\'abonner à ton propre compte.' });
  }
  if (await isBlockedBetween(req.creatorId, req.params.id)) {
    return res.status(403).json({ error: 'Tu ne peux pas t\'abonner à ce compte.' });
  }
  await db.query(
    `INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)
     ON CONFLICT (follower_id, followed_id) DO NOTHING`,
    [req.creatorId, req.params.id]
  );
  res.status(201).json({ following: true });
});

app.delete('/api/creators/:id/follow', requireAuth, async (req, res) => {
  await db.query('DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2', [req.creatorId, req.params.id]);
  res.json({ following: false });
});

// Modification du profil : nom, photo, numéro de retrait, pays.
app.patch('/api/creators/me/profile', requireAuth, async (req, res) => {
  const { name, photoUrl, withdrawalPhone, countryCode, language, primaryContentType } = req.body;
  const giftCurrency = req.body.giftCurrency ? String(req.body.giftCurrency).toUpperCase() : null;
  if (giftCurrency && !isSupportedCurrency(giftCurrency)) return res.status(400).json({ error: 'Devise non prise en charge.' });
  if (countryCode && !isKnownCountry(countryCode)) return res.status(400).json({ error: 'Pays inconnu.' });
  // La zone suit toujours le pays.
  const newZone = countryCode ? zoneOf(countryCode) : null;
  if (newZone || primaryContentType) {
    await db.query(
      'UPDATE creators SET zone = COALESCE($1, zone), primary_content_type = COALESCE($2, primary_content_type) WHERE id = $3',
      [newZone, primaryContentType || null, req.creatorId]
    );
  }
  await db.query(
    `UPDATE creators SET
       name = COALESCE($1, name),
       photo_url = COALESCE($2, photo_url),
       withdrawal_phone = COALESCE($3, withdrawal_phone),
       country_code = COALESCE($4, country_code),
       language = COALESCE($5, language),
       gift_currency = COALESCE($6, gift_currency)
     WHERE id = $7`,
    [name, photoUrl, withdrawalPhone, countryCode ? String(countryCode).toUpperCase() : null, language, giftCurrency, req.creatorId]
  );
  res.json({ updated: true });
});

// Changement de numéro de téléphone : jamais direct — un code de vérification
// est d'abord envoyé au NOUVEAU numéro, pour prouver qu'on le contrôle bien.
app.post('/api/auth/change-phone/request', requireAuth, async (req, res) => {
  const newPhone = String(req.body.newPhone || '').replace(/[\s.-]/g, '');
  if (newPhone.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  const taken = await db.query('SELECT 1 FROM creators WHERE phone = $1 AND id <> $2', [newPhone, req.creatorId]);
  if (taken) return res.status(409).json({ error: 'Ce numéro est déjà utilisé par un autre compte.' });
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, 10);
  const request = await db.query(
    `INSERT INTO phone_change_requests (creator_id, new_phone, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes') RETURNING id`,
    [req.creatorId, newPhone, codeHash]
  );
  // Le code part par SMS vers le nouveau numéro si Twilio est actif, sinon par email au titulaire du compte.
  const me = await db.query('SELECT email FROM creators WHERE id = $1', [req.creatorId]);
  const text = `Eaji — code pour confirmer ton nouveau numéro : ${code} (valable 10 minutes).`;
  if (SMS_PROVIDER_CONNECTED) {
    sendSmsReal(newPhone, text).catch((e) => console.error('Échec SMS changement de numéro :', e.message));
    return res.status(201).json({ requestId: request.id, message: 'Code envoyé par SMS au nouveau numéro.' });
  }
  if (await trySendEmail(me.email, 'Eaji — confirme ton nouveau numéro', text)) {
    return res.status(201).json({ requestId: request.id, message: 'Code envoyé par email.' });
  }
  res.status(201).json({ requestId: request.id, message: "L'email n'a pas pu partir. Ton code :", devCode: code });
});

app.post('/api/auth/change-phone/confirm', requireAuth, async (req, res) => {
  const { requestId, code } = req.body;
  const request = await db.query(
    'SELECT * FROM phone_change_requests WHERE id = $1 AND creator_id = $2 AND verified = FALSE',
    [requestId, req.creatorId]
  );
  if (!request || !(await bcrypt.compare(code, request.code_hash)) || new Date() > request.expires_at) {
    return res.status(400).json({ error: 'Code invalide ou expiré.' });
  }
  await db.query('UPDATE phone_change_requests SET verified = TRUE WHERE id = $1', [request.id]);
  await db.query('UPDATE creators SET phone = $1 WHERE id = $2', [request.new_phone, req.creatorId]);
  res.json({ updated: true });
});

// ==================== ESPACE PUBLICITAIRE (VENTES EN LIGNE) ====================

const AD_TIERS = {
  basique: { price: 5, currency: 'USD', articleLimit: 5, durationDays: 14 },
  standard: { price: 20, currency: 'USD', articleLimit: 30, durationDays: 30 },
  illimite: { price: 100, currency: 'USD', articleLimit: null, durationDays: 180 },
};

app.post('/api/ads/subscribe', requireAuth, requirePayments, async (req, res) => {
  const { tier, contentIds } = req.body; // contentIds : articles à promouvoir (jusqu'à articleLimit)
  const plan = AD_TIERS[tier];
  if (!plan) return res.status(400).json({ error: `Formule inconnue : "${tier}". Formules valides : ${Object.keys(AD_TIERS).join(', ')}` });
  if (plan.articleLimit && contentIds?.length > plan.articleLimit) {
    return res.status(400).json({ error: `La formule "${tier}" autorise au maximum ${plan.articleLimit} articles.` });
  }

  const subscription = await db.query(
    `INSERT INTO ad_subscriptions (creator_id, tier, article_limit, price, currency, ends_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING id`,
    [req.creatorId, tier, plan.articleLimit, plan.price, plan.currency, plan.durationDays]
  );

  for (const contentId of contentIds || []) {
    await db.query('INSERT INTO ad_listings (ad_subscription_id, content_id) VALUES ($1, $2)', [subscription.id, contentId]);
  }

  // Revenu encaissé — crédité exclusivement à l'administrateur principal (voir /api/admin/finances).
  await db.query(
    'INSERT INTO ad_payments (ad_subscription_id, amount, currency) VALUES ($1, $2, $3)',
    [subscription.id, plan.price, plan.currency]
  );

  res.status(201).json({ subscriptionId: subscription.id, endsAt: plan.durationDays, articleLimit: plan.articleLimit });
});

app.get('/api/ads/active', async (req, res) => {
  const listings = await db.all(
    `SELECT c.id, c.title, c.content_type, cr.name AS creator_name
     FROM ad_listings al
     JOIN ad_subscriptions a ON a.id = al.ad_subscription_id
     JOIN content_items c ON c.id = al.content_id
     JOIN creators cr ON cr.id = c.creator_id
     WHERE a.status = 'actif' AND a.ends_at > now()`
  );
  res.json({ listings });
});

// ==================== FINANCES — ADMINISTRATEUR PRINCIPAL UNIQUEMENT ====================
// Verrouillé en dur sur requireAdminPrincipal (pas requireAdminPermission) :
// aucun administrateur secondaire ne doit pouvoir accéder à cette route,
// même avec une permission accordée — conformément à la demande explicite.

app.get('/api/admin/finances', requireAdminPrincipal, async (req, res) => {
  const commissions = await db.all('SELECT * FROM admin_commissions ORDER BY created_at DESC LIMIT 100');
  const adRevenue = await db.all('SELECT * FROM ad_payments ORDER BY created_at DESC LIMIT 100');
  res.json({ commissions, adRevenue });
});

// Devises proposées par pays + devises internationales (seulement celles dont on connaît le taux).
app.get('/api/currencies', (req, res) => {
  res.json(currencyCatalog());
});

// ==================== ARGENT : PREMIUM, VENTES, CADEAUX, DONS, PUBLICITÉ, PORTEFEUILLE ====================
const money = moneyRoutes.register({
  app, db, pool, requireAuth, requireAdminPrincipal, optionalViewerId, createDownloadUrl, convertFromUSD, isSupportedCurrency,
});

// Prix de vente d'un contenu (réservé aux membres premium). null = pas à vendre.
async function parseSalePrice(raw, creatorId) {
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === '' || Number(raw) === 0) return { value: null };
  const price = round2(raw);
  if (!(price >= SALE_PRICE_MIN && price <= SALE_PRICE_MAX)) {
    return { error: `Le prix doit être entre ${SALE_PRICE_MIN} $ et ${SALE_PRICE_MAX} $.` };
  }
  if (!(await monetizationOf(creatorId)).monetized) {
    return { error: "La vente de contenus n'est pas disponible dans ton pays." };
  }
  if (!(await money.premiumUntil(creatorId))) {
    return { error: 'Vendre tes contenus est réservé aux membres premium.' };
  }
  return { value: price };
}

// ==================== MES PUBLICATIONS (point 8) ====================

app.get('/api/my/content', requireAuth, async (req, res) => {
  const items = await db.all(
    `SELECT c.id, c.title, c.content_type, c.visibility_scope, c.created_at, c.view_count, c.duration_seconds, c.sale_price,
            (SELECT COUNT(*)::int FROM content_access WHERE content_id = c.id) AS sales_count,
            (SELECT COUNT(*)::int FROM content_likes WHERE content_id = c.id) AS like_count
     FROM content_items c WHERE c.creator_id = $1 AND c.status = 'actif' ORDER BY c.created_at DESC`,
    [req.creatorId]
  );
  res.json({ items });
});

app.patch('/api/my/content/:id', requireAuth, async (req, res) => {
  const title = req.body.title !== undefined ? String(req.body.title).trim() : null;
  const scope = req.body.visibilityScope;
  if (title === '') return res.status(400).json({ error: 'Le titre ne peut pas être vide.' });
  if (scope && !['public', 'abonnes'].includes(scope)) return res.status(400).json({ error: 'Visibilité inconnue.' });
  const sale = await parseSalePrice(req.body.salePrice, req.creatorId);
  if (sale.error) return res.status(400).json({ error: sale.error });
  const updated = await db.query(
    `UPDATE content_items SET title = COALESCE($1, title), visibility_scope = COALESCE($2, visibility_scope),
            sale_price = CASE WHEN $5::boolean THEN sale_price ELSE $6::numeric END
     WHERE id = $3 AND creator_id = $4 AND status = 'actif' RETURNING id`,
    [title, scope || null, req.params.id, req.creatorId, Boolean(sale.skip), sale.skip ? null : sale.value]
  );
  if (!updated) return res.status(404).json({ error: 'Publication introuvable.' });
  res.json({ updated: true });
});

app.delete('/api/my/content/:id', requireAuth, async (req, res) => {
  const removed = await db.query(
    "UPDATE content_items SET status = 'retire' WHERE id = $1 AND creator_id = $2 AND status = 'actif' RETURNING id",
    [req.params.id, req.creatorId]
  );
  if (!removed) return res.status(404).json({ error: 'Publication introuvable.' });
  res.json({ deleted: true });
});

// ==================== ABONNÉS ET BLOCAGES (point 9) ====================

app.get('/api/creators/me/followers', requireAuth, async (req, res) => {
  const followers = await db.all(
    `SELECT cr.id, cr.name, cr.country_code FROM follows f JOIN creators cr ON cr.id = f.follower_id
     WHERE f.followed_id = $1 ORDER BY f.created_at DESC`,
    [req.creatorId]
  );
  res.json({ followers });
});

app.delete('/api/creators/me/followers/:id', requireAuth, async (req, res) => {
  await db.query('DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2', [req.params.id, req.creatorId]);
  res.json({ removed: true });
});

app.get('/api/creators/me/blocks', requireAuth, async (req, res) => {
  const blocked = await db.all(
    `SELECT cr.id, cr.name FROM blocks b JOIN creators cr ON cr.id = b.blocked_id
     WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [req.creatorId]
  );
  res.json({ blocked });
});

app.post('/api/creators/me/blocks/:id', requireAuth, async (req, res) => {
  if (req.params.id === req.creatorId) return res.status(400).json({ error: 'Tu ne peux pas te bloquer toi-même.' });
  await db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.creatorId, req.params.id]);
  // Bloquer retire aussi l'abonnement dans les deux sens.
  await db.query(
    'DELETE FROM follows WHERE (follower_id = $1 AND followed_id = $2) OR (follower_id = $2 AND followed_id = $1)',
    [req.creatorId, req.params.id]
  );
  res.status(201).json({ blocked: true });
});

app.delete('/api/creators/me/blocks/:id', requireAuth, async (req, res) => {
  await db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.creatorId, req.params.id]);
  res.json({ unblocked: true });
});

// ==================== MODE DE RETRAIT (point 9) ====================

app.get('/api/creators/me/payout-account', requireAuth, async (req, res) => {
  const account = await db.query(
    'SELECT provider, aggregator, external_account_id, status FROM payout_accounts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.creatorId]
  );
  res.json({ account: account || null });
});

app.put('/api/creators/me/payout-account', requireAuth, async (req, res) => {
  const { method, operator, accountNumber } = req.body;
  if (!['mobile_money', 'virement'].includes(method)) return res.status(400).json({ error: 'Choisis un mode de retrait.' });
  if (!accountNumber || String(accountNumber).trim().length < 6) return res.status(400).json({ error: 'Numéro ou compte de retrait invalide.' });
  const provider = method === 'mobile_money' ? 'mobile_money' : 'manual_review';
  await db.query('DELETE FROM payout_accounts WHERE creator_id = $1', [req.creatorId]);
  await db.query(
    'INSERT INTO payout_accounts (creator_id, provider, aggregator, external_account_id) VALUES ($1, $2, $3, $4)',
    [req.creatorId, provider, method === 'mobile_money' ? (operator || null) : 'virement_bancaire', String(accountNumber).trim()]
  );
  if (method === 'mobile_money') {
    await db.query('UPDATE creators SET withdrawal_phone = $1 WHERE id = $2', [String(accountNumber).trim(), req.creatorId]);
  }
  res.json({ saved: true });
});

// ==================== APPELS AUDIO / VIDÉO ====================
// Les deux téléphones se parlent directement (WebRTC). Le serveur ne fait que la mise en
// relation : il transmet « l'offre » de l'appelant et « la réponse » de l'appelé.

// Serveurs qui aident les téléphones à se trouver sur internet. Un serveur TURN (relais)
// rend les appels fiables sur tous les réseaux mobiles : à ajouter via les variables
// TURN_URL, TURN_USERNAME, TURN_CREDENTIAL sur Railway.
app.get('/api/calls/ice-config', requireAuth, (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({ iceServers });
});

app.post('/api/calls', requireAuth, async (req, res) => {
  const { calleeId, kind, offer } = req.body;
  if (!['audio', 'video'].includes(kind) || !offer) return res.status(400).json({ error: 'Appel invalide.' });
  if (calleeId === req.creatorId) return res.status(400).json({ error: 'Tu ne peux pas t\'appeler toi-même.' });
  const callee = await db.query("SELECT id FROM creators WHERE id = $1 AND account_status = 'actif'", [calleeId]);
  if (!callee) return res.status(404).json({ error: 'Compte introuvable.' });
  if (await isBlockedBetween(req.creatorId, calleeId)) return res.status(403).json({ error: 'Tu ne peux pas appeler ce compte.' });
  // Un ancien appel resté « en sonnerie » est considéré comme manqué.
  await db.query(
    "UPDATE calls SET status = 'missed', updated_at = now() WHERE status = 'ringing' AND created_at < now() - interval '45 seconds'"
  );
  const call = await db.query(
    'INSERT INTO calls (caller_id, callee_id, kind, offer_sdp) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.creatorId, calleeId, kind, String(offer)]
  );
  res.status(201).json({ callId: call.id });
});

// L'appelé demande régulièrement s'il a un appel entrant.
app.get('/api/calls/incoming', requireAuth, async (req, res) => {
  const call = await db.query(
    `SELECT c.id, c.kind, c.offer_sdp, cr.name AS caller_name, c.caller_id
     FROM calls c JOIN creators cr ON cr.id = c.caller_id
     WHERE c.callee_id = $1 AND c.status = 'ringing' AND c.created_at > now() - interval '45 seconds'
     ORDER BY c.created_at DESC LIMIT 1`,
    [req.creatorId]
  );
  res.json({ call: call || null });
});

app.get('/api/calls/:id', requireAuth, async (req, res) => {
  const call = await db.query(
    'SELECT id, status, kind, answer_sdp, caller_id, callee_id, created_at FROM calls WHERE id = $1 AND (caller_id = $2 OR callee_id = $2)',
    [req.params.id, req.creatorId]
  );
  if (!call) return res.status(404).json({ error: 'Appel introuvable.' });
  if (call.status === 'ringing' && Date.now() - new Date(call.created_at).getTime() > 45000) {
    await db.query("UPDATE calls SET status = 'missed', updated_at = now() WHERE id = $1", [call.id]);
    call.status = 'missed';
  }
  res.json({ call });
});

app.post('/api/calls/:id/answer', requireAuth, async (req, res) => {
  const updated = await db.query(
    "UPDATE calls SET answer_sdp = $1, status = 'accepted', updated_at = now() WHERE id = $2 AND callee_id = $3 AND status = 'ringing' RETURNING id",
    [String(req.body.answer || ''), req.params.id, req.creatorId]
  );
  if (!updated) return res.status(409).json({ error: 'Cet appel n\'est plus disponible.' });
  res.json({ accepted: true });
});

app.post('/api/calls/:id/reject', requireAuth, async (req, res) => {
  await db.query(
    "UPDATE calls SET status = 'rejected', updated_at = now() WHERE id = $1 AND callee_id = $2 AND status = 'ringing'",
    [req.params.id, req.creatorId]
  );
  res.json({ rejected: true });
});

app.post('/api/calls/:id/end', requireAuth, async (req, res) => {
  await db.query(
    "UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END, updated_at = now() WHERE id = $1 AND (caller_id = $2 OR callee_id = $2) AND status IN ('ringing', 'accepted')",
    [req.params.id, req.creatorId]
  );
  res.json({ ended: true });
});

// ==================== MESSAGERIE PRIVÉE ====================

// Liste des conversations du créateur connecté : dernier message avec chaque personne.
app.get('/api/conversations', requireAuth, async (req, res) => {
  const conversations = await db.all(
    `SELECT DISTINCT ON (other_id) other_id, cr.name AS other_name, m.text AS last_text, m.created_at
     FROM (
       SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_id, text, created_at
       FROM direct_messages WHERE sender_id = $1 OR recipient_id = $1
     ) m JOIN creators cr ON cr.id = m.other_id
     ORDER BY other_id, m.created_at DESC`,
    [req.creatorId]
  );
  conversations.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ conversations });
});

app.get('/api/messages/:withCreatorId', requireAuth, async (req, res) => {
  const messages = await db.all(
    `SELECT * FROM direct_messages
     WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     ORDER BY created_at ASC`,
    [req.creatorId, req.params.withCreatorId]
  );
  for (const m of messages) {
    m.audioUrl = m.audio_key ? await createDownloadUrl(m.audio_key).catch(() => null) : null;
    delete m.audio_key;
  }
  res.json({ messages });
});

app.post('/api/messages/:withCreatorId', requireAuth, async (req, res) => {
  const { text, audioKey } = req.body;
  if (audioKey) {
    // Message vocal : la clé doit avoir été délivrée à cet expéditeur.
    if (!String(audioKey).startsWith(`${req.creatorId}/`)) return res.status(403).json({ error: 'Message vocal non autorisé.' });
    if (req.params.withCreatorId === req.creatorId) return res.status(400).json({ error: 'Tu ne peux pas t\'écrire à toi-même.' });
    if (await isBlockedBetween(req.creatorId, req.params.withCreatorId)) return res.status(403).json({ error: 'Tu ne peux pas écrire à ce compte.' });
    const voice = await db.query(
      'INSERT INTO direct_messages (sender_id, recipient_id, text, audio_key) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.creatorId, req.params.withCreatorId, '🎤 Message vocal', audioKey]
    );
    return res.status(201).json({ messageId: voice.id });
  }
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Message vide.' });
  if (req.params.withCreatorId === req.creatorId) return res.status(400).json({ error: 'Tu ne peux pas t\'écrire à toi-même.' });
  if (await isBlockedBetween(req.creatorId, req.params.withCreatorId)) return res.status(403).json({ error: 'Tu ne peux pas écrire à ce compte.' });
  const message = await db.query(
    'INSERT INTO direct_messages (sender_id, recipient_id, text) VALUES ($1, $2, $3) RETURNING id',
    [req.creatorId, req.params.withCreatorId, text]
  );
  res.status(201).json({ messageId: message.id });
});

app.post('/api/content/:id/report', requireAuth, async (req, res) => {
  const reason = (req.body.reason || '').trim() || 'Contenu inapproprié';
  await db.query(
    'INSERT INTO content_reports (content_id, reported_by, reason) VALUES ($1, $2, $3)',
    [req.params.id, req.creatorId, reason]
  );
  res.status(201).json({ reported: true });
});

// Retrait de contenu : réservé aux administrateurs, toujours journalisé.
app.delete('/api/content/:id', requireAdminPermission('moderer_contenu'), async (req, res) => {
  const reason = req.body.reason || 'Retiré par un administrateur';
  await db.query("UPDATE content_items SET status = 'retire' WHERE id = $1", [req.params.id]);
  await db.query(
    "INSERT INTO moderation_actions (content_id, admin_id, action, reason) VALUES ($1, $2, 'retrait', $3)",
    [req.params.id, req.adminId, reason]
  );
  res.json({ removed: true });
});

// ==================== ADMINISTRATION ====================

// Seul l'admin principal peut approuver un nouvel administrateur.
app.post('/api/admin/approve', requireAdminPrincipal, async (req, res) => {
  const { name, phone, password, permissions } = req.body;
  if (!name || !phone || !password || password.length < 8) {
    return res.status(400).json({ error: 'Nom, téléphone et mot de passe initial (8 caractères minimum) sont requis.' });
  }
  const taken = await db.query('SELECT 1 FROM admin_phone_numbers WHERE phone = $1', [phone]);
  if (taken) return res.status(409).json({ error: 'Ce numéro est déjà utilisé par un administrateur.' });
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await db.query(
    "INSERT INTO admins (name, phone, password_hash, role, approved_by) VALUES ($1, $2, $3, 'admin', $4) RETURNING id",
    [name, phone, passwordHash, req.adminId]
  );
  await db.query('INSERT INTO admin_phone_numbers (admin_id, phone) VALUES ($1, $2)', [admin.id, phone]);
  const allowed = ['moderer_contenu', 'gerer_comptes_utilisateurs', 'repondre_signalements'];
  for (const permission of (permissions || []).filter((p) => allowed.includes(p))) {
    await db.query(
      'INSERT INTO admin_permissions (admin_id, permission, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [admin.id, permission, req.adminId]
    );
  }
  res.status(201).json({ adminId: admin.id });
});

// Qui suis-je ? (nom et rôle de l'administrateur connecté)
app.get('/api/admin/me', async (req, res) => {
  try {
    const admin = await authenticateAdminToken(req);
    res.json({ id: admin.id, name: admin.name, role: admin.role });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// Liste des administrateurs et de leurs permissions (principal uniquement).
app.get('/api/admin/admins', requireAdminPrincipal, async (req, res) => {
  const admins = await db.all(
    `SELECT a.id, a.name, a.role, a.status,
            (SELECT string_agg(phone, ', ') FROM admin_phone_numbers WHERE admin_id = a.id) AS phones,
            (SELECT string_agg(permission, ', ') FROM admin_permissions WHERE admin_id = a.id) AS permissions
     FROM admins a ORDER BY a.role DESC, a.created_at`
  );
  res.json({ admins });
});

// Chiffres réels du tableau de bord administrateur.
app.get('/api/admin/stats', requireAdminPermission('gerer_comptes_utilisateurs'), async (req, res) => {
  const counts = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM creators) AS creators,
       (SELECT COUNT(*)::int FROM creators WHERE account_status = 'suspendu') AS suspended,
       (SELECT COUNT(*)::int FROM content_items WHERE status = 'actif') AS contents,
       (SELECT COUNT(*)::int FROM content_reports r JOIN content_items c ON c.id = r.content_id
          WHERE c.status = 'actif') AS open_reports,
       (SELECT COUNT(*)::int FROM creators c WHERE
          GREATEST(COALESCE((SELECT subscriber_count FROM subscriber_counts WHERE creator_id = c.id
                             ORDER BY verified_at DESC LIMIT 1), 0),
                   (SELECT COUNT(*) FROM follows WHERE followed_id = c.id)) >= 1000
          AND (SELECT COALESCE(SUM(view_count), 0) FROM content_items WHERE creator_id = c.id) >= 1000
          AND c.country_code = ANY($1::text[])) AS eligible`,
    [`{${[...MONETIZED_COUNTRIES].join(',')}}`]
  );
  const latest = await db.all(
    'SELECT name, country_code, created_at FROM creators ORDER BY created_at DESC LIMIT 5'
  );
  res.json({ ...counts, latest });
});

// Contenus signalés par les utilisateurs.
app.get('/api/admin/reports', requireAdminPermission('moderer_contenu'), async (req, res) => {
  const reports = await db.all(
    `SELECT r.id, r.reason, r.created_at, c.id AS content_id, c.title, c.content_type, c.status,
            cr.name AS creator_name, rp.name AS reported_by_name
     FROM content_reports r
     JOIN content_items c ON c.id = r.content_id
     JOIN creators cr ON cr.id = c.creator_id
     LEFT JOIN creators rp ON rp.id = r.reported_by
     ORDER BY r.created_at DESC LIMIT 200`
  );
  res.json({ reports });
});

// Changement de mot de passe d'un administrateur (vérifie l'ancien).
app.post('/api/admin/auth/change-password', async (req, res) => {
  let admin;
  try { admin = await authenticateAdminToken(req); }
  catch (e) { return res.status(401).json({ error: e.message }); }
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
  }
  if (!(await bcrypt.compare(currentPassword || '', admin.password_hash || ''))) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
  }
  await db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(newPassword, 12), admin.id]);
  res.json({ updated: true });
});

// Seul l'administrateur principal choisit les permissions d'un administrateur secondaire.
app.post('/api/admin/:id/permissions', requireAdminPrincipal, async (req, res) => {
  const { permission } = req.body;
  await db.query(
    `INSERT INTO admin_permissions (admin_id, permission, granted_by) VALUES ($1, $2, $3)
     ON CONFLICT (admin_id, permission) DO NOTHING`,
    [req.params.id, permission, req.adminId]
  );
  res.status(201).json({ granted: permission });
});

app.delete('/api/admin/:id/permissions/:permission', requireAdminPrincipal, async (req, res) => {
  await db.query('DELETE FROM admin_permissions WHERE admin_id = $1 AND permission = $2', [req.params.id, req.params.permission]);
  res.json({ revoked: req.params.permission });
});

// Modifier ou suspendre le compte d'un utilisateur — pour agir contre un
// utilisateur dangereux à tout moment. Réservé aux admins avec la permission dédiée.
// Liste réelle des comptes créateurs (pour le panneau administrateur).
app.get('/api/admin/creators', requireAdminPermission('gerer_comptes_utilisateurs'), async (req, res) => {
  const creators = await db.all(
    `SELECT c.id, c.name, c.email, c.phone, c.country_code, c.zone, c.account_status, c.created_at,
            GREATEST(
              COALESCE((SELECT subscriber_count FROM subscriber_counts WHERE creator_id = c.id
                        ORDER BY verified_at DESC LIMIT 1), 0),
              (SELECT COUNT(*)::int FROM follows WHERE followed_id = c.id)
            ) AS subscribers
     FROM creators c ORDER BY c.created_at DESC LIMIT 500`
  );
  creators.forEach((c) => { c.monetized = isMonetizedCreator(c.country_code, c.phone); });
  res.json({ creators });
});

// Suppression DÉFINITIVE d'un compte et de toutes ses données — administrateur principal uniquement
// (jamais accordable à un administrateur secondaire).
app.delete('/api/admin/creators/:id', requireAdminPrincipal, async (req, res) => {
  const deleted = await deleteCreatorAccount(pool, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Compte introuvable.' });
  console.log(`[Eaji] Compte ${req.params.id} supprimé par l'administrateur ${req.adminId}`);
  res.json({ deleted: true });
});

app.patch('/api/admin/creators/:id', requireAdminPermission('gerer_comptes_utilisateurs'), async (req, res) => {
  const { accountStatus, name, profileVisibility } = req.body;
  await db.query(
    `UPDATE creators SET
       account_status = COALESCE($1, account_status),
       name = COALESCE($2, name),
       profile_visibility = COALESCE($3, profile_visibility)
     WHERE id = $4`,
    [accountStatus, name, profileVisibility, req.params.id]
  );
  res.json({ updated: true });
});

// ==================== CONNEXION ADMINISTRATEUR (DÉDIÉE) ====================
// Les administrateurs ne sont PAS des créateurs — ce système est séparé de
// /api/auth/login, qui ne concerne que les créateurs.

// À exécuter UNE SEULE FOIS, au tout premier déploiement : crée l'administrateur
// principal. Refuse de s'exécuter si un admin principal existe déjà, pour
// qu'on ne puisse pas s'en servir pour prendre le contrôle plus tard.
app.post('/api/admin/auth/bootstrap-principal', async (req, res) => {
  const existing = await db.query("SELECT 1 FROM admins WHERE role = 'admin_principal'");
  if (existing) {
    return res.status(403).json({ error: 'Un administrateur principal existe déjà — cette route est à usage unique.' });
  }
  const { name, password, phones } = req.body; // phones : tableau, ex: ['+243823239572', '+243850171480']
  if (!name || !password || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'name, password et phones (tableau) sont requis.' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await db.query(
    "INSERT INTO admins (name, phone, password_hash, role) VALUES ($1, $2, $3, 'admin_principal') RETURNING id",
    [name, phones[0], passwordHash]
  );
  for (const phone of phones) {
    await db.query('INSERT INTO admin_phone_numbers (admin_id, phone) VALUES ($1, $2)', [admin.id, phone]);
  }
  res.status(201).json({ adminId: admin.id });
});

app.post('/api/admin/auth/login', async (req, res) => {
  const { phone, password, ipAddress, deviceFingerprint } = req.body;

  if (await isBlocklisted(ipAddress, deviceFingerprint)) {
    return res.status(403).json({ error: 'Accès bloqué.' });
  }

  const phoneRow = await db.query('SELECT admin_id FROM admin_phone_numbers WHERE phone = $1', [phone]);
  const admin = phoneRow ? await db.query('SELECT * FROM admins WHERE id = $1', [phoneRow.admin_id]) : null;
  const passwordOk = admin && (await bcrypt.compare(password, admin.password_hash));

  await db.query(
    'INSERT INTO admin_login_attempts (phone_attempted, ip_address, device_fingerprint, success) VALUES ($1, $2, $3, $4)',
    [phone, ipAddress, deviceFingerprint, !!passwordOk]
  );

  if (!passwordOk) {
    const recentFailures = await db.query(
      "SELECT COUNT(*) FROM admin_login_attempts WHERE ip_address = $1 AND success = FALSE AND created_at > now() - interval '15 minutes'",
      [ipAddress]
    );
    if (recentFailures?.count >= 3) {
      const alertCode = crypto.randomInt(100000, 999999).toString();
      const alertHash = await bcrypt.hash(alertCode, 10);
      const alert = await db.query(
        'INSERT INTO admin_security_alerts (ip_address, device_fingerprint, confirmation_code_hash) VALUES ($1, $2, $3) RETURNING id',
        [ipAddress, deviceFingerprint, alertHash]
      );
      if (SMS_PROVIDER_CONNECTED) {
        const allAdminPhones = await db.all('SELECT phone FROM admin_phone_numbers');
        for (const row of allAdminPhones) {
          try {
            await sendSmsReal(row.phone, `Eaji — tentative de connexion suspecte sur le compte admin (ref. ${alert.id.slice(0, 8)}). Code pour bloquer la source : ${alertCode}`);
          } catch (e) {
            console.error('Échec envoi SMS alerte sécurité :', e.message);
          }
        }
      } else {
        console.warn(`⚠️ Mode test — code de blocage de sécurité (alerte ${alert.id}) : ${alertCode}`);
      }
    }
    return res.status(401).json({ error: 'Identifiants refusés.' });
  }

  const code = await sendAdminVerificationCode(admin.id, phone);
  res.json({
    adminId: admin.id,
    message: 'Code de vérification envoyé.',
    ...(code ? { devCode: code, devWarning: 'Mode test — aucun SMS réel envoyé. À retirer avant le vrai lancement.' } : {}),
  });
});

app.post('/api/admin/auth/login/verify-2fa', async (req, res) => {
  const { adminId, code } = req.body;
  const record = await db.query(
    'SELECT * FROM admin_verifications WHERE admin_id = $1 AND verified = FALSE ORDER BY created_at DESC LIMIT 1',
    [adminId]
  );
  if (!record || !(await bcrypt.compare(code, record.code_hash)) || new Date() > record.expires_at) {
    return res.status(401).json({ error: 'Code invalide ou expiré.' });
  }
  await db.query('UPDATE admin_verifications SET verified = TRUE WHERE id = $1', [record.id]);
  const token = signSessionToken(adminId);
  res.json({ token, adminId });
});

async function sendAdminVerificationCode(adminId, phone) {
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, 10);
  await db.query(
    `INSERT INTO admin_verifications (admin_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`,
    [adminId, codeHash]
  );

  if (SMS_PROVIDER_CONNECTED && phone) {
    try {
      await sendSmsReal(phone, `Eaji Admin — ton code de vérification : ${code} (valable 10 minutes).`);
    } catch (e) {
      console.error('Échec envoi SMS admin Twilio :', e.message);
    }
    return null;
  }
  return SMS_PROVIDER_CONNECTED ? null : code;
}

// ==================== PROTECTION RENFORCÉE DU COMPTE ADMIN ====================
// Rappel honnête : aucune mesure ne rend un compte "inviolable" à 100% — ce qui
// suit empile plusieurs couches (détection, alerte humaine, blocage) plutôt que
// de prétendre à une sécurité absolue.

async function isBlocklisted(ipAddress, deviceFingerprint) {
  const hit = await db.query(
    'SELECT 1 FROM security_blocklist WHERE ip_address = $1 OR device_fingerprint = $2',
    [ipAddress, deviceFingerprint]
  );
  return !!hit;
}

// Jimmy Komba confirme par le code reçu par SMS pour bloquer définitivement
// la source d'une tentative suspecte.
app.post('/api/admin/security/confirm-block', async (req, res) => {
  const { alertId, code } = req.body;
  const alert = await db.query(
    'SELECT * FROM admin_security_alerts WHERE id = $1 AND confirmed_block = FALSE',
    [alertId]
  );
  if (!alert || !(await bcrypt.compare(code, alert.confirmation_code_hash))) {
    return res.status(400).json({ error: 'Code invalide.' });
  }
  await db.query('UPDATE admin_security_alerts SET confirmed_block = TRUE WHERE id = $1', [alert.id]);
  await db.query(
    "INSERT INTO security_blocklist (ip_address, device_fingerprint, reason) VALUES ($1, $2, 'tentative suspecte sur le compte administrateur')",
    [alert.ip_address, alert.device_fingerprint]
  );
  res.json({ blocked: true });
});

// Gestionnaire d'erreurs final (doit rester après toutes les routes).
app.use((err, req, res, next) => {
  console.error('[Eaji] Erreur sur', req.method, req.path, '→', err.message);
  if (res.headersSent) return next(err);
  if (err && err.code === '22P02') {
    return res.status(400).json({ error: 'Identifiant invalide.' });
  }
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'Cet email ou ce numéro de téléphone est déjà utilisé.' });
  }
  res.status(500).json({ error: 'Erreur du serveur. Réessaie dans un instant.' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[Eaji] Erreur non gérée :', reason);
});

module.exports = app;
