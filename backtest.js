// ════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
//
// Walks forward through REAL historical 1h candles, one at a time, running
// the exact same calc.checkHighConfluence() logic that live Vipertex uses
// right now — same 6-vote threshold, same daily veto, same S&R/Volume
// Profile/Price Action, same session + weekend + open/close buffer rules
// (evaluated against each candle's own historical timestamp, not "now").
//
// At every point in the walk, only data UP TO AND INCLUDING that candle is
// visible to the logic — no lookahead. When a signal fires, we simulate
// forward through subsequent candles to see whether TP1, TP2, or SL was
// hit first, using each candle's real high/low.
//
// HONEST LIMITATIONS — these affect how much to trust the result:
//   1. Hourly resolution only. Live Vipertex scans every MINUTE using live
//      tick data; this backtest can only see what happened once per hour,
//      since that's the finest historical candle data available. It will
//      miss some intra-hour setups live scanning would catch, and can't
//      perfectly replicate the 30-min cooldown at 1h granularity.
//   2. No historical spread data. OHLC candles don't carry bid/ask, so the
//      spread filter is skipped entirely here — this backtest is slightly
//      more permissive than live trading on that one dimension.
//   3. The news blackout calendar only has real verified dates for July
//      2026. On earlier historical dates it simply won't have anything to
//      block — not a bug, just means that filter isn't being tested before
//      July 2026.
//   4. If a single candle's range touches both TP and SL in the same hour,
//      we assume SL was hit first (the pessimistic assumption) since OHLC
//      data alone can't tell us the true intra-hour sequence.
// ════════════════════════════════════════════════════════════════════════
const calc = require('./calculations');

const COOLDOWN_MS = 30 * 60 * 1000;
const MIN_1H_LOOKBACK = 100;   // ~4 days of hourly history before evaluating
const MIN_4H_LOOKBACK = 15;
const MIN_DAILY_LOOKBACK = 14;

async function runBacktest(candles1h, candles4h, candlesDaily, voteThreshold, tp1Override, tp2Override) {
  const threshold = voteThreshold || 6; // matches live default unless overridden
  if (!candles1h || candles1h.length < MIN_1H_LOOKBACK + 20) {
    return { error: `Not enough historical 1h candles — need at least ${MIN_1H_LOOKBACK + 20}, got ${candles1h ? candles1h.length : 0}` };
  }
  if (!candles4h || !candlesDaily) {
    return { error: 'Missing 4h or daily candle data — required for MTF analysis' };
  }

  const trades = [];
  let lastSignalTime = null;
  let skippedByFilter = { session: 0, cooldown: 0, belowThreshold: 0, insufficientMTF: 0 };

  // Forward-only pointers into the 4h/daily arrays — since every array is
  // chronologically ordered and we only ever move forward in time, we can
  // advance these once and never re-scan from the start. Turns what was
  // an O(n×m) re-filter on every single hourly candle into a simple O(n+m)
  // walk — this was almost certainly why the first version locked up the
  // whole single-threaded server long enough for Railway to consider it
  // unresponsive and restart it.
  let ptr4h = 0;
  let ptrDaily = 0;

  for (let i = MIN_1H_LOOKBACK; i < candles1h.length; i++) {
    const candle = candles1h[i];
    const candleTime = new Date(candle.time);

    // Enforce the same 30-minute cooldown real Vipertex uses
    if (lastSignalTime && (candleTime - lastSignalTime) < COOLDOWN_MS) {
      skippedByFilter.cooldown++;
      continue;
    }

    // Advance the 4h/daily pointers forward to just past this candle's time
    while (ptr4h < candles4h.length && new Date(candles4h[ptr4h].time) <= candleTime) ptr4h++;
    while (ptrDaily < candlesDaily.length && new Date(candlesDaily[ptrDaily].time) <= candleTime) ptrDaily++;
    const sub4h = candles4h.slice(0, ptr4h);
    const subDaily = candlesDaily.slice(0, ptrDaily);

    // Yield back to the event loop every 100 candles. This is a fully
    // synchronous CPU-bound loop otherwise — on a single-threaded Node
    // server that means it would completely block everything else
    // (health checks, the live 1-min confluence check, live price
    // updates) for however long the whole run takes. This keeps the
    // server responsive throughout instead of freezing solid.
    if (i % 100 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }

    // Build history up to and including this candle — no lookahead bias
    const subCandles = candles1h.slice(0, i + 1);
    const closes = subCandles.map(c => c.close);
    const highs = subCandles.map(c => c.high);
    const lows = subCandles.map(c => c.low);

    if (sub4h.length < MIN_4H_LOOKBACK || subDaily.length < MIN_DAILY_LOOKBACK) {
      skippedByFilter.insufficientMTF++;
      continue;
    }

    // Run the EXACT same confluence logic live Vipertex uses right now
    const hc = calc.checkHighConfluence(closes, highs, lows, subCandles, sub4h, subDaily, threshold, tp1Override, tp2Override);

    if (!hc || hc.belowThreshold || !hc.signal) {
      if (hc && hc.belowThreshold) skippedByFilter.belowThreshold++;
      continue;
    }

    // Apply session + weekend + open/close buffer using the CANDLE's own
    // historical timestamp — not "now". This is what makes the backtest
    // honest: a signal that would have been filtered out live (say, it's
    // 3am Asian session in the historical data) is filtered out here too.
    const sessionInfo = calc.detectSession(candleTime);
    const sessionCheck = calc.checkSessionTradable(sessionInfo, candleTime);
    if (!sessionCheck.ok) {
      skippedByFilter.session++;
      continue;
    }

    // Signal fires — use the levels checkHighConfluence already computed
    // (entry was the candle's own close, same value we'd use here anyway)
    const isBuy = hc.signal === 'BUY';
    const entry = hc.entry;
    const tp1 = hc.takeProfit;
    const tp2 = hc.takeProfit2;
    const sl = hc.stopLoss;

    let outcome = 'OPEN';
    let exitPrice = null;
    let hoursToResolve = 0;

    for (let j = i + 1; j < candles1h.length; j++) {
      const future = candles1h[j];
      hoursToResolve++;

      const hitSL  = isBuy ? future.low  <= sl  : future.high >= sl;
      const hitTP2 = isBuy ? future.high >= tp2 : future.low  <= tp2;
      const hitTP1 = isBuy ? future.high >= tp1 : future.low  <= tp1;

      // Pessimistic tie-break: if SL and a TP both fall within the same
      // candle's range, assume SL hit first — we can't know the true
      // intra-hour order from OHLC data alone, so we don't give the
      // backtest the benefit of the doubt.
      if (hitSL)  { outcome = 'SL';  exitPrice = sl;  break; }
      if (hitTP2) { outcome = 'TP2'; exitPrice = tp2; break; }
      if (hitTP1) { outcome = 'TP1'; exitPrice = tp1; break; }
    }

    if (outcome !== 'OPEN') {
      const pnl = isBuy ? (exitPrice - entry) : (entry - exitPrice);
      trades.push({
        time: candle.time,
        direction: hc.signal,
        entry: +entry.toFixed(2),
        tp1: +tp1.toFixed(2),
        tp2: +tp2.toFixed(2),
        sl: +sl.toFixed(2),
        outcome,
        exitPrice: +exitPrice.toFixed(2),
        pnl: +pnl.toFixed(2),
        confidence: hc.confidence,
        votes: `${Math.max(hc.bullVotes, hc.bearVotes)}/${hc.bullVotes + hc.bearVotes}`,
        hoursToResolve,
        session: sessionInfo.session,
      });
    }

    lastSignalTime = candleTime;
  }

  const tp1Hits = trades.filter(t => t.outcome === 'TP1').length;
  const tp2Hits = trades.filter(t => t.outcome === 'TP2').length;
  const slHits  = trades.filter(t => t.outcome === 'SL').length;
  const totalClosed = tp1Hits + tp2Hits + slHits;
  const totalPnl = +trades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2);

  return {
    voteThreshold: threshold,
    tp1Used: tp1Override || 7,
    tp2Used: tp2Override || 18,
    dataRange: {
      from: candles1h[MIN_1H_LOOKBACK].time,
      to: candles1h[candles1h.length - 1].time,
      total1hCandles: candles1h.length,
    },
    totalSignals: trades.length,
    tp1Hits, tp2Hits, slHits,
    winRate: totalClosed > 0 ? +(((tp1Hits + tp2Hits) / totalClosed) * 100).toFixed(1) : null,
    totalPnl,
    avgPnl: totalClosed > 0 ? +(totalPnl / totalClosed).toFixed(2) : null,
    buySignals: trades.filter(t => t.direction === 'BUY').length,
    sellSignals: trades.filter(t => t.direction === 'SELL').length,
    skippedByFilter,
    limitations: [
      'Hourly resolution only — live system scans every minute, this cannot see intra-hour setups',
      'Spread filter not applied — no historical bid/ask data available in OHLC candles',
      'News blackout only has verified real dates for July 2026 — earlier dates are untested against it',
      'SL/TP same-candle ties assume SL hit first (pessimistic, since exact intra-hour order is unknown)',
      'Assumes every trade closes the moment TP1 is touched — real subscribers can choose to hold for TP2 instead, which this simplified version does not model. This likely UNDERSTATES TP2 hits and total potential profit for anyone who holds longer.',
    ],
    trades, // full trade-by-trade log for manual inspection
  };
}

module.exports = { runBacktest };
