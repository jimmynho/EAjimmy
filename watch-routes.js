// Eaji — surveillance pour éviter les ennuis judiciaires et les actes contraires à la loi.
//
// 1. Mots sensibles : chaque publication, commentaire, message (privé ou de groupe), message de live et statut
//    est lu automatiquement. S'il contient un mot de la liste (arnaque, arme, drogue, noms d'autorités…),
//    le compte est signalé à l'administration avec les mots surlignés en jaune. L'utilisateur ne voit rien.
//    Le texte écrit DANS les photos et ce qui est DIT dans les vidéos / audios est lu par le tableau de bord
//    de l'administrateur (lecture automatique : reconnaissance du texte et de la parole), puis vérifié de la même façon.
// 2. Accès complet au compte (administrateur principal) : messages écrits, vocaux, images, fichiers, publications.
//    Chaque ouverture est enregistrée avec sa raison (journal d'accès).
// 3. Contenus créés par intelligence artificielle : repérés automatiquement grâce aux marques que posent les
//    outils d'IA (Sora, Veo, Meta AI, Runway, Kling…) dans le fichier, ou marqués par l'administration.
//    Ils ne sont jamais rémunérés : l'argent qu'ils rapportent va à Eaji.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIGRATIONS = [
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS ai_source TEXT',
  'ALTER TABLE content_items ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ',
  `CREATE TABLE IF NOT EXISTS watch_words (
     word TEXT PRIMARY KEY,
     category TEXT NOT NULL DEFAULT 'autre',
     added_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS watch_flags (
     id BIGSERIAL PRIMARY KEY,
     creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
     source TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     origin TEXT NOT NULL CHECK (origin IN ('texte', 'image', 'parole')),
     excerpt TEXT NOT NULL,
     words TEXT[] NOT NULL,
     ranges JSONB NOT NULL DEFAULT '[]',
     at_seconds NUMERIC,
     resolved BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (source, ref_id, origin))`,
  'CREATE INDEX IF NOT EXISTS watch_flags_creator ON watch_flags (creator_id, resolved)',
  `CREATE TABLE IF NOT EXISTS media_analysis (
     source TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     creator_id UUID,
     ocr_text TEXT,
     transcript JSONB,
     status TEXT NOT NULL DEFAULT 'fait',
     analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (source, ref_id))`,
  `CREATE TABLE IF NOT EXISTS watch_cursors (source TEXT PRIMARY KEY, last_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_access_log (
     id BIGSERIAL PRIMARY KEY,
     admin_id UUID,
     creator_id UUID,
     action TEXT NOT NULL,
     reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS admin_access_log_creator ON admin_access_log (creator_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS message_archive (
     id BIGSERIAL PRIMARY KEY,
     kind TEXT NOT NULL,
     message_id TEXT NOT NULL,
     action TEXT NOT NULL,
     sender_id UUID,
     recipient_id UUID,
     group_id UUID,
     text TEXT,
     audio_key TEXT,
     file_key TEXT,
     file_name TEXT,
     file_mime TEXT,
     original_created_at TIMESTAMPTZ,
     archived_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS message_archive_sender ON message_archive (sender_id, archived_at DESC)',
];

// Liste de départ (l'administrateur peut ajouter ou retirer des mots dans le tableau de bord).
const DEFAULT_WORDS = {
  autorites: ['président', 'présidente', 'gouvernement', 'ministre', 'premier ministre', 'gouverneur', 'député', 'sénateur', 'général',
    'colonel', 'police', 'policier', 'militaire', 'FARDC', 'ANR', 'autorités', 'officiel', 'officielle', 'Tshisekedi', 'Kabila', 'Katumbi', 'Kagame', 'Museveni'],
  arnaque: ['arnaque', 'arnaquer', 'arnaqueur', 'escroc', 'escroquerie', 'faux billets', 'scam', 'scammer'],
  piratage: ['pirate', 'piratage', 'pirater', 'hacker', 'hacké'],
  suicide: ['suicide', 'suicider', 'me tuer'],
  meurtre: ['meurtre', 'meurtrier', 'tuer', 'tueur', 'assassiner', 'assassinat', 'égorger', 'murder', 'kill'],
  extorsion: ['extorsion', 'extorquer', 'rançon', 'chantage'],
  cambriolage: ['cambriolage', 'cambrioler', 'cambrioleur', 'braquage', 'braquer'],
  armes: ['armée', 'arme', 'fusil', 'kalachnikov', 'AK-47', 'pistolet', 'munition', 'grenade', 'bombe', 'couteau', 'machette', 'weapon', 'gun', 'knife'],
  complot: ['complot', 'comploter', "coup d'état", 'nuit'],
  drogue: ['drogue', 'cocaïne', 'héroïne', 'chanvre', 'cannabis', 'bangi', 'crack', 'drugs', 'cocaine'],
};
const CATEGORY_LABELS = {
  autorites: 'Autorités / officiels', arnaque: 'Arnaque', piratage: 'Piratage', suicide: 'Suicide', meurtre: 'Meurtre',
  extorsion: 'Extorsion', cambriolage: 'Cambriolage', armes: 'Armée / armes', complot: 'Complot / nuit', drogue: 'Drogue', autre: 'Autre',
};
const SOURCE_LABELS = {
  publication: 'Publication', commentaire: 'Commentaire', message: 'Message privé', groupe: 'Message de groupe',
  live: 'Message pendant un live', statut: 'Statut',
};

// ---------- Recherche des mots (sans tenir compte des accents ni des majuscules) ----------
const VARIANTS = { a: 'aàâäáã', e: 'eéèêë', i: 'iîïí', o: 'oôöóõ', u: 'uùûüú', c: 'cç', n: 'nñ', y: 'yÿ' };
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function wordPattern(word) {
  return [...strip(word).trim()].map((ch) => {
    if (VARIANTS[ch]) return `[${VARIANTS[ch]}]`;
    if (ch === "'" || ch === '’') return "['’ ]?";
    if (ch === ' ') return '\\s+';
    if (ch === '-') return '[-\\s]?';
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
}
let MATCHER = null; // { re, byKey } reconstruit quand la liste change
function buildMatcher(words) {
  if (!words.length) return { re: null, list: [] };
  const sorted = [...words].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${sorted.map(wordPattern).join('|')})(?:s|x|es)?(?![\\p{L}\\p{N}])`, 'giu');
  return { re, list: sorted };
}
function findWords(text, matcher) {
  const out = { words: [], ranges: [] };
  if (!matcher || !matcher.re || !text) return out;
  const seen = new Set();
  matcher.re.lastIndex = 0;
  let m;
  while ((m = matcher.re.exec(text))) {
    out.ranges.push([m.index, m.index + m[0].length]);
    const hit = strip(m[0]);
    const w = matcher.list.find((x) => new RegExp(`^${wordPattern(x)}(?:s|x|es)?$`, 'iu').test(hit)) || hit;
    if (!seen.has(strip(w))) { seen.add(strip(w)); out.words.push(w); }
    if (out.ranges.length > 200) break;
  }
  return out;
}
// Extrait gardé (2 000 caractères au plus, autour des premiers mots trouvés).
function excerptOf(text, matcher) {
  const t = String(text || '');
  if (t.length <= 2000) return t;
  const first = findWords(t, matcher).ranges[0];
  const start = first ? Math.max(0, first[0] - 300) : 0;
  return (start ? '…' : '') + t.slice(start, start + 2000) + (start + 2000 < t.length ? '…' : '');
}

// ---------- Marques laissées par les outils d'intelligence artificielle dans les fichiers ----------
// (normes C2PA / IPTC « trainedAlgorithmicMedia », et noms des générateurs écrits dans les métadonnées)
const AI_MARKERS = [
  'trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia', 'algorithmicMedia', 'Made with Google AI', 'Google Veo', 'SynthID',
  'OpenAI', 'ChatGPT', 'DALL-E', 'DALL·E', 'Midjourney', 'Stable Diffusion', 'StableDiffusion', 'stability.ai', 'RunwayML', 'Runway Gen',
  'Pika Labs', 'PikaLabs', 'Kling AI', 'KlingAI', 'Hailuo', 'Luma AI', 'Dream Machine', 'HeyGen', 'Synthesia', 'Adobe Firefly',
  'Imagined with AI', 'Imagine with Meta', 'Meta AI', 'AI Generated', 'AI-generated', 'ai_generated', 'Generated by AI', '"AIGC"', 'AIGC:',
  'Grok Imagine', 'Ideogram', 'Leonardo.Ai', 'CapCut AI', 'Vidu AI', 'Hunyuan Video', 'Seedance', 'Jimeng',
];
function aiMarkersIn(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
  const low = text.toLowerCase();
  return AI_MARKERS.filter((m) => low.includes(m.toLowerCase()));
}

function register({ app, db, requireAdminPermission, requireAdminPrincipal, createDownloadUrl, STORAGE_CONNECTED }) {
  const canWatch = requireAdminPermission('moderer_contenu');

  async function loadWords() {
    const rows = await db.all('SELECT word FROM watch_words');
    MATCHER = buildMatcher(rows.map((r) => r.word));
    return MATCHER;
  }
  let loadedAt = 0, markReady;
  const ready = new Promise((r) => { markReady = r; });
  async function matcher() {
    // Au démarrage, on attend que la liste des mots soit en place (1 minute au plus).
    await Promise.race([ready, new Promise((r) => setTimeout(r, 60000))]);
    // Liste vide (base pas encore prête au démarrage) : on relit la liste au plus toutes les 10 secondes.
    if (!MATCHER || (!MATCHER.re && Date.now() - loadedAt > 10000)) { loadedAt = Date.now(); return loadWords(); }
    return MATCHER;
  }

  // Première mise en route : la liste de départ est ajoutée une seule fois (les retraits de l'admin restent retirés).
  (async () => {
    for (let i = 0; i < 30; i++) {
      try {
        const seeded = await db.query("SELECT 1 FROM app_settings WHERE key = 'watch_words_seeded'");
        if (!seeded) {
          for (const [cat, words] of Object.entries(DEFAULT_WORDS)) {
            for (const w of words) await db.query('INSERT INTO watch_words (word, category) VALUES ($1, $2) ON CONFLICT DO NOTHING', [w, cat]);
          }
          // Marqué « fait » seulement quand tous les mots sont enregistrés.
          await db.query("INSERT INTO app_settings (key, value) VALUES ('watch_words_seeded', '1') ON CONFLICT (key) DO NOTHING");
          await db.query('DELETE FROM watch_cursors'); // tout est relu avec la liste complète
        }
        await loadWords();
        markReady();
        return;
      } catch (e) { await new Promise((r) => setTimeout(r, 2000)); } // base pas encore prête
    }
    markReady();
  })();

  // Signale (ou met à jour) un passage contenant des mots sensibles.
  async function flag({ creatorId, source, refId, origin, text, atSeconds = null }) {
    if (!creatorId || !text) return null;
    const mt = await matcher();
    const excerpt = excerptOf(text, mt);
    const found = findWords(excerpt, mt);
    if (!found.words.length) return null;
    return db.query(
      `INSERT INTO watch_flags (creator_id, source, ref_id, origin, excerpt, words, ranges, at_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source, ref_id, origin) DO UPDATE SET excerpt = EXCLUDED.excerpt, words = EXCLUDED.words, ranges = EXCLUDED.ranges,
         at_seconds = EXCLUDED.at_seconds, resolved = FALSE, updated_at = now()
       RETURNING id`,
      [creatorId, source, String(refId), origin, excerpt, found.words, JSON.stringify(found.ranges), atSeconds]);
  }

  // ---------- Lecture automatique des textes (toutes les 20 secondes, sans rien changer pour l'utilisateur) ----------
  const TEXT_SOURCES = [
    ['publication', `SELECT id::text AS ref, creator_id, title AS text, GREATEST(created_at, COALESCE(edited_at, created_at)) AS ts FROM content_items`],
    ['commentaire', 'SELECT id::text AS ref, creator_id, text, created_at AS ts FROM content_comments'],
    ['message', 'SELECT id::text AS ref, sender_id AS creator_id, text, GREATEST(created_at, COALESCE(edited_at, created_at)) AS ts FROM direct_messages WHERE deleted_at IS NULL'],
    ['groupe', 'SELECT id::text AS ref, sender_id AS creator_id, text, GREATEST(created_at, COALESCE(edited_at, created_at)) AS ts FROM group_messages WHERE deleted_at IS NULL'],
    ['live', "SELECT id::text AS ref, author_id AS creator_id, text, created_at AS ts FROM live_events WHERE kind = 'message'"],
    ['statut', "SELECT id::text AS ref, creator_id, text, created_at AS ts FROM statuses WHERE text IS NOT NULL AND text <> ''"],
  ];
  let scanning = null;
  async function scanTexts() {
    if (scanning) return scanning;
    scanning = (async () => {
      // Liste des mots pas encore prête : on n'avance pas (rien ne doit être lu « à vide »).
      const mt = await matcher();
      if (!mt || !mt.re) return;
      for (const [source, base] of TEXT_SOURCES) {
        try {
          const cur = await db.query('SELECT last_at::text AS t FROM watch_cursors WHERE source = $1', [source]);
          let from = cur ? cur.t : '1970-01-01T00:00:00Z';
          for (let round = 0; round < 20; round++) {
            const rows = await db.all(`SELECT *, ts::text AS ts_text FROM (${base}) t WHERE t.ts > $1::timestamptz ORDER BY t.ts LIMIT 500`, [from]);
            if (!rows.length) break;
            for (const r of rows) await flag({ creatorId: r.creator_id, source, refId: r.ref, origin: 'texte', text: r.text });
            from = rows[rows.length - 1].ts_text;
            await db.query('INSERT INTO watch_cursors (source, last_at) VALUES ($1, $2::timestamptz) ON CONFLICT (source) DO UPDATE SET last_at = EXCLUDED.last_at', [source, from]);
            if (rows.length < 500) break;
          }
        } catch (e) { /* table pas encore créée : prochain tour */ }
      }
    })().finally(() => { scanning = null; });
    return scanning;
  }
  const timer = setInterval(() => { scanTexts().catch(() => {}); }, 20000);
  if (timer.unref) timer.unref();
  // Les copies des messages modifiés ou supprimés sont effacées après 90 jours.
  const purge = setInterval(() => { db.query("DELETE FROM message_archive WHERE archived_at < now() - interval '90 days'").catch(() => {}); }, 6 * 3600 * 1000);
  if (purge.unref) purge.unref();

  // ---------- Contenus créés par IA ----------
  // Vérification côté serveur (début et fin du fichier, là où les outils écrivent leurs marques).
  async function checkAiInStorage(contentId, storageKey) {
    if (!STORAGE_CONNECTED || !storageKey) return;
    try {
      const url = await createDownloadUrl(storageKey);
      const part = async (range) => {
        const r = await fetch(url, { headers: { Range: range }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) return Buffer.alloc(0);
        return Buffer.from(await r.arrayBuffer());
      };
      const head = await part('bytes=0-3145727');
      const tail = head.length >= 3145728 ? await part('bytes=-1048576') : Buffer.alloc(0);
      const found = aiMarkersIn(Buffer.concat([head, tail]));
      if (found.length) {
        await db.query("UPDATE content_items SET ai_generated = TRUE, ai_source = $2 WHERE id = $1 AND ai_source IS DISTINCT FROM 'admin_non'",
          [contentId, `Marque IA dans le fichier : ${found.slice(0, 3).join(', ')}`]);
      }
    } catch (e) { /* fichier inaccessible : l'administration peut toujours marquer à la main */ }
  }

  // ========== API de l'administration ==========
  const fmt = (r) => ({ ...r, categoryLabel: CATEGORY_LABELS[r.category] || r.category });

  app.get('/api/admin/watch/words', canWatch, async (req, res) => {
    const words = await db.all('SELECT word, category FROM watch_words ORDER BY category, word');
    res.json({ words: words.map(fmt), categories: CATEGORY_LABELS });
  });
  app.post('/api/admin/watch/words', canWatch, async (req, res) => {
    const list = String(req.body.words || req.body.word || '').split(/[,\n;]/).map((w) => w.trim().slice(0, 60)).filter((w) => w.length >= 2);
    if (!list.length) return res.status(400).json({ error: 'Écris au moins un mot (2 lettres minimum).' });
    const category = CATEGORY_LABELS[req.body.category] ? req.body.category : 'autre';
    for (const w of list) await db.query('INSERT INTO watch_words (word, category) VALUES ($1, $2) ON CONFLICT (word) DO UPDATE SET category = EXCLUDED.category', [w, category]);
    await loadWords();
    // Les anciens messages sont relus avec la nouvelle liste.
    await db.query('DELETE FROM watch_cursors');
    scanTexts().catch(() => {});
    res.status(201).json({ added: list.length });
  });
  app.delete('/api/admin/watch/words/:word', canWatch, async (req, res) => {
    await db.query('DELETE FROM watch_words WHERE word = $1', [String(req.params.word)]);
    await loadWords();
    res.json({ removed: true });
  });

  // Comptes signalés, du plus signalé au moins signalé (« Nom³ »).
  app.get('/api/admin/watch/accounts', canWatch, async (req, res) => {
    await scanTexts().catch(() => {});
    const all = req.query.all === '1';
    const rows = await db.all(
      `SELECT cr.id, cr.name, cr.phone, cr.city, cr.country_code, cr.account_status, f.open, f.total, f.last_at,
              (SELECT array_agg(DISTINCT wd) FROM watch_flags w2, unnest(w2.words) wd WHERE w2.creator_id = cr.id AND ($1::boolean OR NOT w2.resolved)) AS words
       FROM (SELECT creator_id, COUNT(*) FILTER (WHERE NOT resolved)::int AS open, COUNT(*)::int AS total, MAX(updated_at) AS last_at
             FROM watch_flags GROUP BY creator_id) f JOIN creators cr ON cr.id = f.creator_id
       WHERE $1::boolean OR f.open > 0
       ORDER BY f.open DESC, f.last_at DESC LIMIT 300`, [all]);
    const pending = await db.query(`SELECT COUNT(*)::int AS n FROM watch_flags WHERE NOT resolved`);
    res.json({ accounts: rows, openFlags: pending.n });
  });
  app.get('/api/admin/watch/count', canWatch, async (req, res) => {
    const r = await db.query('SELECT COUNT(DISTINCT creator_id)::int AS n FROM watch_flags WHERE NOT resolved');
    res.json({ accounts: r.n });
  });
  app.get('/api/admin/watch/flags', canWatch, async (req, res) => {
    if (!UUID_RE.test(String(req.query.creatorId || ''))) return res.status(400).json({ error: 'Compte introuvable.' });
    await scanTexts().catch(() => {});
    const flags = await db.all(
      `SELECT w.*, ma.transcript IS NOT NULL AS has_transcript FROM watch_flags w
       LEFT JOIN media_analysis ma ON ma.source = w.source AND ma.ref_id = w.ref_id
       WHERE w.creator_id = $1 ORDER BY w.resolved, w.updated_at DESC LIMIT 300`, [req.query.creatorId]);
    for (const f of flags) {
      f.sourceLabel = SOURCE_LABELS[f.source] || f.source;
      // Lien vers ce qui a été signalé (publication, fichier, vocal…).
      try {
        if (['publication'].includes(f.source)) {
          const c = await db.query('SELECT title, content_type, storage_url, status FROM content_items WHERE id::text = $1', [f.ref_id]);
          if (c) { f.target = { title: c.title, kind: c.content_type, status: c.status, url: await createDownloadUrl(c.storage_url).catch(() => null) }; }
        } else if (['message', 'groupe'].includes(f.source)) {
          const t = f.source === 'message' ? 'direct_messages' : 'group_messages';
          const m = await db.query(`SELECT file_key, file_name, file_mime, audio_key, created_at FROM ${t} WHERE id::text = $1`, [f.ref_id]);
          if (m) f.target = { name: m.file_name, mime: m.file_mime || (m.audio_key ? 'audio/webm' : null), url: await createDownloadUrl(m.file_key || m.audio_key).catch(() => null), at: m.created_at };
        } else if (f.source === 'statut') {
          const st = await db.query('SELECT kind, storage_key, mime FROM statuses WHERE id::text = $1', [f.ref_id]);
          if (st) f.target = { kind: st.kind, mime: st.mime, url: await createDownloadUrl(st.storage_key).catch(() => null) };
        }
      } catch (e) { /* élément supprimé */ }
    }
    res.json({ flags });
  });
  app.post('/api/admin/watch/flags/:id/resolve', canWatch, async (req, res) => {
    const f = await db.query('UPDATE watch_flags SET resolved = TRUE WHERE id::text = $1 RETURNING id', [String(req.params.id)]);
    if (!f) return res.status(404).json({ error: 'Alerte introuvable.' });
    res.json({ resolved: true });
  });
  app.post('/api/admin/watch/accounts/:id/resolve', canWatch, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Compte introuvable.' });
    await db.query('UPDATE watch_flags SET resolved = TRUE WHERE creator_id = $1', [req.params.id]);
    res.json({ resolved: true });
  });

  // ---------- Lecture automatique des photos, vidéos et audios (faite par le navigateur de l'administrateur) ----------
  const MEDIA_SOURCES = [
    ['publication', `SELECT id::text AS ref, creator_id, storage_url AS key, content_type AS kind, NULL AS mime, title, created_at FROM content_items
                     WHERE storage_url IS NOT NULL AND status IN ('actif', 'en_revue')
                       AND content_type IN ('photo', 'publication', 'video_courte', 'video_longue', 'film', 'musique', 'audio', 'podcast')`],
    ['message', `SELECT id::text AS ref, sender_id AS creator_id, COALESCE(file_key, audio_key) AS key, CASE WHEN audio_key IS NOT NULL THEN 'vocal' ELSE 'fichier' END AS kind,
                   COALESCE(file_mime, CASE WHEN audio_key IS NOT NULL THEN 'audio/webm' END) AS mime, file_name AS title, created_at FROM direct_messages
                 WHERE deleted_at IS NULL AND (audio_key IS NOT NULL OR file_mime LIKE 'image/%' OR file_mime LIKE 'video/%' OR file_mime LIKE 'audio/%')`],
    ['groupe', `SELECT id::text AS ref, sender_id AS creator_id, COALESCE(file_key, audio_key) AS key, CASE WHEN audio_key IS NOT NULL THEN 'vocal' ELSE 'fichier' END AS kind,
                  COALESCE(file_mime, CASE WHEN audio_key IS NOT NULL THEN 'audio/webm' END) AS mime, file_name AS title, created_at FROM group_messages
                WHERE deleted_at IS NULL AND (audio_key IS NOT NULL OR file_mime LIKE 'image/%' OR file_mime LIKE 'video/%' OR file_mime LIKE 'audio/%')`],
    ['statut', `SELECT id::text AS ref, creator_id, storage_key AS key, kind, mime, text AS title, created_at FROM statuses WHERE storage_key IS NOT NULL`],
  ];
  function mediaKind(r) {
    const mime = String(r.mime || '');
    if (mime.startsWith('image/') || ['photo', 'publication'].includes(r.kind)) return 'image';
    if (mime.startsWith('video/') || ['video_courte', 'video_longue', 'film', 'video'].includes(r.kind)) return 'video';
    return 'audio';
  }
  app.get('/api/admin/watch/queue', canWatch, async (req, res) => {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    const items = [];
    let remaining = 0;
    for (const [source, base] of MEDIA_SOURCES) {
      try {
        const cnt = await db.query(`SELECT COUNT(*)::int AS n FROM (${base}) t WHERE NOT EXISTS (SELECT 1 FROM media_analysis ma WHERE ma.source = $1 AND ma.ref_id = t.ref)`, [source]);
        remaining += cnt.n;
        if (items.length >= limit) continue;
        const rows = await db.all(
          `SELECT * FROM (${base}) t WHERE NOT EXISTS (SELECT 1 FROM media_analysis ma WHERE ma.source = $1 AND ma.ref_id = t.ref)
           ORDER BY t.created_at DESC LIMIT $2`, [source, limit - items.length]);
        for (const r of rows) {
          items.push({ source, refId: r.ref, creatorId: r.creator_id, kind: mediaKind(r), title: r.title, url: await createDownloadUrl(r.key).catch(() => null) });
        }
      } catch (e) { /* table absente */ }
    }
    res.json({ items, remaining });
  });
  app.post('/api/admin/watch/analysis', canWatch, async (req, res) => {
    const source = String(req.body.source || '');
    const refId = String(req.body.refId || '').slice(0, 64);
    if (!MEDIA_SOURCES.some(([s]) => s === source) || !refId) return res.status(400).json({ error: 'Élément inconnu.' });
    const base = MEDIA_SOURCES.find(([s]) => s === source)[1];
    const row = await db.query(`SELECT * FROM (${base}) t WHERE t.ref = $1`, [refId]).catch(() => null);
    if (!row) return res.status(404).json({ error: 'Élément introuvable.' });
    const ocr = String(req.body.ocrText || '').slice(0, 20000);
    const transcript = (Array.isArray(req.body.transcript) ? req.body.transcript : []).slice(0, 2000)
      .map((c) => ({ start: Number(c.start) || 0, end: Number(c.end) || 0, text: String(c.text || '').slice(0, 1000) }))
      .filter((c) => c.text.trim());
    await db.query(
      `INSERT INTO media_analysis (source, ref_id, creator_id, ocr_text, transcript, status) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (source, ref_id) DO UPDATE SET ocr_text = EXCLUDED.ocr_text, transcript = EXCLUDED.transcript, status = EXCLUDED.status, analyzed_at = now()`,
      [source, refId, row.creator_id, ocr || null, JSON.stringify(transcript), req.body.error ? 'echec' : 'fait']);
    let flagged = 0;
    if (ocr.trim() && await flag({ creatorId: row.creator_id, source, refId, origin: 'image', text: ocr })) flagged++;
    if (transcript.length) {
      const mt = await matcher();
      const firstHit = transcript.find((c) => findWords(c.text, mt).words.length);
      const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      const text = transcript.map((c) => `[${mmss(c.start)}] ${c.text.trim()}`).join('\n');
      if (await flag({ creatorId: row.creator_id, source, refId, origin: 'parole', text, atSeconds: firstHit ? firstHit.start : null })) flagged++;
    }
    res.json({ saved: true, flagged });
  });
  app.get('/api/admin/watch/analysis', canWatch, async (req, res) => {
    const a = await db.query('SELECT * FROM media_analysis WHERE source = $1 AND ref_id = $2', [String(req.query.source || ''), String(req.query.refId || '')]);
    res.json({ analysis: a || null });
  });

  // ---------- Contenus IA ----------
  app.get('/api/admin/watch/ai', canWatch, async (req, res) => {
    const items = await db.all(
      `SELECT c.id, c.title, c.content_type, c.ai_source, c.view_count, c.created_at, c.status, cr.name AS creator_name, cr.id AS creator_id,
              COALESCE((SELECT SUM(l.amount_usd) FROM revenue_ledger l JOIN payment_requests p ON p.id = l.payment_id
                         WHERE p.target_id = c.id AND l.source LIKE '%\\_ia' ESCAPE '\\'), 0)::float AS revenue_usd
       FROM content_items c JOIN creators cr ON cr.id = c.creator_id WHERE c.ai_generated ORDER BY c.created_at DESC LIMIT 300`);
    for (const i of items) {
      const c = await db.query('SELECT storage_url FROM content_items WHERE id = $1', [i.id]);
      i.url = await createDownloadUrl(c && c.storage_url).catch(() => null);
    }
    res.json({ items });
  });
  app.post('/api/admin/content/:id/ai', canWatch, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Contenu introuvable.' });
    const on = req.body.ai === true;
    const c = await db.query(
      'UPDATE content_items SET ai_generated = $2, ai_source = $3 WHERE id = $1 RETURNING id',
      [req.params.id, on, on ? 'Marqué par l\'administration' : 'admin_non']);
    if (!c) return res.status(404).json({ error: 'Contenu introuvable.' });
    res.json({ ai: on });
  });

  // ========== Accès complet à un compte (administrateur principal, toujours avec une raison enregistrée) ==========
  async function logAccess(adminId, creatorId, action, reason) {
    await db.query('INSERT INTO admin_access_log (admin_id, creator_id, action, reason) VALUES ($1, $2, $3, $4)', [adminId, creatorId, action, reason || null]);
  }
  async function requireOpen(req, res) {
    if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'Compte introuvable.' }); return false; }
    const open = await db.query(
      "SELECT 1 FROM admin_access_log WHERE admin_id = $1 AND creator_id = $2 AND action = 'ouverture' AND created_at > now() - interval '2 hours'",
      [req.adminId, req.params.id]);
    if (!open) { res.status(403).json({ error: 'Indique d\'abord la raison de l\'ouverture de ce compte.', needReason: true }); return false; }
    return true;
  }
  const withUrl = async (key, name) => (key ? createDownloadUrl(key, name).catch(() => null) : null);

  app.post('/api/admin/inspect/:id/open', requireAdminPrincipal, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Compte introuvable.' });
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (reason.length < 5) return res.status(400).json({ error: 'Écris la raison (5 caractères au moins) : elle est gardée dans le journal d\'accès.' });
    const c = await db.query('SELECT id FROM creators WHERE id = $1', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Compte introuvable.' });
    await logAccess(req.adminId, c.id, 'ouverture', reason);
    res.status(201).json({ opened: true });
  });

  app.get('/api/admin/inspect/:id', requireAdminPrincipal, async (req, res) => {
    if (!(await requireOpen(req, res))) return;
    const id = req.params.id;
    const c = await db.query(
      `SELECT id, name, email, phone, country_code, city, zone, account_status, created_at, last_seen_at, photo_url, language, gift_currency
       FROM creators WHERE id = $1`, [id]);
    if (!c) return res.status(404).json({ error: 'Compte introuvable.' });
    c.photoUrl = await withUrl(c.photo_url); delete c.photo_url;
    const publications = await db.all(
      `SELECT id, title, content_type, status, visibility_scope, created_at, view_count, storage_url, ai_generated, ai_source, duration_seconds, sale_price
       FROM content_items WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 300`, [id]);
    for (const p of publications) { p.url = await withUrl(p.storage_url); delete p.storage_url; }
    const comments = await db.all(
      `SELECT cc.id, cc.text, cc.created_at, ci.title AS content_title FROM content_comments cc LEFT JOIN content_items ci ON ci.id = cc.content_id
       WHERE cc.creator_id = $1 ORDER BY cc.created_at DESC LIMIT 300`, [id]);
    const conversations = await db.all(
      `SELECT other_id, cr.name AS other_name, COUNT(*)::int AS messages, MAX(m.created_at) AS last_at,
              COUNT(*) FILTER (WHERE m.file_key IS NOT NULL OR m.audio_key IS NOT NULL)::int AS files
       FROM (SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_id, created_at, file_key, audio_key
             FROM direct_messages WHERE sender_id = $1 OR recipient_id = $1) m JOIN creators cr ON cr.id = m.other_id
       GROUP BY other_id, cr.name ORDER BY MAX(m.created_at) DESC LIMIT 500`, [id]);
    const groups = await db.all(
      `SELECT g.id, g.name, (SELECT COUNT(*)::int FROM group_messages gm WHERE gm.group_id = g.id AND gm.sender_id = $1) AS sent
       FROM chat_groups g JOIN chat_group_members m ON m.group_id = g.id AND m.creator_id = $1 ORDER BY g.created_at DESC`, [id]);
    let statuses = [];
    try {
      statuses = await db.all('SELECT id, kind, text, mime, storage_key, created_at, expires_at FROM statuses WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
      for (const s of statuses) { s.url = await withUrl(s.storage_key); delete s.storage_key; }
    } catch (e) { /* statuts pas encore créés */ }
    const archive = await db.all('SELECT * FROM message_archive WHERE sender_id = $1 ORDER BY archived_at DESC LIMIT 200', [id]);
    for (const a of archive) { a.fileUrl = await withUrl(a.file_key, a.file_name); a.audioUrl = await withUrl(a.audio_key); delete a.file_key; delete a.audio_key; }
    const liveMessages = await db.all(
      "SELECT e.text, e.created_at, e.live_id FROM live_events e WHERE e.author_id = $1 AND e.kind = 'message' ORDER BY e.created_at DESC LIMIT 200", [id]);
    const access = await db.all(
      `SELECT l.action, l.reason, l.created_at, a.name AS admin_name FROM admin_access_log l LEFT JOIN admins a ON a.id = l.admin_id
       WHERE l.creator_id = $1 ORDER BY l.created_at DESC LIMIT 50`, [id]);
    const flags = await db.query('SELECT COUNT(*) FILTER (WHERE NOT resolved)::int AS open, COUNT(*)::int AS total FROM watch_flags WHERE creator_id = $1', [id]);
    res.json({ creator: c, publications, comments, conversations, groups, statuses, archive, liveMessages, access, flags });
  });

  app.get('/api/admin/inspect/:id/dm/:otherId', requireAdminPrincipal, async (req, res) => {
    if (!(await requireOpen(req, res))) return;
    if (!UUID_RE.test(req.params.otherId)) return res.status(404).json({ error: 'Conversation introuvable.' });
    await logAccess(req.adminId, req.params.id, 'conversation', `avec ${req.params.otherId}`);
    const messages = await db.all(
      `SELECT m.id, m.sender_id, m.text, m.created_at, m.edited_at, m.deleted_at, m.read_at, m.file_key, m.file_name, m.file_mime, m.audio_key, m.shared_content_id,
              cr.name AS sender_name
       FROM direct_messages m JOIN creators cr ON cr.id = m.sender_id
       WHERE (m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1)
       ORDER BY m.created_at ASC LIMIT 2000`, [req.params.id, req.params.otherId]);
    const arch = await db.all("SELECT * FROM message_archive WHERE kind = 'prive' AND ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)) ORDER BY archived_at", [req.params.id, req.params.otherId]);
    for (const m of messages) {
      m.fileUrl = await withUrl(m.file_key, m.file_name); m.audioUrl = await withUrl(m.audio_key);
      m.history = arch.filter((a) => a.message_id === String(m.id)).map((a) => ({ action: a.action, text: a.text, at: a.archived_at, file_name: a.file_name }));
      for (const h of m.history) { const a = arch.find((x) => x.archived_at === h.at); if (a) { h.fileUrl = await withUrl(a.file_key, a.file_name); h.audioUrl = await withUrl(a.audio_key); } }
      delete m.file_key; delete m.audio_key;
    }
    res.json({ messages });
  });

  app.get('/api/admin/inspect/:id/group/:groupId', requireAdminPrincipal, async (req, res) => {
    if (!(await requireOpen(req, res))) return;
    if (!UUID_RE.test(req.params.groupId)) return res.status(404).json({ error: 'Groupe introuvable.' });
    const member = await db.query('SELECT 1 FROM chat_group_members WHERE group_id = $1 AND creator_id = $2', [req.params.groupId, req.params.id]);
    if (!member) return res.status(404).json({ error: 'Groupe introuvable.' });
    await logAccess(req.adminId, req.params.id, 'groupe', req.params.groupId);
    const messages = await db.all(
      `SELECT gm.id, gm.sender_id, gm.text, gm.created_at, gm.edited_at, gm.deleted_at, gm.file_key, gm.file_name, gm.file_mime, gm.audio_key, cr.name AS sender_name
       FROM group_messages gm LEFT JOIN creators cr ON cr.id = gm.sender_id WHERE gm.group_id = $1 ORDER BY gm.id ASC LIMIT 3000`, [req.params.groupId]);
    const arch = await db.all("SELECT * FROM message_archive WHERE kind = 'groupe' AND group_id = $1", [req.params.groupId]);
    for (const m of messages) {
      m.fileUrl = await withUrl(m.file_key, m.file_name); m.audioUrl = await withUrl(m.audio_key);
      m.history = arch.filter((a) => a.message_id === String(m.id)).map((a) => ({ action: a.action, text: a.text, at: a.archived_at, file_name: a.file_name }));
      delete m.file_key; delete m.audio_key;
    }
    res.json({ messages });
  });

  app.get('/api/admin/access-log', requireAdminPrincipal, async (req, res) => {
    const rows = await db.all(
      `SELECT l.*, a.name AS admin_name, cr.name AS creator_name FROM admin_access_log l
       LEFT JOIN admins a ON a.id = l.admin_id LEFT JOIN creators cr ON cr.id = l.creator_id ORDER BY l.created_at DESC LIMIT 300`);
    res.json({ log: rows });
  });

  return { flag, scanTexts, checkAiInStorage, aiMarkersIn };
}

module.exports = { MIGRATIONS, register, aiMarkersIn, AI_MARKERS, findWords, buildMatcher, DEFAULT_WORDS };
