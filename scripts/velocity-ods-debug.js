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

  // ── 3. REST v2 — search for reportUnits matching "store" or "IST" ────────
  console.log('\n── REST v2 search: reportUnit q=InStore ─────────────');
  const searchRes  = await fetch(
    `${ODS_URL}/asp/rest_v2/resources?type=reportUnit&q=InStore&limit=20`, {
    headers: { Cookie: cookie, 'User-Agent': ua, Accept: 'application/json' }
  });
  const searchText = await searchRes.text();
  console.log('Status:', searchRes.status);
  console.log(searchText.substring(0, 2000));
  fs.writeFileSync('/tmp/ods-search-instore.json', searchText);

  // ── 4. REST v2 — search for reportUnits matching "above" ─────────────────
  console.log('\n── REST v2 search: reportUnit q=above ───────────────');
  const s2Res  = await fetch(
    `${ODS_URL}/asp/rest_v2/resources?type=reportUnit&q=above&limit=20`, {
    headers: { Cookie: cookie, 'User-Agent': ua, Accept: 'application/json' }
  });
  const s2Text = await s2Res.text();
  console.log('Status:', s2Res.status);
  console.log(s2Text.substring(0, 2000));
  fs.writeFileSync('/tmp/ods-search-above.json', s2Text);

  // ── 5. Try the aboveStore JS bundle ──────────────────────────────────────
  console.log('\n── aboveStore JS bundle ─────────────────────────────');
  for (const jsPath of [
    '/asp/aboveStore/js/aboveStore.min.js',
    '/asp/aboveStore/js/app.js',
    '/asp/aboveStore/js/aboveStore.js',
  ]) {
    const jRes = await fetch(`${ODS_URL}${jsPath}`, {
      headers: { Cookie: cookie, 'User-Agent': ua }
    });
    console.log(jsPath, '→', jRes.status);
    if (jRes.ok) {
      const jText = await jRes.text();
      // Look for PDF/export URL patterns
      const lines = jText.split('\n');
      const hits  = lines.filter(l => /pdf|export|reportUnit|flow\.html|rest_v2/i.test(l));
      console.log('Relevant lines:', hits.slice(0, 20).join('\n'));
      fs.writeFileSync('/tmp/ods-abovestore.js', jText.substring(0, 50000));
      break;
    }
  }

  // ── 6. Try the flow page HTML (full) ─────────────────────────────────────
  console.log('\n── Flow page full HTML ──────────────────────────────');
  const flowRes  = await fetch(
    `${ODS_URL}/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow`, {
    headers: { Cookie: cookie, 'User-Agent': ua }
  });
  const flowHtml = await flowRes.text();
  console.log('Status:', flowRes.status, '  Final URL:', flowRes.url);
  // Print lines containing key patterns
  const flowLines = flowHtml.split('\n');
  const keyLines  = flowLines.filter(l =>
    /flowExecution|e\ds\d|pdf|export|report|api|ajax|url/i.test(l));
  console.log('Key lines from flow HTML:\n', keyLines.slice(0, 40).join('\n'));
  fs.writeFileSync('/tmp/ods-flow.html', flowHtml);
  console.log('\nFull files saved to /tmp/ods-*.html and /tmp/ods-*.json');
  console.log('Run: cat /tmp/ods-search-instore.json | python3 -m json.tool');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
