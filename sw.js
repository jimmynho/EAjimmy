/* ONGD Les Volontaires — fonctionnement hors réseau
   Les pages s'ouvrent même sans réseau (dernière version enregistrée sur le téléphone).
   Changez le numéro de VERSION à chaque mise à jour du site pour rafraîchir les téléphones. */
const VERSION = 'ongd-v15';
const PAGES = ['./', 'index.html', 'formations.html', 'boutique.html', 'dialogue.html', 'direct.html', 'annonces.html', 'paiement.html',
  'volontaire.html', 'fichiers.html', 'membres.html', 'style.css', 'config.js', 'commun.js', 'logo.svg', 'logo-officiel.jpg', 'bienvenue.jpg', 'icone-192.png', 'icone-512.png', 'manifest.webmanifest'];
// Données publiques gardées pour la lecture hors réseau
const API_PUBLIQUE = /\/api\/ongd\/(activites|stats|programmes|produits|sujets|directs|annonces\/actives|annonces\/forfaits|fichiers$|membres\/offre|photos\/|media\/)/;

self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(PAGES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(cles => Promise.all(cles.filter(k => k !== VERSION && k !== 'ongd-donnees').map(k => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || req.headers.has('Authorization') || url.search.includes('t=')) return; // rien de privé dans le cache
  if (url.pathname.endsWith('admin.html')) return;
  if (/\/activites\/\d+\/(video|interactions)$/.test(url.pathname)) return; // vidéos et commentaires : toujours en direct
  if (API_PUBLIQUE.test(url.pathname)) {
    // Réseau d'abord, sinon la dernière réponse enregistrée
    e.respondWith(fetch(req).then(rep => {
      if (rep.ok) { const copie = rep.clone(); caches.open('ongd-donnees').then(c => c.put(req, copie)); }
      return rep;
    }).catch(() => caches.match(req).then(r => r || new Response(JSON.stringify({ erreur: 'Pas de connexion internet. Réessayez.' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  if (url.origin !== location.origin) return;
  // Pages du site : version enregistrée tout de suite, mise à jour en arrière-plan
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(enCache => {
    const reseau = fetch(req).then(rep => { if (rep.ok) { const copie = rep.clone(); caches.open(VERSION).then(c => c.put(req, copie)); } return rep; }).catch(() => enCache);
    return enCache || reseau;
  }));
});
