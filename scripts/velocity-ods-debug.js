/**
 * velocity-ods-debug.js  — v3
 *
 * Four new attack vectors for reaching s4:
 *   A. Deep HTML parse of s1 — extract data-eventid attrs, JS bindings, inline require() calls
 *   B. JavaScriptServlet — attempt to pull aboveStore.main via the JRS script servlet
 *   C. Spring Web Flow button-name pattern: _eventId_X (submit buttons fire events this way)
 *   D. POST with CSRF token header — all prior GETs may have been silently rejected by CSRFGuard
 *   E. AJAX-style (X-Requested-With) variants of getReportsForView from s1
 *   F. Direct aboveStore REST / PDF endpoints (broader sweep)
 *
 * Run from Render shell:
 *   node scripts/velocity-ods-debug.js
 */
'use strict';

const fs = require('fs');
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
  const c2  = parseCookies(r2);
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
  return { cookie: mergeCookies(c1, c2, c3), ua: UA, csrfName, csrfValue };
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  const { cookie, ua, csrfName, csrfValue } = await login();

  // ── LOAD s1 ───────────────────────────────────────────────────────────────
  const flowRes = await fetch(
    `${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`,
    { headers: { Cookie: cookie, 'User-Agent': ua } }
  );
  const flowHtml = await flowRes.text();
  fs.writeFileSync('/tmp/ods-s1.html', flowHtml);
  const s1Key = flowHtml.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/)?.[1];
  console.log('\ns1 key:', s1Key);

  // ── A. Deep HTML parse ────────────────────────────────────────────────────
  console.log('\n══ A. Deep HTML parse of s1 ══════════════════════════════════');

  // data-* event attributes
  const dataAttrs = [...flowHtml.matchAll(/data-[a-z-]*event[a-z-]*=["']([^"']+)["']/gi)].map(m => m[0]);
  console.log('data-*event* attrs:', dataAttrs.length ? dataAttrs.join('\n  ') : 'none');

  // _eventId references (URL or form)
  const eventIdRefs = [...new Set(
    [...flowHtml.matchAll(/_eventId[=&"'\s:]+([a-zA-Z_][a-zA-Z0-9_]{1,40})/g)].map(m => m[1])
  )];
  console.log('\n_eventId values found in HTML:', eventIdRefs.length ? eventIdRefs.join(', ') : 'none');

  // inline aboveStore / flow JS
  const jsLines = flowHtml.split('\n').filter(l =>
    /aboveStore|inStore|InStore|_eventId|eventId|flowExec|selectReport|getReport|runReport|IST|SOS/i.test(l)
  );
  console.log('\nRelevant JS lines in s1 HTML (first 40):');
  jsLines.slice(0, 40).forEach(l => console.log(' ', l.trim().substring(0, 150)));

  // require() calls
  const requireCalls = [...flowHtml.matchAll(/require\s*\(\s*\[([^\]]+)\]/g)].map(m => m[0]);
  console.log('\nrequire() calls:', requireCalls.length ? requireCalls.slice(0,5).join('\n  ') : 'none');

  // __jrsConfigs__ object
  const jrsCfg = flowHtml.match(/__jrsConfigs__\s*=\s*(\{[\s\S]{0,3000}?\});/);
  if (jrsCfg) {
    console.log('\n__jrsConfigs__ =', jrsCfg[1].substring(0, 800));
  }

  // ── B. JavaScriptServlet module fetches ──────────────────────────────────
  console.log('\n══ B. JavaScriptServlet — aboveStore module attempts ══════════');
  const jsPaths = [
    `/asp/JavaScriptServlet?module=aboveStore.main`,
    `/asp/JavaScriptServlet?module=aboveStore%2Fmain`,
    `/asp/JavaScriptServlet?scripts=aboveStore.main`,
    `/asp/JavaScriptServlet?scripts=aboveStore%2Fmain`,
    `/asp/JavaScriptServlet?noext=aboveStore.main`,
    `/asp/JavaScriptServlet?scripts=aboveStore`,
    `/asp/optimized-scripts/aboveStore/main.js`,
    `/asp/optimized-scripts/aboveStore.min.js`,
    `/asp/scripts/aboveStore.js`,
  ];
  for (const p of jsPaths) {
    const r = await fetch(`${ODS_URL}${p}`, { headers: { Cookie: cookie, 'User-Agent': ua } });
    const text = await r.text();
    console.log(p.substring(0, 60).padEnd(62), '→', r.status, text.length, 'bytes');
    if (r.ok && text.length > 200) {
      fs.writeFileSync('/tmp/ods-aboveStore-module.js', text.substring(0, 200000));
      const hits = text.split('\n').filter(l =>
        /eventId|_event|getReport|selectReport|inStoreTime|IST|SOS|pdf|export|download/i.test(l)
      );
      console.log('  → Event/PDF refs:', hits.slice(0, 12).map(l => l.trim().substring(0, 120)).join('\n    '));
    }
  }

  // ── C. Spring Web Flow button-name pattern (_eventId_X) ─────────────────
  // Spring MVC allows submit buttons named "_eventId_X" to trigger event X
  console.log('\n══ C. Spring Web Flow _eventId_X button-name POST pattern ════');
  const swfEvents = [
    'getReportsForView', 'inStoreTime', 'InStoreTime',
    'view', 'run', 'select', 'next', 'submit', 'start',
    'viewReport', 'selectReport', 'runReport', 'loadReport',
    'aboveStore', 'IST', 'SOS',
  ];
  for (const ev of swfEvents) {
    // POST with _eventId_X=x (button-name pattern) + CSRF token
    const postBody = [
      `_flowExecutionKey=${encodeURIComponent(s1Key)}`,
      `_eventId_${ev}=x`,
      `${csrfName}=${encodeURIComponent(csrfValue)}`
    ].join('&');
    const r = await fetch(`${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie, 'User-Agent': ua,
        'Referer': `${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`,
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: postBody
    });
    const ct   = r.headers.get('content-type') || '';
    const text = await r.text();
    const newKey = text.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/)?.[1];
    const title  = text.match(/<title>([^<]+)<\/title>/)?.[1] || '?';
    const isErr  = title.includes('Error') || text.includes('Server Error');
    const mark   = ct.includes('pdf') ? '*** PDF ***'
                 : ct.includes('octet') ? '*** OCTET ***'
                 : isErr ? 'error-page'
                 : `title="${title}" key=${newKey}`;
    console.log(`  _eventId_${ev.padEnd(22)} → ${r.status} ${mark}`);
    if (ct.includes('pdf') || ct.includes('octet')) {
      const buf = await r.buffer();
      fs.writeFileSync('/tmp/ods-hit.pdf', buf);
      console.log('  *** SAVED /tmp/ods-hit.pdf ***');
      return;
    }
    // If we got a new key that's not s1, log it and try getReportsForView from there
    if (newKey && newKey !== s1Key && !isErr) {
      console.log(`    !! Non-error new key ${newKey} — trying getReportsForView from there`);
      const pdfUrl = `${ODS_URL}/asp/flow.html`
        + `?_flowId=aboveStoreInStoreReportsFlow`
        + `&_flowExecutionKey=${encodeURIComponent(newKey)}`
        + `&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment`;
      const pdfR = await fetch(pdfUrl, { headers: { Cookie: cookie, 'User-Agent': ua } });
      const pdfCt = pdfR.headers.get('content-type') || '';
      console.log(`    → getReportsForView: ${pdfR.status} ${pdfCt}`);
      if (pdfCt.includes('pdf') || pdfCt.includes('octet')) {
        const buf = await pdfR.buffer();
        fs.writeFileSync('/tmp/ods-hit.pdf', buf);
        console.log('    *** SAVED /tmp/ods-hit.pdf ***');
        return;
      }
    }
  }

  // ── D. GET requests WITH CSRF token in header ────────────────────────────
  console.log('\n══ D. GET _eventId with CSRF token in header ═════════════════');
  const csrfHeader = {};
  csrfHeader[csrfName] = csrfValue;
  const csrfEvents = ['getReportsForView', 'inStoreTime', 'InStoreTime', 'view', 'run', 'next'];
  for (const ev of csrfEvents) {
    const url = `${ODS_URL}/asp/flow.html`
      + `?_flowId=aboveStoreInStoreReportsFlow`
      + `&_flowExecutionKey=${encodeURIComponent(s1Key)}`
      + `&_eventId=${ev}`
      + (ev === 'getReportsForView' ? '&exportType=pdf&contentDisposition=attachment' : '');
    const r = await fetch(url, { headers: { Cookie: cookie, 'User-Agent': ua, ...csrfHeader } });
    const ct   = r.headers.get('content-type') || '';
    const text = await r.text();
    const title = text.match(/<title>([^<]+)<\/title>/)?.[1] || '?';
    console.log(`  ${ev.padEnd(25)} → ${r.status} ct=${ct.substring(0,30)} title="${title}"`);
    if (ct.includes('pdf') || ct.includes('octet')) {
      const buf = await r.buffer();
      fs.writeFileSync('/tmp/ods-hit.pdf', buf);
      console.log('  *** SAVED /tmp/ods-hit.pdf ***');
      return;
    }
  }

  // ── E. AJAX-style (X-Requested-With) from s1 ────────────────────────────
  console.log('\n══ E. AJAX-style getReportsForView from s1 ═══════════════════');
  const ajaxVariants = [
    // GET, JSON accept
    { method: 'GET', accept: 'application/json', extra: '&exportType=pdf&contentDisposition=attachment' },
    // GET, PDF accept
    { method: 'GET', accept: 'application/pdf', extra: '&exportType=pdf&contentDisposition=attachment' },
    // POST, JSON
    { method: 'POST', accept: 'application/json', extra: '' },
  ];
  for (const v of ajaxVariants) {
    const url = `${ODS_URL}/asp/flow.html`
      + `?_flowId=aboveStoreInStoreReportsFlow`
      + `&_flowExecutionKey=${encodeURIComponent(s1Key)}`
      + `&_eventId=getReportsForView`
      + v.extra;
    const opts = {
      method: v.method,
      headers: {
        Cookie: cookie, 'User-Agent': ua,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': v.accept,
      }
    };
    if (v.method === 'POST') {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = `_flowExecutionKey=${encodeURIComponent(s1Key)}&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment`;
    }
    const r   = await fetch(url, opts);
    const ct  = r.headers.get('content-type') || '';
    const loc = r.headers.get('location') || '';
    const txt = await r.text();
    console.log(`  ${v.method} accept=${v.accept.substring(0,20).padEnd(20)} → ${r.status} ct=${ct.substring(0,30)}`);
    if (txt.length < 600) console.log('   body:', txt.replace(/\s+/g, ' '));
    if (ct.includes('pdf') || ct.includes('octet')) {
      fs.writeFileSync('/tmp/ods-hit.pdf', Buffer.from(txt));
      console.log('  *** PDF HIT ***');
      return;
    }
  }

  // ── F. aboveStore REST + broader PDF attempts ────────────────────────────
  console.log('\n══ F. aboveStore REST / alternative PDF endpoints ════════════');
  const restAttempts = [
    `/asp/aboveStore/inStoreTime.pdf`,
    `/asp/aboveStore/inStoreTime?format=pdf`,
    `/asp/aboveStore/rest/inStoreTime.pdf`,
    `/asp/aboveStore/report?type=IST&format=pdf`,
    `/asp/rest_v2/reports/Reports/Pizza_Hut/Operations/AboveStore_IST.pdf`,
    `/asp/rest_v2/reports/Reports/Pizza_Hut/Operations/IST.pdf`,
    `/asp/rest_v2/reports/Reports/dgi/aboveStore/IST.pdf`,
    `/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment`,
  ];
  for (const p of restAttempts) {
    const r = await fetch(`${ODS_URL}${p}`, { headers: { Cookie: cookie, 'User-Agent': ua } });
    const ct = r.headers.get('content-type') || '';
    console.log(p.substring(0, 70).padEnd(72), '→', r.status, ct.substring(0, 30));
    if (ct.includes('pdf') || ct.includes('octet')) {
      const buf = await r.buffer();
      fs.writeFileSync('/tmp/ods-hit.pdf', buf);
      console.log('  *** SAVED /tmp/ods-hit.pdf ***');
      return;
    }
  }

  console.log('\n── DONE. Key file: /tmp/ods-s1.html ──');
  console.log('If no PDF hit, look at Section A output for _eventId values in the s1 HTML,');
  console.log('and check /tmp/ods-s1.html for aboveStore module init code.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
