// ════════════════════════════════════════════════════════════════════════
// VITRAX BACKEND SERVER
// Runs 24/7 independent of any browser. Generates signals on schedule,
// manages open trades, serves results to the dashboard.
// ════════════════════════════════════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const calc = require('./calculations');
const priceFetcher = require('./priceFetcher');
const mt5 = require('./mt5PriceFeed');
const db = require('./database');
const telegram = require('./telegram');
const tradeManager = require('./tradeManager');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let lastEmergencyTime = null; // prevent spamming emergency signals

// ── Live vote status — what the dashboard polls to show "building" progress ──
// Updated every check cycle (every 1 min) regardless of whether a signal
// actually fires. This is in-memory only (not persisted to DB) since it's
// just "current state right now", not historical data worth keeping.
let currentVoteStatus = {
  direction: null,      // 'BUY' or 'SELL' — whichever side is currently leading
  votes: 0,             // votes on the leading side
  against: 0,           // votes on the opposing side
  threshold: 6,         // votes needed to reach the threshold
  blockedReason: null,  // if threshold was reached but a filter stopped it, why
  updatedAt: null,      // ISO timestamp of last check
};

// ── Market freeze detection ─────────────────────────────────────────────
// Gold markets close for holidays (July 4th, Christmas) and for a daily
// ~1hr break around 21:00-22:00 UTC. When closed, MT5 keeps returning the
// SAME frozen price. Without this check, the confluence detector would
// keep firing fake signals against a price that isn't actually moving.
let recentLivePrices = []; // last 5 raw MT5 prices
const FREEZE_CHECK_COUNT = 5;
const MIN_PRICE_MOVEMENT = 0.02; // if range across last 5 prices is below this, market is frozen

function trackPriceAndCheckFrozen(price) {
  recentLivePrices.push(price);
  if (recentLivePrices.length > FREEZE_CHECK_COUNT) recentLivePrices.shift();
  if (recentLivePrices.length < FREEZE_CHECK_COUNT) return false; // not enough data yet
  const min = Math.min(...recentLivePrices);
  const max = Math.max(...recentLivePrices);
  return (max - min) < MIN_PRICE_MOVEMENT;
}

// ── Session tradability check ───────────────────────────────────────────
// Combines two things:
//   1. Only London/New York sessions are tradable at all (Asian + the
//      quiet gap are blocked entirely — too little real activity).
//   2. Even within London/New York, the first and last 15 minutes are
//      blocked too — the open floods the market with overnight orders
//      executing at once, and the close has funds unwinding positions
//      for the day. Both create erratic, misleading price action that
//      isn't really about a new trend forming.
// Returns { ok: boolean, reason: string } so callers can log exactly why.
function checkSessionTradable(sessionInfo) {
  if (sessionInfo.session !== 'London' && sessionInfo.session !== 'New York') {
    return { ok: false, reason: `session is ${sessionInfo.session} — only London/New York are tradable` };
  }

  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const minutesIntoHour = utcM;

  // London opens 07:00 UTC — block first 15 minutes
  if (utcH === 7 && minutesIntoHour < 15) {
    return { ok: false, reason: 'within 15 min of London open (07:00 UTC) — opening rush, wait for it to settle' };
  }

  // New York closes 21:00 UTC — block last 15 minutes (20:45-20:59)
  if (utcH === 20 && minutesIntoHour >= 45) {
    return { ok: false, reason: 'within 15 min of New York close (21:00 UTC) — closing unwind, too erratic' };
  }

  return { ok: true, reason: sessionInfo.session };
}

// Candle cache — reuse candles across checks instead of fetching every time
// 1h candles refresh every 60 minutes, 4h every 4 hours, daily every 6 hours
let candleCache = { candles1h: null, candles4h: null, candlesDaily: null };
let candleCacheTime = { candles1h: 0, candles4h: 0, candlesDaily: 0 };
const CANDLE_TTL = { candles1h: 15*60*1000, candles4h: 4*60*60*1000, candlesDaily: 6*60*60*1000 };

async function getCachedCandles() {
  const now = Date.now();
  const [c1h, c4h, cd] = await Promise.all([
    (now - candleCacheTime.candles1h > CANDLE_TTL.candles1h)
      ? mt5.fetchMT5Candles('1h', 48).catch(() => null)
      : Promise.resolve(candleCache.candles1h),
    (now - candleCacheTime.candles4h > CANDLE_TTL.candles4h)
      ? mt5.fetchMT5Candles('4h', 60).catch(() => null)
      : Promise.resolve(candleCache.candles4h),
    (now - candleCacheTime.candlesDaily > CANDLE_TTL.candlesDaily)
      ? mt5.fetchMT5Candles('1d', 30).catch(() => null)
      : Promise.resolve(candleCache.candlesDaily),
  ]);
  if (c1h) { candleCache.candles1h = c1h; candleCacheTime.candles1h = now; }
  if (c4h) { candleCache.candles4h = c4h; candleCacheTime.candles4h = now; }
  if (cd)  { candleCache.candlesDaily = cd; candleCacheTime.candlesDaily = now; }
  return [candleCache.candles1h, candleCache.candles4h, candleCache.candlesDaily];
}

// ════════════════════════════════════════════════════════════════════════
// CORE SIGNAL GENERATION — runs on the 5x/day schedule
// ════════════════════════════════════════════════════════════════════════
async function generateScheduledSignal() {
  console.log('\n========================================');
  console.log('SCHEDULED SIGNAL CHECK —', new Date().toISOString());
  console.log('========================================');

  try {
    const priceData = await priceFetcher.fetchGoldPrice();
    if (!priceData) {
      console.log('No real price available from any source this cycle — skipping');
      return { error: 'No real price data available — all sources failed. Try again shortly.' };
    }

    // Fetch real OHLCV candles from MT5 for AVWAP + MTF calculation
    const [candles, candles4h, candlesDaily] = await getCachedCandles();
    if (candles)      console.log(`[MTF] 1h: ${candles.length} candles`);
    if (candles4h)    console.log(`[MTF] 4h: ${candles4h.length} candles`);
    if (candlesDaily) console.log(`[MTF] Daily: ${candlesDaily.length} candles`);

    const sig = calc.calcSignal(priceData.closes, priceData.highs, priceData.lows, candles, candles4h, candlesDaily);

    // ── QUALITY GATE ─────────────────────────────────────────────────────
    // Scheduled signals only fire as BUY or SELL when conditions are
    // genuinely good. If the gate fails, the signal is saved as WAIT
    // and the system waits for the next scheduled check.
    //
    // Gate conditions for a real BUY or SELL to fire:
    //   1. Score must be +3 or higher (strict — not just +2)
    //   2. Confidence must be above 55%
    //   3. Market must not be choppy
    //   4. RSI must not be above 78 for BUY (overbought = bad entry)
    //   5. RSI must not be below 22 for SELL (oversold = bad entry)
    //   6. Daily trend veto is already handled inside calcSignal
    //
    // If gate fails → downgrade to WAIT with reason logged
    if (sig.label !== 'WAIT') {
      const rsiV = parseFloat(sig.rsi);
      const gateReasons = [];

      if (Math.abs(sig.score) < 3) gateReasons.push(`score ${sig.score} below threshold ±3`);
      if (sig.confidence < 55)     gateReasons.push(`confidence ${sig.confidence}% below 55%`);
      if (sig.isChoppy)            gateReasons.push('choppy market');
      if (sig.label === 'BUY'  && rsiV > 78) gateReasons.push(`RSI ${rsiV} overbought for BUY`);
      if (sig.label === 'SELL' && rsiV < 22) gateReasons.push(`RSI ${rsiV} oversold for SELL`);

      if (gateReasons.length > 0) {
        console.log(`[GATE] Signal downgraded to WAIT — ${gateReasons.join(', ')}`);
        sig.label     = 'WAIT';
        sig.direction = 'NEUTRAL';
        sig.strength  = '';
        sig.takeProfit  = null;
        sig.takeProfit2 = null;
        sig.stopLoss    = null;
        sig.reasons.push('⏸️ Quality gate: ' + gateReasons.join(' | '));
      } else {
        console.log(`[GATE] Signal passed quality gate — ${sig.label} score:${sig.score} conf:${sig.confidence}%`);
      }
    }

    // Override entry price with real MT5 broker price
    const mt5Price = await mt5.fetchMT5Price().catch(() => null);
    if (mt5Price && mt5Price.price && sig.label !== 'WAIT') {
      const realEntry = mt5Price.price;
      const levels = calc.calcDynamicLevels(realEntry, sig.label, sig.atr, sig.rsi);
      sig.entry    = realEntry;
      sig.takeProfit  = levels.tp1;
      sig.takeProfit2 = levels.tp2;
      sig.stopLoss    = levels.sl;
      console.log(`[MT5] Entry price overridden: $${realEntry} (was $${priceData.closes[priceData.closes.length-1]})`);
    } else if (sig.label !== 'WAIT') {
      console.log('[MT5] Live price unavailable — using API price for entry');
    }

    const saved = await db.saveSignal(sig, 'SCHEDULED', mt5Price ? 'PrimaCapital MT5 (direct)' : priceData.source);

    console.log(`Signal generated: ${sig.label} (${sig.strength}) at $${sig.entry} — confidence ${sig.confidence}%`);
    if (sig.avwap)    console.log(`[AVWAP] Daily AVWAP: $${sig.avwap} — price is ${sig.entry > sig.avwap ? 'ABOVE' : 'BELOW'} AVWAP`);
    if (sig.mtfScore !== undefined) console.log(`[MTF] Score: ${sig.mtfScore} | ${sig.mtfReasons.join(' | ')}`);
    console.log(`Saved as signal #${saved.id}`);

    // Send Telegram alert — only for real BUY/SELL signals, never for WAIT
    if (sig.label !== 'WAIT') {
      await telegram.sendSignalAlert(sig);
    }

    return saved;
  } catch (err) {
    console.error('Signal generation failed:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// EMERGENCY CHECK — runs every 10 minutes
// ════════════════════════════════════════════════════════════════════════
async function checkEmergency() {
  try {
    // Fetch candles for AVWAP + MTF filtering
    const [candles, candles4h, candlesDaily] = await getCachedCandles();
    if (!candles || candles.length < 20) return;
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const mt5P   = await mt5.fetchMT5Price().catch(() => null);
    const curP   = mt5P && mt5P.price ? mt5P.price : closes[closes.length-1];
    const liveC  = [...closes.slice(0,-1), curP];

    // ── Candle spike detector — catches NFP/Fed/news moves immediately ──
    // Fires when a single candle moves 2.5x ATR — bypasses daily veto
    // because a spike of that size IS the new trend direction
    if (lastEmergencyTime === null || (Date.now() - lastEmergencyTime) > 30 * 60 * 1000) {
      const spike = calc.checkCandleSpike(candles, curP);
      if (spike) {
        const sessionInfo = calc.detectSession();
        const sessionCheck = checkSessionTradable(sessionInfo);

        if (!sessionCheck.ok) {
          console.log(`[BLOCKED] ${spike.signal} candle spike detected but ${sessionCheck.reason}`);
        } else {
        console.log('\n🚀 CANDLE SPIKE SIGNAL:', spike.signal, 'at $' + curP, '(' + spike.atrMultiple + 'x ATR)');
        const baseline = calc.calcSignal(liveC, highs, lows, candles, candles4h, candlesDaily);
        const sig = {
          ...baseline,
          label:       spike.signal,
          direction:   spike.signal === 'BUY' ? 'LONG' : 'SHORT',
          strength:    'SPIKE',
          score:       spike.signal === 'BUY' ? 6 : -6,
          entry:       curP,
          takeProfit:  spike.takeProfit,
          takeProfit2: spike.takeProfit2,
          stopLoss:    spike.stopLoss,
          confidence:  spike.confidence,
          reasons:     [...spike.reasons, `Session: ${sessionInfo.session}`],
        };
        const saved = await db.saveSignal(sig, 'EMERGENCY', 'PrimaCapital MT5 (direct)');
        console.log('🚀 Spike signal saved as #' + saved.id);
        await telegram.sendSignalAlert(sig);
        lastEmergencyTime = Date.now();
        return; // skip regular emergency check if spike already fired
        }
      }
    }

    const emergency = calc.checkEmergencyTrigger(liveC, highs, lows, candles);

    if (emergency) {
      console.log('\n🚨 EMERGENCY SIGNAL TRIGGERED:', emergency.signal, 'at $' + curP);
      const baseline = calc.calcSignal(liveC, highs, lows, candles, candles4h, candlesDaily);

      // Build a fully consistent signal object - every field that depends on
      // label/direction gets explicitly overwritten together, not just label.
      // This was the bug: previously only sig.label was overwritten, leaving
      // direction/strength/score from the calm baseline calc mismatched
      // against the emergency verdict.
      const sig = {
        ...baseline,
        label: emergency.signal,
        direction: emergency.signal === 'BUY' ? 'LONG' : 'SHORT',
        strength: 'EMERGENCY',
        score: emergency.signal === 'BUY' ? 6 : -6, // emergency = max conviction by definition
        entry: emergency.entry,
        takeProfit: emergency.takeProfit,
        stopLoss: emergency.stopLoss,
        confidence: emergency.confidence,
        reasons: emergency.reasons,
        riskReward: emergency.takeProfit && emergency.stopLoss
          ? +(Math.abs(emergency.takeProfit - emergency.entry) / Math.abs(emergency.entry - emergency.stopLoss)).toFixed(2)
          : null
      };

      await db.saveSignal(sig, 'EMERGENCY', 'PrimaCapital MT5 (direct)');
    }
  } catch (err) {
    console.error('Emergency check failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// HIGH CONFLUENCE CHECK — runs every 5 minutes
// Detects when all indicator groups align strongly on same direction.
// Completely independent of news. Fires an emergency signal when
// 8+ out of ~10 indicators agree, representing ~85% confluence.
// Cooldown: minimum 30 minutes between high confluence signals.
// ════════════════════════════════════════════════════════════════════════
async function checkHighConfluenceSignal() {
  try {
    // Cooldown — 30 minutes between signals
    if (lastEmergencyTime && (Date.now() - lastEmergencyTime) < 30 * 60 * 1000) return;

    // Use MT5 candles as primary price history — real OHLCV data from broker
    // This replaces the website API price history which used fake random walks
    // when all APIs were unavailable. Indicators are now calculated from real data.
    const [candles, candles4h, candlesDaily] = await getCachedCandles();

    if (!candles || candles.length < 20) {
      console.log('[HIGH CONFLUENCE] Insufficient candle data — skipping');
      return;
    }

    const closes = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);

    // Get live MT5 price for freshest entry
    const mt5Price = await mt5.fetchMT5Price().catch(() => null);
    const currentPrice = mt5Price && mt5Price.price ? mt5Price.price : closes[closes.length - 1];
    const liveCloses = [...closes.slice(0, -1), currentPrice];

    // ── Market freeze check — skip if price hasn't moved (market closed) ──
    if (trackPriceAndCheckFrozen(currentPrice)) {
      console.log(`[SCAN] $${currentPrice.toFixed(2)} — market appears CLOSED (frozen price) — skipping`);
      return;
    }

    console.log(`[SCAN] $${currentPrice.toFixed(2)} — ${new Date().toISOString().substr(11,8)} UTC`);
    const hc = calc.checkHighConfluence(liveCloses, highs, lows, candles, candles4h, candlesDaily);

    // Show vote counts so we can see how close we are to a signal
    if (hc && hc.belowThreshold) {
      var dominant = hc.dominantSide || (hc.bullVotes > hc.bearVotes ? 'BUY' : 'SELL');
      var domVotes = Math.max(hc.bullVotes, hc.bearVotes);
      var minVotes = Math.min(hc.bullVotes, hc.bearVotes);
      console.log(`[VOTES] ${dominant} ${domVotes}/6 needed (${minVotes} against) — need ${Math.max(0, 6-domVotes)} more votes`);

      currentVoteStatus = {
        direction: dominant,
        votes: domVotes,
        against: minVotes,
        threshold: 6,
        blockedReason: null,
        updatedAt: new Date().toISOString(),
      };
    }

    if (hc && !hc.belowThreshold && hc.signal) {
      // ── Session filter ────────────────────────────────────────────────
      // Only fire during London and New York sessions, and not right at
      // the open/close of those sessions (see checkSessionTradable above).
      const sessionInfo = calc.detectSession();
      const sessionCheck = checkSessionTradable(sessionInfo);

      // ── Spread filter ────────────────────────────────────────────────
      // A wide bid-ask spread means uncertain/thin liquidity right now —
      // entering on a wide spread eats directly into the $7 TP1 target.
      const spread = mt5Price && mt5Price.ask && mt5Price.bid ? (mt5Price.ask - mt5Price.bid) : null;
      const spreadOk = spread === null ? true : spread <= 0.50;

      // ── News blackout ────────────────────────────────────────────────
      // Blocks REGULAR signals within 20 minutes of a scheduled high-impact
      // release (NFP, CPI, Fed decision, etc). The volatility right around
      // a release is often just noise/whipsaw, not a real trend forming.
      // Deliberately NOT applied to the candle-spike detector — that one
      // exists specifically to catch genuine moves that follow news like
      // this, exactly like what happened with today's NFP earlier.
      const newsCheck = calc.isWithinNewsBlackout(20);

      if (!sessionCheck.ok) {
        console.log(`[BLOCKED] ${hc.signal} setup reached threshold but ${sessionCheck.reason}`);
        currentVoteStatus = {
          direction: hc.signal, votes: Math.max(hc.bullVotes, hc.bearVotes), against: Math.min(hc.bullVotes, hc.bearVotes),
          threshold: 6, blockedReason: sessionCheck.reason, updatedAt: new Date().toISOString(),
        };
      } else if (!spreadOk) {
        console.log(`[BLOCKED] ${hc.signal} setup reached threshold but spread is $${spread.toFixed(2)} (max $0.50) — skipping this cycle`);
        currentVoteStatus = {
          direction: hc.signal, votes: Math.max(hc.bullVotes, hc.bearVotes), against: Math.min(hc.bullVotes, hc.bearVotes),
          threshold: 6, blockedReason: `spread too wide ($${spread.toFixed(2)})`, updatedAt: new Date().toISOString(),
        };
      } else if (newsCheck.blocked) {
        console.log(`[BLOCKED] ${hc.signal} setup reached threshold but within 20 min of "${newsCheck.event}" — skipping regular signal (spike detector remains active for the actual move)`);
        currentVoteStatus = {
          direction: hc.signal, votes: Math.max(hc.bullVotes, hc.bearVotes), against: Math.min(hc.bullVotes, hc.bearVotes),
          threshold: 6, blockedReason: `near "${newsCheck.event}" release`, updatedAt: new Date().toISOString(),
        };
      } else {
        console.log('\n🔥 HIGH CONFLUENCE SIGNAL TRIGGERED:', hc.signal, 'at $' + currentPrice);
        console.log('   Votes:', hc.bullVotes, 'bull /', hc.bearVotes, 'bear | Confidence:', hc.confidence + '%');
        console.log('   Session:', sessionInfo.session, '| Spread: $' + (spread !== null ? spread.toFixed(2) : 'n/a'));

        const baseline = calc.calcSignal(liveCloses, highs, lows, candles, candles4h, candlesDaily);
        const levels = calc.calcDynamicLevels(currentPrice, hc.signal, baseline.atr, baseline.rsi);

        const sig = {
          ...baseline,
          label: hc.signal,
          direction: hc.signal === 'BUY' ? 'LONG' : 'SHORT',
          strength: 'HIGH CONFLUENCE',
          score: hc.signal === 'BUY' ? 6 : -6,
          entry: currentPrice,
          takeProfit:  levels.tp1,
          takeProfit2: levels.tp2,
          stopLoss:    levels.sl,
          confidence:  hc.confidence,
          reasons:     [...hc.reasons, `Session: ${sessionInfo.session}`],
        };

        const saved = await db.saveSignal(sig, 'EMERGENCY', 'PrimaCapital MT5 (direct)');
        console.log('🔥 High confluence signal saved as #' + saved.id);
        await telegram.sendSignalAlert(sig);
        lastEmergencyTime = Date.now();

        // Reset the building-progress tracker — a real signal now exists,
        // the dashboard's main action card takes over from here.
        currentVoteStatus = { direction: null, votes: 0, against: 0, threshold: 6, blockedReason: null, updatedAt: new Date().toISOString() };
      }
    }
  } catch (err) {
    console.error('High confluence check failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// LIVE PRICE CHECK — runs every 30 seconds, manages open trades
//
// UPDATED: now uses the real MT5 connection (PrimaCapital, via MetaApi) as
// the primary source, since that's confirmed to match the actual broker
// price exactly - not an estimate from a third-party website. Falls back
// to the 9-API website chain only if the MT5 connection has an issue,
// so trade management never goes completely blind even if MetaApi is
// temporarily unavailable.
// ════════════════════════════════════════════════════════════════════════
async function checkLivePriceAndTrades() {
  try {
    let currentPrice = null;
    let source = null;

    const mt5Price = await mt5.fetchMT5Price();
    if (mt5Price && mt5Price.price) {
      currentPrice = mt5Price.price;
      source = mt5Price.source;
    } else {
      console.log('MT5 price unavailable this cycle, falling back to website API chain...');
      const priceData = await priceFetcher.fetchGoldPrice();
      if (priceData && priceData.closes && priceData.closes.length > 0) {
        currentPrice = priceData.closes[priceData.closes.length - 1];
        source = priceData.source;
      }
    }

    if (currentPrice === null) return;

    // Logged separately so a failure in one doesn't prevent the other from
    // running - kept this structure since it's what actually let us find
    // the real bug earlier (each failure point isolated with its own trace).
    try {
      await db.logPrice(currentPrice, source);
    } catch (logErr) {
      console.error('logPrice failed:', logErr.message);
    }

    try {
      await tradeManager.checkOpenTrades(currentPrice);
    } catch (tradeErr) {
      console.error('checkOpenTrades failed:', tradeErr.message);
    }
  } catch (err) {
    console.error('Live price check failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// SCHEDULER — no fixed signal times
// Signals fire only when the system detects a strong setup.
// The high confluence detector checks every 5 minutes and fires
// when enough indicators agree. 30-minute cooldown between signals.
// ════════════════════════════════════════════════════════════════════════

// Emergency spike detection every 10 minutes
cron.schedule('*/10 * * * *', checkEmergency);

// High confluence check every 1 minute — the only signal generator
cron.schedule('* * * * *', checkHighConfluenceSignal);

// Live price + trade management every 30 seconds
setInterval(checkLivePriceAndTrades, 30000);

// ════════════════════════════════════════════════════════════════════════
// API ENDPOINTS — what the dashboard reads from
// ════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'Vitrax backend running', time: new Date().toISOString() });
});

app.get('/api/latest-signal', async (req, res) => {
  try {
    const signal = await db.getLatestSignal();
    res.json(signal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signal-history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const history = await db.getSignalHistory(limit);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/open-trades', async (req, res) => {
  try {
    const trades = await db.getOpenTrades();
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/win-rate', async (req, res) => {
  try {
    const stats = await db.getWinRate();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/price-history', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 720;
    const history = await db.getPriceHistory(hours);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live price, now sourced directly from PrimaCapital's MT5 feed via MetaApi,
// not from third-party websites. Confirmed today that gold-api.com was
// returning prices $30+ off from the real broker - this connects to the
// actual account instead, so what's shown matches what PrimaCapital's own
// terminal shows.
app.get('/api/live-price', async (req, res) => {
  try {
    const live = await mt5.fetchMT5Price();
    if (!live) {
      return res.json(null);
    }
    res.json(live);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live vote-building progress — lets the dashboard show "getting close to
// a signal" in real time, updated every 1 minute by the confluence check.
app.get('/api/vote-status', (req, res) => {
  res.json(currentVoteStatus);
});

// Manual trigger endpoints (useful for testing without waiting for cron)
app.post('/api/trigger/signal', async (req, res) => {
  const result = await generateScheduledSignal();
  res.json(result);
});

app.post('/api/trigger/emergency-check', async (req, res) => {
  await checkEmergency();
  res.json({ status: 'checked' });
});

// ════════════════════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════════════════════
async function start() {
  console.log('Starting Vitrax backend...');
  await db.initDB();

  app.listen(PORT, () => {
    console.log(`\n✅ Vitrax backend running on port ${PORT}`);
    console.log('Signal generation: condition-based (no fixed schedule)');
    console.log('High confluence checks: every 1 minute');
    console.log('Emergency spike checks: every 10 minutes');
    console.log('Cooldown between signals: 30 minutes');
    console.log('Emergency checks: every 10 minutes (price spike detection)');
    console.log('High confluence checks: every 5 minutes (indicator alignment)');
    console.log('High confluence cooldown: 30 minutes between signals');
    console.log('Live price + trade management: every 30 seconds');
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
