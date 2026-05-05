'use strict';
/**
 * SMG download helper — logs in via the referrerUri SSO flow and downloads
 * the previous-day "Comments By Comment" Excel export from SMG360.
 *
 * Auth flow (discovered from browser tab inspection):
 *   1. Navigate to the 360.smg.com report card URL
 *   2. 360.smg.com redirects to reporting.smg.com/index.aspx?referrerUri=<card_url>
 *   3. Login on reporting.smg.com
 *   4. reporting.smg.com redirects back to 360.smg.com via referrerUri — session established
 *   5. SPA loads the card, find the export button, download Excel
 */
const { launchContext } = require('./browser-launch');
const fs   = require('fs');
const path = require('path');

const SMG_REPORT_URL = 'https://360.smg.com/#/card/5b621d617485e95d90e0a370?languageiso=en-US&view=comments&id=5b621d617485e95d90e0a370';
const PROFILE_DIR    = process.env.SMG_PROFILE_DIR || '/tmp/smg-profile';

async function screenshot(page, label, full = false) {
  try {
    const dir = '/tmp/smg-debug';
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${label}-${Date.now()}.png`), fullPage: full });
    console.log(`[SMG] Screenshot: ${label}`);
  } catch (_) {}
}

async function downloadSMGComments(targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  const user = process.env.SMG_USER     || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();
    page.on('console', m => { if (m.type() === 'error') console.log('[SMG] JS error:', m.text().slice(0, 200)); });

    // ── Step 1: Navigate to the 360.smg.com report — it will redirect to
    //           reporting.smg.com login with referrerUri pointing back to the card.
    console.log('[SMG] Step 1: navigating to 360.smg.com report to trigger SSO redirect...');
    await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    let currentUrl = page.url();
    console.log(`[SMG] After initial nav: ${currentUrl}`);
    await screenshot(page, 'step1-initial');

    // If we're already on 360.smg.com (cached session), skip login
    if (currentUrl.includes('360.smg.com') && !currentUrl.includes('reporting.smg.com')) {
      console.log('[SMG] Already authenticated on 360.smg.com — skipping login');
    } else {
      // Should now be on reporting.smg.com/index.aspx?referrerUri=...
      // Fill credentials
      console.log(`[SMG] On login page: ${currentUrl}`);
      await screenshot(page, 'step1-login');

      const userField = await page.$('#UserName, input[name="UserName"], input[name="Username"], input[type="email"], input[type="text"]');
      if (!userField) throw new Error(`SMG login form not found at: ${currentUrl}`);

      console.log('[SMG] Filling credentials...');
      await userField.fill(user);
      const passField = await page.$('#Password, input[name="Password"], input[type="password"]');
      if (!passField) throw new Error('SMG password field not found');
      await passField.fill(pass);
      await passField.dispatchEvent('input');
      await passField.dispatchEvent('change');
      await page.waitForTimeout(1500);

      // Enable and click submit
      try {
        await page.waitForSelector(
          'input[type="submit"]:not([disabled]), button[type="submit"]:not([disabled]), #LoginButton:not([disabled]), .btn-primary:not([disabled])',
          { state: 'visible', timeout: 8000 }
        );
      } catch (_) { console.log('[SMG] Submit not enabled — pressing Enter'); }
      const clicked = await page.click(
        'input[type="submit"]:not([disabled]), button[type="submit"]:not([disabled]), #LoginButton:not([disabled]), .btn-primary:not([disabled])',
        { timeout: 3000 }
      ).then(() => true).catch(() => false);
      if (!clicked) await passField.press('Enter');

      // Wait for redirect back to 360.smg.com via referrerUri
      console.log('[SMG] Waiting for redirect back to 360.smg.com...');
      try {
        await page.waitForURL('**/360.smg.com/**', { timeout: 20000 });
      } catch (_) {
        // May land on MultiLanguage.aspx first — wait for it and follow
        const midUrl = page.url();
        console.log(`[SMG] Intermediate URL: ${midUrl}`);
        await screenshot(page, 'step1-mid', true);
        if (midUrl.includes('MultiLanguage')) {
          // Click the first non-js link to proceed past language selection
          const firstLink = await page.$('a[href]:not([href="#"]):not([href^="javascript"])');
          if (firstLink) {
            const href = await firstLink.getAttribute('href');
            console.log(`[SMG] Clicking past MultiLanguage: ${href}`);
            await firstLink.click();
            await page.waitForTimeout(5000);
          }
        }
      }

      currentUrl = page.url();
      console.log(`[SMG] Post-login URL: ${currentUrl}`);
      await screenshot(page, 'step1-post-login');
    }

    // ── Step 2: Navigate to the report card (in case we're at a different 360 URL) ─
    if (!currentUrl.includes('5b621d617485e95d90e0a370')) {
      console.log('[SMG] Navigating to report card...');
      await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // Wait for SPA to fully render the card
    console.log('[SMG] Waiting for report card to render...');
    try {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
    } catch (_) { console.log('[SMG] networkidle timeout — continuing'); }
    await page.waitForTimeout(5000);

    const reportUrl = page.url();
    console.log(`[SMG] Report URL after wait: ${reportUrl}`);
    await screenshot(page, 'step2-report', true);

    // Verify we're on 360.smg.com and not still on login
    if (!reportUrl.includes('360.smg.com')) {
      throw new Error(`SMG auth failed — stuck at: ${reportUrl}`);
    }

    // Dump page state
    try {
      const info = await page.evaluate(() => ({
        title: document.title,
        bodyText: document.body.innerText.slice(0, 400),
        buttonCount: document.querySelectorAll('button').length,
      }));
      console.log('[SMG] Report page info:', JSON.stringify(info));
    } catch (_) {}

    // ── Step 3: Find and click the export/download button ─────────────────────
    const downloadSelectors = [
      'button[aria-label*="Download" i]', 'button[aria-label*="Export" i]',
      '[aria-label*="Download" i]',        '[aria-label*="Export" i]',
      'button[title*="Download" i]',       'button[title*="Export" i]',
      '[data-testid*="export" i]',         '[data-testid*="download" i]',
      'button:has-text("Download")',       'button:has-text("Export")',
      'button:has-text("CSV")',            'button:has-text("Excel")',
      'a:has-text("Export")',              'a:has-text("Download")',
      '[class*="download-btn"]',           '[class*="export-btn"]',
      '[class*="downloadButton"]',         '[class*="exportButton"]',
      'a[href*="export"]',                 'a[href*="download"]',
    ];

    let exportEl = null;
    for (const sel of downloadSelectors) {
      try {
        exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 2000 });
        if (exportEl) { console.log(`[SMG] Found export element: ${sel}`); break; }
      } catch (_) {}
    }

    // Hover-to-reveal
    if (!exportEl) {
      console.log('[SMG] Trying hover-to-reveal...');
      const hoverTargets = ['[class*="card-header"]','[class*="cardHeader"]','[class*="widget-header"]','h1','h2','h3'];
      for (const hSel of hoverTargets) {
        try {
          const hoverEl = await page.$(hSel);
          if (!hoverEl) continue;
          await hoverEl.hover();
          await page.waitForTimeout(1200);
          for (const sel of downloadSelectors) {
            try {
              exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 1500 });
              if (exportEl) { console.log(`[SMG] Found export after hovering ${hSel}`); break; }
            } catch (_) {}
          }
          if (exportEl) break;
        } catch (_) {}
      }
    }

    // Evaluate fallback
    if (!exportEl) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, [role="button"], a')) {
          const cls = (el.className||'').toString().toLowerCase();
          const aria = (el.getAttribute('aria-label')||'').toLowerCase();
          const text = (el.innerText||'').toLowerCase().trim();
          if (cls.includes('download')||cls.includes('export')||aria.includes('download')||aria.includes('export')||text==='download'||text==='export')
            el.setAttribute('data-smg-export-target','true');
        }
      });
      exportEl = await page.$('[data-smg-export-target="true"]');
      if (exportEl) console.log('[SMG] Found export via evaluate fallback');
    }

    if (!exportEl) {
      // Log all buttons/links for diagnosis
      const els = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"], a')).slice(0, 40)
          .map(e => ({ tag: e.tagName, text: (e.innerText||'').trim().slice(0,40), aria: e.getAttribute('aria-label')||'', cls: (e.className||'').toString().slice(0,50) }))
      );
      console.log('[SMG] Interactive elements:', JSON.stringify(els));
      await screenshot(page, 'step3-no-export', true);
      throw new Error(`SMG: No export button found on report page`);
    }

    // ── Step 4: Click and download ─────────────────────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await exportEl.click();
    console.log('[SMG] Clicked export');
    await page.waitForTimeout(800);

    // Handle format picker submenu
    try {
      await page.click(
        'li:has-text("Excel"), li:has-text("XLSX"), button:has-text("XLSX"), [role="menuitem"]:has-text("Excel"), [role="menuitem"]:has-text("XLSX")',
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
