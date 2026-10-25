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
  HK: ['HKD'], MO: ['MOP'],
  // Amérique
  US: ['USD'], CA: ['CAD'], MX: ['MXN'], GT: ['GTQ'], BZ: ['BZD'], HN: ['HNL'], SV: ['USD'], NI: ['NIO'], CR: ['CRC'],
  PA: ['USD', 'PAB'], CO: ['COP'], VE: ['VES', 'USD'], EC: ['USD'], PE: ['PEN'], BO: ['BOB'], BR: ['BRL'], PY: ['PYG'],
  UY: ['UYU'], AR: ['ARS'], CL: ['CLP'], GY: ['GYD'], SR: ['SRD'], PR: ['USD'],
  // Europe
  FR: ['EUR'], BE: ['EUR'], NL: ['EUR'], LU: ['EUR'], GB: ['GBP'], IE: ['EUR'], ES: ['EUR'], PT: ['EUR'], IT: ['EUR'],
  MT: ['EUR'], GR: ['EUR'], CY: ['EUR'], DK: ['DKK'], SE: ['SEK'], NO: ['NOK'], FI: ['EUR'], IS: ['ISK'], EE: ['EUR'],
  LV: ['EUR'], LT: ['EUR'], RO: ['RON'], BG: ['EUR'], HR: ['EUR'], RS: ['RSD'], BA: ['BAM'], ME: ['EUR'], MK: ['MKD'],
  AL: ['ALL'], XK: ['EUR'], MD: ['MDL'], UA: ['UAH'], BY: ['BYN'], RU: ['RUB'], MC: ['EUR'], AD: ['EUR'], SM: ['EUR'],
  VA: ['EUR'],
  // Océanie
  AU: ['AUD'], NZ: ['NZD'], PG: ['PGK'], FJ: ['FJD'], SB: ['SBD'], VU: ['VUV'], WS: ['WST'], TO: ['TOP'], KI: ['AUD'],
  TV: ['AUD'], NR: ['AUD'], PW: ['USD'], FM: ['USD'], MH: ['USD'],
};

// Devises internationales proposées à tout le monde.
const INTERNATIONAL = ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'CNY', 'JPY', 'AED'];

// Grandes devises de chaque continent (proposées en plus de celles du pays).
const REGIONAL = {
  afrique: ['XOF', 'XAF', 'ZAR', 'NGN', 'KES', 'EGP', 'MAD', 'GHS'],
  caraibes: ['XCD', 'JMD', 'DOP', 'HTG', 'TTD', 'BSD'],
  amerique: ['USD', 'CAD', 'MXN', 'BRL', 'ARS', 'COP', 'PEN', 'CLP'],
  asie: ['CNY', 'INR', 'JPY', 'AED', 'SAR', 'IDR', 'PHP', 'TRY'],
  europe: ['EUR', 'GBP', 'CHF', 'PLN', 'UAH', 'RUB', 'SEK', 'RON'],
  oceanie: ['AUD', 'NZD', 'FJD', 'PGK'],
};

// Toutes les devises connues d'Eaji (même si le taux du jour n'est pas encore arrivé).
const KNOWN = new Set([...Object.values(COUNTRY_CURRENCIES).flat(), ...INTERNATIONAL, ...Object.values(REGIONAL).flat()]);
function isKnownCurrency(code) { return KNOWN.has(String(code || '').toUpperCase()); }

// Taux de secours (approximatifs, 1 $ = …) : utilisés seulement si les deux sources du jour ne répondent pas,
// pour que TOUTES les devises restent proposées. Remplacés automatiquement dès qu'un vrai taux arrive.
const FALLBACK_RATES = {
  AED: 3.67, AFN: 70, ALL: 84, AMD: 387, AOA: 915, ARS: 1350, AUD: 1.53, AZN: 1.7, BAM: 1.68, BBD: 2, BDT: 122, BHD: 0.376,
  BIF: 2970, BND: 1.29, BOB: 6.91, BRL: 5.5, BSD: 1, BTN: 87, BWP: 13.6, BYN: 3.3, BZD: 2, CAD: 1.38, CDF: 2850, CHF: 0.8,
  CLP: 950, CNY: 7.15, COP: 4000, CRC: 505, CUP: 24, CVE: 94.5, CZK: 21.3, DJF: 178, DKK: 6.4, DOP: 62, DZD: 130, EGP: 48.5,
  ERN: 15, ETB: 140, EUR: 0.86, FJD: 2.26, GBP: 0.75, GEL: 2.7, GHS: 12, GMD: 72, GNF: 8680, GTQ: 7.67, GYD: 209, HKD: 7.8,
  HNL: 26.2, HTG: 131, HUF: 340, IDR: 16300, ILS: 3.4, INR: 87, IQD: 1310, ISK: 123, JMD: 160, JOD: 0.709, JPY: 147, KES: 129,
  KGS: 87.4, KHR: 4010, KMF: 423, KRW: 1390, KWD: 0.305, KZT: 540, LAK: 21600, LBP: 89500, LKR: 301, LRD: 200, LSL: 17.7,
  LYD: 5.4, MAD: 9, MDL: 16.9, MGA: 4450, MKD: 52.9, MMK: 2100, MNT: 3590, MOP: 8.05, MRU: 39.9, MUR: 45.5, MVR: 15.4,
  MWK: 1735, MXN: 18.7, MYR: 4.22, MZN: 63.9, NAD: 17.7, NGN: 1530, NIO: 36.8, NOK: 10.1, NPR: 139, NZD: 1.68, OMR: 0.385,
  PAB: 1, PEN: 3.55, PGK: 4.14, PHP: 57, PKR: 283, PLN: 3.65, PYG: 7300, QAR: 3.64, RON: 4.37, RSD: 100, RUB: 80, RWF: 1445,
  SAR: 3.75, SBD: 8.2, SCR: 14.5, SDG: 600, SEK: 9.6, SGD: 1.29, SLE: 23, SOS: 571, SRD: 38, SSP: 4600, STN: 21.1, SYP: 13000,
  SZL: 17.7, THB: 32.5, TJS: 9.4, TMT: 3.5, TND: 2.92, TOP: 2.38, TRY: 41, TTD: 6.78, TWD: 30, TZS: 2500, UAH: 41.5, UGX: 3580,
  UYU: 40, UZS: 12500, VES: 150, VND: 26200, VUV: 120, WST: 2.75, XAF: 565, XCD: 2.7, XOF: 565, YER: 240, ZAR: 17.7, ZMW: 23.5,
  ZWL: 26.8,
};
const BACKUP_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';

let rates = { ...FALLBACK_RATES, USD: 1 };
let ratesUpdatedAt = null;
let ratesApproximate = true; // vrai tant qu'aucun taux du jour n'est arrivé

async function fetchMainRates() {
  const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  if (data.result !== 'success' || !data.rates) throw new Error('réponse inattendue');
  return { list: data.rates, at: data.time_last_update_utc || new Date().toUTCString() };
}
async function fetchBackupRates() {
  const res = await fetch(BACKUP_URL, { signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  if (!data || !data.usd) throw new Error('réponse inattendue');
  const list = {};
  for (const [k, v] of Object.entries(data.usd)) if (/^[a-z]{3}$/.test(k) && Number(v) > 0) list[k.toUpperCase()] = Number(v);
  return { list, at: data.date || new Date().toUTCString() };
}

let retryTimer = null;
async function refreshRates() {
  for (const [name, get] of [['principale', fetchMainRates], ['de secours', fetchBackupRates]]) {
    try {
      const { list, at } = await get();
      // Les devises absentes de la source gardent leur dernier taux connu (jamais de trou dans la liste).
      rates = { ...rates, ...list, USD: 1 };
      ratesUpdatedAt = at;
      ratesApproximate = false;
      console.log(`[Eaji] Taux de change mis à jour par la source ${name} (${Object.keys(list).length} devises).`);
      return;
    } catch (e) {
      console.warn(`[Eaji] Source de taux ${name} indisponible (${e.message}).`);
    }
  }
  console.warn('[Eaji] Taux du jour indisponibles : taux approximatifs utilisés en attendant (nouvel essai dans 30 minutes).');
  if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; refreshRates(); }, 30 * 60 * 1000);
  if (retryTimer.unref) retryTimer.unref();
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
function payoutInCurrency({ subscribers, views, monthlyViews, currency }) {
  const c = String(currency || 'USD').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(RATE_PER_UNIT, c)) return calculateMonthlyPayout({ subscribers, views, monthlyViews, currency: c });
  const usd = calculateMonthlyPayout({ subscribers, views, monthlyViews, currency: 'USD' });
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
// Liste complète envoyée au site : devises du pays, du continent et internationales.
// « rated » indique celles dont le taux du jour est connu (les autres s'affichent en dollars en attendant).
function currencyCatalog() {
  return {
    byCountry: COUNTRY_CURRENCIES,
    regional: REGIONAL,
    international: INTERNATIONAL,
    rated: [...KNOWN].filter(isSupportedCurrency),
    // Toutes les devises du monde dont le taux du jour est connu (environ 160), pour le choix « autre devise ».
    all: [...new Set([...KNOWN, ...Object.keys(rates)])].filter((c) => /^[A-Z]{3}$/.test(c) && isSupportedCurrency(c)).sort(),
    ratesUpdatedAt,
    approximate: ratesApproximate,
    attribution: { text: 'Rates By Exchange Rate API', url: 'https://www.exchangerate-api.com' },
  };
}

module.exports = {
  isSupportedCurrency, isKnownCurrency, convertFromUSD, payoutInCurrency, openingCommissionInCurrency, currencyCatalog, refreshRates,
};
