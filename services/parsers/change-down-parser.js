'use strict';
/**
 * Change Down Parser — PH_ChangeDownReport from ODS
 *
 * Flag rules:
 *  - CHANGE_DOWN_CASH    (high/red):    ticket amount >= $50 AND payment type is cash
 *  - CHANGE_DOWN_LARGE   (medium/yellow): ticket amount >= $50, non-cash
 *  - CHANGE_DOWN_PATTERN (medium/yellow, high if cash-heavy): same cashier 4+ times at same store in one day
 *
 * Details JSON stored for accordion drill-down:
 *  { tickets: [{ticket_id, amount, cashier_id, cashier_name, payment_type, time}],
 *    cashier_summary: [{cashier_id, cashier_name, count, cash_count, total_amount}] }
 */
const XLSX = require('xlsx');
const db   = require('../db');

const CASH_THRESHOLD   = 50;   // flag if change down >= $50
const PATTERN_MIN      = 4;    // flag cashier if they have this many or more in one day

// Column name patterns to search for (case-insensitive)
const COL_PATTERNS = {
  store:       /store|location/i,
  ticket:      /ticket|order|check/i,
  cashier:     /cashier|employee|emp.?id|empl/i,
  name:        /emp.*name|cashier.*name|name/i,
  amount:      /amount|change.*down|variance/i,
  payment:     /tender|payment|pay.*type|cash.*type/i,
  cancel_type: /cancel.*type|type.*cancel|action.*type|transaction.*type|cancel.*reason|reason/i,
  discount_type: /discount.*type|discount.*reason|promo.*type|coupon.*type|discount.*code|promo/i,
  time:        /time|date.*time/i,
  date:        /^date$/i,
};

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,()]/g, '').trim());
  return isNaN(n) ? null : Math.abs(n); // change downs are often negative
}

function isCash(paymentType) {
  if (!paymentType) return false;
  return /cash/i.test(String(paymentType));
}

function parseStoreId(val) {
  if (!val) return null;
  const m = String(val).match(/0*(\d{5,6})/);
  return m ? m[1].padStart(6, '0') : null;
}

function parseStoreName(val) {
  if (!val) return String(val || '');
  // Remove store number prefix like "(038876) Store Name" or "038876 - Store Name"
  return String(val).replace(/^\(?\d+\)?\s*[-–]?\s*/, '').trim();
}

function detectColumns(headerRow) {
  const cols = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] || '').trim();
    if (!h) continue;
    for (const [key, pattern] of Object.entries(COL_PATTERNS)) {
      if (pattern.test(h) && cols[key] == null) {
        cols[key] = i;
      }
    }
  }
  return cols;
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i];
    if (!r) continue;
    const vals = r.map(c => String(c || '').toLowerCase());
    if ((vals.some(v => /ticket|order|check/.test(v)) || vals.some(v => /cashier|employee/.test(v)))
        && vals.some(v => /amount|change/.test(v))) {
      return i;
    }
  }
  return 0;
}

async function processChangeDown(filePath, targetDate) {
  console.log(`[ChangeDown] Parsing ${filePath} for ${targetDate}`);

  let rows;
  try {
    const wb  = XLSX.readFile(filePath, { cellDates: false, raw: false });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  } catch (err) {
    console.error('[ChangeDown] Parse error:', err.message);
    return { success: false, error: err.message };
  }

  const headerIdx = findHeaderRow(rows);
  const cols      = detectColumns(rows[headerIdx] || []);
  console.log(`[ChangeDown] Header row: ${headerIdx}, columns:`, cols);

  if (cols.amount == null) {
    console.error('[ChangeDown] Could not detect amount column — check report format');
    return { success: false, error: 'Could not detect columns in Change Down report' };
  }

  // Parse data rows
  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const amount = num(row[cols.amount]);
    if (!amount || amount < 0.01) continue; // skip blank/zero rows

    const rawStore   = cols.store  != null ? row[cols.store]   : null;
    const storeId    = parseStoreId(rawStore);
    const storeName  = parseStoreName(rawStore);
    const ticketId   = cols.ticket  != null ? String(row[cols.ticket]  || '').trim() : '';
    const cashierId  = cols.cashier != null ? String(row[cols.cashier] || '').trim() : '';
    const cashierName= cols.name    != null ? String(row[cols.name]    || '').trim() : '';
    const payment      = cols.payment      != null ? String(row[cols.payment]      || '').trim() : '';
    const cancelType   = cols.cancel_type  != null ? String(row[cols.cancel_type]  || '').trim() : '';
    const discountType = cols.discount_type!= null ? String(row[cols.discount_type]|| '').trim() : '';
    const time         = cols.time    != null ? String(row[cols.time]    || '').trim()
                       : cols.date   != null ? String(row[cols.date]    || '').trim() : '';

    if (!storeId) continue;

    records.push({ storeId, storeName, ticketId, cashierId, cashierName, amount, payment, cancelType, discountType, time, isCash: isCash(payment) });
  }

  console.log(`[ChangeDown] ${records.length} records parsed`);
  if (!records.length) return { success: true, flagsWritten: 0, message: 'No records found' };

  // Load store assignments for hierarchy
  const assignments = await db.getStoreAssignments();

  // Group by store — Ayvaz stores only (skip any store not in store_assignments)
  const byStore = {};
  for (const r of records) {
    if (!assignments[r.storeId]) continue; // not an Ayvaz store
    if (!byStore[r.storeId]) byStore[r.storeId] = { storeId: r.storeId, storeName: r.storeName, tickets: [] };
    byStore[r.storeId].tickets.push(r);
  }

  let flagsWritten = 0;

  for (const [storeId, storeData] of Object.entries(byStore)) {
    const assign = assignments[storeId] || {};
    const base   = {
      store_id:     storeId,
      store_name:   storeData.storeName || assign.store_name || storeId,
      area_coach:   assign.area_coach   || null,
      region_coach: assign.region_coach || null,
      territory_vp: assign.vp           || null,
      metric_date:  targetDate,
      source:       'ods',
      tier:         2,
      consecutive_days_out: 1,
    };

    const tickets         = storeData.tickets;
    const largeTickets    = tickets.filter(t => t.amount >= CASH_THRESHOLD);
    const cashTickets     = largeTickets.filter(t => t.isCash);
    const nonCashLarge    = largeTickets.filter(t => !t.isCash);

    // ── RED flag: $50+ cash change down ──────────────────────────────────
    if (cashTickets.length) {
      const totalCash = cashTickets.reduce((s, t) => s + t.amount, 0);
      await db.upsertIntelFlag({
        ...base,
        metric_type: 'CHANGE_DOWN_CASH',
        value:       Math.round(totalCash * 100) / 100,
        target:      CASH_THRESHOLD,
        severity:    'high',
        details: {
          summary: `${cashTickets.length} cash change-down${cashTickets.length > 1 ? 's' : ''} of $${CASH_THRESHOLD}+ — possible cash theft`,
          tickets: cashTickets.map(t => ({
            ticket_id:     t.ticketId,
            amount:        t.amount,
            cashier_id:    t.cashierId,
            cashier_name:  t.cashierName,
            payment_type:  t.payment,
            cancel_type:   t.cancelType   || null,
            discount_type: t.discountType || null,
            time:          t.time,
          })),
        },
      });
      flagsWritten++;
    }

    // ── YELLOW flag: $50+ non-cash change down ────────────────────────────
    if (nonCashLarge.length) {
      const total = nonCashLarge.reduce((s, t) => s + t.amount, 0);
      await db.upsertIntelFlag({
        ...base,
        metric_type: 'CHANGE_DOWN_LARGE',
        value:       Math.round(total * 100) / 100,
        target:      CASH_THRESHOLD,
        severity:    'medium',
        details: {
          summary: `${nonCashLarge.length} large change-down${nonCashLarge.length > 1 ? 's' : ''} of $${CASH_THRESHOLD}+ (non-cash)`,
          tickets: nonCashLarge.map(t => ({
            ticket_id:     t.ticketId,
            amount:        t.amount,
            cashier_id:    t.cashierId,
            cashier_name:  t.cashierName,
            payment_type:  t.payment,
            cancel_type:   t.cancelType   || null,
            discount_type: t.discountType || null,
            time:          t.time,
          })),
        },
      });
      flagsWritten++;
    }

    // ── PATTERN flag: same cashier 4+ change downs in one day ─────────────
    const byCashier = {};
    for (const t of tickets) {
      const key = t.cashierId || t.cashierName || 'unknown';
      if (!byCashier[key]) byCashier[key] = { cashierId: t.cashierId, cashierName: t.cashierName, tickets: [] };
      byCashier[key].tickets.push(t);
    }
    const patternCashiers = Object.values(byCashier).filter(c => c.tickets.length >= PATTERN_MIN);
    if (patternCashiers.length) {
      const hasCash = patternCashiers.some(c => c.tickets.some(t => t.isCash));
      await db.upsertIntelFlag({
        ...base,
        metric_type: 'CHANGE_DOWN_PATTERN',
        value:       Math.max(...patternCashiers.map(c => c.tickets.length)),
        target:      PATTERN_MIN,
        severity:    hasCash ? 'high' : 'medium',
        details: {
          summary: `${patternCashiers.length} cashier${patternCashiers.length > 1 ? 's' : ''} with ${PATTERN_MIN}+ change downs today — observe pattern`,
          cashier_summary: patternCashiers.map(c => ({
            cashier_id:   c.cashierId,
            cashier_name: c.cashierName,
            count:        c.tickets.length,
            cash_count:   c.tickets.filter(t => t.isCash).length,
            total_amount: Math.round(c.tickets.reduce((s, t) => s + t.amount, 0) * 100) / 100,
            tickets:      c.tickets.map(t => ({
              ticket_id:     t.ticketId,
              amount:        t.amount,
              payment_type:  t.payment,
              cancel_type:   t.cancelType   || null,
              discount_type: t.discountType || null,
              time:          t.time,
            })),
          })),
        },
      });
      flagsWritten++;
    }
  }

  console.log(`[ChangeDown] ${flagsWritten} flags written for ${targetDate}`);
  return { success: true, flagsWritten, storesProcessed: Object.keys(byStore).length };
}

module.exports = { processChangeDown };
