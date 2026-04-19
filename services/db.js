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

  await p.query(`
    CREATE TABLE IF NOT EXISTS alignment_data (
      id           SERIAL PRIMARY KEY,
      updated_by   VARCHAR(50)  NOT NULL,
      file_name    VARCHAR(255),
      content_text TEXT         NOT NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
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


// Persistent alignment — survives Render restarts (stored in PostgreSQL)
async function saveAlignment({ updatedBy, fileName, contentText }) {
  const p = getPool();
  if (p == null) return null;
  try {
    await p.query('DELETE FROM alignment_data');
    const res = await p.query(
      'INSERT INTO alignment_data (updated_by, file_name, content_text) VALUES ($1, $2, $3) RETURNING id, created_at',
      [updatedBy, fileName, contentText]
    );
    console.log('[Alignment] Saved to DB by', updatedBy);
    return res.rows[0];
  } catch (err) {
    console.error('DB saveAlignment error:', err.message);
    return null;
  }
}

async function getAlignment() {
  const p = getPool();
  if (p == null) return null;
  try {
    const res = await p.query(
      'SELECT id, updated_by, file_name, content_text, created_at FROM alignment_data ORDER BY created_at DESC LIMIT 1'
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('DB getAlignment error:', err.message);
    return null;
  }
}

async function clearAlignment() {
  const p = getPool();
  if (p == null) return;
  try {
    await p.query('DELETE FROM alignment_data');
    console.log('[Alignment] Cleared from DB');
  } catch (err) {
    console.error('DB clearAlignment error:', err.message);
  }
}

// (exports merged below)

// ── Velocity Tables ───────────────────────────────────────────────────────────
async function initVelocityDB() {
  const p = getPool();
  if (\!p) return;

  await p.query(`
    CREATE TABLE IF NOT EXISTS velocity_daily_records (
      id           SERIAL PRIMARY KEY,
      store_id     VARCHAR(10)   NOT NULL,
      record_date  DATE          NOT NULL,
      week_key     DATE          NOT NULL,
      period_week  VARCHAR(10),
      -- IST metrics (source: Above Store PDF — authoritative)
      ist_avg      DECIMAL(5,2),
      ist_lt10     INTEGER       DEFAULT 0,
      ist_1014     INTEGER       DEFAULT 0,
      ist_1518     INTEGER       DEFAULT 0,
      ist_1925     INTEGER       DEFAULT 0,
      ist_gt25     INTEGER       DEFAULT 0,
      ist_lt19_pct DECIMAL(5,2),
      total_orders INTEGER       DEFAULT 0,
      -- Secondary metrics (source: SOS Excel / Delivery Excel)
      make_time    VARCHAR(10),
      pct_lt4      DECIMAL(5,2),
      production_time VARCHAR(10),
      pct_lt15     DECIMAL(5,2),
      on_time_pct  DECIMAL(5,2),
      -- Metadata
      data_source  VARCHAR(20)   DEFAULT 'pdf',
      uploader     VARCHAR(100)  DEFAULT 'system',
      created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE(store_id, record_date)
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_velocity_date
    ON velocity_daily_records (record_date DESC)
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_velocity_store_date
    ON velocity_daily_records (store_id, record_date DESC)
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_velocity_week
    ON velocity_daily_records (week_key DESC)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS velocity_automation_log (
      id               SERIAL PRIMARY KEY,
      job_type         VARCHAR(30)  NOT NULL,
      target_date      DATE,
      status           VARCHAR(20)  NOT NULL,
      stores_processed INTEGER      DEFAULT 0,
      message          TEXT,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_velocity_log_date
    ON velocity_automation_log (created_at DESC)
  `);
}

// ── Velocity: upsert a single store/day record ────────────────────────────────
async function upsertVelocityRecord(record) {
  const p = getPool();
  if (\!p) return null;
  try {
    const res = await p.query(`
      INSERT INTO velocity_daily_records
        (store_id, record_date, week_key, period_week,
         ist_avg, ist_lt10, ist_1014, ist_1518, ist_1925, ist_gt25,
         ist_lt19_pct, total_orders,
         make_time, pct_lt4, production_time, pct_lt15, on_time_pct,
         data_source, uploader, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
      ON CONFLICT (store_id, record_date) DO UPDATE SET
        ist_avg        = COALESCE(EXCLUDED.ist_avg,        velocity_daily_records.ist_avg),
        ist_lt10       = COALESCE(EXCLUDED.ist_lt10,       velocity_daily_records.ist_lt10),
        ist_1014       = COALESCE(EXCLUDED.ist_1014,       velocity_daily_records.ist_1014),
        ist_1518       = COALESCE(EXCLUDED.ist_1518,       velocity_daily_records.ist_1518),
        ist_1925       = COALESCE(EXCLUDED.ist_1925,       velocity_daily_records.ist_1925),
        ist_gt25       = COALESCE(EXCLUDED.ist_gt25,       velocity_daily_records.ist_gt25),
        ist_lt19_pct   = COALESCE(EXCLUDED.ist_lt19_pct,   velocity_daily_records.ist_lt19_pct),
        total_orders   = COALESCE(EXCLUDED.total_orders,   velocity_daily_records.total_orders),
        make_time      = COALESCE(EXCLUDED.make_time,      velocity_daily_records.make_time),
        pct_lt4        = COALESCE(EXCLUDED.pct_lt4,        velocity_daily_records.pct_lt4),
        production_time= COALESCE(EXCLUDED.production_time,velocity_daily_records.production_time),
        pct_lt15       = COALESCE(EXCLUDED.pct_lt15,       velocity_daily_records.pct_lt15),
        on_time_pct    = COALESCE(EXCLUDED.on_time_pct,    velocity_daily_records.on_time_pct),
        data_source    = EXCLUDED.data_source,
        uploader       = EXCLUDED.uploader,
        updated_at     = NOW()
      RETURNING id
    `, [
      record.store_id, record.record_date, record.week_key, record.period_week,
      record.ist_avg ?? null, record.ist_lt10 ?? 0, record.ist_1014 ?? 0,
      record.ist_1518 ?? 0, record.ist_1925 ?? 0, record.ist_gt25 ?? 0,
      record.ist_lt19_pct ?? null, record.total_orders ?? 0,
      record.make_time ?? null, record.pct_lt4 ?? null,
      record.production_time ?? null, record.pct_lt15 ?? null,
      record.on_time_pct ?? null,
      record.data_source || 'pdf', record.uploader || 'system'
    ]);
    return res.rows[0];
  } catch (err) {
    console.error('DB upsertVelocityRecord error:', err.message);
    return null;
  }
}

// ── Velocity: get records for a date range ────────────────────────────────────
async function getVelocityRecords({ startDate, endDate, storeIds } = {}) {
  const p = getPool();
  if (\!p) return [];
  try {
    let query = `SELECT * FROM velocity_daily_records WHERE 1=1`;
    const params = [];
    if (startDate) { params.push(startDate); query += ` AND record_date >= $${params.length}`; }
    if (endDate)   { params.push(endDate);   query += ` AND record_date <= $${params.length}`; }
    if (storeIds?.length) { params.push(storeIds); query += ` AND store_id = ANY($${params.length})`; }
    query += ` ORDER BY record_date DESC, store_id`;
    const res = await p.query(query, params);
    return res.rows;
  } catch (err) {
    console.error('DB getVelocityRecords error:', err.message);
    return [];
  }
}

// ── Velocity: get WTD records for a week ─────────────────────────────────────
async function getVelocityWeek(weekKey) {
  const p = getPool();
  if (\!p) return [];
  try {
    const res = await p.query(
      `SELECT * FROM velocity_daily_records WHERE week_key = $1 ORDER BY record_date, store_id`,
      [weekKey]
    );
    return res.rows;
  } catch (err) {
    console.error('DB getVelocityWeek error:', err.message);
    return [];
  }
}

// ── Velocity: get all weeks that have data ────────────────────────────────────
async function getVelocityWeeks() {
  const p = getPool();
  if (\!p) return [];
  try {
    const res = await p.query(`
      SELECT week_key, period_week,
             COUNT(DISTINCT record_date) AS days_with_data,
             COUNT(DISTINCT store_id) AS store_count,
             MIN(record_date) AS first_day,
             MAX(record_date) AS last_day
      FROM velocity_daily_records
      GROUP BY week_key, period_week
      ORDER BY week_key DESC
    `);
    return res.rows;
  } catch (err) {
    console.error('DB getVelocityWeeks error:', err.message);
    return [];
  }
}

// ── Velocity: log automation job ─────────────────────────────────────────────
async function logVelocityJob({ jobType, targetDate, status, storesProcessed, message }) {
  const p = getPool();
  if (\!p) return;
  try {
    await p.query(
      `INSERT INTO velocity_automation_log (job_type, target_date, status, stores_processed, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobType, targetDate || null, status, storesProcessed || 0, message || null]
    );
  } catch (err) {
    console.error('DB logVelocityJob error:', err.message);
  }
}

// ── Velocity: get recent automation logs ─────────────────────────────────────
async function getVelocityLogs(limit = 20) {
  const p = getPool();
  if (\!p) return [];
  try {
    const res = await p.query(
      `SELECT * FROM velocity_automation_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error('DB getVelocityLogs error:', err.message);
    return [];
  }
}

// ── Velocity: DOW (day-of-week) trend query ───────────────────────────────────
async function getVelocityDOWTrends({ storeId, areaCoach, regionCoach, weeks = 8 } = {}) {
  const p = getPool();
  if (\!p) return [];
  try {
    // Build join with alignment data filter
    let whereClause = `WHERE record_date >= NOW() - INTERVAL '${weeks * 7} days'`;
    const params = [];
    // NOTE: filtering by area/region is done in JS using ALIGNMENT after query
    if (storeId) { params.push(storeId); whereClause += ` AND store_id = $${params.length}`; }

    const res = await p.query(`
      SELECT
        EXTRACT(DOW FROM record_date) AS dow,
        TO_CHAR(record_date, 'Dy') AS day_name,
        AVG(ist_avg) AS avg_ist,
        COUNT(*) AS sample_count
      FROM velocity_daily_records
      ${whereClause}
        AND ist_avg IS NOT NULL
      GROUP BY EXTRACT(DOW FROM record_date), TO_CHAR(record_date, 'Dy')
      ORDER BY dow
    `, params);
    return res.rows;
  } catch (err) {
    console.error('DB getVelocityDOWTrends error:', err.message);
    return [];
  }
}

module.exports = {
  initDB, saveAnalysis, getHistory, getRecentDaily, getAnalysisById,
  saveAlignment, getAlignment, clearAlignment,
  // Velocity exports
  initVelocityDB, upsertVelocityRecord, getVelocityRecords,
  getVelocityWeek, getVelocityWeeks, logVelocityJob, getVelocityLogs,
  getVelocityDOWTrends
};
