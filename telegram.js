// ════════════════════════════════════════════════════════════════════════
// TELEGRAM NOTIFICATIONS — Vipertex Gold Signals
// Sends signal alerts to the Telegram channel when a real BUY or SELL
// passes the quality gate. WAIT signals are never sent to Telegram.
// ════════════════════════════════════════════════════════════════════════

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN || '8285392664:AAGi0-cATBXsh4YijfzlYjUWBUvNTtDGoPo';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1004449524229';

async function sendSignalAlert(sig) {
  if (!sig || sig.label === 'WAIT') return;

  const arrow     = sig.label === 'BUY' ? '🟢' : '🔴';
  const direction = sig.label === 'BUY' ? '▲ BUY' : '▼ SELL';
  const strength  = sig.strength ? sig.strength + ' ' : '';

  const message = [
    `${arrow} *VIPERTEX SIGNAL*`,
    ``,
    `*${strength}${direction}* — XAU/USD Gold`,
    ``,
    `💰 *Entry:*      $${parseFloat(sig.entry).toFixed(2)}`,
    `🎯 *TP1:*        $${parseFloat(sig.takeProfit).toFixed(2)}`,
    `🎯 *TP2:*        $${parseFloat(sig.takeProfit2).toFixed(2)}`,
    `🛑 *Stop Loss:*  $${parseFloat(sig.stopLoss).toFixed(2)}`,
    ``,
    `⚠️ _Always use stop loss. Not financial advice._`,
  ].join('\n');

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       message,
        parse_mode: 'Markdown',
      }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[TELEGRAM] ✅ Signal sent to channel — ${sig.label} at $${sig.entry}`);
    } else {
      console.error('[TELEGRAM] ❌ Failed:', data.description);
    }
  } catch (err) {
    console.error('[TELEGRAM] ❌ Error:', err.message);
  }
}

async function sendTPAlert(signalId, tp) {
  const message = [
    `🎯 *TP${tp} HIT* — Signal #${signalId}`,
    ``,
    tp === 1
      ? `Take Profit 1 reached. You can close your position now.`
      : `Take Profit 2 reached. Close all positions.`,
    ``,
    `⚠️ _Always use stop loss. Not financial advice._`,
  ].join('\n');

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       message,
        parse_mode: 'Markdown',
      }),
    });
    console.log(`[TELEGRAM] ✅ TP${tp} alert sent for signal #${signalId}`);
  } catch (err) {
    console.error('[TELEGRAM] ❌ TP alert error:', err.message);
  }
}

async function sendSLAlert(signalId) {
  const message = [
    `🛑 *STOP LOSS HIT* — Signal #${signalId}`,
    ``,
    `Exit your trade now to limit losses.`,
    `Wait for the next signal.`,
    ``,
    `⚠️ _Always use stop loss. Not financial advice._`,
  ].join('\n');

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       message,
        parse_mode: 'Markdown',
      }),
    });
    console.log(`[TELEGRAM] ✅ SL alert sent for signal #${signalId}`);
  } catch (err) {
    console.error('[TELEGRAM] ❌ SL alert error:', err.message);
  }
}

module.exports = { sendSignalAlert, sendTPAlert, sendSLAlert };
