// Eaji — devises locales et internationales, avec conversion au taux du jour.
//
// La règle de rémunération ne change pas : 2 $ (ou 2 €, ou 5 000 FC) par tranche de 1 000 abonnés,
// calculée par rate-engine.js. Pour toute autre devise, on calcule le montant en dollars puis
// on le convertit au taux de change du jour.
//
// Taux : ExchangeRate-API (accès libre, sans clé, mis à jour une fois par jour).
// Mention obligatoire affichée dans l'application : « Rates By Exchange Rate API ».

const { calculateMonthlyPayout, RATE_PER_UNIT } = require('./rate-engine');
const { calculateOpeningCommission } = require('./admin-commission-engine');

const RATES_URL = process.env.EXCHANGE_RATES_URL || 'https://open.er-api.com/v6/latest/USD';

// Devises utilisées dans chaque pays (la devise locale d'abord, puis celles très utilisées sur place).
const COUNTRY_CURRENCIES = {
  // Afrique
  DZ: ['DZD'], AO: ['AOA'], BJ: ['XOF'], BW: ['BWP'], BF: ['XOF'], BI: ['BIF'], CV: ['CVE'], CM: ['XAF'], CF: ['XAF'],
  TD: ['XAF'], KM: ['KMF'], CG: ['XAF'], CD: ['CDF', 'USD'], CI: ['XOF'], DJ: ['DJF'], EG: ['EGP'], GQ: ['XAF'],
  ER: ['ERN'], SZ: ['SZL', 'ZAR'], ET: ['ETB'], GA: ['XAF'], GM: ['GMD'], GH: ['GHS'], GN: ['GNF'], GW: ['XOF'],
  KE: ['KES'], LS: ['LSL', 'ZAR'], LR: ['LRD', 'USD'], LY: ['LYD'], MG: ['MGA'], MW: ['MWK'], ML: ['XOF'], MR: ['MRU'],
  MU: ['MUR'], MA: ['MAD'], MZ: ['MZN'], NA: ['NAD', 'ZAR'], NE: ['XOF'], NG: ['NGN'], RW: ['RWF'], ST: ['STN'],
  SN: ['XOF'], SC: ['SCR'], SL: ['SLE'], SO: ['SOS', 'USD'], ZA: ['ZAR'], SS: ['SSP', 'USD'], SD: ['SDG'], TZ: ['TZS'],
  TG: ['XOF'], TN: ['TND'], UG: ['UGX'], ZM: ['ZMW'], ZW: ['USD', 'ZWL'],
  // Caraïbes
  AG: ['XCD'], BS: ['BSD'], BB: ['BBD'], CU: ['CUP'], DM: ['XCD'], DO: ['DOP'], GD: ['XCD'], HT: ['HTG', 'USD'],
  JM: ['JMD'], KN: ['XCD'], LC: ['XCD'], VC: ['XCD'], TT: ['TTD'],
  // Asie
  AF: ['AFN'], SA: ['SAR'], AM: ['AMD'], AZ: ['AZN'], BH: ['BHD'], BD: ['BDT'], BT: ['BTN', 'INR'], MM: ['MMK'],
  BN: ['BND'], KH: ['KHR', 'USD'], CN: ['CNY'], KR: ['KRW'], AE: ['AED'], GE: ['GEL'], IN: ['INR'], ID: ['IDR'],
  IQ: ['IQD'], IR: ['USD'], IL: ['ILS'], JP: ['JPY'], JO: ['JOD'], KZ: ['KZT'], KG: ['KGS'], KW: ['KWD'], LA: ['LAK'],
  LB: ['LBP', 'USD'], MY: ['MYR'], MV: ['MVR'], MN: ['MNT'], NP: ['NPR'], OM: ['OMR'], UZ: ['UZS'], PK: ['PKR'],
  PS: ['ILS', 'JOD'], PH: ['PHP'], QA: ['QAR'], SG: ['SGD'], LK: ['LKR'], SY: ['SYP'], TJ: ['TJS'], TW: ['TWD'],
  TH: ['THB'], TL: ['USD'], TM: ['TMT'], TR: ['TRY'], VN: ['VND'], YE: ['YER'],
  // Europe centrale
  DE: ['EUR'], AT: ['EUR'], HU: ['HUF'], LI: ['CHF'], PL: ['PLN'], SK: ['EUR'], SI: ['EUR'], CH: ['CHF'], CZ: ['CZK'],
};

// Devises internationales proposées à tout le monde.
const INTERNATIONAL = ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'CNY', 'JPY', 'AED', 'ZAR', 'XOF', 'XAF'];

let rates = { USD: 1 };
let ratesUpdatedAt = null;

async function refreshRates() {
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.result !== 'success' || !data.rates) throw new Error('réponse inattendue');
    rates = { ...data.rates, USD: 1 };
    ratesUpdatedAt = data.time_last_update_utc || new Date().toUTCString();
    console.log(`[Eaji] Taux de change mis à jour (${Object.keys(rates).length} devises).`);
  } catch (e) {
    console.warn('[Eaji] Taux de change indisponibles pour le moment (' + e.message + ') : seules USD, EUR et CDF sont proposées.');
  }
}
refreshRates();
setInterval(refreshRates, 12 * 60 * 60 * 1000).unref(); // deux fois par jour

// Une devise est utilisable si la règle la fixe directement (USD, EUR, CDF) ou si on connaît son taux.
function isSupportedCurrency(code) {
  const c = String(code || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(RATE_PER_UNIT, c) || Boolean(rates[c]);
}

function decimalsOf(code) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits; }
  catch (e) { return 2; }
}

// Convertit un montant en dollars dans une autre devise, au taux du jour.
function convertFromUSD(amountUsd, code) {
  const c = String(code || 'USD').toUpperCase();
  if (c === 'USD') return amountUsd;
  const rate = rates[c];
  if (!rate) throw new Error(`Taux de change indisponible pour ${c}.`);
  const factor = 10 ** decimalsOf(c);
  return Math.round(amountUsd * rate * factor) / factor;
}

// Rémunération : règle d'origine pour USD/EUR/CDF, conversion du montant en dollars pour les autres.
function payoutInCurrency({ subscribers, views, currency }) {
  const c = String(currency || 'USD').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(RATE_PER_UNIT, c)) return calculateMonthlyPayout({ subscribers, views, currency: c });
  const usd = calculateMonthlyPayout({ subscribers, views, currency: 'USD' });
  return { ...usd, amount: convertFromUSD(usd.amount, c), currency: c, convertedFromUSD: usd.amount, rateUpdatedAt: ratesUpdatedAt };
}

// Commission d'ouverture : 2 $ / 2 € / 5 000 FC, ou l'équivalent de 2 $ dans les autres devises.
function openingCommissionInCurrency(currency) {
  const c = String(currency || 'USD').toUpperCase();
  try { return calculateOpeningCommission(c); }
  catch (e) {
    if (!rates[c]) return calculateOpeningCommission('USD');
    return { amount: convertFromUSD(calculateOpeningCommission('USD').amount, c), currency: c, type: 'ouverture' };
  }
}

// Liste envoyée au site : uniquement les devises réellement utilisables.
function currencyCatalog() {
  const byCountry = {};
  for (const [country, list] of Object.entries(COUNTRY_CURRENCIES)) {
    const usable = list.filter(isSupportedCurrency);
    byCountry[country] = usable.length ? usable : ['USD'];
  }
  return {
    byCountry,
    international: INTERNATIONAL.filter(isSupportedCurrency),
    ratesUpdatedAt,
    attribution: { text: 'Rates By Exchange Rate API', url: 'https://www.exchangerate-api.com' },
  };
}

module.exports = {
  isSupportedCurrency, convertFromUSD, payoutInCurrency, openingCommissionInCurrency, currencyCatalog, refreshRates,
};
