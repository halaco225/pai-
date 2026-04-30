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

  await p.query(`
    CREATE TABLE IF NOT EXISTS recap_sessions (
      id            SERIAL PRIMARY KEY,
      username      VARCHAR(50)  NOT NULL,
      file_names    TEXT,
      week_label    VARCHAR(100),
      analysis_json TEXT         NOT NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_recap_user
    ON recap_sessions (username, created_at DESC)
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
  if (!p) return;

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
  if (!p) return null;
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
  if (!p) return [];
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
  if (!p) return [];
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
  if (!p) return [];
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
  if (!p) return;
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
  if (!p) return [];
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

// ── Recap: save a session ─────────────────────────────────────────────────────
async function saveRecapSession({ username, fileNames, weekLabel, analysisJson }) {
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query(
      `INSERT INTO recap_sessions (username, file_names, week_label, analysis_json)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [username, fileNames || '', weekLabel || '', analysisJson]
    );
    return res.rows[0];
  } catch (err) {
    console.error('DB saveRecapSession error:', err.message);
    return null;
  }
}

async function getRecapSessions(username, limit = 10) {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query(
      `SELECT id, file_names, week_label, created_at
       FROM recap_sessions WHERE username = $1
       ORDER BY created_at DESC LIMIT $2`,
      [username, limit]
    );
    return res.rows;
  } catch (err) {
    console.error('DB getRecapSessions error:', err.message);
    return [];
  }
}

async function getRecapSessionById(id, username) {
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query(
      `SELECT * FROM recap_sessions WHERE id = $1 AND username = $2`,
      [id, username]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('DB getRecapSessionById error:', err.message);
    return null;
  }
}

// ── Velocity: DOW (day-of-week) trend query ───────────────────────────────────
async function getVelocityDOWTrends({ storeId, areaCoach, regionCoach, weeks = 8 } = {}) {
  const p = getPool();
  if (!p) return [];
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

// ── Velocity: DOW drill — raw records for a specific day-of-week ─────────────
async function getVelocityDOWDrill({ dow, weeks = 12 } = {}) {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query(`
      SELECT store_id, record_date, week_key, period_week, ist_avg
      FROM velocity_daily_records
      WHERE EXTRACT(DOW FROM record_date) = $1
        AND record_date >= NOW() - INTERVAL '${weeks * 7} days'
        AND ist_avg IS NOT NULL
      ORDER BY record_date ASC
    `, [dow]);
    return res.rows;
  } catch (err) {
    console.error('DB getVelocityDOWDrill error:', err.message);
    return [];
  }
}

// add intel exports
module.exports = {
  getPool,
  initDB, saveAnalysis, getHistory, getRecentDaily, getAnalysisById,
  saveAlignment, getAlignment, clearAlignment,
  saveRecapSession, getRecapSessions, getRecapSessionById,
  // Velocity exports
  initVelocityDB, upsertVelocityRecord, getVelocityRecords,
  getVelocityWeek, getVelocityWeeks, logVelocityJob, getVelocityLogs,
  getVelocityDOWTrends, getVelocityDOWDrill
};

// ── Intel Tables ─────────────────────────────────────────────────────────────
async function initIntelDB() {
  const p = getPool();
  if (!p) return;

  // Store hierarchy — populated by DBS parser on every run
  await p.query(`
    CREATE TABLE IF NOT EXISTS store_assignments (
      store_id     VARCHAR(10) PRIMARY KEY,
      store_name   VARCHAR(100),
      area_coach   VARCHAR(100),
      region_coach VARCHAR(100),
      vp           VARCHAR(100),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Core flag table
  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_flags (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id             VARCHAR(10) NOT NULL,
      store_name           VARCHAR(100),
      area_coach           VARCHAR(100),
      region_coach         VARCHAR(100),
      territory_vp         VARCHAR(100),
      metric_type          VARCHAR(50) NOT NULL,
      metric_date          DATE NOT NULL,
      value                DECIMAL(12,4),
      target               DECIMAL(12,4),
      variance             DECIMAL(12,4),
      source               VARCHAR(30),
      tier                 INTEGER DEFAULT 1,
      details              JSONB,
      trend_direction      VARCHAR(20) DEFAULT 'stable_out',
      consecutive_days_out INTEGER DEFAULT 1,
      severity             VARCHAR(10) DEFAULT 'low',
      is_new               BOOLEAN DEFAULT TRUE,
      status               VARCHAR(20) DEFAULT 'open',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_intel_flags_date   ON intel_flags (metric_date DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_intel_flags_store  ON intel_flags (store_id, metric_date DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_intel_flags_area   ON intel_flags (area_coach, metric_date DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_intel_flags_region ON intel_flags (region_coach, metric_date DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_intel_flags_status ON intel_flags (status, metric_date DESC)`);

  // Acknowledgments from area coaches
  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_acknowledgments (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      flag_id          UUID NOT NULL,
      acknowledged_by  VARCHAR(100) NOT NULL,
      role             VARCHAR(30),
      action_taken     TEXT NOT NULL,
      acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_intel_ack_flag ON intel_acknowledgments (flag_id)`);

  // Cached per-user intel payload (keyed by user_id + date)
  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_cache (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      VARCHAR(100) NOT NULL,
      cache_date   DATE NOT NULL,
      role         VARCHAR(30),
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload      JSONB NOT NULL,
      UNIQUE(user_id, cache_date)
    )
  `);

  // Survey tracking (SMG — detect stores with no surveys)
  await p.query(`
    CREATE TABLE IF NOT EXISTS store_survey_log (
      id             SERIAL PRIMARY KEY,
      store_id       VARCHAR(10) NOT NULL,
      survey_date    DATE NOT NULL,
      comment_count  INTEGER DEFAULT 0,
      positive_count INTEGER DEFAULT 0,
      negative_count INTEGER DEFAULT 0,
      UNIQUE(store_id, survey_date)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_survey_log_date  ON store_survey_log (survey_date DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_survey_log_store ON store_survey_log (store_id, survey_date DESC)`);

  // Positive shout-outs (SMG — displayed on store cards, not flags)
  await p.query(`
    CREATE TABLE IF NOT EXISTS store_shoutouts (
      id            SERIAL PRIMARY KEY,
      store_id      VARCHAR(10) NOT NULL,
      shoutout_date DATE NOT NULL,
      summary       TEXT NOT NULL,
      full_comment  TEXT,
      source        VARCHAR(30),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_shoutouts_store ON store_shoutouts (store_id, shoutout_date DESC)`);

  // Soft indicator tracking (for stacked Tier 2 flags)
  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_soft_indicators (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id    VARCHAR(10) NOT NULL,
      metric_date DATE NOT NULL,
      indicator   VARCHAR(50) NOT NULL,
      value       DECIMAL(12,4),
      target      DECIMAL(12,4),
      source      VARCHAR(30),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(store_id, metric_date, indicator)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_soft_store_date ON intel_soft_indicators (store_id, metric_date DESC)`);
}

// ── Intel DB helpers ──────────────────────────────────────────────────────────

async function upsertStoreAssignment({ store_id, store_name, area_coach, region_coach, vp }) {
  const p = getPool(); if (!p) return;
  await p.query(`
    INSERT INTO store_assignments (store_id, store_name, area_coach, region_coach, vp, updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW())
    ON CONFLICT (store_id) DO UPDATE SET
      store_name   = EXCLUDED.store_name,
      area_coach   = EXCLUDED.area_coach,
      region_coach = EXCLUDED.region_coach,
      vp           = EXCLUDED.vp,
      updated_at   = NOW()
  `, [store_id, store_name, area_coach, region_coach, vp]);
}

async function getStoreAssignments() {
  const p = getPool(); if (!p) return {};
  const res = await p.query('SELECT * FROM store_assignments');
  const map = {};
  for (const r of res.rows) map[r.store_id] = r;
  return map;
}

async function insertIntelFlag(flag) {
  const p = getPool(); if (!p) return null;
  try {
    const res = await p.query(`
      INSERT INTO intel_flags
        (store_id, store_name, area_coach, region_coach, territory_vp,
         metric_type, metric_date, value, target, variance,
         source, tier, details, trend_direction, consecutive_days_out,
         severity, is_new, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id
    `, [
      flag.store_id, flag.store_name || null, flag.area_coach || null,
      flag.region_coach || null, flag.territory_vp || null,
      flag.metric_type, flag.metric_date,
      flag.value ?? null, flag.target ?? null, flag.variance ?? null,
      flag.source || null, flag.tier ?? 1,
      flag.details ? JSON.stringify(flag.details) : null,
      flag.trend_direction || 'stable_out',
      flag.consecutive_days_out || 1,
      flag.severity || 'low',
      flag.is_new !== false,
      flag.status || 'open'
    ]);
    return res.rows[0].id;
  } catch (err) {
    console.error('[Intel DB] insertIntelFlag error:', err.message);
    return null;
  }
}

async function getConsecutiveDays(store_id, metric_type, metric_date) {
  const p = getPool(); if (!p) return 0;
  // Count how many consecutive days before metric_date this store had this flag
  const res = await p.query(`
    SELECT consecutive_days_out FROM intel_flags
    WHERE store_id = $1 AND metric_type = $2
      AND metric_date = $3::date - INTERVAL '1 day'
      AND status != 'resolved'
    ORDER BY created_at DESC LIMIT 1
  `, [store_id, metric_type, metric_date]);
  return res.rows[0] ? parseInt(res.rows[0].consecutive_days_out) : 0;
}

async function resolveRecoveredFlags(store_id, metric_type, metric_date) {
  const p = getPool(); if (!p) return;
  // Mark yesterday's flag as recovering if today the metric is in range
  await p.query(`
    UPDATE intel_flags SET status = 'resolved', trend_direction = 'recovering'
    WHERE store_id = $1 AND metric_type = $2
      AND metric_date = $3::date - INTERVAL '1 day'
      AND status = 'open'
  `, [store_id, metric_type, metric_date]);
}

async function archiveOldRecoveringFlags(before_date) {
  const p = getPool(); if (!p) return;
  // Archive recovering flags older than 1 day
  await p.query(`
    UPDATE intel_flags SET status = 'archived'
    WHERE status = 'resolved' AND trend_direction = 'recovering'
      AND metric_date < $1::date - INTERVAL '1 day'
  `, [before_date]);
}

async function upsertSurveyLog({ store_id, survey_date, comment_count, positive_count, negative_count }) {
  const p = getPool(); if (!p) return;
  await p.query(`
    INSERT INTO store_survey_log (store_id, survey_date, comment_count, positive_count, negative_count)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (store_id, survey_date) DO UPDATE SET
      comment_count  = EXCLUDED.comment_count,
      positive_count = EXCLUDED.positive_count,
      negative_count = EXCLUDED.negative_count
  `, [store_id, survey_date, comment_count, positive_count, negative_count]);
}

async function getStoresWithNoRecentSurveys(scope_store_ids, check_date) {
  const p = getPool(); if (!p) return [];
  // Stores that had no surveys yesterday OR day before
  const res = await p.query(`
    SELECT DISTINCT store_id FROM store_assignments
    WHERE store_id = ANY($1)
      AND store_id NOT IN (
        SELECT store_id FROM store_survey_log
        WHERE survey_date >= $2::date - INTERVAL '1 day'
          AND survey_date <= $2::date
          AND comment_count > 0
      )
  `, [scope_store_ids, check_date]);
  return res.rows.map(r => r.store_id);
}

async function insertShoutout({ store_id, shoutout_date, summary, full_comment, source }) {
  const p = getPool(); if (!p) return;
  try {
    await p.query(`
      INSERT INTO store_shoutouts (store_id, shoutout_date, summary, full_comment, source)
      VALUES ($1,$2,$3,$4,$5)
    `, [store_id, shoutout_date, summary, full_comment || null, source || null]);
  } catch (err) {
    console.error('[Intel DB] insertShoutout error:', err.message);
  }
}

async function upsertSoftIndicator({ store_id, metric_date, indicator, value, target, source }) {
  const p = getPool(); if (!p) return;
  await p.query(`
    INSERT INTO intel_soft_indicators (store_id, metric_date, indicator, value, target, source)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (store_id, metric_date, indicator) DO UPDATE SET
      value = EXCLUDED.value, target = EXCLUDED.target
  `, [store_id, metric_date, indicator, value, target, source]);
}

async function getStoreSoftIndicators(store_id, days = 3) {
  const p = getPool(); if (!p) return [];
  const res = await p.query(`
    SELECT indicator, metric_date, value, target, source
    FROM intel_soft_indicators
    WHERE store_id = $1 AND metric_date >= NOW()::date - INTERVAL '${days} days'
    ORDER BY metric_date DESC
  `, [store_id]);
  return res.rows;
}

async function getIntelFlags({ metric_date, region_coach, area_coach, store_id, status } = {}) {
  const p = getPool(); if (!p) return [];
  let q = 'SELECT * FROM intel_flags WHERE 1=1';
  const params = [];
  if (metric_date) { params.push(metric_date); q += ` AND metric_date = $${params.length}`; }
  if (region_coach) { params.push(region_coach); q += ` AND region_coach = $${params.length}`; }
  if (area_coach) { params.push(area_coach); q += ` AND area_coach = $${params.length}`; }
  if (store_id) { params.push(store_id); q += ` AND store_id = $${params.length}`; }
  if (status) { params.push(status); q += ` AND status = $${params.length}`; }
  q += ' ORDER BY severity DESC, consecutive_days_out DESC, created_at DESC';
  const res = await p.query(q, params);
  return res.rows;
}

async function getIntelCache(user_id, cache_date) {
  const p = getPool(); if (!p) return null;
  const res = await p.query(
    'SELECT payload FROM intel_cache WHERE user_id=$1 AND cache_date=$2',
    [user_id, cache_date]
  );
  return res.rows[0]?.payload || null;
}

async function upsertIntelCache({ user_id, cache_date, role, payload }) {
  const p = getPool(); if (!p) return;
  await p.query(`
    INSERT INTO intel_cache (user_id, cache_date, role, payload, generated_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (user_id, cache_date) DO UPDATE SET
      role = EXCLUDED.role, payload = EXCLUDED.payload, generated_at = NOW()
  `, [user_id, cache_date, role, JSON.stringify(payload)]);
}

async function getAcknowledgments({ flag_id, region_coach, area_coach } = {}) {
  const p = getPool(); if (!p) return [];
  let q = `
    SELECT a.*, f.store_id, f.store_name, f.area_coach, f.region_coach,
           f.metric_type, f.metric_date, f.severity, f.value, f.target, f.status
    FROM intel_acknowledgments a
    JOIN intel_flags f ON f.id = a.flag_id
    WHERE 1=1
  `;
  const params = [];
  if (flag_id) { params.push(flag_id); q += ` AND a.flag_id = $${params.length}`; }
  if (region_coach) { params.push(region_coach); q += ` AND f.region_coach = $${params.length}`; }
  if (area_coach) { params.push(area_coach); q += ` AND f.area_coach = $${params.length}`; }
  q += ' ORDER BY a.acknowledged_at DESC';
  const res = await p.query(q, params);
  return res.rows;
}

// ── Intel exports (added after initIntelDB was defined post-module.exports) ──
Object.assign(module.exports, {
  initIntelDB,
  upsertStoreAssignment, getStoreAssignments,
  insertIntelFlag, getConsecutiveDays, resolveRecoveredFlags, archiveOldRecoveringFlags,
  upsertSurveyLog, getStoresWithNoRecentSurveys,
  insertShoutout,
  upsertSoftIndicator, getStoreSoftIndicators,
  getIntelFlags, getIntelCache, upsertIntelCache, getAcknowledgments
});
