'use strict';
/**
 * Hut Bot Playwright scraper — Yum SuperApp Routines
 * Scrapes https://admin.superapp.yum.com/routines for missed/late routines.
 * Uses SAML SSO via stored credentials.
 *
 * Env vars required:
 *   HUTBOT_USER      — Yum SuperApp username / email
 *   HUTBOT_PASSWORD  — Yum SuperApp password
 *   HUTBOT_PROFILE_DIR (optional) — persistent browser profile path
 */
const { launchContext } = require('./browser-launch');
const db = require('./db');

const ROUTINES_URL  = 'https://admin.superapp.yum.com/routines';
const PROFILE_DIR   = process.env.HUTBOT_PROFILE_DIR || '/tmp/hutbot-profile';
const LOGIN_TIMEOUT = 60_000;   // SSO redirects can be slow
const NAV_TIMEOUT   = 60_000;   // Yum enterprise portal is slow to respond

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function credentialsPresent() {
  return !!(process.env.HUTBOT_USER && process.env.HUTBOT_PASSWORD);
}

async function screenshot(page, label) {
  try {
    const fs   = require('fs');
    const path = require('path');
    const dir  = '/tmp/hutbot-debug';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[HutBot] Screenshot saved: ${file}`);
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  Login
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogin(page) {
  const user = process.env.HUTBOT_USER;
  const pass = process.env.HUTBOT_PASSWORD;

  console.log('[HutBot] Handling SSO login...');
  await screenshot(page, 'login-start');

  // Combined selectors — one waitForSelector call instead of 4 × 15s loops
  const USER_SEL   = 'input[name="username"], input[type="email"], #username, input[type="text"]';
  const PASS_SEL   = 'input[name="password"], input[type="password"], #password';
  const SUBMIT_SEL = 'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Next"), button:has-text("Continue")';

  // Wait up to 20s for username field to appear
  let userEl;
  try {
    userEl = await page.waitForSelector(USER_SEL, { state: 'visible', timeout: 20000 });
  } catch (_) {}

  if (!userEl) {
    await screenshot(page, 'login-no-username');
    throw new Error(`HutBot login: username field not found. URL: ${page.url()}`);
  }

  await userEl.fill(user);
  console.log('[HutBot] Filled username');

  // If password is not yet on screen, click Next/Continue to advance SSO step
  let passEl = await page.$(PASS_SEL).catch(() => null);
  if (!passEl || !(await passEl.isVisible().catch(() => false))) {
    await page.click(SUBMIT_SEL).catch(() => {});
    await page.waitForTimeout(3000);
    passEl = await page.waitForSelector(PASS_SEL, { state: 'visible', timeout: 15000 }).catch(() => null);
  }

  if (!passEl) {
    await screenshot(page, 'login-no-password');
    throw new Error(`HutBot login: password field not found. URL: ${page.url()}`);
  }

  await passEl.fill(pass);
  console.log('[HutBot] Filled password');
  await screenshot(page, 'login-creds-filled');

  await page.click(SUBMIT_SEL).catch(() => {});

  // Wait for redirect back to superapp domain
  try {
    await page.waitForURL(/superapp\.yum\.com/, { timeout: LOGIN_TIMEOUT });
    console.log('[HutBot] Login successful — redirected to SuperApp');
  } catch (_) {
    await screenshot(page, 'login-redirect-timeout');
    const finalUrl = page.url();
    console.warn(`[HutBot] Login redirect timeout — URL: ${finalUrl}`);
    if (!finalUrl.includes('superapp')) {
      throw new Error(`HutBot login failed — stuck at: ${finalUrl}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scrape
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeHutBot(targetDate) {
  if (!credentialsPresent()) {
    console.error('[HutBot] HUTBOT_USER / HUTBOT_PASSWORD env vars not set — skipping scrape');
    return { success: false, error: 'HUTBOT_USER / HUTBOT_PASSWORD env vars not set. Set them in Render environment variables.' };
  }

  console.log(`[HutBot] Scraping routines for ${targetDate}`);
  let browser;
  try {
    browser = await launchContext(PROFILE_DIR);
  } catch (err) {
    console.error('[HutBot] Failed to launch browser:', err.message);
    return { success: false, error: `Browser launch failed: ${err.message}` };
  }

  const records = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    // ── Navigate to routines ─────────────────────────────────────────────────
    // Use 'commit' — fires on first byte received, not after DOM parse.
    // Yum's enterprise portal is slow; domcontentloaded was timing out at 30s.
    console.log(`[HutBot] Navigating to ${ROUTINES_URL} (waitUntil: commit, timeout: ${NAV_TIMEOUT}ms)`);

    let navError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(ROUTINES_URL, { waitUntil: 'commit', timeout: NAV_TIMEOUT });
        navError = null;
        console.log(`[HutBot] Navigation commit on attempt ${attempt}`);
        break;
      } catch (err) {
        navError = err;
        console.warn(`[HutBot] Nav attempt ${attempt} failed: ${err.message}. URL at fail: ${page.url()}`);
        if (attempt < 2) await page.waitForTimeout(5000);
      }
    }
    if (navError) throw new Error(`Navigation to routines URL failed after 2 attempts: ${navError.message}`);

    // Wait for page to actually start rendering content
    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    console.log(`[HutBot] After goto — URL: ${currentUrl}`);
    await screenshot(page, 'after-nav');

    // ── Detect login requirement ─────────────────────────────────────────────
    const needsLogin = currentUrl.includes('portalsso')
      || currentUrl.includes('login')
      || currentUrl.includes('sso')
      || currentUrl.includes('auth')
      || await page.$('input[type="password"], input[name="username"]').then(el => !!el).catch(() => false);

    if (needsLogin) {
      console.log(`[HutBot] Login required. URL: ${currentUrl}`);
      await handleLogin(page);
      const postLoginUrl = page.url();
      if (!postLoginUrl.includes('routines')) {
        console.log('[HutBot] Navigating to routines after login...');
        await page.goto(ROUTINES_URL, { waitUntil: 'commit', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(3000);
      }
    }

    const routinesUrl = page.url();
    const routinesTitle = await page.title().catch(() => '?');
    console.log(`[HutBot] On routines page — URL: ${routinesUrl} | Title: ${routinesTitle}`);

    // Wait for page content to load (after auth redirect settles)
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
    } catch (_) {}
    await page.waitForTimeout(2000);
    await screenshot(page, 'routines-page');

    // Dump page body so we can diagnose selector issues
    try {
      const pageInfo = await page.evaluate(() => ({
        url:         location.href,
        title:       document.title,
        bodyText:    document.body.innerText.slice(0, 600),
        inputCount:  document.querySelectorAll('input').length,
        tableCount:  document.querySelectorAll('table, [role="grid"]').length,
        buttonCount: document.querySelectorAll('button').length,
      }));
      console.log('[HutBot] Page info:', JSON.stringify(pageInfo));
    } catch (_) {}

    // ── Apply date filter ────────────────────────────────────────────────────
    try {
      const dateInputs = await page.$$('input[type="date"]');
      for (const inp of dateInputs) {
        await inp.fill(targetDate).catch(() => {});
      }
      const dateByPlaceholder = await page.$$('input[placeholder*="date" i], input[placeholder*="mm/dd" i]');
      for (const inp of dateByPlaceholder) {
        const [y, m, d] = targetDate.split('-');
        await inp.fill(`${m}/${d}/${y}`).catch(() => {});
      }
    } catch (_) {}

    // ── Apply Late + Missed status filters ───────────────────────────────────
    try {
      const filterSelectors = [
        { sel: 'input[type="checkbox"][value*="late" i]',   label: 'Late' },
        { sel: 'input[type="checkbox"][value*="missed" i]', label: 'Missed' },
        { sel: 'label:has-text("Late") input[type="checkbox"]',   label: 'Late label' },
        { sel: 'label:has-text("Missed") input[type="checkbox"]', label: 'Missed label' },
      ];
      for (const { sel, label } of filterSelectors) {
        const el = await page.$(sel);
        if (el && !(await el.isChecked().catch(() => true))) {
          await el.click().catch(() => {});
          console.log(`[HutBot] Checked filter: ${label}`);
        }
      }
    } catch (_) {}

    // ── Click Search / Apply ─────────────────────────────────────────────────
    try {
      const searchBtn = await page.$('button:has-text("Search"), button:has-text("Apply"), button:has-text("Filter"), button[type="submit"]');
      if (searchBtn) {
        await searchBtn.click();
        await page.waitForTimeout(4000);
      }
    } catch (_) {}

    // ── Wait for results table ───────────────────────────────────────────────
    try {
      await page.waitForSelector(
        'table tbody tr, [role="grid"] [role="row"], [class*="table"] [class*="row"], [class*="routine-row"]',
        { timeout: 20_000 }
      );
    } catch (err) {
      await screenshot(page, 'no-results-table');
      const currentPageUrl = page.url();
      console.warn('[HutBot] Results table not found:', err.message);
      // Only treat missing table as "no issues" if we're actually on the routines page.
      // If we ended up somewhere else (login page, error page) it's a real failure.
      if (!currentPageUrl.includes('superapp.yum.com')) {
        throw new Error(`HutBot: results table missing AND not on superapp domain. Likely login failure. URL: ${currentPageUrl}`);
      }
      return { success: true, records: [], note: 'No results table found on routines page — likely zero issues today' };
    }

    // ── Parse rows ───────────────────────────────────────────────────────────
    const rows = await page.$$('tr, [role="row"]');
    for (const row of rows) {
      try {
        const cells = await row.$$('td, [role="cell"]');
        if (cells.length < 3) continue;
        const texts  = await Promise.all(cells.map(c => c.innerText().catch(() => '')));
        const rowText = texts.join(' ').toLowerCase();
        if (!rowText.includes('late') && !rowText.includes('missed')) continue;

        const storeMatch = texts.join(' ').match(/\b(\d{5,6})\b/);
        if (!storeMatch) continue;

        const store_id       = storeMatch[1].padStart(6, '0');
        const status         = rowText.includes('missed') ? 'missed' : 'late';
        const routine_name   = (texts[1] || texts[0] || 'Unknown Routine').trim();
        const scheduled_time = texts.find(t => /\d{1,2}:\d{2}/.test(t))?.match(/\d{1,2}:\d{2}/)?.[0] || null;
        const completion_pct = texts.find(t => /\d+%/.test(t))?.match(/(\d+)%/)?.[1] || null;

        records.push({ store_id, routine_name, status, scheduled_time, completion_pct, report_date: targetDate });
      } catch (_) {}
    }

    console.log(`[HutBot] Scraped ${records.length} late/missed routines`);
    await screenshot(page, records.length > 0 ? 'results-found' : 'results-empty');

  } catch (err) {
    console.error('[HutBot] Scrape error:', err.message);
    await browser.close().catch(() => {});
    return { success: false, error: err.message };
  }

  await browser.close().catch(() => {});
  return { success: true, records };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Write flags to DB
// ─────────────────────────────────────────────────────────────────────────────

async function writeHutBotFlags(records, targetDate) {
  const assignments = await db.getStoreAssignments();
  const dow = new Date(targetDate + 'T12:00:00Z').getUTCDay();
  const isMonday = dow === 1;
  let flagsWritten = 0;

  for (const rec of records) {
    const asgn        = assignments[rec.store_id] || {};
    const isMissed    = rec.status === 'missed';
    const metric_type = isMissed ? 'ROUTINE_MISSED' : 'ROUTINE_LATE';
    const severity    = isMissed ? 'high' : 'medium';

    const prevDays = await db.getConsecutiveDays(rec.store_id, metric_type, targetDate);

    await db.insertIntelFlag({
      store_id:    rec.store_id,
      store_name:  asgn.store_name,
      area_coach:  asgn.area_coach,
      region_coach:asgn.region_coach,
      territory_vp:asgn.vp,
      metric_type,
      metric_date: targetDate,
      value:       isMissed ? 1 : 0,
      target:      0,
      variance:    1,
      source:      'HUTBOT',
      tier:        1,
      details: {
        routine_name:   rec.routine_name,
        status:         rec.status,
        scheduled_time: rec.scheduled_time || null,
        completion_pct: rec.completion_pct || null,
      },
      consecutive_days_out: prevDays + 1,
      severity,
      is_new: prevDays === 0,
    });
    flagsWritten++;
  }

  // Monday: re-surface unacknowledged Sunday ROUTINE_MISSED flags
  if (isMonday) {
    const p = db.getPool();
    if (p) {
      const res = await p.query(`
        SELECT DISTINCT store_id FROM intel_flags
        WHERE metric_type = 'ROUTINE_MISSED'
          AND metric_date = $1::date - INTERVAL '1 day'
          AND status NOT IN ('addressed','resolved','archived')
          AND id NOT IN (SELECT flag_id FROM intel_acknowledgments WHERE flag_id IS NOT NULL)
      `, [targetDate]);

      for (const row of res.rows) {
        const asgn = assignments[row.store_id] || {};
        await db.insertIntelFlag({
          store_id:    row.store_id,
          store_name:  asgn.store_name,
          area_coach:  asgn.area_coach,
          region_coach:asgn.region_coach,
          territory_vp:asgn.vp,
          metric_type: 'ROUTINE_MISSED',
          metric_date: targetDate,
          value: 1, target: 0, variance: 1,
          source: 'HUTBOT', tier: 1,
          details: { note: 'Monday reminder — unacknowledged Sunday routine miss' },
          consecutive_days_out: 1,
          severity: 'high',
          is_new: true,
        });
        flagsWritten++;
      }
    }
  }

  console.log(`[HutBot] ${flagsWritten} flags written for ${targetDate}`);
  return flagsWritten;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main entry point
// ─────────────────────────────────────────────────────────────────────────────

async function processHutBot(targetDate) {
  const result = await scrapeHutBot(targetDate);
  if (!result.success) return result;

  try {
    const flagsWritten = await writeHutBotFlags(result.records, targetDate);
    return {
      success: true,
      recordsProcessed: result.records.length,
      flagsWritten,
      note: result.note || null,
    };
  } catch (err) {
    console.error('[HutBot] DB write error:', err.message);
    return { success: false, error: `DB write failed: ${err.message}` };
  }
}

module.exports = { processHutBot, writeHutBotFlags };
