'use strict';
/**
 * Hut Bot Playwright scraper — Yum SuperApp Routines
 * Scrapes https://admin.superapp.yum.com/routines for missed/late routines.
 * Uses SAML SSO — try direct URL first, fall back to credential login.
 */
const { chromium } = require('playwright');
const db = require('./db');

const ROUTINES_URL = 'https://admin.superapp.yum.com/routines';
const PROFILE_DIR  = process.env.HUTBOT_PROFILE_DIR || '/tmp/hutbot-profile';

async function scrapeHutBot(targetDate) {
  console.log(`[HutBot] Scraping routines for ${targetDate}`);
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const records = [];
  try {
    const page = await browser.newPage();
    await page.goto(ROUTINES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Handle SAML redirect / login
    const needsLogin = await page.$('input[type="text"], input[type="email"], #username').catch(() => null);
    const url = page.url();
    if (needsLogin || url.includes('portalsso') || url.includes('login') || url.includes('sso')) {
      const user = process.env.HUTBOT_USER || '';
      const pass = process.env.HUTBOT_PASSWORD || '';
      if (!user || !pass) throw new Error('HUTBOT_USER / HUTBOT_PASSWORD env vars not set');
      console.log('[HutBot] Logging in via SSO');
      const userField = await page.$('input[type="text"], input[type="email"], #username, input[name="username"]');
      if (userField) await userField.fill(user);
      const passField = await page.$('input[type="password"], #password, input[name="password"]');
      if (passField) await passField.fill(pass);
      await page.click('button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
      await page.waitForURL(/superapp|routines/, { timeout: 30000 });
      console.log('[HutBot] Login OK');
    }

    // Set date filter to yesterday
    const yesterday = targetDate;
    try {
      const dateInputs = await page.$$('input[type="date"], input[placeholder*="date" i], input[placeholder*="Date" i]');
      for (const inp of dateInputs) { await inp.fill(yesterday); }
    } catch (_) {}

    // Apply Late + Missed filters
    try {
      const lateChk  = await page.$('input[type="checkbox"][value*="late" i], label:has-text("Late") input, label:has-text("late") input');
      const missedChk = await page.$('input[type="checkbox"][value*="missed" i], label:has-text("Missed") input, label:has-text("missed") input');
      if (lateChk && !(await lateChk.isChecked()))   await lateChk.click();
      if (missedChk && !(await missedChk.isChecked())) await missedChk.click();
    } catch (_) {}

    // Click search / apply
    try {
      await page.click('button:has-text("Search"), button:has-text("Apply"), button[type="submit"]');
      await page.waitForTimeout(3000);
    } catch (_) {}

    // Scrape results table
    await page.waitForSelector('table, [role="grid"], [class*="table"], [class*="routine"]', { timeout: 20000 });
    const rows = await page.$$('tr, [role="row"]');
    for (const row of rows) {
      try {
        const cells = await row.$$('td, [role="cell"]');
        if (cells.length < 3) continue;
        const texts = await Promise.all(cells.map(c => c.innerText()));
        // Look for rows that contain store identifiers and routine status
        const rowText = texts.join(' ').toLowerCase();
        if (!rowText.includes('late') && !rowText.includes('missed')) continue;
        // Extract store number (6 digits)
        const storeMatch = texts.join(' ').match(/\b(\d{5,6})\b/);
        if (!storeMatch) continue;
        const store_id = storeMatch[1].padStart(6,'0');
        const status   = rowText.includes('missed') ? 'missed' : 'late';
        // Try to find routine name and times
        const routine_name   = texts[1] || texts[0] || 'Unknown Routine';
        const scheduled_time = texts.find(t => /\d{1,2}:\d{2}/.test(t))?.match(/\d{1,2}:\d{2}/)?.[0] || null;
        records.push({ store_id, routine_name: routine_name.trim(), status, scheduled_time, report_date: targetDate });
      } catch (_) {}
    }
    console.log(`[HutBot] Scraped ${records.length} late/missed routines`);
  } catch (err) {
    console.error('[HutBot] Scrape error:', err.message);
    await browser.close();
    return { success: false, error: err.message };
  }
  await browser.close();
  return { success: true, records };
}

async function processHutBot(targetDate) {
  const result = await scrapeHutBot(targetDate);
  if (!result.success) return result;

  const assignments = await db.getStoreAssignments();
  const dow = new Date(targetDate + 'T12:00:00Z').getUTCDay();
  const isMonday = dow === 1;
  let flagsWritten = 0;

  for (const rec of result.records) {
    const asgn = assignments[rec.store_id] || {};
    let severity = 'medium', metric_type = 'ROUTINE_LATE';

    if (rec.status === 'missed') {
      severity = 'high'; metric_type = 'ROUTINE_MISSED';
    } else {
      // Calculate minutes late if we have times
      severity = 'medium'; // default for late
    }

    const prevDays = await db.getConsecutiveDays(rec.store_id, metric_type, targetDate);
    await db.insertIntelFlag({
      store_id:    rec.store_id,
      store_name:  asgn.store_name,
      area_coach:  asgn.area_coach,
      region_coach:asgn.region_coach,
      territory_vp:asgn.vp,
      metric_type,
      metric_date: targetDate,
      value:       rec.status === 'missed' ? 1 : 0,
      target:      0, variance: 1,
      source:      'HUTBOT', tier: 1,
      details:     { routine_name: rec.routine_name, status: rec.status, scheduled_time: rec.scheduled_time },
      consecutive_days_out: prevDays + 1,
      severity,
      is_new:      prevDays === 0,
    });
    flagsWritten++;
  }

  // Monday: re-surface unacknowledged Sunday ROUTINE_MISSED
  if (isMonday) {
    const p = db.getPool();
    if (p) {
      const res = await p.query(`
        SELECT DISTINCT store_id FROM intel_flags
        WHERE metric_type = 'ROUTINE_MISSED'
          AND metric_date = $1::date - INTERVAL '1 day'
          AND status NOT IN ('addressed','resolved','archived')
          AND id NOT IN (SELECT flag_id FROM intel_acknowledgments)
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
          consecutive_days_out: 1, severity: 'high', is_new: true,
        });
        flagsWritten++;
      }
    }
  }

  console.log(`[HutBot] Done — ${flagsWritten} flags written`);
  return { success: true, recordsProcessed: result.records.length, flagsWritten };
}

module.exports = { processHutBot };
