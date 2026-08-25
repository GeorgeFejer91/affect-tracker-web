export const COIN_CATALOG_VERIFIED_ON = "2026-08-26";
export const BIS_2025_MOST_TRADED_CURRENCY_CODES = Object.freeze(["USD", "EUR", "JPY", "GBP", "CNY"]);

const EUR_COUNTRIES = [["AT", "Austria"], ["BE", "Belgium"], ["HR", "Croatia"], ["CY", "Cyprus"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["GR", "Greece"], ["IE", "Ireland"], ["IT", "Italy"], ["LV", "Latvia"], ["LT", "Lithuania"], ["LU", "Luxembourg"], ["MT", "Malta"], ["NL", "Netherlands"], ["PT", "Portugal"], ["SK", "Slovakia"], ["SI", "Slovenia"], ["ES", "Spain"], ["AD", "Andorra"], ["MC", "Monaco"], ["SM", "San Marino"], ["VA", "Vatican City"]];

// code, name, symbol, countries, authority, official source, round circulating coins.
// Polygonal and scalloped denominations are intentionally absent because their
// width cannot be represented by a circle-inscribed square.
const definitions = [
  ["EUR", "Euro", "€", EUR_COUNTRIES, "European Commission", "https://economy-finance.ec.europa.eu/euro/euro-coins-and-notes/euro-coins/common-sides-euro-coins_en", [["1c", "1 cent", "1¢", 16.25], ["2c", "2 cents", "2¢", 18.75], ["5c", "5 cents", "5¢", 21.25], ["10c", "10 cents", "10¢", 19.75], ["50c", "50 cents", "50¢", 24.25], ["1", "1 euro", "€1", 23.25], ["2", "2 euros", "€2", 25.75]]],
  ["USD", "United States dollar", "$", [["US", "United States"]], "United States Mint", "https://www.usmint.gov/learn/coins-and-medals/circulating-coins/coin-specifications", [["1c", "1 cent", "1¢", 19.05], ["5c", "5 cents", "5¢", 21.21], ["10c", "10 cents", "10¢", 17.91], ["25c", "25 cents", "25¢", 24.26], ["50c", "50 cents", "50¢", 30.61], ["1", "1 dollar", "$1", 26.49]]],
  ["JPY", "Japanese yen", "¥", [["JP", "Japan"]], "Bank of Japan", "https://www.boj.or.jp/en/note_tfjgs/note/valid/issue.htm", [["1", "1 yen", "¥1", 20], ["5", "5 yen", "¥5", 22], ["10", "10 yen", "¥10", 23.5], ["50", "50 yen", "¥50", 21], ["100", "100 yen", "¥100", 22.6], ["500", "500 yen", "¥500", 26.5]]],
  ["GBP", "Pound sterling", "£", [["GB", "United Kingdom"]], "The Royal Mint", "https://www.royalmint.com/aboutus/press-centre/the-royal-mint-reveals-new-coins-for-2022-including-the-queens-platinum-jubilee-50p/", [["1p", "1 penny", "1p", 20.32], ["2p", "2 pence", "2p", 25.91], ["5p", "5 pence", "5p", 18], ["10p", "10 pence", "10p", 24.5], ["2", "2 pounds", "£2", 28.4]]],
  ["CNY", "Chinese renminbi", "¥", [["CN", "China"]], "People's Bank of China", "https://www.bomi.gov.cn/bmx/zwgk/201904/1ba828ebd89147bfbab63406080e84fe.shtml", [["1j", "1 jiao", "¥0.1", 19], ["5j", "5 jiao", "¥0.5", 20.5], ["1", "1 yuan", "¥1", 22.25]]],
  ["CAD", "Canadian dollar", "$", [["CA", "Canada"]], "Royal Canadian Mint", "https://www.mint.ca/en/discover/canadian-circulation", [["5c", "5 cents", "5¢", 21.2], ["10c", "10 cents", "10¢", 18.03], ["25c", "25 cents", "25¢", 23.88], ["50c", "50 cents", "50¢", 27.13], ["2", "2 dollars", "$2", 28]]],
  ["AUD", "Australian dollar", "$", [["AU", "Australia"]], "Royal Australian Mint", "https://www.ramint.gov.au/collect/national-coin-collection/circulating-coins", [["5c", "5 cents", "5¢", 19.41], ["10c", "10 cents", "10¢", 23.6], ["20c", "20 cents", "20¢", 28.65], ["1", "1 dollar", "$1", 25], ["2", "2 dollars", "$2", 20.5]]],
  ["NZD", "New Zealand dollar", "$", [["NZ", "New Zealand"]], "Reserve Bank of New Zealand", "https://www.rbnz.govt.nz/money-and-cash/banknotes-and-coins/coins-in-circulation/coin-specifications-and-images-by-denomination", [["10c", "10 cents", "10¢", 20.5], ["20c", "20 cents", "20¢", 21.75], ["50c", "50 cents", "50¢", 24.75], ["1", "1 dollar", "$1", 23], ["2", "2 dollars", "$2", 26.5]]],
  ["KRW", "South Korean won", "₩", [["KR", "South Korea"]], "Bank of Korea", "https://www.bok.or.kr/eng/main/contents.do?menuNo=400113", [["1", "1 won", "₩1", 17.2], ["5", "5 won", "₩5", 20.4], ["10", "10 won", "₩10", 18], ["50", "50 won", "₩50", 21.6], ["100", "100 won", "₩100", 24], ["500", "500 won", "₩500", 26.5]]],
  ["CHF", "Swiss franc", "CHF", [["CH", "Switzerland"], ["LI", "Liechtenstein"]], "Swiss National Bank", "https://www.snb.ch/en/the-snb/mandates-goals/cash/coins", [["5r", "5 rappen", "5 rp", 17.15], ["10r", "10 rappen", "10 rp", 19.15], ["20r", "20 rappen", "20 rp", 21.05], ["half", "½ franc", "CHF 0.50", 18.2], ["1", "1 franc", "CHF 1", 23.2], ["2", "2 francs", "CHF 2", 27.4], ["5", "5 francs", "CHF 5", 31.45]]],
  ["SEK", "Swedish krona", "kr", [["SE", "Sweden"]], "Sveriges Riksbank", "https://www.riksbank.se/en-gb/payments--cash/notes--coins/coins/valid-coins/", [["1", "1 krona", "1 kr", 19.5], ["2", "2 kronor", "2 kr", 22.5], ["5", "5 kronor", "5 kr", 23.75], ["10", "10 kronor", "10 kr", 20.5]]],
  ["NOK", "Norwegian krone", "kr", [["NO", "Norway"]], "Norges Bank", "https://www.norges-bank.no/en/topics/notes-and-coins/legal-tender-notes-coins/", [["1", "1 krone", "1 kr", 21], ["5", "5 kroner", "5 kr", 26], ["10", "10 kroner", "10 kr", 24], ["20", "20 kroner", "20 kr", 27.5]]],
  ["DKK", "Danish krone", "kr", [["DK", "Denmark"]], "Danmarks Nationalbank", "https://www.nationalbanken.dk/en/what-we-do/notes-and-coins/danish-coins-today/the-coin-sequence", [["50o", "50 øre", "50 øre", 21.5], ["1", "1 krone", "1 kr", 20.25], ["2", "2 kroner", "2 kr", 24.5], ["5", "5 kroner", "5 kr", 28.5], ["10", "10 kroner", "10 kr", 23.35], ["20", "20 kroner", "20 kr", 27]]],
  ["PLN", "Polish złoty", "zł", [["PL", "Poland"]], "Narodowy Bank Polski", "https://nbp.pl/en/coins-and-banknotes/coins/", [["1g", "1 grosz", "1 gr", 15.5], ["2g", "2 grosze", "2 gr", 17.5], ["5g", "5 groszy", "5 gr", 19.5], ["10g", "10 groszy", "10 gr", 16.5], ["20g", "20 groszy", "20 gr", 18.5], ["50g", "50 groszy", "50 gr", 20.5], ["1", "1 złoty", "1 zł", 23], ["2", "2 złote", "2 zł", 21.5], ["5", "5 złotych", "5 zł", 24]]],
  ["CZK", "Czech koruna", "Kč", [["CZ", "Czechia"]], "Czech National Bank", "https://www.cnb.cz/en/banknotes-and-coins/coins/", [["1", "1 koruna", "1 Kč", 20], ["5", "5 korun", "5 Kč", 23], ["10", "10 korun", "10 Kč", 24.5], ["50", "50 korun", "50 Kč", 27.5]]],
  ["HUF", "Hungarian forint", "Ft", [["HU", "Hungary"]], "Magyar Nemzeti Bank", "https://www.mnb.hu/en/banknotes-and-coins/coins", [["5", "5 forint", "5 Ft", 21.2], ["10", "10 forint", "10 Ft", 24.8], ["20", "20 forint", "20 Ft", 26.3], ["50", "50 forint", "50 Ft", 27.4], ["100", "100 forint", "100 Ft", 23.8], ["200", "200 forint", "200 Ft", 28.3]]],
  ["ISK", "Icelandic króna", "kr", [["IS", "Iceland"]], "Central Bank of Iceland", "https://cb.is/payments/banknotes-and-coin/valid-coins-in-circulation/", [["1", "1 króna", "1 kr", 21.5], ["5", "5 krónur", "5 kr", 24.5], ["10", "10 krónur", "10 kr", 27.5], ["50", "50 krónur", "50 kr", 23], ["100", "100 krónur", "100 kr", 25.5]]],
  ["RON", "Romanian leu", "lei", [["RO", "Romania"]], "National Bank of Romania", "https://www.bnr.ro/Coins-and-notes-in-circulation-1331-Mobile.aspx", [["1b", "1 ban", "1 ban", 19.1], ["5b", "5 bani", "5 bani", 20.5], ["10b", "10 bani", "10 bani", 20.5], ["50b", "50 bani", "50 bani", 23.75]]],
  ["SGD", "Singapore dollar", "$", [["SG", "Singapore"]], "Singapore Statutes Online", "https://sso.agc.gov.sg/SL/CA1967-S347-2013?ProvIds=Sc-&ValidDate=20130611", [["5c", "5 cents", "5¢", 16.75], ["10c", "10 cents", "10¢", 18.5], ["20c", "20 cents", "20¢", 21], ["50c", "50 cents", "50¢", 23], ["1", "1 dollar", "$1", 24.65]]],
  ["HKD", "Hong Kong dollar", "$", [["HK", "Hong Kong"]], "Hong Kong Monetary Authority", "https://www.hkma.gov.hk/eng/key-functions/money/hong-kong-currency/coins/", [["10c", "10 cents", "10¢", 17.5], ["50c", "50 cents", "50¢", 22.5], ["1", "1 dollar", "$1", 25.5], ["5", "5 dollars", "$5", 27], ["10", "10 dollars", "$10", 24]]],
  ["TWD", "New Taiwan dollar", "NT$", [["TW", "Taiwan"]], "Central Bank of the Republic of China (Taiwan)", "https://www.cbc.gov.tw/en/lp-448-2.html", [["1", "1 dollar", "NT$1", 20], ["5", "5 dollars", "NT$5", 22], ["10", "10 dollars", "NT$10", 26], ["20", "20 dollars", "NT$20", 26.85], ["50", "50 dollars", "NT$50", 28]]],
  ["MYR", "Malaysian ringgit", "RM", [["MY", "Malaysia"]], "Bank Negara Malaysia", "https://www.bnm.gov.my/web/bnm-coins", [["5s", "5 sen", "5 sen", 17.78], ["10s", "10 sen", "10 sen", 18.8], ["20s", "20 sen", "20 sen", 20.6], ["50s", "50 sen", "50 sen", 22.65]]],
  ["PHP", "Philippine peso", "₱", [["PH", "Philippines"]], "Bangko Sentral ng Pilipinas", "https://www.bsp.gov.ph/Media_And_Research/Media%20Releases/FAQs/NGCCoins.pdf", [["1s", "1 sentimo", "1¢", 15], ["5s", "5 sentimo", "5¢", 16], ["25s", "25 sentimo", "25¢", 20], ["1", "1 piso", "₱1", 23], ["5", "5 piso", "₱5", 25], ["10", "10 piso", "₱10", 27], ["20", "20 piso", "₱20", 30]]],
  ["INR", "Indian rupee", "₹", [["IN", "India"]], "Reserve Bank of India", "https://www.rbi.org.in/commonperson/english/scripts/PressReleases.aspx?Id=2968", [["1", "1 rupee", "₹1", 20], ["2", "2 rupees", "₹2", 23], ["5", "5 rupees", "₹5", 25], ["10", "10 rupees", "₹10", 27]]],
  ["IDR", "Indonesian rupiah", "Rp", [["ID", "Indonesia"]], "Bank Indonesia", "https://www.bi.go.id/en/rupiah/gambar-uang/Detail-Uang.aspx?Bahan=Logam", [["100", "100 rupiah", "Rp100", 23], ["200", "200 rupiah", "Rp200", 25], ["500", "500 rupiah", "Rp500", 27.2], ["1000", "1,000 rupiah", "Rp1,000", 24.15]]],
  ["BRL", "Brazilian real", "R$", [["BR", "Brazil"]], "Banco Central do Brasil", "https://www.bcb.gov.br/cedulasemoedas/moedasemitidas", [["1c", "1 centavo", "1¢", 17], ["5c", "5 centavos", "5¢", 22], ["10c", "10 centavos", "10¢", 20], ["25c", "25 centavos", "25¢", 25], ["50c", "50 centavos", "50¢", 23], ["1", "1 real", "R$1", 27]]],
  ["MXN", "Mexican peso", "$", [["MX", "Mexico"]], "Banco de México", "https://www.banxico.org.mx/banknotes-and-coins/currently-banknotes-and-coins.html", [["10c", "10 centavos", "10¢", 14], ["20c", "20 centavos", "20¢", 15.3], ["50c", "50 centavos", "50¢", 17], ["1", "1 peso", "$1", 21], ["2", "2 pesos", "$2", 23], ["5", "5 pesos", "$5", 25.5], ["10", "10 pesos", "$10", 28]]],
  ["ZAR", "South African rand", "R", [["ZA", "South Africa"]], "South African Reserve Bank", "https://www.resbank.co.za/en/home/what-we-do/banknotes-and-coin", [["10c", "10 cents", "10c", 16], ["20c", "20 cents", "20c", 19], ["50c", "50 cents", "50c", 22], ["1", "1 rand", "R1", 20], ["2", "2 rand", "R2", 23], ["5", "5 rand", "R5", 26]]],
  ["TRY", "Turkish lira", "₺", [["TR", "Türkiye"]], "Central Bank of the Republic of Türkiye", "https://tcmb.gov.tr/wps/wcm/connect/8e9bfdb9-811d-4aca-ae30-7654437e7c4b/tl_profesyonel_specimen.pdf?CACHEID=ROOTWORKSPACE-8e9bfdb9-811d-4aca-ae30-7654437e7c4b-m3fxEO0&MOD=AJPERES", [["1k", "1 kuruş", "1 kr", 16.5], ["5k", "5 kuruş", "5 kr", 17.5], ["10k", "10 kuruş", "10 kr", 18.5], ["25k", "25 kuruş", "25 kr", 20.5], ["50k", "50 kuruş", "50 kr", 23.85], ["1", "1 lira", "₺1", 26.15]]],
  ["ILS", "Israeli new shekel", "₪", [["IL", "Israel"]], "Bank of Israel", "https://www.boi.org.il/en/information-and-service-to-the-public/my-cash-notes/coins/", [["10a", "10 agorot", "10 ag", 22], ["half", "½ new shekel", "₪0.50", 26], ["1", "1 new shekel", "₪1", 18], ["2", "2 new shekels", "₪2", 21.6], ["5", "5 new shekels", "₪5", 24], ["10", "10 new shekels", "₪10", 23.5]]],
  ["AED", "UAE dirham", "د.إ", [["AE", "United Arab Emirates"]], "Central Bank of the UAE", "https://www.centralbank.ae/en/our-operations/currency-and-coins/coins/", [["1f", "1 fils", "1 fils", 15], ["5f", "5 fils", "5 fils", 17], ["10f", "10 fils", "10 fils", 21], ["25f", "25 fils", "25 fils", 20], ["1", "1 dirham", "د.إ1", 24]]],
];

function freezeCurrency([code, name, symbol, countries, authority, sourceUrl, coins]) {
  const frozenCountries = Object.freeze(countries.map(([countryCode, countryName]) => Object.freeze({ code: countryCode, name: countryName })));
  const frozenCoins = Object.freeze(coins.map(([slug, denomination, label, diameterMm]) => Object.freeze({ id: `${code.toLowerCase()}-${slug}`, currencyCode: code, denomination, label, diameterMm, shape: "round", authority, sourceUrl, verifiedOn: COIN_CATALOG_VERIFIED_ON })));
  return Object.freeze({ code, name, symbol, countries: frozenCountries, coins: frozenCoins });
}

export const CURRENCY_CATALOG = Object.freeze(definitions.map(freezeCurrency));
export const COUNTRY_CATALOG = Object.freeze(CURRENCY_CATALOG.flatMap((currency) => currency.countries.map((country) => Object.freeze({ ...country, currencyCode: currency.code, currencyName: currency.name, currencySymbol: currency.symbol }))).sort((a, b) => a.name.localeCompare(b.name)));
export const COIN_REFERENCE_CATALOG = Object.freeze(CURRENCY_CATALOG.flatMap((currency) => currency.coins.map((coin) => Object.freeze({ ...coin, region: currency.countries.map(({ name }) => name).join(", "), currency: currency.code, currencyName: currency.name, currencySymbol: currency.symbol }))));

export const currencyByCode = (code) => CURRENCY_CATALOG.find((currency) => currency.code === code);
export const countryByCode = (code) => COUNTRY_CATALOG.find((country) => country.code === code);
const LEGACY_V1_COIN_ALIASES = Object.freeze([
  Object.freeze({ id: "usd-quarter", region: "United States", currency: "USD", denomination: "25¢ quarter", diameterMm: 24.26, authority: "United States Mint", sourceUrl: "https://www.usmint.gov/learn/coins-and-medals/circulating-coins/coin-specifications" }),
  Object.freeze({ id: "cad-quarter", region: "Canada", currency: "CAD", denomination: "25 cents", diameterMm: 23.88, authority: "Royal Canadian Mint", sourceUrl: "https://www.mint.ca/en/discover/canadian-circulation/25-cents" }),
  Object.freeze({ id: "czk-20", region: "Czechia", currency: "CZK", denomination: "20 korun", diameterMm: 26, authority: "Czech National Bank", sourceUrl: "https://www.cnb.cz/en/banknotes-and-coins/coins/20-czk-2019-i-version/" }),
]);

export const coinReferenceById = (id) => COIN_REFERENCE_CATALOG.find((coin) => coin.id === id)
  ?? LEGACY_V1_COIN_ALIASES.find((coin) => coin.id === id);

export function validateCoinReferenceCatalog() {
  if (BIS_2025_MOST_TRADED_CURRENCY_CODES.join(",") !== "USD,EUR,JPY,GBP,CNY") throw new TypeError("BIS shortcut order changed.");
  const ids = new Set();
  const countries = new Set();
  for (const country of COUNTRY_CATALOG) {
    if (!/^[A-Z]{2}$/.test(country.code) || countries.has(country.code) || !currencyByCode(country.currencyCode)) throw new TypeError(`Invalid country mapping: ${country.code}`);
    countries.add(country.code);
  }
  for (const coin of COIN_REFERENCE_CATALOG) {
    if (!/^[a-z0-9-]+$/.test(coin.id) || ids.has(coin.id)) throw new TypeError(`Invalid or duplicate coin id: ${coin.id}`);
    ids.add(coin.id);
    if (coin.shape !== "round" || ![coin.currency, coin.currencyName, coin.denomination, coin.label, coin.authority, coin.verifiedOn].every((value) => String(value).trim())) throw new TypeError(`Coin ${coin.id} is incomplete.`);
    if (!Number.isFinite(coin.diameterMm) || coin.diameterMm < 14 || coin.diameterMm > 35) throw new TypeError(`Coin ${coin.id} has an implausible diameter.`);
    if (new URL(coin.sourceUrl).protocol !== "https:") throw new TypeError(`Coin ${coin.id} must use an HTTPS source.`);
  }
  return true;
}
