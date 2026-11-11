// Outils du créateur : statistiques par publication, hashtags et tendances.
//
//  - GET /api/my/content/:id/stats : chiffres d'UNE de mes publications (vues par jour, j'aime, commentaires…).
//    Seul l'auteur peut les voir. Aucun montant d'argent ici (l'argent est dans le Portefeuille).
//  - GET /api/hashtags/trending    : les #hashtags les plus utilisés ces 30 derniers jours (pays d'abord, sinon partout).
//  - GET /api/hashtags/feed?tag=   : les publications qui portent ce #hashtag.
//
// Les hashtags sont lus directement dans le texte des publications (« #kinshasa ») : rien d'autre à enregistrer.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_CHARS = '[^\\s#.,;:!?()"«»<>&\'’]';
const TAG_OK = new RegExp(`^${TAG_CHARS}{2,40}$`);
const TAG_SQL = `(?:^|\\s)#(${TAG_CHARS}{2,40})`;
const cleanTag = (t) => { const s = String(t || '').trim().replace(/^#/, '').toLowerCase(); return TAG_OK.test(s) ? s : null; };

function register({ app, db, requireAuth, optionalViewerId, feedItems, rateLimit }) {
  app.get('/api/my/content/:id/stats', requireAuth, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Publication introuvable.' });
    const c = await db.query(
      `SELECT c.id, c.title, c.content_type, c.created_at, c.view_count, c.duration_seconds,
              (SELECT COUNT(*)::int FROM content_likes WHERE content_id = c.id) AS likes,
              (SELECT COUNT(*)::int FROM content_comments WHERE content_id = c.id) AS comments,
              (SELECT COUNT(*)::int FROM content_reposts WHERE content_id = c.id) AS reposts,
              (SELECT COUNT(*)::int FROM content_saves WHERE content_id = c.id AND kind = 'favori') AS favorites,
              (SELECT COUNT(*)::int FROM content_saves WHERE content_id = c.id AND kind = 'plus_tard') AS later,
              (SELECT COUNT(*)::int FROM content_access WHERE content_id = c.id) AS sales,
              (SELECT COUNT(*)::int FROM gifts WHERE content_id = c.id) AS gifts
       FROM content_items c WHERE c.id = $1 AND c.creator_id = $2 AND c.status = 'actif'`, [req.params.id, req.creatorId]);
    if (!c) return res.status(404).json({ error: 'Publication introuvable.' });
    // Vues des 14 derniers jours (une vue par personne et par jour).
    const rows = await db.all(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(v.n, 0)::int AS views
       FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, interval '1 day') AS d(day)
       LEFT JOIN (SELECT day, COUNT(*) AS n FROM content_view_log WHERE content_id = $1 AND day >= CURRENT_DATE - 13 GROUP BY day) v ON v.day = d.day::date
       ORDER BY d.day`, [c.id]);
    const last7 = rows.slice(7).reduce((a, r) => a + r.views, 0), prev7 = rows.slice(0, 7).reduce((a, r) => a + r.views, 0);
    const views = Number(c.view_count) || 0;
    res.json({
      id: c.id, title: c.title, contentType: c.content_type, createdAt: c.created_at,
      views, likes: c.likes, comments: c.comments, reposts: c.reposts, favorites: c.favorites, later: c.later, sales: c.sales, gifts: c.gifts,
      // Part des spectateurs qui ont réagi (j'aime, commentaire ou partage).
      engagement: views ? Math.min(100, Math.round(((c.likes + c.comments + c.reposts) / views) * 100)) : 0,
      days: rows, last7, prev7,
    });
  });

  let cache = new Map();
  async function trending(country) {
    const key = country || '*', hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.v;
    const q = (cc) => db.all(
      `SELECT lower(m[1]) AS tag, COUNT(DISTINCT ci.id)::int AS posts, COALESCE(SUM(ci.view_count), 0)::int AS views
       FROM content_items ci JOIN creators cr ON cr.id = ci.creator_id
       CROSS JOIN LATERAL regexp_matches(ci.title, $2, 'g') AS m
       WHERE ci.status = 'actif' AND ci.visibility_scope = 'public' AND cr.account_status = 'actif'
         AND ci.created_at > now() - interval '30 days' AND ($1::text IS NULL OR cr.country_code = $1)
       GROUP BY 1 ORDER BY posts DESC, views DESC, tag LIMIT 12`, [cc, TAG_SQL]);
    let v = country ? await q(country) : [];
    if (v.length < 3) v = await q(null); // peu de hashtags dans le pays : ceux de partout
    if (cache.size > 300) cache = new Map();
    cache.set(key, { at: Date.now(), v });
    return v;
  }
  app.get('/api/hashtags/trending', async (req, res) => {
    const country = /^[A-Z]{2}$/.test(String(req.query.country || '')) ? req.query.country : null;
    res.json({ tags: await trending(country) });
  });

  app.get('/api/hashtags/feed', rateLimit('tagfeed', 120, 10 * 60 * 1000), async (req, res) => {
    const tag = cleanTag(req.query.tag);
    if (!tag) return res.status(400).json({ error: 'Hashtag invalide.' });
    const viewerId = optionalViewerId(req);
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ids = (await db.all(
      `SELECT ci.id FROM content_items ci JOIN creators cr ON cr.id = ci.creator_id
       WHERE ci.status = 'actif' AND cr.account_status = 'actif' AND ci.title ~* $1
       ORDER BY ci.created_at DESC LIMIT 60`, [`(^|\\s)#${esc}($|[\\s#.,;:!?()"«»<>&'’])`])).map((r) => r.id);
    const items = ids.length ? await feedItems(viewerId, null, null, ids) : [];
    let following = [];
    if (viewerId) following = (await db.all('SELECT followed_id FROM follows WHERE follower_id = $1', [viewerId])).map((r) => r.followed_id);
    res.json({ tag, items, following });
  });

  return { trending, cleanTag };
}

module.exports = { register, cleanTag };
