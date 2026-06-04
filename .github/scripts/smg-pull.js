'use strict';
/**
 * smg-pull.js — GitHub Actions daily SMG comments pull.
 *
 * Auth strategy (in order):
 *   1. Check for existing authorizationData cookie on 360.smg.com → use it
 *   2. Log in to reporting.smg.com (sets .ASPXAUTH for .smg.com domain)
 *   3. Navigate to 360.smg.com → app silently authenticates via .ASPXAUTH
 *   4. Read authorizationData cookie that the app sets
 *   5. If auth.smg.com/connect/authorize URL is captured instead, log it for diagnosis
 */
const { chromium } = require('playwright');
const { getSmg360Auth } = require('./smg360-auth-helper');
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
  const endMs = new Date(targetDate + 'T05:00:00.000Z').getTime() + 86400000;
  const startMs = endMs - 30 * 86400000;
  return {
    startDate: new Date(startMs).toISOString(), endDate: new Date(endMs-1).toISOString(),
    benchmarkStartDate: new Date(startMs - 30*86400000).toISOString(),
    benchmarkEndDate:   new Date(startMs - 1).toISOString(), appliedByUser: false,
  };
}

const ACCOUNT_ID     = '5b6205b27485e95d90e0a366';
const REPORT_ID      = '5b621d617485e95d90e0a36f';
const CARD_ID        = '5b621d617485e95d90e0a370';
const FILTER_SOURCES = ['6684c1735040640c94fe34da','5b522bf87485e96d80b2dfaf','60ada0b4de7df021c003f620','65807135e6485f00fc5c9fb4'];
const ALL_SOURCES    = ['5b73cc62f820781a3c28152c','6684c1735040640c94fe34da','644a8e03de7dee17c04fe327','5b522bf87485e96d80b2dfaf','661d4b6df820780f14f6fcf1','65a0028a504064228089de85','60ada0b4de7df021c003f620','642dca8350406420fc9bb262','6983e2725040640e14f8ebcf','65807135e6485f00fc5c9fb4','5d42044ef8207820d81c1169','64ec730ce6485f17e494aa4d','61e7494350406421a4ea9608','5ed7b8d6f820782450e5d26f','5b522969f8207835f04a3106','5ad79fc0f82078451850a66b','63f39d717485e921f0f4a405','5f2ca93d7485e90bec6c7bda'];

async function loginToReportingPortal(page, context) {
  console.log('Logging in to reporting.smg.com...');
  // Navigate to the actual login form (MultiLanguage.aspx, not Index.aspx)
  await page.goto('https://reporting.smg.com/MultiLanguage.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Login page URL: ' + page.url().slice(0, 80));

  // Log the page structure for diagnosis
  const pageInfo = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
      name: i.name, id: i.id, type: i.type, placeholder: i.placeholder
    }));
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.action, method: f.method, inputs: f.querySelectorAll('input').length
    }));
    return { inputs, forms, url: window.location.href };
  });
  console.log('Page inputs: ' + JSON.stringify(pageInfo.inputs.filter(i => ['text','password','submit'].includes(i.type))));
  console.log('Forms: ' + JSON.stringify(pageInfo.forms));

  // Find the actual username/password fields (flexible matching)
  const formData = await page.evaluate(({ username, password }) => {
    // Find password field (unambiguous)
    const passField = document.querySelector('input[type="password"]');
    if (!passField) return { error: 'no password field found' };

    // Find username field — try multiple patterns
    const userField = document.querySelector('input[name*="txtUserName"], input[name="username"], input[type="text"][name*="user"], input[id*="txtUserName"]')
                   || document.querySelector('input[type="text"]');
    if (!userField) return { error: 'no username field found' };

    // Set values
    userField.value = username;
    passField.value = password;

    // Dispatch events
    [userField, passField].forEach(field => {
      ['focus', 'input', 'change', 'blur'].forEach(ev => {
        field.dispatchEvent(new Event(ev, { bubbles: true }));
      });
    });

    // Find and submit the form
    const form = passField.closest('form') || document.querySelector('form');
    const action = form ? form.action : 'no form';
    form.submit();
    return { userFieldName: userField.name, passFieldName: passField.name, formAction: action };
  }, { username: SMG_USER, password: SMG_PASS });
  console.log('Form submit result: ' + JSON.stringify(formData));

  // Wait briefly for navigation to settle
  await page.waitForTimeout(2000);
  const afterSubmitUrl = page.url();
  console.log('After submit URL: ' + afterSubmitUrl.slice(0, 80));

  // Check if .ASPXAUTH cookie was set — that's the real success signal
  const allCookies = await context.cookies('https://reporting.smg.com');
  const aspxAuth = allCookies.find(c => c.name === '.ASPXAUTH');
  console.log('.ASPXAUTH set: ' + (aspxAuth ? 'YES domain=' + aspxAuth.domain : 'NO'));
  console.log('All reporting cookies: ' + allCookies.map(c => c.name).join(', '));

  if (!aspxAuth) {
    // If no .ASPXAUTH, try submitting the form on MultiLanguage.aspx directly
    if (afterSubmitUrl.includes('MultiLanguage')) {
      console.log('On MultiLanguage.aspx without .ASPXAUTH — trying login form here...');
      const mlFormData = await page.evaluate(({ username, password }) => {
        const passField = document.querySelector('input[type="password"]');
        const userField = document.querySelector('input[type="text"]') || document.querySelector('input[name*="User"]');
        if (!passField || !userField) return { error: 'fields not found', html: document.body.innerHTML.slice(0, 500) };
        userField.value = username;
        passField.value = password;
        ['input','change','blur'].forEach(ev => {
          userField.dispatchEvent(new Event(ev, { bubbles: true }));
          passField.dispatchEvent(new Event(ev, { bubbles: true }));
        });
        const form = passField.closest('form');
        form.submit();
        return { userFieldName: userField.name, formAction: form.action };
      }, { username: SMG_USER, password: SMG_PASS });
      console.log('MultiLanguage form submit: ' + JSON.stringify(mlFormData));
      await page.waitForTimeout(3000);
      const mlCookies = await context.cookies('https://reporting.smg.com');
      const mlAuth = mlCookies.find(c => c.name === '.ASPXAUTH');
      if (!mlAuth) throw new Error('Login failed on MultiLanguage.aspx too. URL: ' + page.url());
      console.log('.ASPXAUTH set after MultiLanguage submit');
    } else {
      throw new Error('Login failed — no .ASPXAUTH cookie. URL: ' + afterSubmitUrl);
    }
  }
  console.log('reporting.smg.com login succeeded');
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext();
    const page    = await context.newPage();
    page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('NAV→ ' + f.url().slice(0, 100)); });

    // ── Step 1: Check for existing authorizationData cookie ───────────────────
    let authResult = await getSmg360Auth(page, context, { timeoutMs: 5000 });
    console.log('Initial auth check: mode=' + authResult.mode);

    // ── Step 2: If no cookie, log in to reporting.smg.com first ──────────────
    if (authResult.mode !== 'cookie') {
      await loginToReportingPortal(page, context);

      // ── Step 3: Navigate to 360.smg.com — app authenticates via .ASPXAUTH ──
      console.log('Navigating to 360.smg.com with reporting session...');
      authResult = await getSmg360Auth(page, context, { timeoutMs: 15000 });
      console.log('Auth result after reporting login: mode=' + authResult.mode);
    }

    // ── Step 4: Handle result ─────────────────────────────────────────────────
    let accessToken = null;

    if (authResult.mode === 'cookie') {
      accessToken = authResult.tokens.accessToken;
      console.log('Using authorizationData cookie, token length=' + accessToken.length);
    } else if (authResult.mode === 'authorize_url') {
      // Log the real authorize URL for diagnosis — do NOT hand-reconstruct it
      console.log('Real authorize URL captured: ' + authResult.authorizeUrl.slice(0, 200));
      console.log('Params: ' + JSON.stringify(authResult.params));
      throw new Error('Got real authorize URL but login form handling not yet implemented for this flow. See logs for the exact URL.');
    } else {
      throw new Error(authResult.message || 'Authentication failed — no token obtained');
    }

    await browser.close();

    // ── Step 5: Download SMG export ───────────────────────────────────────────
    console.log('Downloading SMG export...');
    const payload = {
      reportId: REPORT_ID, cardId: CARD_ID, sortBy: 1,
      sourceOffsets: ALL_SOURCES.map(s => ({ sourceId: s, offset: 0 })),
      showCommentTranslation: false, includeSubcategories: true, text: '', topics: [],
      filter: {
        sources: FILTER_SOURCES,
        dateFilter: { dateRange: buildDateRange(TARGET_DATE), dateType: 0, reportGenerated: null },
        hierarchy: {}, socialSites: [], attributeMeasures: [], openEnds: [],
        searchTerms: null, aggregationPeriod: null, ontologyGroups: [],
      },
      exportFileType: 1, baseFileName: 'Comments_ByComment', timeZone: 'America/New_York', separateComments: true,
    };
    const body = JSON.stringify(payload);
    const xlsxBuf = await new Promise((resolve, reject) => {
      const req = https.request({
        method: 'POST', hostname: '360.smg.com', port: 443,
        path: '/api/export/v2/commentreport',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'accept': 'application/xlsx', 'AccountId': ACCOUNT_ID,
          'Authorization': 'Bearer ' + accessToken,
          'SMG-LanguageIso': 'en-US', 'TimeZone': 'America/New_York',
          'Origin': 'https://360.smg.com', 'Referer': 'https://360.smg.com/',
          'X-Requested-With': 'XMLHttpRequest',
        },
      }, (res) => {
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

    if (xlsxBuf[0] !== 0x50 || xlsxBuf[1] !== 0x4b) {
      throw new Error('Response is not xlsx: ' + xlsxBuf.toString('utf8').slice(0, 200));
    }

    // ── Step 6: Upload to PAi ─────────────────────────────────────────────────
    const tmpFile = '/tmp/smg-' + TARGET_DATE + '.xlsx';
    fs.writeFileSync(tmpFile, xlsxBuf);
    console.log('Uploading to PAi (' + xlsxBuf.length + ' bytes)...');

    const boundary  = '----Boundary' + Date.now();
    const fileBytes = fs.readFileSync(tmpFile);
    const formBody  = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="date"\r\n\r\n' + TARGET_DATE + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="smg-' + TARGET_DATE + '.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'),
      fileBytes,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);

    const uploadResult = await new Promise((resolve, reject) => {
      const parsed = new URL(PAI_URL + '/api/intel/upload/smg');
      const lib    = parsed.protocol === 'https:' ? https : http;
      const req    = lib.request({
        method: 'POST', hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        headers: {
          'Content-Type':    'multipart/form-data; boundary=' + boundary,
          'Content-Length':  formBody.length,
          'X-Automation-Token': AUTH_TOKEN,
        },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.write(formBody);
      req.end();
    });

    console.log('Upload HTTP ' + uploadResult.status + ': ' + uploadResult.body);
    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      throw new Error('Upload failed HTTP ' + uploadResult.status);
    }
    console.log('SMG comments pull complete.');
    fs.unlinkSync(tmpFile);

  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
