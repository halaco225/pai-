/**
 * velocity-ods-debug.js — v4
 *
 * Key findings from v3:
 *   - aboveStore.decoration require() is at line 440 of s1 HTML → need to read callback
 *   - aboveStore.main is required at line 266 via RequireJS
 *   - require.config.js is a static file at /asp/optimized-scripts/require.config.js → maps module paths
 *   - CSRF guard injects token as a REQUEST HEADER named OWASP_CSRFTOKEN with
 *     X-Requested-With: "OWASP CSRFGuard Project" (not "XMLHttpRequest")
 *   - CSRF token must be refreshed AFTER login using authenticated session
 *   - All prior POST events returned login page because token was stale/wrong header
 *
 * This script:
 *   A. Fetches require.config.js to find the real path for aboveStore.main
 *   B. Prints lines 230-290 and 435-570 from saved /tmp/ods-s1.html
 *   C. Gets FRESH CSRF token using authenticated session
 *   D. Retries events with correct X-Requested-With + CSRF header pattern
 *   E. If aboveStore.main path found, fetches and searches it for eventIds
 */
'use strict';

const fs   = require('fs');
const ODS_URL  = 'https://bi.onedatasource.com';
const ODS_ORG  = process.env.ODS_ORG  || 'dgi';
const ODS_USER = process.env.ODS_USER || 'hlacoste';
const ODS_PASS = process.env.ODS_PASSWORD || '';

function fetch(...args) { return require('node-fetch')(...args); }
function parseCookies(r) {
  return (r.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]);
}
function mergeCookies(...arrays) {
  const map = new Map();
  arrays.flat().forEach(c => { const [n] = c.split('='); map.set(n, c); });
  return Array.from(map.values()).join('; ');
}

async function login() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const r1 = await fetch(`${ODS_URL}/asp/login.html`, { headers: { 'User-Agent': UA } });
  const c1 = parseCookies(r1);
  const r2 = await fetch(`${ODS_URL}/asp/JavaScriptServlet`, {
    method: 'POST',
    headers: { 'Cookie': mergeCookies(c1), 'FETCH-CSRF-TOKEN': '1',
               'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA }
  });
  const c2 = parseCookies(r2);
  const raw = await r2.text();
  const colon = raw.indexOf(':');
  const csrfName  = raw.substring(0, colon).trim();
  const csrfValue = raw.substring(colon + 1).trim();

  const body = [
    `orgId=${encodeURIComponent(ODS_ORG)}`,
    `j_username=${encodeURIComponent(ODS_USER)}`,
    `j_password=${encodeURIComponent(ODS_PASS)}`,
    `j_password_pseudo=${encodeURIComponent(ODS_PASS)}`,
    `${csrfName}=${encodeURIComponent(csrfValue)}`
  ].join('&');

  const r3 = await fetch(`${ODS_URL}/asp/j_spring_security_check`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded',
               'Cookie': mergeCookies(c1, c2), 'Referer': `${ODS_URL}/asp/login.html`,
               'Origin': ODS_URL, 'User-Agent': UA },
    body
  });
  const c3  = parseCookies(r3);
  const loc = r3.headers.get('location') || '';
  if (loc.includes('error')) throw new Error(`Login failed: ${loc}`);
  console.log('[LOGIN] OK →', loc);
  return { cookie: mergeCookies(c1, c2, c3), ua: UA };
}

async function getFreshCsrf(cookie, ua) {
  const r = await fetch(`${ODS_URL}/asp/JavaScriptServlet`, {
    method: 'POST',
    headers: { 'Cookie': cookie, 'FETCH-CSRF-TOKEN': '1', 'User-Agent': ua }
  });
  const text = await r.text();
  const colon = text.indexOf(':');
  const name  = text.substring(0, colon).trim();
  const value = text.substring(colon + 1).trim();
  console.log(`[CSRF] Fresh token: ${name}=${value.substring(0, 12)}...`);
  return { name, value };
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  const { cookie, ua } = await login();

  // ── A. require.config.js → find aboveStore.main real path ─────────────────
  console.log('\n══ A. require.config.js ═════════════════════════════════════');
  const rcRes  = await fetch(`${ODS_URL}/asp/optimized-scripts/require.config.js`,
    { headers: { Cookie: cookie, 'User-Agent': ua } });
  const rcText = await rcRes.text();
  console.log('Status:', rcRes.status, '  Bytes:', rcText.length);
  if (rcRes.ok) {
    fs.writeFileSync('/tmp/ods-require-config.js', rcText);
    // Find aboveStore path mapping
    const abLines = rcText.split('\n').filter(l => /aboveStore/i.test(l));
    console.log('aboveStore entries:\n ', abLines.join('\n  '));
    // Print first 60 lines for context
    console.log('\nFirst 60 lines of require.config.js:');
    console.log(rcText.split('\n').slice(0, 60).join('\n'));
  }

  // ── B. Print key sections of saved s1 HTML ────────────────────────────────
  console.log('\n══ B. s1 HTML key sections ══════════════════════════════════');
  if (fs.existsSync('/tmp/ods-s1.html')) {
    const lines = fs.readFileSync('/tmp/ods-s1.html', 'utf8').split('\n');
    console.log('\n--- Lines 230-295 (require.config block + aboveStore.main require) ---');
    console.log(lines.slice(229, 295).join('\n'));
    console.log('\n--- Lines 435-580 (aboveStore.decoration callback) ---');
    console.log(lines.slice(434, 580).join('\n'));
  } else {
    console.log('No saved s1 HTML — loading fresh...');
    const r   = await fetch(`${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`,
      { headers: { Cookie: cookie, 'User-Agent': ua } });
    const html = await r.text();
    fs.writeFileSync('/tmp/ods-s1.html', html);
    const lines = html.split('\n');
    console.log('Lines 229-295:'); console.log(lines.slice(229, 295).join('\n'));
    console.log('Lines 434-580:'); console.log(lines.slice(434, 580).join('\n'));
  }

  // ── C. Get fresh CSRF + load s1 for current flowKey ──────────────────────
  console.log('\n══ C. Fresh CSRF + s1 key ═══════════════════════════════════');
  const csrf = await getFreshCsrf(cookie, ua);
  const flowRes = await fetch(`${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`,
    { headers: { Cookie: cookie, 'User-Agent': ua } });
  const flowHtml = await flowRes.text();
  const s1Key = flowHtml.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/)?.[1];
  console.log('s1 key:', s1Key);

  // ── D. Events with CORRECT CSRF header (OWASP CSRFGuard pattern) ──────────
  console.log('\n══ D. Events with X-Requested-With: OWASP CSRFGuard Project ═');
  // CSRF guard injects: X-Requested-With: "OWASP CSRFGuard Project" + token as named header
  const csrfHeaders = {
    Cookie: cookie, 'User-Agent': ua,
    'X-Requested-With': 'OWASP CSRFGuard Project',
    [csrf.name]: csrf.value,
    'Referer': `${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`
  };

  // Try GET events with correct CSRF headers
  const getEvents = [
    'getReportsForView', 'inStoreTime', 'InStoreTime', 'view', 'run',
    'next', 'start', 'init', 'initialize', 'loadReports', 'showReports',
    'selectReport', 'viewReport', 'display', 'show', 'load',
  ];
  for (const ev of getEvents) {
    const extra = ev === 'getReportsForView' ? '&exportType=pdf&contentDisposition=attachment' : '';
    const url = `${ODS_URL}/asp/flow.html`
      + `?_flowId=aboveStoreInStoreReportsFlow`
      + `&_flowExecutionKey=${encodeURIComponent(s1Key)}`
      + `&_eventId=${ev}${extra}`;
    const r  = await fetch(url, { headers: csrfHeaders });
    const ct = r.headers.get('content-type') || '';
    const body = await r.text();
    const newKey = body.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/)?.[1];
    const title  = body.match(/<title>([^<]+)<\/title>/)?.[1] || '?';
    const isErr  = title.includes('Error') || body.includes('Server Error');
    const isLogin = body.includes('oneVIEW: Login');
    const mark = ct.includes('pdf') ? '*** PDF ***'
               : isLogin ? 'LOGIN-PAGE'
               : isErr   ? 'error-page'
               : `title="${title}" newKey=${newKey}`;
    console.log(`  GET ${ev.padEnd(22)} → ${r.status} ${mark}`);
    if (ct.includes('pdf') || ct.includes('octet')) {
      const buf = Buffer.from(body);
      fs.writeFileSync('/tmp/ods-hit.pdf', buf);
      console.log('  *** SAVED PDF ***');
      return;
    }
    // Non-error, non-login new key → try getReportsForView from there
    if (newKey && newKey !== s1Key && !isErr && !isLogin) {
      console.log(`    !! Got new key ${newKey} — trying getReportsForView`);
      const pdfUrl = `${ODS_URL}/asp/flow.html`
        + `?_flowId=aboveStoreInStoreReportsFlow`
        + `&_flowExecutionKey=${encodeURIComponent(newKey)}`
        + `&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment`;
      const pr  = await fetch(pdfUrl, { headers: csrfHeaders });
      const pct = pr.headers.get('content-type') || '';
      console.log(`    → ${pr.status} ct=${pct}`);
      if (pct.includes('pdf') || pct.includes('octet')) {
        const buf = await pr.buffer();
        fs.writeFileSync('/tmp/ods-hit.pdf', buf);
        console.log('    *** SAVED PDF ***');
        return;
      }
    }
  }

  // Try POST events with correct CSRF headers + token in body AND header
  console.log('\n── D2. POST events with OWASP CSRFGuard headers ─────────────');
  // Re-fetch fresh CSRF token (prior GETs may have rotated it)
  const csrf2 = await getFreshCsrf(cookie, ua);
  const postHdrs = {
    Cookie: cookie, 'User-Agent': ua,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'OWASP CSRFGuard Project',
    [csrf2.name]: csrf2.value,
    'Referer': `${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`
  };
  const postEvents = ['getReportsForView', 'inStoreTime', 'view', 'run', 'next', 'start', 'init'];
  for (const ev of postEvents) {
    const postBody = [
      `_flowExecutionKey=${encodeURIComponent(s1Key)}`,
      `_eventId=${ev}`,
      `exportType=pdf`,
      `contentDisposition=attachment`,
      `${csrf2.name}=${encodeURIComponent(csrf2.value)}`
    ].join('&');
    const r  = await fetch(`${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`, {
      method: 'POST', headers: postHdrs, body: postBody
    });
    const ct   = r.headers.get('content-type') || '';
    const text = await r.text();
    const newKey = text.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/)?.[1];
    const title  = text.match(/<title>([^<]+)<\/title>/)?.[1] || '?';
    const mark = ct.includes('pdf') ? '*** PDF ***'
               : text.includes('oneVIEW: Login') ? 'LOGIN-PAGE'
               : title.includes('Error') ? 'error-page'
               : `title="${title}" newKey=${newKey}`;
    console.log(`  POST ${ev.padEnd(22)} → ${r.status} ${mark}`);
    if (ct.includes('pdf') || ct.includes('octet')) {
      fs.writeFileSync('/tmp/ods-hit.pdf', Buffer.from(text));
      console.log('  *** SAVED PDF ***');
      return;
    }
  }

  // ── E. If require.config found aboveStore path, fetch that module ─────────
  if (rcRes.ok && rcText.length > 100) {
    const pathMatch = rcText.match(/['"]aboveStore[^'"]*['"]\s*:\s*['"]([^'"]+)['"]/);
    if (pathMatch) {
      console.log('\n══ E. Fetch aboveStore from discovered path ═════════════════');
      const modulePath = pathMatch[1];
      const tryUrls = [
        `${ODS_URL}/asp/optimized-scripts/${modulePath}.js`,
        `${ODS_URL}${modulePath}.js`,
        `${ODS_URL}/asp/${modulePath}.js`,
      ];
      for (const u of tryUrls) {
        const r   = await fetch(u, { headers: { Cookie: cookie, 'User-Agent': ua } });
        const txt = await r.text();
        console.log(u.substring(0, 80), '→', r.status, txt.length, 'bytes');
        if (r.ok && txt.length > 500) {
          fs.writeFileSync('/tmp/ods-aboveStore-real.js', txt);
          const hits = txt.split('\n').filter(l =>
            /_eventId|eventId|getReport|inStoreTime|flowExec/i.test(l));
          console.log('  Event lines:\n  ', hits.slice(0, 15).join('\n  '));
          break;
        }
      }
    }
  }

  console.log('\n══ DONE ══════════════════════════════════════════════════════');
  console.log('Key files: /tmp/ods-s1.html  /tmp/ods-require-config.js');
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            