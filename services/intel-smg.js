'use strict';
/**
 * SMG download helper — logs in and downloads previous-day comments export.
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SMG_LOGIN_URL  = 'https://reporting.smg.com/index.aspx';
const SMG_REPORT_URL = 'https://360.smg.com/#/card/5b621d617485e95d90e0a370?languageiso=en-US&view=comments&id=5b621d617485e95d90e0a370';
const PROFILE_DIR    = process.env.SMG_PROFILE_DIR || '/tmp/smg-profile';

async function downloadSMGComments(targetDate) {
  const tmpDir  = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    acceptDownloads: true,
  });

  try {
    const page = await browser.newPage();

    // Try going directly to the report
    await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // If redirected to login
    if (page.url().includes('login') || page.url().includes('reporting.smg')) {
      const user = process.env.SMG_USER || '';
      const pass = process.env.SMG_PASSWORD || '';
      if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');
      console.log('[SMG] Logging in');
      await page.goto(SMG_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const userField = await page.$('#UserName, input[name="Username"], input[type="email"]');
      if (userField) await userField.fill(user);
      const passField = await page.$('#Password, input[name="Password"], input[type="password"]');
      if (passField) await passField.fill(pass);
      await page.click('input[type="submit"], button[type="submit"], #LoginButton');
      await page.waitForNavigation({ timeout: 30000 });
      await page.goto(SMG_REPORT_URL, { waitUntil: 'networkidle', timeout: 60000 });
      console.log('[SMG] Login OK');
    }

    // Set date filter to previous day
    try {
      const dateFilter = await page.$('input[type="date"], [placeholder*="date" i]');
      if (dateFilter) {
        await dateFilter.fill(targetDate);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
      }
    } catch (_) {}

    // Find and click export / download button
    console.log('[SMG] Waiting for export button...');
    const exportBtn = await page.waitForSelector(
      'button:has-text("Export"), button:has-text("Download"), [data-testid*="export"], [class*="export"]',
      { timeout: 30000 }
    );
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      exportBtn.click(),
    ]);

    try { await page.click('text=Excel, text=XLSX, text=.xlsx', { timeout: 5000 }); } catch (_) {}

    const dlPath = await download.path();
    if (!dlPath) throw new Error('SMG download path null');
    fs.copyFileSync(dlPath, outPath);
    console.log(`[SMG] Comments downloaded to ${outPath}`);
    return { success: true, filePath: outPath };
  } catch (err) {
    console.error('[SMG] Download failed:', err.message);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = { downloadSMGComments };
