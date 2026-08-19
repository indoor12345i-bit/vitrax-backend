// ════════════════════════════════════════════════════════════════════════
// PRICE FETCHER — same 9-API fallback chain as the dashboard frontend
// ════════════════════════════════════════════════════════════════════════
const fetch = require('node-fetch');

// SECURITY FIX (19 Aug 2026 audit): hardcoded fallback keys removed. Unlike
// mt5PriceFeed.js/telegram.js, this file already treats each source as
// best-effort (fetchGoldPrice tries each in turn and moves on if one fails),
// so a missing key here doesn't need to crash the server -- that source
// just fails its HTTP call and the chain falls through, same as if the
// provider itself were down. A warning at load time is enough.
const KEYS = {
  alphavantage: process.env.ALPHAVANTAGE_KEY,
  goldapi: process.env.GOLDAPI_KEY,
  goldpricez: process.env.GOLDPRICEZ_KEY,
  metalprice: process.env.METALPRICE_KEY,
  apininjas: process.env.APININJAS_KEY,
  commodity: process.env.COMMODITY_KEY,
  unirate: process.env.UNIRATE_KEY,
  newsapi: process.env.NEWSAPI_KEY
};

const missingKeys = Object.entries(KEYS).filter(([, v]) => !v).map(([k]) => k);
if (missingKeys.length > 0) {
  console.warn(`[PRICE FETCHER] No API key set for: ${missingKeys.join(', ')} -- those sources will fail and be skipped in the fallback chain, not crash the server. Set them in Railway's Variables tab if you want that source available.`);
}

function buildCloses(cur, high, low) {
  var closes = [], p = cur - 40;
  for (var i = 0; i < 29; i++) {
    p += (Math.random() - 0.46) * 18;
    if (p < cur - 80) p += 12;
    if (p > cur + 80) p -= 12;
    closes.push(+p.toFixed(2));
  }
  closes.push(cur);
  var highs = closes.map(function(c) { return +(c + Math.random() * 12).toFixed(2); });
  var lows = closes.map(function(c) { return +(c - Math.random() * 12).toFixed(2); });
  highs[highs.length - 1] = high || cur + 15;
  lows[lows.length - 1] = low || cur - 15;
  return { closes: closes, highs: highs, lows: lows };
}

async function tryAlphaVantage() {
  const r = await fetch('https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=XAU&to_symbol=USD&outputsize=compact&apikey=' + KEYS.alphavantage);
  const data = await r.json();
  const s = data['Time Series FX (Daily)'];
  if (!s) throw new Error('Alpha Vantage: no data');
  const dates = Object.keys(s).sort().slice(-30);
  const closes = dates.map(d => parseFloat(s[d]['4. close']));
  const highs = dates.map(d => parseFloat(s[d]['2. high']));
  const lows = dates.map(d => parseFloat(s[d]['3. low']));
  return { closes, highs, lows, source: 'AlphaVantage' };
}

async function tryGoldApiCom() {
  const r = await fetch('https://api.gold-api.com/price/XAU');
  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`gold-api.com: HTTP ${r.status} - ${bodyText.slice(0, 150)}`);
  }
  const data = await r.json();
  if (!data || !data.price) throw new Error('gold-api.com: response OK but no price field - ' + JSON.stringify(data).slice(0, 150));
  const d = buildCloses(parseFloat(data.price), data.high, data.low);
  return { ...d, source: 'gold-api.com' };
}

async function tryGoldApiIo() {
  const r = await fetch('https://www.goldapi.io/api/XAU/USD', { headers: { 'x-access-token': KEYS.goldapi } });
  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`GoldAPI.io: HTTP ${r.status} - ${bodyText.slice(0, 150)}`);
  }
  const data = await r.json();
  if (!data || !data.price) throw new Error('GoldAPI.io: response OK but no price field - ' + JSON.stringify(data).slice(0, 150));
  const d = buildCloses(parseFloat(data.price), data.high_price, data.low_price);
  return { ...d, source: 'GoldAPI.io' };
}

async function tryGoldPricez() {
  const r = await fetch('https://goldpricez.com/api/rates/currency/usd/measure/ounce', { headers: { 'X-API-KEY': KEYS.goldpricez } });
  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`GoldPricez: HTTP ${r.status} - ${bodyText.slice(0, 150)}`);
  }
  const data = await r.json();
  if (!data || !data.ounce_price_usd) throw new Error('GoldPricez: response OK but no price field - ' + JSON.stringify(data).slice(0, 150));
  const cur = parseFloat(data.ounce_price_usd);
  const high = parseFloat(data.ounce_price_usd_today_high) || cur + 15;
  const low = parseFloat(data.ounce_price_usd_today_low) || cur - 15;
  const d = buildCloses(cur, high, low);
  return { ...d, source: 'GoldPricez' };
}

async function tryMetalpriceApi() {
  const r = await fetch('https://api.metalpriceapi.com/v1/latest?api_key=' + KEYS.metalprice + '&base=XAU&currencies=USD');
  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`MetalpriceAPI: HTTP ${r.status} - ${bodyText.slice(0, 150)}`);
  }
  const data = await r.json();
  if (!data || !data.rates || !data.rates.XAUUSD) throw new Error('MetalpriceAPI: response OK but no price field - ' + JSON.stringify(data).slice(0, 150));
  const cur = +(1 / data.rates.XAUUSD).toFixed(2);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'MetalpriceAPI' };
}

async function tryApiNinjas() {
  const r = await fetch('https://api.api-ninjas.com/v1/goldprice', { headers: { 'X-Api-Key': KEYS.apininjas } });
  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`API Ninjas: HTTP ${r.status} - ${bodyText.slice(0, 150)}`);
  }
  const data = await r.json();
  if (!data || !data.price) throw new Error('API Ninjas: response OK but no price field - ' + JSON.stringify(data).slice(0, 150));
  const cur = parseFloat(data.price);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'API Ninjas' };
}

async function tryCommodityApi() {
  const r = await fetch('https://api.commoditypriceapi.com/v2/rates/latest?apiKey=' + KEYS.commodity + '&symbols=XAU');
  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`CommodityAPI: HTTP ${r.status} - ${bodyText.slice(0, 150)}`);
  }
  const data = await r.json();
  if (!data || !data.rates || !data.rates.XAU) throw new Error('CommodityAPI: response OK but no price field - ' + JSON.stringify(data).slice(0, 150));
  const cur = parseFloat(data.rates.XAU);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'CommodityPriceAPI' };
}

async function tryUniRateApi() {
  const r = await fetch('https://api.unirateapi.com/api/commodities/rates?from=USD&to=XAU&apiKey=' + KEYS.unirate);
  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`UniRateAPI: HTTP ${r.status} - ${bodyText.slice(0, 150)}`);
  }
  const data = await r.json();
  if (!data || !data.rate) throw new Error('UniRateAPI: response OK but no price field - ' + JSON.stringify(data).slice(0, 150));
  const cur = +(1 / data.rate).toFixed(2);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'UniRateAPI' };
}

async function tryCoinGecko() {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd');
  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`CoinGecko: HTTP ${r.status} - ${bodyText.slice(0, 150)}`);
  }
  const data = await r.json();
  if (!data || !data['pax-gold'] || !data['pax-gold'].usd) throw new Error('CoinGecko: response OK but no price field - ' + JSON.stringify(data).slice(0, 150));
  const cur = parseFloat(data['pax-gold'].usd);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'CoinGecko' };
}

// Tries each API in order, returns the first success. Logs which one worked.
// If every single API fails, returns null rather than fabricating fake
// prices — a fake price used for real trade management (breakeven,
// trailing stop, TP/SL checks) could cause an incorrect action on a real
// open position. Skipping the cycle is always safer than guessing.
async function fetchGoldPrice() {
  const chain = [
    tryAlphaVantage, tryGoldApiCom, tryGoldApiIo, tryGoldPricez,
    tryMetalpriceApi, tryApiNinjas, tryCommodityApi, tryUniRateApi, tryCoinGecko
  ];
  for (const attempt of chain) {
    try {
      const result = await attempt();
      console.log(`✅ Price fetched from ${result.source}: $${result.closes[result.closes.length - 1]}`);
      return result;
    } catch (err) {
      console.log(`❌ ${attempt.name} failed: ${err.message}`);
    }
  }
  console.log('⚠️  ALL 9 website APIs failed this cycle — no real price available, skipping (MT5 remains the primary source regardless)');
  return null;
}

async function fetchNewsSentiment(analyzeNewsSentiment) {
  try {
    const r = await fetch('https://newsapi.org/v2/everything?q=gold+XAU+price&language=en&sortBy=publishedAt&pageSize=20&apiKey=' + KEYS.newsapi);
    const data = await r.json();
    if (!data || !data.articles || data.articles.length === 0) return null;
    return analyzeNewsSentiment(data.articles);
  } catch (err) {
    console.log('News sentiment fetch failed:', err.message);
    return null;
  }
}

module.exports = { fetchGoldPrice, fetchNewsSentiment, KEYS };
