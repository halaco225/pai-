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

// ── Intel Tables ──────────────────────────────────────────────────────────────
async function initIntelDB() {
  const p = getPool();
  if (!p) return;

  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_dbs_metrics (
      id                      SERIAL PRIMARY KEY,
      store_id                VARCHAR(10)   NOT NULL,
      store_name              VARCHAR(100),
      area_coach              VARCHAR(100),
      region_coach            VARCHAR(100),
      territory_vp            VARCHAR(100),
      metric_date             DATE          NOT NULL,
      net_sales_day           DECIMAL(12,2),
      net_sales_wtd           DECIMAL(12,2),
      net_sales_ptd           DECIMAL(12,2),
      growth_pct_day          DECIMAL(8,4),
      growth_pct_wtd          DECIMAL(8,4),
      growth_pct_ptd          DECIMAL(8,4),
      production_lt15_day     DECIMAL(8,4),
      change_down_day         DECIMAL(10,2),
      allowance_pct_day       DECIMAL(8,4),
      discount_pct_day        DECIMAL(8,4),
      cancel_unmade_day       DECIMAL(10,2),
      changed_miles_day       DECIMAL(8,2),
      paidouts_day            DECIMAL(10,2),
      refunds_day             DECIMAL(10,2),
      cash_variance_day       DECIMAL(10,2),
      created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE(store_id, metric_date)
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_intel_metrics_store_date
    ON intel_dbs_metrics (store_id, metric_date DESC)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS store_assignments (
      store_id      VARCHAR(20)  NOT NULL,
      store_name    VARCHAR(100),
      area_coach    VARCHAR(100),
      region_coach  VARCHAR(100),
      vp            VARCHAR(100),
      updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (store_id)
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_store_assignments_ac
    ON store_assignments (area_coach)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_flags (
      id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id            VARCHAR(10)   NOT NULL,
      store_name          VARCHAR(100),
      area_coach          VARCHAR(100),
      region_coach        VARCHAR(100),
      territory_vp        VARCHAR(100),
      metric_type         VARCHAR(30)   NOT NULL,
      metric_date         DATE          NOT NULL,
      value               DECIMAL(12,4),
      target              DECIMAL(12,4),
      variance            DECIMAL(12,4),
      trend_direction     VARCHAR(20),
      consecutive_days_out INTEGER      DEFAULT 1,
      severity            VARCHAR(10)   NOT NULL,
      is_new              BOOLEAN       DEFAULT TRUE,
      status              VARCHAR(20)   DEFAULT 'open',
      source              VARCHAR(10)   DEFAULT 'DBS',
      tier                INTEGER       DEFAULT 1,
      details             JSONB,
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE(store_id, metric_type, metric_date)
    )
  `);

  // Migration: add updated_at if table was created before this column was added
  await p.query(`
    ALTER TABLE intel_flags
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  // Migration: dedup then add UNIQUE constraint (needed for ON CONFLICT in upsertIntelFlag)
  await p.query(`
    DELETE FROM intel_flags a
    USING intel_flags b
    WHERE a.id < b.id
      AND a.store_id    = b.store_id
      AND a.metric_type = b.metric_type
      AND a.metric_date = b.metric_date
  `);

  await p.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'intel_flags_store_metric_date_unique'
      ) THEN
        ALTER TABLE intel_flags
        ADD CONSTRAINT intel_flags_store_metric_date_unique
        UNIQUE (store_id, metric_type, metric_date);
      END IF;
    END $$
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_intel_flags_date_severity
    ON intel_flags (metric_date DESC, severity)
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_intel_flags_area
    ON intel_flags (area_coach, metric_date DESC)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_acknowledgments (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      flag_id         UUID        NOT NULL REFERENCES intel_flags(id),
      acknowledged_by VARCHAR(50) NOT NULL,
      role            VARCHAR(20) NOT NULL,
      action_taken    TEXT        NOT NULL,
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);


  await p.query(`
    CREATE TABLE IF NOT EXISTS dbs_soft_indicators (
      id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id    VARCHAR(10)   NOT NULL,
      metric_date DATE          NOT NULL,
      indicator   VARCHAR(50)   NOT NULL,
      value       DECIMAL(12,4),
      target      DECIMAL(12,4),
      source      VARCHAR(10)   DEFAULT 'DBS',
      updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE(store_id, metric_date, indicator)
    )
  `);


  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_shoutouts (
      id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id      VARCHAR(10)   NOT NULL,
      shoutout_date DATE          NOT NULL,
      summary       TEXT,
      full_comment  TEXT,
      source        VARCHAR(20),
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_intel_shoutouts_date
    ON intel_shoutouts (shoutout_date DESC)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_survey_log (
      id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id       VARCHAR(10)   NOT NULL,
      survey_date    DATE          NOT NULL,
      comment_count  INTEGER       DEFAULT 0,
      positive_count INTEGER       DEFAULT 0,
      negative_count INTEGER       DEFAULT 0,
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE(store_id, survey_date)
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_cache (
      id           SERIAL      PRIMARY KEY,
      user_id      VARCHAR(50) NOT NULL,
      cache_date   DATE        NOT NULL,
      cache_json   TEXT        NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, cache_date)
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS intel_automation_log (
      id               SERIAL PRIMARY KEY,
      job_type         VARCHAR(30)  NOT NULL,
      target_date      DATE,
      status           VARCHAR(20)  NOT NULL,
      stores_processed INTEGER      DEFAULT 0,
      flags_created    INTEGER      DEFAULT 0,
      message          TEXT,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_intel_log_date
    ON intel_automation_log (created_at DESC)
  `);
}

// ── Intel: upsert raw DBS metrics for a store/day ────────────────────────────
async function upsertDBSMetrics(record) {
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query(`
      INSERT INTO intel_dbs_metrics
        (store_id, store_name, area_coach, region_coach, territory_vp, metric_date,
         net_sales_day, net_sales_wtd, net_sales_ptd,
         growth_pct_day, growth_pct_wtd, growth_pct_ptd,
         production_lt15_day, change_down_day, allowance_pct_day,
         discount_pct_day, cancel_unmade_day, changed_miles_day,
         paidouts_day, refunds_day, cash_variance_day)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (store_id, metric_date) DO UPDATE SET
        store_name          = EXCLUDED.store_name,
        area_coach          = EXCLUDED.area_coach,
        region_coach        = EXCLUDED.region_coach,
        territory_vp        = EXCLUDED.territory_vp,
        net_sales_day       = EXCLUDED.net_sales_day,
        net_sales_wtd       = EXCLUDED.net_sales_wtd,
        net_sales_ptd       = EXCLUDED.net_sales_ptd,
        growth_pct_day      = EXCLUDED.growth_pct_day,
        growth_pct_wtd      = EXCLUDED.growth_pct_wtd,
        growth_pct_ptd      = EXCLUDED.growth_pct_ptd,
        production_lt15_day = EXCLUDED.production_lt15_day,
        change_down_day     = EXCLUDED.change_down_day,
        allowance_pct_day   = EXCLUDED.allowance_pct_day,
        discount_pct_day    = EXCLUDED.discount_pct_day,
        cancel_unmade_day   = EXCLUDED.cancel_unmade_day,
        changed_miles_day   = EXCLUDED.changed_miles_day,
        paidouts_day        = EXCLUDED.paidouts_day,
        refunds_day         = EXCLUDED.refunds_day,
        cash_variance_day   = EXCLUDED.cash_variance_day
      RETURNING id
    `, [
      record.store_id, record.store_name ?? null, record.area_coach ?? null,
      record.region_coach ?? null, record.territory_vp ?? null, record.metric_date,
      record.net_sales_day ?? null, record.net_sales_wtd ?? null, record.net_sales_ptd ?? null,
      record.growth_pct_day ?? null, record.growth_pct_wtd ?? null, record.growth_pct_ptd ?? null,
      record.production_lt15_day ?? null, record.change_down_day ?? null,
      record.allowance_pct_day ?? null, record.discount_pct_day ?? null,
      record.cancel_unmade_day ?? null, record.changed_miles_day ?? null,
      record.paidouts_day ?? null, record.refunds_day ?? null, record.cash_variance_day ?? null
    ]);
    return res.rows[0];
  } catch (err) {
    console.error('DB upsertDBSMetrics error:', err.message);
    return null;
  }
}

// ── Intel: upsert a flag ──────────────────────────────────────────────────────
async function upsertIntelFlag(flag) {
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query(`
      INSERT INTO intel_flags
        (store_id, store_name, area_coach, region_coach, territory_vp,
         metric_type, metric_date, value, target, variance,
         trend_direction, consecutive_days_out, severity, is_new,
         status, source, tier, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (store_id, metric_type, metric_date) DO UPDATE SET
        value               = EXCLUDED.value,
        target              = EXCLUDED.target,
        variance            = EXCLUDED.variance,
        trend_direction     = EXCLUDED.trend_direction,
        consecutive_days_out= EXCLUDED.consecutive_days_out,
        severity            = EXCLUDED.severity,
        is_new              = EXCLUDED.is_new,
        details             = EXCLUDED.details,
        updated_at          = NOW()
      RETURNING id
    `, [
      flag.store_id, flag.store_name ?? null, flag.area_coach ?? null,
      flag.region_coach ?? null, flag.territory_vp ?? null,
      flag.metric_type, flag.metric_date,
      flag.value ?? null, flag.target ?? null, flag.variance ?? null,
      flag.trend_direction ?? null, flag.consecutive_days_out ?? 1,
      flag.severity, flag.is_new ?? true,
      flag.status ?? 'open', flag.source ?? 'DBS', flag.tier ?? 1,
      flag.details ? JSON.stringify(flag.details) : null
    ]);
    return res.rows[0];
  } catch (err) {
    console.error('DB upsertIntelFlag error:', err.message);
    return null;
  }
}

// ── Intel: get active flags for a date/scope ─────────────────────────────────
// Accepts snake_case params matching how routes/intel.js calls this:
//   metric_date, region_coach, area_coach, area_coach_in, store_id, status
async function getIntelFlags({
  metric_date, region_coach, area_coach, area_coach_in, store_id, status,
  // legacy camelCase aliases (backwards compat)
  metricDate, regionCoach, areaCoach, storeId
} = {}) {
  const p = getPool();
  if (!p) return [];
  try {
    // Resolve aliases
    const date  = metric_date  || metricDate  || null;
    const rc    = region_coach || regionCoach || null;
    const ac    = area_coach   || areaCoach   || null;
    const sid   = store_id     || storeId     || null;
    const acIn  = area_coach_in || null;

    let query = 'SELECT * FROM intel_flags WHERE 1=1';
    const params = [];

    if (date)  { params.push(date);  query += ` AND metric_date = $${params.length}`; }
    if (rc)    { params.push(rc);    query += ` AND (region_coach = $${params.length} OR area_coach = $${params.length})`; }
    if (ac)    { params.push(ac);    query += ` AND area_coach = $${params.length}`; }
    if (acIn && acIn.length > 0) {
      params.push(acIn);
      query += ` AND (area_coach = ANY($${params.length}::text[]) OR region_coach = ANY($${params.length}::text[]))`;
    }
    if (sid)   { params.push(sid);   query += ` AND store_id = $${params.length}`; }
    if (status) { params.push(status); query += ` AND status != $${params.length}`; }
    else { query += ` AND status != 'archived'`; }

    query += ` ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, consecutive_days_out DESC`;
    const res = await p.query(query, params);
    return res.rows;
  } catch (err) {
    console.error('DB getIntelFlags error:', err.message);
    return [];
  }
}

// ── Intel: get recent metrics for a store (for consecutive day calculation) ──
async function getRecentDBSMetrics(storeId, fromDate, days = 7) {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query(`
      SELECT * FROM intel_dbs_metrics
      WHERE store_id = $1
        AND metric_date >= $2::date - ($3 || ' days')::interval
        AND metric_date <= $2
      ORDER BY metric_date DESC
    `, [storeId, fromDate, days]);
    return res.rows;
  } catch (err) {
    console.error('DB getRecentDBSMetrics error:', err.message);
    return [];
  }
}

// ── Intel: count consecutive prior days a flag existed ───────────────────────
async function getConsecutiveFlagDays(storeId, metricType, beforeDate) {
  const p = getPool();
  if (!p) return 0;
  try {
    const res = await p.query(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT metric_date,
               ROW_NUMBER() OVER (ORDER BY metric_date DESC) AS rn,
               ($1::date - metric_date)::int AS days_ago
        FROM intel_flags
        WHERE store_id = $2 AND metric_type = $3
          AND metric_date < $1
          AND status != 'archived'
      ) t WHERE days_ago = rn
    `, [beforeDate, storeId, metricType]);
    return parseInt(res.rows[0]?.cnt || 0, 10);
  } catch (err) {
    console.error('DB getConsecutiveFlagDays error:', err.message);
    return 0;
  }
}

// ── Intel: resolve flags that have come back into range ──────────────────────
async function resolveIntelFlags(storeIds, metricType, metricDate) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      UPDATE intel_flags
      SET status = 'resolved', trend_direction = 'recovering', updated_at = NOW()
      WHERE store_id = ANY($1)
        AND metric_type = $2
        AND metric_date < $3
        AND status = 'open'
    `, [storeIds, metricType, metricDate]);
  } catch (err) {
    console.error('DB resolveIntelFlags error:', err.message);
  }
}

// ── Store assignments (hierarchy lookup) ─────────────────────────────────────
async function upsertStoreAssignment({ store_id, store_name, area_coach, region_coach, vp }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO store_assignments (store_id, store_name, area_coach, region_coach, vp, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (store_id) DO UPDATE SET
        store_name   = EXCLUDED.store_name,
        area_coach   = EXCLUDED.area_coach,
        region_coach = EXCLUDED.region_coach,
        vp           = EXCLUDED.vp,
        updated_at   = NOW()
    `, [store_id, store_name ?? null, area_coach ?? null, region_coach ?? null, vp ?? null]);
  } catch (err) {
    console.error('DB upsertStoreAssignment error:', err.message);
  }
}

async function getStoreAssignments() {
  const p = getPool();
  if (!p) return {};
  try {
    const res = await p.query('SELECT * FROM store_assignments');
    const map = {};
    for (const r of res.rows) map[r.store_id] = r;
    return map;
  } catch (err) {
    console.error('DB getStoreAssignments error:', err.message);
    return {};
  }
}

// ── Intel: cache save/get ─────────────────────────────────────────────────────
async function saveIntelCache({ userId, cacheDate, cacheJson }) {
  return upsertIntelCache({ user_id: userId, cache_date: cacheDate, payload: cacheJson });
}

// upsertIntelCache — used by intel-pipeline.js
// Actual DB column is "payload" JSONB (table predates cache_json TEXT schema).
async function upsertIntelCache({ user_id, cache_date, role, payload }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO intel_cache (user_id, cache_date, role, payload, generated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, cache_date) DO UPDATE SET
        role         = EXCLUDED.role,
        payload      = EXCLUDED.payload,
        generated_at = NOW()
    `, [user_id, cache_date, role || null,
        typeof payload === 'string' ? payload : JSON.stringify(payload)]);
  } catch (err) {
    console.error('DB upsertIntelCache error:', err.message);
  }
}

async function getIntelCache({ userId, cacheDate }) {
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query(
      `SELECT payload, generated_at FROM intel_cache WHERE user_id = $1 AND cache_date = $2`,
      [userId, cacheDate]
    );
    if (!res.rows[0]) return null;
    const raw = res.rows[0].payload;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { data, generatedAt: res.rows[0].generated_at };
  } catch (err) {
    console.error('DB getIntelCache error:', err.message);
    return null;
  }
}

// ── Intel: automation log ─────────────────────────────────────────────────────
async function logIntelJob({ jobType, targetDate, status, storesProcessed, flagsCreated, message }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO intel_automation_log (job_type, target_date, status, stores_processed, flags_created, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [jobType, targetDate || null, status, storesProcessed || 0, flagsCreated || 0, message || null]
    );
  } catch (err) {
    console.error('DB logIntelJob error:', err.message);
  }
}

async function getIntelLogs(limit = 20) {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query(
      `SELECT * FROM intel_automation_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error('DB getIntelLogs error:', err.message);
    return [];
  }
}




// ── Intel: insert a shoutout (positive SMG comment) ─────────────────────────
async function insertShoutout({ store_id, shoutout_date, summary, full_comment, source }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO intel_shoutouts (store_id, shoutout_date, summary, full_comment, source)
      VALUES ($1, $2, $3, $4, $5)
    `, [store_id, shoutout_date, summary || null, full_comment || null, source || 'SMG']);
  } catch (err) {
    console.error('DB insertShoutout error:', err.message);
  }
}

// ── Intel: upsert daily survey log ──────────────────────────────────────────
async function upsertSurveyLog({ store_id, survey_date, comment_count, positive_count, negative_count }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO intel_survey_log (store_id, survey_date, comment_count, positive_count, negative_count, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (store_id, survey_date) DO UPDATE SET
        comment_count  = EXCLUDED.comment_count,
        positive_count = EXCLUDED.positive_count,
        negative_count = EXCLUDED.negative_count,
        updated_at     = NOW()
    `, [store_id, survey_date, comment_count || 0, positive_count || 0, negative_count || 0]);
  } catch (err) {
    console.error('DB upsertSurveyLog error:', err.message);
  }
}

// ── Intel: get stores with no recent surveys (for PUSH_SURVEYS flag) ─────────
async function getStoresWithNoRecentSurveys(allStoreIds, targetDate) {
  const p = getPool();
  if (!p) return [];
  try {
    const result = await p.query(`
      SELECT DISTINCT store_id FROM intel_survey_log
      WHERE survey_date >= ($1::date - INTERVAL '7 days')
        AND store_id = ANY($2)
    `, [targetDate, allStoreIds]);
    const hasRecent = new Set(result.rows.map(r => r.store_id));
    return allStoreIds.filter(id => !hasRecent.has(id));
  } catch (err) {
    console.error('DB getStoresWithNoRecentSurveys error:', err.message);
    return [];
  }
}

// ── Intel: resolve flags for a single store that has recovered ───────────────
async function resolveRecoveredFlags(storeId, metricType, metricDate) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      UPDATE intel_flags
      SET status = 'resolved', trend_direction = 'recovering', updated_at = NOW()
      WHERE store_id = $1
        AND metric_type = $2
        AND metric_date < $3
        AND status = 'open'
    `, [storeId, metricType, metricDate]);
  } catch (err) {
    console.error('DB resolveRecoveredFlags error:', err.message);
  }
}

// ── Intel: get soft indicators for a store over last N days ─────────────────
async function getStoreSoftIndicators(storeId, days) {
  const p = getPool();
  if (!p) return [];
  try {
    const result = await p.query(`
      SELECT * FROM dbs_soft_indicators
      WHERE store_id = $1
        AND metric_date >= (CURRENT_DATE - INTERVAL '1 day' * $2)
      ORDER BY metric_date DESC
    `, [storeId, days]);
    return result.rows;
  } catch (err) {
    console.error('DB getStoreSoftIndicators error:', err.message);
    return [];
  }
}

// ── Intel: upsert a DBS soft indicator ───────────────────────────────────────
async function upsertSoftIndicator({ store_id, metric_date, indicator, value, target, source }) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO dbs_soft_indicators (store_id, metric_date, indicator, value, target, source, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (store_id, metric_date, indicator) DO UPDATE SET
        value      = EXCLUDED.value,
        target     = EXCLUDED.target,
        updated_at = NOW()
    `, [store_id, metric_date, indicator, value ?? null, target ?? null, source || 'DBS']);
  } catch (err) {
    console.error('DB upsertSoftIndicator error:', err.message);
  }
}

// ── Intel: archive old resolved/recovering flags (cleanup) ───────────────────
async function archiveOldRecoveringFlags(targetDate) {
  const p = getPool();
  if (!p) return;
  try {
    // Archive flags resolved more than 7 days before targetDate
    await p.query(`
      UPDATE intel_flags
      SET status = 'archived', updated_at = NOW()
      WHERE status = 'resolved'
        AND metric_date < ($1::date - INTERVAL '7 days')
    `, [targetDate]);
  } catch (err) {
    console.error('DB archiveOldRecoveringFlags error:', err.message);
  }
}

// ── Seed store_assignments from velocity-alignment.js (all stores, all RDOs) ──
async function seedStoreAssignmentsFromAlignment() {
  const p = getPool();
  if (!p) return;
  try {
    let alignment = {};
    try { alignment = require('../services/velocity-alignment'); } catch(e) {
      try { alignment = require('./velocity-alignment'); } catch(e2) { return; }
    }
    let count = 0;
    for (const [key, info] of Object.entries(alignment)) {
      const store_id = key.replace(/^S/, '');
      await p.query(`
        INSERT INTO store_assignments (store_id, store_name, area_coach, region_coach, vp)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (store_id) DO UPDATE SET
          store_name   = EXCLUDED.store_name,
          area_coach   = EXCLUDED.area_coach,
          region_coach = EXCLUDED.region_coach,
          vp           = EXCLUDED.vp
      `, [store_id, info.name, info.area_coach, info.region_coach, info.vp]);
      count++;
    }
    console.log(`[DB] Seeded ${count} store assignments from alignment data`);
  } catch(err) {
    console.error('[DB] seedStoreAssignments error:', err.message);
  }
}

module.exports = {
  getPool,
  initDB, saveAnalysis, getHistory, getRecentDaily, getAnalysisById,
  saveAlignment, getAlignment, clearAlignment,
  saveRecapSession, getRecapSessions, getRecapSessionById,
  // Velocity exports
  initVelocityDB, upsertVelocityRecord, getVelocityRecords,
  getVelocityWeek, getVelocityWeeks, logVelocityJob, getVelocityLogs,
  getVelocityDOWTrends, getVelocityDOWDrill,
  // Intel exports
  initIntelDB, upsertDBSMetrics, upsertIntelFlag, getIntelFlags,
  getRecentDBSMetrics, getConsecutiveFlagDays, resolveIntelFlags,
  upsertStoreAssignment, getStoreAssignments,
  saveIntelCache, upsertIntelCache, getIntelCache, logIntelJob, getIntelLogs,
  // Aliases used by parsers
  insertIntelFlag: upsertIntelFlag,
  seedStoreAssignmentsFromAlignment,
  upsertSoftIndicator,
  insertShoutout, upsertSurveyLog, getStoresWithNoRecentSurveys,
  resolveRecoveredFlags, getStoreSoftIndicators,
  getConsecutiveDays: getConsecutiveFlagDays,
  archiveOldRecoveringFlags
};
