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

function parseFourthLaborFile(filePath) {
  const wb   = XLSX.readFile(filePath, { cellDates: false, raw: true });
  console.log('[FourthLabor] SheetNames:', wb.SheetNames);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  console.log('[FourthLabor] Total rows:', rows.length, '| First 5 rows:', JSON.stringify(rows.slice(0, 5)));
  const stores = [];
  // Data starts at row index 3 (0-based), skip header rows and rollup
  // Auto-detect: if row 3 col 0 doesn't match, scan for the first row matching (NNNNNN)
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
    stores.push({
      ...loc,
      af_sales:      num(row[1]),
      fcst_sales:    num(row[2]),
      sales_var:     num(row[3]),
      act_lab_dollar: num(row[4]),
      sch_lab_dollar: num(row[5]),
      lab_dollar_var: num(row[6]),
      act_lab_pct:   num(row[7]),
      sch_lab_pct:   num(row[8]),
      lab_pct_var:   num(row[9]),
      act_hrs:       num(row[10]),
      sch_hrs:       num(row[11]),
      hrs_var:       num(row[12]),
    });
  }
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
    if (s.act_lab_dollar != null) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'act_lab_dollar', value: s.act_lab_dollar, target: null, source: 'FOURTH' });
    }
    if (s.sch_lab_dollar != null) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'sch_lab_dollar', value: s.sch_lab_dollar, target: null, source: 'FOURTH' });
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
