// =====================================================================
// VELOCITY EXPORT — Excel workbook generation
// Sheets: WTD IST, PTD IST, Daily tabs, Trend, PTD Trend
// =====================================================================
'use strict';

const XLSX = require('xlsx');

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

function avgLt19(storeList) {
  const valid = storeList.filter(s => s.wtd_lt19_pct != null);
  return valid.length ? Math.round(valid.reduce((a, s) => a + s.wtd_lt19_pct, 0) / valid.length * 10) / 10 : null;
}

// % = count / total_orders as decimal (e.g. 0.038), null if no orders
function bucketPct(count, totalOrders) {
  return (totalOrders > 0) ? Math.round((count / totalOrders) * 10000) / 10000 : null;
}

const IST_HEADERS = [
  'Level','Region','Area Coach','Store #','Store Name',
  'Avg IST (mins)','Total Orders',
  'IST <10 #','IST <10 %',
  'IST 10-14 #','IST 10-14 %',
  'IST 15-18 #','IST 15-18 %',
  'IST 19-25 #','IST 19-25 %',
  'IST >25 #','IST >25 %',
  'IST <19%'
];

function istRow(level, region, area, storeId, storeName, istAvg, orders, lt10, t1014, t1518, t1925, gt25, lt19pct) {
  return [
    level, region, area, storeId, storeName,
    istAvg, orders,
    lt10, bucketPct(lt10, orders),
    t1014, bucketPct(t1014, orders),
    t1518, bucketPct(t1518, orders),
    t1925, bucketPct(t1925, orders),
    gt25, bucketPct(gt25, orders),
    lt19pct
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
    stores.reduce((a,s)=>a+(s.wtd_gt25||0),0),
    avgLt19(stores)
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
      rStores.reduce((a,s)=>a+(s.wtd_gt25||0),0),
      avgLt19(rStores)
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
        aStores.reduce((a,s)=>a+(s.wtd_gt25||0),0),
        avgLt19(aStores)
      ));

      for (const s of aStores) {
        const sOrders = s.wtd_orders || 0;
        rows.push(istRow(
          'STORE', s.region_coach||'', s.area_coach||'', s.store_id, s.name,
          s.wtd_ist, sOrders,
          s.wtd_lt10||0, s.wtd_1014||0, s.wtd_1518||0,
          s.wtd_1925||0, s.wtd_gt25||0,
          s.wtd_lt19_pct
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

function generateExcelExport({ weekKey, periodWeek, wtdStores, dailyByDate, allWeekStores }) {
  const wb = XLSX.utils.book_new();
  const dateRange = weekKey ? (() => {
    try {
      const tue = new Date(weekKey + 'T12:00:00Z');
      const mon = new Date(tue); mon.setUTCDate(tue.getUTCDate() + 6);
      return `${tue.getUTCMonth()+1}/${tue.getUTCDate()}–${mon.getUTCMonth()+1}/${mon.getUTCDate()}`;
    } catch(e) { return ''; }
  })() : '';

  // ── WTD IST Sheet ────────────────────────────────────────────────
  const wtdRows = [
    [`WTD IST — ${periodWeek} ${dateRange}`],
    IST_HEADERS,
    ...buildHierarchyRows(wtdStores)
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wtdRows), 'WTD IST');

  // ── PTD IST Sheet (all weeks in period) ──────────────────────────
  if (allWeekStores && allWeekStores.length) {
    const ptdRows = [
      [`PTD IST — ${periodWeek?.replace(/W\d+/,'')} Period To Date`],
      IST_HEADERS,
      ...buildHierarchyRows(allWeekStores)
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ptdRows), 'PTD IST');
  }

  // ── Daily Sheets ─────────────────────────────────────────────────
  if (dailyByDate) {
    const sortedDates = Object.keys(dailyByDate).sort();
    for (const dateStr of sortedDates) {
      const dayStores = dailyByDate[dateStr] || [];
      const displayStores = dayStores.map(r => ({
        store_id: r.store_id, name: r.name||'', area: r.area||'',
        area_coach: r.area_coach||'', region_coach: r.region_coach||'',
        wtd_ist: r.ist_avg ? parseFloat(r.ist_avg) : null,
        wtd_orders: r.total_orders||0,
        wtd_lt10: r.ist_lt10||0, wtd_1014: r.ist_1014||0,
        wtd_1518: r.ist_1518||0, wtd_1925: r.ist_1925||0,
        wtd_gt25: r.ist_gt25||0, wtd_lt19_pct: r.ist_lt19_pct ? parseFloat(r.ist_lt19_pct) : null
      }));

      const dayRows = [
        [`${fmtDate(dateStr)} — ${periodWeek}`],
        IST_HEADERS,
        ...buildHierarchyRows(displayStores)
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dayRows), fmtDate(dateStr).substring(0, 31));
    }
  }

  // ── Trend Sheet (day-over-day within the week) ────────────────────
  if (dailyByDate) {
    const sortedDates = Object.keys(dailyByDate).sort().filter(d => (dailyByDate[d]||[]).length > 0);
    if (sortedDates.length > 0) {
      // Build map: store_id -> { date -> ist_avg }
      const storeMap = {};
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

      // Headers: Level, Region, Area Coach, Store #, Store Name, [Day IST, Δ, Day IST, Δ, ...]
      const trendHdrs = ['Level','Region','Area Coach','Store #','Store Name'];
      for (let i = 0; i < sortedDates.length; i++) {
        trendHdrs.push(`${fmtDate(sortedDates[i])} IST`);
        if (i < sortedDates.length - 1) trendHdrs.push(`Δ`);
      }

      const trendRows = [[`Trend — Daily IST ${periodWeek} ${dateRange}`], trendHdrs];
      for (const [storeId, dayIST] of Object.entries(storeMap)) {
        const info = storeInfo[storeId];
        const row = ['STORE', info.region_coach, info.area_coach, storeId, info.name];
        for (let i = 0; i < sortedDates.length; i++) {
          row.push(dayIST[sortedDates[i]] ?? null);
          if (i < sortedDates.length - 1) {
            row.push(delta(dayIST[sortedDates[i]], dayIST[sortedDates[i+1]]));
          }
        }
        trendRows.push(row);
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trendRows), 'Trend');
    }
  }

  // ── PTD Trend Sheet (week-over-week) ─────────────────────────────
  if (allWeekStores && allWeekStores.length && allWeekStores[0]?.weeklyIST) {
    const weeks = Object.keys(allWeekStores[0].weeklyIST).sort();

    // Headers: Level, Region, Area Coach, Store #, Store Name, [Wk IST, Δ, Wk IST, Δ, ...]
    const ptdTrendHdrs = ['Level','Region','Area Coach','Store #','Store Name'];
    for (let i = 0; i < weeks.length; i++) {
      ptdTrendHdrs.push(`${weeks[i]} Avg IST`);
      if (i < weeks.length - 1) ptdTrendHdrs.push('Δ');
    }

    const ptdTrendRows = [[`PTD Trend — Week over Week IST`], ptdTrendHdrs];
    for (const s of allWeekStores) {
      if (s.level !== 'STORE') continue;
      const row = ['STORE', s.region_coach||'', s.area_coach||'', s.store_id, s.name];
      for (let i = 0; i < weeks.length; i++) {
        row.push(s.weeklyIST[weeks[i]] ?? null);
        if (i < weeks.length - 1) {
          row.push(delta(s.weeklyIST[weeks[i]], s.weeklyIST[weeks[i+1]]));
        }
      }
      ptdTrendRows.push(row);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ptdTrendRows), 'PTD Trend');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generateExcelExport };
