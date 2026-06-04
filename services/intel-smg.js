'use strict';
/**
 * SMG comment export — pure HTTP, OAuth2 implicit flow.
 *
 * Auth flow:
 *   1. GET reporting.smg.com/Index.aspx → scrape hidden fields
 *   2. POST credentials → receive .ASPXAUTH cookie (Domain=.smg.com)
 *   3. OAuth2 implicit flow: GET auth.smg.com/connect/authorize (sends .ASPXAUTH)
 *      → redirects through reporting.smg.com back to 360.smg.com#access_token=xxx
 *   4. Parse Bearer token from final redirect URL fragment
 *   5. POST 360.smg.com/api/export/v2/commentreport with Authorization: Bearer <token>
 */
const https = require('https');
const http  = require('http');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const LOGIN_URL   = 'https://reporting.smg.com/Index.aspx';
const BASE_360    = 'https://360.smg.com';
const EXPORT_URL  = `${BASE_360}/api/export/v2/commentreport`;
const ACCOUNT_ID  = '5b6205b27485e95d90e0a366';
const REPORT_ID   = '5b621d617485e95d90e0a36f';
const CARD_ID     = '5b621d617485e95d90e0a370';

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

// ── HTTP / cookie helpers ─────────────────────────────────────────────────────

function makeCookieJar() {
  const store = new Map();
  return {
    set(domain, cookieHeader) {
      if (!cookieHeader) return;
      const headers = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
      for (const h of headers) {
        const parts = h.split(';');
        const pair  = parts[0].trim();
        const eq    = pair.indexOf('=');
        if (eq < 1) continue;
        const name  = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        // Honour Domain attribute so .smg.com cookies reach all subdomains
        let cookieDomain = domain;
        for (const p of parts.slice(1)) {
          const t = p.trim();
          if (/^domain=/i.test(t)) { cookieDomain = t.slice(7).trim().toLowerCase(); break; }
        }
        if (!store.has(cookieDomain)) store.set(cookieDomain, new Map());
        store.get(cookieDomain).set(name, value);
      }
    },
    get(domain) {
      const result = new Map();
      // Walk parent domains: reporting.smg.com → .smg.com → .com
      const parts = domain.split('.');
      for (let i = 1; i < parts.length; i++) {
        const jar = store.get('.' + parts.slice(i).join('.'));
        if (jar) for (const [k, v] of jar) result.set(k, v);
      }
      const jar = store.get(domain);
      if (jar) for (const [k, v] of jar) result.set(k, v);
      return [...result.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    dump() {
      const out = {};
      for (const [d, m] of store) out[d] = Object.fromEntries(m);
      return out;
    },
  };
}

function httpReq(jar, method, reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(reqUrl);
    const domain  = parsed.hostname;
    const cookies = jar ? jar.get(domain) : '';
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookies ? { Cookie: cookies } : {}),
      ...opts.headers,
    };

    const body = opts.body || null;
    if (body) {
      headers['Content-Type']   = headers['Content-Type'] || 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const reqOpts = {
      method,
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers,
    };

    const req = lib.request(reqOpts, (res) => {
      const setCookies = res.headers['set-cookie'];
      if (setCookies && jar) jar.set(domain, setCookies);

      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new url.URL(res.headers.location, reqUrl).href;
        res.resume();
        return resolve(httpReq(jar, 'GET', next, opts.followRedirectOpts || {}));
      }

      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        resolve({
          status:  res.statusCode,
          headers: res.headers,
          body:    opts.binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    const timer = setTimeout(() => req.destroy(new Error('SMG request timeout 60s')), 60000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    if (body) req.write(body);
    req.end();
  });
}

// Single-step HTTP request — does NOT follow redirects, stores cookies, returns status + location + body
function httpReqStep(jar, method, reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(reqUrl);
    const domain  = parsed.hostname;
    const cookies = jar ? jar.get(domain) : '';
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookies ? { Cookie: cookies } : {}),
      ...opts.headers,
    };

    const body = opts.body || null;
    if (body) {
      headers['Content-Type']   = opts.headers?.['Content-Type'] || 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const reqOpts = {
      method,
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers,
    };

    const req = lib.request(reqOpts, (res) => {
      const setCookies = res.headers['set-cookie'];
      if (setCookies && jar) jar.set(domain, setCookies);
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({
        status:   res.statusCode,
        location: res.headers.location || null,
        body:     Buffer.concat(chunks).toString('utf8'),
      }));
    });

    const timer = setTimeout(() => req.destroy(new Error('SMG auth timeout 30s')), 30000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    if (body) req.write(body);
    req.end();
  });
}

function extractTokenFromUrl(loc) {
  const fragment = loc.includes('#') ? loc.split('#')[1] : '';
  const query    = loc.includes('?') ? loc.split('?')[1].split('#')[0] : '';
  for (const part of [fragment, query]) {
    if (!part || !part.includes('access_token=')) continue;
    const params = {};
    for (const p of part.split('&')) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq)] = decodeURIComponent(p.slice(eq + 1));
    }
    if (params.access_token) return params.access_token;
  }
  return null;
}

// ── Auth: try ROPC grant first, fall back to Playwright ──────────────────────

// OAuth2 Resource Owner Password Credentials grant — plain HTTP POST, no browser.
// Many IdentityServer installs support this. Returns token string or null.
async function getBearerViaROPC(user, pass) {
  const TOKEN_URL = 'https://auth.smg.com/connect/token';
  const body = [
    'grant_type=password',
    `client_id=smg360`,
    `scope=${encodeURIComponent('feedback openid email smg360 offline_access')}`,
    `username=${encodeURIComponent(user)}`,
    `password=${encodeURIComponent(pass)}`,
  ].join('&');

  return new Promise((resolve) => {
    const parsed  = new url.URL(TOKEN_URL);
    const options = {
      method:   'POST',
      hostname: parsed.hostname,
      port:     443,
      path:     parsed.pathname,
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Mozilla/5.0',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`[SMG] ROPC response HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.access_token || null);
          } catch (_) { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.warn('[SMG] ROPC request error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function getBearerWithPlaywright(user, pass) {
  // Use chromium.launch() (not launchPersistentContext) — no profile dir needed
  // for a one-shot OAuth flow. Resolve the executable path explicitly across all
  // candidate locations so we don't rely on Playwright's registry (which fails
  // when PLAYWRIGHT_BROWSERS_PATH points to a dir without the binary).
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/render/project/src/playwright-browsers';
  const { chromium } = require('playwright');
  const _fs   = require('fs');
  const _path = require('path');

  function findExecutable() {
    const bases = [
      '/opt/render/project/src/playwright-browsers',
      '/opt/render/project/src/node_modules/.playwright-browsers',
      '/tmp/ms-playwright',
      process.env.HOME ? _path.join(process.env.HOME, '.cache', 'ms-playwright') : null,
    ].filter(Boolean);
    const subDirs  = ['chrome-headless-shell-linux64', 'chrome-linux64', 'chrome-linux', ''];
    const binaries = ['chrome-headless-shell', 'chromium_headless_shell', 'chrome', 'chromium'];
    for (const base of bases) {
      let entries; try { entries = _fs.readdirSync(base); } catch (_) { continue; }
      for (const entry of entries.filter(e => e.startsWith('chromium'))) {
        const dir = _path.join(base, entry);
        for (const sub of subDirs) {
          const searchDir = sub ? _path.join(dir, sub) : dir;
          for (const bin of binaries) {
            const candidate = _path.join(searchDir, bin);
            if (_fs.existsSync(candidate)) return candidate;
          }
        }
      }
    }
    return null;
  }

  let executablePath = findExecutable();
  console.log(`[SMG] Playwright: executable=${executablePath || 'not found — will install'}`);

  // Install browser if not found — runs inline so we can see success/failure in logs
  if (!executablePath) {
    console.log('[SMG] Installing Playwright chromium-headless-shell...');
    try {
      const { spawnSync } = require('child_process');
      const playwrightCli = _path.join(process.cwd(), 'node_modules', 'playwright', 'cli.js');
      const result = spawnSync(
        process.execPath,
        [playwrightCli, 'install', 'chromium-headless-shell'],
        {
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/opt/render/project/src/playwright-browsers' },
          timeout: 120000,
          encoding: 'utf8',
        }
      );
      console.log('[SMG] Playwright install stdout:', (result.stdout || '').slice(-500));
      if (result.stderr) console.log('[SMG] Playwright install stderr:', result.stderr.slice(-500));
      console.log('[SMG] Playwright install exit code:', result.status);
      executablePath = findExecutable();
      console.log('[SMG] Executable after install:', executablePath || 'STILL NOT FOUND');
    } catch (installErr) {
      console.error('[SMG] Playwright install threw:', installErr.message);
    }
  }

  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-http2', '--ignore-certificate-errors',
      '--single-process', '--disable-extensions', '--no-first-run',
      '--disable-background-networking', '--mute-audio', '--window-size=1280,800',
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ],
  };
  if (executablePath) launchOpts.executablePath = executablePath;

  let browser;
  try {
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext();
    const page = await context.newPage();

    let bearerToken = null;

    // Capture token from URL fragment whenever the page navigates to 360.smg.com
    page.on('framenavigated', (frame) => {
      try {
        const frameUrl = frame.url();
        if (frameUrl.includes('360.smg.com') && frameUrl.includes('access_token')) {
          const token = extractTokenFromUrl(frameUrl);
          if (token) bearerToken = token;
        }
      } catch (_) {}
    });

    const nonce = Math.random().toString(36).slice(2);
    const state = Math.random().toString(36).slice(2);
    const authorizeUrl = 'https://auth.smg.com/connect/authorize?' + [
      'response_type=token%20id_token',
      'client_id=smg360',
      `scope=${encodeURIComponent('feedback openid email smg360 offline_access')}`,
      `redirect_uri=${encodeURIComponent('https://360.smg.com/auth-callback')}`,
      `nonce=${nonce}`,
      `state=${state}`,
    ].join('&');

    console.log('[SMG] Playwright: navigating to auth.smg.com/connect/authorize');
    await page.goto(authorizeUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // If already authenticated, the framenavigated handler may have caught the token
    if (bearerToken) {
      console.log('[SMG] Playwright: Bearer token obtained (existing session)');
      return bearerToken;
    }

    // Fill login form if present
    const passwordInput = await page.$('input[type="password"]');
    if (passwordInput) {
      console.log('[SMG] Playwright: login form found — filling credentials');
      const userInput = await page.$('input[name="username"]')
                     || await page.$('input[name="email"]')
                     || await page.$('input[type="email"]');
      if (userInput) await userInput.fill(user);
      await passwordInput.fill(pass);

      const submitBtn = await page.$('button[type="submit"]')
                     || await page.$('input[type="submit"]');
      if (submitBtn) {
        await Promise.all([
          page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
          submitBtn.click(),
        ]);
      }
    } else {
      console.warn('[SMG] Playwright: no login form found on auth.smg.com — may be a consent page');
    }

    // Read token from current URL fragment if not yet captured by event
    if (!bearerToken) {
      bearerToken = await page.evaluate(() => {
        const hash = (window.location.hash || '').replace(/^#/, '');
        const params = {};
        hash.split('&').forEach(p => {
          const eq = p.indexOf('=');
          if (eq > 0) params[decodeURIComponent(p.slice(0, eq))] = decodeURIComponent(p.slice(eq + 1));
        });
        return params.access_token || null;
      }).catch(() => null);
    }

    const finalUrl = page.url();
    if (bearerToken) {
      console.log('[SMG] Playwright: Bearer token obtained');
    } else {
      console.warn(`[SMG] Playwright: no token found. Final URL: ${finalUrl.slice(0, 120)}`);
      throw new Error(`Playwright OAuth completed but no access_token found. Final URL: ${finalUrl.slice(0, 120)}`);
    }

    return bearerToken;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Build date range (30-day window ending at targetDate) ─────────────────────

function buildDateRange(targetDate) {
  const endMs   = new Date(targetDate + 'T05:00:00.000Z').getTime() + 86400000;
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

// ── Export comments ───────────────────────────────────────────────────────────

async function exportComments(jar, bearer, targetDate) {
  const dateRange = buildDateRange(targetDate);
  console.log(`[SMG] Exporting comments ${dateRange.startDate} → ${dateRange.endDate}`);

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
      hierarchy:         {},
      socialSites:       [],
      attributeMeasures: [],
      openEnds:          [],
      searchTerms:       null,
      aggregationPeriod: null,
      ontologyGroups:    [],
    },
    exportFileType:   1,
    baseFileName:     'Comments_ByComment',
    timeZone:         'America/New_York',
    separateComments: true,
  };

  const body = JSON.stringify(payload);
  console.log(`[SMG] Export POST — bearer=${bearer ? 'yes' : 'no (cookie-only)'}`);
  const resp = await httpReq(jar, 'POST', EXPORT_URL, {
    body,
    binary: true,
    headers: {
      'AccountId':        ACCOUNT_ID,
      'Content-Type':     'application/json',
      'accept':           'application/xlsx',
      'SMG-LanguageIso':  'en-US',
      'TimeZone':         'America/New_York',
      'Origin':           BASE_360,
      'Referer':          `${BASE_360}/`,
      'X-Requested-With': 'XMLHttpRequest',
      ...(bearer ? { 'Authorization': `Bearer ${bearer}` } : {}),
    },
  });

  console.log(`[SMG] Export HTTP ${resp.status}, ${resp.body?.length ?? 0} bytes`);

  if (resp.status !== 200) {
    const preview = Buffer.isBuffer(resp.body) ? resp.body.toString('utf8').slice(0, 300) : String(resp.body).slice(0, 300);
    throw new Error(`SMG export failed: HTTP ${resp.status} — ${preview}`);
  }

  const buf = Buffer.isBuffer(resp.body) ? resp.body : Buffer.from(resp.body);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`SMG export returned non-xlsx data: ${buf.toString('utf8').slice(0, 200)}`);
  }

  return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function downloadSMGComments(targetDate) {
  const user = process.env.SMG_USER     || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) {
    return { success: false, error: 'SMG_USER / SMG_PASSWORD env vars not set' };
  }

  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  // Try ROPC grant first (plain HTTP, no browser required)
  let bearer = await getBearerViaROPC(user, pass);
  if (bearer) {
    console.log('[SMG] Bearer token obtained via ROPC grant');
  } else {
    // Fall back to Playwright (requires Chromium binary on Render)
    console.log('[SMG] ROPC failed or unsupported — trying Playwright OAuth2');
    try {
      bearer = await getBearerWithPlaywright(user, pass);
    } catch (err) {
      console.error('[SMG] Playwright auth failed:', err.message);
      return { success: false, error: `Login: ${err.message}` };
    }
  }

  if (!bearer) {
    return { success: false, error: 'Login: all auth methods failed (ROPC + Playwright)' };
  }

  const jar = makeCookieJar(); // empty — Bearer token handles auth
  let xlsxBuffer;
  try {
    xlsxBuffer = await exportComments(jar, bearer, targetDate);
  } catch (err) {
    console.error('[SMG] Export failed:', err.message);
    return { success: false, error: `Export: ${err.message}` };
  }

  fs.writeFileSync(outPath, xlsxBuffer);
  console.log(`[SMG] Saved → ${outPath} (${xlsxBuffer.length} bytes)`);
  return { success: true, filePath: outPath };
}

module.exports = { downloadSMGComments };
