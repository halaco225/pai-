/**
 * velocity-ods-debug.js
 * One-shot script to discover the correct PDF download URL for the Above Store report.
 * Run once from Render shell: node scripts/velocity-ods-debug.js
 *
 * Tries four approaches in order:
 *   1. JRS REST v2 — list reports in the repo to find the Above Store report URI
 *   2. JRS REST v2 — direct PDF download once URI is found
 *   3. Fetch loginsuccess.html to see what the default landing page is
 *   4. Fetch the aboveStore JS bundle to find the PDF export endpoint
 */
'use strict';

const fs   = require('fs');
const path = require('path');

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
  const r1  = await fetch(`${ODS_URL}/asp/login.html`, { headers: { 'User-Agent': UA } });
  const c1  = parseCookies(r1);
  const r2  = await fetch(`${ODS_URL}/asp/JavaScriptServlet`, {
    method: 'POST',
    headers: { 'Cookie': mergeCookies(c1), 'FETCH-CSRF-TOKEN': '1',
               'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA }
  });
  const c2    = parseCookies(r2);
  const raw   = await r2.text();
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
  console.log('[DEBUG] Login OK, location:', loc);
  return { cookie: mergeCookies(c1, c2, c3), ua: UA, csrfName, csrfValue };
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }

  const session = await login();
  const { cookie, ua } = session;

  // ── 1. loginsuccess.html ──────────────────────────────────────────────────
  console.log('\n── loginsuccess.html ────────────────────────────────');
  const lsRes  = await fetch(`${ODS_URL}/asp/loginsuccess.html`, {
    headers: { Cookie: cookie, 'User-Agent': ua }
  });
  const lsHtml = await lsRes.text();
  console.log('Status:', lsRes.status, '  Final URL:', lsRes.url);
  console.log(lsHtml.substring(0, 1000));
  fs.writeFileSync('/tmp/ods-loginsuccess.html', lsHtml);

  // ── 2. REST v2 — list top-level folders ──────────────────────────────────
  console.log('\n── REST v2 /resources (top) ─────────────────────────');
  const foldersRes  = await fetch(`${ODS_URL}/asp/rest_v2/resources?type=folder&limit=20`, {
    headers: { Cookie: cookie, 'User-Agent': ua, Accept: 'application/json' }
  });
  const foldersText = await foldersRes.text();
  console.log('Status:', foldersRes.status);
  console.log(foldersText.substring(0, 1000));
  fs.writeFileSync('/tmp/ods-folders.json', foldersText);

  // ── 3. List all reports in Pizza_Hut/Operations ──────────────────────────
  console.log('\n── REST v2: /Reports/Pizza_Hut/Operations reports ───');
  const opsRes  = await fetch(
    `${ODS_URL}/asp/rest_v2/resources?folderUri=/Reports/Pizza_Hut/Operations&type=reportUnit&limit=100`, {
    headers: { Cookie: cookie, 'User-Agent': ua, Accept: 'application/json' }
  });
  const opsText = await opsRes.text();
  console.log('Status:', opsRes.status);
  console.log(opsText);
  fs.writeFileSync('/tmp/ods-ops-reports.json', opsText);

  // ── 4. Search by multiple terms ──────────────────────────────────────────
  for (const q of ['IST', 'speed', 'dispatch', 'store', 'velocity', 'performance']) {
    const r = await fetch(
      `${ODS_URL}/asp/rest_v2/resources?type=reportUnit&q=${q}&limit=10`, {
      headers: { Cookie: cookie, 'User-Agent': ua, Accept: 'application/json' }
    });
    const t = await r.text();
    if (r.status === 200 && t.includes('uri')) {
      console.log(`\n── q=${q} (${r.status}) ──`);
      // Extract just the URIs
      const uris = [...t.matchAll(/"uri":"([^"]+)"/g)].map(m => m[1]);
      console.log(uris.join('\n'));
    }
  }

  // ── 5. List all top-level report folders (more complete) ─────────────────
  console.log('\n── All folders (limit 50) ───────────────────────────');
  const allFolders = await fetch(
    `${ODS_URL}/asp/rest_v2/resources?type=folder&limit=50`, {
    headers: { Cookie: cookie, 'User-Agent': ua, Accept: 'application/json' }
  });
  const af = await allFolders.text();
  const folderUris = [...af.matchAll(/"uri":"([^"]+)"/g)].map(m => m[1]);
  console.log(folderUris.join('\n'));
  fs.writeFileSync('/tmp/ods-all-folders.json', af);

  // ── 6. Flow page — extract flowExecutionKey and relevant JS ──────────────
  console.log('\n── Flow page key lines ──────────────────────────────');
  const flowRes  = await fetch(
    `${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`, {
    headers: { Cookie: cookie, 'User-Agent': ua }
  });
  const flowHtml = await flowRes.text();
  const keyLines = flowHtml.split('\n').filter(l =>
    /flowExecution|reportUnit|rest_v2|aboveStore|pdf|export|selectReport|IST/i.test(l));
  console.log(keyLines.slice(0, 30).join('\n'));
  fs.writeFileSync('/tmp/ods-flow.html', flowHtml);

  // ── 7. Try REST v2 async report run (alternative to direct PDF) ──────────
  console.log('\n── REST v2 async run test (PH_AboveStoreInStoreTime) ─');
  const asyncRes = await fetch(
    `${ODS_URL}/asp/rest_v2/reports/Reports/Pizza_Hut/Operations/PH_AboveStoreInStoreTime.pdf?DATE=2026-04-18`, {
    headers: { Cookie: cookie, 'User-Agent': ua }
  });
  console.log('Status:', asyncRes.status, 'ct:', asyncRes.headers.get('content-type'));
  if (!asyncRes.ok) {
    const t = await asyncRes.text();
    console.log(t.substring(0, 300));
  } else {
    console.log('Got PDF!', (await asyncRes.buffer()).length, 'bytes');
  }

  console.log('\nFiles saved to /tmp/ods-*.  Run: ls /tmp/ods-*');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
