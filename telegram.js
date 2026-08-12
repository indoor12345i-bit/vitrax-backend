// ════════════════════════════════════════════════════════════════════════
// TELEGRAM NOTIFICATIONS — Vipertex Gold Signals
// Single-target model: TP $10, breakeven trigger $5.50, SL $15 (flat)
// ════════════════════════════════════════════════════════════════════════

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || '8285392664:AAGi0-cATBXsh4YijfzlYjUWBUvNTtDGoPo';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1004449524229';

async function send(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
    });
    const data = await res.json();
    if (data.ok) console.log('[TELEGRAM] ✅ Message sent');
    else console.error('[TELEGRAM] ❌ Failed:', data.description);
  } catch (err) {
    console.error('[TELEGRAM] ❌ Error:', err.message);
  }
}

// ── New signal ────────────────────────────────────────────────────────
// UPDATE: single TP now, TP2 removed entirely.
async function sendSignalAlert(sig) {
  if (!sig || sig.label === 'WAIT') return;
  const arrow    = sig.label === 'BUY' ? '🟢' : '🔴';
  const dir      = sig.label === 'BUY' ? '▲ BUY' : '▼ SELL';
  const strength = sig.strength ? sig.strength + ' ' : '';

  const msg = [
    `${arrow} *VIPERTEX SIGNAL*`,
    ``,
    `*${strength}${dir}* — XAU/USD Gold`,
    ``,
    `💰 *Entry:*     $${parseFloat(sig.entry).toFixed(2)}`,
    `🎯 *Target:*    $${parseFloat(sig.takeProfit).toFixed(2)}`,
    `🛑 *Stop Loss:* $${parseFloat(sig.stopLoss).toFixed(2)}`,
    ``,
    `📌 _Always keep your stop loss active._`,
    ``,
    `⚠️ _Not financial advice. Always use stop loss._`,
  ].join('\n');

  await send(msg);
}

// ── Breakeven alert — profit has reached $5.50 ─────────────────────────
async function sendBreakevenAlert(tradeId, entry, newSL, currentPrice) {
  const currentProfit = Math.abs(currentPrice - entry).toFixed(2);

  const msg = [
    `📈 *GOOD PROGRESS* — Signal #${tradeId}`,
    ``,
    `You're sitting on *$${currentProfit}* right now.`,
    ``,
    `✅ *Move your stop loss to entry: $${parseFloat(newSL).toFixed(2)}*`,
    `_Makes it impossible for this trade to turn into a loss from here, while staying in for the full target._`,
    ``,
    `Prefer to lock in exactly what you see right now instead? You can also just close and take the $${currentProfit}.`,
    ``,
    `📌 _Either is fine — moving your stop is the safer default._`,
  ].join('\n');

  await send(msg);
}

// ── TP hit — single target, this closes the trade completely ───────────
// Replaces the old sendTP1Alert / sendTP2Alert pair now that there's only
// one target. This is the LAST message for this trade -- nothing further
// mentions this signal number again once this fires.
async function sendTPHitAlert(tradeId, tp, pnl) {
  const msg = [
    `🎯 *TARGET HIT* — Signal #${tradeId}`,
    ``,
    `Price reached *$${parseFloat(tp).toFixed(2)}* — *+$${parseFloat(pnl).toFixed(2)}*`,
    ``,
    `✅ *Trade closed. Full target reached.*`,
    ``,
    `Well done. Watching for the next signal.`,
  ].join('\n');

  await send(msg);
}

// ── SL hit ────────────────────────────────────────────────────────────
async function sendSLAlert(tradeId, sl) {
  const msg = [
    `🛑 *STOP LOSS HIT* — Signal #${tradeId}`,
    ``,
    `Price hit *$${parseFloat(sl).toFixed(2)}*`,
    ``,
    `❌ *Close all positions immediately.*`,
    `Do not hold or average down.`,
    ``,
    `Wait for the next Vipertex signal.`,
    ``,
    `📌 _Stop losses exist to protect your account. This is normal._`,
  ].join('\n');

  await send(msg);
}

// ── Breakeven SL hit (price returned to entry after going up) ─────────
async function sendBreakevenSLAlert(tradeId, entry) {
  const msg = [
    `🔁 *BREAKEVEN EXIT* — Signal #${tradeId}`,
    ``,
    `Price returned to your breakeven level at *$${parseFloat(entry).toFixed(2)}*`,
    ``,
    `*Close your position now — no loss, no gain.*`,
    ``,
    `Wait for the next Vipertex signal.`,
  ].join('\n');

  await send(msg);
}

// ── Daily summary — reports in dollars (gold has no single standard
// "pip" size, so dollars is the unambiguous choice) ─────────────────────
// UPDATE: no more "still running toward TP2" note -- with a single
// target, every counted win is fully closed, no in-between state.
async function sendDailySummaryAlert(summary) {
  const { wins, losses, breakevens, totalClosed, totalPnl } = summary;

  if (totalClosed === 0) {
    await send([`📊 *DAILY SUMMARY*`, ``, `No trades closed today.`].join('\n'));
    return;
  }

  const arrow = totalPnl >= 0 ? '📈' : '📉';
  const sign  = totalPnl >= 0 ? '+' : '';

  const lines = [
    `📊 *DAILY SUMMARY*`,
    ``,
    `${arrow} *${sign}$${totalPnl.toFixed(2)}* today`,
    ``,
    `✅ Wins: ${wins}`,
    `🛑 Losses: ${losses}`,
  ];
  if (breakevens > 0) lines.push(`➖ Breakeven: ${breakevens}`);
  lines.push(``, `📋 Total: ${totalClosed}`);

  await send(lines.join('\n'));
}

module.exports = {
  send,
  sendSignalAlert,
  sendBreakevenAlert,
  sendTPHitAlert,
  sendSLAlert,
  sendBreakevenSLAlert,
  sendDailySummaryAlert,
};
