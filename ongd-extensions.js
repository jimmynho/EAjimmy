'use strict';
/*
 * ONGD Les Volontaires — fonctions supplémentaires
 * Formations (avec étapes), événements et réservations, boutique, annonces payantes,
 * espace de dialogue, réunions virtuelles et lives.
 * Chargé automatiquement par ongd-routes.js : rien à ajouter dans server.js.
 */
const crypto = require('crypto');

module.exports = function (ctx) {
  const { r, pool, q, wrap, anti, antiRobot, exige, admin, txt, tel, ErrUtil, imagesValides, nouvelleRef, initierPaiement,
    verifierCinetpay, surPaiement, journal, reglage, prixEn, ia, iaPrete, presentationIa, envoyerCsv, DEVISES } = ctx;
  const volontaire = exige('volontaire');
  const entier = (v, min, max) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
  const dateOuNull = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
  const codeCourt = () => Array.from(crypto.randomBytes(6), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  const hacherCode = c => crypto.createHash('sha256').update('ongd:' + String(c).trim().toUpperCase()).digest('hex');
  const deviseValide = d => { if (!DEVISES.includes(d)) throw new ErrUtil('Choisissez la devise (USD ou CDF).'); return d; };
  const contactValide = c => { const s = txt(c, 150); if (s.length < 5) throw new ErrUtil('Indiquez votre téléphone ou votre e-mail.'); return s; };
  const avecPrixCdf = async rows => { for (const x of rows) if (x.prix_usd != null) x.prix_cdf = await prixEn(x.prix_usd, 'CDF'); return rows; };

  async function verifierTexte(...textes) {
    const tout = textes.join(' ').toLowerCase();
    if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|info|xyz|io|me|ly|cd)\b)/i.test(tout))
      throw new ErrUtil('Les liens ne sont pas autorisés dans l\'espace de dialogue.');
    const interdits = await reglage('mots_interdits');
    if ((interdits || []).some(m => m && tout.includes(m))) throw new ErrUtil('Votre message contient des mots non autorisés.');
  }

  /* ================= IMAGES ================= */
  r.get('/media/:genre/:id', wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9);
    const tables = { programme: 'ongd_programmes', produit: 'ongd_produits', annonce: 'ongd_annonces' };
    const table = tables[req.params.genre];
    if (!id || !table) return res.sendStatus(404);
    const { rows } = await q(`SELECT image, image_type ${table === 'ongd_annonces' ? ', statut' : ''} FROM ${table} WHERE id = $1`, [id]);
    const x = rows[0];
    if (!x || !x.image) return res.sendStatus(404);
    if (table === 'ongd_annonces' && x.statut !== 'active') {
      const t = String(req.query.t || '');
      if (!t || !(await q("SELECT 1 FROM ongd_sessions WHERE token = $1 AND role = 'admin' AND expire_le > now()", [t])).rowCount) return res.sendStatus(404);
      res.set('Cache-Control', 'private, no-store');
    } else res.set('Cache-Control', 'public, max-age=3600');
    res.type(x.image_type).send(x.image);
  }));

  /* ================= FORMATIONS ET ÉVÉNEMENTS ================= */
  const SELECT_PROG = `SELECT p.id, p.type, p.titre, p.resume, p.description, p.lieu, p.en_ligne, p.debut, p.fin, p.places, p.prix_usd, p.statut,
      (p.image IS NOT NULL) AS a_image,
      COALESCE((SELECT json_agg(json_build_object('id', e.id, 'titre', e.titre) ORDER BY e.ordre) FROM ongd_etapes e WHERE e.programme_id = p.id), '[]') AS etapes,
      (SELECT COALESCE(sum(i.places), 0)::int FROM ongd_inscriptions i WHERE i.programme_id = p.id
        AND (i.statut IN ('confirme', 'declare') OR (i.statut = 'en_attente' AND i.cree_le > now() - interval '2 hours'))) AS reserves
    FROM ongd_programmes p`;
  const restantes = p => { p.places_restantes = p.places == null ? null : Math.max(0, p.places - p.reserves); delete p.reserves; return p; };

  r.get('/programmes', wrap(async (req, res) => {
    const type = ['formation', 'evenement'].includes(req.query.type) ? req.query.type : null;
    const { rows } = await q(`${SELECT_PROG} WHERE p.statut = 'publie' AND ($1::text IS NULL OR p.type = $1)
      ORDER BY (COALESCE(p.fin, p.debut, now()) < now() - interval '1 day'), p.debut NULLS LAST, p.id DESC LIMIT 60`, [type]);
    res.set('Cache-Control', 'no-cache');
    res.json({ programmes: await avecPrixCdf(rows.map(restantes)) });
  }));

  r.get('/programmes/:id', wrap(async (req, res) => {
    const { rows } = await q(`${SELECT_PROG} WHERE p.id = $1 AND p.statut = 'publie'`, [entier(req.params.id, 1, 2e9)]);
    if (!rows[0]) return res.status(404).json({ erreur: 'Introuvable.' });
    res.json((await avecPrixCdf([restantes(rows[0])]))[0]);
  }));

  r.post('/programmes/:id/inscription', anti(10, 30, 'inscription_prog'), antiRobot, wrap(async (req, res) => {
    const b = req.body || {};
    const { rows } = await q(`${SELECT_PROG} WHERE p.id = $1 AND p.statut = 'publie'`, [entier(req.params.id, 1, 2e9)]);
    const p = rows[0] && restantes(rows[0]);
    if (!p) throw new ErrUtil('Cette formation ou cet événement n\'est plus disponible.');
    if (p.fin && new Date(p.fin) < new Date()) throw new ErrUtil('Les inscriptions sont terminées.');
    const nom = txt(b.nom, 120), telephone = tel(b.telephone), email = txt(b.email, 150);
    if (nom.length < 2) throw new ErrUtil('Indiquez votre nom.');
    if (telephone.length < 10) throw new ErrUtil('Indiquez un numéro de téléphone valide.');
    const places = p.type === 'evenement' ? entier(b.places, 1, 20) : 1;
    if (!places) throw new ErrUtil('Nombre de places invalide (1 à 20).');
    if (p.places_restantes != null && places > p.places_restantes)
      throw new ErrUtil(p.places_restantes ? `Il reste seulement ${p.places_restantes} place(s).` : 'Complet : il ne reste plus de place.');
    const code = codeCourt(), reference = nouvelleRef('INS');
    if (!p.prix_usd) {
      await q(`INSERT INTO ongd_inscriptions(programme_id, code, reference, nom, telephone, email, places, montant, devise, mode, statut)
        VALUES($1,$2,$3,$4,$5,$6,$7,0,'USD','gratuit','confirme')`, [p.id, code, reference, nom, telephone, email || null, places]);
      return res.status(201).json({ reference, code, gratuit: true,
        message: p.type === 'formation' ? 'Inscription confirmée ! Gardez votre code pour suivre la formation.' : 'Réservation confirmée ! Présentez ce code à l\'entrée.' });
    }
    const devise = deviseValide(b.devise), montant = await prixEn(p.prix_usd * places, devise);
    await q(`INSERT INTO ongd_inscriptions(programme_id, code, reference, nom, telephone, email, places, montant, devise, mode, statut)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'manuel','en_attente')`, [p.id, code, reference, nom, telephone, email || null, places, montant, devise]);
    const pay = await initierPaiement(req, { reference, montant, devise, description: (p.type === 'formation' ? 'Formation ' : 'Reservation ') + p.titre, nom, contact: telephone });
    res.status(201).json({ reference, montant, devise, ...pay });
  }));

  // Accès à une formation (étapes complètes) ou à une réservation avec le code reçu
  async function inscriptionParCode(code) {
    const { rows } = await q(`SELECT i.*, p.type, p.titre, p.lieu, p.en_ligne, p.debut, p.fin FROM ongd_inscriptions i
      JOIN ongd_programmes p ON p.id = i.programme_id WHERE i.code = $1`, [txt(code, 12).toUpperCase()]);
    return rows[0];
  }
  r.post('/acces', anti(20, 15, 'acces'), wrap(async (req, res) => {
    const i = await inscriptionParCode(req.body?.code);
    if (!i) throw new ErrUtil('Code inconnu. Vérifiez les 6 caractères.');
    if (i.statut !== 'confirme') throw new ErrUtil(i.statut === 'declare' || i.statut === 'en_attente' ? 'Votre paiement n\'est pas encore confirmé.' : 'Cette inscription est annulée.');
    const base = { code: i.code, nom: i.nom, type: i.type, titre: i.titre, lieu: i.lieu, en_ligne: i.en_ligne, debut: i.debut, fin: i.fin, places: i.places, progression: i.progression };
    if (i.type !== 'formation') return res.json(base);
    const et = await q('SELECT id, titre, contenu, video_url FROM ongd_etapes WHERE programme_id = $1 ORDER BY ordre', [i.programme_id]);
    res.json({ ...base, etapes: et.rows });
  }));
  r.post('/acces/progression', anti(120, 15, 'progression'), wrap(async (req, res) => {
    const i = await inscriptionParCode(req.body?.code);
    if (!i || i.statut !== 'confirme') throw new ErrUtil('Code invalide.');
    const etape = entier(req.body?.etape, 1, 2e9);
    if (!etape) throw new ErrUtil('Étape inconnue.');
    const set = new Set(i.progression || []);
    req.body?.fait ? set.add(etape) : set.delete(etape);
    await q('UPDATE ongd_inscriptions SET progression = $2 WHERE id = $1', [i.id, JSON.stringify([...set])]);
    res.json({ ok: true, progression: [...set] });
  }));

  /* ----- Admin programmes ----- */
  async function enregistrerProgramme(id, b) {
    const type = ['formation', 'evenement'].includes(b.type) ? b.type : 'formation';
    const titre = txt(b.titre, 150);
    if (titre.length < 3) throw new ErrUtil('Indiquez un titre.');
    const champs = [type, titre, txt(b.resume, 300) || null, txt(b.description, 8000) || null, txt(b.lieu, 150) || null, !!b.en_ligne,
      dateOuNull(b.debut), dateOuNull(b.fin), b.places === '' || b.places == null ? null : entier(b.places, 1, 100000),
      entier(b.prix_usd || 0, 0, 100000) ?? 0, ['publie', 'brouillon', 'annule'].includes(b.statut) ? b.statut : 'publie'];
    const image = b.image ? imagesValides(b.image, 1)[0] : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (id) {
        const rc = await client.query(`UPDATE ongd_programmes SET type=$2, titre=$3, resume=$4, description=$5, lieu=$6, en_ligne=$7, debut=$8, fin=$9,
          places=$10, prix_usd=$11, statut=$12 WHERE id=$1`, [id, ...champs]);
        if (!rc.rowCount) throw new ErrUtil('Introuvable.');
      } else {
        id = (await client.query(`INSERT INTO ongd_programmes(type, titre, resume, description, lieu, en_ligne, debut, fin, places, prix_usd, statut)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, champs)).rows[0].id;
      }
      if (image) await client.query('UPDATE ongd_programmes SET image=$2, image_type=$3 WHERE id=$1', [id, image.buf, image.type]);
      if (Array.isArray(b.etapes)) {
        const etapes = b.etapes.map(e => ({ titre: txt(e.titre, 150), contenu: txt(e.contenu, 20000), video: txt(e.video_url, 300) })).filter(e => e.titre).slice(0, 60);
        if (etapes.some(e => e.video && !/^https:\/\//.test(e.video))) throw new ErrUtil('Les liens vidéo doivent commencer par https://');
        // On garde les identifiants des étapes existantes (la progression des participants reste valable)
        const anciennes = (await client.query('SELECT id FROM ongd_etapes WHERE programme_id=$1 ORDER BY ordre', [id])).rows.map(x => x.id);
        for (const [k, e] of etapes.entries()) {
          if (anciennes[k]) await client.query('UPDATE ongd_etapes SET ordre=$2, titre=$3, contenu=$4, video_url=$5 WHERE id=$1', [anciennes[k], k, e.titre, e.contenu || null, e.video || null]);
          else await client.query('INSERT INTO ongd_etapes(programme_id, ordre, titre, contenu, video_url) VALUES($1,$2,$3,$4,$5)', [id, k, e.titre, e.contenu || null, e.video || null]);
        }
        if (anciennes.length > etapes.length) await client.query('DELETE FROM ongd_etapes WHERE id = ANY($1)', [anciennes.slice(etapes.length)]);
      }
      await client.query('COMMIT');
      return id;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  r.get('/admin/programmes', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT p.id, p.type, p.titre, p.resume, p.description, p.lieu, p.en_ligne, p.debut, p.fin, p.places, p.prix_usd, p.statut,
      (p.image IS NOT NULL) a_image,
      COALESCE((SELECT json_agg(json_build_object('id', e.id, 'titre', e.titre, 'contenu', e.contenu, 'video_url', e.video_url) ORDER BY e.ordre) FROM ongd_etapes e WHERE e.programme_id = p.id), '[]') etapes,
      (SELECT COALESCE(sum(places), 0)::int FROM ongd_inscriptions i WHERE i.programme_id = p.id AND i.statut = 'confirme') confirmes,
      (SELECT count(*)::int FROM ongd_inscriptions i WHERE i.programme_id = p.id AND i.statut = 'declare') a_verifier
      FROM ongd_programmes p ORDER BY p.id DESC LIMIT 200`);
    res.json({ programmes: rows });
  }));
  r.post('/admin/programmes', admin, wrap(async (req, res) => {
    const id = await enregistrerProgramme(null, req.body || {});
    res.status(201).json({ ok: true, id, message: 'Enregistré.' });
  }));
  r.patch('/admin/programmes/:id', admin, wrap(async (req, res) => {
    await enregistrerProgramme(entier(req.params.id, 1, 2e9), req.body || {});
    res.json({ ok: true, message: 'Modifications enregistrées.' });
  }));
  r.delete('/admin/programmes/:id', admin, wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9);
    const n = (await q("SELECT count(*)::int n FROM ongd_inscriptions WHERE programme_id = $1 AND statut IN ('confirme','declare')", [id])).rows[0].n;
    if (n) { await q("UPDATE ongd_programmes SET statut = 'annule' WHERE id = $1", [id]); return res.json({ ok: true, message: 'Des personnes sont inscrites : le programme est marqué « annulé » au lieu d\'être supprimé.' }); }
    await q('DELETE FROM ongd_programmes WHERE id = $1', [id]);
    journal('suppression_programme', req, 'programme ' + id);
    res.json({ ok: true, message: 'Supprimé.' });
  }));
  r.get('/admin/programmes/:id/inscriptions', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT id, code, reference, nom, telephone, email, places, montant::float, devise, mode, statut, ref_paiement, operateur,
      present, cree_le, paye_le, jsonb_array_length(progression) AS etapes_faites FROM ongd_inscriptions WHERE programme_id = $1 ORDER BY id DESC`, [entier(req.params.id, 1, 2e9)]);
    if (req.query.csv) return envoyerCsv(res, 'inscriptions.csv', ['Code', 'Nom', 'Téléphone', 'E-mail', 'Places', 'Montant', 'Devise', 'Statut', 'Présent', 'Inscrit le'],
      rows.map(i => [i.code, i.nom, '+' + i.telephone, i.email, i.places, i.montant, i.devise, i.statut, i.present ? 'oui' : '', i.cree_le]));
    res.json({ inscriptions: rows });
  }));
  r.patch('/admin/inscriptions/:id', admin, wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9);
    if (req.body?.present !== undefined) await q('UPDATE ongd_inscriptions SET present = $2 WHERE id = $1', [id, !!req.body.present]);
    if (req.body?.statut === 'annule') await q("UPDATE ongd_inscriptions SET statut = 'annule' WHERE id = $1", [id]);
    res.json({ ok: true });
  }));
  r.post('/admin/inscriptions/verifier', admin, wrap(async (req, res) => { // contrôle à l'entrée
    const i = await inscriptionParCode(req.body?.code);
    if (!i) throw new ErrUtil('Code inconnu.');
    res.json({ id: i.id, nom: i.nom, titre: i.titre, places: i.places, statut: i.statut, present: i.present });
  }));

  /* ================= BOUTIQUE ================= */
  r.get('/produits', wrap(async (req, res) => {
    const { rows } = await q(`SELECT id, nom, description, prix_usd, stock, (image IS NOT NULL) a_image FROM ongd_produits
      WHERE actif ORDER BY (stock = 0), id DESC LIMIT 200`);
    res.set('Cache-Control', 'no-cache');
    res.json({ produits: await avecPrixCdf(rows) });
  }));

  r.post('/commandes', anti(10, 30, 'commandes'), antiRobot, wrap(async (req, res) => {
    const b = req.body || {};
    const devise = deviseValide(b.devise), contact = contactValide(b.contact), nom = txt(b.nom, 120);
    if (nom.length < 2) throw new ErrUtil('Indiquez votre nom.');
    const livraison = txt(b.livraison, 300);
    if (livraison.length < 3) throw new ErrUtil('Indiquez l\'adresse de livraison ou « retrait au siège ».');
    const demande = (Array.isArray(b.articles) ? b.articles : []).map(a => ({ id: entier(a.id, 1, 2e9), qte: entier(a.qte, 1, 100) })).filter(a => a.id && a.qte);
    if (!demande.length) throw new ErrUtil('Votre panier est vide.');
    const { rows } = await q('SELECT id, nom, prix_usd, stock FROM ongd_produits WHERE actif AND id = ANY($1)', [demande.map(a => a.id)]);
    const articles = demande.map(a => {
      const p = rows.find(x => x.id === a.id);
      if (!p) throw new ErrUtil('Un article de votre panier n\'est plus disponible.');
      if (p.stock != null && a.qte > p.stock) throw new ErrUtil(`Stock insuffisant pour « ${p.nom} » (reste ${p.stock}).`);
      return { id: p.id, nom: p.nom, qte: a.qte, prix_usd: p.prix_usd };
    });
    const total = articles.reduce((s, a) => s + a.qte * a.prix_usd, 0);
    const montant = await prixEn(total, devise), reference = nouvelleRef('CMD');
    await q(`INSERT INTO ongd_commandes(reference, nom, contact, livraison, articles, total_usd, montant, devise, mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manuel')`, [reference, nom, contact, livraison, JSON.stringify(articles), total, montant, devise]);
    const pay = await initierPaiement(req, { reference, montant, devise, description: 'Commande boutique ONGD Les Volontaires', nom, contact });
    res.status(201).json({ reference, montant, devise, ...pay });
  }));
  surPaiement.CMD = async reference => { // une commande payée retire les articles du stock
    const { rows } = await q('SELECT articles FROM ongd_commandes WHERE reference = $1', [reference]);
    for (const a of rows[0]?.articles || [])
      await q('UPDATE ongd_produits SET stock = GREATEST(0, stock - $2) WHERE id = $1 AND stock IS NOT NULL', [a.id, a.qte]);
  };

  async function enregistrerProduit(id, b) {
    const nom = txt(b.nom, 120);
    if (nom.length < 2) throw new ErrUtil('Indiquez le nom du produit.');
    const prix = entier(b.prix_usd, 1, 100000);
    if (!prix) throw new ErrUtil('Prix en dollars : nombre entier à partir de 1.');
    const stock = b.stock === '' || b.stock == null ? null : entier(b.stock, 0, 1000000);
    const champs = [nom, txt(b.description, 2000) || null, prix, stock, b.actif !== false];
    const image = b.image ? imagesValides(b.image, 1)[0] : null;
    if (id) { if (!(await q('UPDATE ongd_produits SET nom=$2, description=$3, prix_usd=$4, stock=$5, actif=$6 WHERE id=$1', [id, ...champs])).rowCount) throw new ErrUtil('Introuvable.'); }
    else id = (await q('INSERT INTO ongd_produits(nom, description, prix_usd, stock, actif) VALUES($1,$2,$3,$4,$5) RETURNING id', champs)).rows[0].id;
    if (image) await q('UPDATE ongd_produits SET image=$2, image_type=$3 WHERE id=$1', [id, image.buf, image.type]);
    return id;
  }
  r.get('/admin/produits', admin, wrap(async (req, res) => {
    res.json({ produits: (await q('SELECT id, nom, description, prix_usd, stock, actif, (image IS NOT NULL) a_image FROM ongd_produits ORDER BY id DESC')).rows });
  }));
  r.post('/admin/produits', admin, wrap(async (req, res) => res.status(201).json({ ok: true, id: await enregistrerProduit(null, req.body || {}), message: 'Produit ajouté.' })));
  r.patch('/admin/produits/:id', admin, wrap(async (req, res) => { await enregistrerProduit(entier(req.params.id, 1, 2e9), req.body || {}); res.json({ ok: true, message: 'Produit modifié.' }); }));
  r.delete('/admin/produits/:id', admin, wrap(async (req, res) => { await q('UPDATE ongd_produits SET actif = false WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
  r.get('/admin/commandes', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT id, reference, nom, contact, livraison, articles, total_usd, montant::float, devise, mode, statut, ref_paiement, operateur, cree_le, paye_le
      FROM ongd_commandes ORDER BY (statut IN ('declare','payee')) DESC, id DESC LIMIT 300`);
    res.json({ commandes: rows });
  }));
  r.patch('/admin/commandes/:id', admin, wrap(async (req, res) => {
    if (req.body?.statut !== 'livree') throw new ErrUtil('Statut inconnu.');
    const { rowCount } = await q("UPDATE ongd_commandes SET statut = 'livree' WHERE id = $1 AND statut = 'payee'", [req.params.id]);
    if (!rowCount) throw new ErrUtil('Seule une commande payée peut être marquée livrée.');
    res.json({ ok: true });
  }));

  /* ================= ANNONCES PAYANTES ================= */
  r.get('/annonces/forfaits', wrap(async (req, res) => {
    const f = await reglage('forfaits_annonces');
    res.json({ forfaits: await Promise.all(f.map(async x => ({ ...x, prix_cdf: await prixEn(x.prix_usd, 'CDF') }))) });
  }));
  r.post('/annonces', anti(6, 60, 'annonces'), antiRobot, wrap(async (req, res) => {
    const b = req.body || {};
    const devise = deviseValide(b.devise), contact = contactValide(b.contact);
    const annonceur = txt(b.annonceur, 120), titre = txt(b.titre, 80), texte = txt(b.texte, 300), lien = txt(b.lien, 300);
    if (annonceur.length < 2) throw new ErrUtil('Indiquez le nom de l\'annonceur.');
    if (titre.length < 3) throw new ErrUtil('Indiquez un titre (80 caractères maximum).');
    if (lien && !/^https?:\/\/[^\s]+\.[^\s]+/.test(lien)) throw new ErrUtil('Le lien doit commencer par https://');
    const forfait = (await reglage('forfaits_annonces')).find(f => f.jours === entier(b.jours, 1, 365));
    if (!forfait) throw new ErrUtil('Choisissez une durée de diffusion.');
    const image = b.image ? imagesValides(b.image, 1)[0] : null;
    const montant = await prixEn(forfait.prix_usd, devise), reference = nouvelleRef('PUB');
    await q(`INSERT INTO ongd_annonces(reference, annonceur, contact, titre, texte, lien, image, image_type, jours, montant, devise, mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manuel')`,
      [reference, annonceur, contact, titre, texte || null, lien || null, image?.buf || null, image?.type || null, forfait.jours, montant, devise]);
    const pay = await initierPaiement(req, { reference, montant, devise, description: 'Annonce sur le site ONGD Les Volontaires', nom: annonceur, contact });
    res.status(201).json({ reference, montant, devise, ...pay });
  }));
  r.get('/annonces/actives', wrap(async (req, res) => {
    const { rows } = await q(`SELECT id, annonceur, titre, texte, lien, (image IS NOT NULL) a_image FROM ongd_annonces
      WHERE statut = 'active' AND fin > now() ORDER BY random() LIMIT 3`);
    res.set('Cache-Control', 'no-cache');
    res.json({ annonces: rows });
  }));
  r.get('/admin/annonces', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT id, reference, annonceur, contact, titre, texte, lien, (image IS NOT NULL) a_image, jours, montant::float, devise, mode, statut,
      ref_paiement, operateur, debut, fin, motif, cree_le, paye_le,
      CASE WHEN statut = 'active' AND fin < now() THEN true ELSE false END AS expiree
      FROM ongd_annonces ORDER BY (statut IN ('declare','payee')) DESC, id DESC LIMIT 300`);
    res.json({ annonces: rows });
  }));
  r.patch('/admin/annonces/:id', admin, wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9), action = req.body?.action;
    let rc;
    if (action === 'activer') rc = await q("UPDATE ongd_annonces SET statut = 'active', debut = now(), fin = now() + make_interval(days => jours) WHERE id = $1 AND statut = 'payee'", [id]);
    else if (action === 'refuser') rc = await q("UPDATE ongd_annonces SET statut = 'refusee', motif = $2 WHERE id = $1 AND statut IN ('payee','declare','en_attente','active')", [id, txt(req.body?.motif, 300) || null]);
    else if (action === 'arreter') rc = await q("UPDATE ongd_annonces SET fin = now() WHERE id = $1 AND statut = 'active'", [id]);
    else throw new ErrUtil('Action inconnue.');
    if (!rc.rowCount) throw new ErrUtil(action === 'activer' ? 'Seule une annonce payée peut être activée.' : 'Action impossible pour cette annonce.');
    journal('annonce_' + action, req, 'annonce ' + id);
    res.json({ ok: true });
  }));

  /* ================= ESPACE DE DIALOGUE ================= */
  const CATEGORIES = ['Questions', 'Idées', 'Témoignages', 'Volontariat', 'Autre'];
  async function repondreAuto(sujetId, titre, message) {
    if (!iaPrete() || !(await reglage('reponses_auto'))) return;
    const texte = await ia(await presentationIa() + '\nTâche : tu réponds publiquement à un nouveau sujet de l\'espace de dialogue du site. Réponse utile et bienveillante, 120 mots maximum. Si la question demande une décision de l\'équipe, dis que l\'équipe va compléter.',
      [{ role: 'user', content: `Sujet : ${titre}\n\n${message}` }], 500, 20000);
    if (texte) await q("INSERT INTO ongd_reponses(sujet_id, nom, message, auto) VALUES($1, 'Assistant de l''ONGD', $2, true)", [sujetId, texte]);
  }
  r.get('/sujets', wrap(async (req, res) => {
    const page = Math.max(1, entier(req.query.page, 1, 1000) || 1);
    const cat = CATEGORIES.includes(req.query.categorie) ? req.query.categorie : null;
    const { rows } = await q(`SELECT s.id, s.titre, s.categorie, s.nom, left(s.message, 220) extrait, s.epingle, s.cree_le, s.derniere_activite,
      (SELECT count(*)::int FROM ongd_reponses x WHERE x.sujet_id = s.id AND x.statut = 'visible') reponses
      FROM ongd_sujets s WHERE s.statut = 'visible' AND ($3::text IS NULL OR s.categorie = $3)
      ORDER BY s.epingle DESC, s.derniere_activite DESC LIMIT $1 OFFSET $2`, [21, (page - 1) * 20, cat]);
    res.set('Cache-Control', 'no-cache');
    res.json({ sujets: rows.slice(0, 20), suite: rows.length > 20, categories: CATEGORIES });
  }));
  r.get('/sujets/:id', wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9);
    const s = (await q("SELECT id, titre, categorie, nom, message, epingle, cree_le FROM ongd_sujets WHERE id = $1 AND statut = 'visible'", [id])).rows[0];
    if (!s) return res.status(404).json({ erreur: 'Sujet introuvable.' });
    const rep = await q("SELECT id, nom, message, auto, admin, cree_le FROM ongd_reponses WHERE sujet_id = $1 AND statut = 'visible' ORDER BY id", [id]);
    res.set('Cache-Control', 'no-cache');
    res.json({ ...s, reponses: rep.rows });
  }));
  r.post('/sujets', anti(5, 60, 'sujets'), antiRobot, wrap(async (req, res) => {
    const b = req.body || {};
    const titre = txt(b.titre, 150), nom = txt(b.nom, 80), message = txt(b.message, 4000);
    if (nom.length < 2) throw new ErrUtil('Indiquez votre nom ou pseudo.');
    if (titre.length < 5) throw new ErrUtil('Le titre est trop court.');
    if (message.length < 10) throw new ErrUtil('Votre message est trop court.');
    await verifierTexte(titre, message, nom);
    const cat = CATEGORIES.includes(b.categorie) ? b.categorie : 'Autre';
    const { rows } = await q('INSERT INTO ongd_sujets(titre, categorie, nom, message) VALUES($1,$2,$3,$4) RETURNING id', [titre, cat, nom, message]);
    repondreAuto(rows[0].id, titre, message).catch(e => console.error('[ONGD] réponse auto', e.message));
    res.status(201).json({ ok: true, id: rows[0].id, message: 'Sujet publié.' });
  }));
  r.post('/sujets/:id/reponses', anti(15, 60, 'reponses'), antiRobot, wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9), nom = txt(req.body?.nom, 80), message = txt(req.body?.message, 3000);
    if (nom.length < 2) throw new ErrUtil('Indiquez votre nom ou pseudo.');
    if (message.length < 2) throw new ErrUtil('Écrivez votre réponse.');
    await verifierTexte(message, nom);
    if (!(await q("SELECT 1 FROM ongd_sujets WHERE id = $1 AND statut = 'visible'", [id])).rowCount) throw new ErrUtil('Sujet introuvable.');
    await q('INSERT INTO ongd_reponses(sujet_id, nom, message) VALUES($1,$2,$3)', [id, nom, message]);
    await q('UPDATE ongd_sujets SET derniere_activite = now() WHERE id = $1', [id]);
    res.status(201).json({ ok: true });
  }));
  r.get('/admin/sujets', admin, wrap(async (req, res) => {
    const { rows } = await q(`SELECT s.*, COALESCE((SELECT json_agg(x ORDER BY x.id) FROM ongd_reponses x WHERE x.sujet_id = s.id), '[]') reponses
      FROM ongd_sujets s ORDER BY s.derniere_activite DESC LIMIT 100`);
    res.json({ sujets: rows });
  }));
  r.patch('/admin/sujets/:id', admin, wrap(async (req, res) => {
    const id = entier(req.params.id, 1, 2e9), b = req.body || {};
    if (b.statut) await q('UPDATE ongd_sujets SET statut = $2 WHERE id = $1', [id, b.statut === 'masque' ? 'masque' : 'visible']);
    if (b.epingle !== undefined) await q('UPDATE ongd_sujets SET epingle = $2 WHERE id = $1', [id, !!b.epingle]);
    res.json({ ok: true });
  }));
  r.delete('/admin/sujets/:id', admin, wrap(async (req, res) => { await q('DELETE FROM ongd_sujets WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
  r.post('/admin/sujets/:id/reponses', admin, wrap(async (req, res) => {
    const message = txt(req.body?.message, 3000);
    if (message.length < 2) throw new ErrUtil('Écrivez la réponse.');
    await q("INSERT INTO ongd_reponses(sujet_id, nom, message, admin) VALUES($1, 'ONGD Les Volontaires', $2, true)", [req.params.id, message]);
    await q('UPDATE ongd_sujets SET derniere_activite = now() WHERE id = $1', [req.params.id]);
    res.status(201).json({ ok: true });
  }));
  r.patch('/admin/reponses/:id', admin, wrap(async (req, res) => {
    await q('UPDATE ongd_reponses SET statut = $2 WHERE id = $1', [req.params.id, req.body?.statut === 'masque' ? 'masque' : 'visible']);
    res.json({ ok: true });
  }));

  /* ================= RÉUNIONS VIRTUELLES ET LIVES ================= */
  // Salles Jitsi Meet (gratuit, sans compte pour les participants) ou lien YouTube / Facebook / Eaji
  const salleJitsi = () => 'https://meet.jit.si/LesVolontaires-' + crypto.randomBytes(8).toString('hex');
  const youtubeId = u => { const m = /(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(u || ''); return m ? m[1] : null; };
  function lienValide(lien) {
    lien = txt(lien, 400);
    if (!lien) return null;
    if (!/^https:\/\/[^\s]+$/.test(lien)) throw new ErrUtil('Le lien doit commencer par https://');
    return lien;
  }
  const publicDirect = d => {
    const prive = !!d.code_hash;
    const yt = youtubeId(d.lien);
    return { id: d.id, type: d.type, titre: d.titre, description: d.description, debut: d.debut, statut: d.statut, prive, auteur: d.auteur,
      plateforme: yt ? 'youtube' : /meet\.jit\.si/.test(d.lien) ? 'jitsi' : 'lien',
      youtube: !prive && yt ? yt : null, url: prive ? null : d.lien };
  };
  const SELECT_DIRECT = `SELECT d.*, COALESCE(v.nom, 'ONGD Les Volontaires') auteur FROM ongd_directs d LEFT JOIN ongd_volontaires v ON v.id = d.volontaire_id`;
  async function fermerAnciens() {
    await q("UPDATE ongd_directs SET statut = 'termine' WHERE statut = 'en_cours' AND COALESCE(demarre_le, debut, cree_le) < now() - interval '12 hours'");
  }

  r.get('/directs', wrap(async (req, res) => {
    await fermerAnciens();
    const { rows } = await q(`${SELECT_DIRECT} WHERE d.statut = 'en_cours'
      OR (d.statut = 'prevu' AND (d.debut IS NULL OR d.debut > now() - interval '3 hours')) ORDER BY (d.statut = 'en_cours') DESC, d.debut NULLS LAST LIMIT 30`);
    res.set('Cache-Control', 'no-cache');
    res.json({ directs: rows.map(publicDirect) });
  }));
  r.post('/directs/:id/rejoindre', anti(20, 15, 'rejoindre'), wrap(async (req, res) => {
    const d = (await q('SELECT * FROM ongd_directs WHERE id = $1', [entier(req.params.id, 1, 2e9)])).rows[0];
    if (!d || d.statut === 'termine') throw new ErrUtil('Ce direct est terminé.');
    if (d.code_hash && hacherCode(req.body?.code || '') !== d.code_hash) throw new ErrUtil('Code d\'accès incorrect.');
    res.json({ url: d.lien });
  }));

  async function creerDirect(b, volontaireId) {
    const type = b.type === 'reunion' ? 'reunion' : 'live';
    const titre = txt(b.titre, 150);
    if (titre.length < 3) throw new ErrUtil('Indiquez un titre.');
    const lien = lienValide(b.lien) || salleJitsi();
    const code = txt(b.code, 40);
    const enCours = volontaireId ? true : !!b.maintenant;
    const { rows } = await q(`INSERT INTO ongd_directs(type, titre, description, debut, lien, code_hash, statut, demarre_le, volontaire_id)
      VALUES($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 = 'en_cours' THEN now() END, $8) RETURNING *`,
      [type, titre, txt(b.description, 1000) || null, dateOuNull(b.debut) || (enCours ? new Date() : null), lien, code ? hacherCode(code) : null,
        enCours ? 'en_cours' : 'prevu', volontaireId || null]);
    return rows[0];
  }
  r.get('/admin/directs', admin, wrap(async (req, res) => {
    await fermerAnciens();
    res.json({ directs: (await q(`${SELECT_DIRECT} ORDER BY d.id DESC LIMIT 100`)).rows.map(d => ({ ...publicDirect(d), url: d.lien })) });
  }));
  r.post('/admin/directs', admin, wrap(async (req, res) => {
    const d = await creerDirect(req.body || {}, null);
    res.status(201).json({ ok: true, url: d.lien, message: d.statut === 'en_cours' ? 'C\'est en direct !' : 'Programmé.' });
  }));
  r.patch('/admin/directs/:id', admin, wrap(async (req, res) => {
    const s = req.body?.statut;
    if (!['en_cours', 'termine'].includes(s)) throw new ErrUtil('Statut inconnu.');
    await q(`UPDATE ongd_directs SET statut = $2, demarre_le = CASE WHEN $2 = 'en_cours' THEN now() ELSE demarre_le END WHERE id = $1`, [req.params.id, s]);
    res.json({ ok: true });
  }));
  r.delete('/admin/directs/:id', admin, wrap(async (req, res) => { await q('DELETE FROM ongd_directs WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));

  // Les volontaires actifs peuvent lancer un live depuis le terrain
  r.get('/volontaires/directs', volontaire, wrap(async (req, res) => {
    await fermerAnciens();
    const { rows } = await q(`${SELECT_DIRECT} WHERE d.volontaire_id = $1 ORDER BY d.id DESC LIMIT 20`, [req.ongd.volontaire_id]);
    res.json({ directs: rows.map(d => ({ ...publicDirect(d), url: d.lien })) });
  }));
  r.post('/volontaires/directs', volontaire, anti(6, 60, 'live_vol'), wrap(async (req, res) => {
    const d = await creerDirect({ ...(req.body || {}), type: 'live' }, req.ongd.volontaire_id);
    journal('live_volontaire', req, `${req.ongd.nom} : ${d.titre}`);
    res.status(201).json({ ok: true, url: d.lien, message: 'Votre live est annoncé sur le site.' });
  }));
  r.patch('/volontaires/directs/:id', volontaire, wrap(async (req, res) => {
    await q("UPDATE ongd_directs SET statut = 'termine' WHERE id = $1 AND volontaire_id = $2", [req.params.id, req.ongd.volontaire_id]);
    res.json({ ok: true });
  }));

  /* ================= SUIVI D'UN PAIEMENT (page paiement.html) ================= */
  r.get('/paiements/:reference', wrap(async (req, res) => {
    const ref = txt(req.params.reference, 60), t = ctx.typeDe(ref);
    if (!t || t.table === 'ongd_dons') return res.status(404).json({ erreur: 'Référence introuvable.' });
    const lire = () => q(`SELECT * FROM ${t.table} WHERE reference = $1`, [ref]).then(x => x.rows[0]);
    let x = await lire();
    if (!x) return res.status(404).json({ erreur: 'Référence introuvable.' });
    if (x.mode === 'cinetpay' && x.statut === 'en_attente') { await verifierCinetpay(ref); x = await lire(); }
    const out = { reference: ref, type: ref.slice(0, 3), montant: Number(x.montant), devise: x.devise, statut: x.statut, mode: x.mode };
    if (out.type === 'INS') {
      const p = (await q('SELECT type, titre, debut, lieu FROM ongd_programmes WHERE id = $1', [x.programme_id])).rows[0];
      Object.assign(out, { programme: p, places: x.places, code: x.statut === 'confirme' ? x.code : null });
    }
    if (out.type === 'CMD') Object.assign(out, { articles: x.articles, livraison: x.livraison });
    if (out.type === 'PUB') Object.assign(out, { titre: x.titre, jours: x.jours, fin: x.fin });
    res.json(out);
  }));

  /* ================= CONTEXTE POUR L'ASSISTANT IA ================= */
  async function contexteIa() {
    const [p, pr, f] = await Promise.all([
      q("SELECT type, titre, resume, lieu, en_ligne, debut, prix_usd FROM ongd_programmes WHERE statut = 'publie' AND COALESCE(fin, debut, now()) >= now() - interval '1 day' ORDER BY debut NULLS LAST LIMIT 15"),
      q('SELECT nom, prix_usd, stock FROM ongd_produits WHERE actif ORDER BY id DESC LIMIT 20'),
      reglage('forfaits_annonces'),
    ]);
    const d = x => x ? new Date(x).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa', dateStyle: 'long', timeStyle: 'short' }) : 'date à confirmer';
    return [
      p.rows.length ? 'Formations et événements à venir :\n' + p.rows.map(x => `- ${x.type === 'formation' ? 'Formation' : 'Événement'} « ${x.titre} » : ${d(x.debut)}, ${x.en_ligne ? 'en ligne' : x.lieu || 'lieu à confirmer'}, ${x.prix_usd ? x.prix_usd + ' $' : 'gratuit'}${x.resume ? ' — ' + x.resume : ''}`).join('\n') : 'Aucune formation ni événement programmé pour le moment.',
      pr.rows.length ? 'Boutique :\n' + pr.rows.map(x => `- ${x.nom} : ${x.prix_usd} $${x.stock === 0 ? ' (épuisé)' : ''}`).join('\n') : '',
      'Annonces sur le site : ' + f.map(x => `${x.jours} jours pour ${x.prix_usd} $`).join(', ') + '.',
      `Date du jour : ${d(new Date())}.`,
    ].filter(Boolean).join('\n');
  }

  /* ================= TABLES ================= */
  function creerTables() {
    return q(`
      CREATE TABLE IF NOT EXISTS ongd_programmes (
        id SERIAL PRIMARY KEY, type TEXT NOT NULL, titre TEXT NOT NULL, resume TEXT, description TEXT, lieu TEXT,
        en_ligne BOOLEAN NOT NULL DEFAULT false, debut TIMESTAMPTZ, fin TIMESTAMPTZ, places INT, prix_usd INT NOT NULL DEFAULT 0,
        image BYTEA, image_type TEXT, statut TEXT NOT NULL DEFAULT 'publie', cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ongd_etapes (
        id SERIAL PRIMARY KEY, programme_id INT NOT NULL REFERENCES ongd_programmes(id) ON DELETE CASCADE,
        ordre INT NOT NULL DEFAULT 0, titre TEXT NOT NULL, contenu TEXT, video_url TEXT);
      CREATE TABLE IF NOT EXISTS ongd_inscriptions (
        id SERIAL PRIMARY KEY, programme_id INT NOT NULL REFERENCES ongd_programmes(id) ON DELETE CASCADE,
        code TEXT UNIQUE NOT NULL, reference TEXT UNIQUE NOT NULL, nom TEXT NOT NULL, telephone TEXT NOT NULL, email TEXT,
        places INT NOT NULL DEFAULT 1, montant NUMERIC(14,2) NOT NULL DEFAULT 0, devise TEXT NOT NULL DEFAULT 'USD', mode TEXT NOT NULL,
        statut TEXT NOT NULL DEFAULT 'en_attente', ref_paiement TEXT, operateur TEXT, present BOOLEAN NOT NULL DEFAULT false,
        progression JSONB NOT NULL DEFAULT '[]', cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), paye_le TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS ongd_produits (
        id SERIAL PRIMARY KEY, nom TEXT NOT NULL, description TEXT, prix_usd INT NOT NULL, stock INT, actif BOOLEAN NOT NULL DEFAULT true,
        image BYTEA, image_type TEXT, cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ongd_commandes (
        id SERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, nom TEXT NOT NULL, contact TEXT NOT NULL, livraison TEXT,
        articles JSONB NOT NULL, total_usd INT NOT NULL, montant NUMERIC(14,2) NOT NULL, devise TEXT NOT NULL, mode TEXT NOT NULL,
        statut TEXT NOT NULL DEFAULT 'en_attente', ref_paiement TEXT, operateur TEXT, cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), paye_le TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS ongd_annonces (
        id SERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, annonceur TEXT NOT NULL, contact TEXT NOT NULL, titre TEXT NOT NULL,
        texte TEXT, lien TEXT, image BYTEA, image_type TEXT, jours INT NOT NULL, montant NUMERIC(14,2) NOT NULL, devise TEXT NOT NULL,
        mode TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'en_attente', ref_paiement TEXT, operateur TEXT, motif TEXT,
        debut TIMESTAMPTZ, fin TIMESTAMPTZ, cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), paye_le TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS ongd_sujets (
        id SERIAL PRIMARY KEY, titre TEXT NOT NULL, categorie TEXT NOT NULL, nom TEXT NOT NULL, message TEXT NOT NULL,
        statut TEXT NOT NULL DEFAULT 'visible', epingle BOOLEAN NOT NULL DEFAULT false,
        cree_le TIMESTAMPTZ NOT NULL DEFAULT now(), derniere_activite TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ongd_reponses (
        id SERIAL PRIMARY KEY, sujet_id INT NOT NULL REFERENCES ongd_sujets(id) ON DELETE CASCADE, nom TEXT NOT NULL, message TEXT NOT NULL,
        auto BOOLEAN NOT NULL DEFAULT false, admin BOOLEAN NOT NULL DEFAULT false, statut TEXT NOT NULL DEFAULT 'visible',
        cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ongd_directs (
        id SERIAL PRIMARY KEY, type TEXT NOT NULL, titre TEXT NOT NULL, description TEXT, debut TIMESTAMPTZ, lien TEXT NOT NULL,
        code_hash TEXT, statut TEXT NOT NULL DEFAULT 'prevu', demarre_le TIMESTAMPTZ,
        volontaire_id INT REFERENCES ongd_volontaires(id) ON DELETE SET NULL, cree_le TIMESTAMPTZ NOT NULL DEFAULT now());
    `);
  }

  return { creerTables, contexteIa };
};
