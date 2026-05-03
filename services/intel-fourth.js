'use strict';
/**
 * Fourth Analytics Playwright helper.
 * Downloads Labor and OT reports from analytics.na1.fourth.com (GoodData).
 *
 * Export: hover over "Labor %" column header to reveal .s-options-menu, then export.
 *
 * Auth strategy: always navigate to account.html first.
 * On Render, profile dirs are ephemeral so login is required every run.
 * GoodData redirects away from account.html if session is already valid.
 */
const { launchContext } = require('./browser-launch');
const fs   = require('fs');
const path = require('path');

const FOURTH_URL  = 'https://analytics.na1.fourth.com';
const PROFILE_DIR = process.env.FOURTH_PROFILE_DIR || '/tmp/fourth-profile';

const REPORTS = {
  LABOR: `${FOURTH_URL}/#s=/gdc/workspaces/q0t16mq5dgsreqiq8macw3ghv3k1iuqc|workspaceDashboardPage|/gdc/md/q0t16mq5dgsreqiq8macw3ghv3k1iuqc/obj/607717|8e923313686e`,
  OT:    `${FOURTH_URL}/#s=/gdc/workspaces/q0t16mq5dgsreqiq8macw3ghv3k1iuqc|workspaceDashboardPage|/gdc/md/q0t16mq5dgsreqiq8macw3ghv3k1iuqc/obj/607556|9103c1ea9b50`,
};

async function screenshot(page, label) {
  try {
    const dir = '/tmp/fourth-debug';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[Fourth] Screenshot: ${file}`);
  } catch (_) {}
}

async function logPageState(page, label) {
  try {
    const url   = page.url();
    const title = await page.title().catch(() => '?');
    console.log(`[Fourth] ${label} — URL: ${url} | Title: ${title}`);
  } catch (_) {}
}

/**
 * Logs all visible interactive elements — used to debug when selectors fail.
 */
async function logPageElements(page, label) {
  try {
    const elements = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
        const text       = (el.innerText || el.textContent || '').trim().slice(0, 60);
        const title      = el.getAttribute('title') || '';
        const ariaLabel  = el.getAttribute('aria-label') || '';
        const cls        = (el.className || '').toString().slice(0, 80);
        if (text || title || ariaLabel) out.push({ text, title, ariaLabel, cls });
      }
      return out.slice(0, 40);
    });
    console.log(`[Fourth] ${label} elements:`, JSON.stringify(elements));
  } catch (_) {}
}

/**
 * Login to GoodData via account.html.
 * Skips form fill if GoodData already redirected us to the app (valid session).
 */
async function loginToFourth(page) {
  const user = process.env.FOURTH_USER || '';
  const pass = process.env.FOURTH_PASSWORD || '';
  if (!user || !pass) throw new Error('FOURTH_USER / FOURTH_PASSWORD env vars not set');

  console.log('[Fourth] Navigating to account.html for auth...');
  await page.goto(`${FOURTH_URL}/account.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // GoodData SPA may redirect immediately if session is valid
  await page.waitForTimeout(4000);
  await logPageState(page, 'account-page');
  await screenshot(page, 'step1-account-page');

  const urlAfter = page.url();
  if (!urlAfter.includes('account.html')) {
    console.log(`[Fourth] Already authenticated — redirected to: ${urlAfter}`);
    return;
  }

  console.log('[Fourth] Login form present — filling credentials');

  // Email/username field
  const emailField = await page.waitForSelector(
    'input[type="email"], input[name="username"], #username, input[type="text"]',
    { timeout: 10000 }
  );
  await emailField.fill(user);
  console.log('[Fourth] Email filled');

  // Password — may be on same screen or next screen
  let passField = await page.$('input[type="password"], input[name="password"], #password');
  if (!passField) {
    // Click Next to advance to password screen
    await page.click('button[type="submit"], button:has-text("Next"), button:has-text("Continue")').catch(() => {});
    await page.waitForTimeout(2500);
    passField = await page.waitForSelector('input[type="password"], #password', { timeout: 8000 });
  }
  await passField.fill(pass);
  console.log('[Fourth] Password filled');
  await screenshot(page, 'step1-creds-filled');

  // Submit
  await page.click('button[type="submit"], .s-login-button, button:has-text("Log In"), button:has-text("Sign In")');

  // Wait for redirect off account.html
  try {
    await page.waitForURL(url => !url.includes('account.html'), { timeout: 30000 });
  } catch {
    await screenshot(page, 'step1-login-stuck');
    await logPageState(page, 'login-redirect-timeout');
    throw new Error(`[Fourth] Login did not redirect from account.html. Current: ${page.url()}`);
  }

  await logPageState(page, 'after-login');
  await screenshot(page, 'step1-after-login');
  console.log('[Fourth] Login successful');
}

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const reportUrl = REPORTS[reportKey];
  if (!reportUrl) throw new Error(`Unknown report key: ${reportKey}`);

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();

    // ── Step 1: Login ────────────────────────────────────────────────────────
    await loginToFourth(page);

    // ── Step 2: Navigate to report ───────────────────────────────────────────
    console.log(`[Fourth] Navigating to ${reportKey} report...`);
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await logPageState(page, 'after-report-nav');
    await screenshot(page, 'step2-report-nav');

    // GoodData SPA needs time to parse hash route and request data
    await page.waitForTimeout(5000);

    // Wait for network to settle (GoodData fetches dashboard data via XHR)
    try {
      await page.waitForLoadState('networkidle', { timeout: 25000 });
      console.log('[Fourth] Network idle');
    } catch (_) {
      console.log('[Fourth] networkidle timeout — continuing');
    }

    await logPageState(page, 'after-networkidle');
    await screenshot(page, 'step2-after-networkidle');

    // ── Step 3: Wait for dashboard content ──────────────────────────────────
    console.log('[Fourth] Waiting for dashboard to render (up to 90s)...');
    let dashRendered = false;
    try {
      await page.waitForSelector(
        [
          '.s-dash-item',
          '[class*="dashboardItem"]',
          '.gd-fluidlayout-item',
          '.visualization-container',
          '.gd-kpi-value',
          '.highcharts-container',
          '.s-table',
          'table',
        ].join(', '),
        { timeout: 90000 }
      );
      dashRendered = true;
      console.log('[Fourth] Dashboard content visible');
    } catch (err) {
      await logPageState(page, 'dashboard-timeout');
      await screenshot(page, 'step3-dashboard-timeout');
      await logPageElements(page, 'dashboard-timeout');
      throw new Error(`Dashboard did not render. ${err.message} [page_url=${page.url()}]`);
    }

    await page.waitForTimeout(2000);
    await screenshot(page, 'step3-dashboard-loaded');

    // ── Step 4: Hover over "Labor %" header to reveal 3-dot menu ─────────────
    console.log('[Fourth] Looking for Labor % header...');
    const HEADER_SELECTORS = [
      'th:has-text("Labor %")',
      '[role="columnheader"]:has-text("Labor %")',
      '[class*="header"]:has-text("Labor %")',
      '[class*="gd-column-header"]:has-text("Labor %")',
      '[class*="s-header-cell"]:has-text("Labor %")',
    ];

    let laborHeader = null;
    for (const sel of HEADER_SELECTORS) {
      try {
        laborHeader = await page.waitForSelector(sel, { timeout: 8000 });
        if (laborHeader) { console.log(`[Fourth] Found Labor % header via: ${sel}`); break; }
      } catch (_) {}
    }

    if (!laborHeader) {
      await logPageElements(page, 'no-labor-header');
      await screenshot(page, 'step4-no-labor-header');
      throw new Error(`Labor % column header not found. [page_url=${page.url()}]`);
    }

    await laborHeader.hover();
    await page.waitForTimeout(1200);
    await screenshot(page, 'step4-after-hover');
    console.log('[Fourth] Hovered Labor % — looking for options menu');

    // ── Step 5: Click 3-dot options menu ────────────────────────────────────
    const MENU_SELECTORS = [
      '.s-options-menu',
      'button[class*="optionsMenu"]',
      '[class*="s-options-menu"]',
      'button[aria-label*="option" i]',
      'button[title*="option" i]',
      '[class*="menu-icon"]:visible',
    ];

    let optionsBtn = null;
    for (const sel of MENU_SELECTORS) {
      try {
        optionsBtn = await page.waitForSelector(sel, { state: 'visible', timeout: 4000 });
        if (optionsBtn) { console.log(`[Fourth] Found options button via: ${sel}`); break; }
      } catch (_) {}
    }

    if (!optionsBtn) {
      await screenshot(page, 'step5-no-options-btn');
      await logPageElements(page, 'no-options-btn');
      throw new Error(`Options menu not found after hover. [page_url=${page.url()}]`);
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await optionsBtn.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'step5-menu-open');

    // Try Export menu item
    try {
      await page.click(
        '.s-options-menu-export, li:has-text("Export"), button:has-text("Export"), [role="menuitem"]:has-text("Export")',
        { timeout: 5000 }
      );
      console.log('[Fourth] Clicked Export');
    } catch (_) { console.log('[Fourth] No Export item — trying direct download'); }

    await page.waitForTimeout(400);

    // Try XLSX format picker if a submenu appeared
    try {
      await page.click(
        'li:has-text("XLSX"), button:has-text("XLSX"), li:has-text("Excel"), button:has-text("Excel"), [role="menuitem"]:has-text("XLSX")',
        { timeout: 3000 }
      );
      console.log('[Fourth] Clicked XLSX');
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
    if (!dlPath) throw new Error('Download path null after export');

    fs.copyFileSync(dlPath, outPath);
    console.log(`[Fourth] ${reportKey} downloaded → ${outPath}`);
    return { success: true, filePath: outPath };

  } catch (err) {
    let url = '?';
    try {
      const ctxs = browser.contexts();
      if (ctxs.length) url = ctxs[0].pages()[0]?.url() || '?';
    } catch (_) {}
    const errMsg = `${err.message} [page_url=${url}]`;
    console.error(`[Fourth] ${reportKey} FAILED:`, errMsg);
    return { success: false, error: errMsg };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { downloadFourthReport };
