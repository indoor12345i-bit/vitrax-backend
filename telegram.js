// ════════════════════════════════════════════════════════════════════════
// TELEGRAM NOTIFICATIONS — Vipertex Gold Signals
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
    `🎯 *TP1:*       $${parseFloat(sig.takeProfit).toFixed(2)}`,
    `🎯 *TP2:*       $${parseFloat(sig.takeProfit2).toFixed(2)}`,
    `🛑 *Stop Loss:* $${parseFloat(sig.stopLoss).toFixed(2)}`,
    ``,
    `📌 _When price reaches TP1, you can close your position or wait for TP2._`,
    `📌 _Always keep your stop loss active._`,
    ``,
    `⚠️ _Not financial advice. Always use stop loss._`,
  ].join('\n');

  await send(msg);
}

// ── Near TP1 — remind to move SL to entry ────────────────────────────
async function sendNearTP1Alert(tradeId, entry, tp1) {
  const msg = [
    `⚡ *ALMOST AT TP1* — Signal #${tradeId}`,
    ``,
    `Price is within $2 of Take Profit 1 at *$${parseFloat(tp1).toFixed(2)}*`,
    ``,
    `📌 *Move your stop loss to entry now: $${parseFloat(entry).toFixed(2)}*`,
    ``,
    `This ensures you exit at breakeven even if price reverses before hitting TP1.`,
  ].join('\n');

  await send(msg);
}

// ── Breakeven alert — SL moved to entry ──────────────────────────────
async function sendBreakevenAlert(tradeId, entry, newSL) {
  const msg = [
    `🔒 *MOVE YOUR STOP LOSS* — Signal #${tradeId}`,
    ``,
    `Price has moved in your favour.`,
    `*Move your stop loss to: $${parseFloat(newSL).toFixed(2)}*`,
    ``,
    `This locks in a breakeven trade — if price reverses now, you exit with no loss.`,
    ``,
    `📌 _Update your SL on your broker platform now._`,
  ].join('\n');

  await send(msg);
}

// ── TP1 hit ───────────────────────────────────────────────────────────
async function sendTP1Alert(tradeId, tp1, tp2) {
  const msg = [
    `🎯 *TP1 HIT* — Signal #${tradeId}`,
    ``,
    `Price reached *$${parseFloat(tp1).toFixed(2)}*`,
    ``,
    `✅ *You can close your position now and take profit.*`,
    ``,
    `Or if you want to go for TP2 at *$${parseFloat(tp2).toFixed(2)}*:`,
    `→ Make sure your stop loss is at breakeven`,
    `→ Only risk-free money stays in the trade`,
    ``,
    `📌 _Your choice — TP1 is already a winning trade._`,
  ].join('\n');

  await send(msg);
}

// ── TP2 hit ───────────────────────────────────────────────────────────
async function sendTP2Alert(tradeId, tp2) {
  const msg = [
    `🎯🎯 *TP2 HIT* — Signal #${tradeId}`,
    ``,
    `Price reached *$${parseFloat(tp2).toFixed(2)}*`,
    ``,
    `✅ *Close all positions now. Full target reached.*`,
    ``,
    `Well done. Wait for the next Vipertex signal.`,
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
    `🔒 *BREAKEVEN EXIT* — Signal #${tradeId}`,
    ``,
    `Price returned to your breakeven level at *$${parseFloat(entry).toFixed(2)}*`,
    ``,
    `*Close your position now — no loss, no gain.*`,
    ``,
    `Wait for the next Vipertex signal.`,
  ].join('\n');

  await send(msg);
}

module.exports = {
  sendSignalAlert,
  sendNearTP1Alert,
  sendBreakevenAlert,
  sendTP1Alert,
  sendTP2Alert,
  sendSLAlert,
  sendBreakevenSLAlert,
};
