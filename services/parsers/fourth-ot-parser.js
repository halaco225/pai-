'use strict';
/**
 * Fourth Analytics OT Parser — Overtime / Double Time / Special By Location
 * Run schedule: Sunday and Monday ONLY
 * Col map (0-indexed):
 *  0=Location  1=Act OT Hrs  2=Sch OT Hrs  3=Var Hrs  4=Var%
 *  5=Act OT$   6=Sch OT$     7=Var$        8=Var%
 *  9=DT Hrs   10=DT$        11=Special$   12=Special Hrs
 */
const XLSX = require('xlsx');
const db   = require('../db');

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

async function processFourthOT(filePath, targetDate) {
  console.log(`[FourthOT] Parsing ${filePath} for ${targetDate}`);
  // Only runs Sun (0) and Mon (1)
  const dow = new Date(targetDate + 'T12:00:00Z').getUTCDay();
  if (dow !== 0 && dow !== 1) {
    console.log('[FourthOT] Skipped — only runs Sun/Mon');
    return { success: true, skipped: true };
  }

  let wb, rows;
  try {
    wb   = require('xlsx').readFile(filePath, { cellDates: false, raw: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = require('xlsx').utils.sheet_to_json(ws, { header: 1, defval: null });
  } catch (err) {
    console.error('[FourthOT] Parse error:', err.message);
    return { success: false, error: err.message };
  }

  const assignments = await db.getStoreAssignments();
  let flagsWritten = 0;

  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0] || String(row[0]).trim() === 'Rollup' || String(row[0]).trim() === 'Location') continue;
    const loc = parseLocation(row[0]);
    if (!loc) continue;

    const s = {
      ...loc,
      act_ot_hrs: num(row[1]),
      sch_ot_hrs: num(row[2]),
      ot_var_hrs: num(row[3]),
      act_ot_dollar: num(row[5]),
      sch_ot_dollar: num(row[6]),
      dt_hrs:     num(row[9]),
      dt_dollar:  num(row[10]),
    };

    const asgn = assignments[s.store_id] || {};
    const base = {
      store_id:     s.store_id,
      store_name:   s.store_name || asgn.store_name,
      area_coach:   asgn.area_coach,
      region_coach: asgn.region_coach,
      territory_vp: asgn.vp,
      metric_date:  targetDate,
      source:       'FOURTH_OT',
      tier:         1,
    };
    const details = {
      act_ot_hrs:    s.act_ot_hrs,
      sch_ot_hrs:    s.sch_ot_hrs,
      ot_var_hrs:    s.ot_var_hrs,
      act_ot_dollar: s.act_ot_dollar,
      sch_ot_dollar: s.sch_ot_dollar,
      dt_hrs:        s.dt_hrs,
      dt_dollar:     s.dt_dollar,
    };

    // ── FLAG 1: Scheduled OT > 10 hrs ────────────────────────────────────
    if (s.sch_ot_hrs != null && s.sch_ot_hrs > 10) {
      const severity = s.sch_ot_hrs > 15 ? 'high' : 'medium';
      const prevDays = await db.getConsecutiveDays(s.store_id, 'OT_OVER_SCHEDULED', targetDate);
      await db.insertIntelFlag({
        ...base, metric_type: 'OT_OVER_SCHEDULED',
        value: s.sch_ot_hrs, target: 10, variance: s.sch_ot_hrs - 10,
        consecutive_days_out: prevDays + 1, severity, is_new: prevDays === 0, details,
      });
      flagsWritten++;
    }

    // ── FLAG 2: Actual OT exceeded scheduled ─────────────────────────────
    if (s.ot_var_hrs != null && s.ot_var_hrs > 5) {
      const severity = s.ot_var_hrs > 15 ? 'high' : 'medium';
      const prevDays = await db.getConsecutiveDays(s.store_id, 'OT_OVER_RUN', targetDate);
      await db.insertIntelFlag({
        ...base, metric_type: 'OT_OVER_RUN',
        value: s.ot_var_hrs, target: 0, variance: s.ot_var_hrs,
        consecutive_days_out: prevDays + 1, severity, is_new: prevDays === 0, details,
      });
      flagsWritten++;
    }

    // ── FLAG 3: Any double time ───────────────────────────────────────────
    if (s.dt_hrs != null && s.dt_hrs > 0) {
      const prevDays = await db.getConsecutiveDays(s.store_id, 'DOUBLE_TIME', targetDate);
      await db.insertIntelFlag({
        ...base, metric_type: 'DOUBLE_TIME',
        value: s.dt_hrs, target: 0, variance: s.dt_hrs,
        consecutive_days_out: prevDays + 1, severity: 'high', is_new: prevDays === 0, details,
      });
      flagsWritten++;
    }
  }

  console.log(`[FourthOT] Done — ${flagsWritten} flags written`);
  return { success: true, flagsWritten };
}

module.exports = { processFourthOT };
