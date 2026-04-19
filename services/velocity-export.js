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

const IST_HEADERS = [
  'Level','Region Coach','Area Coach','Store #','Store Name',
  'Avg IST (min)','Total Orders',
  'IST <10 #','IST 10-14 #','IST 15-18 #','IST 19-25 #','IST >25 #','IST <19%'
];

function buildHierarchyRows(stores, label = '') {
  const rows = [];
  // Group by region
  const byRegion = {};
  stores.forEach(s => {
    const r = s.region_coach || 'Unknown';
    if (!byRegion[r]) byRegion[r] = [];
    byRegion[r].push(s);
  });

  // TOTAL row
  rows.push(['TOTAL','ALL','','',`${stores.length} Stores`,
    avgIST(stores), sumOrders(stores),
    stores.reduce((a,s)=>a+(s.wtd_lt10||0),0),
    stores.reduce((a,s)=>a+(s.wtd_1014||0),0),
    stores.reduce((a,s)=>a+(s.wtd_1518||0),0),
    stores.reduce((a,s)=>a+(s.wtd_1925||0),0),
    stores.reduce((a,s)=>a+(s.wtd_gt25||0),0),
    avgLt19(stores)
  ]);

  for (const [region, rStores] of Object.entries(byRegion)) {
    rows.push(['REGION', region, '', '', `${rStores.length} Stores`,
      avgIST(rStores), sumOrders(rStores),
      rStores.reduce((a,s)=>a+(s.wtd_lt10||0),0),
      rStores.reduce((a,s)=>a+(s.wtd_1014||0),0),
      rStores.reduce((a,s)=>a+(s.wtd_1518||0),0),
      rStores.reduce((a,s)=>a+(s.wtd_1925||0),0),
      rStores.reduce((a,s)=>a+(s.wtd_gt25||0),0),
      avgLt19(rStores)
    ]);

    const byArea = {};
    rStores.forEach(s => {
      const a = s.area_coach || 'Unknown';
      if (!byArea[a]) byArea[a] = [];
      byArea[a].push(s);
    });

    for (const [area, aStores] of Object.entries(byArea)) {
      rows.push(['AREA', region, area, '', `${aStores.length} Stores`,
        avgIST(aStores), sumOrders(aStores),
        aStores.reduce((a,s)=>a+(s.wtd_lt10||0),0),
        aStores.reduce((a,s)=>a+(s.wtd_1014||0),0),
        aStores.reduce((a,s)=>a+(s.wtd_1518||0),0),
        aStores.reduce((a,s)=>a+(s.wtd_1925||0),0),
        aStores.reduce((a,s)=>a+(s.wtd_gt25||0),0),
        avgLt19(aStores)
      ]);

      for (const s of aStores) {
        rows.push(['STORE', s.region_coach||'', s.area_coach||'', s.store_id, s.name,
          s.wtd_ist, s.wtd_orders||0,
          s.wtd_lt10||0, s.wtd_1014||0, s.wtd_1518||0,
          s.wtd_1925||0, s.wtd_gt25||0, s.wtd_lt19_pct
        ]);
      }
    }
  }
  return rows;
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
      // Convert raw records to display format
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
      const sheetName = fmtDate(dateStr).substring(0, 31);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dayRows), sheetName);
    }
  }

  // ── PTD Trend Sheet (week-over-week) ─────────────────────────────
  if (allWeekStores && allWeekStores.length && allWeekStores[0]?.weeklyIST) {
    const weeks = Object.keys(allWeekStores[0].weeklyIST).sort();
    const trendHeaders = ['Level','Region Coach','Area Coach','Store #','Store Name',
      ...weeks.map(w => `${w} Avg IST`),
      ...weeks.slice(1).map((w, i) => `Δ ${weeks[i]}→${w}`)
    ];

    const trendRows = [[`PTD Trend — Week over Week IST`], trendHeaders];
    for (const s of allWeekStores) {
      if (s.level !== 'STORE') continue;
      const row = ['STORE', s.region_coach||'', s.area_coach||'', s.store_id, s.name];
      weeks.forEach(w => row.push(s.weeklyIST[w] ?? ''));
      for (let i = 1; i < weeks.length; i++) {
        const prev = s.weeklyIST[weeks[i-1]];
        const curr = s.weeklyIST[weeks[i]];
        if (prev != null && curr != null) {
          const delta = curr - prev;
          row.push(delta > 0 ? `▲ +${delta.toFixed(1)}` : delta < 0 ? `▼ ${delta.toFixed(1)}` : '—');
        } else row.push('—');
      }
      trendRows.push(row);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trendRows), 'PTD Trend');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generateExcelExport };
