/* =====================================================================
   ONGD Les Volontaires — RÉGLAGES DU SITE
   Modifiez seulement les textes entre guillemets ci-dessous.
   ===================================================================== */
// Toujours en connexion sécurisée (cadenas) : http:// → https://
if (location.protocol === 'http:' && !/^(localhost|127\.|192\.168\.)/.test(location.hostname)) location.replace('https://' + location.host + location.pathname + location.search + location.hash);

window.ONGD = {
  nom: 'ONGD Les Volontaires',

  // Adresse du serveur Eaji (Railway) — ne pas changer sauf si le serveur change
  api: 'https://eajimmy-production.up.railway.app/api/ongd',
  // Liens partagés sur Facebook, WhatsApp… (adresse eaji.org du serveur : aperçu avec photo et texte)
  partage: 'https://api.eaji.org/api/ongd/partage/',

  slogan: 'Ensemble, nous pouvons transformer notre société !',

  // Texte de présentation de l'ONGD (vision)
  mission: "Notre vision est de former, autonomiser et inspirer à travers l'éducation et l'électricité pour un avenir durable et équitable. Ensemble, éclairons les communautés et construisons un monde meilleur.",

  // Les 12 domaines d'intervention. « centre: true » = mis en avant (l'électricité, au cœur de notre action)
  domaines: [
    { titre: 'Village des volontaires pour la jeunesse technologique', texte: "Former les jeunes aux métiers du numérique et de l'innovation, espaces de co-working et d'incubation, ateliers pratiques et hackathons, préparer la jeunesse aux défis du futur." },
    { titre: "Création d'entreprises locales", texte: "Charpenterie, mécanique, apprentissage de la robotique et de l'intelligence artificielle, tournage et forge écologique, accompagnement, formation, accès au financement, mise en réseau et mentorat." },
    { titre: "Festivals d'innovation", texte: "Célébrer la créativité, la technologie et l'innovation : concours de projets, expositions et démonstrations, conférences et panels, réseautage et opportunités." },
    { titre: 'Mobilisation de financements', texte: "Lever des fonds pour les projets de développement : partenariats public-privé, fonds d'investissement, crowdfunding et mécénat, gestion transparente." },
    { titre: 'Plaidoyer pour les démunis', texte: "Défendre les droits des plus vulnérables, lutter contre la pauvreté, promouvoir l'inclusion sociale et l'égalité des chances, sensibilisation et mobilisation citoyenne." },
    { titre: 'Solutions sociales concrètes et construction', texte: "Construction d'une école de qualité, d'un centre de formation et d'apprentissage, et d'un espace d'encadrement socio-économique." },
    { titre: 'Interpellation des autorités', texte: "Interpeller les autorités et les décideurs pour des politiques publiques justes et efficaces : dialogue citoyen, suivi des engagements, transparence, redevabilité et gouvernance participative." },
    { titre: 'Valorisation des talents et paysages du développement', texte: "Promouvoir nos talents locaux, les arts, la culture et la créativité, le tourisme durable, la beauté de nos paysages, la fierté et l'identité locale." },
    { titre: "Promotion de l'épargne", texte: "Encourager la culture de l'épargne, éducation financière pour tous, comptes d'épargne accessibles, investir dans son avenir et sécuriser ses projets de vie." },
    { titre: "L'eau et l'électricité", centre: true, texte: "Accès à l'eau potable pour tous, forages et adduction d'eau, accès à l'électricité, énergies renouvelables (solaire, hydro, éolien), entretien et modernisation des infrastructures." },
    { titre: 'Coopération internationale', texte: "Travailler avec nos partenaires internationaux : partage d'expertise et de ressources, échanges de bonnes pratiques, financements et dons, projets communs pour un développement durable." },
    { titre: 'Santé et éducation', texte: "Investir dans la santé pour tous, construire des écoles et des centres de formation, accès aux soins de qualité, éducation de qualité, prévention et bien-être." },
  ],

  siege: "Avenue Mobutu, Mbandaka, province de l'Équateur, RD Congo",
  whatsapp: '243850171480',            // numéro WhatsApp sans le +
  telephoneAffiche: '+243 850 171 480 / +243 823 239 572',
  email: 'lesvolontaires13@gmail.com',
  facebook: '',                         // lien de la page Facebook (laisser vide pour masquer)

  // Dons manuels (affichés si le paiement en ligne n'est pas disponible).
  // Remplissez les numéros Mobile Money AU NOM DE L'ONGD ; une ligne vide est masquée.
  mobileMoney: [
    { operateur: 'M-Pesa', numero: '0823239572' },
    { operateur: 'Orange Money', numero: '0850171480' },
    { operateur: 'Airtel Money', numero: '' },          // bientôt disponible
  ],
  // Virement bancaire : un compte par devise (le donateur voit celui de la devise choisie)
  banque: {
    banque: 'RAWBANK', titulaire: 'LES VOLONTAIRES', agence: '05180', swift: 'RAWBCDKI',
    comptes: {
      USD: '05180-10072955101-72',   // ⚠️ à vérifier chiffre par chiffre avec la carte de la banque
      CDF: '05180-10272955101-71',   // ⚠️ à vérifier chiffre par chiffre avec la carte de la banque
    },
  },

  // Projets que le donateur peut choisir (laisser vide [] pour masquer le choix)
  projets: [],

  plaquette: 'plaquette-partenariat.pdf',

  // Langues proposées dans le sélecteur (traduction automatique par l'IA)
  langues: [
    ['fr', 'Français'], ['en', 'English'], ['ln', 'Lingála'], ['sw', 'Kiswahili'], ['kg', 'Kikongo'],
    ['lua', 'Tshiluba'], ['pt', 'Português'], ['es', 'Español'], ['ar', 'العربية'],
  ],
};

/* ===================== Outils communs (ne pas modifier) ===================== */
window.outils = {
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  async api(chemin, opts = {}, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    let r;
    try { r = await fetch(ONGD.api + chemin, { ...opts, headers }); }
    catch { throw new Error('Pas de connexion internet. Réessayez.'); }
    let d = {};
    try { d = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(d.erreur || 'Une erreur est survenue. Réessayez.'); e.status = r.status; throw e; }
    return d;
  },
  photo(id, token) { return ONGD.api + '/photos/' + id + (token ? '?t=' + token : ''); },
  date(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso);
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  },
  montant(n, devise) {
    return devise === 'USD' ? Number(n).toLocaleString('fr-FR') + ' $' : Number(n).toLocaleString('fr-FR') + ' FC';
  },
  lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } },
  ecrire(cle, v) { try { v == null ? localStorage.removeItem(cle) : localStorage.setItem(cle, v); } catch {} },
  // Réduit une photo (max 1280 px, JPEG) avant l'envoi pour économiser les données mobiles
  reduire(fichier) {
    return new Promise((ok, ko) => {
      const img = new Image(), url = URL.createObjectURL(fichier);
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('Cette image ne peut pas être lue.')); };
      img.src = url;
    });
  },
  // Ligne « virement bancaire » pour la devise du paiement ('' si aucun compte)
  virement(devise) {
    const b = ONGD.banque || {}, c = b.comptes || {}, n = c[devise] || '';
    if (!n) return '';
    return `<li><strong>Virement ${devise === 'USD' ? 'en dollars' : 'en francs congolais'}</strong> : ${outils.esc(b.banque)}, compte <span data-no-tr>${outils.esc(n)}</span>, titulaire ${outils.esc(b.titulaire)}${b.swift ? ', SWIFT <span data-no-tr>' + outils.esc(b.swift) + '</span>' : ''}</li>`;
  },
  // Affiche un message sous un formulaire
  message(el, texte, type = 'ok') { el.className = 'alerte ' + type; el.textContent = texte; el.hidden = false; },
};
