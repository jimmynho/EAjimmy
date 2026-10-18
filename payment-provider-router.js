/**
 * Routeur de paiement — Eaji
 * -----------------------------------------------------------------
 * Choisit automatiquement le bon rail de paiement selon le pays du
 * créateur : mobile money là où c'est le vrai levier d'inclusion
 * financière, virement bancaire / Stripe là où la population est
 * déjà largement bancarisée.
 *
 * Usage :
 *   const { resolvePaymentProvider } = require('./payment-provider-router');
 *   resolvePaymentProvider('CD') // → config RDC
 */

const PROVIDER = {
  STRIPE: 'stripe',
  MOBILE_MONEY: 'mobile_money',
  MANUAL_REVIEW: 'manual_review', // pays pas encore configuré
};

// Configuration explicite par pays (code ISO 3166-1 alpha-2).
// À enrichir pays par pays au fur et à mesure de l'expansion —
// ne jamais deviner un opérateur ou un agrégateur sans vérification.
const COUNTRY_CONFIG = {
  // --- Afrique ---
  CD: { // République démocratique du Congo
    zone: 'afrique',
    provider: PROVIDER.MOBILE_MONEY,
    aggregator: 'malipo', // alternative : klasha, maxicash
    operators: ['vodacom_mpesa', 'orange_money', 'airtel_money', 'africell_afrimoney'],
    currency: 'CDF',
    secondaryCurrency: 'USD',
    notes: 'Stripe non disponible pour les paiements en RDC. Flux push USSD/STK requis.',
  },
  NG: {
    zone: 'afrique',
    provider: PROVIDER.MOBILE_MONEY,
    aggregator: 'flutterwave', // alternative : paystack
    operators: ['bank_transfer', 'ussd', 'mobile_money'],
    currency: 'NGN',
    notes: 'Stripe supporte le Nigeria pour Stripe Tax, pas pour les payouts créateurs à ce jour.',
  },
  KE: {
    zone: 'afrique',
    provider: PROVIDER.MOBILE_MONEY,
    aggregator: 'flutterwave',
    operators: ['mpesa'],
    currency: 'KES',
    notes: 'M-Pesa domine largement le marché kényan.',
  },
  SN: {
    zone: 'afrique',
    provider: PROVIDER.STRIPE,
    currency: 'XOF',
    notes: 'Sénégal supporté par Stripe. Orange Money reste une alternative locale à évaluer.',
  },

  // --- Caraïbes ---
  HT: { // Haïti
    zone: 'caraibes',
    provider: PROVIDER.MOBILE_MONEY,
    aggregator: 'digicel_moncash',
    operators: ['moncash'],
    currency: 'HTG',
    notes: 'MonCash (Digicel) touche plus de 2M d\'utilisateurs, marché très peu bancarisé.',
  },
  JM: {
    zone: 'caraibes',
    provider: PROVIDER.STRIPE,
    currency: 'JMD',
    notes: 'Jamaïque : population largement bancarisée, virement classique suffit.',
  },
  DO: {
    zone: 'caraibes',
    provider: PROVIDER.STRIPE,
    currency: 'DOP',
    notes: 'République dominicaine : bancarisation correcte, virement/carte adaptés.',
  },

  // --- Asie ---
  PH: {
    zone: 'asie',
    provider: PROVIDER.MOBILE_MONEY,
    aggregator: 'xendit', // GCash accessible via agrégateurs régionaux
    operators: ['gcash'],
    currency: 'PHP',
    notes: 'GCash très largement utilisé aux Philippines.',
  },
  BD: {
    zone: 'asie',
    provider: PROVIDER.MOBILE_MONEY,
    aggregator: 'a_confirmer',
    operators: ['bkash'],
    currency: 'BDT',
    notes: 'bKash domine le marché bangladais du paiement mobile.',
  },
  IN: {
    zone: 'asie',
    provider: PROVIDER.STRIPE,
    aggregator: 'razorpay',
    currency: 'INR',
    notes: 'Inde : UPI (via Razorpay) largement adopté, même sans compte bancaire traditionnel.',
  },
  ID: {
    zone: 'asie',
    provider: PROVIDER.MOBILE_MONEY,
    aggregator: 'xendit',
    operators: ['e_wallet'],
    currency: 'IDR',
    notes: 'Indonésie : forte adoption des e-wallets locaux.',
  },

  // --- Europe centrale ---
  PL: { zone: 'europe_centrale', provider: PROVIDER.STRIPE, currency: 'PLN', notes: 'Population bancarisée, SEPA/carte suffisent.' },
  CZ: { zone: 'europe_centrale', provider: PROVIDER.STRIPE, currency: 'CZK', notes: 'Population bancarisée, SEPA/carte suffisent.' },
  HU: { zone: 'europe_centrale', provider: PROVIDER.STRIPE, currency: 'HUF', notes: 'Population bancarisée, SEPA/carte suffisent.' },
  SK: { zone: 'europe_centrale', provider: PROVIDER.STRIPE, currency: 'EUR', notes: 'Zone euro, SEPA natif.' },
};

/**
 * Renvoie la configuration de paiement pour un pays donné.
 * @param {string} countryCode - code ISO 3166-1 alpha-2 (ex: 'CD', 'HT')
 * @returns {Object} configuration de paiement, ou un statut "manual_review"
 *                    si le pays n'est pas encore configuré (jamais de choix
 *                    par défaut silencieux sur un pays non vérifié).
 */
function resolvePaymentProvider(countryCode) {
  const code = (countryCode || '').toUpperCase();
  const config = COUNTRY_CONFIG[code];

  if (!config) {
    return {
      provider: PROVIDER.MANUAL_REVIEW,
      notes: `Pays "${code}" non configuré. Vérifier la couverture Stripe et les opérateurs mobile money locaux avant d'activer les paiements.`,
    };
  }

  return config;
}

module.exports = {
  PROVIDER,
  COUNTRY_CONFIG,
  resolvePaymentProvider,
};

// ---- Exemple d'utilisation (exécuter avec `node payment-provider-router.js`) ----
if (require.main === module) {
  console.log(resolvePaymentProvider('CD')); // RDC → mobile money (Malipo)
  console.log(resolvePaymentProvider('HT')); // Haïti → mobile money (MonCash)
  console.log(resolvePaymentProvider('PL')); // Pologne → Stripe
  console.log(resolvePaymentProvider('ZZ')); // pays non configuré → revue manuelle
}
