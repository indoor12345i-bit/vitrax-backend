// ════════════════════════════════════════════════════════════════════════
// MT5 LIVE PRICE FEED — direct connection to PrimaCapital via MetaApi
//
// This replaces the old website-based live ticker (gold-api.com, GoldAPI.io)
// which was confirmed to sometimes return prices $30+ off from the
// real broker feed. This connects directly to the actual MT5 account,
// pulling the exact same price PrimaCapital's own terminal shows.
//
// Confirmed working via standalone test on 2026-06-30: real price
// ($4023.39) matched the live MT5 app screenshot ($4023.91) within
// normal price movement over a few minutes.
//
// ── UPDATE (staleness detection) ────────────────────────────────────────
// terminalState.price() returns whatever price is CACHED in the terminal
// state. If the underlying broker connection silently dies, this keeps
// returning the LAST known price with an old timestamp — forever — and
// nothing throws, so the old code never noticed. From the outside it looks
// alive. This version now checks the AGE of the price: if the market
// should be open but the price is several minutes stale, the connection is
// treated as dead — the cache is cleared so the next call rebuilds a fresh
// connection, instead of trusting a frozen number indefinitely.
// ════════════════════════════════════════════════════════════════════════
const MetaApi = require('metaapi.cloud-sdk').default;

// SECURITY FIX (19 Aug 2026 audit): hardcoded fallback credentials removed.
// These are now REQUIRED env vars with no fallback -- the server refuses to
// start rather than silently running on a value baked into source control.
// Set METAAPI_TOKEN, MT5_LOGIN, MT5_PASSWORD, MT5_SERVER in Railway's
// Variables tab using the NEW rotated values, not the old exposed ones.
const TOKEN = process.env.METAAPI_TOKEN;
const LOGIN = process.env.MT5_LOGIN;
const PASSWORD = process.env.MT5_PASSWORD;
const SERVER = process.env.MT5_SERVER;

if (!TOKEN || !LOGIN || !PASSWORD || !SERVER) {
  throw new Error(
    '[MT5] Missing required environment variable(s): ' +
    ['METAAPI_TOKEN', 'MT5_LOGIN', 'MT5_PASSWORD', 'MT5_SERVER']
      .filter(name => !process.env[name]).join(', ') +
    '. No hardcoded fallback exists anymore -- set these in Railway\'s Variables tab before deploying.'
  );
}

const SYMBOL = 'XAUUSD-'; // Confirmed exact symbol from PrimaCapital's MT5 Market Watch

// How old a price can be, during OPEN market hours, before we treat the
// connection as dead. Gold ticks constantly while the market is open — it
// never goes 5 minutes without a single tick — so a price older than this
// during open hours means no fresh data is arriving, i.e. the connection
// has silently died. Kept deliberately generous (5 min, not 1) so a brief
// feed hiccup or a thin quiet moment doesn't trigger a needless reconnect.
const STALE_PRICE_MS = 5 * 60 * 1000;

// Cached connection - we don't want to re-establish this on every price
// request, since deployment/connection/sync takes real time. Connect once,
// keep the connection alive, reuse it for all subsequent price reads.
let cachedConnection = null;
let cachedApi = null;
let cachedAccount = null; // needed for getHistoricalCandles (called on account, not connection)
let connectionPromise = null;

// ── Is a fresh tick physically expected right now? ──────────────────────
// Deliberately SEPARATE from calculations.js's checkSessionTradable(). That
// function answers "is this a moment we're allowed to fire a signal" and
// returns false for the Asian session and the open/close buffers — but gold
// is still TICKING during all of those, so a stale price then would still
// mean a dead connection. This helper answers the narrower physical
// question: "is the gold market actually open, so a fresh tick should be
// coming in?" Only the weekend closure and the daily ~21:00 UTC maintenance
// break make ticks genuinely stop. That's why this isn't reused from calc —
// it's a different question, not accidental duplication.
function isMarketLikelyOpen(atDate) {
  const now = atDate || new Date();
  const day = now.getUTCDay(); // 0=Sunday, 5=Friday, 6=Saturday
  const h = now.getUTCHours();

  // Weekend closure — same boundaries the signal logic already uses
  if (day === 6) return false;              // all of Saturday
  if (day === 0 && h < 21) return false;    // Sunday before ~21:00 UTC reopen
  if (day === 5 && h >= 21) return false;   // Friday after ~21:00 UTC close

  // Daily maintenance break — gold pauses for ~1hr around 21:00-22:00 UTC
  // (17:00 ET rollover). A stale price during this hour is expected too.
  if (h === 21) return false;

  return true;
}

async function getConnection() {
  if (cachedConnection) {
    return cachedConnection;
  }

  // If a connection attempt is already in progress, wait for that one
  // instead of starting a second concurrent attempt
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    console.log('[MT5] Establishing connection to PrimaCapital via MetaApi...');
    cachedApi = new MetaApi(TOKEN);

    const accounts = await cachedApi.metatraderAccountApi.getAccountsWithInfiniteScrollPagination();
    let account = accounts.find(a => a.login === LOGIN && a.server === SERVER);

    if (!account) {
      console.log('[MT5] No existing account found, creating new one...');
      account = await cachedApi.metatraderAccountApi.createAccount({
        name: 'Vitrax Gold Price Feed',
        type: 'cloud',
        login: LOGIN,
        password: PASSWORD,
        server: SERVER,
        platform: 'mt5',
        magic: 0,
      });
    }

    if (account.state !== 'DEPLOYED' && account.state !== 'DEPLOYING') {
      console.log('[MT5] Deploying account...');
      await account.deploy();
    }

    await account.waitConnected();
    cachedAccount = account; // cache for getHistoricalCandles calls

    const connection = account.getStreamingConnection();
    await connection.connect();
    await connection.waitSynchronized();

    // Known MetaApi timing gap - settle before subscribing
    await new Promise(resolve => setTimeout(resolve, 10000));

    let subscribed = false;
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await connection.subscribeToMarketData(SYMBOL);
        subscribed = true;
        break;
      } catch (err) {
        lastError = err;
        const waitSeconds = attempt * 10;
        console.log(`[MT5] Subscription attempt ${attempt}/5 failed: ${err.message}`);
        if (attempt < 5) {
          await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        }
      }
    }

    if (!subscribed) {
      throw new Error(`MT5 subscription failed after 5 attempts: ${lastError.message}`);
    }

    console.log('[MT5] ✅ Connected and subscribed to', SYMBOL);
    cachedConnection = connection;
    return connection;
  })();

  try {
    return await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}

// Clears every cached handle so the NEXT call to getConnection() rebuilds a
// completely fresh connection from scratch, rather than reusing a dead one.
function resetConnection() {
  cachedConnection = null;
  cachedAccount = null;
  // cachedApi is intentionally left — the MetaApi client itself is fine to
  // reuse; it's the streaming connection + account handle that go stale.
}

async function fetchMT5Price() {
  try {
    const connection = await getConnection();
    const price = connection.terminalState.price(SYMBOL);

    if (!price || !price.bid) {
      console.log('[MT5] No price data available yet from terminal state');
      return null;
    }

    // ── Staleness check ──────────────────────────────────────────────────
    // If the market should be open but this price is minutes old, no fresh
    // ticks are arriving — the connection has silently died. Clear the cache
    // so the next call rebuilds a fresh one, and skip THIS cycle cleanly
    // (returning null) rather than handing back a frozen price that trade
    // management or the signal check would wrongly treat as current.
    if (price.time) {
      const ageMs = Date.now() - new Date(price.time).getTime();
      if (isMarketLikelyOpen() && ageMs > STALE_PRICE_MS) {
        const ageMin = Math.round(ageMs / 60000);
        console.warn(`[MT5] ⚠️ Price is ${ageMin} min old during open market — connection likely dead. Forcing fresh reconnect on next cycle.`);
        resetConnection();
        return null;
      }
    }

    return {
      price: price.bid,
      bid: price.bid,
      ask: price.ask,
      source: 'PrimaCapital MT5 (direct)',
      time: price.time
    };
  } catch (err) {
    console.error('[MT5] Price fetch failed:', err.message);
    // If the connection itself failed, clear the cache so the next call
    // attempts a fresh connection rather than repeatedly failing on a
    // broken cached one.
    resetConnection();
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// OHLCV CANDLE DATA — for AVWAP and volume-based analysis
// Fetches real candle data from PrimaCapital via MetaApi, including
// volume which is not available from any of the website-based APIs.
// Used to calculate Anchored VWAP (AVWAP) - anchored to daily open.
// ════════════════════════════════════════════════════════════════════════

// Consecutive candle-fetch failure counter. When the connection is
// struggling (like the xhr-poll-error storms seen in the Railway logs),
// candle fetches start failing and the whole signal check silently skips
// every cycle with nothing obvious in the logs. This surfaces that: after a
// few failures in a row it logs a loud, greppable warning so the silent
// failure mode is actually visible. Resets to 0 the moment a fetch
// succeeds. (Search Railway logs for "CANDLE FETCH FAILING" to catch it.)
let candleFetchFailStreak = 0;
const CANDLE_FAIL_ALERT_AT = 3;

async function fetchMT5Candles(timeframe, count) {
  if (!cachedAccount) {
    // Ensure connection is established first
    try {
      await getConnection();
    } catch (err) {
      console.log('[MT5] Cannot fetch candles - no account connection:', err.message);
      candleFetchFailStreak++;
      if (candleFetchFailStreak >= CANDLE_FAIL_ALERT_AT) {
        console.warn(`[MT5] 🔴 CANDLE FETCH FAILING — ${candleFetchFailStreak} cycles in a row with no candle data. The signal check is silently skipping every cycle. Connection is likely down.`);
      }
      return null;
    }
  }

  if (!cachedAccount) {
    console.log('[MT5] Cannot fetch candles - account not yet cached');
    candleFetchFailStreak++;
    if (candleFetchFailStreak >= CANDLE_FAIL_ALERT_AT) {
      console.warn(`[MT5] 🔴 CANDLE FETCH FAILING — ${candleFetchFailStreak} cycles in a row with no candle data. The signal check is silently skipping every cycle. Connection is likely down.`);
    }
    return null;
  }

  try {
    const raw = await cachedAccount.getHistoricalCandles(SYMBOL, timeframe, null, count);
    if (!raw || raw.length === 0) {
      console.log('[MT5] No candle data returned');
      candleFetchFailStreak++;
      if (candleFetchFailStreak >= CANDLE_FAIL_ALERT_AT) {
        console.warn(`[MT5] 🔴 CANDLE FETCH FAILING — ${candleFetchFailStreak} cycles in a row with no candle data. The signal check is silently skipping every cycle. Connection is likely down.`);
      }
      return null;
    }

    // Normalize to a clean format for calculations.js
    // Use tickVolume as primary (always available), volume as fallback
    const candles = raw.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.tickVolume || c.volume || 1
    }));

    // Success — clear the failure streak. If it was mid-alert, note recovery.
    if (candleFetchFailStreak >= CANDLE_FAIL_ALERT_AT) {
      console.log(`[MT5] ✅ Candle fetch recovered after ${candleFetchFailStreak} failed cycles.`);
    }
    candleFetchFailStreak = 0;

    console.log(`[MT5] Fetched ${candles.length} ${timeframe} candles for AVWAP`);
    return candles;
  } catch (err) {
    console.error('[MT5] fetchMT5Candles failed:', err.message);
    candleFetchFailStreak++;
    if (candleFetchFailStreak >= CANDLE_FAIL_ALERT_AT) {
      console.warn(`[MT5] 🔴 CANDLE FETCH FAILING — ${candleFetchFailStreak} cycles in a row (last error: ${err.message}). The signal check is silently skipping every cycle. Connection is likely down.`);
    }
    return null;
  }
}

module.exports = { fetchMT5Price, fetchMT5Candles };
