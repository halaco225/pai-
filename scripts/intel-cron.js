/**
 * intel-cron.js
 * Runs at 5 AM EST via Render cron.
 * Calls the PAi automation endpoint which runs the full intel pipeline.
 * Same pattern as velocity-cron-pull.js — all processing happens in the web service.
 */
const https = require('https');
const http  = require('http');

const BASE_URL = process.env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com';
const TOKEN    = process.env.INTEL_AUTOMATION_TOKEN;

if (!TOKEN) {
  console.error('[intel-cron] ERROR: INTEL_AUTOMATION_TOKEN not set');
  process.exit(1);
}

function post(url, token) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const body    = JSON.stringify({});
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Automation-Token': token },
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  const endpoint = `${BASE_URL}/api/intel/automation/run-batch`;
  console.log(`[intel-cron] ${new Date().toISOString()} — calling ${endpoint}`);
  try {
    const result = await post(endpoint, TOKEN);
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
