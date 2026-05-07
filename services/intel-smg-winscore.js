'use strict';
/**
 * SMG Win Score — scrapes reporting.smg.com Comparison Report (Current Fiscal Period)
 * and stores per-store Win Score PTD in smg_win_scores table.
 *
 * Credentials: SMG_USER / SMG_PASSWORD env vars (same as reporting.smg.com login)
 * Export format: CSV → Store | Count | Win Score%
 */
const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const REPORT_URL = 'https://reporting.smg.com/ReportBuilder.aspx';

// "1P039375 - 039375,4221 BELLS FERRY DR..." → "039375"
function parseStoreIdFromUnit(unit) {
  if (!unit) return null;
  const m = String(unit).match(/1P(\d{6})\s*-\s*(\d{6})/);
  if (m) return m[2];
  const m2 = String(unit).match(/(\d{6})/);
  return m2 ? m2[1] : null;
}

function parseWinScore(val) {
  if (val == null) return null;
  const n = parseFloat(String(val).replace('%', '').trim());
  return isNaN(n) ? null : n;
}

/**
 * Parse the CSV export: rows are Store, Count, Win Score
 * First data row is "Combined" (skip it)
 */
function parseWinScoreCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  // Find header row
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/win score/i.test(lines[i])) { dataStart = i + 1; break; }
  }

  const results = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (!cols[0] || /combined/i.test(cols[0])) continue;
    const store_id = parseStoreIdFromUnit(cols[0]);
    if (!store_id) continue;
    // Win Score may be in col 2 (index 2) — handle quoted cells
    const raw = cols.slice(-1)[0]; // last column
    const winScore = parseWinScore(raw);
    const count = parseInt(String(cols[cols.length - 2] || '0').replace(/\D/g, '')) || 0;
    if (winScore == null) continue;
    results.push({ store_id, win_score: winScore, survey_count: count });
  }
  return results;
}

async function downloadWinScoreCSV(targetDate) {
  let playwright;
  try { playwright = require('playwright'); } catch (_) {
    throw new Error('playwright not installed — run: npm install playwright');
  }

  const user = process.env.SMG_USER || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');

  const tmpDir  = path.join(__dirname, '..', 'uploads');
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `smg-winscore-${targetDate}.csv`);

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page    = await context.newPage();

  try {
    console.log('[WinScore] Navigating to reporting.smg.com');
    await page.goto(REPORT_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Handle login if redirected
    if (page.url().includes('Login') || page.url().includes('login')) {
      console.log('[WinScore] Login page detected — authenticating');
      const userField = await page.$('input[type="text"], input[name*="user" i], input[id*="user" i]');
      const passField = await page.$('input[type="password"]');
      if (!userField || !passField) throw new Error('Could not find login form fields');
      await userField.fill(user);
      await passField.fill(pass);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
        page.keyboard.press('Enter'),
      ]);
      console.log('[WinScore] Login submitted, now at:', page.url());
      // Navigate to report builder if needed
      if (!page.url().includes('ReportBuilder')) {
        await page.goto(REPORT_URL, { waitUntil: 'networkidle', timeout: 30000 });
      }
    }

    // Ensure Report Type = Comparison
    const reportTypeSelect = await page.$('select[id*="ReportType" i], select[name*="reporttype" i]');
    if (reportTypeSelect) {
      await reportTypeSelect.selectOption({ label: 'Comparison' });
      await page.waitForTimeout(500);
    }

    // Date range = Current Fiscal Period
    const dateRangeSelect = await page.$('select[id*="DateRange" i], select[name*="daterange" i]');
    if (dateRangeSelect) {
      await dateRangeSelect.selectOption({ label: /current fiscal period/i });
      await page.waitForTimeout(500);
    }

    // Ensure level = Store
    const levelSelect = await page.$('select[id*="Level" i], select[name*="level" i]');
    if (levelSelect) {
      await levelSelect.selectOption({ label: /store/i });
      await page.waitForTimeout(500);
    }

    // Select all stores
    const selectAllLink = await page.$('a:has-text("Select all"), a:text-matches("select all", "i")');
    if (selectAllLink) {
      await selectAllLink.click();
      await page.waitForTimeout(500);
    }

    // Make sure Win Score is selected in section 3 — click it if not already selected
    const winScoreOption = await page.$('text=Win Score');
    if (winScoreOption) {
      const isSelected = await winScoreOption.evaluate(el => {
        const parent = el.closest('[class*="selected"], [class*="active"]');
        return !!parent || el.classList.contains('selected');
      });
      if (!isSelected) {
        await winScoreOption.click();
        await page.waitForTimeout(500);
      }
    }

    // Click Build Report
    console.log('[WinScore] Clicking Build Report');
    await Promise.all([
      page.waitForSelector('table:has(th:has-text("Win Score"))', { timeout: 30000 }),
      page.click('input[value*="Build" i], button:has-text("Build Report")'),
    ]);
    console.log('[WinScore] Report built');

    // Click Save/Export
    await page.click('a:has-text("Save/Export"), button:has-text("Save/Export")');
    await page.waitForTimeout(1000);

    // Select Export to CSV radio
    const csvRadio = await page.$('input[type="radio"] + label:has-text("CSV"), label:has-text("Export to CSV")');
    if (csvRadio) {
      const radio = await page.$('input[type="radio"][value*="csv" i], input[type="radio"]:near(:text("CSV"))');
      if (radio) await radio.click();
      else await csvRadio.click();
    } else {
      // Try clicking the label directly
      await page.click('text=Export to CSV');
    }
    await page.waitForTimeout(500);

    // Click Download and capture file
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('button:has-text("Download"), input[value*="Download" i]'),
    ]);

    await download.saveAs(outPath);
    console.log(`[WinScore] CSV saved → ${outPath}`);
    return { success: true, filePath: outPath };
  } finally {
    await browser.close();
  }
}

async function processWinScore(targetDate) {
  console.log(`[WinScore] Starting for ${targetDate}`);
  let filePath;
  try {
    const dl = await downloadWinScoreCSV(targetDate);
    if (!dl.success) return { success: false, error: dl.error };
    filePath = dl.filePath;
  } catch (err) {
    console.error('[WinScore] Download failed:', err.message);
    return { success: false, error: err.message };
  }

  let csvText;
  try {
    csvText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { success: false, error: `Could not read CSV: ${err.message}` };
  }

  const scores = parseWinScoreCSV(csvText);
  console.log(`[WinScore] Parsed ${scores.length} store scores`);

  const pool = db.getPool();
  if (!pool) return { success: false, error: 'No DB pool' };

  let written = 0;
  for (const s of scores) {
    await pool.query(`
      INSERT INTO smg_win_scores (store_id, period_end_date, win_score, survey_count, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (store_id, period_end_date)
      DO UPDATE SET win_score=$3, survey_count=$4, updated_at=NOW()
    `, [s.store_id, targetDate, s.win_score, s.survey_count]);
    written++;
  }

  try { fs.unlinkSync(filePath); } catch (_) {}
  console.log(`[WinScore] ${written} scores written`);
  return { success: true, storesProcessed: scores.length, scoresWritten: written };
}

module.exports = { processWinScore, parseWinScoreCSV };
