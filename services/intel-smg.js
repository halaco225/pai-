'use strict';
/**
 * SMG comment export — pure HTTP approach.
 *
 * Auth flow (tried in order):
 *   1. SMG_REFRESH_TOKEN env var  → refresh_token grant (fastest)
 *   2. DB smg_auth table          → stored refresh_token (fast, survives redeploys)
 *   3. Playwright PKCE login      → automatic browser login, captures + stores token
 *
 * After Playwright login succeeds the refresh_token is written to DB so all
 * future runs use path 2 (no browser needed).
 *
 * Export flow (once access_token is obtained):
 *   POST to 360.smg.com/api/export/v2/commentreport with Bearer token
 *   → returns xlsx binary
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SMG_TOKEN_URL   = 'https://auth.smg.com/connect/token';
const SMG_EXPORT_URL  = 'https://360.smg.com/api/export/v2/commentreport';
const ACCOUNT_ID     = '5b6205b27485e95d90e0a366';
const REPORT_ID      = '5b621d617485e95d90e0a36f';
const CARD_ID        = '5b621d617485e95d90e0a370';

// Survey sources included in the filter (from captured network request)
const FILTER_SOURCES = [
  '6684c1735040640c94fe34da',
  '5b522bf87485e96d80b2dfaf',
  '60ada0b4de7df021c003f620',
  '65807135e6485f00fc5c9fb4',
];

// All source IDs for sourceOffsets (pagination reset)
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

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpRequest(method, url, { headers = {}, body, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        ...headers,
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        resolve({
          status:  res.statusCode,
          headers: res.headers,
          body:    binary ? buf : buf.toString('utf8'),
          buffer:  buf,
        });
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`SMG request timeout after 60s: ${method} ${url.slice(0, 80)}`));
    }, 60000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Auth path 1 & 2: refresh_token grant ────────────────────────────────────

async function exchangeRefreshToken(refreshToken) {
  const formBody = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     'smg360',
  }).toString();
  const resp = await httpRequest('POST', SMG_TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  if (resp.status !== 200) {
    console.warn(`[SMG] refresh_token exchange failed: HTTP ${resp.status} — ${resp.body.slice(0, 200)}`);
    return null;
  }
  const data = JSON.parse(resp.body);
  const accessToken = data.access_token || data.accessToken;
  if (!accessToken) {
    console.warn('[SMG] refresh_token exchange: no access_token in response');
    return null;
  }
  // Return both so caller can store updated refresh_token (rotation)
  return { accessToken, newRefreshToken: data.refresh_token || null };
}

// ── Auth path 3: Direct password grant to auth.smg.com ───────────────────────
// Bypasses reporting.smg.com SSO entirely — works as long as auth.smg.com
// accepts resource-owner password credentials for client_id=smg360.

async function getTokenViaPasswordGrant(user, pass) {
  console.log('[SMG] Trying direct password grant to auth.smg.com...');
  const formBody = new URLSearchParams({
    grant_type: 'password',
    username:   user,
    password:   pass,
    client_id:  'smg360',
    scope:      'openid profile email offline_access',
  }).toString();
  const resp = await httpRequest('POST', SMG_TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  if (resp.status !== 200) {
    console.error(`[SMG] Password grant FAILED: HTTP ${resp.status}`);
    console.error(`[SMG] Response body: ${resp.body.slice(0, 500)}`);
    console.error(`[SMG] client_id used: smg360, scope: openid profile email offline_access`);
    return null;
  }
  const data = JSON.parse(resp.body);
  const accessToken = data.access_token || data.accessToken;
  if (!accessToken) {
    console.warn('[SMG] Password grant: no access_token in response:', resp.body.slice(0, 200));
    return null;
  }
  console.log('[SMG] Password grant succeeded — got access_token + refresh_token');
  return { accessToken, refreshToken: data.refresh_token || null };
}

// ── Auth path 4: Playwright PKCE login → capture token from network ──────────

async function getTokenViaPlaywright(user, pass) {
  console.log('[SMG] No cached token — attempting Playwright login to 360.smg.com...');
  const { launchContext } = require('./browser-launch');
  const tmpDir = '/tmp/smg-pw-profile';
  fs.mkdirSync(tmpDir, { recursive: true });

  let context;
  try {
    let capturedTokenData = null;

    context = await launchContext(tmpDir, {});
    const page = await context.newPage();

    // Intercept auth.smg.com/connect/token response to capture tokens
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('auth.smg.com/connect/token') && response.status() === 200) {
          const data = await response.json();
          if (data.refresh_token) {
            console.log('[SMG] Playwright: captured token response from auth.smg.com');
            capturedTokenData = data;
          }
        }
      } catch (_) {}
    });

    // Navigate to 360.smg.com — redirects to auth.smg.com login
    console.log('[SMG] Playwright: navigating to 360.smg.com...');
    await page.goto('https://360.smg.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for login form (either on 360.smg.com or redirected to auth.smg.com)
    await page.waitForSelector('input[type="email"], input[type="text"]', { timeout: 30000 });

    // Fill email/username
    const emailField = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[type="text"]').first();
    await emailField.fill(user);
    console.log('[SMG] Playwright: filled username field');

    // Some login flows show password on the same page, others after clicking Next
    const passVisible = await page.locator('input[type="password"]').isVisible().catch(() => false);
    if (!passVisible) {
      // Click Next/Continue to reveal password field
      const nextBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign in")').first();
      await nextBtn.click();
      await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    }

    const passField = page.locator('input[type="password"]').first();
    await passField.fill(pass);
    console.log('[SMG] Playwright: filled password field');

    // Submit
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    console.log('[SMG] Playwright: submitted login form — waiting for redirect...');

    // Wait for redirect back to 360.smg.com and token capture
    await page.waitForURL(/360\.smg\.com/, { timeout: 30000 }).catch(() => {});

    // Give the SPA a moment to exchange the code for tokens
    await page.waitForTimeout(3000);

    if (!capturedTokenData) {
      // Try waiting a bit longer
      await page.waitForTimeout(5000);
    }

    if (!capturedTokenData) {
      const currentUrl = page.url();
      throw new Error(`SMG Playwright login: did not capture token. Current URL: ${currentUrl.slice(0, 100)}`);
    }

    console.log('[SMG] Playwright login succeeded — access_token and refresh_token captured');
    return {
      accessToken:  capturedTokenData.access_token || capturedTokenData.accessToken,
      refreshToken: capturedTokenData.refresh_token,
    };
  } finally {
    if (context) {
      try { await context.close(); } catch (_) {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Main auth: env → DB → Playwright ─────────────────────────────────────────

async function getAccessToken() {
  let db;
  try { db = require('./db'); } catch (_) { db = null; }

  // ── Path 1: SMG_REFRESH_TOKEN env var ──────────────────────────────────────
  const envRefreshToken = process.env.SMG_REFRESH_TOKEN || '';
  if (envRefreshToken) {
    console.log('[SMG] Trying access token via SMG_REFRESH_TOKEN env var...');
    const result = await exchangeRefreshToken(envRefreshToken);
    if (result) {
      console.log('[SMG] Got access token via env refresh_token');
      // Store new token if rotation occurred
      if (result.newRefreshToken && db) {
        await db.setSMGAuth(result.newRefreshToken).catch(() => {});
      }
      return result.accessToken;
    }
    // Env token failed — fall through to DB / Playwright
    console.warn('[SMG] Env SMG_REFRESH_TOKEN failed — trying DB / Playwright fallback');
  }

  // ── Path 2: DB stored refresh_token ───────────────────────────────────────
  if (db) {
    const stored = await db.getSMGAuth().catch(() => null);
    if (stored && stored.is_valid && stored.refresh_token) {
      console.log('[SMG] Trying access token via DB-stored refresh_token...');
      const result = await exchangeRefreshToken(stored.refresh_token);
      if (result) {
        console.log('[SMG] Got access token via DB refresh_token');
        // Update DB with rotated refresh_token if applicable
        if (result.newRefreshToken) {
          await db.setSMGAuth(result.newRefreshToken).catch(() => {});
        }
        return result.accessToken;
      }
      // DB token failed — mark invalid and fall through
      console.warn('[SMG] DB refresh_token failed — marking invalid, falling through to Playwright');
      await db.markSMGAuthInvalid().catch(() => {});
    }
  }

  // ── Path 3: Direct password grant to auth.smg.com ────────────────────────
  const user = process.env.SMG_USER     || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) {
    throw new Error(
      'SMG auth failed: no valid refresh_token (env or DB) and no SMG_USER/SMG_PASSWORD. ' +
      'Set SMG_REFRESH_TOKEN, or SMG_USER + SMG_PASSWORD in env vars.'
    );
  }

  const pwResult = await getTokenViaPasswordGrant(user, pass);
  if (pwResult) {
    if (db && pwResult.refreshToken) {
      await db.setSMGAuth(pwResult.refreshToken).catch(() => {});
      console.log('[SMG] Stored refresh_token from password grant — future runs will use pure HTTP');
    }
    return pwResult.accessToken;
  }

  // Password grant failed — surface the error instead of trying Playwright
  // (Playwright Chromium binary is not reliably available on Render starter plan)
  throw new Error(
    'SMG auth failed: OAuth2 password grant to auth.smg.com returned null. ' +
    'Check Render logs for "[SMG] Password grant failed" to see the HTTP response. ' +
    'Possible causes: wrong client_id, unsupported grant type, or credentials mismatch. ' +
    'Set SMG_REFRESH_TOKEN env var to bypass.'
  );
}

// ── Step 2: Build date range (30-day window ending at targetDate) ────────────

function buildDateRange(targetDate) {
  // targetDate is "YYYY-MM-DD" in local time; ET midnight = UTC 04:00 or 05:00
  // Use 05:00 UTC (EST offset) as a safe midnight boundary
  const endMs   = new Date(targetDate + 'T05:00:00.000Z').getTime() + 86400000; // end of targetDate ET
  const startMs = endMs - 30 * 86400000;
  const bmEndMs = startMs - 1;
  const bmStartMs = bmEndMs - 30 * 86400000 + 1;

  return {
    startDate:          new Date(startMs).toISOString(),
    endDate:            new Date(endMs - 1).toISOString(),
    benchmarkStartDate: new Date(bmStartMs).toISOString(),
    benchmarkEndDate:   new Date(bmEndMs).toISOString(),
    appliedByUser:      false,
  };
}

// ── Step 3: POST export request → xlsx binary ───────────────────────────────

async function exportComments(accessToken, targetDate) {
  const dateRange = buildDateRange(targetDate);
  console.log(`[SMG] Exporting comments for date range ${dateRange.startDate} → ${dateRange.endDate}`);

  const payload = {
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
      dateFilter: {
        dateRange,
        dateType:        0,
        reportGenerated: null,
      },
      hierarchy:           {},
      socialSites:         [],
      attributeMeasures:   [],
      openEnds:            [],
      searchTerms:         null,
      aggregationPeriod:   null,
      ontologyGroups:      [],
    },
    exportFileType:    1,
    baseFileName:      'Comments_ByComment',
    timeZone:          'America/New_York',
    separateComments:  true,
  };

  const body = JSON.stringify(payload);
  const resp = await httpRequest('POST', SMG_EXPORT_URL, {
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'AccountId':      ACCOUNT_ID,
      'Content-Type':   'application/json',
      'accept':         'application/xlsx',
      'SMG-LanguageIso': 'en-US',
      'TimeZone':       'America/New_York',
      'Origin':         'https://360.smg.com',
      'Referer':        'https://360.smg.com/',
    },
    body,
    binary: true,
  });

  console.log(`[SMG] Export response: HTTP ${resp.status}, size=${resp.buffer.length} bytes`);

  if (resp.status !== 200) {
    const msg = resp.buffer.toString('utf8').slice(0, 300);
    throw new Error(`SMG export failed: HTTP ${resp.status} — ${msg}`);
  }

  // Verify it looks like an xlsx (PK zip magic bytes)
  if (resp.buffer[0] !== 0x50 || resp.buffer[1] !== 0x4b) {
    const preview = resp.buffer.toString('utf8').slice(0, 200);
    throw new Error(`SMG export returned non-xlsx data: ${preview}`);
  }

  return resp.buffer;
}

// ── Main export function ────────────────────────────────────────────────────

async function downloadSMGComments(targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  try {
    const accessToken = await getAccessToken();
    const xlsxBuffer  = await exportComments(accessToken, targetDate);
    fs.writeFileSync(outPath, xlsxBuffer);
    console.log(`[SMG] Saved → ${outPath} (${xlsxBuffer.length} bytes)`);
    return { success: true, filePath: outPath };
  } catch (err) {
    console.error('[SMG] FAILED:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { downloadSMGComments };
