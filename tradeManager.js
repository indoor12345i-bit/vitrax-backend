// ════════════════════════════════════════════════════════════════════════
// TRADE MANAGEMENT — single-target model: breakeven at $3.30, TP at $6,
// SL at $8 (flat, set by calculations.js at signal creation). Every state
// change below is atomic (see database.js) so a message can never fire
// twice for the same trade, no matter how it's called or how many times.
// ════════════════════════════════════════════════════════════════════════
const db       = require('./database');
const telegram = require('./telegram');

async function checkOpenTrades(currentPrice) {
  const openTrades = await db.getOpenTrades();

  for (const trade of openTrades) {
    const entry     = parseFloat(trade.entry_price);
    const tp        = parseFloat(trade.take_profit);
    const currentSL = parseFloat(trade.current_sl);
    const isBuy     = trade.label === 'BUY';

    // ── TP hit — single target, closes the trade completely ────────────
    const tpHit = isBuy ? currentPrice >= tp : currentPrice <= tp;
    if (tpHit) {
      const pnl = isBuy ? tp - entry : entry - tp;
      const wasFirstTime = await db.markTradeClosed(trade.id, 'CLOSED_WIN', currentSL, currentPrice, pnl);
      if (wasFirstTime) {
        console.log(`🎯 Trade #${trade.id} hit TP — closed WIN ($${pnl.toFixed(2)})`);
        await telegram.sendTPHitAlert(trade.id, tp, pnl);
      }
      continue;
    }

    // ── SL hit ────────────────────────────────────────────────────────
    const slHit = isBuy ? currentPrice <= currentSL : currentPrice >= currentSL;
    if (slHit) {
      const pnl = isBuy ? currentSL - entry : entry - currentSL;
      const isBreakevenExit = Math.abs(currentSL - entry) < 0.10;
      const status = isBreakevenExit ? 'CLOSED_BE' : (pnl >= 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS');

      const wasFirstTime = await db.markTradeClosed(trade.id, status, currentSL, currentPrice, pnl);
      if (wasFirstTime) {
        console.log(`🛑 Trade #${trade.id} hit SL ($${currentSL}) — ${status} ($${pnl.toFixed(2)})`);
        if (isBreakevenExit) {
          await telegram.sendBreakevenSLAlert(trade.id, entry);
        } else if (status === 'CLOSED_LOSS') {
          await telegram.sendSLAlert(trade.id, currentSL);
        }
      }
      continue;
    }

    // ── Move SL to breakeven once profit reaches $3.30 ──────────────────
    const progressDollars = isBuy ? (currentPrice - entry) : (entry - currentPrice);
    if (progressDollars >= 3.3 && trade.trade_status === 'OPEN') {
      const newSL = entry;
      const wasFirstTime = await db.markBreakevenReached(trade.id, newSL);
      if (wasFirstTime) {
        console.log(`✅ Trade #${trade.id} reached $3.30 — SL moved to breakeven ($${newSL})`);
        await telegram.sendBreakevenAlert(trade.id, entry, newSL, currentPrice);
      }
    }
  }
}

module.exports = { checkOpenTrades };
