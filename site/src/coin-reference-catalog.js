export const COIN_CATALOG_VERIFIED_ON = "2026-08-25";

// One practical, round, currently circulating/legal-tender reference per
// currency region. Polygonal and scalloped coins are deliberately excluded:
// their official "diameter" does not describe a circle that can touch all four
// sides of a square at once.
export const COIN_REFERENCE_CATALOG = Object.freeze([
  { id: "eur-1", region: "Euro area and other euro users", currency: "EUR", denomination: "€1", diameterMm: 23.25, authority: "European Commission", sourceUrl: "https://economy-finance.ec.europa.eu/euro/euro-coins-and-notes/euro-coins/common-sides-euro-coins_en" },
  { id: "usd-quarter", region: "United States", currency: "USD", denomination: "25¢ quarter", diameterMm: 24.26, authority: "United States Mint", sourceUrl: "https://www.usmint.gov/learn/coins-and-medals/circulating-coins/coin-specifications" },
  { id: "gbp-10p", region: "United Kingdom", currency: "GBP", denomination: "10 pence", diameterMm: 24.5, authority: "The Royal Mint", sourceUrl: "https://www.royalmint.com/collect/collector-resources/designs-and-specifications/ten-pence-coin-designs/" },
  { id: "cad-quarter", region: "Canada", currency: "CAD", denomination: "25 cents", diameterMm: 23.88, authority: "Royal Canadian Mint", sourceUrl: "https://www.mint.ca/en/discover/canadian-circulation/25-cents" },
  { id: "aud-10c", region: "Australia", currency: "AUD", denomination: "10 cents", diameterMm: 23.6, authority: "Royal Australian Mint", sourceUrl: "https://www.ramint.gov.au/collect/national-coin-collection/circulating-coins/ten-cents" },
  { id: "nzd-1", region: "New Zealand", currency: "NZD", denomination: "$1", diameterMm: 23, authority: "Reserve Bank of New Zealand", sourceUrl: "https://www.rbnz.govt.nz/money-and-cash/banknotes-and-coins/coins-in-circulation/coin-specifications-and-images-by-denomination" },
  { id: "jpy-100", region: "Japan", currency: "JPY", denomination: "¥100", diameterMm: 22.6, authority: "Bank of Japan", sourceUrl: "https://www.boj.or.jp/en/note_tfjgs/note/valid/issue.htm" },
  { id: "krw-100", region: "South Korea", currency: "KRW", denomination: "₩100", diameterMm: 24, authority: "Bank of Korea", sourceUrl: "https://www.bok.or.kr/eng/main/contents.do?menuNo=400113" },
  { id: "chf-1", region: "Switzerland and Liechtenstein", currency: "CHF", denomination: "1 franc", diameterMm: 23.2, authority: "Swiss National Bank", sourceUrl: "https://www.snb.ch/en/the-snb/mandates-goals/cash/coins" },
  { id: "sek-10", region: "Sweden", currency: "SEK", denomination: "10 kronor", diameterMm: 20.5, authority: "Sveriges Riksbank", sourceUrl: "https://www.riksbank.se/en-gb/payments--cash/notes--coins/coins/valid-coins/10-krona-coin/" },
  { id: "nok-20", region: "Norway", currency: "NOK", denomination: "20 kroner", diameterMm: 27.5, authority: "Norges Bank", sourceUrl: "https://www.norges-bank.no/en/topics/notes-and-coins/legal-tender-notes-coins/20-krone-coin/20-design/" },
  { id: "dkk-10", region: "Denmark", currency: "DKK", denomination: "10 kroner", diameterMm: 23.35, authority: "Danmarks Nationalbank", sourceUrl: "https://www.nationalbanken.dk/en/what-we-do/notes-and-coins/danish-coins-today/the-coin-sequence" },
  { id: "pln-5", region: "Poland", currency: "PLN", denomination: "5 złotych", diameterMm: 24, authority: "Narodowy Bank Polski", sourceUrl: "https://nbp.pl/en/coins-and-banknotes/collector-coins/catalogue/page/2/" },
  { id: "czk-20", region: "Czechia", currency: "CZK", denomination: "20 korun", diameterMm: 26, authority: "Czech National Bank", sourceUrl: "https://www.cnb.cz/en/banknotes-and-coins/coins/20-czk-2019-i-version/" },
  { id: "huf-100", region: "Hungary", currency: "HUF", denomination: "100 forint", diameterMm: 23.8, authority: "Magyar Nemzeti Bank", sourceUrl: "https://www.mnb.hu/en/banknotes-and-coins/coins" },
  { id: "isk-10", region: "Iceland", currency: "ISK", denomination: "10 krónur", diameterMm: 27.5, authority: "Central Bank of Iceland", sourceUrl: "https://cb.is/payments/banknotes-and-coin/valid-coins-in-circulation/" },
  { id: "ron-50b", region: "Romania", currency: "RON", denomination: "50 bani", diameterMm: 23.75, authority: "National Bank of Romania", sourceUrl: "https://www.bnr.ro/files/d/Monede%20si%20bancnote/R20041117guv.pdf" },
  { id: "sgd-1", region: "Singapore", currency: "SGD", denomination: "$1", diameterMm: 24.65, authority: "Singapore Statutes Online", sourceUrl: "https://sso.agc.gov.sg/SL/CA1967-S347-2013?ProvIds=Sc-&ValidDate=20130611" },
  { id: "hkd-1", region: "Hong Kong", currency: "HKD", denomination: "$1", diameterMm: 25.5, authority: "Hong Kong Monetary Authority", sourceUrl: "https://www.hkma.gov.hk/media/eng/publication-and-research/quarterly-bulletin/qb200506/E_Content.pdf" },
  { id: "twd-10", region: "Taiwan", currency: "TWD", denomination: "NT$10", diameterMm: 26, authority: "Central Bank of the Republic of China (Taiwan)", sourceUrl: "https://www.cbc.gov.tw/en/cp-448-37605-23FD0-2.html" },
  { id: "myr-20s", region: "Malaysia", currency: "MYR", denomination: "20 sen", diameterMm: 20.6, authority: "Bank Negara Malaysia", sourceUrl: "https://www.bnm.gov.my/web/bnm-coins/20-sen-bunga-melur" },
  { id: "php-10", region: "Philippines", currency: "PHP", denomination: "10 piso", diameterMm: 27, authority: "Bangko Sentral ng Pilipinas", sourceUrl: "https://www.bsp.gov.ph/Media_And_Research/Media%20Releases/FAQs/NGCCoins.pdf" },
  { id: "inr-5", region: "India", currency: "INR", denomination: "₹5", diameterMm: 23, authority: "Reserve Bank of India", sourceUrl: "https://www.rbi.org.in/commonperson/english/scripts/PressReleases.aspx?Id=1123" },
  { id: "idr-1000", region: "Indonesia", currency: "IDR", denomination: "Rp1,000 (2010 issue)", diameterMm: 24.15, authority: "Bank Indonesia", sourceUrl: "https://www.bi.go.id/id/edukasi/Documents/90320740454248eaa25d76c118b341efBukuPanduanUangRupiah.pdf" },
  { id: "brl-1", region: "Brazil", currency: "BRL", denomination: "R$1", diameterMm: 27, authority: "Banco Central do Brasil", sourceUrl: "https://www.bcb.gov.br/cedulasemoedas/moedasemitidas?modalAberto=moeda_real_RS1_00_2_familia_de_moedas" },
  { id: "mxn-10", region: "Mexico", currency: "MXN", denomination: "$10", diameterMm: 28, authority: "Banco de México", sourceUrl: "https://www.banxico.org.mx/banknotes-and-coins/10-peso-coins--c-type--circul.html" },
  { id: "zar-5", region: "South Africa", currency: "ZAR", denomination: "R5", diameterMm: 26, authority: "South African Reserve Bank", sourceUrl: "https://www.resbank.co.za/content/dam/sarb/what-we-do/banknotes-and-coin/2023/Upgraded%20Currency%20Frequently%20Asked%20Questions.pdf" },
  { id: "try-1", region: "Türkiye", currency: "TRY", denomination: "₺1", diameterMm: 26.15, authority: "Central Bank of the Republic of Türkiye", sourceUrl: "https://tcmb.gov.tr/wps/wcm/connect/8e9bfdb9-811d-4aca-ae30-7654437e7c4b/tl_profesyonel_specimen.pdf" },
  { id: "ils-half", region: "Israel", currency: "ILS", denomination: "½ new shekel", diameterMm: 26, authority: "Bank of Israel", sourceUrl: "https://www.boi.org.il/en/information-and-service-to-the-public/my-cash-notes/" },
  { id: "aed-1", region: "United Arab Emirates", currency: "AED", denomination: "1 dirham", diameterMm: 24, authority: "Central Bank of the UAE", sourceUrl: "https://www.centralbank.ae/media/ph4j3exu/commemorativecoins-press-release.pdf" },
]);

export function coinReferenceById(id) {
  return COIN_REFERENCE_CATALOG.find((coin) => coin.id === id);
}

export function validateCoinReferenceCatalog(catalog = COIN_REFERENCE_CATALOG) {
  if (!Array.isArray(catalog) || catalog.length === 0) throw new TypeError("Coin reference catalog must not be empty.");
  const ids = new Set();
  for (const coin of catalog) {
    if (!/^[a-z0-9-]+$/.test(coin.id) || ids.has(coin.id)) throw new TypeError(`Invalid or duplicate coin id: ${coin.id}`);
    ids.add(coin.id);
    if (![coin.region, coin.currency, coin.denomination, coin.authority].every((value) => String(value).trim())) {
      throw new TypeError(`Coin ${coin.id} is missing display metadata.`);
    }
    if (!Number.isFinite(coin.diameterMm) || coin.diameterMm < 15 || coin.diameterMm > 35) {
      throw new TypeError(`Coin ${coin.id} has an implausible diameter.`);
    }
    const source = new URL(coin.sourceUrl);
    if (source.protocol !== "https:") throw new TypeError(`Coin ${coin.id} must use an HTTPS source.`);
  }
  return true;
}
