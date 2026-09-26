/**
 * Moteur de commissions administrateurs — Eaji
 * -----------------------------------------------------------------
 * Deux types de commission :
 *   1. Ouverture de compte créateur : montant fixe selon la devise.
 *   2. Retrait de gains par un créateur : 1% du montant retiré.
 */

const OPENING_COMMISSION = {
  USD: 10,
  EUR: 10,
  CDF: 25000,
};

const WITHDRAWAL_COMMISSION_RATE = 0.01; // 1%

/**
 * Calcule la commission due à l'administrateur pour l'ouverture
 * d'un compte créateur.
 * @param {string} currency - 'USD' | 'EUR' | 'CDF'
 * @returns {{ amount: number, currency: string, type: 'ouverture' }}
 */
function calculateOpeningCommission(currency) {
  const cur = (currency || '').toUpperCase();
  if (!(cur in OPENING_COMMISSION)) {
    throw new Error(`Devise non supportée pour la commission d'ouverture : "${currency}". Devises valides : ${Object.keys(OPENING_COMMISSION).join(', ')}`);
  }
  return { amount: OPENING_COMMISSION[cur], currency: cur, type: 'ouverture' };
}

/**
 * Calcule la commission due à l'administrateur sur un retrait de
 * gains effectué par un créateur.
 * @param {number} withdrawalAmount - montant retiré par le créateur
 * @param {string} currency - devise du retrait
 * @returns {{ amount: number, currency: string, type: 'retrait', netToCreator: number }}
 */
function calculateWithdrawalCommission(withdrawalAmount, currency) {
  if (typeof withdrawalAmount !== 'number' || withdrawalAmount <= 0) {
    throw new Error('Le montant du retrait doit être un nombre positif.');
  }
  const amount = Math.round(withdrawalAmount * WITHDRAWAL_COMMISSION_RATE * 100) / 100;
  const netToCreator = Math.round((withdrawalAmount - amount) * 100) / 100;

  return { amount, currency: (currency || '').toUpperCase(), type: 'retrait', netToCreator };
}

/**
 * Construit l'enregistrement prêt à insérer dans `admin_commissions`.
 * @param {Object} params
 * @param {string} params.adminId
 * @param {string} params.creatorAccountId
 * @param {Object} params.commission - résultat de calculateOpeningCommission ou calculateWithdrawalCommission
 * @returns {Object} enregistrement pour la table admin_commissions
 */
function buildCommissionRecord({ adminId, creatorAccountId, commission }) {
  return {
    admin_id: adminId,
    creator_account_id: creatorAccountId,
    type: commission.type, // 'ouverture' | 'retrait'
    amount: commission.amount,
    currency: commission.currency,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

module.exports = {
  OPENING_COMMISSION,
  WITHDRAWAL_COMMISSION_RATE,
  calculateOpeningCommission,
  calculateWithdrawalCommission,
  buildCommissionRecord,
};

// ---- Exemple d'utilisation ----
if (require.main === module) {
  console.log(calculateOpeningCommission('CDF'));
  // → { amount: 25000, currency: 'CDF', type: 'ouverture' }

  console.log(calculateWithdrawalCommission(142.50, 'USD'));
  // → { amount: 1.43, currency: 'USD', type: 'retrait', netToCreator: 141.07 }

  console.log(
    buildCommissionRecord({
      adminId: 'admin_jimmy',
      creatorAccountId: 'creator_0001',
      commission: calculateOpeningCommission('USD'),
    })
  );
}
