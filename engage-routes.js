// Eaji — connexion par code QR, favoris / « à regarder plus tard », republications (partage = publication),
// import d'une vidéo depuis un lien (Facebook, YouTube, TikTok…) et blocage des liens inconnus.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QR_LIFETIME_S = 180;          // un code QR d'ordinateur reste valable 3 minutes
const IMPORT_MAX_BYTES = 300 * 1024 * 1024;
const IMPORT_MAX_SECONDS = 3600;    // même limite que les vidéos publiées (60 minutes)
const IMPORT_DIR = path.join(require('os').tmpdir(), 'eaji-import');

const MIGRATIONS = [
  // Connexion d'un ordinateur en scannant un code QR avec l'application (téléphone déjà connecté).
  `CREATE TABLE IF NOT EXISTS qr_logins (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     secret_hash TEXT NOT NULL,
     user_agent TEXT,
     ip TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL,
     approved_by UUID REFERENCES creators(id) ON DELETE CASCADE,
     approved_at TIMESTAMPTZ,
     denied BOOLEAN NOT NULL DEFAULT FALSE,
     consumed_at TIMESTAMPTZ)`,
  // Favoris et « à regarder plus tard ».
  `CREATE TABLE IF NOT EXISTS content_saves (
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     content_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('favori', 'plus_tard')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (creator_id, content_id, kind))`,
  'CREATE INDEX IF NOT EXISTS content_saves_mine ON content_saves (creator_id, kind, created_at DESC)',
  // Republications : partager une publication la publie aussi sur son propre compte.
  `CREATE TABLE IF NOT EXISTS content_reposts (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     content_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
     reposter_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     text TEXT,
     view_count INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (content_id, reposter_id))`,
  'CREATE INDEX IF NOT EXISTS content_reposts_by ON content_reposts (reposter_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS repost_view_log (
     repost_id UUID NOT NULL REFERENCES content_reposts(id) ON DELETE CASCADE,
     viewer_key TEXT NOT NULL,
     day DATE NOT NULL DEFAULT CURRENT_DATE,
     PRIMARY KEY (repost_id, viewer_key, day))`,
  // Argent payé depuis une republication : il revient entièrement à Eaji.
  'ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS via_repost_id UUID',
  // Vidéo importée depuis un lien (source affichée sous la publication).
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS imported_from TEXT',
  `CREATE TABLE IF NOT EXISTS import_jobs (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     url TEXT NOT NULL,
     site TEXT,
     status TEXT NOT NULL DEFAULT 'attente' CHECK (status IN ('attente', 'telechargement', 'pret', 'echec', 'recupere')),
     progress NUMERIC NOT NULL DEFAULT 0,
     title TEXT,
     duration_seconds NUMERIC,
     ext TEXT,
     size_bytes BIGINT,
     file_path TEXT,
     error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ)`,
];

// ===================== LIENS : blocage des liens inconnus =====================
// Domaines « forts » : bloqués même écrits sans http ni chemin (exemple : arnaque.com).
const STRONG_TLDS = new Set(['com', 'net', 'org', 'info', 'biz', 'xyz', 'top', 'site', 'online', 'shop', 'store', 'app', 'link', 'click', 'live', 'io',
  'co', 'ly', 'cd', 'cg', 'fr', 'ru', 'cn', 'tk', 'ml', 'ga', 'cf', 'gq', 'cc', 'tv', 'gl', 'gg', 'club', 'vip', 'win', 'bid', 'loan', 'work', 'icu',
  'buzz', 'cam', 'rest', 'monster', 'cyou', 'sbs', 'cfd', 'fun', 'space', 'website', 'tech', 'mobi', 'ws', 'su', 'page', 'dev', 'news', 'today',
  'world', 'email', 'digital', 'network', 'cloud', 'media', 'social', 'chat', 'group', 'money', 'cash', 'finance', 'bet', 'casino', 'games', 'xxx',
  'porn', 'sex', 'adult', 'dating', 'gift', 'promo', 'bonus', 'free', 'download', 'review', 'stream', 'watch', 'video', 'tube', 'me', 'us', 'uk',
  'ng', 'ke', 'za', 'ug', 'tz', 'rw', 'gh', 'cm', 'sn', 'ci', 'bi', 'ao', 'eu', 'asia', 'africa', 'one', 'pro', 'ca', 'be', 'ch', 'br', 'in']);
// Domaines qui ressemblent à des mots courts (« fin.de », « ok.ma », « merci.to ») : bloqués seulement avec un chemin (exemple : site.de/page).
const WEAK_TLDS = new Set(['de', 'la', 'le', 'ma', 'to', 'it', 'is', 'na', 'et', 'es', 'pt', 'se', 'si', 'so', 'tn', 'dz', 'eg', 'mx', 'ar', 'nl', 'pl',
  'ua', 'tr', 'ir', 'pk', 'bd', 'id', 'ph', 'vn', 'th', 'my', 'sg', 'hk', 'tw', 'jp', 'kr', 'au', 'nz', 'ae', 'sa', 'lk', 'nu', 'li', 'im', 'gd', 'pw',
  'sh', 'ai', 'zip', 'mov', 'st', 'am', 'fm', 'ly', 'ms', 'mu', 'ne', 'cx', 'ws']);
const URL_RE = /(?:\bhttps?:\/\/[^\s<>"'«»]+)|(?:\bwww\.[^\s<>"'«»]+)|(?:\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})\b(\/[^\s<>"'«»]*)?)/gi;
const EMAIL_RE = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi;
const MESSAGING_HOSTS = ['wa.me', 'whatsapp.com', 'whatsapp.net', 't.me', 'telegram.me', 'telegram.org', 'telegram.dog'];

function hostOfLink(link) {
  let s = String(link).trim().replace(/[),.;:!?»]+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try { const u = new URL(s); return { host: u.hostname.toLowerCase().replace(/^www\./, ''), path: u.pathname || '/', userinfo: Boolean(u.username || u.password) }; } catch (e) { return null; }
}
const hostIs = (host, list) => list.some((d) => host === d || host.endsWith('.' + d));
function siteHosts() {
  const out = [];
  for (const v of [process.env.PUBLIC_SITE_URL, process.env.PUBLIC_API_URL]) {
    try { if (v) out.push(new URL(v).hostname.toLowerCase().replace(/^www\./, '')); } catch (e) { /* adresse mal écrite */ }
  }
  for (const h of String(process.env.ALLOWED_LINK_HOSTS || '').split(',')) if (h.trim()) out.push(h.trim().toLowerCase().replace(/^www\./, ''));
  return out;
}
// Liens toujours permis : ceux d'Eaji (publications partagées, profils).
function isEajiLink(l) {
  if (l.host === 'eaji.org' || l.host.endsWith('.eaji.org')) return true; // eaji.org et ses sous-domaines (api, secours, finance…)
  if (l.host === 'jimmynho.github.io') return /^\/eaji-site(\/|$)/i.test(l.path);
  if (/(^|\.)eajimmy-production\.up\.railway\.app$/.test(l.host)) return true;
  return hostIs(l.host, siteHosts().filter((h) => h !== 'jimmynho.github.io' && h !== '127.0.0.1' && h !== 'localhost'))
    || (['127.0.0.1', 'localhost'].includes(l.host) && siteHosts().includes(l.host));
}
const isMessagingLink = (l) => hostIs(l.host, MESSAGING_HOSTS);
function findLinks(text) {
  // Une adresse email est ignorée, sauf si elle suit « http:// » (adresse déguisée : https://eaji.com@arnaque.com).
  const clean = String(text || '').replace(EMAIL_RE, (m) => (/:\/\//.test(m) ? m : ' '));
  const out = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(clean))) {
    const raw = m[0];
    if (m[1] !== undefined) { // domaine écrit sans http ni www
      const tld = m[1].toLowerCase();
      const hasPath = Boolean(m[2] && m[2].length > 1);
      if (!(STRONG_TLDS.has(tld) || (WEAK_TLDS.has(tld) && hasPath))) continue;
    }
    const l = hostOfLink(raw);
    if (l) out.push({ ...l, raw: raw.slice(0, 120) });
  }
  return out;
}
// Liens refusés : un compte Entreprise publie librement ses liens (WhatsApp, Telegram, site internet…) ;
// pour les autres utilisateurs, tout lien est bloqué, sauf ceux d'Eaji.
function blockedLinks(text, isBusiness) {
  if (isBusiness) return [];
  return findLinks(text).filter((l) => !isEajiLink(l));
}
const LINK_BLOCKED_MESSAGE = '🔒 Lien bloqué pour ta sécurité : les liens sont interdits sur Eaji (protection contre les virus et les arnaques). Seuls les comptes Entreprise peuvent publier leurs liens (WhatsApp, Telegram, site internet).';

// ===================== ANTI-PHISHING (hameçonnage) =====================
// Le phishing : un faux message ou un faux site qui imite Eaji pour voler un mot de passe, un code ou de l'argent.
// 1) Liens dangereux refusés pour TOUS (même les comptes Entreprise et les publicités) : faux sites qui imitent
//    Eaji, liens raccourcis qui cachent la vraie adresse, adresses en chiffres, adresses déguisées.
const SHORTENERS = ['bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'v.gd', 'cutt.ly', 'ow.ly', 'rebrand.ly', 'shorturl.at', 'tiny.cc',
  'rb.gy', 's.id', 'buff.ly', 'bl.ink', 'short.io', 'shorte.st', 'adf.ly', 't.ly', 'lnkd.in', 'qr.ae', 'clck.ru', 'u.to', 'shrtco.de', 'tny.im',
  'surl.li', 'urlz.fr', 'link.tl', 'x.gd', 'gg.gg', 'bitly.ws', 'snip.ly', 'kutt.it', 'tr.ee', 'shorturl.asia'];
const OFFICIAL_HOSTS = ['eaji.org', 'eajimmy.onrender.com', 'eajimmy-production.up.railway.app'];
function dangerReason(l) {
  const host = l.host || '';
  if (hostIs(host, OFFICIAL_HOSTS) || isEajiLink(l)) return null;
  if (/^\[?[0-9a-f:.]+\]?$/i.test(host) && /\d/.test(host)) return 'adresse en chiffres';
  if (/(^|\.)xn--/.test(host)) return 'adresse déguisée';
  if (l.userinfo) return 'adresse déguisée';
  if (hostIs(host, SHORTENERS)) return 'lien raccourci';
  const labels = host.split(/[-_.]/).map((x) => x.replace(/[1l!|]/g, 'i').replace(/0/g, 'o'));
  if (labels.some((x) => /^e[a4]i?ji/.test(x) || /eajimmy|eajmy/.test(x))) return 'faux site Eaji';
  return null;
}
function dangerousLinks(text) {
  return findLinks(text).filter((l) => dangerReason(l)).map((l) => ({ host: l.host, why: dangerReason(l) }));
}
const DANGER_LINK_MESSAGE = '🔒 Lien bloqué : il ressemble à une arnaque (faux site d\'Eaji, lien raccourci qui cache la vraie adresse, ou adresse déguisée). Même les comptes Entreprise et les publicités ne peuvent pas le publier.';

// 2) Messages qui demandent un mot de passe, un code ou un code PIN, ou qui se font passer pour l'équipe Eaji.
const deaccent = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’`]/g, "'");
const ASK = "(?:envoie|envoi|envoyer|envoyez|renvoie|donne|donner|donnez|communique|communiquez|partage|partagez|transmets|transmettez|ecris|ecrivez|dis[- ]moi|dites[- ]moi|tape|tapez|copie|copiez|colle|redonne|confirme|confirmez|saisis|saisissez|entre|entrez|mets|mettez|besoin de|il me faut|j'ai besoin|send|give|share|tell me|provide|forward|text me|need your|enter your|type your|confirm your|nitumie|tuma|nipe|niambie|nipatie|tinda|pesa ngai|yebisa ngai|envia|manda|passa|me da|dame|dime|pasame|enviame)";
const SECRET = "(?:mot de passe|mots de passe|\\bmdp\\b|password|passcode|pass word|code (?:de |d')?(?:confirmation|verification|connexion|validation|securite|acces|retrait)|code secret|code pin|\\bpin\\b|\\botp\\b|code (?:que tu as|qu'on t'a|qui t'a ete|recu|envoye|a 6 chiffres|sms)|verification code|confirmation code|login code|security code|one[- ]time|nenosiri|neno la siri|senha|contrasena|codigo de (?:verificacao|verificacion|confirmacao|confirmacion|seguranca|seguridad)|code ya (?:confirmation|kokota)|mot ya passe)";
const PHISH_ASK_RE = new RegExp(`\\b${ASK}\\b[^.!?\\n]{0,45}?(?<!\\b(?:mon|ma|mes|my|mi|meu|minha|yangu|na ngai) )${SECRET}`);
const PHISH_TEAM_RE = /\b(?:je suis|j'suis|nous sommes|ici|c'est|this is|i am|i'm|we are|mimi ni|sisi ni|ngai nazali|biso tozali|sou|somos|soy)\b[^.!?\n]{0,25}\b(?:equipe|service|support|admin\w*|moderat\w*|agent|team|staff|securite|security|direction|directeur|fondateur|founder|responsable|technicien)\b[^.!?\n]{0,20}\beaji|\b(?:message|avis|alerte|notification|annonce|compte) officiel(?:le)? (?:d'|de |du )?eaji|\beaji (?:officiel|official|support|securite|security)\b/;
function phishReason(text) {
  const t = deaccent(text);
  if (!t || t.length < 6) return null;
  if (PHISH_ASK_RE.test(t)) return 'demande de mot de passe ou de code';
  if (PHISH_TEAM_RE.test(t)) return 'se fait passer pour l\'équipe Eaji';
  return null;
}
const PHISH_MESSAGE = '🔒 Message bloqué pour ta sécurité : sur Eaji, personne ne doit demander un mot de passe, un code de confirmation ou un code PIN, ni se faire passer pour l\'équipe Eaji. La vraie équipe Eaji t\'écrit seulement dans Profil → « Contacter l\'équipe Eaji ».';
const PHISH_FIELDS = ['text', 'title', 'message', 'comment', 'caption', 'description', 'bio', 'note', 'reply', 'lyrics'];
const PHISH_EXEMPT = ['/api/admin', '/api/auth', '/api/support', '/api/agent', '/api/payments', '/api/cinetpay', '/api/push', '/api/import', '/api/montage'];
// onBlocked : prévient Eajimmy AI (journal de sécurité, suspension après plusieurs essais).
function phishGuard({ db, verifySessionToken, onBlocked = async () => {} }) {
  return async (req, res, next) => {
    try {
      const p = String(req.path || req.url || '').split('?')[0];
      if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !p.startsWith('/api/') || PHISH_EXEMPT.some((x) => p.startsWith(x))) return next();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const text = PHISH_FIELDS.map((k) => body[k]).filter((v) => typeof v === 'string' && v.length > 5).join('\n');
      const why = text && phishReason(text);
      if (!why) return next();
      let creatorId = null;
      const token = String(req.headers.authorization || '').replace('Bearer ', '');
      if (token) { try { creatorId = verifySessionToken(token); } catch (e) { /* non connecté */ } }
      const base = typeof db === 'function' ? db() : db;
      // Compte exempté par l'administrateur (exemple : le compte du fondateur) : pas de contrôle.
      if (creatorId && await base.query('SELECT 1 FROM creators WHERE id = $1 AND agent_exempt', [creatorId]).catch(() => null)) return next();
      Promise.resolve(onBlocked({ creatorId, ip: req.ip, device: req.deviceKey || null, reason: why, text: text.slice(0, 300), path: p })).catch(() => {});
      return res.status(400).json({ code: 'hameconnage', error: PHISH_MESSAGE });
    } catch (e) { return next(); }
  };
}

// Vérifie tous les textes envoyés par les utilisateurs (publications, commentaires, messages, statuts,
// groupes, publicités…). Placé avant toutes les routes.
const LINK_FIELDS = ['text', 'title', 'message', 'comment', 'caption', 'description', 'bio', 'linkUrl', 'link', 'link_url', 'note', 'company', 'name', 'reply', 'lyrics'];
// Les publicités ne sont pas bloquées : leur lien (site, WhatsApp, boutique…) fonctionne pour tout compte
// qui paie sa publicité (elle n'est affichée qu'une fois réellement payée, et l'équipe peut la retirer).
const LINK_EXEMPT = ['/api/admin', '/api/auth', '/api/import', '/api/payments', '/api/cinetpay', '/api/support', '/api/push', '/api/business-ads', '/api/advertise'];
const AD_PATHS = ['/api/business-ads', '/api/advertise']; // publicités : seuls les liens dangereux sont refusés
function linkGuard({ db, verifySessionToken }) {
  return async (req, res, next) => {
    try {
      const p = String(req.path || req.url || '').split('?')[0];
      if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !p.startsWith('/api/')) return next();
      const isAd = AD_PATHS.some((x) => p.startsWith(x));
      if (!isAd && LINK_EXEMPT.some((x) => p.startsWith(x))) return next();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const texts = LINK_FIELDS.map((k) => body[k]).filter((v) => typeof v === 'string' && v.length > 3);
      if (!texts.length) return next();
      // Liens d'arnaque (faux Eaji, liens raccourcis, adresses déguisées) : refusés pour tout le monde.
      const danger = dangerousLinks(texts.join('\n'));
      if (danger.length) return res.status(400).json({ code: 'lien_dangereux', blocked: [...new Set(danger.map((l) => l.host))].slice(0, 3), error: DANGER_LINK_MESSAGE });
      if (isAd) return next();
      const found = findLinks(texts.join('\n')).filter((l) => !isEajiLink(l));
      if (!found.length) return next();
      let creatorId = null;
      const token = String(req.headers.authorization || '').replace('Bearer ', '');
      if (token) { try { creatorId = verifySessionToken(token); } catch (e) { /* non connecté */ } }
      const base = typeof db === 'function' ? db() : db; // la base peut être créée après ce contrôle
      const business = creatorId ? Boolean(await base.query(
        "SELECT 1 FROM premium_subscriptions WHERE creator_id = $1 AND plan LIKE 'entreprise%' AND ends_at > now() LIMIT 1", [creatorId])) : false;
      if (business) return next(); // compte Entreprise : WhatsApp, Telegram et site internet permis
      return res.status(400).json({ code: 'lien_bloque', blocked: [...new Set(found.map((l) => l.host))].slice(0, 3), error: LINK_BLOCKED_MESSAGE });
    } catch (e) { return next(); }
  };
}

// ===================== IMPORT D'UNE VIDÉO DEPUIS UN LIEN =====================
const IMPORT_SITES = [
  ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['tiktok.com', 'TikTok'], ['facebook.com', 'Facebook'], ['fb.watch', 'Facebook'],
  ['fb.com', 'Facebook'], ['instagram.com', 'Instagram'], ['twitter.com', 'X (Twitter)'], ['x.com', 'X (Twitter)'], ['vimeo.com', 'Vimeo'],
  ['dailymotion.com', 'Dailymotion'], ['dai.ly', 'Dailymotion'], ['snapchat.com', 'Snapchat'], ['likee.video', 'Likee'], ['kwai.com', 'Kwai'],
  ['pinterest.com', 'Pinterest'], ['pin.it', 'Pinterest'], ['threads.net', 'Threads'], ['reddit.com', 'Reddit'], ['triller.co', 'Triller'],
];
function importSiteOf(url) {
  let u; try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|vm|vt)\./, '');
  const hit = IMPORT_SITES.find(([d]) => host === d || host.endsWith('.' + d));
  return hit ? { site: hit[1], url: u.toString() } : null;
}
const IMPORT_ERRORS = [
  [/Unsupported URL|is not a valid URL|No video formats/i, "Ce lien ne contient pas de vidéo téléchargeable. Copie le lien de la vidéo elle-même (bouton « Partager » → « Copier le lien »)."],
  [/Private video|private|login required|log in|Sign in to confirm|cookies/i, "Cette vidéo est privée ou le site demande une connexion : elle ne peut pas être téléchargée. Essaie une vidéo publique."],
  [/unavailable|removed|deleted|not found|404/i, "Cette vidéo n'existe plus ou n'est pas disponible dans ce pays."],
  [/larger than max-filesize|File is larger/i, 'Vidéo trop lourde (300 Mo au maximum).'],
  [/does not pass filter|duration/i, 'Vidéo trop longue : 60 minutes au maximum.'],
  [/geo|country/i, "Cette vidéo est bloquée dans le pays du serveur d'Eaji."],
  [/429|Too Many Requests|rate/i, 'Le site refuse les téléchargements pour le moment. Réessaie dans quelques minutes.'],
];
function importErrorText(stderr) {
  const hit = IMPORT_ERRORS.find(([re]) => re.test(stderr || ''));
  return hit ? hit[1] : 'Téléchargement impossible pour le moment. Vérifie le lien et réessaie.';
}

// Outil de téléchargement (yt-dlp) : variable YTDLP_PATH, sinon installé sur le serveur, sinon téléchargé
// automatiquement une seule fois depuis la page officielle du projet (GitHub).
let ytdlpPromise = null;
function ensureYtdlp() {
  if (ytdlpPromise) return ytdlpPromise;
  ytdlpPromise = (async () => {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
    try { if (spawnSync('yt-dlp', ['--version'], { timeout: 15000 }).status === 0) return 'yt-dlp'; } catch (e) { /* pas installé */ }
    const dir = path.join(require('os').tmpdir(), 'eaji-bin');
    const bin = path.join(dir, 'yt-dlp');
    if (fs.existsSync(bin)) return bin;
    fs.mkdirSync(dir, { recursive: true });
    const name = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
    const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`, { redirect: 'follow' });
    if (!r.ok) throw new Error('outil de téléchargement indisponible');
    const tmp = bin + '.part';
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, bin);
    return bin;
  })();
  ytdlpPromise.catch(() => { ytdlpPromise = null; });
  return ytdlpPromise;
}

function register({ app, db, requireAuth, requireAdminPrincipal, optionalViewerId, verifySessionToken, signSessionToken, notify, feedItems, security, createSession = async () => null }) {
  // ---------- petite limite d'essais en mémoire ----------
  const hits = new Map();
  const tooMany = (key, max, windowMs) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return list.length > max;
  };
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

  // ===================== CONNEXION PAR CODE QR =====================
  // 1) L'ordinateur demande un code ; 2) le téléphone connecté le scanne et confirme ; 3) l'ordinateur reçoit sa session.
  app.post('/api/auth/qr/start', async (req, res) => {
    if (tooMany(`qr:${req.ip}`, 40, 10 * 60 * 1000)) return res.status(429).json({ error: 'Trop de codes demandés. Attends quelques minutes.' });
    const secret = crypto.randomBytes(24).toString('base64url');
    const row = await db.query(
      `INSERT INTO qr_logins (secret_hash, user_agent, ip, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval) RETURNING id, expires_at`,
      [sha(secret), String(req.headers['user-agent'] || '').slice(0, 300), String(req.ip || '').slice(0, 64), QR_LIFETIME_S]);
    res.status(201).json({ id: row.id, secret, code: `${row.id}.${secret}`, expiresAt: row.expires_at, lifetimeSeconds: QR_LIFETIME_S });
  });
  async function qrRow(id, secret) {
    if (!UUID_RE.test(String(id || '')) || !secret) return null;
    const r = await db.query('SELECT *, expires_at < now() AS expired FROM qr_logins WHERE id = $1', [id]);
    if (!r) return null;
    const a = Buffer.from(r.secret_hash), b = Buffer.from(sha(secret));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? r : null;
  }
  // L'ordinateur demande où en est son code (toutes les 2 secondes).
  app.get('/api/auth/qr/:id/status', async (req, res) => {
    const r = await qrRow(req.params.id, req.query.secret);
    if (!r) return res.status(404).json({ status: 'inconnu', error: 'Code QR inconnu.' });
    if (r.denied) return res.json({ status: 'refuse' });
    if (r.consumed_at) return res.json({ status: 'utilise' });
    if (r.approved_by) {
      // La session n'est remise qu'une seule fois.
      const used = await db.query('UPDATE qr_logins SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING approved_by', [r.id]);
      if (!used) return res.json({ status: 'utilise' });
      const c = await db.query("SELECT session_version, account_status FROM creators WHERE id = $1", [used.approved_by]);
      if (!c || c.account_status !== 'actif') return res.json({ status: 'refuse' });
      // L'ordinateur apparaît dans « Mes connexions » du propriétaire (on peut le déconnecter à distance).
      const sid = await createSession(used.approved_by, req);
      return res.json({ status: 'approuve', creatorId: used.approved_by, token: signSessionToken(used.approved_by, { v: Number(c.session_version || 0), sid }) });
    }
    if (r.expired) return res.json({ status: 'expire' });
    res.json({ status: 'attente' });
  });
  // Le téléphone affiche l'ordinateur qui demande l'accès avant de confirmer (protection contre le vol de compte).
  function deviceLabel(ua) {
    const s = String(ua || '');
    const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Navigateur';
    const os = /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iPhone/iPad' : /Linux/.test(s) ? 'Linux' : 'appareil inconnu';
    return `${browser} sur ${os}`;
  }
  app.post('/api/auth/qr/:id/info', requireAuth, async (req, res) => {
    const r = await qrRow(req.params.id, req.body.secret);
    if (!r || r.expired || r.consumed_at || r.denied || r.approved_by) return res.status(404).json({ error: 'Ce code QR n\'est plus valable. Recharge la page sur l\'ordinateur.' });
    res.json({ device: deviceLabel(r.user_agent), createdAt: r.created_at, secondsLeft: Math.max(0, Math.round((new Date(r.expires_at) - Date.now()) / 1000)) });
  });
  app.post('/api/auth/qr/:id/approve', requireAuth, async (req, res) => {
    const r = await qrRow(req.params.id, req.body.secret);
    if (!r || r.expired || r.consumed_at || r.denied) return res.status(404).json({ error: 'Ce code QR n\'est plus valable. Recharge la page sur l\'ordinateur.' });
    const ok = await db.query('UPDATE qr_logins SET approved_by = $2, approved_at = now() WHERE id = $1 AND approved_by IS NULL AND NOT denied RETURNING id', [r.id, req.creatorId]);
    if (!ok) return res.status(409).json({ error: 'Ce code a déjà été utilisé.' });
    if (security && security.log) security.log('connexion_qr', 'info', { creatorId: req.creatorId, ip: r.ip, detail: `Ordinateur connecté par code QR (${deviceLabel(r.user_agent)})` }).catch(() => {});
    await notify(req.creatorId, 'securite', `💻 Ton compte vient d'être ouvert sur un ordinateur (${deviceLabel(r.user_agent)}) avec le code QR. Si ce n'est pas toi, change ton mot de passe.`, 's-profil', { inApp: true });
    res.json({ approved: true, device: deviceLabel(r.user_agent) });
  });
  app.post('/api/auth/qr/:id/deny', requireAuth, async (req, res) => {
    const r = await qrRow(req.params.id, req.body.secret);
    if (r) await db.query('UPDATE qr_logins SET denied = TRUE WHERE id = $1 AND approved_by IS NULL', [r.id]);
    res.json({ denied: true });
  });
  const qrClean = setInterval(() => { db.query("DELETE FROM qr_logins WHERE created_at < now() - interval '1 day'").catch(() => {}); }, 3600 * 1000);
  if (qrClean.unref) qrClean.unref();

  // ===================== FAVORIS ET « À REGARDER PLUS TARD » =====================
  app.post('/api/content/:id/save', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Publication introuvable.' });
    const kind = req.body.kind === 'plus_tard' ? 'plus_tard' : 'favori';
    const [item] = await feedItems(req.creatorId, null, req.params.id);
    if (!item) return res.status(404).json({ error: 'Publication introuvable.' });
    const exists = await db.query('SELECT 1 FROM content_saves WHERE creator_id = $1 AND content_id = $2 AND kind = $3', [req.creatorId, item.id, kind]);
    const want = typeof req.body.on === 'boolean' ? req.body.on : !exists;
    if (want && !exists) await db.query('INSERT INTO content_saves (creator_id, content_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.creatorId, item.id, kind]);
    if (!want && exists) await db.query('DELETE FROM content_saves WHERE creator_id = $1 AND content_id = $2 AND kind = $3', [req.creatorId, item.id, kind]);
    res.json({ saved: want, kind });
  });
  app.get('/api/saves', requireAuth, async (req, res) => {
    const kind = req.query.kind === 'plus_tard' ? 'plus_tard' : 'favori';
    const rows = await db.all('SELECT content_id, created_at FROM content_saves WHERE creator_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 100', [req.creatorId, kind]);
    const items = [];
    for (const r of rows) {
      const [item] = await feedItems(req.creatorId, null, r.content_id);
      if (item) items.push({ ...item, saved_at: r.created_at });
    }
    const counts = await db.all('SELECT kind, COUNT(*)::int AS n FROM content_saves WHERE creator_id = $1 GROUP BY kind', [req.creatorId]);
    res.json({ kind, items, counts: Object.fromEntries(counts.map((c) => [c.kind, c.n])) });
  });

  // ===================== REPUBLICATIONS =====================
  // Partager une publication d'un autre compte la publie aussi sur son compte. Les vues et l'argent
  // gagnés par la republication vont à Eaji (seule la publication originale rapporte à son auteur).
  async function repost(reposterId, contentId, text) {
    const [item] = await feedItems(reposterId, null, contentId);
    if (!item) return { status: 404, error: 'Publication introuvable.' };
    if (item.creator_id === reposterId) return { status: 400, error: 'C\'est déjà ta publication.' };
    const row = await db.query(
      `INSERT INTO content_reposts (content_id, reposter_id, text) VALUES ($1, $2, $3)
       ON CONFLICT (content_id, reposter_id) DO UPDATE SET text = COALESCE(EXCLUDED.text, content_reposts.text) RETURNING id, (xmax = 0) AS created`,
      [item.id, reposterId, text ? String(text).slice(0, 500) : null]);
    if (row.created) {
      const me = await db.query('SELECT name FROM creators WHERE id = $1', [reposterId]);
      await notify(item.creator_id, 'republication', `🔁 ${me ? me.name : 'Quelqu\'un'} a republié ta publication « ${String(item.title || '').slice(0, 60)} ».`, `content:${item.id}`);
    }
    return { status: row.created ? 201 : 200, repostId: row.id, created: row.created };
  }
  app.post('/api/content/:id/repost', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Publication introuvable.' });
    const r = await repost(req.creatorId, req.params.id, String(req.body.text || '').trim());
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.status(r.status).json({ reposted: true, repostId: r.repostId });
  });
  app.delete('/api/content/:id/repost', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Publication introuvable.' });
    await db.query('DELETE FROM content_reposts WHERE content_id = $1 AND reposter_id = $2', [req.params.id, req.creatorId]);
    res.json({ removed: true });
  });
  async function repostItems(viewerId, where, params, limit = 30) {
    const rows = await db.all(
      `SELECT r.id, r.content_id, r.reposter_id, r.text, r.created_at, r.view_count, rc.name AS reposter_name
       FROM content_reposts r JOIN creators rc ON rc.id = r.reposter_id
       WHERE rc.account_status = 'actif' AND ${where}
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = r.reposter_id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = r.reposter_id))
       ORDER BY r.created_at DESC LIMIT ${Number(limit)}`, params);
    const out = [];
    for (const r of rows) {
      const [item] = await feedItems(viewerId, null, r.content_id);
      if (item) out.push({ ...item, repost: { id: r.id, byId: r.reposter_id, byName: r.reposter_name, text: r.text, at: r.created_at, views: viewerId === r.reposter_id ? r.view_count : undefined } });
    }
    return out;
  }
  // Fil : republications des comptes suivis (et les miennes), glissées à leur date parmi les publications.
  async function mergeRepostsIntoFeed(viewerId, items) {
    if (!viewerId) return items;
    const reposts = await repostItems(viewerId,
      `(r.reposter_id = $1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = r.reposter_id)) AND r.created_at > now() - interval '30 days'`,
      [viewerId], 20).catch(() => []);
    // Une publication déjà présente dans le fil n'est pas répétée par sa republication.
    const seen = new Set(items.map((x) => x.id));
    const kept = [];
    for (const r of reposts) { if (!seen.has(r.id)) { seen.add(r.id); kept.push(r); } }
    reposts.length = 0; reposts.push(...kept);
    if (!reposts.length) return items;
    const out = [];
    let i = 0;
    for (const it of items) {
      while (i < reposts.length && new Date(reposts[i].repost.at) > new Date(it.created_at)) out.push(reposts[i++]);
      out.push(it);
    }
    while (i < reposts.length) out.push(reposts[i++]);
    return out;
  }
  app.get('/api/creators/:id/reposts', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Compte introuvable.' });
    const viewerId = optionalViewerId(req);
    res.json({ items: await repostItems(viewerId, 'r.reposter_id = $2', [viewerId, req.params.id], 50) });
  });
  // Vue comptée sur une republication : jamais dans les vues (ni la rémunération) de l'auteur ou du « republieur ».
  async function countRepostView(repostId, contentId, viewerKey, viewerId) {
    if (!UUID_RE.test(String(repostId || ''))) return false;
    const r = await db.query('SELECT id, reposter_id FROM content_reposts WHERE id = $1 AND content_id = $2', [repostId, contentId]);
    if (!r || r.reposter_id === viewerId) return false;
    const fresh = await db.query('INSERT INTO repost_view_log (repost_id, viewer_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING repost_id', [r.id, viewerKey]);
    if (fresh) await db.query('UPDATE content_reposts SET view_count = view_count + 1 WHERE id = $1', [r.id]);
    return Boolean(fresh);
  }
  app.get('/api/admin/reposts/stats', requireAdminPrincipal, async (req, res) => {
    const t = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM content_reposts) AS reposts,
              COALESCE((SELECT SUM(view_count) FROM content_reposts), 0)::int AS views,
              COALESCE((SELECT SUM(amount_usd) FROM revenue_ledger WHERE beneficiary = 'eaji' AND source LIKE '%\\_republication' ESCAPE '\\'), 0)::float AS money`);
    const top = await db.all(
      `SELECT r.view_count, r.created_at, c.title, rc.name AS reposter_name, oc.name AS author_name
       FROM content_reposts r JOIN content_items c ON c.id = r.content_id JOIN creators rc ON rc.id = r.reposter_id JOIN creators oc ON oc.id = c.creator_id
       ORDER BY r.view_count DESC, r.created_at DESC LIMIT 20`);
    res.json({ ...t, top });
  });

  // ===================== IMPORT D'UNE VIDÉO PAR LIEN =====================
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  db.query("UPDATE import_jobs SET status = 'echec', error = 'Serveur redémarré pendant le téléchargement : réessaie.' WHERE status IN ('attente', 'telechargement')").catch(() => {});
  const queue = [];
  let running = 0;
  const MAX_PARALLEL = Number(process.env.IMPORT_PARALLEL || 2);
  const progressOf = new Map();
  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      running++;
      runImport(job).catch(() => {}).finally(() => { running--; progressOf.delete(job.id); pump(); });
    }
  }
  async function runImport(job) {
    await db.query("UPDATE import_jobs SET status = 'telechargement' WHERE id = $1", [job.id]);
    let bin;
    try { bin = await ensureYtdlp(); }
    catch (e) {
      await db.query("UPDATE import_jobs SET status = 'echec', error = $2, finished_at = now() WHERE id = $1", [job.id, 'Le téléchargement par lien n\'est pas encore disponible sur le serveur. Réessaie plus tard.']);
      return;
    }
    const base = path.join(IMPORT_DIR, job.id);
    const args = ['--no-playlist', '--no-warnings', '--newline', '--restrict-filenames', '--no-part', '--no-mtime',
      '--max-filesize', String(IMPORT_MAX_BYTES), '--match-filter', `!duration | duration <= ${IMPORT_MAX_SECONDS}`,
      '-f', 'b[ext=mp4][height<=720]/b[height<=720]/b[ext=mp4]/b',
      '-o', `${base}.%(ext)s`, '--print', 'after_move:EAJIJSON %(.{title,duration,ext,filepath})j', job.url];
    await new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let info = null, err = '';
      const timer = setTimeout(() => { err += ' timeout'; child.kill('SIGKILL'); }, 15 * 60 * 1000);
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const pm = /\[download\]\s+([\d.]+)%/.exec(line);
          if (pm) progressOf.set(job.id, Math.min(99, Number(pm[1])));
          if (line.startsWith('EAJIJSON ')) { try { info = JSON.parse(line.slice(9)); } catch (e) { /* ligne coupée */ } }
        }
      });
      child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
      child.on('error', (e) => { err += ' ' + e.message; });
      child.on('close', async (code) => {
        clearTimeout(timer);
        if (buf.startsWith('EAJIJSON ')) { try { info = JSON.parse(buf.slice(9)); } catch (e) { /* rien */ } }
        try {
          const file = info && info.filepath && fs.existsSync(info.filepath) ? info.filepath
            : (fs.readdirSync(IMPORT_DIR).filter((f) => f.startsWith(job.id + '.')).map((f) => path.join(IMPORT_DIR, f))[0] || null);
          if (code !== 0 || !file) {
            await db.query("UPDATE import_jobs SET status = 'echec', error = $2, finished_at = now() WHERE id = $1", [job.id, importErrorText(err)]);
          } else {
            const size = fs.statSync(file).size;
            const ext = path.extname(file).slice(1).toLowerCase() || (info && info.ext) || 'mp4';
            await db.query(
              `UPDATE import_jobs SET status = 'pret', progress = 100, title = $2, duration_seconds = $3, ext = $4, size_bytes = $5, file_path = $6, finished_at = now() WHERE id = $1`,
              [job.id, String((info && info.title) || '').slice(0, 200) || null, info && Number(info.duration) > 0 ? Number(info.duration) : null, ext, size, file]);
          }
        } catch (e) {
          await db.query("UPDATE import_jobs SET status = 'echec', error = $2, finished_at = now() WHERE id = $1", [job.id, importErrorText(err)]).catch(() => {});
        }
        resolve();
      });
    });
  }
  app.post('/api/import/link', requireAuth, async (req, res) => {
    const hit = importSiteOf(req.body.url);
    if (!hit) return res.status(400).json({ error: 'Colle le lien d\'une vidéo Facebook, YouTube, TikTok, Instagram, X, Vimeo ou Dailymotion.' });
    if (req.body.rights !== true) return res.status(400).json({ error: 'Confirme que cette vidéo t\'appartient ou que tu as le droit de la publier.' });
    if (tooMany(`imp:${req.creatorId}`, 15, 60 * 60 * 1000)) return res.status(429).json({ error: 'Trop de téléchargements cette heure-ci (15 au maximum). Réessaie plus tard.' });
    const busy = await db.query("SELECT COUNT(*)::int AS n FROM import_jobs WHERE creator_id = $1 AND status IN ('attente', 'telechargement')", [req.creatorId]);
    if (busy.n >= 2) return res.status(429).json({ error: 'Attends la fin de tes téléchargements en cours.' });
    const job = await db.query('INSERT INTO import_jobs (creator_id, url, site) VALUES ($1, $2, $3) RETURNING id', [req.creatorId, hit.url.slice(0, 1000), hit.site]);
    queue.push({ id: job.id, url: hit.url });
    pump();
    res.status(202).json({ jobId: job.id, site: hit.site });
  });
  app.get('/api/import/:id', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Téléchargement introuvable.' });
    const j = await db.query('SELECT * FROM import_jobs WHERE id = $1 AND creator_id = $2', [req.params.id, req.creatorId]);
    if (!j) return res.status(404).json({ error: 'Téléchargement introuvable.' });
    const position = queue.findIndex((q) => q.id === j.id);
    res.json({ id: j.id, status: j.status, site: j.site, url: j.url, progress: j.status === 'telechargement' ? (progressOf.get(j.id) || 0) : Number(j.progress),
      title: j.title, durationSeconds: j.duration_seconds ? Number(j.duration_seconds) : null, ext: j.ext, sizeBytes: j.size_bytes ? Number(j.size_bytes) : null,
      error: j.error, queuePosition: position >= 0 ? position + 1 : 0 });
  });
  const MIME = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4a: 'audio/mp4', mp3: 'audio/mpeg', '3gp': 'video/3gpp' };
  app.get('/api/import/:id/file', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Téléchargement introuvable.' });
    const j = await db.query("SELECT * FROM import_jobs WHERE id = $1 AND creator_id = $2 AND status IN ('pret', 'recupere')", [req.params.id, req.creatorId]);
    if (!j || !j.file_path || !fs.existsSync(j.file_path)) return res.status(404).json({ error: 'Fichier plus disponible : relance le téléchargement.' });
    const size = fs.statSync(j.file_path).size;
    res.setHeader('Content-Type', MIME[j.ext] || 'application/octet-stream');
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    const stream = fs.createReadStream(j.file_path);
    stream.on('error', () => { try { res.end(); } catch (e) { /* fermé */ } });
    stream.on('end', () => { db.query("UPDATE import_jobs SET status = 'recupere' WHERE id = $1 AND status = 'pret'", [j.id]).catch(() => {}); });
    stream.pipe(res);
  });
  // Les fichiers téléchargés sont effacés du serveur au bout de 2 heures.
  const impClean = setInterval(async () => {
    try {
      const old = await db.all("SELECT id, file_path FROM import_jobs WHERE file_path IS NOT NULL AND created_at < now() - interval '2 hours'");
      for (const o of old) {
        try { fs.unlinkSync(o.file_path); } catch (e) { /* déjà effacé */ }
        await db.query('UPDATE import_jobs SET file_path = NULL WHERE id = $1', [o.id]);
      }
      await db.query("DELETE FROM import_jobs WHERE created_at < now() - interval '30 days'");
    } catch (e) { /* base indisponible */ }
  }, 30 * 60 * 1000);
  if (impClean.unref) impClean.unref();

  return { repost, mergeRepostsIntoFeed, countRepostView, repostItems, importSiteOf };
}

module.exports = { MIGRATIONS, register, linkGuard, phishGuard, phishReason, dangerousLinks, findLinks, blockedLinks, isEajiLink, importSiteOf, LINK_BLOCKED_MESSAGE, PHISH_MESSAGE };
