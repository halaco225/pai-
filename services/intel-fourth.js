'use strict';
/**
 * Fourth Analytics Playwright helper.
 * Downloads Labor and OT reports from analytics.na1.fourth.com (GoodData).
 *
 * Export: hover over "Labor %" column header to reveal .s-options-menu, then export.
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
    console.log(`[Fourth] Screenshot saved: ${file}`);
  } catch (_) {}
}

async function logPageState(page, label) {
  try {
    const url   = page.url();
    const title = await page.title().catch(() => '?');
    console.log(`[Fourth] ${label} — URL: ${url} | Title: ${title}`);
  } catch (_) {}
}

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();

    // ── Step 1: Try report URL — GoodData JS will redirect if not authenticated
    const reportUrl = REPORTS[reportKey];
    if (!reportUrl) throw new Error(`Unknown report key: ${reportKey}`);

    console.log(`[Fourth] Navigating to ${reportKey} report URL`);
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for GoodData JS to evaluate auth state and potentially redirect
    await page.waitForTimeout(5000);
    await logPageState(page, 'after-initial-nav');
    await screenshot(page, 'step1-initial');

    const urlAfterNav = page.url();

    // ── Step 2: Detect if we need to log in ─────────────────────────────────
    // Check URL AND check for presence of any login form fields
    const isNotOnReport = !urlAfterNav.includes('analytics.na1.fourth.com')
      || urlAfterNav.includes('account.html')
      || urlAfterNav.includes('/login')
      || urlAfterNav.includes('/sso')
      || urlAfterNav.includes('/auth');

    const hasLoginField = await page.$('input[type="email"], input[type="password"], input[name="username"], #username').then(el => !!el).catch(() => false);

    if (isNotOnReport || hasLoginField) {
      console.log(`[Fourth] Login required (isNotOnReport=${isNotOnReport}, hasLoginField=${hasLoginField})`);
      const user = process.env.FOURTH_USER || '';
      const pass = process.env.FOURTH_PASSWORD || '';
      if (!user || !pass) throw new Error('FOURTH_USER / FOURTH_PASSWORD env vars not set');

      // Navigate to login page explicitly if needed
      if (!hasLoginField) {
        await page.goto(`${FOURTH_URL}/account.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        await logPageState(page, 'after-account-nav');
      }

      await screenshot(page, 'step2-login-page');

      // Wait for email/username field
      const emailField = await page.waitForSelector(
        'input[type="email"], input[name="username"], #username, input[type="text"]',
        { timeout: 10000 }
      );
      await emailField.fill(user);
      console.log('[Fourth] Email filled');

      // Password may be on same screen or next screen
      let passField = await page.$('input[type="password"], input[name="password"], #password');
      if (!passField) {
        await page.click('button[type="submit"], button:has-text("Next"), button:has-text("Continue")');
        await page.waitForTimeout(2000);
        passField = await page.waitForSelector('input[type="password"], #password', { timeout: 8000 });
      }
      await passField.fill(pass);
      console.log('[Fourth] Password filled');

      await screenshot(page, 'step2-creds-filled');
      await page.click('button[type="submit"], .s-login-button, button:has-text("Log In"), button:has-text("Sign In")');
      await page.waitForTimeout(5000);
      await logPageState(page, 'after-login-submit');
      await screenshot(page, 'step2-post-login');

      // Navigate to report now that we're authenticated
      console.log('[Fourth] Navigating to report post-login');
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      await logPageState(page, 'after-report-nav-post-login');
    }

    await screenshot(page, 'step3-report-page');

    // ── Step 3: Wait for GoodData dashboard to render ────────────────────────
    console.log('[Fourth] Waiting for dashboard to render (up to 60s)...');
    await page.waitForSelector(
      '.s-dash-item, [class*="dashboardItem"], [class*="visualization"], table, .s-table',
      { timeout: 60000 }
    );
    console.log('[Fourth] Dashboard content visible');
    await page.waitForTimeout(3000); // let everything settle

    await screenshot(page, 'step4-dashboard-loaded');

    // ── Step 4: Hover over "Labor %" header to reveal 3-dot menu ─────────────
    console.log('[Fourth] Looking for Labor % header...');
    const laborHeader = await page.waitForSelector(
      'th:has-text("Labor %"), [role="columnheader"]:has-text("Labor %"), [class*="header"]:has-text("Labor %")',
      { timeout: 20000 }
    );
    await laborHeader.hover();
    await page.waitForTimeout(1000);
    await screenshot(page, 'step4-after-hover');
    console.log('[Fourth] Hovered Labor % — waiting for options menu');

    // ── Step 5: Click the 3-dot options menu ─────────────────────────────────
    const optionsBtn = await page.waitForSelector(
      '.s-options-menu, button[class*="optionsMenu"], [class*="s-options-menu"], button[aria-label*="option" i]',
      { state: 'visible', timeout: 8000 }
    );

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await optionsBtn.click();
    await page.waitForTimeout(500);

    try {
      await page.click(
        'text=Export, .s-options-menu-export, li:has-text("Export"), button:has-text("Export")',
        { timeout: 5000 }
      );
    } catch (_) {}

    try {
      await page.click('text=XLSX, text=Excel, text=Export to XLSX', { timeout: 3000 });
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
    if (!dlPath) throw new Error('Download path null');
    fs.copyFileSync(dlPath, outPath);
    console.log(`[Fourth] ${reportKey} downloaded to ${outPath}`);
    return { success: true, filePath: outPath };

  } catch (err) {
    let url = '?';
    try { url = browser && browser.contexts().length ? browser.contexts()[0].pages()[0]?.url() : '?'; } catch (_) {}
    const errMsg = `${err.message} [page_url=${url}]`;
    console.error(`[Fourth] ${reportKey} failed:`, errMsg);
    return { success: false, error: errMsg };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { downloadFourthReport };
