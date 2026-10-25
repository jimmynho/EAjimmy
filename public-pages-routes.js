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

// Publications texte : les mêmes fonds que dans l'appli (couleurs, dégradés, papiers peints).
const TEXT_BG_CSS = {
  or: ['#E4AE3A', 1], turquoise: ['#2EC4B6', 1], corail: ['#E8304F'], violet: ['#7B61FF'], nuit: ['#1B1E29'], foret: ['#2D6A4F'], orange: ['#F28C28', 1],
  ocean: ['linear-gradient(135deg,#0077B6,#00B4D8 55%,#48CAE4)'], couchant: ['linear-gradient(135deg,#FF512F,#F09819)'],
  aurore: ['linear-gradient(135deg,#43E97B,#38F9D7)', 1], galaxie: ['linear-gradient(135deg,#3A1C71,#D76D77 60%,#FFAF7B)'],
  feu: ['linear-gradient(135deg,#F12711,#F5AF19)'], bonbon: ['linear-gradient(135deg,#FF9A9E,#FAD0C4 50%,#FBC2EB)', 1],
  peche: ['linear-gradient(135deg,#FFECD2,#FCB69F)', 1], menthe: ['linear-gradient(135deg,#D4FC79,#96E6A1)', 1],
  pagne: ['repeating-linear-gradient(45deg,#E4AE3A 0 14px,#E8304F 14px 28px,#2D6A4F 28px 42px,#1B1E29 42px 56px)', 0, 1],
  points: ['radial-gradient(circle,rgba(255,255,255,.35) 2px,transparent 2.6px) 0 0/18px 18px,linear-gradient(135deg,#7B61FF,#E8304F)'],
  rayures: ['repeating-linear-gradient(135deg,#2EC4B6 0 18px,#7B61FF 18px 36px,#E4AE3A 36px 54px,#E8304F 54px 72px)', 0, 1],
  confettis: ['radial-gradient(circle at 20% 30%,#F0A63C 0 3px,transparent 4px) 0 0/56px 56px,radial-gradient(circle at 70% 60%,#45C7B5 0 3px,transparent 4px) 0 0/56px 56px,radial-gradient(circle at 40% 85%,#E8654F 0 3px,transparent 4px) 0 0/56px 56px,radial-gradient(circle at 85% 15%,#B9A6FF 0 3px,transparent 4px) 0 0/56px 56px,#1B1E29'],
  vagues: ['repeating-radial-gradient(circle at 0 100%,#0077B6 0 14px,#00B4D8 14px 28px,#90E0EF 28px 42px)', 0, 1],
};
// Titre court pour Google et les aperçus (le texte complet reste sur la page).
const shortText = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };

function register({ app, db, createDownloadUrl, rateLimit, accessMap }) {
  const site = () => (process.env.PUBLIC_SITE_URL || 'https://jimmynho.github.io/Eaji-site').replace(/\/$/, '');
  // Adresse du serveur (Railway la donne dans les en-têtes : https et le nom de domaine).
  const base = (req) => {
    if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
    const host = String(req.headers.host || req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    return `${proto}://${host}`;
  };
  // Serveur de secours (Render) : mêmes pages, mais Google ne doit les lire que sur le principal (pas de doublons).
  const isBackup = () => Boolean(process.env.EAJI_SERVER_NAME) && process.env.EAJI_SERVER_NAME !== 'principal';
  const langOf = (req) => (/^en\b/i.test(String(req.headers['accept-language'] || '')) ? 'en' : 'fr');
  const limit = rateLimit('pages', 900, 15 * 60 * 1000, 'Trop de pages demandées. Réessaie dans quelques minutes.');

  function page(req, { title, description, path, image, imageSize, video, body, jsonLd, status = 200, noindex = false }, res) {
    const L = langOf(req), t = T[L], url = base(req) + path;
    const verify = process.env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(process.env.GOOGLE_SITE_VERIFICATION)}">` : '';
    const img = image || `${site()}/icon-512.png`;
    res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
    res.send(`<!DOCTYPE html><html lang="${L}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex || isBackup() ? '<meta name="robots" content="noindex">' : ''}${verify}
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="${esc(site())}/icon-192.png">
<meta property="og:site_name" content="Eaji"><meta property="og:type" content="${video ? 'video.other' : 'website'}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}"><meta property="og:image:secure_url" content="${esc(img)}">
${imageSize ? `<meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="${esc(imageSize.w)}"><meta property="og:image:height" content="${esc(imageSize.h)}">` : ''}<meta property="og:image:alt" content="${esc(title)}">
${video ? `<meta property="og:video" content="${esc(video.url)}"><meta property="og:video:secure_url" content="${esc(video.url)}"><meta property="og:video:type" content="${esc(video.type)}">${video.w ? `<meta property="og:video:width" content="${esc(video.w)}"><meta property="og:video:height" content="${esc(video.h)}">` : ''}` : ''}
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
.tp{border-radius:14px;padding:22px 18px;margin:12px 0;color:#fff;white-space:pre-wrap;overflow-wrap:anywhere;font-size:17px;line-height:1.55}
.tp.big{min-height:220px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:24px;font-weight:700}
.tp.dark{color:#1A1206}.tp.panel span{background:rgba(10,12,18,.55);border-radius:12px;padding:12px 14px;display:block;color:#fff}
.tp.none{background:var(--card);border:1px solid var(--line)}
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
    <span><b>${esc(shortText(it.title, 140))}</b><small>${esc((L === 'en' ? TYPE_EN : TYPE_FR)[it.content_type] || '')} · ${esc(it.creator_name || '')}</small></span></a>`;

  // Image d'aperçu d'une publication (celle que Facebook, WhatsApp… affichent avec le lien partagé) :
  // l'image de la vidéo ou du texte préparée à la publication, sinon la photo (si elle n'est pas en vente), sinon la photo de profil.
  const VIDEO_KINDS = ['video_courte', 'video_longue', 'film', 'telechargement'];
  const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' };
  const previewKey = (it) => {
    const paid = Number(it.sale_price) > 0;
    const isPhoto = ['photo', 'publication'].includes(it.content_type) && it.storage_url;
    // Photo mise en vente : jamais montrée (l'aperçu serait la photo elle-même) ; une vidéo, elle, ne montre qu'une image.
    if (isPhoto && paid) return it.creator_photo || null;
    return it.thumb_key || (isPhoto ? it.storage_url : null) || it.creator_photo || null;
  };
  const ITEM_SQL = `SELECT c.id, c.title, c.content_type, c.created_at, c.storage_url, c.sale_price, c.lyrics, c.lyrics_source, c.text_bg,
              c.thumb_key, c.thumb_w, c.thumb_h, c.duration_seconds, c.media_width, c.media_height,
              cr.id AS creator_id, cr.name AS creator_name, cr.photo_url AS creator_photo,
              (SELECT COUNT(*)::int FROM content_likes WHERE content_id = c.id) AS likes
       FROM content_items c JOIN creators cr ON cr.id = c.creator_id WHERE c.id = $1 AND ${VISIBLE}`;
  // Vidéo gratuite pour tous (pas payante, pas en vente) : peut être lue directement par les sites qui le permettent.
  const freeVideo = async (it) => {
    if (!VIDEO_KINDS.includes(it.content_type) || !it.storage_url || !accessMap) return false;
    const a = (await accessMap(null, [it]).catch(() => null) || new Map()).get(it.id);
    return Boolean(a && !a.locked && !a.forSale);
  };
  app.get('/p/:id/apercu.jpg', limit, async (req, res) => {
    const it = UUID_RE.test(req.params.id) && await db.query(ITEM_SQL, [req.params.id]).catch(() => null);
    const key = it && previewKey(it);
    const url = key && await createDownloadUrl(key).catch(() => null);
    if (!url) return res.redirect(302, `${site()}/icon-512.png`);
    let up;
    try { up = await fetch(url); } catch (e) { up = null; }
    const type = up && up.headers.get('content-type') || '';
    if (!up || !up.ok || !/^image\//.test(type)) return res.redirect(302, `${site()}/icon-512.png`);
    res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
    const len = up.headers.get('content-length'); if (len) res.set('Content-Length', len);
    const body = require('stream').Readable.fromWeb(up.body);
    body.on('error', () => res.destroy());
    body.pipe(res);
  });
  app.get('/p/:id/video', limit, async (req, res) => {
    const it = UUID_RE.test(req.params.id) && await db.query(ITEM_SQL, [req.params.id]).catch(() => null);
    if (!it || !(await freeVideo(it))) return res.status(404).type('text/plain').send('Vidéo indisponible.');
    const url = await createDownloadUrl(it.storage_url).catch(() => null);
    if (!url) return res.status(404).type('text/plain').send('Vidéo indisponible.');
    res.set('Cache-Control', 'no-store').redirect(302, url);
  });

  // ---------- Une publication ----------
  app.get('/p/:id', limit, async (req, res) => {
    const L = langOf(req), t = T[L];
    const it = UUID_RE.test(req.params.id) && await db.query(ITEM_SQL, [req.params.id]).catch(() => null);
    if (!it) {
      // Publication réservée aux abonnés (ou retirée) : pas de contenu ici, mais le lien partagé ouvre toujours Eaji,
      // où les abonnés la voient après connexion.
      const appLink = UUID_RE.test(req.params.id) ? `<a class="btn gold" href="${esc(site())}/#content-${esc(req.params.id)}">${esc(t.open)}</a>` : '';
      return page(req, { title: 'Eaji', description: t.notfound, path: req.path, noindex: true, status: 404,
        body: `<div class="card"><h1>${esc(t.notfound)}</h1>${appLink}<a class="btn line" href="${esc(base(req))}/decouvrir">${esc(t.discover)}</a></div>` }, res);
    }
    const type = (L === 'en' ? TYPE_EN : TYPE_FR)[it.content_type] || '';
    const paid = Number(it.sale_price) > 0;
    const isPhoto = ['photo', 'publication'].includes(it.content_type);
    const photoUrl = isPhoto && !paid ? await createDownloadUrl(it.storage_url).catch(() => null) : null;
    // Aperçu du lien partagé : l'image de la publication elle-même (adresse stable sur ce serveur).
    const pKey = previewKey(it);
    const preview = pKey ? `${base(req)}/p/${it.id}/apercu.jpg` : null;
    const imageSize = pKey && pKey === it.thumb_key && it.thumb_w ? { w: it.thumb_w, h: it.thumb_h } : null;
    const ext = String(it.storage_url || '').split('?')[0].split('.').pop().toLowerCase();
    const video = await freeVideo(it) ? { url: `${base(req)}/p/${it.id}/video`, type: VIDEO_MIME[ext] || 'video/mp4', w: it.media_width, h: it.media_height } : null;
    const openUrl = `${site()}/#content-${it.id}`;
    const lyrics = it.content_type === 'musique' && it.lyrics && it.lyrics_source !== 'auto'
      ? String(it.lyrics).replace(/\[[^\]]*\]/g, '').replace(/\n{2,}/g, '\n').trim().slice(0, 900) : '';
    const action = ['musique', 'audio', 'podcast'].includes(it.content_type) ? t.listen : ['livre', 'pdf', 'powerpoint', 'publication'].includes(it.content_type) ? t.read : t.watch;
    // Publication texte : le texte entier, sur son fond (lisible par Google).
    const textOnly = it.content_type === 'publication' && it.storage_url === '';
    const bg = TEXT_BG_CSS[it.text_bg];
    const big = String(it.title).length <= 160 && (String(it.title).match(/\n/g) || []).length <= 4;
    const media = textOnly
      ? `<div class="tp${bg ? (bg[1] ? ' dark' : '') + (bg[2] ? ' panel' : '') : ' none'}${big ? ' big' : ''}"${bg ? ` style="background:${bg[0]}"` : ''}><span>${esc(it.title)}</span></div>`
      : photoUrl
      ? `<a href="${esc(openUrl)}"><img class="media" src="${esc(photoUrl)}" alt="${esc(shortText(it.title, 120))}" loading="lazy"></a>`
      : it.thumb_key
      ? `<a class="ph" href="${esc(openUrl)}" style="background:#000 url('${esc(base(req))}/p/${esc(it.id)}/apercu.jpg') center/cover no-repeat;text-shadow:0 1px 6px #000"><b>${esc(paid ? t.paid : action)}</b></a>`
      : `<a class="ph" href="${esc(openUrl)}">${ICON[it.content_type] || '▶'}<b>${esc(paid ? t.paid : action)}</b></a>`;
    const desc = textOnly ? shortText(it.title, 280)
      : `${type} ${t.by} ${it.creator_name} ${t.on}${lyrics ? ' — ' + lyrics.split('\n').slice(0, 2).join(' / ') : ''}`.slice(0, 300);
    page(req, {
      title: `${shortText(it.title, 70)} — ${it.creator_name} | Eaji`, description: desc, path: `/p/${it.id}`, image: preview, imageSize, video,
      jsonLd: { '@context': 'https://schema.org', '@type': 'SocialMediaPosting', headline: shortText(it.title, 110), datePublished: it.created_at,
        ...(textOnly ? { articleBody: String(it.title).slice(0, 20000) } : {}),
        url: `${base(req)}/p/${it.id}`, author: { '@type': 'Person', name: it.creator_name, url: `${base(req)}/u/${it.creator_id}` },
        interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: it.likes } },
      body: `<div class="card"><div class="muted">${ICON[it.content_type] || ''} ${esc(type)} · <a href="${esc(base(req))}/u/${esc(it.creator_id)}">${esc(it.creator_name)}</a> · ${esc(new Date(it.created_at).toLocaleDateString(L === 'en' ? 'en-GB' : 'fr-FR'))}</div>
        ${textOnly ? '' : `<h1>${esc(shortText(it.title, 120))}</h1>${String(it.title).length > 120 ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(it.title)}</p>` : ''}`}${media}
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
    if (isBackup()) return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
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
