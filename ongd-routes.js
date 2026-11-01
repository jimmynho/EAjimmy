'use strict';
/*
 * ONGD Les Volontaires — module serveur (site ongdlesvolontaires.eaji.org)
 * ---------------------------------------------------------------------
 * Ces deux fichiers s'ajoutent au serveur Eaji (dépôt EAjimmy, sur Railway) :
 *     ongd-routes.js      (ce fichier : dons, activités, volontaires, sécurité, IA, traduction)
 *     ongd-extensions.js  (formations, réservations, boutique, annonces, dialogue, réunions et lives)
 *     ongd-membres.js     (fichiers payants, membres d'honneur et VIP, consultations)
 * Dans server.js, juste APRÈS la ligne `const app = express();`, ajoutez :
 *
 *     require('./ongd-routes')(app);
 *
 * Tables propres (préfixe ongd_) dans la même base PostgreSQL : les dons et ventes
 * de l'ONGD restent comptés à part des revenus d'Eaji.
 *
 * Variables Railway :
 *   DATABASE_URL, CINETPAY_APIKEY, CINETPAY_SITE_ID   (déjà présentes pour Eaji)
 *   ONGD_ADMIN_PASSWORD   mot de passe du panneau admin de l'ONGD (10 caractères minimum)
 *   ANTHROPIC_API_KEY     clé de l'assistant IA, de la traduction et des réponses automatiques
 *   ONGD_IA_MODELE        (facultative) modèle IA, par défaut claude-haiku-5-5
 *   ONGD_SITE_URL         (facultative) par défaut https://ongdlesvolontaires.eaji.org
 *   ONGD_ADMIN_PHONES     (facultative) par défaut les deux numéros de l'administrateur principal
 *   ONGD_2FA_SECOURS      (facultative) mettre 1 UNIQUEMENT si vous perdez votre téléphone d'authentification
 */
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const ADMIN_PHONES = (process.env.ONGD_ADMIN_PHONES || '243823239572,243850171480')
  .split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
const SITE_URL = (process.env.ONGD_SITE_URL || 'https://ongdlesvolontaires.eaji.org').replace(/\/$/, '');
const CINETPAY_URL = 'https://api-checkout.cinetpay.com/v2/payment';
const DEVISES = ['USD', 'CDF'];
const LANGUES = { fr: 'français', en: 'anglais', ln: 'lingala', sw: 'swahili', kg: 'kikongo', lua: 'tshiluba', pt: 'portugais', es: 'espagnol', ar: 'arabe' };

class ErrUtil extends Error {}

module.exports = function monterOngd(app, options = {}) {
  const pool = options.pool || new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false, // comme Eaji
  });
  const q = (sql, params) => pool.query(sql, params);
  const r = express.Router();

  /* ---------- Outils ---------- */
  const txt = (s, max = 2000) => String(s ?? '').trim().slice(0, max);
  const tel = s => {
    let d = String(s || '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length === 10 && d.startsWith('0')) d = '243' + d.slice(1); // 0850… → 243850…
    if (d.length === 9) d = '243' + d;                                 // 850…  → 243850…
    return d;
  };
  const hacher = mdp => {
    const sel = crypto.randomBytes(16).toString('hex');
    return sel + ':' + crypto.scryptSync(mdp, sel, 64).toString('hex');
  };
  const verifierMdp = (mdp, stocke) => {
    const [sel, h] = String(stocke || '').split(':');
    if (!sel || !h) return false;
    const a = crypto.scryptSync(mdp, sel, 64), b = Buffer.from(h, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const egal = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };
  // Vraie adresse du visiteur (server.js règle « trust proxy » comme Eaji : impossible de la falsifier)
  const ipDe = req => String(req.ip || req.socket.remoteAddress || '');
  const nouvelleRef = prefixe => prefixe + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
  const cinetpay = () => ({
    apikey: process.env.CINETPAY_APIKEY || process.env.CINETPAY_API_KEY,
    site_id: process.env.CINETPAY_SITE_ID || process.env.CINETPAY_SITEID,
  });
  const cinetpayPret = () => { const c = cinetpay(); return !!(c.apikey && c.site_id); };
  const urlApi = req => {
    if (process.env.ONGD_API_URL) return process.env.ONGD_API_URL.replace(/\/$/, '');
    const h = req.get('host') || '';
    return (/^(localhost|127\.)/.test(h) ? 'http://' : 'https://') + h;
  };

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
    if (e instanceof ErrUtil) return res.status(400).json({ erreur: e.message });
    console.error('[ONGD]', e);
    res.status(500).json({ erreur: 'Erreur du serveur, réessayez dans un instant.' });
  });

  // Limite de tentatives (anti-abus), en mémoire
  const compteurs = new Map();
  const anti = (max, minutes, nom) => (req, res, next) => {
    const cle = nom + '|' + ipDe(req), now = Date.now(), e = compteurs.get(cle);
    if (!e || now > e.fin) { compteurs.set(cle, { n: 1, fin: now + minutes * 60000 }); return next(); }
    if (++e.n > max) return res.status(429).json({ erreur: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    next();
  };
  // Champ piège invisible : les robots le remplissent, les humains non
  const antiRobot = (req, res, next) => (req.body && req.body.site_web) ? res.status(201).json({ ok: true, message: 'Merci.' }) : next();
  setInterval(() => {
    const n = Date.now();
    for (const [k, v] of compteurs) if (n > v.fin) compteurs.delete(k);
    q('DELETE FROM ongd_sessions WHERE expire_le < now()').catch(() => {});
  }, 10 * 60000).unref();

  /* ---------- Journal de sécurité ---------- */
  const journal = (type, req, detail) =>
    q('INSERT INTO ongd_journal(type, ip, detail) VALUES($1,$2,$3)', [type, req ? ipDe(req) : null, txt(detail, 500) || null]).catch(() => {});

  /* ---------- Réglages modifiables par l'admin ---------- */
  const REGLAGES_DEFAUT = {
    taux_cdf: 2850,                                   // 1 $ = 2 850 FC (à mettre à jour dans l'admin)
    forfaits_annonces: [{ jours: 7, prix_usd: 5 }, { jours: 30, prix_usd: 15 }, { jours: 90, prix_usd: 40 }],
    infos_ia: '',                                     // informations supplémentaires pour l'assistant
    reponses_auto: true,                              // réponses automatiques aux messages et au dialogue
    mots_interdits: [],
    prix_document_usd: 10,                            // PDF, PowerPoint, photos… (prix par défaut)
    prix_video_usd: 20,                               // vidéos (prix par défaut)
    cotisation_honneur_usd: 100,                      // membre d'honneur, par trimestre
    cotisation_vip_usd: 200,                          // membre VIP, par trimestre
  };
  async function reglage(cle) {
    const { rows } = await q('SELECT valeur FROM ongd_reglages WHERE cle = $1', [cle]);
    return rows[0] ? rows[0].valeur : REGLAGES_DEFAUT[cle];
  }
  const ecrireReglage = (cle, valeur) =>
    q('INSERT INTO ongd_reglages(cle, valeur) VALUES($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur = $2', [cle, JSON.stringify(valeur)]);
  async function prixEn(usd, devise) {
    if (devise === 'USD') return Math.ceil(Number(usd));
    const taux = Number(await reglage('taux_cdf')) || REGLAGES_DEFAUT.taux_cdf;
    return Math.ceil((Number(usd) * taux) / 5) * 5;            // FC : multiple de 5 (exigence CinetPay)
  }

  /* ---------- Intelligence artificielle (Claude) ---------- */
  const iaPrete = () => !!process.env.ANTHROPIC_API_KEY;
  // Mêmes réglages qu'Eajimmy AI (ANTHROPIC_API_URL, ANTHROPIC_VERSION, ANTHROPIC_MODEL, ANTHROPIC_WORKSPACE_ID)
  let derniereErreurIa = null;
  async function ia(system, messages, maxTokens = 700, delaiMs = 25000) {
    if (!iaPrete()) { derniereErreurIa = 'ANTHROPIC_API_KEY absente du serveur'; return null; }
    const ctrl = new AbortController(), minuterie = setTimeout(() => ctrl.abort(), delaiMs);
    try {
      const r0 = await fetch(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01', 'content-type': 'application/json',
          ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}) },
        body: JSON.stringify({ model: process.env.ONGD_IA_MODELE || process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: maxTokens, system, messages }),
      });
      const rep = await r0.json().catch(() => ({}));
      if (!r0.ok || rep.error) {
        derniereErreurIa = `Anthropic a répondu ${r0.status} : ${rep.error?.message || 'erreur inconnue'}`
          + (r0.status === 401 ? ' (clé refusée : mal copiée ou supprimée)' : r0.status === 402 || /credit/i.test(rep.error?.message || '') ? ' (crédits épuisés)' : '');
        console.error('[ONGD] IA', derniereErreurIa); return null;
      }
      derniereErreurIa = null;
      return (rep.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim() || null;
    } catch (e) { derniereErreurIa = 'Anthropic injoignable : ' + e.message; console.error('[ONGD] IA', derniereErreurIa); return null; }
    finally { clearTimeout(minuterie); }
  }
  async function presentationIa() {
    const infos = await reglage('infos_ia');
    return `Tu es l'assistant officiel de l'ONGD Les Volontaires, organisation non gouvernementale de développement reconnue en RD Congo, siège avenue Mobutu à Mbandaka (province de l'Équateur). Site : ${SITE_URL}. WhatsApp : +243 850 171 480 et +243 823 239 572. E-mail : lesvolontaires13@gmail.com.\nVision : former, autonomiser et inspirer à travers l'éducation et l'électricité pour un avenir durable et équitable. L'ONGD intervient dans 12 domaines, avec l'électricité au centre : village des volontaires pour la jeunesse technologique, création d'entreprises locales, festivals d'innovation, mobilisation de financements, plaidoyer pour les démunis, solutions sociales concrètes et construction (école, centre de formation), interpellation des autorités, valorisation des talents et paysages, promotion de l'épargne, eau et électricité (solaire, hydro, éolien), coopération internationale, santé et éducation.
Sur le site on peut : voir les activités des volontaires, faire un don (Mobile Money ou carte), proposer un partenariat, devenir volontaire, s'inscrire aux formations et réserver une place aux événements, acheter dans la boutique, télécharger les documents et vidéos de l'ONGD, devenir membre d'honneur ou VIP, publier une annonce payante, discuter dans l'espace dialogue, suivre les lives et rejoindre les réunions virtuelles.
${infos ? 'Informations données par l\'ONGD :\n' + infos + '\n' : ''}Règles : réponds avec chaleur, en phrases courtes, dans la langue de ton interlocuteur. N'invente jamais de chiffres, de dates, de prix ni de promesses : si tu ne sais pas, invite à écrire sur WhatsApp. Ne demande jamais de mot de passe, de code PIN ni de code de carte.`;
  }

  /* ---------- Paiements communs (dons, inscriptions, commandes, annonces) ---------- */
  const TYPES_PAIEMENT = {
    DON: { table: 'ongd_dons', paye: 'paye', annule: 'annule', retour: ref => `${SITE_URL}/?don=${ref}#don` },
    INS: { table: 'ongd_inscriptions', paye: 'confirme', annule: 'annule', retour: ref => `${SITE_URL}/paiement.html?ref=${ref}` },
    CMD: { table: 'ongd_commandes', paye: 'payee', annule: 'annulee', retour: ref => `${SITE_URL}/paiement.html?ref=${ref}` },
    PUB: { table: 'ongd_annonces', paye: 'payee', annule: 'refusee', retour: ref => `${SITE_URL}/paiement.html?ref=${ref}` },
    TEL: { table: 'ongd_achats', paye: 'paye', annule: 'annule', retour: ref => `${SITE_URL}/paiement.html?ref=${ref}` },
    COT: { table: 'ongd_cotisations', paye: 'paye', annule: 'annule', retour: ref => `${SITE_URL}/paiement.html?ref=${ref}` },
  };
  const typeDe = ref => TYPES_PAIEMENT[String(ref || '').slice(0, 3)];
  const surPaiement = {}; // actions déclenchées quand un paiement est confirmé (ex. stock de la boutique)

  async function initierPaiement(req, { reference, montant, devise, description, nom, contact }) {
    const t = typeDe(reference);
    if (!cinetpayPret()) return { mode: 'manuel' };
    const estEmail = /@/.test(contact || '');
    const corps = {
      ...cinetpay(), transaction_id: reference, amount: montant, currency: devise,
      description: txt(description, 60).replace(/[^\w\s\-.,']/g, ''), channels: 'ALL', lang: 'fr', metadata: 'ongd_' + reference.slice(0, 3).toLowerCase(),
      notify_url: `${urlApi(req)}/api/ongd/paiements/notify`,
      return_url: `${urlApi(req)}/api/ongd/dons/retour/${reference}`,
      customer_id: reference, customer_name: nom || 'Client', customer_surname: nom || 'Client',
      customer_email: estEmail ? contact : (process.env.ONGD_EMAIL || 'contact@eaji.org'),
      customer_phone_number: estEmail ? '' : '+' + tel(contact),
      customer_address: 'Avenue Mobutu', customer_city: 'Mbandaka', customer_country: 'CD', customer_state: 'CD', customer_zip_code: '00000',
    };
    let rep = null;
    try {
      rep = await fetch(CINETPAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) }).then(x => x.json());
    } catch (e) { console.error('[ONGD] CinetPay injoignable', e.message); }
    if (!rep || String(rep.code) !== '201' || !rep.data?.payment_url) {
      console.error('[ONGD] CinetPay refus', rep && { code: rep.code, message: rep.message, description: rep.description });
      await q(`UPDATE ${t.table} SET mode = 'manuel' WHERE reference = $1`, [reference]);
      return { mode: 'manuel', info: 'Le paiement en ligne est momentanément indisponible.' };
    }
    await q(`UPDATE ${t.table} SET mode = 'cinetpay', ref_paiement = $2 WHERE reference = $1`, [reference, txt(rep.data.payment_token, 200)]);
    return { mode: 'cinetpay', payment_url: rep.data.payment_url };
  }

  async function marquerPaye(reference, operateur) {
    const t = typeDe(reference);
    const { rowCount } = await q(`UPDATE ${t.table} SET statut = $2, paye_le = now(), operateur = COALESCE($3, operateur)
      WHERE reference = $1 AND statut IN ('en_attente', 'declare', 'echoue')`, [reference, t.paye, operateur || null]);
    if (rowCount && surPaiement[reference.slice(0, 3)]) await surPaiement[reference.slice(0, 3)](reference).catch(e => console.error('[ONGD]', e));
    return rowCount;
  }

  // Vérifie le paiement directement auprès de CinetPay (jamais sur la seule parole du navigateur)
  async function verifierCinetpay(reference) {
    const t = typeDe(reference);
    if (!t || !cinetpayPret()) return null;
    let rep = null;
    try {
      rep = await fetch(CINETPAY_URL + '/check', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cinetpay(), transaction_id: reference }) }).then(x => x.json());
    } catch (e) { console.error('[ONGD] vérification CinetPay', e.message); return null; }
    const d = rep?.data;
    if (!d) return null;
    const { rows } = await q(`SELECT montant, devise FROM ${t.table} WHERE reference = $1`, [reference]);
    const ligne = rows[0];
    if (!ligne) return null;
    if (d.status === 'ACCEPTED' && Number(d.amount) === Number(ligne.montant) && String(d.currency) === ligne.devise) {
      await marquerPaye(reference, txt(d.payment_method, 40));
    } else if (d.status === 'REFUSED') {
      await q(`UPDATE ${t.table} SET statut = 'echoue' WHERE reference = $1 AND statut = 'en_attente'`, [reference]);
    } else if (d.status === 'ACCEPTED') {
      journal('paiement_incoherent', null, `${reference} : montant ou devise différents chez CinetPay`);
    }
    return d.status;
  }

  /* ---------- Sessions ---------- */
  async function creerSession(role, volontaireId, heures) {
    const token = crypto.randomBytes(32).toString('hex');
    await q('INSERT INTO ongd_sessions(token, role, volontaire_id, expire_le) VALUES($1,$2,$3, now() + make_interval(hours => $4))',
      [token, role, volontaireId, heures]);
    return token;
  }
  const exige = role => async (req, res, next) => {
    try {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ erreur: 'Connectez-vous.' });
      const { rows } = await q(`SELECT s.role, s.volontaire_id, v.statut, v.nom FROM ongd_sessions s
        LEFT JOIN ongd_volontaires v ON v.id = s.volontaire_id WHERE s.token = $1 AND s.expire_le > now()`, [token]);
      const s = rows[0];
      if (!s || s.role !== role) return res.status(401).json({ erreur: 'Session expirée, reconnectez-vous.' });
      if (role === 'volontaire' && s.statut !== 'actif') return res.status(403).json({ erreur: "Votre compte volontaire n'est pas actif." });
      req.ongd = { ...s, token };
      next();
    } catch (e) { console.error('[ONGD]', e); res.status(500).json({ erreur: 'Erreur du serveur.' }); }
  };

  /* ---------- Double authentification (application Google Authenticator) ---------- */
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const base32 = buf => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0');
    for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
  const deBase32 = s => { let bits = ''; for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
    const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
  function codeTotp(secret, decalage = 0) {
    const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + decalage));
    const h = crypto.createHmac('sha1', deBase32(secret)).update(c).digest(), o = h[19] & 15;
    return ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  }
  const totpValide = (secret, code) => /^\d{6}$/.test(String(code || '')) && [-1, 0, 1].some(d => egal(codeTotp(secret, d), code));

  /* ---------- CORS, en-têtes de sécurité et lecture des données ---------- */
  r.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  r.use(express.json({ limit: '12mb' }));
  r.use(express.urlencoded({ extended: true, limit: '1mb' }));

  /* ---------- Images (photos d'activités, produits, annonces, formations) ---------- */
  function imagesValides(liste, max = 4) {
    if (liste == null || liste === '') return [];
    if (!Array.isArray(liste)) liste = [liste];
    if (liste.length > max) throw new ErrUtil(max === 1 ? 'Une seule image.' : `${max} photos maximum.`);
    return liste.map(p => {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(p));
      if (!m) throw new ErrUtil('Format de photo non accepté (JPEG, PNG ou WebP).');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 2.5 * 1024 * 1024) throw new ErrUtil('Une photo dépasse 2,5 Mo.');
      // Vérifie le vrai contenu du fichier, pas seulement son nom
      const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8)
        || (m[1] === 'png' && buf.slice(0, 4).toString('hex') === '89504e47')
        || (m[1] === 'webp' && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');
      if (!ok) throw new ErrUtil("Ce fichier n'est pas une vraie image.");
      return { type: 'image/' + m[1], buf };
    });
  }
  const photosValides = liste => imagesValides(liste, 4);

  async function creerActivite(volontaireId, b, statut) {
    const titre = txt(b.titre, 150), texte = txt(b.texte, 8000), lieu = txt(b.lieu, 150);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date_activite || '') ? b.date_activite : null;
    if (titre.length < 3) throw new ErrUtil("Donnez un titre à l'activité.");
    if (texte.length < 20) throw new ErrUtil("Décrivez l'activité (au moins 20 caractères).");
    const photos = photosValides(b.photos);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO ongd_activites(volontaire_id, titre, lieu, date_activite, texte, statut, publie_le)
         VALUES($1,$2,$3,$4,$5,$6, CASE WHEN $6 = 'publie' THEN now() END) RETURNING id`,
        [volontaireId, titre, lieu || null, date, texte, statut]);
      for (const [i, p] of photos.entries())
        await client.query('INSERT INTO ongd_photos(activite_id, ordre, type, donnees) VALUES($1,$2,$3,$4)', [rows[0].id, i, p.type, p.buf]);
      await client.query('COMMIT');
      return rows[0].id;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  const SELECT_ACTIVITE = `SELECT a.id, a.titre, a.lieu, to_char(a.date_activite, 'YYYY-MM-DD') AS date_activite, a.texte, a.statut, a.motif_refus, a.cree_le, a.publie_le,
      COALESCE(v.nom, 'Équipe de l''ONGD') AS auteur, v.telephone AS auteur_telephone,
      COALESCE((SELECT json_agg(p.id ORDER BY p.ordre) FROM ongd_photos p WHERE p.activite_id = a.id), '[]') AS photos
    FROM ongd_activites a LEFT JOIN ongd_volontaires v ON v.id = a.volontaire_id`;

  /* ================= PUBLIC ================= */

  r.get('/sante', (req, res) => res.json({ ok: true, paiement_en_ligne: cinetpayPret(), ia: iaPrete() }));

  r.get('/stats', wrap(async (req, res) => {
    const [a, v, d] = await Promise.all([
      q("SELECT count(*)::int n FROM ongd_activites WHERE statut = 'publie'"),
      q("SELECT count(*)::int n FROM ongd_volontaires WHERE statut = 'actif'"),
      q("SELECT devise, sum(montant)::float total, count(*)::int nombre FROM ongd_dons WHERE statut = 'paye' GROUP BY devise ORDER BY devise DESC"),
    ]);
    res.set('Cache-Control', 'no-cache');
    res.json({ activites: a.rows[0].n, volontaires: v.rows[0].n, dons: d.rows, paiement_en_ligne: cinetpayPret(), ia: iaPrete() });
  }));

  r.get('/activites', wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1), par = 9;
    const { rows } = await q(`${SELECT_ACTIVITE} WHERE a.statut = 'publie'
      ORDER BY COALESCE(a.date_activite, a.publie_le::date) DESC, a.id DESC LIMIT $1 OFFSET $2`, [par + 1, (page - 1) * par]);
    rows.forEach(a => delete a.auteur_telephone);
    res.set('Cache-Control', 'no-cache');
    res.json({ activites: rows.slice(0, par), suite: rows.length > par });
  }));

  r.get('/photos/:id', wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.sendStatus(404);
    const { rows } = await q('SELECT p.type, p.donnees, a.statut FROM ongd_photos p JOIN ongd_activites a ON a.id = p.activite_id WHERE p.id = $1', [id]);
    const p = rows[0];
    if (!p) return res.sendStatus(404);
    if (p.statut !== 'publie') { // photo pas encore publiée : visible seulement par un volontaire ou l'admin connecté
      const t = String(req.query.t || '');
      const ok = t && (await q('SELECT 1 FROM ongd_sessions WHERE token = $1 AND expire_le > now()', [t])).rowCount;
      if (!ok) return res.sendStatus(404);
      res.set('Cache-Control', 'private, no-store');
    } else res.set('Cache-Control', 'public, max-age=86400');
    res.type(p.type).send(p.donnees);
  }));

  /* ----- Dons ----- */
  r.post('/dons', anti(10, 30, 'dons'), antiRobot, wrap(async (req, res) => {
    const b = req.body || {};
    const devise = DEVISES.includes(b.devise) ? b.devise : null;
    const montant = Number(b.montant);
    if (!devise) throw new ErrUtil('Choisissez la devise (USD ou CDF).');
    if (devise === 'USD' && !(Number.isInteger(montant) && montant >= 1 && montant <= 10000))
      throw new ErrUtil('Montant en dollars : un nombre entier entre 1 et 10 000.');
    if (devise === 'CDF' && !(Number.isInteger(montant) && montant >= 1000 && montant <= 25000000 && montant % 5 === 0))
      throw new ErrUtil('Montant en francs congolais : à partir de 1 000 FC (multiple de 5).');
    const nom = txt(b.nom, 120), contact = txt(b.contact, 150);
    if (contact.length < 5) throw new ErrUtil('Indiquez votre téléphone ou votre e-mail pour recevoir la confirmation.');
    const reference = nouvelleRef('DON');
    await q(`INSERT INTO ongd_dons(reference, nom, contact, montant, devise, projet, message, anonyme, mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manuel')`,
      [reference, nom || null, contact, montant, devise, txt(b.projet, 120) || null, txt(b.message, 500) || null, !!b.anonyme]);
    const p = await initierPaiement(req, { reference, montant, devise, description: 'Don a ONGD Les Volontaires', nom, contact });
    res.status(201).json({ reference, montant, devise, ...p });
  }));

  r.get('/dons/notify', (req, res) => res.sendStatus(200)); // test de CinetPay
  r.get('/paiements/notify', (req, res) => res.sendStatus(200));
  const notifier = wrap(async (req, res) => {
    const ref = txt(req.body?.cpm_trans_id, 60);
    if (ref) await verifierCinetpay(ref);
    res.sendStatus(200);
  });
  r.post('/dons/notify', notifier);
  r.post('/paiements/notify', notifier);

  // Retour du client après la page CinetPay (GET ou POST) → renvoyé vers la bonne page du site
  r.all('/dons/retour/:reference', wrap(async (req, res) => {
    const ref = txt(req.params.reference, 60).replace(/[^A-Z0-9]/gi, '');
    const t = typeDe(ref) || TYPES_PAIEMENT.DON;
    if (ref) await verifierCinetpay(ref);
    res.redirect(303, t.retour(encodeURIComponent(ref)));
  }));

  r.get('/dons/:reference', wrap(async (req, res) => {
    const ref = txt(req.params.reference, 60);
    let { rows } = await q('SELECT reference, montant::float, devise, statut, mode FROM ongd_dons WHERE reference = $1', [ref]);
    if (!rows[0]) return res.status(404).json({ erreur: 'Don introuvable.' });
    if (rows[0].mode === 'cinetpay' && rows[0].statut === 'en_attente') {
      await verifierCinetpay(ref);
      ({ rows } = await q('SELECT reference, montant::float, devise, statut, mode FROM ongd_dons WHERE reference = $1', [ref]));
    }
    res.json(rows[0]);
  }));

  // Paiement par Mobile Money / virement manuel : le client déclare la référence de son envoi
  const declarer = wrap(async (req, res) => {
    const ref = txt(req.params.reference, 60), t = typeDe(ref);
    if (!t) throw new ErrUtil('Référence inconnue.');
    const refPaiement = txt(req.body?.ref_paiement, 120), operateur = txt(req.body?.operateur, 40);
    if (refPaiement.length < 3) throw new ErrUtil("Indiquez la référence (ou le numéro) de votre envoi.");
    const { rowCount } = await q(`UPDATE ${t.table} SET statut = 'declare', ref_paiement = $2, operateur = $3
      WHERE reference = $1 AND mode = 'manuel' AND statut = 'en_attente'`, [ref, refPaiement, operateur || null]);
    if (!rowCount) throw new ErrUtil('Ce paiement a déjà été déclaré ou n\'existe pas.');
    res.json({ ok: true, message: "Merci ! L'ONGD vérifie la réception et confirme votre paiement." });
  });
  r.post('/dons/:reference/declarer', anti(10, 30, 'declarer'), declarer);
  r.post('/paiements/:reference/declarer', anti(10, 30, 'declarer'), declarer);

  /* ----- Partenariats et contact (avec réponse automatique) ----- */
  async function reponseAutomatique(type, b) {
    const modele = type === 'partenariat'
      ? `Bonjour ${b.nom},\n\nMerci pour votre proposition de partenariat${b.organisation ? ' au nom de ' + b.organisation : ''}. Notre équipe l'étudie et vous recontacte rapidement. Vous pouvez aussi nous écrire sur WhatsApp au +243 850 171 480.\n\nL'équipe de l'ONGD Les Volontaires`
      : `Bonjour ${b.nom},\n\nMerci pour votre message, il est bien arrivé. Notre équipe vous répond dès que possible. Pour une réponse plus rapide, écrivez-nous sur WhatsApp au +243 850 171 480.\n\nL'équipe de l'ONGD Les Volontaires`;
    if (!(await reglage('reponses_auto'))) return modele;
    const texte = await ia(await presentationIa() + `\nTâche : écrire la réponse automatique immédiate à un message reçu sur le site (${type}). Remercie, réponds à ce que tu peux à partir des informations connues, dis que l'équipe reviendra vers la personne, sans rien promettre de précis. 90 mots maximum, signe "L'équipe de l'ONGD Les Volontaires".`,
      [{ role: 'user', content: `Message de ${b.nom}${b.organisation ? ' (' + b.organisation + ')' : ''}${b.sujet ? ', sujet : ' + b.sujet : ''} :\n${b.message}` }], 400, 9000);
    return texte || modele;
  }

  r.post('/messages', anti(8, 30, 'messages'), antiRobot, wrap(async (req, res) => {
    const b = req.body || {};
    const type = ['partenariat', 'contact'].includes(b.type) ? b.type : 'contact';
    const nom = txt(b.nom, 120), message = txt(b.message, 4000), email = txt(b.email, 150), telephone = txt(b.telephone, 30);
    if (nom.length < 2) throw new ErrUtil('Indiquez votre nom.');
    if (message.length < 10) throw new ErrUtil('Votre message est trop court.');
    if (!email && !telephone) throw new ErrUtil('Indiquez un e-mail ou un téléphone pour vous répondre.');
    const organisation = txt(b.organisation, 150), sujet = txt(b.sujet, 120);
    const reponse = await reponseAutomatique(type, { nom, organisation, sujet, message });
    await q('INSERT INTO ongd_messages(type, organisation, nom, email, telephone, sujet, message, reponse_auto) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [type, organisation || null, nom, email || null, telephone || null, sujet || null, message, reponse]);
    res.status(201).json({ ok: true, reponse_auto: reponse, message: type === 'partenariat'
      ? 'Merci ! Votre proposition de partenariat est bien reçue. Nous vous répondons rapidement.'
      : 'Merci ! Votre message est bien reçu.' });
  }));

  /* ----- Assistant IA ----- */
  r.post('/ia/chat', anti(30, 60, 'ia'), wrap(async (req, res) => {
    const historique = (Array.isArray(req.body?.messages) ? req.body.messages : []).slice(-10)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: txt(m.content, 1500) })).filter(m => m.content);
    if (!historique.length || historique[historique.length - 1].role !== 'user') throw new ErrUtil('Écrivez votre question.');
    while (historique[0] && historique[0].role !== 'user') historique.shift();
    if (!iaPrete()) return res.json({ reponse: "L'assistant n'est pas encore activé. Écrivez-nous sur WhatsApp au +243 850 171 480, nous vous répondons rapidement." });
    const extra = options.contexteIa ? await options.contexteIa() : '';
    const reponse = await ia(await presentationIa() + (extra ? '\n' + extra : ''), historique, 600);
    res.json({ reponse: reponse || "Je n'arrive pas à répondre pour le moment. Écrivez-nous sur WhatsApp au +243 850 171 480." });
  }));

  /* ----- Traduction automatique (mise en cache : chaque texte n'est traduit qu'une fois) ----- */
  let traduitsAujourdhui = 0, jourTrad = new Date().toDateString();
  r.post('/traduire', anti(60, 60, 'traduire'), wrap(async (req, res) => {
    const langue = String(req.body?.langue || '');
    if (!LANGUES[langue] || langue === 'fr') throw new ErrUtil('Langue non disponible.');
    const textes = [...new Set((Array.isArray(req.body?.textes) ? req.body.textes : []).map(s => txt(s, 2000)).filter(Boolean))].slice(0, 120);
    const h = s => crypto.createHash('sha1').update(s).digest('hex');
    const resultat = {};
    if (!textes.length) return res.json({ traductions: resultat });
    const { rows } = await q('SELECT hash, texte FROM ongd_traductions WHERE langue = $1 AND hash = ANY($2)', [langue, textes.map(h)]);
    const connus = new Map(rows.map(x => [x.hash, x.texte]));
    const manquants = textes.filter(s => { const t = connus.get(h(s)); if (t) resultat[s] = t; return !t; });
    if (jourTrad !== new Date().toDateString()) { jourTrad = new Date().toDateString(); traduitsAujourdhui = 0; }
    if (manquants.length && iaPrete() && traduitsAujourdhui < 4000) {
      for (let i = 0; i < manquants.length; i += 40) {
        const lot = manquants.slice(i, i + 40);
        const sortie = await ia(`Tu traduis le site web d'une ONGD congolaise du français vers le ${LANGUES[langue]}. Garde le sens, le ton chaleureux et la ponctuation ; ne traduis pas les noms propres (Les Volontaires, Mbandaka, Eaji, M-Pesa, WhatsApp, CinetPay), les montants, ni les numéros. Réponds UNIQUEMENT par un tableau JSON de chaînes, dans le même ordre et de même longueur que le tableau reçu.`,
          [{ role: 'user', content: JSON.stringify(lot) }], 4000, 40000);
        let tab = null;
        try { tab = JSON.parse(String(sortie || '').replace(/^[^[]*/, '').replace(/[^\]]*$/, '')); } catch {}
        if (!Array.isArray(tab) || tab.length !== lot.length) continue;
        traduitsAujourdhui += lot.length;
        for (const [j, s] of lot.entries()) {
          const t = txt(tab[j], 4000); if (!t) continue;
          resultat[s] = t;
          await q('INSERT INTO ongd_traductions(hash, langue, texte) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [h(s), langue, t]);
        }
      }
    }
    const complet = Object.keys(resultat).length === textes.length;
    res.json({ traductions: resultat, complet, raison: complet ? undefined : (!iaPrete() ? 'clé IA absente du serveur' : derniereErreurIa || undefined) });
  }));

  /* ================= VOLONTAIRES ================= */

  r.post('/volontaires/inscription', anti(5, 30, 'inscription'), antiRobot, wrap(async (req, res) => {
    const b = req.body || {};
    const nom = txt(b.nom, 120), telephone = tel(b.telephone), mdp = String(b.mot_de_passe || '');
    if (nom.length < 2) throw new ErrUtil('Indiquez votre nom complet.');
    if (telephone.length < 10 || telephone.length > 15) throw new ErrUtil('Numéro de téléphone invalide.');
    if (mdp.length < 8) throw new ErrUtil('Le mot de passe doit avoir au moins 8 caractères.');
    const { rowCount } = await q(`INSERT INTO ongd_volontaires(nom, telephone, email, ville, competences, motivation, mdp_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (telephone) DO NOTHING`,
      [nom, telephone, txt(b.email, 150) || null, txt(b.ville, 100) || null, txt(b.competences, 500) || null, txt(b.motivation, 1500) || null, hacher(mdp)]);
    if (!rowCount) throw new ErrUtil("Ce numéro est déjà inscrit. Connectez-vous dans l'espace volontaire.");
    res.status(201).json({ ok: true, message: "Merci ! Votre candidature est envoyée. Vous pourrez publier dès que l'ONGD l'aura validée." });
  }));

  r.post('/volontaires/connexion', anti(10, 15, 'connexion'), wrap(async (req, res) => {
    const { rows } = await q('SELECT * FROM ongd_volontaires WHERE telephone = $1', [tel(req.body?.telephone)]);
    const v = rows[0];
    if (v && v.bloque_jusqu && new Date(v.bloque_jusqu) > new Date())
      return res.status(429).json({ erreur: 'Trop d\'erreurs de mot de passe : compte bloqué 30 minutes par sécurité.' });
    if (!v || !verifierMdp(String(req.body?.mot_de_passe || ''), v.mdp_hash)) {
      if (v) {
        await q(`UPDATE ongd_volontaires SET echecs = CASE WHEN echecs + 1 >= 5 THEN 0 ELSE echecs + 1 END,
          bloque_jusqu = CASE WHEN echecs + 1 >= 5 THEN now() + interval '30 minutes' ELSE bloque_jusqu END WHERE id = $1`, [v.id]);
        journal('echec_connexion_volontaire', req, '+' + v.telephone);
      }
      return res.status(401).json({ erreur: 'Numéro ou mot de passe incorrect.' });
    }
    await q('UPDATE ongd_volontaires SET echecs = 0, bloque_jusqu = NULL WHERE id = $1', [v.id]);
    if (v.statut === 'en_attente') return res.status(403).json({ erreur: "Votre candidature est en cours de validation par l'ONGD." });
    if (v.statut !== 'actif') return res.status(403).json({ erreur: "Votre compte volontaire n'est pas actif. Contactez l'ONGD." });
    res.json({ token: await creerSession('volontaire', v.id, 24 * 30), nom: v.nom });
  }));

  r.post('/volontaires/deconnexion', exige('volontaire'), wrap(async (req, res) => {
    await q('DELETE FROM ongd_sessions WHERE token = $1', [req.ongd.token]);
    res.json({ ok: true });
  }));

  r.post('/volontaires/mot-de-passe', exige('volontaire'), anti(5, 30, 'mdp'), wrap(async (req, res) => {
    const { rows } = await q('SELECT mdp_hash FROM ongd_volontaires WHERE id = $1', [req.ongd.volontaire_id]);
    if (!verifierMdp(String(req.body?.ancien || ''), rows[0].mdp_hash)) throw new ErrUtil('Mot de passe actuel incorrect.');
    if (String(req.body?.nouveau || '').length < 8) throw new ErrUtil('Le nouveau mot de passe doit avoir au moins 8 caractères.');
    await q('UPDATE ongd_volontaires SET mdp_hash = $2 WHERE id = $1', [req.ongd.volontaire_id, hacher(String(req.body.nouveau))]);
    await q('DELETE FROM ongd_sessions WHERE volontaire_id = $1 AND token <> $2', [req.ongd.volontaire_id, req.ongd.token]);
    res.json({ ok: true, message: 'Mot de passe changé. Vos autres appareils ont été déconnectés.' });
  }));

  r.get('/volontaires/moi', exige('volontaire'), wrap(async (req, res) => {
    const { rows } = await q(`${SELECT_ACTIVITE} WHERE a.volontaire_id = $1 ORDER BY a.id DESC LIMIT 50`, [req.ongd.volontaire_id]);
    res.json({ nom: req.ongd.nom, activites: rows });
  }));

  r.post('/volontaires/activites', anti(20, 60, 'publier'), exige('volontaire'), wrap(async (req, res) => {
    const id = await creerActivite(req.ongd.volontaire_id, req.body || {}, 'en_attente');
    res.status(201).json({ ok: true, id, message: "Activité envoyée. Elle sera visible sur le site après validation." });
  }));

  /* ================= ADMINISTRATION ================= */

  r.post('/admin/connexion', anti(8, 15, 'admin'), wrap(async (req, res) => {
    const attendu = process.env.ONGD_ADMIN_PASSWORD;
    if (!attendu || attendu.length < 10)
      return res.status(503).json({ erreur: "Administration non configurée : ajoutez ONGD_ADMIN_PASSWORD (10 caractères minimum) dans Railway." });
    const ip = ipDe(req);
    // Blocage 30 min : 5 échecs depuis une même adresse, ou 20 échecs au total (attaque répartie)
    const echecs = await q(`SELECT count(*) FILTER (WHERE ip = $1)::int n_ip, count(*)::int n_total FROM ongd_journal
      WHERE type = 'echec_connexion_admin' AND cree_le > now() - interval '30 minutes'`, [ip]);
    if (echecs.rows[0].n_ip >= 5 || echecs.rows[0].n_total >= 20)
      return res.status(429).json({ erreur: 'Trop de tentatives : accès bloqué 30 minutes par sécurité.' });
    const t = tel(req.body?.telephone);
    if (!ADMIN_PHONES.includes(t) || !egal(String(req.body?.mot_de_passe || ''), attendu)) {
      journal('echec_connexion_admin', req, t ? '+' + t : 'numéro vide');
      return res.status(401).json({ erreur: 'Numéro ou mot de passe incorrect.' });
    }
    const secret = await reglage('admin_totp');
    if (secret && process.env.ONGD_2FA_SECOURS !== '1') {
      if (!req.body?.code) return res.status(401).json({ erreur: 'Entrez le code à 6 chiffres de votre application d\'authentification.', besoin_code: true });
      if (!totpValide(secret, req.body.code)) {
        journal('echec_connexion_admin', req, 'code 2FA faux pour +' + t);
        return res.status(401).json({ erreur: 'Code à 6 chiffres incorrect.', besoin_code: true });
      }
    }
    journal('connexion_admin', req, '+' + t);
    res.json({ token: await creerSession('admin', null, 12) });
  }));

  const admin = exige('admin');

  r.post('/admin/deconnexion', admin, wrap(async (req, res) => {
    await q('DELETE FROM ongd_sessions WHERE token = $1', [req.ongd.token]);
    res.json({ ok: true });
  }));

  r.get('/admin/resume', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT
      (SELECT count(*)::int FROM ongd_activites WHERE statut = 'en_attente') activites,
      (SELECT count(*)::int FROM ongd_volontaires WHERE statut = 'en_attente') volontaires,
      (SELECT count(*)::int FROM ongd_dons WHERE statut = 'declare') dons,
      (SELECT count(*)::int FROM ongd_messages WHERE NOT traite) messages,
      (SELECT count(*)::int FROM ongd_inscriptions WHERE statut = 'declare') inscriptions,
      (SELECT count(*)::int FROM ongd_commandes WHERE statut IN ('declare', 'payee')) commandes,
      (SELECT count(*)::int FROM ongd_annonces WHERE statut IN ('declare', 'payee')) annonces,
      (SELECT count(*)::int FROM ongd_achats WHERE statut = 'declare') achats,
      (SELECT count(*)::int FROM ongd_cotisations WHERE statut = 'declare') + (SELECT count(*)::int FROM ongd_consultations WHERE statut = 'proposee') membres`);
    const dons = await q("SELECT devise, sum(montant)::float total, count(*)::int nombre FROM ongd_dons WHERE statut = 'paye' GROUP BY devise");
    res.json({ en_attente: rows[0], dons_recus: dons.rows, paiement_en_ligne: cinetpayPret(), ia: iaPrete() });
  }));

  r.get('/admin/activites', admin, wrap(async (req, res) => {
    const statut = ['en_attente', 'publie', 'refuse'].includes(req.query.statut) ? req.query.statut : 'en_attente';
    const { rows } = await q(`${SELECT_ACTIVITE} WHERE a.statut = $1 ORDER BY a.id DESC LIMIT 100`, [statut]);
    res.json({ activites: rows });
  }));

  r.post('/admin/activites', admin, wrap(async (req, res) => {
    const id = await creerActivite(null, req.body || {}, 'publie');
    res.status(201).json({ ok: true, id, message: 'Activité publiée sur le site.' });
  }));

  r.patch('/admin/activites/:id', admin, wrap(async (req, res) => {
    const action = req.body?.action;
    if (!['publier', 'refuser'].includes(action)) throw new ErrUtil('Action inconnue.');
    const { rowCount } = action === 'publier'
      ? await q("UPDATE ongd_activites SET statut = 'publie', publie_le = now(), motif_refus = NULL WHERE id = $1", [req.params.id])
      : await q("UPDATE ongd_activites SET statut = 'refuse', motif_refus = $2 WHERE id = $1", [req.params.id, txt(req.body?.motif, 300) || null]);
    if (!rowCount) return res.status(404).json({ erreur: 'Activité introuvable.' });
    res.json({ ok: true });
  }));

  r.delete('/admin/activites/:id', admin, wrap(async (req, res) => {
    await q('DELETE FROM ongd_activites WHERE id = $1', [req.params.id]);
    journal('suppression_activite', req, 'activité ' + req.params.id);
    res.json({ ok: true });
  }));

  r.get('/admin/volontaires', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT v.id, v.nom, v.telephone, v.email, v.ville, v.competences, v.motivation, v.statut, v.cree_le,
      (SELECT count(*)::int FROM ongd_activites a WHERE a.volontaire_id = v.id AND a.statut = 'publie') publiees
      FROM ongd_volontaires v ORDER BY (v.statut = 'en_attente') DESC, v.id DESC LIMIT 500`);
    res.json({ volontaires: rows });
  }));

  r.patch('/admin/volontaires/:id', admin, wrap(async (req, res) => {
    const statut = req.body?.statut;
    if (!['actif', 'suspendu', 'refuse'].includes(statut)) throw new ErrUtil('Statut inconnu.');
    const { rowCount } = await q('UPDATE ongd_volontaires SET statut = $2 WHERE id = $1', [req.params.id, statut]);
    if (!rowCount) return res.status(404).json({ erreur: 'Volontaire introuvable.' });
    if (statut !== 'actif') await q('DELETE FROM ongd_sessions WHERE volontaire_id = $1', [req.params.id]);
    journal('volontaire_' + statut, req, 'volontaire ' + req.params.id);
    res.json({ ok: true });
  }));

  r.get('/admin/dons', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT id, reference, nom, contact, montant::float, devise, projet, message, anonyme, mode, statut,
      ref_paiement, operateur, cree_le, paye_le FROM ongd_dons ORDER BY (statut = 'declare') DESC, id DESC LIMIT 300`);
    res.json({ dons: rows });
  }));

  r.patch('/admin/dons/:id', admin, wrap(async (req, res) => {
    const statut = req.body?.statut;
    if (!['paye', 'annule'].includes(statut)) throw new ErrUtil('Statut inconnu.');
    const { rowCount } = await q(`UPDATE ongd_dons SET statut = $2, paye_le = CASE WHEN $2 = 'paye' THEN now() ELSE paye_le END
      WHERE id = $1 AND statut IN ('en_attente', 'declare', 'echoue')`, [req.params.id, statut]);
    if (!rowCount) throw new ErrUtil('Ce don ne peut plus être modifié.');
    journal('don_' + statut, req, 'don ' + req.params.id);
    res.json({ ok: true });
  }));

  // Confirmation manuelle commune (inscriptions, commandes, annonces)
  r.patch('/admin/paiements/:reference', admin, wrap(async (req, res) => {
    const ref = txt(req.params.reference, 60), t = typeDe(ref);
    if (!t) throw new ErrUtil('Référence inconnue.');
    if (req.body?.statut === 'paye') {
      if (!(await marquerPaye(ref, null))) throw new ErrUtil('Ce paiement ne peut plus être modifié.');
    } else if (req.body?.statut === 'annule') {
      const { rowCount } = await q(`UPDATE ${t.table} SET statut = $2 WHERE reference = $1 AND statut IN ('en_attente', 'declare', 'echoue')`, [ref, t.annule]);
      if (!rowCount) throw new ErrUtil('Ce paiement ne peut plus être modifié.');
    } else throw new ErrUtil('Statut inconnu.');
    journal('paiement_' + req.body.statut, req, ref);
    res.json({ ok: true });
  }));

  // Export comptable : uniquement les dons, séparés des revenus d'Eaji
  const cel = v => { const s = v instanceof Date ? v.toISOString() : String(v ?? ''); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const envoyerCsv = (res, nom, entetes, lignes) =>
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${nom}"`)
      .send('﻿' + [entetes.join(';'), ...lignes.map(l => l.map(cel).join(';'))].join('\n'));
  r.get('/admin/dons.csv', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT reference, cree_le, paye_le, nom, contact, montant, devise, projet, mode, operateur, ref_paiement, statut
      FROM ongd_dons ORDER BY id`);
    envoyerCsv(res, 'dons-ongd-les-volontaires.csv',
      ['Référence', 'Créé le', 'Payé le', 'Nom', 'Contact', 'Montant', 'Devise', 'Projet', 'Mode', 'Opérateur', 'Réf. paiement', 'Statut'],
      rows.map(d => [d.reference, d.cree_le, d.paye_le, d.nom, d.contact, d.montant, d.devise, d.projet, d.mode, d.operateur, d.ref_paiement, d.statut]));
  }));

  r.get('/admin/messages', admin, wrap(async (req, res) => {
    const { rows } = await q('SELECT * FROM ongd_messages ORDER BY traite, id DESC LIMIT 300');
    res.json({ messages: rows });
  }));

  r.patch('/admin/messages/:id', admin, wrap(async (req, res) => {
    await q('UPDATE ongd_messages SET traite = $2 WHERE id = $1', [req.params.id, !!req.body?.traite]);
    res.json({ ok: true });
  }));

  /* ----- Réglages ----- */
  r.get('/admin/reglages', admin, wrap(async (req, res) => {
    const out = {};
    for (const cle of Object.keys(REGLAGES_DEFAUT)) out[cle] = await reglage(cle);
    res.json({ reglages: out, ia: iaPrete(), paiement_en_ligne: cinetpayPret() });
  }));
  r.patch('/admin/reglages', admin, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.taux_cdf !== undefined) { const t = Number(b.taux_cdf); if (!(t >= 100 && t <= 100000)) throw new ErrUtil('Taux invalide.'); await ecrireReglage('taux_cdf', t); }
    if (b.forfaits_annonces !== undefined) {
      const f = (Array.isArray(b.forfaits_annonces) ? b.forfaits_annonces : []).map(x => ({ jours: parseInt(x.jours, 10), prix_usd: parseInt(x.prix_usd, 10) }))
        .filter(x => x.jours > 0 && x.jours <= 365 && x.prix_usd > 0 && x.prix_usd <= 10000).slice(0, 6);
      if (!f.length) throw new ErrUtil('Indiquez au moins un forfait valide.');
      await ecrireReglage('forfaits_annonces', f);
    }
    if (b.infos_ia !== undefined) await ecrireReglage('infos_ia', txt(b.infos_ia, 6000));
    if (b.reponses_auto !== undefined) await ecrireReglage('reponses_auto', !!b.reponses_auto);
    if (b.mots_interdits !== undefined) await ecrireReglage('mots_interdits',
      String(b.mots_interdits).split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 300));
    for (const cle of ['prix_document_usd', 'prix_video_usd', 'cotisation_honneur_usd', 'cotisation_vip_usd']) if (b[cle] !== undefined) {
      const v = Number(b[cle]); if (!(Number.isInteger(v) && v >= 0 && v <= 100000)) throw new ErrUtil('Prix invalide (nombre entier de dollars).');
      await ecrireReglage(cle, v);
    }
    journal('reglages_modifies', req, Object.keys(b).join(', '));
    res.json({ ok: true, message: 'Réglages enregistrés.' });
  }));

  /* ----- Diagnostic : vérifie l'IA, le stockage et le paiement ----- */
  r.get('/admin/diagnostic', admin, wrap(async (req, res) => {
    const out = { paiement: cinetpayPret() ? { ok: true, detail: 'CinetPay configuré' } : { ok: false, detail: 'CINETPAY_APIKEY / CINETPAY_SITE_ID absents : paiement manuel par Mobile Money' } };
    const t = await ia('Réponds seulement : OK', [{ role: 'user', content: 'Test' }], 5, 15000);
    out.ia = t ? { ok: true, detail: 'Assistant, traduction et réponses automatiques actifs (' + (process.env.ONGD_IA_MODELE || process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5') + ')' } : { ok: false, detail: derniereErreurIa };
    out.stockage = ctx.testStockage ? await ctx.testStockage() : { ok: false, detail: 'module fichiers absent' };
    res.json(out);
  }));

  /* ----- Sécurité ----- */
  r.get('/admin/securite', admin, wrap(async (req, res) => {
    const [j, s] = await Promise.all([
      q('SELECT cree_le, type, ip, detail FROM ongd_journal ORDER BY id DESC LIMIT 150'),
      q("SELECT role, count(*)::int n FROM ongd_sessions WHERE expire_le > now() GROUP BY role"),
    ]);
    res.json({ double_auth: !!(await reglage('admin_totp')), secours: process.env.ONGD_2FA_SECOURS === '1', journal: j.rows, sessions: s.rows });
  }));
  r.post('/admin/securite/2fa/preparer', admin, wrap(async (req, res) => {
    const secret = base32(crypto.randomBytes(20));
    await ecrireReglage('admin_totp_attente', secret);
    res.json({ secret, uri: `otpauth://totp/ONGD%20Les%20Volontaires:admin?secret=${secret}&issuer=ONGD%20Les%20Volontaires&digits=6&period=30` });
  }));
  r.post('/admin/securite/2fa/activer', admin, wrap(async (req, res) => {
    const secret = await reglage('admin_totp_attente');
    if (!secret || !totpValide(secret, req.body?.code)) throw new ErrUtil('Code incorrect. Vérifiez l\'heure de votre téléphone et réessayez.');
    await ecrireReglage('admin_totp', secret);
    await q("DELETE FROM ongd_reglages WHERE cle = 'admin_totp_attente'");
    journal('2fa_activee', req, '');
    res.json({ ok: true, message: 'Double authentification activée. Le code sera demandé à chaque connexion.' });
  }));
  r.post('/admin/securite/2fa/desactiver', admin, wrap(async (req, res) => {
    const secret = await reglage('admin_totp');
    if (secret && !totpValide(secret, req.body?.code)) throw new ErrUtil('Code incorrect.');
    await q("DELETE FROM ongd_reglages WHERE cle = 'admin_totp'");
    journal('2fa_desactivee', req, '');
    res.json({ ok: true, message: 'Double authentification désactivée.' });
  }));
  r.post('/admin/securite/deconnecter-tout', admin, wrap(async (req, res) => {
    await q('DELETE FROM ongd_sessions WHERE token <> $1', [req.ongd.token]);
    journal('deconnexion_generale', req, '');
    res.json({ ok: true, message: 'Toutes les autres sessions (admin et volontaires) sont déconnectées.' });
  }));

  /* ---------- Fonctions supplémentaires (formations, boutique, annonces, dialogue, direct) ---------- */
  const ctx = { r, pool, q, wrap, anti, antiRobot, exige, admin, txt, tel, ErrUtil, imagesValides, nouvelleRef, initierPaiement,
    verifierCinetpay, marquerPaye, typeDe, surPaiement, journal, reglage, prixEn, ia, iaPrete, presentationIa, creerSession, ipDe, envoyerCsv, DEVISES,
    stockage: options.stockage, detailsPaiement: {} };
  const extensions = require('./ongd-extensions')(ctx);
  const membres = require('./ongd-membres')(ctx);
  options.contexteIa = async () => [await extensions.contexteIa(), await membres.contexteIa()].join('\n');

  app.use('/api/ongd', r);

  /* ---------- Tables ---------- */
  q(`
    CREATE TABLE IF NOT EXISTS ongd_volontaires (
      id SERIAL PRIMARY KEY, nom TEXT NOT NULL, telephone TEXT UNIQUE NOT NULL, email TEXT, ville TEXT,
      competences TEXT, motivation TEXT, mdp_hash TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'en_attente',
      cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE ongd_volontaires ADD COLUMN IF NOT EXISTS echecs INT NOT NULL DEFAULT 0;
    ALTER TABLE ongd_volontaires ADD COLUMN IF NOT EXISTS bloque_jusqu TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS ongd_sessions (
      token TEXT PRIMARY KEY, role TEXT NOT NULL, volontaire_id INT REFERENCES ongd_volontaires(id) ON DELETE CASCADE,
      expire_le TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS ongd_activites (
      id SERIAL PRIMARY KEY, volontaire_id INT REFERENCES ongd_volontaires(id) ON DELETE SET NULL,
      titre TEXT NOT NULL, lieu TEXT, date_activite DATE, texte TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'en_attente',
      motif_refus TEXT, cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), publie_le TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS ongd_activites_statut ON ongd_activites(statut);
    CREATE TABLE IF NOT EXISTS ongd_photos (
      id SERIAL PRIMARY KEY, activite_id INT NOT NULL REFERENCES ongd_activites(id) ON DELETE CASCADE,
      ordre INT NOT NULL DEFAULT 0, type TEXT NOT NULL, donnees BYTEA NOT NULL);
    CREATE INDEX IF NOT EXISTS ongd_photos_activite ON ongd_photos(activite_id);
    CREATE TABLE IF NOT EXISTS ongd_dons (
      id SERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, nom TEXT, contact TEXT, montant NUMERIC(14,2) NOT NULL,
      devise TEXT NOT NULL, projet TEXT, message TEXT, anonyme BOOLEAN NOT NULL DEFAULT false, mode TEXT NOT NULL,
      statut TEXT NOT NULL DEFAULT 'en_attente', ref_paiement TEXT, operateur TEXT,
      cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), paye_le TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS ongd_messages (
      id SERIAL PRIMARY KEY, type TEXT NOT NULL, organisation TEXT, nom TEXT NOT NULL, email TEXT, telephone TEXT,
      sujet TEXT, message TEXT NOT NULL, traite BOOLEAN NOT NULL DEFAULT false, cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE ongd_messages ADD COLUMN IF NOT EXISTS reponse_auto TEXT;
    CREATE TABLE IF NOT EXISTS ongd_reglages (cle TEXT PRIMARY KEY, valeur JSONB);
    CREATE TABLE IF NOT EXISTS ongd_journal (
      id SERIAL PRIMARY KEY, cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), type TEXT NOT NULL, ip TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS ongd_traductions (hash TEXT NOT NULL, langue TEXT NOT NULL, texte TEXT NOT NULL, PRIMARY KEY (hash, langue));
  `).then(() => extensions.creerTables()).then(() => membres.creerTables())
    .then(() => console.log('[ONGD] Les Volontaires : tables prêtes'))
    .catch(e => console.error('[ONGD] création des tables', e.message));

  return r;
};
