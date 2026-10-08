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
const { resolvePaymentProvider, PROVIDER } = require('./payment-provider-router');
const { calculateOpeningCommission, calculateWithdrawalCommission, buildCommissionRecord } = require('./admin-commission-engine');
const { validateFileSize, isLiveEligible, LIVE_SUBSCRIBER_THRESHOLD } = require('./content-limits');
const { STORAGE_CONNECTED, buildStorageKey, createUploadUrl, createDownloadUrl } = require('./storage');

const app = express();
app.use(cors()); // Autorise les appels depuis Netlify (à restreindre à ton domaine précis plus tard si besoin).
app.use(express.json());

const { Pool } = require('pg');

// db : connexion réelle à PostgreSQL via la variable d'environnement DATABASE_URL
// (fournie automatiquement par Railway une fois la base de données ajoutée au projet).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

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
  const { name, email, phone, password, countryCode, zone, primaryContentType } = req.body;

  const passwordHash = await bcrypt.hash(password, 12);

  const creator = await db.query(
    `INSERT INTO creators (name, email, phone, password_hash, country_code, zone, primary_content_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, country_code`,
    [name, email, phone, passwordHash, countryCode, zone, primaryContentType]
  );

  const smsCode = await sendVerificationCode(creator.id, 'sms', phone);
  await sendVerificationCode(creator.id, 'gmail', email);

  // Commission d'ouverture de compte pour l'admin qui a traité l'inscription
  // (currency à déterminer selon le choix de l'utilisateur à l'inscription).
  // const commission = calculateOpeningCommission(req.body.currency);
  // await db.query('INSERT INTO admin_commissions ...', buildCommissionRecord({...}));

  res.status(201).json({
    creatorId: creator.id,
    message: 'Codes de vérification envoyés (SMS + Gmail).',
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
  const creator = await db.query('SELECT * FROM creators WHERE email = $1', [email]);

  const passwordOk = creator && (await bcrypt.compare(password, creator.password_hash));

  await logLoginAttempt({ creatorId: creator?.id, ipAddress, deviceFingerprint, success: !!passwordOk });

  if (!passwordOk) return res.status(401).json({ error: 'Identifiants invalides.' });

  const { code: devCode, channel } = await sendLoginOtp(creator);
  const channelLabel = { gmail: 'par email', sms: 'par SMS', demo: '(mode test)' }[channel];
  res.json({
    creatorId: creator.id,
    message: `Code de vérification envoyé ${channelLabel}.`,
    ...(devCode ? { devCode, devWarning: 'Mode test — aucun email/SMS réel envoyé. À retirer avant le vrai lancement.' } : {}),
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
const EMAIL_PROVIDER_CONNECTED = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

let mailTransporter = null;
if (EMAIL_PROVIDER_CONNECTED) {
  mailTransporter = require('nodemailer').createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
} else {
  console.warn('⚠️  Gmail non configuré — pas d\'envoi d\'email réel pour l\'instant.');
}

async function sendEmailReal(toEmail, subject, text) {
  await mailTransporter.sendMail({ from: process.env.GMAIL_USER, to: toEmail, subject, text });
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

  await db.query(
    `INSERT INTO account_verifications (creator_id, channel, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [creator.id, channel, codeHash]
  );

  if (channel === 'gmail') {
    try {
      await sendEmailReal(creator.email, 'Eaji — ton code de connexion', `Ton code de vérification : ${code} (valable 10 minutes).`);
      return { code: null, channel };
    } catch (e) {
      console.error('Échec envoi email Gmail :', e.message);
    }
  } else if (channel === 'sms') {
    try {
      await sendSmsReal(creator.phone, `Eaji — ton code de vérification : ${code} (valable 10 minutes).`);
      return { code: null, channel };
    } catch (e) {
      console.error('Échec envoi SMS Twilio :', e.message);
    }
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
app.get('/api/creators/:id', requireAuth, async (req, res) => {
  const creator = await db.query('SELECT * FROM creators WHERE id = $1', [req.params.id]);
  const isOwner = req.creatorId === req.params.id;

  const publicProfile = {
    id: creator.id,
    name: creator.name,
    zone: creator.zone,
    subscriberCount: creator.subscriber_count_public || isOwner ? creator.subscriber_count : undefined,
  };

  if (isOwner) {
    const balance = await db.query('SELECT * FROM creator_balances WHERE creator_id = $1', [creator.id]);
    publicProfile.balance = balance.balance;
    publicProfile.currency = balance.currency;
  }

  res.json(publicProfile);
});

app.patch('/api/creators/me/visibility', requireAuth, async (req, res) => {
  const { profileVisibility, subscriberCountPublic } = req.body;
  await db.query(
    'UPDATE creators SET profile_visibility = $1, subscriber_count_public = $2 WHERE id = $3',
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

app.get('/api/creators/:id/eligibility', requireAuth, async (req, res) => {
  const { subscribers, views } = await getLatestMetrics(req.params.id);
  res.json(calculateEligibility(subscribers, views));
});

app.get('/api/creators/:id/payout-preview', requireAuth, async (req, res) => {
  const { subscribers, views } = await getLatestMetrics(req.params.id);
  const currency = req.query.currency || 'USD';
  res.json(calculateMonthlyPayout({ subscribers, views, currency }));
});

app.post('/api/payouts/withdraw', requireAuth, async (req, res) => {
  const { amount, currency } = req.body;
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
  return { subscribers: row?.subscriber_count || 0, views: views?.total || 0 };
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

app.post('/api/content', requireAuth, async (req, res) => {
  const { contentType, title, storageUrl, visibilityScope, fileSizeBytes } = req.body;

  const sizeCheck = validateFileSize(contentType, fileSizeBytes);
  if (!sizeCheck.valid) return res.status(400).json({ error: sizeCheck.error });

  const content = await db.query(
    `INSERT INTO content_items (creator_id, content_type, title, storage_url, file_size_bytes, visibility_scope)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.creatorId, contentType, title, storageUrl, fileSizeBytes || null, visibilityScope || 'public']
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
app.post('/api/gifts', requireAuth, async (req, res) => {
  const { toCreatorId, contentId, liveSessionId, amount } = req.body;
  if (!contentId && !liveSessionId) {
    return res.status(400).json({ error: 'Un cadeau doit être associé à un contenu ou à un live.' });
  }
  const recipient = await db.query('SELECT gift_currency FROM creators WHERE id = $1', [toCreatorId]);
  const gift = await db.query(
    `INSERT INTO gifts (from_creator_id, to_creator_id, content_id, live_session_id, amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.creatorId, toCreatorId, contentId || null, liveSessionId || null, amount, recipient.gift_currency]
  );
  res.status(201).json({ giftId: gift.id, currency: recipient.gift_currency });
});

// Fil de contenus publics (découverte) : les plus récents en premier,
// avec le nom du créateur et les compteurs likes/commentaires.
app.get('/api/feed', async (req, res) => {
  const items = await db.all(
    `SELECT c.id, c.title, c.content_type, c.created_at,
            c.storage_url,
            cr.id AS creator_id, cr.name AS creator_name,
            (SELECT COUNT(*) FROM content_likes WHERE content_id = c.id) AS like_count,
            (SELECT COUNT(*) FROM content_comments WHERE content_id = c.id) AS comment_count
     FROM content_items c
     JOIN creators cr ON cr.id = c.creator_id
     WHERE c.visibility_scope = 'public' AND c.status = 'actif'
     ORDER BY c.created_at DESC
     LIMIT 30`
  );
  for (const item of items) {
    item.fileUrl = await createDownloadUrl(item.storage_url).catch(() => null);
    delete item.storage_url;
  }
  res.json({ items });
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
  const comment = await db.query(
    'INSERT INTO content_comments (content_id, creator_id, text) VALUES ($1, $2, $3) RETURNING id',
    [req.params.id, req.creatorId, text]
  );
  res.status(201).json({ commentId: comment.id });
});

app.post('/api/creators/:id/follow', requireAuth, async (req, res) => {
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
  const { name, photoUrl, withdrawalPhone, countryCode, language, giftCurrency } = req.body;
  await db.query(
    `UPDATE creators SET
       name = COALESCE($1, name),
       photo_url = COALESCE($2, photo_url),
       withdrawal_phone = COALESCE($3, withdrawal_phone),
       country_code = COALESCE($4, country_code),
       language = COALESCE($5, language),
       gift_currency = COALESCE($6, gift_currency)
     WHERE id = $7`,
    [name, photoUrl, withdrawalPhone, countryCode, language, giftCurrency, req.creatorId]
  );
  res.json({ updated: true });
});

// Changement de numéro de téléphone : jamais direct — un code de vérification
// est d'abord envoyé au NOUVEAU numéro, pour prouver qu'on le contrôle bien.
app.post('/api/auth/change-phone/request', requireAuth, async (req, res) => {
  const { newPhone } = req.body;
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, 10);
  const request = await db.query(
    `INSERT INTO phone_change_requests (creator_id, new_phone, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes') RETURNING id`,
    [req.creatorId, newPhone, codeHash]
  );
  // Brancher ici l'envoi réel du SMS vers newPhone.
  res.status(201).json({ requestId: request.id, message: 'Code envoyé au nouveau numéro.' });
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

app.post('/api/ads/subscribe', requireAuth, async (req, res) => {
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

// ==================== MESSAGERIE PRIVÉE ====================

app.get('/api/messages/:withCreatorId', requireAuth, async (req, res) => {
  const messages = await db.all(
    `SELECT * FROM direct_messages
     WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     ORDER BY created_at ASC`,
    [req.creatorId, req.params.withCreatorId]
  );
  res.json({ messages });
});

app.post('/api/messages/:withCreatorId', requireAuth, async (req, res) => {
  const { text } = req.body;
  const message = await db.query(
    'INSERT INTO direct_messages (sender_id, recipient_id, text) VALUES ($1, $2, $3) RETURNING id',
    [req.creatorId, req.params.withCreatorId, text]
  );
  res.status(201).json({ messageId: message.id });
});

app.post('/api/content/:id/report', requireAuth, async (req, res) => {
  const { reason } = req.body;
  await db.query(
    'INSERT INTO content_reports (content_id, reported_by, reason) VALUES ($1, $2, $3)',
    [req.params.id, req.creatorId, reason]
  );
  res.status(201).json({ reported: true });
});

// Retrait de contenu : réservé aux administrateurs, toujours journalisé.
app.delete('/api/content/:id', requireAdminPrincipal, async (req, res) => {
  const { reason } = req.body;
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
  const { name, phone } = req.body;
  const admin = await db.query(
    "INSERT INTO admins (name, role, approved_by) VALUES ($1, 'admin', $2) RETURNING id",
    [name, req.adminId]
  );
  await db.query('INSERT INTO admin_phone_numbers (admin_id, phone) VALUES ($1, $2)', [admin.id, phone]);
  res.status(201).json({ adminId: admin.id });
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

module.exports = app;
