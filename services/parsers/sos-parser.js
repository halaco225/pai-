'use strict';
/**
 * SOS Parser — PH_Speed_Of_Service
 * Columns confirmed from actual file (0-indexed):
 *  0=StoreID  3=OnTime%  8=IST  9=#Deliveries  11=MakeTime  13=%Make<4
 * 15=Oven/Cut  17=ProductionTime  19=%Prod<15  24=RackTime
 */
const XLSX = require('xlsx');
const db   = require('../db');

const COL = { STORE_ID:0, ON_TIME:3, IST:8, DELIVERIES:9, MAKE:11, PCT_MAKE_LT4:13,
              OVEN_CUT:15, PRODUCTION:17, PCT_PROD_LT15:19, RACK:24 };

function mmssToMinutes(s) {
  if (s == null) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) + parseInt(m[2]) / 60;
}

function pctToFloat(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace('%','').trim());
  return isNaN(n) ? null : n;
}

function parseSOSFile(filePath) {
  const wb   = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const stores = [];

  for (const row of rows) {
    const colA = row[COL.STORE_ID];
    if (!colA || !/^S\d{5,}/.test(String(colA).trim())) continue;

    const storeRaw = String(colA).trim();
    const store_id = storeRaw.replace(/^S/, '').split(' ')[0];

    const makeStr  = row[COL.MAKE];
    const prodStr  = row[COL.PRODUCTION];
    if (makeStr == null && prodStr == null) continue;

    const make_min = mmssToMinutes(makeStr);
    const prod_min = mmssToMinutes(prodStr);
    const ist_raw  = row[COL.IST];
    const ist_min  = ist_raw != null ? parseFloat(String(ist_raw).trim()) : null;

    stores.push({
      store_id,
      make_min,
      prod_min,
      ist_min,
      on_time_pct:     pctToFloat(row[COL.ON_TIME]),
      deliveries:      row[COL.DELIVERIES] != null ? parseInt(String(row[COL.DELIVERIES]).replace(/\D/g,'')) : null,
      pct_make_lt4:    pctToFloat(row[COL.PCT_MAKE_LT4]),
      pct_prod_lt15:   pctToFloat(row[COL.PCT_PROD_LT15]),
    });
  }
  return stores;
}

async function processSOS(filePath, targetDate) {
  console.log(`[SOS] Parsing ${filePath} for ${targetDate}`);
  let stores;
  try {
    stores = parseSOSFile(filePath);
  } catch (err) {
    console.error('[SOS] Parse error:', err.message);
    return { success: false, error: err.message };
  }

  console.log(`[SOS] ${stores.length} store rows found`);
  const assignments = await db.getStoreAssignments();

  let hardFlags = 0, softIndicators = 0;

  for (const s of stores) {
    const asgn = assignments[s.store_id] || {};
    const base = {
      store_id:     s.store_id,
      store_name:   asgn.store_name || null,
      area_coach:   asgn.area_coach || null,
      region_coach: asgn.region_coach || null,
      territory_vp: asgn.vp || null,
      metric_date:  targetDate,
      source:       'SOS',
    };

    // ── Tier 1 Hard Flag: Production > 20 min ────────────────────────────
    if (s.prod_min != null && s.prod_min > 20) {
      const prevDays = await db.getConsecutiveDays(s.store_id, 'PRODUCTION_TIME', targetDate);
      const consecutive = prevDays + 1;
      // Severity by value only — no day escalation; consecutive_days kept for trend display
      const severity = s.prod_min > 25 ? 'high' : 'medium';
      const details  = {
        label: s.prod_min > 25 ? 'critical' : null,
        pct_prod_lt15: s.pct_prod_lt15,
        trend_days: consecutive,
        trend_note: consecutive >= 2 ? `${consecutive}-day trend` : null,
      };
      await db.insertIntelFlag({
        ...base, tier: 1, metric_type: 'PRODUCTION_TIME',
        value: parseFloat(s.prod_min.toFixed(2)), target: 20.0,
        variance: parseFloat((s.prod_min - 20).toFixed(2)),
        consecutive_days_out: consecutive, severity, is_new: prevDays === 0,
        details,
      });
      hardFlags++;
    } else if (s.prod_min != null) {
      // Mark as recovered if previously flagged
      await db.resolveRecoveredFlags(s.store_id, 'PRODUCTION_TIME', targetDate);
    }

    // ── Soft Indicator: Make > 5 min ─────────────────────────────────────
    if (s.make_min != null && s.make_min > 5) {
      await db.upsertSoftIndicator({
        store_id:    s.store_id, metric_date: targetDate,
        indicator:   'make_time', value: parseFloat(s.make_min.toFixed(2)),
        target:      4.0, source: 'SOS',
      });
      softIndicators++;
    }

    // ── Soft Indicator: Production 15-20 min ─────────────────────────────
    if (s.prod_min != null && s.prod_min >= 15 && s.prod_min <= 20) {
      await db.upsertSoftIndicator({
        store_id:  s.store_id, metric_date: targetDate,
        indicator: 'production_time_soft', value: parseFloat(s.prod_min.toFixed(2)),
        target:    15.0, source: 'SOS',
      });
      softIndicators++;
    }
  }

  // After writing all SOS data, check for stacked soft flags (2+ indicators ≥3 days)
  await evaluateStackedSoftFlags(Object.keys(assignments), targetDate, assignments);

  console.log(`[SOS] Done — ${hardFlags} hard flags, ${softIndicators} soft indicators`);
  return { success: true, storesProcessed: stores.length, hardFlags, softIndicators };
}

/**
 * After both DBS and SOS soft indicators are written, check for stores where
 * 2+ soft indicators have been negative for 3+ consecutive days → PERFORMANCE_TREND flag.
 */
async function evaluateStackedSoftFlags(storeIds, targetDate, assignments) {
  let stackedFlags = 0;
  for (const store_id of storeIds) {
    const indicators = await db.getStoreSoftIndicators(store_id, 3);
    if (!indicators.length) continue;

    // Group by indicator name — count how many days each has been negative
    const byIndicator = {};
    for (const ind of indicators) {
      if (!byIndicator[ind.indicator]) byIndicator[ind.indicator] = new Set();
      byIndicator[ind.indicator].add(String(ind.metric_date).split('T')[0]);
    }

    // Count indicators with 3+ days of negative data
    const persistentNegative = Object.entries(byIndicator)
      .filter(([, dates]) => dates.size >= 3)
      .map(([name]) => name);

    if (persistentNegative.length < 2) continue;

    // Build stacked performance flag — severity by indicator count, not consecutive days
    const severity = persistentNegative.length >= 3 ? 'high' : 'medium';
    const asgn = assignments[store_id] || {};
    const prevDays = await db.getConsecutiveDays(store_id, 'PERFORMANCE_TREND', targetDate);

    const details = {
      indicators_negative: persistentNegative,
      consecutive_days: 3,
      indicator_count: persistentNegative.length,
      trend_days: prevDays + 1,
      trend_note: `${persistentNegative.length} indicator${persistentNegative.length !== 1 ? 's' : ''} negative for 3+ days`,
    };

    await db.insertIntelFlag({
      store_id, store_name: asgn.store_name, area_coach: asgn.area_coach,
      region_coach: asgn.region_coach, territory_vp: asgn.vp,
      metric_type: 'PERFORMANCE_TREND', metric_date: targetDate,
      value: persistentNegative.length, target: 2, variance: persistentNegative.length - 2,
      source: 'DBS+SOS', tier: 2, details,
      consecutive_days_out: prevDays + 1, severity,
      trend_direction: 'stable_out', is_new: prevDays === 0,
    });
    stackedFlags++;
  }
  if (stackedFlags > 0) console.log(`[SOS] ${stackedFlags} stacked PERFORMANCE_TREND flags created`);
}

module.exports = { processSOS, parseSOSFile };
