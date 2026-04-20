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

  // ── 7. Find the aboveStore JS module (RequireJS base = /asp/optimized-scripts)
  //       aboveStore.main  →  /asp/optimized-scripts/aboveStore/main.js
  console.log('\n── aboveStore JS module ─────────────────────────────');
  const jsPaths = [
    '/asp/optimized-scripts/aboveStore/main.js',
    '/asp/optimized-scripts/aboveStore/main.min.js',
    '/asp/scripts/aboveStore/main.js',
    '/asp/aboveStore/main.js',
    '/asp/optimized-scripts/aboveStore.main.js',
  ];
  for (const p of jsPaths) {
    const r = await fetch(`${ODS_URL}${p}`, { headers: { Cookie: cookie, 'User-Agent': ua } });
    console.log(p, '→', r.status);
    if (r.ok) {
      const js = await r.text();
      fs.writeFileSync('/tmp/ods-aboveStore-main.js', js.substring(0, 100000));
      // Extract lines with pdf/export/download/api patterns
      const hits = js.split(';').filter(s => /pdf|export|download|\.pdf|format|aboveStore/i.test(s));
      console.log('PDF/export relevant snippets:\n', hits.slice(0, 20).join('\n---\n'));
      break;
    }
  }

  // ── 8. Try aboveStore direct API endpoints ────────────────────────────────
  console.log('\n── aboveStore direct API attempts ───────────────────');
  const apiAttempts = [
    '/asp/aboveStore/inStoreTime.pdf?date=2026-04-18',
    '/asp/aboveStore/download?format=pdf&date=2026-04-18',
    '/asp/aboveStore/run?format=pdf&reportName=InStoreTime&date=2026-04-18',
    '/asp/aboveStore/api/report?format=pdf&date=2026-04-18',
  ];
  for (const p of apiAttempts) {
    const r = await fetch(`${ODS_URL}${p}`, { headers: { Cookie: cookie, 'User-Agent': ua } });
    const ct = r.headers.get('content-type') || '';
    console.log(p, '→', r.status, ct.substring(0, 40));
    if (ct.includes('pdf')) { console.log('*** PDF HIT ***'); break; }
  }

  // ── 9. Get the flow page RequireJS config to find the correct module path ──
  console.log('\n── Flow page RequireJS config ───────────────────────');
  const flowFull = fs.readFileSync('/tmp/ods-flow.html', 'utf8');
  const requireCfg = flowFull.match(/require\.config\s*\(\s*\{[\s\S]{0,3000}?\}\s*\)/);
  if (requireCfg) console.log(requireCfg[0].substring(0, 1500));
  else {
    // Look for paths/baseUrl config
    const baseUrlMatch = flowFull.match(/baseUrl['":\s]+['"](.*?)['"]/g);
    const pathsMatch   = flowFull.match(/aboveStore[^;]{0,200}/g);
    console.log('baseUrl matches:', baseUrlMatch);
    console.log('aboveStore references:', pathsMatch?.slice(0, 10));
  }

  console.log('\nFiles saved to /tmp/ods-*.  Run: ls /tmp/ods-*');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
