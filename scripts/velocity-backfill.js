/**
 * velocity-backfill.js
 * One-time script to backfill historical Velocity data from P1W1 (2025-12-30) through yesterday.
 *
 * USAGE (run once from terminal or Render one-off):
 *   node scripts/velocity-backfill.js
 *   node scripts/velocity-backfill.js --start 2026-01-01 --end 2026-03-23
 *   node scripts/velocity-backfill.js --dry-run   (just lists dates, no pulls)
 *
 * The script calls the PAi automation endpoint for each date sequentially.
 * It pauses 30s between requests to avoid hammering OneData.
 * Failed dates are logged and retried at the end.
 *
 * Env vars required:
 *   PAI_BASE_URL              e.g. https://pai-ayvaz.onrender.com
 *   VELOCITY_AUTOMATION_TOKEN  shared secret
 */

const https = require('https');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = process.env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com';
const TOKEN = process.env.VELOCITY_AUTOMATION_TOKEN;

// P1W1 start = 2025-12-30 (Tuesday)
const DEFAULT_START = '2025-12-30';

// Yesterday in Chicago time
function getYesterdayChicago() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = fmt.formatToParts(new Date(Date.now() - 86400000));
  return parts.map(p => p.value).join('').replace(/\//g, '-');
}

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
let startDate = DEFAULT_START;
let endDate = getYesterdayChicago();

const startIdx = args.indexOf('--start');
if (startIdx !== -1 && args[startIdx + 1]) startDate = args[startIdx + 1];
const endIdx = args.indexOf('--end');
if (endIdx !== -1 && args[endIdx + 1]) endDate = args[endIdx + 1];

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function postDate(targetDate) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}/api/velocity/automation/pull-ods`;
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ date: targetDate });
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Automation-Token': TOKEN
      },
      timeout: 120000  // 2 min — backfill runs are allowed longer
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN && !isDryRun) {
    console.error('ERROR: VELOCITY_AUTOMATION_TOKEN not set. Export it before running.');
    console.error('  export VELOCITY_AUTOMATION_TOKEN=your_token_here');
    process.exit(1);
  }

  const dates = dateRange(startDate, endDate);
  console.log(`\n🏎  Velocity Backfill`);
  console.log(`   Range  : ${startDate} → ${endDate}`);
  console.log(`   Dates  : ${dates.length}`);
  console.log(`   Target : ${BASE_URL}`);
  if (isDryRun) {
    console.log(`   Mode   : DRY RUN — no requests will be made\n`);
    dates.forEach((d, i) => console.log(`   [${String(i+1).padStart(3,'0')}] ${d}`));
    return;
  }
  console.log(`   Mode   : LIVE — 30s pause between requests\n`);

  const failed = [];
  let successCount = 0;

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    process.stdout.write(`   [${String(i+1).padStart(3,'0')}/${dates.length}] ${d} ... `);
    try {
      const result = await postDate(d);
      if (result.status >= 200 && result.status < 300) {
        console.log(`✓ (${result.status})`);
        successCount++;
      } else {
        console.log(`✗ HTTP ${result.status} — ${result.body.slice(0, 120)}`);
        failed.push(d);
      }
    } catch (err) {
      console.log(`✗ ERROR — ${err.message}`);
      failed.push(d);
    }

    // Pause between requests (skip pause after last)
    if (i < dates.length - 1) await sleep(30000);
  }

  console.log(`\n── Summary ──────────────────────────────`);
  console.log(`   Succeeded : ${successCount}`);
  console.log(`   Failed    : ${failed.length}`);

  if (failed.length > 0) {
    console.log(`\n── Failed dates (retry manually) ────────`);
    failed.forEach(d => console.log(`   ${d}`));
    console.log(`\n   To retry: node scripts/velocity-backfill.js --start ${failed[0]} --end ${failed[failed.length - 1]}`);
    process.exit(1);
  } else {
    console.log(`\n   All dates processed successfully. ✓`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
