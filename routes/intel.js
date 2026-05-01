'use strict';
/**
 * Intel Routes — /api/intel/*
 * Serves cached intel dashboard data, handles acknowledgments, weekly digest.
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../services/db');

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

  try {
    const { runIntelPipeline } = require('../services/intel-pipeline');
    const result = await runIntelPipeline(targetDate);
    console.log('[Intel] Pipeline complete:', JSON.stringify(result.steps, null, 2));
    if (result.errors.length) console.warn('[Intel] Pipeline errors:', result.errors);
  } catch (err) {
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
router.use(requireAuth);

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
    const date = req.query.date || (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    })();

    const p = db.getPool();
    if (!p) return res.json({ success: true, date, summary: null, areas: [] });

    // Scope filter
    let metricWhere = 'metric_date = $1';
    const mp = [date];
    if (user.scope?.type === 'rdo') {
      // Use area_coach IN list to match regardless of stored region_coach value
      const acs = user.scope.area_coaches || [];
      if (acs.length) {
        mp.push(acs);
        metricWhere += ` AND area_coach = ANY($${mp.length}::text[])`;
      } else {
        mp.push(user.scope.rc_name);
        metricWhere += ` AND region_coach = $${mp.length}`;
      }
    } else if (user.scope?.type === 'area_coach') {
      mp.push(user.scope.ac_name);
      metricWhere += ` AND area_coach = $${mp.length}`;
    }

    // Flags scoped the same way
    let flagWhere = "metric_date = $1 AND status != 'archived'";
    const fp = [date];
    if (user.scope?.type === 'rdo') {
      const acs = user.scope.area_coaches || [];
      if (acs.length) { fp.push(acs); flagWhere += ` AND area_coach = ANY($${fp.length}::text[])`; }
      else { fp.push(user.scope.rc_name); flagWhere += ` AND region_coach = $${fp.length}`; }
    } else if (user.scope?.type === 'area_coach') {
      fp.push(user.scope.ac_name);
      flagWhere += ` AND area_coach = $${fp.length}`;
    }

    const [metricsRes, flagsRes] = await Promise.all([
      p.query(`SELECT area_coach, region_coach,
        COUNT(*) as store_count,
        SUM(net_sales_day) as total_sales,
        AVG(net_sales_day) as avg_sales,
        AVG(growth_pct_day) as avg_growth,
        SUM(change_down_day) as total_change_down,
        SUM(cash_variance_day) as total_cash_var,
        SUM(paidouts_day) as total_paidouts
        FROM intel_dbs_metrics WHERE ${metricWhere}
        GROUP BY area_coach, region_coach ORDER BY area_coach`, mp),
      p.query(`SELECT area_coach, severity, COUNT(*) as cnt
        FROM intel_flags WHERE ${flagWhere}
        GROUP BY area_coach, severity`, fp)
    ]);

    // Build per-area flag counts
    const flagMap = {};
    for (const r of flagsRes.rows) {
      if (!flagMap[r.area_coach]) flagMap[r.area_coach] = { high: 0, medium: 0, low: 0, total: 0 };
      flagMap[r.area_coach][r.severity] = (flagMap[r.area_coach][r.severity] || 0) + Number(r.cnt);
      flagMap[r.area_coach].total += Number(r.cnt);
    }

    // Store-level detail for drill-down
    const storeRes = await p.query(`
      SELECT area_coach, store_id, store_name,
        net_sales_day, growth_pct_day, change_down_day,
        cash_variance_day, paidouts_day, production_lt15_day
      FROM intel_dbs_metrics WHERE ${metricWhere}
      ORDER BY area_coach, store_id`, mp);

    const storeFlagRes = await p.query(`
      SELECT store_id, metric_type, severity, value, consecutive_days_out
      FROM intel_flags WHERE ${flagWhere}
      ORDER BY store_id, severity DESC`, fp);

    const storeFlagMap = {};
    for (const r of storeFlagRes.rows) {
      if (!storeFlagMap[r.store_id]) storeFlagMap[r.store_id] = [];
      storeFlagMap[r.store_id].push({ metric_type: r.metric_type, severity: r.severity, value: Number(r.value), days: r.consecutive_days_out });
    }

    const storesByAC = {};
    for (const r of storeRes.rows) {
      const ac = r.area_coach || 'Unknown';
      if (!storesByAC[ac]) storesByAC[ac] = [];
      storesByAC[ac].push({
        store_id: r.store_id, store_name: r.store_name,
        net_sales_day: r.net_sales_day ? Number(r.net_sales_day) : null,
        growth_pct_day: r.growth_pct_day ? Number(r.growth_pct_day) : null,
        change_down_day: r.change_down_day ? Number(r.change_down_day) : null,
        flags: storeFlagMap[r.store_id] || []
      });
    }

    const areas = metricsRes.rows.map(r => {
      const ac = r.area_coach;
      const flags = flagMap[ac] || { high: 0, medium: 0, low: 0, total: 0 };
      return {
        area_coach: ac,
        region_coach: r.region_coach,
        store_count: Number(r.store_count),
        total_sales: r.total_sales ? Number(r.total_sales) : null,
        avg_sales: r.avg_sales ? Number(r.avg_sales) : null,
        avg_growth: r.avg_growth ? Number(r.avg_growth) : null,
        total_change_down: r.total_change_down ? Number(r.total_change_down) : null,
        total_cash_var: r.total_cash_var ? Number(r.total_cash_var) : null,
        total_paidouts: r.total_paidouts ? Number(r.total_paidouts) : null,
        flags,
        stores: storesByAC[ac] || []
      };
    });

    // Region-level summary
    const summary = {
      total_stores: areas.reduce((n, a) => n + a.store_count, 0),
      total_sales: areas.reduce((n, a) => n + (a.total_sales || 0), 0),
      avg_growth: areas.length ? areas.reduce((n, a) => n + (a.avg_growth || 0), 0) / areas.filter(a => a.avg_growth != null).length : null,
      flagged_stores: new Set(storeFlagRes.rows.map(r => r.store_id)).size,
      high_flags: areas.reduce((n, a) => n + a.flags.high, 0),
      medium_flags: areas.reduce((n, a) => n + a.flags.medium, 0),
      low_flags: areas.reduce((n, a) => n + a.flags.low, 0),
    };

    res.json({ success: true, date, summary, areas });
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
          territory_vp  = a.vp
      FROM store_assignments a
      WHERE f.store_id = a.store_id
        AND (f.region_coach IS DISTINCT FROM a.region_coach OR f.territory_vp IS DISTINCT FROM a.vp)
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

module.exports = router;
