/**
 * velocity-cron-email.js
 * Runs at 7 AM EST via Render cron.
 * Calls the PAi automation endpoint to send the daily SOS email to all recipients.
 * All email/nodemailer logic lives in the main web service — this script just triggers it.
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com';
const TOKEN = process.env.VELOCITY_AUTOMATION_TOKEN;

if (!TOKEN) {
  console.error('[velocity-cron-email] ERROR: VELOCITY_AUTOMATION_TOKEN not set');
  process.exit(1);
}

function post(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify({});
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Automation-Token': token
      }
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  const endpoint = `${BASE_URL}/api/velocity/automation/send-emails`;
  console.log(`[velocity-cron-email] ${new Date().toISOString()} — calling ${endpoint}`);

  try {
    const result = await post(endpoint, TOKEN);
    console.log(`[velocity-cron-email] Response ${result.status}: ${result.body}`);
    if (result.status >= 200 && result.status < 300) {
      console.log('[velocity-cron-email] Email send triggered successfully.');
      process.exit(0);
    } else {
      console.error('[velocity-cron-email] Non-2xx response — check main service logs.');
      process.exit(1);
    }
  } catch (err) {
    console.error('[velocity-cron-email] Request failed:', err.message);
    process.exit(1);
  }
}

run();
