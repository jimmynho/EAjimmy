// Eaji — statuts (onglet Messages) : un texte, une photo ou une vidéo d'1 minute au maximum,
// visible par tous les utilisateurs pendant 2 100 minutes (35 heures), puis effacé automatiquement.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_LIFETIME_MINUTES = 2100; // 35 heures
const STATUS_MAX_SECONDS = 60;        // vidéo d'1 minute au maximum
const BACKGROUNDS = ['#E4AE3A', '#2EC4B6', '#E8304F', '#7B61FF', '#1B1E29', '#2D6A4F', '#F28C28', '#0077B6'];

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS statuses (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('texte', 'photo', 'video')),
     text TEXT,
     bg TEXT,
     storage_key TEXT,
     mime TEXT,
     duration_seconds NUMERIC,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2100 minutes')`,
  'CREATE INDEX IF NOT EXISTS statuses_live ON statuses (expires_at DESC, creator_id)',
  `CREATE TABLE IF NOT EXISTS status_views (
     status_id UUID NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
     viewer_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (status_id, viewer_id))`,
];

function register({ app, db, requireAuth, createDownloadUrl, isBlockedBetween, notify, STORAGE_CONNECTED, watch }) {
  // Effacement automatique après 35 heures (les statuts expirés ne sont plus jamais renvoyés).
  const clean = setInterval(() => {
    db.query("DELETE FROM statuses WHERE expires_at < now() - interval '30 days'").catch(() => {});
  }, 3600 * 1000);
  if (clean.unref) clean.unref();

  app.post('/api/statuses', requireAuth, async (req, res) => {
    const kind = ['texte', 'photo', 'video'].includes(req.body.kind) ? req.body.kind : null;
    if (!kind) return res.status(400).json({ error: 'Type de statut inconnu.' });
    const text = String(req.body.text || '').trim().slice(0, 700);
    const count = await db.query("SELECT COUNT(*)::int AS n FROM statuses WHERE creator_id = $1 AND created_at > now() - interval '24 hours'", [req.creatorId]);
    if (count.n >= 30) return res.status(429).json({ error: 'Trop de statuts aujourd\'hui (30 au maximum).' });
    let key = null, mime = null, duration = null;
    if (kind === 'texte') {
      if (text.length < 1) return res.status(400).json({ error: 'Écris le texte de ton statut.' });
    } else {
      if (!STORAGE_CONNECTED) return res.status(503).json({ error: "Le stockage de fichiers n'est pas encore activé sur le serveur." });
      key = String(req.body.storageKey || '');
      if (!key.startsWith(`${req.creatorId}/`) || key.includes('..')) return res.status(403).json({ error: 'Fichier non autorisé.' });
      mime = String(req.body.mime || '').slice(0, 80);
      if (kind === 'photo' && !mime.startsWith('image/')) return res.status(400).json({ error: 'Choisis une photo.' });
      if (kind === 'video') {
        if (!mime.startsWith('video/')) return res.status(400).json({ error: 'Choisis une vidéo.' });
        duration = Number(req.body.durationSeconds);
        if (!(duration > 0)) return res.status(400).json({ error: 'Durée de la vidéo inconnue.' });
        if (duration > STATUS_MAX_SECONDS + 0.9) return res.status(400).json({ error: 'Un statut vidéo dure 1 minute au maximum : coupe ta vidéo.' });
      }
    }
    const bg = BACKGROUNDS.includes(req.body.bg) ? req.body.bg : BACKGROUNDS[0];
    const st = await db.query(
      `INSERT INTO statuses (creator_id, kind, text, bg, storage_key, mime, duration_seconds, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' minutes')::interval) RETURNING id, expires_at`,
      [req.creatorId, kind, text || null, kind === 'texte' ? bg : null, key, mime, duration, STATUS_LIFETIME_MINUTES]);
    if (watch && text) watch.flag({ creatorId: req.creatorId, source: 'statut', refId: st.id, origin: 'texte', text }).catch(() => {});
    res.status(201).json({ statusId: st.id, expiresAt: st.expires_at });
  });

  // Tous les statuts en cours (visibles par tous les utilisateurs), regroupés par personne :
  // les miens d'abord, puis ceux que je n'ai pas encore vus, puis les autres.
  app.get('/api/statuses', requireAuth, async (req, res) => {
    const rows = await db.all(
      `SELECT s.id, s.creator_id, s.kind, s.text, s.bg, s.storage_key, s.mime, s.duration_seconds, s.created_at, s.expires_at,
              cr.name AS creator_name, cr.photo_url,
              EXISTS (SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = $1) AS seen,
              CASE WHEN s.creator_id = $1 THEN (SELECT COUNT(*)::int FROM status_views v WHERE v.status_id = s.id) END AS views,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = s.creator_id) AS followed
       FROM statuses s JOIN creators cr ON cr.id = s.creator_id
       WHERE s.expires_at > now() AND cr.account_status = 'actif'
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = s.creator_id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = s.creator_id))
       ORDER BY s.created_at ASC LIMIT 3000`, [req.creatorId]);
    const people = new Map();
    for (const r of rows) {
      let p = people.get(r.creator_id);
      if (!p) {
        p = { creatorId: r.creator_id, name: r.creator_name, photoKey: r.photo_url, mine: r.creator_id === req.creatorId, followed: r.followed, items: [], last: null };
        people.set(r.creator_id, p);
      }
      p.items.push({ id: r.id, kind: r.kind, text: r.text, bg: r.bg, key: r.storage_key, mime: r.mime, duration: r.duration_seconds ? Number(r.duration_seconds) : null,
        createdAt: r.created_at, expiresAt: r.expires_at, seen: r.seen, views: r.views });
      p.last = r.created_at;
    }
    let list = [...people.values()];
    list.forEach((p) => { p.unseen = p.items.filter((i) => !i.seen).length; });
    list.sort((a, b) => (b.mine - a.mine) || ((b.unseen > 0) - (a.unseen > 0)) || (b.followed - a.followed) || (new Date(b.last) - new Date(a.last)));
    list = list.slice(0, 150);
    for (const p of list) {
      p.photoUrl = await createDownloadUrl(p.photoKey).catch(() => null); delete p.photoKey;
      for (const i of p.items) { i.url = i.key ? await createDownloadUrl(i.key).catch(() => null) : null; delete i.key; }
    }
    res.json({ people: list, lifetimeMinutes: STATUS_LIFETIME_MINUTES, maxSeconds: STATUS_MAX_SECONDS, backgrounds: BACKGROUNDS });
  });

  app.post('/api/statuses/:id/view', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Statut introuvable.' });
    await db.query(
      `INSERT INTO status_views (status_id, viewer_id) SELECT id, $2 FROM statuses WHERE id = $1 AND creator_id <> $2 AND expires_at > now()
       ON CONFLICT DO NOTHING`, [req.params.id, req.creatorId]);
    res.json({ seen: true });
  });

  app.get('/api/statuses/:id/viewers', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Statut introuvable.' });
    const st = await db.query('SELECT id FROM statuses WHERE id = $1 AND creator_id = $2', [req.params.id, req.creatorId]);
    if (!st) return res.status(404).json({ error: 'Statut introuvable.' });
    const viewers = await db.all(
      `SELECT cr.id, cr.name, v.viewed_at FROM status_views v JOIN creators cr ON cr.id = v.viewer_id WHERE v.status_id = $1 ORDER BY v.viewed_at DESC LIMIT 500`,
      [st.id]);
    res.json({ viewers });
  });

  app.delete('/api/statuses/:id', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Statut introuvable.' });
    // Le statut disparaît pour tout le monde ; l'administration garde la trace (enquêtes).
    const st = await db.query('UPDATE statuses SET expires_at = now() WHERE id = $1 AND creator_id = $2 AND expires_at > now() RETURNING id', [req.params.id, req.creatorId]);
    if (!st) return res.status(404).json({ error: 'Statut introuvable.' });
    res.json({ deleted: true });
  });

  // Répondre à un statut : message privé à son auteur, avec le rappel du statut.
  app.post('/api/statuses/:id/reply', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Statut introuvable.' });
    const text = String(req.body.text || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'Message vide.' });
    const st = await db.query('SELECT s.id, s.creator_id, s.kind, s.text FROM statuses s WHERE s.id = $1 AND s.expires_at > now()', [req.params.id]);
    if (!st) return res.status(404).json({ error: 'Ce statut n\'est plus disponible.' });
    if (st.creator_id === req.creatorId) return res.status(400).json({ error: 'Tu ne peux pas t\'écrire à toi-même.' });
    if (await isBlockedBetween(req.creatorId, st.creator_id)) return res.status(403).json({ error: 'Tu ne peux pas écrire à ce compte.' });
    const what = st.kind === 'texte' ? `« ${String(st.text || '').slice(0, 60)} »` : st.kind === 'photo' ? '📷 photo' : '🎥 vidéo';
    const full = `↩️ Réponse à ton statut (${what}) : ${text}`;
    const m = await db.query('INSERT INTO direct_messages (sender_id, recipient_id, text) VALUES ($1, $2, $3) RETURNING id', [req.creatorId, st.creator_id, full]);
    const me = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
    await notify(st.creator_id, 'message', `💬 ${me.name} a répondu à ton statut.`, `dm:${req.creatorId}`, { title: me.name, body: text.slice(0, 160) });
    res.status(201).json({ messageId: m.id });
  });
}

module.exports = { MIGRATIONS, register, STATUS_LIFETIME_MINUTES, STATUS_MAX_SECONDS };
