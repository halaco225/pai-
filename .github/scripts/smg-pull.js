'use strict';
/**
 * smg-pull.js — runs in GitHub Actions.
 * 1. Opens 360.smg.com with Playwright (browser handles OAuth2 natively).
 * 2. Makes the export API call using browser cookies (already authenticated).
 * 3. POSTs the xlsx file to PAi's /api/intel/upload/smg endpoint.
 */
const { chromium } = require('playwright');
const fs    = require('fs');
const path  = require('path');
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

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext();

    // Log all browser console messages in Node.js output
    const page = await context.newPage();
    page.on('console', msg => console.log('BROWSER[' + msg.type() + ']: ' + msg.text()));

    // Intercept requests — look for auth headers of any kind
    let bearerToken = null;
    context.on('request', (req) => {
      const h = req.headers();
      for (const [k, v] of Object.entries(h)) {
        const kl = k.toLowerCase();
        if ((kl.includes('auth') || kl === 'x-smg-token' || kl.includes('token')) && v.length > 20) {
          console.log('AUTH HEADER on ' + req.url().slice(0, 60) + ' => ' + k + ': ' + v.slice(0, 60));
          if (v.toLowerCase().startsWith('bearer ')) {
            bearerToken = v.replace(/^bearer\s+/i, '');
          }
        }
      }
    });

    // ── Step 1: Navigate and log in ──────────────────────────────────────────
    console.log('Navigating to 360.smg.com...');
    await page.goto('https://360.smg.com', { waitUntil: 'networkidle', timeout: 60000 });
    console.log('URL after initial load: ' + page.url().slice(0, 80));

    // Handle login form on auth.smg.com if present
    for (let i = 0; i < 4; i++) {
      const url = page.url();
      if (url.includes('360.smg.com') && !url.includes('auth.smg.com')) break;
      const pwInput = await page.$('input[type="password"]');
      if (pwInput) {
        console.log('Login form found — filling credentials');
        const userInput = await page.$('input[name="username"]') || await page.$('input[name="email"]') || await page.$('input[type="email"]');
        if (userInput) await userInput.fill(SMG_USER);
        await pwInput.fill(SMG_PASS);
        const btn = await page.$('button[type="submit"]') || await page.$('input[type="submit"]');
        if (btn) {
          await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), btn.click()]);
        }
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      } else {
        await page.waitForTimeout(2000);
      }
    }
    console.log('Final URL: ' + page.url().slice(0, 80));

    // Navigate to Comments page to trigger API calls
    console.log('Loading Comments page...');
    await page.goto('https://360.smg.com/#/card/' + CARD_ID + '?id=' + CARD_ID, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Dump all localStorage keys + values
    const lsData = await page.evaluate(() => {
      const result = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        result[k] = (localStorage.getItem(k) || '').slice(0, 120);
      }
      return result;
    }).catch(() => ({}));
    console.log('localStorage (' + Object.keys(lsData).length + ' keys):');
    for (const [k, v] of Object.entries(lsData)) console.log('  ' + k + ' = ' + v);

    // ── Step 2: Export using browser cookies (credentials:include) ────────────
    console.log('Requesting export via browser fetch with credentials:include...');
    const payload = {
      reportId: REPORT_ID, cardId: CARD_ID, sortBy: 1,
      sourceOffsets: ALL_SOURCES.map(s => ({ sourceId: s, offset: 0 })),
      showCommentTranslation: false, includeSubcategories: true, text: '', topics: [],
      filter: { sources: FILTER_SOURCES, dateFilter: { dateRange: buildDateRange(TARGET_DATE), dateType: 0, reportGenerated: null }, hierarchy: {}, socialSites: [], attributeMeasures: [], openEnds: [], searchTerms: null, aggregationPeriod: null, ontologyGroups: [] },
      exportFileType: 1, baseFileName: 'Comments_ByComment', timeZone: 'America/New_York', separateComments: true,
    };

    const exportResult = await page.evaluate(async ({ exportUrl, acctId, pl }) => {
      const resp = await fetch(exportUrl, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'accept': 'application/xlsx', 'AccountId': acctId, 'SMG-LanguageIso': 'en-US', 'TimeZone': 'America/New_York', 'Origin': 'https://360.smg.com', 'Referer': 'https://360.smg.com/', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(pl),
      });
      if (!resp.ok) return { ok: false, status: resp.status, error: (await resp.text()).slice(0, 300) };
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return { ok: true, status: resp.status, b64: btoa(bin), size: buf.byteLength };
    }, { exportUrl: 'https://360.smg.com/api/export/v2/commentreport', acctId: ACCOUNT_ID, pl: payload });

    console.log('Export result: status=' + exportResult.status + ' ok=' + exportResult.ok + (exportResult.error ? ' err=' + exportResult.error : '') + (exportResult.size ? ' size=' + exportResult.size : ''));
    if (!exportResult.ok) throw new Error('Export HTTP ' + exportResult.status + ': ' + (exportResult.error || ''));

    const xlsxBuf = Buffer.from(exportResult.b64, 'base64');
    console.log('Downloaded ' + xlsxBuf.length + ' bytes');
    if (xlsxBuf[0] !== 0x50 || xlsxBuf[1] !== 0x4b) throw new Error('Not xlsx: ' + xlsxBuf.toString('utf8').slice(0, 200));

    // ── Step 3: Upload to PAi ─────────────────────────────────────────────────
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
