// Eaji — image d'aperçu des vidéos préparée par le SERVEUR (sans attendre le téléphone de l'auteur).
// Une image est tirée de la vidéo avec ffmpeg, le bouton ▶ est posé au centre, puis elle est rangée
// dans le stockage. C'est elle que Facebook, WhatsApp, Telegram… affichent avec le lien partagé.
// ffmpeg vient du paquet « ffmpeg-static » (installé automatiquement), sinon de la variable FFMPEG_PATH,
// sinon de la commande « ffmpeg » du serveur. Sans ffmpeg, rien ne casse : l'aperçu reste l'ancien.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VIDEO_KINDS = ['video_courte', 'video_longue', 'film', 'telechargement'];
const PLAY_PNG = path.join(__dirname, 'apercu-play.png');
const MAX_PARALLEL = 2;

let BIN;
function ffmpegPath() {
  if (BIN !== undefined) return BIN;
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { const p = require('ffmpeg-static'); if (p) candidates.push(p); } catch (e) { /* paquet absent */ }
  candidates.push('ffmpeg');
  BIN = null;
  for (const c of candidates) {
    try { if (spawnSync(c, ['-version'], { timeout: 8000 }).status === 0) { BIN = c; break; } } catch (e) { /* suivant */ }
  }
  console.log(BIN ? `[Eaji] Aperçus des vidéos : ffmpeg prêt (${BIN === 'ffmpeg' ? 'commande du serveur' : BIN}).` : '[Eaji] Aperçus des vidéos : ffmpeg introuvable (les téléphones préparent les aperçus).');
  return BIN;
}

// Largeur × hauteur d'une image JPEG (lues dans son en-tête).
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    let out = [], done = false;
    const p = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* déjà fini */ } finish(null); }, timeoutMs);
    p.stdout.on('data', (c) => out.push(c));
    p.on('error', () => finish(null));
    p.on('close', (code) => { const b = Buffer.concat(out); finish(code === 0 && b.length > 1000 && b[0] === 0xff && b[1] === 0xd8 ? b : null); });
  });
}

// Une image de la vidéo (à 1 s, ou au tout début si elle est très courte), 1200 px au plus, avec ▶.
async function frameJpeg(url, timeoutMs = 20000) {
  const scale = "scale='if(gt(iw,ih),min(1200,iw),-2)':'if(gt(iw,ih),-2,min(1200,ih))',setsar=1";
  const withPlay = fs.existsSync(PLAY_PNG);
  for (const at of ['1', '0']) {
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', at, '-i', url];
    if (withPlay) {
      args.push('-i', PLAY_PNG, '-filter_complex',
        `[0:v]${scale}[v];[1:v][v]scale2ref=w='0.24*min(main_w,main_h)':h='ow'[p][v2];[v2][p]overlay=(W-w)/2:(H-h)/2[o]`, '-map', '[o]');
    } else args.push('-vf', scale);
    args.push('-frames:v', '1', '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1');
    const buf = await runFfmpeg(args, timeoutMs);
    if (buf) return buf;
  }
  return null;
}

// Images brutes de la vidéo (sans le bouton ▶) à plusieurs moments : servent à la vérification par l'IA.
async function rawFrames(url, seconds, timeoutMs = 20000) {
  if (!ffmpegPath()) return [];
  const out = [];
  for (const s of seconds.slice(0, 4)) {
    const buf = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, Number(s) || 0).toFixed(2)), '-i', url,
      '-vf', "scale='if(gt(iw,ih),min(768,iw),-2)':'if(gt(iw,ih),-2,min(768,ih))'", '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], timeoutMs);
    if (buf) out.push(buf);
  }
  return out;
}

function register({ db, createDownloadUrl, uploadThroughServer, buildStorageKey }) {
  const inflight = new Map();
  const failedAt = new Map();
  let running = 0;
  const queue = [];
  const slot = () => new Promise((r) => { if (running < MAX_PARALLEL) { running++; r(); } else queue.push(r); });
  const release = () => { const next = queue.shift(); if (next) next(); else running--; };

  // it : { id, creator_id, content_type, storage_url, thumb_key } — renvoie { key, w, h } ou null.
  function ensure(it) {
    if (!it || it.thumb_key || !VIDEO_KINDS.includes(it.content_type) || !it.storage_url) return Promise.resolve(null);
    if (inflight.has(it.id)) return inflight.get(it.id);
    if (Date.now() - (failedAt.get(it.id) || 0) < 10 * 60 * 1000) return Promise.resolve(null);
    if (!ffmpegPath()) return Promise.resolve(null);
    const job = (async () => {
      await slot();
      try {
        const url = await createDownloadUrl(it.storage_url);
        const buf = url && await frameJpeg(url);
        if (!buf) { failedAt.set(it.id, Date.now()); return null; }
        const size = jpegSize(buf) || { w: null, h: null };
        const key = buildStorageKey(it.creator_id, 'apercu.jpg');
        await uploadThroughServer(key, 'image/jpeg', buf, buf.length);
        const row = await db.query(`UPDATE content_items SET thumb_key = $2, thumb_w = $3, thumb_h = $4
          WHERE id = $1 AND thumb_key IS NULL RETURNING thumb_key, thumb_w, thumb_h`, [it.id, key, size.w, size.h]);
        if (!row) {
          // L'auteur a envoyé la sienne entre-temps : on garde la sienne.
          const cur = await db.query('SELECT thumb_key, thumb_w, thumb_h FROM content_items WHERE id = $1', [it.id]);
          return cur && cur.thumb_key ? { key: cur.thumb_key, w: cur.thumb_w, h: cur.thumb_h } : null;
        }
        return { key, w: size.w, h: size.h };
      } catch (e) {
        failedAt.set(it.id, Date.now());
        return null;
      } finally { release(); }
    })().finally(() => inflight.delete(it.id));
    inflight.set(it.id, job);
    return job;
  }
  // Attendre au plus « ms » millisecondes (la page partagée ne doit pas trop tarder).
  const ensureWithin = (it, ms) => Promise.race([ensure(it), new Promise((r) => setTimeout(() => r(null), ms))]);
  return { ensure, ensureWithin, available: () => Boolean(ffmpegPath()), VIDEO_KINDS };
}

module.exports = { register, frameJpeg, rawFrames, jpegSize, ffmpegPath };
