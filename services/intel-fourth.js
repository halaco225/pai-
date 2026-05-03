'use strict';
/**
 * Fourth Analytics Playwright helper.
 * Downloads Labor and OT reports from analytics.na1.fourth.com (GoodData).
 *
 * Key facts from production logs:
 * - Login redirects correctly: account.html → report URL ✓
 * - Page title loads: "Labor Overview - 03. Labor Optimization" ✓
 * - Dashboard container selectors (.s-dash-item, table, etc.) do NOT match GoodData's actual DOM
 * - Fix: skip container wait, go straight for the "Labor %" column header (what we need anyway)
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
    await page.screenshot({ path: path.join(dir, `${label}-${Date.now()}.png`), fullPage: false });
    console.log(`[Fourth] Screenshot: ${label}`);
  } catch (_) {}
}

async function logPageState(page, label) {
  try {
    const url   = page.url();
    const title = await page.title().catch(() => '?');
    console.log(`[Fourth] ${label} — URL: ${url} | Title: ${title}`);
  } catch (_) {}
}

/** Dumps visible DOM classes so we can identify GoodData's actual element structure */
async function logDomClasses(page, label) {
  try {
    const info = await page.evaluate(() => {
      // Top-level children of body
      const bodyChildren = Array.from(document.body.children)
        .map(el => ({ tag: el.tagName, cls: (el.className||'').toString().slice(0,80), id: el.id }));

      // All elements with 'gd' or 'visualization' or 'dash' or 'widget' in class
      const gdEls = Array.from(document.querySelectorAll('[class]'))
        .filter(el => {
          const c = (el.className||'').toString().toLowerCase();
          return c.includes('gd-') || c.includes('s-dash') || c.includes('visual')
              || c.includes('widget') || c.includes('kpi') || c.includes('highchart');
        })
        .slice(0, 30)
        .map(el => ({ tag: el.tagName, cls: (el.className||'').toString().slice(0,100) }));

      // Any visible text that contains "Labor"
      const laborEls = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && (el.textContent||'').includes('Labor'))
        .slice(0, 10)
        .map(el => ({ tag: el.tagName, cls: (el.className||'').toString().slice(0,60), text: el.textContent.trim().slice(0,40) }));

      return { bodyChildren, gdEls, laborEls };
    });
    console.log(`[Fourth] ${label} DOM:`, JSON.stringify(info, null, 2));
  } catch (e) {
    console.log(`[Fourth] logDomClasses failed: ${e.message}`);
  }
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

    // ── Step 1: Navigate to report URL — GoodData will redirect to login if needed
    console.log(`[Fourth] Navigating to ${reportKey} report URL`);
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await logPageState(page, 'after-initial-nav');
    await screenshot(page, 'step1-initial');

    // ── Step 2: Login if redirected to account.html ───────────────────────────
    const urlAfterNav = page.url();
    const isNotOnReport = !urlAfterNav.includes('analytics.na1.fourth.com')
      || urlAfterNav.includes('account.html')
      || urlAfterNav.includes('/login')
      || urlAfterNav.includes('/sso')
      || urlAfterNav.includes('/auth');
    const hasLoginField = await page.$('input[type="email"], input[type="password"], input[name="username"], #username')
      .then(el => !!el).catch(() => false);

    if (isNotOnReport || hasLoginField) {
      console.log(`[Fourth] Login required`);
      const user = process.env.FOURTH_USER || '';
      const pass = process.env.FOURTH_PASSWORD || '';
      if (!user || !pass) throw new Error('FOURTH_USER / FOURTH_PASSWORD env vars not set');

      if (!hasLoginField) {
        await page.goto(`${FOURTH_URL}/account.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
      }
      await screenshot(page, 'step2-login-page');

      const emailField = await page.waitForSelector(
        'input[type="email"], input[name="username"], #username, input[type="text"]',
        { timeout: 10000 }
      );
      await emailField.fill(user);

      let passField = await page.$('input[type="password"], input[name="password"], #password');
      if (!passField) {
        await page.click('button[type="submit"], button:has-text("Next"), button:has-text("Continue")').catch(() => {});
        await page.waitForTimeout(2000);
        passField = await page.waitForSelector('input[type="password"], #password', { timeout: 8000 });
      }
      await passField.fill(pass);
      await screenshot(page, 'step2-creds-filled');

      await page.click('button[type="submit"], .s-login-button, button:has-text("Log In"), button:has-text("Sign In")');
      await page.waitForTimeout(5000);
      await logPageState(page, 'after-login-submit');
      await screenshot(page, 'step2-post-login');

      console.log('[Fourth] Navigating to report post-login');
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      await logPageState(page, 'after-report-nav-post-login');
    }

    await screenshot(page, 'step3-report-page');

    // ── Step 3: Wait for GoodData to finish loading data (networkidle) ────────
    // The page title already loads quickly ("Labor Overview - ...").
    // We need to wait for GoodData to fetch the actual data via XHR.
    console.log('[Fourth] Waiting for network idle (GoodData data fetch)...');
    try {
      await page.waitForLoadState('networkidle', { timeout: 45000 });
      console.log('[Fourth] Network idle reached');
    } catch (_) {
      console.log('[Fourth] networkidle timeout — proceeding anyway');
    }
    await page.waitForTimeout(3000);
    await logPageState(page, 'after-networkidle');
    await screenshot(page, 'step3-after-networkidle');

    // ── Step 4: Find "Labor %" column header directly ─────────────────────────
    // We skip waiting for a dashboard container (GoodData uses unpredictable class names).
    // If the title says "Labor Overview", the header text must be in the DOM.
    console.log('[Fourth] Looking for Labor % column header (up to 60s)...');
    const LABOR_HEADER_SELECTORS = [
      'th:has-text("Labor %")',
      '[role="columnheader"]:has-text("Labor %")',
      '[class*="header"]:has-text("Labor %")',
      '[class*="gd-column-header"]:has-text("Labor %")',
      '[class*="s-header-cell"]:has-text("Labor %")',
      'span:has-text("Labor %")',
      'div:has-text("Labor %")',
    ];

    let laborHeader = null;
    for (const sel of LABOR_HEADER_SELECTORS) {
      try {
        laborHeader = await page.waitForSelector(sel, { timeout: 10000 });
        if (laborHeader) { console.log(`[Fourth] Found Labor % header via: ${sel}`); break; }
      } catch (_) {}
    }

    if (!laborHeader) {
      // Dump DOM so we can identify the actual element class names
      await logDomClasses(page, 'labor-header-not-found');
      await screenshot(page, 'step4-no-labor-header');
      throw new Error(`Labor % column header not found after networkidle. [page_url=${page.url()}]`);
    }

    await laborHeader.hover();
    await page.waitForTimeout(1200);
    await screenshot(page, 'step4-after-hover');
    console.log('[Fourth] Hovered Labor % — looking for options menu');

    // ── Step 5: Click 3-dot options menu ─────────────────────────────────────
    const MENU_SELECTORS = [
      '.s-options-menu',
      'button[class*="optionsMenu"]',
      '[class*="s-options-menu"]',
      'button[aria-label*="option" i]',
      'button[title*="option" i]',
      'button[aria-label*="more" i]',
    ];

    let optionsBtn = null;
    for (const sel of MENU_SELECTORS) {
      try {
        optionsBtn = await page.waitForSelector(sel, { state: 'visible', timeout: 4000 });
        if (optionsBtn) { console.log(`[Fourth] Options button via: ${sel}`); break; }
      } catch (_) {}
    }

    if (!optionsBtn) {
      await logDomClasses(page, 'no-options-btn');
      await screenshot(page, 'step5-no-options-btn');
      throw new Error(`Options menu not found after hover. [page_url=${page.url()}]`);
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await optionsBtn.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'step5-menu-open');

    try {
      await page.click(
        '.s-options-menu-export, li:has-text("Export"), button:has-text("Export"), [role="menuitem"]:has-text("Export")',
        { timeout: 5000 }
      );
      console.log('[Fourth] Clicked Export');
    } catch (_) {}

    await page.waitForTimeout(400);
    try {
      await page.click(
        'li:has-text("XLSX"), button:has-text("XLSX"), li:has-text("Excel"), [role="menuitem"]:has-text("XLSX")',
        { timeout: 3000 }
      );
      console.log('[Fourth] Clicked XLSX');
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
    if (!dlPath) throw new Error('Download path null');
    fs.copyFileSync(dlPath, outPath);
    console.log(`[Fourth] ${reportKey} downloaded → ${outPath}`);
    return { success: true, filePath: outPath };

  } catch (err) {
    let url = '?';
    try { url = browser.contexts()[0]?.pages()[0]?.url() || '?'; } catch (_) {}
    const errMsg = `${err.message} [page_url=${url}]`;
    console.error(`[Fourth] ${reportKey} FAILED:`, errMsg);
    return { success: false, error: errMsg };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { downloadFourthReport };
