// =====================================================================
// VELOCITY ODS — Pull Above Store Report PDF from OneData (bi.onedatasource.com)
//
// Auth flow (3-step, no browser required):
//   1. GET /asp/login.html          → JSESSIONID cookie
//   2. POST /asp/JavaScriptServlet  → OWASP CSRF token (FETCH-CSRF-TOKEN: 1)
//   3. POST /asp/j_spring_security_check → authenticated session
//   4. Navigate to report + download PDF
// =====================================================================
'use strict';

const fs   = require('fs');
const path = require('path');

const ODS_URL  = 'https://bi.onedatasource.com';
const ODS_ORG  = process.env.ODS_ORG  || 'dgi';
const ODS_USER = process.env.ODS_USER || 'hlacoste';
const ODS_PASS = process.env.ODS_PASSWORD || '';

// Lazy-load node-fetch (ships with the project)
function fetch(...args) {
  return require('node-fetch')(...args);
}

// ── Cookie helpers ─────────────────────────────────────────────────────────
function parseCookies(response) {
  const raw = response.headers.raw()['set-cookie'] || [];
  return raw.map(c => c.split(';')[0]);
}

function mergeCookies(...arrays) {
  // Last value wins for duplicate names
  const map = new Map();
  arrays.flat().forEach(c => {
    const [name] = c.split('=');
    map.set(name, c);
  });
  return Array.from(map.values()).join('; ');
}

// ── Step 1+2+3: Full login sequence ───────────────────────────────────────
async function login() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  // Step 1: GET login page → session cookie
  const loginPage = await fetch(`${ODS_URL}/asp/login.html`, {
    headers: { 'User-Agent': UA }
  });
  if (!loginPage.ok && loginPage.status !== 200) {
    throw new Error(`Login page returned ${loginPage.status}`);
  }
  const cookies1 = parseCookies(loginPage);
  const sess1 = mergeCookies(cookies1);
  console.log('[ODS] Step 1 OK — session:', sess1.substring(0, 40));

  // Step 2: POST JavaScriptServlet with FETCH-CSRF-TOKEN: 1 → OWASP_CSRFTOKEN:value
  const csrfRes = await fetch(`${ODS_URL}/asp/JavaScriptServlet`, {
    method: 'POST',
    headers: {
      'Cookie': sess1,
      'FETCH-CSRF-TOKEN': '1',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA
    }
  });
  const cookies2 = parseCookies(csrfRes);
  const sess2 = mergeCookies(cookies1, cookies2);
  const csrfRaw = await csrfRes.text();
  const colonIdx = csrfRaw.indexOf(':');
  if (colonIdx < 0) throw new Error(`Unexpected CSRF response: ${csrfRaw.substring(0, 100)}`);
  const csrfName  = csrfRaw.substring(0, colonIdx).trim();
  const csrfValue = csrfRaw.substring(colonIdx + 1).trim();
  console.log(`[ODS] Step 2 OK — ${csrfName}:${csrfValue.substring(0, 12)}...`);

  // Step 3: POST j_spring_security_check → authenticated session
  const formBody = [
    `orgId=${encodeURIComponent(ODS_ORG)}`,
    `j_username=${encodeURIComponent(ODS_USER)}`,
    `j_password=${encodeURIComponent(ODS_PASS)}`,
    `j_password_pseudo=${encodeURIComponent(ODS_PASS)}`,
    `${csrfName}=${encodeURIComponent(csrfValue)}`
  ].join('&');

  const authRes = await fetch(`${ODS_URL}/asp/j_spring_security_check`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': sess2,
      'Referer': `${ODS_URL}/asp/login.html`,
      'Origin': ODS_URL,
      'User-Agent': UA
    },
    body: formBody
  });

  const cookies3  = parseCookies(authRes);
  const authCookie = mergeCookies(cookies1, cookies2, cookies3);
  const location   = authRes.headers.get('location') || '';
  console.log(`[ODS] Step 3 — status ${authRes.status}, location: ${location}`);

  if (location.indexOf('error') >= 0) {
    throw new Error(`ODS login failed (redirect to ${location}) — check ODS_USER / ODS_PASSWORD in Render env vars`);
  }

  console.log('[ODS] Login SUCCESS');
  return { cookie: authCookie, location, ua: UA };
}

// ── Navigate to Above Store Report and download PDF ────────────────────────
async function downloadAboveStoreReport(session, targetDate, outPath) {
  const { cookie, ua } = session;

  // Step 1: Start the aboveStoreInStoreReportsFlow → get a fresh _flowExecutionKey
  console.log(`[ODS] Starting aboveStoreInStoreReportsFlow for ${targetDate}...`);
  const flowStart = await fetch(`${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`, {
    headers: { 'Cookie': cookie, 'User-Agent': ua, 'Referer': `${ODS_URL}/asp/` }
  });

  if (!flowStart.ok) {
    return { success: false, error: `Flow start returned ${flowStart.status}` };
  }

  const flowHtml = await flowStart.text();

  // Extract _flowExecutionKey from hidden input field
  const keyMatch = flowHtml.match(/name=["']_flowExecutionKey["'][^>]*value=["']([^"']+)["']/i)
    || flowHtml.match(/value=["']([^"']+)["'][^>]*name=["']_flowExecutionKey["']/i);

  if (!keyMatch) {
    console.log('[ODS] Flow HTML snippet (no key found):', flowHtml.substring(0, 2000));
    return { success: false, error: 'Could not extract _flowExecutionKey from flow page — check logs' };
  }

  const flowKey = keyMatch[1];
  console.log(`[ODS] Flow execution key: ${flowKey}`);

  // Grab CSRF token if present on the form page
  const csrfOnPage = flowHtml.match(/name=["']OWASP_CSRFTOKEN["'][^>]*value=["']([^"']+)["']/i)
    || flowHtml.match(/value=["']([^"']+)["'][^>]*name=["']OWASP_CSRFTOKEN["']/i);
  const csrfToken = csrfOnPage ? csrfOnPage[1] : null;
  if (csrfToken) console.log(`[ODS] Page CSRF token: ${csrfToken.substring(0, 12)}...`);

  // Step 2: POST to run the report with the target date → PDF
  const formFields = [
    `_flowExecutionKey=${encodeURIComponent(flowKey)}`,
    `_eventId=run`,
    `DATE=${encodeURIComponent(targetDate)}`,
    `output=pdf`
  ];
  if (csrfToken) formFields.push(`OWASP_CSRFTOKEN=${encodeURIComponent(csrfToken)}`);

  const reportRes = await fetch(`${ODS_URL}/asp/flow.html`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie,
      'User-Agent': ua,
      'Referer': `${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`
    },
    body: formFields.join('&')
  });

  const contentType = reportRes.headers.get('content-type') || '';
  console.log(`[ODS] Report response: status=${reportRes.status} content-type=${contentType}`);

  if (contentType.indexOf('pdf') >= 0 || contentType.indexOf('octet') >= 0) {
    const buf = await reportRes.buffer();
    fs.writeFileSync(outPath, buf);
    console.log(`[ODS] PDF saved (${buf.length} bytes) → ${outPath}`);
    return { success: true, bytes: buf.length };
  }

  // Got HTML — log snippet so we can see what the form actually expects
  const html = await reportRes.text();
  console.log('[ODS] Got HTML instead of PDF. Snippet:', html.substring(0, 1500).replace(/\s+/g, ' '));
  return {
    success: false,
    error: `Got HTML instead of PDF (status=${reportRes.status}) — check Render logs for form structure`,
    flowKey
  };
}

// ── Public API ─────────────────────────────────────────────────────────────
async function pullAboveStoreReport(targetDate) {
  const tmpDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `above-store-${targetDate}.pdf`);

  try {
    if (!ODS_PASS) {
      throw new Error('ODS_PASSWORD env var is not set — add it to Render service env vars');
    }

    console.log(`[ODS] Starting pull for date=${targetDate}, user=${ODS_USER}@${ODS_ORG}`);
    const session = await login();

    // Try the report download; if URL is wrong, the caller can still see the session worked
    const result = await downloadAboveStoreReport(session, targetDate, outPath);
    if (result.success) {
      return { success: true, filePath: outPath, date: targetDate };
    }

    // Session works but report URL needs tuning — return session info for debugging
    return {
      success: false,
      error: result.error,
      date: targetDate,
      sessionOk: true,
      cookie: session.cookie.substring(0, 60)
    };
  } catch (e) {
    console.error('[ODS] Pull failed:', e.message);
    return { success: false, error: e.message, date: targetDate };
  }
}

module.exports = { pullAboveStoreReport };
