// Eaji — tous les pays du monde peuvent ouvrir un compte et utiliser l'application.
// Seuls les créateurs des pays ci-dessous (MONETIZED_COUNTRIES) peuvent gagner de l'argent :
// toute l'Afrique et les Caraïbes, puis l'Asie, l'Amérique, l'Europe et l'Océanie SAUF les pays
// à revenu élevé selon la Banque mondiale (classement de juillet 2026).
// Pour ajouter ou retirer un pays de la monétisation, il suffit de modifier la liste.

// code pays : [zone, indicatif téléphonique]
const WORLD = {
  DZ: ['afrique', '+213'], AO: ['afrique', '+244'], BJ: ['afrique', '+229'], BW: ['afrique', '+267'], BF: ['afrique', '+226'], BI: ['afrique', '+257'],
  CV: ['afrique', '+238'], CM: ['afrique', '+237'], CF: ['afrique', '+236'], TD: ['afrique', '+235'], KM: ['afrique', '+269'], CG: ['afrique', '+242'],
  CD: ['afrique', '+243'], CI: ['afrique', '+225'], DJ: ['afrique', '+253'], EG: ['afrique', '+20'], GQ: ['afrique', '+240'], ER: ['afrique', '+291'],
  SZ: ['afrique', '+268'], ET: ['afrique', '+251'], GA: ['afrique', '+241'], GM: ['afrique', '+220'], GH: ['afrique', '+233'], GN: ['afrique', '+224'],
  GW: ['afrique', '+245'], KE: ['afrique', '+254'], LS: ['afrique', '+266'], LR: ['afrique', '+231'], LY: ['afrique', '+218'], MG: ['afrique', '+261'],
  MW: ['afrique', '+265'], ML: ['afrique', '+223'], MR: ['afrique', '+222'], MU: ['afrique', '+230'], MA: ['afrique', '+212'], MZ: ['afrique', '+258'],
  NA: ['afrique', '+264'], NE: ['afrique', '+227'], NG: ['afrique', '+234'], RW: ['afrique', '+250'], ST: ['afrique', '+239'], SN: ['afrique', '+221'],
  SC: ['afrique', '+248'], SL: ['afrique', '+232'], SO: ['afrique', '+252'], ZA: ['afrique', '+27'], SS: ['afrique', '+211'], SD: ['afrique', '+249'],
  TZ: ['afrique', '+255'], TG: ['afrique', '+228'], TN: ['afrique', '+216'], UG: ['afrique', '+256'], ZM: ['afrique', '+260'], ZW: ['afrique', '+263'],
  AG: ['caraibes', '+1268'], BS: ['caraibes', '+1242'], BB: ['caraibes', '+1246'], CU: ['caraibes', '+53'], DM: ['caraibes', '+1767'], DO: ['caraibes', '+1809'],
  GD: ['caraibes', '+1473'], HT: ['caraibes', '+509'], JM: ['caraibes', '+1876'], KN: ['caraibes', '+1869'], LC: ['caraibes', '+1758'], VC: ['caraibes', '+1784'],
  TT: ['caraibes', '+1868'], AF: ['asie', '+93'], SA: ['asie', '+966'], AM: ['asie', '+374'], AZ: ['asie', '+994'], BH: ['asie', '+973'],
  BD: ['asie', '+880'], BT: ['asie', '+975'], MM: ['asie', '+95'], BN: ['asie', '+673'], KH: ['asie', '+855'], CN: ['asie', '+86'],
  KR: ['asie', '+82'], AE: ['asie', '+971'], GE: ['asie', '+995'], IN: ['asie', '+91'], ID: ['asie', '+62'], IQ: ['asie', '+964'],
  IR: ['asie', '+98'], IL: ['asie', '+972'], JP: ['asie', '+81'], JO: ['asie', '+962'], KZ: ['asie', '+7'], KG: ['asie', '+996'],
  KW: ['asie', '+965'], LA: ['asie', '+856'], LB: ['asie', '+961'], MY: ['asie', '+60'], MV: ['asie', '+960'], MN: ['asie', '+976'],
  NP: ['asie', '+977'], OM: ['asie', '+968'], UZ: ['asie', '+998'], PK: ['asie', '+92'], PS: ['asie', '+970'], PH: ['asie', '+63'],
  QA: ['asie', '+974'], SG: ['asie', '+65'], LK: ['asie', '+94'], SY: ['asie', '+963'], TJ: ['asie', '+992'], TW: ['asie', '+886'],
  TH: ['asie', '+66'], TL: ['asie', '+670'], TM: ['asie', '+993'], TR: ['asie', '+90'], VN: ['asie', '+84'], YE: ['asie', '+967'],
  DE: ['europe', '+49'], AT: ['europe', '+43'], HU: ['europe', '+36'], LI: ['europe', '+423'], PL: ['europe', '+48'], SK: ['europe', '+421'],
  SI: ['europe', '+386'], CH: ['europe', '+41'], CZ: ['europe', '+420'], US: ['amerique', '+1'], CA: ['amerique', '+1'], MX: ['amerique', '+52'],
  GT: ['amerique', '+502'], BZ: ['amerique', '+501'], HN: ['amerique', '+504'], SV: ['amerique', '+503'], NI: ['amerique', '+505'], CR: ['amerique', '+506'],
  PA: ['amerique', '+507'], CO: ['amerique', '+57'], VE: ['amerique', '+58'], EC: ['amerique', '+593'], PE: ['amerique', '+51'], BO: ['amerique', '+591'],
  BR: ['amerique', '+55'], PY: ['amerique', '+595'], UY: ['amerique', '+598'], AR: ['amerique', '+54'], CL: ['amerique', '+56'], GY: ['amerique', '+592'],
  SR: ['amerique', '+597'], PR: ['amerique', '+1787'], FR: ['europe', '+33'], BE: ['europe', '+32'], NL: ['europe', '+31'], LU: ['europe', '+352'],
  GB: ['europe', '+44'], IE: ['europe', '+353'], ES: ['europe', '+34'], PT: ['europe', '+351'], IT: ['europe', '+39'], MT: ['europe', '+356'],
  GR: ['europe', '+30'], CY: ['europe', '+357'], DK: ['europe', '+45'], SE: ['europe', '+46'], NO: ['europe', '+47'], FI: ['europe', '+358'],
  IS: ['europe', '+354'], EE: ['europe', '+372'], LV: ['europe', '+371'], LT: ['europe', '+370'], RO: ['europe', '+40'], BG: ['europe', '+359'],
  HR: ['europe', '+385'], RS: ['europe', '+381'], BA: ['europe', '+387'], ME: ['europe', '+382'], MK: ['europe', '+389'], AL: ['europe', '+355'],
  XK: ['europe', '+383'], MD: ['europe', '+373'], UA: ['europe', '+380'], BY: ['europe', '+375'], RU: ['europe', '+7'], MC: ['europe', '+377'],
  AD: ['europe', '+376'], SM: ['europe', '+378'], VA: ['europe', '+39'], AU: ['oceanie', '+61'], NZ: ['oceanie', '+64'], PG: ['oceanie', '+675'],
  FJ: ['oceanie', '+679'], SB: ['oceanie', '+677'], VU: ['oceanie', '+678'], WS: ['oceanie', '+685'], TO: ['oceanie', '+676'], KI: ['oceanie', '+686'],
  TV: ['oceanie', '+688'], NR: ['oceanie', '+674'], PW: ['oceanie', '+680'], FM: ['oceanie', '+691'], MH: ['oceanie', '+692'], HK: ['asie', '+852'],
  MO: ['asie', '+853'],
};

const MONETIZED_COUNTRIES = new Set([
  'DZ', 'AO', 'BJ', 'BW', 'BF', 'BI', 'CV', 'CM', 'CF', 'TD', 'KM', 'CG', 'CD', 'CI', 'DJ', 'EG', 'GQ', 'ER', 'SZ', 'ET',
  'GA', 'GM', 'GH', 'GN', 'GW', 'KE', 'LS', 'LR', 'LY', 'MG', 'MW', 'ML', 'MR', 'MU', 'MA', 'MZ', 'NA', 'NE', 'NG', 'RW',
  'ST', 'SN', 'SC', 'SL', 'SO', 'ZA', 'SS', 'SD', 'TZ', 'TG', 'TN', 'UG', 'ZM', 'ZW', 'AG', 'BS', 'BB', 'CU', 'DM', 'DO',
  'GD', 'HT', 'JM', 'KN', 'LC', 'VC', 'TT', 'AF', 'AM', 'AZ', 'BD', 'BT', 'MM', 'KH', 'CN', 'GE', 'IN', 'ID', 'IQ', 'IR',
  'JO', 'KZ', 'KG', 'LA', 'LB', 'MY', 'MV', 'MN', 'NP', 'UZ', 'PK', 'PS', 'PH', 'LK', 'SY', 'TJ', 'TH', 'TL', 'TM', 'TR',
  'VN', 'YE', 'MX', 'GT', 'BZ', 'HN', 'SV', 'NI', 'CO', 'VE', 'EC', 'PE', 'BO', 'BR', 'PY', 'AR', 'SR', 'RS', 'BA', 'ME',
  'MK', 'AL', 'XK', 'MD', 'UA', 'BY', 'PG', 'FJ', 'SB', 'VU', 'WS', 'TO', 'KI', 'TV', 'FM', 'MH',
]);

const ZONES = ['afrique', 'caraibes', 'amerique', 'asie', 'europe', 'oceanie'];

function isKnownCountry(code) { return Object.prototype.hasOwnProperty.call(WORLD, String(code || '').toUpperCase()); }
function zoneOf(code) { return isKnownCountry(code) ? WORLD[String(code).toUpperCase()][0] : null; }
function dialOf(code) { return isKnownCountry(code) ? WORLD[String(code).toUpperCase()][1] : null; }

// Un créateur est monétisé si son pays est dans la liste ET si son numéro de téléphone
// est bien de ce pays (évite qu'on choisisse un faux pays pour toucher l'argent).
function isMonetizedCreator(countryCode, phone) {
  const code = String(countryCode || '').toUpperCase();
  if (!MONETIZED_COUNTRIES.has(code)) return false;
  const dial = dialOf(code);
  return Boolean(dial && String(phone || '').replace(/[\s.()-]/g, '').startsWith(dial));
}

function monetizationReason(countryCode, phone) {
  const code = String(countryCode || '').toUpperCase();
  if (!MONETIZED_COUNTRIES.has(code)) return 'pays';
  if (!isMonetizedCreator(code, phone)) return 'telephone';
  return null;
}

module.exports = { WORLD, MONETIZED_COUNTRIES, ZONES, isKnownCountry, zoneOf, dialOf, isMonetizedCreator, monetizationReason };
