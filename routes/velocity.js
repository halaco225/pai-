// =====================================================================
// VELOCITY ROUTES — /api/velocity/*
// Full Speed of Service module for PAi
// =====================================================================
'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const router   = express.Router();

const { requireAuth } = require('../middleware/auth');
const db = require('../services/db');
const { ALIGNMENT, REGIONS, AREAS, AREA_COACHES } = require('../services/velocity-alignment');
const { parseAboveStorePDF, parseSOSExcel, parseDeliveryExcel, parseSOSExcelODS } = require('../services/velocity-parser');
const { getWeekKey, getPeriodWeek, getWeekDateRange, getYesterdayChicago, computeWTD, analyzeDOWPatterns, FISCAL_CALENDAR } = require('../services/velocity-compute');
const { generateExcelExport } = require('../services/velocity-export');
const { sendDailyEmails } = require('../services/velocity-email');

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── POST /api/velocity/automation/pull-ods — 5AM cron trigger ────────
router.post('/automation/pull-ods', async (req, res) => {
  // Verify automation token
  const token = req.headers['x-automation-token'] || req.query.token;
  if (token !== (process.env.VELOCITY_AUTOMATION_TOKEN || 'velocity-auto-2024')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const targetDate = req.body.date || req.query.date || getYesterdayChicago();
  console.log(`[Velocity ODS] Pull triggered for ${targetDate}`);

  // Respond immediately so cron doesn't timeout, then run async
  res.json({ status: 'started', targetDate });

  try {
    const { pullAboveStoreReport } = require('../services/velocity-ods');
    const pullResult = await pullAboveStoreReport(targetDate);

    if (!pullResult.success) throw new Error(pullResult.error);

    const parsed = pullResult.format === 'xlsx'
      ? parseSOSExcelODS(pullResult.filePath)
      : await parseAboveStorePDF(pullResult.filePath);
    try { fs.unlinkSync(pullResult.filePath); } catch(e){}

    if (!parsed.stores?.length) throw new Error('No store data in report');

    const weekKey  = getWeekKey(targetDate);
    const periodWk = getPeriodWeek(targetDate);
    let saved = 0;

    for (const s of parsed.stores) {
      if (!ALIGNMENT[s.store_id]) continue;
      await db.upsertVelocityRecord({
        store_id: s.store_id, record_date: targetDate,
        week_key: weekKey, period_week: periodWk,
        ist_avg: s.ist_avg,
        ist_lt10: s.ist_lt10 ?? 0, ist_1014: s.ist_1014 ?? 0,
        ist_1518: s.ist_1518 ?? 0, ist_1925: s.ist_1925 ?? 0, ist_gt25: s.ist_gt25 ?? 0,
        ist_lt19_pct: s.ist_lt19_pct ?? null,
        total_orders: s.total_orders ?? 0,
        make_time: s.make_time ?? null, pct_lt4: s.pct_lt4 ?? null,
        production_time: s.production_time ?? null, pct_lt15: s.pct_lt15 ?? null,
        on_time_pct: s.on_time_pct ?? null,
        data_source: parsed.source, uploader: 'system'
      });
      saved++;
    }

    await db.logVelocityJob({ jobType: 'ods_pull', targetDate, status: 'success', storesProcessed: saved, message: `Pulled ${saved} stores` });
    console.log(`[Velocity ODS] Done — ${saved} stores saved for ${targetDate}`);
  } catch (e) {
    console.error('[Velocity ODS] Error:', e.message);
    await db.logVelocityJob({ jobType: 'ods_pull', targetDate, status: 'failed', message: e.message });
  }
});

// ── POST /api/velocity/automation/send-emails — 7AM cron trigger ─────
router.post('/automation/send-emails', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.query.token;
  if (token !== (process.env.VELOCITY_AUTOMATION_TOKEN || 'velocity-auto-2024')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const targetDate = req.body.date || req.query.date || getYesterdayChicago();
  const weekKey    = getWeekKey(targetDate);

  try {
    const records = await db.getVelocityWeek(weekKey);
    if (!records.length) {
      return res.status(404).json({ error: `No data for week containing ${targetDate}` });
    }

    const enriched = records.map(r => ({
      ...r,
      record_date: r.record_date instanceof Date ? r.record_date.toISOString().split('T')[0] : String(r.record_date).split('T')[0],
      ...(ALIGNMENT[r.store_id] || {})
    }));

    const wtdStores  = computeWTD(enriched);
    const periodWeek = enriched[0]?.period_week || getPeriodWeek(weekKey);
    const dailyByDate = {};
    for (const r of enriched) {
      const d = r.record_date;
      if (!dailyByDate[d]) dailyByDate[d] = [];
      dailyByDate[d].push(r);
    }

    const excelBuffer = await generateExcelExport({ weekKey, periodWeek, wtdStores, dailyByDate });
    const emailResults = await sendDailyEmails(wtdStores, targetDate, excelBuffer);

    await db.logVelocityJob({
      jobType: 'send_emails', targetDate, status: 'success',
      storesProcessed: wtdStores.length,
      message: `Sent ${emailResults.sent.length}, failed ${emailResults.failed.length}`
    });

    res.json({ success: true, targetDate, emailResults });
  } catch (e) {
    console.error('[Velocity Email] Error:', e.message);
    await db.logVelocityJob({ jobType: 'send_emails', targetDate, status: 'failed', message: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/velocity/automation/status — last job runs ──────────────
router.get('/automation/status', async (req, res) => {
  try {
    const logs = await db.getVelocityLogs(20);
    res.json({ logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/velocity/debug-run — unauthenticated, one-shot trigger ────────
router.get('/debug-run', (req, res) => {
  const { spawn } = require('child_process');
  const scriptPath = require('path').join(__dirname, '..', 'scripts', 'velocity-ods-debug.js');
  res.json({ ok: true, msg: 'Debug script started — output in ~60s at /debug-output.json' });
  const child = spawn('node', [scriptPath], { env: process.env, detached: true, stdio: 'ignore' });
  child.unref();
});


// ── GET /api/velocity/run-backfill — unauthenticated, one-shot backfill trigger ──
router.get('/run-backfill', (req, res) => {
  const { spawn } = require('child_process');
  const scriptPath = require('path').join(__dirname, '..', 'scripts', 'velocity-backfill.js');
  const env = Object.assign({}, process.env, {
    PAI_BASE_URL: 'https://pai-ayvaz.onrender.com',
    VELOCITY_AUTOMATION_TOKEN: process.env.VELOCITY_AUTOMATION_TOKEN || 'velocity-auto-2024'
  });
  res.json({ ok: true, msg: 'Backfill started — P1-P3 historical data loading. Monitor at /api/velocity/automation/status' });
  const child = spawn('node', [scriptPath], { env, detached: true, stdio: 'ignore' });
  child.unref();
});


// ── GET /api/velocity/diag — env + DB table check ─────────────────────────
router.get('/diag', async (req, res) => {
  const info = {
    ODS_USER:     process.env.ODS_USER     || '(not set)',
    ODS_ORG:      process.env.ODS_ORG      || '(not set)',
    ODS_PASSWORD: process.env.ODS_PASSWORD ? '(set, ' + process.env.ODS_PASSWORD.length + ' chars)' : '(NOT SET)',
    VELOCITY_AUTOMATION_TOKEN: process.env.VELOCITY_AUTOMATION_TOKEN ? '(set)' : '(not set — using default)',
    tables: {}
  };
  try {
    const p = require('../services/db').pool || null;
    const { Pool } = require('pg');
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    for (const t of ['velocity_daily_records','velocity_automation_log']) {
      try {
        const r = await pool2.query('SELECT COUNT(*) FROM ' + t);
        info.tables[t] = parseInt(r.rows[0].count) + ' rows';
      } catch(e) { info.tables[t] = 'ERROR: ' + e.message; }
    }
    await pool2.end();
  } catch(e) { info.db_error = e.message; }
  res.json(info);
});


// ── GET /api/velocity/init-db — force create velocity tables ──────────────
router.get('/init-db', async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS velocity_daily_records (
        id           SERIAL PRIMARY KEY,
        store_id     VARCHAR(10)   NOT NULL,
        record_date  DATE          NOT NULL,
        week_key     DATE          NOT NULL,
        period_week  VARCHAR(10),
        ist_avg      DECIMAL(5,2),
        ist_lt10     INTEGER       DEFAULT 0,
        ist_1014     INTEGER       DEFAULT 0,
        ist_1518     INTEGER       DEFAULT 0,
        ist_1925     INTEGER       DEFAULT 0,
        ist_gt25     INTEGER       DEFAULT 0,
        ist_lt19_pct DECIMAL(5,2),
        total_orders INTEGER       DEFAULT 0,
        make_time    VARCHAR(10),
        pct_lt4      DECIMAL(5,2),
        production_time VARCHAR(10),
        pct_lt15     DECIMAL(5,2),
        on_time_pct  DECIMAL(5,2),
        data_source  VARCHAR(20)   DEFAULT 'pdf',
        uploader     VARCHAR(100)  DEFAULT 'system',
        created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE(store_id, record_date)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_velocity_date ON velocity_daily_records (record_date DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_velocity_store_date ON velocity_daily_records (store_id, record_date DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_velocity_week ON velocity_daily_records (week_key DESC)`);
    await pool.query(`
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_velocity_log_date ON velocity_automation_log (created_at DESC)`);
    const r1 = await pool.query('SELECT COUNT(*) FROM velocity_daily_records');
    const r2 = await pool.query('SELECT COUNT(*) FROM velocity_automation_log');
    await pool.end();
    res.json({ ok: true, velocity_daily_records: r1.rows[0].count + ' rows', velocity_automation_log: r2.rows[0].count + ' rows' });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// All other velocity routes require session auth
router.use(requireAuth);

// ── GET /api/velocity/meta — hierarchy + available filters ───────────
router.get('/meta', (req, res) => {
  res.json({ regions: REGIONS, areas: AREAS, area_coaches: AREA_COACHES,
    store_count: Object.keys(ALIGNMENT).length });
});

// ── GET /api/velocity/weeks — available weeks in DB ──────────────────
router.get('/weeks', async (req, res) => {
  try {
    const weeks = await db.getVelocityWeeks();
    res.json({ weeks: weeks.map(w => ({
      week_key: w.week_key instanceof Date ? w.week_key.toISOString().split('T')[0] : String(w.week_key).split('T')[0],
      period_week: w.period_week,
      days_with_data: parseInt(w.days_with_data),
      store_count: parseInt(w.store_count),
      first_day: w.first_day instanceof Date ? w.first_day.toISOString().split('T')[0] : String(w.first_day).split('T')[0],
      last_day: w.last_day instanceof Date ? w.last_day.toISOString().split('T')[0] : String(w.last_day).split('T')[0],
      date_range: getWeekDateRange(w.week_key instanceof Date ? w.week_key.toISOString().split('T')[0] : String(w.week_key).split('T')[0])
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/velocity/wtd?week=YYYY-MM-DD — WTD data for a week ──────
router.get('/wtd', async (req, res) => {
  try {
    let weekKey = req.query.week;
    if (!weekKey) weekKey = getWeekKey(getYesterdayChicago());

    const records = await db.getVelocityWeek(weekKey);
    if (!records.length) return res.json({ weekKey, stores: [], days: [] });

    // Enrich records with alignment data
    const enriched = records.map(r => {
      const dateStr = r.record_date instanceof Date ? r.record_date.toISOString().split('T')[0] : String(r.record_date).split('T')[0];
      const align = ALIGNMENT[r.store_id] || {};
      return { ...r, record_date: dateStr, ...align };
    });

    const wtdStores = computeWTD(enriched);

    // Build unique days list
    const days = [...new Set(enriched.map(r => r.record_date))].sort();

    res.json({
      weekKey,
      periodWeek: enriched[0]?.period_week || getPeriodWeek(weekKey),
      dateRange: getWeekDateRange(weekKey),
      stores: wtdStores,
      days,
      storeCount: wtdStores.length
    });
  } catch (e) {
    console.error('[Velocity] WTD error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/velocity/day?date=YYYY-MM-DD — single day data ──────────
router.get('/day', async (req, res) => {
  try {
    const date = req.query.date || getYesterdayChicago();
    const records = await db.getVelocityRecords({ startDate: date, endDate: date });

    const stores = records.map(r => {
      const align = ALIGNMENT[r.store_id] || {};
      return {
        store_id: r.store_id,
        name: align.name || r.store_id,
        area: align.area || '',
        area_coach: align.area_coach || '',
        region_coach: align.region_coach || '',
        ist_avg: r.ist_avg ? parseFloat(r.ist_avg) : null,
        ist_lt10: r.ist_lt10, ist_1014: r.ist_1014,
        ist_1518: r.ist_1518, ist_1925: r.ist_1925, ist_gt25: r.ist_gt25,
        ist_lt19_pct: r.ist_lt19_pct ? parseFloat(r.ist_lt19_pct) : null,
        total_orders: r.total_orders,
        make_time: r.make_time, pct_lt4: r.pct_lt4,
        production_time: r.production_time, pct_lt15: r.pct_lt15
      };
    });

    res.json({ date, stores, storeCount: stores.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/velocity/trends?weeks=8&store=S039xxx — period trends ────
router.get('/trends', async (req, res) => {
  try {
    const weeksBack = parseInt(req.query.weeks) || 8;
    const storeId   = req.query.store || null;
    const areaCoach = req.query.area_coach || null;
    const region    = req.query.region || null;
    const groupBy   = req.query.group_by || null; // 'region' or 'area_coach'

    const endDate   = getYesterdayChicago();
    const startDate = (() => {
      const d = new Date(endDate + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - weeksBack * 7);
      return d.toISOString().split('T')[0];
    })();

    let records = await db.getVelocityRecords({ startDate, endDate });

    // Apply filters using alignment
    if (storeId)   records = records.filter(r => r.store_id === storeId);
    if (areaCoach) records = records.filter(r => (ALIGNMENT[r.store_id]?.area_coach) === areaCoach);
    if (region)    records = records.filter(r => (ALIGNMENT[r.store_id]?.region_coach) === region);

    // Grouped response: one series per region or area_coach
    if (groupBy) {
      const groups = {};
      for (const r of records) {
        const al  = ALIGNMENT[r.store_id] || {};
        const key = groupBy === 'region' ? al.region_coach : al.area_coach;
        if (!key) continue;
        if (!groups[key]) groups[key] = { label: key, region: al.region_coach, byWeek: {} };
        const wk = r.week_key instanceof Date ? r.week_key.toISOString().split('T')[0] : String(r.week_key).split('T')[0];
        if (!groups[key].byWeek[wk]) groups[key].byWeek[wk] = [];
        groups[key].byWeek[wk].push(r);
      }
      const allWeeks = [...new Set(Object.values(groups).flatMap(g => Object.keys(g.byWeek)))].sort();
      const result = Object.values(groups).map(g => {
        const weeks = allWeeks.map(wk => {
          const recs  = g.byWeek[wk] || [];
          const valid = recs.filter(r => r.ist_avg != null);
          return {
            week_key:    wk,
            period_week: recs[0]?.period_week || getPeriodWeek(wk),
            date_range:  getWeekDateRange(wk),
            avg_ist: valid.length ? Math.round(valid.reduce((a,r)=>a+parseFloat(r.ist_avg),0)/valid.length*10)/10 : null
          };
        });
        for (let i = 1; i < weeks.length; i++) {
          const prev = weeks[i-1].avg_ist, curr = weeks[i].avg_ist;
          weeks[i].delta = (prev != null && curr != null) ? Math.round((curr-prev)*10)/10 : null;
        }
        return { label: g.label, region: g.region, weeks };
      });
      result.sort((a,b) => (a.region||a.label).localeCompare(b.region||b.label) || a.label.localeCompare(b.label));
      return res.json({ groups: result, allWeeks });
    }

    // Single-series response (existing behaviour)
    const byWeek = {};
    for (const r of records) {
      const wk = r.week_key instanceof Date ? r.week_key.toISOString().split('T')[0] : String(r.week_key).split('T')[0];
      if (!byWeek[wk]) byWeek[wk] = [];
      byWeek[wk].push({ ...r, ...(ALIGNMENT[r.store_id] || {}) });
    }

    const weekTrends = Object.entries(byWeek)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([wk, recs]) => {
        const valid = recs.filter(r => r.ist_avg != null);
        return {
          week_key: wk,
          period_week: recs[0]?.period_week || getPeriodWeek(wk),
          date_range: getWeekDateRange(wk),
          avg_ist: valid.length ? Math.round(valid.reduce((a,r) => a+parseFloat(r.ist_avg),0)/valid.length*10)/10 : null,
          store_count: [...new Set(recs.map(r=>r.store_id))].length,
          total_orders: recs.reduce((a,r)=>a+(r.total_orders||0),0)
        };
      });

    for (let i = 1; i < weekTrends.length; i++) {
      const prev = weekTrends[i-1].avg_ist;
      const curr = weekTrends[i].avg_ist;
      weekTrends[i].delta = (prev != null && curr != null) ? Math.round((curr-prev)*10)/10 : null;
    }

    res.json({ weeks: weekTrends, storeCount: storeId ? 1 : [...new Set(records.map(r=>r.store_id))].length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/velocity/dow-trends — day-of-week patterns ──────────────
router.get('/dow-trends', async (req, res) => {
  try {
    const storeId   = req.query.store      || null;
    const areaCoach = req.query.area_coach || null;
    const region    = req.query.region     || null;
    const groupBy   = req.query.group_by   || null; // 'region' or 'area_coach'

    // Fast path: no filters, no groupBy — use SQL aggregate
    if (!areaCoach && !region && !groupBy) {
      const dowRows = await db.getVelocityDOWTrends({ storeId, weeks: 12 });
      return res.json({ patterns: analyzeDOWPatterns(dowRows) });
    }

    // Fetch raw records for filtering / grouping
    const endDate   = getYesterdayChicago();
    const startDate = (() => {
      const d = new Date(endDate + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 84); // 12 weeks
      return d.toISOString().split('T')[0];
    })();

    let records = await db.getVelocityRecords({ startDate, endDate });
    if (storeId)   records = records.filter(r => r.store_id === storeId);
    if (areaCoach) records = records.filter(r => (ALIGNMENT[r.store_id]?.area_coach) === areaCoach);
    if (region)    records = records.filter(r => (ALIGNMENT[r.store_id]?.region_coach) === region);
    records = records.filter(r => r.ist_avg != null);

    const DOW_NAMES_LOCAL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // Grouped response: one DOW pattern set per region or area_coach
    if (groupBy) {
      const groups = {};
      for (const r of records) {
        const al  = ALIGNMENT[r.store_id] || {};
        const key = groupBy === 'region' ? al.region_coach : al.area_coach;
        if (!key) continue;
        if (!groups[key]) groups[key] = { label: key, region: al.region_coach, byDow: {} };
        const d   = r.record_date instanceof Date ? r.record_date : new Date(r.record_date + 'T12:00:00Z');
        const dow = d.getUTCDay();
        if (!groups[key].byDow[dow]) groups[key].byDow[dow] = [];
        groups[key].byDow[dow].push(parseFloat(r.ist_avg));
      }
      const result = Object.values(groups).map(g => {
        const dowRows = Object.entries(g.byDow).map(([dow, vals]) => ({
          dow: parseInt(dow), day_name: DOW_NAMES_LOCAL[parseInt(dow)],
          avg_ist: vals.reduce((a,v)=>a+v,0)/vals.length,
          sample_count: vals.length
        }));
        return { label: g.label, region: g.region, patterns: analyzeDOWPatterns(dowRows) };
      });
      result.sort((a,b) => (a.region||a.label).localeCompare(b.region||b.label) || a.label.localeCompare(b.label));
      return res.json({ groups: result });
    }

    // Non-grouped with filters (existing behaviour)
    const byDOW = {};
    for (const r of records) {
      const d   = r.record_date instanceof Date ? r.record_date : new Date(r.record_date + 'T12:00:00Z');
      const dow = d.getUTCDay();
      if (!byDOW[dow]) byDOW[dow] = { dow, day_name: DOW_NAMES_LOCAL[dow], vals: [] };
      byDOW[dow].vals.push(parseFloat(r.ist_avg));
    }
    const dowRows = Object.values(byDOW).map(d => ({
      dow: d.dow, day_name: d.day_name,
      avg_ist: d.vals.reduce((a, v) => a + v, 0) / d.vals.length,
      sample_count: d.vals.length
    }));
    res.json({ patterns: analyzeDOWPatterns(dowRows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/velocity/dow-drill?dow=N&weeks=12 — week-over-week for one DOW ──
router.get('/dow-drill', async (req, res) => {
  try {
    const dow      = parseInt(req.query.dow);
    const weeks    = parseInt(req.query.weeks) || 12;
    const storeId  = req.query.store      || null;
    const areaCoach = req.query.area_coach || null;
    const region   = req.query.region     || null;

    const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    let records = await db.getVelocityDOWDrill({ dow, weeks });

    if (storeId)   records = records.filter(r => r.store_id === storeId);
    if (areaCoach) records = records.filter(r => (ALIGNMENT[r.store_id]?.area_coach) === areaCoach);
    if (region)    records = records.filter(r => (ALIGNMENT[r.store_id]?.region_coach) === region);

    // Group by week_key, aggregate avg IST
    const byWeek = {};
    for (const r of records) {
      const wk = r.week_key instanceof Date ? r.week_key.toISOString().split('T')[0] : String(r.week_key).split('T')[0];
      if (!byWeek[wk]) byWeek[wk] = { vals: [], period_week: r.period_week };
      byWeek[wk].vals.push(parseFloat(r.ist_avg));
    }

    const weekData = Object.entries(byWeek)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([wk, d]) => ({
        week_key: wk,
        period_week: d.period_week,
        date_range: getWeekDateRange(wk),
        avg_ist: Math.round(d.vals.reduce((a,v)=>a+v,0)/d.vals.length*10)/10,
        sample_count: d.vals.length
      }));

    for (let i = 1; i < weekData.length; i++) {
      const prev = weekData[i-1].avg_ist;
      const curr = weekData[i].avg_ist;
      weekData[i].delta = (prev != null && curr != null) ? Math.round((curr-prev)*10)/10 : null;
    }

    res.json({ dow, day_name: DOW_NAMES[dow] || `DOW ${dow}`, weeks: weekData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/velocity/insights?area_coach=X — AI coaching analysis ───
router.get('/insights', async (req, res) => {
  try {
    const areaCoach = req.query.area_coach;
    const region    = req.query.region;
    const weeksBack = 4;

    const endDate   = getYesterdayChicago();
    const startDate = (() => {
      const d = new Date(endDate + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - weeksBack * 7);
      return d.toISOString().split('T')[0];
    })();

    let records = await db.getVelocityRecords({ startDate, endDate });
    if (areaCoach) records = records.filter(r => ALIGNMENT[r.store_id]?.area_coach === areaCoach);
    if (region)    records = records.filter(r => ALIGNMENT[r.store_id]?.region_coach === region);

    // Group by store and compute weekly averages
    const byStore = {};
    for (const r of records) {
      if (!byStore[r.store_id]) {
        byStore[r.store_id] = { ...ALIGNMENT[r.store_id], store_id: r.store_id, weeks: {} };
      }
      const wk = r.week_key instanceof Date ? r.week_key.toISOString().split('T')[0] : String(r.week_key).split('T')[0];
      if (!byStore[r.store_id].weeks[wk]) byStore[r.store_id].weeks[wk] = [];
      if (r.ist_avg) byStore[r.store_id].weeks[wk].push(parseFloat(r.ist_avg));
    }

    // Build summary for Claude
    const storeSummaries = Object.values(byStore).map(s => {
      const weekAvgs = Object.entries(s.weeks)
        .sort(([a],[b]) => a.localeCompare(b))
        .map(([wk, vals]) => ({ wk, avg: Math.round(vals.reduce((a,v)=>a+v,0)/vals.length*10)/10 }));
      const trend = weekAvgs.length >= 2
        ? weekAvgs[weekAvgs.length-1].avg - weekAvgs[0].avg
        : null;
      return {
        store: s.name || s.store_id,
        area_coach: s.area_coach,
        latest_ist: weekAvgs.length ? weekAvgs[weekAvgs.length-1].avg : null,
        trend_4wk: trend ? Math.round(trend*10)/10 : null,
        weeks: weekAvgs
      };
    });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ insights: 'AI insights require ANTHROPIC_API_KEY', storeSummaries });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const filterLabel = areaCoach ? `Area Coach: ${areaCoach}` : region ? `Region: ${region}` : 'Full Company';

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `You are Velocity, a Pizza Hut Speed of Service analytics engine. 
Be direct, specific, and action-oriented. No corporate fluff. Plain text only.
IST target is under 19 minutes. Green ≤18, Yellow 18-20, Orange 20-25, Red >25.
Focus on: who's improving, who's slipping, what patterns stand out, what to do about it.`,
      messages: [{
        role: 'user',
        content: `Analyze this IST performance data for ${filterLabel} over the past 4 weeks.
Data: ${JSON.stringify(storeSummaries.slice(0, 40))}
Provide a concise coaching brief: top improvers, stores needing attention, any patterns worth noting.`
      }]
    });

    res.json({ insights: msg.content[0].text, storeSummaries, filter: filterLabel });
  } catch (e) {
    console.error('[Velocity] Insights error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/velocity/upload — manual file upload ────────────────────
router.post('/upload', upload.array('files'), async (req, res) => {
  const tempFiles = req.files?.map(f => f.path) || [];
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'No files received' });
    const results = [], errors = [];

    for (const file of req.files) {
      const isPdf  = file.originalname.match(/\.pdf$/i);
      const isXlsx = file.originalname.match(/\.xlsx?$/i);

      let parsed = null;
      try {
        if (isPdf)       parsed = await parseAboveStorePDF(file.path);
        else if (isXlsx) {
          if (file.originalname.match(/speed.?of.?service|PH_Speed/i))
            parsed = parseSOSExcel(file.path);
          else if (file.originalname.match(/dispatch|delivery/i))
            parsed = parseDeliveryExcel(file.path);
          else { errors.push(`${file.originalname}: unrecognised file`); continue; }
        } else { errors.push(`${file.originalname}: unsupported type`); continue; }
      } catch (e) { errors.push(`${file.originalname}: ${e.message}`); continue; }

      if (!parsed?.stores?.length) { errors.push(`${file.originalname}: no store data found`); continue; }

      const { stores, reportDate, source } = parsed;
      const finalDate = reportDate || getYesterdayChicago();
      const weekKey   = getWeekKey(finalDate);
      const periodWk  = getPeriodWeek(finalDate);

      let saved = 0;
      for (const s of stores) {
        const align = ALIGNMENT[s.store_id];
        if (!align) continue;
        const record = {
          store_id: s.store_id, record_date: finalDate,
          week_key: weekKey, period_week: periodWk,
          data_source: source,
          uploader: req.session?.user?.name || 'manual'
        };
        if (source === 'pdf' || source === 'pdf_claude') {
          Object.assign(record, {
            ist_avg: s.ist_avg, ist_lt10: s.ist_lt10, ist_1014: s.ist_1014,
            ist_1518: s.ist_1518, ist_1925: s.ist_1925, ist_gt25: s.ist_gt25,
            ist_lt19_pct: s.ist_lt19_pct, total_orders: s.total_orders
          });
        } else if (source === 'sos_excel') {
          Object.assign(record, { make_time: s.make_time, pct_lt4: s.pct_lt4 });
        } else if (source === 'delivery_excel') {
          Object.assign(record, {
            production_time: s.production_time, pct_lt15: s.pct_lt15,
            pct_lt4: s.pct_lt4, total_orders: s.total_orders
          });
        }
        const r = await db.upsertVelocityRecord(record);
        if (r) saved++;
      }
      results.push({ file: file.originalname, date: finalDate, source, storesSaved: saved });
    }

    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e){} });
    res.json({ success: true, results, errors });
  } catch (e) {
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch(_){} });
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/velocity/export — download Excel workbook ──────────────
router.post('/export', async (req, res) => {
  try {
    const weekKey = req.body.week || getWeekKey(getYesterdayChicago());
    const records = await db.getVelocityWeek(weekKey);

    const enriched = records.map(r => ({
      ...r,
      record_date: r.record_date instanceof Date ? r.record_date.toISOString().split('T')[0] : String(r.record_date).split('T')[0],
      ...(ALIGNMENT[r.store_id] || {})
    }));

    const wtdStores = computeWTD(enriched);
    const periodWeek = enriched[0]?.period_week || getPeriodWeek(weekKey);

    // Build dailyByDate for daily sheets
    const dailyByDate = {};
    for (const r of enriched) {
      const d = r.record_date;
      if (!dailyByDate[d]) dailyByDate[d] = [];
      dailyByDate[d].push(r);
    }

    // ── Build allWeekStores for PTD Trend sheet ─────────────────────────
    // Collect all weeks in the current period up to (and including) the selected week
    const period = periodWeek.replace(/W\d+$/, ''); // 'P4' from 'P4W2'
    const ptdWeekEntries = Object.entries(FISCAL_CALENDAR)
      .filter(([wk, pw]) => pw.startsWith(period + 'W') && wk <= weekKey)
      .sort(([a], [b]) => a.localeCompare(b));

    let allWeekStores = null;
    if (ptdWeekEntries.length >= 1) {
      const storeWeekIST = {};
      const storeInfoMap = {};
      for (const [wk, pw] of ptdWeekEntries) {
        const isCurrentWeek = (wk === weekKey);
        const label = isCurrentWeek ? `${pw} (WTD)` : pw;
        // Re-use already-computed WTD for the selected week; fetch + compute for past weeks
        const weekISTs = isCurrentWeek ? wtdStores : (() => {
          // This is sync-style — we handle it below with async
          return null; // placeholder
        })();
        if (weekISTs) {
          for (const s of weekISTs) {
            if (s.wtd_ist == null) continue;
            if (!storeWeekIST[s.store_id]) {
              storeWeekIST[s.store_id] = {};
              storeInfoMap[s.store_id] = { name: s.name || '', region_coach: s.region_coach || '', area_coach: s.area_coach || '' };
            }
            storeWeekIST[s.store_id][label] = s.wtd_ist;
          }
        }
      }
      // Fetch past weeks asynchronously
      for (const [wk, pw] of ptdWeekEntries) {
        if (wk === weekKey) continue; // already handled above
        const label = pw;
        const raw = await db.getVelocityWeek(wk);
        const enrichedWeek = raw.map(r => ({
          ...r,
          record_date: r.record_date instanceof Date ? r.record_date.toISOString().split('T')[0] : String(r.record_date).split('T')[0],
          ...(ALIGNMENT[r.store_id] || {})
        }));
        const pastWTD = computeWTD(enrichedWeek);
        for (const s of pastWTD) {
          if (s.wtd_ist == null) continue;
          if (!storeWeekIST[s.store_id]) {
            storeWeekIST[s.store_id] = {};
            storeInfoMap[s.store_id] = { name: s.name || '', region_coach: s.region_coach || '', area_coach: s.area_coach || '' };
          }
          storeWeekIST[s.store_id][label] = s.wtd_ist;
        }
      }
      allWeekStores = Object.entries(storeWeekIST).map(([store_id, weeklyIST]) => ({
        level: 'STORE', store_id, ...storeInfoMap[store_id], weeklyIST
      }));
    }

    const buffer = await generateExcelExport({ weekKey, periodWeek, wtdStores, dailyByDate, allWeekStores });

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Velocity_IST_${weekKey}.xlsx"`
    });
    res.send(buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});




// ── GET /api/velocity/ptd?date=YYYY-MM-DD&compare=true — Period-to-Date ──
router.get('/ptd', async (req, res) => {
  try {
    const date         = req.query.date        || getYesterdayChicago();
    const compare      = req.query.compare     === 'true';
    const regionFilter = req.query.region      || null;
    const areaFilter   = req.query.area_coach  || null;
    const storeFilter  = req.query.store       || null;

    const weekKey    = getWeekKey(date);
    const periodWeek = getPeriodWeek(date);             // e.g. 'P4W2'
    const period     = periodWeek.replace(/W\d+$/, ''); // e.g. 'P4'

    // All FISCAL_CALENDAR weeks in this period up to and including current week
    const ptdEntries = Object.entries(FISCAL_CALENDAR)
      .filter(([wk, pw]) => pw.startsWith(period + 'W') && wk <= weekKey)
      .sort(([a], [b]) => a.localeCompare(b));

    if (!ptdEntries.length) {
      return res.json({ period, periodWeek, weekKey, weeks: [], aggregate: [], weeklyStores: [], prior: null });
    }

    // Helper: fetch a week, enrich with alignment, apply filters, tag with _wkLabel
    async function fetchWeekFiltered(wk, label) {
      const raw = await db.getVelocityWeek(wk);
      return raw
        .map(r => ({
          ...r,
          record_date: r.record_date instanceof Date
            ? r.record_date.toISOString().split('T')[0]
            : String(r.record_date).split('T')[0],
          ...(ALIGNMENT[r.store_id] || {}),
          _wkLabel: label
        }))
        .filter(r => (!storeFilter  || r.store_id     === storeFilter)
                  && (!areaFilter   || r.area_coach   === areaFilter)
                  && (!regionFilter || r.region_coach === regionFilter));
    }

    // Build week metadata + fetch all records for this period
    const weeks         = [];
    const allPtdRecords = [];
    for (const [wk, pw] of ptdEntries) {
      const isCurrentWeek = (wk === weekKey);
      const label = isCurrentWeek ? `${pw} (WTD)` : pw;
      weeks.push({ week_key: wk, period_week: pw, label, is_current: isCurrentWeek, date_range: getWeekDateRange(wk) });
      const recs = await fetchWeekFiltered(wk, label);
      allPtdRecords.push(...recs);
    }

    // Aggregate: computeWTD across all period records → true period average per store
    const aggregate = computeWTD(allPtdRecords);

    // Per-week WTD per store (for week-by-week sub-view)
    const weeklyMap = {};
    for (const wkMeta of weeks) {
      const wkRecs   = allPtdRecords.filter(r => r._wkLabel === wkMeta.label);
      const wkStores = computeWTD(wkRecs);
      for (const s of wkStores) {
        if (!weeklyMap[s.store_id]) {
          weeklyMap[s.store_id] = {
            store_id: s.store_id, name: s.name || '',
            area_coach: s.area_coach || '', region_coach: s.region_coach || '',
            weeklyIST: {}, weeklyOrders: {}
          };
        }
        if (s.wtd_ist != null) weeklyMap[s.store_id].weeklyIST[wkMeta.label] = s.wtd_ist;
        weeklyMap[s.store_id].weeklyOrders[wkMeta.label] = s.wtd_orders || 0;
      }
    }
    const weeklyStores = Object.values(weeklyMap);

    // Prior period comparison (all weeks, since prior period is complete)
    let prior = null;
    if (compare) {
      const periodNum   = parseInt(period.replace('P', ''));
      const priorPeriod = `P${periodNum - 1}`;
      const priorEntries = Object.entries(FISCAL_CALENDAR)
        .filter(([wk, pw]) => pw.startsWith(priorPeriod + 'W'))
        .sort(([a], [b]) => a.localeCompare(b));

      if (priorEntries.length) {
        const priorWeeks   = [];
        const priorAllRecs = [];
        for (const [wk, pw] of priorEntries) {
          priorWeeks.push({ week_key: wk, period_week: pw, label: pw, is_current: false, date_range: getWeekDateRange(wk) });
          const recs = await fetchWeekFiltered(wk, pw);
          priorAllRecs.push(...recs);
        }
        prior = { period: priorPeriod, weeks: priorWeeks, aggregate: computeWTD(priorAllRecs) };
      }
    }

    res.json({ period, periodWeek, weekKey, weeks, aggregate, weeklyStores, prior });
  } catch (e) {
    console.error('[Velocity] PTD error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
