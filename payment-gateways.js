// Eaji — paiements en ligne RÉELS.
//
//  • Mobile money avec pawaPay (M-Pesa, Orange Money, Airtel Money… dans 22 pays d'Afrique) :
//    l'acheteur reçoit une demande sur son téléphone et la valide avec SON code secret mobile money.
//  • Carte bancaire ou compte PayPal avec PayPal Checkout : l'acheteur paie sur la page sécurisée de PayPal
//    (mot de passe PayPal, ou carte avec la vérification de sa banque).
//
// Rien n'est jamais activé sur la parole de l'utilisateur : Eaji redemande toujours le résultat à
// pawaPay ou PayPal avant d'activer un achat.
//
// Réglages sur Railway (variables d'environnement) :
//   PAWAPAY_TOKEN        jeton d'API pawaPay (tableau de bord pawaPay → API Tokens)
//   PAWAPAY_ENV          « production » pour l'argent réel (sinon : bac à sable de test)
//   PAYPAL_CLIENT_ID     identifiant d'application PayPal (developer.paypal.com → Apps & Credentials)
//   PAYPAL_SECRET        secret de cette application
//   PAYPAL_ENV           « production » pour l'argent réel (sinon : bac à sable)
//   PUBLIC_SITE_URL      adresse du site, ex. https://jimmynho.github.io/Eaji-site
const crypto = require('crypto');

// Opérateurs pawaPay par pays (documentation pawaPay v2, « Providers »).
// decimals : false = montant entier obligatoire.
const PAWAPAY_PROVIDERS = {
  CD: [
    { code: 'VODACOM_MPESA_COD', name: 'Vodacom M-Pesa', currencies: { USD: true, CDF: false }, prefixes: ['81', '82', '83'] },
    { code: 'ORANGE_COD', name: 'Orange Money', currencies: { USD: true, CDF: true }, prefixes: ['80', '84', '85', '89'] },
    { code: 'AIRTEL_COD', name: 'Airtel Money', currencies: { USD: true, CDF: true }, prefixes: ['97', '98', '99', '90'] },
  ],
  BJ: [{ code: 'MTN_MOMO_BEN', name: 'MTN MoMo', currencies: { XOF: false } }, { code: 'MOOV_BEN', name: 'Moov Money', currencies: { XOF: false } }],
  BF: [{ code: 'MOOV_BFA', name: 'Moov Money', currencies: { XOF: false } }, { code: 'ORANGE_BFA', name: 'Orange Money', currencies: { XOF: false } }],
  CM: [{ code: 'MTN_MOMO_CMR', name: 'MTN MoMo', currencies: { XAF: false } }, { code: 'ORANGE_CMR', name: 'Orange Money', currencies: { XAF: false } }],
  CI: [{ code: 'MTN_MOMO_CIV', name: 'MTN MoMo', currencies: { XOF: false } }, { code: 'ORANGE_CIV', name: 'Orange Money', currencies: { XOF: false } }, { code: 'WAVE_CIV', name: 'Wave', currencies: { XOF: false } }],
  ET: [{ code: 'MPESA_ETH', name: 'Safaricom M-Pesa', currencies: { ETB: true } }],
  GA: [{ code: 'AIRTEL_GAB', name: 'Airtel Money', currencies: { XAF: true } }],
  GH: [{ code: 'MTN_MOMO_GHA', name: 'MTN MoMo', currencies: { GHS: true } }, { code: 'AIRTELTIGO_GHA', name: 'AirtelTigo', currencies: { GHS: true } }, { code: 'VODAFONE_GHA', name: 'Vodafone Cash', currencies: { GHS: true } }],
  KE: [{ code: 'MPESA_KEN', name: 'M-Pesa', currencies: { KES: false } }],
  LS: [{ code: 'MPESA_LSO', name: 'M-Pesa', currencies: { LSL: true } }],
  MW: [{ code: 'AIRTEL_MWI', name: 'Airtel Money', currencies: { MWK: true } }, { code: 'TNM_MWI', name: 'TNM Mpamba', currencies: { MWK: true } }],
  MZ: [{ code: 'VODACOM_MOZ', name: 'Vodacom M-Pesa', currencies: { MZN: true } }, { code: 'MOVITEL_MOZ', name: 'Movitel e-Mola', currencies: { MZN: false } }],
  NG: [{ code: 'MTN_MOMO_NGA', name: 'MTN MoMo', currencies: { NGN: true } }, { code: 'AIRTEL_NGA', name: 'Airtel', currencies: { NGN: false } }],
  CG: [{ code: 'AIRTEL_COG', name: 'Airtel Money', currencies: { XAF: false } }, { code: 'MTN_MOMO_COG', name: 'MTN MoMo', currencies: { XAF: false } }],
  RW: [{ code: 'MTN_MOMO_RWA', name: 'MTN MoMo', currencies: { RWF: false } }, { code: 'AIRTEL_RWA', name: 'Airtel Money', currencies: { RWF: false } }],
  SN: [{ code: 'ORANGE_SEN', name: 'Orange Money', currencies: { XOF: false } }, { code: 'WAVE_SEN', name: 'Wave', currencies: { XOF: false } }, { code: 'FREE_SEN', name: 'Free Money', currencies: { XOF: false } }],
  SL: [{ code: 'ORANGE_SLE', name: 'Orange Money', currencies: { SLE: true } }],
  TZ: [{ code: 'VODACOM_TZA', name: 'Vodacom M-Pesa', currencies: { TZS: false } }, { code: 'AIRTEL_TZA', name: 'Airtel Money', currencies: { TZS: true } }, { code: 'TIGO_TZA', name: 'Tigo Pesa', currencies: { TZS: false } }, { code: 'HALOTEL_TZA', name: 'HaloPesa', currencies: { TZS: false } }],
  UG: [{ code: 'MTN_MOMO_UGA', name: 'MTN MoMo', currencies: { UGX: true } }, { code: 'AIRTEL_OAPI_UGA', name: 'Airtel Money', currencies: { UGX: false } }],
  ZM: [{ code: 'MTN_MOMO_ZMB', name: 'MTN MoMo', currencies: { ZMW: true } }, { code: 'AIRTEL_OAPI_ZMB', name: 'Airtel Money', currencies: { ZMW: true } }, { code: 'ZAMTEL_ZMB', name: 'Zamtel Kwacha', currencies: { ZMW: true } }],
  ZW: [{ code: 'ECOCASH_ZWE', name: 'EcoCash', currencies: { USD: true } }],
};
const DIAL = { CD: '243', BJ: '229', BF: '226', CM: '237', CI: '225', ET: '251', GA: '241', GH: '233', KE: '254', LS: '266', MW: '265',
  MZ: '258', NG: '234', CG: '242', RW: '250', SN: '221', SL: '232', TZ: '255', UG: '256', ZM: '260', ZW: '263' };

function pawapayBase() {
  if (process.env.PAWAPAY_BASE_URL) return process.env.PAWAPAY_BASE_URL.replace(/\/$/, ''); // tests automatiques
  return process.env.PAWAPAY_ENV === 'production' ? 'https://api.pawapay.io' : 'https://api.sandbox.pawapay.io';
}
function paypalBase() {
  if (process.env.PAYPAL_BASE_URL) return process.env.PAYPAL_BASE_URL.replace(/\/$/, '');
  return process.env.PAYPAL_ENV === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}
const pawapayConfigured = () => Boolean(process.env.PAWAPAY_TOKEN);
const paypalConfigured = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);

async function httpJson(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(t); }
}

// ---------- pawaPay ----------
function providersFor(countryCode) { return PAWAPAY_PROVIDERS[countryCode] || []; }

// Numéro au format international sans « + » (ex. 243812345678). Accepte 0812345678, +243 81…, 812345678.
function normalizeMsisdn(countryCode, phone) {
  const dial = DIAL[countryCode];
  let d = String(phone || '').replace(/\D/g, '');
  if (!dial || !d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith(dial)) d = d.slice(dial.length);
  d = d.replace(/^0+/, '');
  if (d.length < 7 || d.length > 10) return null;
  return dial + d;
}
// Opérateur deviné d'après le numéro (RDC) — l'utilisateur peut toujours le changer.
function guessProvider(countryCode, msisdn) {
  const list = providersFor(countryCode), dial = DIAL[countryCode] || '';
  const local = String(msisdn || '').slice(dial.length);
  const hit = list.find((p) => (p.prefixes || []).some((x) => local.startsWith(x)));
  return hit ? hit.code : null;
}
// Montant et devise envoyés à l'opérateur : en dollars quand l'opérateur l'accepte, sinon en monnaie locale.
function mobileAmount(provider, amountUsd, convertFromUSD) {
  if (provider.currencies.USD !== undefined) return { currency: 'USD', amount: Number(amountUsd).toFixed(2) };
  const [currency, decimals] = Object.entries(provider.currencies)[0];
  const local = convertFromUSD(Number(amountUsd), currency);
  return { currency, amount: decimals ? (Math.ceil(local * 100) / 100).toFixed(2) : String(Math.ceil(local)) };
}

const pawaHeaders = () => ({ Authorization: `Bearer ${process.env.PAWAPAY_TOKEN}`, 'Content-Type': 'application/json' });

async function pawapayDeposit({ depositId, amount, currency, msisdn, provider, description }) {
  const r = await httpJson(`${pawapayBase()}/v2/deposits`, { method: 'POST', headers: pawaHeaders(), body: JSON.stringify({
    depositId, amount, currency,
    payer: { type: 'MMO', accountDetails: { phoneNumber: msisdn, provider } },
    customerMessage: String(description || 'Eaji').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 22) || 'Eaji',
  }) });
  return r.data || {};
}
async function pawapayCheck(kind, id) { // kind : deposits | payouts
  const r = await httpJson(`${pawapayBase()}/v2/${kind}/${encodeURIComponent(id)}`, { headers: pawaHeaders() });
  if (r.data && r.data.status === 'FOUND' && r.data.data) return r.data.data;
  if (r.data && r.data.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
  return { status: 'UNKNOWN' };
}
async function pawapayPayout({ payoutId, amount, currency, msisdn, provider }) {
  const r = await httpJson(`${pawapayBase()}/v2/payouts`, { method: 'POST', headers: pawaHeaders(), body: JSON.stringify({
    payoutId, amount, currency, recipient: { type: 'MMO', accountDetails: { phoneNumber: msisdn, provider } },
  }) });
  return r.data || {};
}

// ---------- PayPal (carte bancaire ou compte PayPal) ----------
let paypalToken = null;
async function paypalAuth() {
  if (paypalToken && paypalToken.exp > Date.now() + 60000) return paypalToken.value;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await httpJson(`${paypalBase()}/v1/oauth2/token`, { method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!r.ok || !r.data.access_token) throw new Error('PayPal refuse la connexion (identifiants de l\'application à vérifier).');
  paypalToken = { value: r.data.access_token, exp: Date.now() + (Number(r.data.expires_in) || 3000) * 1000 };
  return paypalToken.value;
}
async function paypalCreateOrder({ amountUsd, reference, description, returnUrl, cancelUrl }) {
  const token = await paypalAuth();
  const r = await httpJson(`${paypalBase()}/v2/checkout/orders`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': reference },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: reference, description: String(description).slice(0, 120), amount: { currency_code: 'USD', value: Number(amountUsd).toFixed(2) } }],
      application_context: { brand_name: 'Eaji', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl },
    }) });
  if (!r.ok || !r.data.id) throw new Error('PayPal n\'a pas pu préparer le paiement. Réessaie.');
  const approve = (r.data.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  return { id: r.data.id, approveUrl: approve ? approve.href : null };
}
// Résultat d'une commande PayPal : capture l'argent si l'acheteur a validé.
async function paypalSettle(orderId) {
  const token = await paypalAuth();
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let order = (await httpJson(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}`, { headers: h })).data || {};
  if (order.status === 'APPROVED') {
    const c = await httpJson(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', headers: { ...h, 'PayPal-Request-Id': `cap-${orderId}` }, body: '{}' });
    order = c.data || order;
  }
  const cap = order.purchase_units && order.purchase_units[0] && order.purchase_units[0].payments && order.purchase_units[0].payments.captures
    && order.purchase_units[0].payments.captures[0];
  return {
    status: order.status === 'COMPLETED' && cap && cap.status === 'COMPLETED' ? 'COMPLETED' : order.status === 'VOIDED' ? 'FAILED' : 'PENDING',
    amount: cap ? cap.amount.value : null, currency: cap ? cap.amount.currency_code : null, captureId: cap ? cap.id : null,
  };
}

module.exports = {
  PAWAPAY_PROVIDERS, DIAL, providersFor, normalizeMsisdn, guessProvider, mobileAmount,
  pawapayConfigured, paypalConfigured, pawapayDeposit, pawapayCheck, pawapayPayout, paypalCreateOrder, paypalSettle,
  newId: () => crypto.randomUUID(),
};
