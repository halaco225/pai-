// smg_win_scores sat empty for months while the nightly pipeline logged the
// Win Score step as a success every single night. Two separate faults did that,
// and a tester noticing his score did not match is how it finally surfaced.
//
// First, the pipeline called the HTTP implementation, which drives a saved SMG
// favourite that is region-level and rolling-30-day. A region-level report
// returns one aggregate row with no store id, so the parser found no store rows
// and wrote nothing. The browser implementation — the one the manual
// /api/brief/winscore/run endpoint has been using — rebuilds the report the way
// it is run by hand, at store level grouped by area, reading every page.
//
// Second, writing nothing was reported as success, so nothing ever complained.
//
// These pin the wiring. The numbers themselves need the live site and cannot be
// tested here.

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const pipeline = read('services/intel-pipeline.js');

const { WANT, pullAndStore } = require('../services/intel-smg-winscore-browser');

describe('the nightly pipeline pulls Win Score the way it is run by hand', () => {
  test('it uses the browser implementation', () => {
    expect(pipeline).toContain("require('./intel-smg-winscore-browser')");
  });

  test('it no longer calls the one that has never written a row', () => {
    expect(pipeline).not.toContain("require('./intel-smg-winscore')");
  });

  test('the browser implementation offers what the pipeline needs', () => {
    expect(typeof pullAndStore).toBe('function');
    // It takes no date: the report carries its own Current Fiscal Period.
    expect(pullAndStore.length).toBe(0);
  });
});

describe('a pull that writes nothing is a failed pull', () => {
  // Extract the step so the rule is checked, not just its presence.
  const step = pipeline.slice(
    pipeline.indexOf('Step 6b'),
    pipeline.indexOf("await logStep('winScore'")
  );

  test('the step exists and was found', () => {
    expect(step.length).toBeGreaterThan(0);
  });

  test('success is conditional on rows actually landing', () => {
    expect(step).toMatch(/wr\.written\s*>\s*0/);
  });

  test('zero rows reports an error naming the period', () => {
    expect(step).toMatch(/success:\s*false/);
    expect(step).toMatch(/wrote no store rows/);
  });
});

describe('the date type is chosen on purpose', () => {
  test('it is stated, not left to whatever SMG defaults to', () => {
    expect(WANT.dateType).toBeTruthy();
    expect(['Survey Date', 'Visit Date']).toContain(WANT.dateType);
  });

  test('it is the one the recipe was captured with', () => {
    // docs/SMG_WIN_SCORE.md, written watching the report run by hand. If this
    // is ever deliberately switched to Visit Date, that doc changes with it —
    // the two count different things and give different numbers for a period.
    expect(WANT.dateType).toBe('Survey Date');
    expect(read('docs/SMG_WIN_SCORE.md')).toMatch(/Survey Date/);
  });

  test('it is picked by its label, never by a radio value', () => {
    const svc = read('services/intel-smg-winscore-browser.js');
    expect(svc).toContain('checkRadioByLabel');
    // The old selector keyed on value="2", which a rename would silently break.
    expect(svc).not.toMatch(/input\[type=radio\]\[value="2"\]/);
  });

  test('a date type that cannot be set stops the run', () => {
    const svc = read('services/intel-smg-winscore-browser.js');
    const fn = svc.slice(svc.indexOf('async function checkRadioByLabel'), svc.indexOf('async function settle'));
    expect(fn).toMatch(/throw new Error/);
    // And says what was on offer, so the next person can see what moved.
    expect(fn).toMatch(/On offer/);
  });
});

describe('every page of the report still gets read', () => {
  const svc = read('services/intel-smg-winscore-browser.js');

  test('the report paginates and the reader follows it', () => {
    // Two pages for this region — a first-page-only read loses half the stores.
    expect(svc).toContain('readAllPages');
    expect(svc).toMatch(/Next/);
  });
});
