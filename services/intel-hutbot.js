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

const ROUTINES_URL = 'https://admin.superapp.yum.com/routines';
const PROFILE_DIR  = process.env.HUTBOT_PROFILE_DIR || '/tmp/hutbot-profile';
const LOGIN_TIMEOUT = 45_000;
const NAV_TIMEOUT   = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function credentialsPresent() {
  return !!(process.env.HUTBOT_USER && process.env.HUTBOT_PASSWORD);
}

/** Save a debug screenshot when something goes wrong (non-fatal). */
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

/** Wait for navigation, tolerating timeouts gracefully. */
async function safeWaitForNav(page, opts = {}) {
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  Login
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogin(page) {
  const user = process.env.HUTBOT_USER;
  const pass = process.env.HUTBOT_PASSWORD;

  console.log('[HutBot] Handling SSO login...');

  // Yum portalsso — username first, then password on next screen
  const userSelectors = [
    'input[name="username"]',
    'input[type="email"]',
    '#username',
    'input[type="text"]',
  ];
  const passSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    '#password',
  ];
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
  ];

  // Fill username
  let filled = false;
  for (const sel of userSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.fill(user);
        filled = true;
        console.log(`[HutBot] Filled username via: ${sel}`);
        break;
      }
    } catch (_) {}
  }
  if (!filled) {
    await screenshot(page, 'login-no-username');
    throw new Error('HutBot login: could not find username field');
  }

  // Click submit / Next (some flows show username-only first)
  for (const sel of submitSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.click(); break; }
    } catch (_) {}
  }

  // Wait briefly then fill password (may be same screen or next screen)
  await page.waitForTimeout(2000);

  let passPage = page;
  let passEl = null;
  for (const sel of passSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { passEl = el; break; }
    } catch (_) {}
  }

  if (!passEl) {
    // password might be on a new page — wait for it
    await page.waitForTimeout(3000);
    for (const sel of passSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) { passEl = el; break; }
      } catch (_) {}
    }
  }

  if (!passEl) {
    await screenshot(page, 'login-no-password');
    throw new Error('HutBot login: could not find password field');
  }

  await passEl.fill(pass);
  console.log('[HutBot] Filled password');

  // Submit
  for (const sel of submitSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.click(); break; }
    } catch (_) {}
  }

  // Wait for redirect to superapp domain
  try {
    await page.waitForURL(/superapp\.yum\.com/, { timeout: LOGIN_TIMEOUT });
    console.log('[HutBot] Login successful — redirected to SuperApp');
  } catch (_) {
    await screenshot(page, 'login-redirect-timeout');
    // Check if we landed somewhere useful anyway
    const finalUrl = page.url();
    console.warn(`[HutBot] Login redirect timeout — current URL: ${finalUrl}`);
    if (!finalUrl.includes('superapp')) {
      throw new Error(`HutBot login failed — stuck at: ${finalUrl}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scrape
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeHutBot(targetDate) {
  // ── Fail fast if no credentials ──────────────────────────────────────────
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

    // ── Navigate to routines — retry once on HTTP/2 protocol error ─────────
    let navError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(ROUTINES_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        navError = null;
        break;
      } catch (err) {
        navError = err;
        console.warn(`[HutBot] Nav attempt ${attempt} failed: ${err.message}`);
        if (attempt < 2) await page.waitForTimeout(3000);
      }
    }
    if (navError) throw navError;
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    console.log(`[HutBot] After goto — URL: ${currentUrl}`);

    // ── Detect login requirement ─────────────────────────────────────────────
    const needsLogin = currentUrl.includes('portalsso')
      || currentUrl.includes('login')
      || currentUrl.includes('sso')
      || currentUrl.includes('auth')
      || await page.$('input[type="password"], input[name="username"]').then(el => !!el).catch(() => false);

    if (needsLogin) {
      await handleLogin(page);
      // Navigate (or re-navigate) to routines after login
      const postLoginUrl = page.url();
      if (!postLoginUrl.includes('routines')) {
        console.log('[HutBot] Navigating to routines after login...');
        await page.goto(ROUTINES_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(2000);
      }
    }

    console.log(`[HutBot] On routines page — URL: ${page.url()}`);

    // ── Apply date filter ────────────────────────────────────────────────────
    try {
      const dateInputs = await page.$$('input[type="date"]');
      for (const inp of dateInputs) {
        await inp.fill(targetDate).catch(() => {});
      }
      // Also try placeholder-based date pickers
      const dateByPlaceholder = await page.$$('input[placeholder*="date" i], input[placeholder*="mm/dd" i]');
      for (const inp of dateByPlaceholder) {
        // Format as MM/DD/YYYY for US-style pickers
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
        await page.waitForTimeout(3500);
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
      console.warn('[HutBot] Results table not found:', err.message);
      // Return zero records (no issues today) rather than an error
      return { success: true, records: [], note: 'No results table found — may mean zero issues' };
    }

    // ── Parse rows ───────────────────────────────────────────────────────────
    const rows = await page.$$('tr, [role="row"]');
    for (const row of rows) {
      try {
        const cells = await row.$$('td, [role="cell"]');
        if (cells.length < 3) continue;
        const texts = await Promise.all(cells.map(c => c.innerText().catch(() => '')));
        const rowText = texts.join(' ').toLowerCase();

        if (!rowText.includes('late') && !rowText.includes('missed')) continue;

        // Extract store number (5-6 digits)
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
//  Write flags to DB (shared by scraper + manual upload parser)
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
//  Main entry point (called by intel-pipeline.js)
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
