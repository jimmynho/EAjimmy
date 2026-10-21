// Eaji — pages publiques pour les moteurs de recherche (Google, Bing…) et les aperçus de liens.
//  • /p/:id      une publication publique (titre, auteur, photo, paroles…) + « Ouvrir dans Eaji »
//  • /u/:id      le profil public d'un créateur et ses publications publiques
//  • /decouvrir  les dernières publications publiques, avec une recherche (?q=mot)
//  • /sitemap.xml et /robots.txt : la liste des pages à lire pour Google
// Seul ce qui est déjà PUBLIC dans l'appli apparaît : jamais les contenus réservés aux abonnés,
// jamais les comptes suspendus, jamais les fichiers des contenus payants, jamais les numéros ou emails.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const VISIBLE = "c.status = 'actif' AND c.visibility_scope = 'public' AND cr.account_status = 'actif'";

const TYPE_FR = { video_courte: 'Vidéo', video_longue: 'Vidéo', film: 'Film', telechargement: 'Vidéo', photo: 'Photo', publication: 'Publication',
  musique: 'Musique', audio: 'Audio', podcast: 'Podcast', livre: 'Livre', pdf: 'Document PDF', powerpoint: 'Présentation', live: 'Live' };
const TYPE_EN = { video_courte: 'Video', video_longue: 'Video', film: 'Film', telechargement: 'Video', photo: 'Photo', publication: 'Post',
  musique: 'Music', audio: 'Audio', podcast: 'Podcast', livre: 'Book', pdf: 'PDF document', powerpoint: 'Presentation', live: 'Live' };
const ICON = { video_courte: '🎬', video_longue: '🎬', film: '🎞️', telechargement: '🎬', photo: '🖼️', publication: '📝', musique: '🎵', audio: '🎧',
  podcast: '🎙️', livre: '📚', pdf: '📄', powerpoint: '📊', live: '🔴' };
const T = {
  fr: { open: 'Ouvrir dans Eaji', join: 'Créer mon compte gratuit', watch: 'Regarder sur Eaji', listen: 'Écouter sur Eaji', read: 'Lire sur Eaji',
    paid: 'Contenu payant : ouvre Eaji pour le débloquer.', by: 'par', on: 'sur Eaji', likes: 'j’aime', posts: 'Publications', profile: 'Voir le profil',
    discover: 'Découvrir Eaji', search: 'Chercher sur Eaji…', go: 'Chercher', none: 'Aucune publication trouvée.', latest: 'Dernières publications',
    results: 'Résultats pour', tagline: 'Eaji : vidéos, musique, photos, livres et lives de créateurs du monde entier. Les créateurs sont rémunérés.',
    lyrics: 'Paroles', notfound: 'Cette publication n’existe pas ou n’est plus publique.', home: 'Aller sur Eaji', creator: 'Créateur sur Eaji' },
  en: { open: 'Open in Eaji', join: 'Create my free account', watch: 'Watch on Eaji', listen: 'Listen on Eaji', read: 'Read on Eaji',
    paid: 'Paid content: open Eaji to unlock it.', by: 'by', on: 'on Eaji', likes: 'likes', posts: 'Posts', profile: 'See the profile',
    discover: 'Discover Eaji', search: 'Search Eaji…', go: 'Search', none: 'No posts found.', latest: 'Latest posts',
    results: 'Results for', tagline: 'Eaji: videos, music, photos, books and lives from creators around the world. Creators get paid.',
    lyrics: 'Lyrics', notfound: 'This post does not exist or is no longer public.', home: 'Go to Eaji', creator: 'Creator on Eaji' },
};

function register({ app, db, createDownloadUrl, rateLimit }) {
  const site = () => (process.env.PUBLIC_SITE_URL || 'https://jimmynho.github.io/Eaji-site').replace(/\/$/, '');
  // Adresse du serveur (Railway la donne dans les en-têtes : https et le nom de domaine).
  const base = (req) => {
    if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
    const host = String(req.headers.host || req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    return `${proto}://${host}`;
  };
  const langOf = (req) => (/^en\b/i.test(String(req.headers['accept-language'] || '')) ? 'en' : 'fr');
  const limit = rateLimit('pages', 900, 15 * 60 * 1000, 'Trop de pages demandées. Réessaie dans quelques minutes.');

  function page(req, { title, description, path, image, body, jsonLd, status = 200, noindex = false }, res) {
    const L = langOf(req), t = T[L], url = base(req) + path;
    const verify = process.env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(process.env.GOOGLE_SITE_VERIFICATION)}">` : '';
    const img = image || `${site()}/icon-512.png`;
    res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
    res.send(`<!DOCTYPE html><html lang="${L}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">' : ''}${verify}
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="${esc(site())}/icon-192.png">
<meta property="og:site_name" content="Eaji"><meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(img)}">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
<style>
:root{--bg:#12141C;--card:#1B1E29;--line:#2C3140;--gold:#F0A63C;--text:#F3F1EB;--muted:#9AA0B0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--gold)}.wrap{max-width:640px;margin:0 auto;padding:16px}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}
.brand{font-weight:800;font-size:22px;color:var(--text);text-decoration:none}.brand span{color:var(--gold)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
h1{font-size:22px;margin:0 0 6px;line-height:1.3}h2{font-size:18px;margin:18px 0 8px}
.muted{color:var(--muted);font-size:14px}.media{width:100%;border-radius:12px;display:block;margin:12px 0;background:#000}
.ph{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;aspect-ratio:16/9;border-radius:12px;margin:12px 0;
 background:radial-gradient(circle at 50% 40%,#2a2f45,#000 75%);color:#fff;text-decoration:none;font-size:42px}
.ph b{font-size:16px}.btn{display:block;text-align:center;padding:14px;border-radius:14px;font-weight:700;text-decoration:none;margin-top:10px}
.btn.gold{background:var(--gold);color:#1A1206}.btn.line{border:1px solid var(--gold);color:var(--gold)}
.item{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--text)}
.item .ic{font-size:24px;width:34px;text-align:center}.item small{display:block;color:var(--muted)}
.lyr{white-space:pre-line;color:var(--muted);font-size:14px;max-height:260px;overflow:hidden}
form{display:flex;gap:8px;margin:0 0 14px}input{flex:1;min-width:0;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--text);font-size:15px}
button{padding:12px 16px;border-radius:12px;border:none;background:var(--gold);color:#1A1206;font-weight:700}
footer{color:var(--muted);font-size:13px;text-align:center;margin:20px 0}
</style></head><body><div class="wrap">
<div class="top"><a class="brand" href="${esc(base(req))}/decouvrir">E<span>aji</span></a><a href="${esc(site())}/">${esc(t.home)}</a></div>
${body}
<a class="btn line" href="${esc(site())}/">${esc(t.join)}</a>
<footer>${esc(t.tagline)}<br><a href="${esc(base(req))}/decouvrir">${esc(t.discover)}</a> · <a href="${esc(site())}/conditions.html">Conditions</a> · <a href="${esc(site())}/confidentialite.html">Confidentialité</a></footer>
</div></body></html>`);
  }

  const itemRow = (req, it, L) => `<a class="item" href="${esc(base(req))}/p/${esc(it.id)}"><span class="ic">${ICON[it.content_type] || '🔗'}</span>
    <span><b>${esc(it.title)}</b><small>${esc((L === 'en' ? TYPE_EN : TYPE_FR)[it.content_type] || '')} · ${esc(it.creator_name || '')}</small></span></a>`;

  // ---------- Une publication ----------
  app.get('/p/:id', limit, async (req, res) => {
    const L = langOf(req), t = T[L];
    const it = UUID_RE.test(req.params.id) && await db.query(
      `SELECT c.id, c.title, c.content_type, c.created_at, c.storage_url, c.sale_price, c.lyrics, c.lyrics_source,
              cr.id AS creator_id, cr.name AS creator_name, cr.photo_url AS creator_photo,
              (SELECT COUNT(*)::int FROM content_likes WHERE content_id = c.id) AS likes
       FROM content_items c JOIN creators cr ON cr.id = c.creator_id WHERE c.id = $1 AND ${VISIBLE}`, [req.params.id]).catch(() => null);
    if (!it) {
      return page(req, { title: 'Eaji', description: t.notfound, path: req.path, noindex: true, status: 404,
        body: `<div class="card"><h1>${esc(t.notfound)}</h1><a class="btn gold" href="${esc(base(req))}/decouvrir">${esc(t.discover)}</a></div>` }, res);
    }
    const type = (L === 'en' ? TYPE_EN : TYPE_FR)[it.content_type] || '';
    const paid = Number(it.sale_price) > 0;
    const isPhoto = ['photo', 'publication'].includes(it.content_type);
    const photoUrl = isPhoto && !paid ? await createDownloadUrl(it.storage_url).catch(() => null) : null;
    const avatar = await createDownloadUrl(it.creator_photo).catch(() => null);
    const openUrl = `${site()}/#content-${it.id}`;
    const lyrics = it.content_type === 'musique' && it.lyrics && it.lyrics_source !== 'auto'
      ? String(it.lyrics).replace(/\[[^\]]*\]/g, '').replace(/\n{2,}/g, '\n').trim().slice(0, 900) : '';
    const action = ['musique', 'audio', 'podcast'].includes(it.content_type) ? t.listen : ['livre', 'pdf', 'powerpoint', 'publication'].includes(it.content_type) ? t.read : t.watch;
    const media = photoUrl
      ? `<a href="${esc(openUrl)}"><img class="media" src="${esc(photoUrl)}" alt="${esc(it.title)}" loading="lazy"></a>`
      : `<a class="ph" href="${esc(openUrl)}">${ICON[it.content_type] || '▶'}<b>${esc(paid ? t.paid : action)}</b></a>`;
    const desc = `${type} ${t.by} ${it.creator_name} ${t.on}${lyrics ? ' — ' + lyrics.split('\n').slice(0, 2).join(' / ') : ''}`.slice(0, 300);
    page(req, {
      title: `${it.title} — ${it.creator_name} | Eaji`, description: desc, path: `/p/${it.id}`, image: photoUrl || avatar,
      jsonLd: { '@context': 'https://schema.org', '@type': 'SocialMediaPosting', headline: String(it.title).slice(0, 110), datePublished: it.created_at,
        url: `${base(req)}/p/${it.id}`, author: { '@type': 'Person', name: it.creator_name, url: `${base(req)}/u/${it.creator_id}` },
        interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: it.likes } },
      body: `<div class="card"><div class="muted">${ICON[it.content_type] || ''} ${esc(type)} · <a href="${esc(base(req))}/u/${esc(it.creator_id)}">${esc(it.creator_name)}</a> · ${esc(new Date(it.created_at).toLocaleDateString(L === 'en' ? 'en-GB' : 'fr-FR'))}</div>
        <h1>${esc(it.title)}</h1>${media}
        ${lyrics ? `<h2>${esc(t.lyrics)}</h2><div class="lyr">${esc(lyrics)}</div>` : ''}
        <div class="muted">❤ ${esc(it.likes)} ${esc(t.likes)}</div>
        <a class="btn gold" href="${esc(openUrl)}">${esc(t.open)}</a></div>`,
    }, res);
  });

  // ---------- Un créateur ----------
  app.get('/u/:id', limit, async (req, res) => {
    const L = langOf(req), t = T[L];
    const c = UUID_RE.test(req.params.id) && await db.query("SELECT id, name, country_code, photo_url FROM creators WHERE id = $1 AND account_status = 'actif'", [req.params.id]).catch(() => null);
    if (!c) return page(req, { title: 'Eaji', description: t.notfound, path: req.path, noindex: true, status: 404, body: `<div class="card"><h1>${esc(t.notfound)}</h1></div>` }, res);
    const items = await db.all(
      `SELECT c.id, c.title, c.content_type, cr.name AS creator_name FROM content_items c JOIN creators cr ON cr.id = c.creator_id
       WHERE c.creator_id = $1 AND ${VISIBLE} ORDER BY c.created_at DESC LIMIT 60`, [c.id]);
    const photo = await createDownloadUrl(c.photo_url).catch(() => null);
    page(req, {
      title: `${c.name} — ${t.creator} | Eaji`, description: `${c.name} : ${items.slice(0, 5).map((i) => i.title).join(' · ')}`.slice(0, 300) || c.name,
      path: `/u/${c.id}`, image: photo,
      jsonLd: { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: c.name, url: `${base(req)}/u/${c.id}` } },
      body: `<div class="card">${photo ? `<img src="${esc(photo)}" alt="${esc(c.name)}" style="width:84px;height:84px;border-radius:50%;object-fit:cover;">` : ''}
        <h1>${esc(c.name)}</h1><div class="muted">${esc(t.creator)}</div>
        <a class="btn gold" href="${esc(site())}/#u-${esc(c.id)}">${esc(t.open)}</a></div>
        <div class="card"><h2 style="margin-top:0;">${esc(t.posts)}</h2>${items.map((i) => itemRow(req, i, L)).join('') || `<p class="muted">${esc(t.none)}</p>`}</div>`,
    }, res);
  });

  // ---------- Découvrir + recherche ----------
  app.get('/decouvrir', limit, async (req, res) => {
    const L = langOf(req), t = T[L];
    const q = String(req.query.q || '').trim().slice(0, 60);
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const items = await db.all(
      `SELECT c.id, c.title, c.content_type, cr.name AS creator_name FROM content_items c JOIN creators cr ON cr.id = c.creator_id
       WHERE ${VISIBLE} AND ($1 = '' OR c.title ILIKE $2 OR cr.name ILIKE $2) ORDER BY c.created_at DESC LIMIT 60`, [q.length >= 2 ? q : '', like]);
    page(req, {
      title: q ? `${q} — Eaji` : `${t.discover} — Eaji`, description: t.tagline, path: '/decouvrir' + (q ? `?q=${encodeURIComponent(q)}` : ''), noindex: Boolean(q),
      body: `<form action="${esc(base(req))}/decouvrir" method="get"><input name="q" value="${esc(q)}" placeholder="${esc(t.search)}" aria-label="${esc(t.search)}"><button type="submit">${esc(t.go)}</button></form>
        <div class="card"><h1 style="font-size:19px;">${esc(q ? `${t.results} « ${q} »` : t.latest)}</h1>${items.map((i) => itemRow(req, i, L)).join('') || `<p class="muted">${esc(t.none)}</p>`}
        <a class="btn gold" href="${esc(site())}/">${esc(t.open)}</a></div>`,
    }, res);
  });

  // ---------- Pour Google ----------
  app.get('/sitemap.xml', limit, async (req, res) => {
    const b = base(req);
    const posts = await db.all(`SELECT c.id, c.created_at FROM content_items c JOIN creators cr ON cr.id = c.creator_id WHERE ${VISIBLE} ORDER BY c.created_at DESC LIMIT 40000`);
    const people = await db.all(`SELECT cr.id, MAX(c.created_at) AS last FROM content_items c JOIN creators cr ON cr.id = c.creator_id WHERE ${VISIBLE} GROUP BY cr.id ORDER BY 2 DESC LIMIT 9000`);
    const u = (loc, last, freq) => `<url><loc>${esc(loc)}</loc>${last ? `<lastmod>${new Date(last).toISOString().slice(0, 10)}</lastmod>` : ''}<changefreq>${freq}</changefreq></url>`;
    res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=1800' });
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
      + u(`${b}/decouvrir`, posts[0] && posts[0].created_at, 'hourly')
      + people.map((p) => u(`${b}/u/${p.id}`, p.last, 'daily')).join('')
      + posts.map((p) => u(`${b}/p/${p.id}`, p.created_at, 'weekly')).join('') + '</urlset>');
  });
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /p/\nAllow: /u/\nAllow: /decouvrir\nDisallow: /api/\nSitemap: ${base(req)}/sitemap.xml\n`);
  });
  // Vérification Google Search Console par fichier : GOOGLE_SITE_VERIFICATION_FILE=google1234abcd.html (variable Railway).
  app.get('/:file', (req, res, next) => {
    const f = process.env.GOOGLE_SITE_VERIFICATION_FILE;
    if (!f || req.params.file !== f || !/^google[0-9a-z]+\.html$/i.test(f)) return next();
    res.type('text/html').send(`google-site-verification: ${f}`);
  });
}

module.exports = { register };
