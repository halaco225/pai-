'use strict';
/**
 * Forgot to Clock Out Parser — PH_ForgotToClockOut (OneData Payroll)
 *
 * ⚠️  CRITICAL: Column index 3 contains SSN. NEVER write it to DB. Ever.
 *
 * Col map (0-indexed):
 *  0=Store#  1=FirstName  2=LastName  3=SSN(SKIP)  4=JobCode
 *  5=PunchIn  6=PunchOut(always 03:59:59 next day)
 *  7=AdjDate  8=AdjPunchIn  9=AdjPunchOut
 */
const XLSX = require('xlsx');
const db   = require('../db');

function padStoreId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\D/g,'');
  return s.padStart(6, '0');
}

function parseDate(v) {
  if (v == null || String(v).trim() === '') return null;
  return String(v).trim();
}

// Estimate hours worked from punch-in to midnight of that day
function estimateHours(punchInStr) {
  if (!punchInStr) return null;
  try {
    const d = new Date(punchInStr);
    if (isNaN(d.getTime())) return null;
    const midnight = new Date(d);
    midnight.setHours(23, 59, 0, 0);
    const hrs = (midnight - d) / 3600000;
    return hrs > 0 ? parseFloat(hrs.toFixed(1)) : null;
  } catch (_) { return null; }
}

function parseForgotClockOut(filePath) {
  const wb   = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const records = [];
  // Data starts at row 5 (0-indexed: row[5])
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const storeRaw = row[0];
    if (!storeRaw || String(storeRaw).trim() === '' || String(storeRaw).trim() === 'Store Number') continue;

    const store_id    = padStoreId(storeRaw);
    if (!store_id) continue;

    const first_name  = String(row[1] || '').trim();
    const last_name   = String(row[2] || '').trim();
    // row[3] = SSN — read only to confirm row structure, NEVER stored
    const _ssnPresent = row[3] != null; // just confirm column exists, discard value
    const job_code    = row[4] != null ? String(row[4]).trim() : null;
    const punch_in    = parseDate(row[5]);
    // row[6] = punch_out — always 03:59:59 next day, confirms never clocked out
    const adj_date    = parseDate(row[7]); // blank = not corrected yet
    // row[8], row[9] = corrected timestamps (only if adjusted)

    records.push({
      store_id,
      first_name,
      last_name,
      job_code,
      punch_in,
      is_corrected: adj_date != null && adj_date !== '',
    });
  }
  return records;
}

async function processForgotClockOut(filePath, targetDate) {
  console.log(`[ClockOut] Parsing ${filePath} for ${targetDate}`);
  let records;
  try {
    records = parseForgotClockOut(filePath);
  } catch (err) {
    console.error('[ClockOut] Parse error:', err.message);
    return { success: false, error: err.message };
  }

  console.log(`[ClockOut] ${records.length} records found`);
  const assignments = await db.getStoreAssignments();

  // Group uncorrected records by store
  const byStore = {};
  for (const r of records) {
    if (r.is_corrected) continue;
    if (!byStore[r.store_id]) byStore[r.store_id] = [];
    byStore[r.store_id].push(r);
  }

  let flagsWritten = 0;
  for (const [store_id, employees] of Object.entries(byStore)) {
    const asgn = assignments[store_id] || {};
    const severity = employees.length >= 3 ? 'high' : 'medium';
    const prevDays = await db.getConsecutiveDays(store_id, 'FORGOT_CLOCKOUT', targetDate);

    // Build employee list — names + estimated hours, no SSN
    const empList = employees.map(e => ({
      name:      `${e.first_name} ${e.last_name}`.trim(),
      punch_in:  e.punch_in,
      job_code:  e.job_code,
      hours_est: estimateHours(e.punch_in),
    }));

    await db.insertIntelFlag({
      store_id,
      store_name:   asgn.store_name,
      area_coach:   asgn.area_coach,
      region_coach: asgn.region_coach,
      territory_vp: asgn.vp,
      metric_type:  'FORGOT_CLOCKOUT',
      metric_date:  targetDate,
      value:        employees.length,
      target:       0,
      variance:     employees.length,
      source:       'ONEDATA_PAYROLL',
      tier:         1,
      details:      { employees: empList, uncorrected_count: employees.length },
      consecutive_days_out: prevDays + 1,
      severity,
      is_new:       prevDays === 0,
    });
    flagsWritten++;
  }

  console.log(`[ClockOut] Done — ${flagsWritten} stores flagged`);
  return { success: true, recordsProcessed: records.length, flagsWritten };
}

module.exports = { processForgotClockOut };
