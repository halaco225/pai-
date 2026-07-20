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

  console.log(`[ClockOut] ${rows.length} total rows, first 8 row-0 cells:`, JSON.stringify((rows[0]||[]).slice(0,8)));

  // Detect header row dynamically — look for row containing 'store' keyword
  let headerIdx = -1;
  let colStore=-1, colFirst=-1, colLast=-1, colJob=-1, colPunchIn=-1, colAdjDate=-1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const row = rows[i] || [];
    const lower = row.map(c => String(c||'').toLowerCase().trim());
    const si = lower.findIndex(c => c.includes('store'));
    if (si >= 0) {
      headerIdx = i;
      colStore   = si;
      colFirst   = lower.findIndex(c => c.includes('first'));
      colLast    = lower.findIndex(c => c.includes('last'));
      colJob     = lower.findIndex(c => c.includes('job') || c.includes('position'));
      colPunchIn = lower.findIndex(c => c.includes('punch') && (c.includes('in') || c.includes('date')));
      colAdjDate = lower.findIndex(c => c.includes('adj') || c.includes('correct') || c.includes('modified'));
      console.log(`[ClockOut] Header at row ${i}:`, JSON.stringify({colStore,colFirst,colLast,colJob,colPunchIn,colAdjDate}));
      break;
    }
  }

  // Fallback to original fixed-column layout if header not found
  if (headerIdx < 0) {
    console.log('[ClockOut] Header not detected — using fixed col layout (0,1,2,4,5,7)');
    headerIdx = 4;
    colStore=0; colFirst=1; colLast=2; colJob=4; colPunchIn=5; colAdjDate=7;
  }

  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const storeRaw = row[colStore];
    if (!storeRaw || String(storeRaw).trim() === '' || String(storeRaw).trim() === 'Store Number') continue;

    const store_id = padStoreId(storeRaw);
    if (!store_id) continue;

    const first_name = colFirst >= 0 ? String(row[colFirst] || '').trim() : '';
    const last_name  = colLast  >= 0 ? String(row[colLast]  || '').trim() : '';
    const job_code   = colJob   >= 0 && row[colJob] != null ? String(row[colJob]).trim() : null;
    const punch_in   = colPunchIn >= 0 ? parseDate(row[colPunchIn]) : null;
    // SSN is always col 3 in known layout — never stored
    const adj_date   = colAdjDate >= 0 ? parseDate(row[colAdjDate]) : null;

    records.push({
      store_id, first_name, last_name, job_code, punch_in,
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

  const corrected = records.filter(r => r.is_corrected).length;
  console.log(`[ClockOut] ${records.length} records found — ${corrected} corrected, ${records.length - corrected} uncorrected`);
  if (records.length === 0) console.log('[ClockOut] WARNING: zero records parsed — check row offset or report format');
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
