'use strict';
/**
 * Fourth Analytics Playwright helper.
 * Downloads Labor and OT reports from analytics.na1.fourth.com
 * GoodData dashboards load async — we wait for export button, not just navigation.
 */
const { launchContext } = require('./browser-launch');
const fs   = require('fs');
const path = require('path');

const FOURTH_URL = 'https://analytics.na1.fourth.com';
const PROFILE_DIR = process.env.FOURTH_PROFILE_DIR || '/tmp/fourth-profile';

const REPORTS = {
  LABOR: `${FOURTH_URL}/#s=/gdc/workspaces/q0t16mq5dgsreqiq8macw3ghv3k1iuqc|workspaceDashboardPage|/gdc/md/q0t16mq5dgsreqiq8macw3ghv3k1iuqc/obj/607717|8e923313686e`,
  OT:    `${FOURTH_URL}/#s=/gdc/workspaces/q0t16mq5dgsreqiq8macw3ghv3k1iuqc|workspaceDashboardPage|/gdc/md/q0t16mq5dgsreqiq8macw3ghv3k1iuqc/obj/607556|9103c1ea9b50`,
};

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();

    // Navigate to login page first
    await page.goto(`${FOURTH_URL}/account.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check if we need to log in
    const needsLogin = await page.$('input[name="username"], #username, [data-testid="login"]');
    if (needsLogin) {
      const user = process.env.FOURTH_USER || '';
      const pass = process.env.FOURTH_PASSWORD || '';
      if (!user || !pass) throw new Error('FOURTH_USER / FOURTH_PASSWORD env vars not set');
      await page.fill('input[type="email"], input[name="username"], #username', user);
      await page.fill('input[type="password"], input[name="password"], #password', pass);
      await page.click('button[type="submit"], .s-login-button, button:has-text("Log In")');
      await page.waitForURL(/dashboard|workspaces/, { timeout: 30000 });
      console.log('[Fourth] Login completed');
    }

    // Navigate to report
    const reportUrl = REPORTS[reportKey];
    if (!reportUrl) throw new Error(`Unknown report key: ${reportKey}`);
    console.log(`[Fourth] Navigating to ${reportKey} report`);
    await page.goto(reportUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // GoodData renders async — wait for export button to appear
    console.log('[Fourth] Waiting for dashboard to load...');
    const exportButton = await page.waitForSelector(
      '[class*="export"], [data-testid*="export"], button:has-text("Export"), .s-options-menu',
      { timeout: 60000 }
    );
    if (!exportButton) throw new Error('Export button never appeared — dashboard may not have loaded');

    // Start download
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      exportButton.click(),
    ]);

    // Some dashboards show a dropdown — pick XLSX
    try {
      await page.click('text=Export to XLSX, text=XLSX, [data-testid*="xlsx"]', { timeout: 5000 });
    } catch (_) { /* already triggered or single-click export */ }

    const dlPath = await download.path();
    if (!dlPath) throw new Error('Download path null — download may have failed');
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
