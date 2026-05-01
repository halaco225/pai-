'use strict';
/**
 * HutBot Routines Manual Upload Parser
 *
 * Accepts a CSV or Excel (.xlsx/.xls) export from the Yum SuperApp routines page.
 * Returns an array of { store_id, routine_name, status, scheduled_time, completion_pct }
 *
 * Expected columns (case-insensitive, flexible order):
 *   Store Number / Store ID / Restaurant / Unit
 *   Routine Name / Routine / Task
 *   Status (values: "Missed", "Late", "Completed", etc.)
 *   Scheduled Time / Due Time / Time (optional)
 *   Completion % / Complete / % Done (optional)
 */

const fs      = require('fs');
const path    = require('path');
const ExcelJS = require('exceljs');

// ─────────────────────────────────────────────────────────────────────────────
//  Column name normalizer
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const STORE_HEADERS    = ['storenumber','storeid','restaurantnumber','unitnumber','store','unit','restaurant'];
const ROUTINE_HEADERS  = ['routinename','routine','taskname','task','checklistname','name'];
const STATUS_HEADERS   = ['status','completionstatus','result','state'];
const TIME_HEADERS     = ['scheduledtime','duetime','time','scheduledfor','duedate'];
const PCT_HEADERS      = ['completionpct','completepct','percentcomplete','done','pctdone','completion'];

function findCol(headers, candidates) {
  const norm = headers.map(normalizeHeader);
  for (const c of candidates) {
    const idx = norm.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parse helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseStoreId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/\b(\d{4,6})\b/);
  return m ? m[1].padStart(6, '0') : null;
}

function parseStatus(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (v.includes('miss')) return 'missed';
  if (v.includes('late') || v.includes('incomplete') || v.includes('partial')) return 'late';
  return null; // skip completed / n/a
}

function parseTime(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : null;
}

function parsePct(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d+)/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSV parser (no external dep — manual split)
// ─────────────────────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

async function parseCSV(filePath) {
  const text  = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const storeCol   = findCol(headers, STORE_HEADERS);
  const routineCol = findCol(headers, ROUTINE_HEADERS);
  const statusCol  = findCol(headers, STATUS_HEADERS);
  const timeCol    = findCol(headers, TIME_HEADERS);
  const pctCol     = findCol(headers, PCT_HEADERS);

  if (storeCol === -1 || statusCol === -1) {
    throw new Error(`HutBot CSV missing required columns. Found: ${headers.join(', ')}`);
  }

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const status = parseStatus(cols[statusCol]);
    if (!status) continue; // skip completed rows
    const store_id = parseStoreId(cols[storeCol]);
    if (!store_id) continue;

    records.push({
      store_id,
      routine_name:   (routineCol !== -1 ? cols[routineCol] : 'Unknown Routine').trim() || 'Unknown Routine',
      status,
      scheduled_time: timeCol !== -1 ? parseTime(cols[timeCol]) : null,
      completion_pct: pctCol  !== -1 ? parsePct(cols[pctCol])  : null,
    });
  }
  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Excel parser
// ─────────────────────────────────────────────────────────────────────────────

async function parseExcel(filePath) {
  const wb = new ExcelJS.Workbook();
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv') {
    await wb.csv.readFile(filePath);
  } else {
    await wb.xlsx.readFile(filePath);
  }

  // Use first worksheet that has data
  let ws = null;
  wb.eachSheet(sheet => { if (!ws && sheet.rowCount > 1) ws = sheet; });
  if (!ws) throw new Error('HutBot Excel: no usable worksheet found');

  // Read header row (first non-empty row)
  let headerRow = null;
  ws.eachRow((row, rn) => {
    if (!headerRow && row.values.filter(Boolean).length > 2) {
      headerRow = { row, rn };
    }
  });
  if (!headerRow) throw new Error('HutBot Excel: no header row found');

  const headers    = headerRow.row.values.map(v => String(v || ''));
  const storeCol   = findCol(headers, STORE_HEADERS);
  const routineCol = findCol(headers, ROUTINE_HEADERS);
  const statusCol  = findCol(headers, STATUS_HEADERS);
  const timeCol    = findCol(headers, TIME_HEADERS);
  const pctCol     = findCol(headers, PCT_HEADERS);

  if (storeCol === -1 || statusCol === -1) {
    throw new Error(`HutBot Excel missing required columns. Found: ${headers.filter(Boolean).join(', ')}`);
  }

  const records = [];
  ws.eachRow((row, rn) => {
    if (rn <= headerRow.rn) return; // skip header
    const vals = row.values; // 1-indexed
    const status = parseStatus(vals[statusCol]);
    if (!status) return;
    const store_id = parseStoreId(vals[storeCol]);
    if (!store_id) return;

    records.push({
      store_id,
      routine_name:   String(routineCol !== -1 ? (vals[routineCol] || '') : 'Unknown Routine').trim() || 'Unknown Routine',
      status,
      scheduled_time: timeCol !== -1 ? parseTime(vals[timeCol]) : null,
      completion_pct: pctCol  !== -1 ? parsePct(vals[pctCol])  : null,
    });
  });
  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a HutBot routines export file.
 * @param {string} filePath  - absolute path to CSV or Excel file
 * @returns {{ records: Array, summary: object }}
 */
async function parseHutBotFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let records;

  if (ext === '.csv') {
    records = await parseCSV(filePath);
  } else if (['.xlsx', '.xls', '.xlsm'].includes(ext)) {
    records = await parseExcel(filePath);
  } else {
    throw new Error(`Unsupported file type: ${ext}. Use CSV or Excel.`);
  }

  const missed = records.filter(r => r.status === 'missed').length;
  const late   = records.filter(r => r.status === 'late').length;
  const stores = [...new Set(records.map(r => r.store_id))].length;

  return {
    records,
    summary: { total: records.length, missed, late, stores },
  };
}

module.exports = { parseHutBotFile };
