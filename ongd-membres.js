'use strict';
/*
 * ONGD Les Volontaires — fichiers payants et membres
 *  - Documents, photos et vidéos : téléchargement payant (prix fixé par l'administrateur)
 *  - Membres d'honneur et VIP : cotisation renouvelable chaque trimestre, téléchargements gratuits,
 *    espace de décision (consultations, votes, avis, propositions)
 * Chargé automatiquement par ongd-routes.js : rien à ajouter dans server.js.
 * Les fichiers sont stockés sur Backblaze B2 avec les mêmes variables qu'Eaji (B2_KEY_ID, B2_APP_KEY,
 * B2_BUCKET, B2_ENDPOINT, B2_REGION), dans un dossier séparé « ongd/ ».
 */
const crypto = require('crypto');

const TAILLE_MAX = 2 * 1024 * 1024 * 1024; // 2 Go par fichier
const EXTENSIONS = {
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', '3gp', 'm4v'],
  photo: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  document: ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'odt', 'odp', 'txt', 'zip', 'mp3', 'm4a', 'wav'],
};
const CATEGORIES = { honneur: "Membre d'honneur", vip: 'Membre VIP' };
const DUREE_ACCES_H = 48;      // un achat permet de télécharger pendant 48 h…
const TELECHARGEMENTS_MAX = 3; // …jusqu'à 3 fois (si le réseau coupe)

module.exports = function (ctx) {
  const { r, pool, q, wrap, anti, antiRobot, admin, txt, tel, ErrUtil, nouvelleRef, initierPaiement, surPaiement,
    journal, reglage, prixEn, envoyerCsv, DEVISES } = ctx;
  const entier = (v, min, max) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
  const ext = nom => (String(nom || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [, ''])[1];
  const genreDe = nom => Object.keys(EXTENSIONS).find(g => EXTENSIONS[g].includes(ext(nom))) || null;
  const deviseValide = d => { if (!DEVISES.includes(d)) throw new ErrUtil('Choisissez la devise (USD ou CDF).'); return d; };

  /* ---------- Stockage Backblaze B2 (mêmes variables qu'Eaji) ---------- */
  let stockage = ctx.stockage || null;
  function sto() {
    if (stockage) return stockage;
    const e = process.env;
    if (!(e.B2_KEY_ID && e.B2_APP_KEY && e.B2_BUCKET && e.B2_ENDPOINT && e.B2_REGION)) return null;
    const sdk = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const s3 = new sdk.S3Client({ region: e.B2_REGION, endpoint: e.B2_ENDPOINT,
      credentials: { accessKeyId: e.B2_KEY_ID, secretAccessKey: e.B2_APP_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
    const B = e.B2_BUCKET;
    stockage = {
      urlEnvoi: (cle, type) => getSignedUrl(s3, new sdk.PutObjectCommand({ Bucket: B, Key: cle, ContentType: type }), { expiresIn: 3600 }),
      envoyer: (cle, type, flux, taille) => s3.send(new sdk.PutObjectCommand({ Bucket: B, Key: cle, ContentType: type, ContentLength: taille, Body: flux })),
      infos: async cle => { const h = await s3.send(new sdk.HeadObjectCommand({ Bucket: B, Key: cle })); return { taille: Number(h.ContentLength) }; },
      // Lien de téléchargement valable 15 minutes seulement : il ne peut pas circuler longtemps
      urlLecture: (cle, nom) => getSignedUrl(s3, new sdk.GetObjectCommand({ Bucket: B, Key: cle,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(String(nom).slice(0, 150))}` }), { expiresIn: 900 }),
      supprimer: cle => s3.send(new sdk.DeleteObjectCommand({ Bucket: B, Key: cle })),
    };
    return stockage;
  }
  const stoOuErreur = () => { const s = sto(); if (!s) throw new ErrUtil('Le stockage des fichiers n\'est pas configuré sur le serveur (variables B2_*).'); return s; };

  // Test du stockage pour le diagnostic de l'administration
  ctx.testStockage = async () => {
    const s = sto();
    if (!s) return { ok: false, detail: 'Variables B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION absentes du serveur' };
    try { await s.infos('ongd/test-' + Date.now()); return { ok: true, detail: 'Backblaze B2 joignable' }; }
    catch (e) {
      const code = e?.$metadata?.httpStatusCode;
      if (code === 404 || e.name === 'NotFound') return { ok: true, detail: 'Backblaze B2 joignable (dossier ongd/)' };
      return { ok: false, detail: 'Backblaze B2 refuse l\'accès : ' + (e.name || '') + ' ' + (code || e.message) };
    }
  };

  /* ---------- Prix ---------- */
  async function prixFichierUsd(f) {
    if (f.prix_usd != null) return Number(f.prix_usd);
    return Number(await reglage(f.genre === 'video' ? 'prix_video_usd' : 'prix_document_usd'));
  }
  const cotisationUsd = cat => reglage(cat === 'vip' ? 'cotisation_vip_usd' : 'cotisation_honneur_usd');

  /* ---------- Session des membres ---------- */
  async function creerSessionMembre(id) {
    const token = crypto.randomBytes(32).toString('hex');
    await q("INSERT INTO ongd_sessions(token, role, membre_id, expire_le) VALUES($1, 'membre', $2, now() + interval '30 days')", [token, id]);
    return token;
  }
  const membre = async (req, res, next) => {
    try {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ erreur: 'Connectez-vous.' });
      const { rows } = await q(`SELECT m.*, (m.statut = 'actif' AND m.expire_le > now()) AS actif FROM ongd_sessions s
        JOIN ongd_membres m ON m.id = s.membre_id WHERE s.token = $1 AND s.role = 'membre' AND s.expire_le > now()`, [token]);
      const m = rows[0];
      if (!m) return res.status(401).json({ erreur: 'Session expirée, reconnectez-vous.' });
      if (m.statut === 'suspendu') return res.status(403).json({ erreur: 'Votre compte membre est suspendu. Contactez l\'ONGD.' });
      req.membre = m; req.token = token;
      next();
    } catch (e) { console.error('[ONGD]', e); res.status(500).json({ erreur: 'Erreur du serveur.' }); }
  };
  const membreActif = (req, res, next) => req.membre.actif ? next()
    : res.status(403).json({ erreur: 'Votre cotisation n\'est pas à jour. Renouvelez-la pour accéder à l\'espace membres.', renouveler: true });

  /* ================= FICHIERS : PUBLIC ================= */
  const SELECT_FICHIER = 'SELECT id, titre, description, genre, nom_fichier, taille, prix_usd, cree_le FROM ongd_fichiers';
  async function versPublic(f) {
    const usd = await prixFichierUsd(f);
    return { id: f.id, titre: f.titre, description: f.description, genre: f.genre, extension: ext(f.nom_fichier), taille: Number(f.taille),
      prix_usd: usd, prix_cdf: await prixEn(usd, 'CDF'), cree_le: f.cree_le };
  }
  r.get('/fichiers', wrap(async (req, res) => {
    const { rows } = await q(`${SELECT_FICHIER} WHERE actif ORDER BY id DESC LIMIT 300`);
    res.set('Cache-Control', 'no-cache');
    res.json({ fichiers: await Promise.all(rows.map(versPublic)) });
  }));

  r.post('/fichiers/:id/acheter', anti(15, 30, 'achat_fichier'), antiRobot, wrap(async (req, res) => {
    const f = (await q(`${SELECT_FICHIER} WHERE id = $1 AND actif`, [entier(req.params.id, 1, 2e9)])).rows[0];
    if (!f) throw new ErrUtil('Ce fichier n\'est plus disponible.');
    const usd = await prixFichierUsd(f);
    const b = req.body || {}, nom = txt(b.nom, 120), contact = txt(b.contact, 150);
    if (contact.length < 5) throw new ErrUtil('Indiquez votre téléphone ou votre e-mail.');
    const reference = nouvelleRef('TEL');
    if (!usd) { // fichier gratuit
      const jeton = crypto.randomBytes(24).toString('hex');
      await q(`INSERT INTO ongd_achats(reference, fichier_id, nom, contact, montant, devise, mode, statut, jeton, acces_jusqu, paye_le)
        VALUES($1,$2,$3,$4,0,'USD','gratuit','paye',$5, now() + make_interval(hours => $6), now())`, [reference, f.id, nom || null, contact, jeton, DUREE_ACCES_H]);
      return res.status(201).json({ reference, gratuit: true, jeton });
    }
    const devise = deviseValide(b.devise), montant = await prixEn(usd, devise);
    await q(`INSERT INTO ongd_achats(reference, fichier_id, nom, contact, montant, devise, mode) VALUES($1,$2,$3,$4,$5,$6,'manuel')`,
      [reference, f.id, nom || null, contact, montant, devise]);
    const pay = await initierPaiement(req, { reference, montant, devise, description: 'Telechargement ' + f.titre, nom, contact });
    res.status(201).json({ reference, montant, devise, ...pay });
  }));
  surPaiement.TEL = async reference => { // paiement confirmé → lien de téléchargement
    await q(`UPDATE ongd_achats SET jeton = $2, acces_jusqu = now() + make_interval(hours => $3) WHERE reference = $1 AND jeton IS NULL`,
      [reference, crypto.randomBytes(24).toString('hex'), DUREE_ACCES_H]);
  };

  // Lien de téléchargement après achat
  r.get('/telecharger/:jeton', anti(30, 15, 'telecharger'), wrap(async (req, res) => {
    const jeton = String(req.params.jeton || '').replace(/[^a-f0-9]/g, '');
    const { rows } = await q(`SELECT a.*, f.cle, f.nom_fichier, f.titre FROM ongd_achats a JOIN ongd_fichiers f ON f.id = a.fichier_id
      WHERE a.jeton = $1 AND a.statut = 'paye'`, [jeton]);
    const a = rows[0];
    const page = msg => res.status(410).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Téléchargement</title><body style="font-family:system-ui;padding:24px;max-width:520px;margin:auto"><h2>Téléchargement impossible</h2><p>${msg}</p>
      <p><a href="${process.env.ONGD_SITE_URL || 'https://ongdlesvolontaires.eaji.org'}/fichiers.html">Retour aux documents</a></p></body>`);
    if (!a) return page('Ce lien n\'est pas valable.');
    if (new Date(a.acces_jusqu) < new Date()) return page(`Ce lien a expiré (valable ${DUREE_ACCES_H} heures après le paiement).`);
    if (a.telechargements >= TELECHARGEMENTS_MAX) return page(`Ce lien a déjà servi ${TELECHARGEMENTS_MAX} fois.`);
    const url = await stoOuErreur().urlLecture(a.cle, a.nom_fichier);
    await q('UPDATE ongd_achats SET telechargements = telechargements + 1 WHERE id = $1', [a.id]);
    res.redirect(302, url);
  }));

  /* ================= MEMBRES : PUBLIC ================= */
  r.get('/membres/offre', wrap(async (req, res) => {
    const out = {};
    for (const c of Object.keys(CATEGORIES)) { const usd = Number(await cotisationUsd(c)); out[c] = { nom: CATEGORIES[c], prix_usd: usd, prix_cdf: await prixEn(usd, 'CDF') }; }
    res.json({ categories: out, duree: 'trimestre' });
  }));

  async function nouvelleCotisation(req, m, categorie, devise) {
    if (!CATEGORIES[categorie]) throw new ErrUtil('Choisissez la catégorie : membre d\'honneur ou membre VIP.');
    deviseValide(devise);
    const montant = await prixEn(await cotisationUsd(categorie), devise), reference = nouvelleRef('COT');
    await q(`INSERT INTO ongd_cotisations(reference, membre_id, categorie, montant, devise, mode) VALUES($1,$2,$3,$4,$5,'manuel')`,
      [reference, m.id, categorie, montant, devise]);
    const pay = await initierPaiement(req, { reference, montant, devise, description: 'Cotisation ' + CATEGORIES[categorie] + ' ONGD', nom: m.nom, contact: m.email || m.telephone });
    return { reference, montant, devise, ...pay };
  }
  surPaiement.COT = async reference => { // cotisation payée → 3 mois de plus (à partir de la fin de la période en cours)
    await q(`UPDATE ongd_membres m SET categorie = c.categorie, statut = 'actif',
      expire_le = GREATEST(COALESCE(m.expire_le, now()), now()) + interval '3 months'
      FROM ongd_cotisations c WHERE c.reference = $1 AND m.id = c.membre_id`, [reference]);
    await q(`UPDATE ongd_cotisations c SET periode_fin = m.expire_le FROM ongd_membres m WHERE c.reference = $1 AND m.id = c.membre_id`, [reference]);
  };

  r.post('/membres/inscription', anti(6, 30, 'inscription_membre'), antiRobot, wrap(async (req, res) => {
    const b = req.body || {};
    const nom = txt(b.nom, 120), telephone = tel(b.telephone), mdp = String(b.mot_de_passe || '');
    if (nom.length < 2) throw new ErrUtil('Indiquez votre nom complet.');
    if (telephone.length < 10 || telephone.length > 15) throw new ErrUtil('Numéro de téléphone invalide.');
    if (mdp.length < 8) throw new ErrUtil('Le mot de passe doit avoir au moins 8 caractères.');
    if (!CATEGORIES[b.categorie]) throw new ErrUtil('Choisissez la catégorie : membre d\'honneur ou membre VIP.');
    deviseValide(b.devise);
    const sel = crypto.randomBytes(16).toString('hex');
    const { rows } = await q(`INSERT INTO ongd_membres(categorie, nom, telephone, email, organisation, mdp_hash) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (telephone) DO NOTHING RETURNING *`,
      [b.categorie, nom, telephone, txt(b.email, 150) || null, txt(b.organisation, 150) || null, sel + ':' + crypto.scryptSync(mdp, sel, 64).toString('hex')]);
    if (!rows[0]) throw new ErrUtil('Ce numéro a déjà un compte membre. Connectez-vous pour payer ou renouveler votre cotisation.');
    const token = await creerSessionMembre(rows[0].id);
    const pay = await nouvelleCotisation(req, rows[0], b.categorie, b.devise);
    res.status(201).json({ token, ...pay });
  }));

  r.post('/membres/connexion', anti(10, 15, 'connexion_membre'), wrap(async (req, res) => {
    const m = (await q('SELECT * FROM ongd_membres WHERE telephone = $1', [tel(req.body?.telephone)])).rows[0];
    if (m && m.bloque_jusqu && new Date(m.bloque_jusqu) > new Date())
      return res.status(429).json({ erreur: 'Trop d\'erreurs de mot de passe : compte bloqué 30 minutes par sécurité.' });
    const [sel, h] = String(m?.mdp_hash || '').split(':');
    const ok = m && sel && h && crypto.timingSafeEqual(crypto.scryptSync(String(req.body?.mot_de_passe || ''), sel, 64), Buffer.from(h, 'hex'));
    if (!ok) {
      if (m) {
        await q(`UPDATE ongd_membres SET echecs = CASE WHEN echecs + 1 >= 5 THEN 0 ELSE echecs + 1 END,
          bloque_jusqu = CASE WHEN echecs + 1 >= 5 THEN now() + interval '30 minutes' ELSE bloque_jusqu END WHERE id = $1`, [m.id]);
        journal('echec_connexion_membre', req, '+' + m.telephone);
      }
      return res.status(401).json({ erreur: 'Numéro ou mot de passe incorrect.' });
    }
    if (m.statut === 'suspendu') return res.status(403).json({ erreur: 'Votre compte membre est suspendu. Contactez l\'ONGD.' });
    await q('UPDATE ongd_membres SET echecs = 0, bloque_jusqu = NULL WHERE id = $1', [m.id]);
    res.json({ token: await creerSessionMembre(m.id), nom: m.nom });
  }));

  /* ================= ESPACE MEMBRES ================= */
  r.post('/membres/deconnexion', membre, wrap(async (req, res) => { await q('DELETE FROM ongd_sessions WHERE token = $1', [req.token]); res.json({ ok: true }); }));

  r.get('/membres/moi', membre, wrap(async (req, res) => {
    const m = req.membre;
    const c = await q(`SELECT reference, categorie, montant::float, devise, statut, mode, cree_le, paye_le, periode_fin FROM ongd_cotisations
      WHERE membre_id = $1 ORDER BY id DESC LIMIT 20`, [m.id]);
    res.json({ nom: m.nom, telephone: m.telephone, email: m.email, organisation: m.organisation, categorie: m.categorie, categorie_nom: CATEGORIES[m.categorie],
      statut: m.statut, actif: m.actif, expire_le: m.expire_le, cotisations: c.rows });
  }));

  r.post('/membres/cotiser', membre, anti(10, 30, 'cotiser'), wrap(async (req, res) => {
    res.status(201).json(await nouvelleCotisation(req, req.membre, req.body?.categorie || req.membre.categorie, req.body?.devise));
  }));

  r.post('/membres/mot-de-passe', membre, anti(5, 30, 'mdp_membre'), wrap(async (req, res) => {
    const [sel, h] = String(req.membre.mdp_hash).split(':');
    if (!crypto.timingSafeEqual(crypto.scryptSync(String(req.body?.ancien || ''), sel, 64), Buffer.from(h, 'hex'))) throw new ErrUtil('Mot de passe actuel incorrect.');
    if (String(req.body?.nouveau || '').length < 8) throw new ErrUtil('Le nouveau mot de passe doit avoir au moins 8 caractères.');
    const s2 = crypto.randomBytes(16).toString('hex');
    await q('UPDATE ongd_membres SET mdp_hash = $2 WHERE id = $1', [req.membre.id, s2 + ':' + crypto.scryptSync(String(req.body.nouveau), s2, 64).toString('hex')]);
    await q("DELETE FROM ongd_sessions WHERE membre_id = $1 AND token <> $2", [req.membre.id, req.token]);
    res.json({ ok: true, message: 'Mot de passe changé. Vos autres appareils ont été déconnectés.' });
  }));

  // Téléchargement gratuit pour les membres à jour
  r.post('/membres/fichiers/:id/telecharger', membre, membreActif, anti(60, 15, 'tel_membre'), wrap(async (req, res) => {
    const f = (await q('SELECT id, cle, nom_fichier FROM ongd_fichiers WHERE id = $1 AND actif', [entier(req.params.id, 1, 2e9)])).rows[0];
    if (!f) throw new ErrUtil('Ce fichier n\'est plus disponible.');
    const url = await stoOuErreur().urlLecture(f.cle, f.nom_fichier);
    await q('INSERT INTO ongd_telechargements_membres(membre_id, fichier_id) VALUES($1,$2)', [req.membre.id, f.id]);
    res.json({ url });
  }));

  /* ----- Consultations : décider ensemble des orientations des projets ----- */
  const visible = m => m.categorie === 'vip' ? "('tous','vip')" : "('tous')";
  async function resultats(ids) {
    if (!ids.length) return {};
    const { rows } = await q(`SELECT consultation_id, choix, categorie, count(*)::int n FROM ongd_votes WHERE consultation_id = ANY($1)
      GROUP BY consultation_id, choix, categorie`, [ids]);
    const out = {};
    for (const x of rows) {
      const c = out[x.consultation_id] ||= {};
      const v = c[x.choix] ||= { total: 0, honneur: 0, vip: 0 };
      v.total += x.n; v[x.categorie] = (v[x.categorie] || 0) + x.n;
    }
    return out;
  }
  r.get('/membres/consultations', membre, membreActif, wrap(async (req, res) => {
    const m = req.membre;
    await q("UPDATE ongd_consultations SET statut = 'close' WHERE statut = 'ouverte' AND date_limite IS NOT NULL AND date_limite < now()");
    const { rows } = await q(`SELECT c.id, c.titre, c.texte, c.public, c.options, c.date_limite, c.statut, c.cree_le,
        (SELECT nom FROM ongd_membres x WHERE x.id = c.propose_par) AS propose_par,
        (SELECT choix FROM ongd_votes v WHERE v.consultation_id = c.id AND v.membre_id = $1) AS mon_vote,
        COALESCE((SELECT json_agg(json_build_object('nom', mm.nom, 'categorie', mm.categorie, 'texte', a.texte, 'cree_le', a.cree_le) ORDER BY a.id)
          FROM ongd_avis a JOIN ongd_membres mm ON mm.id = a.membre_id WHERE a.consultation_id = c.id), '[]') AS avis
      FROM ongd_consultations c WHERE c.statut IN ('ouverte','close') AND c.public IN ${visible(m)}
      ORDER BY (c.statut = 'ouverte') DESC, c.id DESC LIMIT 50`, [m.id]);
    const res2 = await resultats(rows.map(x => x.id));
    const mes = await q("SELECT titre, statut, cree_le FROM ongd_consultations WHERE propose_par = $1 ORDER BY id DESC LIMIT 20", [m.id]);
    res.json({ consultations: rows.map(c => ({ ...c, resultats: res2[c.id] || {} })), mes_propositions: mes.rows });
  }));
  async function consultationOuverte(id, m) {
    const c = (await q(`SELECT * FROM ongd_consultations WHERE id = $1 AND public IN ${visible(m)}`, [entier(id, 1, 2e9)])).rows[0];
    if (!c) throw new ErrUtil('Consultation introuvable.');
    if (c.statut !== 'ouverte' || (c.date_limite && new Date(c.date_limite) < new Date())) throw new ErrUtil('Cette consultation est close.');
    return c;
  }
  r.post('/membres/consultations/:id/vote', membre, membreActif, anti(60, 15, 'vote'), wrap(async (req, res) => {
    const c = await consultationOuverte(req.params.id, req.membre);
    const choix = txt(req.body?.choix, 80);
    if (!c.options.includes(choix)) throw new ErrUtil('Choix invalide.');
    await q(`INSERT INTO ongd_votes(consultation_id, membre_id, categorie, choix) VALUES($1,$2,$3,$4)
      ON CONFLICT (consultation_id, membre_id) DO UPDATE SET choix = $4, categorie = $3, vote_le = now()`, [c.id, req.membre.id, req.membre.categorie, choix]);
    res.json({ ok: true, message: 'Vote enregistré. Vous pouvez le changer tant que la consultation est ouverte.' });
  }));
  r.post('/membres/consultations/:id/avis', membre, membreActif, anti(20, 30, 'avis'), wrap(async (req, res) => {
    const c = await consultationOuverte(req.params.id, req.membre);
    const texte = txt(req.body?.texte, 2000);
    if (texte.length < 3) throw new ErrUtil('Écrivez votre avis.');
    await q('INSERT INTO ongd_avis(consultation_id, membre_id, texte) VALUES($1,$2,$3)', [c.id, req.membre.id, texte]);
    res.status(201).json({ ok: true });
  }));
  r.post('/membres/propositions', membre, membreActif, anti(5, 60, 'proposition'), wrap(async (req, res) => {
    const titre = txt(req.body?.titre, 150), texte = txt(req.body?.texte, 4000);
    if (titre.length < 5) throw new ErrUtil('Le titre est trop court.');
    if (texte.length < 20) throw new ErrUtil('Expliquez votre proposition (au moins 20 caractères).');
    await q("INSERT INTO ongd_consultations(titre, texte, public, statut, propose_par) VALUES($1,$2,'tous','proposee',$3)", [titre, texte, req.membre.id]);
    res.status(201).json({ ok: true, message: 'Proposition envoyée. L\'ONGD la soumettra au vote des membres.' });
  }));

  /* ================= ADMINISTRATION ================= */
  r.get('/admin/fichiers', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT f.id, f.titre, f.description, f.genre, f.nom_fichier, f.taille, f.prix_usd, f.actif, f.cree_le,
      (SELECT count(*)::int FROM ongd_achats a WHERE a.fichier_id = f.id AND a.statut = 'paye' AND a.mode <> 'gratuit') ventes,
      (SELECT count(*)::int FROM ongd_telechargements_membres t WHERE t.fichier_id = f.id) par_membres
      FROM ongd_fichiers f ORDER BY f.id DESC`);
    const defaut = { document: Number(await reglage('prix_document_usd')), video: Number(await reglage('prix_video_usd')) };
    res.json({ fichiers: rows, prix_defaut: defaut, stockage: !!sto() });
  }));
  r.post('/admin/fichiers/preparer', admin, wrap(async (req, res) => {
    const nom = txt(req.body?.nom, 200), taille = Number(req.body?.taille), genre = genreDe(nom);
    if (!genre) throw new ErrUtil('Type de fichier non accepté. Formats : ' + Object.values(EXTENSIONS).flat().join(', ') + '.');
    if (!(taille > 0 && taille <= TAILLE_MAX)) throw new ErrUtil('Fichier trop grand (2 Go maximum).');
    const cle = `ongd/fichiers/${crypto.randomUUID()}.${ext(nom)}`;
    const type = txt(req.body?.type, 100) || 'application/octet-stream';
    res.json({ cle, genre, url_envoi: await stoOuErreur().urlEnvoi(cle, type), type });
  }));
  // Envoi par le serveur si l'envoi direct vers Backblaze échoue (le fichier passe sans être gardé en mémoire)
  r.put('/admin/fichiers/relais', admin, wrap(async (req, res) => {
    const cle = String(req.query.cle || '');
    if (!/^ongd\/fichiers\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/.test(cle)) throw new ErrUtil('Envoi non autorisé.');
    const taille = Number(req.headers['content-length']);
    if (!(taille > 0 && taille <= TAILLE_MAX)) throw new ErrUtil('Taille de fichier invalide.');
    await stoOuErreur().envoyer(cle, txt(req.query.type, 100) || 'application/octet-stream', req, taille);
    res.json({ ok: true });
  }));
  r.post('/admin/fichiers', admin, wrap(async (req, res) => {
    const b = req.body || {};
    const titre = txt(b.titre, 150), nom = txt(b.nom_fichier, 200), cle = String(b.cle || '');
    if (titre.length < 3) throw new ErrUtil('Indiquez un titre.');
    if (!/^ongd\/fichiers\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/.test(cle)) throw new ErrUtil('Fichier invalide.');
    const genre = genreDe(nom);
    if (!genre) throw new ErrUtil('Type de fichier non accepté.');
    let taille;
    try { taille = (await stoOuErreur().infos(cle)).taille; } catch (e) { if (e instanceof ErrUtil) throw e; throw new ErrUtil('Le fichier n\'est pas arrivé sur le stockage. Réessayez l\'envoi.'); }
    const prix = b.prix_usd === '' || b.prix_usd == null ? null : entier(b.prix_usd, 0, 100000);
    if (b.prix_usd !== '' && b.prix_usd != null && prix == null) throw new ErrUtil('Prix invalide (nombre entier de dollars).');
    const { rows } = await q(`INSERT INTO ongd_fichiers(titre, description, genre, cle, nom_fichier, taille, prix_usd) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [titre, txt(b.description, 2000) || null, genre, cle, nom, taille, prix]);
    journal('fichier_ajoute', req, titre);
    res.status(201).json({ ok: true, id: rows[0].id, message: 'Fichier publié.' });
  }));
  r.patch('/admin/fichiers/:id', admin, wrap(async (req, res) => {
    const b = req.body || {}, id = entier(req.params.id, 1, 2e9);
    const titre = txt(b.titre, 150);
    if (titre.length < 3) throw new ErrUtil('Indiquez un titre.');
    const prix = b.prix_usd === '' || b.prix_usd == null ? null : entier(b.prix_usd, 0, 100000);
    if (b.prix_usd !== '' && b.prix_usd != null && prix == null) throw new ErrUtil('Prix invalide (nombre entier de dollars).');
    const rc = await q('UPDATE ongd_fichiers SET titre = $2, description = $3, prix_usd = $4, actif = $5 WHERE id = $1',
      [id, titre, txt(b.description, 2000) || null, prix, b.actif !== false]);
    if (!rc.rowCount) throw new ErrUtil('Introuvable.');
    res.json({ ok: true, message: 'Modifications enregistrées.' });
  }));
  r.delete('/admin/fichiers/:id', admin, wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9);
    const f = (await q('SELECT cle, titre FROM ongd_fichiers WHERE id = $1', [id])).rows[0];
    if (!f) throw new ErrUtil('Introuvable.');
    const achats = (await q("SELECT count(*)::int n FROM ongd_achats WHERE fichier_id = $1 AND statut IN ('paye','declare')", [id])).rows[0].n;
    if (achats) { // des acheteurs existent : on garde l'historique, on retire seulement le fichier de la liste
      await q('UPDATE ongd_fichiers SET actif = false WHERE id = $1', [id]);
      return res.json({ ok: true, message: 'Ce fichier a déjà été acheté : il est retiré de la liste, mais gardé pour l\'historique.' });
    }
    try { await sto()?.supprimer(f.cle); } catch (e) { console.error('[ONGD] suppression B2', e.message); }
    await q('DELETE FROM ongd_fichiers WHERE id = $1', [id]);
    journal('fichier_supprime', req, f.titre);
    res.json({ ok: true, message: 'Fichier supprimé.' });
  }));
  r.get('/admin/achats', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT a.id, a.reference, a.nom, a.contact, a.montant::float, a.devise, a.mode, a.statut, a.ref_paiement, a.operateur,
      a.telechargements, a.acces_jusqu, a.cree_le, a.paye_le, f.titre FROM ongd_achats a JOIN ongd_fichiers f ON f.id = a.fichier_id
      WHERE a.mode <> 'gratuit' ORDER BY (a.statut = 'declare') DESC, a.id DESC LIMIT 300`);
    res.json({ achats: rows });
  }));

  r.get('/admin/membres', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT m.id, m.categorie, m.nom, m.telephone, m.email, m.organisation, m.statut, m.expire_le, m.cree_le,
      (m.statut = 'actif' AND m.expire_le > now()) AS a_jour,
      COALESCE((SELECT json_agg(json_build_object('reference', c.reference, 'categorie', c.categorie, 'montant', c.montant, 'devise', c.devise,
        'statut', c.statut, 'mode', c.mode, 'ref_paiement', c.ref_paiement, 'cree_le', c.cree_le) ORDER BY c.id DESC)
        FROM ongd_cotisations c WHERE c.membre_id = m.id), '[]') AS cotisations
      FROM ongd_membres m ORDER BY (EXISTS (SELECT 1 FROM ongd_cotisations c WHERE c.membre_id = m.id AND c.statut = 'declare')) DESC, m.id DESC LIMIT 500`);
    res.json({ membres: rows });
  }));
  r.patch('/admin/membres/:id', admin, wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9), statut = req.body?.statut;
    if (!['actif', 'suspendu'].includes(statut)) throw new ErrUtil('Statut inconnu.');
    const rc = await q(`UPDATE ongd_membres SET statut = $2 WHERE id = $1 AND (statut <> 'en_attente' OR $2 = 'suspendu')`, [id, statut]);
    if (!rc.rowCount) throw new ErrUtil('Ce membre n\'a pas encore payé sa première cotisation.');
    if (statut === 'suspendu') await q('DELETE FROM ongd_sessions WHERE membre_id = $1', [id]);
    journal('membre_' + statut, req, 'membre ' + id);
    res.json({ ok: true });
  }));
  r.get('/admin/cotisations.csv', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT c.reference, c.cree_le, c.paye_le, m.nom, m.telephone, c.categorie, c.montant, c.devise, c.mode, c.operateur, c.ref_paiement, c.statut, c.periode_fin
      FROM ongd_cotisations c JOIN ongd_membres m ON m.id = c.membre_id ORDER BY c.id`);
    envoyerCsv(res, 'cotisations-membres.csv', ['Référence', 'Créée le', 'Payée le', 'Membre', 'Téléphone', 'Catégorie', 'Montant', 'Devise', 'Mode', 'Opérateur', 'Réf. paiement', 'Statut', 'Fin de période'],
      rows.map(c => [c.reference, c.cree_le, c.paye_le, c.nom, '+' + c.telephone, CATEGORIES[c.categorie], c.montant, c.devise, c.mode, c.operateur, c.ref_paiement, c.statut, c.periode_fin]));
  }));

  r.get('/admin/consultations', admin, wrap(async (req, res) => {
    await q("UPDATE ongd_consultations SET statut = 'close' WHERE statut = 'ouverte' AND date_limite IS NOT NULL AND date_limite < now()");
    const { rows } = await q(`SELECT c.*, (SELECT nom FROM ongd_membres x WHERE x.id = c.propose_par) AS propose_par_nom,
      COALESCE((SELECT json_agg(json_build_object('nom', mm.nom, 'categorie', mm.categorie, 'texte', a.texte, 'cree_le', a.cree_le) ORDER BY a.id)
        FROM ongd_avis a JOIN ongd_membres mm ON mm.id = a.membre_id WHERE a.consultation_id = c.id), '[]') AS avis
      FROM ongd_consultations c WHERE c.statut <> 'refusee' ORDER BY (c.statut = 'proposee') DESC, c.id DESC LIMIT 100`);
    const res2 = await resultats(rows.map(x => x.id));
    res.json({ consultations: rows.map(c => ({ ...c, resultats: res2[c.id] || {} })) });
  }));
  function champsConsultation(b) {
    const titre = txt(b.titre, 150), texte = txt(b.texte, 6000);
    if (titre.length < 5) throw new ErrUtil('Indiquez un titre.');
    const options = (Array.isArray(b.options) ? b.options : String(b.options || '').split(/\n|,/)).map(o => txt(o, 80)).filter(Boolean).slice(0, 8);
    const opts = options.length >= 2 ? options : ['Pour', 'Contre', 'Abstention'];
    const lim = b.date_limite ? new Date(b.date_limite) : null;
    return [titre, texte || null, b.public === 'vip' ? 'vip' : 'tous', JSON.stringify(opts), lim && !isNaN(lim) ? lim : null];
  }
  r.post('/admin/consultations', admin, wrap(async (req, res) => {
    await q("INSERT INTO ongd_consultations(titre, texte, public, options, date_limite, statut) VALUES($1,$2,$3,$4,$5,'ouverte')", champsConsultation(req.body || {}));
    res.status(201).json({ ok: true, message: 'Consultation ouverte aux membres.' });
  }));
  r.patch('/admin/consultations/:id', admin, wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9), b = req.body || {};
    if (b.titre !== undefined) await q('UPDATE ongd_consultations SET titre=$2, texte=$3, public=$4, options=$5, date_limite=$6 WHERE id=$1', [id, ...champsConsultation(b)]);
    if (b.statut) {
      if (!['ouverte', 'close', 'refusee'].includes(b.statut)) throw new ErrUtil('Statut inconnu.');
      await q('UPDATE ongd_consultations SET statut = $2 WHERE id = $1', [id, b.statut]);
    }
    res.json({ ok: true });
  }));
  r.delete('/admin/consultations/:id', admin, wrap(async (req, res) => { await q('DELETE FROM ongd_consultations WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));

  /* ---------- Détails affichés sur la page de suivi du paiement ---------- */
  ctx.detailsPaiement = ctx.detailsPaiement || {};
  ctx.detailsPaiement.TEL = async (x, out) => {
    const f = (await q('SELECT titre, genre, nom_fichier FROM ongd_fichiers WHERE id = $1', [x.fichier_id])).rows[0];
    Object.assign(out, { fichier: f && { titre: f.titre, genre: f.genre }, jeton: x.statut === 'paye' ? x.jeton : null,
      acces_jusqu: x.acces_jusqu, telechargements_restants: Math.max(0, TELECHARGEMENTS_MAX - x.telechargements) });
  };
  ctx.detailsPaiement.COT = async (x, out) => {
    const m = (await q('SELECT nom, expire_le FROM ongd_membres WHERE id = $1', [x.membre_id])).rows[0];
    Object.assign(out, { categorie: x.categorie, categorie_nom: CATEGORIES[x.categorie], membre: m && m.nom, expire_le: x.statut === 'paye' ? (x.periode_fin || m?.expire_le) : null });
  };

  /* ---------- Contexte pour l'assistant IA ---------- */
  async function contexteIa() {
    const p = { doc: await reglage('prix_document_usd'), vid: await reglage('prix_video_usd'), h: await reglage('cotisation_honneur_usd'), v: await reglage('cotisation_vip_usd') };
    const n = (await q('SELECT count(*)::int n FROM ongd_fichiers WHERE actif')).rows[0].n;
    return `Documents et vidéos (page Documents) : ${n} fichier(s) ; téléchargement payant, en général ${p.doc} $ par document (PDF, PowerPoint, photos) et ${p.vid} $ par vidéo, prix fixé par l'ONGD pour chaque fichier. `
      + `Membres (page Membres) : membre d'honneur ${p.h} $ par trimestre, membre VIP ${p.v} $ par trimestre (cotisation renouvelable) ; les membres téléchargent gratuitement et votent sur les orientations des projets.`;
  }

  /* ---------- Tables ---------- */
  function creerTables() {
    return q(`
      CREATE TABLE IF NOT EXISTS ongd_fichiers (
        id SERIAL PRIMARY KEY, titre TEXT NOT NULL, description TEXT, genre TEXT NOT NULL, cle TEXT UNIQUE NOT NULL, nom_fichier TEXT NOT NULL,
        taille BIGINT NOT NULL DEFAULT 0, prix_usd INT, actif BOOLEAN NOT NULL DEFAULT true, cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ongd_achats (
        id SERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, fichier_id INT NOT NULL REFERENCES ongd_fichiers(id) ON DELETE CASCADE,
        nom TEXT, contact TEXT, montant NUMERIC(14,2) NOT NULL, devise TEXT NOT NULL, mode TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'en_attente',
        ref_paiement TEXT, operateur TEXT, jeton TEXT UNIQUE, acces_jusqu TIMESTAMPTZ, telechargements INT NOT NULL DEFAULT 0,
        cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), paye_le TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS ongd_membres (
        id SERIAL PRIMARY KEY, categorie TEXT NOT NULL, nom TEXT NOT NULL, telephone TEXT UNIQUE NOT NULL, email TEXT, organisation TEXT,
        mdp_hash TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'en_attente', expire_le TIMESTAMPTZ, echecs INT NOT NULL DEFAULT 0,
        bloque_jusqu TIMESTAMPTZ, cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
      ALTER TABLE ongd_sessions ADD COLUMN IF NOT EXISTS membre_id INT REFERENCES ongd_membres(id) ON DELETE CASCADE;
      CREATE TABLE IF NOT EXISTS ongd_cotisations (
        id SERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, membre_id INT NOT NULL REFERENCES ongd_membres(id) ON DELETE CASCADE,
        categorie TEXT NOT NULL, montant NUMERIC(14,2) NOT NULL, devise TEXT NOT NULL, mode TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'en_attente',
        ref_paiement TEXT, operateur TEXT, periode_fin TIMESTAMPTZ, cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), paye_le TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS ongd_telechargements_membres (
        id SERIAL PRIMARY KEY, membre_id INT REFERENCES ongd_membres(id) ON DELETE CASCADE, fichier_id INT REFERENCES ongd_fichiers(id) ON DELETE CASCADE,
        le TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ongd_consultations (
        id SERIAL PRIMARY KEY, titre TEXT NOT NULL, texte TEXT, public TEXT NOT NULL DEFAULT 'tous',
        options JSONB NOT NULL DEFAULT '["Pour","Contre","Abstention"]', date_limite TIMESTAMPTZ, statut TEXT NOT NULL DEFAULT 'ouverte',
        propose_par INT REFERENCES ongd_membres(id) ON DELETE SET NULL, cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ongd_votes (
        consultation_id INT NOT NULL REFERENCES ongd_consultations(id) ON DELETE CASCADE, membre_id INT NOT NULL REFERENCES ongd_membres(id) ON DELETE CASCADE,
        categorie TEXT NOT NULL, choix TEXT NOT NULL, vote_le TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (consultation_id, membre_id));
      CREATE TABLE IF NOT EXISTS ongd_avis (
        id SERIAL PRIMARY KEY, consultation_id INT NOT NULL REFERENCES ongd_consultations(id) ON DELETE CASCADE,
        membre_id INT NOT NULL REFERENCES ongd_membres(id) ON DELETE CASCADE, texte TEXT NOT NULL, cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
    `);
  }

  return { creerTables, contexteIa };
};
