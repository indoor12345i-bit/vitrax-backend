// ════════════════════════════════════════════════════════════════════════
// PRICE FETCHER — same 9-API fallback chain as the dashboard frontend
// ════════════════════════════════════════════════════════════════════════
const fetch = require('node-fetch');

const KEYS = {
  alphavantage: process.env.ALPHAVANTAGE_KEY || 'ECU0FASBENK86YA8',
  goldapi: process.env.GOLDAPI_KEY || 'goldapi-bd571556d1769efdd739efcd8bbdc9fd-io',
  goldpricez: process.env.GOLDPRICEZ_KEY || 'f6412fdf260d55b6cb460cb4e5bad69cf6412fdf',
  metalprice: process.env.METALPRICE_KEY || '0d6ef3daa54343a5a1bc181ae43e0697',
  apininjas: process.env.APININJAS_KEY || '2Uajf11dLM7aoBHC5CV4AKVncblqFvhLVr3wuYOe',
  commodity: process.env.COMMODITY_KEY || '5146eb56-3e42-4fba-bd43-66b146b6062a',
  unirate: process.env.UNIRATE_KEY || 'yFCVgwyyL8BBVj4mrkQ1UojQqmYUzHsZ6Lop1i3hSdgyFkHzOX7XARrqWRzRsFTJ',
  newsapi: process.env.NEWSAPI_KEY || 'd33aaf056e654539bcbe7c049b7c83a0'
};

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
  const data = await r.json();
  if (!data || !data.price) throw new Error('gold-api.com: no data');
  const d = buildCloses(parseFloat(data.price), data.high, data.low);
  return { ...d, source: 'gold-api.com' };
}

async function tryGoldApiIo() {
  const r = await fetch('https://www.goldapi.io/api/XAU/USD', { headers: { 'x-access-token': KEYS.goldapi } });
  const data = await r.json();
  if (!data || !data.price) throw new Error('GoldAPI.io: no data');
  const d = buildCloses(parseFloat(data.price), data.high_price, data.low_price);
  return { ...d, source: 'GoldAPI.io' };
}

async function tryGoldPricez() {
  const r = await fetch('https://goldpricez.com/api/rates/currency/usd/measure/ounce', { headers: { 'X-API-KEY': KEYS.goldpricez } });
  const data = await r.json();
  if (!data || !data.ounce_price_usd) throw new Error('GoldPricez: no data');
  const cur = parseFloat(data.ounce_price_usd);
  const high = parseFloat(data.ounce_price_usd_today_high) || cur + 15;
  const low = parseFloat(data.ounce_price_usd_today_low) || cur - 15;
  const d = buildCloses(cur, high, low);
  return { ...d, source: 'GoldPricez' };
}

async function tryMetalpriceApi() {
  const r = await fetch('https://api.metalpriceapi.com/v1/latest?api_key=' + KEYS.metalprice + '&base=XAU&currencies=USD');
  const data = await r.json();
  if (!data || !data.rates || !data.rates.XAUUSD) throw new Error('MetalpriceAPI: no data');
  const cur = +(1 / data.rates.XAUUSD).toFixed(2);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'MetalpriceAPI' };
}

async function tryApiNinjas() {
  const r = await fetch('https://api.api-ninjas.com/v1/goldprice', { headers: { 'X-Api-Key': KEYS.apininjas } });
  const data = await r.json();
  if (!data || !data.price) throw new Error('API Ninjas: no data');
  const cur = parseFloat(data.price);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'API Ninjas' };
}

async function tryCommodityApi() {
  const r = await fetch('https://api.commoditypriceapi.com/v2/rates/latest?apiKey=' + KEYS.commodity + '&symbols=XAU');
  const data = await r.json();
  if (!data || !data.rates || !data.rates.XAU) throw new Error('CommodityAPI: no data');
  const cur = parseFloat(data.rates.XAU);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'CommodityPriceAPI' };
}

async function tryUniRateApi() {
  const r = await fetch('https://api.unirateapi.com/api/commodities/rates?from=USD&to=XAU&apiKey=' + KEYS.unirate);
  const data = await r.json();
  if (!data || !data.rate) throw new Error('UniRateAPI: no data');
  const cur = +(1 / data.rate).toFixed(2);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'UniRateAPI' };
}

async function tryCoinGecko() {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd');
  const data = await r.json();
  if (!data || !data['pax-gold'] || !data['pax-gold'].usd) throw new Error('CoinGecko: no data');
  const cur = parseFloat(data['pax-gold'].usd);
  const d = buildCloses(cur, cur + 15, cur - 15);
  return { ...d, source: 'CoinGecko' };
}

function simulatedData() {
  var base = 4088, closes = [], p = base - 80;
  for (var i = 0; i < 30; i++) {
    p += (Math.random() - 0.46) * 22;
    if (p < base - 120) p += 15;
    if (p > base + 120) p -= 15;
    closes.push(+p.toFixed(2));
  }
  var highs = closes.map(c => +(c + Math.random() * 12).toFixed(2));
  var lows = closes.map(c => +(c - Math.random() * 12).toFixed(2));
  return { closes, highs, lows, source: 'SIMULATED' };
}

// Tries each API in order, returns the first success. Logs which one worked.
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
  console.log('⚠️  ALL 9 APIs FAILED — falling back to simulated data');
  return simulatedData();
}

async function fetchLivePrice() {
  // Try gold-api.com first (unlimited, fast)
  try {
    const r = await fetch('https://api.gold-api.com/price/XAU');
    const data = await r.json();
    if (data && data.price) {
      return { price: parseFloat(data.price), bid: data.bid, ask: data.ask, source: 'gold-api.com' };
    }
    console.log('fetchLivePrice: gold-api.com returned no price field. Response:', JSON.stringify(data).slice(0, 200));
  } catch (err) {
    console.log('fetchLivePrice: gold-api.com failed -', err.message);
  }

  // Fallback to GoldAPI.io
  try {
    const r = await fetch('https://www.goldapi.io/api/XAU/USD', { headers: { 'x-access-token': KEYS.goldapi } });
    const data = await r.json();
    if (data && data.price) {
      return { price: data.price, bid: data.bid, ask: data.ask, source: 'GoldAPI.io' };
    }
    console.log('fetchLivePrice: GoldAPI.io returned no price field. Response:', JSON.stringify(data).slice(0, 200));
  } catch (err) {
    console.log('fetchLivePrice: GoldAPI.io failed -', err.message);
  }

  // Last resort: reuse the full 9-API chain that scheduled signals already use.
  // This is slower (tries more sources) but far more reliable than only 2 attempts.
  console.log('fetchLivePrice: both fast sources failed, falling back to full 9-API chain...');
  try {
    const full = await fetchGoldPrice();
    if (full && full.closes && full.closes.length > 0) {
      const lastPrice = full.closes[full.closes.length - 1];
      return { price: lastPrice, bid: lastPrice - 0.3, ask: lastPrice + 0.3, source: full.source + ' (via full chain)' };
    }
  } catch (err) {
    console.log('fetchLivePrice: full chain fallback also failed -', err.message);
  }

  console.log('fetchLivePrice: ALL sources exhausted, returning null');
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

module.exports = { fetchGoldPrice, fetchLivePrice, fetchNewsSentiment, KEYS };
