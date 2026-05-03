'use strict';
/**
 * SMG download helper — logs in and downloads previous-day comments export.
 */
const { launchContext } = require('./browser-launch');
const fs   = require('fs');
const path = require('path');

const SMG_LOGIN_URL  = 'https://reporting.smg.com/index.aspx';
const SMG_REPORT_URL = 'https://360.smg.com/#/card/5b621d617485e95d90e0a370?languageiso=en-US&view=comments&id=5b621d617485e95d90e0a370';
const PROFILE_DIR    = process.env.SMG_PROFILE_DIR || '/tmp/smg-profile';

async function screenshot(page, label) {
  try {
    const dir = '/tmp/smg-debug';
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${label}-${Date.now()}.png`), fullPage: false });
    console.log(`[SMG] Screenshot: ${label}`);
  } catch (_) {}
}

async function downloadSMGComments(targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();

    // Navigate to report — SMG360 will redirect to login if session expired
    console.log('[SMG] Navigating to report...');
    await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const urlAfterNav = page.url();
    console.log(`[SMG] URL after nav: ${urlAfterNav}`);

    // Detect login redirect
    const needsLogin = urlAfterNav.includes('login')
      || urlAfterNav.includes('reporting.smg')
      || urlAfterNav.includes('/auth')
      || urlAfterNav.includes('signin');

    if (needsLogin) {
      console.log('[SMG] Login required');
      const user = process.env.SMG_USER || '';
      const pass = process.env.SMG_PASSWORD || '';
      if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');

      await page.goto(SMG_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Use waitForSelector — login forms are often JS-rendered
      const userField = await page.waitForSelector(
        '#UserName, input[name="Username"], input[type="email"], input[type="text"]',
        { timeout: 8000 }
      );
      await userField.fill(user);

      const passField = await page.waitForSelector(
        '#Password, input[name="Password"], input[type="password"]',
        { timeout: 5000 }
      );
      await passField.fill(pass);

      await page.click('input[type="submit"], button[type="submit"], #LoginButton, button:has-text("Sign In"), button:has-text("Log In")');
      await page.waitForTimeout(3000);
      console.log(`[SMG] Post-login URL: ${page.url()}`);

      // Navigate to report now that we're authenticated
      await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    }

    await screenshot(page, 'report-loaded');

    // ── Set date filter to targetDate if available ─────────────────────────
    try {
      const dateInput = await page.$('input[type="date"]');
      if (dateInput) {
        await dateInput.fill(targetDate);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
      }
    } catch (_) {}

    // ── Wait for page to fully render ──────────────────────────────────────
    console.log('[SMG] Waiting for report content...');
    await page.waitForTimeout(5000);
    await screenshot(page, 'before-export');

    // ── Find download/export — SMG360 uses various patterns ───────────────
    // Try multiple approaches in order of likelihood
    let downloadStarted = false;

    // Approach 1: Look for a download icon button (common in SMG360)
    const downloadSelectors = [
      'button[title*="Download" i]',
      'button[aria-label*="Download" i]',
      'button[title*="Export" i]',
      'button[aria-label*="Export" i]',
      'button:has-text("Download")',
      'button:has-text("Export")',
      '[data-testid*="download"]',
      '[data-testid*="export"]',
      '[class*="download"]:not(style):not(script)',
      '[class*="export"]:not(style):not(script)',
      'a[href*="export"]',
      'a[href*="download"]',
    ];

    let exportEl = null;
    for (const sel of downloadSelectors) {
      try {
        exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 5000 });
        if (exportEl) {
          console.log(`[SMG] Found export element with: ${sel}`);
          break;
        }
      } catch (_) {}
    }

    if (!exportEl) {
      await screenshot(page, 'no-export-found');
      throw new Error('SMG: Could not find any export/download button after trying all selectors');
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await exportEl.click();
    downloadStarted = true;

    // May need a secondary click (format picker)
    try {
      await page.click('text=Excel, text=XLSX, text=.xlsx, text=CSV', { timeout: 4000 });
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
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
