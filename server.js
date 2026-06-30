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
const db = require('./database');
const tradeManager = require('./tradeManager');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let lastNewsSentiment = null;
let lastNewsTime = null;

// ════════════════════════════════════════════════════════════════════════
// CORE SIGNAL GENERATION — runs on the 5x/day schedule
// ════════════════════════════════════════════════════════════════════════
async function generateScheduledSignal() {
  console.log('\n========================================');
  console.log('SCHEDULED SIGNAL CHECK —', new Date().toISOString());
  console.log('========================================');

  try {
    const priceData = await priceFetcher.fetchGoldPrice();

    // Refresh news sentiment every 2 hours
    const now = Date.now();
    if (!lastNewsTime || (now - lastNewsTime) > 2 * 60 * 60 * 1000) {
      lastNewsSentiment = await priceFetcher.fetchNewsSentiment(calc.analyzeNewsSentiment);
      lastNewsTime = now;
    }

    const sig = calc.calcSignal(priceData.closes, priceData.highs, priceData.lows, lastNewsSentiment);
    const saved = await db.saveSignal(sig, 'SCHEDULED', priceData.source);

    console.log(`Signal generated: ${sig.label} (${sig.strength}) at $${sig.entry} — confidence ${sig.confidence}%`);
    console.log(`Saved as signal #${saved.id}`);

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
    const priceData = await priceFetcher.fetchGoldPrice();
    const emergency = calc.checkEmergencyTrigger(priceData.closes, priceData.highs, priceData.lows, lastNewsSentiment);

    if (emergency) {
      console.log('\n🚨 EMERGENCY SIGNAL TRIGGERED:', emergency.signal, 'at $' + emergency.entry);
      const baseline = calc.calcSignal(priceData.closes, priceData.highs, priceData.lows, lastNewsSentiment);

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

      await db.saveSignal(sig, 'EMERGENCY', priceData.source);
    }
  } catch (err) {
    console.error('Emergency check failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// LIVE PRICE CHECK — runs every 30 seconds, manages open trades
// ════════════════════════════════════════════════════════════════════════
async function checkLivePriceAndTrades() {
  try {
    const live = await priceFetcher.fetchLivePrice();
    if (!live) return;
    await db.logPrice(live.price, live.source);
    await tradeManager.checkOpenTrades(live.price);
  } catch (err) {
    console.error('Live price check failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// SCHEDULER — cron jobs
// ════════════════════════════════════════════════════════════════════════
// Scheduled signals at 00:00, 04:48, 09:36, 14:24, 19:12 (5x per day, every 4.8h)
cron.schedule('0 0 * * *', generateScheduledSignal);   // 00:00
cron.schedule('48 4 * * *', generateScheduledSignal);  // 04:48
cron.schedule('36 9 * * *', generateScheduledSignal);  // 09:36
cron.schedule('24 14 * * *', generateScheduledSignal); // 14:24
cron.schedule('12 19 * * *', generateScheduledSignal); // 19:12

// Emergency check every 10 minutes
cron.schedule('*/10 * * * *', checkEmergency);

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

app.get('/api/live-price', async (req, res) => {
  try {
    const live = await priceFetcher.fetchLivePrice();
    res.json(live);
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

  // Generate an initial signal immediately on startup so the dashboard
  // has something to show right away, instead of waiting for the next cron slot
  await generateScheduledSignal();

  app.listen(PORT, () => {
    console.log(`\n✅ Vitrax backend running on port ${PORT}`);
    console.log('Scheduled signals: 00:00, 04:48, 09:36, 14:24, 19:12 daily');
    console.log('Emergency checks: every 10 minutes');
    console.log('Live price + trade management: every 30 seconds');
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
