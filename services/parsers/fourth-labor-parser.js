'use strict';
/**
 * Fourth Analytics Labor Parser — Overview Report By Location
 * Col map (0-indexed):
 *  0=Location  1=A/F Sales  2=Fcst Sales  3=Sales Var
 *  4=Act Lab$  5=Sch Lab$   6=Lab$ Var
 *  7=Act Lab%  8=Sch Lab%   9=Lab% Var
 * 10=Act Hrs  11=Sch Hrs   12=Hrs Var
 *
 * FLAG RULES (Fri-Sun only):
 *  - LABOR_NOT_ADJUSTED: Sales Var < 0 AND Hrs Var > 10
 *  - LABOR_OVER_BUDGET:  Lab$ Var > +$200
 *  - LABOR_UNDER_BUDGET: Lab$ Var < -$200
 * Mon-Thu: informational only (soft indicators for display, no flags)
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
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const stores = [];
  // Data starts at row index 3 (0-based), skip header rows and rollup
  for (let i = 3; i < rows.length; i++) {
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
  // DOW check
  const dow = new Date(targetDate + 'T12:00:00Z').getUTCDay(); // 0=Sun,5=Fri,6=Sat
  const flaggingActive = dow === 0 || dow >= 5; // Fri, Sat, Sun

  let stores;
  try {
    stores = parseFourthLaborFile(filePath);
  } catch (err) {
    console.error('[FourthLabor] Parse error:', err.message);
    return { success: false, error: err.message };
  }

  console.log(`[FourthLabor] ${stores.length} stores, flagging=${flaggingActive}`);
  const assignments = await db.getStoreAssignments();
  let flagsWritten = 0;

  for (const s of stores) {
    const asgn = assignments[s.store_id] || {};
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
      sales_var:      s.sales_var,
      sales_var_pct:  s.fcst_sales ? (s.sales_var / s.fcst_sales) : null,
      labor_dollar_var: s.lab_dollar_var,
      hours_var:      s.hrs_var,
      act_labor_pct:  s.act_lab_pct,
      sch_labor_pct:  s.sch_lab_pct,
      day_of_week:    dow,
    };

    if (!flaggingActive) {
      // Mon-Thu: store as soft indicators for display
      if (s.sales_var != null) {
        await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
          indicator: 'fourth_sales_var', value: s.sales_var, target: 0, source: 'FOURTH' });
      }
      continue;
    }

    // ── FLAG 1: Scissors Pattern — Sales down, Hours over ────────────────
    if (s.sales_var != null && s.hrs_var != null && s.sales_var < 0 && s.hrs_var > 10) {
      const severity = s.hrs_var > 20 ? 'high' : 'medium';
      const prevDays = await db.getConsecutiveDays(s.store_id, 'LABOR_NOT_ADJUSTED', targetDate);
      await db.insertIntelFlag({
        ...base, metric_type: 'LABOR_NOT_ADJUSTED',
        value: s.hrs_var, target: 0, variance: s.hrs_var,
        consecutive_days_out: prevDays + 1, severity, is_new: prevDays === 0, details,
      });
      flagsWritten++;
    }

    // ── FLAG 2: Labor $ over $200 either direction ────────────────────────
    if (s.lab_dollar_var != null) {
      if (s.lab_dollar_var > 200) {
        const prevDays = await db.getConsecutiveDays(s.store_id, 'LABOR_OVER_BUDGET', targetDate);
        await db.insertIntelFlag({
          ...base, metric_type: 'LABOR_OVER_BUDGET',
          value: s.lab_dollar_var, target: 200, variance: s.lab_dollar_var - 200,
          consecutive_days_out: prevDays + 1, severity: 'medium', is_new: prevDays === 0, details,
        });
        flagsWritten++;
      } else if (s.lab_dollar_var < -200) {
        const prevDays = await db.getConsecutiveDays(s.store_id, 'LABOR_UNDER_BUDGET', targetDate);
        await db.insertIntelFlag({
          ...base, metric_type: 'LABOR_UNDER_BUDGET',
          value: s.lab_dollar_var, target: -200, variance: s.lab_dollar_var + 200,
          consecutive_days_out: prevDays + 1, severity: 'medium', is_new: prevDays === 0, details,
        });
        flagsWritten++;
      }
    }

    // ── FLAG 3: Sales miss -5%+ by Friday ────────────────────────────────
    const salesVarPct = s.fcst_sales ? (s.sales_var / s.fcst_sales) : null;
    if (salesVarPct != null && salesVarPct <= -0.05) {
      await db.upsertSoftIndicator({ store_id: s.store_id, metric_date: targetDate,
        indicator: 'sales_miss_pct', value: salesVarPct, target: -0.05, source: 'FOURTH' });
    }
  }

  console.log(`[FourthLabor] Done — ${flagsWritten} flags written`);
  return { success: true, storesProcessed: stores.length, flagsWritten };
}

module.exports = { processFourthLabor, parseFourthLaborFile };
