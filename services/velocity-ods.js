// =====================================================================
// VELOCITY ODS — Pull Speed of Service report from OneData via REST API
//
// Auth flow:
//   1. GET /asp/login.html          → JSESSIONID cookie
//   2. POST /asp/JavaScriptServlet  → OWASP CSRF token (pre-login)
//   3. POST /asp/j_spring_security_check → authenticated session
//   4. POST /asp/JavaScriptServlet  → fresh CSRF token (post-login)
//   5. POST /asp/rest_v2/reportExecutions → queue report (async)
//   6. GET  /asp/rest_v2/reportExecutions/{id} → poll until ready
//   7. GET  /asp/rest_v2/reportExecutions/{id}/exports/{expId}/outputResource → download XLSX
// =====================================================================
'use strict';

const fs   = require('fs');
const path = require('path');

const ODS_URL  = 'https://bi.onedatasource.com';
const ODS_ORG  = process.env.ODS_ORG  || 'dgi';
const ODS_USER = process.env.ODS_USER || 'hlacoste';
const ODS_PASS = process.env.ODS_PASSWORD || '';

const REPORT_URI = '/Reports/Pizza_Hut/Operations/PH_Speed_Of_Service';
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 30;  // 90 seconds max

function fetch(...args) { return require('node-fetch')(...args); }

function parseCookies(response) {
  return (response.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]);
}

function mergeCookies(...arrays) {
  const map = new Map();
  arrays.flat().forEach(c => { map.set(c.split('=')[0], c); });
  return Array.from(map.values()).join('; ');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getCsrf(cookieStr) {
  const r = await fetch(`${ODS_URL}/asp/JavaScriptServlet`, {
    method: 'POST',
    headers: {
      'Cookie': cookieStr,
      'FETCH-CSRF-TOKEN': '1',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0'
    }
  });
  const text = await r.text();
  const colon = text.indexOf(':');
  if (colon < 0) throw new Error(`Unexpected CSRF response: ${text.substring(0, 100)}`);
  return {
    name:  text.substring(0, colon).trim(),
    value: text.substring(colon + 1).trim(),
    cookies: parseCookies(r)
  };
}

async function login() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  // Step 1: session cookie
  const r1 = await fetch(`${ODS_URL}/asp/login.html`, { headers: { 'User-Agent': UA } });
  const c1 = parseCookies(r1);

  // Step 2: pre-login CSRF
  const csrf1 = await getCsrf(mergeCookies(c1));
  const c2 = csrf1.cookies;

  // Step 3: authenticate
  const formBody = [
    `orgId=${encodeURIComponent(ODS_ORG)}`,
    `j_username=${encodeURIComponent(ODS_USER)}`,
    `j_password=${encodeURIComponent(ODS_PASS)}`,
    `j_password_pseudo=${encodeURIComponent(ODS_PASS)}`,
    `${csrf1.name}=${encodeURIComponent(csrf1.value)}`
  ].join('&');

  const r3 = await fetch(`${ODS_URL}/asp/j_spring_security_check`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': mergeCookies(c1, c2),
      'Referer': `${ODS_URL}/asp/login.html`,
      'Origin': ODS_URL,
      'User-Agent': UA
    },
    body: formBody
  });

  const c3 = parseCookies(r3);
  const location = r3.headers.get('location') || '';
  if (location.includes('error')) {
    throw new Error(`ODS login failed (${location}) — check ODS_USER / ODS_PASSWORD`);
  }

  const cookie = mergeCookies(c1, c2, c3);

  // Step 4: fresh post-login CSRF (required for REST API calls)
  const csrf2 = await getCsrf(cookie);
  const finalCookie = mergeCookies(c1, c2, c3, csrf2.cookies);

  console.log('[ODS] Login OK');
  return { cookie: finalCookie, csrfName: csrf2.name, csrfValue: csrf2.value, ua: UA };
}

async function downloadSOSReport(session, targetDate, outPath) {
  const { cookie, csrfName, csrfValue, ua } = session;
  const hdrs = {
    'Cookie': cookie,
    'User-Agent': ua,
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest'
  };
  hdrs[csrfName] = csrfValue;

  // Submit report execution
  const execRes = await fetch(`${ODS_URL}/asp/rest_v2/reportExecutions`, {
    method: 'POST',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportUnitUri: REPORT_URI,
      async: true,
      outputFormat: 'xlsx',
      parameters: { reportParameter: [{ name: 'date', value: [targetDate] }] }
    })
  });

  if (!execRes.ok) {
    const txt = await execRes.text();
    throw new Error(`Report execution submit failed: ${execRes.status} — ${txt.substring(0, 200)}`);
  }

  const exec = await execRes.json();
  const reqId = exec.requestId;
  const expId = exec.exports?.[0]?.id;

  if (!reqId || !expId) throw new Error(`No requestId/exportId in response: ${JSON.stringify(exec)}`);
  console.log(`[ODS] Report queued: ${reqId}`);

  // Poll until ready
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const statusRes = await fetch(`${ODS_URL}/asp/rest_v2/reportExecutions/${reqId}`, { headers: hdrs });
    const status = await statusRes.json();
    const execStatus  = status.status;
    const exportStatus = status.exports?.[0]?.status;
    console.log(`[ODS] Poll ${i + 1}: exec=${execStatus} export=${exportStatus}`);

    if (execStatus === 'ready' && exportStatus === 'ready') break;
    if (execStatus === 'failed' || execStatus === 'cancelled') {
      throw new Error(`Report execution ${execStatus}: ${JSON.stringify(status)}`);
    }
  }

  // Download XLSX
  const dlRes = await fetch(
    `${ODS_URL}/asp/rest_v2/reportExecutions/${reqId}/exports/${expId}/outputResource`,
    { headers: hdrs }
  );

  if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

  const buf = await dlRes.buffer();
  if (buf.length < 1000) throw new Error(`Downloaded file too small (${buf.length} bytes) — may be an error page`);

  fs.writeFileSync(outPath, buf);
  console.log(`[ODS] XLSX saved — ${buf.length} bytes`);
  return { success: true, bytes: buf.length };
}

// ── Public API ─────────────────────────────────────────────────────────────
async function pullAboveStoreReport(targetDate) {
  const tmpDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `sos-${targetDate}.xlsx`);

  try {
    if (!ODS_PASS) throw new Error('ODS_PASSWORD env var is not set');

    console.log(`[ODS] Starting pull for date=${targetDate}, user=${ODS_USER}@${ODS_ORG}`);
    const session = await login();
    await downloadSOSReport(session, targetDate, outPath);
    return { success: true, filePath: outPath, format: 'xlsx', date: targetDate };
  } catch (e) {
    console.error('[ODS] Pull failed:', e.message);
    return { success: false, error: e.message, date: targetDate };
  }
}

module.exports = { pullAboveStoreReport };
