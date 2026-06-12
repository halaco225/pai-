/**
 * intel-cron.js
 * Runs at 9 AM UTC via Render cron.
 * Wakes the web service first (it may be sleeping), then triggers the pipeline.
 */
const https = require('https');
const http  = require('http');

const BASE_URL = process.env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com';
const TOKEN    = process.env.INTEL_AUTOMATION_TOKEN;

if (!TOKEN) {
  console.error('[intel-cron] ERROR: INTEL_AUTOMATION_TOKEN not set');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method,
      timeout:  90000,
      headers:  {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(token ? { 'X-Automation-Token': token } : {}),
      },
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function wakeServer(maxWaitMs = 120000) {
  const healthUrl = `${BASE_URL}/health`;
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    attempt++;
    try {
      const r = await request('GET', healthUrl, null, null);
      if (r.status < 500) {
        console.log(`[intel-cron] Server awake after ${attempt} attempt(s) (${Date.now()-start}ms)`);
        return true;
      }
    } catch (e) {
      console.log(`[intel-cron] Wake attempt ${attempt} failed: ${e.message} — retrying in 15s`);
    }
    await sleep(15000);
  }
  return false;
}

async function run() {
  console.log(`[intel-cron] ${new Date().toISOString()} — waking server at ${BASE_URL}`);
  const awake = await wakeServer();
  if (!awake) {
    console.error('[intel-cron] Server did not wake after 2 minutes — aborting');
    process.exit(1);
  }

  const endpoint = `${BASE_URL}/api/intel/automation/run-batch`;
  console.log(`[intel-cron] Triggering pipeline: ${endpoint}`);
  try {
    const result = await request('POST', endpoint, TOKEN, {});
    console.log(`[intel-cron] Response ${result.status}: ${result.body}`);
    if (result.status >= 200 && result.status < 300) {
      console.log('[intel-cron] Intel pipeline triggered successfully.');
      process.exit(0);
    } else {
      console.error('[intel-cron] Non-2xx response — check main service logs.');
      process.exit(1);
    }
  } catch (err) {
    console.error('[intel-cron] Request failed:', err.message);
    process.exit(1);
  }
}

run();
