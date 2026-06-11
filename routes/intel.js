'use strict';
/**
 * Intel Routes — /api/intel/*
 * Serves cached intel dashboard data, handles acknowledgments, weekly digest.
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { USER_ROSTER } = require('./auth');
const db = require('../services/db');
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

// ── Multer config for file uploads (HutBot, SMG) ──────────────────────────────
const hutbotUploadDir = '/tmp/uploads';
fs.mkdirSync(hutbotUploadDir, { recursive: true });
const hutbotStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, hutbotUploadDir),
  filename: (req, file, cb) => cb(null, `hutbot_${Date.now()}_${file.originalname}`),
});
const hutbotUpload = multer({ storage: hutbotStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const smgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, hutbotUploadDir),
  filename: (req, file, cb) => cb(null, `smg_${Date.now()}_${file.originalname}`),
});
const smgUpload = multer({ storage: smgStorage, limits: { fileSize: 20 * 1024 * 1024 } });

let lastPipelineResult = null; // in-memory store of most recent pipeline run

// ── POST /api/intel/automation/run-batch — cron trigger ──────────────────────
router.post('/automation/run-batch', async (req, res) => {
  const token = req.headers['x-automation-token'] || req.query.token;
  // Accept the dashboard INTEL_AUTOMATION_TOKEN OR the cron service's known token
  // (cron token is defined in render.yaml and shared in the repo — low-risk endpoint)
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, '38b8091924e1f85583454212a9860038'].filter(Boolean);
  if (!validTokens.includes(token)) {
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
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN, '38b8091924e1f85583454212a9860038'].filter(Boolean);
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
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN, '38b8091924e1f85583454212a9860038'].filter(Boolean);
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

  // Try to actually launch Playwright and report the error
  result.playwrightModule = false;
  result.playwrightLaunch = null;
  try {
    const pw = require('playwright');
    result.playwrightModule = true;
    try {
      const br = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
      result.playwrightLaunch = 'success';
      await br.close();
    } catch (le) {
      result.playwrightLaunch = le.message.slice(0, 300);
    }
  } catch (me) {
    result.playwrightLaunch = 'require failed: ' + me.message.slice(0, 200);
  }

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
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, '38b8091924e1f85583454212a9860038'].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  const fs   = require('fs');
  const path = require('path');
  const home = process.env.HOME || '/root';

  // Check all candidate paths where chromium might live
  const candidatePaths = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,                          // dashboard env var
    '/opt/render/project/src/node_modules/.playwright-browsers',   // build-time install (browser-launch.js target)
    '/opt/render/project/src/playwright-browsers',                  // old dashboard path
    path.join(home, '.cache', 'ms-playwright'),                     // playwright default cache
    '/tmp/ms-playwright',                                           // old startup install path
  ].filter(Boolean);

  function scanPath(p) {
    if (!fs.existsSync(p)) return { exists: false };
    try {
      const top = fs.readdirSync(p);
      const chromiumDirs = top.filter(x => x.startsWith('chromium'));
      const details = chromiumDirs.map(e => {
        const dir = path.join(p, e);
        try {
          const sub = fs.readdirSync(dir);
          const subDetails = sub.map(s => {
            const sp = path.join(dir, s);
            try { return { name: s, files: fs.readdirSync(sp) }; }
            catch (_) { return { name: s }; }
          });
          return { name: e, contents: subDetails };
        } catch (_) { return { name: e }; }
      });
      return { exists: true, topLevel: top, chromiumDirs, details };
    } catch (err) { return { exists: true, error: err.message }; }
  }

  const pathResults = {};
  for (const p of [...new Set(candidatePaths)]) {
    pathResults[p] = scanPath(p);
  }

  res.json({
    PLAYWRIGHT_BROWSERS_PATH_env: process.env.PLAYWRIGHT_BROWSERS_PATH,
    browserLaunchTarget: '/opt/render/project/src/node_modules/.playwright-browsers',
    HOME: home,
    cwd: process.cwd(),
    pathResults,
  });
});

// ── POST /api/intel/upload/smg — manual SMG Comments Excel upload ─────────────
// Accepts the "Comments by Comment" Excel export from 360.smg.com.
// Runs the same processing as the automated pipeline (Claude Haiku classification,
// flags, shoutouts) — no credentials needed, user downloads the file manually.
// NOTE: This route must be BEFORE router.use(requireAuth) so the automation token works.
router.post('/upload/smg', smgUpload.single('file'), async (req, res) => {
  // Accept either a logged-in RDO/VP session OR the automation token
  const tkn = req.headers['x-automation-token'] || req.query.token;
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, '38b8091924e1f85583454212a9860038'].filter(Boolean);
  const hasToken = tkn && validTokens.includes(tkn);
  const hasRole  = req.session?.user && ['rdo','vp','area_coach'].includes(req.session.user.role);
  if (!hasToken && !hasRole) return res.status(401).json({ error: 'Unauthorized' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded. Attach the SMG Comments xlsx export.' });

  const targetDate = req.body.date || (() => {
    const now = new Date();
    const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    est.setDate(est.getDate() - 1);
    return est.toISOString().split('T')[0];
  })();

  console.log(`[SMG Upload] Processing ${file.originalname} for ${targetDate}`);

  // Respond immediately — processing takes minutes (Claude API per comment)
  res.json({ status: 'started', file: file.originalname, targetDate });

  // Process async so connection doesn't time out
  (async () => {
    try {
      const { processSMG } = require('../services/parsers/smg-parser');
      const result = await processSMG(file.path, targetDate);

      if (!result.success) {
        console.error('[SMG Upload] Processing failed:', result.error);
      } else {
        console.log(`[SMG Upload] Done — ${result.commentsProcessed} comments, ${result.flagsWritten} flags, ${result.shoutoutsWritten} shoutouts for ${targetDate}`);
        try {
          const { generateIntelCache } = require('../services/intel-pipeline');
          await generateIntelCache(targetDate);
          console.log('[SMG Upload] Intel cache regenerated');
        } catch (cacheErr) {
          console.warn('[SMG Upload] Cache regen failed (non-fatal):', cacheErr.message);
        }
      }
    } catch (err) {
      console.error('[SMG Upload] Error:', err.message);
    } finally {
      fs.unlink(file.path, () => {});
    }
  })();
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

// ── POST /api/intel/automation/bulk-backfill — run pipeline for a date range ──
// Session auth only — no token needed. Responds immediately, runs async.
router.post('/automation/bulk-backfill', requireRole('rdo', 'vp'), async (req, res) => {
  const user = req.session.user;
  const { start, end } = req.body;
  if (!start || !end) return res.status(400).json({ error: 'start and end dates required (YYYY-MM-DD)' });

  // Build date list
  const dates = [];
  const cur = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');
  while (cur <= last) { dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }

  console.log(`[Backfill] ${user.username} triggered backfill for ${dates.length} dates: ${start} → ${end}`);
  res.json({ status: 'started', dates, message: `Running pipeline for ${dates.length} dates. Check server logs for progress.` });

  // Run sequentially in background — 1 min gap between dates to let the server breathe
  (async () => {
    const { runIntelPipeline } = require('../services/intel-pipeline');
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      console.log(`[Backfill] [${i + 1}/${dates.length}] Running pipeline for ${date}...`);
      await db.logIntelJob({ jobType: 'backfill:start', targetDate: date, status: 'running', message: `Backfill ${i + 1}/${dates.length}` });
      try {
        const result = await runIntelPipeline(date);
        lastPipelineResult = { ...result, completedAt: new Date().toISOString() };
        const ok = result.errors.length === 0;
        console.log(`[Backfill] ${date} done — errors: ${result.errors.length}`);
        await db.logIntelJob({ jobType: 'backfill:done', targetDate: date, status: ok ? 'success' : 'partial', message: result.errors.join('; ').slice(0, 500) || 'ok' });
      } catch (err) {
        console.error(`[Backfill] ${date} FAILED:`, err.message);
        await db.logIntelJob({ jobType: 'backfill:error', targetDate: date, status: 'error', message: err.message.slice(0, 500) });
      }
      if (i < dates.length - 1) await new Promise(r => setTimeout(r, 60000)); // 1 min between dates
    }
    console.log(`[Backfill] All ${dates.length} dates complete.`);
  })();
});

// ── GET /api/intel/automation/pipeline-status — session-auth view of last run + DB logs ──
router.get('/automation/pipeline-status', requireRole('rdo', 'vp'), async (req, res) => {
  try {
    const logs = await db.getIntelLogs(30);
    res.json({ lastRun: lastPipelineResult, recentLogs: logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
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


// ── GET /api/intel/vp-scope-options — regions + area coaches for VP filter ────
router.get('/vp-scope-options', async (req, res) => {
  try {
    const user = req.session.user;
    if (user.role !== 'vp') return res.json({ regions: [] });
    const rcNames = user.scope?.region_coaches || [];
    const regions = rcNames.map(rcName => {
      const rdo = USER_ROSTER.find(u => u.role === 'rdo' && u.scope?.rc_name === rcName);
      return { rc_name: rcName, area_coaches: rdo?.scope?.area_coaches || [] };
    });
    res.json({ regions });
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

    // Global sub-filter (RDO/VP drilling into AC or store)
    const filterAC    = req.query.filter_ac    || null;
    const filterStore = req.query.filter_store || null;

    // VP scope filter from query params
    const vpRcFilter = user.role === 'vp' ? (req.query.rc_name || null) : null;
    const vpAcFilter = user.role === 'vp' ? (req.query.ac_name || filterAC || null) : null;
    let vpAcSet = null;
    if (vpRcFilter) {
      const rdo = USER_ROSTER.find(u => u.role === 'rdo' && u.scope?.rc_name === vpRcFilter);
      vpAcSet = new Set(rdo?.scope?.area_coaches || []);
    }

    // Flag scope filter
    const fp = [date]; let flagWhere = "metric_date = $1 AND status != 'archived'";

    if (user.scope?.type === 'rdo') {
      if (filterAC) {
        fp.push(filterAC); flagWhere += ` AND area_coach = $${fp.length}`;
      } else {
        const acs = user.scope.area_coaches || [];
        if (acs.length) {
          fp.push(acs); flagWhere += ` AND (area_coach = ANY($${fp.length}::text[]) OR area_coach IS NULL)`;
        } else {
          fp.push(user.scope.rc_name || user.name); flagWhere += ` AND (region_coach = $${fp.length} OR region_coach IS NULL)`;
        }
      }
    } else if (user.scope?.type === 'area_coach') {
      const ac = user.scope.ac_name || user.name;
      fp.push(ac); flagWhere += ` AND area_coach = $${fp.length}`;
    } else if (user.role === 'vp' && vpRcFilter) {
      fp.push(vpRcFilter); flagWhere += ` AND region_coach = $${fp.length}`;
    } else if (user.role === 'vp' && vpAcFilter) {
      fp.push(vpAcFilter); flagWhere += ` AND area_coach = $${fp.length}`;
    }

    // Build scope filter for store_assignments
    const sp = []; let assignWhere = '1=1';
    if (user.scope?.type === 'rdo') {
      if (filterAC) {
        sp.push(filterAC); assignWhere += ` AND area_coach = $${sp.length}`;
        if (filterStore) { sp.push(filterStore); assignWhere += ` AND store_name = $${sp.length}`; }
      } else {
        const acs = user.scope.area_coaches || [];
        if (acs.length) { sp.push(acs); assignWhere += ` AND area_coach = ANY($${sp.length}::text[])`; }
        else if (user.scope.rc_name || user.name) { sp.push(user.scope.rc_name || user.name); assignWhere += ` AND region_coach = $${sp.length}`; }
      }
    } else if (user.scope?.type === 'area_coach') {
      sp.push(user.scope.ac_name || user.name); assignWhere += ` AND area_coach = $${sp.length}`;
    } else if (user.role === 'vp' && vpRcFilter) {
      sp.push(vpRcFilter); assignWhere += ` AND region_coach = $${sp.length}`;
    } else if (user.role === 'vp' && vpAcFilter) {
      sp.push(vpAcFilter); assignWhere += ` AND area_coach = $${sp.length}`;
    }

    // Fetch store_assignments first — seed storeMap so all ACs appear even with no DBS data
    const assignRes = await p.query(
      `SELECT store_id, store_name, area_coach, region_coach FROM store_assignments WHERE ${assignWhere}`, sp);
    const storeMap = {};
    for (const r of assignRes.rows) {
      storeMap[r.store_id] = {
        area_coach: r.area_coach, store_id: r.store_id, store_name: r.store_name,
        net_sales: null, growth_pct: null, cancels: null,
        labor_pct: null, act_lab_dollar: null, sch_lab_dollar: null,
        sched_labor_pct: null, act_labor_pct: null,
        ot_hours: 0, comments_pos: 0, comments_neg: 0,
        forgot_clockout: 0, routines_missed: 0, routines_late: 0, flag_count: 0,
        win_score: null
      };
    }

    // Fetch all metrics for the date — storeMap (seeded from store_assignments) scopes in JS.
    // Avoids type-mismatch issues with store_id = ANY() across different DB column types.
    const [metricsRes, flagCountRes, fcOtRes, surveyRes, routinesRes, laborRes, winScoreRes, actLabRes, schLabRes] = await Promise.all([
      p.query(`SELECT area_coach, store_id, store_name,
        net_sales_day, growth_pct_day,
        cancel_unmade_day, paidouts_day, cash_variance_day,
        sched_labor_pct_day, act_labor_pct_day
        FROM intel_dbs_metrics
        WHERE metric_date=$1
        ORDER BY area_coach, store_id`, [date]),
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
      p.query(`SELECT store_id, value FROM dbs_soft_indicators WHERE metric_date=$1 AND indicator='labor_pct'`, [date]),
      p.query(`SELECT store_id, win_score, survey_count FROM smg_win_scores WHERE period_end_date <= $1 ORDER BY period_end_date DESC`, [date]),
      p.query(`SELECT store_id, value FROM dbs_soft_indicators WHERE metric_date=$1 AND indicator='act_lab_dollar'`, [date]),
      p.query(`SELECT store_id, value FROM dbs_soft_indicators WHERE metric_date=$1 AND indicator='sch_lab_dollar'`, [date])
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
        } else { // vp
          if (vpAcSet !== null) inScope = vpAcSet.has(acName);
          else if (vpAcFilter) inScope = (acName === vpAcFilter);
          else inScope = true;
        }
        if (!inScope) continue;
        storeMap[r.store_id] = {
          area_coach: acName, store_id: r.store_id, store_name: r.store_name,
          net_sales: null, growth_pct: null, cancels: null,
          labor_pct: null, ot_hours: 0, comments_pos: 0, comments_neg: 0,
          forgot_clockout: 0, routines_missed: 0, routines_late: 0, flag_count: 0,
          win_score: null
        };
      }
      Object.assign(storeMap[r.store_id], {
        net_sales:       r.net_sales_day ? +r.net_sales_day : null,
        growth_pct:      r.growth_pct_day != null ? +r.growth_pct_day : null,
        cancels:         r.cancel_unmade_day ? +r.cancel_unmade_day : null,
        sched_labor_pct: r.sched_labor_pct_day != null ? +r.sched_labor_pct_day : null,
        act_labor_pct:   r.act_labor_pct_day   != null ? +r.act_labor_pct_day   : null,
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
    // Win score: use most recent row per store (query ordered DESC so first seen = most recent)
    const winScoreSeen = new Set();
    for (const r of winScoreRes.rows) {
      if (!winScoreSeen.has(r.store_id) && storeMap[r.store_id]) {
        storeMap[r.store_id].win_score = r.win_score != null ? +r.win_score : null;
        winScoreSeen.add(r.store_id);
      }
    }
    for (const r of actLabRes.rows) {
      if (storeMap[r.store_id]) storeMap[r.store_id].act_lab_dollar = r.value != null ? +r.value : null;
    }
    for (const r of schLabRes.rows) {
      if (storeMap[r.store_id]) storeMap[r.store_id].sch_lab_dollar = r.value != null ? +r.value : null;
    }

    const by_store = Object.values(storeMap);

    // Group by area_coach
    const acMap = {};
    for (const s of by_store) {
      const ac = s.area_coach || 'Unknown';
      if (!acMap[ac]) acMap[ac] = { area_coach: ac, store_count: 0, net_sales: 0,
        gsum: 0, gcnt: 0, cancels: 0, lpsum: 0, lpcnt: 0, ot_hours: 0, comments_pos: 0,
        comments_neg: 0, forgot_clockout: 0, routines_missed: 0, routines_late: 0, flag_count: 0,
        wssum: 0, wscnt: 0, slpsum: 0, slpcnt: 0, alpsum: 0, alpcnt: 0 };
      const a = acMap[ac];
      a.store_count++;
      if (s.net_sales  != null) a.net_sales  += s.net_sales;
      if (s.growth_pct != null) { a.gsum += s.growth_pct; a.gcnt++; }
      if (s.cancels    != null) a.cancels += s.cancels;
      if (s.labor_pct      != null) { a.lpsum  += s.labor_pct;      a.lpcnt++;  }
      if (s.sched_labor_pct != null) { a.slpsum += s.sched_labor_pct; a.slpcnt++; }
      if (s.act_labor_pct   != null) { a.alpsum += s.act_labor_pct;   a.alpcnt++; }
      a.ot_hours       += s.ot_hours       || 0;
      a.comments_pos   += s.comments_pos   || 0;
      a.comments_neg   += s.comments_neg   || 0;
      a.forgot_clockout  += s.forgot_clockout   || 0;
      if (s.win_score != null) { a.wssum += s.win_score; a.wscnt++; }
      a.routines_missed  += s.routines_missed  || 0;
      a.routines_late    += s.routines_late    || 0;
      a.flag_count       += s.flag_count       || 0;
    }

    // Group stores by AC for drill-down
    const storesByAC = {};
    for (const s of by_store) {
      const ac = s.area_coach || 'Unknown';
      if (!storesByAC[ac]) storesByAC[ac] = [];
      storesByAC[ac].push(s);
    }

    const by_ac = Object.values(acMap).map(a => ({
      area_coach: a.area_coach, store_count: a.store_count,
      net_sales:       a.net_sales    || null,
      growth_pct:      a.gcnt > 0 ? a.gsum / a.gcnt : null,
      cancels:         a.cancels      || null,
      labor_pct:        a.lpcnt  > 0 ? a.lpsum  / a.lpcnt  : null,
      sched_labor_pct:  a.slpcnt > 0 ? a.slpsum / a.slpcnt : null,
      act_labor_pct:    a.alpcnt > 0 ? a.alpsum / a.alpcnt : null,
      ot_hours:         a.ot_hours    || null,
      comments_pos:    a.comments_pos,
      comments_neg:    a.comments_neg,
      forgot_clockout:  a.forgot_clockout,
      routines_missed:  a.routines_missed,
      routines_late:    a.routines_late,
      flag_count:       a.flag_count,
      avg_win_score:    a.wscnt > 0 ? Math.round(a.wssum / a.wscnt * 10) / 10 : null,
      stores:          storesByAC[a.area_coach] || [],
    }));

    const validGrowth  = by_store.filter(s => s.growth_pct != null);
    const validWinScore = by_store.filter(s => s.win_score != null);
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
      routines_late:    by_store.reduce((s,r) => s+(r.routines_late||0), 0),
      avg_win_score:    validWinScore.length ? Math.round(validWinScore.reduce((s,r) => s+r.win_score, 0) / validWinScore.length * 10) / 10 : null
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
    const statusFilter = req.query.status || null;
    const filterAC    = req.query.filter_ac    || null;
    const filterStore = req.query.filter_store || null;
    // Default to most recent available date — don't show all-time flags by default
    let date = req.query.date || null;
    if (!date && !req.query.all) {
      const p2 = db.getPool();
      if (p2) {
        const dr = await p2.query("SELECT MAX(metric_date)::text as d FROM intel_flags WHERE status != 'archived'");
        if (dr.rows[0]?.d) date = dr.rows[0].d;
      }
    }

    let flags = [];
    if (user.role === 'rdo') {
      const p = db.getPool();
      if (!p) return res.json({ flags: [] });
      const areaCoaches = user.scope?.area_coaches || [];
      const params = [];
      let q = 'SELECT * FROM intel_flags WHERE 1=1';
      if (date) { params.push(date); q += ` AND metric_date=$${params.length}`; }
      if (statusFilter) { params.push(statusFilter); q += ` AND status=$${params.length}`; }
      // Drill-down overrides broad scope
      if (filterAC) {
        params.push(filterAC); q += ` AND area_coach=$${params.length}`;
        if (filterStore) { params.push(filterStore); q += ` AND store_name=$${params.length}`; }
      } else if (areaCoaches.length) {
        params.push(areaCoaches); q += ` AND area_coach=ANY($${params.length}::text[])`;
      } else {
        params.push(user.scope?.rc_name || user.name); q += ` AND region_coach=$${params.length}`;
      }
      q += ' ORDER BY severity DESC, consecutive_days_out DESC';
      const r = await p.query(q, params);
      flags = r.rows;
    } else if (user.role === 'area_coach') {
      flags = await db.getIntelFlags({ metric_date: date, area_coach: user.scope?.ac_name || user.name, status: statusFilter });
    } else if (user.role === 'vp') {
      const p = db.getPool();
      if (!p) return res.json({ flags: [] });
      const vpRcFilter = req.query.rc_name || null;
      const vpAcFilter = req.query.ac_name || filterAC || null;
      let q = 'SELECT * FROM intel_flags WHERE territory_vp=$1';
      const params = [user.scope?.vp_name || user.name];
      if (date) { params.push(date); q += ` AND metric_date=$${params.length}`; }
      if (statusFilter) { params.push(statusFilter); q += ` AND status=$${params.length}`; }
      if (vpRcFilter) { params.push(vpRcFilter); q += ` AND region_coach=$${params.length}`; }
      else if (vpAcFilter) { params.push(vpAcFilter); q += ` AND area_coach=$${params.length}`; }
      if (filterStore) { params.push(filterStore); q += ` AND store_name=$${params.length}`; }
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
    if (action_taken.trim().length < 5) return res.status(400).json({ error: 'action_taken must be at least 5 characters — explain what you actually did.' });

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

    let q = `SELECT s.id, s.store_id, a.store_name, s.shoutout_date, s.summary,
                   s.full_comment AS comment_text, s.source, a.area_coach, a.region_coach
             FROM intel_shoutouts s
             LEFT JOIN store_assignments a ON s.store_id = a.store_id
             WHERE 1=1`;
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

// ── GET /api/intel/smg-comments — all SMG comments (pos + neg) for user scope ──
// ?range=yesterday|wtd|ptd  (default: yesterday)
// ?date=YYYY-MM-DD           (explicit single date, overrides range)
router.get('/smg-comments', async (req, res) => {
  try {
    const user = req.session.user;
    const p    = db.getPool();
    if (!p) return res.json({ date_start: null, date_end: null, positive: [], negative: [] });

    const { getCurrentFiscalPeriod } = require('../services/fiscal-calendar');

    // Resolve date range
    const nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const toEST  = d => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const yesterdayD = new Date(nowEST); yesterdayD.setDate(nowEST.getDate() - 1);
    const yesterdayStr = toEST(yesterdayD);

    let dateStart, dateEnd;
    if (req.query.date) {
      dateStart = dateEnd = req.query.date;
    } else {
      const range = req.query.range || 'yesterday'; // default: yesterday only
      if (range === 'wtd') {
        // PH fiscal week runs Tuesday–Monday
        const dow = nowEST.getDay(); // 0=Sun,1=Mon,2=Tue,...
        const daysFromTue = dow === 0 ? 5 : dow === 1 ? 6 : dow - 2;
        const tuesday = new Date(nowEST); tuesday.setDate(nowEST.getDate() - daysFromTue);
        dateStart = toEST(tuesday);
        dateEnd   = yesterdayStr;
      } else if (range === 'ptd') {
        const fp = getCurrentFiscalPeriod();
        dateStart = fp ? fp.start : yesterdayStr;
        dateEnd   = yesterdayStr;
      } else {
        dateStart = dateEnd = yesterdayStr;
      }
    }

    // VP scope filter from query params
    const vpRcFilter2 = user.role === 'vp' ? (req.query.rc_name || null) : null;
    const vpAcFilter2 = user.role === 'vp' ? (req.query.ac_name || null) : null;

    // Build scope WHERE (for shoutouts joined to store_assignments)
    let scopeWhere = '1=1'; const sp = [];
    if (user.role === 'area_coach') { sp.push(user.scope?.ac_name||user.name); scopeWhere = `a.area_coach=$${sp.length}`; }
    else if (user.role === 'rdo') {
      const acs = user.scope?.area_coaches || [];
      if (acs.length) { sp.push(acs); scopeWhere = `a.area_coach = ANY($${sp.length}::text[])`; }
      else { sp.push(user.scope?.rc_name||user.name); scopeWhere = `a.region_coach=$${sp.length}`; }
    } else if (user.role === 'vp' && vpRcFilter2) {
      sp.push(vpRcFilter2); scopeWhere = `a.region_coach=$${sp.length}`;
    } else if (user.role === 'vp' && vpAcFilter2) {
      sp.push(vpAcFilter2); scopeWhere = `a.area_coach=$${sp.length}`;
    }

    // Date filter: single day or range
    const isSingleDay = dateStart === dateEnd;
    const dateCond    = isSingleDay ? `= $${sp.length+1}` : `BETWEEN $${sp.length+1} AND $${sp.length+2}`;
    sp.push(dateStart);
    if (!isSingleDay) sp.push(dateEnd);

    // Positive: shoutouts
    const posRes = await p.query(
      `SELECT s.store_id, a.store_name, a.area_coach, s.summary,
              s.full_comment AS comment_text, s.source, s.shoutout_date AS comment_date
       FROM intel_shoutouts s
       LEFT JOIN store_assignments a ON s.store_id = a.store_id
       WHERE ${scopeWhere} AND s.shoutout_date ${dateCond}
       ORDER BY s.shoutout_date DESC, a.area_coach, a.store_name`, sp
    );

    // Negative: GUEST_COMPLAINT flags with date range
    const negSp = [dateStart];
    if (!isSingleDay) negSp.push(dateEnd);
    const negDateCond = isSingleDay ? `metric_date=$1` : `metric_date BETWEEN $1 AND $2`;
    let negWhere = `${negDateCond} AND metric_type='GUEST_COMPLAINT' AND status != 'archived'`;
    if (user.role === 'area_coach') { negSp.push(user.scope?.ac_name||user.name); negWhere += ` AND area_coach=$${negSp.length}`; }
    else if (user.role === 'rdo') {
      const acs = user.scope?.area_coaches || [];
      if (acs.length) { negSp.push(acs); negWhere += ` AND area_coach = ANY($${negSp.length}::text[])`; }
      else { negSp.push(user.scope?.rc_name||user.name); negWhere += ` AND region_coach=$${negSp.length}`; }
    } else if (user.role === 'vp' && vpRcFilter2) {
      negSp.push(vpRcFilter2); negWhere += ` AND region_coach=$${negSp.length}`;
    } else if (user.role === 'vp' && vpAcFilter2) {
      negSp.push(vpAcFilter2); negWhere += ` AND area_coach=$${negSp.length}`;
    }
    const negRes = await p.query(
      `SELECT store_id, store_name, area_coach, metric_date, details
       FROM intel_flags WHERE ${negWhere} ORDER BY metric_date DESC, area_coach, store_name`,
      negSp
    );

    // Flatten complaint details into individual comment rows
    const negative = [];
    for (const row of negRes.rows) {
      const det = row.details || {};
      const complaints = det.complaints || [];
      if (complaints.length > 0) {
        for (const c of complaints) {
          negative.push({
            store_id:   row.store_id,
            store_name: row.store_name,
            area_coach: row.area_coach,
            comment_date: row.metric_date,   // date PAi received it
            event_date:   c.event_date || null, // actual survey/visit date
            source:     c.source,
            summary:    c.summary,
            comment_text: c.comment,
            categories: c.categories || [],
            name_mentioned: c.name_mentioned || null,
            severity:   c.severity || 'medium',
            overall_satisfaction: c.overall_satisfaction,
          });
        }
      } else {
        // Fallback for flags without full complaint detail (pre-update)
        const count = det.negative_count || 1;
        negative.push({
          store_id:   row.store_id,
          store_name: row.store_name,
          area_coach: row.area_coach,
          comment_date: dateStart,
          source:     'SMG',
          summary:    count + ' negative review' + (count !== 1 ? 's' : '') + ' — run batch to load full details',
          comment_text: det.names_mentioned?.length
            ? 'Employee(s) mentioned: ' + det.names_mentioned.join(', ')
            : 'Categories: ' + (det.top_categories || []).join(', ') || 'No details available',
          categories: det.top_categories || [],
          name_mentioned: det.names_mentioned?.[0] || null,
          severity:   'medium',
          overall_satisfaction: null,
        });
      }
    }

    // Build trend data: stores with multiple negative days + repeated name mentions
    const storeNegDays = {};
    const storeNames   = {};
    for (const c of negative) {
      const sid = c.store_id;
      if (!sid) continue;
      storeNames[sid] = c.store_name || sid;
      if (!storeNegDays[sid]) storeNegDays[sid] = new Set();
      const day = String(c.comment_date || '').slice(0, 10);
      if (day) storeNegDays[sid].add(day);
    }
    // Repeated employee names across complaints at same store
    const storeNameMentions = {};
    for (const c of negative) {
      if (!c.store_id || !c.name_mentioned) continue;
      if (!storeNameMentions[c.store_id]) storeNameMentions[c.store_id] = {};
      const n = c.name_mentioned;
      storeNameMentions[c.store_id][n] = (storeNameMentions[c.store_id][n] || 0) + 1;
    }
    const trends = Object.entries(storeNegDays)
      .map(([sid, days]) => {
        const repeatedNames = Object.entries(storeNameMentions[sid] || {})
          .filter(([, cnt]) => cnt >= 2)
          .map(([n, cnt]) => ({ name: n, count: cnt }));
        return { store_id: sid, store_name: storeNames[sid], negative_days: days.size, repeated_names: repeatedNames };
      })
      .filter(t => t.negative_days >= 2 || t.repeated_names.length > 0)
      .sort((a, b) => b.negative_days - a.negative_days);

    res.json({ date_start: dateStart, date_end: dateEnd, positive: posRes.rows, negative, trends });
  } catch (err) {
    console.error('[Intel] /smg-comments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/weekly-digest — WTD visual dashboard data for user's scope ──
router.get('/weekly-digest', async (req, res) => {
  try {
    const user = req.session.user;
    const p    = db.getPool();
    if (!p) return res.status(503).json({ error: 'Database unavailable' });

    const { getFiscalContextString } = require('../services/fiscal-calendar');

    // Week bounds: Monday → yesterday (EST)
    const nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dayOfWeek = nowEST.getDay(); // 0=Sun,1=Mon,2=Tue...
    // PH fiscal week: Tuesday–Monday
    const daysFromTue = dayOfWeek === 0 ? 5 : dayOfWeek === 1 ? 6 : dayOfWeek - 2;
    const weekStart = new Date(nowEST);
    weekStart.setDate(nowEST.getDate() - daysFromTue);
    weekStart.setHours(0, 0, 0, 0);
    const yesterday = new Date(nowEST);
    yesterday.setDate(nowEST.getDate() - 1);
    const weekStartStr  = weekStart.toISOString().split('T')[0];
    const yesterdayStr  = yesterday.toISOString().split('T')[0];

    // Build scope WHERE for flags and metrics
    let flagWhere    = `metric_date BETWEEN $1 AND $2 AND status != 'archived'`;
    let metricsWhere = `metric_date BETWEEN $1 AND $2`;
    const fp = [weekStartStr, yesterdayStr];
    const mp = [weekStartStr, yesterdayStr];

    if (user.scope?.type === 'rdo') {
      const acs = user.scope.area_coaches || [];
      if (acs.length) {
        fp.push(acs); flagWhere    += ` AND area_coach = ANY($${fp.length}::text[])`;
        mp.push(acs); metricsWhere += ` AND area_coach = ANY($${mp.length}::text[])`;
      } else {
        const rc = user.scope.rc_name || user.name;
        fp.push(rc); flagWhere    += ` AND region_coach = $${fp.length}`;
        mp.push(rc); metricsWhere += ` AND region_coach = $${mp.length}`;
      }
    } else if (user.scope?.type === 'area_coach') {
      const ac = user.scope.ac_name || user.name;
      fp.push(ac); flagWhere    += ` AND area_coach = $${fp.length}`;
      mp.push(ac); metricsWhere += ` AND area_coach = $${mp.length}`;
    } else if (user.role === 'vp') {
      const vp = user.scope?.vp_name || user.name;
      fp.push(vp); flagWhere    += ` AND territory_vp = $${fp.length}`;
      mp.push(vp); metricsWhere += ` AND territory_vp = $${mp.length}`;
    }

    // Use most recent day's WTD columns (they accumulate Mon→today)
    // Also fetch daily flag trend counts for the chart
    // Latest date with data in this week's range (for WTD snapshot)
    const latestInWeek = `(SELECT MAX(metric_date) FROM intel_dbs_metrics WHERE ${metricsWhere})`;

    const [regionRes, acRes, flagsByDayRes, topStoresRes] = await Promise.all([
      // Region WTD totals — use most recent day's WTD columns
      p.query(
        `SELECT COUNT(DISTINCT store_id)::int as store_count,
                COALESCE(SUM(net_sales_wtd), 0)::float as net_sales_wtd,
                AVG(NULLIF(growth_pct_wtd, 0))::float as avg_growth_wtd,
                COALESCE(SUM(net_sales_day), 0)::float as net_sales_yesterday,
                AVG(NULLIF(growth_pct_day, 0))::float as avg_growth_yesterday
         FROM intel_dbs_metrics
         WHERE metric_date = ${latestInWeek} AND ${metricsWhere}`, mp
      ),
      // Per-AC WTD (exclude unaligned stores)
      p.query(
        `SELECT area_coach,
                COUNT(DISTINCT store_id)::int as store_count,
                COALESCE(SUM(net_sales_wtd), 0)::float as net_sales_wtd,
                AVG(NULLIF(growth_pct_wtd, 0))::float as avg_growth_wtd
         FROM intel_dbs_metrics
         WHERE metric_date = ${latestInWeek} AND ${metricsWhere}
           AND area_coach IS NOT NULL AND area_coach != 'Unknown'
         GROUP BY area_coach ORDER BY net_sales_wtd DESC`, mp
      ),
      // Flag counts by day for trend chart
      p.query(
        `SELECT TO_CHAR(metric_date,'YYYY-MM-DD') as day,
                COUNT(CASE WHEN severity='high'   THEN 1 END)::int as high,
                COUNT(CASE WHEN severity='medium' THEN 1 END)::int as medium,
                COUNT(CASE WHEN severity='low'    THEN 1 END)::int as low
         FROM intel_flags WHERE ${flagWhere}
         GROUP BY metric_date ORDER BY metric_date`, fp
      ),
      // Top 5 stores by WTD growth
      p.query(
        `SELECT store_id, store_name, area_coach,
                net_sales_wtd::float, growth_pct_wtd::float
         FROM intel_dbs_metrics
         WHERE metric_date = ${latestInWeek} AND ${metricsWhere}
           AND growth_pct_wtd IS NOT NULL
         ORDER BY growth_pct_wtd DESC LIMIT 5`, mp
      )
    ]);

    // Velocity WTD averages — scoped to user's hierarchy via store_assignments
    const velParams = [weekStartStr, yesterdayStr];
    let velScopeJoin = 'JOIN store_assignments sa ON v.store_id=sa.store_id';
    if (user.scope?.type === 'rdo') {
      const acs = user.scope.area_coaches || [];
      if (acs.length) { velParams.push(acs); velScopeJoin += ` AND sa.area_coach = ANY($${velParams.length}::text[])`; }
      else { velParams.push(user.scope.rc_name || user.name); velScopeJoin += ` AND sa.region_coach=$${velParams.length}`; }
    } else if (user.scope?.type === 'area_coach') {
      velParams.push(user.scope.ac_name || user.name); velScopeJoin += ` AND sa.area_coach=$${velParams.length}`;
    } else if (user.role === 'vp') {
      velParams.push(user.scope?.vp_name || user.name); velScopeJoin += ` AND sa.vp=$${velParams.length}`;
    }

    const [velByACRes, storeDetailRes] = await Promise.all([
      p.query(`
        SELECT sa.area_coach,
               ROUND(AVG(v.on_time_pct)::numeric, 1)::float      AS avg_otd_pct,
               ROUND(AVG(v.pct_lt4)::numeric, 1)::float           AS avg_pct_lt4,
               COUNT(DISTINCT v.store_id)::int                    AS store_count
        FROM velocity_daily_records v
        ${velScopeJoin}
        WHERE v.record_date BETWEEN $1 AND $2
        GROUP BY sa.area_coach ORDER BY sa.area_coach`, velParams
      ),
      p.query(`
        SELECT store_id, store_name, area_coach,
               net_sales_wtd::float, growth_pct_wtd::float,
               net_sales_day::float, growth_pct_day::float
        FROM intel_dbs_metrics
        WHERE metric_date = ${latestInWeek} AND ${metricsWhere}
        ORDER BY area_coach, store_name`, mp
      )
    ]);

    // Labor % from Fourth soft_indicators — avg actual & scheduled per AC for the week
    const laborParams = [weekStartStr, yesterdayStr];
    let laborScopeWhere = '1=1';
    if (user.scope?.type === 'rdo') {
      const acs = user.scope.area_coaches || [];
      if (acs.length) { laborParams.push(acs); laborScopeWhere = `sa.area_coach = ANY($${laborParams.length}::text[])`; }
      else { laborParams.push(user.scope.rc_name || user.name); laborScopeWhere = `sa.region_coach=$${laborParams.length}`; }
    } else if (user.scope?.type === 'area_coach') {
      laborParams.push(user.scope.ac_name || user.name); laborScopeWhere = `sa.area_coach=$${laborParams.length}`;
    } else if (user.role === 'vp') {
      laborParams.push(user.scope?.vp_name || user.name); laborScopeWhere = `sa.vp=$${laborParams.length}`;
    }
    const laborByACRes = await p.query(`
      SELECT sa.area_coach,
             ROUND(AVG(CASE WHEN si.indicator='labor_pct'     THEN si.value END)::numeric, 1)::float AS act_labor_pct,
             ROUND(AVG(CASE WHEN si.indicator='sch_labor_pct' THEN si.value END)::numeric, 1)::float AS sched_labor_pct
      FROM dbs_soft_indicators si
      JOIN store_assignments sa ON si.store_id = sa.store_id
      WHERE si.metric_date BETWEEN $1 AND $2
        AND si.indicator IN ('labor_pct', 'sch_labor_pct')
        AND ${laborScopeWhere}
      GROUP BY sa.area_coach`, laborParams);
    const laborMap = {};
    for (const r of laborByACRes.rows) laborMap[r.area_coach] = r;

    const velMap = {};
    for (const r of velByACRes.rows) velMap[r.area_coach] = r;
    const byACWithVel = acRes.rows.map(a => ({
      ...a,
      velocity:        velMap[a.area_coach]   || null,
      act_labor_pct:   laborMap[a.area_coach]?.act_labor_pct   ?? null,
      sched_labor_pct: laborMap[a.area_coach]?.sched_labor_pct ?? null,
    }));

    const storesByAC = {};
    for (const s of storeDetailRes.rows) {
      const ac = s.area_coach || 'Unknown';
      if (!storesByAC[ac]) storesByAC[ac] = [];
      storesByAC[ac].push(s);
    }

    res.json({
      week_start:        weekStartStr,
      week_end:          yesterdayStr,
      fiscal_context:    getFiscalContextString ? getFiscalContextString() : '',
      region:            regionRes.rows[0] || {},
      by_ac:             byACWithVel,
      stores_by_ac:      storesByAC,
      flags_by_day:      flagsByDayRes.rows,
      top_stores:        topStoresRes.rows,
    });
  } catch (err) {
    console.error('[Intel] /weekly-digest error:', err.message);
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

// ── POST /api/intel/upload/winscore — manual SMG Win Score CSV upload ──────────
// Accepts the CSV export from reporting.smg.com Comparison Report.
router.post('/upload/winscore', requireRole('rdo', 'vp', 'area_coach'), smgUpload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded. Attach the Win Score CSV export.' });

  const targetDate = req.body.date || (() => {
    const now = new Date();
    const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    est.setDate(est.getDate() - 1);
    return est.toISOString().split('T')[0];
  })();

  console.log(`[WinScore Upload] Processing ${file.originalname} for ${targetDate}`);

  try {
    const { parseWinScoreCSV } = require('../services/intel-smg-winscore');
    const csvText = fs.readFileSync(file.path, 'utf8');
    const scores  = parseWinScoreCSV(csvText);

    if (!scores.length) {
      fs.unlink(file.path, () => {});
      return res.json({ success: true, message: 'File parsed — no Win Score data found.', scoresWritten: 0 });
    }

    const pool = db.getPool();
    if (!pool) throw new Error('No DB connection');

    let written = 0;
    for (const s of scores) {
      await pool.query(`
        INSERT INTO smg_win_scores (store_id, period_end_date, win_score, survey_count, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (store_id, period_end_date)
        DO UPDATE SET win_score=$3, survey_count=$4, updated_at=NOW()
      `, [s.store_id, targetDate, s.win_score, s.survey_count]);
      written++;
    }

    fs.unlink(file.path, () => {});
    res.json({
      success: true,
      message: `Processed ${scores.length} stores — ${written} Win Scores written for ${targetDate}.`,
      summary: { scoresWritten: written, storeCount: scores.length, targetDate },
    });
  } catch (err) {
    console.error('[WinScore Upload] Error:', err.message);
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


// ── In-memory cache for AI-generated morning brief memos ─────────────────────
const briefMemoCache = new Map(); // key: `${username}_${date}` → { memo, ts }
const BRIEF_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── GET /api/intel/morning-brief — AI executive memo + priority flags + shoutouts ──
router.get('/morning-brief', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const p    = db.getPool();
    if (!p) return res.json({ memo_text: 'Database unavailable.', priority_flags: [], shoutouts: [], follow_up_items: [] });

    // "View as AC" — manager sees the brief of a specific area coach
    const viewAsAC      = req.query.view_as_ac || null;
    const forceRefreshV = req.query.refresh === '1';
    if (viewAsAC && ['rdo','vp'].includes(user.role)) {
      // Match by name OR ac_name in scope (case-insensitive fallback)
      const acUser = USER_ROSTER.find(u =>
        u.role === 'area_coach' &&
        (u.name === viewAsAC || u.scope?.ac_name === viewAsAC ||
         u.name?.toLowerCase() === viewAsAC.toLowerCase() ||
         u.scope?.ac_name?.toLowerCase() === viewAsAC.toLowerCase())
      );

      const acName = acUser?.scope?.ac_name || acUser?.name || viewAsAC;
      const yesterday2 = (() => { const d=new Date(); d.setDate(d.getDate()-1); return d.toLocaleDateString('en-CA',{timeZone:'America/New_York'}); })();
      const dr2 = await p.query(`SELECT TO_CHAR(MAX(metric_date),'YYYY-MM-DD') AS latest FROM intel_dbs_metrics WHERE metric_date<=$1`,[yesterday2]);
      const date2 = dr2.rows[0]?.latest || yesterday2;

      // Fetch flags for this AC's stores (always needed for sidebar)
      const fr = await p.query(
        `SELECT store_id,store_name,area_coach,metric_type,value,severity,consecutive_days_out,status,created_at AS flag_date,details
         FROM intel_flags WHERE metric_date=$1 AND area_coach=$2 AND status!='archived'
         ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,consecutive_days_out DESC LIMIT 50`,
        [date2, acName]
      );

      // Check DB cache first (unless forced refresh)
      let acMemo = null;
      if (!forceRefreshV && acUser) {
        const dbCached = await db.getIntelCache({ userId: acUser.username + '::brief', cacheDate: date2 });
        if (dbCached?.data?.memo_text) acMemo = dbCached.data.memo_text;
      }

      // Generate on-demand if no cache (scoped to this AC)
      if (!acMemo) {
        const [acMetRes, acSalesRes, acVelRes, acFlagsRes, acShoutRes, acFollowRes] = await Promise.all([
          p.query(`SELECT COUNT(DISTINCT store_id)::int as store_count, COALESCE(SUM(net_sales_day),0)::float as net_sales_day, AVG(growth_pct_day)::float as avg_growth_day FROM intel_dbs_metrics WHERE metric_date=$1 AND area_coach=$2`, [date2, acName]),
          p.query(`SELECT store_id, store_name, area_coach, net_sales_day::float, growth_pct_day::float FROM intel_dbs_metrics WHERE metric_date=$1 AND area_coach=$2 ORDER BY net_sales_day DESC NULLS LAST`, [date2, acName]),
          p.query(`SELECT v.store_id, COALESCE(sa.store_name,v.store_id::text) as store_name, ROUND(AVG(v.on_time_pct)::numeric,1)::float AS avg_otd_pct, ROUND(AVG(v.pct_lt4)::numeric,1)::float AS avg_pct_lt4 FROM velocity_daily_records v JOIN store_assignments sa ON v.store_id=sa.store_id WHERE v.record_date=$1 AND sa.area_coach=$2 AND v.on_time_pct IS NOT NULL GROUP BY v.store_id, sa.store_name`, [date2, acName]),
          p.query(`SELECT store_id,store_name,area_coach,metric_type,value,severity,consecutive_days_out,status,details FROM intel_flags WHERE metric_date=$1 AND area_coach=$2 AND status!='archived' ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, consecutive_days_out DESC LIMIT 50`, [date2, acName]),
          p.query(`SELECT s.store_id, COALESCE(a.store_name,s.store_id) as store_name, s.summary, s.full_comment AS comment_text, a.area_coach FROM intel_shoutouts s LEFT JOIN store_assignments a ON s.store_id=a.store_id WHERE s.shoutout_date=$1 AND a.area_coach=$2 LIMIT 10`, [date2, acName]),
          p.query(`SELECT ack.acknowledged_by, ack.action_taken, ack.acknowledged_at, f.store_id, f.store_name, f.metric_type, f.status as flag_status, f.consecutive_days_out FROM intel_acknowledgments ack JOIN intel_flags f ON f.id=ack.flag_id WHERE ack.acknowledged_at>=NOW()-INTERVAL '7 days' AND (f.status!='resolved' OR f.consecutive_days_out>=3) AND f.area_coach=$1 LIMIT 15`, [acName]),
        ]);
        const { generateMorningBrief } = require('../services/claude');
        const { getFiscalContextString } = require('../services/fiscal-calendar');
        acMemo = await generateMorningBrief({
          date: date2,
          userName:      acUser?.name || viewAsAC,
          userRole:      'area_coach',
          fiscalContext: getFiscalContextString ? getFiscalContextString() : '',
          regionMetrics: acMetRes.rows[0] || {},
          byAC:          [],
          byStore:       acSalesRes.rows,
          velocity:      acVelRes.rows,
          flags:         acFlagsRes.rows,
          shoutouts:     acShoutRes.rows,
          followUps:     acFollowRes.rows,
        });
        // Cache it so next load is instant
        if (acUser) {
          await db.upsertIntelCache({
            user_id: acUser.username + '::brief', cache_date: date2,
            role: 'morning_brief', payload: { memo_text: acMemo, generated_at: new Date().toISOString() }
          }).catch(() => {});
        }
      }

      return res.json({
        date: date2, memo_text: acMemo,
        viewing_as: acUser?.name || viewAsAC, viewing_as_role: 'Area Coach',
        priority_flags: fr.rows, shoutouts: [], follow_up_items: [],
      });
    }

    // Resolve most recent date with DBS data
    const yesterday = (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    })();
    const dateRes = await p.query(
      `SELECT TO_CHAR(MAX(metric_date), 'YYYY-MM-DD') AS latest FROM intel_dbs_metrics WHERE metric_date <= $1`,
      [yesterday]
    );
    const date = dateRes.rows[0]?.latest || yesterday;

    // Build scope WHERE fragments
    let flagWhere    = `metric_date = $1 AND status != 'archived'`;
    let metricsWhere = `metric_date = $1`;
    const fp = [date], mp = [date];

    if (user.scope?.type === 'rdo') {
      const acs = user.scope.area_coaches || [];
      if (acs.length) {
        fp.push(acs); flagWhere    += ` AND area_coach = ANY($${fp.length}::text[])`;
        mp.push(acs); metricsWhere += ` AND area_coach = ANY($${mp.length}::text[])`;
      } else {
        const rc = user.scope.rc_name || user.name;
        fp.push(rc); flagWhere    += ` AND region_coach = $${fp.length}`;
        mp.push(rc); metricsWhere += ` AND region_coach = $${mp.length}`;
      }
    } else if (user.scope?.type === 'area_coach') {
      const ac = user.scope.ac_name || user.name;
      fp.push(ac); flagWhere    += ` AND area_coach = $${fp.length}`;
      mp.push(ac); metricsWhere += ` AND area_coach = $${mp.length}`;
    } else if (user.role === 'vp') {
      const vp = user.scope?.vp_name || user.name;
      fp.push(vp); flagWhere    += ` AND territory_vp = $${fp.length}`;
      mp.push(vp); metricsWhere += ` AND territory_vp = $${mp.length}`;
    }

    // Parallel data fetch — including per-store breakdown for hierarchy-aware brief
    const [flagsRes, metricsRes, acMetricsRes, storeMetricsRes, shoutoutsRes, velocityRes, followUpRes] = await Promise.all([
      p.query(
        `SELECT store_id, store_name, area_coach, metric_type, value, target, variance,
                severity, consecutive_days_out, status, created_at AS flag_date, details
         FROM intel_flags WHERE ${flagWhere}
         ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                  consecutive_days_out DESC LIMIT 100`, fp
      ),
      p.query(
        `SELECT COUNT(DISTINCT store_id)::int as store_count,
                COALESCE(SUM(net_sales_day), 0)::float as net_sales_day,
                AVG(growth_pct_day)::float as avg_growth_day,
                COALESCE(SUM(net_sales_wtd), 0)::float as net_sales_wtd,
                AVG(growth_pct_wtd)::float as avg_growth_wtd
         FROM intel_dbs_metrics WHERE ${metricsWhere}`, mp
      ),
      // Per-AC summary (for RDO/VP briefs)
      p.query(
        `SELECT area_coach,
                COUNT(DISTINCT store_id)::int as store_count,
                COALESCE(SUM(net_sales_day), 0)::float as net_sales_day,
                AVG(growth_pct_day)::float as avg_growth_day
         FROM intel_dbs_metrics WHERE ${metricsWhere}
           AND area_coach IS NOT NULL AND area_coach != 'Unknown'
         GROUP BY area_coach ORDER BY net_sales_day DESC`, mp
      ),
      // Per-store breakdown (for AC briefs + store callouts in RDO briefs)
      p.query(
        `SELECT store_id, store_name, area_coach,
                net_sales_day::float, growth_pct_day::float
         FROM intel_dbs_metrics WHERE ${metricsWhere}
         ORDER BY area_coach, net_sales_day DESC NULLS LAST`, mp
      ),
      (() => {
        const sq = [`SELECT s.id, s.store_id, COALESCE(a.store_name, s.store_id) as store_name, s.summary,
                s.full_comment AS comment_text, s.shoutout_date, a.area_coach
         FROM intel_shoutouts s
         LEFT JOIN store_assignments a ON s.store_id = a.store_id
         WHERE s.shoutout_date = $1`];
        const sp = [date];
        if (user.scope?.type === 'area_coach') { sp.push(user.scope.ac_name || user.name); sq.push(`AND a.area_coach = $${sp.length}`); }
        else if (user.scope?.type === 'rdo') {
          const acs = user.scope.area_coaches || [];
          if (acs.length) { sp.push(acs); sq.push(`AND a.area_coach = ANY($${sp.length}::text[])`); }
          else { sp.push(user.scope.rc_name || user.name); sq.push(`AND a.region_coach = $${sp.length}`); }
        }
        sq.push('ORDER BY s.shoutout_date DESC LIMIT 20');
        return p.query(sq.join(' '), sp);
      })(),
      (() => {
        const vp = [date];
        let vj = 'JOIN store_assignments sa ON v.store_id=sa.store_id';
        if (user.scope?.type === 'rdo') {
          const acs = user.scope.area_coaches || [];
          if (acs.length) { vp.push(acs); vj += ` AND sa.area_coach = ANY($${vp.length}::text[])`; }
          else { vp.push(user.scope.rc_name || user.name); vj += ` AND sa.region_coach=$${vp.length}`; }
        } else if (user.scope?.type === 'area_coach') {
          vp.push(user.scope.ac_name || user.name); vj += ` AND sa.area_coach=$${vp.length}`;
        }
        return p.query(`
          SELECT sa.area_coach, v.store_id, COALESCE(sa.store_name, v.store_id::text) as store_name,
                 ROUND(AVG(v.on_time_pct)::numeric,1)::float AS avg_otd_pct,
                 ROUND(AVG(v.pct_lt4)::numeric,1)::float      AS avg_pct_lt4
          FROM velocity_daily_records v ${vj}
          WHERE v.record_date=$1 AND v.on_time_pct IS NOT NULL
          GROUP BY sa.area_coach, v.store_id, sa.store_name ORDER BY sa.area_coach`, vp);
      })(),
      (() => {
        const fup = [`SELECT ack.flag_id, ack.acknowledged_by, ack.action_taken,
                ack.acknowledged_at, f.store_id, f.store_name, f.area_coach,
                f.metric_type, f.metric_date, f.status as flag_status, f.consecutive_days_out
         FROM intel_acknowledgments ack JOIN intel_flags f ON f.id = ack.flag_id
         WHERE ack.acknowledged_at >= NOW() - INTERVAL '7 days'
           AND (f.status != 'resolved' OR f.consecutive_days_out >= 3)`];
        const fpp = [];
        if (user.scope?.type === 'rdo') {
          const acs = user.scope.area_coaches || [];
          if (acs.length) { fpp.push(acs); fup.push(`AND f.area_coach = ANY($${fpp.length}::text[])`); }
          else { fpp.push(user.scope.rc_name || user.name); fup.push(`AND f.region_coach = $${fpp.length}`); }
        } else if (user.scope?.type === 'area_coach') {
          fpp.push(user.scope.ac_name || user.name); fup.push(`AND f.area_coach = $${fpp.length}`);
        }
        fup.push('ORDER BY ack.acknowledged_at DESC LIMIT 20');
        return p.query(fup.join(' '), fpp);
      })()
    ]);

    const acFlagCounts = {};
    for (const fl of flagsRes.rows) {
      if (fl.severity === 'high') acFlagCounts[fl.area_coach] = (acFlagCounts[fl.area_coach] || 0) + 1;
    }
    const byAC    = acMetricsRes.rows.map(a => ({ ...a, high_flags: acFlagCounts[a.area_coach] || 0 }));
    const byStore = storeMetricsRes.rows;

    // Cache: in-memory → DB (pipeline) → on-demand
    const cacheKey    = `${user.username}_${date}`;
    const forceRefresh = req.query.refresh === '1';
    if (forceRefresh) briefMemoCache.delete(cacheKey);
    const inmem = briefMemoCache.get(cacheKey);
    let memo_text;

    if (!forceRefresh && inmem && (Date.now() - inmem.ts) < BRIEF_CACHE_TTL) {
      memo_text = inmem.memo;
    } else {
      const dbCached = await db.getIntelCache({ userId: user.username + '::brief', cacheDate: date });
      if (!forceRefresh && dbCached?.data?.memo_text) {
        memo_text = dbCached.data.memo_text;
      } else {
        const { generateMorningBrief } = require('../services/claude');
        const { getFiscalContextString } = require('../services/fiscal-calendar');
        memo_text = await generateMorningBrief({
          date, userName: user.name, userRole: user.role,
          fiscalContext: getFiscalContextString ? getFiscalContextString() : '',
          regionMetrics: metricsRes.rows[0] || {},
          byAC, byStore, velocity: velocityRes.rows,
          flags: flagsRes.rows, shoutouts: shoutoutsRes.rows, followUps: followUpRes.rows,
        });
        await db.upsertIntelCache({
          user_id: user.username + '::brief', cache_date: date,
          role: 'morning_brief', payload: { memo_text, generated_at: new Date().toISOString() }
        }).catch(() => {});
      }
      briefMemoCache.set(cacheKey, { memo: memo_text, ts: Date.now() });
    }

    res.json({
      date, memo_text,
      priority_flags:  flagsRes.rows,
      shoutouts:       shoutoutsRes.rows,
      follow_up_items: followUpRes.rows,
      metrics_summary: metricsRes.rows[0] || {},
    });
  } catch (err) {
    console.error('[Intel] /morning-brief error:', err.message);
    res.status(500).json({ error: err.message, memo_text: 'Error loading brief.', priority_flags: [], shoutouts: [], follow_up_items: [] });
  }
});

// ── GET /api/intel/db-check — session-auth diagnostic: what dates have data ────
router.get('/db-check', requireRole('rdo', 'vp'), async (req, res) => {
  try {
    const p = db.getPool();
    if (!p) return res.json({ error: 'no pool' });

    const [datesRes, assignRes, flagsRes, cacheRes] = await Promise.all([
      p.query(`SELECT TO_CHAR(metric_date, 'YYYY-MM-DD') AS d, COUNT(DISTINCT store_id)::int AS stores
               FROM intel_dbs_metrics GROUP BY metric_date ORDER BY metric_date DESC LIMIT 14`),
      p.query(`SELECT COUNT(*)::int AS total,
                      COUNT(DISTINCT area_coach)::int AS area_coaches,
                      COUNT(DISTINCT region_coach)::int AS region_coaches
               FROM store_assignments`),
      p.query(`SELECT TO_CHAR(metric_date, 'YYYY-MM-DD') AS d,
                      COUNT(*)::int AS cnt,
                      COUNT(CASE WHEN severity='high' THEN 1 END)::int AS high
               FROM intel_flags WHERE status != 'archived'
               GROUP BY metric_date ORDER BY metric_date DESC LIMIT 14`),
      p.query(`SELECT user_id, cache_date, role, TO_CHAR(generated_at, 'YYYY-MM-DD HH24:MI') AS generated_at
               FROM intel_cache ORDER BY generated_at DESC LIMIT 10`)
    ]);

    res.json({
      dbs_metrics_by_date:  datesRes.rows,
      store_assignments:    assignRes.rows[0],
      flags_by_date:        flagsRes.rows,
      recent_cache_entries: cacheRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Flag trend history (last N days for a store+metric) ──────────────────────
router.get('/flag-trend', requireAuth, async (req, res) => {
  const { store_id, metric_type, date } = req.query;
  if (!store_id || !metric_type) return res.json([]);
  const p = db.getPool();
  if (!p) return res.json([]);
  const endDate = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  try {
    const rows = await p.query(
      `SELECT TO_CHAR(metric_date,'YYYY-MM-DD') AS metric_date, value, severity, details
       FROM intel_flags
       WHERE store_id=$1 AND metric_type=$2 AND metric_date <= $3
       ORDER BY metric_date DESC LIMIT 10`,
      [store_id, metric_type, endDate]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HutBot WTD per-store summary ─────────────────────────────────────────────
router.get('/hutbot-wtd', requireAuth, async (req, res) => {
  const p = db.getPool();
  if (!p) return res.json([]);
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  try {
    // Start of the current week (Monday)
    const dt = new Date(date + 'T12:00:00');
    const dow = dt.getDay();
    const startOfWeek = new Date(dt);
    startOfWeek.setDate(dt.getDate() - (dow === 0 ? 6 : dow - 1));
    const weekStart = startOfWeek.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const rows = await p.query(
      `SELECT store_id, store_name, area_coach,
         COUNT(CASE WHEN metric_type='ROUTINE_MISSED' THEN 1 END)::int AS missed,
         COUNT(CASE WHEN metric_type='ROUTINE_LATE'   THEN 1 END)::int AS late,
         array_agg(DISTINCT CASE WHEN metric_type='ROUTINE_MISSED' THEN details->>'routine_name' END
           ORDER BY 1) FILTER (WHERE metric_type='ROUTINE_MISSED') AS missed_routines,
         array_agg(DISTINCT CASE WHEN metric_type='ROUTINE_LATE' THEN details->>'routine_name' END
           ORDER BY 1) FILTER (WHERE metric_type='ROUTINE_LATE') AS late_routines
       FROM intel_flags
       WHERE metric_date BETWEEN $1 AND $2
         AND metric_type IN ('ROUTINE_MISSED','ROUTINE_LATE')
       GROUP BY store_id, store_name, area_coach
       ORDER BY missed DESC, late DESC`,
      [weekStart, date]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/automation/fourth-diag — diagnose Fourth API connectivity ───
// Token-protected. Returns step-by-step auth + report discovery results.
router.get('/automation/fourth-diag', async (req, res) => {
  const token = req.query.token || req.headers['x-automation-token'];
  const validTokens = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
  if (!validTokens.includes(token)) return res.status(401).json({ error: 'Unauthorized' });

  const user = process.env.FOURTH_USER     || '';
  const pass = process.env.FOURTH_PASSWORD || '';
  const diag = { env: { FOURTH_USER: user ? '✓ set' : '✗ missing', FOURTH_PASSWORD: pass ? '✓ set' : '✗ missing' }, steps: {} };

  if (!user || !pass) {
    return res.json({ ...diag, error: 'FOURTH_USER / FOURTH_PASSWORD not set in environment' });
  }

  try {
    // Step 1: Auth
    const https  = require('https');
    const FOURTH_HOST = 'analytics.na1.fourth.com';
    const PROJECT_ID  = 'q0t16mq5dgsreqiq8macw3ghv3k1iuqc';

    function httpReq(method, urlPath, { headers={}, body, cookieJar=[] }={}) {
      return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req  = https.request({
          hostname: FOURTH_HOST, path: urlPath, method,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
            ...(cookieJar.length ? { Cookie: cookieJar.join('; ') } : {}),
            ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            ...headers,
          }
        }, res2 => {
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => resolve({
            status: res2.statusCode,
            headers: res2.headers,
            newCookies: (res2.headers['set-cookie']||[]).map(c=>c.split(';')[0]),
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.setTimeout(30000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
      });
    }

    // Auth step
    const loginResp = await httpReq('POST', '/gdc/account/login', {
      body: { postUserLogin: { login: user, password: pass, remember: 1, captcha: '', verifyCaptcha: '' } }
    });
    diag.steps.login = { status: loginResp.status, cookies: loginResp.newCookies.map(c=>c.split('=')[0]) };
    if (loginResp.status !== 200 && loginResp.status !== 201) {
      diag.steps.login.error = loginResp.body.slice(0, 500);
      return res.json(diag);
    }

    const jar = loginResp.newCookies.filter(c => c.startsWith('GDCAuthSST'));
    const tokenResp = await httpReq('GET', '/gdc/account/token', { cookieJar: jar });
    diag.steps.token = { status: tokenResp.status };
    if (tokenResp.newCookies.length) jar.push(...tokenResp.newCookies.filter(c=>c.startsWith('GDCAuthTT')));

    // List reports
    const rptResp = await httpReq('GET', `/gdc/md/${PROJECT_ID}/query/reports`, { cookieJar: jar });
    diag.steps.reportList = { status: rptResp.status };
    if (rptResp.status === 200) {
      try {
        const data = JSON.parse(rptResp.body);
        const entries = data.query?.entries || [];
        diag.steps.reportList.total = entries.length;
        // Show all reports with labor/overtime/schedule/hours keywords
        const laborKw  = ['labor','labour','scheduled','actual labor','lab cost','labor cost','overview by location'];
        const otKw     = ['overtime','over time',' ot ','double time'];
        diag.steps.reportList.labor_matches  = entries.filter(e=>laborKw.some(k=>(e.title||'').toLowerCase().includes(k))).map(e=>({title:e.title,link:e.link}));
        diag.steps.reportList.ot_matches     = entries.filter(e=>otKw.some(k=>(e.title||'').toLowerCase().includes(k))).map(e=>({title:e.title,link:e.link}));
        diag.steps.reportList.all_titles     = entries.map(e=>e.title).sort();
      } catch (e) {
        diag.steps.reportList.parseError = e.message;
        diag.steps.reportList.rawPreview = rptResp.body.slice(0, 500);
      }
    } else {
      diag.steps.reportList.body = rptResp.body.slice(0, 500);
    }

    // Try executing first labor match to see what comes back
    if (diag.steps.reportList.labor_matches?.length) {
      const testUri = diag.steps.reportList.labor_matches[0].link;
      diag.steps.testExecute = { report: diag.steps.reportList.labor_matches[0].title, uri: testUri };
      try {
        const execResp = await httpReq('POST', `/gdc/app/projects/${PROJECT_ID}/execute/raw/`,
          { cookieJar: jar, body: { report_req: { report: testUri } } });
        diag.steps.testExecute.execStatus = execResp.status;
        if (execResp.status === 200 || execResp.status === 201) {
          const resultUri = JSON.parse(execResp.body).uri;
          diag.steps.testExecute.resultUri = resultUri;
          // Poll once
          await new Promise(r=>setTimeout(r,3000));
          const pollResp = await httpReq('GET', resultUri, { cookieJar: jar });
          diag.steps.testExecute.pollStatus = pollResp.status;
          diag.steps.testExecute.pollBytes  = pollResp.body.length;
          diag.steps.testExecute.contentType = pollResp.headers['content-type'];
          diag.steps.testExecute.bodyPreview = pollResp.body.slice(0,200);
        } else {
          diag.steps.testExecute.execBody = execResp.body.slice(0,300);
        }
      } catch(e){ diag.steps.testExecute.error = e.message; }
    }

    res.json(diag);
  } catch (err) {
    diag.error = err.message;
    res.json(diag);
  }
});

// ── GET /api/intel/scope-stores — AC list + stores for global filter dropdowns ─
router.get('/scope-stores', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const p    = db.getPool();
    if (!p) return res.json({ area_coaches: [], stores_by_ac: {} });

    let acWhere = '1=1'; const params = [];
    if (user.scope?.type === 'rdo') {
      const acs = user.scope.area_coaches || [];
      if (acs.length) { params.push(acs); acWhere = `area_coach = ANY($${params.length}::text[])`; }
      else { params.push(user.scope.rc_name || user.name); acWhere = `region_coach = $${params.length}`; }
    } else if (user.scope?.type === 'area_coach') {
      params.push(user.scope.ac_name || user.name); acWhere = `area_coach = $${params.length}`;
    } else if (user.role === 'vp') {
      const rcFilter = req.query.rc_name || null;
      if (rcFilter) { params.push(rcFilter); acWhere = `region_coach = $${params.length}`; }
    }

    const r = await p.query(
      `SELECT area_coach, store_id, store_name FROM store_assignments WHERE ${acWhere} ORDER BY area_coach, store_name`,
      params
    );

    const area_coaches = [...new Set(r.rows.map(x => x.area_coach).filter(Boolean))].sort();
    const stores_by_ac = {};
    for (const row of r.rows) {
      const ac = row.area_coach || 'Unknown';
      if (!stores_by_ac[ac]) stores_by_ac[ac] = [];
      stores_by_ac[ac].push({ store_id: row.store_id, store_name: row.store_name });
    }

    res.json({ area_coaches, stores_by_ac });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
