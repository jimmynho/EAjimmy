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
const { isSupportedCurrency, isKnownCurrency, convertFromUSD, payoutInCurrency, openingCommissionInCurrency, currencyCatalog } = require('./currencies');
const { resolvePaymentProvider, PROVIDER } = require('./payment-provider-router');
const { calculateOpeningCommission, calculateWithdrawalCommission, buildCommissionRecord } = require('./admin-commission-engine');
const { validateFileSize, isLiveEligible, LIVE_SUBSCRIBER_THRESHOLD } = require('./content-limits');
const { STORAGE_CONNECTED, buildStorageKey, createUploadUrl, createDownloadUrl, uploadThroughServer, tryEnableBrowserUploads, deleteCreatorFiles } = require('./storage');
const { deleteCreatorAccount } = require('./account-deletion');
const moneyRoutes = require('./monetization-routes');
const liveRoutes = require('./live-routes');
const supportRoutes = require('./support-routes');
const securityRoutes = require('./security-routes');
const extrasRoutes = require('./extras-routes');
const chatRoutes = require('./chat-routes');
const kycRoutes = require('./kyc-routes');
const pushRoutes = require('./push-routes');
const watchRoutes = require('./watch-routes');
const statusRoutes = require('./status-routes');
const engageRoutes = require('./engage-routes');
const cyclesRoutes = require('./cycles-routes');
const advertiseRoutes = require('./advertise-routes');
const musicRoutes = require('./music-routes');
// Date de naissance, nouveau mot de passe automatique, « Mes connexions » (access-routes.js).
const accessRoutes = require('./access-routes');
// Pages publiques pour Google et les aperçus de liens : /p/:id, /u/:id, /decouvrir, /sitemap.xml (public-pages-routes.js).
const publicPages = require('./public-pages-routes');
const backupRoutes = require('./backup-routes');
const { ZONES, MONETIZED_COUNTRIES, isKnownCountry, zoneOf, isMonetizedCreator, monetizationReason } = require('./world-countries');
const { SALE_PRICE_MIN, SALE_PRICE_MAX, VIDEO_TYPES, MAX_VIDEO_SECONDS, round2 } = require('./monetization');

const app = express();
// Railway place un relais devant le serveur : la vraie adresse IP du visiteur est dans X-Forwarded-For.
// Une seule passerelle devant le serveur (Railway) : l'adresse réelle est celle qu'elle ajoute en dernier.
// (Avec « true », un pirate pourrait écrire une fausse adresse lui-même et échapper au blocage.)
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors()); // Le site (GitHub Pages) et l'application appellent l'API depuis une autre adresse.
app.use(express.json({ limit: '200kb' }));
// Liens inconnus bloqués dans tout ce que publient les utilisateurs (anti-virus, anti-arnaque) :
// seuls les liens d'Eaji passent, et WhatsApp / Telegram pour les comptes Entreprise.
app.use(engageRoutes.linkGuard({ db: () => db, verifySessionToken }));
// Appareil (identifiant aléatoire du téléphone) et réseau, chiffrés : servent à repérer les fausses vues.
app.use(cyclesRoutes.deviceTracker({ db: () => db, verifySessionToken }));
// En-têtes de sécurité de base.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Limiteur simple en mémoire : bloque les tentatives répétées (mots de passe, codes, inscriptions).
const rateBuckets = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rateBuckets.set(key, hits);
  return hits.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rateBuckets) if (!v.some((t) => now - t < 60 * 60 * 1000)) rateBuckets.delete(k); }, 10 * 60 * 1000).unref();
// keyFn : par défaut l'adresse IP. Attention : en RDC, les opérateurs mobiles mettent souvent des milliers
// d'abonnés derrière la même adresse IP ; les limites par IP restent donc larges, et la vraie protection
// contre le piratage se fait par compte (blocage après 8 mauvais mots de passe, 5 essais par code).
function rateLimit(name, max, windowMs, message, keyFn) {
  return (req, res, next) => {
    if (tooMany(`${name}:${keyFn ? keyFn(req) : req.ip}`, max, windowMs)) {
      return res.status(429).json({ error: message || 'Trop de tentatives. Attends quelques minutes puis réessaie.' });
    }
    next();
  };
}

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
// Serveur principal + serveur de secours : un seul fait les tâches automatiques (leader.js).
const leader = require('./leader');
leader.start({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false });

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
  // Base de données toute neuve (nouvel hébergeur) : les tables de départ sont créées toutes seules
  // (schema.sql puis delta-mise-a-jour.sql), avant les mises à jour ci-dessous. Jamais sur une base déjà remplie.
  try {
    const has = (await pool.query("SELECT to_regclass('public.creators') AS t")).rows[0].t;
    if (!has) {
      const fs = require('fs'), path = require('path');
      for (const f of ['schema.sql', 'delta-mise-a-jour.sql']) {
        // Une instruction à la fois, en plusieurs tours : une table qui dépend d'une autre pas encore créée
        // est simplement refaite au tour suivant.
        let todo = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/--[^\n]*/g, '')
          .split(';').map((x) => x.trim()).filter(Boolean);
        for (let round = 0; todo.length && round < 6; round++) {
          const left = [];
          for (const sql of todo) { try { await pool.query(sql); } catch (e) { left.push(sql); } }
          if (left.length === todo.length) break;
          todo = left;
        }
      }
      console.log('[Eaji] Base neuve : tables de départ créées.');
    }
  } catch (e) { console.error('[Eaji] Création des tables de départ impossible :', e.message); }
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
    // Sécurité : version de session et nombre d'essais par code.
    'ALTER TABLE creators ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0',
    // Inscription possible avec le seul numéro de téléphone (l'email devient facultatif).
    'ALTER TABLE creators ALTER COLUMN email DROP NOT NULL',
    // Ville (obligatoire à l'inscription) : regroupe les comptes par pays et par ville.
    'ALTER TABLE creators ADD COLUMN IF NOT EXISTS city TEXT',
    // Première connexion réussie (code validé) : un compte jamais confirmé peut être repris par une nouvelle inscription.
    'ALTER TABLE creators ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMPTZ',
    `UPDATE creators c SET first_login_at = c.created_at WHERE c.first_login_at IS NULL
       AND EXISTS (SELECT 1 FROM account_verifications v WHERE v.creator_id = c.id AND v.verified = TRUE)`,
    // Publications « à vérifier » : la détection de nudité n'a pas pu tourner sur le téléphone.
    'ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_status_check',
    "ALTER TABLE content_items ADD CONSTRAINT content_items_status_check CHECK (status IN ('actif', 'retire', 'en_revue'))",
    'CREATE INDEX IF NOT EXISTS dm_unread_idx ON direct_messages (recipient_id) WHERE read_at IS NULL',
    'CREATE INDEX IF NOT EXISTS creators_country_city_idx ON creators (country_code, lower(city))',
    `CREATE TABLE IF NOT EXISTS admin_broadcasts (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       admin_id UUID,
       scope TEXT NOT NULL,
       country_code TEXT,
       city TEXT,
       title TEXT NOT NULL,
       text TEXT NOT NULL,
       recipients INTEGER NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    // Vues : une seule par personne, par publication et par jour (sert aussi aux « vues du mois »).
    `CREATE TABLE IF NOT EXISTS content_view_log (
       content_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
       creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
       viewer_key TEXT NOT NULL,
       day DATE NOT NULL DEFAULT CURRENT_DATE,
       PRIMARY KEY (content_id, viewer_key, day))`,
    'CREATE INDEX IF NOT EXISTS content_view_log_creator_day ON content_view_log (creator_id, day)',
    'ALTER TABLE account_verifications ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0',
    // Tous les pays du monde : zones Afrique, Caraïbes, Amérique, Asie, Europe, Océanie.
    // L'ancienne zone « Europe centrale » est regroupée dans « Europe ».
    'ALTER TABLE creators DROP CONSTRAINT IF EXISTS creators_zone_check',
    "UPDATE creators SET zone = 'europe' WHERE zone = 'europe_centrale'",
    `ALTER TABLE creators ADD CONSTRAINT creators_zone_check CHECK (zone IN
       ('afrique', 'caraibes', 'amerique', 'asie', 'europe', 'oceanie'))`,
    // Argent : paiements, premium, vidéos payantes, ventes, publicité, portefeuille (monetization-routes.js).
    ...moneyRoutes.MIGRATIONS,
    // Format d'origine des vidéos (largeur × hauteur) : le fil les montre sans les rétrécir ni les couper.
    'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS media_width INTEGER',
    'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS media_height INTEGER',
    // Éditeur : « utiliser ce son » d'une autre publication (le son d'origine est crédité).
    'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS sound_content_id UUID REFERENCES content_items(id) ON DELETE SET NULL',
    // Messagerie : en ligne, messages modifiés / supprimés, appels manqués, appel qui sonne.
    'ALTER TABLE creators ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ',
    'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ',
    'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ',
    'ALTER TABLE calls ADD COLUMN IF NOT EXISTS callee_seen BOOLEAN NOT NULL DEFAULT FALSE',
    // Arrière-plans virtuels (nature, maison, voitures, bureau…) ajoutés par l'administrateur principal.
    `CREATE TABLE IF NOT EXISTS backgrounds (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       name TEXT NOT NULL,
       category TEXT NOT NULL CHECK (category IN ('nature', 'maison', 'voiture', 'bureau', 'ville', 'autre')),
       mime_type TEXT NOT NULL,
       image BYTEA NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    // Centre de sécurité : activités suspectes, tentatives de piratage (security-routes.js).
    ...securityRoutes.MIGRATIONS,
    // « Contacter l'équipe Eaji » (support-routes.js).
    ...supportRoutes.MIGRATIONS,
    // Direct : spectateurs connectés et fil du live (live-routes.js).
    ...liveRoutes.MIGRATIONS,
    // Rémunération mensuelle, mot de passe oublié, notifications (extras-routes.js).
    ...extrasRoutes.MIGRATIONS,
    // Messagerie : fichiers, groupes, appels de groupe (chat-routes.js).
    ...chatRoutes.MIGRATIONS,
    // Vérification d'identité avant retrait (kyc-routes.js).
    ...kycRoutes.MIGRATIONS,
    // Notifications sur l'appareil, même écran verrouillé (push-routes.js).
    ...pushRoutes.MIGRATIONS,
    // Statuts de l'onglet Messages (status-routes.js).
    ...statusRoutes.MIGRATIONS,
    ...engageRoutes.MIGRATIONS,
    ...cyclesRoutes.MIGRATIONS,
    ...advertiseRoutes.MIGRATIONS,
    ...musicRoutes.MIGRATIONS,
    ...accessRoutes.MIGRATIONS,
    // Surveillance : mots sensibles, accès complet aux comptes, contenus IA (watch-routes.js).
    ...watchRoutes.MIGRATIONS,
  ];
  for (const sql of steps) {
    try { await pool.query(sql); }
    catch (e) { console.error('[Eaji] Mise à jour de la base ignorée :', e.message); }
  }
  // Appareils déconnectés à distance (« Mes connexions ») : refusés tout de suite.
  await sessions.loadRevoked();
  // Numéros enregistrés sans indicatif (0812…) ou avec un 0 après l'indicatif (+243 0812…) : remis au
  // format international (+243812…), pour que la connexion et la monétisation les reconnaissent.
  // Jamais si un autre compte a déjà ce numéro.
  try {
    const rows = (await pool.query("SELECT id, phone, country_code FROM creators WHERE phone !~ '^[+]' OR phone ~ '^[+][0-9]{1,3}0'")).rows;
    let fixed = 0;
    for (const r of rows) {
      const canon = extrasRoutes.normalizePhone(r.phone, r.country_code);
      if (!canon || canon === r.phone) continue;
      const u = await pool.query('UPDATE creators SET phone = $1 WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM creators WHERE phone = $1) RETURNING id', [canon, r.id]).catch(() => ({ rowCount: 0 }));
      fixed += u.rowCount || 0;
    }
    if (fixed) console.log(`[Eaji] ${fixed} numéro(s) remis au format international.`);
  } catch (e) { console.error('[Eaji] Numéros non vérifiés :', e.message); }
}
runStartupMigrations();
tryEnableBrowserUploads();

// (les notifications sont créées après la définition de db, voir plus bas)
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

// Notifications dans l'application (nouvel abonné, message, cadeau, paiement, live...).
// Chaque notification part aussi sur le téléphone (Web Push), même écran verrouillé.
const push = pushRoutes.create(db);
const notify = extrasRoutes.makeNotifier(db, push.sendTo);
// Alertes sur le téléphone de l'administrateur (application Eaji Admin).
const notifyAdmins = (opts) => push.sendToAdmins(opts).catch(() => 0);
const security = securityRoutes.makeSecurity({ db, notify, notifyAdmins });
// « Mes connexions » : chaque connexion (appareil) a son identifiant, qu'on peut couper à distance.
const sessions = accessRoutes.create({ db });

// Route de test simple : permet de vérifier que l'API répond, en ouvrant
// simplement ton domaine dans un navigateur.
// État du serveur : l'appli s'en sert pour savoir si ce serveur répond (et passer sur le secours sinon).
app.get('/api/health', async (req, res) => {
  const dbOk = await pool.query('SELECT 1').then(() => true, () => false);
  res.status(dbOk ? 200 : 503).set('Cache-Control', 'no-store')
    .json({ ok: dbOk, server: process.env.EAJI_SERVER_NAME || 'principal', jobs: leader.isLeader(), time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  // Vérification Google Search Console : Google cherche la balise sur cette page d'accueil.
  // Seulement pour un navigateur ou Google (qui demandent une page HTML) ; l'appli reçoit toujours le JSON.
  if (process.env.GOOGLE_SITE_VERIFICATION && /text\/html/.test(String(req.headers.accept || ''))) {
    const code = String(process.env.GOOGLE_SITE_VERIFICATION).replace(/[^\w-]/g, '');
    return res.type('html').send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Eaji</title>
<meta name="google-site-verification" content="${code}"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;background:#12141C;color:#F3F1EB;padding:24px;">
<p>Eaji API en ligne — ${new Date().toISOString()}</p><p><a style="color:#F0A63C" href="/decouvrir">Découvrir les publications d'Eaji</a></p></body></html>`);
  }
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
  let data;
  try {
    data = decodeSessionToken(token);
    if (data.typ === 'admin') throw new Error('Jeton administrateur.');
  } catch {
    return res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
  // Appareil déconnecté à distance par le propriétaire (« Mes connexions ») : l'appli s'y déconnecte.
  if (sessions.isRevoked(data.sid)) return res.status(401).json({ code: 'appareil_deconnecte', error: 'Ce compte a été déconnecté de cet appareil.' });
  // Compte supprimé, suspendu, ou mot de passe changé depuis : la session n'est plus valable.
  // (L'appareil coupé à distance est aussi vérifié dans la base : utile quand deux serveurs tournent.)
  const sid = /^[0-9a-f-]{36}$/i.test(String(data.sid || '')) ? data.sid : null;
  const c = await db.query(
    `SELECT account_status, session_version,
            ($2::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM user_sessions s WHERE s.id = $2::uuid AND s.revoked_at IS NOT NULL)) AS sid_revoked
     FROM creators WHERE id = $1`, [data.sub, sid]).catch(() => null);
  if (c && c.sid_revoked) return res.status(401).json({ code: 'appareil_deconnecte', error: 'Ce compte a été déconnecté de cet appareil.' });
  if (!c || c.account_status !== 'actif' || Number(c.session_version || 0) !== Number(data.v || 0)) {
    return res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
  req.creatorId = data.sub;
  req.sessionId = data.sid || null;
  touchSeen(data.sub);
  sessions.touch(data.sid);
  next();
}

// « En ligne » : chaque action d'un compte connecté met à jour son dernier passage (au plus toutes les 20 s).
const SEEN_CACHE = new Map();
function touchSeen(id) {
  const now = Date.now();
  if (now - (SEEN_CACHE.get(id) || 0) < 20000) return;
  SEEN_CACHE.set(id, now);
  if (SEEN_CACHE.size > 50000) SEEN_CACHE.clear();
  db.query('UPDATE creators SET last_seen_at = now() WHERE id = $1', [id]).catch(() => {});
}
const ONLINE_SECONDS = 70;
const isOnline = (t) => Boolean(t && Date.now() - new Date(t).getTime() < ONLINE_SECONDS * 1000);

// Vérifie le jeton signé envoyé par le tableau de bord admin et renvoie
// l'id admin qu'il contient — jamais fait confiance à un en-tête non signé.
async function authenticateAdminToken(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new Error('Authentification admin requise.');
  const data = decodeSessionToken(token); // lève une erreur si invalide/expiré
  if (data.typ !== 'admin') throw new Error('Authentification admin requise.');
  const adminId = data.sub;
  const admin = await db.query('SELECT * FROM admins WHERE id = $1', [adminId]);
  if (!admin || admin.status !== 'actif') throw new Error('Administrateur inconnu ou suspendu.');
  return admin;
}

// N'importe quel administrateur actif (principal ou secondaire).
async function requireAdmin(req, res, next) {
  try { const admin = await authenticateAdminToken(req); req.adminId = admin.id; next(); }
  catch (e) { res.status(401).json({ error: e.message }); }
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
// Clé secrète des sessions : celle de Railway (SESSION_SECRET) si elle existe ; sinon une clé
// aléatoire créée une seule fois et gardée dans la base. Plus jamais de clé « par défaut » devinable.
let SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.SESSION_SECRET) {
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query("INSERT INTO app_settings (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING", [SESSION_SECRET]);
      const r = await pool.query("SELECT value FROM app_settings WHERE key = 'session_secret'");
      if (r.rows[0]) SESSION_SECRET = r.rows[0].value;
    } catch (e) { console.error('[Eaji] Clé de session non enregistrée :', e.message); }
  })();
}
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function hmac(payload) { return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'); }

// typ : 'admin' pour l'administration ; v : version de session (changer de mot de passe déconnecte les autres appareils).
function signSessionToken(id, { typ = 'creator', v = 0, sid = null } = {}) {
  const body = { sub: id, typ, v, exp: Date.now() + SESSION_DURATION_MS };
  if (sid) body.sid = sid; // appareil (« Mes connexions »)
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

function decodeSessionToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) throw new Error('Jeton malformé.');
  const expected = Buffer.from(hmac(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw new Error('Signature invalide.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (Date.now() > data.exp) throw new Error('Jeton expiré.');
  return data;
}

// Jeton d'utilisateur (un jeton d'administrateur n'est pas accepté ici).
function verifySessionToken(token) {
  const data = decodeSessionToken(token);
  if (data.typ === 'admin') throw new Error('Jeton administrateur.');
  if (sessions.isRevoked(data.sid)) throw new Error('Appareil déconnecté.');
  return data.sub;
}

// ==================== AUTHENTIFICATION & 2FA ====================

// Inscription : crée le compte, déclenche l'envoi des deux codes de vérification.
app.post('/api/auth/register', rateLimit('register', 60, 60 * 60 * 1000, "Trop d'inscriptions depuis ce réseau. Réessaie plus tard."), async (req, res) => {
  if (await security.isBlocked(req.ip, req.body && req.body.deviceFingerprint)) {
    await security.log('ip_bloquee', 'alerte', { ip: req.ip, detail: 'Inscription refusée : adresse bloquée' });
    return res.status(403).json({ error: 'Accès bloqué pour raisons de sécurité. Contacte l\'équipe Eaji si c\'est une erreur.' });
  }
  const { name, phone, password, countryCode, primaryContentType, language, currency } = req.body;
  const email = String(req.body.email || '').trim().toLowerCase() || null; // facultatif
  // La zone est déduite du pays (tous les pays du monde sont acceptés).
  const zone = zoneOf(req.body.countryCode);

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Indique ton nom.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide (exemple : nom@gmail.com). Tu peux aussi laisser ce champ vide.' });
  if (!phone || String(phone).replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  if (!isKnownCountry(countryCode) || !VALID_ZONES.includes(zone)) return res.status(400).json({ error: 'Choisis ton pays.' });
  const city = cleanCity(req.body.city);
  if (!city) return res.status(400).json({ error: 'Indique ta ville.' });
  // Date de naissance (jour / mois / année) : sert à retrouver son compte (nouveau mot de passe automatique).
  const birthDate = req.body.birthDate ? accessRoutes.parseBirthDate(req.body.birthDate) : null;
  if (req.body.birthDate && !birthDate) return res.status(400).json({ error: 'Date de naissance invalide : choisis le jour, le mois et l\'année.' });

  const passwordHash = await bcrypt.hash(password, 12);
  // Toute devise connue est acceptée ; sans taux du jour, les montants s'affichent en dollars en attendant.
  const giftCurrency = isKnownCurrency(currency) || isSupportedCurrency(currency) ? String(currency).toUpperCase() : 'USD';
  // Toujours enregistré au format international (+243812345678), quelle que soit la façon de l'écrire.
  const cleanPhone = extrasRoutes.normalizePhone(phone, countryCode) || String(phone).replace(/[\s.()-]/g, '');

  // Numéro (écrit de n'importe quelle façon) ou email déjà enregistré (personne qui appuie une 2e fois sur
  // « Créer mon compte ») : jamais de blocage, on l'emmène directement vers son code de confirmation.
  const byPhone = (await extrasRoutes.findAccount(db, cleanPhone, countryCode)).creator;
  const byEmail = email ? await db.query('SELECT * FROM creators WHERE lower(email) = $1', [email]) : null;
  const existing = [byPhone, byEmail].filter(Boolean).filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
  if (existing.length) {
    const same = existing.length === 1 ? existing[0] : null;
    if (same && await bcrypt.compare(password, same.password_hash)) {
      return res.json({ creatorId: same.id, existing: true, message: 'Ce compte existe déjà : ton code de confirmation arrive.' });
    }
    // Compte jamais confirmé (le code n'a jamais été validé) : on le reprend avec les nouvelles informations.
    if (same && !same.first_login_at && same.account_status !== 'suspendu') {
      await db.query(
        `UPDATE creators SET name = $1, email = $2, phone = $3, password_hash = $4, country_code = $5, zone = $6,
           primary_content_type = $7, language = $8, gift_currency = $9, city = $10, session_version = session_version + 1,
           terms_accepted_at = CASE WHEN $11 THEN now() ELSE terms_accepted_at END
         WHERE id = $12`,
        [String(name).trim(), email, cleanPhone, passwordHash, String(countryCode).toUpperCase(), zone,
         primaryContentType || 'video_courte', language || 'fr', giftCurrency, city, req.body.acceptTerms === true, same.id]);
      if (birthDate) await db.query('UPDATE creators SET birth_date = $1 WHERE id = $2', [birthDate, same.id]);
      return res.json({ creatorId: same.id, existing: true, message: 'Ton compte a été mis à jour : ton code de confirmation arrive.' });
    }
    return res.status(409).json({
      code: 'compte_existe',
      identifier: same ? (byPhone && same.id === byPhone.id ? same.phone : email) : cleanPhone,
      error: 'Ce numéro (ou cet email) a déjà un compte confirmé. Connecte-toi avec ton mot de passe, ou appuie sur « Mot de passe oublié ».',
    });
  }

  const creator = await db.query(
    `INSERT INTO creators (name, email, phone, password_hash, country_code, zone, primary_content_type, language, gift_currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, country_code`,
    [String(name).trim(), email, cleanPhone, passwordHash, String(countryCode).toUpperCase(), zone,
     primaryContentType || 'video_courte', language || 'fr', giftCurrency]
  );
  await db.query('UPDATE creators SET city = $1 WHERE id = $2', [city, creator.id]);
  if (birthDate) await db.query('UPDATE creators SET birth_date = $1 WHERE id = $2', [birthDate, creator.id]);
  if (req.body.acceptTerms === true) {
    await db.query('UPDATE creators SET terms_accepted_at = now() WHERE id = $1', [creator.id]);
  }
  // Pas d'envoi de code ici : le site enchaîne aussitôt sur la connexion, qui envoie UN seul code.
  // (Avant, deux codes différents partaient par email, et le premier ne marchait plus.)
  const smsCode = null;

  // (Plus de « commission d'ouverture » de 2 $ : personne ne la paie à l'inscription, c'était de l'argent non réel.)

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
app.post('/api/auth/login', rateLimit('login', 300, 15 * 60 * 1000), rateLimit('loginacct', 20, 15 * 60 * 1000, null,
  (req) => String((req.body && (req.body.identifier || req.body.email || req.body.phone)) || '').replace(/[\s.()-]/g, '').toLowerCase()), async (req, res) => {
  const { deviceFingerprint } = req.body;
  const ipAddress = req.ip; // vraie adresse (jamais celle envoyée par le téléphone)
  const identifier = String(req.body.identifier || req.body.email || req.body.phone || '');
  // Adresse bloquée par l'administrateur (activité suspecte).
  if (await security.isBlocked(ipAddress, deviceFingerprint)) {
    await security.log('ip_bloquee', 'alerte', { identifier, ip: ipAddress, device: deviceFingerprint, detail: 'Connexion refusée : adresse bloquée' });
    return res.status(403).json({ error: 'Accès bloqué pour raisons de sécurité. Contacte l\'équipe Eaji si c\'est une erreur.' });
  }
  // Connexion avec l'email OU le numéro de téléphone.
  const found = await extrasRoutes.findAccount(db, req.body.identifier || req.body.email || req.body.phone, req.body.countryCode);
  if (found.ambiguous) return res.status(400).json({ error: "Plusieurs comptes ont ce numéro dans des pays différents : écris-le avec l'indicatif du pays (exemple : +243 812 345 678)." });
  const creator = found.creator;
  const via = found.via;
  // Trop d'essais ratés sur ce compte : pause de 15 minutes (protège contre le vol de mot de passe).
  if (creator) {
    const fails = await db.query(
      "SELECT COUNT(*)::int AS n FROM login_attempts WHERE creator_id = $1 AND success = FALSE AND created_at > now() - interval '15 minutes'", [creator.id]);
    if (fails && fails.n >= 8) {
      await security.accountLocked({ creatorId: creator.id, ip: ipAddress, device: deviceFingerprint });
      return res.status(429).json({ error: 'Trop de tentatives sur ce compte. Réessaie dans 15 minutes ou utilise « Mot de passe oublié ».' });
    }
  }
  const password = req.body.password;

  const passwordOk = creator && (await bcrypt.compare(password || '', creator.password_hash));

  await logLoginAttempt({ creatorId: creator?.id, ipAddress, deviceFingerprint, success: !!passwordOk });

  if (!passwordOk) {
    await security.loginFailed({ creatorId: creator?.id, identifier, ip: ipAddress, device: deviceFingerprint });
    // Message clair (au lieu de « invalide ») : on dit ce qui ne va pas et quoi faire.
    if (!creator) {
      return res.status(401).json({ code: 'compte_introuvable', error: via === 'telephone'
        ? "Aucun compte avec ce numéro. Écris-le avec l'indicatif du pays (exemple : +243 812 345 678) ou crée ton compte."
        : 'Aucun compte avec cet email. Vérifie l\'orthographe, connecte-toi avec ton numéro de téléphone, ou crée ton compte.' });
    }
    return res.status(401).json({ code: 'mot_de_passe', error: 'Mot de passe incorrect. Réessaie (attention aux majuscules) ou appuie sur « Mot de passe oublié ».' });
  }
  await security.loginSucceeded({ creatorId: creator.id, ip: ipAddress, device: deviceFingerprint });
  if (creator.account_status && creator.account_status !== 'actif') {
    return res.status(403).json({ error: 'Ce compte est suspendu. Contacte l\'administrateur.' });
  }

  const { code, channel, emailed, smsSent } = await sendLoginOtp(creator, via);
  // Un nouveau code à CHAQUE connexion. Connexion avec l'email : le code part SEULEMENT par email (jamais à l'écran).
  // Connexion avec le numéro : le code s'affiche à l'écran (ou part par SMS si Twilio est payé). Si le code
  // tarde par email, la personne peut se connecter avec son numéro. Si l'email n'a pas pu partir (service
  // d'email en panne ou pas réglé), le code s'affiche avec un message qui le dit clairement.
  const byEmail = via !== 'telephone' && Boolean(creator.email);
  const showOnScreen = LOGIN_CODE_ON_SCREEN || !(emailed || smsSent);
  const emailFailed = byEmail && !emailed;
  res.json({
    creatorId: creator.id,
    via,
    channel,
    emailed: !!emailed,
    smsSent: !!smsSent,
    firstLogin: !creator.first_login_at,
    expiresInMinutes: LOGIN_CODE_MINUTES,
    message: showOnScreen ? 'Ton code de confirmation est affiché ci-dessous.' : (emailed ? 'Code envoyé par email.' : 'Code envoyé par SMS.'),
    emailTo: byEmail ? maskEmail(creator.email) : null,
    emailFailed,
    ...(showOnScreen ? { devCode: code } : {}),
  });
});


// Connexion étape 2 : validation de l'OTP → émission de la session.
// Peu importe le canal utilisé (email ou SMS) — on prend le dernier code non vérifié.
app.post('/api/auth/login/verify-2fa', rateLimit('otp', 300, 15 * 60 * 1000), async (req, res) => {
  const { creatorId } = req.body;
  const code = String(req.body.code || '');
  if (!/^[0-9a-f-]{36}$/i.test(String(creatorId || ''))) return res.status(401).json({ error: 'Code invalide.' });
  const record = await db.query(
    "SELECT * FROM account_verifications WHERE creator_id = $1 AND verified = FALSE ORDER BY created_at DESC LIMIT 1",
    [creatorId]
  );
  // Code expiré ou 5 essais ratés : il faut en demander un nouveau (impossible de deviner le code).
  if (!record || new Date() > new Date(record.expires_at) || Number(record.attempts || 0) >= 5) {
    return res.status(401).json({ code: 'code_expire', error: 'Ce code n\'est plus valable : un nouveau code arrive.' });
  }
  const typed = code.replace(/\D/g, '');
  if (!(await bcrypt.compare(typed, record.code_hash))) {
    await db.query('UPDATE account_verifications SET attempts = attempts + 1 WHERE id = $1', [record.id]);
    await security.codeFailed({ creatorId, ip: req.ip, attempts: Number(record.attempts || 0) });
    const left = 4 - Number(record.attempts || 0);
    return res.status(401).json(left > 0
      ? { code: 'code_faux', attemptsLeft: left, error: `Ce code ne correspond pas. Vérifie les 6 chiffres (essais restants : ${left}).` }
      : { code: 'code_expire', error: 'Trop d\'essais avec ce code : un nouveau code arrive.' });
  }
  await db.query('UPDATE account_verifications SET verified = TRUE WHERE id = $1', [record.id]);
  await db.query('UPDATE creators SET first_login_at = COALESCE(first_login_at, now()) WHERE id = $1', [creatorId]);
  const c = await db.query('SELECT session_version, must_change_password FROM creators WHERE id = $1', [creatorId]);
  const sid = await sessions.createSession(creatorId, req).catch(() => null);
  const token = signSessionToken(creatorId, { v: Number(c?.session_version || 0), sid });
  // Connecté avec un mot de passe provisoire de l'administrateur : il doit en choisir un nouveau tout de suite.
  res.json({ token, mustChangePassword: Boolean(c && c.must_change_password) });
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
    const res = await fetch(process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email', {
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
async function sendLoginOtp(creator, via = 'email') {
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, 10);
  const minutes = `${LOGIN_CODE_MINUTES} minutes`;

  // Connexion avec le numéro de téléphone (ou compte sans email) : code affiché à l'écran (et par SMS si Twilio est payé).
  // Connexion avec l'email : le code part par email (jamais à l'écran).
  if (via === 'telephone' || !creator.email) {
    await db.query(
      `INSERT INTO account_verifications (creator_id, channel, code_hash, expires_at)
       VALUES ($1, 'sms', $2, now() + $3::interval)`, [creator.id, codeHash, minutes]);
    let smsSent = false;
    if (SMS_PROVIDER_CONNECTED && creator.phone) {
      smsSent = await sendSmsReal(creator.phone, `Eaji — ton code de connexion : ${code}`).then(() => true, () => false);
    }
    return { code, channel: smsSent ? 'sms' : 'ecran', smsSent };
  }

  let channel = 'demo';
  if (EMAIL_PROVIDER_CONNECTED) channel = 'gmail';
  else if (SMS_PROVIDER_CONNECTED) channel = 'sms';

  // La base n'accepte que 'sms' ou 'gmail' comme canal : en mode test (aucun envoi
  // configuré), on enregistre 'gmail' — le code reste valable de la même façon.
  await db.query(
    `INSERT INTO account_verifications (creator_id, channel, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + $4::interval)`,
    [creator.id, channel === 'sms' ? 'sms' : 'gmail', codeHash, minutes]
  );

  // Le code est toujours renvoyé à l'appelant : la route décide s'il s'affiche à l'écran
  // (toujours affiché si l'email ou le SMS n'a pas pu partir — personne ne reste bloqué).
  if (channel === 'gmail') {
    const sent = await trySendEmail(creator.email, 'Eaji — ton code de connexion', `Ton code de vérification : ${code} (valable ${LOGIN_CODE_MINUTES} minutes).`);
    return { code, channel: sent ? 'gmail' : 'ecran', emailed: !!sent };
  } else if (channel === 'sms') {
    const sent = await sendSmsReal(creator.phone, `Eaji — ton code de vérification : ${code}`).then(() => true, (e) => { console.error('Échec envoi SMS Twilio :', e.message); return false; });
    return { code, channel: sent ? 'sms' : 'ecran', smsSent: sent };
  }

  return { code, channel: 'ecran' }; // rien n'est configuré : le code s'affiche à l'écran
}

// Code de connexion : valable 30 minutes. Connexion avec l'email : envoyé par email uniquement ; connexion
// avec le numéro : affiché à l'écran (ou SMS). Un nouveau code est créé à chaque connexion.
const LOGIN_CODE_MINUTES = 30;
// LOGIN_CODE_ON_SCREEN=1 (seulement pour des essais) : affiche aussi le code des connexions par email.
const LOGIN_CODE_ON_SCREEN = ['1', 'true', 'oui', 'yes'].includes(String(process.env.LOGIN_CODE_ON_SCREEN || '').toLowerCase());
// « jimmy@gmail.com » → « ji***@gmail.com » (montré à l'écran pour dire où le code est parti).
function maskEmail(e) {
  const [u, d] = String(e).split('@');
  return d ? `${u.slice(0, Math.min(2, u.length))}***@${d}` : '';
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
    publicProfile.city = creator.city;
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
    // Payé seulement avec le Premium (sinon : cadeaux des lives uniquement).
    publicProfile.earns = publicProfile.monetized && Boolean(publicProfile.premiumUntil);
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
  // Les autres appareils sont déconnectés ; ce téléphone reçoit une nouvelle session.
  const row = await db.query(`UPDATE creators SET password_hash = $1, session_version = session_version + 1,
     temp_password_enc = NULL, must_change_password = FALSE WHERE id = $2 RETURNING session_version`, [newHash, req.creatorId]);
  await db.query("UPDATE password_help_requests SET status = 'traitee', handled_at = now() WHERE creator_id = $1 AND status = 'en_attente'", [req.creatorId]);
  await security.log('mot_de_passe_change', 'info', { creatorId: req.creatorId, ip: req.ip, detail: 'Mot de passe changé par le propriétaire (autres appareils déconnectés)' });
  if (req.sessionId) await db.query('UPDATE user_sessions SET session_version = $2 WHERE id = $1', [req.sessionId, row.session_version]).catch(() => {});
  res.json({ updated: true, token: signSessionToken(req.creatorId, { v: row.session_version, sid: req.sessionId }) });
});

// ==================== RÉMUNÉRATION & PAIEMENTS ====================

// Monétisation réservée aux créateurs des pays éligibles (voir world-countries.js).
async function monetizationOf(creatorId) {
  const c = await db.query('SELECT country_code, phone FROM creators WHERE id = $1', [creatorId]);
  if (!c) return { monetized: false, reason: 'pays' };
  return { monetized: isMonetizedCreator(c.country_code, c.phone), reason: monetizationReason(c.country_code, c.phone) };
}

// Ville : 2 à 60 caractères, espaces nettoyés.
function cleanCity(v) {
  const c = String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return c.length >= 2 ? c : null;
}

// Créateurs ayant un Premium actif parmi une liste (une seule requête pour tout le fil).
async function premiumSet(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Set();
  const rows = await db.all('SELECT DISTINCT creator_id FROM premium_subscriptions WHERE ends_at > now() AND creator_id = ANY($1::uuid[])', [`{${uniq.join(',')}}`]);
  return new Set(rows.map((r) => r.creator_id));
}

// Être payé (vidéos, ventes, cadeaux sur les publications, rémunération mensuelle) : pays éligible ET compte Premium.
// Un compte gratuit reçoit seulement les cadeaux de ses lives.
async function earningsOf(creatorId) {
  const m = await monetizationOf(creatorId);
  if (!m.monetized) return m;
  if (!(await money.premiumUntil(creatorId))) return { monetized: false, reason: 'premium' };
  return m;
}

app.get('/api/creators/:id/eligibility', requireAuth, async (req, res) => {
  const { subscribers, views } = await getLatestMetrics(req.params.id);
  const m = await earningsOf(req.params.id);
  const result = calculateEligibility(subscribers, views);
  res.json({ ...result, eligible: m.monetized && result.eligible, monetized: m.monetized, monetizationReason: m.reason });
});

// Vues reçues pendant un mois (« AAAA-MM ») sur toutes les publications d'un créateur.
async function monthlyViewsOf(creatorId, period) {
  const p = period || new Date().toISOString().slice(0, 7);
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM content_view_log v
     WHERE v.creator_id = $1 AND v.day >= ($2 || '-01')::date AND v.day < ($2 || '-01')::date + interval '1 month'
       AND NOT EXISTS (SELECT 1 FROM content_items ci WHERE ci.id = v.content_id AND ci.ai_generated)`, [creatorId, p]);
  return r ? r.n : 0;
}

app.get('/api/creators/:id/payout-preview', requireAuth, async (req, res) => {
  const { subscribers, views } = await getLatestMetrics(req.params.id);
  const currency = isSupportedCurrency(req.query.currency) ? String(req.query.currency).toUpperCase() : 'USD';
  const m = await earningsOf(req.params.id);
  // Estimation sur la période en cours (règle des 70 % de vues et paliers des grands comptes).
  const monthlyViews = (await money.premiumUntil(req.params.id))
    ? await cycles.currentPeriodViews(req.params.id).catch(() => 0)
    : await monthlyViewsOf(req.params.id);
  const payout = payoutInCurrency({ subscribers, views, monthlyViews, currency });
  const viewsInfo = { monthlyViews, requiredMonthlyViews: Math.ceil(subscribers * 0.7) };
  if (!m.monetized) {
    return res.json({ subscribers, views, ...viewsInfo, ...payout, eligible: false, amount: 0, monetized: false, monetizationReason: m.reason });
  }
  res.json({ subscribers, views, ...viewsInfo, ...payout, monetized: true });
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
    'SELECT COALESCE(SUM(view_count), 0) AS total FROM content_items WHERE creator_id = $1 AND NOT ai_generated', // vues des contenus IA : jamais comptées
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
  // Impossible de publier le fichier de quelqu'un d'autre (ex. un contenu payant) avec sa clé.
  if (!String(storageUrl || '').startsWith(`${req.creatorId}/`) || String(storageUrl).includes('..')) {
    return res.status(403).json({ error: 'Fichier non autorisé.' });
  }

  // Son repris d'une autre publication (éditeur) : seulement un son gratuit et visible de tous.
  let soundId = null;
  if (req.body.soundContentId && /^[0-9a-f-]{36}$/i.test(String(req.body.soundContentId))) {
    const snd = await db.query(
      `SELECT c.id FROM content_items c JOIN creators cr ON cr.id = c.creator_id
       WHERE c.id = $1 AND c.status = 'actif' AND c.visibility_scope = 'public' AND cr.account_status = 'actif'`, [req.body.soundContentId]);
    soundId = snd ? snd.id : null;
  }
  // Marques d'outils d'intelligence artificielle trouvées dans le fichier par le téléphone (Sora, Veo, Meta AI…).
  const aiMarkers = (Array.isArray(req.body.aiMarkers) ? req.body.aiMarkers : []).map((m) => String(m).slice(0, 60)).slice(0, 5);
  const content = await db.query(
    `INSERT INTO content_items (creator_id, content_type, title, storage_url, file_size_bytes, visibility_scope, duration_seconds, sale_price, status, sound_content_id, ai_generated, ai_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, status`,
    [req.creatorId, contentType, title, storageUrl, fileSizeBytes || null, visibilityScope || 'public', durationSeconds, sale.skip ? null : sale.value,
     // Détection de nudité impossible sur le téléphone (pas de réseau…) : la publication attend l'équipe Eaji.
     req.body.safetyCheck === 'non_verifie' ? 'en_revue' : 'actif', soundId,
     aiMarkers.length > 0, aiMarkers.length ? `Marque IA dans le fichier : ${aiMarkers.join(', ')}` : null]
  );
  // Format d'origine de la vidéo (mesuré par le téléphone avant l'envoi).
  const dims = mediaDims(req.body.mediaWidth, req.body.mediaHeight);
  if (dims) await db.query('UPDATE content_items SET media_width = $2, media_height = $3 WHERE id = $1', [content.id, dims.w, dims.h]);
  // Vidéo importée depuis un lien : la source est gardée et affichée.
  const imported = engage.importSiteOf(req.body.importedFrom);
  if (imported) await db.query('UPDATE content_items SET imported_from = $1 WHERE id = $2', [imported.url.slice(0, 500), content.id]);
  // Paroles de la chanson écrites au moment de publier (facultatif).
  if (req.body.lyrics) await music.saveOnPublish(content.id, req.body.lyrics).catch(() => {});
  // Contenu identique déjà publié (même fichier ou même lien) : repéré pour l'administration, jamais rémunéré.
  await cycles.markDuplicate(content.id, { fingerprint: req.body.fingerprint, sourceFingerprint: req.body.sourceFingerprint,
    importedFrom: imported ? imported.url.slice(0, 500) : null }).catch(() => null);
  // Deuxième vérification par le serveur, directement sur le fichier stocké (sans faire attendre).
  if (!aiMarkers.length) watch.checkAiInStorage(content.id, storageUrl).catch(() => {});
  watch.flag({ creatorId: req.creatorId, source: 'publication', refId: content.id, origin: 'texte', text: title }).catch(() => {});
  res.status(201).json({ contentId: content.id, status: content.status });
});

// Sons d'Eaji : les vidéos et musiques gratuites et publiques, réutilisables dans l'éditeur (« utiliser ce son »).
app.get('/api/sounds', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const rows = await db.all(
    `SELECT c.id, c.title, c.content_type, c.duration_seconds, c.sale_price, c.storage_url, cr.id AS creator_id, cr.name AS creator_name,
            (SELECT COUNT(*)::int FROM content_items u WHERE u.sound_content_id = c.id AND u.status = 'actif') AS uses
     FROM content_items c JOIN creators cr ON cr.id = c.creator_id
     WHERE c.status = 'actif' AND c.visibility_scope = 'public' AND cr.account_status = 'actif'
       AND c.content_type IN ('video_courte', 'video_longue', 'musique')
       AND ($1 = '' OR c.title ILIKE '%' || $1 || '%' OR cr.name ILIKE '%' || $1 || '%')
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = c.creator_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = c.creator_id))
     ORDER BY uses DESC, c.created_at DESC LIMIT 60`, [q.replace(/[%_\\]/g, ''), req.creatorId]);
  // Seulement les sons gratuits : un contenu payant ne peut pas être repris.
  const access = await money.accessMap(null, rows);
  const sounds = [];
  for (const r of rows) {
    const a = access.get(r.id);
    if (a.locked || a.forSale) continue;
    sounds.push({ id: r.id, title: r.title, creatorName: r.creator_name, kind: r.content_type, duration: r.duration_seconds, uses: r.uses,
      url: await createDownloadUrl(r.storage_url).catch(() => null) });
    if (sounds.length >= 30) break;
  }
  res.json({ sounds: sounds.filter((s) => s.url) });
});

// ==== Arrière-plans virtuels (éditeur et live) ====
// Petites images gardées dans la base : servies directement par Eaji (aucun réglage de stockage nécessaire).
const BG_CATEGORIES = ['nature', 'maison', 'voiture', 'bureau', 'ville', 'autre'];
function imageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
app.get('/api/backgrounds', async (req, res) => {
  const rows = await db.all('SELECT id, name, category FROM backgrounds ORDER BY category, created_at DESC');
  res.json({ backgrounds: rows.map((b) => ({ ...b, url: `/api/backgrounds/${b.id}/image` })), categories: BG_CATEGORIES });
});
app.get('/api/backgrounds/:id/image', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
  const b = await db.query('SELECT mime_type, image FROM backgrounds WHERE id = $1', [req.params.id]);
  if (!b) return res.status(404).end();
  // (selon la version du pilote PostgreSQL, l'image arrive en octets ou en texte « \x… »)
  if (typeof b.image === 'string') b.image = Buffer.from(b.image.replace(/^\\x/, ''), 'hex');
  res.statusCode = 200;
  res.setHeader('Content-Type', b.mime_type);
  res.setHeader('Content-Length', b.image.length);
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.end(b.image);
});
// Lit l'image envoyée telle quelle (4 Mo au maximum).
function readImageBody(req, max) {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length']) > max) return resolve('trop_gros');
    const chunks = []; let n = 0, done = false;
    req.on('data', (c) => { n += c.length; if (n > max) { if (!done) { done = true; resolve('trop_gros'); } req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}
app.post('/api/admin/backgrounds', requireAdminPrincipal, async (req, res) => {
  const body = await readImageBody(req, 4 * 1024 * 1024);
  if (body === 'trop_gros') return res.status(413).json({ error: 'Image trop lourde (4 Mo maximum).' });
  req.body = body;
  const name = String(req.query.name || '').trim().slice(0, 60);
  const category = BG_CATEGORIES.includes(req.query.category) ? req.query.category : null;
  if (!name || !category) return res.status(400).json({ error: 'Nom et catégorie obligatoires.' });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const mime = buf && imageMime(buf);
  if (!mime) return res.status(400).json({ error: 'Image JPEG, PNG ou WebP attendue.' });
  const b = await db.query('INSERT INTO backgrounds (name, category, mime_type, image) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, category, mime, buf]);
  res.status(201).json({ id: b.id });
});
app.delete('/api/admin/backgrounds/:id', requireAdminPrincipal, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Arrière-plan introuvable.' });
  const b = await db.query('DELETE FROM backgrounds WHERE id = $1 RETURNING id', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'Arrière-plan introuvable.' });
  res.json({ deleted: true });
});

// Le live se débloque à 50 abonnés (distinct du seuil de rémunération à 1000).
app.get('/api/creators/:id/live-eligibility', requireAuth, async (req, res) => {
  const { subscribers } = await getLatestMetrics(req.params.id);
  res.json({ eligible: isLiveEligible(subscribers), threshold: LIVE_SUBSCRIBER_THRESHOLD, subscribers });
});

app.post('/api/live/start', requireAuth, async (req, res) => {
  const { subscribers } = await getLatestMetrics(req.creatorId);
  if (!isLiveEligible(subscribers)) {
    return res.status(403).json({ error: `Live réservé aux créateurs ayant au moins ${LIVE_SUBSCRIBER_THRESHOLD} abonnés.` });
  }
  // Un seul live à la fois : un ancien live resté ouvert (téléphone éteint…) est fermé.
  await db.query("UPDATE live_sessions SET status = 'termine', ended_at = now() WHERE creator_id = $1 AND status = 'en_cours'", [req.creatorId]);
  const session = await db.query(
    'INSERT INTO live_sessions (creator_id) VALUES ($1) RETURNING id',
    [req.creatorId]
  );
  // Les abonnés sont prévenus que le live commence.
  const host = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
  await db.query(
    `INSERT INTO notifications (creator_id, kind, text, link)
     SELECT follower_id, 'live', $2, $3 FROM follows WHERE followed_id = $1`,
    [req.creatorId, `🔴 ${host.name} est en direct maintenant !`, `live:${session.id}`]
  ).catch(() => {});
  res.status(201).json({ liveSessionId: session.id });
});

// Seul le créateur peut terminer SON live.
app.post('/api/live/:id/end', requireAuth, async (req, res) => {
  const live = await db.query(
    "UPDATE live_sessions SET status = 'termine', ended_at = now() WHERE id = $1 AND creator_id = $2 AND status = 'en_cours' RETURNING id",
    [req.params.id, req.creatorId]
  );
  if (!live) return res.status(404).json({ error: 'Live introuvable ou déjà terminé.' });
  await db.query('UPDATE live_viewers SET left_at = now() WHERE live_id = $1 AND left_at IS NULL', [live.id]);
  await db.query("INSERT INTO live_events (live_id, author_id, kind, text) VALUES ($1, $2, 'fin', 'Le live est terminé.')", [live.id, req.creatorId]);
  res.json({ ended: true });
});

// Ancien cadeau enregistré sans paiement : remplacé par le paiement en ligne (purpose « cadeau » / « cadeau_live »).
app.post('/api/gifts', requireAuth, (req, res) => {
  res.status(402).json({ code: 'paiement_requis', error: 'Un cadeau se paie en ligne (mobile money, carte ou PayPal) : utilise le bouton 🎁 Cadeau.' });
});

// Lecteur de musique avec effets (basses, écho, 8D…) : le navigateur n'applique les effets que si le fichier
// l'autorise. Le stockage B2 ne l'autorise pas toujours : la musique passe alors par ce relais, qui l'autorise.
// Seuls les fichiers du stockage d'Eaji (adresse signée, donc déjà autorisée) sont acceptés.
let MEDIA_PREFIX = null;
async function storagePrefix() {
  if (MEDIA_PREFIX === null) {
    const probe = await createDownloadUrl('__eaji_probe__').catch(() => null);
    if (!probe) return '';
    const u = new URL(probe), i = u.pathname.indexOf('__eaji_probe__');
    MEDIA_PREFIX = u.origin + (i >= 0 ? u.pathname.slice(0, i) : '/');
  }
  return MEDIA_PREFIX;
}
app.get('/api/media/proxy', rateLimit('mediaproxy', 1200, 60 * 60 * 1000), async (req, res) => {
  let u;
  try { u = new URL(String(req.query.u || '')); } catch (e) { return res.status(400).json({ error: 'Adresse invalide.' }); }
  const prefix = await storagePrefix();
  if (!prefix || !(u.origin + u.pathname).startsWith(prefix) || u.pathname.includes('..')) return res.status(403).json({ error: 'Fichier non autorisé.' });
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  let up;
  try { up = await fetch(u.href, { headers: req.headers.range ? { Range: req.headers.range } : {}, signal: ac.signal }); }
  catch (e) { return res.status(502).json({ error: 'Fichier indisponible pour le moment.' }); }
  const type = up.headers.get('content-type') || '';
  if (!up.ok || !/^(audio|video)\/|^application\/octet-stream/.test(type)) {
    ac.abort();
    return res.status(up.ok ? 415 : up.status).json({ error: 'Fichier indisponible.' });
  }
  res.status(up.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = up.headers.get(h); if (v) res.setHeader(h, v);
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const body = require('stream').Readable.fromWeb(up.body);
  body.on('error', () => res.destroy());
  body.pipe(res);
});

// Largeur × hauteur d'une vidéo (entiers raisonnables), sinon null.
function mediaDims(w, h) {
  w = Math.round(Number(w)); h = Math.round(Number(h));
  return w >= 16 && h >= 16 && w <= 10000 && h <= 10000 ? { w, h } : null;
}
// Anciennes vidéos publiées sans leur format : le premier téléphone qui la lit donne sa taille
// (seulement si elle est encore inconnue ; cela ne change que la forme du cadre dans le fil).
app.post('/api/content/:id/dims', rateLimit('dims', 300, 60 * 60 * 1000), async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
  const dims = mediaDims(req.body && req.body.width, req.body && req.body.height);
  if (!dims) return res.status(400).json({ error: 'Taille invalide.' });
  await db.query(`UPDATE content_items SET media_width = $2, media_height = $3
    WHERE id = $1 AND media_width IS NULL AND content_type IN ('video_courte', 'video_longue', 'film', 'telechargement')`, [req.params.id, dims.w, dims.h]);
  res.json({ ok: true });
});

// Fil de contenus publics (découverte) : les plus récents en premier,
// avec le nom du créateur et les compteurs likes/commentaires.
// Publications telles qu'affichées dans le fil (une seule si contentId est donné : publication partagée).
async function feedItems(viewerId, country, contentId) {
  const items = await db.all(
    `SELECT c.id, c.title, c.content_type, c.created_at, c.visibility_scope,
            c.storage_url, c.duration_seconds, c.sale_price, c.sound_content_id, c.ai_generated, c.media_width, c.media_height,
            (SELECT s.title FROM content_items s WHERE s.id = c.sound_content_id) AS sound_title,
            (SELECT scr.name FROM content_items s JOIN creators scr ON scr.id = s.creator_id WHERE s.id = c.sound_content_id) AS sound_creator_name,
            cr.id AS creator_id, cr.name AS creator_name, cr.country_code AS creator_country, cr.photo_url AS creator_photo_key,
            cr.phone AS creator_phone,
            EXISTS (SELECT 1 FROM premium_subscriptions ps WHERE ps.creator_id = cr.id AND ps.ends_at > now()) AS creator_premium,
            EXISTS (SELECT 1 FROM premium_subscriptions ps WHERE ps.creator_id = cr.id AND ps.ends_at > now() AND ps.plan LIKE 'entreprise%') AS creator_business,
            (SELECT COUNT(*) FROM content_likes WHERE content_id = c.id) AS like_count,
            (SELECT COUNT(*) FROM content_comments WHERE content_id = c.id) AS comment_count,
            (SELECT COUNT(*)::int FROM content_reposts WHERE content_id = c.id) AS repost_count,
            c.imported_from,
            EXISTS (SELECT 1 FROM content_likes l WHERE l.content_id = c.id AND l.creator_id = $2) AS liked,
            EXISTS (SELECT 1 FROM content_saves s WHERE s.content_id = c.id AND s.creator_id = $2 AND s.kind = 'favori') AS is_favorite,
            EXISTS (SELECT 1 FROM content_saves s WHERE s.content_id = c.id AND s.creator_id = $2 AND s.kind = 'plus_tard') AS is_later,
            EXISTS (SELECT 1 FROM content_reposts rp WHERE rp.content_id = c.id AND rp.reposter_id = $2) AS reposted
     FROM content_items c
     JOIN creators cr ON cr.id = c.creator_id
     WHERE c.status = 'actif' AND cr.account_status = 'actif'
       AND ($1::text IS NULL OR cr.country_code = $1)
       AND ($3::uuid IS NULL OR c.id = $3)
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
    [country, viewerId, contentId || null]
  );
  for (const item of items) {
    // Le numéro n'est jamais envoyé : il sert seulement à savoir si le créateur est monétisé.
    item.creator_monetized = isMonetizedCreator(item.creator_country, item.creator_phone);
    delete item.creator_phone;
  }
  const premiumCreators = await premiumSet(items.map((i) => i.creator_id));
  // Contenu créé par intelligence artificielle : jamais rémunéré (l'argent revient à Eaji).
  for (const item of items) item.creator_earns = item.creator_monetized && premiumCreators.has(item.creator_id) && !item.ai_generated;
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
  return items;
}

app.get('/api/feed', async (req, res) => {
  const viewerId = optionalViewerId(req);
  const country = /^[A-Z]{2}$/.test(String(req.query.country || '')) ? req.query.country : null;
  const items = await engage.mergeRepostsIntoFeed(viewerId, await feedItems(viewerId, country, null));
  let following = [];
  if (viewerId) {
    following = (await db.all('SELECT followed_id FROM follows WHERE follower_id = $1', [viewerId])).map((r) => r.followed_id);
  }
  // Membres premium : beaucoup moins de publicité (une seule, discrète, en bas du fil).
  const viewerPremium = viewerId ? Boolean(await money.premiumUntil(viewerId)) : false;
  const ads = (await money.adsForFeed(country).catch(() => [])).slice(0, viewerPremium ? 1 : 5);
  res.json({ items, following, ads, viewerPremium });
});

// Une seule publication (ouverte depuis un partage dans Messages ou un lien Eaji).
app.get('/api/content/:id/item', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Publication introuvable.' });
  const viewerId = optionalViewerId(req);
  const [item] = await feedItems(viewerId, null, req.params.id);
  if (!item) return res.status(404).json({ error: 'Cette publication n\'est plus disponible (supprimée ou réservée aux abonnés).' });
  const following = viewerId ? Boolean(await db.query('SELECT 1 FROM follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, item.creator_id])) : false;
  res.json({ item, following });
});

// Partager une publication avec des comptes Eaji (message privé) ou des groupes.
app.post('/api/content/:id/share', requireAuth, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Publication introuvable.' });
  const [item] = await feedItems(req.creatorId, null, req.params.id);
  if (!item) return res.status(404).json({ error: 'Publication introuvable.' });
  const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
  const creators = ids(req.body.toCreators).filter((id) => id !== req.creatorId);
  const groups = ids(req.body.toGroups);
  if (!creators.length && !groups.length) return res.status(400).json({ error: 'Choisis au moins une personne ou un groupe.' });
  if (creators.length + groups.length > 50) return res.status(400).json({ error: '50 destinataires au maximum.' });
  const text = String(req.body.text || '').trim().slice(0, 1000);
  const me = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
  let sent = 0;
  for (const to of creators) {
    if (await isBlockedBetween(req.creatorId, to)) continue;
    const ok = await db.query(
      `INSERT INTO direct_messages (sender_id, recipient_id, text, shared_content_id)
       SELECT $1, id, $3, $4 FROM creators WHERE id = $2 AND account_status = 'actif' RETURNING id`,
      [req.creatorId, to, text, item.id]);
    if (ok) {
      sent++;
      await notify(to, 'message', `🔗 ${me.name} t'a partagé une publication : « ${String(item.title || '').slice(0, 60)} ».`, `dm:${req.creatorId}`,
        { title: me.name, body: `🔗 ${String(item.title || 'Publication').slice(0, 120)}` });
    }
  }
  for (const g of groups) {
    const member = await db.query('SELECT 1 FROM chat_group_members WHERE group_id = $1 AND creator_id = $2', [g, req.creatorId]);
    if (!member) continue;
    await db.query('INSERT INTO group_messages (group_id, sender_id, text, shared_content_id) VALUES ($1, $2, $3, $4)', [g, req.creatorId, text, item.id]);
    sent++;
  }
  // Partager = aussi publier sur son propre compte (republication), sauf sa propre publication.
  let reposted = false;
  if (sent && item.creator_id !== req.creatorId && req.body.repost !== false) {
    const r = await engage.repost(req.creatorId, item.id, null).catch(() => null);
    reposted = Boolean(r && r.repostId);
  }
  res.json({ sent, reposted });
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
    `SELECT id, title, content_type, created_at, duration_seconds, sale_price, creator_id, visibility_scope, storage_url, media_width, media_height,
            $4::boolean AS creator_monetized,
            (SELECT COUNT(*) FROM content_likes WHERE content_id = content_items.id) AS like_count,
            (SELECT COUNT(*) FROM content_comments WHERE content_id = content_items.id) AS comment_count
     FROM content_items
     WHERE creator_id = $1 AND status = 'actif'
       AND (visibility_scope = 'public' OR $2::boolean OR creator_id = $3)
     ORDER BY created_at DESC LIMIT 50`,
    [creator.id, isFollowing, viewerId, isMonetizedCreator(creator.country_code, creator.phone)]
  );
  const creatorPremium = Boolean(await money.premiumUntil(creator.id));
  // En ligne / en direct : pour savoir si on peut lui écrire tout de suite.
  const liveNow = await db.query(
    "SELECT id FROM live_sessions WHERE creator_id = $1 AND status = 'en_cours' AND started_at > now() - interval '12 hours' ORDER BY started_at DESC LIMIT 1", [creator.id]).catch(() => null);
  res.json({
    online: isOnline(creator.last_seen_at),
    lastSeen: creator.last_seen_at || null,
    liveId: liveNow ? liveNow.id : null,
    monetized: isMonetizedCreator(creator.country_code, creator.phone),
    earns: isMonetizedCreator(creator.country_code, creator.phone) && creatorPremium,
    id: creator.id,
    name: creator.name,
    countryCode: creator.country_code,
    zone: creator.zone,
    primaryContentType: creator.primary_content_type,
    photoUrl: await createDownloadUrl(creator.photo_url).catch(() => null),
    subscriberCount: creator.subscriber_count_public || viewerId === creator.id ? followers.total : null,
    isFollowing,
    isMe: viewerId === creator.id,
    premium: creatorPremium,
    business: Boolean(await money.businessUntil(creator.id)),
    contents: await (async () => {
      // Les publications s'affichent comme dans le fil : photo, vidéo, musique ou document visibles
      // (sauf contenu payant pas encore débloqué).
      const access = await money.accessMap(viewerId, contents);
      const out = [];
      for (const c of contents) {
        const a = access.get(c.id);
        out.push({ id: c.id, title: c.title, content_type: c.content_type, created_at: c.created_at, visibility_scope: c.visibility_scope,
                   duration_seconds: c.duration_seconds, price: a.price, for_sale: a.forSale, locked: a.locked,
                   like_count: c.like_count, comment_count: c.comment_count, creator_monetized: c.creator_monetized,
                   creator_earns: Boolean(c.creator_monetized && creatorPremium),
                   fileUrl: a.locked ? null : await createDownloadUrl(c.storage_url).catch(() => null) });
      }
      return out;
    })(),
  });
});

// Une vue est comptée quand quelqu'un regarde/écoute/ouvre un contenu.
// Les vues du créateur sur ses propres contenus ne comptent pas.
app.post('/api/content/:id/view', async (req, res) => {
  let viewerId = null;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) { try { viewerId = verifySessionToken(token); } catch { /* visiteur non connecté */ } }
  // Une vue par personne (compte, sinon appareil/réseau) et par jour : relancer la vidéo
  // en boucle ne gonfle plus les vues. L'adresse IP n'est jamais gardée en clair.
  const viewerKey = viewerId ? `u:${viewerId}` : `ip:${crypto.createHash('sha256').update(`eaji-vue:${req.ip}`).digest('hex').slice(0, 32)}`;
  // Vue d'une republication : comptée pour la republication (au profit d'Eaji), jamais pour l'auteur.
  if (req.body && req.body.repostId) {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.json({ counted: false });
    return res.json({ counted: await engage.countRepostView(req.body.repostId, req.params.id, viewerKey, viewerId), viaRepost: true });
  }
  const fresh = await db.query(
    `INSERT INTO content_view_log (content_id, creator_id, viewer_key, device_key, net_key)
     SELECT id, creator_id, $2, $4, $5 FROM content_items WHERE id = $1 AND status = 'actif' AND creator_id IS DISTINCT FROM $3
     ON CONFLICT DO NOTHING RETURNING content_id`,
    [req.params.id, viewerKey, viewerId, req.deviceKey || null, req.netKey || null]);
  if (fresh) await db.query('UPDATE content_items SET view_count = view_count + 1 WHERE id = $1', [req.params.id]);
  res.json({ counted: Boolean(fresh) });
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
  const fan = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
  if (fan) notify(req.params.id, 'abonne', `👤 ${fan.name} s'est abonné(e) à toi.`, `creator:${req.creatorId}`);
  res.status(201).json({ following: true });
});

app.delete('/api/creators/:id/follow', requireAuth, async (req, res) => {
  await db.query('DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2', [req.creatorId, req.params.id]);
  res.json({ following: false });
});

// Modification du profil : nom, photo, numéro de retrait, pays.
app.patch('/api/creators/me/profile', requireAuth, async (req, res) => {
  const { name, photoUrl, withdrawalPhone, countryCode, language, primaryContentType } = req.body;
  if (req.body.city !== undefined) {
    const city = cleanCity(req.body.city);
    if (!city) return res.status(400).json({ error: 'Indique ta ville.' });
    await db.query('UPDATE creators SET city = $1 WHERE id = $2', [city, req.creatorId]);
  }
  const giftCurrency = req.body.giftCurrency ? String(req.body.giftCurrency).toUpperCase() : null;
  if (giftCurrency && !isKnownCurrency(giftCurrency) && !isSupportedCurrency(giftCurrency)) return res.status(400).json({ error: 'Devise non prise en charge.' });
  if (countryCode && !isKnownCountry(countryCode)) return res.status(400).json({ error: 'Pays inconnu.' });
  if (name) {
    const cur = await db.query('SELECT name, verification_status FROM creators WHERE id = $1', [req.creatorId]);
    if (cur.verification_status === 'verifie' && String(name).trim() !== cur.name) {
      return res.status(400).json({ error: "Ton nom est vérifié avec ta pièce d'identité : contacte l'administrateur pour le changer." });
    }
  }
  if (photoUrl && (!String(photoUrl).startsWith(`${req.creatorId}/`) || String(photoUrl).includes('..'))) {
    return res.status(403).json({ error: 'Photo non autorisée.' });
  }
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
  const me0 = await db.query('SELECT country_code FROM creators WHERE id = $1', [req.creatorId]);
  const newPhone = extrasRoutes.normalizePhone(req.body.newPhone, me0 && me0.country_code) || String(req.body.newPhone || '').replace(/[\s.-]/g, '');
  if (newPhone.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  const taken = (await extrasRoutes.findAccount(db, newPhone, me0 && me0.country_code, { excludeId: req.creatorId })).creator;
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

// Ancienne activation sans paiement : remplacée par le paiement en ligne (formules pub_basique / pub_standard / pub_illimite).
app.post('/api/ads/subscribe', requireAuth, (req, res, next) => {
  const plan = { basique: 'pub_basique', standard: 'pub_standard', illimite: 'pub_illimite' }[req.body && req.body.tier];
  if (!plan) return res.status(400).json({ error: 'Formule inconnue.' });
  res.status(402).json({ code: 'paiement_requis', purpose: plan, error: "L'espace publicitaire se paie en ligne (mobile money, carte ou PayPal)." });
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
const kyc = kycRoutes.register({ app, db, requireAuth, requireAdminPermission, createDownloadUrl, isKnownCountry, notify });
// Rémunération par période d'abonnement Premium (règle interne : voir cycles-routes.js).
const cycles = cyclesRoutes.register({ app, db, requireAuth, requireAdminPrincipal, notify, notifyAdmins, isMonetizedCreator, calculateMonthlyPayout });
const money = moneyRoutes.register({
  app, db, pool, requireAuth, requireAdminPrincipal, optionalViewerId, createDownloadUrl, convertFromUSD, isSupportedCurrency, notify,
  isIdentityVerified: kyc.isVerified, bcrypt, notifyAdmins, cycles,
});
supportRoutes.register({ app, db, requireAuth, requireAdminPermission, notify, notifyAdmins });
// « Annoncer sur Eaji » : page publique pour les entreprises (chiffres d'audience, essai, contact).
advertiseRoutes.register({ app, db, requireAdminPrincipal, optionalViewerId, rateLimit, notifyAdmins, M: require('./monetization') });
// Lecteur de musique : paroles des chansons (écrites par le créateur ou automatiques).
const music = musicRoutes.register({ app, db, requireAuth, optionalViewerId });
securityRoutes.register({ app, db, requireAdminPermission, security, notify });
const chat = chatRoutes.register({ app, db, requireAuth, createDownloadUrl, isBlockedBetween, notify });
const watch = watchRoutes.register({ app, db, requireAdminPermission, requireAdminPrincipal, createDownloadUrl, STORAGE_CONNECTED });
statusRoutes.register({ app, db, requireAuth, createDownloadUrl, isBlockedBetween, notify, STORAGE_CONNECTED, watch });
const engage = engageRoutes.register({ app, db, requireAuth, requireAdminPrincipal, optionalViewerId, verifySessionToken, signSessionToken, notify, feedItems, security,
  createSession: (id, rq) => sessions.createSession(id, rq).catch(() => null) });
push.registerRoutes({ app, requireAuth, requireAdmin });
extrasRoutes.register({
  app, db, bcrypt, requireAuth, requireAdminPrincipal, requireAdminPermission, optionalViewerId, createDownloadUrl, isMonetizedCreator,
  trySendEmail, sendSms: SMS_PROVIDER_CONNECTED ? sendSmsReal : null, notify,
  notifyAdmins, rateLimit, getSecret: () => SESSION_SECRET,
});
accessRoutes.register({ app, db, bcrypt, requireAuth, rateLimit, findAccount: extrasRoutes.findAccount, trySendEmail, notify, security,
  sealTemp: extrasRoutes.sealTemp, getSecret: () => SESSION_SECRET, signSessionToken, sessions });
publicPages.register({ app, db, createDownloadUrl, rateLimit });
backupRoutes.register({ app, db, pool, bcrypt, requireAdminPrincipal, rateLimit });
liveRoutes.register({ app, db, requireAuth, optionalViewerId, createDownloadUrl, isBlockedBetween, isMonetizedCreator,
  isPremium: async (id) => (await premiumSet([id])).has(id) });

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
    `SELECT c.id, c.title, c.content_type, c.visibility_scope, c.created_at, c.view_count, c.duration_seconds, c.sale_price, c.ai_generated,
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
    `UPDATE content_items SET title = COALESCE($1, title), visibility_scope = COALESCE($2, visibility_scope), edited_at = now(),
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

// Pages de 50 (?offset=) : la liste complète ne se charge jamais d'un coup ; « total » donne le nombre.
function followersPage(req) {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  return { limit, offset: Math.max(0, Number(req.query.offset) || 0) };
}
app.get('/api/creators/me/followers', requireAuth, async (req, res) => {
  const { limit, offset } = followersPage(req);
  const total = await db.query('SELECT COUNT(*)::int AS n FROM follows WHERE followed_id = $1', [req.creatorId]);
  const followers = await db.all(
    `SELECT cr.id, cr.name, cr.country_code, cr.photo_url FROM follows f JOIN creators cr ON cr.id = f.follower_id
     WHERE f.followed_id = $1 ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`,
    [req.creatorId, limit, offset]
  );
  for (const f of followers) { f.photoUrl = await createDownloadUrl(f.photo_url).catch(() => null); delete f.photo_url; }
  res.json({ followers, total: total.n, offset });
});

// Abonnés d'un créateur (avec photos) : visibles si le créateur affiche son nombre d'abonnés, ou pour lui-même.
app.get('/api/creators/:id/followers', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
  const viewerId = optionalViewerId(req);
  const creator = await db.query("SELECT id, subscriber_count_public FROM creators WHERE id = $1 AND account_status = 'actif'", [req.params.id]);
  if (!creator) return res.status(404).json({ error: 'Compte introuvable.' });
  if (!creator.subscriber_count_public && viewerId !== creator.id) return res.status(403).json({ error: 'Ce créateur garde la liste de ses abonnés privée.' });
  const { limit, offset } = followersPage(req);
  const total = await db.query(
    "SELECT COUNT(*)::int AS n FROM follows f JOIN creators cr ON cr.id = f.follower_id WHERE f.followed_id = $1 AND cr.account_status = 'actif'", [creator.id]);
  const followers = await db.all(
    `SELECT cr.id, cr.name, cr.country_code, cr.photo_url FROM follows f JOIN creators cr ON cr.id = f.follower_id
     WHERE f.followed_id = $1 AND cr.account_status = 'actif' ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`, [creator.id, limit, offset]);
  for (const f of followers) { f.photoUrl = await createDownloadUrl(f.photo_url).catch(() => null); delete f.photo_url; }
  res.json({ followers, total: total.n, offset });
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
// Relais TURN : indispensable quand les deux téléphones sont derrière des réseaux mobiles stricts
// (très courant en Afrique) — sans lui, l'appel ou le live « se connecte » mais ne passe pas.
//   1) Cloudflare (gratuit jusqu'à 1 000 Go) : CF_TURN_KEY_ID + CF_TURN_KEY_API_TOKEN
//   2) Metered : METERED_APP (nom de l'application) + METERED_API_KEY
//   3) Serveur TURN à soi : TURN_URL + TURN_USERNAME + TURN_CREDENTIAL
let turnCache = null;
function turnProvider() {
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_KEY_API_TOKEN) return 'cloudflare';
  if ((process.env.METERED_APP || process.env.METERED_BASE_URL) && process.env.METERED_API_KEY) return 'metered';
  if (process.env.TURN_URL) return 'serveur';
  return null;
}
async function turnServers() {
  if (turnCache && turnCache.exp > Date.now()) return turnCache.servers;
  const provider = turnProvider();
  let servers = [];
  try {
    if (provider === 'cloudflare') {
      const base = (process.env.CF_TURN_BASE_URL || 'https://rtc.live.cloudflare.com').replace(/\/$/, '');
      const r = await fetch(`${base}/v1/turn/keys/${encodeURIComponent(process.env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.CF_TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      servers = (d.iceServers || []).map((x) => ({ ...x, urls: [].concat(x.urls).filter((u) => !/:53(\?|$)/.test(u)) })); // port 53 : bloqué par les navigateurs
    } else if (provider === 'metered') {
      const base = process.env.METERED_BASE_URL || `https://${process.env.METERED_APP}.metered.live`;
      const r = await fetch(`${base.replace(/\/$/, '')}/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`, { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      servers = Array.isArray(d) ? d : [];
    } else if (provider === 'serveur') {
      servers = [{ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
    }
  } catch (e) {
    console.warn('[Eaji] Relais TURN indisponible :', e.message);
    servers = [];
  }
  const relay = servers.some((x) => [].concat(x.urls).some((u) => /^turns?:/.test(u)));
  // Identifiants valables 24 h chez Cloudflare : on les garde 12 h (5 min si l'appel a échoué).
  turnCache = { servers, exp: Date.now() + (relay ? 12 * 3600 * 1000 : 5 * 60 * 1000) };
  return servers;
}
app.get('/api/calls/ice-config', requireAuth, async (req, res) => {
  const turn = await turnServers();
  const relay = turn.some((x) => [].concat(x.urls).some((u) => /^turns?:/.test(u)));
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, ...turn];
  res.json({ iceServers, relay });
});

// État des services branchés (tableau de bord de l'administrateur principal).
app.get('/api/admin/system-status', requireAdminPrincipal, async (req, res) => {
  const turn = await turnServers();
  res.json({
    turn: { provider: turnProvider(), working: turn.some((x) => [].concat(x.urls).some((u) => /^turns?:/.test(u))) },
    pawapay: Boolean(process.env.PAWAPAY_TOKEN), pawapayLive: process.env.PAWAPAY_ENV === 'production',
    paypal: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET), paypalLive: process.env.PAYPAL_ENV === 'production',
    sms: SMS_PROVIDER_CONNECTED, storage: STORAGE_CONNECTED, email: Boolean(process.env.GMAIL_USER || process.env.RESEND_API_KEY || process.env.BREVO_API_KEY),
    push: true, // clés de notification créées automatiquement
  });
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
  const caller = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
  push.sendTo(calleeId, { kind: 'appel', urgent: true, ttl: 45, tag: `call:${call.id}`, link: `dm:${req.creatorId}`,
    title: kind === 'video' ? '🎥 Appel vidéo entrant' : '📞 Appel entrant', body: `${caller ? caller.name : 'Quelqu\'un'} t'appelle sur Eaji. Touche pour répondre.` });
  const ce = await db.query('SELECT last_seen_at FROM creators WHERE id = $1', [calleeId]);
  res.status(201).json({ callId: call.id, calleeOnline: isOnline(ce && ce.last_seen_at) });
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
  // L'appel est arrivé sur le téléphone de l'appelé : l'appelant voit « Ça sonne ».
  if (call) await db.query('UPDATE calls SET delivered_at = COALESCE(delivered_at, now()) WHERE id = $1', [call.id]);
  res.json({ call: call || null });
});

app.get('/api/calls/:id', requireAuth, async (req, res) => {
  const call = await db.query(
    'SELECT id, status, kind, answer_sdp, caller_id, callee_id, created_at, delivered_at IS NOT NULL AS delivered FROM calls WHERE id = $1 AND (caller_id = $2 OR callee_id = $2)',
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

// Appels manqués (affichés sur l'onglet Messages jusqu'à ce qu'on les ait vus).
const MISSED_SQL = `c.callee_id = $1 AND NOT c.callee_seen AND (c.status = 'missed'
  OR (c.status = 'ringing' AND c.created_at < now() - interval '45 seconds'))`;
app.get('/api/calls-missed', requireAuth, async (req, res) => {
  const calls = await db.all(
    `SELECT c.id, c.kind, c.created_at, c.caller_id, cr.name AS caller_name FROM calls c JOIN creators cr ON cr.id = c.caller_id
     WHERE c.callee_id = $1 AND c.status IN ('missed', 'ringing') AND c.created_at > now() - interval '30 days'
       AND (c.status = 'missed' OR c.created_at < now() - interval '45 seconds')
     ORDER BY c.created_at DESC LIMIT 20`, [req.creatorId]);
  const unseen = await db.query(`SELECT COUNT(*)::int AS n FROM calls c WHERE ${MISSED_SQL}`, [req.creatorId]);
  res.json({ calls, unseen: unseen.n });
});
app.post('/api/calls-missed/seen', requireAuth, async (req, res) => {
  await db.query(`UPDATE calls c SET callee_seen = TRUE WHERE ${MISSED_SQL}`, [req.creatorId]);
  res.json({ ok: true });
});

// ==================== MESSAGERIE PRIVÉE ====================

// Liste des conversations du créateur connecté : dernier message avec chaque personne.
app.get('/api/conversations', requireAuth, async (req, res) => {
  const conversations = await db.all(
    `SELECT DISTINCT ON (other_id) other_id, cr.name AS other_name, cr.photo_url AS other_photo, cr.last_seen_at AS other_seen,
            CASE WHEN m.deleted_at IS NOT NULL THEN '🚫 Message supprimé' ELSE COALESCE(NULLIF(m.text, ''), '📎 ' || m.file_name,
              CASE WHEN m.shared_content_id IS NOT NULL THEN '🔗 Publication partagée' END) END AS last_text,
            m.created_at, m.sender_id = $1 AS last_mine, m.read_at IS NOT NULL AS last_read
     FROM (
       SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_id, sender_id, text, file_name, created_at, deleted_at, read_at, shared_content_id
       FROM direct_messages WHERE sender_id = $1 OR recipient_id = $1
     ) m JOIN creators cr ON cr.id = m.other_id
     ORDER BY other_id, m.created_at DESC`,
    [req.creatorId]
  );
  conversations.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const unread = await db.all('SELECT sender_id, COUNT(*)::int AS n FROM direct_messages WHERE recipient_id = $1 AND read_at IS NULL GROUP BY sender_id', [req.creatorId]);
  const unreadBy = new Map(unread.map((u) => [u.sender_id, u.n]));
  for (const c of conversations) { c.online = isOnline(c.other_seen); c.unread = unreadBy.get(c.other_id) || 0; c.otherPhotoUrl = await createDownloadUrl(c.other_photo).catch(() => null); delete c.other_photo; }
  res.json({ conversations });
});

app.get('/api/messages-unread', requireAuth, async (req, res) => {
  const dm = await db.query('SELECT COUNT(*)::int AS n FROM direct_messages WHERE recipient_id = $1 AND read_at IS NULL', [req.creatorId]);
  const gr = await db.query(
    `SELECT COUNT(*)::int AS n FROM group_messages gm JOIN chat_group_members m ON m.group_id = gm.group_id AND m.creator_id = $1
     WHERE gm.id > COALESCE(m.last_read_id, 0) AND gm.sender_id IS DISTINCT FROM $1`, [req.creatorId]);
  const missed = await db.query(`SELECT COUNT(*)::int AS n FROM calls c WHERE ${MISSED_SQL}`, [req.creatorId]);
  const sup = await db.query(
    `SELECT COUNT(*)::int AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
     WHERE t.creator_id = $1 AND m.author = 'equipe' AND m.created_at > t.user_read_at`, [req.creatorId]).catch(() => ({ n: 0 }));
  res.json({ total: dm.n + gr.n, direct: dm.n, groups: gr.n, missedCalls: missed.n, support: sup.n });
});

app.get('/api/messages/:withCreatorId', requireAuth, async (req, res) => {
  const messages = await db.all(
    `SELECT * FROM direct_messages
     WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     ORDER BY created_at ASC`,
    [req.creatorId, req.params.withCreatorId]
  );
  for (const m of messages) await chat.withUrls(m);
  await db.query('UPDATE direct_messages SET read_at = now() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL', [req.creatorId, req.params.withCreatorId]);
  const other = await db.query('SELECT last_seen_at FROM creators WHERE id = $1', [req.params.withCreatorId]).catch(() => null);
  res.json({ messages, contact: other ? { online: isOnline(other.last_seen_at), lastSeen: other.last_seen_at } : null });
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
    const vs = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
    if (vs) notify(req.params.withCreatorId, 'message', `🎤 ${vs.name} t'a envoyé un message vocal.`, `dm:${req.creatorId}`, { title: vs.name, body: '🎤 Message vocal' });
    return res.status(201).json({ messageId: voice.id });
  }
  // Pièce jointe (photo, vidéo, document, musique… tout type de fichier).
  const att = chat.readAttachment(req);
  if (!att.ok) return res.status(403).json({ error: 'Fichier non autorisé.' });
  if (att.file) {
    if (req.params.withCreatorId === req.creatorId) return res.status(400).json({ error: 'Tu ne peux pas t\'écrire à toi-même.' });
    if (await isBlockedBetween(req.creatorId, req.params.withCreatorId)) return res.status(403).json({ error: 'Tu ne peux pas écrire à ce compte.' });
    const fm = await db.query(
      'INSERT INTO direct_messages (sender_id, recipient_id, text, file_key, file_name, file_mime, file_size) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [req.creatorId, req.params.withCreatorId, String(text || '').trim().slice(0, 4000), att.file.key, att.file.name, att.file.mime, att.file.size]);
    const snd = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
    if (snd) notify(req.params.withCreatorId, 'message', `📎 ${snd.name} t'a envoyé un fichier.`, `dm:${req.creatorId}`,
      { title: snd.name, body: `📎 ${String(att.file.mime || '').startsWith('image/') ? 'Photo' : String(att.file.mime || '').startsWith('video/') ? 'Vidéo' : att.file.name}` });
    return res.status(201).json({ messageId: fm.id });
  }
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Message vide.' });
  if (req.params.withCreatorId === req.creatorId) return res.status(400).json({ error: 'Tu ne peux pas t\'écrire à toi-même.' });
  if (await isBlockedBetween(req.creatorId, req.params.withCreatorId)) return res.status(403).json({ error: 'Tu ne peux pas écrire à ce compte.' });
  const message = await db.query(
    'INSERT INTO direct_messages (sender_id, recipient_id, text) VALUES ($1, $2, $3) RETURNING id',
    [req.creatorId, req.params.withCreatorId, text]
  );
  const sender = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
  if (sender) notify(req.params.withCreatorId, 'message', `💬 Nouveau message de ${sender.name}.`, `dm:${req.creatorId}`,
    { title: sender.name, body: String(text).trim().slice(0, 160) });
  res.status(201).json({ messageId: message.id });
});

// Modifier ou supprimer un message envoyé par erreur (seulement par celui qui l'a envoyé).
app.patch('/api/messages/item/:id', requireAuth, async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Message vide.' });
  await chatRoutes.archiveMessage(db, 'prive', String(req.params.id), 'modifie', req.creatorId);
  const m = await db.query(
    `UPDATE direct_messages SET text = $3, edited_at = now() WHERE id::text = $1 AND sender_id = $2 AND deleted_at IS NULL AND audio_key IS NULL AND file_key IS NULL
     RETURNING id`, [String(req.params.id), req.creatorId, text]);
  if (!m) return res.status(404).json({ error: 'Tu ne peux modifier que tes propres messages écrits.' });
  res.json({ edited: true });
});
app.delete('/api/messages/item/:id', requireAuth, async (req, res) => {
  await chatRoutes.archiveMessage(db, 'prive', String(req.params.id), 'supprime', req.creatorId);
  const m = await db.query(
    `UPDATE direct_messages SET deleted_at = now(), text = '', audio_key = NULL, file_key = NULL, file_name = NULL, file_mime = NULL, file_size = NULL
     WHERE id::text = $1 AND sender_id = $2 AND deleted_at IS NULL RETURNING id`, [String(req.params.id), req.creatorId]);
  if (!m) return res.status(404).json({ error: 'Tu ne peux supprimer que tes propres messages.' });
  res.json({ deleted: true });
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
app.get('/api/admin/content-review', requireAdminPermission('moderer_contenu'), async (req, res) => {
  const items = await db.all(
    `SELECT c.id, c.title, c.content_type, c.storage_url, c.created_at, cr.name AS creator_name
     FROM content_items c JOIN creators cr ON cr.id = c.creator_id WHERE c.status = 'en_revue' ORDER BY c.created_at ASC LIMIT 100`);
  for (const i of items) { i.fileUrl = await createDownloadUrl(i.storage_url).catch(() => null); delete i.storage_url; }
  res.json({ items });
});
app.post('/api/admin/content/:id/approve', requireAdminPermission('moderer_contenu'), async (req, res) => {
  const c = await db.query("UPDATE content_items SET status = 'actif' WHERE id = $1 AND status = 'en_revue' RETURNING creator_id, title", [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Publication introuvable ou déjà traitée.' });
  await db.query("INSERT INTO moderation_actions (content_id, admin_id, action, reason) VALUES ($1, $2, 'restauration', 'Vérifiée par l''équipe (détection impossible sur le téléphone)')", [req.params.id, req.adminId]).catch(() => {});
  notify(c.creator_id, 'publication', `✅ Ta publication « ${c.title} » a été vérifiée : elle est maintenant visible.`, 's-contenu');
  res.json({ approved: true });
});

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
          AND (SELECT COALESCE(SUM(view_count), 0) FROM content_items WHERE creator_id = c.id AND NOT ai_generated) >= 1000
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
    `SELECT c.id, c.name, c.email, c.phone, c.country_code, c.city, c.zone, c.account_status, c.created_at, c.last_seen_at,
            GREATEST(
              COALESCE((SELECT subscriber_count FROM subscriber_counts WHERE creator_id = c.id
                        ORDER BY verified_at DESC LIMIT 1), 0),
              (SELECT COUNT(*)::int FROM follows WHERE followed_id = c.id)
            ) AS subscribers,
            (SELECT MAX(ends_at) FROM premium_subscriptions WHERE creator_id = c.id AND ends_at > now()) AS premium_until,
            (SELECT MAX(ends_at) FROM premium_subscriptions WHERE creator_id = c.id AND ends_at > now() AND plan LIKE 'entreprise%') AS business_until,
            EXISTS (SELECT 1 FROM premium_subscriptions WHERE creator_id = c.id AND ends_at > now() AND plan LIKE '%_offert') AS has_gift,
            (SELECT COALESCE(SUM(view_count), 0)::int FROM content_items WHERE creator_id = c.id AND status <> 'supprime') AS views,
            (SELECT COUNT(*)::int FROM content_view_log v WHERE v.creator_id = c.id AND v.day >= date_trunc('month', now())::date) AS month_views,
            (SELECT COUNT(*)::int FROM watch_flags w WHERE w.creator_id = c.id AND NOT w.resolved) AS open_flags
     FROM creators c
     WHERE ($1::text IS NULL OR c.country_code = $1) AND ($2::text IS NULL OR lower(trim(c.city)) = lower($2))
     LIMIT 5000`,
    [req.query.country ? String(req.query.country).toUpperCase() : null, req.query.city ? String(req.query.city).trim() : null]
  );
  creators.forEach((c) => { c.monetized = isMonetizedCreator(c.country_code, c.phone); c.online = isOnline(c.last_seen_at); });
  // Classement : par abonnés (défaut), par vues, ou du plus récent au plus ancien.
  const sort = ['abonnes', 'vues', 'recent'].includes(req.query.sort) ? req.query.sort : 'abonnes';
  creators.sort((x, y) => sort === 'vues' ? (y.views - x.views) || (y.subscribers - x.subscribers)
    : sort === 'recent' ? new Date(y.created_at) - new Date(x.created_at)
    : (y.subscribers - x.subscribers) || (y.views - x.views));
  // Villes : total des abonnés et des vues de tous leurs comptes (pour repérer où sont les créateurs à payer).
  const cityMap = new Map();
  for (const c of creators) {
    if (c.account_status === 'supprime') continue;
    const city = String(c.city || '').trim() ? String(c.city).trim().toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase()) : '(ville non indiquée)';
    const k = `${c.country_code}|${city}`;
    const e = cityMap.get(k) || { country_code: c.country_code, city, accounts: 0, subscribers: 0, views: 0, month_views: 0 };
    e.accounts++; e.subscribers += Number(c.subscribers) || 0; e.views += Number(c.views) || 0; e.month_views += Number(c.month_views) || 0;
    cityMap.set(k, e);
  }
  const cities = [...cityMap.values()].sort((x, y) => sort === 'vues' ? y.views - x.views : (y.subscribers - x.subscribers) || (y.views - x.views));
  // Regroupement : nombre de comptes par pays et par ville (pour les filtres et les envois groupés).
  const groups = await db.all(
    `SELECT country_code, COALESCE(NULLIF(initcap(lower(trim(city))), ''), '(ville non indiquée)') AS city, COUNT(*)::int AS n
     FROM creators WHERE account_status <> 'supprime'
     GROUP BY 1, 2 ORDER BY country_code, n DESC`);
  res.json({ creators, groups, cities, sort });
});

// Abonnés d'un compte (vus par l'administration), par pages de 50 : la liste ne s'ouvre que sur demande.
app.get('/api/admin/creators/:id/followers', requireAdminPermission('gerer_comptes_utilisateurs'), async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const total = await db.query('SELECT COUNT(*)::int AS n FROM follows WHERE followed_id = $1', [req.params.id]);
  const followers = await db.all(
    `SELECT cr.id, cr.name, cr.country_code, cr.city, cr.phone, f.created_at FROM follows f JOIN creators cr ON cr.id = f.follower_id
     WHERE f.followed_id = $1 ORDER BY f.created_at DESC LIMIT 50 OFFSET $2`, [req.params.id, offset]);
  res.json({ total: total.n, offset, followers });
});

// ==================== MESSAGES DE L'ADMINISTRATION À TOUS LES COMPTES ====================
// Envoi automatique d'une alerte (changement, panne, maintenance…) à tous les comptes, à un pays
// ou à une ville : notification dans la cloche + sur le téléphone (même écran verrouillé).
function broadcastAudience(body) {
  const scope = ['tous', 'pays', 'ville'].includes(body.scope) ? body.scope : null;
  const country = body.countryCode ? String(body.countryCode).toUpperCase() : null;
  const city = cleanCity(body.city);
  if (!scope) return { error: 'Choisis les destinataires.' };
  if (scope !== 'tous' && !isKnownCountry(country)) return { error: 'Choisis le pays.' };
  if (scope === 'ville' && !city) return { error: 'Indique la ville.' };
  return {
    scope, country: scope === 'tous' ? null : country, city: scope === 'ville' ? city : null,
    where: `account_status = 'actif' AND ($1::text IS NULL OR country_code = $1) AND ($2::text IS NULL OR lower(trim(city)) = lower($2))`,
  };
}

app.get('/api/admin/broadcast/count', requireAdminPrincipal, async (req, res) => {
  const a = broadcastAudience(req.query);
  if (a.error) return res.status(400).json({ error: a.error });
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM creators WHERE ${a.where}`, [a.country, a.city]);
  res.json({ recipients: r.n });
});

app.post('/api/admin/broadcast', requireAdminPrincipal, async (req, res) => {
  const a = broadcastAudience(req.body);
  if (a.error) return res.status(400).json({ error: a.error });
  const title = String(req.body.title || '').trim().slice(0, 80) || '📢 Message de l\'équipe Eaji';
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (text.length < 3) return res.status(400).json({ error: 'Écris le message.' });
  const rows = await db.all(`SELECT id FROM creators WHERE ${a.where}`, [a.country, a.city]);
  // La cloche de chacun, en une seule fois.
  await db.query(
    `INSERT INTO notifications (creator_id, kind, text, link)
     SELECT id, 'annonce', $3, NULL FROM creators WHERE ${a.where}`, [a.country, a.city, `${title} — ${text}`.slice(0, 300)]);
  const b = await db.query(
    `INSERT INTO admin_broadcasts (admin_id, scope, country_code, city, title, text, recipients) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.adminId, a.scope, a.country, a.city, title, text, rows.length]);
  // Le téléphone de chacun (en arrière-plan, sans faire attendre l'administrateur).
  (async () => { for (const r of rows) await push.sendTo(r.id, { kind: 'annonce', title, body: text, link: 's-decouvrir', tag: `annonce:${b.id}` }); })() // gardée 24 h si le téléphone est éteint
    .catch((e) => console.error('[Eaji] Envoi groupé interrompu :', e.message));
  res.status(201).json({ sent: true, recipients: rows.length });
});

app.get('/api/admin/broadcasts', requireAdminPrincipal, async (req, res) => {
  res.json({ broadcasts: await db.all('SELECT * FROM admin_broadcasts ORDER BY created_at DESC LIMIT 50') });
});

// Suppression DÉFINITIVE d'un compte et de toutes ses données — administrateur principal uniquement
// (jamais accordable à un administrateur secondaire).
app.delete('/api/admin/creators/:id', requireAdminPrincipal, async (req, res) => {
  const deleted = await deleteCreatorAccount(pool, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Compte introuvable.' });
  console.log(`[Eaji] Compte ${req.params.id} supprimé par l'administrateur ${req.adminId}`);
  // Les fichiers (dont la pièce d'identité et la photo du visage) sont effacés du stockage en arrière-plan.
  deleteCreatorFiles(req.params.id)
    .then((n) => console.log(`[Eaji] ${n} fichier(s) effacé(s) du stockage pour le compte ${req.params.id}`))
    .catch((e) => console.error(`[Eaji] Effacement des fichiers du compte ${req.params.id} à refaire :`, e.message));
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

app.post('/api/admin/auth/login', rateLimit('adminlogin', 15, 15 * 60 * 1000), async (req, res) => {
  const { phone, password, deviceFingerprint } = req.body;
  const ipAddress = req.ip; // vraie adresse IP, jamais celle envoyée par le navigateur

  if (await isBlocklisted(ipAddress, deviceFingerprint)) {
    return res.status(403).json({ error: 'Accès bloqué.' });
  }

  // Numéro de l'administrateur écrit de n'importe quelle façon (0823…, +243 823…, 243823…).
  const adminTail = extrasRoutes.phoneTail(phone);
  const phoneRow = await db.query(
    `SELECT admin_id FROM admin_phone_numbers WHERE phone = $1 OR phone = $2
        OR ($3::text IS NOT NULL AND right(regexp_replace(phone, '[^0-9]', '', 'g'), length($3)) = $3)
     ORDER BY (phone = $1) DESC LIMIT 1`, [phone, extrasRoutes.normalizePhone(phone, 'CD'), adminTail]);
  const admin = phoneRow ? await db.query('SELECT * FROM admins WHERE id = $1', [phoneRow.admin_id]) : null;
  const passwordOk = admin && (await bcrypt.compare(password, admin.password_hash));

  await db.query(
    'INSERT INTO admin_login_attempts (phone_attempted, ip_address, device_fingerprint, success) VALUES ($1, $2, $3, $4)',
    [phone, ipAddress, deviceFingerprint, !!passwordOk]
  );
  if (!passwordOk) await security.log('admin_connexion_echouee', 'critique', { identifier: phone, ip: ipAddress, device: deviceFingerprint, detail: `Mot de passe administrateur faux (numéro ${String(phone || '').slice(0, 20)})` });

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

app.post('/api/admin/auth/login/verify-2fa', rateLimit('adminotp', 15, 15 * 60 * 1000), async (req, res) => {
  const { adminId, code } = req.body;
  const record = await db.query(
    'SELECT * FROM admin_verifications WHERE admin_id = $1 AND verified = FALSE ORDER BY created_at DESC LIMIT 1',
    [adminId]
  );
  if (!record || !(await bcrypt.compare(code, record.code_hash)) || new Date() > record.expires_at) {
    return res.status(401).json({ error: 'Code invalide ou expiré.' });
  }
  await db.query('UPDATE admin_verifications SET verified = TRUE WHERE id = $1', [record.id]);
  const token = signSessionToken(adminId, { typ: 'admin' });
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
