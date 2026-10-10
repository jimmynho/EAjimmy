// Eaji — toutes les règles d'argent au même endroit (prix, parts, frais).
// Pour changer un prix ou un pourcentage, il suffit de modifier ce fichier.
// Tous les prix sont en dollars US ; ils sont convertis dans la devise de l'utilisateur au taux du jour.

// Part d'Eaji sur l'argent qui passe par l'application vers un créateur
// (cadeaux, vidéos payantes, ventes de contenus) : 40 % Eaji, 60 % créateur.
const EAJI_SHARE = 0.40;
const CREATOR_SHARE = 0.60;

// Frais sur les retraits des gains des créateurs.
const EARNINGS_WITHDRAWAL_FEE = 0.15;

// Portefeuille (transfert d'argent) : 2 % au dépôt, 4 % au retrait, envoi entre comptes gratuit.
const WALLET_DEPOSIT_FEE = 0.02;
const WALLET_WITHDRAWAL_FEE = 0.04;

// Abonnement premium.
const PREMIUM_PLANS = {
  premium_mois: { price: 10, days: 30, label: 'Premium 1 mois' },
  premium_annee: { price: 100, days: 365, label: 'Premium 1 an' },
};

// Compte Entreprise : tout le premium + badge « Entreprise », statistiques détaillées,
// et un message groupé par jour à tous ses abonnés.
const BUSINESS_PLANS = {
  entreprise_mois: { price: 20, days: 30, label: 'Compte Entreprise 1 mois' },
  entreprise_annee: { price: 200, days: 365, label: 'Compte Entreprise 1 an' },
};
const BROADCAST_EVERY_HOURS = 24;

// Vidéos : gratuites jusqu'à 2 minutes, puis payantes selon la durée (prix pour la regarder).
const VIDEO_TYPES = ['video_courte', 'video_longue', 'film', 'live'];
const FREE_VIDEO_SECONDS = 2 * 60;
const MAX_VIDEO_SECONDS = 60 * 60;
const VIDEO_PRICE_STEPS = [
  { upTo: 10 * 60, price: 1 },
  { upTo: 20 * 60, price: 5 },
  { upTo: 60 * 60, price: 10 },
];

// Publicité des entreprises (bannière ou vidéo dans le fil d'un pays).
const BUSINESS_AD_PLANS = {
  semaine: { price: 10, days: 7, label: '7 jours' },
  mois: { price: 30, days: 30, label: '30 jours' },
  trimestre: { price: 75, days: 90, label: '90 jours' },
};

// Montants proposés pour les cadeaux et les dons (en dollars).
const GIFT_AMOUNTS = [1, 2, 5, 10, 20, 50];
const DONATION_MIN = 1;
const SALE_PRICE_MIN = 0.5;
const SALE_PRICE_MAX = 500;
const WITHDRAWAL_MIN = 1;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Prix (en $) pour regarder une vidéo, ou 0 si elle est gratuite.
function videoPriceForDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s <= FREE_VIDEO_SECONDS) return 0;
  for (const step of VIDEO_PRICE_STEPS) if (s <= step.upTo) return step.price;
  return VIDEO_PRICE_STEPS[VIDEO_PRICE_STEPS.length - 1].price;
}

// Prix d'accès à un contenu : prix de vente fixé par le créateur, sinon prix selon la durée (vidéos).
function accessPriceFor(content) {
  if (content.sale_price != null && Number(content.sale_price) > 0) return round2(content.sale_price);
  if (VIDEO_TYPES.includes(content.content_type)) return videoPriceForDuration(content.duration_seconds);
  return 0;
}

// Partage 40 / 60 d'un montant payé pour un créateur.
function splitForCreator(amountUsd) {
  const eaji = round2(amountUsd * EAJI_SHARE);
  return { eaji, creator: round2(amountUsd - eaji) };
}

function withdrawalFee(amountUsd, source) {
  const rate = source === 'portefeuille' ? WALLET_WITHDRAWAL_FEE : EARNINGS_WITHDRAWAL_FEE;
  const fee = round2(amountUsd * rate);
  return { fee, net: round2(amountUsd - fee), rate };
}

function depositFee(amountUsd) {
  const fee = round2(amountUsd * WALLET_DEPOSIT_FEE);
  return { fee, credited: round2(amountUsd - fee) };
}

function pricingSummary() {
  return {
    eajiShare: EAJI_SHARE, creatorShare: CREATOR_SHARE,
    earningsWithdrawalFee: EARNINGS_WITHDRAWAL_FEE,
    walletDepositFee: WALLET_DEPOSIT_FEE, walletWithdrawalFee: WALLET_WITHDRAWAL_FEE,
    premiumPlans: PREMIUM_PLANS, businessPlans: BUSINESS_PLANS, broadcastEveryHours: BROADCAST_EVERY_HOURS,
    freeVideoSeconds: FREE_VIDEO_SECONDS, maxVideoSeconds: MAX_VIDEO_SECONDS, videoPriceSteps: VIDEO_PRICE_STEPS,
    businessAdPlans: BUSINESS_AD_PLANS,
    giftAmounts: GIFT_AMOUNTS, donationMin: DONATION_MIN,
    salePriceMin: SALE_PRICE_MIN, salePriceMax: SALE_PRICE_MAX, withdrawalMin: WITHDRAWAL_MIN,
  };
}

module.exports = {
  EAJI_SHARE, CREATOR_SHARE, PREMIUM_PLANS, BUSINESS_PLANS, BROADCAST_EVERY_HOURS, VIDEO_TYPES, FREE_VIDEO_SECONDS, MAX_VIDEO_SECONDS,
  BUSINESS_AD_PLANS, GIFT_AMOUNTS, DONATION_MIN, SALE_PRICE_MIN, SALE_PRICE_MAX, WITHDRAWAL_MIN,
  videoPriceForDuration, accessPriceFor, splitForCreator, withdrawalFee, depositFee, pricingSummary, round2,
};
