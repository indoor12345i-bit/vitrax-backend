// ════════════════════════════════════════════════════════════════════════
// DATABASE LAYER — PostgreSQL via Railway's built-in Postgres add-on
// ════════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');

// Railway auto-injects DATABASE_URL when you attach a Postgres service
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signals (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      signal_type VARCHAR(20) NOT NULL,      -- 'SCHEDULED' or 'EMERGENCY'
      label VARCHAR(10) NOT NULL,             -- 'BUY', 'SELL', 'WAIT'
      direction VARCHAR(20),
      strength VARCHAR(20),
      score INTEGER,
      entry_price DECIMAL(10,2),
      take_profit DECIMAL(10,2),
      take_profit_2 DECIMAL(10,2),
      stop_loss DECIMAL(10,2),
      current_sl DECIMAL(10,2),               -- moves with trailing stop
      atr DECIMAL(10,2),
      risk_reward DECIMAL(5,2),
      rsi DECIMAL(5,2),
      ema14 DECIMAL(10,2),
      ema25 DECIMAL(10,2),
      confidence INTEGER,
      fear_greed INTEGER,
      candle_pattern VARCHAR(50),
      session VARCHAR(20),
      whale_detected BOOLEAN,
      stop_hunt_detected BOOLEAN,
      is_choppy BOOLEAN,
      has_econ_event BOOLEAN,
      reasons TEXT,
      price_source VARCHAR(30),
      trade_status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, BREAKEVEN, TRAILING, CLOSED_WIN, CLOSED_LOSS, CLOSED_BE
      exit_price DECIMAL(10,2),
      closed_at TIMESTAMP,
      pnl DECIMAL(10,2)
    );

    CREATE TABLE IF NOT EXISTS price_log (
      id SERIAL PRIMARY KEY,
      logged_at TIMESTAMP DEFAULT NOW(),
      price DECIMAL(10,2),
      source VARCHAR(30)
    );

    CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(trade_status);
  `);

  // Add take_profit_2 column if it doesn't exist yet
  // (ALTER TABLE IF NOT EXISTS column is not standard SQL, so we catch the error)
  try {
    await pool.query(`ALTER TABLE signals ADD COLUMN take_profit_2 DECIMAL(10,2)`);
    console.log('✅ Added take_profit_2 column');
  } catch (e) {
    // Column already exists — ignore
  }

  // Add tp1_hit_at column if it doesn't exist yet -- needed so the daily
  // summary can tell WHEN a trade reached TP1, since TP1_HIT isn't a
  // "closed" status (the trade may still be running toward TP2) and was
  // previously invisible to any closed_at-based reporting entirely.
  try {
    await pool.query(`ALTER TABLE signals ADD COLUMN tp1_hit_at TIMESTAMP`);
    console.log('✅ Added tp1_hit_at column');
  } catch (e) {
    // Column already exists — ignore
  }

  console.log('✅ Database tables ready');
}

async function saveSignal(sig, type, priceSource) {
  const tradeStatus = sig.label === 'WAIT' ? 'WAIT' : 'OPEN';
  const result = await pool.query(`
    INSERT INTO signals (
      signal_type, label, direction, strength, score,
      entry_price, take_profit, take_profit_2, stop_loss, current_sl, atr, risk_reward,
      rsi, ema14, ema25, confidence, fear_greed, candle_pattern, session,
      whale_detected, stop_hunt_detected, is_choppy, has_econ_event,
      reasons, price_source, trade_status
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6::decimal, $7::decimal, $8::decimal, $9::decimal, $9::decimal, $10::decimal, $11::decimal,
      $12::decimal, $13::decimal, $14::decimal, $15, $16, $17, $18,
      $19, $20, $21, $22,
      $23, $24, $25
    )
    RETURNING *
  `, [
    type, sig.label, sig.direction, sig.strength, sig.score,
    sig.entry, sig.takeProfit, sig.takeProfit2, sig.stopLoss, sig.atr, sig.riskReward,
    sig.rsi, sig.ema14, sig.ema25, sig.confidence, sig.fearGreed,
    sig.candlePattern, sig.session, sig.whaleDetected, sig.stopHuntDetected,
    sig.isChoppy, sig.hasEconEvent, sig.reasons.join(' · '), priceSource, tradeStatus
  ]);
  return result.rows[0];
}

async function getLatestSignal() {
  const result = await pool.query(`
    SELECT * FROM signals ORDER BY created_at DESC LIMIT 1
  `);
  return result.rows[0] || null;
}

async function getSignalHistory(limit = 20) {
  const result = await pool.query(`
    SELECT * FROM signals ORDER BY created_at DESC LIMIT $1
  `, [limit]);
  return result.rows;
}

async function getOpenTrades() {
  const result = await pool.query(`
    SELECT * FROM signals WHERE trade_status IN ('OPEN','BREAKEVEN','TRAILING','TP1_HIT')
    ORDER BY created_at DESC
  `);
  return result.rows;
}

// ── Atomic TP1 check-and-set ────────────────────────────────────────────
// (kept for now in case older open trades still reference TP1/TP2 --
// safe to remove once every open trade has migrated to the single-TP model)
async function markTP1Hit(id, currentSL) {
  const result = await pool.query(`
    UPDATE signals
    SET trade_status = 'TP1_HIT',
        current_sl = COALESCE($2::decimal, current_sl),
        tp1_hit_at = NOW()
    WHERE id = $1
      AND trade_status != 'TP1_HIT'
      AND trade_status NOT LIKE 'CLOSED%'
    RETURNING id
  `, [id, currentSL]);
  return result.rows.length > 0;
}

// ── Atomic breakeven check-and-set ──────────────────────────────────────
// Same pattern as markTP1Hit -- only the first call for a given trade can
// ever match and update; every later call (even an overlapping one from a
// near-simultaneous check) matches nothing and returns false.
async function markBreakevenReached(id, newSL) {
  const result = await pool.query(`
    UPDATE signals
    SET trade_status = 'BREAKEVEN', current_sl = $2::decimal
    WHERE id = $1 AND trade_status = 'OPEN'
    RETURNING id
  `, [id, newSL]);
  return result.rows.length > 0;
}

// ── Atomic close (TP hit or SL hit) ─────────────────────────────────────
// Same idea again: WHERE trade_status NOT LIKE 'CLOSED%' means only the
// first call that reaches this can ever actually close the trade -- any
// later or overlapping call for the same trade finds it already closed
// and does nothing, so a close/alert can never double-fire.
async function markTradeClosed(id, status, currentSL, exitPrice, pnl) {
  const result = await pool.query(`
    UPDATE signals
    SET trade_status = $2, current_sl = COALESCE($3::decimal, current_sl),
        exit_price = $4::decimal, closed_at = NOW(), pnl = $5::decimal
    WHERE id = $1 AND trade_status NOT LIKE 'CLOSED%'
    RETURNING id
  `, [id, status, currentSL, exitPrice, pnl]);
  return result.rows.length > 0;
}

async function updateTradeStatus(id, status, currentSL, exitPrice, pnl) {
  await pool.query(`
    UPDATE signals
    SET trade_status = $2, current_sl = COALESCE($3::decimal, current_sl),
        exit_price = $4::decimal, closed_at = CASE WHEN $6 LIKE 'CLOSED%' THEN NOW() ELSE closed_at END,
        tp1_hit_at = CASE WHEN $6 = 'TP1_HIT' AND tp1_hit_at IS NULL THEN NOW() ELSE tp1_hit_at END,
        pnl = $5::decimal
    WHERE id = $1
  `, [id, status, currentSL, exitPrice, pnl, status]);
}

async function logPrice(price, source) {
  const numericPrice = Number(price);
  await pool.query(
    `INSERT INTO price_log (price, source) VALUES ($1::numeric, $2::varchar)`,
    [numericPrice, String(source)]
  );
}

async function getWinRate() {
  const TRACK_RECORD_START = process.env.TRACK_RECORD_START || '2026-07-02T10:39:00Z';

  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_WIN') as wins,
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_LOSS') as losses,
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_BE') as breakevens,
      COUNT(*) FILTER (WHERE trade_status LIKE 'CLOSED%') as total_closed,
      SUM(pnl) FILTER (WHERE trade_status LIKE 'CLOSED%') as total_pnl
    FROM signals WHERE label != 'WAIT' AND created_at >= $1::timestamptz
  `, [TRACK_RECORD_START]);
  const row = result.rows[0];
  const totalClosed = parseInt(row.total_closed) || 0;
  const wins = parseInt(row.wins) || 0;
  return {
    wins, losses: parseInt(row.losses) || 0, breakevens: parseInt(row.breakevens) || 0,
    totalClosed, totalPnl: parseFloat(row.total_pnl) || 0,
    winRate: totalClosed > 0 ? +((wins / totalClosed) * 100).toFixed(1) : null,
    trackRecordStart: TRACK_RECORD_START
  };
}

async function getPriceHistory(hours = 720) {
  const result = await pool.query(`
    SELECT price, logged_at FROM price_log
    WHERE logged_at > NOW() - INTERVAL '1 hour' * $1
    ORDER BY logged_at ASC
  `, [hours]);
  return result.rows;
}

// ── NEW: daily summary — every trade that CLOSED in the last N hours ────
// Used for the end-of-day Telegram report. A rolling lookback (not a fixed
// calendar-day boundary) so it always covers exactly "since the last time
// this ran," regardless of the exact hour the cron job fires at.
//
// UPDATE: also counts trades that hit TP1 today but haven't fully closed
// yet (still running toward TP2) as a win, using the TP1-level profit --
// these were previously invisible here entirely, since TP1_HIT isn't a
// "closed" status and this query only looked at closed_at before.
async function getDailySummary(hoursBack = 24) {
  const closedResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_WIN') as wins,
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_LOSS') as losses,
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_BE') as breakevens,
      COUNT(*) FILTER (WHERE trade_status LIKE 'CLOSED%') as total_closed,
      SUM(pnl) FILTER (WHERE trade_status LIKE 'CLOSED%') as total_pnl
    FROM signals
    WHERE trade_status LIKE 'CLOSED%'
      AND closed_at >= NOW() - INTERVAL '1 hour' * $1
  `, [hoursBack]);
  const c = closedResult.rows[0];

  const tp1Result = await pool.query(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(ABS(take_profit - entry_price)), 0) as pnl
    FROM signals
    WHERE trade_status = 'TP1_HIT'
      AND tp1_hit_at >= NOW() - INTERVAL '1 hour' * $1
  `, [hoursBack]);
  const t = tp1Result.rows[0];

  const closedWins = parseInt(c.wins) || 0;
  const closedTotal = parseInt(c.total_closed) || 0;
  const closedPnl = parseFloat(c.total_pnl) || 0;
  const tp1Count = parseInt(t.count) || 0;
  const tp1Pnl = parseFloat(t.pnl) || 0;

  return {
    wins: closedWins + tp1Count,
    losses: parseInt(c.losses) || 0,
    breakevens: parseInt(c.breakevens) || 0,
    totalClosed: closedTotal + tp1Count,
    totalPnl: closedPnl + tp1Pnl,
    stillRunningToTP2: tp1Count,
  };
}

module.exports = {
  pool, initDB, saveSignal, getLatestSignal, getSignalHistory,
  getOpenTrades, updateTradeStatus, logPrice, getWinRate, getPriceHistory,
  getDailySummary, markTP1Hit, markBreakevenReached, markTradeClosed
};
