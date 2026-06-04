'use strict';
/**
 * smg-pull.js — runs in GitHub Actions.
 * 1. Opens auth.smg.com/connect/authorize with Playwright.
 *    The Angular login SPA renders; we fill credentials; token arrives in redirect fragment.
 * 2. Uses the Bearer token to call the SMG export API.
 * 3. POSTs the xlsx to PAi's /api/intel/upload/smg.
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
  const fragment = (url.split('#')[1] || '').replace(/^#/, '');
  const query    = (url.split('?')[1] || '').split('#')[0];
  for (const part of [fragment, query]) {
    if (!part) continue;
    const params = {};
    part.split('&').forEach(p => { const eq = p.indexOf('='); if (eq > 0) params[decodeURIComponent(p.slice(0,eq))] = decodeURIComponent(p.slice(eq+1)); });
    if (params.access_token) return params.access_token;
  }
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext();
    const page    = await context.newPage();

    // Log browser console for debugging
    page.on('console', msg => { if (msg.type() !== 'log') return; console.log('BROWSER: ' + msg.text().slice(0, 120)); });

    let bearerToken = null;

    // Capture token from any navigation that includes access_token in the URL
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (url.includes('access_token')) {
        const t = extractToken(url);
        if (t) { bearerToken = t; console.log('Bearer token captured from URL fragment, length=' + t.length); }
      }
    });

    // ── Step 1: Navigate to OAuth2 authorize endpoint directly ────────────────
    const nonce = Math.random().toString(36).slice(2);
    const state = Math.random().toString(36).slice(2);
    const authorizeUrl = 'https://auth.smg.com/connect/authorize?' + [
      'response_type=token%20id_token',
      'client_id=smg360',
      'scope=' + encodeURIComponent('feedback openid email smg360 offline_access'),
      'redirect_uri=' + encodeURIComponent('https://360.smg.com/auth-callback'),
      'nonce=' + nonce,
      'state=' + state,
    ].join('&');

    console.log('Navigating to auth.smg.com/connect/authorize...');
    await page.goto(authorizeUrl, { waitUntil: 'networkidle', timeout: 60000 });
    console.log('Auth page URL: ' + page.url().slice(0, 100));

    // ── Step 2: Wait for login form OR auto-redirect (Angular takes time to render)
    console.log('Waiting for login form or redirect (up to 45s)...');

    // Race: wait for password field OR URL change to 360.smg.com
    await Promise.race([
      page.locator('input[type="password"]').waitFor({ timeout: 45000 }).catch(() => {}),
      page.waitForURL(u => u.startsWith('https://360.smg.com'), { timeout: 45000 }).catch(() => {}),
    ]);

    const currentUrlAfterWait = page.url();
    console.log('URL after wait: ' + currentUrlAfterWait.slice(0, 120));

    // If already redirected to 360.smg.com with token, we're done
    if (currentUrlAfterWait.startsWith('https://360.smg.com') && currentUrlAfterWait.includes('access_token')) {
      console.log('Auto-redirected with token.');
    } else if (currentUrlAfterWait.startsWith('https://360.smg.com')) {
      console.log('Redirected to 360.smg.com (no token in URL yet — may be in hash).');
      const hash = await page.evaluate(() => window.location.hash).catch(() => '');
      console.log('URL hash: ' + hash.slice(0, 100));
      const t = extractToken('360.smg.com' + hash);
      if (t) bearerToken = t;
    } else {
      // Still on auth.smg.com — try to fill login form
      const pwInput = await page.$('input[type="password"]');
      if (pwInput) {
        console.log('Login form found — filling credentials');
        const userInput = await page.$('input[name="username"]') || await page.$('input[name="email"]') || await page.$('input[type="email"]') || await page.$('input[type="text"]');
        if (userInput) {
          console.log('Username field type: ' + await userInput.getAttribute('type'));
          await userInput.fill(SMG_USER);
        }
        await pwInput.fill(SMG_PASS);

        const btn = await page.$('button[type="submit"]') || await page.$('input[type="submit"]');
        if (btn) {
          console.log('Submitting form...');
          await Promise.all([
            page.waitForURL('**360.smg.com**', { timeout: 30000 }).catch(() => {}),
            btn.click(),
          ]);
        }
        console.log('After submit URL: ' + page.url().slice(0, 120));
        const hash2 = await page.evaluate(() => window.location.hash).catch(() => '');
        console.log('After submit hash: ' + hash2.slice(0, 100));
        const t2 = extractToken(page.url() + hash2);
        if (t2) bearerToken = t2;
      } else {
        console.log('No login form and no redirect. Page title: ' + await page.title());
        // Log page body for diagnosis
        const body = (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 500);
        console.log('Page body: ' + body);
      }
    }

    // Try reading from current URL fragment
    if (!bearerToken) {
      const currentUrl = page.url();
      bearerToken = extractToken(currentUrl);
      if (bearerToken) console.log('Token from current URL, length=' + bearerToken.length);
    }

    // Try localStorage (in case token was stored by auth-callback Angular code)
    if (!bearerToken) {
      bearerToken = await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k) || '';
          try {
            if (v.startsWith('{')) {
              const obj = JSON.parse(v);
              if (obj.access_token) return obj.access_token;
            }
            if (v.length > 100 && v.split('.').length === 3 && !v.includes(' ')) return v;
          } catch (_) {}
        }
        return null;
      }).catch(() => null);
      if (bearerToken) console.log('Token from localStorage, length=' + bearerToken.length);
    }

    if (!bearerToken) throw new Error('No Bearer token after login. Final URL: ' + page.url().slice(0, 100));

    await browser.close();

    // ── Step 3: Download export with Bearer token ─────────────────────────────
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
