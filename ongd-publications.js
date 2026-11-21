'use strict';
/*
 * ONGD Les Volontaires — publications (activités)
 *  - Une publication entière (texte, photos, vidéo) avec « J'aime », commentaires et partage
 *  - Page d'aperçu pour Facebook / WhatsApp (titre, photo et résumé de la publication)
 *  - Correction d'une publication par l'administration (texte, photos, vidéo)
 * Chargé automatiquement par ongd-routes.js : rien à ajouter dans server.js.
 */
const crypto = require('crypto');

module.exports = function (ctx) {
  const { r, pool, q, wrap, anti, antiRobot, admin, txt, ErrUtil, journal, reglage, SELECT_ACTIVITE, photosValides, videoValide, SITE_URL } = ctx;
  const idDe = v => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 && n < 2e9 ? n : null; };
  const echapper = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Le visiteur est reconnu par un numéro tiré au hasard sur son téléphone (ni compte, ni adresse IP gardée)
  const visiteurDe = v => /^[A-Za-z0-9_-]{16,64}$/.test(String(v || '')) ? crypto.createHash('sha256').update('ongd-jaime:' + v).digest('hex').slice(0, 32) : null;

  async function publiee(id) {
    const { rows } = await q(`${SELECT_ACTIVITE} WHERE a.id = $1 AND a.statut = 'publie'`, [id]);
    const a = rows[0];
    if (a) delete a.auteur_telephone;
    return a || null;
  }
  const nonTrouvee = () => new ErrUtil('Cette publication n\'existe plus.');

  async function texteAutorise(...textes) {
    const tout = textes.join(' ').toLowerCase();
    if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|info|xyz|io|me|ly|cd)\b)/i.test(tout))
      throw new ErrUtil('Les liens ne sont pas autorisés dans les commentaires.');
    const interdits = await reglage('mots_interdits');
    if ((interdits || []).some(m => m && tout.includes(m))) throw new ErrUtil('Votre commentaire contient des mots non autorisés.');
  }

  /* ================= PUBLIC ================= */
  r.get('/activites/:id', wrap(async (req, res) => {
    const a = await publiee(idDe(req.params.id));
    if (!a) return res.status(404).json({ erreur: 'Cette publication n\'existe plus.' });
    res.set('Cache-Control', 'no-cache');
    res.json({ activite: a });
  }));

  // Vidéo : renvoie vers un lien Backblaze temporaire (lecture dans la page)
  r.get('/activites/:id/video', wrap(async (req, res) => {
    const id = idDe(req.params.id);
    const { rows } = await q("SELECT video_cle, video_type FROM ongd_activites WHERE id = $1 AND statut = 'publie'", [id]);
    const sto = ctx.sto && ctx.sto();
    if (!rows[0]?.video_cle || !sto) return res.sendStatus(404);
    res.set('Cache-Control', 'private, max-age=3000');
    res.redirect(302, await sto.urlVoir(rows[0].video_cle, rows[0].video_type));
  }));

  r.get('/activites/:id/interactions', wrap(async (req, res) => {
    const id = idDe(req.params.id), v = visiteurDe(req.query.v);
    const [j, moi, c] = await Promise.all([
      q('SELECT count(*)::int n FROM ongd_jaime WHERE activite_id = $1', [id]),
      v ? q('SELECT 1 FROM ongd_jaime WHERE activite_id = $1 AND visiteur = $2', [id, v]) : { rowCount: 0 },
      q('SELECT id, nom, texte, cree_le FROM ongd_commentaires WHERE activite_id = $1 ORDER BY id DESC LIMIT 200', [id]),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ jaime: j.rows[0].n, moi: !!moi.rowCount, commentaires: c.rows.reverse() });
  }));

  r.post('/activites/:id/jaime', anti(60, 10, 'jaime'), wrap(async (req, res) => {
    const id = idDe(req.params.id), v = visiteurDe(req.body?.v);
    if (!v) throw new ErrUtil('Rechargez la page puis réessayez.');
    if (!(await publiee(id))) throw nonTrouvee();
    const retire = await q('DELETE FROM ongd_jaime WHERE activite_id = $1 AND visiteur = $2', [id, v]);
    if (!retire.rowCount) await q('INSERT INTO ongd_jaime(activite_id, visiteur) VALUES($1, $2) ON CONFLICT DO NOTHING', [id, v]);
    const n = (await q('SELECT count(*)::int n FROM ongd_jaime WHERE activite_id = $1', [id])).rows[0].n;
    res.json({ jaime: n, moi: !retire.rowCount });
  }));

  r.post('/activites/:id/commentaires', anti(8, 30, 'commenter'), antiRobot, wrap(async (req, res) => {
    const id = idDe(req.params.id), b = req.body || {};
    const nom = txt(b.nom, 60), texte = txt(b.texte, 1000);
    if (nom.length < 2) throw new ErrUtil('Indiquez votre nom.');
    if (texte.length < 2) throw new ErrUtil('Écrivez votre commentaire.');
    await texteAutorise(nom, texte);
    if (!(await publiee(id))) throw nonTrouvee();
    const { rows } = await q('INSERT INTO ongd_commentaires(activite_id, nom, texte) VALUES($1,$2,$3) RETURNING id, nom, texte, cree_le', [id, nom, texte]);
    res.status(201).json({ ok: true, commentaire: rows[0], message: 'Merci pour votre commentaire !' });
  }));

  // Page d'aperçu pour le partage : Facebook et WhatsApp y lisent le titre, la photo et le résumé,
  // puis la personne qui clique est envoyée sur la publication dans le site.
  r.get('/partage/:id', wrap(async (req, res) => {
    const id = idDe(req.params.id);
    const a = id && await publiee(id);
    const cible = a ? `${SITE_URL}/?p=${a.id}` : SITE_URL + '/';
    const base = `${req.protocol}://${req.get('host')}/api/ongd`;
    const image = a?.photos?.length ? `${base}/photos/${a.photos[0]}` : `${SITE_URL}/icone-512.png`;
    const titre = a ? a.titre : 'ONGD Les Volontaires';
    const resume = a ? a.texte.replace(/\s+/g, ' ').slice(0, 220) + (a.texte.length > 220 ? '…' : '') : 'Agir ensemble, là où on a besoin de nous.';
    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${echapper(titre)} — ONGD Les Volontaires</title>
<meta name="description" content="${echapper(resume)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="ONGD Les Volontaires">
<meta property="og:title" content="${echapper(titre)}">
<meta property="og:description" content="${echapper(resume)}">
<meta property="og:image" content="${echapper(image)}">
<meta property="og:locale" content="fr_FR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${echapper(titre)}">
<meta name="twitter:description" content="${echapper(resume)}">
<meta name="twitter:image" content="${echapper(image)}">
<meta http-equiv="refresh" content="0;url=${echapper(cible)}">
</head><body style="font-family:sans-serif;padding:24px">
<p><a href="${echapper(cible)}">Voir la publication sur le site de l'ONGD Les Volontaires</a></p>
</body></html>`);
  }));

  /* ================= ADMINISTRATION ================= */
  // Corriger une publication : texte, date, lieu, photos (garder / retirer / ajouter) et vidéo
  r.put('/admin/activites/:id', admin, wrap(async (req, res) => {
    const id = idDe(req.params.id), b = req.body || {};
    const avant = (await q('SELECT id, video_cle FROM ongd_activites WHERE id = $1', [id])).rows[0];
    if (!avant) throw new ErrUtil('Publication introuvable.');
    const titre = txt(b.titre, 150), texte = txt(b.texte, 8000), lieu = txt(b.lieu, 150);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date_activite || '') ? b.date_activite : null;
    if (titre.length < 3) throw new ErrUtil("Donnez un titre à l'activité.");
    if (texte.length < 20) throw new ErrUtil("Décrivez l'activité (au moins 20 caractères).");
    const actuelles = (await q('SELECT id FROM ongd_photos WHERE activite_id = $1', [id])).rows.map(x => x.id);
    const garder = (Array.isArray(b.garder) ? b.garder : []).map(idDe).filter(x => actuelles.includes(x));
    const nouvelles = photosValides(b.photos);
    if (garder.length + nouvelles.length > 4) throw new ErrUtil('4 photos maximum.');
    const nouvelleVideo = b.video_cle ? await videoValide(b.video_cle, b.video_nom) : null;
    const retirerVideo = !!nouvelleVideo || b.retirer_video === true;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE ongd_activites SET titre = $2, texte = $3, lieu = $4, date_activite = $5, modifie_le = now()
        ${retirerVideo ? ', video_cle = $6, video_type = $7' : ''} WHERE id = $1`,
        retirerVideo ? [id, titre, texte, lieu || null, date, nouvelleVideo?.cle || null, nouvelleVideo?.type || null] : [id, titre, texte, lieu || null, date]);
      await client.query('DELETE FROM ongd_photos WHERE activite_id = $1 AND NOT (id = ANY($2::int[]))', [id, garder]);
      for (const [i, pid] of garder.entries()) await client.query('UPDATE ongd_photos SET ordre = $2 WHERE id = $1', [pid, i]);
      for (const [i, p] of nouvelles.entries())
        await client.query('INSERT INTO ongd_photos(activite_id, ordre, type, donnees) VALUES($1,$2,$3,$4)', [id, garder.length + i, p.type, p.buf]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    if (retirerVideo && avant.video_cle && avant.video_cle !== nouvelleVideo?.cle)
      ctx.sto?.()?.supprimer(avant.video_cle).catch(e => console.error('[ONGD] suppression vidéo', e.message));
    journal('activite_modifiee', req, 'activité ' + id);
    res.json({ ok: true, message: 'Publication corrigée.' });
  }));

  r.get('/admin/commentaires', admin, wrap(async (req, res) => {
    const id = idDe(req.query.activite);
    const { rows } = await q(`SELECT c.id, c.activite_id, c.nom, c.texte, c.cree_le, a.titre FROM ongd_commentaires c
      JOIN ongd_activites a ON a.id = c.activite_id ${id ? 'WHERE c.activite_id = $1' : ''} ORDER BY c.id DESC LIMIT 200`, id ? [id] : []);
    res.json({ commentaires: rows });
  }));

  r.delete('/admin/commentaires/:id', admin, wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM ongd_commentaires WHERE id = $1', [idDe(req.params.id)]);
    if (!rowCount) throw new ErrUtil('Commentaire introuvable.');
    journal('commentaire_supprime', req, 'commentaire ' + req.params.id);
    res.json({ ok: true, message: 'Commentaire supprimé.' });
  }));
};
