// Eaji — messagerie avancée : fichiers de tout type dans les messages, transfert à plusieurs
// personnes, conversations de groupe et appels vocaux de groupe.
//
// Appel de groupe : chaque participant est relié directement aux autres (WebRTC, audio seulement).
// Le serveur transmet seulement les « offres » et « réponses ». Limite : 8 participants.

const MAX_GROUP_MEMBERS = 256;
const MAX_CALL_PARTICIPANTS = 8;
const MAX_FORWARD_TARGETS = 20;

// Copie gardée 90 jours d'un message modifié ou supprimé : visible seulement par l'administration
// (preuve en cas de menace, d'arnaque ou de demande de la justice). Annoncé dans la politique de confidentialité.
async function archiveMessage(db, kind, id, action, senderId, groupId) {
  const table = kind === 'groupe' ? 'group_messages' : 'direct_messages';
  await db.query(
    `INSERT INTO message_archive (kind, message_id, action, sender_id, recipient_id, group_id, text, audio_key, file_key, file_name, file_mime, original_created_at)
     SELECT $1, m.id::text, $3, m.sender_id, ${kind === 'groupe' ? 'NULL' : 'm.recipient_id'}, ${kind === 'groupe' ? 'm.group_id' : 'NULL'},
            m.text, m.audio_key, m.file_key, m.file_name, m.file_mime, m.created_at
     FROM ${table} m WHERE m.id::text = $2 AND m.sender_id = $4 AND m.deleted_at IS NULL ${kind === 'groupe' ? 'AND m.group_id = $5' : ''}`,
    kind === 'groupe' ? [kind, id, action, senderId, groupId] : [kind, id, action, senderId]).catch(() => {});
}

const MIGRATIONS = [
  'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_key TEXT',
  'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_name TEXT',
  'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_mime TEXT',
  'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_size BIGINT',
  `CREATE TABLE IF NOT EXISTS chat_groups (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name TEXT NOT NULL,
     owner_id UUID REFERENCES creators(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS chat_group_members (
     group_id UUID NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     role TEXT NOT NULL DEFAULT 'membre' CHECK (role IN ('admin', 'membre')),
     joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (group_id, creator_id))`,
  'ALTER TABLE chat_group_members ADD COLUMN IF NOT EXISTS last_read_id BIGINT NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS group_messages (
     id BIGSERIAL PRIMARY KEY,
     group_id UUID NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
     sender_id UUID REFERENCES creators(id) ON DELETE CASCADE,
     text TEXT NOT NULL DEFAULT '',
     audio_key TEXT,
     file_key TEXT,
     file_name TEXT,
     file_mime TEXT,
     file_size BIGINT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS group_messages_group_idx ON group_messages (group_id, id)',
  'ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ',
  'ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ',
  `CREATE TABLE IF NOT EXISTS group_calls (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     group_id UUID NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
     started_by UUID REFERENCES creators(id) ON DELETE SET NULL,
     status TEXT NOT NULL DEFAULT 'en_cours' CHECK (status IN ('en_cours', 'termine')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     ended_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS group_call_members (
     call_id UUID NOT NULL REFERENCES group_calls(id) ON DELETE CASCADE,
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
     left_at TIMESTAMPTZ,
     PRIMARY KEY (call_id, creator_id))`,
  `CREATE TABLE IF NOT EXISTS group_call_signals (
     id BIGSERIAL PRIMARY KEY,
     call_id UUID NOT NULL REFERENCES group_calls(id) ON DELETE CASCADE,
     from_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     to_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('offer', 'answer')),
     sdp TEXT NOT NULL,
     consumed BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  // Publication partagée dans une conversation ou un groupe.
  'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS shared_content_id UUID REFERENCES content_items(id) ON DELETE SET NULL',
  'ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS shared_content_id UUID REFERENCES content_items(id) ON DELETE SET NULL',
];

function register({ app, db, requireAuth, createDownloadUrl, isBlockedBetween, notify }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const checkId = (req, res, next) => (UUID_RE.test(req.params.id) ? next() : res.status(400).json({ error: 'Identifiant invalide.' }));
  const uuids = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((x) => UUID_RE.test(x)))];
  const pgArray = (list) => `{${list.join(',')}}`;
  const ownKey = (creatorId, key) => !key || (String(key).startsWith(`${creatorId}/`) && !String(key).includes('..'));

  // Pièce jointe : la clé doit appartenir à l'expéditeur (déjà envoyée au stockage par lui).
  function readAttachment(req) {
    const fileKey = req.body.fileKey ? String(req.body.fileKey) : null;
    if (!fileKey) return { ok: true, file: null };
    if (!ownKey(req.creatorId, fileKey)) return { ok: false };
    return {
      ok: true,
      file: {
        key: fileKey,
        name: String(req.body.fileName || 'fichier').slice(0, 200),
        mime: String(req.body.fileMime || 'application/octet-stream').slice(0, 120),
        size: Number(req.body.fileSize) > 0 ? Math.round(Number(req.body.fileSize)) : null,
      },
    };
  }

  async function withUrls(m) {
    m.audioUrl = m.audio_key ? await createDownloadUrl(m.audio_key).catch(() => null) : null;
    m.fileUrl = m.file_key ? await createDownloadUrl(m.file_key).catch(() => null) : null;
    // Adresse qui enregistre le fichier sur le téléphone (bouton « Télécharger »).
    m.downloadUrl = m.file_key ? await createDownloadUrl(m.file_key, m.file_name || 'fichier').catch(() => null) : null;
    delete m.audio_key; delete m.file_key;
    // Publication partagée : petit aperçu (titre, type, auteur) ; elle s'ouvre en touchant la carte.
    if (m.shared_content_id) {
      const c = await db.query(
        `SELECT c.id, c.title, c.content_type, c.status, cr.name AS creator_name FROM content_items c JOIN creators cr ON cr.id = c.creator_id WHERE c.id = $1`,
        [m.shared_content_id]).catch(() => null);
      m.shared = c ? { id: c.id, title: c.title, contentType: c.content_type, creatorName: c.creator_name, available: c.status === 'actif' } : { id: m.shared_content_id, available: false };
    }
    return m;
  }

  async function membership(groupId, creatorId) {
    return db.query('SELECT role FROM chat_group_members WHERE group_id = $1 AND creator_id = $2', [groupId, creatorId]);
  }

  // ---------- Contacts (pour créer un groupe ou transférer) ----------
  app.get('/api/contacts', requireAuth, async (req, res) => {
    const contacts = await db.all(
      `SELECT DISTINCT cr.id, cr.name, cr.photo_url FROM creators cr
       WHERE cr.id <> $1 AND cr.account_status = 'actif' AND (
         cr.id IN (SELECT followed_id FROM follows WHERE follower_id = $1)
         OR cr.id IN (SELECT follower_id FROM follows WHERE followed_id = $1)
         OR cr.id IN (SELECT recipient_id FROM direct_messages WHERE sender_id = $1)
         OR cr.id IN (SELECT sender_id FROM direct_messages WHERE recipient_id = $1))
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = cr.id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = cr.id))
       ORDER BY cr.name LIMIT 300`, [req.creatorId]);
    for (const c of contacts) { c.photoUrl = await createDownloadUrl(c.photo_url).catch(() => null); delete c.photo_url; }
    res.json({ contacts });
  });

  // ---------- Groupes ----------
  app.post('/api/groups', requireAuth, async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Donne un nom au groupe.' });
    const members = uuids(req.body.memberIds).filter((id) => id !== req.creatorId).slice(0, MAX_GROUP_MEMBERS - 1);
    if (!members.length) return res.status(400).json({ error: 'Ajoute au moins une personne au groupe.' });
    const group = await db.query('INSERT INTO chat_groups (name, owner_id) VALUES ($1, $2) RETURNING id', [name, req.creatorId]);
    await db.query("INSERT INTO chat_group_members (group_id, creator_id, role) VALUES ($1, $2, 'admin')", [group.id, req.creatorId]);
    const me = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
    let added = 0;
    for (const id of members) {
      if (await isBlockedBetween(req.creatorId, id)) continue;
      const r = await db.query(
        `INSERT INTO chat_group_members (group_id, creator_id) SELECT $1, id FROM creators WHERE id = $2 AND account_status = 'actif'
         ON CONFLICT DO NOTHING RETURNING creator_id`, [group.id, id]);
      if (r) { added++; await notify(id, 'groupe', `👥 ${me.name} t'a ajouté(e) au groupe « ${name} ».`, `group:${group.id}`); }
    }
    await db.query("INSERT INTO group_messages (group_id, sender_id, text) VALUES ($1, $2, $3)",
      [group.id, req.creatorId, `${me.name} a créé le groupe « ${name} »`]);
    res.status(201).json({ groupId: group.id, members: added + 1 });
  });

  app.get('/api/groups', requireAuth, async (req, res) => {
    const groups = await db.all(
      `SELECT g.id, g.name, (SELECT COUNT(*)::int FROM chat_group_members WHERE group_id = g.id) AS members,
              lm.text AS last_text, lm.created_at AS last_at, lm.file_name AS last_file, lm.audio AS last_audio,
              (SELECT id FROM group_calls WHERE group_id = g.id AND status = 'en_cours' LIMIT 1) AS active_call,
              (SELECT COUNT(*)::int FROM group_messages x WHERE x.group_id = g.id AND x.id > m.last_read_id AND x.sender_id IS DISTINCT FROM $1) AS unread
       FROM chat_groups g JOIN chat_group_members m ON m.group_id = g.id AND m.creator_id = $1
       LEFT JOIN LATERAL (SELECT text, created_at, file_name, audio_key IS NOT NULL AS audio FROM group_messages
                          WHERE group_id = g.id ORDER BY id DESC LIMIT 1) lm ON TRUE
       ORDER BY COALESCE(lm.created_at, g.created_at) DESC`, [req.creatorId]);
    res.json({ groups });
  });

  app.get('/api/groups/:id', requireAuth, checkId, async (req, res) => {
    const me = await membership(req.params.id, req.creatorId);
    if (!me) return res.status(404).json({ error: 'Groupe introuvable.' });
    const group = await db.query('SELECT id, name, owner_id, created_at FROM chat_groups WHERE id = $1', [req.params.id]);
    const members = await db.all(
      `SELECT cr.id, cr.name, cr.photo_url, m.role FROM chat_group_members m JOIN creators cr ON cr.id = m.creator_id
       WHERE m.group_id = $1 ORDER BY m.role, cr.name`, [req.params.id]);
    for (const m of members) { m.photoUrl = await createDownloadUrl(m.photo_url).catch(() => null); delete m.photo_url; }
    res.json({ ...group, myRole: me.role, members });
  });

  app.post('/api/groups/:id/members', requireAuth, checkId, async (req, res) => {
    const me = await membership(req.params.id, req.creatorId);
    if (!me || me.role !== 'admin') return res.status(403).json({ error: "Seul l'administrateur du groupe peut ajouter des membres." });
    const group = await db.query('SELECT name FROM chat_groups WHERE id = $1', [req.params.id]);
    const count = await db.query('SELECT COUNT(*)::int AS n FROM chat_group_members WHERE group_id = $1', [req.params.id]);
    const adder = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
    let added = 0;
    for (const id of uuids(req.body.memberIds)) {
      if (count.n + added >= MAX_GROUP_MEMBERS) break;
      if (await isBlockedBetween(req.creatorId, id)) continue;
      const r = await db.query(
        `INSERT INTO chat_group_members (group_id, creator_id) SELECT $1, id FROM creators WHERE id = $2 AND account_status = 'actif'
         ON CONFLICT DO NOTHING RETURNING creator_id`, [req.params.id, id]);
      if (r) {
        added++;
        const who = await db.query('SELECT name FROM creators WHERE id = $1', [id]);
        await db.query('INSERT INTO group_messages (group_id, sender_id, text) VALUES ($1, $2, $3)', [req.params.id, req.creatorId, `${adder.name} a ajouté ${who.name}`]);
        await notify(id, 'groupe', `👥 ${adder.name} t'a ajouté(e) au groupe « ${group.name} ».`, `group:${req.params.id}`);
      }
    }
    res.json({ added });
  });

  // Retirer un membre (administrateur) ou quitter le groupe (soi-même).
  app.delete('/api/groups/:id/members/:memberId', requireAuth, checkId, async (req, res) => {
    const me = await membership(req.params.id, req.creatorId);
    if (!me) return res.status(404).json({ error: 'Groupe introuvable.' });
    const self = req.params.memberId === req.creatorId;
    if (!self && me.role !== 'admin') return res.status(403).json({ error: "Seul l'administrateur peut retirer un membre." });
    const removed = await db.query('DELETE FROM chat_group_members WHERE group_id = $1 AND creator_id = $2 RETURNING creator_id', [req.params.id, req.params.memberId]);
    if (!removed) return res.status(404).json({ error: 'Membre introuvable.' });
    const who = await db.query('SELECT name FROM creators WHERE id = $1', [req.params.memberId]);
    await db.query('INSERT INTO group_messages (group_id, sender_id, text) VALUES ($1, $2, $3)',
      [req.params.id, req.creatorId, self ? `${who.name} a quitté le groupe` : `${who.name} a été retiré(e) du groupe`]);
    // Le groupe garde toujours un administrateur.
    const admins = await db.query("SELECT COUNT(*)::int AS n FROM chat_group_members WHERE group_id = $1 AND role = 'admin'", [req.params.id]);
    if (admins.n === 0) {
      await db.query(
        `UPDATE chat_group_members SET role = 'admin' WHERE group_id = $1 AND creator_id =
           (SELECT creator_id FROM chat_group_members WHERE group_id = $1 ORDER BY joined_at LIMIT 1)`, [req.params.id]);
    }
    res.json({ removed: true });
  });

  app.get('/api/groups/:id/messages', requireAuth, checkId, async (req, res) => {
    if (!(await membership(req.params.id, req.creatorId))) return res.status(404).json({ error: 'Groupe introuvable.' });
    const rows = await db.all(
      `SELECT * FROM (SELECT gm.id, gm.sender_id, gm.text, gm.audio_key, gm.file_key, gm.file_name, gm.file_mime, gm.file_size, gm.created_at, gm.edited_at, gm.deleted_at, gm.shared_content_id,
              cr.name AS sender_name
       FROM group_messages gm LEFT JOIN creators cr ON cr.id = gm.sender_id
       WHERE gm.group_id = $1 ORDER BY gm.id DESC LIMIT 200) t ORDER BY id ASC`, [req.params.id]);
    for (const m of rows) await withUrls(m);
    if (rows.length) await db.query('UPDATE chat_group_members SET last_read_id = GREATEST(last_read_id, $3) WHERE group_id = $1 AND creator_id = $2', [req.params.id, req.creatorId, rows[rows.length - 1].id]);
    res.json({ messages: rows });
  });

  app.post('/api/groups/:id/messages', requireAuth, checkId, async (req, res) => {
    if (!(await membership(req.params.id, req.creatorId))) return res.status(404).json({ error: 'Groupe introuvable.' });
    const text = String(req.body.text || '').trim().slice(0, 4000);
    const audioKey = req.body.audioKey ? String(req.body.audioKey) : null;
    if (audioKey && !ownKey(req.creatorId, audioKey)) return res.status(403).json({ error: 'Message vocal non autorisé.' });
    const att = readAttachment(req);
    if (!att.ok) return res.status(403).json({ error: 'Fichier non autorisé.' });
    if (!text && !audioKey && !att.file) return res.status(400).json({ error: 'Message vide.' });
    const m = await db.query(
      `INSERT INTO group_messages (group_id, sender_id, text, audio_key, file_key, file_name, file_mime, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.params.id, req.creatorId, audioKey ? '🎤 Message vocal' : text, audioKey,
       att.file?.key || null, att.file?.name || null, att.file?.mime || null, att.file?.size || null]);
    // Chaque membre est prévenu sur son téléphone (sans remplir la cloche à chaque message).
    const info = await db.query('SELECT g.name, cr.name AS sender FROM chat_groups g, creators cr WHERE g.id = $1 AND cr.id = $2', [req.params.id, req.creatorId]);
    if (info) {
      const preview = audioKey ? '🎤 Message vocal' : att.file ? `📎 ${String(att.file.mime || '').startsWith('image/') ? 'Photo' : att.file.name}` : text.slice(0, 140);
      db.all('SELECT creator_id FROM chat_group_members WHERE group_id = $1 AND creator_id <> $2', [req.params.id, req.creatorId])
        .then((rows) => Promise.all(rows.map((r) => notify(r.creator_id, 'message', '', `group:${req.params.id}`,
          { inApp: false, title: `👥 ${info.name}`, body: `${info.sender} : ${preview}` })))).catch(() => {});
    }
    res.status(201).json({ messageId: m.id });
  });

  // ---------- Transférer un message (texte, vocal ou fichier) à plusieurs personnes / groupes ----------
  // Modifier / supprimer son message dans un groupe.
  app.patch('/api/groups/:id/messages/:messageId', requireAuth, checkId, async (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'Message vide.' });
    // L'ancienne version reste visible pour l'administration (enquêtes, 90 jours).
    await archiveMessage(db, 'groupe', String(req.params.messageId), 'modifie', req.creatorId, req.params.id);
    const m = await db.query(
      `UPDATE group_messages SET text = $4, edited_at = now() WHERE id::text = $1 AND group_id = $2 AND sender_id = $3 AND deleted_at IS NULL AND audio_key IS NULL AND file_key IS NULL RETURNING id`,
      [String(req.params.messageId), req.params.id, req.creatorId, text]);
    if (!m) return res.status(404).json({ error: 'Tu ne peux modifier que tes propres messages écrits.' });
    res.json({ edited: true });
  });
  app.delete('/api/groups/:id/messages/:messageId', requireAuth, checkId, async (req, res) => {
    await archiveMessage(db, 'groupe', String(req.params.messageId), 'supprime', req.creatorId, req.params.id);
    const m = await db.query(
      `UPDATE group_messages SET deleted_at = now(), text = '', audio_key = NULL, file_key = NULL, file_name = NULL, file_mime = NULL, file_size = NULL
       WHERE id::text = $1 AND group_id = $2 AND sender_id = $3 AND deleted_at IS NULL RETURNING id`,
      [String(req.params.messageId), req.params.id, req.creatorId]);
    if (!m) return res.status(404).json({ error: 'Tu ne peux supprimer que tes propres messages.' });
    res.json({ deleted: true });
  });

  app.post('/api/messages/forward', requireAuth, async (req, res) => {
    const kind = req.body.kind === 'group' ? 'group' : 'dm';
    const messageId = String(req.body.messageId || '');
    let src;
    if (kind === 'dm') {
      if (!UUID_RE.test(messageId)) return res.status(400).json({ error: 'Message introuvable.' });
      src = await db.query('SELECT * FROM direct_messages WHERE id = $1 AND (sender_id = $2 OR recipient_id = $2)', [messageId, req.creatorId]);
    } else {
      if (!/^\d+$/.test(messageId)) return res.status(400).json({ error: 'Message introuvable.' });
      src = await db.query(
        `SELECT gm.* FROM group_messages gm JOIN chat_group_members m ON m.group_id = gm.group_id AND m.creator_id = $2
         WHERE gm.id = $1`, [messageId, req.creatorId]);
    }
    if (!src || src.deleted_at) return res.status(404).json({ error: 'Message introuvable.' });
    const creators = uuids(req.body.toCreators).filter((id) => id !== req.creatorId);
    const groups = uuids(req.body.toGroups);
    if (!creators.length && !groups.length) return res.status(400).json({ error: 'Choisis au moins une personne ou un groupe.' });
    if (creators.length + groups.length > MAX_FORWARD_TARGETS) return res.status(400).json({ error: `${MAX_FORWARD_TARGETS} destinataires au maximum.` });
    const me = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
    let sent = 0;
    for (const to of creators) {
      if (await isBlockedBetween(req.creatorId, to)) continue;
      const ok = await db.query(
        `INSERT INTO direct_messages (sender_id, recipient_id, text, audio_key, file_key, file_name, file_mime, file_size, shared_content_id)
         SELECT $1, id, $3, $4, $5, $6, $7, $8, $9 FROM creators WHERE id = $2 AND account_status = 'actif' RETURNING id`,
        [req.creatorId, to, src.text || '', src.audio_key, src.file_key, src.file_name, src.file_mime, src.file_size, src.shared_content_id || null]);
      if (ok) { sent++; await notify(to, 'message', `💬 ${me.name} t'a transféré un message.`, `dm:${req.creatorId}`); }
    }
    for (const g of groups) {
      if (!(await membership(g, req.creatorId))) continue;
      await db.query(
        `INSERT INTO group_messages (group_id, sender_id, text, audio_key, file_key, file_name, file_mime, file_size, shared_content_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [g, req.creatorId, src.text || '', src.audio_key, src.file_key, src.file_name, src.file_mime, src.file_size, src.shared_content_id || null]);
      sent++;
    }
    res.json({ sent });
  });

  // ---------- Appels vocaux de groupe ----------
  const fresh = "last_seen > now() - interval '20 seconds' AND left_at IS NULL";

  app.post('/api/groups/:id/call', requireAuth, checkId, async (req, res) => {
    if (!(await membership(req.params.id, req.creatorId))) return res.status(404).json({ error: 'Groupe introuvable.' });
    // Un appel en cours sans personne depuis 20 s est considéré terminé.
    await db.query(
      `UPDATE group_calls c SET status = 'termine', ended_at = now() WHERE c.group_id = $1 AND c.status = 'en_cours'
         AND c.created_at < now() - interval '20 seconds'
         AND NOT EXISTS (SELECT 1 FROM group_call_members m WHERE m.call_id = c.id AND m.left_at IS NULL
                         AND m.last_seen > now() - interval '20 seconds')`, [req.params.id]);
    let call = await db.query("SELECT id FROM group_calls WHERE group_id = $1 AND status = 'en_cours' ORDER BY created_at DESC LIMIT 1", [req.params.id]);
    let started = false;
    if (!call) {
      call = await db.query('INSERT INTO group_calls (group_id, started_by) VALUES ($1, $2) RETURNING id', [req.params.id, req.creatorId]);
      started = true;
    }
    const present = await db.query(`SELECT COUNT(*)::int AS n FROM group_call_members WHERE call_id = $1 AND creator_id <> $2 AND ${fresh}`, [call.id, req.creatorId]);
    if (present.n >= MAX_CALL_PARTICIPANTS) return res.status(429).json({ error: `Appel complet (${MAX_CALL_PARTICIPANTS} personnes au maximum).` });
    await db.query(
      `INSERT INTO group_call_members (call_id, creator_id) VALUES ($1, $2)
       ON CONFLICT (call_id, creator_id) DO UPDATE SET joined_at = now(), last_seen = now(), left_at = NULL`, [call.id, req.creatorId]);
    // Les anciens échanges avec moi sont effacés (nouvelle connexion propre).
    await db.query('DELETE FROM group_call_signals WHERE call_id = $1 AND (from_id = $2 OR to_id = $2)', [call.id, req.creatorId]);
    const others = await db.all(
      `SELECT m.creator_id AS id, cr.name FROM group_call_members m JOIN creators cr ON cr.id = m.creator_id
       WHERE m.call_id = $1 AND m.creator_id <> $2 AND m.left_at IS NULL AND m.last_seen > now() - interval '20 seconds'`, [call.id, req.creatorId]);
    if (started) {
      const g = await db.query('SELECT name FROM chat_groups WHERE id = $1', [req.params.id]);
      const me = await db.query('SELECT name FROM creators WHERE id = $1', [req.creatorId]);
      const members = await db.all('SELECT creator_id FROM chat_group_members WHERE group_id = $1 AND creator_id <> $2', [req.params.id, req.creatorId]);
      for (const m of members) await notify(m.creator_id, 'appel', `📞 ${me.name} lance un appel vocal dans « ${g.name} ». Touche pour rejoindre.`, `group:${req.params.id}`);
      await db.query('INSERT INTO group_messages (group_id, sender_id, text) VALUES ($1, $2, $3)', [req.params.id, req.creatorId, '📞 Appel vocal de groupe lancé']);
    }
    res.json({ callId: call.id, started, others });
  });

  async function inCall(callId, creatorId) {
    return db.query('SELECT 1 FROM group_call_members WHERE call_id = $1 AND creator_id = $2 AND left_at IS NULL', [callId, creatorId]);
  }

  app.get('/api/group-calls/:id/state', requireAuth, checkId, async (req, res) => {
    if (!(await inCall(req.params.id, req.creatorId))) return res.status(404).json({ error: 'Tu ne participes pas à cet appel.' });
    await db.query('UPDATE group_call_members SET last_seen = now() WHERE call_id = $1 AND creator_id = $2', [req.params.id, req.creatorId]);
    const participants = await db.all(
      `SELECT m.creator_id AS id, cr.name FROM group_call_members m JOIN creators cr ON cr.id = m.creator_id
       WHERE m.call_id = $1 AND m.creator_id <> $2 AND m.last_seen > now() - interval '20 seconds' AND m.left_at IS NULL`, [req.params.id, req.creatorId]);
    const signals = await db.all(
      `UPDATE group_call_signals SET consumed = TRUE WHERE id IN
         (SELECT id FROM group_call_signals WHERE call_id = $1 AND to_id = $2 AND consumed = FALSE ORDER BY id)
       RETURNING id, from_id, kind, sdp`, [req.params.id, req.creatorId]);
    signals.sort((a, b) => Number(a.id) - Number(b.id));
    const call = await db.query('SELECT status FROM group_calls WHERE id = $1', [req.params.id]);
    res.json({ status: call.status, participants, signals });
  });

  app.post('/api/group-calls/:id/signal', requireAuth, checkId, async (req, res) => {
    if (!(await inCall(req.params.id, req.creatorId))) return res.status(404).json({ error: 'Tu ne participes pas à cet appel.' });
    const to = String(req.body.to || '');
    const kind = req.body.kind === 'answer' ? 'answer' : 'offer';
    const sdp = String(req.body.sdp || '');
    if (!UUID_RE.test(to) || !sdp) return res.status(400).json({ error: 'Signal invalide.' });
    if (!(await inCall(req.params.id, to))) return res.status(404).json({ error: 'Cette personne a quitté l\'appel.' });
    await db.query('INSERT INTO group_call_signals (call_id, from_id, to_id, kind, sdp) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, req.creatorId, to, kind, sdp]);
    res.json({ ok: true });
  });

  app.post('/api/group-calls/:id/leave', requireAuth, checkId, async (req, res) => {
    await db.query('UPDATE group_call_members SET left_at = now() WHERE call_id = $1 AND creator_id = $2', [req.params.id, req.creatorId]);
    const left = await db.query('SELECT COUNT(*)::int AS n FROM group_call_members WHERE call_id = $1 AND left_at IS NULL AND last_seen > now() - interval \'20 seconds\'', [req.params.id]);
    if (left.n === 0) await db.query("UPDATE group_calls SET status = 'termine', ended_at = now() WHERE id = $1", [req.params.id]);
    res.json({ left: true });
  });

  return { readAttachment, withUrls };
}

module.exports = { archiveMessage, register, MIGRATIONS, MAX_CALL_PARTICIPANTS };
