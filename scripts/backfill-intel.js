/**
 * backfill-intel.js
 * Triggers the intel pipeline for each date in a range, waiting for each
 * to complete before starting the next. Safe to run overnight unattended.
 *
 * Usage:
 *   node scripts/backfill-intel.js [startDate] [endDate]
 *   node scripts/backfill-intel.js 2026-04-21 2026-05-07
 *
 * Defaults to 2026-04-21 → yesterday if no args given.
 */

const https = require('https');

const BASE_URL = process.env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com';
const TOKEN    = process.env.INTEL_AUTOMATION_TOKEN || '38b8091924e1f85583454212a9860038';

// Delay between pipeline triggers — pipeline takes ~10 min on Render Starter
const DELAY_BETWEEN_DATES_MS = 14 * 60 * 1000; // 14 minutes

function post(path, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(BASE_URL + path);
    const req  = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-automation-token': TOKEN,
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function run() {
  const startDate = process.argv[2] || '2026-04-21';
  const endDate   = process.argv[3] || yesterday();
  const dates     = dateRange(startDate, endDate);

  console.log(`\n[backfill] ${dates.length} dates to process: ${startDate} → ${endDate}`);
  console.log(`[backfill] Estimated time: ~${Math.ceil(dates.length * 14 / 60)} hours\n`);

  const results = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    console.log(`[backfill] [${i + 1}/${dates.length}] Triggering pipeline for ${date}...`);

    try {
      const res = await post('/api/intel/automation/run-batch', { date });
      if (res.status === 401) {
        console.error('[backfill] ✗ UNAUTHORIZED — check INTEL_AUTOMATION_TOKEN');
        process.exit(1);
      }
      console.log(`[backfill]   → HTTP ${res.status}: ${res.body.slice(0, 80)}`);
      results.push({ date, status: res.status, ok: res.status < 300 });
    } catch (err) {
      console.error(`[backfill]   → ERROR: ${err.message}`);
      results.push({ date, status: 0, ok: false, error: err.message });
    }

    if (i < dates.length - 1) {
      const waitMin = Math.ceil(DELAY_BETWEEN_DATES_MS / 60000);
      console.log(`[backfill]   Waiting ${waitMin} min for pipeline to finish...\n`);
      await sleep(DELAY_BETWEEN_DATES_MS);
    }
  }

  console.log('\n[backfill] Done.\n');
  console.table(results);
}

run().catch(err => { console.error('[backfill] Fatal:', err.message); process.exit(1); });
