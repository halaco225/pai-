'use strict';
/**
 * Cancel After Tender Parser — PH_Cancels_After_Tender from ODS
 *
 * Stores ticket-level cancel data per store for drill-down in the
 * Cancel & Discount modal (ticket #, cashier ID, time, amount, type).
 *
 * Creates CANCEL_TENDER intel_flags with tickets array in details.
 */
const XLSX = require('xlsx');
const db   = require('../db');

const COL_PATTERNS = {
  store:        /store|location/i,
  date:         /^date$|cancel.*date|transaction.*date/i,
  ticket:       /ticket|order|check/i,
  cashier:      /cashier.*id|emp.*id|empl.*id|operator.*id/i,
  cashier_name: /emp.*name|cashier.*name|operator.*name|^name$/i,
  amount:       /cash.*out|amount|cancel.*amt|initial/i,
  payment:      /tender|payment|pay.*type/i,
  cancel_type:  /cancel.*type|reason|void.*type/i,
  time:         /time|date.*time|cancel.*time|void.*time/i,
};

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,()]/g, '').trim());
  return isNaN(n) ? null : Math.abs(n);
}

function parseStoreId(val) {
  if (!val) return null;
  const m = String(val).match(/0*(\d{5,6})/);
  return m ? m[1].padStart(6, '0') : null;
}

function parseStoreName(val) {
  if (!val) return '';
  return String(val).replace(/^\(?\d+\)?\s*[-–]?\s*/, '').replace(/\s*-\s*Pizza Hut\s*$/i, '').trim();
}

function detectColumns(headerRow) {
  const cols = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] || '').trim();
    if (!h) continue;
    for (const [key, pat] of Object.entries(COL_PATTERNS)) {
      if (!(key in cols) && pat.test(h)) { cols[key] = i; break; }
    }
  }
  return cols;
}

async function processCancelTender(filePath, targetDate) {
  console.log(`[CancelTender] Parsing ${filePath} for ${targetDate}`);
  const wb   = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Find header row
  let headerIdx = -1;
  let cols = {};
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const candidate = detectColumns(rows[i] || []);
    if (Object.keys(candidate).length >= 3) { headerIdx = i; cols = candidate; break; }
  }
  if (headerIdx < 0) {
    console.error('[CancelTender] Could not detect columns');
    return { success: false, error: 'Could not detect columns in Cancel After Tender report' };
  }
  console.log(`[CancelTender] Header at row ${headerIdx}:`, JSON.stringify(cols));

  // Group tickets by store
  const byStore = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c == null)) continue;
    const rawStore = cols.store != null ? row[cols.store] : null;
    const storeId  = parseStoreId(rawStore);
    if (!storeId) continue;
    const storeName = parseStoreName(rawStore);
    if (!byStore[storeId]) byStore[storeId] = { store_id: storeId, store_name: storeName, tickets: [] };
    const amount = cols.amount != null ? num(row[cols.amount]) : null;
    if (!amount || amount < 0.01) continue;
    byStore[storeId].tickets.push({
      ticket_id:    cols.ticket       != null ? String(row[cols.ticket]       || '').trim() : null,
      date:         cols.date         != null ? String(row[cols.date]         || '').trim() : null,
      cashier_id:   cols.cashier      != null ? String(row[cols.cashier]      || '').trim() : null,
      cashier_name: cols.cashier_name != null ? String(row[cols.cashier_name] || '').trim() : null,
      amount,
      payment_type: cols.payment     != null ? String(row[cols.payment]      || '').trim() : null,
      cancel_type:  cols.cancel_type != null ? String(row[cols.cancel_type]  || '').trim() : null,
      time:         cols.time        != null ? String(row[cols.time]         || '').trim() : null,
    });
  }

  const assignments = await db.getStoreAssignments();
  let flagsWritten = 0;

  for (const [storeId, store] of Object.entries(byStore)) {
    const asgn = assignments[storeId];
    if (!asgn || !asgn.area_coach) continue;
    const totalAmt = store.tickets.reduce((s, t) => s + (t.amount || 0), 0);
    await db.upsertIntelFlag({
      store_id:              storeId,
      store_name:            store.store_name || asgn.store_name,
      area_coach:            asgn.area_coach,
      region_coach:          asgn.region_coach,
      territory_vp:          asgn.vp,
      metric_date:           targetDate,
      source:                'ODS',
      tier:                  2,
      metric_type:           'CANCEL_TENDER',
      value:                 store.tickets.length,
      target:                0,
      variance:              store.tickets.length,
      consecutive_days_out:  1,
      severity:              'low',
      is_new:                true,
      details: {
        ticket_count: store.tickets.length,
        total_amount: Math.round(totalAmt * 100) / 100,
        tickets: store.tickets,
      },
    });
    flagsWritten++;
  }

  console.log(`[CancelTender] Done — ${flagsWritten} stores written`);
  return { success: true, storesProcessed: Object.keys(byStore).length, flagsWritten };
}

module.exports = { processCancelTender };
