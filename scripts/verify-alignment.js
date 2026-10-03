#!/usr/bin/env node
'use strict';
/**
 * verify-alignment.js — cross-check routes/auth.js USER_ROSTER against the
 * Master Alignment workbook. Exits non-zero on any discrepancy.
 *
 *   node scripts/verify-alignment.js "<path to AYVAZ Master Alignment PXX.xlsx>"
 *
 * The roster is hand-maintained because it carries logins; the workbook is the
 * source of truth for hierarchy. This catches the drift between them — a coach
 * who changed VPs, an area that changed hands, someone who left, someone new
 * who has no login yet.
 */
const XLSX = require('xlsx');
const fs   = require('fs');
const { USER_ROSTER } = require('../routes/auth');

const COL = { store: 1, area: 15, ac: 16, rc: 19, vp: 22 };
const S = v => String(v ?? '').trim();

function main() {
  const file = process.argv[2];
  if (!file)                 { console.error('usage: node scripts/verify-alignment.js <alignment.xlsx>'); process.exit(1); }
  if (!fs.existsSync(file))  { console.error(`not found: ${file}`); process.exit(1); }

  const wb   = XLSX.readFile(file);
  const sh   = wb.Sheets['Master Alignment'] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, blankrows: false })
                   .slice(1).filter(r => S(r[COL.store]));

  const acTruth = new Map(), rcTruth = new Map(), vpTruth = new Map();
  for (const r of rows) {
    const ac = S(r[COL.ac]), rc = S(r[COL.rc]), vp = S(r[COL.vp]);
    if (!ac) continue;
    if (!acTruth.has(ac)) acTruth.set(ac, { area: S(r[COL.area]), rc, vp, stores: 0 });
    acTruth.get(ac).stores++;
    if (!rcTruth.has(rc)) rcTruth.set(rc, { vp, acs: new Set() });
    rcTruth.get(rc).acs.add(ac);
    if (!vpTruth.has(vp)) vpTruth.set(vp, new Set());
    vpTruth.get(vp).add(rc);
  }

  const problems = [];
  const seen = { ac: new Set(), rc: new Set(), vp: new Set() };

  for (const u of USER_ROSTER) {
    const sc = u.scope || {};
    if (u.role === 'area_coach') {
      seen.ac.add(u.name);
      const t = acTruth.get(u.name);
      if (!t) { problems.push(`AC GONE: ${u.name} (${u.username}) is not in the workbook`); continue; }
      if (t.area !== sc.area)       problems.push(`AC AREA: ${u.name} roster=${sc.area} workbook=${t.area}`);
      if (t.rc   !== sc.region_coach) problems.push(`AC RC:   ${u.name} roster=${sc.region_coach} workbook=${t.rc}`);
      if (t.vp   !== sc.vp)         problems.push(`AC VP:   ${u.name} roster=${sc.vp} workbook=${t.vp}`);
    } else if (u.role === 'rdo') {
      seen.rc.add(u.name);
      const t = rcTruth.get(u.name);
      if (!t) { problems.push(`RC GONE: ${u.name} is not in the workbook`); continue; }
      if (t.vp !== sc.vp) problems.push(`RC VP:   ${u.name} roster=${sc.vp} workbook=${t.vp}`);
      const have = new Set(sc.area_coaches || []);
      for (const ac of t.acs) if (!have.has(ac)) problems.push(`RC MISSING AC: ${u.name} should include ${ac}`);
      for (const ac of have) if (!t.acs.has(ac)) problems.push(`RC EXTRA AC:   ${u.name} lists ${ac}, not theirs in the workbook`);
    } else if (u.role === 'vp') {
      seen.vp.add(u.name);
      const t = vpTruth.get(u.name);
      if (!t) { problems.push(`VP GONE: ${u.name} is not in the workbook`); continue; }
      const have = new Set(sc.region_coaches || []);
      for (const rc of t)    if (!have.has(rc)) problems.push(`VP MISSING RC: ${u.name} should include ${rc}`);
      for (const rc of have) if (!t.has(rc))    problems.push(`VP EXTRA RC:   ${u.name} lists ${rc}, not theirs in the workbook`);
    }
  }

  for (const [ac, t] of acTruth) if (!seen.ac.has(ac)) problems.push(`AC NEW: ${ac} has no login (${t.stores} stores, ${t.area}, under ${t.rc})`);
  for (const rc of rcTruth.keys()) if (!seen.rc.has(rc)) problems.push(`RC NEW: ${rc} has no login`);
  for (const vp of vpTruth.keys()) if (!seen.vp.has(vp)) problems.push(`VP NEW: ${vp} has no login`);

  console.log(`Workbook: ${rows.length} stores · ${acTruth.size} ACs · ${rcTruth.size} RCs · ${vpTruth.size} VPs`);
  console.log(`Roster:   ${seen.ac.size} ACs · ${seen.rc.size} RCs · ${seen.vp.size} VPs`);

  if (!problems.length) { console.log('\nRoster matches the workbook.'); return; }
  console.log(`\n${problems.length} discrepanc${problems.length === 1 ? 'y' : 'ies'}:\n`);
  problems.forEach(p => console.log('  ' + p));
  process.exitCode = 1;
}

main();
