'use strict';
/**
 * Intel Routes — /api/intel/*
 * Serves cached intel dashboard data, handles acknowledgments, weekly digest.
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../services/db');
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

// ── Multer config for HutBot file uploads ─────────────────────────────────────
const hutbotUploadDir = '/tmp/uploads';
fs.mkdirSync(hutbotUploadDir, { recursive: true });
const hutbotStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, hutbotUploadDir),
  filename: (req, file, cb) => cb(null, `hutbot_${Date.now()}_${file.originalname}`),
});
const hutbotUpload = multer({ storage: hutbotStorage, limits: { fileSize: 10 * 1024 * 1024 } });

let lastPipelineResult = null; // in-memory store of most recent pipeline run

// ── POST /api/intel/automation/run-batch — cron trigger ──────────────────────
router.post('/automation/run-batch', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.query.token;
  if (token !== process.env.INTEL_AUTOMATION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const targetDate = req.body.date || req.query.date || null;
  console.log(`[Intel] Batch pipeline triggered for ${targetDate || 'yesterday'}`);

  // Respond immediately so cron doesn't timeout, then run async
  res.json({ status: 'started', targetDate });

  // Log route entry to DB immediately — if this shows up, the async block runs
  await db.logIntelJob({ jobType: 'route:triggered', targetDate, status: 'running', message: 'run-batch route entered' });

  try {
    const { runIntelPipeline } = require('../services/intel-pipeline');
    await db.logIntelJob({ jobType: 'route:require_ok', targetDate, status: 'running', message: 'intel-pipeline required OK' });
    const result = await runIntelPipeline(targetDate);
    lastPipelineResult = { ...result, completedAt: new Date().toISOString() };
    console.log('[Intel] Pipeline complete:', JSON.stringify(result.steps, null, 2));
    if (result.errors.length) console.warn('[Intel] Pipeline errors:', result.errors);
  } catch (err) {
    await db.logIntelJob({ jobType: 'route:fatal', targetDate, status: 'error', message: err.message + '\n' + (err.stack || '') });
    console.error('[Intel] Pipeline fatal error:', err.message);
  }
});

// ── GET /api/intel/automation/status ─────────────────────────────────────────
router.get('/automation/status', async (req, res) => {
  try {
    const p = db.getPool();
    if (!p) return res.json({ status: 'db_unavailable' });
    const flags = await p.query(
      'SELECT metric_date, region_coach, area_coach, territory_vp, COUNT(*) as cnt FROM intel_flags GROUP BY metric_date, region_coach, area_coach, territory_vp ORDER BY metric_date DESC, cnt DESC LIMIT 30'
    );
    res.json({ recent_runs: flags.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/intel/automation/last-run — result of most recent pipeline run ────
router.get('/automation/last-run', async (req, res) => {
  const token = req.query.token || req.headers['x-automation-token'];
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  if (!lastPipelineResult) return res.json({ status: 'no_run_yet', message: 'No pipeline run since last server restart' });
  res.json(lastPipelineResult);
});

// ── GET /api/intel/automation/logs — persistent pipeline run history ─────────
router.get('/automation/logs', async (req, res) => {
  const token = req.query.token || req.headers['x-automation-token'];
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const logs = await db.getIntelLogs(20);
    const parsed = logs.map(l => {
      try { return { ...l, message: JSON.parse(l.message) }; } catch { return l; }
    });
    res.json({ logs: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/automation/debug-cache — temp debug ───────────────────────
router.get('/automation/debug-cache', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.query.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = db.getPool();
    if (!p) return res.json({ error: 'no pool' });
    const cache = await p.query('SELECT user_id, cache_date, role, generated_at, length(payload::text) as payload_size FROM intel_cache ORDER BY generated_at DESC LIMIT 20');
    const flags = await p.query('SELECT metric_date, territory_vp, region_coach, area_coach, COUNT(*) as cnt FROM intel_flags GROUP BY metric_date, territory_vp, region_coach, area_coach ORDER BY metric_date DESC, cnt DESC LIMIT 30');
    res.json({ cache_entries: cache.rows, flag_breakdown: flags.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── GET /api/intel/automation/regenerate-cache — GET version for token-only callers ──
router.get('/automation/regenerate-cache', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.query.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  const date = req.query.date || (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  })();
  res.json({ status: 'started', date });
  try {
    const { generateIntelCache } = require('../services/intel-pipeline');
    await generateIntelCache(date);
    console.log(`[Intel] Cache regenerated via GET for ${date}`);
  } catch (err) {
    console.error('[Intel] Cache regen error:', err.message);
  }
});

// ── GET /api/intel/automation/browser-check — diagnose Playwright binary path ──
router.get('/automation/browser-check', async (req, res) => {
  const token = req.query.token || req.headers['x-automation-token'];
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  const fss = require('fs');
  const pathh = require('path');
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '/tmp/ms-playwright';
  const result = { browsersPath, exists: false, dirs: [], files: [] };
  try {
    result.exists = fss.existsSync(browsersPath);
    if (result.exists) {
      result.dirs = fss.readdirSync(browsersPath);
      for (const d of result.dirs.filter(e => e.startsWith('chromium'))) {
        const full = pathh.join(browsersPath, d);
        try {
          const sub = fss.readdirSync(full);
          result.files.push({ dir: d, contents: sub });
          for (const s of sub) {
            const sub2 = pathh.join(full, s);
            try { result.files.push({ dir: d + '/' + s, contents: fss.readdirSync(sub2) }); } catch (_) {}
          }
        } catch (_) {}
      }
    }
  } catch (e) { result.error = e.message; }
  res.json(result);
});

// ── POST /api/intel/automation/regenerate-cache — re-run cache step only ─────
router.post('/automation/regenerate-cache', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.query.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  const targetDate = req.body?.date || req.query.date || null;
  res.json({ status: 'started', targetDate });
  try {
    const { generateIntelCache } = require('../services/intel-pipeline');
    const date = targetDate || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    })();
    await generateIntelCache(date);
    console.log(`[Intel] Cache regenerated for ${date}`);
  } catch (err) {
    console.error('[Intel] Cache regen error:', err.message);
  }
});


// ── GET /api/intel/automation/test-cache-write — diagnose upsertIntelCache ───
router.get('/automation/test-cache-write', async (req, res) => {
  const token = req.query.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = db.getPool();
    if (!p) return res.json({ error: 'no pool' });

    // 1. Show actual table columns
    const cols = await p.query(`SELECT column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_name='intel_cache' ORDER BY ordinal_position`);

    // 2. Try a direct insert matching actual columns
    let insertResult = null, insertError = null;
    try {
      await p.query(
        `INSERT INTO intel_cache (user_id, cache_date, role, payload, generated_at)
         VALUES ('__test__', '2026-01-01', 'test', $1, NOW())
         ON CONFLICT (user_id, cache_date) DO UPDATE SET payload=EXCLUDED.payload, generated_at=NOW()`,
        [JSON.stringify({ test: true })]
      );
      insertResult = 'ok';
    } catch (e) { insertError = e.message; }

    // 3. Clean up test row
    await p.query("DELETE FROM intel_cache WHERE user_id='__test__'").catch(()=>{});

    res.json({ columns: cols.rows, insertResult, insertError });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/automation/fix-hierarchy — token-auth, no session needed ──
// Patches region_coach + territory_vp on intel_flags using USER_ROSTER AC→RC/VP map.
// Also fixes null-hierarchy flags by joining store_assignments if populated.
router.get('/automation/fix-hierarchy', async (req, res) => {
  const token = req.query.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = db.getPool();
    if (!p) return res.status(503).json({ error: 'No DB' });

    // Build AC → { rc, vp } map from USER_ROSTER
    const { USER_ROSTER } = require('../routes/auth');
    const acMap = {};
    for (const u of USER_ROSTER) {
      if (u.role === 'rdo') {
        for (const ac of (u.scope.area_coaches || [])) {
          acMap[ac] = { rc: u.scope.rc_name, vp: u.scope.vp };
        }
      }
    }

    let totalUpdated = 0;
    for (const [ac, hier] of Object.entries(acMap)) {
      const r = await p.query(
        `UPDATE intel_flags SET region_coach=$1, territory_vp=$2
         WHERE area_coach=$3
           AND (region_coach IS DISTINCT FROM $1 OR territory_vp IS DISTINCT FROM $2)`,
        [hier.rc, hier.vp, ac]
      );
      totalUpdated += r.rowCount;
    }

    // Also fix flags where area_coach is null but store is in store_assignments
    const r2 = await p.query(`
      UPDATE intel_flags f
      SET area_coach   = a.area_coach,
          region_coach = a.region_coach,
          territory_vp = a.vp
      FROM store_assignments a
      WHERE f.store_id = a.store_id AND f.area_coach IS NULL
    `);
    totalUpdated += r2.rowCount;

    res.json({ status: 'ok', rows_updated: totalUpdated, ac_entries: Object.keys(acMap).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All routes below require login
// ── GET /api/intel/automation/raw-flags — full flag detail for review ─────────
router.get('/automation/raw-flags', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.query.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = db.getPool();
    if (!p) return res.json({ error: 'no pool' });
    const date = req.query.date || null;
    let q = `SELECT store_id, store_name, metric_type, metric_date, value, target,
               severity, consecutive_days_out, status, area_coach, region_coach,
               territory_vp, created_at
             FROM intel_flags WHERE status != 'archived'`;
    const params = [];
    if (date) { params.push(date); q += ` AND metric_date = $1`; }
    q += ` ORDER BY metric_date DESC,
           CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           consecutive_days_out DESC`;
    const result = await p.query(q, params);
    const soft   = await p.query(`SELECT store_id, metric_date, indicator, value, target, source
      FROM dbs_soft_indicators ORDER BY metric_date DESC LIMIT 100`);
    const byType = {};
    for (const row of result.rows) {
      if (!byType[row.metric_type]) byType[row.metric_type] = [];
      byType[row.metric_type].push(row);
    }
    res.json({ total_flags: result.rows.length, by_type: byType, soft_indicators: soft.rows, all_flags: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/intel/automation/seed-hierarchy — seed store_assignments from alignment then fix flags ──
router.get('/automation/seed-hierarchy', async (req, res) => {
  const token = req.query.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // 1) Seed store_assignments from velocity-alignment
    await db.seedStoreAssignmentsFromAlignment();

    // 2) Fix null-hierarchy flags using the freshly seeded store_assignments
    const p = db.getPool();
    const r = await p.query(`
      UPDATE intel_flags f
      SET area_coach   = a.area_coach,
          region_coach = a.region_coach,
          territory_vp = a.vp
      FROM store_assignments a
      WHERE f.store_id = a.store_id AND f.area_coach IS NULL
    `);

    // 3) Also fix region_coach/vp on flags that have area_coach but missing RC/VP
    const { USER_ROSTER } = require('../routes/auth');
    const acMap = {};
    for (const u of USER_ROSTER) {
      if (u.role === 'rdo') {
        for (const ac of (u.scope.area_coaches || [])) {
          acMap[ac] = { rc: u.scope.rc_name, vp: u.scope.vp };
        }
      }
    }
    let rcFixed = 0;
    for (const [ac, hier] of Object.entries(acMap)) {
      const r2 = await p.query(
        `UPDATE intel_flags SET region_coach=$1, territory_vp=$2
         WHERE area_coach=$3
           AND (region_coach IS DISTINCT FROM $1 OR territory_vp IS DISTINCT FROM $2)`,
        [hier.rc, hier.vp, ac]
      );
      rcFixed += r2.rowCount;
    }

    res.json({ status: 'ok', null_hierarchy_fixed: r.rowCount, rc_vp_fixed: rcFixed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/intel/debug/playwright — check browser binary filesystem ──────────
router.get('/debug/playwright', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.query.token;
  if (token !== process.env.INTEL_AUTOMATION_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const fs   = require('fs');
  const path = require('path');
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || 'NOT SET';
  const home = process.env.HOME || '/root';
  const defaultCache = path.join(home, '.cache', 'ms-playwright');
  const result = {
    PLAYWRIGHT_BROWSERS_PATH: base,
    HOME: home,
    cwd: process.cwd(),
    defaultCacheExists: fs.existsSync(defaultCache),
    defaultCacheEntries: [],
    browserPathEntries: [],
  };
  // Check PLAYWRIGHT_BROWSERS_PATH
  try {
    if (base !== 'NOT SET' && fs.existsSync(base)) {
      const top = fs.readdirSync(base);
      result.browserPathTopLevel = top.filter(x => x.startsWith('chromium') || x.startsWith('firefox') || x.startsWith('webkit'));
      for (const e of top.filter(x => x.startsWith('chromium'))) {
        const dir = path.join(base, e);
        const sub = { name: e, contents: [] };
        try {
          const subEntries = fs.readdirSync(dir);
          for (const s of subEntries) {
            const sp = path.join(dir, s);
            try { sub.contents.push({ name: s, files: fs.readdirSync(sp) }); }
            catch (_) { sub.contents.push({ name: s }); }
          }
        } catch (_) {}
        result.browserPathEntries.push(sub);
      }
    }
  } catch (err) { result.browserPathError = err.message; }
  // Check default cache
  try {
    if (fs.existsSync(defaultCache)) {
      const entries = fs.readdirSync(defaultCache);
      result.defaultCacheEntries = entries;
    }
  } catch (_) {}
  res.json(result);
});

router.use(requireAuth);

// ── POST /api/intel/automation/run-now — manual batch trigger (session auth, rdo/vp only) ──
router.post('/automation/run-now', requireRole('rdo', 'vp'), async (req, res) => {
  const user = req.session.user;
  const targetDate = req.body.date || null;
  console.log(`[Intel] Manual batch triggered by ${user.username} (${user.role}) for ${targetDate || 'yesterday'}`);
  res.json({ status: 'started', targetDate, triggeredBy: user.username });
  await db.logIntelJob({ jobType: 'manual:triggered', targetDate, status: 'running', message: `Triggered manually by ${user.username}` });
  try {
    const { runIntelPipeline } = require('../services/intel-pipeline');
    const result = await runIntelPipeline(targetDate);
    lastPipelineResult = { ...result, completedAt: new Date().toISOString() };
    console.log('[Intel] Manual pipeline complete:', JSON.stringify(result.steps, null, 2));
    if (result.errors.length) console.warn('[Intel] Manual pipeline errors:', result.errors);
  } catch (err) {
    await db.logIntelJob({ jobType: 'manual:fatal', targetDate, status: 'error', message: err.message });
    console.error('[Intel] Manual pipeline error:', err.message);
  }
});


// ── GET /api/intel/dashboard — serve cached intel for logged-in user ──────────
router.get('/dashboard', async (req, res) => {
  try {
    const user      = req.session.user;
    const today     = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const yesterday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    })();

    // Try today's cache first, fall back to yesterday
    let cacheResult = await db.getIntelCache({ userId: user.username, cacheDate: today });
    let cacheDate = today;
    if (!cacheResult) {
      cacheResult = await db.getIntelCache({ userId: user.username, cacheDate: yesterday });
      cacheDate = yesterday;
    }

    if (!cacheResult) {
      return res.json({ status: 'no_data', message: 'Intel not yet generated for today. Check back after 5 AM.' });
    }
    const payload = cacheResult.data;
    res.json({ status: 'ok', ...payload, narrative: payload.trend_summary, metric_date: cacheDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/intel/kpis — aggregated KPI dashboard (sales, growth, flags) ────
router.get('/kpis', async (req, res) => {
  try {
    const user = req.session.user;
    const requestedDate = req.query.date || (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    })();
    const p = db.getPool();
    if (!p) return res.json({ region: null, by_ac: [], by_store: [], date: requestedDate });

    // Fall back to most recent date with data if requested date has none
    const dateCheckRes = await p.query(
      `SELECT TO_CHAR(MAX(metric_date), 'YYYY-MM-DD') AS latest FROM intel_dbs_metrics WHERE metric_date <= $1`,
      [requestedDate]
    );
    const date = dateCheckRes.rows[0]?.latest || requestedDate;

    // Flag scope filter
    const fp = [date]; let flagWhere = "metric_date = $1 AND status != 'archived'";

    if (user.scope?.type === 'rdo') {
      const acs = user.scope.area_coaches || [];
      if (acs.length) {
        fp.push(acs); flagWhere += ` AND (area_coach = ANY($${fp.length}::text[]) OR area_coach IS NULL)`;
      } else {
        fp.push(user.scope.rc_name || user.name); flagWhere += ` AND (region_coach = $${fp.length} OR region_coach IS NULL)`;
      }
    } else if (user.scope?.type === 'area_coach') {
      const ac = user.scope.ac_name || user.name;
      fp.push(ac); flagWhere += ` AND area_coach = $${fp.length}`;
    }

    // Build scope filter for store_assignments
    const sp = []; let assignWhere = '1=1';
    if (user.scope?.type === 'rdo') {
      const acs = user.scope.area_coaches || [];
      if (acs.length) { sp.push(acs); assignWhere += ` AND area_coach = ANY($${sp.length}::text[])`; }
      else if (user.scope.rc_name || user.name) { sp.push(user.scope.rc_name || user.name); assignWhere += ` AND region_coach = $${sp.length}`; }
    } else if (user.scope?.type === 'area_coach') {
      sp.push(user.scope.ac_name || user.name); assignWhere += ` AND area_coach = $${sp.length}`;
    }

    // Fetch store_assignments first — seed storeMap so all ACs appear even with no DBS data
    const assignRes = await p.query(
      `SELECT store_id, store_name, area_coach, region_coach FROM store_assignments WHERE ${assignWhere}`, sp);
    const storeMap = {};
    for (const r of assignRes.rows) {
      storeMap[r.store_id] = {
        area_coach: r.area_coach, store_id: r.store_id, store_name: r.store_name,
        net_sales: null, growth_pct: null, cancels: null,
        labor_pct: null, ot_hours: 0, comments_pos: 0, comments_neg: 0,
        forgot_clockout: 0, routines_missed: 0, routines_late: 0, flag_count: 0
      };
    }

    // Fetch all metrics for the date — storeMap (seeded from store_assignments) scopes in JS.
    // Avoids type-mismatch issues with store_id = ANY() across different DB column types.
    const [metricsRes, flagCountRes, fcOtRes, surveyRes, routinesRes, laborRes] = await Promise.all([
      p.query(`SELECT t.area_coach, t.store_id, t.store_name,
        t.net_sales_day,
        COALESCE(
          t.growth_pct_day,
          CASE
            WHEN p.net_sales_day IS NOT NULL AND p.net_sales_day <> 0
              THEN ROUND(((t.net_sales_day - p.net_sales_day) / p.net_sales_day * 100)::numeric, 2)
            ELSE NULL
          END
        ) AS growth_pct_day,
        t.cancel_unmade_day, t.paidouts_day, t.cash_variance_day
        FROM intel_dbs_metrics t
        LEFT JOIN intel_dbs_metrics p
          ON p.store_id = t.store_id
          AND p.metric_date = t.metric_date - INTERVAL '1 day'
        WHERE t.metric_date=$1
        ORDER BY t.area_coach, t.store_id`, [date]),
      p.query(`SELECT area_coach, store_id, severity, COUNT(*) as cnt
        FROM intel_flags WHERE ${flagWhere} GROUP BY area_coach, store_id, severity`, fp),
      p.query(`SELECT area_coach, store_id,
        COUNT(CASE WHEN metric_type = 'FORGOT_CLOCKOUT' THEN 1 END)::int as forgot_clockout,
        COALESCE(SUM(CASE WHEN metric_type IN ('OT_OVER_SCHEDULED','OT_OVER_RUN','DOUBLE_TIME')
          THEN COALESCE(value::numeric, 0) ELSE 0 END), 0)::float as ot_hours
        FROM intel_flags WHERE ${flagWhere} GROUP BY area_coach, store_id`, fp),
      p.query(`SELECT sl.store_id, a.area_coach,
        COALESCE(SUM(sl.positive_count),0)::int as pos,
        COALESCE(SUM(sl.negative_count),0)::int as neg
        FROM intel_survey_log sl LEFT JOIN store_assignments a ON sl.store_id=a.store_id
        WHERE sl.survey_date=$1 GROUP BY sl.store_id, a.area_coach`, [date]),
      p.query(`SELECT store_id, area_coach,
        COUNT(CASE WHEN metric_type='ROUTINE_MISSED' THEN 1 END)::int as routines_missed,
        COUNT(CASE WHEN metric_type='ROUTINE_LATE'   THEN 1 END)::int as routines_late
        FROM intel_flags WHERE ${flagWhere} GROUP BY store_id, area_coach`, fp),
      p.query(`SELECT store_id, value FROM dbs_soft_indicators WHERE metric_date=$1 AND indicator='labor_pct'`, [date])
    ]);

    // Build user AC set for fallback scoping when store not in store_assignments
    const userACSet = new Set(user.scope?.area_coaches || []);

    // Overlay DBS metrics:
    // - If store is in storeMap (from store_assignments): use its area_coach, apply sales
    // - If NOT in storeMap: fall back to metrics area_coach, scope by user's AC list
    for (const r of metricsRes.rows) {
      if (!storeMap[r.store_id]) {
        // store_assignments is empty or store missing — scope via metrics area_coach
        const acName = r.area_coach;
        let inScope = false;
        if (user.scope?.type === 'rdo') {
          inScope = userACSet.size === 0 || userACSet.has(acName);
        } else if (user.scope?.type === 'area_coach') {
          inScope = acName === (user.scope.ac_name || user.name);
        } else {
          inScope = true; // vp sees all
        }
        if (!inScope) continue;
        storeMap[r.store_id] = {
          area_coach: acName, store_id: r.store_id, store_name: r.store_name,
          net_sales: null, growth_pct: null, cancels: null,
          labor_pct: null, ot_hours: 0, comments_pos: 0, comments_neg: 0,
          forgot_clockout: 0, routines_missed: 0, routines_late: 0, flag_count: 0
        };
      }
      Object.assign(storeMap[r.store_id], {
        net_sales: r.net_sales_day ? +r.net_sales_day : null,
        growth_pct: r.growth_pct_day != null ? +r.growth_pct_day : null,
        cancels: r.cancel_unmade_day ? +r.cancel_unmade_day : null,
      });
    }

    // Merge flag counts
    for (const r of flagCountRes.rows) {
      if (!storeMap[r.store_id]) storeMap[r.store_id] = {
        area_coach: r.area_coach, store_id: r.store_id, store_name: r.store_id,
        net_sales: null, growth_pct: null, cancels: null, labor_pct: null,
        ot_hours: 0, comments_pos: 0, comments_neg: 0, forgot_clockout: 0,
        routines_missed: 0, routines_late: 0, flag_count: 0
      };
      storeMap[r.store_id].flag_count = (storeMap[r.store_id].flag_count || 0) + +r.cnt;
    }
    for (const r of fcOtRes.rows) {
      if (storeMap[r.store_id]) {
        storeMap[r.store_id].forgot_clockout = r.forgot_clockout || 0;
        storeMap[r.store_id].ot_hours = +r.ot_hours || 0;
      }
    }
    for (const r of surveyRes.rows) {
      if (storeMap[r.store_id]) {
        storeMap[r.store_id].comments_pos = r.pos || 0;
        storeMap[r.store_id].comments_neg = r.neg || 0;
      }
    }

    for (const r of routinesRes.rows) {
      if (storeMap[r.store_id]) {
        storeMap[r.store_id].routines_missed = r.routines_missed || 0;
        storeMap[r.store_id].routines_late   = r.routines_late   || 0;
      }
    }
    for (const r of laborRes.rows) {
      if (storeMap[r.store_id]) storeMap[r.store_id].labor_pct = r.value != null ? +r.value : null;
    }

    const by_store = Object.values(storeMap);

    // Group by area_coach
    const acMap = {};
    for (const s of by_store) {
      const ac = s.area_coach || 'Unknown';
      if (!acMap[ac]) acMap[ac] = { area_coach: ac, store_count: 0, net_sales: 0,
        gsum: 0, gcnt: 0, cancels: 0, lpsum: 0, lpcnt: 0, ot_hours: 0, comments_pos: 0,
        comments_neg: 0, forgot_clockout: 0, routines_missed: 0, routines_late: 0, flag_count: 0 };
      const a = acMap[ac];
      a.store_count++;
      if (s.net_sales  != null) a.net_sales  += s.net_sales;
      if (s.growth_pct != null) { a.gsum += s.growth_pct; a.gcnt++; }
      if (s.cancels    != null) a.cancels += s.cancels;
      if (s.labor_pct  != null) { a.lpsum += s.labor_pct; a.lpcnt++; }
      a.ot_hours       += s.ot_hours       || 0;
      a.comments_pos   += s.comments_pos   || 0;
      a.comments_neg   += s.comments_neg   || 0;
      a.forgot_clockout  += s.forgot_clockout   || 0;
      a.routines_missed  += s.routines_missed  || 0;
      a.routines_late    += s.routines_late    || 0;
      a.flag_count       += s.flag_count       || 0;
    }

    const by_ac = Object.values(acMap).map(a => ({
      area_coach: a.area_coach, store_count: a.store_count,
      net_sales:       a.net_sales    || null,
      growth_pct:      a.gcnt > 0 ? a.gsum / a.gcnt : null,
      cancels:         a.cancels      || null,
      labor_pct:       a.lpcnt > 0 ? a.lpsum / a.lpcnt : null,
      ot_hours:        a.ot_hours     || null,
      comments_pos:    a.comments_pos,
      comments_neg:    a.comments_neg,
      forgot_clockout:  a.forgot_clockout,
      routines_missed:  a.routines_missed,
      routines_late:    a.routines_late,
      flag_count:       a.flag_count
    }));

    const validGrowth = by_store.filter(s => s.growth_pct != null);
    const region = {
      store_count:     by_store.length,
      net_sales:       by_store.reduce((s,r) => s+(r.net_sales||0), 0) || null,
      growth_pct:      validGrowth.length ? validGrowth.reduce((s,r) => s+r.growth_pct,0)/validGrowth.length : null,
      cancels:         by_store.reduce((s,r) => s+(r.cancels||0), 0) || null,
      labor_pct:       (() => { const lp = by_store.filter(s => s.labor_pct != null); return lp.length ? lp.reduce((s,r) => s+r.labor_pct, 0)/lp.length : null; })(),
      ot_hours:        by_store.reduce((s,r) => s+(r.ot_hours||0), 0) || null,
      comments_pos:    by_store.reduce((s,r) => s+(r.comments_pos||0), 0),
      comments_neg:    by_store.reduce((s,r) => s+(r.comments_neg||0), 0),
      forgot_clockout:  by_store.reduce((s,r) => s+(r.forgot_clockout||0), 0),
      routines_missed:  by_store.reduce((s,r) => s+(r.routines_missed||0), 0),
      routines_late:    by_store.reduce((s,r) => s+(r.routines_late||0), 0)
    };

    res.json({ region, by_ac, by_store, date });
  } catch (err) {
    console.error('[Intel] /kpis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/performance — Region → AC → Store drill-down ──────────────
router.get('/performance', async (req, res) => {
  try {
    const user = req.session.user;
    const date = req.query.date || (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    })();

    const p = db.getPool();
    if (!p) return res.json({ success: true, date, regions: [] });

    const PERF_METRICS = ['CANCEL_UNMADE','PRODUCTION_TIME','CASH_VARIANCE',
                          'CHANGE_DOWN','CHANGED_MILES','PAIDOUT','REFUNDS'];
    let where = `metric_date = $1 AND status != 'archived'`;
    const params = [date];
    if (user.scope?.type === 'rdo')        { params.push(user.scope.rc_name);  where += ` AND region_coach = $${params.length}`; }
    if (user.scope?.type === 'area_coach') { params.push(user.scope.ac_name);  where += ` AND area_coach = $${params.length}`; }
    const metricIn = PERF_METRICS.map((_, i) => `$${params.length + i + 1}`).join(',');
    params.push(...PERF_METRICS);

    const { rows } = await p.query(`
      SELECT region_coach, area_coach, store_id, store_name, metric_type,
             value, severity, consecutive_days_out, status
      FROM intel_flags
      WHERE ${where} AND metric_type IN (${metricIn})
      ORDER BY region_coach, area_coach, store_id, metric_type
    `, params);

    const regions = {};
    for (const row of rows) {
      const r = row.region_coach || 'Unknown';
      const a = row.area_coach   || 'Unknown';
      if (!regions[r]) regions[r] = { name: r, areas: {} };
      if (!regions[r].areas[a]) regions[r].areas[a] = { name: a, stores: {} };
      const s = row.store_id;
      if (!regions[r].areas[a].stores[s]) regions[r].areas[a].stores[s] = { store_id: s, store_name: row.store_name, flags: [] };
      regions[r].areas[a].stores[s].flags.push({ metric_type: row.metric_type, value: row.value,
        severity: row.severity, days: row.consecutive_days_out, status: row.status });
    }

    const output = Object.values(regions).map(r => ({
      region_coach: r.name,
      areas: Object.values(r.areas).map(a => {
        const stores = Object.values(a.stores);
        return { area_coach: a.name, store_count: stores.length,
          flag_count: stores.reduce((n, s) => n + s.flags.length, 0),
          high_count: stores.reduce((n, s) => n + s.flags.filter(f => f.severity === 'high').length, 0),
          stores };
      })
    }));

    res.json({ success: true, date, regions: output });
  } catch (err) {
    console.error('[Intel] /performance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/flags — live flag query (filters by session user scope) ────
router.get('/flags', async (req, res) => {
  try {
    const user  = req.session.user;
    const date  = req.query.date || null;
    const statusFilter = req.query.status || null;

    let flags = [];
    if (user.role === 'rdo') {
      const areaCoaches = user.scope?.area_coaches || [];
      flags = await db.getIntelFlags({
        metric_date: date,
        area_coach_in: areaCoaches.length > 0 ? areaCoaches : undefined,
        region_coach: areaCoaches.length === 0 ? (user.scope?.rc_name || user.name) : undefined,
        status: statusFilter
      });
    } else if (user.role === 'area_coach') {
      flags = await db.getIntelFlags({ metric_date: date, area_coach: user.scope?.ac_name || user.name, status: statusFilter });
    } else if (user.role === 'vp') {
      const p = db.getPool();
      if (!p) return res.json({ flags: [] });
      let q = 'SELECT * FROM intel_flags WHERE territory_vp=$1';
      const params = [user.scope?.vp_name || user.name];
      if (date) { params.push(date); q += ` AND metric_date=$${params.length}`; }
      if (statusFilter) { params.push(statusFilter); q += ` AND status=$${params.length}`; }
      q += ' ORDER BY severity DESC, consecutive_days_out DESC';
      const r = await p.query(q, params);
      flags = r.rows;
    }

    res.json({ flags, count: flags.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/flags/:id — single flag detail ─────────────────────────────
router.get('/flags/:id', async (req, res) => {
  try {
    const p = db.getPool();
    if (!p) return res.status(503).json({ error: 'Database unavailable' });
    const r = await p.query('SELECT * FROM intel_flags WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Flag not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/intel/acknowledge — area coach submits acknowledgment ────────────
router.post('/acknowledge', async (req, res) => {
  try {
    const user       = req.session.user;
    const { flag_id, action_taken } = req.body;
    if (!flag_id || !action_taken) return res.status(400).json({ error: 'flag_id and action_taken required' });
    if (action_taken.trim().length < 20) return res.status(400).json({ error: 'action_taken must be at least 20 characters — explain what you actually did.' });

    const p = db.getPool();
    if (!p) return res.status(503).json({ error: 'Database unavailable' });

    // Verify flag exists and is in user's scope
    const flagRes = await p.query('SELECT * FROM intel_flags WHERE id=$1', [flag_id]);
    if (!flagRes.rows.length) return res.status(404).json({ error: 'Flag not found' });

    // Insert acknowledgment
    const ackRes = await p.query(`
      INSERT INTO intel_acknowledgments (flag_id, acknowledged_by, role, action_taken)
      VALUES ($1, $2, $3, $4) RETURNING id, acknowledged_at
    `, [flag_id, user.username, user.role, action_taken.trim()]);

    // Update flag status to addressed
    await p.query("UPDATE intel_flags SET status='addressed' WHERE id=$1", [flag_id]);

    res.json({ success: true, acknowledgment_id: ackRes.rows[0].id, acknowledged_at: ackRes.rows[0].acknowledged_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/accountability — RDO/VP: see all acknowledgments in scope ───
router.get('/accountability', requireRole('rdo', 'vp'), async (req, res) => {
  try {
    const user = req.session.user;
    let acks = [];
    if (user.role === 'rdo') {
      acks = await db.getAcknowledgments({ region_coach: user.scope?.rc_name || user.name });
    } else if (user.role === 'vp') {
      const p = db.getPool();
      if (!p) return res.json({ acknowledgments: [] });
      const r = await p.query(`
        SELECT a.*, f.store_id, f.store_name, f.area_coach, f.region_coach,
               f.metric_type, f.metric_date, f.severity, f.value, f.status
        FROM intel_acknowledgments a
        JOIN intel_flags f ON f.id = a.flag_id
        WHERE f.territory_vp=$1
        ORDER BY a.acknowledged_at DESC
      `, [user.scope?.vp_name || user.name]);
      acks = r.rows;
    }
    res.json({ acknowledgments: acks, count: acks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/shoutouts — positive comments for user's scope ─────────────
router.get('/shoutouts', async (req, res) => {
  try {
    const user = req.session.user;
    const date = req.query.date || null;
    const p    = db.getPool();
    if (!p) return res.json({ shoutouts: [] });

    let q = 'SELECT s.*, a.area_coach, a.region_coach FROM store_shoutouts s LEFT JOIN store_assignments a ON s.store_id=a.store_id WHERE 1=1';
    const params = [];
    if (date) { params.push(date); q += ` AND s.shoutout_date=$${params.length}`; }
    if (user.role === 'area_coach') { params.push(user.scope?.ac_name||user.name); q += ` AND a.area_coach=$${params.length}`; }
    if (user.role === 'rdo') { params.push(user.scope?.rc_name||user.name); q += ` AND a.region_coach=$${params.length}`; }
    q += ' ORDER BY s.shoutout_date DESC, s.id DESC LIMIT 50';
    const r = await p.query(q, params);
    res.json({ shoutouts: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/weekly-digest — Monday digest for user's scope ─────────────
router.get('/weekly-digest', async (req, res) => {
  try {
    const user = req.session.user;
    const p    = db.getPool();
    if (!p) return res.status(503).json({ error: 'Database unavailable' });

    // Get this week's flags (Mon-Sun ending with yesterday)
    const today     = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay() + 1); // Monday
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const yesterday    = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let flags = [], acks = [];
    if (user.role === 'rdo') {
      const r1 = await p.query(
        `SELECT * FROM intel_flags WHERE region_coach=$1 AND metric_date BETWEEN $2 AND $3 ORDER BY severity DESC`,
        [user.scope?.rc_name||user.name, weekStartStr, yesterdayStr]
      );
      flags = r1.rows;
      acks  = await db.getAcknowledgments({ region_coach: user.scope?.rc_name||user.name });
    } else if (user.role === 'area_coach') {
      const r1 = await p.query(
        `SELECT * FROM intel_flags WHERE area_coach=$1 AND metric_date BETWEEN $2 AND $3 ORDER BY severity DESC`,
        [user.scope?.ac_name||user.name, weekStartStr, yesterdayStr]
      );
      flags = r1.rows;
    } else if (user.role === 'vp') {
      const r1 = await p.query(
        `SELECT * FROM intel_flags WHERE territory_vp=$1 AND metric_date BETWEEN $2 AND $3 ORDER BY severity DESC`,
        [user.scope?.vp_name||user.name, weekStartStr, yesterdayStr]
      );
      flags = r1.rows;
    }

    // Build digest text
    const digest = buildDigestText({ user, flags, acks, weekStartStr, yesterdayStr });
    res.json({ digest, flag_count: flags.length, ack_count: acks.length, week_start: weekStartStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildDigestText({ user, flags, acks, weekStartStr, yesterdayStr }) {
  const lines = [];
  const { getFiscalContextString } = require('../services/fiscal-calendar');
  const fiscal = getFiscalContextString ? getFiscalContextString() : '';
  lines.push(`PAi Weekly Intel Digest — Week of ${weekStartStr} | ${fiscal}`);
  lines.push('');

  // Follow-up items
  lines.push('FOLLOW-UP ITEMS FOR 1:1s');
  const openFlags = flags.filter(f => f.status !== 'resolved' && f.status !== 'archived');
  if (!openFlags.length) {
    lines.push('• No open flags this week.');
  } else {
    for (const f of openFlags.slice(0, 15)) {
      const ack = acks.find(a => String(a.flag_id) === String(f.id));
      const ackedText = ack ? `Addressed by ${ack.acknowledged_by}: "${ack.action_taken.substring(0,60)}..."` : 'Not yet addressed.';
      lines.push(`• Store ${f.store_id} (${f.area_coach||'Unknown Area'}) — ${f.metric_type} (${f.consecutive_days_out} days). ${ackedText}`);
    }
  }
  lines.push('');

  // Stores to watch
  const highStores = [...new Set(flags.filter(f => f.severity === 'high').map(f => `${f.store_id} (${f.store_name||f.store_id})`))];
  if (highStores.length) {
    lines.push('STORES TO WATCH');
    highStores.slice(0, 10).forEach(s => lines.push(`• ${s}`));
    lines.push('');
  }

  // Bright spots
  const recovering = flags.filter(f => f.trend_direction === 'recovering');
  if (recovering.length) {
    lines.push('BRIGHT SPOTS');
    recovering.forEach(f => lines.push(`• Store ${f.store_id} — ${f.metric_type} now recovering`));
    lines.push('');
  }

  return lines.join('\n');
}


// ── POST /api/intel/automation/fix-hierarchy — one-time data fix ──────────────
// Corrects intel_flags rows where region_coach was set to the VP name instead of
// the RDO name. Joins intel_flags to store_assignments and updates region_coach
// and territory_vp from the authoritative assignments table.
router.post('/automation/fix-hierarchy', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.body?.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = db.getPool();
    if (!p) return res.status(503).json({ error: 'No DB' });
    const r = await p.query(`
      UPDATE intel_flags f
      SET region_coach  = a.region_coach,
          area_coach    = COALESCE(f.area_coach, a.area_coach),
          territory_vp  = a.vp
      FROM store_assignments a
      WHERE f.store_id = a.store_id
        AND (f.region_coach IS DISTINCT FROM a.region_coach
          OR f.territory_vp IS DISTINCT FROM a.vp
          OR (f.area_coach IS NULL AND a.area_coach IS NOT NULL))
    `);
    res.json({ status: 'ok', rows_updated: r.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/store-assignments — hierarchy lookup ───────────────────────
router.get('/store-assignments', requireRole('rdo', 'vp'), async (req, res) => {
  try {
    const assignments = await db.getStoreAssignments();
    res.json({ assignments, count: Object.keys(assignments).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/intel/store-trend — 7-day flag history for a store+metric ────────
router.get('/store-trend', async (req, res) => {
  try {
    const { store_id, metric_type, days = 14 } = req.query;
    if (!store_id || !metric_type) return res.status(400).json({ error: 'store_id and metric_type required' });
    const p = db.getPool();
    if (!p) return res.json({ history: [] });
    const r = await p.query(`
      SELECT metric_date, value, target, severity, status, consecutive_days_out
      FROM intel_flags
      WHERE store_id=$1 AND metric_type=$2
      ORDER BY metric_date DESC LIMIT $3
    `, [store_id, metric_type, parseInt(days)]);
    res.json({ store_id, metric_type, history: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/intel/rdo-signoff — RDO clears an addressed flag ────────────────
router.post('/rdo-signoff', requireRole('rdo', 'vp'), async (req, res) => {
  try {
    const { flag_id } = req.body;
    if (!flag_id) return res.status(400).json({ error: 'flag_id required' });
    const p = db.getPool();
    if (!p) return res.status(503).json({ error: 'Database unavailable' });
    const flagRes = await p.query('SELECT * FROM intel_flags WHERE id=$1', [flag_id]);
    if (!flagRes.rows.length) return res.status(404).json({ error: 'Flag not found' });
    await p.query("UPDATE intel_flags SET status='resolved', updated_at=NOW() WHERE id=$1", [flag_id]);
    await p.query(`INSERT INTO intel_acknowledgments (flag_id, acknowledged_by, role, action_taken)
      VALUES ($1,$2,$3,$4)`, [flag_id, req.session.user.username, req.session.user.role, 'RDO sign-off — issue closed']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── POST /api/intel/upload/hutbot — manual HutBot routines file upload ─────────
// Accepts CSV or Excel export from the Yum SuperApp routines page.
// Processes it and writes ROUTINE_MISSED / ROUTINE_LATE flags to the DB.
router.post('/upload/hutbot', requireRole('rdo', 'vp', 'area_coach'), hutbotUpload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded. Attach a CSV or Excel file.' });

  const targetDate = req.body.date || (() => {
    // Default to yesterday EST
    const now = new Date();
    const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    est.setDate(est.getDate() - 1);
    return est.toISOString().split('T')[0];
  })();

  console.log(`[HutBot Upload] Processing ${file.originalname} for ${targetDate}`);

  try {
    const { parseHutBotFile } = require('../services/parsers/hutbot-parser');
    const { writeHutBotFlags } = require('../services/intel-hutbot');

    const { records, summary } = await parseHutBotFile(file.path);
    console.log(`[HutBot Upload] Parsed ${records.length} records — ${summary.missed} missed, ${summary.late} late, ${summary.stores} stores`);

    if (records.length === 0) {
      fs.unlink(file.path, () => {});
      return res.json({ success: true, message: 'File parsed — no missed or late routines found.', summary });
    }

    const flagsWritten = await writeHutBotFlags(records, targetDate);

    // Regenerate intel cache so dashboard reflects new flags immediately
    try {
      const { generateIntelCache } = require('../services/intel-pipeline');
      await generateIntelCache(targetDate);
    } catch (cacheErr) {
      console.warn('[HutBot Upload] Cache regen failed (non-fatal):', cacheErr.message);
    }

    fs.unlink(file.path, () => {});
    res.json({
      success: true,
      message: `Processed ${records.length} routines — ${flagsWritten} flags written for ${targetDate}.`,
      summary: { ...summary, flagsWritten, targetDate },
    });
  } catch (err) {
    console.error('[HutBot Upload] Error:', err.message);
    fs.unlink(file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/intel/hutbot/auth — store session cookie for automation ─────────
router.post('/hutbot/auth', requireRole('rdo', 'vp', 'area_coach'), async (req, res) => {
  const { cookie } = req.body;
  if (!cookie || typeof cookie !== 'string' || cookie.trim().length < 10) {
    return res.status(400).json({ error: 'Invalid cookie value — paste the full Cookie header string' });
  }
  try {
    await db.setHutBotAuth(cookie.trim(), req.session.user?.username || 'unknown');
    console.log(`[HutBot Auth] Cookie saved by ${req.session.user?.username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[HutBot Auth] Error saving cookie:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/hutbot/status — last scrape status for dashboard tile ──────
router.get('/hutbot/status', requireAuth, async (req, res) => {
  try {
    const p = db.getPool();
    if (!p) return res.json({ configured: false, needsReauth: true });

    const auth = await db.getHutBotAuth();
    const needsReauth = !auth || !auth.is_valid;

    const yesterday = (() => {
      const now = new Date();
      const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      est.setDate(est.getDate() - 1);
      return est.toISOString().split('T')[0];
    })();
    const r = await p.query(
      "SELECT COUNT(*)::int as cnt FROM intel_flags WHERE source='HUTBOT' AND metric_date=$1",
      [yesterday]
    );
    res.json({
      configured: !!auth,
      needsReauth,
      hasDataToday: r.rows[0].cnt > 0,
      flagCount: r.rows[0].cnt,
      yesterday,
    });
  } catch (err) {
    res.json({ configured: false, needsReauth: true, error: err.message });
  }
});

module.exports = router;
