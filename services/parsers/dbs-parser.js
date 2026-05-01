'use strict';
/**
 * DBS Parser — PH_DGIDBS_1 (Daily Business Summary)
 * Parses the DBS Excel export, detects store hierarchy from row context,
 * extracts Tier 1 hard flags and Tier 2 soft indicators.
 * Also populates store_assignments with area/region/VP mapping.
 */
const XLSX = require('xlsx');
const db   = require('../db');

// Build hierarchy lookup from USER_ROSTER — DBS file goes VP → AC directly,
// so positional depthStack counting misidentifies AC rows as region_coach.
const VP_NAMES        = new Set();
const RDO_NAMES       = new Set();
const AC_TO_HIERARCHY = {};
try {
  const { USER_ROSTER } = require('../../routes/auth');
  for (const u of USER_ROSTER) {
    if (u.role === 'vp') { VP_NAMES.add(u.name); }
    else if (u.role === 'rdo') {
      RDO_NAMES.add(u.scope.rc_name);
      if (u.scope.vp) VP_NAMES.add(u.scope.vp);
      for (const ac of (u.scope.area_coaches || [])) {
        AC_TO_HIERARCHY[ac] = { rc: u.scope.rc_name, vp: u.scope.vp };
      }
    }
  }
} catch (_) {}

// ── Columns (0-indexed, confirmed from actual file) ──────────────────────────
// Section 1 (Operations) — identified when col[4] header = "Net Sales $"
const S1 = {
  NET_SALES_DAY : 4,  NET_SALES_WTD: 5,  NET_SALES_PTD: 6,
  GROWTH_DAY    :11,  GROWTH_WTD   :12,  GROWTH_PTD   :13,
  PROD_LT15_DAY :29,
  DISCOUNT_DAY  : 6,  // Section 2 col indices below
};
// Section 2 (Financial/Labor) — identified when col[4] header = "Change Down $"
const S2 = {
  CHANGE_DOWN   : 4,
  ALLOWANCE     : 5,
  DISCOUNT      : 6,
  CANCEL_UNMADE : 8,
  PAIDOUTS      :27,
  REFUNDS       :28,
  CREDITS       :29,
  CASH_VAR_DAY  :31,
  CASH_VAR_WTD  :32,
};

function cellVal(row, idx) {
  const v = row[idx];
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$,%]/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? v : n;
}

function absVal(v) { return v != null ? Math.abs(v) : null; }

// Extract store_id and store_name from "S039377 - Griffin"
function parseStoreRow(colA) {
  const m = String(colA).match(/^S(\d+)\s*-\s*(.+)$/);
  if (!m) return null;
  return { store_id: m[1], store_name: m[2].trim() };
}

function isStoreRow(colA) {
  return colA != null && /^S\d{5,}/.test(String(colA).trim());
}
function isSectionHeader(colA, colE) {
  return (!colA || String(colA).trim() === '') && colE != null &&
    (String(colE).trim() === 'Net Sales $' || String(colE).trim() === 'Change Down $');
}
function isGroupLabel(colA, colE) {
  return colA && String(colA).trim() !== '' && !isStoreRow(colA) &&
    (colE == null || String(colE).trim() === '');
}
function isSubtotal(colA) {
  const s = String(colA || '').trim();
  return s === 'Report Total' || s === 'Total' || s.startsWith('Report By:');
}

/**
 * Parse DBS Excel file.
 * Returns { storeFlags: [], softIndicators: [], assignments: [] }
 */
function parseDBS(filePath, targetDate) {
  const wb   = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const storeFlags     = [];  // Tier 1 flag records
  const softIndicators = [];  // Tier 2 soft indicator records
  const assignments    = [];  // store → area/region/VP mappings
  const storeMetrics   = {};  // store_id → raw KPI snapshot (for intel_dbs_metrics)

  let currentSection  = null; // 'operations' | 'financial'
  let currentArea     = null;
  let currentRegion   = null;
  let currentVP       = null;

  for (const row of rows) {
    const colA = row[0];
    const colE = row[4];

    // Stop at footer
    if (colA && String(colA).trim().startsWith('Report By:')) break;

    // Section header detection
    if (isSectionHeader(colA, colE)) {
      const hdr = String(colE).trim();
      currentSection = hdr === 'Net Sales $' ? 'operations' : 'financial';
      continue;
    }

    // Skip subtotals
    if (isSubtotal(colA)) continue;

    // Grouping label — classify by name, not by position.
    if (isGroupLabel(colA, colE)) {
      const label = String(colA).trim();
      if (VP_NAMES.has(label)) {
        currentVP = label; currentRegion = null; currentArea = null;
      } else if (RDO_NAMES.has(label)) {
        currentRegion = label; currentArea = null;
      } else {
        currentArea = label;
        const hier = AC_TO_HIERARCHY[label];
        if (hier) { currentRegion = hier.rc; currentVP = hier.vp; }
      }
      continue;
    }

    // Store row
    if (isStoreRow(colA)) {
      const parsed = parseStoreRow(colA);
      if (!parsed) continue;
      const { store_id, store_name } = parsed;

      // Always resolve RC and VP from USER_ROSTER lookup — DBS file grouping structure
      // cannot be trusted (VPs appear as intermediate labels under other VPs, etc.)
      const hier = AC_TO_HIERARCHY[currentArea] || {};
      const resolvedRC = hier.rc || currentRegion;
      const resolvedVP = hier.vp || currentVP;

      // Record assignment
      assignments.push({ store_id, store_name, area_coach: currentArea, region_coach: resolvedRC, vp: resolvedVP });

      if (currentSection === 'financial') {
        // ── Tier 1 Hard Flags ──────────────────────────────────────────────
        const changeDown   = cellVal(row, S2.CHANGE_DOWN);
        const changedMiles = cellVal(row, 25); // col Z
        const paidouts     = cellVal(row, S2.PAIDOUTS);
        const cashVar      = cellVal(row, S2.CASH_VAR_DAY);
        const refunds      = cellVal(row, S2.REFUNDS);
        const cancelUnmade = cellVal(row, S2.CANCEL_UNMADE);

        const base = { store_id, store_name, area_coach: currentArea, region_coach: resolvedRC,
                       territory_vp: resolvedVP, metric_date: targetDate, source: 'DBS', tier: 1 };

        // Capture raw KPI snapshot — merged with ops section data below
        if (!storeMetrics[store_id]) storeMetrics[store_id] = { store_id, store_name, area_coach: currentArea, region_coach: resolvedRC, territory_vp: resolvedVP, metric_date: targetDate };
        Object.assign(storeMetrics[store_id], {
          change_down_day:   changeDown,
          allowance_pct_day: cellVal(row, S2.ALLOWANCE),
          discount_pct_day:  cellVal(row, S2.DISCOUNT),
          cancel_unmade_day: cancelUnmade,
          changed_miles_day: changedMiles,
          paidouts_day:      paidouts,
          refunds_day:       refunds,
          cash_variance_day: cashVar,
        });

        if (changeDown != null && changeDown > 30) {
          storeFlags.push({ ...base, metric_type: 'CHANGE_DOWN', value: changeDown, target: 30, variance: changeDown - 30 });
        }
        if (changedMiles != null && changedMiles !== 0) {
          storeFlags.push({ ...base, metric_type: 'CHANGED_MILES', value: changedMiles, target: 0, variance: changedMiles });
        }
        if (paidouts != null && paidouts !== 0) {
          storeFlags.push({ ...base, metric_type: 'PAIDOUT', value: paidouts, target: 0, variance: paidouts });
        }
        if (cashVar != null && absVal(cashVar) > 50) {
          storeFlags.push({ ...base, metric_type: 'CASH_VARIANCE', value: cashVar, target: 50, variance: absVal(cashVar) - 50 });
        }
        if (refunds != null && refunds > 20) {
          storeFlags.push({ ...base, metric_type: 'REFUNDS', value: refunds, target: 20, variance: refunds - 20 });
        }
        if (cancelUnmade != null && cancelUnmade > 50) {
          storeFlags.push({ ...base, metric_type: 'CANCEL_UNMADE', value: cancelUnmade, target: 50, variance: cancelUnmade - 50 });
        }

        // ── Tier 2 Soft: Discount % ────────────────────────────────────────
        const discount = cellVal(row, S2.DISCOUNT);
        if (discount != null && discount > 1.5) {
          softIndicators.push({ store_id, metric_date: targetDate, indicator: 'discount_pct', value: discount, target: 1.5, source: 'DBS' });
        }

        // ── Tier 2 Soft: Allowance % vs area avg (stored raw, compared later) ──
        const allowance = cellVal(row, S2.ALLOWANCE);
        if (allowance != null) {
          softIndicators.push({ store_id, metric_date: targetDate, indicator: 'allowance_pct', value: allowance, target: null, source: 'DBS' });
        }
      }

      if (currentSection === 'operations') {
        // ── Raw KPI: net sales + growth ────────────────────────────────────
        const netSalesDay = cellVal(row, S1.NET_SALES_DAY);
        const netSalesWtd = cellVal(row, S1.NET_SALES_WTD);
        const netSalesPtd = cellVal(row, S1.NET_SALES_PTD);
        if (!storeMetrics[store_id]) storeMetrics[store_id] = { store_id, store_name, area_coach: currentArea, region_coach: resolvedRC, territory_vp: resolvedVP, metric_date: targetDate };
        Object.assign(storeMetrics[store_id], { net_sales_day: netSalesDay, net_sales_wtd: netSalesWtd, net_sales_ptd: netSalesPtd });

        // ── Tier 2 Soft: Sales Growth % ───────────────────────────────────
        const growthDay = cellVal(row, S1.GROWTH_DAY);
        if (growthDay != null) storeMetrics[store_id].growth_pct_day = growthDay;
        if (growthDay != null && growthDay < 0) {
          softIndicators.push({ store_id, metric_date: targetDate, indicator: 'growth_pct_day', value: growthDay, target: 0, source: 'DBS' });
        }
        // ── Tier 2 Soft: Production < 15% score ───────────────────────────
        const prodLt15 = cellVal(row, S1.PROD_LT15_DAY);
        if (prodLt15 != null) storeMetrics[store_id].production_lt15_day = prodLt15;
        if (prodLt15 != null && prodLt15 <= 55) {
          softIndicators.push({ store_id, metric_date: targetDate, indicator: 'production_lt15', value: prodLt15, target: 60, source: 'DBS' });
        }
      }
    }
  }

  return { storeFlags, softIndicators, assignments, storeMetrics: Object.values(storeMetrics) };
}

/**
 * Main entry point: parse file, write to DB.
 */
async function processDBS(filePath, targetDate) {
  console.log(`[DBS] Parsing ${filePath} for ${targetDate}`);
  let result;
  try {
    result = parseDBS(filePath, targetDate);
  } catch (err) {
    console.error('[DBS] Parse error:', err.message);
    return { success: false, error: err.message };
  }

  const { storeFlags, softIndicators, assignments, storeMetrics } = result;
  console.log(`[DBS] Found: ${assignments.length} store assignments, ${storeFlags.length} flags, ${softIndicators.length} soft indicators`);

  // Write assignments (authoritative hierarchy for all other parsers)
  for (const a of assignments) {
    await db.upsertStoreAssignment(a);
  }

  // Clear any existing DBS flags for this date before re-inserting (prevents stacking on re-runs)
  const pool = db.getPool();
  if (pool) {
    await pool.query('DELETE FROM intel_flags WHERE metric_date = $1 AND source = $2', [targetDate, 'DBS']);
    console.log(`[DBS] Cleared existing DBS flags for ${targetDate}`);
  }

  // Write raw KPI snapshots (powers the performance dashboard)
  let metricsWritten = 0;
  for (const m of storeMetrics) {
    await db.upsertDBSMetrics(m);
    metricsWritten++;
  }

  // Write Tier 1 flags with consecutive day logic
  let flagsWritten = 0;
  for (const flag of storeFlags) {
    const prevDays = await db.getConsecutiveDays(flag.store_id, flag.metric_type, flag.metric_date);
    const consecutiveDays = prevDays + 1;
    const severity = consecutiveDays >= 4 ? 'high' : consecutiveDays >= 2 ? 'medium' : 'low';
    await db.insertIntelFlag({ ...flag, consecutive_days_out: consecutiveDays, severity, is_new: prevDays === 0 });
    flagsWritten++;
  }

  // Write soft indicators
  for (const si of softIndicators) {
    await db.upsertSoftIndicator(si);
  }

  console.log(`[DBS] Done — ${metricsWritten} KPI rows, ${flagsWritten} flags written`);
  return { success: true, assignmentsWritten: assignments.length, metricsWritten, flagsWritten, softIndicatorsWritten: softIndicators.length };
}

module.exports = { processDBS, parseDBS };
