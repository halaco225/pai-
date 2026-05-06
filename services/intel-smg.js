'use strict';
/**
 * SMG download helper — hybrid HTTP auth + Playwright SPA interaction.
 *
 * Auth flow:
 *   1. HTTP GET reporting.smg.com/index.aspx?referrerUri=<card_url>
 *      → extract __VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION
 *   2. HTTP POST with credentials → reporting.smg.com sets .ASPXAUTH cookie
 *      and redirects to 360.smg.com (the referrerUri)
 *   3. Inject reporting.smg.com cookies into Playwright context so the
 *      360.smg.com SPA's CORS requests to reporting.smg.com are authenticated
 *   4. Navigate Playwright to the 360.smg.com redirect URL — SPA loads with
 *      an authenticated session
 *   5. Find the export button, click, download Excel
 */
const { launchContext } = require('./browser-launch');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SMG_REPORT_URL = 'https://360.smg.com/#/card/5b621d617485e95d90e0a370?languageiso=en-US&view=comments&id=5b621d617485e95d90e0a370';
const PROFILE_DIR    = process.env.SMG_PROFILE_DIR || '/tmp/smg-profile';

// ── HTTP helpers ────────────────────────────────────────────────────────────

function httpRequest(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function extractHiddenField(html, name) {
  const re = new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
  const m = html.match(re) || html.match(re2);
  return m ? m[1] : '';
}

function parseCookies(setCookieHeader) {
  if (!setCookieHeader) return {};
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const out = {};
  for (const h of arr) {
    const [nameVal] = h.split(';');
    const eq = nameVal.indexOf('=');
    if (eq < 0) continue;
    const name = nameVal.slice(0, eq).trim();
    const val  = nameVal.slice(eq + 1).trim();
    if (name) out[name] = val;
  }
  return out;
}

function cookieStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── HTTP auth against reporting.smg.com ────────────────────────────────────

async function httpSmgLogin(user, pass) {
  const loginUrl = `https://reporting.smg.com/index.aspx?referrerUri=${encodeURIComponent(SMG_REPORT_URL)}`;

  // Step 1: GET login page to extract ASP.NET form tokens
  console.log('[SMG] HTTP GET login page...');
  const getResp = await httpRequest('GET', loginUrl);
  console.log(`[SMG] GET → ${getResp.status}`);
  if (getResp.status !== 200) throw new Error(`SMG login page unreachable: HTTP ${getResp.status}`);

  const html    = getResp.body;
  const cookies = parseCookies(getResp.headers['set-cookie']);

  const viewstate    = extractHiddenField(html, '__VIEWSTATE');
  const viewstateGen = extractHiddenField(html, '__VIEWSTATEGENERATOR');
  const eventVal     = extractHiddenField(html, '__EVENTVALIDATION');

  if (!viewstate) throw new Error('SMG: __VIEWSTATE not found — login page structure changed');
  console.log('[SMG] Got VIEWSTATE, posting credentials...');

  // Step 2: POST credentials (same URL — ASP.NET posts back to itself)
  const formBody = new URLSearchParams({
    '__LASTFOCUS':                          '',
    'ctl00_TheScriptManager_HiddenField':   '',
    '__EVENTTARGET':                        '',
    '__EVENTARGUMENT':                      '',
    '__VIEWSTATE':                          viewstate,
    '__VIEWSTATEGENERATOR':                 viewstateGen,
    '__EVENTVALIDATION':                    eventVal,
    'ctl00$cphMain$txtUserName':            user,
    'ctl00$cphMain$txtPassword':            pass,
  }).toString();

  const postResp = await httpRequest('POST', loginUrl, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      loginUrl,
      'Cookie':       cookieStr(cookies),
    },
    body: formBody,
  });

  const postCookies = parseCookies(postResp.headers['set-cookie']);
  const allCookies  = { ...cookies, ...postCookies };
  const location    = postResp.headers['location'] || '';

  console.log(`[SMG] POST → ${postResp.status}, Location: ${location}`);

  if (postResp.status === 302 && location) {
    return { success: true, cookies: allCookies, location };
  }

  // 200 with body = stayed on login page → wrong credentials or CSRF failure
  if (postResp.status === 200) {
    const errMatch = postResp.body.match(/class=["'][^"']*error[^"']*["'][^>]*>([^<]{1,200})/i);
    const errMsg   = errMatch ? errMatch[1].trim() : '(no error text found)';
    // Log first 500 chars of response so we can diagnose
    console.log('[SMG] Login POST 200 body snippet:', postResp.body.slice(0, 500));
    throw new Error(`SMG login failed (credentials rejected?): ${errMsg}`);
  }

  throw new Error(`SMG login POST returned HTTP ${postResp.status}`);
}

// Follow a chain of HTTP redirects (up to maxHops) and collect cookies
async function followRedirects(startUrl, startCookies, maxHops = 5) {
  let url     = startUrl;
  let cookies = { ...startCookies };
  for (let i = 0; i < maxHops; i++) {
    const resp   = await httpRequest('GET', url, { headers: { 'Cookie': cookieStr(cookies) } });
    const more   = parseCookies(resp.headers['set-cookie']);
    cookies      = { ...cookies, ...more };
    const loc    = resp.headers['location'];
    console.log(`[SMG] Redirect hop ${i + 1}: ${resp.status} → ${loc || '(done)'}`);
    if (resp.status < 300 || resp.status >= 400 || !loc) {
      return { finalUrl: url, cookies, status: resp.status };
    }
    url = loc.startsWith('http') ? loc : new URL(loc, url).href;
  }
  return { finalUrl: url, cookies };
}

// ── Screenshot helper ───────────────────────────────────────────────────────

async function screenshot(page, label, full = false) {
  try {
    const dir = '/tmp/smg-debug';
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${label}-${Date.now()}.png`), fullPage: full });
    console.log(`[SMG] Screenshot: ${label}`);
  } catch (_) {}
}

// ── Main download function ──────────────────────────────────────────────────

async function downloadSMGComments(targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  const user = process.env.SMG_USER     || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');

  // ── Phase 1: Authenticate via HTTP ────────────────────────────────────────
  let authResult;
  try {
    authResult = await httpSmgLogin(user, pass);
  } catch (err) {
    console.error('[SMG] HTTP auth failed:', err.message);
    return { success: false, error: err.message };
  }

  console.log(`[SMG] Auth OK, redirect: ${authResult.location}`);
  console.log(`[SMG] Cookies obtained: ${Object.keys(authResult.cookies).join(', ')}`);

  // Follow any intermediate redirects (MultiLanguage.aspx etc.) to get final 360.smg.com URL
  let spaUrl    = authResult.location;
  // Resolve relative Location headers against reporting.smg.com
  if (spaUrl && !spaUrl.startsWith('http')) {
    spaUrl = new URL(spaUrl, 'https://reporting.smg.com/').href;
    console.log(`[SMG] Resolved relative redirect → ${spaUrl}`);
  }
  let spaCookies = authResult.cookies;
  if (!spaUrl.includes('360.smg.com')) {
    console.log('[SMG] Following intermediate redirects...');
    const hops = await followRedirects(spaUrl, spaCookies);
    spaUrl    = hops.finalUrl;
    spaCookies = hops.cookies;
    console.log(`[SMG] Final URL after redirects: ${spaUrl}`);
  }

  // ── Phase 2: Load the 360.smg.com SPA with pre-loaded auth cookies ────────
  // Clear stale profile then inject cookies before the SPA loads
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    // Inject reporting.smg.com auth cookies so SPA's CORS calls succeed
    const cookiesToInject = Object.entries(spaCookies).map(([name, value]) => ({
      name, value,
      domain: 'reporting.smg.com',
      path:   '/',
      secure: true,
    }));
    if (cookiesToInject.length) {
      await browser.addCookies(cookiesToInject);
      console.log(`[SMG] Injected ${cookiesToInject.length} cookies into browser context`);
    }

    const page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (!window.chrome) window.chrome = { runtime: {} };
    });
    page.on('console', m => { if (m.type() === 'error') console.log('[SMG] JS:', m.text().slice(0, 150)); });

    // Intercept export-related requests for diagnosis
    const capturedReqs = [];
    page.on('request', req => {
      if (/export|download|excel|xlsx|csv|report/i.test(req.url())) {
        capturedReqs.push({ method: req.method(), url: req.url() });
      }
    });

    // Navigate to the 360.smg.com SPA URL (with auth token if present in redirect)
    const navUrl = spaUrl.includes('360.smg.com') ? spaUrl : SMG_REPORT_URL;
    console.log(`[SMG] Navigating SPA to: ${navUrl}`);
    await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      await page.waitForLoadState('networkidle', { timeout: 25000 });
    } catch (_) { console.log('[SMG] networkidle timeout — continuing'); }
    await page.waitForTimeout(8000);

    const pageUrl = page.url();
    console.log(`[SMG] SPA URL after load: ${pageUrl}`);
    await screenshot(page, 'step2-spa', true);

    // Dump diagnostics
    try {
      const info = await page.evaluate(() => ({
        title:   document.title,
        buttons: document.querySelectorAll('button').length,
        links:   document.querySelectorAll('a').length,
        inputs:  document.querySelectorAll('input').length,
        body100: document.body.innerHTML.slice(0, 800),
      }));
      console.log('[SMG] Page:', JSON.stringify({ title: info.title, buttons: info.buttons, links: info.links, inputs: info.inputs }));
      console.log('[SMG] Body snippet:', info.body100);
    } catch (_) {}

    // ── Phase 3: Find and click the export button ──────────────────────────
    const exportSelectors = [
      'button[aria-label*="Download" i]', 'button[aria-label*="Export" i]',
      '[aria-label*="Download" i]',        '[aria-label*="Export" i]',
      'button[title*="Download" i]',       'button[title*="Export" i]',
      '[title*="Download" i]',             '[title*="Export" i]',
      '[data-testid*="export" i]',         '[data-testid*="download" i]',
      'button:has-text("Download")',        'button:has-text("Export")',
      'button:has-text("CSV")',             'button:has-text("Excel")',
      'a:has-text("Export")',              'a:has-text("Download")',
      '[class*="download"]',               '[class*="export"]',
      '[class*="Download"]',               '[class*="Export"]',
      '[ng-click*="download" i]',          '[ng-click*="export" i]',
      'a[href*="export"]',                 'a[href*="download"]',
    ];

    let exportEl = null;

    // Direct selector search
    for (const sel of exportSelectors) {
      try {
        exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 1500 });
        if (exportEl) { console.log(`[SMG] Found export: ${sel}`); break; }
      } catch (_) {}
    }

    // Hover-to-reveal
    if (!exportEl) {
      for (const hSel of ['[class*="card-header"]','[class*="cardHeader"]','[class*="widget"]','h1','h2','h3','[class*="title"]']) {
        try {
          const el = await page.$(hSel);
          if (!el) continue;
          await el.hover();
          await page.waitForTimeout(1200);
          for (const sel of exportSelectors) {
            try {
              exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 1000 });
              if (exportEl) { console.log(`[SMG] Found export after hover on ${hSel}`); break; }
            } catch (_) {}
          }
          if (exportEl) break;
        } catch (_) {}
      }
    }

    // Kebab / "..." menu expansion
    if (!exportEl) {
      for (const mSel of [
        'button[aria-label*="more" i]', 'button[aria-label*="action" i]', 'button[aria-label*="menu" i]',
        '[class*="kebab"]', '[class*="ellipsis"]', '[class*="more-options"]', '[class*="dropdown-toggle"]',
        'button:has-text("...")', 'button:has-text("⋮")',
      ]) {
        try {
          const menu = await page.$(mSel);
          if (!menu) continue;
          await menu.click();
          await page.waitForTimeout(1500);
          for (const sel of exportSelectors) {
            try {
              exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 1000 });
              if (exportEl) { console.log(`[SMG] Found export in menu ${mSel}`); break; }
            } catch (_) {}
          }
          if (exportEl) break;
          await page.keyboard.press('Escape');
        } catch (_) {}
      }
    }

    // Broad DOM scan
    if (!exportEl) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          const cls  = (el.className || '').toString().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const txt  = (el.innerText || '').toLowerCase().trim();
          const ttl  = (el.getAttribute('title') || '').toLowerCase();
          if (cls.includes('download') || cls.includes('export') ||
              aria.includes('download') || aria.includes('export') ||
              ttl.includes('download') || ttl.includes('export') ||
              txt === 'download' || txt === 'export') {
            el.setAttribute('data-smg-export', 'true');
          }
        }
      });
      exportEl = await page.$('[data-smg-export="true"]');
      if (exportEl) console.log('[SMG] Found export via broad DOM scan');
    }

    if (!exportEl) {
      // Full element dump for diagnosis
      const els = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],a,[class*="btn"],[class*="icon"]'))
          .slice(0, 60)
          .map(e => ({ tag: e.tagName, text: (e.innerText||'').trim().slice(0,50), aria: e.getAttribute('aria-label')||'', title: e.getAttribute('title')||'', cls: (e.className||'').toString().slice(0,80) }))
      );
      console.log('[SMG] Element dump:', JSON.stringify(els));
      console.log('[SMG] Captured requests:', JSON.stringify(capturedReqs));
      await screenshot(page, 'step3-no-export', true);
      const diagSnippet = JSON.stringify(els.slice(0, 15)).slice(0, 500);
      throw new Error(`SMG: No export button found. pageUrl=${pageUrl} els=${diagSnippet} reqs=${JSON.stringify(capturedReqs).slice(0,200)}`);
    }

    // ── Phase 4: Click export and download ────────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await exportEl.click();
    console.log('[SMG] Clicked export button');
    await page.waitForTimeout(800);

    // Handle Excel format picker submenu if it appears
    try {
      await page.click(
        'li:has-text("Excel"), li:has-text("XLSX"), [role="menuitem"]:has-text("Excel"), [role="menuitem"]:has-text("XLSX")',
        { timeout: 4000 }
      );
      console.log('[SMG] Clicked Excel format option');
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
    if (!dlPath) throw new Error('SMG download path null');
    fs.copyFileSync(dlPath, outPath);
    console.log(`[SMG] Downloaded → ${outPath}`);
    return { success: true, filePath: outPath };

  } catch (err) {
    console.error('[SMG] FAILED:', err.message);
    return { success: false, error: err.message };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { downloadSMGComments };
