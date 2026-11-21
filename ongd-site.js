'use strict';
/*
 * ONGD Les Volontaires — le site ongdlesvolontaires.eaji.org servi par ce serveur
 *  - Les pages viennent du dépôt GitHub du site (jimmynho/ongd.lesvolontaires-site) :
 *    vous continuez à mettre le site à jour dans GitHub, comme avant (visible en 1 à 5 minutes).
 *  - Un lien de publication (https://ongdlesvolontaires.eaji.org/?p=12) montre sur Facebook, WhatsApp…
 *    le titre, la photo et le texte de cette publication, puis l'ouvre directement sur le site.
 * Chargé automatiquement par ongd-routes.js : rien à ajouter dans server.js.
 * Variables facultatives : ONGD_SITE_DEPOT (adresse « raw » du dépôt), ONGD_SITE_HOTES (noms de domaine, séparés par des virgules).
 */
const TYPES = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8', xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', ico: 'image/x-icon', pdf: 'application/pdf', mp4: 'video/mp4', woff2: 'font/woff2', woff: 'font/woff',
};
const DUREE_CACHE = 60 * 1000; // une page est redemandée à GitHub au plus une fois par minute

module.exports = function (app, { q, SELECT_ACTIVITE, SITE_URL }) {
  const DEPOT = (process.env.ONGD_SITE_DEPOT || 'https://raw.githubusercontent.com/jimmynho/ongd.lesvolontaires-site/main/').replace(/\/?$/, '/');
  const HOTES = (process.env.ONGD_SITE_HOTES || new URL(SITE_URL).hostname).split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  const cache = new Map();
  const echapper = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function lire(chemin) {
    const c = cache.get(chemin);
    if (c && Date.now() - c.le < DUREE_CACHE) return c.fichier;
    try {
      const ctrl = new AbortController(), minuterie = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(DEPOT + chemin.slice(1).split('/').map(encodeURIComponent).join('/'), { signal: ctrl.signal });
      clearTimeout(minuterie);
      if (r.status === 404) { cache.set(chemin, { le: Date.now(), fichier: null }); return null; }
      if (!r.ok) throw new Error('GitHub ' + r.status);
      const fichier = Buffer.from(await r.arrayBuffer());
      if (fichier.length < 20 * 1024 * 1024) cache.set(chemin, { le: Date.now(), fichier });
      return fichier;
    } catch (e) {
      console.error('[ONGD] site : lecture de', chemin, e.message);
      return c ? c.fichier : undefined; // GitHub indisponible : dernière version connue
    }
  }

  // Lien d'une publication : le titre, la photo et le texte remplacent ceux du site dans l'aperçu
  async function avecApercu(html, id) {
    const { rows } = await q(`${SELECT_ACTIVITE} WHERE a.id = $1 AND a.statut = 'publie'`, [id]);
    const a = rows[0];
    if (!a) return html;
    const url = `${SITE_URL}/?p=${a.id}`;
    const titre = `${a.titre} — ONGD Les Volontaires`;
    const texte = a.texte.replace(/\s+/g, ' ').slice(0, 280) + (a.texte.length > 280 ? '…' : '');
    const image = a.photos.length ? `${SITE_URL}/api/ongd/photos/${a.photos[0]}` : `${SITE_URL}/affiche-ongd.jpg`;
    const meta = (attr, nom, valeur) => {
      const re = new RegExp(`(<meta\\s+${attr}="${nom}"\\s+content=")[^"]*(")`, 'i');
      html = re.test(html) ? html.replace(re, `$1${echapper(valeur)}$2`) : html.replace('</head>', `<meta ${attr}="${nom}" content="${echapper(valeur)}">\n</head>`);
    };
    html = html.replace(/<title>[^<]*<\/title>/i, `<title>${echapper(titre)}</title>`)
      .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/i, `$1${echapper(url)}$2`);
    meta('name', 'description', texte);
    meta('property', 'og:type', 'article');
    meta('property', 'og:url', url);
    meta('property', 'og:title', a.titre);
    meta('property', 'og:description', texte);
    meta('property', 'og:image', image);
    meta('property', 'og:image:alt', a.titre);
    meta('name', 'twitter:title', a.titre);
    meta('name', 'twitter:description', texte);
    meta('name', 'twitter:image', image);
    return html;
  }

  app.use(async (req, res, next) => {
    if (!HOTES.includes(String(req.hostname || '').toLowerCase()) || req.path.startsWith('/api/')) return next();
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);
      let chemin;
      try { chemin = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
      if (chemin.endsWith('/')) chemin += 'index.html';
      if (chemin.includes('..') || !/^\/[A-Za-z0-9._\-/]+$/.test(chemin)) return res.sendStatus(404);
      let ext = (chemin.match(/\.([a-z0-9]+)$/i) || [])[1];
      if (!ext) { chemin += '.html'; ext = 'html'; } // /formations → formations.html (comme GitHub Pages)
      ext = ext.toLowerCase();
      let fichier = await lire(chemin);
      if (fichier === undefined) return res.status(503).type('html').send('<p>Site momentanément indisponible. Réessayez dans un instant.</p>');
      if (fichier === null) {
        return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page introuvable — ONGD Les Volontaires</title><body style="font-family:sans-serif;padding:32px;text-align:center"><h1>Page introuvable</h1><p><a href="/">Retour à l'accueil de l'ONGD Les Volontaires</a></p></body>`);
      }
      const p = parseInt(req.query.p, 10);
      if (chemin === '/index.html' && p > 0) fichier = Buffer.from(await avecApercu(fichier.toString('utf8'), p), 'utf8');
      res.set('Content-Type', TYPES[ext] || 'application/octet-stream');
      res.set('Cache-Control', ext === 'html' || chemin === '/sw.js' ? 'no-cache' : 'public, max-age=300');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Strict-Transport-Security', 'max-age=31536000');
      res.send(fichier);
    } catch (e) { next(e); }
  });
};
