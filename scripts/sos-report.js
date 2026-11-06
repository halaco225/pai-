#!/usr/bin/env node
// Read a PH_Speed_Of_Service.xlsx straight off disk and print the numbers,
// by store and rolled up by area. Nothing here touches ODS or the database —
// this is the path to accurate numbers when the dashboard is in doubt.
//
//   node scripts/sos-report.js <file.xlsx> [name-or-area]
//
// The optional filter matches an area coach, an area, a region coach or a
// store number, case-insensitively: "jadon", "Area 2022", "S039382".
'use strict';

const { parseSOSExcelODS, parseMinutes } = (() => {
  const p = require('../services/velocity-parser');
  const c = require('../services/velocity-compute');
  return { parseSOSExcelODS: p.parseSOSExcelODS, parseMinutes: c.parseMinutes };
})();
const { ALIGNMENT } = require('../services/velocity-alignment');

const [file, filter] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/sos-report.js <file.xlsx> [name-or-area]');
  process.exit(1);
}

let parsed;
try {
  parsed = parseSOSExcelODS(file);
} catch (e) {
  console.error('\nCould not read the report:\n  ' + e.message + '\n');
  process.exit(1);
}

const mmss = (v) => {
  const m = parseMinutes(v);
  if (m == null) return '—';
  const whole = Math.floor(m);
  return `${whole}:${String(Math.round((m - whole) * 60)).padStart(2, '0')}`;
};
const n1 = (v) => (v == null ? '—' : v.toFixed(1));

// Only stores on the roster, and only the ones the filter asks for.
const rows = parsed.stores
  .map(s => ({ ...s, ...(ALIGNMENT[s.store_id] || {}) }))
  .filter(s => s.area)
  .filter(s => !filter || [s.area_coach, s.area, s.region_coach, s.store_id, s.name]
    .some(f => String(f || '').toLowerCase().includes(filter.toLowerCase())));

if (!rows.length) {
  console.error(`No stores on the roster matched ${filter ? `"${filter}"` : 'the report'}.`);
  process.exit(1);
}

// An area's IST is weighted by orders. A flat average of store averages lets a
// 12-order store count as much as a 60-order one, so both are printed — above
// store reports differ on which they show.
function rollUp(list) {
  const withIST    = list.filter(s => s.ist_avg != null);
  const orders     = list.reduce((a, s) => a + (s.total_orders || 0), 0);
  const weightable = withIST.filter(s => s.total_orders);
  const weighted   = weightable.length && orders
    ? weightable.reduce((a, s) => a + s.ist_avg * s.total_orders, 0) /
      weightable.reduce((a, s) => a + s.total_orders, 0)
    : null;
  const flat = withIST.length
    ? withIST.reduce((a, s) => a + s.ist_avg, 0) / withIST.length
    : null;
  const avg = (f) => {
    const vals = list.map(s => parseMinutes(s[f])).filter(v => v != null);
    return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  };
  const pct = (f) => {
    const vals = list.map(s => s[f]).filter(v => v != null);
    return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  };
  return {
    stores: list.length, orders, weighted, flat,
    make: avg('make_time'), prod: avg('production_time'),
    onTime: pct('on_time_pct'), lt4: pct('pct_lt4'), lt15: pct('pct_lt15')
  };
}

console.log(`\nSpeed of Service — report date ${parsed.reportDate || '(none in file)'}`);
console.log(`${rows.length} store(s) on the roster${filter ? ` matching "${filter}"` : ''}, of ${parsed.stores.length} in the file\n`);

const byArea = {};
for (const s of rows) (byArea[s.area] ||= []).push(s);

for (const [area, list] of Object.entries(byArea).sort()) {
  const r = rollUp(list);
  console.log(`${area} — ${list[0].area_coach}   (${list[0].region_coach})`);
  console.log('  store      name                  IST   ord   make   prod   on-time  %<4    %<15');
  for (const s of list.sort((a, b) => (b.ist_avg || 0) - (a.ist_avg || 0))) {
    console.log(
      `  ${s.store_id}  ${String(s.name).padEnd(20).slice(0, 20)}  ` +
      `${String(n1(s.ist_avg)).padStart(5)} ${String(s.total_orders ?? '—').padStart(5)}  ` +
      `${mmss(s.make_time).padStart(5)}  ${mmss(s.production_time).padStart(5)}  ` +
      `${String(n1(s.on_time_pct)).padStart(7)}  ${String(n1(s.pct_lt4)).padStart(5)}  ${String(n1(s.pct_lt15)).padStart(5)}`
    );
  }
  console.log(
    `  AREA       ${String(r.stores + ' stores').padEnd(20)}  ${String(n1(r.weighted)).padStart(5)} ` +
    `${String(r.orders).padStart(5)}  ${mmss(r.make).padStart(5)}  ${mmss(r.prod).padStart(5)}  ` +
    `${String(n1(r.onTime)).padStart(7)}  ${String(n1(r.lt4)).padStart(5)}  ${String(n1(r.lt15)).padStart(5)}`
  );
  console.log(`  IST ${n1(r.weighted)} weighted by orders · ${n1(r.flat)} flat average of stores\n`);
}

if (Object.keys(byArea).length > 1) {
  const t = rollUp(rows);
  console.log(`TOTAL — ${t.stores} stores, ${t.orders} orders`);
  console.log(`  IST ${n1(t.weighted)} weighted · ${n1(t.flat)} flat · make ${mmss(t.make)} · prod ${mmss(t.prod)} · on-time ${n1(t.onTime)}\n`);
}
