/**
 * Moteur de rémunération — Eaji
 * -----------------------------------------------------------------
 * Remplace l'ancien barème par zone/type de contenu.
 *
 * Éligibilité : au moins 1000 abonnés vérifiés ET au moins 1000 vues
 * cumulées sur les publications.
 *
 * Montant : proportionnel au nombre d'abonnés, à raison de 2 $ / 2 €
 * / 5 000 FC pour chaque palier de 1000 abonnés (croissance continue,
 * pas par palier fixe) — plus les abonnés (et donc les vues) augmentent,
 * plus le montant augmente.
 *
 * Exemples validés :
 *   1 000 abonnés  → 2 $ / 2 € / 5 000 FC
 *   2 000 abonnés  → 4 $ / 4 € / 10 000 FC
 *  10 000 abonnés  → 20 $ / 20 € / 50 000 FC
 */

const SUBSCRIBER_THRESHOLD = 1000;
const VIEW_THRESHOLD = 1000;
const UNIT_SIZE = 1000; // taille du palier de référence

// Montant versé par tranche de 1000 abonnés, selon la devise.
const RATE_PER_UNIT = {
  USD: 2,
  EUR: 2,
  CDF: 5000,
};

const VALID_CURRENCIES = Object.keys(RATE_PER_UNIT);

/**
 * Détermine si un créateur est éligible à la rémunération.
 * @param {number} subscribers - nombre d'abonnés vérifiés
 * @param {number} views - nombre de vues cumulées sur les publications
 * @returns {{ eligible: boolean, missingSubscribers: number, missingViews: number }}
 */
function calculateEligibility(subscribers, views) {
  const missingSubscribers = Math.max(0, SUBSCRIBER_THRESHOLD - subscribers);
  const missingViews = Math.max(0, VIEW_THRESHOLD - views);
  return {
    eligible: missingSubscribers === 0 && missingViews === 0,
    missingSubscribers,
    missingViews,
  };
}

/**
 * Calcule la rémunération d'un créateur.
 * @param {Object} params
 * @param {number} params.subscribers - nombre d'abonnés vérifiés
 * @param {number} params.views - nombre de vues cumulées sur les publications
 * @param {string} params.currency - 'USD' | 'EUR' | 'CDF'
 * @returns {Object} détail du calcul
 */
function calculateMonthlyPayout({ subscribers, views, currency }) {
  const cur = (currency || '').toUpperCase();
  if (!VALID_CURRENCIES.includes(cur)) {
    throw new Error(`Devise inconnue : "${currency}". Devises valides : ${VALID_CURRENCIES.join(', ')}`);
  }

  const { eligible, missingSubscribers, missingViews } = calculateEligibility(subscribers, views);

  if (!eligible) {
    return {
      eligible: false,
      missingSubscribers,
      missingViews,
      amount: 0,
      currency: cur,
    };
  }

  const rate = RATE_PER_UNIT[cur];
  const amount = Math.round((subscribers / UNIT_SIZE) * rate * 100) / 100;

  return {
    eligible: true,
    missingSubscribers: 0,
    missingViews: 0,
    amount,
    currency: cur,
    subscribers,
    views,
  };
}

module.exports = {
  SUBSCRIBER_THRESHOLD,
  VIEW_THRESHOLD,
  RATE_PER_UNIT,
  calculateEligibility,
  calculateMonthlyPayout,
};

// ---- Exemple d'utilisation (exécuter avec `node rate-engine.js`) ----
if (require.main === module) {
  console.log(calculateEligibility(742, 900));
  // → { eligible: false, missingSubscribers: 258, missingViews: 100 }

  console.log(calculateMonthlyPayout({ subscribers: 1000, views: 1000, currency: 'USD' }));
  // → { eligible: true, amount: 2, currency: 'USD', ... }

  console.log(calculateMonthlyPayout({ subscribers: 2000, views: 2000, currency: 'EUR' }));
  // → { eligible: true, amount: 4, currency: 'EUR', ... }

  console.log(calculateMonthlyPayout({ subscribers: 10000, views: 10000, currency: 'CDF' }));
  // → { eligible: true, amount: 50000, currency: 'CDF', ... }
}
