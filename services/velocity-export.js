// =====================================================================
// VELOCITY EXPORT — Excel workbook generation (ExcelJS)
// Sheets: WTD IST, PTD IST, Daily tabs, Trend, PTD Trend
// =====================================================================
'use strict';

const ExcelJS = require('exceljs');

const DAY_NAMES  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const dt = new Date(parseInt(y), parseInt(m)-1, parseInt(d));
  return `${DAY_NAMES[dt.getDay()]}, ${MONTH_NAMES[dt.getMonth()]} ${parseInt(d)}`;
}

function avgIST(storeList) {
  const valid = storeList.filter(s => s.wtd_ist != null);
  return valid.length ? Math.round(valid.reduce((a, s) => a + s.wtd_ist, 0) / valid.length * 10) / 10 : null;
}

function sumOrders(storeList) {
  return storeList.reduce((a, s) => a + (s.wtd_orders || 0), 0);
}

// % = count / total_orders as decimal (e.g. 0.038), null if no orders
function bucketPct(count, totalOrders) {
  return (totalOrders > 0) ? Math.round((count / totalOrders) * 10000) / 10000 : null;
}

// ARGB hex for IST value: green <19, orange 19–22, red >22
function istColorArgb(val) {
  if (val == null || isNaN(val)) return null;
  if (val < 19)  return 'FF28A745';  // green
  if (val <= 22) return 'FFFD7E14';  // orange
  return 'FFDC3545';                  // red
}

const IST_HEADERS = [
  'Level','Region','Area Coach','Store #','Store Name',
  'Avg IST (mins)','Total Orders',
  'IST <10 #','IST <10 %',
  'IST 10-14 #','IST 10-14 %',
  'IST 15-18 #','IST 15-18 %',
  'IST 19-25 #','IST 19-25 %',
  'IST >25 #','IST >25 %'
];

// 1-based column index of "Avg IST (mins)" in IST sheets
const AVG_IST_COL = 6;

// 1-based indices of % columns (need numFmt = '0.0%')
const PCT_COLS = [9, 11, 13, 15, 17];

// Column widths for IST sheets (1 per header column)
const IST_COL_WIDTHS = [8, 24, 22, 10, 30, 14, 13, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];

function istRow(level, region, area, storeId, storeName, istAvg, orders, lt10, t1014, t1518, t1925, gt25) {
  return [
    level, region, area, storeId, storeName,
    istAvg, orders,
    lt10, bucketPct(lt10, orders),
    t1014, bucketPct(t1014, orders),
    t1518, bucketPct(t1518, orders),
    t1925, bucketPct(t1925, orders),
    gt25, bucketPct(gt25, orders)
  ];
}

function buildHierarchyRows(stores) {
  const rows = [];
  const byRegion = {};
  stores.forEach(s => {
    const r = s.region_coach || 'Unknown';
    if (!byRegion[r]) byRegion[r] = [];
    byRegion[r].push(s);
  });

  // TOTAL row
  const tOrders = sumOrders(stores);
  rows.push(istRow(
    'TOTAL', 'ALL REGIONS', '', '', `${stores.length} Stores`,
    avgIST(stores), tOrders,
    stores.reduce((a,s)=>a+(s.wtd_lt10||0),0),
    stores.reduce((a,s)=>a+(s.wtd_1014||0),0),
    stores.reduce((a,s)=>a+(s.wtd_1518||0),0),
    stores.reduce((a,s)=>a+(s.wtd_1925||0),0),
    stores.reduce((a,s)=>a+(s.wtd_gt25||0),0)
  ));

  for (const [region, rStores] of Object.entries(byRegion)) {
    const rOrders = sumOrders(rStores);
    rows.push(istRow(
      'REGION', region, '', '', `${rStores.length} Stores`,
      avgIST(rStores), rOrders,
      rStores.reduce((a,s)=>a+(s.wtd_lt10||0),0),
      rStores.reduce((a,s)=>a+(s.wtd_1014||0),0),
      rStores.reduce((a,s)=>a+(s.wtd_1518||0),0),
      rStores.reduce((a,s)=>a+(s.wtd_1925||0),0),
      rStores.reduce((a,s)=>a+(s.wtd_gt25||0),0)
    ));

    const byArea = {};
    rStores.forEach(s => {
      const a = s.area_coach || 'Unknown';
      if (!byArea[a]) byArea[a] = [];
      byArea[a].push(s);
    });

    for (const [area, aStores] of Object.entries(byArea)) {
      const aOrders = sumOrders(aStores);
      rows.push(istRow(
        'AREA', region, area, '', `${aStores.length} Stores`,
        avgIST(aStores), aOrders,
        aStores.reduce((a,s)=>a+(s.wtd_lt10||0),0),
        aStores.reduce((a,s)=>a+(s.wtd_1014||0),0),
        aStores.reduce((a,s)=>a+(s.wtd_1518||0),0),
        aStores.reduce((a,s)=>a+(s.wtd_1925||0),0),
        aStores.reduce((a,s)=>a+(s.wtd_gt25||0),0)
      ));

      for (const s of aStores) {
        const sOrders = s.wtd_orders || 0;
        rows.push(istRow(
          'STORE', s.region_coach||'', s.area_coach||'', s.store_id, s.name,
          s.wtd_ist, sOrders,
          s.wtd_lt10||0, s.wtd_1014||0, s.wtd_1518||0,
          s.wtd_1925||0, s.wtd_gt25||0
        ));
      }
    }
  }
  return rows;
}

function delta(prev, curr) {
  if (prev == null || curr == null) return '—';
  const d = Math.round((curr - prev) * 10) / 10;
  return d > 0 ? `▲ +${d.toFixed(1)}` : d < 0 ? `▼ ${d.toFixed(1)}` : '—';
}

// ── Shared header row style ───────────────────────────────────────────
function styleHeaderRow(row) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFEEEEEE' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF222222' } };
  });
}

// ── Add an IST hierarchy sheet ────────────────────────────────────────
function addISTSheet(wb, sheetName, title, stores) {
  const ws = wb.addWorksheet(sheetName);
  ws.views = [{ state: 'frozen', xSplit: 5, ySplit: 2 }];

  // Row 1: title
  const titleRow = ws.addRow([title]);
  titleRow.font = { bold: true, size: 12 };

  // Row 2: column headers
  styleHeaderRow(ws.addRow(IST_HEADERS));

  // Data rows
  for (const row of buildHierarchyRows(stores)) {
    const level  = row[0];
    const istVal = row[AVG_IST_COL - 1]; // 0-indexed
    const wsRow  = ws.addRow(row);

    const isBold = (level === 'TOTAL' || level === 'REGION' || level === 'AREA');

    if (isBold) {
      const fillColor = level === 'TOTAL' ? 'FF0D0D0D' : level === 'REGION' ? 'FF1A1A1A' : 'FF252525';
      wsRow.eachCell({ includeEmpty: true }, cell => {
        cell.font  = { bold: true };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
      });
    }

    // IST color on Avg IST cell
    const color = istColorArgb(istVal);
    if (color) {
      wsRow.getCell(AVG_IST_COL).font = { bold: isBold, color: { argb: color } };
    }

    // Apply % format to % columns
    for (const ci of PCT_COLS) {
      const cell = wsRow.getCell(ci);
      if (cell.value != null) cell.numFmt = '0.0%';
    }
  }

  // Set column widths
  IST_COL_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

// ── Main export (async — ExcelJS requires writeBuffer) ────────────────
async function generateExcelExport({ weekKey, periodWeek, wtdStores, dailyByDate, allWeekStores }) {
  const wb = new ExcelJS.Workbook();
  const dateRange = weekKey ? (() => {
    try {
      const tue = new Date(weekKey + 'T12:00:00Z');
      const mon = new Date(tue); mon.setUTCDate(tue.getUTCDate() + 6);
      return `${tue.getUTCMonth()+1}/${tue.getUTCDate()}–${mon.getUTCMonth()+1}/${mon.getUTCDate()}`;
    } catch(e) { return ''; }
  })() : '';

  // ── WTD IST Sheet ────────────────────────────────────────────────────
  addISTSheet(wb, 'WTD IST', `WTD IST — ${periodWeek} ${dateRange}`, wtdStores);

  // ── PTD IST Sheet ────────────────────────────────────────────────────
  if (allWeekStores && allWeekStores.length) {
    addISTSheet(wb, 'PTD IST', `PTD IST — ${periodWeek?.replace(/W\d+/,'')} Period To Date`, allWeekStores);
  }

  // ── Daily Sheets ─────────────────────────────────────────────────────
  if (dailyByDate) {
    for (const dateStr of Object.keys(dailyByDate).sort()) {
      const dayStores = (dailyByDate[dateStr] || []).map(r => ({
        store_id: r.store_id, name: r.name||'', area: r.area||'',
        area_coach: r.area_coach||'', region_coach: r.region_coach||'',
        wtd_ist: r.ist_avg ? parseFloat(r.ist_avg) : null,
        wtd_orders: r.total_orders||0,
        wtd_lt10: r.ist_lt10||0, wtd_1014: r.ist_1014||0,
        wtd_1518: r.ist_1518||0, wtd_1925: r.ist_1925||0,
        wtd_gt25: r.ist_gt25||0
      }));
      addISTSheet(wb, fmtDate(dateStr).substring(0, 31), `${fmtDate(dateStr)} — ${periodWeek}`, dayStores);
    }
  }

  // ── Trend Sheet (day-over-day within the week) ────────────────────────
  if (dailyByDate) {
    const sortedDates = Object.keys(dailyByDate).sort().filter(d => (dailyByDate[d]||[]).length > 0);
    if (sortedDates.length > 0) {
      const storeMap  = {};
      const storeInfo = {};
      for (const dateStr of sortedDates) {
        for (const r of (dailyByDate[dateStr] || [])) {
          if (!storeMap[r.store_id]) {
            storeMap[r.store_id] = {};
            storeInfo[r.store_id] = { region_coach: r.region_coach||'', area_coach: r.area_coach||'', name: r.name||'' };
          }
          storeMap[r.store_id][dateStr] = r.ist_avg ? parseFloat(r.ist_avg) : null;
        }
      }

      // Headers: identity cols + [Day IST, Δ, Day IST, Δ, ...]
      const trendHdrs = ['Level','Region','Area Coach','Store #','Store Name'];
      for (let i = 0; i < sortedDates.length; i++) {
        trendHdrs.push(`${fmtDate(sortedDates[i])} IST`);
        if (i < sortedDates.length - 1) trendHdrs.push('Δ');
      }

      const ws = wb.addWorksheet('Trend');
      ws.views = [{ state: 'frozen', xSplit: 5, ySplit: 2 }];
      ws.addRow([`Trend — Daily IST ${periodWeek} ${dateRange}`]).font = { bold: true, size: 12 };
      styleHeaderRow(ws.addRow(trendHdrs));

      // Set identity column widths
      [8, 24, 22, 10, 30].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      for (let i = 5; i < trendHdrs.length; i++) { ws.getColumn(i + 1).width = 14; }

      for (const [storeId, dayIST] of Object.entries(storeMap)) {
        const info    = storeInfo[storeId];
        const rowData = ['STORE', info.region_coach, info.area_coach, storeId, info.name];
        for (let i = 0; i < sortedDates.length; i++) {
          rowData.push(dayIST[sortedDates[i]] ?? null);
          if (i < sortedDates.length - 1) rowData.push(delta(dayIST[sortedDates[i]], dayIST[sortedDates[i+1]]));
        }
        const wsRow = ws.addRow(rowData);
        // Color IST cells (cols 6, 8, 10, ...)
        for (let i = 0; i < sortedDates.length; i++) {
          const color = istColorArgb(dayIST[sortedDates[i]]);
          if (color) wsRow.getCell(6 + i * 2).font = { color: { argb: color } };
        }
      }
    }
  }

  // ── PTD Trend Sheet (week-over-week) ──────────────────────────────────
  if (allWeekStores && allWeekStores.length) {
    // Collect all week labels that have actual data across ALL stores (not just the first)
    const weeks = [...new Set(allWeekStores.flatMap(s => Object.keys(s.weeklyIST || {})))].sort();

    if (weeks.length > 0) {
      const ptdHdrs = ['Level','Region','Area Coach','Store #','Store Name'];
      for (let i = 0; i < weeks.length; i++) {
        ptdHdrs.push(`${weeks[i]} Avg IST`);
        if (i < weeks.length - 1) ptdHdrs.push('Δ');
      }

      const ws = wb.addWorksheet('PTD Trend');
      ws.views = [{ state: 'frozen', xSplit: 5, ySplit: 2 }];
      ws.addRow([`PTD Trend — Week over Week IST`]).font = { bold: true, size: 12 };
      styleHeaderRow(ws.addRow(ptdHdrs));

      [8, 24, 22, 10, 30].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      for (let i = 5; i < ptdHdrs.length; i++) { ws.getColumn(i + 1).width = 14; }

      for (const s of allWeekStores) {
        if (s.level !== 'STORE') continue;
        const rowData = ['STORE', s.region_coach||'', s.area_coach||'', s.store_id, s.name];
        for (let i = 0; i < weeks.length; i++) {
          const val = s.weeklyIST?.[weeks[i]] ?? null;
          rowData.push(val);
          if (i < weeks.length - 1) rowData.push(delta(val, s.weeklyIST?.[weeks[i+1]] ?? null));
        }
        const wsRow = ws.addRow(rowData);
        for (let i = 0; i < weeks.length; i++) {
          const color = istColorArgb(s.weeklyIST?.[weeks[i]]);
          if (color) wsRow.getCell(6 + i * 2).font = { color: { argb: color } };
        }
      }
    }
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { generateExcelExport };
