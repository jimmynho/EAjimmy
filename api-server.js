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
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { calculateEligibility, calculateMonthlyPayout } = require('./rate-engine');
const { resolvePaymentProvider, PROVIDER } = require('./payment-provider-router');
const { calculateOpeningCommission, calculateWithdrawalCommission, buildCommissionRecord } = require('./admin-commission-engine');

const app = express();
app.use(express.json());

// db : à remplacer par un vrai client (ex: require('./db') basé sur `pg`)
const db = {
  query: async (_sql, _params) => { throw new Error('Connecter un vrai client PostgreSQL ici.'); },
};

// ==================== MIDDLEWARES ====================

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });
  try {
    req.creatorId = await verifySessionToken(token); // à implémenter (JWT ou session store)
    next();
  } catch {
    res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
}

async function requireAdminPrincipal(req, res, next) {
  const adminId = req.headers['x-admin-id'];
  const admin = await db.query('SELECT * FROM admins WHERE id = $1', [adminId]);
  if (!admin || admin.role !== 'admin_principal') {
    return res.status(403).json({ error: "Seul l'administrateur principal peut effectuer cette action." });
  }
  req.adminId = adminId;
  next();
}

async function verifySessionToken(_token) {
  throw new Error('À implémenter avec un vrai système de session/JWT.');
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

  await sendVerificationCode(creator.id, 'sms', phone);
  await sendVerificationCode(creator.id, 'gmail', email);

  // Commission d'ouverture de compte pour l'admin qui a traité l'inscription
  // (currency à déterminer selon le choix de l'utilisateur à l'inscription).
  // const commission = calculateOpeningCommission(req.body.currency);
  // await db.query('INSERT INTO admin_commissions ...', buildCommissionRecord({...}));

  res.status(201).json({ creatorId: creator.id, message: 'Codes de vérification envoyés (SMS + Gmail).' });
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

  await sendVerificationCode(creator.id, 'sms', creator.phone);
  res.json({ creatorId: creator.id, message: 'Code de vérification envoyé par SMS.' });
});

// Connexion étape 2 : validation de l'OTP → émission de la session.
app.post('/api/auth/login/verify-2fa', async (req, res) => {
  const { creatorId, code } = req.body;
  const record = await db.query(
    "SELECT * FROM account_verifications WHERE creator_id = $1 AND channel = 'sms' AND verified = FALSE ORDER BY created_at DESC LIMIT 1",
    [creatorId]
  );
  if (!record || !(await bcrypt.compare(code, record.code_hash))) {
    return res.status(401).json({ error: 'Code invalide.' });
  }
  const token = crypto.randomBytes(32).toString('hex'); // à remplacer par un vrai JWT signé
  res.json({ token });
});

async function sendVerificationCode(creatorId, channel, _destination) {
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, 10);
  await db.query(
    `INSERT INTO account_verifications (creator_id, channel, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [creatorId, channel, codeHash]
  );
  // Brancher ici l'envoi réel : SMS (ex: Twilio/Africa's Talking) ou email (Gmail API/SMTP).
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

app.post('/api/content', requireAuth, async (req, res) => {
  const { contentType, title, storageUrl, visibilityScope } = req.body;
  const content = await db.query(
    `INSERT INTO content_items (creator_id, content_type, title, storage_url, visibility_scope)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.creatorId, contentType, title, storageUrl, visibilityScope || 'public']
  );
  res.status(201).json({ contentId: content.id });
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

module.exports = app;
