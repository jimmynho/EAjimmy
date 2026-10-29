// Eaji — paroles des chansons (lecteur de musique).
//  • Le créateur peut écrire les paroles de sa chanson (texte simple, ou synchronisé « [01:23] ligne »).
//  • Sinon, les paroles automatiques (reconnaissance de la parole, dans la langue de la chanson) sont utilisées
//    quand elles existent : celles générées par le créateur depuis le lecteur, ou celles de la surveillance.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LYRICS = 20000;

const MIGRATIONS = [
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS lyrics TEXT',
  "ALTER TABLE content_items ADD COLUMN IF NOT EXISTS lyrics_source TEXT",
];

// Garde les retours à la ligne, retire les caractères invisibles.
function cleanLyrics(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, MAX_LYRICS).trim();
}
const mmss = (s) => {
  const t = Math.max(0, Number(s) || 0), m = Math.floor(t / 60), r = t - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
};
// Transcription automatique [{start, end, text}] → paroles synchronisées « [mm:ss.xx] texte ».
function transcriptToLrc(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((c) => ({ t: Number(c.start) || 0, text: String(c.text || '').replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.text)
    .map((c) => `[${mmss(c.t)}] ${c.text}`).join('\n');
}

function register({ app, db, requireAuth, optionalViewerId }) {
  async function canSee(c, viewerId) {
    if (c.creator_id === viewerId) return true;
    if (c.visibility_scope !== 'abonnes') return true;
    if (!viewerId) return false;
    return Boolean(await db.query('SELECT 1 FROM follows WHERE follower_id = $1 AND followed_id = $2', [viewerId, c.creator_id]));
  }

  app.get('/api/content/:id/lyrics', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const c = await db.query(
      'SELECT id, creator_id, status, visibility_scope, lyrics, lyrics_source FROM content_items WHERE id = $1', [req.params.id]);
    const viewerId = optionalViewerId(req);
    if (!c || (c.status !== 'actif' && c.creator_id !== viewerId)) return res.status(404).json({ error: 'Contenu introuvable.' });
    const mine = Boolean(viewerId && c.creator_id === viewerId);
    if (!(await canSee(c, viewerId))) return res.json({ lyrics: '', source: null, mine });
    if (c.lyrics) return res.json({ lyrics: c.lyrics, source: c.lyrics_source || 'createur', mine });
    let auto = '';
    try {
      const ma = await db.query("SELECT transcript FROM media_analysis WHERE source = 'publication' AND ref_id = $1 AND status = 'fait'", [c.id]);
      auto = ma ? transcriptToLrc(typeof ma.transcript === 'string' ? JSON.parse(ma.transcript) : ma.transcript) : '';
    } catch (e) { auto = ''; }
    res.json({ lyrics: auto, source: auto ? 'auto' : null, mine });
  });

  // Le créateur écrit, corrige ou enregistre les paroles automatiques de sa chanson.
  app.put('/api/content/:id/lyrics', requireAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const c = await db.query('SELECT id, creator_id FROM content_items WHERE id = $1', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Contenu introuvable.' });
    if (c.creator_id !== req.creatorId) return res.status(403).json({ error: 'Seul le propriétaire de la chanson peut changer ses paroles.' });
    const lyrics = cleanLyrics(req.body && req.body.lyrics);
    const source = req.body && req.body.source === 'auto' ? 'auto' : 'createur';
    await db.query('UPDATE content_items SET lyrics = $2, lyrics_source = $3 WHERE id = $1', [c.id, lyrics || null, lyrics ? source : null]);
    res.json({ saved: true, lyrics, source: lyrics ? source : null });
  });

  // Paroles envoyées avec la publication (formulaire « Publier »).
  async function saveOnPublish(contentId, raw) {
    const lyrics = cleanLyrics(raw);
    if (lyrics) await db.query("UPDATE content_items SET lyrics = $2, lyrics_source = 'createur' WHERE id = $1", [contentId, lyrics]);
  }

  return { saveOnPublish };
}

module.exports = { MIGRATIONS, register, cleanLyrics, transcriptToLrc };
