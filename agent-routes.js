// Eaji — l'« Agent Eaji » : un assistant automatique qui veille quand l'équipe est absente ou dort.
//
//  1. Sécurité : repère les tentatives de piratage (mots de passe essayés en masse, attaques de
//     l'administration, robots qui cherchent des failles) et BLOQUE la source. Seul un administrateur
//     peut lever un blocage (onglet « 🤖 Agent » ou « Menaces » du tableau d'administration).
//  2. Aide : répond aux utilisateurs (compte, connexion, paiements…) dans « Posez votre question » et
//     dans « Contacter l'équipe Eaji ». Réponses préparées gratuites ; avec une clé ANTHROPIC_API_KEY
//     sur le serveur, c'est une vraie IA (Claude) qui répond, dans la langue de la personne.
//  3. Modération : met de côté une publication signalée plusieurs fois ; avec la clé IA, regarde les
//     photos et vidéos en attente (nudité, violence) et décide ; suspend les faux comptes évidents.
//     Tout ce que fait l'agent est noté et peut être annulé par l'administrateur.
//  4. Montage IA (photos, vidéos, musique, voix off, texte en image, texte en vidéo) : 2 par semaine (gratuit),
//     5 par semaine (Premium) ; abonnement Montage : 10 par jour, jusqu'à 50 / 200 / 1 000 (1 mois / 3 mois / 1 an).
//
// Les règles internes de rémunération ne sont jamais données à l'IA ni aux utilisateurs.
const crypto = require('crypto');

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS agent_actions (
     id BIGSERIAL PRIMARY KEY,
     kind TEXT NOT NULL,
     target_type TEXT NOT NULL,
     target_id TEXT NOT NULL,
     ref_id TEXT,
     detail TEXT NOT NULL,
     undone_at TIMESTAMPTZ,
     undone_by UUID,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS agent_actions_time ON agent_actions (created_at DESC)',
  `CREATE TABLE IF NOT EXISTS agent_trusted_ips (ip TEXT PRIMARY KEY, last_seen TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS agent_chats (
     id BIGSERIAL PRIMARY KEY,
     creator_id UUID REFERENCES creators(id) ON DELETE SET NULL,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     source TEXT NOT NULL,
     escalated BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS agent_chats_time ON agent_chats (created_at DESC)',
  // « robots » : le blocage ne touche que les programmes (pas l'application Eaji d'un vrai téléphone),
  // car en Afrique beaucoup de téléphones partagent la même adresse internet chez l'opérateur.
  'ALTER TABLE security_blocklist ADD COLUMN IF NOT EXISTS agent_scope TEXT',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS agent_checked_at TIMESTAMPTZ',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS agent_note TEXT',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS agent_exempt BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS agent_exempt BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS by_agent BOOLEAN NOT NULL DEFAULT FALSE',
  `CREATE TABLE IF NOT EXISTS montage_uses (
     id BIGSERIAL PRIMARY KEY,
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     paid BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS montage_uses_creator ON montage_uses (creator_id)',
  'ALTER TABLE montage_uses ADD COLUMN IF NOT EXISTS subscription_id UUID',
  'ALTER TABLE montage_uses ADD COLUMN IF NOT EXISTS kind TEXT',
  'CREATE INDEX IF NOT EXISTS montage_uses_sub ON montage_uses (subscription_id)',
];

const MONTAGE_FREE = 2; // compte gratuit, par semaine
const MONTAGE_WEEK = { gratuit: 2, premium: 5 };
const DEFAULT_SETTINGS = { securite: true, aide: true, support_auto: true, moderation: true, faux_comptes: true };
const WHATSAPP = '+243 850 171 480';

// Robots qui cherchent des failles : fichiers de configuration, WordPress, injections…
const PROBE_RE = /(\/\.env\b|\/\.git\b|\/wp-(admin|login|content|includes)|xmlrpc\.php|phpmyadmin|\/cgi-bin\/|\/etc\/passwd|\.(php|asp|aspx|jsp)(\?|$)|\/boaform|\/HNAP1|\/actuator\b|\/vendor\/phpunit|\/server-status|\/\.aws|\/\.ssh)/i;
const INJECT_RE = /(\bunion\s+(all\s+)?select\b|'\s*or\s+'?\d+'?\s*=\s*'?\d+|;\s*drop\s+table\b|<script\b|\.\.\/\.\.\/|\binformation_schema\b|\bsleep\s*\(\s*\d+\s*\)|\bbenchmark\s*\(|\$where\b|\$ne\b)/i;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ---------- L'IA (Claude d'Anthropic), seulement si une clé est donnée au serveur ----------
const aiReady = () => Boolean(process.env.ANTHROPIC_API_KEY);
async function askClaude({ system, messages, maxTokens = 600, timeoutMs = 20000 }) {
  if (!aiReady()) return null;
  const res = await fetch(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': process.env.ANTHROPIC_VERSION || '2026-10-21', 'content-type': 'application/json',
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}) },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`IA ${res.status} : ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
const jsonIn = (t) => { try { const m = String(t || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } };

// ---------- Connaissances de l'assistant (réponses préparées) ----------
// Chaque sujet : mots-clés (plusieurs langues) et réponse ; « fn » quand la réponse dépend du compte.
const KB = [
  { id: 'mot_de_passe', k: ['oubli', 'mot de passe', 'password', 'mdp', 'forgot', 'reinitialis', 'perdu', 'lost', 'contrasena', 'senha', 'nenosiri'],
    a: "Appuie sur « Mot de passe oublié ? » sur l'écran de connexion. Dans « Nouveau mot de passe automatique », écris ton nom complet (comme à l'inscription), ton numéro ou ton email, et ta date de naissance : tu reçois tout de suite un nouveau mot de passe. Ensuite, choisis le tien dans Profil → Sécurité." },
  { id: 'code', k: ['code', 'recu', 'recoi', 'arrive', 'spam', 'otp', 'confirmation', 'verification', 'chiffres', 'receive'],
    a: "Si tu te connectes avec ton email, le code part par email : regarde aussi dans le dossier « Spam » ou « Courrier indésirable », et attends une minute. Le plus simple : connecte-toi avec ton numéro de téléphone, le code s'affiche alors directement à l'écran. Tu peux aussi appuyer sur « Recevoir un nouveau code »." },
  { id: 'connexion', k: ['connect', 'connexion', 'login', 'entrer', 'incorrect', 'aucun compte', 'introuvable', 'trop de tentatives', 'acceder', 'acces'],
    a: "Pour te connecter : écris ton numéro avec l'indicatif du pays (exemple +243 812 345 678) ou ton email, puis ton mot de passe (attention aux majuscules). Après plusieurs essais ratés, le compte est protégé 15 minutes : attends un peu. Si tu as oublié le mot de passe, utilise « Mot de passe oublié ? »." },
  { id: 'inscription', k: ['creer', 'inscri', 'register', 'sign up', 'nouveau compte', 'ouvrir un compte', 'create'],
    a: "Appuie sur « Créer mon compte » : 1) nom complet, ville et date de naissance ; 2) pays, numéro de téléphone (l'indicatif suit le pays), mot de passe et email facultatif ; 3) photo de profil (facultative), type de contenu, langue, puis accepte les conditions." },
  { id: 'suspendu', k: ['suspendu', 'suspend', 'desactive', 'banni', 'banned', 'ferme'],
    fn: (c) => c && c.blocked ? null : `Un compte suspendu ne peut plus se connecter. Si tu penses que c'est une erreur, écris à l'administrateur Eaji sur WhatsApp : ${WHATSAPP}. Je peux aussi transmettre ta demande à l'équipe.`, escalate: true },
  { id: 'paiement', k: ['paiement', 'payer', 'paye', 'payment', 'mobile money', 'orange money', 'm pesa', 'mpesa', 'airtel', 'debite', 'argent', 'carte', 'paypal', 'transaction', 'abonnement'],
    fn: (c) => paymentAnswer(c) },
  { id: 'retrait', k: ['retrait', 'retirer', 'gains', 'withdraw', 'versement', 'remuneration', 'payout', 'solde'],
    fn: (c) => withdrawalAnswer(c) },
  { id: 'premium', k: ['premium', 'essai', 'trial', 'badge'],
    a: "Le Premium coûte 10 $ par mois, 20 $ pour 3 mois ou 100 $ pour un an. L'essai Premium à 2 $ le premier mois est possible une seule fois, pour un compte qui n'a jamais eu le Premium. Abonne-toi dans l'onglet Paiements." },
  { id: 'monetisation', k: ['monetis', 'gagner', 'earn', '1000 abonnes', '1 000', 'remunere', 'payer les createurs'],
    a: "Pour être payé sur tes contenus, il faut avoir au moins 1 000 abonnés et 1 000 vues, avoir le Premium, et habiter un pays où la monétisation est ouverte (Afrique, Caraïbes et pays en développement). Avec le compte gratuit, tu reçois déjà les cadeaux de tes lives." },
  { id: 'montage', k: ['montage', 'monter', 'editer', 'video ia', 'editeur', 'montage ia'],
    a: `L'éditeur (filtres, musique, voix off, textes) est gratuit. Le « Montage IA » d'Eajimmy AI fait tout seul tous les montages : photos, vidéos, musique, voix off, texte en image, texte en vidéo avec voix off et musique. Compte gratuit : 2 montages par semaine ; Premium : 5 par semaine. Montages jusqu'à 1 min 30, ou jusqu'à 3 minutes avec l'abonnement Montage : 10 montages par jour, jusqu'à 50 au total pour 1 mois (10 $), 200 pour 3 mois (30 $) ou 1 000 pour un an (100 $). Pour toutes les autres questions (même hors de l'application), utilise « Discuter avec Eajimmy AI » dans l'Accueil. Ouvre l'onglet Accueil → « Eajimmy AI », ou Contenu → « 🤖 Montage IA ».` },
  { id: 'publicite', k: ['publicite', 'annonce', 'pub', 'sponsor', 'entreprise', 'advert'],
    a: "Pour faire de la publicité : Contenu → « Publicité pour entreprises ». Tu choisis où la montrer (une ville, un pays, un continent ou partout), la durée (7 jours 10 $, 30 jours 30 $, 90 jours 75 $), puis tu ajoutes ta bannière ou ta vidéo." },
  { id: 'signaler', k: ['signal', 'choquant', 'nudite', 'nu ', 'porn', 'violence', 'arnaque', 'faux compte', 'harcel', 'report', 'fake'],
    a: "Sous chaque publication, appuie sur « Signaler ». Une publication signalée par plusieurs personnes est mise de côté automatiquement en attendant la vérification, et les faux comptes évidents sont suspendus. Tu peux aussi bloquer un compte depuis son profil." },
  { id: 'supprimer', k: ['supprimer mon compte', 'effacer mon compte', 'delete account', 'fermer mon compte', 'supprimer le compte'],
    a: "Pour supprimer ton compte, la demande passe par l'équipe Eaji (pour vérifier que c'est bien toi). Je peux la transmettre maintenant.", escalate: true },
  { id: 'langue', k: ['langue', 'language', 'anglais', 'english', 'lingala', 'swahili', 'idioma'],
    a: "Touche 🌐 en haut de l'écran de connexion, ou change la langue dans ton Profil : toute l'application change de langue." },
  { id: 'installer', k: ['installer', 'install', 'telecharger l application', 'ecran d accueil', 'play store', 'download'],
    a: "Sur l'écran de connexion, appuie sur « 📲 Installer l'application Eaji ». Sur Android (Chrome) : menu ⋮ → « Installer l'application ». Sur iPhone (Safari) : bouton Partager → « Sur l'écran d'accueil »." },
  { id: 'humain', k: ['humain', 'personne', 'administrateur', 'admin', 'equipe', 'whatsapp', 'parler a', 'agent humain', 'support', 'human'],
    a: `D'accord, je peux transmettre ta demande à l'équipe Eaji : elle te répond dans « Contacter l'équipe Eaji » (Profil). Tu peux aussi écrire sur WhatsApp : ${WHATSAPP}.`, escalate: true },
];
const STATUS_FR = { en_attente: 'en attente de confirmation', confirme: 'confirmé', refuse: 'refusé', annule: 'annulé' };
function paymentAnswer(c) {
  if (!c) return "Connecte-toi d'abord : je pourrai alors regarder tes paiements. En général : après avoir choisi mobile money, valide la demande qui arrive sur ton téléphone avec ton code PIN. Le paiement est confirmé en quelques minutes.";
  const p = c.payments && c.payments[0];
  if (!p) return "Je ne vois aucun paiement sur ton compte pour le moment. Pour payer : onglet Paiements, choisis ce que tu veux (Premium, publicité…), puis mobile money, carte ou PayPal.";
  const what = `${p.label} (${p.amount} $, réf. ${p.reference}, le ${p.date})`;
  if (p.status === 'confirme') return `Ton dernier paiement est bien confirmé : ${what}. Si quelque chose ne s'est pas activé, dis-le-moi et je préviens l'équipe.`;
  if (p.status === 'en_attente') return `Ton dernier paiement est encore en attente de confirmation : ${what}. Sur mobile money, il faut valider la demande reçue sur ton téléphone avec ton code PIN. Si ton argent a été retiré mais que le paiement reste en attente plus de 30 minutes, je transmets à l'équipe pour vérifier.`;
  return `Ton dernier paiement n'a pas abouti (${STATUS_FR[p.status] || p.status}) : ${what}. Tu peux réessayer depuis l'onglet Paiements. Si ton argent a été retiré quand même, je transmets à l'équipe avec la référence.`;
}
function withdrawalAnswer(c) {
  if (!c) return "Connecte-toi d'abord : je pourrai voir tes demandes de retrait. Tes gains se trouvent dans l'onglet Paiements, avec le bouton pour demander un retrait vers ton mobile money.";
  const w = c.withdrawals && c.withdrawals[0];
  if (!w) return "Tes gains se trouvent dans l'onglet Paiements (« Mes gains »). Tu peux y demander un retrait vers ton mobile money ; la demande est vérifiée puis envoyée.";
  const st = { en_attente: 'en cours de vérification', paye: 'payée', refuse: 'refusée' }[w.status] || w.status;
  return `Ta dernière demande de retrait (${w.amount} $, le ${w.date}) est ${st}.${w.status === 'refuse' ? ' Si tu ne comprends pas pourquoi, je transmets à l\'équipe.' : ''}`;
}
function detectTopic(text) {
  const t = ' ' + norm(text) + ' ';
  let best = null, top = 0;
  for (const e of KB) {
    let sc = 0;
    for (const k of e.k) { const n = norm(k); if (n && t.includes(n.length <= 3 ? ` ${n} ` : n)) sc += n.length; }
    if (sc > top) { top = sc; best = e; }
  }
  return best;
}

function register({ app, db, security, notify = async () => {}, notifyAdmins = async () => {}, requireAuth, requireAdmin, requireAdminPrincipal,
  optionalViewerId, decodeToken, isLeader = () => true, rateLimit, createDownloadUrl, frames, businessUntil = async () => null, MONTAGE_PLANS = {} }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ---------- Réglages (l'administrateur principal peut couper un module) ----------
  let settingsCache = { at: 0, v: DEFAULT_SETTINGS };
  async function settings() {
    if (Date.now() - settingsCache.at < 15000) return settingsCache.v;
    const row = await db.query("SELECT value FROM app_settings WHERE key = 'agent_settings'").catch(() => null);
    let v = { ...DEFAULT_SETTINGS };
    try { if (row) v = { ...v, ...JSON.parse(row.value) }; } catch (e) { /* valeur abîmée : réglages par défaut */ }
    settingsCache = { at: Date.now(), v };
    return v;
  }
  async function act(kind, targetType, targetId, detail, refId = null) {
    const r = await db.query('INSERT INTO agent_actions (kind, target_type, target_id, ref_id, detail) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [kind, targetType, String(targetId), refId == null ? null : String(refId), short(detail, 500)]).catch(() => null);
    return r && r.id;
  }

  // ==================== 1. SÉCURITÉ ====================
  let blocks = { at: 0, ips: new Map(), devices: new Map() };
  async function loadBlocks(force) {
    if (!force && Date.now() - blocks.at < 20000) return blocks;
    const rows = await db.all('SELECT ip_address, device_fingerprint, agent_scope FROM security_blocklist').catch(() => null);
    if (!rows) return blocks;
    const ips = new Map(), devices = new Map();
    rows.forEach((r) => { if (r.ip_address) ips.set(r.ip_address, r.agent_scope || 'total'); if (r.device_fingerprint) devices.set(r.device_fingerprint, r.agent_scope || 'total'); });
    blocks = { at: Date.now(), ips, devices };
    return blocks;
  }
  // Adresse d'où un administrateur s'est connecté (30 derniers jours) : jamais bloquée par l'agent.
  async function trusted(ip) {
    const r = await db.query("SELECT 1 FROM agent_trusted_ips WHERE ip = $1 AND last_seen > now() - interval '30 days'", [ip]).catch(() => null);
    return Boolean(r);
  }
  async function blockSource({ ip = null, device = null, scope = 'robots', reason }) {
    if (!(await settings()).securite) return null;
    if (ip && await trusted(ip)) return null;
    const exists = await db.query('SELECT id FROM security_blocklist WHERE ($1::text IS NOT NULL AND ip_address = $1) OR ($2::text IS NOT NULL AND device_fingerprint = $2)', [ip, device]).catch(() => null);
    if (exists) return null;
    const b = await db.query('INSERT INTO security_blocklist (ip_address, device_fingerprint, reason, agent_scope) VALUES ($1, $2, $3, $4) RETURNING id',
      [ip, device, short('🤖 Eajimmy AI : ' + reason, 200), scope]).catch(() => null);
    if (!b) return null;
    await act('blocage', ip ? 'ip' : 'appareil', ip || device, reason, b.id);
    if (security) await security.log('agent_blocage', 'critique', { ip, device, detail: `🤖 Eajimmy AI : ${ip ? 'adresse ' + ip : 'appareil'} bloquée — ${reason}` });
    await loadBlocks(true);
    return b.id;
  }

  const strikes = new Map();
  const trustSeen = new Map();
  function guard() {
    return async (req, res, next) => {
      const ip = req.ip;
      let url = req.originalUrl || req.url || '';
      try { url = decodeURIComponent(url); } catch (e) { /* adresse mal encodée : on garde telle quelle */ }
      // Body des connexions : les champs ne doivent pas contenir d'injection.
      const authPath = /^\/api\/(auth|admin\/auth)\//.test(req.path);
      const bodyBad = authPath && req.body && typeof req.body === 'object'
        && ['identifier', 'email', 'phone', 'password', 'code', 'name'].some((f) => typeof req.body[f] === 'string' && INJECT_RE.test(req.body[f]));
      if (PROBE_RE.test(req.path) || INJECT_RE.test(url) || bodyBad) {
        const list = (strikes.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
        list.push(Date.now()); strikes.set(ip, list);
        if (strikes.size > 20000) strikes.clear();
        if (list.length >= 3) blockSource({ ip, scope: 'total', reason: 'Robot qui cherche des failles (fichiers secrets, WordPress, injections)' }).catch(() => {});
        return res.status(404).json({ error: 'Introuvable.' });
      }
      if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
      const token = String(req.headers.authorization || '').replace('Bearer ', '');
      let tok = null;
      if (token) { try { tok = decodeToken(token); } catch (e) { tok = null; } }
      // Administrateur : toujours autorisé (pour pouvoir débloquer), et son adresse devient « de confiance ».
      if (tok && tok.typ === 'admin') {
        if (Date.now() - (trustSeen.get(ip) || 0) > 60 * 60 * 1000) {
          trustSeen.set(ip, Date.now());
          db.query('INSERT INTO agent_trusted_ips (ip) VALUES ($1) ON CONFLICT (ip) DO UPDATE SET last_seen = now()', [ip]).catch(() => {});
        }
        return next();
      }
      const b = await loadBlocks();
      const ipScope = b.ips.get(ip), devScope = req.deviceKey ? b.devices.get(req.deviceKey) : null;
      if (!ipScope && !devScope) return next();
      // Adresse bloquée mais téléphone connecté à son compte (réseau partagé) : il continue, sauf si son appareil est bloqué.
      if (!devScope && tok && tok.sub) return next();
      // Blocage « robots » : l'application Eaji d'un vrai téléphone passe ; les programmes non.
      if (!devScope && ipScope === 'robots' && req.deviceKey) return next();
      return res.status(403).json({ code: 'bloque_securite',
        error: `Accès bloqué par la sécurité d'Eaji (activité suspecte). Seul l'administrateur peut le débloquer : écris-lui sur WhatsApp au ${WHATSAPP}.` });
    };
  }

  // Surveillance toutes les minutes : essais de mots de passe en masse, attaques de l'administration.
  async function securityTick() {
    if (!(await settings()).securite) return;
    const logins = await db.all(
      `SELECT ip_address AS ip, COUNT(*)::int AS fails, COUNT(DISTINCT COALESCE(creator_id::text, identifier))::int AS accounts
       FROM security_events WHERE kind = 'connexion_echouee' AND created_at > now() - interval '15 minutes' AND ip_address IS NOT NULL
       GROUP BY ip_address HAVING COUNT(*) >= 20 OR COUNT(DISTINCT COALESCE(creator_id::text, identifier)) >= 8`).catch(() => []);
    for (const r of logins) {
      await blockSource({ ip: r.ip, scope: r.fails >= 60 ? 'total' : 'robots',
        reason: `${r.fails} mots de passe faux sur ${r.accounts} compte(s) en 15 minutes (vol de comptes)` });
    }
    const codes = await db.all(
      `SELECT ip_address AS ip, COUNT(*)::int AS n FROM security_events WHERE kind = 'code_faux' AND created_at > now() - interval '15 minutes'
       AND ip_address IS NOT NULL GROUP BY ip_address HAVING COUNT(*) >= 15`).catch(() => []);
    for (const r of codes) await blockSource({ ip: r.ip, reason: `${r.n} codes de confirmation faux en 15 minutes (devinette de codes)` });
    const admin = await db.all(
      `SELECT ip_address AS ip, COUNT(*)::int AS n FROM security_events WHERE kind = 'admin_connexion_echouee' AND created_at > now() - interval '1 hour'
       AND ip_address IS NOT NULL GROUP BY ip_address HAVING COUNT(*) >= 5`).catch(() => []);
    for (const r of admin) await blockSource({ ip: r.ip, scope: 'total', reason: `${r.n} essais de mot de passe sur l'administration en 1 heure` });
  }

  // ==================== 3. MODÉRATION ET FAUX COMPTES ====================
  const NUDE_REASON = "\\m(nu|nue|nus|nues|nudite|nudité|sex\\w*|porn\\w*|nsfw|naked|nude|xxx|seins|obscene)\\M";
  async function hideReported() {
    const rows = await db.all(
      `SELECT c.id, c.creator_id, c.title, COUNT(DISTINCT r.reported_by)::int AS n, string_agg(DISTINCT r.reason, ' | ') AS reasons
       FROM content_reports r JOIN content_items c ON c.id = r.content_id
       WHERE c.status = 'actif' AND NOT c.agent_exempt AND r.reported_by IS NOT NULL AND r.created_at > now() - interval '7 days'
       GROUP BY c.id, c.creator_id, c.title
       HAVING COUNT(DISTINCT r.reported_by) >= 3 OR (COUNT(DISTINCT r.reported_by) >= 2 AND bool_or(r.reason ~* $1))`, [NUDE_REASON]).catch(() => []);
    for (const c of rows) {
      const done = await db.query("UPDATE content_items SET status = 'en_revue', agent_checked_at = NULL, agent_note = $2 WHERE id = $1 AND status = 'actif' RETURNING id",
        [c.id, `Signalée ${c.n} fois : ${short(c.reasons, 300)}`]);
      if (!done) continue;
      await act('masquage', 'publication', c.id, `« ${short(c.title, 80)} » mise de côté : signalée par ${c.n} personnes (${short(c.reasons, 200)})`);
      await notify(c.creator_id, 'publication', `⏸️ Ta publication « ${short(c.title, 60)} » a été mise de côté après plusieurs signalements. L'équipe Eaji va la vérifier.`, 's-contenu');
      notifyAdmins({ title: '🤖 Agent : publication mise de côté', body: short(c.title, 80), link: 'admin:v-agent', kind: 'moderation', permission: 'moderer_contenu' });
    }
  }
  // Regarde les photos / vidéos en attente avec l'IA (seulement si la clé est donnée).
  async function imagesOf(c) {
    const out = [];
    const grab = async (key) => {
      if (!key) return;
      const url = await createDownloadUrl(key).catch(() => null);
      if (!url) return;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      const type = r && r.headers.get('content-type') || '';
      if (!r || !r.ok || !/^image\/(jpeg|png|webp|gif)/.test(type)) return;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4.5 * 1024 * 1024) return;
      out.push({ type: type.split(';')[0], data: buf.toString('base64') });
    };
    const video = ['video_courte', 'video_longue', 'film', 'telechargement', 'live'].includes(c.content_type);
    if (video && frames && c.storage_url) {
      const url = await createDownloadUrl(c.storage_url).catch(() => null);
      const d = Number(c.duration_seconds) || 0;
      const list = url ? await frames(url, d > 4 ? [1, d * 0.5, d * 0.85] : [0.5]).catch(() => []) : [];
      list.forEach((b) => out.push({ type: 'image/jpeg', data: b.toString('base64') }));
    }
    if (!out.length && ['photo', 'publication'].includes(c.content_type) && c.storage_url) await grab(c.storage_url);
    if (!out.length) await grab(c.thumb_key);
    return out.slice(0, 3);
  }
  async function reviewPending() {
    if (!aiReady()) return;
    const items = await db.all(
      `SELECT c.id, c.creator_id, c.title, c.content_type, c.storage_url, c.thumb_key, c.duration_seconds, c.agent_note
       FROM content_items c WHERE c.status = 'en_revue' AND c.agent_checked_at IS NULL AND NOT c.agent_exempt ORDER BY c.created_at LIMIT 5`).catch(() => []);
    for (const c of items) {
      await db.query('UPDATE content_items SET agent_checked_at = now() WHERE id = $1', [c.id]);
      const imgs = await imagesOf(c).catch(() => []);
      if (!imgs.length && c.storage_url) continue; // rien à regarder : l'équipe décidera
      let v = null;
      try {
        v = jsonIn(await askClaude({
          system: "Tu es le modérateur automatique d'Eaji, un réseau social. Tu regardes une publication (images tirées de la photo ou de la vidéo, et son titre). "
            + "Réponds UNIQUEMENT par un objet JSON : {\"verdict\": \"ok\" | \"nudite\" | \"sexuel\" | \"violence\" | \"danger\" | \"doute\", \"raison\": \"une phrase en français\"}. "
            + "« nudite » : sexe, seins ou fesses nus visibles. « sexuel » : acte ou pose sexuelle. « violence » : sang, blessures graves, cruauté. "
            + "« danger » : armes pointées sur quelqu'un, drogue, incitation à la haine ou au suicide. Maillot de bain, sport, art non sexuel : « ok ». Si tu n'es pas sûr : « doute ».",
          messages: [{ role: 'user', content: [...imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.type, data: i.data } })),
            { type: 'text', text: `Titre : ${short(c.title, 500)}` }] }],
          maxTokens: 200,
        }));
      } catch (e) { console.warn('[Eaji] Agent : vérification IA impossible :', e.message); continue; }
      if (!v || !v.verdict) continue;
      const reported = Boolean(c.agent_note);
      const why = short(v.raison || '', 200);
      if (['nudite', 'sexuel', 'violence', 'danger'].includes(v.verdict)) {
        await db.query("UPDATE content_items SET status = 'retire', agent_note = $2 WHERE id = $1", [c.id, `IA : ${v.verdict} — ${why}`]);
        await act('retrait', 'publication', c.id, `« ${short(c.title, 80)} » retirée par l'IA (${v.verdict}) : ${why}`);
        await notify(c.creator_id, 'publication', `🚫 Ta publication « ${short(c.title, 60)} » a été retirée : elle ne respecte pas les règles d'Eaji (${v.verdict === 'violence' ? 'violence' : v.verdict === 'danger' ? 'contenu dangereux' : 'nudité ou contenu sexuel'}). Si c'est une erreur, écris à l'équipe Eaji.`, 's-contenu');
        notifyAdmins({ title: '🤖 Agent : publication retirée', body: `${short(c.title, 60)} — ${v.verdict}`, link: 'admin:v-agent', kind: 'moderation', permission: 'moderer_contenu' });
      } else if (v.verdict === 'ok' && !reported) {
        await db.query("UPDATE content_items SET status = 'actif', agent_note = $2 WHERE id = $1", [c.id, `IA : rien de choquant — ${why}`]);
        await act('validation', 'publication', c.id, `« ${short(c.title, 80)} » vérifiée par l'IA et mise en ligne : ${why}`);
        await notify(c.creator_id, 'publication', `✅ Ta publication « ${short(c.title, 60)} » a été vérifiée : elle est maintenant visible.`, 's-contenu');
      } else {
        await db.query('UPDATE content_items SET agent_note = $2 WHERE id = $1', [c.id, short(`${c.agent_note ? c.agent_note + ' · ' : ''}IA : ${v.verdict} — ${why}`, 600)]);
      }
    }
  }
  async function suspend(id, reason) {
    const c = await db.query(
      "UPDATE creators SET account_status = 'suspendu', session_version = COALESCE(session_version, 0) + 1 WHERE id = $1 AND account_status = 'actif' AND NOT agent_exempt RETURNING id, name",
      [id]).catch(() => null);
    if (!c) return false;
    await act('suspension', 'compte', id, `${c.name} suspendu : ${reason}`);
    notifyAdmins({ title: '🤖 Agent : compte suspendu', body: `${c.name} — ${short(reason, 100)}`, link: 'admin:v-agent', kind: 'securite', permission: 'gerer_comptes_utilisateurs' });
    return true;
  }
  async function fakeAccounts() {
    // a) Beaucoup de nouveaux comptes sur le même téléphone en 2 jours : on garde le premier.
    const farms = await db.all(
      `SELECT d.device_key, array_agg(c.id::text ORDER BY c.created_at) AS ids FROM device_links d JOIN creators c ON c.id = d.creator_id
       WHERE c.created_at > now() - interval '48 hours' GROUP BY d.device_key HAVING COUNT(*) >= 4`).catch(() => []);
    for (const f of farms) for (const id of f.ids.slice(1)) await suspend(id, `${f.ids.length} comptes créés sur le même téléphone en 2 jours (faux comptes)`);
    // b) Nom qui imite l'équipe Eaji (comptes créés depuis la mise en route de l'agent).
    let since = await db.query("SELECT value FROM app_settings WHERE key = 'agent_started_at'").catch(() => null);
    if (!since) {
      await db.query("INSERT INTO app_settings (key, value) VALUES ('agent_started_at', $1) ON CONFLICT (key) DO NOTHING", [new Date().toISOString()]).catch(() => {});
      since = { value: new Date().toISOString() };
    }
    const fresh = await db.all("SELECT id, name FROM creators WHERE account_status = 'actif' AND NOT agent_exempt AND created_at > $1::timestamptz", [since.value]).catch(() => []);
    for (const c of fresh) {
      const n = ' ' + norm(c.name) + ' ';
      if (/ (eaji|administrateur|administrator|moderateur|moderator) /.test(n) || / (support|service client|equipe) /.test(n) && n.includes('eaji')) {
        await suspend(c.id, `nom « ${short(c.name, 60)} » qui imite l'équipe Eaji (usurpation)`);
      }
    }
    // c) Robots d'envoi en masse (messages privés à des dizaines de personnes, commentaires en rafale).
    const dm = await db.all(
      `SELECT sender_id::text AS id, COUNT(DISTINCT recipient_id)::int AS n FROM direct_messages WHERE created_at > now() - interval '1 hour'
       GROUP BY sender_id HAVING COUNT(DISTINCT recipient_id) >= 30`).catch(() => []);
    for (const r of dm) if (!(await businessUntil(r.id))) await suspend(r.id, `messages privés envoyés à ${r.n} personnes en 1 heure (robot d'envoi en masse)`);
    const cm = await db.all(
      `SELECT creator_id::text AS id, COUNT(*)::int AS n FROM content_comments WHERE created_at > now() - interval '10 minutes'
       GROUP BY creator_id HAVING COUNT(*) >= 30`).catch(() => []);
    for (const r of cm) await suspend(r.id, `${r.n} commentaires en 10 minutes (robot)`);
  }
  async function moderationTick() {
    const s = await settings();
    if (s.moderation) { await hideReported(); await reviewPending(); }
    if (s.faux_comptes) await fakeAccounts();
  }

  // Les tâches ne tournent que sur le serveur « chef ».
  const busy = { securite: false, moderation: false };
  async function tick(which) {
    if (!isLeader() || busy[which]) return;
    busy[which] = true;
    try { if (which === 'securite') await securityTick(); else await moderationTick(); }
    catch (e) { console.warn('[Eaji] Agent :', e.message); }
    finally { busy[which] = false; }
  }
  if (!process.env.EAJI_AGENT_NO_TIMERS) {
    const t1 = setInterval(() => tick('securite'), Number(process.env.EAJI_AGENT_SECURITE_MS) || 60 * 1000); if (t1.unref) t1.unref();
    const t2 = setInterval(() => tick('moderation'), Number(process.env.EAJI_AGENT_MODERATION_MS) || 5 * 60 * 1000); if (t2.unref) t2.unref();
  }

  // ==================== 2. AIDE AUX UTILISATEURS ====================
  async function accountContext(creatorId, req) {
    if (!creatorId) return null;
    const me = await db.query('SELECT name, account_status, email, phone, country_code FROM creators WHERE id = $1', [creatorId]).catch(() => null);
    if (!me) return null;
    const pay = await db.all(
      `SELECT reference, purpose, description, amount_usd, status, created_at FROM payment_requests WHERE payer_id = $1 ORDER BY created_at DESC LIMIT 5`, [creatorId]).catch(() => []);
    const wd = await db.all('SELECT amount_usd, status, created_at FROM withdrawal_requests WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 3', [creatorId]).catch(() => []);
    const prem = await db.query('SELECT MAX(ends_at) AS e FROM premium_subscriptions WHERE creator_id = $1 AND ends_at > now()', [creatorId]).catch(() => null);
    const day = (d) => new Date(d).toLocaleDateString('fr-FR');
    const b = await loadBlocks();
    return {
      name: me.name, email: Boolean(me.email), country: me.country_code, premiumUntil: prem && prem.e ? day(prem.e) : null,
      blocked: Boolean((req && b.ips.get(req.ip) === 'total') || (req && req.deviceKey && b.devices.get(req.deviceKey))),
      payments: pay.map((p) => ({ reference: p.reference, label: p.description, amount: Number(p.amount_usd), status: p.status, date: day(p.created_at) })),
      withdrawals: wd.map((w) => ({ amount: Number(w.amount_usd), status: w.status, date: day(w.created_at) })),
    };
  }
  const SYSTEM = (ctx) => `Tu es « Eajimmy AI », l'agent IA et assistant automatique de l'application Eaji (réseau social qui rémunère les créateurs de pays en développement). `
    + `Tu aides quand l'équipe est absente : compte, connexion, paiements, Premium, publicité, montage. Réponds dans la langue de la personne, en 2 à 6 phrases simples, `
    + `avec des étapes concrètes ; beaucoup d'utilisateurs connaissent peu le téléphone. `
    + `Règles absolues : ne demande JAMAIS un mot de passe, un code de confirmation, un code PIN ou un numéro de carte ; n'invente pas de fonction ni de prix ; `
    + `ne donne aucun détail sur la répartition interne de l'argent, les périodes de calcul ou les dates de versement aux créateurs ; ne promets pas de remboursement. `
    + `Si tu ne peux pas résoudre le problème, ou si la personne demande un humain, termine ta réponse par la balise [EQUIPE] (elle ne sera pas montrée). `
    + `Contact de l'administrateur : WhatsApp ${WHATSAPP}.\n\nConnaissances :\n`
    + KB.filter((e) => e.a).map((e) => `- ${e.a}`).join('\n')
    + `\n- Paiements : mobile money (valider avec le code PIN sur le téléphone), carte ou PayPal, depuis l'onglet Paiements.`
    + `\n\nCompte de la personne (données réelles, ne pas les répéter inutilement) : ${ctx ? JSON.stringify(ctx) : 'non connectée'}`;

  async function answer(messages, ctx) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const question = last ? last.text : '';
    if (aiReady()) {
      try {
        const out = await askClaude({ system: SYSTEM(ctx), messages: messages.slice(-10).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })), maxTokens: 500 });
        if (out) {
          const escalate = /\[EQUIPE\]/i.test(out);
          return { text: out.replace(/\s*\[EQUIPE\]\s*/gi, ' ').trim(), escalate, source: 'ia' };
        }
      } catch (e) { console.warn('[Eaji] Agent : IA indisponible, réponses préparées :', e.message); }
    }
    if (ctx && ctx.blocked) return { text: `L'accès depuis ton téléphone ou ton réseau a été bloqué par la sécurité d'Eaji après une activité suspecte. Seul l'administrateur peut le débloquer : écris-lui sur WhatsApp au ${WHATSAPP}.`, escalate: true, source: 'regles' };
    const topic = detectTopic(question);
    if (topic) {
      const text = topic.fn ? topic.fn(ctx) : topic.a;
      if (text) return { text, escalate: Boolean(topic.escalate) || ['paiement', 'retrait'].includes(topic.id), source: 'regles', topic: topic.id };
    }
    return { text: `Je n'ai pas bien compris. Parle-moi de ton souci avec quelques mots (exemples : « code pas reçu », « paiement en attente », « mot de passe oublié », « compte suspendu »). Je peux aussi transmettre ta demande à l'équipe Eaji, ou tu peux écrire sur WhatsApp : ${WHATSAPP}.`, escalate: true, source: 'regles' };
  }
  const cleanMsgs = (list, keep = 12, max = 1500) => (Array.isArray(list) ? list : []).slice(-keep)
    .map((m) => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', text: String((m && m.text) || '').trim().slice(0, max) })).filter((m) => m.text);

  app.post('/api/agent/chat', rateLimit('agentchat', 40, 10 * 60 * 1000, 'Trop de questions envoyées. Réessaie dans quelques minutes.'), async (req, res) => {
    const msgs = cleanMsgs(req.body && req.body.messages);
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Écris ta question.' });
    if (!(await settings()).aide) return res.json({ text: `L'assistant est en pause. Écris à l'administrateur Eaji sur WhatsApp : ${WHATSAPP}.`, escalate: true, source: 'regles' });
    const viewer = optionalViewerId(req);
    const ctx = await accountContext(viewer, req);
    const out = await answer(msgs, ctx);
    db.query('INSERT INTO agent_chats (creator_id, question, answer, source, escalated) VALUES ($1, $2, $3, $4, FALSE)',
      [viewer, short(msgs[msgs.length - 1].text, 500), short(out.text, 1000), out.source]).catch(() => {});
    res.json({ text: out.text, escalate: out.escalate, source: out.source, loggedIn: Boolean(viewer), whatsapp: WHATSAPP });
  });
  // Transmettre la conversation à l'équipe : elle arrive dans « Contacter l'équipe Eaji ».
  app.post('/api/agent/escalate', requireAuth, rateLimit('agentesc', 6, 60 * 60 * 1000, 'Ta demande a déjà été transmise. L\'équipe te répond bientôt.'), async (req, res) => {
    const msgs = cleanMsgs(req.body && req.body.messages);
    if (!msgs.length) return res.status(400).json({ error: 'Rien à transmettre.' });
    const topic = detectTopic(msgs.filter((m) => m.role === 'user').map((m) => m.text).join(' '));
    const category = topic && ['paiement', 'retrait'].includes(topic.id) ? 'paiement' : topic && ['mot_de_passe', 'code', 'connexion', 'suspendu', 'supprimer', 'inscription'].includes(topic.id) ? 'compte' : 'autre';
    const text = '🤖 Transmis par Eajimmy AI :\n' + msgs.map((m) => `${m.role === 'user' ? '👤' : '🤖'} ${m.text}`).join('\n').slice(0, 2900);
    const t = await db.query('INSERT INTO support_threads (creator_id, category) VALUES ($1, $2) RETURNING id', [req.creatorId, category]);
    await db.query("INSERT INTO support_messages (thread_id, author, text) VALUES ($1, 'utilisateur', $2)", [t.id, text]);
    await db.query('UPDATE agent_chats SET escalated = TRUE WHERE id = (SELECT id FROM agent_chats WHERE creator_id = $1 ORDER BY id DESC LIMIT 1)', [req.creatorId]).catch(() => {});
    notifyAdmins({ title: '💬 Support (transmis par Eajimmy AI)', body: short(msgs.filter((m) => m.role === 'user').pop()?.text || '', 120), link: 'admin:v-support', kind: 'support', permission: 'repondre_signalements' });
    res.status(201).json({ threadId: t.id });
  });
  // Réponse automatique dans « Contacter l'équipe Eaji » (l'équipe garde la main et peut répondre ensuite).
  async function replyInThread(threadId, creatorId) {
    const s = await settings();
    if (!s.aide || !s.support_auto) return;
    const rows = await db.all('SELECT author, text, by_agent FROM support_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT 10', [threadId]).catch(() => []);
    if (!rows.length || rows[0].author !== 'utilisateur') return;
    const msgs = rows.reverse().map((r) => ({ role: r.author === 'utilisateur' ? 'user' : 'assistant', text: r.text }));
    const out = await answer(msgs, await accountContext(creatorId, null));
    const text = `${out.text}\n\n(Réponse automatique d'Eajimmy AI. L'équipe lit aussi ta demande et peut te répondre ici.)`;
    await db.query("INSERT INTO support_messages (thread_id, author, text, by_agent) VALUES ($1, 'equipe', $2, TRUE)", [threadId, short(text, 2990)]);
    await db.query('UPDATE support_threads SET updated_at = now() WHERE id = $1', [threadId]);
    await notify(creatorId, 'support', `🤖 Eajimmy AI : ${short(out.text, 100)}`, `support:${threadId}`);
  }

  // ==================== 4. MONTAGE IA ====================
  // Chaque semaine (lundi → dimanche, heure de Kinshasa) : 2 montages pour un compte gratuit, 5 pour un compte Premium.
  // Abonnement Montage : 10 montages par jour, jusqu'à 50 (1 mois), 200 (3 mois) ou 1 000 (1 an) au total.
  const KIN = "'Africa/Kinshasa'";
  const DAY_START = `(date_trunc('day', now() AT TIME ZONE ${KIN}) AT TIME ZONE ${KIN})`;
  const WEEK_START = `(date_trunc('week', now() AT TIME ZONE ${KIN}) AT TIME ZONE ${KIN})`;
  async function montageQuota(creatorId) {
    const sub = await db.query(`SELECT id, plan, ends_at FROM montage_subscriptions WHERE creator_id = $1 AND starts_at <= now() AND ends_at > now()
      ORDER BY starts_at DESC LIMIT 1`, [creatorId]).catch(() => null);
    const plan = sub && MONTAGE_PLANS[sub.plan];
    let subInfo = null;
    if (sub && plan) {
      const u = await db.query(`SELECT COUNT(*)::int AS used, COUNT(*) FILTER (WHERE created_at >= ${DAY_START})::int AS today
        FROM montage_uses WHERE subscription_id = $1`, [sub.id]);
      subInfo = { id: sub.id, plan: sub.plan, label: plan.label, until: sub.ends_at, used: u.used, total: plan.quota, today: u.today, daily: plan.daily };
    }
    const prem = await db.query('SELECT 1 FROM premium_subscriptions WHERE creator_id = $1 AND starts_at <= now() AND ends_at > now() LIMIT 1', [creatorId]).catch(() => null);
    const w = await db.query(`SELECT COUNT(*)::int AS n FROM montage_uses WHERE creator_id = $1 AND subscription_id IS NULL AND created_at >= ${WEEK_START}`, [creatorId]);
    const r = await db.query(`SELECT ${WEEK_START} + interval '7 days' AS reset`);
    const week = { used: w.n, limit: prem ? MONTAGE_WEEK.premium : MONTAGE_WEEK.gratuit, resetsAt: r.reset };
    return { tier: prem ? 'premium' : 'gratuit', week, sub: subInfo };
  }
  async function montageUntil(creatorId) {
    const r = await db.query('SELECT MAX(ends_at) AS e FROM montage_subscriptions WHERE creator_id = $1 AND ends_at > now()', [creatorId]).catch(() => null);
    return r && r.e ? r.e : null;
  }
  const plansOut = () => Object.entries(MONTAGE_PLANS).map(([id, p]) => ({ id, price: p.price, months: p.months, label: p.label, total: p.quota, daily: p.daily, conditions: p.conditions }));
  app.get('/api/montage/status', requireAuth, async (req, res) => {
    const q = await montageQuota(req.creatorId);
    res.json({ ...q, weekly: MONTAGE_WEEK, plans: plansOut(), ai: aiReady() });
  });
  const KINDS = ['medias', 'texte_video', 'texte_image'];
  app.post('/api/montage/start', requireAuth, rateLimit('montage', 60, 60 * 60 * 1000), async (req, res) => {
    const q = await montageQuota(req.creatorId);
    const kind = KINDS.includes(req.body && req.body.kind) ? req.body.kind : 'medias';
    let subId = null;
    if (q.sub && q.sub.used < q.sub.total && q.sub.today < q.sub.daily) subId = q.sub.id;
    else if (q.week.used >= q.week.limit) {
      const fr = (d) => new Date(d).toLocaleDateString('fr-FR', { timeZone: 'Africa/Kinshasa' });
      let error;
      if (q.sub && q.sub.today >= q.sub.daily && q.sub.used < q.sub.total) error = `Tu as déjà fait tes ${q.sub.daily} montages d'aujourd'hui avec ton abonnement. Reviens demain !`;
      else if (q.sub) error = `Les ${q.sub.total} montages de ton abonnement sont utilisés, et ceux de la semaine aussi. Tu peux reprendre un abonnement Montage.`;
      else error = `Tes ${q.week.limit} montages de la semaine sont utilisés (compte ${q.tier === 'premium' ? 'Premium : 5' : 'gratuit : 2'} par semaine, de nouveau le ${fr(q.week.resetsAt)}). Pour en faire plus : abonnement Montage, 10 montages par jour.`;
      return res.status(402).json({ code: 'montage_abonnement', plans: plansOut(), error, quota: q });
    }
    await db.query('INSERT INTO montage_uses (creator_id, paid, subscription_id, kind) VALUES ($1, $2, $3, $4)', [req.creatorId, Boolean(subId), subId, kind]);
    // Avec l'IA : la description (« montage joyeux de mon mariage… ») devient un plan de montage.
    let plan = null;
    const desc = String((req.body && req.body.description) || '').trim().slice(0, 600);
    if (desc && aiReady()) {
      plan = jsonIn(await askClaude({
        system: 'Tu prépares un montage vidéo automatique. Réponds UNIQUEMENT en JSON : {"style": "dynamique"|"doux"|"fete"|"cinema", '
          + '"mood": "joyeux"|"afro"|"calme"|"romantique"|"triste"|"suspense"|"action"|"epique"|"mystere", "title": "titre court (40 caractères max) ou chaîne vide"}.',
        messages: [{ role: 'user', content: desc }], maxTokens: 150, timeoutMs: 12000,
      }).catch(() => null));
      if (plan && typeof plan.title === 'string') plan.title = plan.title.slice(0, 60);
    }
    const after = await montageQuota(req.creatorId);
    res.json({ ok: true, subscribed: Boolean(subId), source: subId ? 'abonnement' : 'semaine', quota: after, plan,
      // compatibilité : montages restants
      freeLeft: subId ? null : Math.max(0, after.week.limit - after.week.used) });
  });

  // ==================== 5. DISCUSSION LIBRE AVEC EAJIMMY AI ====================
  // Toutes les questions, même hors de l'application (écrire, traduire, idées, devoirs…). Demande la vraie IA.
  // Chaque message coûte un peu à Eaji : un nombre de messages par jour et par compte (30 par défaut).
  const CHAT_DAILY = Number(process.env.EAJI_CHAT_PAR_JOUR) || 30;
  const FREE_SYSTEM = (name) => `Tu es « Eajimmy AI », l'assistant IA de l'application Eaji (réseau social qui rémunère les créateurs de pays en développement). `
    + `Tu peux aider sur tous les sujets : questions de culture générale, école et devoirs, écriture (légendes, textes, lettres, CV), traduction, idées de vidéos et de publications, `
    + `conseils pour réussir sur les réseaux, cuisine, santé générale (sans remplacer un médecin), argent au quotidien (sans conseil financier personnalisé), etc. `
    + `Réponds dans la langue de la personne, avec des phrases simples et claires ; des listes courtes si c'est utile ; pas de tableaux. `
    + `Refuse poliment ce qui est dangereux, illégal, haineux ou sexuel. Ne demande jamais de mot de passe, de code ou de code PIN. `
    + `Si la question porte sur l'application Eaji, appuie-toi sur ces informations (n'invente aucune fonction ni aucun prix) :\n`
    + KB.filter((e) => e.a).map((e) => `- ${e.a}`).join('\n')
    + `\nNe donne jamais de détail sur la répartition interne de l'argent ni sur les dates de versement aux créateurs. `
    + `La personne s'appelle ${name || 'un utilisateur'} (utilise son prénom de temps en temps, sans exagérer).`;
  async function chatLeft(creatorId) {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM agent_chats WHERE creator_id = $1 AND source = 'libre' AND created_at >= ${DAY_START}`, [creatorId]);
    return Math.max(0, CHAT_DAILY - r.n);
  }
  app.get('/api/agent/ask/status', requireAuth, async (req, res) => {
    res.json({ ai: aiReady(), daily: CHAT_DAILY, left: await chatLeft(req.creatorId), paused: !(await settings()).aide });
  });
  app.post('/api/agent/ask', requireAuth, rateLimit('agentask', 40, 10 * 60 * 1000, 'Trop de messages envoyés. Réessaie dans quelques minutes.'), async (req, res) => {
    const msgs = cleanMsgs(req.body && req.body.messages, 16, 4000);
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Écris ta question.' });
    if (!(await settings()).aide) return res.status(503).json({ code: 'ia_pause', error: 'Eajimmy AI est en pause pour le moment. Réessaie plus tard.' });
    if (!aiReady()) {
      return res.status(503).json({ code: 'ia_inactive',
        error: "La discussion libre avec Eajimmy AI s'ouvrira bientôt (l'IA n'est pas encore activée par Eaji). En attendant, je réponds aux questions sur l'application dans « Aide sur Eaji »." });
    }
    const left = await chatLeft(req.creatorId);
    if (left <= 0) return res.status(429).json({ code: 'ia_limite', error: `Tu as utilisé tes ${CHAT_DAILY} messages d'aujourd'hui avec Eajimmy AI. Reviens demain !` });
    const me = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]).catch(() => null);
    let text;
    try {
      text = await askClaude({ system: FREE_SYSTEM(me && me.name ? String(me.name).split(' ')[0] : ''),
        messages: msgs.map((m) => ({ role: m.role, content: m.text })), maxTokens: 1200, timeoutMs: 45000 });
    } catch (e) {
      console.warn('[Eaji] Eajimmy AI (discussion) :', e.message);
      return res.status(502).json({ error: "Eajimmy AI n'arrive pas à répondre pour le moment. Réessaie dans un instant." });
    }
    if (!text) return res.status(502).json({ error: "Eajimmy AI n'arrive pas à répondre pour le moment. Réessaie dans un instant." });
    await db.query("INSERT INTO agent_chats (creator_id, question, answer, source) VALUES ($1, $2, $3, 'libre')",
      [req.creatorId, short(msgs[msgs.length - 1].text, 500), short(text, 1000)]);
    res.json({ text, left: left - 1, daily: CHAT_DAILY });
  });

  // ==================== ADMINISTRATION ====================
  app.get('/api/admin/agent', requireAdmin, async (req, res) => {
    const k = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM agent_actions WHERE kind = 'blocage' AND created_at > now() - interval '24 hours') AS blocages,
         (SELECT COUNT(*)::int FROM agent_actions WHERE kind IN ('masquage', 'retrait') AND created_at > now() - interval '24 hours') AS moderation,
         (SELECT COUNT(*)::int FROM agent_actions WHERE kind = 'validation' AND created_at > now() - interval '24 hours') AS validations,
         (SELECT COUNT(*)::int FROM agent_actions WHERE kind = 'suspension' AND created_at > now() - interval '24 hours') AS suspensions,
         (SELECT COUNT(*)::int FROM agent_chats WHERE created_at > now() - interval '24 hours') AS conversations,
         (SELECT COUNT(*)::int FROM agent_chats WHERE escalated AND created_at > now() - interval '24 hours') AS transmises,
         (SELECT COUNT(*)::int FROM montage_uses WHERE created_at > now() - interval '24 hours') AS montages`);
    const actions = await db.all('SELECT id, kind, target_type, target_id, detail, undone_at, created_at FROM agent_actions ORDER BY created_at DESC LIMIT 150');
    const chats = await db.all(
      `SELECT a.question, a.answer, a.source, a.escalated, a.created_at, cr.name AS creator_name FROM agent_chats a
       LEFT JOIN creators cr ON cr.id = a.creator_id ORDER BY a.created_at DESC LIMIT 40`);
    res.json({ settings: await settings(), ai: aiReady(), model: aiReady() ? (process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5') : null, kpis: k, actions, chats, montageWeekly: MONTAGE_WEEK });
  });
  app.put('/api/admin/agent/settings', requireAdminPrincipal, async (req, res) => {
    const cur = await settings(), next = { ...cur };
    Object.keys(DEFAULT_SETTINGS).forEach((key) => { if (typeof (req.body || {})[key] === 'boolean') next[key] = req.body[key]; });
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('agent_settings', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
    settingsCache = { at: 0, v: next };
    res.json({ settings: next });
  });
  // Annuler une action de l'agent : débloquer, remettre en ligne, réactiver le compte (et ne plus y toucher).
  app.post('/api/admin/agent/actions/:id/undo', requireAdmin, async (req, res) => {
    const a = await db.query('SELECT * FROM agent_actions WHERE id::text = $1 AND undone_at IS NULL', [String(req.params.id)]);
    if (!a) return res.status(404).json({ error: 'Action introuvable ou déjà annulée.' });
    if (a.kind === 'blocage') {
      await db.query('DELETE FROM security_blocklist WHERE id::text = $1', [a.ref_id]);
      if (a.target_type === 'ip') await db.query('INSERT INTO agent_trusted_ips (ip) VALUES ($1) ON CONFLICT (ip) DO UPDATE SET last_seen = now()', [a.target_id]);
      await loadBlocks(true);
    } else if (['masquage', 'retrait', 'validation'].includes(a.kind) && UUID_RE.test(a.target_id)) {
      const c = await db.query(`UPDATE content_items SET status = $2, agent_exempt = TRUE WHERE id = $1 RETURNING creator_id, title`,
        [a.target_id, a.kind === 'validation' ? 'en_revue' : 'actif']);
      if (c && a.kind !== 'validation') await notify(c.creator_id, 'publication', `✅ Ta publication « ${short(c.title, 60)} » a été vérifiée par l'équipe : elle est de nouveau visible.`, 's-contenu');
    } else if (a.kind === 'suspension' && UUID_RE.test(a.target_id)) {
      await db.query("UPDATE creators SET account_status = 'actif', agent_exempt = TRUE WHERE id = $1 AND account_status = 'suspendu'", [a.target_id]);
    }
    await db.query('UPDATE agent_actions SET undone_at = now(), undone_by = $2 WHERE id = $1', [a.id, req.adminId]);
    res.json({ undone: true });
  });

  return { guard, replyInThread, tick, securityTick, moderationTick, montageUntil, blockSource, aiReady };
}

module.exports = { MIGRATIONS, register, MONTAGE_FREE, MONTAGE_WEEK, detectTopic, PROBE_RE, INJECT_RE };
