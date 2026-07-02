// ════════════════════════════════════════════════════════════════════════
// TRADE MANAGEMENT — breakeven + trailing stop + Telegram alerts
// Runs server-side every 30 seconds, independent of any browser
// ════════════════════════════════════════════════════════════════════════
const db       = require('./database');
const telegram = require('./telegram');

async function checkOpenTrades(currentPrice) {
  const openTrades = await db.getOpenTrades();

  for (const trade of openTrades) {
    const entry     = parseFloat(trade.entry_price);
    const tp1       = parseFloat(trade.take_profit);
    const tp2       = trade.take_profit_2 ? parseFloat(trade.take_profit_2) : null;
    const originalSL = parseFloat(trade.stop_loss);
    const currentSL  = parseFloat(trade.current_sl);
    const isBuy     = trade.label === 'BUY';

    // ── TP2 hit — full target reached ─────────────────────────────────
    if (tp2) {
      const tp2Hit = isBuy ? currentPrice >= tp2 : currentPrice <= tp2;
      if (tp2Hit) {
        const pnl = isBuy ? tp2 - entry : entry - tp2;
        await db.updateTradeStatus(trade.id, 'CLOSED_WIN', currentSL, currentPrice, pnl);
        console.log(`🎯🎯 Trade #${trade.id} hit TP2 — closed WIN ($${pnl.toFixed(2)})`);
        await telegram.sendTP2Alert(trade.id, tp2);
        continue;
      }
    }

    // ── TP1 hit — first target reached ────────────────────────────────
    const tp1Hit = isBuy ? currentPrice >= tp1 : currentPrice <= tp1;
    if (tp1Hit && trade.trade_status !== 'TP1_HIT' && trade.trade_status !== 'CLOSED_WIN') {
      // Mark as TP1 hit but keep trade open for TP2
      await db.updateTradeStatus(trade.id, 'TP1_HIT', currentSL, null, null);
      console.log(`🎯 Trade #${trade.id} hit TP1 at $${tp1}`);
      await telegram.sendTP1Alert(trade.id, tp1, tp2 || tp1);
      continue;
    }

    // ── SL hit ────────────────────────────────────────────────────────
    const slHit = isBuy ? currentPrice <= currentSL : currentPrice >= currentSL;
    if (slHit) {
      const pnl = isBuy ? currentSL - entry : entry - currentSL;
      const isBreakeven = Math.abs(currentSL - entry) < 0.10;
      const status = isBreakeven ? 'CLOSED_BE'
                   : pnl >= 0    ? 'CLOSED_WIN'
                   : 'CLOSED_LOSS';

      await db.updateTradeStatus(trade.id, status, currentSL, currentPrice, pnl);
      console.log(`🛑 Trade #${trade.id} hit SL ($${currentSL}) — ${status} ($${pnl.toFixed(2)})`);

      if (isBreakeven) {
        await telegram.sendBreakevenSLAlert(trade.id, entry);
      } else if (status === 'CLOSED_LOSS') {
        await telegram.sendSLAlert(trade.id, currentSL);
      }
      continue;
    }

    // ── Move SL to breakeven / trail ──────────────────────────────────
    const tpDistance = Math.abs(tp1 - entry);
    const progress   = isBuy
      ? (currentPrice - entry) / tpDistance
      : (entry - currentPrice) / tpDistance;

    if (progress >= 0.5) {
      const atr          = parseFloat(trade.atr);
      const trailDistance = atr * 0.5;

      if (trade.trade_status === 'OPEN') {
        // First time reaching 50% — move to breakeven
        const newSL = entry;
        await db.updateTradeStatus(trade.id, 'BREAKEVEN', newSL, null, null);
        console.log(`✅ Trade #${trade.id} reached 50% — SL moved to breakeven ($${newSL})`);
        await telegram.sendBreakevenAlert(trade.id, entry, newSL);

      } else if (trade.trade_status === 'BREAKEVEN' || trade.trade_status === 'TRAILING' || trade.trade_status === 'TP1_HIT') {
        // Already at breakeven — trail the stop
        const newSL = isBuy
          ? Math.max(currentSL, currentPrice - trailDistance)
          : Math.min(currentSL, currentPrice + trailDistance);

        if (Math.abs(newSL - currentSL) > 0.01) {
          await db.updateTradeStatus(trade.id, 'TRAILING', newSL, null, null);
          console.log(`📈 Trade #${trade.id} trailing SL → $${newSL.toFixed(2)}`);
        }
      }
    }

    // ── Close to TP1 — remind subscriber to move SL to entry ──────────
    // Fires when price is within $2 of TP1 and SL hasn't moved to entry yet
    const distanceToTP1 = isBuy ? tp1 - currentPrice : currentPrice - tp1;
    const slAtEntry = Math.abs(currentSL - entry) < 0.10;
    if (distanceToTP1 > 0 && distanceToTP1 <= 2 && !slAtEntry && trade.trade_status === 'OPEN') {
      console.log(`[TELEGRAM] Trade #${trade.id} is $${distanceToTP1.toFixed(2)} from TP1 — sending SL reminder`);
      await telegram.sendNearTP1Alert(trade.id, entry, tp1);
    }
  }
}
module.exports = { checkOpenTrades };
