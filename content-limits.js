/**
 * Limites de contenu — Eaji
 * -----------------------------------------------------------------
 * Ces limites sont des métadonnées de validation : la taille réelle du
 * fichier doit être vérifiée par le service de stockage (ex: Cloudinary,
 * Backblaze B2, AWS S3) au moment de l'upload — ce backend ne stocke
 * jamais les fichiers eux-mêmes, seulement leur lien signé.
 */

const GIGA = 1024 * 1024 * 1024;
const MEGA = 1024 * 1024;

const MAX_FILE_SIZE_BYTES = {
  video_courte: 1 * GIGA,
  video_longue: 1 * GIGA,
  film: 1 * GIGA,
  musique: 500 * MEGA,
  audio: 500 * MEGA,
  publication: 20 * MEGA, // message long + photo, façon Facebook
  photo: 20 * MEGA,
  livre: 10 * MEGA,
  pdf: 10 * MEGA,
  powerpoint: 10 * MEGA,
  telechargement: 1 * GIGA,
  podcast: 500 * MEGA,
  live: null, // pas de fichier — flux en direct
};

const LIVE_SUBSCRIBER_THRESHOLD = 500;

function validateFileSize(contentType, fileSizeBytes) {
  const max = MAX_FILE_SIZE_BYTES[contentType];
  if (max === undefined) {
    return { valid: false, error: `Type de contenu inconnu : "${contentType}".` };
  }
  if (max === null) {
    return { valid: true }; // pas de limite de fichier (live)
  }
  if (typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0) {
    return { valid: false, error: 'Taille de fichier manquante ou invalide.' };
  }
  if (fileSizeBytes > max) {
    return { valid: false, error: `Fichier trop volumineux pour "${contentType}" (max ${(max / MEGA).toFixed(0)} Mo).` };
  }
  return { valid: true };
}

function isLiveEligible(subscribers) {
  return subscribers >= LIVE_SUBSCRIBER_THRESHOLD;
}

module.exports = { MAX_FILE_SIZE_BYTES, LIVE_SUBSCRIBER_THRESHOLD, validateFileSize, isLiveEligible };
