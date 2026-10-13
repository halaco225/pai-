'use strict';
/**
 * SUS_DBS parser — the CHEESE row of each store's "Daily Critical Items" block.
 *
 * Layout, confirmed against a real export:
 *
 *   S038876 (Wells Street)                         <- block header
 *   ...
 *   DAILY CRITICAL ITEMS
 *   "", Ideal Usage, Actual Usage, Variance, ...   <- column header
 *   CHEESE, 81.9, 80, 1.9, ...
 *
 * Columns are located by header text rather than by index. dbs-parser.js takes
 * the index approach and carries two columns it never identified; a report that
 * gains a column there starts reading the wrong number silently. Here, a header
 * that cannot be understood yields no row at all, so the brief omits cheese for
 * that store rather than printing something confident and wrong.
 *
 * Variance is Ideal - Actual: positive means the store used less than ideal.
 * It is not stored. Storing a number that is the difference of two other stored
 * numbers is how the three of them drift apart.
 */
const XLSX = require('xlsx');

// "S038876 (Wells Street)" -> id without the S, and the name.
// store_assignments, intel_dbs_metrics and dbs_soft_indicators all key stores
// as "038876"; only this report and velocity_daily_records carry the S.
const STORE_RE = /^S(\d{6})\s*\((.+)\)\s*$/;

const CRITICALS_HEADING = 'DAILY CRITICAL ITEMS';
const ITEM              = 'CHEESE';

const txt = v => String(v == null ? '' : v).trim();
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

// The header row names its columns; find them rather than counting them.
function columnsFrom(row) {
  const find = label => row.findIndex(c => txt(c).toLowerCase() === label);
  const ideal  = find('ideal usage');
  const actual = find('actual usage');
  return ideal >= 0 && actual >= 0 ? { ideal, actual } : null;
}

/**
 * Walk the sheet rows. Pure — no file access, so the odd layouts are testable.
 * Returns { softIndicators, skipped } where skipped names the stores that had a
 * block but no usable cheese number.
 */
function cheeseFromRows(rows, targetDate) {
  const softIndicators = [];
  const skipped = [];

  let store = null;      // the block we are inside
  let cols  = null;      // that block's column positions
  let seen  = false;     // did this block yield a row

  const closeBlock = () => {
    if (store && !seen) skipped.push(store);
  };

  for (const row of rows) {
    const a = txt(row[0]);

    const m = STORE_RE.exec(a);
    if (m) { closeBlock(); store = m[1]; cols = null; seen = false; continue; }

    if (!store) continue;                       // content before the first block
    if (a === CRITICALS_HEADING) { cols = null; continue; }

    if (!cols) { cols = columnsFrom(row); }     // the row after the heading names the columns

    if (a === ITEM) {
      const ideal  = cols ? num(row[cols.ideal])  : null;
      const actual = cols ? num(row[cols.actual]) : null;
      // A store that has not posted yet shows blanks. Writing 0/0 would report
      // a perfect variance for a store that reported nothing at all.
      if (ideal == null || actual == null) continue;
      softIndicators.push({
        store_id:    store,
        metric_date: targetDate,
        indicator:   'cheese_usage',
        value:       actual,
        target:      ideal,
        source:      'ODS',
      });
      seen = true;
    }
  }
  closeBlock();

  return { softIndicators, skipped };
}

function parseSusDbs(filePath, targetDate) {
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: true });
  // Concatenated for the same reason dbs-parser.js concatenates: this report
  // splits across tabs once it covers enough stores.
  const rows = wb.SheetNames.flatMap(name =>
    XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null })
  );
  return cheeseFromRows(rows, targetDate);
}

module.exports = { parseSusDbs, cheeseFromRows, STORE_RE };
