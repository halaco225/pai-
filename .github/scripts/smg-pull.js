'use strict';
/**
 * smg-pull.js — GitHub Actions daily SMG comments pull.
 *
 * Auth: PKCE authorization code flow → 360.smg.com sets authorizationData cookie.
 * Token is in cookie "authorizationData" (JSON: access_token, refresh_token).
 */
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');

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
  const endMs = new Date(targetDate + 'T05:00:00.000Z').getTime() + 86400000;
  const startMs = endMs - 30 * 86400000;
  return {
    startDate: new Date(startMs).toISOString(), endDate: new Date(endMs-1).toISOString(),
    benchmarkStartDate: new Date(startMs - 30*86400000).toISOString(),
    benchmarkEndDate: new Date(startMs - 1).toISOString(), appliedByUser: false,
  };
}

// PKCE helpers
function generateVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

const ACCOUNT_ID     = '5b6205b27485e95d90e0a366';
const REPORT_ID      = '5b621d617485e95d90e0a36f';
const CARD_ID        = '5b621d617485e95d90e0a370';
const FILTER_SOURCES = ['6684c1735040640c94fe34da','5b522bf87485e96d80b2dfaf','60ada0b4de7df021c003f620','65807135e6485f00fc5c9fb4'];
const ALL_SOURCES    = ['5b73cc62f820781a3c28152c','6684c1735040640c94fe34da','644a8e03de7dee17c04fe327','5b522bf87485e96d80b2dfaf','661d4b6df820780f14f6fcf1','65a0028a504064228089de85','60ada0b4de7df021c003f620','642dca8350406420fc9bb262','6983e2725040640e14f8ebcf','65807135e6485f00fc5c9fb4','5d42044ef8207820d81c1169','64ec730ce6485f17e494aa4d','61e7494350406421a4ea9608','5ed7b8d6f820782450e5d26f','5b522969f8207835f04a3106','5ad79fc0f82078451850a66b','63f39d717485e921f0f4a405','5f2ca93d7485e90bec6c7bda'];

async function getAccessToken(context, page) {
  // Check if authorizationData cookie already exists (session established)
  const cookies = await context.cookies('https://360.smg.com');
  const authCookie = cookies.find(c => c.name === 'authorizationData');
  if (authCookie) {
    try {
      const data = JSON.parse(decodeURIComponent(authCookie.value));
      const token = data.access_token || data.accessToken;
      if (token) { console.log('authorizationData cookie found — using existing token'); return token; }
    } catch(_) {}
  }
  console.log('No valid authorizationData cookie — starting OAuth2 PKCE flow');

  // Generate PKCE parameters
  const verifier   = generateVerifier();
  const challenge  = generateChallenge(verifier);
  const state      = crypto.randomBytes(8).toString('hex');
  const nonce      = crypto.randomBytes(8).toString('hex');

  page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('NAV→ ' + f.url().slice(0, 100)); });

  // Build authorize URL — PKCE code flow, redirect_uri = app origin
  const authorizeUrl = 'https://auth.smg.com/connect/authorize?' + [
    'response_type=code',
    'client_id=smg360',
    'scope=' + encodeURIComponent('feedback openid email smg360 offline_access'),
    'redirect_uri=' + encodeURIComponent('https://360.smg.com'),
    'code_challenge=' + challenge,
    'code_challenge_method=S256',
    'state=' + state,
    'nonce=' + nonce,
  ].join('&');

  console.log('Navigating to auth.smg.com (PKCE code flow)...');
  await page.goto(authorizeUrl, { waitUntil: 'networkidle', timeout: 60000 });
  console.log('Auth page: ' + page.url().slice(0, 100));

  // Wait up to 30s for login form
  await page.locator('input[type="password"]').waitFor({ timeout: 30000 }).catch(() => {});
  const pwInput = await page.$('input[type="password"]');
  if (pwInput) {
    console.log('Login form — filling credentials');
    const userInput = await page.$('input[name="username"]') || await page.$('input[name="email"]')
                   || await page.$('input[type="email"]')   || await page.$('input[type="text"]');
    if (userInput) await userInput.fill(SMG_USER);
    await pwInput.fill(SMG_PASS);
    const btn = await page.$('button[type="submit"]') || await page.$('input[type="submit"]');
    if (btn) {
      await Promise.all([
        page.waitForURL(u => u.startsWith('https://360.smg.com'), { timeout: 30000 }).catch(() => {}),
        btn.click(),
      ]);
    }
  } else {
    const body = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).replace(/\s+/g,' ').slice(0, 200);
    console.log('No login form. Page: ' + body);
  }
  console.log('After auth: ' + page.url().slice(0, 100));

  // Wait for Angular app to process the redirect and set authorizationData cookie
  await page.waitForTimeout(5000);

  // Check authorizationData cookie
  const cookies2 = await context.cookies('https://360.smg.com');
  const authCookie2 = cookies2.find(c => c.name === 'authorizationData');
  if (authCookie2) {
    try {
      const data = JSON.parse(decodeURIComponent(authCookie2.value));
      const token = data.access_token || data.accessToken;
      if (token) { console.log('authorizationData cookie set after auth, token length=' + token.length); return token; }
    } catch(e) { console.log('Cookie parse error: ' + e.message); }
  }

  // All cookies for debugging
  const allCookies = await context.cookies();
  console.log('All cookie names: ' + allCookies.map(c => c.name).join(', ').slice(0, 300));

  // CDP fallback — intercept API requests to capture Bearer token
  console.log('Trying CDP intercept for Bearer token...');
  let capturedToken = null;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://360.smg.com/api/*', requestStage: 'Request' }] });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const auth = request.headers['Authorization'] || request.headers['authorization'];
    if (auth && auth.toLowerCase().startsWith('bearer ')) capturedToken = auth.replace(/^bearer\s+/i, '');
    await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });
  await page.goto('https://360.smg.com', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await cdp.send('Fetch.disable').catch(() => {});
  if (capturedToken) { console.log('Token from CDP, length=' + capturedToken.length); return capturedToken; }

  throw new Error('No access token after all attempts. Final URL: ' + page.url().slice(0,100));
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext();
    const page    = await context.newPage();

    const accessToken = await getAccessToken(context, page);
    await browser.close();

    // Download SMG export
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
      const req = https.request({ method: 'POST', hostname: '360.smg.com', port: 443, path: '/api/export/v2/commentreport',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'accept': 'application/xlsx', 'AccountId': ACCOUNT_ID, 'Authorization': 'Bearer ' + accessToken, 'SMG-LanguageIso': 'en-US', 'TimeZone': 'America/New_York', 'Origin': 'https://360.smg.com', 'Referer': 'https://360.smg.com/', 'X-Requested-With': 'XMLHttpRequest' }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => { const buf = Buffer.concat(chunks); console.log('Export HTTP ' + res.statusCode + ', ' + buf.length + ' bytes'); if (res.statusCode !== 200) return reject(new Error('Export HTTP ' + res.statusCode + ': ' + buf.toString('utf8').slice(0,200))); resolve(buf); });
      });
      req.on('error', reject); req.write(body); req.end();
    });
    if (xlsxBuf[0] !== 0x50 || xlsxBuf[1] !== 0x4b) throw new Error('Not xlsx: ' + xlsxBuf.toString('utf8').slice(0,200));

    // Upload to PAi
    const tmpFile = '/tmp/smg-' + TARGET_DATE + '.xlsx';
    fs.writeFileSync(tmpFile, xlsxBuf);
    console.log('Uploading to PAi...');
    const boundary = '----Boundary' + Date.now();
    const fileContent = fs.readFileSync(tmpFile);
    const formBody = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="date"\r\n\r\n' + TARGET_DATE + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="smg-' + TARGET_DATE + '.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'),
      fileContent, Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    const uploadResult = await new Promise((resolve, reject) => {
      const parsed = new URL(PAI_URL + '/api/intel/upload/smg');
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({ method: 'POST', hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname, headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': formBody.length, 'X-Automation-Token': AUTH_TOKEN } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
      req.on('error', reject); req.write(formBody); req.end();
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
