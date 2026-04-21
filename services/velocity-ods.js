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


// ── CSRF token helper ──────────────────────────────────────────────────────
async function fetchCsrf(cookie, ua) {
  const r = await fetch(`${ODS_URL}/asp/JavaScriptServlet`, {
    method: 'POST',
    headers: { 'Cookie': cookie, 'FETCH-CSRF-TOKEN': '1', 'User-Agent': ua }
  });
  const text = await r.text();
  const idx = text.indexOf(':');
  return { name: text.substring(0, idx).trim(), value: text.substring(idx + 1).trim() };
}

// ── Navigate to Daily Dispatch Performance and download PDF ────────────────
//
//  Confirmed flow (reverse-engineered from browser network tab 2026-04-21):
//
//   s1  GET  flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId=4
//            → __jrsConfigs__.flowExecutionKey = "e1s1"
//
//   s2  GET  flow.html?...&_flowExecutionKey=e1s1
//            &_eventId=selectParameters&selectedReportId=457
//            → __jrsConfigs__.flowExecutionKey = "e1s2"
//            (renders date + org-type parameter form)
//
//   s3  POST flow.html?...&_flowExecutionKey=e1s2
//            body: _eventId=retrieveReports
//                  &orgTypes=company&orgTypeValues=8&storesInOrgType=all
//                  &selectedDate=YYYY-MM-DD
//            → HTML page containing:
//              <iframe src="/asp/flow.html?...&_flowExecutionKey=eNs3
//                           &_eventId=getReportsForView&print=true">
//
//   PDF GET  <iframe src>  → application/pdf
//
async function downloadAboveStoreReport(session, targetDate, outPath) {
  const { cookie, ua } = session;

  // Normalise date to YYYY-MM-DD regardless of input format
  let dateStr = targetDate;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(targetDate)) {
    const [m, d, y] = targetDate.split('/');
    dateStr = `${y}-${m}-${d}`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    dateStr = targetDate; // already correct
  }
  console.log(`[ODS] downloadAboveStoreReport date=${dateStr}`);

  const flowBase = `${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`;

  // ── s1: load flow with categoryId to get first execution key ────────────
  let csrf = await fetchCsrf(cookie, ua);
  const s1Headers = {
    'Cookie': cookie, 'User-Agent': ua,
    'X-Requested-With': 'OWASP CSRFGuard Project',
    'Referer': flowBase
  };
  s1Headers[csrf.name] = csrf.value;

  const s1Res = await fetch(`${flowBase}&categoryId=4`, { headers: s1Headers });
  if (!s1Res.ok) return { success: false, error: `s1 returned ${s1Res.status}` };
  const s1Html = await s1Res.text();
  const s1KeyM = s1Html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  if (!s1KeyM) return { success: false, error: 's1: no flowExecutionKey found' };
  const s1Key = s1KeyM[1];
  console.log(`[ODS] s1 key: ${s1Key}`);

  // ── s2: select Daily Dispatch Performance (reportId=457) ────────────────
  csrf = await fetchCsrf(cookie, ua);
  const s2Headers = {
    'Cookie': cookie, 'User-Agent': ua,
    'X-Requested-With': 'OWASP CSRFGuard Project',
    'Referer': `${flowBase}&categoryId=4`
  };
  s2Headers[csrf.name] = csrf.value;

  const s2Res = await fetch(
    `${flowBase}&_flowExecutionKey=${encodeURIComponent(s1Key)}&_eventId=selectParameters&selectedReportId=457`,
    { headers: s2Headers }
  );
  if (!s2Res.ok) return { success: false, error: `s2 returned ${s2Res.status}` };
  const s2Html = await s2Res.text();
  const s2KeyM = s2Html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  if (!s2KeyM) return { success: false, error: 's2: no flowExecutionKey found' };
  const s2Key = s2KeyM[1];
  console.log(`[ODS] s2 key: ${s2Key}`);

  // ── s3: submit date + org params → report viewer page with iframe ────────
  csrf = await fetchCsrf(cookie, ua);
  const s3Headers = {
    'Cookie': cookie, 'User-Agent': ua,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'OWASP CSRFGuard Project',
    'Referer': `${flowBase}&_flowExecutionKey=${s2Key}`
  };
  s3Headers[csrf.name] = csrf.value;

  const postBody = [
    '_eventId=retrieveReports',
    'orgTypes=company',
    'orgTypeValues=8',
    'storesInOrgType=all',
    `selectedDate=${encodeURIComponent(dateStr)}`
  ].join('&');

  const s3Res = await fetch(
    `${flowBase}&_flowExecutionKey=${encodeURIComponent(s2Key)}`,
    { method: 'POST', headers: s3Headers, body: postBody }
  );
  if (!s3Res.ok) return { success: false, error: `s3 POST returned ${s3Res.status}` };
  const s3Html = await s3Res.text();

  // Extract iframe src — e.g.:
  //   src="/asp/flow.html?_flowId=...&_flowExecutionKey=eNs3&_eventId=getReportsForView&print=true"
  const iframeM = s3Html.match(/src="(\/asp\/flow\.html[^"]*getReportsForView[^"]*)"/);
  if (!iframeM) {
    console.log('[ODS] s3: no getReportsForView iframe found. HTML snippet:',
      s3Html.substring(0, 600).replace(/\s+/g, ' '));
    return { success: false, error: 's3: iframe with getReportsForView not found' };
  }
  const iframeSrc = iframeM[1].replace(/&amp;/g, '&');
  console.log(`[ODS] s3 iframe: ${iframeSrc}`);

  // ── PDF: fetch the iframe URL ────────────────────────────────────────────
  const pdfRes = await fetch(`${ODS_URL}${iframeSrc}`, {
    headers: { 'Cookie': cookie, 'User-Agent': ua, 'Referer': `${ODS_URL}${iframeSrc}` }
  });
  const ct = pdfRes.headers.get('content-type') || '';
  console.log(`[ODS] PDF fetch: status=${pdfRes.status} ct=${ct}`);

  if (ct.includes('pdf') || ct.includes('octet')) {
    const buf = await pdfRes.buffer();
    fs.writeFileSync(outPath, buf);
    console.log(`[ODS] PDF saved: ${buf.length} bytes → ${outPath}`);
    return { success: true, bytes: buf.length };
  }

  // If print=true returns HTML viewer, try explicit exportType=pdf
  const s3KeyM = iframeSrc.match(/[?&]_flowExecutionKey=([^&]+)/);
  const s3Key  = s3KeyM ? decodeURIComponent(s3KeyM[1]) : '';
  if (s3Key) {
    const pdfUrl2 = `${flowBase}&_flowExecutionKey=${encodeURIComponent(s3Key)}`
      + `&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment`;
    const pdf2 = await fetch(pdfUrl2, {
      headers: { 'Cookie': cookie, 'User-Agent': ua, 'Referer': `${ODS_URL}${iframeSrc}` }
    });
    const ct2 = pdf2.headers.get('content-type') || '';
    console.log(`[ODS] PDF fallback: status=${pdf2.status} ct=${ct2}`);
    if (ct2.includes('pdf') || ct2.includes('octet')) {
      const buf = await pdf2.buffer();
      fs.writeFileSync(outPath, buf);
      console.log(`[ODS] PDF saved (fallback): ${buf.length} bytes`);
      return { success: true, bytes: buf.length };
    }
    const errHtml = await pdf2.text();
    console.log('[ODS] fallback also returned HTML:', errHtml.substring(0, 400).replace(/\s+/g,' '));
  }

  return { success: false, error: 'PDF download returned HTML even after iframe + fallback' };
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
