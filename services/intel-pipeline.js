'use strict';
/**
 * Intel Pipeline — orchestrates all 7 data sources.
 * Called by routes/intel.js automation endpoint.
 * Run order:
 *   1. DBS (OneData REST)
 *   2. SOS (OneData REST) — also evaluates stacked soft flags
 *   3. Fourth Labor (Playwright)
 *   4. Fourth OT (Playwright) — Sun/Mon only
 *   5. Forgot to Clock Out (OneData REST)
 *   6. SMG Comments (Playwright + Claude Haiku)
 *   7. Hut Bot (Playwright)
 *   8. Generate intel_cache per user
 */
const fs   = require('fs');
const path = require('path');

const { pullReport }           = require('./intel-ods');
const { processDBS }           = require('./parsers/dbs-parser');
const { processSOS }           = require('./parsers/sos-parser');
const { processFourthLabor }   = require('./parsers/fourth-labor-parser');
const { processFourthOT }      = require('./parsers/fourth-ot-parser');
const { processForgotClockOut }= require('./parsers/forgot-clockout-parser');
const { processSMG }           = require('./parsers/smg-parser');
const { processHutBot }        = require('./intel-hutbot');
const { downloadFourthReport } = require('./intel-fourth');
const { downloadSMGComments }  = require('./intel-smg');
const db   = require('./db');
const { USER_ROSTER } = require('../routes/auth');
const Anthropic = require('@anthropic-ai/sdk');

function getYesterdayEST() {
  const now = new Date();
  const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  est.setDate(est.getDate() - 1);
  return est.toISOString().split('T')[0];
}

function cleanupFile(fp) {
  try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
}

async function logStep(step, result, targetDate) {
  try {
    await db.logIntelJob({
      jobType: `step:${step}`, targetDate,
      status: result.success ? 'success' : (result.skipped ? 'skipped' : 'error'),
      storesProcessed: result.storesProcessed || 0,
      flagsCreated: result.flagsWritten || 0,
      message: result.error || JSON.stringify(result)
    });
  } catch (_) {}
}

// Archive all open flags from before the current business week (week starts Tuesday).
// Runs only when the batch processes a Tuesday (i.e. Wednesday morning run).
async function clearWeeklyFlags(targetDate) {
  const d = new Date(targetDate + 'T12:00:00');
  const dow = d.getDay(); // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  if (dow !== 2) return { skipped: true, reason: `Not Tuesday (dow=${dow})` };
  // targetDate IS the Tuesday — archive everything before it
  const pool = db.getPool();
  if (!pool) return { skipped: true, reason: 'No pool' };
  const r = await pool.query(
    `UPDATE intel_flags SET status='archived'
     WHERE metric_date < $1 AND status NOT IN ('addressed','archived')`,
    [targetDate]
  );
  console.log(`[Intel] Weekly clear: archived ${r.rowCount} flags older than ${targetDate}`);
  return { success: true, archived: r.rowCount, weekStart: targetDate };
}

async function runIntelPipeline(targetDate) {
  if (!targetDate) targetDate = getYesterdayEST();
  console.log(`\n[Intel Pipeline] Starting for ${targetDate}`);
  const results = { targetDate, steps: {}, errors: [] };

  await db.logIntelJob({ jobType: 'pipeline:start', targetDate, status: 'running', message: 'Pipeline started' });

  // ── Weekly flag clear (archives prior-week flags when processing a Tuesday) ─
  results.steps.weeklyClean = await clearWeeklyFlags(targetDate);
  if (!results.steps.weeklyClean.skipped) {
    console.log(`[Intel Pipeline] Weekly clear: ${results.steps.weeklyClean.archived} flags archived`);
  }

  // ── Step 1: DBS ────────────────────────────────────────────────────────────
  console.log('[Intel Pipeline] Step 1: DBS');
  try {
    const pull = await pullReport('DBS', targetDate);
    if (!pull.success) throw new Error(pull.error);
    const r = await processDBS(pull.filePath, targetDate);
    cleanupFile(pull.filePath);
    results.steps.dbs = r;
  } catch (err) {
    results.errors.push(`DBS: ${err.message}`);
    results.steps.dbs = { success: false, error: err.message };
    console.error('[Intel Pipeline] DBS failed:', err.message);
  }
  await logStep('dbs', results.steps.dbs, targetDate);

  // ── Step 2: SOS ────────────────────────────────────────────────────────────
  console.log('[Intel Pipeline] Step 2: SOS');
  try {
    const pull = await pullReport('SOS', targetDate);
    if (!pull.success) throw new Error(pull.error);
    const r = await processSOS(pull.filePath, targetDate);
    cleanupFile(pull.filePath);
    results.steps.sos = r;
  } catch (err) {
    results.errors.push(`SOS: ${err.message}`);
    results.steps.sos = { success: false, error: err.message };
    console.error('[Intel Pipeline] SOS failed:', err.message);
  }
  await logStep('sos', results.steps.sos, targetDate);

  // ── Step 3: Fourth Labor ───────────────────────────────────────────────────
  console.log('[Intel Pipeline] Step 3: Fourth Labor');
  try {
    const dl = await downloadFourthReport('LABOR', targetDate);
    if (!dl.success) throw new Error(dl.error);
    const r = await processFourthLabor(dl.filePath, targetDate);
    cleanupFile(dl.filePath);
    results.steps.fourthLabor = r;
  } catch (err) {
    results.errors.push(`FourthLabor: ${err.message}`);
    results.steps.fourthLabor = { success: false, error: err.message };
    console.error('[Intel Pipeline] Fourth Labor failed:', err.message);
  }
  await logStep('fourthLabor', results.steps.fourthLabor, targetDate);

  // ── Step 4: Fourth OT (Sun/Mon only) ──────────────────────────────────────
  const dow = new Date(targetDate + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 1) {
    console.log('[Intel Pipeline] Step 4: Fourth OT');
    try {
      const dl = await downloadFourthReport('OT', targetDate);
      if (!dl.success) throw new Error(dl.error);
      const r = await processFourthOT(dl.filePath, targetDate);
      cleanupFile(dl.filePath);
      results.steps.fourthOT = r;
    } catch (err) {
      results.errors.push(`FourthOT: ${err.message}`);
      results.steps.fourthOT = { success: false, error: err.message };
      console.error('[Intel Pipeline] Fourth OT failed:', err.message);
    }
    await logStep('fourthOT', results.steps.fourthOT, targetDate);
  } else {
    results.steps.fourthOT = { skipped: true, reason: 'Only runs Sun/Mon' };
  }

  // ── Step 5: Forgot to Clock Out ────────────────────────────────────────────
  console.log('[Intel Pipeline] Step 5: Forgot to Clock Out');
  try {
    const pull = await pullReport('PAYROLL', targetDate);
    if (!pull.success) throw new Error(pull.error);
    const r = await processForgotClockOut(pull.filePath, targetDate);
    cleanupFile(pull.filePath);
    results.steps.clockOut = r;
  } catch (err) {
    results.errors.push(`ClockOut: ${err.message}`);
    results.steps.clockOut = { success: false, error: err.message };
    console.error('[Intel Pipeline] Clock Out failed:', err.message);
  }
  await logStep('clockOut', results.steps.clockOut, targetDate);

  // ── Step 6: SMG Comments ───────────────────────────────────────────────────
  console.log('[Intel Pipeline] Step 6: SMG Comments');
  try {
    const dl = await downloadSMGComments(targetDate);
    if (!dl.success) throw new Error(dl.error);
    const r = await processSMG(dl.filePath, targetDate);
    cleanupFile(dl.filePath);
    results.steps.smg = r;
  } catch (err) {
    results.errors.push(`SMG: ${err.message}`);
    results.steps.smg = { success: false, error: err.message };
    console.error('[Intel Pipeline] SMG failed:', err.message);
  }
  await logStep('smg', results.steps.smg, targetDate);

  // ── Step 7: Hut Bot ────────────────────────────────────────────────────────
  console.log('[Intel Pipeline] Step 7: Hut Bot');
  try {
    const r = await processHutBot(targetDate);
    results.steps.hutBot = r;
  } catch (err) {
    results.errors.push(`HutBot: ${err.message}`);
    results.steps.hutBot = { success: false, error: err.message };
    console.error('[Intel Pipeline] Hut Bot failed:', err.message);
  }
  await logStep('hutBot', results.steps.hutBot, targetDate);

  // ── Step 8: Archive old recovering flags ───────────────────────────────────
  await db.archiveOldRecoveringFlags(targetDate);

  // ── Step 9: Generate intel_cache for all users ─────────────────────────────
  console.log('[Intel Pipeline] Step 9: Generating intel cache');
  try {
    await generateIntelCache(targetDate);
    results.steps.cache = { success: true };
  } catch (err) {
    results.errors.push(`Cache: ${err.message}`);
    results.steps.cache = { success: false, error: err.message };
    console.error('[Intel Pipeline] Cache generation failed:', err.message);
  }

  const successCount = Object.values(results.steps).filter(s => s.success || s.skipped).length;
  const totalSteps = Object.keys(results.steps).length;
  console.log(`\n[Intel Pipeline] Complete — ${successCount}/${totalSteps} steps OK, ${results.errors.length} errors`);

  try {
    await db.logIntelJob({
      jobType: 'pipeline',
      targetDate,
      status: results.errors.length === 0 ? 'success' : (successCount === 0 ? 'error' : 'partial'),
      storesProcessed: results.steps.dbs?.storesProcessed || 0,
      flagsCreated: Object.values(results.steps).reduce((s, r) => s + (r.flagsWritten || 0), 0),
      message: JSON.stringify({ steps: results.steps, errors: results.errors })
    });
  } catch (logErr) {
    console.error('[Intel Pipeline] Failed to write job log:', logErr.message);
  }

  return results;
}

async function generateIntelCache(targetDate) {
  const assignments = await db.getStoreAssignments();
  const client = new Anthropic();

  for (const user of USER_ROSTER) {
    const { username, name, role, scope } = user;

    // Get flags in this user's scope
    let flags = [];
    if (role === 'rdo') {
      // Query by region_coach name OR area_coach IN scope list (handles hierarchy detection mismatches)
      const p = db.getPool();
      if (p) {
        const areaCoaches = scope?.area_coaches || [];
        const res = await p.query(
          `SELECT * FROM intel_flags WHERE metric_date=$1
           AND (region_coach=$2 OR area_coach = ANY($3::text[]))
           ORDER BY severity DESC, consecutive_days_out DESC`,
          [targetDate, scope?.rc_name || name, areaCoaches]
        );
        flags = res.rows;
      }
    } else if (role === 'area_coach') {
      const acName = scope?.ac_name || name;
      const p = db.getPool();
      if (p) {
        const res = await p.query(
          `SELECT * FROM intel_flags WHERE metric_date=$1
           AND (area_coach=$2 OR region_coach=$2)
           ORDER BY severity DESC, consecutive_days_out DESC`,
          [targetDate, acName]
        );
        flags = res.rows;
      }
    } else if (role === 'vp') {
      // VP sees all — get flags where territory_vp matches OR region_coach is one of their RDOs
      const p = db.getPool();
      if (p) {
        const rdoNames = scope?.region_coaches || [];
        const res = await p.query(
          `SELECT * FROM intel_flags WHERE metric_date=$1
           AND (territory_vp=$2 OR region_coach = ANY($3::text[]))
           ORDER BY severity DESC, consecutive_days_out DESC`,
          [targetDate, scope?.vp_name || name, rdoNames]
        );
        flags = res.rows;
      }
    }

    const highCount   = flags.filter(f => f.severity === 'high').length;
    const mediumCount = flags.filter(f => f.severity === 'medium').length;
    const recovering  = flags.filter(f => f.trend_direction === 'recovering');

    // Generate 2-3 sentence AI narrative (cheap — claude-sonnet-4-6, very short)
    let trend_summary = '';
    if (flags.length > 0 && process.env.ANTHROPIC_API_KEY) {
      try {
        const flagSummary = flags.slice(0, 20).map(f =>
          `${f.store_name||f.store_id}: ${f.metric_type} (${f.severity}, ${f.consecutive_days_out}d)`
        ).join('; ');
        const msg = await client.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 150,
          messages: [{
            role:    'user',
            content: `Write a 2-sentence morning briefing for a Pizza Hut ${role === 'rdo' ? 'Region Coach' : role === 'vp' ? 'VP' : 'Area Coach'}. \nFlags today: ${flagSummary}\nBe direct. No fluff. Plain text only.`,
          }],
        });
        trend_summary = msg.content[0].text.trim();
      } catch (_) { trend_summary = `${highCount} high-priority and ${mediumCount} medium-priority flags require attention today.`; }
    } else {
      trend_summary = `${highCount} high-priority and ${mediumCount} medium-priority flags require attention today.`;
    }

    const { getFiscalContextString } = require('./fiscal-calendar');
    const fiscal_context = getFiscalContextString ? getFiscalContextString() : '';

    const payload = {
      user_id:           username,
      role,
      generated_at:      new Date().toISOString(),
      fiscal_context,
      high_severity_count:   highCount,
      medium_severity_count: mediumCount,
      flags:             flags.slice(0, 100), // cap for cache size
      trend_summary,
      recovering_stores: recovering.map(f => ({ store_id: f.store_id, store_name: f.store_name, metric_type: f.metric_type })),
    };

    await db.upsertIntelCache({ user_id: username, cache_date: targetDate, role, payload });
  }
  console.log(`[Intel Pipeline] Cache generated for ${USER_ROSTER.length} users`);
}

module.exports = { runIntelPipeline, generateIntelCache };
