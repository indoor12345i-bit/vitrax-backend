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
  console.log('✅ Database tables ready');
}

async function saveSignal(sig, type, priceSource) {
  const tradeStatus = sig.label === 'WAIT' ? 'WAIT' : 'OPEN';
  const result = await pool.query(`
    INSERT INTO signals (
      signal_type, label, direction, strength, score,
      entry_price, take_profit, stop_loss, current_sl, atr, risk_reward,
      rsi, ema14, ema25, confidence, fear_greed, candle_pattern, session,
      whale_detected, stop_hunt_detected, is_choppy, has_econ_event,
      reasons, price_source, trade_status
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6::decimal, $7::decimal, $8::decimal, $8::decimal, $9::decimal, $10::decimal,
      $11::decimal, $12::decimal, $13::decimal, $14, $15, $16, $17,
      $18, $19, $20, $21,
      $22, $23, $24
    )
    RETURNING *
  `, [
    type, sig.label, sig.direction, sig.strength, sig.score,
    sig.entry, sig.takeProfit, sig.stopLoss, sig.atr, sig.riskReward,
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
    SELECT * FROM signals WHERE trade_status IN ('OPEN','BREAKEVEN','TRAILING')
    ORDER BY created_at DESC
  `);
  return result.rows;
}

async function updateTradeStatus(id, status, currentSL, exitPrice, pnl) {
  await pool.query(`
    UPDATE signals
    SET trade_status = $2, current_sl = COALESCE($3::decimal, current_sl),
        exit_price = $4::decimal, closed_at = CASE WHEN $2 LIKE 'CLOSED%' THEN NOW() ELSE closed_at END,
        pnl = $5::decimal
    WHERE id = $1
  `, [id, status, currentSL, exitPrice, pnl]);
}

async function logPrice(price, source) {
  // Explicit numeric type cast on BOTH the value and ensuring source is
  // cast to its target type too - this resolves a documented node-postgres
  // issue (driver sends JS numbers as 'double precision' by default,
  // conflicting with the DECIMAL/numeric column type) that a single-side
  // cast doesn't always resolve, per github.com/brianc/node-postgres/issues/1205
  const numericPrice = Number(price);
  await pool.query(
    `INSERT INTO price_log (price, source) VALUES ($1::numeric, $2::varchar)`,
    [numericPrice, String(source)]
  );
}

async function getWinRate() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_WIN') as wins,
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_LOSS') as losses,
      COUNT(*) FILTER (WHERE trade_status = 'CLOSED_BE') as breakevens,
      COUNT(*) FILTER (WHERE trade_status LIKE 'CLOSED%') as total_closed,
      SUM(pnl) FILTER (WHERE trade_status LIKE 'CLOSED%') as total_pnl
    FROM signals WHERE label != 'WAIT'
  `);
  const row = result.rows[0];
  const totalClosed = parseInt(row.total_closed) || 0;
  const wins = parseInt(row.wins) || 0;
  return {
    wins, losses: parseInt(row.losses) || 0, breakevens: parseInt(row.breakevens) || 0,
    totalClosed, totalPnl: parseFloat(row.total_pnl) || 0,
    winRate: totalClosed > 0 ? +((wins / totalClosed) * 100).toFixed(1) : null
  };
}

async function getPriceHistory(hours = 720) {
  // 720 hours = 30 days, matches the chart's previous 30-day window
  const result = await pool.query(`
    SELECT price, logged_at FROM price_log
    WHERE logged_at > NOW() - INTERVAL '1 hour' * $1
    ORDER BY logged_at ASC
  `, [hours]);
  return result.rows;
}

module.exports = {
  pool, initDB, saveSignal, getLatestSignal, getSignalHistory,
  getOpenTrades, updateTradeStatus, logPrice, getWinRate, getPriceHistory
};
