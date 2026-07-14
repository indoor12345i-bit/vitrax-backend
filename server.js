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
const backtest = require('./backtest');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let lastEmergencyTime = null; // prevent spamming emergency signals

// ── Live vote status — what the dashboard polls to show "building" progress ──
let currentVoteStatus = {
  direction: null,
  votes: 0,
  against: 0,
  threshold: 6,
  blockedReason: null,
  updatedAt: null,
};

// ── Market freeze detection ─────────────────────────────────────────────
let recentLivePrices = [];
const FREEZE_CHECK_COUNT = 5;
const MIN_PRICE_MOVEMENT = 0.02;

function trackPriceAndCheckFrozen(price) {
  recentLivePrices.push(price);
  if (recentLivePrices.length > FREEZE_CHECK_COUNT) recentLivePrices.shift();
  if (recentLivePrices.length < FREEZE_CHECK_COUNT) return false;
  const min = Math.min(...recentLivePrices);
  const max = Math.max(...recentLivePrices);
  return (max - min) < MIN_PRICE_MOVEMENT;
}

const checkSessionTradable = calc.checkSessionTradable;

// Candle cache — reuse candles across checks instead of fetching every time
// 1h candles refresh every 60 minutes, 4h every 4 hours, daily every 6 hours
let candleCache = { candles1h: null, candles4h: null, candlesDaily: null };
let candleCacheTime = { candles1h: 0, candles4h: 0, candlesDaily: 0 };
const CANDLE_TTL = { candles1h: 15*60*1000, candles4h: 4*60*60*1000, candlesDaily: 6*60*60*1000 };

// ── UPDATE: hard staleness ceiling ──────────────────────────────────────
// The bug found tonight: if a candle fetch fails, the old code kept
// silently serving whatever candle set it last successfully fetched --
// forever, retrying each cycle but never actually admitting the data was
// ancient if every retry also failed. That's exactly why the confluence
// check sat frozen on the same 4/6 vote count for a full hour straight
// while real price kept moving $9+. This caps how long a cache entry can
// go without a SUCCESSFUL refresh before it's treated as unusable (null)
// instead of trusted indefinitely -- and logs loudly when that happens,
// so this failure mode is visible instead of silent.
const MAX_STALENESS = { candles1h: 30*60*1000, candles4h: 8*60*60*1000, candlesDaily: 12*60*60*1000 };

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

  const stale1h    = (now - candleCacheTime.candles1h)     > MAX_STALENESS.candles1h;
  const stale4h    = (now - candleCacheTime.candles4h)     > MAX_STALENESS.candles4h;
  const staleDaily = (now - candleCacheTime.candlesDaily)  > MAX_STALENESS.candlesDaily;
  if (stale1h)    console.warn(`[CANDLE CACHE] 1h candles are ${Math.round((now-candleCacheTime.candles1h)/60000)} min stale — treating as unavailable`);
  if (stale4h)    console.warn(`[CANDLE CACHE] 4h candles are ${Math.round((now-candleCacheTime.candles4h)/60000)} min stale — treating as unavailable`);
  if (staleDaily) console.warn(`[CANDLE CACHE] Daily candles are ${Math.round((now-candleCacheTime.candlesDaily)/60000)} min stale — treating as unavailable`);

  return [
    stale1h    ? null : candleCache.candles1h,
    stale4h    ? null : candleCache.candles4h,
    staleDaily ? null : candleCache.candlesDaily,
  ];
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

    const [candles, candles4h, candlesDaily] = await getCachedCandles();
    if (candles)      console.log(`[MTF] 1h: ${candles.length} candles`);
    if (candles4h)    console.log(`[MTF] 4h: ${candles4h.length} candles`);
    if (candlesDaily) console.log(`[MTF] Daily: ${candlesDaily.length} candles`);

    const sig = calc.calcSignal(priceData.closes, priceData.highs, priceData.lows, candles, candles4h, candlesDaily);

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
    const [candles, candles4h, candlesDaily] = await getCachedCandles();
    if (!candles || candles.length < 20) return;
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const mt5P   = await mt5.fetchMT5Price().catch(() => null);
    const curP   = mt5P && mt5P.price ? mt5P.price : closes[closes.length-1];
    const liveC  = [...closes.slice(0,-1), curP];

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
        return;
        }
      }
    }

    const emergency = calc.checkEmergencyTrigger(liveC, highs, lows, candles);

    if (emergency) {
      console.log('\n🚨 EMERGENCY SIGNAL TRIGGERED:', emergency.signal, 'at $' + curP);
      const baseline = calc.calcSignal(liveC, highs, lows, candles, candles4h, candlesDaily);

      const sig = {
        ...baseline,
        label: emergency.signal,
        direction: emergency.signal === 'BUY' ? 'LONG' : 'SHORT',
        strength: 'EMERGENCY',
        score: emergency.signal === 'BUY' ? 6 : -6,
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
// ════════════════════════════════════════════════════════════════════════
async function checkHighConfluenceSignal() {
  try {
    if (lastEmergencyTime && (Date.now() - lastEmergencyTime) < 30 * 60 * 1000) return;

    const [candles, candles4h, candlesDaily] = await getCachedCandles();

    if (!candles || candles.length < 20) {
      console.log('[HIGH CONFLUENCE] Insufficient candle data — skipping');
      currentVoteStatus = {
        direction: null, votes: 0, against: 0, threshold: 6,
        blockedReason: 'candle data unavailable or stale', updatedAt: new Date().toISOString(),
      };
      return;
    }

    const closes = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);

    const mt5Price = await mt5.fetchMT5Price().catch(() => null);
    const currentPrice = mt5Price && mt5Price.price ? mt5Price.price : closes[closes.length - 1];
    const liveCloses = [...closes.slice(0, -1), currentPrice];

    const earlySessionInfo = calc.detectSession();
    const earlySessionCheck = checkSessionTradable(earlySessionInfo);
    if (!earlySessionCheck.ok) {
      console.log(`[SCAN] $${currentPrice.toFixed(2)} — ${earlySessionCheck.reason} — skipping`);
      currentVoteStatus = {
        direction: null, votes: 0, against: 0, threshold: 6,
        blockedReason: earlySessionCheck.reason, updatedAt: new Date().toISOString(),
      };
      return;
    }

    if (trackPriceAndCheckFrozen(currentPrice)) {
      console.log(`[SCAN] $${currentPrice.toFixed(2)} — market appears CLOSED (frozen price) — skipping`);
      currentVoteStatus = {
        direction: null, votes: 0, against: 0, threshold: 6,
        blockedReason: 'price feed frozen — market likely closed', updatedAt: new Date().toISOString(),
      };
      return;
    }

    console.log(`[SCAN] $${currentPrice.toFixed(2)} — ${new Date().toISOString().substr(11,8)} UTC`);
    const hc = calc.checkHighConfluence(liveCloses, highs, lows, candles, candles4h, candlesDaily);

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
      const sessionInfo = calc.detectSession();
      const sessionCheck = checkSessionTradable(sessionInfo);

      const spread = mt5Price && mt5Price.ask && mt5Price.bid ? (mt5Price.ask - mt5Price.bid) : null;
      const spreadOk = spread === null ? true : spread <= 0.50;

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

        currentVoteStatus = { direction: null, votes: 0, against: 0, threshold: 6, blockedReason: null, updatedAt: new Date().toISOString() };
      }
    }
  } catch (err) {
    console.error('High confluence check failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// LIVE PRICE CHECK — runs every 30 seconds, manages open trades
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
// SCHEDULER
// ════════════════════════════════════════════════════════════════════════
cron.schedule('*/10 * * * *', checkEmergency);
cron.schedule('* * * * *', checkHighConfluenceSignal);
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

app.get('/api/vote-status', (req, res) => {
  res.json(currentVoteStatus);
});

// ── Backtest — replays real historical candles through the exact live
// signal logic to get a measured win rate, instead of guessing.
app.get('/api/backtest', async (req, res) => {
  try {
    const hours1h = Math.min(parseInt(req.query.hours) || 500, 3000);
    const hours4h = Math.ceil(hours1h / 3);
    const hoursDaily = Math.ceil(hours1h / 15);
    const voteThreshold = parseInt(req.query.votes) || 6;
    const tp1Override = req.query.tp1 ? parseFloat(req.query.tp1) : undefined;
    const tp2Override = req.query.tp2 ? parseFloat(req.query.tp2) : undefined;
    const directionFilter = req.query.direction ? req.query.direction.toUpperCase() : null;

    console.log(`[BACKTEST] Fetching ${hours1h} 1h candles (~${Math.round(hours1h/24)} days), testing threshold=${voteThreshold}${directionFilter ? `, direction=${directionFilter}` : ''}...`);

    let fetchErrors = {};
    const [candles1h, candles4h, candlesDaily] = await Promise.all([
      mt5.fetchMT5Candles('1h', hours1h).catch(err => { fetchErrors.h1 = err.message; return null; }),
      mt5.fetchMT5Candles('4h', hours4h).catch(err => { fetchErrors.h4 = err.message; return null; }),
      mt5.fetchMT5Candles('1d', hoursDaily).catch(err => { fetchErrors.daily = err.message; return null; }),
    ]);

    if (Object.keys(fetchErrors).length > 0) {
      console.error('[BACKTEST] Candle fetch errors:', JSON.stringify(fetchErrors));
    }

    if (!candles1h) {
      return res.status(500).json({ error: 'Could not fetch historical 1h candles from MT5', details: fetchErrors });
    }

    console.log(`[BACKTEST] Got ${candles1h.length} 1h, ${candles4h ? candles4h.length : 0} 4h, ${candlesDaily ? candlesDaily.length : 0} daily candles. Running simulation...`);

    if (!candles4h || !candlesDaily) {
      return res.status(500).json({
        error: 'Missing 4h or daily candle data — required for MTF analysis',
        details: fetchErrors,
        hint: 'The exact error from MetaApi is in "details" above — likely a candle count or history-length limit at this hours value',
      });
    }

    const results = await backtest.runBacktest(candles1h, candles4h, candlesDaily, voteThreshold, tp1Override, tp2Override, directionFilter);
    console.log(`[BACKTEST] Done — ${results.totalSignals || 0} signals found, win rate: ${results.winRate}%`);

    res.json(results);
  } catch (err) {
    console.error('[BACKTEST] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
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
    console.log('Live price + trade management: every 30 seconds');
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
