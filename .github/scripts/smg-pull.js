'use strict';
/**
 * smg-pull.js — runs in GitHub Actions (full Chromium support).
 * 1. Opens 360.smg.com with Playwright — browser handles OAuth2 natively.
 * 2. Makes the export API call FROM WITHIN the browser (already authenticated).
 * 3. POSTs the xlsx file to PAi's existing upload endpoint.
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const SMG_USER   = process.env.SMG_USER;
const SMG_PASS   = process.env.SMG_PASSWORD;
const PAI_URL    = (process.env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com').replace(/\/$/, '');
const AUTH_TOKEN = process.env.INTEL_AUTOMATION_TOKEN || '38b8091924e1f85583454212a9860038';
const TARGET_DATE = process.env.TARGET_DATE || (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
})();

if (!SMG_USER || !SMG_PASS) {
  console.error('SMG_USER and SMG_PASSWORD must be set');
  process.exit(1);
}

console.log(`Target date: ${TARGET_DATE}`);

// Build 30-day window for the export payload
function buildDateRange(targetDate) {
  const endMs      = new Date(targetDate + 'T05:00:00.000Z').getTime() + 86400000;
  const startMs    = endMs - 30 * 86400000;
  const bmEndMs    = startMs - 1;
  const bmStartMs  = bmEndMs - 30 * 86400000 + 1;
  return {
    startDate:          new Date(startMs).toISOString(),
    endDate:            new Date(endMs - 1).toISOString(),
    benchmarkStartDate: new Date(bmStartMs).toISOString(),
    benchmarkEndDate:   new Date(bmEndMs).toISOString(),
    appliedByUser:      false,
  };
}

const ACCOUNT_ID     = '5b6205b27485e95d90e0a366';
const REPORT_ID      = '5b621d617485e95d90e0a36f';
const CARD_ID        = '5b621d617485e95d90e0a370';
const FILTER_SOURCES = [
  '6684c1735040640c94fe34da', '5b522bf87485e96d80b2dfaf',
  '60ada0b4de7df021c003f620', '65807135e6485f00fc5c9fb4',
];
const ALL_SOURCES = [
  '5b73cc62f820781a3c28152c', '6684c1735040640c94fe34da',
  '644a8e03de7dee17c04fe327', '5b522bf87485e96d80b2dfaf',
  '661d4b6df820780f14f6fcf1', '65a0028a504064228089de85',
  '60ada0b4de7df021c003f620', '642dca8350406420fc9bb262',
  '6983e2725040640e14f8ebcf', '65807135e6485f00fc5c9fb4',
  '5d42044ef8207820d81c1169', '64ec730ce6485f17e494aa4d',
  '61e7494350406421a4ea9608', '5ed7b8d6f820782450e5d26f',
  '5b522969f8207835f04a3106', '5ad79fc0f82078451850a66b',
  '63f39d717485e921f0f4a405', '5f2ca93d7485e90bec6c7bda',
];

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext();
  const page    = await context.newPage();

  // ── Step 1: Navigate to 360.smg.com, capture Bearer token from page requests ─
  let bearerToken = null;

  // Intercept all requests — log headers for diagnosis, capture Bearer token
  context.on('request', (request) => {
    const url = request.url();
    const headers = request.headers();
    // Log any request to smg.com domains
    if (url.includes('smg.com')) {
      const authKeys = Object.keys(headers).filter(k => k.toLowerCase().includes('auth') || k.toLowerCase().includes('token') || k.toLowerCase().includes('bearer'));
      if (authKeys.length > 0) {
        console.log('REQUEST ' + request.method() + ' ' + url.slice(0, 80));
        for (const k of authKeys) console.log('  ' + k + ': ' + headers[k].slice(0, 60));
      }
    }
    // Capture bearer from any header variant
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase().includes('auth') && v.toLowerCase().includes('bearer ')) {
        bearerToken = v.replace(/^bearer\s+/i, '');
        console.log('Bearer token captured from header: ' + k + ', length=' + bearerToken.length);
      }
    }
  });

  console.log('Navigating to 360.smg.com...');
  await page.goto('https://360.smg.com', { waitUntil: 'networkidle', timeout: 60000 });

  // Handle login form if redirected to auth.smg.com
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = page.url();
    console.log(`Current URL: ${url.slice(0, 80)}`);
    if (url.includes('360.smg.com') && !url.includes('auth.smg.com')) break;

    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) {
      await page.waitForTimeout(3000);
      continue;
    }
    console.log('Login form detected — filling credentials');
    const userInput = await page.$('input[name="username"]')
                   || await page.$('input[name="email"]')
                   || await page.$('input[type="email"]');
    if (userInput) await userInput.fill(SMG_USER);
    await passwordInput.fill(SMG_PASS);
    const btn = await page.$('button[type="submit"]') || await page.$('input[type="submit"]');
    if (btn) {
      await Promise.all([
        page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
        btn.click(),
      ]);
    }
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }

  console.log(`Logged in. Final URL: ${page.url().slice(0, 80)}`);

  // Navigate to the Comments page — this forces Angular to make authenticated API calls
  if (!bearerToken) {
    console.log('Navigating to Comments page to trigger authenticated API calls...');
    await page.goto('https://360.smg.com/#/card/5b621d617485e95d90e0a370?id=5b621d617485e95d90e0a370', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }

  // Still no token from requests — extract from localStorage (oidc-client pattern)
  if (!bearerToken) {
    console.log('Checking localStorage for token...');
    bearerToken = await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      // Log all keys and first 80 chars of each value for diagnosis
      for (const k of keys) {
        const v = localStorage.getItem(k) || '';
        console.log('LS key=' + k + ' val=' + v.slice(0, 80));
      }
      console.log('localStorage keys:', JSON.stringify(keys));
      for (const key of keys) {
        try {
          const val = localStorage.getItem(key);
          if (!val || val.length < 10) continue;
          // oidc-client-js: stored as JSON with access_token
          if (val.startsWith('{')) {
            const obj = JSON.parse(val);
            if (obj.access_token) return obj.access_token;
            if (obj.token) return obj.token;
          }
          // Raw JWT (3 dot-separated base64 segments, >100 chars)
          if (val.length > 100 && val.split('.').length === 3 && !val.includes(' ')) return val;
        } catch (_) {}
      }
      return null;
    }).catch(() => null);
    if (bearerToken) console.log('Token found in localStorage, length=' + bearerToken.length);
  }

  // Last resort: trigger a known API endpoint and intercept the request
  if (!bearerToken) {
    console.log('Triggering API call via page.evaluate fetch...');
    const result = await page.evaluate(async () => {
      try {
        // Make a lightweight API call — the Angular $http interceptor adds the Bearer token
        // We can't read it back but we can trigger it for the context interceptor
        await fetch('https://360.smg.com/api/accounts', { credentials: 'include' });
      } catch (_) {}
      return null;
    }).catch(() => null);
    await page.waitForTimeout(2000);
  }

  if (!bearerToken) throw new Error('Could not capture Bearer token from page. Login may have failed or token is not in localStorage.');
  console.log('Bearer token captured, length=' + bearerToken.length);


  await browser.close();
  browser = null;

  // ── Step 2: Download export via Node.js HTTP with captured Bearer token ──────
  console.log('Downloading SMG comments export...');
  const exportPayload = {
    reportId:              REPORT_ID,
    cardId:                CARD_ID,
    sortBy:                1,
    sourceOffsets:         ALL_SOURCES.map(sourceId => ({ sourceId, offset: 0 })),
    showCommentTranslation: false,
    includeSubcategories:  true,
    text:                  '',
    topics:                [],
    filter: {
      sources:   FILTER_SOURCES,
      dateFilter: { dateRange: buildDateRange(TARGET_DATE), dateType: 0, reportGenerated: null },
      hierarchy: {}, socialSites: [], attributeMeasures: [],
      openEnds: [], searchTerms: null, aggregationPeriod: null, ontologyGroups: [],
    },
    exportFileType:   1,
    baseFileName:     'Comments_ByComment',
    timeZone:         'America/New_York',
    separateComments: true,
  };

  const body = JSON.stringify(exportPayload);
  const xlsxBuf = await new Promise((resolve, reject) => {
    const options = {
      method: 'POST', hostname: '360.smg.com', port: 443,
      path: '/api/export/v2/commentreport',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'accept': 'application/xlsx', 'AccountId': ACCOUNT_ID,
        'Authorization': `Bearer ${bearerToken}`,
        'SMG-LanguageIso': 'en-US', 'TimeZone': 'America/New_York',
        'Origin': 'https://360.smg.com', 'Referer': 'https://360.smg.com/',
        'X-Requested-With': 'XMLHttpRequest',
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        console.log(`Export HTTP ${res.statusCode}, ${buf.length} bytes`);
        if (res.statusCode !== 200) return reject(new Error(`Export HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  console.log(`Export downloaded: ${xlsxBuf.length} bytes`);

  if (xlsxBuf[0] !== 0x50 || xlsxBuf[1] !== 0x4b) {
    throw new Error(`Response is not xlsx: ${xlsxBuf.toString('utf8').slice(0, 200)}`);
  }

  // ── Step 3: Upload to PAi ────────────────────────────────────────────────────
  const tmpFile = path.join('/tmp', `smg-comments-${TARGET_DATE}.xlsx`);
  fs.writeFileSync(tmpFile, xlsxBuf);
  console.log(`Uploading to ${PAI_URL}/api/intel/upload/smg for ${TARGET_DATE}...`);

  const boundary = `----FormBoundary${Date.now()}`;
  const fileContent = fs.readFileSync(tmpFile);
  const formBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="date"\r\n\r\n${TARGET_DATE}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="smg-comments-${TARGET_DATE}.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const uploadResult = await new Promise((resolve, reject) => {
    const parsed  = new URL(`${PAI_URL}/api/intel/upload/smg`);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      method:   'POST',
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      headers: {
        'Content-Type':        `multipart/form-data; boundary=${boundary}`,
        'Content-Length':      formBody.length,
        'X-Automation-Token':  AUTH_TOKEN,
      },
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(formBody);
    req.end();
  });

  console.log(`Upload response HTTP ${uploadResult.status}: ${uploadResult.body}`);
  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Upload failed: HTTP ${uploadResult.status}`);
  }

  console.log('SMG comments pull complete.');
  fs.unlinkSync(tmpFile);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
