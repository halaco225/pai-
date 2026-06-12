'use strict';
/**
 * Fourth Analytics Labor Parser — Overview Report By Location
 * Col map (0-indexed):
 *  0=Location  1=A/F Sales  2=Fcst Sales  3=Sales Var
 *  4=Act Lab$  5=Sch Lab$   6=Lab$ Var
 *  7=Act Lab%  8=Sch Lab%   9=Lab% Var
 * 10=Act Hrs  11=Sch Hrs   12=Hrs Var
 *
 * FLAG RULES (every day):
 *  - LABOR_OVER_BUDGET: Act Lab$ > Sch Lab$ (any positive variance)
 *    Severity: high if >$200, medium if >$50, low otherwise
 *  Negative variance (under budget) = good, no flag.
 */
const XLSX = require('xlsx');
const db   = require('../db');

// "(038876) Senoia - Pizza Hut" → { store_id: "038876", store_name: "Senoia" }
function parseLocation(loc) {
  if (!loc) return null;
  const m = String(loc).match(/\((\d+)\)\s*([^-]+)/);
  if (!m) return null;
  return { store_id: m[1].trim(), store_name: m[2].trim().split(' - ')[0].trim() };
}

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,%]/g,'').trim());
  return isNaN(n) ? null : n;
}

// Scan header row to find actual column indices by keyword.
// Skip FOH/BOH/LY sub-columns — we only want the total labor columns.
function detectColumns(rows) {
  // GoodData "Overview by Location" report structure (confirmed from live API response):
  //  0=Location  1=Week  2=A/F Sales  3=LY Sales
  //  4=Frct Hours  5=Sch Hours  6=Act Hours
  //  7=Sch Labor $  8=Act Labor $
  //  9..=FOH/BOH breakdowns (skip these)
  const cols = { af_sales: 2, sch_hrs: 5, act_hrs: 6, sch_lab_dollar: 7, act_lab_dollar: 8,
                 lab_dollar_var: null, act_lab_pct: null, sch_lab_pct: null };
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r];
    if (!row) continue;
    let found = false;
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!cell) continue;
      // Skip FOH, BOH, LY sub-columns — only map top-level totals
      if (cell.includes('foh') || cell.includes('boh') || cell.startsWith('ly ') || cell.includes(' ly ')) continue;
      if (cell === 'act labor $' || cell === 'act lab $' || cell === 'actual labor $') { cols.act_lab_dollar = c; found = true; }
      else if (cell === 'sch labor $' || cell === 'sch lab $' || cell === 'sched labor $' || cell === 'scheduled labor $') { cols.sch_lab_dollar = c; found = true; }
      else if (cell === 'act hours' || cell === 'act hrs' || cell === 'actual hours') { cols.act_hrs = c; }
      else if (cell === 'sch hours' || cell === 'sch hrs' || cell === 'sched hours' || cell === 'scheduled hours') { cols.sch_hrs = c; }
      else if ((cell.includes('a/f') || cell.includes('af ')) && cell.includes('sales')) { cols.af_sales = c; }
      else if (cell.includes('act') && cell.includes('lab') && cell.includes('%') && !cell.includes('var')) { cols.act_lab_pct = c; found = true; }
      else if ((cell.includes('sch') || cell.includes('sched')) && cell.includes('lab') && cell.includes('%') && !cell.includes('var')) { cols.sch_lab_pct = c; found = true; }
    }
    if (found) {
      console.log(`[FourthLabor] Header detected at row ${r}:`, JSON.stringify(cols));
      break;
    }
  }
  return cols;
}

function parseFourthLaborFile(filePath) {
  const wb   = XLSX.readFile(filePath, { cellDates: false, raw: true });
  console.log('[FourthLabor] SheetNames:', wb.SheetNames);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  console.log('[FourthLabor] Total rows:', rows.length);
  console.log('[FourthLabor] Row0:', JSON.stringify((rows[0] || []).slice(0, 15)));
  console.log('[FourthLabor] Row1:', JSON.stringify((rows[1] || []).slice(0, 15)));
  console.log('[FourthLabor] Row2:', JSON.stringify((rows[2] || []).slice(0, 15)));
  console.log('[FourthLabor] Row3:', JSON.stringify((rows[3] || []).slice(0, 15)));
  console.log('[FourthLabor] Row4:', JSON.stringify((rows[4] || []).slice(0, 15)));

  const C = detectColumns(rows);

  const storeRows = [];
  let dataStart = 3;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i] && rows[i][0] && parseLocation(rows[i][0])) { dataStart = i; break; }
  }
  if (dataStart !== 3) console.log(`[FourthLabor] Data start auto-detected at row ${dataStart} (expected 3)`);
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0] || String(row[0]).trim() === 'Rollup' || String(row[0]).trim() === 'Location') continue;
    const loc = parseLocation(row[0]);
    if (!loc) continue;
    const af_sales       = num(row[C.af_sales]);
    const act_lab_dollar = num(row[C.act_lab_dollar]);
    const sch_lab_dollar = num(row[C.sch_lab_dollar]);
    const act_hrs        = num(row[C.act_hrs]);
    const sch_hrs        = num(row[C.sch_hrs]);
    // Compute derived values not present in this report format
    const lab_dollar_var = (act_lab_dollar != null && sch_lab_dollar != null) ? Math.round((act_lab_dollar - sch_lab_dollar) * 100) / 100 : null;
    const hrs_var        = (act_hrs != null && sch_hrs != null) ? Math.round((act_hrs - sch_hrs) * 100) / 100 : null;
    // Labor % — read from report if available, otherwise compute from dollars/sales
    let act_lab_pct = C.act_lab_pct != null ? num(row[C.act_lab_pct]) : null;
    let sch_lab_pct = C.sch_lab_pct != null ? num(row[C.sch_lab_pct]) : null;
    if (act_lab_pct == null && act_lab_dollar != null && af_sales && af_sales > 0) {
      act_lab_pct = Math.round((act_lab_dollar / af_sales) * 1000) / 10;
    }
    if (sch_lab_pct == null && sch_lab_dollar != null && af_sales && af_sales > 0) {
      sch_lab_pct = Math.round((sch_lab_dollar / af_sales) * 1000) / 10;
    }
    storeRows.push({
      ...loc,
      af_sales, fcst_sales: af_sales, sales_var: null,
      act_lab_dollar, sch_lab_dollar, lab_dollar_var,
      act_lab_pct, sch_lab_pct, lab_pct_var: null,
      act_hrs, sch_hrs, hrs_var,
    });
  }
  // Dedup by store_id — report has one row per store per week, keep the row with most non-null data
  const bestByStore = {};
  for (const s of storeRows) {
    const score = [s.act_lab_dollar, s.sch_lab_dollar, s.act_hrs, s.sch_hrs].filter(v => v != null).length;
    if (!bestByStore[s.store_id] || score > bestByStore[s.store_id]._score) {
      bestByStore[s.store_id] = { ...s, _score: score };
    }
  }
  const stores = Object.values(bestByStore).map(({ _score, ...s }) => s);
  console.log(`[FourthLabor] ${storeRows.length} raw rows → ${stores.length} unique stores after dedup`);

  // Return debug metadata alongside stores so processFourthLabor can log it
  stores._debug = {
    column_map: C,
    header_rows: rows.slice(0, 5).map(r => (r || []).slice(0, 15)),
    first_data_row: (rows[dataStart] || []).slice(0, 15),
  };
  return stores;
}

async function processFourthLabor(filePath, targetDate) {
  console.log(`[FourthLabor] Parsing ${filePath} for ${targetDate}`);
  const dow = new Date(targetDate + 'T12:00:00Z').getUTCDay();

  let stores;
  try {
    stores = parseFourthLaborFile(filePath);
  } catch (err) {
    console.error('[FourthLabor] Parse error:', err.message);
    return { success: false, error: err.message };
  }

  console.log(`[FourthLabor] ${stores.length} stores`);

  // Debug: log column map, raw header rows, and parsed sample to diagnose column mapping
  const dbg = stores._debug || {};
  const debugStores = stores.filter(s => ['042659','039522','039461'].includes(s.store_id)).slice(0, 3);
  await db.logIntelJob({ jobType: 'debug:fourthLabor_sample', targetDate, status: 'info',
    message: JSON.stringify({
      column_map: dbg.column_map,
      header_rows: dbg.header_rows,
      first_data_row: dbg.first_data_row,
      total_stores: stores.length,
      sample: (debugStores.length ? debugStores : stores.slice(0, 3)).map(s => ({
        store_id: s.store_id, store_name: s.store_name,
        act_lab_dollar: s.act_lab_dollar, sch_lab_dollar: s.sch_lab_dollar,
        lab_dollar_var: s.lab_dollar_var,
        act_lab_pct: s.act_lab_pct, sch_lab_pct: s.sch_lab_pct,
        act_hrs: s.act_hrs, sch_hrs: s.sch_hrs,
      })),
    }) });

  const assignments = await db.getStoreAssignments();
  let flagsWritten = 0;

  let skipped = 0;
  for (const s of stores) {
    const asgn = assignments[s.store_id];
    if (!asgn || !asgn.area_coach) { skipped++; continue; } // not an Ayvaz store
    const base = {
      store_id:     s.store_id,
      store_name:   s.store_name || asgn.store_name,
      area_coach:   asgn.area_coach,
      region_coach: asgn.region_coach,
      territory_vp: asgn.vp,
      metric_date:  targetDate,
      source:       'FOURTH',
      tier:         1,
    };
    const details = {
      sales_var:        s.sales_var,
      sales_var_pct:    s.fcst_sales ? (s.sales_var / s.fcst_sales) : null,
      labor_dollar_var: s.lab_dollar_var,
      hours_var:        s.hrs_var,
      act_labor_pct:    s.act_lab_pct,
      sch_labor_pct:    s.sch_lab_pct,
      act_lab_dollar:   s.act_lab_dollar,
      sch_lab_dollar:   s.sch_lab_dollar,
      day_of_week:      dow,
    };

    if (s.act_lab_pct != null) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'labor_pct', value: s.act_lab_pct, target: 28, source: 'FOURTH' });
    }
    if (s.sch_lab_pct != null) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'sch_labor_pct', value: s.sch_lab_pct, target: null, source: 'FOURTH' });
    }
    if (s.act_lab_dollar != null) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'act_lab_dollar', value: s.act_lab_dollar, target: null, source: 'FOURTH' });
    }
    if (s.sch_lab_dollar != null) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'sch_lab_dollar', value: s.sch_lab_dollar, target: null, source: 'FOURTH' });
    }
    if (s.act_hrs != null) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'act_labor_hrs', value: s.act_hrs, target: null, source: 'FOURTH' });
    }
    if (s.sch_hrs != null) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'sch_labor_hrs', value: s.sch_hrs, target: null, source: 'FOURTH' });
    }

    // Flag only when Act Lab$ >= $200 over scheduled (eliminates low-noise small variances)
    if (s.lab_dollar_var != null && s.lab_dollar_var >= 200) {
      const severity = s.lab_dollar_var >= 500 ? 'high' : 'medium';
      const prevDays = await db.getConsecutiveDays(s.store_id, 'LABOR_OVER_BUDGET', targetDate);
      await db.upsertIntelFlag({
        ...base, metric_type: 'LABOR_OVER_BUDGET',
        value: s.lab_dollar_var, target: 0, variance: s.lab_dollar_var,
        consecutive_days_out: prevDays + 1, severity, is_new: prevDays === 0, details,
      });
      flagsWritten++;
    }
  }

  const ayvazStores = stores.length - skipped;
  console.log(`[FourthLabor] Done — ${flagsWritten} flags written for ${ayvazStores} Ayvaz stores (${skipped} non-Ayvaz skipped)`);
  return { success: true, storesProcessed: ayvazStores, flagsWritten };
}

module.exports = { processFourthLabor, parseFourthLaborFile };
