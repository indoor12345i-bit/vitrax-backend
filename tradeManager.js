// ════════════════════════════════════════════════════════════════════════
// TRADE MANAGEMENT — breakeven + trailing stop, runs server-side every
// price check, completely independent of any browser being open
// ════════════════════════════════════════════════════════════════════════
const db = require('./database');

async function checkOpenTrades(currentPrice) {
  const openTrades = await db.getOpenTrades();

  for (const trade of openTrades) {
    const entry = parseFloat(trade.entry_price);
    const tp = parseFloat(trade.take_profit);
    const originalSL = parseFloat(trade.stop_loss);
    const currentSL = parseFloat(trade.current_sl);
    const isBuy = trade.label === 'BUY';

    // ── Check if TP hit first (full win) ──────────────────────────────
    const tpHit = isBuy ? currentPrice >= tp : currentPrice <= tp;
    if (tpHit) {
      const pnl = isBuy ? tp - entry : entry - tp;
      await db.updateTradeStatus(trade.id, 'CLOSED_WIN', currentSL, currentPrice, pnl);
      console.log(`🎯 Trade #${trade.id} hit TAKE PROFIT — closed WIN ($${pnl.toFixed(2)})`);
      continue;
    }

    // ── Check if current SL hit (could be original, breakeven, or trailing) ──
    const slHit = isBuy ? currentPrice <= currentSL : currentPrice >= currentSL;
    if (slHit) {
      const pnl = isBuy ? currentSL - entry : entry - currentSL;
      const status = Math.abs(pnl) < 0.5 ? 'CLOSED_BE' : (pnl > 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS');
      await db.updateTradeStatus(trade.id, status, currentSL, currentPrice, pnl);
      console.log(`🛑 Trade #${trade.id} hit stop ($${currentSL}) — closed ${status} ($${pnl.toFixed(2)})`);
      continue;
    }

    // ── Not closed yet — check if SL should move (breakeven / trailing) ──
    const tpDistance = Math.abs(tp - entry);
    const progress = isBuy
      ? (currentPrice - entry) / tpDistance
      : (entry - currentPrice) / tpDistance;

    if (progress >= 0.5) {
      const atr = parseFloat(trade.atr);
      const trailDistance = atr * 0.5;

      let newSL;
      if (progress >= 0.5 && trade.trade_status === 'OPEN') {
        // First time crossing 50% — move to breakeven
        newSL = entry;
        await db.updateTradeStatus(trade.id, 'BREAKEVEN', newSL, null, null);
        console.log(`✅ Trade #${trade.id} reached 50% — SL moved to breakeven ($${newSL})`);
      } else {
        // Already past breakeven — trail the stop
        newSL = isBuy
          ? Math.max(currentSL, currentPrice - trailDistance)
          : Math.min(currentSL, currentPrice + trailDistance);

        if (newSL !== currentSL) {
          await db.updateTradeStatus(trade.id, 'TRAILING', newSL, null, null);
          console.log(`📈 Trade #${trade.id} trailing stop moved to $${newSL.toFixed(2)}`);
        }
      }
    }
  }
}

module.exports = { checkOpenTrades };
