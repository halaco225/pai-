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

  // Step 1: Start the flow.
  // The server redirects to a URL containing ?_flowExecutionKey=eNsN — extract it from the
  // *final* URL after node-fetch follows the redirect (flowStart.url), not from the HTML body.
  console.log(`[ODS] Starting aboveStoreInStoreReportsFlow for ${targetDate}...`);
  const flowStart = await fetch(`${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`, {
    headers: { 'Cookie': cookie, 'User-Agent': ua, 'Referer': `${ODS_URL}/asp/` }
  });

  if (!flowStart.ok) {
    return { success: false, error: `Flow start returned ${flowStart.status}` };
  }

  // Final URL after redirect contains the execution key
  const finalUrl = flowStart.url;
  console.log(`[ODS] Flow final URL: ${finalUrl}`);

  let flowKey = null;

  // 1. Try the redirect URL (most reliable for JRS flows)
  const urlKeyMatch = finalUrl.match(/_flowExecutionKey=([^&]+)/);
  if (urlKeyMatch) flowKey = decodeURIComponent(urlKeyMatch[1]);

  // 2. Fallback: scan HTML for eNsN pattern anywhere
  if (!flowKey) {
    const flowHtml = await flowStart.text();
    const htmlKeyMatch = flowHtml.match(/['"=](\s*e\d+s\d+)['"&]/i);
    if (htmlKeyMatch) flowKey = htmlKeyMatch[1].trim();
    if (!flowKey) {
      // Last resort: any eNsN token
      const loose = flowHtml.match(/\b(e\d+s\d+)\b/);
      if (loose) flowKey = loose[1];
    }
    if (!flowKey) {
      console.log('[ODS] Flow HTML (no key found):', flowHtml.substring(0, 2000));
      return { success: false, error: 'Could not extract _flowExecutionKey — check logs' };
    }
  }

  console.log(`[ODS] Flow execution key: ${flowKey}`);

  // Step 2: Request PDF export using the flow key.
  // Try GET first (standard JRS export pattern), then POST fallback.
  const exportUrl = `${ODS_URL}/asp/flow.html`
    + `?_flowId=aboveStoreInStoreReportsFlow`
    + `&_flowExecutionKey=${encodeURIComponent(flowKey)}`
    + `&_eventId=export`
    + `&output=pdf`
    + `&DATE=${encodeURIComponent(targetDate)}`;

  console.log(`[ODS] Requesting PDF export...`);
  let pdfRes = await fetch(exportUrl, {
    headers: { 'Cookie': cookie, 'User-Agent': ua, 'Referer': finalUrl }
  });
  let ct = pdfRes.headers.get('content-type') || '';
  console.log(`[ODS] GET export: status=${pdfRes.status} ct=${ct}`);

  if (ct.includes('pdf') || ct.includes('octet')) {
    const buf = await pdfRes.buffer();
    fs.writeFileSync(outPath, buf);
    console.log(`[ODS] PDF saved via GET export (${buf.length} bytes)`);
    return { success: true, bytes: buf.length };
  }

  // POST fallback — some JRS setups require POST for export
  const postBody = [
    `_flowExecutionKey=${encodeURIComponent(flowKey)}`,
    `_eventId=export`,
    `output=pdf`,
    `DATE=${encodeURIComponent(targetDate)}`
  ].join('&');

  pdfRes = await fetch(`${ODS_URL}/asp/flow.html`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie, 'User-Agent': ua, 'Referer': finalUrl
    },
    body: postBody
  });
  ct = pdfRes.headers.get('content-type') || '';
  console.log(`[ODS] POST export: status=${pdfRes.status} ct=${ct}`);

  if (ct.includes('pdf') || ct.includes('octet')) {
    const buf = await pdfRes.buffer();
    fs.writeFileSync(outPath, buf);
    console.log(`[ODS] PDF saved via POST export (${buf.length} bytes)`);
    return { success: true, bytes: buf.length };
  }

  // Still HTML — dump it so we can see what the app actually returns
  const html = await pdfRes.text();
  console.log('[ODS] POST export HTML snippet:', html.substring(0, 2000).replace(/\s+/g, ' '));
  return {
    success: false,
    error: `PDF export returned HTML (status=${pdfRes.status}) — see Render logs`,
    flowKey,
    finalUrl
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
