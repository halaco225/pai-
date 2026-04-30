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
    let payload = await db.getIntelCache(user.username, today);
    if (!payload) payload = await db.getIntelCache(user.username, yesterday);

    if (!payload) {
      return res.json({ status: 'no_data', message: 'Intel not yet generated for today. Check back after 5 AM.' });
    }
    res.json({ status: 'ok', ...payload, narrative: payload.trend_summary, metric_date: payload.generated_at?.split('T')[0] });
  } catch (err) {
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
