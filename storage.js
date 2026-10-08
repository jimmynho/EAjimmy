// Eaji — stockage réel des fichiers (vidéos, photos, PDF, musique) sur Backblaze B2.
// B2 parle le même langage qu'Amazon S3, donc on utilise la bibliothèque officielle S3.
// Le navigateur envoie le fichier DIRECTEMENT à B2 (via une adresse temporaire signée) :
// le serveur Railway ne transporte jamais le fichier lui-même, ce qui permet les gros fichiers (1 Go).

const crypto = require('crypto');

const STORAGE_CONNECTED = Boolean(
  process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET &&
  process.env.B2_ENDPOINT && process.env.B2_REGION
);

let s3 = null;
let PutObjectCommand = null;
let GetObjectCommand = null;
let getSignedUrl = null;

if (STORAGE_CONNECTED) {
  const { S3Client, PutObjectCommand: Put, GetObjectCommand: Get } = require('@aws-sdk/client-s3');
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  PutObjectCommand = Put;
  GetObjectCommand = Get;
  s3 = new S3Client({
    region: process.env.B2_REGION,
    endpoint: process.env.B2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APP_KEY,
    },
  });
} else {
  console.warn('[Eaji] Stockage de fichiers non configuré (variables B2_* manquantes) : les envois de fichiers sont désactivés.');
}

const UPLOAD_URL_LIFETIME_S = 60 * 60;        // 1 h pour envoyer un gros fichier
const DOWNLOAD_URL_LIFETIME_S = 6 * 60 * 60;  // 6 h pour regarder / écouter

// Nom de fichier imprévisible : personne ne peut deviner l'adresse d'un contenu.
function buildStorageKey(creatorId, originalName) {
  const ext = (String(originalName || '').match(/\.[a-zA-Z0-9]{1,8}$/) || [''])[0].toLowerCase();
  return `${creatorId}/${crypto.randomUUID()}${ext}`;
}

async function createUploadUrl(storageKey, mimeType) {
  const command = new PutObjectCommand({
    Bucket: process.env.B2_BUCKET,
    Key: storageKey,
    ContentType: mimeType || 'application/octet-stream',
  });
  return getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_LIFETIME_S });
}

async function createDownloadUrl(storageKey) {
  if (!STORAGE_CONNECTED || !storageKey) return null;
  const command = new GetObjectCommand({ Bucket: process.env.B2_BUCKET, Key: storageKey });
  return getSignedUrl(s3, command, { expiresIn: DOWNLOAD_URL_LIFETIME_S });
}

module.exports = { STORAGE_CONNECTED, buildStorageKey, createUploadUrl, createDownloadUrl };
