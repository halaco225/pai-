#!/usr/bin/env node
'use strict';
/**
 * test-scorecard.js — proves the rollup arithmetic against hand-computed truth.
 *
 *   node scripts/test-scorecard.js
 *
 * No database: a fake pool returns fixed store rows, so the assertions below are
 * about the aggregation rules, not about what happens to be in Postgres today.
 */
const { buildScorecard } = require('../services/scorecard');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected
    || (typeof actual === 'number' && typeof expected === 'number'
        && Math.abs(actual - expected) < 0.051);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`);
  if (!ok) failures++;
}

function fakePool(rows) {
  return { query: async () => ({ rows }) };
}

// Two stores under one area coach. Deliberately lopsided order counts so a
// straight average of IST would give a visibly different answer.
const AREA_ROWS = [
  { store_id: '039377', store_name: 'Griffin', area: 'Area 2011',
    area_coach: 'Darian Spikes', region_coach: 'Harold Lacoste', vp: 'Matt Hester',
    net_sales: 10000, growth_pct: 10,      // LY = 10000 / 1.10 = 9090.909
    ist_avg: 15, total_orders: 2000,
    act_hrs: 100, sch_hrs: 90,
    win_score: 80, survey_count: 90,
    missed_routines: 1 },
  { store_id: '039378', store_name: 'Union City', area: 'Area 2011',
    area_coach: 'Darian Spikes', region_coach: 'Harold Lacoste', vp: 'Matt Hester',
    net_sales: 5000,  growth_pct: -20,     // LY = 5000 / 0.80 = 6250
    ist_avg: 25, total_orders: 200,
    act_hrs: 40,  sch_hrs: 50,
    win_score: 60, survey_count: 10,
    missed_routines: 0 },
];

(async () => {
  console.log('Area coach scope — own line (2 stores):\n');
  const sc = await buildScorecard({
    pool: fakePool(AREA_ROWS), targetDate: '2026-10-01',
    role: 'area_coach', name: 'Darian Spikes', scope: { ac_name: 'Darian Spikes' },
  });

  check('level',      sc.level,      'area');
  check('childLevel', sc.childLevel, 'store');
  check('row count',  sc.rows.length, 2);

  const own = sc.own;
  check('sales (10000 + 5000)', own.sales, 15000);

  // LY = 9090.909 + 6250 = 15340.909 ; growth = (15000 - 15340.909) / 15340.909
  check('growth recomputed from summed LY, not averaged', own.growth_pct, -2.2);
  // The naive average of +10 and -20 would be -5.0 — a very different story.

  // IST order-weighted: (15*2000 + 25*200) / 2200 = 35000 / 2200 = 15.909
  check('IST weighted by orders', own.ist, 15.9);
  // Straight average would be 20.0 — wrong by 4 minutes.

  check('act hrs summed',  own.act_hrs,      140);
  check('sch hrs summed',  own.sch_hrs,      140);
  check('hrs variance on the sums', own.hrs_variance, 0);
  // Note: +10 at one store and -10 at the other nets to zero at the area line.

  // WIN survey-weighted: (80*90 + 60*10) / 100 = 7800 / 100 = 78.0
  check('WIN weighted by surveys', own.win, 78);
  check('WIN flagged approximate', own.win_approx, true);

  check('missed routines summed', own.missed_routines, 1);
  check('coverage shown',         own.sales_coverage, '2/2');

  console.log('\nRows sorted worst growth first:');
  sc.rows.forEach(r => console.log(`  ${r.label}: ${r.growth_pct}%`));
  check('worst first', sc.rows[0].label, 'Union City');

  console.log('\nMissing data must read null, never 0:\n');
  const sparse = await buildScorecard({
    pool: fakePool([{ ...AREA_ROWS[0],
      net_sales: null, growth_pct: null,
      ist_avg: null, total_orders: null,
      act_hrs: null, sch_hrs: null,
      win_score: null, survey_count: null, missed_routines: 0 }]),
    targetDate: '2026-10-01',
    role: 'area_coach', name: 'Darian Spikes', scope: { ac_name: 'Darian Spikes' },
  });
  check('sales null not 0',  sparse.own.sales,  null);
  check('IST null not 0',    sparse.own.ist,    null);
  check('labor null not 0',  sparse.own.act_hrs, null);
  check('WIN null not 0',    sparse.own.win,    null);
  check('coverage exposes the gap', sparse.own.sales_coverage, '0/1');

  console.log('\nRDO scope groups by area coach:\n');
  const rdo = await buildScorecard({
    pool: fakePool([...AREA_ROWS,
      { ...AREA_ROWS[0], store_id: '039383', store_name: 'Stockbridge',
        area: 'Area 2016', area_coach: 'Ebony Simmons', net_sales: 8000, growth_pct: 5 }]),
    targetDate: '2026-10-01',
    role: 'rdo', name: 'Harold Lacoste', scope: { rc_name: 'Harold Lacoste' },
  });
  check('rdo level',      rdo.level,       'region');
  check('two area rows',  rdo.rows.length, 2);
  check('area label carries the number', rdo.rows.some(r => r.label === 'Area 2016 — Ebony Simmons'), true);

  console.log(failures ? `\n${failures} FAILED` : '\nAll assertions passed.');
  process.exitCode = failures ? 1 : 0;
})();
