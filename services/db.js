const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 5
    });
  }
  return pool;
}

// ── Initialize tables ─────────────────────────────────────────────────────────
async function initDB() {
  const p = getPool();
  if (!p) return; // No DB configured — skip silently

  await p.query(`
    CREATE TABLE IF NOT EXISTS analysis_history (
      id          SERIAL PRIMARY KEY,
      username    VARCHAR(50)   NOT NULL,
      user_name   VARCHAR(100)  NOT NULL,
      module      VARCHAR(20)   NOT NULL DEFAULT 'daily',
      report_names TEXT,
      analysis_text TEXT        NOT NULL,
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  // Index for fast user history lookups
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_history_user
    ON analysis_history (username, created_at DESC)
  `);
}

// ── Save an analysis ──────────────────────────────────────────────────────────
async function saveAnalysis({ username, userName, module = 'daily', reportNames, analysisText }) {
  const p = getPool();
  if (!p) return null;

  try {
    const res = await p.query(
      `INSERT INTO analysis_history (username, user_name, module, report_names, analysis_text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [username, userName, module, reportNames, analysisText]
    );
    return res.rows[0];
  } catch (err) {
    console.error('DB saveAnalysis error:', err.message);
    return null;
  }
}

// ── Get a user's history ──────────────────────────────────────────────────────
async function getHistory(username, limit = 30) {
  const p = getPool();
  if (!p) return [];

  try {
    const res = await p.query(
      `SELECT id, user_name, module, report_names, analysis_text, created_at
       FROM analysis_history
       WHERE username = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [username, limit]
    );
    return res.rows;
  } catch (err) {
    console.error('DB getHistory error:', err.message);
    return [];
  }
}

// ── Get recent daily analyses for trend engine ────────────────────────────────
async function getRecentDaily(username, days = 14) {
  const p = getPool();
  if (!p) return [];

  try {
    const res = await p.query(
      `SELECT id, report_names, analysis_text, created_at
       FROM analysis_history
       WHERE username = $1
         AND module = 'daily'
         AND created_at > NOW() - INTERVAL '${days} days'
       ORDER BY created_at DESC
       LIMIT 21`,
      [username]
    );
    return res.rows;
  } catch (err) {
    console.error('DB getRecentDaily error:', err.message);
    return [];
  }
}

// ── Get single analysis by ID ─────────────────────────────────────────────────
async function getAnalysisById(id, username) {
  const p = getPool();
  if (!p) return null;

  try {
    const res = await p.query(
      `SELECT * FROM analysis_history WHERE id = $1 AND username = $2`,
      [id, username]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('DB getAnalysisById error:', err.message);
    return null;
  }
}

module.exports = { initDB, saveAnalysis, getHistory, getRecentDaily, getAnalysisById };
