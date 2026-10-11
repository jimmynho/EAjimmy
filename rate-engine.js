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
 *
 * Grands comptes (comme YouTube / TikTok, le taux baisse par paliers) :
 *   jusqu'à 100 000 abonnés        → 2 $ pour 1 000
 *   de 100 000 à 1 million         → 1 $ pour 1 000
 *   au-delà de 1 million           → 0,50 $ pour 1 000
 *   (100 000 → 200 $ ; 1 million → 1 100 $ ; 10 millions → 5 600 $)
 *
 * Contre les abonnés « dormants » ou faux : les vues du mois doivent atteindre 70 % des abonnés.
 * Sinon, seuls (vues du mois ÷ 0,7) abonnés sont payés : 1 million d'abonnés et 350 000 vues
 * → payé comme 500 000 abonnés. Au-delà de 70 %, aucune réduction.
 * Le total versé chaque mois reste ensuite limité par le budget d'Eaji (voir extras-routes.js).
 */

const SUBSCRIBER_THRESHOLD = 1000;
const VIEW_THRESHOLD = 1000;
const UNIT_SIZE = 1000; // taille du palier de référence
// Paliers dégressifs : part du taux de base appliquée à chaque tranche d'abonnés.
const TIERS = [
  { upTo: 100000, factor: 1 },      // 2 $ / 1 000
  { upTo: 1000000, factor: 0.5 },   // 1 $ / 1 000
  { upTo: Infinity, factor: 0.25 }, // 0,50 $ / 1 000
];
const MONTHLY_VIEWS_RATIO = 0.7; // vues du mois exigées : 70 % des abonnés

// « Milliers d'abonnés pondérés » selon les paliers.
function weightedThousands(subscribers) {
  let weighted = 0, prev = 0;
  for (const t of TIERS) {
    const n = Math.min(subscribers, t.upTo) - prev;
    if (n <= 0) break;
    weighted += n * t.factor;
    prev = t.upTo;
  }
  return weighted / UNIT_SIZE;
}

// Abonnés réellement payés selon les vues du mois (règle des 70 %).
function paidSubscribersFor(subscribers, monthlyViews) {
  if (monthlyViews === undefined || monthlyViews === null) return subscribers;
  const required = Math.ceil(subscribers * MONTHLY_VIEWS_RATIO);
  if (monthlyViews >= required) return subscribers;
  return Math.floor(Math.max(0, monthlyViews) / MONTHLY_VIEWS_RATIO);
}

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
function calculateMonthlyPayout({ subscribers, views, monthlyViews, currency }) {
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
  const paidSubscribers = paidSubscribersFor(subscribers, monthlyViews);
  const amount = Math.round(weightedThousands(paidSubscribers) * rate * 100) / 100;

  return {
    eligible: true,
    missingSubscribers: 0,
    missingViews: 0,
    amount,
    currency: cur,
    subscribers,
    views,
    paidSubscribers,
    ...(monthlyViews !== undefined && monthlyViews !== null ? {
      monthlyViews,
      requiredMonthlyViews: Math.ceil(subscribers * MONTHLY_VIEWS_RATIO),
      viewsRuleMet: paidSubscribers === subscribers,
    } : {}),
  };
}

module.exports = {
  SUBSCRIBER_THRESHOLD,
  VIEW_THRESHOLD,
  RATE_PER_UNIT,
  TIERS,
  MONTHLY_VIEWS_RATIO,
  weightedThousands,
  paidSubscribersFor,
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
