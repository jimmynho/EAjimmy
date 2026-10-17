// Eaji — stockage réel des fichiers (vidéos, photos, PDF, musique) sur Backblaze B2.
// B2 parle le même langage qu'Amazon S3, donc on utilise la bibliothèque officielle S3.
// Deux chemins d'envoi :
//  1. direct : le navigateur envoie le fichier à B2 via une adresse temporaire signée ;
//  2. relais : si le navigateur n'y arrive pas (réglage CORS de B2), il envoie le fichier
//     au serveur Railway, qui le transmet à B2. Ce chemin ne dépend d'aucun réglage CORS.

const crypto = require('crypto');

const STORAGE_CONNECTED = Boolean(
  process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET &&
  process.env.B2_ENDPOINT && process.env.B2_REGION
);

let s3 = null;
let PutObjectCommand = null;
let GetObjectCommand = null;
let PutBucketCorsCommand = null;
let getSignedUrl = null;

if (STORAGE_CONNECTED) {
  const sdk = require('@aws-sdk/client-s3');
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  PutObjectCommand = sdk.PutObjectCommand;
  GetObjectCommand = sdk.GetObjectCommand;
  PutBucketCorsCommand = sdk.PutBucketCorsCommand;
  s3 = new sdk.S3Client({
    region: process.env.B2_REGION,
    endpoint: process.env.B2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APP_KEY,
    },
    // Compatibilité Backblaze : n'ajoute les sommes de contrôle que si elles sont exigées.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
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

// downloadName : le fichier est enregistré sur le téléphone sous ce nom (au lieu d'être seulement affiché).
async function createDownloadUrl(storageKey, downloadName) {
  if (!STORAGE_CONNECTED || !storageKey) return null;
  const input = { Bucket: process.env.B2_BUCKET, Key: storageKey };
  if (downloadName) input.ResponseContentDisposition = `attachment; filename*=UTF-8''${encodeURIComponent(String(downloadName).slice(0, 150))}`;
  const command = new GetObjectCommand(input);
  return getSignedUrl(s3, command, { expiresIn: DOWNLOAD_URL_LIFETIME_S });
}

// Chemin relais : le serveur transmet à B2 le fichier reçu du navigateur, sans le garder en mémoire.
async function uploadThroughServer(storageKey, mimeType, bodyStream, contentLength) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.B2_BUCKET,
    Key: storageKey,
    ContentType: mimeType || 'application/octet-stream',
    ContentLength: contentLength,
    Body: bodyStream,
  }));
}

// Essaie d'autoriser les envois directs depuis le navigateur (règle CORS sur le bucket).
// Si la clé B2 n'a pas ce droit, ce n'est pas grave : le chemin relais prend le relais.
async function tryEnableBrowserUploads() {
  if (!STORAGE_CONNECTED || !PutBucketCorsCommand) return;
  try {
    await s3.send(new PutBucketCorsCommand({
      Bucket: process.env.B2_BUCKET,
      CORSConfiguration: {
        CORSRules: [{
          AllowedOrigins: ['*'],
          AllowedMethods: ['GET', 'HEAD', 'PUT'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3600,
        }],
      },
    }));
    console.log('[Eaji] Envois directs vers B2 autorisés (règle CORS appliquée).');
  } catch (e) {
    console.warn('[Eaji] Règle CORS B2 non appliquée (' + e.message + ') — les envois passeront par le serveur.');
  }
}

// Suppression d'un compte : efface VRAIMENT tous ses fichiers (vidéos, photos, messages, pièce d'identité,
// photo du visage…). Sur B2, on efface chaque version, sinon le fichier ne serait que « caché ».
async function deleteCreatorFiles(creatorId) {
  if (!STORAGE_CONNECTED || !/^[0-9a-f-]{36}$/i.test(String(creatorId))) return 0;
  const sdk = require('@aws-sdk/client-s3');
  let removed = 0, KeyMarker, VersionIdMarker;
  for (let round = 0; round < 1000; round++) {
    const page = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: process.env.B2_BUCKET, Prefix: `${creatorId}/`, KeyMarker, VersionIdMarker, MaxKeys: 1000 }));
    const objects = [...(page.Versions || []), ...(page.DeleteMarkers || [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    if (objects.length) {
      await s3.send(new sdk.DeleteObjectsCommand({ Bucket: process.env.B2_BUCKET, Delete: { Objects: objects, Quiet: true } }));
      removed += objects.length;
    }
    if (!page.IsTruncated) break;
    KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker;
  }
  return removed;
}

module.exports = {
  STORAGE_CONNECTED, buildStorageKey, createUploadUrl, createDownloadUrl,
  uploadThroughServer, tryEnableBrowserUploads, deleteCreatorFiles,
};
