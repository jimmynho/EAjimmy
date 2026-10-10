// Eaji — le direct (live) : le téléphone du créateur envoie sa caméra à chaque spectateur
// (WebRTC, comme les appels), le serveur fait seulement la mise en relation, et garde
// le fil du live : messages des spectateurs, arrivées et cadeaux.
//
// Limite honnête : chaque spectateur reçoit une copie de la vidéo directement depuis le
// téléphone du créateur. Cela marche bien jusqu'à une dizaine de spectateurs ; au-delà,
// il faudra un serveur vidéo dédié (payant) qui redistribue le flux.

const MAX_VIEWERS = 15;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS live_viewers (
     live_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
     viewer_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     offer_sdp TEXT,
     answer_sdp TEXT,
     answer_applied BOOLEAN NOT NULL DEFAULT FALSE,
     joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
     left_at TIMESTAMPTZ,
     PRIMARY KEY (live_id, viewer_id))`,
  `CREATE TABLE IF NOT EXISTS live_events (
     id BIGSERIAL PRIMARY KEY,
     live_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
     author_id UUID REFERENCES creators(id) ON DELETE SET NULL,
     kind TEXT NOT NULL CHECK (kind IN ('message', 'cadeau', 'arrivee', 'fin')),
     text TEXT NOT NULL,
     amount_usd NUMERIC(12,2),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
];

function register({ app, db, requireAuth, optionalViewerId, createDownloadUrl, isBlockedBetween, isMonetizedCreator }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const checkId = (req, res, next) => (UUID_RE.test(req.params.id) ? next() : res.status(400).json({ error: 'Identifiant invalide.' }));

  async function activeLive(id) {
    return db.query(
      `SELECT l.*, cr.name AS creator_name, cr.country_code, cr.phone FROM live_sessions l
       JOIN creators cr ON cr.id = l.creator_id WHERE l.id = $1 AND l.status = 'en_cours'`, [id]);
  }

  const watching = "(SELECT COUNT(*)::int FROM live_viewers v WHERE v.live_id = l.id AND v.left_at IS NULL AND v.last_seen > now() - interval '30 seconds')";

  // Lives en cours (bandeau « En direct » du fil).
  app.get('/api/lives', async (req, res) => {
    const viewerId = optionalViewerId(req);
    const lives = await db.all(
      `SELECT l.id, l.started_at, cr.id AS creator_id, cr.name AS creator_name, cr.country_code, cr.phone, cr.photo_url,
              ${watching} AS viewers
       FROM live_sessions l JOIN creators cr ON cr.id = l.creator_id
       WHERE l.status = 'en_cours' AND cr.account_status = 'actif' AND l.started_at > now() - interval '12 hours'
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = cr.id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = cr.id))
       ORDER BY viewers DESC, l.started_at DESC LIMIT 20`, [viewerId]);
    for (const l of lives) {
      l.monetized = isMonetizedCreator(l.country_code, l.phone);
      l.creator_photo = await createDownloadUrl(l.photo_url).catch(() => null);
      delete l.phone; delete l.photo_url;
    }
    res.json({ lives });
  });

  app.get('/api/live/:id', checkId, async (req, res) => {
    const live = await db.query(
      `SELECT l.id, l.status, l.started_at, l.creator_id, cr.name AS creator_name, cr.country_code, cr.phone, ${watching} AS viewers
       FROM live_sessions l JOIN creators cr ON cr.id = l.creator_id WHERE l.id = $1`, [req.params.id]);
    if (!live) return res.status(404).json({ error: 'Live introuvable.' });
    live.monetized = isMonetizedCreator(live.country_code, live.phone);
    delete live.phone;
    res.json({ live });
  });

  // ---------- Côté spectateur ----------
  app.post('/api/live/:id/join', requireAuth, checkId, async (req, res) => {
    const live = await activeLive(req.params.id);
    if (!live) return res.status(404).json({ error: 'Ce live est terminé.' });
    if (live.creator_id === req.creatorId) return res.status(400).json({ error: 'Tu es le créateur de ce live.' });
    if (await isBlockedBetween(req.creatorId, live.creator_id)) return res.status(403).json({ error: 'Tu ne peux pas regarder ce live.' });
    const count = await db.query(
      `SELECT COUNT(*)::int AS n FROM live_viewers WHERE live_id = $1 AND left_at IS NULL
         AND last_seen > now() - interval '30 seconds' AND viewer_id <> $2`, [live.id, req.creatorId]);
    if (count.n >= MAX_VIEWERS) return res.status(429).json({ error: `Ce live est complet (${MAX_VIEWERS} spectateurs). Réessaie dans un moment.` });
    // (Re)connexion : on repart d'une mise en relation neuve.
    await db.query(
      `INSERT INTO live_viewers (live_id, viewer_id) VALUES ($1, $2)
       ON CONFLICT (live_id, viewer_id) DO UPDATE SET offer_sdp = NULL, answer_sdp = NULL, answer_applied = FALSE,
         last_seen = now(), left_at = NULL, joined_at = now()`, [live.id, req.creatorId]);
    const me = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
    await db.query("INSERT INTO live_events (live_id, author_id, kind, text) VALUES ($1, $2, 'arrivee', $3)",
      [live.id, req.creatorId, `${me.name} a rejoint le live`]);
    res.json({ joined: true, creatorName: live.creator_name, monetized: isMonetizedCreator(live.country_code, live.phone) });
  });

  // Le spectateur attend l'offre vidéo du créateur.
  app.get('/api/live/:id/me', requireAuth, checkId, async (req, res) => {
    const row = await db.query(
      `UPDATE live_viewers SET last_seen = now() WHERE live_id = $1 AND viewer_id = $2 AND left_at IS NULL
       RETURNING offer_sdp, answer_sdp`, [req.params.id, req.creatorId]);
    const live = await db.query('SELECT status FROM live_sessions WHERE id = $1', [req.params.id]);
    res.json({ status: live ? live.status : 'termine', offer: row ? row.offer_sdp : null, answered: Boolean(row && row.answer_sdp) });
  });

  app.post('/api/live/:id/answer', requireAuth, checkId, async (req, res) => {
    const sdp = String(req.body.sdp || '');
    if (!sdp) return res.status(400).json({ error: 'Réponse vide.' });
    const row = await db.query(
      `UPDATE live_viewers SET answer_sdp = $3, answer_applied = FALSE, last_seen = now()
       WHERE live_id = $1 AND viewer_id = $2 AND offer_sdp IS NOT NULL AND left_at IS NULL RETURNING viewer_id`,
      [req.params.id, req.creatorId, sdp]);
    if (!row) return res.status(404).json({ error: 'Connexion au live introuvable.' });
    res.json({ ok: true });
  });

  app.post('/api/live/:id/leave', requireAuth, checkId, async (req, res) => {
    await db.query('UPDATE live_viewers SET left_at = now() WHERE live_id = $1 AND viewer_id = $2', [req.params.id, req.creatorId]);
    res.json({ left: true });
  });

  // ---------- Côté créateur ----------
  async function ownLive(req, res) {
    const live = await db.query("SELECT * FROM live_sessions WHERE id = $1 AND creator_id = $2", [req.params.id, req.creatorId]);
    if (!live) { res.status(404).json({ error: 'Live introuvable.' }); return null; }
    return live;
  }

  // Spectateurs à connecter (pas encore d'offre) et réponses à appliquer.
  app.get('/api/live/:id/viewers', requireAuth, checkId, async (req, res) => {
    const live = await ownLive(req, res); if (!live) return;
    const rows = await db.all(
      `SELECT v.viewer_id, cr.name, v.offer_sdp IS NOT NULL AS has_offer, v.answer_sdp, v.answer_applied
       FROM live_viewers v JOIN creators cr ON cr.id = v.viewer_id
       WHERE v.live_id = $1 AND v.left_at IS NULL AND v.last_seen > now() - interval '30 seconds'`, [live.id]);
    const gone = await db.all(
      `SELECT viewer_id FROM live_viewers WHERE live_id = $1 AND (left_at IS NOT NULL OR last_seen <= now() - interval '30 seconds')`, [live.id]);
    res.json({
      waiting: rows.filter((r) => !r.has_offer).map((r) => ({ viewerId: r.viewer_id, name: r.name })),
      answers: rows.filter((r) => r.answer_sdp && !r.answer_applied).map((r) => ({ viewerId: r.viewer_id, sdp: r.answer_sdp })),
      count: rows.length,
      gone: gone.map((g) => g.viewer_id),
    });
  });

  app.post('/api/live/:id/viewers/:viewerId/offer', requireAuth, checkId, async (req, res) => {
    const live = await ownLive(req, res); if (!live) return;
    if (!UUID_RE.test(req.params.viewerId)) return res.status(400).json({ error: 'Identifiant invalide.' });
    await db.query('UPDATE live_viewers SET offer_sdp = $3, answer_sdp = NULL, answer_applied = FALSE WHERE live_id = $1 AND viewer_id = $2',
      [live.id, req.params.viewerId, String(req.body.sdp || '')]);
    res.json({ ok: true });
  });

  app.post('/api/live/:id/viewers/:viewerId/applied', requireAuth, checkId, async (req, res) => {
    const live = await ownLive(req, res); if (!live) return;
    if (!UUID_RE.test(req.params.viewerId)) return res.status(400).json({ error: 'Identifiant invalide.' });
    await db.query('UPDATE live_viewers SET answer_applied = TRUE WHERE live_id = $1 AND viewer_id = $2', [live.id, req.params.viewerId]);
    res.json({ ok: true });
  });

  // ---------- Fil du live : messages, arrivées, cadeaux ----------
  app.get('/api/live/:id/events', checkId, async (req, res) => {
    const after = Number(req.query.after) || 0;
    const events = await db.all(
      `SELECT e.id, e.kind, e.text, e.amount_usd, e.created_at, cr.name AS author_name
       FROM live_events e LEFT JOIN creators cr ON cr.id = e.author_id
       WHERE e.live_id = $1 AND e.id > $2 ORDER BY e.id ASC LIMIT 100`, [req.params.id, after]);
    const live = await db.query(`SELECT l.status, ${watching} AS viewers FROM live_sessions l WHERE l.id = $1`, [req.params.id]);
    const gifts = await db.query(
      "SELECT COALESCE(SUM(amount_usd), 0)::float AS total FROM live_events WHERE live_id = $1 AND kind = 'cadeau'", [req.params.id]);
    res.json({ events, status: live ? live.status : 'termine', viewers: live ? live.viewers : 0, giftsTotal: gifts.total });
  });

  app.post('/api/live/:id/chat', requireAuth, checkId, async (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: 'Message vide.' });
    const live = await activeLive(req.params.id);
    if (!live) return res.status(404).json({ error: 'Ce live est terminé.' });
    if (await isBlockedBetween(req.creatorId, live.creator_id)) return res.status(403).json({ error: 'Tu ne peux pas écrire dans ce live.' });
    const e = await db.query("INSERT INTO live_events (live_id, author_id, kind, text) VALUES ($1, $2, 'message', $3) RETURNING id",
      [live.id, req.creatorId, text]);
    res.status(201).json({ eventId: e.id });
  });

  return { activeLive };
}

module.exports = { register, MIGRATIONS, MAX_VIEWERS };
