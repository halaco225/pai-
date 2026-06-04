'use strict';
/**
 * smg-pull.js — GitHub Actions daily SMG comments pull.
 *
 * Auth flow (mirrors what a real browser does):
 *   1. Log in to reporting.smg.com → .ASPXAUTH cookie set for .smg.com
 *   2. Navigate to 360.smg.com — Angular app loads, route guard runs
 *   3. Guard calls startAuthentication() → navigates to auth.smg.com/connect/authorize
 *   4. auth.smg.com sees .ASPXAUTH cookie → issues token without showing login form
 *   5. Redirect back to 360.smg.com with #access_token=xxx
 *   6. Use Bearer token to call export API
 *   7. Upload xlsx to PAi
 */
const { chromium } = require('playwright');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const SMG_USER    = process.env.SMG_USER;
const SMG_PASS    = process.env.SMG_PASSWORD;
const PAI_URL     = (process.env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com').replace(/\/$/, '');
const AUTH_TOKEN  = process.env.INTEL_AUTOMATION_TOKEN || '38b8091924e1f85583454212a9860038';
const TARGET_DATE = process.env.TARGET_DATE || (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
})();

if (!SMG_USER || !SMG_PASS) { console.error('SMG_USER and SMG_PASSWORD must be set'); process.exit(1); }
console.log('Target date: ' + TARGET_DATE);

function buildDateRange(targetDate) {
  const endMs     = new Date(targetDate + 'T05:00:00.000Z').getTime() + 86400000;
  const startMs   = endMs - 30 * 86400000;
  const bmEndMs   = startMs - 1;
  const bmStartMs = bmEndMs - 30 * 86400000 + 1;
  return { startDate: new Date(startMs).toISOString(), endDate: new Date(endMs-1).toISOString(),
           benchmarkStartDate: new Date(bmStartMs).toISOString(), benchmarkEndDate: new Date(bmEndMs).toISOString(), appliedByUser: false };
}

const ACCOUNT_ID     = '5b6205b27485e95d90e0a366';
const REPORT_ID      = '5b621d617485e95d90e0a36f';
const CARD_ID        = '5b621d617485e95d90e0a370';
const FILTER_SOURCES = ['6684c1735040640c94fe34da','5b522bf87485e96d80b2dfaf','60ada0b4de7df021c003f620','65807135e6485f00fc5c9fb4'];
const ALL_SOURCES    = ['5b73cc62f820781a3c28152c','6684c1735040640c94fe34da','644a8e03de7dee17c04fe327','5b522bf87485e96d80b2dfaf','661d4b6df820780f14f6fcf1','65a0028a504064228089de85','60ada0b4de7df021c003f620','642dca8350406420fc9bb262','6983e2725040640e14f8ebcf','65807135e6485f00fc5c9fb4','5d42044ef8207820d81c1169','64ec730ce6485f17e494aa4d','61e7494350406421a4ea9608','5ed7b8d6f820782450e5d26f','5b522969f8207835f04a3106','5ad79fc0f82078451850a66b','63f39d717485e921f0f4a405','5f2ca93d7485e90bec6c7bda'];

function extractToken(url) {
  const fragment = (url.split('#')[1] || '');
  const query    = (url.split('?')[1] || '').split('#')[0];
  for (const part of [fragment, query]) {
    if (!part || !part.includes('access_token')) continue;
    const params = {};
    part.split('&').forEach(p => { const eq = p.indexOf('='); if (eq > 0) params[decodeURIComponent(p.slice(0,eq))] = decodeURIComponent(p.slice(eq+1)); });
    if (params.access_token) return params.access_token;
  }
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page    = await context.newPage();

    // Log navigations
    page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('NAV→ ' + f.url().slice(0, 100)); });

    let bearerToken = null;

    // Capture token from any URL fragment navigation
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (url.includes('access_token=')) {
        const t = extractToken(url);
        if (t) { bearerToken = t; console.log('Bearer captured from nav URL, length=' + t.length); }
      }
    });

    // ── Step 1: Log in to reporting.smg.com ────────────────────────────────────
    console.log('Logging in to reporting.smg.com...');
    await page.goto('https://reporting.smg.com/Index.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Extract hidden form fields and submit
    const loginResult = await page.evaluate(async (user, pass) => {
      const form = document.querySelector('form');
      if (!form) return 'no form';
      const inputs = {};
      for (const el of document.querySelectorAll('input[type=hidden]')) {
        inputs[el.name] = el.value;
      }
      inputs['ctl00$cphMain$txtUserName'] = user;
      inputs['ctl00$cphMain$txtPassword'] = pass;
      const body = Object.entries(inputs).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
      const resp = await fetch('https://reporting.smg.com/Index.aspx', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://reporting.smg.com/Index.aspx', 'Origin': 'https://reporting.smg.com' },
        body,
      });
      return 'HTTP ' + resp.status + ' url=' + resp.url;
    }, SMG_USER, SMG_PASS);
    console.log('reporting.smg.com login result: ' + loginResult);

    // Check if logged in (cookie should now be set)
    const cookies = await context.cookies('https://reporting.smg.com');
    const authCookie = cookies.find(c => c.name === '.ASPXAUTH');
    console.log('.ASPXAUTH cookie: ' + (authCookie ? 'SET (domain=' + authCookie.domain + ')' : 'NOT SET'));

    // ── Step 2: Navigate to 360.smg.com — Angular will redirect to auth.smg.com ─
    console.log('Navigating to 360.smg.com (session cookie should trigger OAuth)...');
    await page.goto('https://360.smg.com', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000); // give Angular time to process route guard
    console.log('After 360.smg.com load: ' + page.url().slice(0, 100));

    // Wait for either auth.smg.com redirect OR token appearing in URL
    if (!bearerToken && !page.url().startsWith('https://auth.smg.com')) {
      console.log('Waiting for auth redirect or token (30s)...');
      await Promise.race([
        page.waitForURL(u => u.startsWith('https://auth.smg.com'), { timeout: 30000 }),
        page.waitForURL(u => u.includes('access_token='), { timeout: 30000 }),
      ]).catch(() => {});
      console.log('After wait: ' + page.url().slice(0, 100));
    }

    // If redirected to auth.smg.com, wait for it to redirect back with token
    if (!bearerToken && page.url().startsWith('https://auth.smg.com')) {
      console.log('On auth.smg.com — waiting for redirect with token (30s)...');
      await page.waitForURL(u => u.includes('access_token='), { timeout: 30000 }).catch(() => {});
      console.log('After auth: ' + page.url().slice(0, 100));
      const t = extractToken(page.url());
      if (t) { bearerToken = t; console.log('Token from URL, length=' + t.length); }
    }

    // Fallback: check localStorage
    if (!bearerToken) {
      bearerToken = await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k) || '';
          try {
            if (v.startsWith('{')) {
              const o = JSON.parse(v);
              if (o.access_token) return o.access_token;
            }
            if (v.length > 100 && v.split('.').length === 3 && !v.includes(' ')) return v;
          } catch(_) {}
        }
        return null;
      }).catch(() => null);
      if (bearerToken) console.log('Token from localStorage, length=' + bearerToken.length);
    }

    if (!bearerToken) {
      // Last log: what is the current page state?
      const finalBody = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).slice(0, 300);
      throw new Error('No Bearer token. Final URL: ' + page.url().slice(0,100) + ' body: ' + finalBody.replace(/\s+/g,' ').slice(0,200));
    }

    await browser.close();

    // ── Step 3: Download SMG export ───────────────────────────────────────────
    console.log('Downloading SMG export...');
    const payload = {
      reportId: REPORT_ID, cardId: CARD_ID, sortBy: 1,
      sourceOffsets: ALL_SOURCES.map(s => ({ sourceId: s, offset: 0 })),
      showCommentTranslation: false, includeSubcategories: true, text: '', topics: [],
      filter: { sources: FILTER_SOURCES, dateFilter: { dateRange: buildDateRange(TARGET_DATE), dateType: 0, reportGenerated: null }, hierarchy: {}, socialSites: [], attributeMeasures: [], openEnds: [], searchTerms: null, aggregationPeriod: null, ontologyGroups: [] },
      exportFileType: 1, baseFileName: 'Comments_ByComment', timeZone: 'America/New_York', separateComments: true,
    };
    const body = JSON.stringify(payload);
    const xlsxBuf = await new Promise((resolve, reject) => {
      const options = { method: 'POST', hostname: '360.smg.com', port: 443, path: '/api/export/v2/commentreport',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'accept': 'application/xlsx', 'AccountId': ACCOUNT_ID, 'Authorization': 'Bearer ' + bearerToken, 'SMG-LanguageIso': 'en-US', 'TimeZone': 'America/New_York', 'Origin': 'https://360.smg.com', 'Referer': 'https://360.smg.com/', 'X-Requested-With': 'XMLHttpRequest' } };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          console.log('Export HTTP ' + res.statusCode + ', ' + buf.length + ' bytes');
          if (res.statusCode !== 200) return reject(new Error('Export HTTP ' + res.statusCode + ': ' + buf.toString('utf8').slice(0, 200)));
          resolve(buf);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    if (xlsxBuf[0] !== 0x50 || xlsxBuf[1] !== 0x4b) throw new Error('Not xlsx: ' + xlsxBuf.toString('utf8').slice(0, 200));

    // ── Step 4: Upload to PAi ─────────────────────────────────────────────────
    const tmpFile = '/tmp/smg-' + TARGET_DATE + '.xlsx';
    fs.writeFileSync(tmpFile, xlsxBuf);
    console.log('Uploading to PAi...');
    const boundary = '----FormBoundary' + Date.now();
    const fileContent = fs.readFileSync(tmpFile);
    const formBody = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="date"\r\n\r\n' + TARGET_DATE + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="smg-' + TARGET_DATE + '.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'),
      fileContent,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    const uploadResult = await new Promise((resolve, reject) => {
      const parsed  = new URL(PAI_URL + '/api/intel/upload/smg');
      const lib     = parsed.protocol === 'https:' ? https : http;
      const options = { method: 'POST', hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname, headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': formBody.length, 'X-Automation-Token': AUTH_TOKEN } };
      const req = lib.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
      req.on('error', reject);
      req.write(formBody);
      req.end();
    });
    console.log('Upload HTTP ' + uploadResult.status + ': ' + uploadResult.body);
    if (uploadResult.status < 200 || uploadResult.status >= 300) throw new Error('Upload failed HTTP ' + uploadResult.status);
    console.log('SMG comments pull complete.');
    fs.unlinkSync(tmpFile);

  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
