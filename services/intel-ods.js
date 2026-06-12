'use strict';
/**
 * Intel ODS — Pull reports from OneData via REST API.
 * Reuses the same auth flow as velocity-ods.js but supports multiple report URIs.
 * Covers: DBS, SOS (already in velocity), Forgot-to-Clock-Out
 */
const fs   = require('fs');
const path = require('path');

const ODS_URL  = 'https://bi.onedatasource.com';
const ODS_ORG  = process.env.ODS_ORG  || 'dgi';
const ODS_USER = process.env.ODS_USER || 'hlacoste';
const ODS_PASS = process.env.ODS_PASSWORD || '';

const REPORTS = {
  DBS:            '/Reports/Pizza_Hut/Operations/PH_DGIDBS_1',
  SOS:            '/Reports/Pizza_Hut/Operations/PH_Speed_Of_Service',
  PAYROLL:        '/Reports/Pizza_Hut/Payroll/PH_ForgotToClockOut',
  CHANGE_DOWN:    '/Reports/Pizza_Hut/Operations/PH_ChangeDownReport',
  CANCEL_TENDER:  '/Reports/Pizza_Hut/Operations/PH_Cancels_After_Tender',
};

const POLL_INTERVAL_MS  = 5000;
const POLL_MAX_ATTEMPTS = 60;

function fetch(...args) { return require('node-fetch')(...args); }
function parseCookies(r) { return (r.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]); }
function mergeCookies(...arrs) {
  const map = new Map();
  arrs.flat().forEach(c => { map.set(c.split('=')[0], c); });
  return Array.from(map.values()).join('; ');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getCsrf(cookieStr) {
  const r = await fetch(`${ODS_URL}/asp/JavaScriptServlet`, {
    method: 'POST',
    headers: { Cookie: cookieStr, 'FETCH-CSRF-TOKEN': '1', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0' },
  });
  const text  = await r.text();
  const colon = text.indexOf(':');
  if (colon < 0) throw new Error(`Unexpected CSRF response: ${text.substring(0,100)}`);
  return { name: text.substring(0,colon).trim(), value: text.substring(colon+1).trim(), cookies: parseCookies(r) };
}

async function login() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const r1   = await fetch(`${ODS_URL}/asp/login.html`, { headers: { 'User-Agent': UA } });
  const c1   = parseCookies(r1);
  const csrf1 = await getCsrf(mergeCookies(c1));
  const body  = [
    `orgId=${encodeURIComponent(ODS_ORG)}`,
    `j_username=${encodeURIComponent(ODS_USER)}`,
    `j_password=${encodeURIComponent(ODS_PASS)}`,
    `j_password_pseudo=${encodeURIComponent(ODS_PASS)}`,
    `${csrf1.name}=${encodeURIComponent(csrf1.value)}`,
  ].join('&');
  const r3 = await fetch(`${ODS_URL}/asp/j_spring_security_check`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: mergeCookies(c1, csrf1.cookies), Referer: `${ODS_URL}/asp/login.html`,
      Origin: ODS_URL, 'User-Agent': UA },
    body,
  });
  const c3  = parseCookies(r3);
  if ((r3.headers.get('location')||'').includes('error')) throw new Error('ODS login failed — check ODS_USER / ODS_PASSWORD');
  const csrf2 = await getCsrf(mergeCookies(c1, csrf1.cookies, c3));
  console.log('[IntelODS] Login OK');
  return { cookie: mergeCookies(c1, csrf1.cookies, c3, csrf2.cookies), csrfName: csrf2.name, csrfValue: csrf2.value, ua: UA };
}

async function downloadReport(session, reportKey, targetDate, outPath) {
  const { cookie, csrfName, csrfValue, ua } = session;
  const reportURI = REPORTS[reportKey];
  if (!reportURI) throw new Error(`Unknown report key: ${reportKey}`);

  const hdrs = { Cookie: cookie, 'User-Agent': ua, Accept: 'application/json',
                 'X-Requested-With': 'XMLHttpRequest' };
  hdrs[csrfName] = csrfValue;

  const execRes = await fetch(`${ODS_URL}/asp/rest_v2/reportExecutions`, {
    method: 'POST',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportUnitUri: reportURI, async: true, outputFormat: 'xlsx',
      parameters: { reportParameter: [{ name: 'date', value: [targetDate] }] },
    }),
  });
  if (!execRes.ok) { const t = await execRes.text(); throw new Error(`Exec failed ${execRes.status}: ${t.substring(0,200)}`); }
  const exec = await execRes.json();
  const { requestId, exports } = exec;
  const expId = exports?.[0]?.id;
  if (!requestId || !expId) throw new Error(`No requestId/exportId: ${JSON.stringify(exec)}`);
  console.log(`[IntelODS] ${reportKey} queued: ${requestId}`);

  let ready = false;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const st = await (await fetch(`${ODS_URL}/asp/rest_v2/reportExecutions/${requestId}`, { headers: hdrs })).json();
    const es = st.status, xs = st.exports?.[0]?.status;
    console.log(`[IntelODS] Poll ${i+1}/${POLL_MAX_ATTEMPTS}: exec=${es} export=${xs}`);
    if (es === 'ready' && xs === 'ready') { ready = true; break; }
    if (es === 'failed' || es === 'cancelled') throw new Error(`Execution ${es}`);
  }
  if (!ready) throw new Error(`ODS report did not complete after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s — report may be too large or ODS is slow`);

  const dlRes = await fetch(`${ODS_URL}/asp/rest_v2/reportExecutions/${requestId}/exports/${expId}/outputResource`, { headers: hdrs });
  if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
  const buf = await dlRes.buffer();
  if (buf.length < 1000) throw new Error(`File too small (${buf.length} bytes)`);
  fs.writeFileSync(outPath, buf);
  console.log(`[IntelODS] ${reportKey} saved — ${buf.length} bytes`);
  return { success: true, bytes: buf.length };
}

async function pullReport(reportKey, targetDate) {
  const tmpDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-${reportKey.toLowerCase()}-${targetDate}.xlsx`);
  try {
    if (!ODS_PASS) throw new Error('ODS_PASSWORD env var not set');
    const session = await login();
    await downloadReport(session, reportKey, targetDate, outPath);
    return { success: true, filePath: outPath, reportKey, date: targetDate };
  } catch (err) {
    console.error(`[IntelODS] ${reportKey} pull failed:`, err.message);
    return { success: false, error: err.message, reportKey };
  }
}

module.exports = { pullReport, REPORTS };
