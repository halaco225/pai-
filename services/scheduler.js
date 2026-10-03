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

// Yesterday only becomes eligible once the source report exists — 6am Eastern.
// Older gaps are already stale, so fill them whenever we notice.
// `now` is injectable so the DST boundaries can be tested.
function eligible(dateStr, now = new Date()) {
  if (dateStr !== minusDays(localDate(now, PULL_TZ), 1)) return true;
  return isAtOrAfter(now, PULL_TZ, PULL_AFTER_LOCAL);
}

// ── Reuse the existing route rather than duplicating the pull logic ──────
function triggerPull(dateStr) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ date: dateStr });
    const req  = http.request({
      hostname: '127.0.0.1',
      port:     process.env.PORT || 3000,
      path:     '/api/velocity/automation/pull-ods',
      method:   'POST',
      timeout:  30000,
      headers: {
        'Content-Type':     'application/json',
        'Content-Length':   Buffer.byteLength(body),
        'X-Automation-Token': process.env.VELOCITY_AUTOMATION_TOKEN || 'velocity-auto-2024',
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

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const gaps = (await missingDates()).filter(eligible);
    if (!gaps.length) return;

    // Oldest first, one per tick — keeps history filling in order and stays
    // gentle on OneDataSource.
    const target = gaps[gaps.length - 1];
    console.log(`[Scheduler] no successful pull logged for ${target} — triggering (${gaps.length} gap(s) outstanding)`);
    const status = await triggerPull(target);
    console.log(`[Scheduler] pull-ods accepted for ${target} (HTTP ${status})`);
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
  easternToday, eligible, PULL_TZ, PULL_AFTER_LOCAL,
};
