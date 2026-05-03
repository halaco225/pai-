'use strict';
/**
 * Fourth Analytics Playwright helper.
 * Downloads Labor and OT reports from analytics.na1.fourth.com (GoodData).
 *
 * Export flow: the 3-dot options menu only appears when hovering over the
 * "Labor %" column header — then click ".s-options-menu" → export option.
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

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();

    // ── Navigate directly to report — GoodData redirects to login if needed ──
    const reportUrl = REPORTS[reportKey];
    if (!reportUrl) throw new Error(`Unknown report key: ${reportKey}`);

    console.log(`[Fourth] Navigating to ${reportKey} report`);
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // let JS redirect settle

    const urlAfterNav = page.url();
    console.log(`[Fourth] URL after initial nav: ${urlAfterNav}`);

    // ── Login if redirected to account/login/sso page ──────────────────────
    const needsLogin = urlAfterNav.includes('account.html')
      || urlAfterNav.includes('/login')
      || urlAfterNav.includes('/sso')
      || urlAfterNav.includes('/auth')
      || !urlAfterNav.includes('fourth.com');

    if (needsLogin) {
      console.log('[Fourth] Login required');
      const user = process.env.FOURTH_USER || '';
      const pass = process.env.FOURTH_PASSWORD || '';
      if (!user || !pass) throw new Error('FOURTH_USER / FOURTH_PASSWORD env vars not set');

      // GoodData login form is JS-rendered — wait for it
      const emailField = await page.waitForSelector(
        'input[type="email"], input[name="username"], #username',
        { timeout: 10000 }
      );
      await emailField.fill(user);

      // Some GoodData SSO flows show password on same screen, some on next
      let passField = await page.$('input[type="password"], input[name="password"], #password');
      if (!passField) {
        // Click Next first
        await page.click('button[type="submit"], button:has-text("Next"), button:has-text("Continue")');
        await page.waitForTimeout(2000);
        passField = await page.waitForSelector('input[type="password"], #password', { timeout: 8000 });
      }
      await passField.fill(pass);
      await page.click('button[type="submit"], .s-login-button, button:has-text("Log In"), button:has-text("Sign In")');
      await page.waitForTimeout(3000);

      console.log(`[Fourth] Post-login URL: ${page.url()}`);
      // Navigate to report now that we're logged in
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
    }

    await screenshot(page, 'report-loaded');

    // ── Wait for GoodData dashboard to fully render ─────────────────────────
    console.log('[Fourth] Waiting for dashboard content...');
    await page.waitForSelector(
      '.s-dash-item, [class*="dashboardItem"], [class*="visualization"], table',
      { timeout: 30000 }
    );
    await page.waitForTimeout(3000);

    // ── Hover over "Labor %" column header to reveal the 3-dot menu ─────────
    // The .s-options-menu only appears on hover — must trigger it
    console.log('[Fourth] Locating Labor % header to trigger options menu...');
    const laborHeader = await page.waitForSelector(
      'th:has-text("Labor %"), [role="columnheader"]:has-text("Labor %"), [class*="header"]:has-text("Labor %"), td:has-text("Labor %")',
      { timeout: 20000 }
    );
    await laborHeader.hover();
    await page.waitForTimeout(1000);
    await screenshot(page, 'after-hover');

    // ── Click the 3-dot options menu ────────────────────────────────────────
    const optionsBtn = await page.waitForSelector(
      '.s-options-menu, button[class*="optionsMenu"], [class*="s-options"], [aria-label*="option" i], button[title*="option" i]',
      { state: 'visible', timeout: 8000 }
    );
    console.log('[Fourth] Options menu found — clicking');

    // Start waiting for download before click chain
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await optionsBtn.click();
    await page.waitForTimeout(500);

    // Click the Export item in the dropdown
    try {
      await page.click(
        'text=Export, .s-options-menu-export, [class*="export"], button:has-text("Export to"), li:has-text("Export")',
        { timeout: 5000 }
      );
    } catch (_) {
      console.log('[Fourth] No secondary export click needed (may be direct download)');
    }

    // Try XLSX if prompted
    try {
      await page.click('text=XLSX, text=Excel, text=Export to XLSX', { timeout: 3000 });
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
    if (!dlPath) throw new Error('Download path null — download failed');
    fs.copyFileSync(dlPath, outPath);
    console.log(`[Fourth] ${reportKey} downloaded to ${outPath}`);
    return { success: true, filePath: outPath };

  } catch (err) {
    console.error(`[Fourth] ${reportKey} failed:`, err.message);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { downloadFourthReport };
