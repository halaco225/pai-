/**
 * scheduler.js — in-process daily trigger for the Velocity ODS pull.
 *
 * Why this exists: the pull used to be driven only by the GitHub Actions cron
 * (.github/workflows/velocity-cron.yml). GitHub auto-disables scheduled
 * workflows after 60 days without repository activity, which silently froze
 * velocity data on 2026-09-28 — no error, no failed job row, the log just
 * stopped. The web service runs on Render's always-on "starter" plan, so an
 * in-process timer is a trigger nothing outside the app can switch off.
 *
 * Self-healing: every tick looks for recent days with no successful pull
 * logged and fills one. A gap left by downtime, a failed run, or a disabled
 * external cron closes itself on the next tick. If GitHub Actions or a Render
 * cron also fires, their success is already in the log, so this does nothing —
 * the two triggers are safe to run side by side.
 */

const http = require('http');
const db   = require('./db');

const TICK_MS             = 15 * 60 * 1000;  // re-check every 15 minutes
const FIRST_TICK_MS       = 60 * 1000;       // first check 1 min after boot
const PULL_TZ             = 'America/New_York'; // the business day these reports describe
const PULL_AFTER_LOCAL    = '06:00';         // 6am Eastern, DST or not
const LOOKBACK_DAYS       = 7;               // how far back to heal gaps

let inFlight = false;
let timer    = null;
let started  = false;

// ── Date helpers ─────────────────────────────────────────────────────────
// Delegated to services/localtime.js. The gate and "today" have to agree on a
// zone: this module used to compare UTC hours while computing today in
// Chicago, and those two part company for an hour every night.
const { localDate, minusDays, isAtOrAfter } = require('./localtime');

function easternToday() {
  return localDate(new Date(), PULL_TZ);
}

// Kept so existing callers of scheduler.chicagoToday() do not break. It now
// returns Eastern, because every date decision in this module is Eastern.
const chicagoToday = easternToday;

// ── Which recent days have no successful pull logged? ────────────────────
async function missingDates() {
  const pool = db.getPool();
  if (!pool) return [];

  const today      = chicagoToday();
  const candidates = [];                       // newest first
  for (let i = 1; i <= LOOKBACK_DAYS; i++) candidates.push(minusDays(today, i));
  const oldest = candidates[candidates.length - 1];

  const res = await pool.query(
    `SELECT DISTINCT TO_CHAR(target_date,'YYYY-MM-DD') AS d
       FROM velocity_automation_log
      WHERE job_type = 'ods_pull' AND status = 'success'
        AND target_date >= $1::date`,
    [oldest]
  );

  const done = new Set(res.rows.map(r => r.d));
  return candidates.filter(d => !done.has(d));
}

// Is the 6am Eastern gate open? Asked by the intel pipeline route before it
// runs an undated batch, and by the intel tick below.
//
// The Render cron fires at a fixed 10:00 UTC, which is 6am Eastern during EDT
// but 5am once DST ends. Without this gate the morning brief would be built an
// hour early for seven months of the year, off a source report that may not
// have landed yet.
function gateOpen(now = new Date()) {
  return isAtOrAfter(now, PULL_TZ, PULL_AFTER_LOCAL);
}

// Yesterday only becomes eligible once the source report exists — 6am Eastern.
// Older gaps are already stale, so fill them whenever we notice.
// `now` is injectable so the DST boundaries can be tested.
function eligible(dateStr, now = new Date()) {
  if (dateStr !== minusDays(localDate(now, PULL_TZ), 1)) return true;
  return isAtOrAfter(now, PULL_TZ, PULL_AFTER_LOCAL);
}

// ── Reuse the existing routes rather than duplicating the pull logic ─────
function postLocal(path, token, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req  = http.request({
      hostname: '127.0.0.1',
      port:     process.env.PORT || 3000,
      path,
      method:   'POST',
      timeout:  30000,
      headers: {
        'Content-Type':     'application/json',
        'Content-Length':   Buffer.byteLength(body),
        'X-Automation-Token': token,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });

    req.on('error',   (e) => { console.error('[Scheduler] trigger failed:', e.message); resolve(0); });
    req.on('timeout', ()  => { req.destroy(); resolve(0); });
    req.end(body);
  });
}

function triggerPull(dateStr) {
  return postLocal(
    '/api/velocity/automation/pull-ods',
    process.env.VELOCITY_AUTOMATION_TOKEN || 'velocity-auto-2024',
    { date: dateStr }
  );
}

function triggerIntel(dateStr) {
  return postLocal(
    '/api/intel/automation/run-batch',
    process.env.INTEL_AUTOMATION_TOKEN || '38b8091924e1f85583454212a9860038',
    { date: dateStr }
  );
}

// ── Has yesterday's intel pipeline run? ─────────────────────────────────
// The pipeline logs one 'pipeline' row per target date when it finishes;
// 'partial' counts as run, because a rerun would not fix the failed step and
// would regenerate ~60 briefs through Claude for nothing.
async function intelMissingDate(now = new Date()) {
  const pool = db.getPool();
  if (!pool) return null;

  const target = minusDays(localDate(now, PULL_TZ), 1);
  try {
    const res = await pool.query(
      `SELECT 1 FROM intel_automation_log
        WHERE job_type = 'pipeline' AND status IN ('success','partial')
          AND target_date = $1::date
        LIMIT 1`,
      [target]
    );
    return res.rows.length ? null : target;
  } catch (err) {
    console.error('[Scheduler] intel log check failed:', err.message);
    return null;   // never trigger on a failed check — a double run is worse
  }
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    // Arrow, not a bare reference: filter passes (element, index), and index
    // would land in eligible()'s `now` parameter and blow up on element 0.
    const gaps = (await missingDates()).filter(d => eligible(d));

    if (gaps.length) {
      // Oldest first, one per tick — keeps history filling in order and stays
      // gentle on OneDataSource.
      const target = gaps[gaps.length - 1];
      console.log(`[Scheduler] no successful pull logged for ${target} — triggering (${gaps.length} gap(s) outstanding)`);
      const status = await triggerPull(target);
      console.log(`[Scheduler] pull-ods accepted for ${target} (HTTP ${status})`);
    }

    // ── Intel pipeline — the one that builds the morning briefs ──────────
    // The Render cron is the usual trigger, but it fires at a fixed UTC hour
    // that is 5am Eastern in winter, when the route defers it. This is what
    // then runs it at 6am, and what closes a gap left by a failed run.
    if (gateOpen()) {
      const intelTarget = await intelMissingDate();
      if (intelTarget) {
        console.log(`[Scheduler] no intel pipeline logged for ${intelTarget} — triggering`);
        const status = await triggerIntel(intelTarget);
        console.log(`[Scheduler] run-batch accepted for ${intelTarget} (HTTP ${status})`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] tick error:', err.message);
  } finally {
    inFlight = false;
  }
}

function start() {
  if (process.env.ENABLE_INTERNAL_SCHEDULER === 'false') {
    console.log('   Scheduler: disabled (ENABLE_INTERNAL_SCHEDULER=false)');
    return;
  }
  // Guard on its own flag, not `timer` — `timer` stays null for the first
  // FIRST_TICK_MS, so a second start() in that window would arm a duplicate.
  if (started) return;
  started = true;
  setTimeout(() => { tick(); timer = setInterval(tick, TICK_MS); }, FIRST_TICK_MS);
  console.log(`   Scheduler: velocity auto-pull armed ✓ (every ${TICK_MS / 60000}m, from ${PULL_AFTER_LOCAL} ${PULL_TZ})`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
}

module.exports = {
  start, stop, tick, missingDates, minusDays, chicagoToday,
  easternToday, eligible, gateOpen, intelMissingDate,
  PULL_TZ, PULL_AFTER_LOCAL,
};
