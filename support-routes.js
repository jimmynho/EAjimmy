// Eaji — « Contacter l'équipe Eaji » : un utilisateur écrit à l'équipe (aide, paiement, compte, service de
// communication…) depuis son Profil ; l'administrateur répond depuis le tableau de bord, et peut aussi
// écrire le premier à un utilisateur en cas de besoin.

const CATEGORIES = {
  paiement: 'Problème de paiement', compte: 'Mon compte', probleme: 'Signaler un problème',
  communication: 'Service de communication / presse', partenariat: 'Partenariat / publicité', autre: 'Autre question',
};

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS support_threads (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     category TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'ouvert' CHECK (status IN ('ouvert', 'resolu')),
     started_by TEXT NOT NULL DEFAULT 'utilisateur' CHECK (started_by IN ('utilisateur', 'equipe')),
     user_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     admin_read_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS support_threads_creator ON support_threads (creator_id, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS support_messages (
     id BIGSERIAL PRIMARY KEY,
     thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
     author TEXT NOT NULL CHECK (author IN ('utilisateur', 'equipe')),
     admin_id UUID,
     text TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS support_messages_thread ON support_messages (thread_id, id)',
];

function register({ app, db, requireAuth, requireAdminPermission, notify = async () => {}, notifyAdmins = async () => {} }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const canAnswer = requireAdminPermission('repondre_signalements');
  const clean = (t) => String(t || '').trim().slice(0, 3000);

  // Pas plus de 30 messages à l'équipe par heure (protection contre l'envoi en masse).
  async function tooMany(creatorId) {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
       WHERE t.creator_id = $1 AND m.author = 'utilisateur' AND m.created_at > now() - interval '1 hour'`, [creatorId]);
    return r.n >= 30;
  }
  const unreadForUser = `(SELECT COUNT(*)::int FROM support_messages m WHERE m.thread_id = t.id AND m.author = 'equipe' AND m.created_at > t.user_read_at)`;
  const unreadForAdmin = `(SELECT COUNT(*)::int FROM support_messages m WHERE m.thread_id = t.id AND m.author = 'utilisateur' AND m.created_at > COALESCE(t.admin_read_at, 'epoch'))`;
  const lastText = `(SELECT text FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1)`;

  async function alertTeam(creatorId, subject, text) {
    const c = await db.query('SELECT name FROM creators WHERE id = $1', [creatorId]).catch(() => null);
    notifyAdmins({ title: `💬 Support : ${c ? c.name : 'un utilisateur'}`, body: `${subject} — ${text.slice(0, 120)}`, link: 'admin:v-support', kind: 'support', permission: 'repondre_signalements' });
  }

  // ---------- Côté utilisateur ----------
  app.post('/api/support', requireAuth, async (req, res) => {
    const category = CATEGORIES[req.body.category] ? req.body.category : null;
    const text = clean(req.body.text);
    if (!category) return res.status(400).json({ error: 'Choisis le sujet de ta demande.' });
    if (text.length < 5) return res.status(400).json({ error: 'Écris ton message (5 caractères au moins).' });
    if (await tooMany(req.creatorId)) return res.status(429).json({ error: 'Trop de messages envoyés. Réessaie dans une heure.' });
    const t = await db.query('INSERT INTO support_threads (creator_id, category) VALUES ($1, $2) RETURNING id', [req.creatorId, category]);
    await db.query("INSERT INTO support_messages (thread_id, author, text) VALUES ($1, 'utilisateur', $2)", [t.id, text]);
    alertTeam(req.creatorId, CATEGORIES[category], text);
    res.status(201).json({ threadId: t.id });
  });

  app.get('/api/support', requireAuth, async (req, res) => {
    const threads = await db.all(
      `SELECT t.id, t.category, t.status, t.started_by, t.updated_at, ${lastText} AS last_text, ${unreadForUser} AS unread
       FROM support_threads t WHERE t.creator_id = $1 ORDER BY t.updated_at DESC LIMIT 50`, [req.creatorId]);
    threads.forEach((t) => { t.categoryLabel = CATEGORIES[t.category] || t.category; });
    res.json({ threads, categories: CATEGORIES, unread: threads.reduce((s, t) => s + t.unread, 0) });
  });

  async function ownThread(req, res) {
    if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'Demande introuvable.' }); return null; }
    const t = await db.query('SELECT * FROM support_threads WHERE id = $1 AND creator_id = $2', [req.params.id, req.creatorId]);
    if (!t) { res.status(404).json({ error: 'Demande introuvable.' }); return null; }
    return t;
  }
  app.get('/api/support/:id', requireAuth, async (req, res) => {
    const t = await ownThread(req, res); if (!t) return;
    const messages = await db.all('SELECT id, author, text, created_at FROM support_messages WHERE thread_id = $1 ORDER BY id', [t.id]);
    await db.query('UPDATE support_threads SET user_read_at = now() WHERE id = $1', [t.id]);
    res.json({ thread: { id: t.id, category: t.category, categoryLabel: CATEGORIES[t.category] || t.category, status: t.status }, messages });
  });
  app.post('/api/support/:id/messages', requireAuth, async (req, res) => {
    const t = await ownThread(req, res); if (!t) return;
    const text = clean(req.body.text);
    if (!text) return res.status(400).json({ error: 'Message vide.' });
    if (await tooMany(req.creatorId)) return res.status(429).json({ error: 'Trop de messages envoyés. Réessaie dans une heure.' });
    await db.query("INSERT INTO support_messages (thread_id, author, text) VALUES ($1, 'utilisateur', $2)", [t.id, text]);
    await db.query("UPDATE support_threads SET status = 'ouvert', updated_at = now(), user_read_at = now() WHERE id = $1", [t.id]);
    alertTeam(req.creatorId, CATEGORIES[t.category] || t.category, text);
    res.status(201).json({ sent: true });
  });

  // ---------- Côté équipe (administrateur principal, ou secondaire avec « répondre aux signalements ») ----------
  app.get('/api/admin/support', canAnswer, async (req, res) => {
    const status = ['ouvert', 'resolu'].includes(req.query.status) ? req.query.status : null;
    const threads = await db.all(
      `SELECT t.id, t.category, t.status, t.started_by, t.updated_at, t.creator_id, cr.name AS creator_name, cr.phone AS creator_phone,
              cr.email AS creator_email, cr.country_code, cr.city, ${lastText} AS last_text, ${unreadForAdmin} AS unread
       FROM support_threads t JOIN creators cr ON cr.id = t.creator_id
       WHERE ($1::text IS NULL OR t.status = $1) ORDER BY ${unreadForAdmin} > 0 DESC, t.updated_at DESC LIMIT 200`, [status]);
    threads.forEach((t) => { t.categoryLabel = CATEGORIES[t.category] || t.category; });
    res.json({ threads, unread: threads.filter((t) => t.unread > 0).length });
  });
  app.get('/api/admin/support-count', canAnswer, async (req, res) => {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM support_threads t WHERE ${unreadForAdmin} > 0`);
    res.json({ unread: r.n });
  });
  app.get('/api/admin/support/:id', canAnswer, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Demande introuvable.' });
    const t = await db.query(
      `SELECT t.*, cr.name AS creator_name, cr.phone AS creator_phone, cr.email AS creator_email FROM support_threads t
       JOIN creators cr ON cr.id = t.creator_id WHERE t.id = $1`, [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Demande introuvable.' });
    const messages = await db.all(
      `SELECT m.id, m.author, m.text, m.created_at, a.name AS admin_name FROM support_messages m
       LEFT JOIN admins a ON a.id = m.admin_id WHERE m.thread_id = $1 ORDER BY m.id`, [t.id]);
    await db.query('UPDATE support_threads SET admin_read_at = now() WHERE id = $1', [t.id]);
    t.categoryLabel = CATEGORIES[t.category] || t.category;
    res.json({ thread: t, messages });
  });
  async function teamWrites(threadId, creatorId, adminId, text) {
    await db.query("INSERT INTO support_messages (thread_id, author, admin_id, text) VALUES ($1, 'equipe', $2, $3)", [threadId, adminId, text]);
    await db.query('UPDATE support_threads SET updated_at = now(), admin_read_at = now() WHERE id = $1', [threadId]);
    await notify(creatorId, 'support', `📩 L'équipe Eaji t'a répondu : « ${text.slice(0, 80)}${text.length > 80 ? '…' : ''} »`, `support:${threadId}`,
      { title: 'Équipe Eaji', body: text.slice(0, 160) });
  }
  app.post('/api/admin/support/:id/messages', canAnswer, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Demande introuvable.' });
    const text = clean(req.body.text);
    if (!text) return res.status(400).json({ error: 'Message vide.' });
    const t = await db.query('SELECT id, creator_id FROM support_threads WHERE id = $1', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Demande introuvable.' });
    await teamWrites(t.id, t.creator_id, req.adminId, text);
    res.status(201).json({ sent: true });
  });
  app.post('/api/admin/support/:id/status', canAnswer, async (req, res) => {
    if (!UUID_RE.test(req.params.id) || !['ouvert', 'resolu'].includes(req.body.status)) return res.status(400).json({ error: 'Demande invalide.' });
    const t = await db.query('UPDATE support_threads SET status = $2 WHERE id = $1 RETURNING id', [req.params.id, req.body.status]);
    if (!t) return res.status(404).json({ error: 'Demande introuvable.' });
    res.json({ status: req.body.status });
  });
  // L'équipe écrit la première à un utilisateur (vérification, information, problème sur son compte…).
  app.post('/api/admin/support/new', canAnswer, async (req, res) => {
    const text = clean(req.body.text);
    if (!UUID_RE.test(String(req.body.creatorId || ''))) return res.status(400).json({ error: 'Utilisateur introuvable.' });
    if (!text) return res.status(400).json({ error: 'Message vide.' });
    const c = await db.query('SELECT id FROM creators WHERE id = $1', [req.body.creatorId]);
    if (!c) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const category = CATEGORIES[req.body.category] ? req.body.category : 'autre';
    const t = await db.query("INSERT INTO support_threads (creator_id, category, started_by, user_read_at) VALUES ($1, $2, 'equipe', 'epoch') RETURNING id", [c.id, category]);
    await teamWrites(t.id, c.id, req.adminId, text);
    res.status(201).json({ threadId: t.id });
  });

  return { CATEGORIES };
}

module.exports = { register, MIGRATIONS, CATEGORIES };
