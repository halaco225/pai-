// =====================================================================
// VELOCITY ODS — Automated pull from OneData (bi.onedatasource.com)
// Uses Playwright to authenticate and download the Above Store Report
// =====================================================================
'use strict';

const fs   = require('fs');
const path = require('path');

const ODS_URL  = 'https://bi.onedatasource.com';
const ODS_ORG  = process.env.ODS_ORG  || 'dgi';
const ODS_USER = process.env.ODS_USER || 'hlacoste';
const ODS_PASS = process.env.ODS_PASSWORD || '';

async function pullAboveStoreReport(targetDate) {
  let browser = null;
  const tmpDir = path.join(__dirname, '..', 'uploads');
  if (\!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Lazy-load playwright so startup isn't affected if not installed
    const { chromium } = require('playwright');

    console.log(`[ODS] Launching browser for date=${targetDate}`);
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      acceptDownloads: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    const page = await context.newPage();

    // ── Step 1: Navigate to OneData ──────────────────────────────────
    console.log(`[ODS] Navigating to ${ODS_URL}`);
    await page.goto(ODS_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // ── Step 2: Select DGI organization ──────────────────────────────
    console.log('[ODS] Selecting organization: DGI');
    try {
      // Look for org dropdown (may be select, input, or custom dropdown)
      const orgSelector = await page.$('select[name*="org"], select[id*="org"], input[name*="org"]');
      if (orgSelector) {
        const tagName = await orgSelector.evaluate(el => el.tagName.toLowerCase());
        if (tagName === 'select') {
          await orgSelector.selectOption({ label: ODS_ORG.toUpperCase() });
        } else {
          await orgSelector.fill(ODS_ORG);
        }
      } else {
        // Try clicking a dropdown that shows org options
        const orgDropdown = await page.$('[data-org], .org-selector, #organization');
        if (orgDropdown) {
          await orgDropdown.click();
          await page.waitForTimeout(500);
          await page.click(`text=${ODS_ORG.toUpperCase()}`);
        }
      }
    } catch (e) {
      console.log('[ODS] Org select step:', e.message);
    }

    // ── Step 3: Fill credentials and sign in ─────────────────────────
    console.log('[ODS] Filling credentials');
    try {
      // Try standard login fields
      const usernameField = await page.$('input[name="username"], input[name="j_username"], input[type="email"], input[id*="user"]');
      const passwordField = await page.$('input[name="password"], input[name="j_password"], input[type="password"]');
      
      if (usernameField) await usernameField.fill(ODS_USER);
      if (passwordField) await passwordField.fill(ODS_PASS);
    } catch (e) {
      console.log('[ODS] Credential fill step:', e.message);
    }

    // ── Step 4: Click Sign In ─────────────────────────────────────────
    console.log('[ODS] Clicking sign in');
    try {
      const signInBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Login")');
      if (signInBtn) {
        await signInBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
      console.log('[ODS] Sign in step:', e.message);
    }

    // ── Step 5: Navigate to Daily Dispatch Performance report ─────────
    console.log('[ODS] Looking for Daily Dispatch Performance report');
    await page.waitForTimeout(2000);

    // Try to find the report in navigation
    try {
      const reportLink = await page.$('a:has-text("Daily Dispatch"), a:has-text("Above Store"), a:has-text("Dispatch Performance")');
      if (reportLink) {
        await reportLink.click();
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
      }
    } catch (e) {
      console.log('[ODS] Report navigation:', e.message);
    }

    // ── Step 6: Set date parameter to targetDate ──────────────────────
    console.log(`[ODS] Setting report date to ${targetDate}`);
    await page.waitForTimeout(1000);
    try {
      const dateInput = await page.$('input[type="date"], input[name*="date"], input[id*="date"]');
      if (dateInput) {
        await dateInput.fill(targetDate);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      console.log('[ODS] Date set step:', e.message);
    }

    // ── Step 7: Download PDF ──────────────────────────────────────────
    console.log('[ODS] Attempting PDF download');
    const downloadPath = path.join(tmpDir, `above-store-${targetDate}.pdf`);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('button:has-text("Export"), button:has-text("Download"), a:has-text("PDF"), [data-format="pdf"]')
        .catch(() => page.click('button:has-text("Run"), button:has-text("Submit")'))
    ]);

    const suggestedName = download.suggestedFilename();
    console.log(`[ODS] Download started: ${suggestedName}`);
    await download.saveAs(downloadPath);

    await browser.close();
    console.log(`[ODS] PDF saved to ${downloadPath}`);
    return { success: true, filePath: downloadPath, date: targetDate };

  } catch (e) {
    console.error('[ODS] Pull failed:', e.message);
    if (browser) {
      try { await browser.close(); } catch(_) {}
    }
    return { success: false, error: e.message, date: targetDate };
  }
}

module.exports = { pullAboveStoreReport };
