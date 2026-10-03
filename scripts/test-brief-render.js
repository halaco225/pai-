#!/usr/bin/env node
'use strict';
/**
 * test-brief-render.js — end-to-end render of a morning brief with no API key.
 *
 *   node scripts/test-brief-render.js
 *
 * The lede is the only part that calls the model, and it fails soft to an empty
 * string. So with no key this exercises the whole deterministic path and proves
 * the brief still carries every number on its own.
 */
delete process.env.ANTHROPIC_API_KEY;

const { buildScorecard } = require('../services/scorecard');
const { generateMorningBrief } = require('../services/claude');

const store = (o) => Object.assign({
  store_id: '039377', store_name: 'Griffin', area: 'Area 2011',
  area_coach: 'Darian Spikes', region_coach: 'Harold Lacoste', vp: 'Matt Hester',
  net_sales: 9000, growth_pct: 2, ist_avg: 18, total_orders: 800,
  act_hrs: 120, sch_hrs: 115, win_score: 76, survey_count: 30, missed_routines: 0,
}, o);

const ROWS = [
  store({}),
  store({ store_id: '039378', store_name: 'Union City', net_sales: 8000, growth_pct: -3.5,
          ist_avg: 24, total_orders: 700, act_hrs: 131, sch_hrs: 120,
          win_score: 68, survey_count: 20, missed_routines: 2 }),
  store({ store_id: '038876', store_name: 'Senoia', net_sales: 6200, growth_pct: 6.1,
          ist_avg: null, total_orders: null, act_hrs: 90, sch_hrs: 95,
          win_score: null, survey_count: null, missed_routines: 0 }),
];

const ALERTS = {
  hutbot: [{ store_name: 'Union City', store_id: '039378', area_coach: 'Darian Spikes',
             metric_type: 'ROUTINE_MISSED', consecutive_days_out: 2 }],
  clockOut: [{ store_name: 'Griffin', store_id: '039377', area_coach: 'Darian Spikes',
               metric_type: 'FORGOT_CLOCKOUT', value: 2,
               details: { employees: [{ name: 'A. Carter' }, { name: 'J. Reyes' }] } }],
  labor: [], otd: [], changeDown: [], cancelTender: [],
  smg: [{ store_name: 'Union City', store_id: '039378', area_coach: 'Darian Spikes',
          comment_text: 'Staff was rude and the order was wrong',
          categories: ['service'], name_mentioned: null }],
};

(async () => {
  const sc = await buildScorecard({
    pool: { query: async () => ({ rows: ROWS }) },
    targetDate: '2026-10-01',
    role: 'area_coach', name: 'Darian Spikes', scope: { ac_name: 'Darian Spikes' },
  });

  const brief = await generateMorningBrief({
    date: '2026-10-01', userName: 'Darian Spikes', userRole: 'area_coach',
    fiscalContext: 'Period 10 Week 4 (P10W4)',
    regionMetrics: { store_count: 3, net_sales_day: 23200, avg_growth_day: 1.5 },
    byAC: [], byStore: [], velocity: [], flags: [],
    shoutouts: [], followUps: [], operationalAlerts: ALERTS,
    scorecard: sc,
  });

  console.log('='.repeat(72));
  console.log(brief);
  console.log('='.repeat(72));

  let fail = 0;
  const must = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) fail++; };

  console.log('\nAssertions:');
  must('has MORNING BRIEF header',        /MORNING BRIEF/.test(brief));
  must('fiscal day code present',         /P10W4D/.test(brief));
  must('scorecard own heading',           /YOUR AREA/.test(brief));
  must('all five metrics labelled',
       /Sales/.test(brief) && /IST/.test(brief) && /Labor hrs/.test(brief)
       && /WIN PTD/.test(brief) && /Missed routines/.test(brief));
  must('BY STORE table present',          /BY STORE/.test(brief));
  must('worst store listed first',        brief.indexOf('Union City') < brief.indexOf('Senoia'));
  must('missing IST renders as dash',     /Senoia\s+\$6,200\s+\+6\.1%\s+—/.test(brief));
  must('coverage note on thin IST',       /2\/3 reporting/.test(brief));
  must('attack list still there',         /ATTACK LIST/.test(brief));
  must('missed routine in attack list',   /HutBot/.test(brief));
  must('SMG pulse still there',           /SMG CUSTOMER PULSE/.test(brief));
  must('no markdown leaked in',           !/\*\*/.test(brief));
  must('no NaN or undefined',             !/NaN|undefined/.test(brief));

  console.log(fail ? `\n${fail} FAILED` : '\nAll assertions passed.');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('THREW:', e.message); process.exitCode = 1; });
