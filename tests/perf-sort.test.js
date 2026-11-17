// The intel performance table used to be locked to net sales, biggest first.
// A tester asked to rank by a column instead: click Growth and the best sits
// at the top, click again and the worst does.
//
// These run the page's own comparator rather than asserting on its source, so
// a change that quietly breaks the ranking fails here and not on his screen.

const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'intel.html'), 'utf8');
const OPEN = '// ─── perf-sort:pure ───';
const SHUT = '// ─── /perf-sort:pure ───';

test('the sort block is still marked off in the page', () => {
  expect(page).toContain(OPEN);
  expect(page).toContain(SHUT);
});

const block = page.split(OPEN)[1].split(SHUT)[0];
const {
  perfSortedBy, perfTheadFor, perfRoutines, perfLaborPct,
  PERF_COLS_AC, PERF_COLS_STORE,
} = new Function(block + `;return {
  perfSortedBy, perfTheadFor, perfRoutines, perfLaborPct,
  PERF_COLS_AC, PERF_COLS_STORE };`)();

const ac = (name, over) => ({ area_coach: name, net_sales: 1000, growth_pct: 0, ...over });
const names = rows => rows.map(r => r.area_coach);

describe('ranking by a column', () => {
  const rows = [
    ac('Coach A', { growth_pct: 2.5,  net_sales: 500 }),
    ac('Coach B', { growth_pct: -7.9, net_sales: 900 }),
    ac('Coach C', { growth_pct: 26.5, net_sales: 100 }),
  ];

  test('growth, biggest first', () => {
    const out = perfSortedBy(rows, PERF_COLS_AC, { key: 'growth_pct', dir: 1 });
    expect(names(out)).toEqual(['Coach C', 'Coach A', 'Coach B']);
  });

  test('clicking again flips it', () => {
    const out = perfSortedBy(rows, PERF_COLS_AC, { key: 'growth_pct', dir: -1 });
    expect(names(out)).toEqual(['Coach B', 'Coach A', 'Coach C']);
  });

  test('net sales descending is still the opening order', () => {
    const out = perfSortedBy(rows, PERF_COLS_AC, { key: 'net_sales', dir: 1 });
    expect(names(out)).toEqual(['Coach B', 'Coach A', 'Coach C']);
  });

  test('a column the table does not have falls back to net sales', () => {
    // Switching between the two tables carries the sort key across, and only
    // one of them has a Labor column — so an unknown key must not drop the sort.
    expect(PERF_COLS_STORE.some(c => c.k === 'labor')).toBe(false);
    const store = perfSortedBy(rows, PERF_COLS_STORE, { key: 'labor', dir: 1 });
    const bogus = perfSortedBy(rows, PERF_COLS_AC, { key: 'nope', dir: 1 });
    expect(names(store)).toEqual(['Coach B', 'Coach A', 'Coach C']);
    expect(names(bogus)).toEqual(['Coach B', 'Coach A', 'Coach C']);
  });

  test('a column where nobody has a figure leaves the order alone', () => {
    const out = perfSortedBy(rows, PERF_COLS_AC, { key: 'labor', dir: 1 });
    expect(names(out)).toEqual(['Coach A', 'Coach B', 'Coach C']);
  });

  test('the name column opens A to Z and flips to Z to A', () => {
    expect(names(perfSortedBy(rows, PERF_COLS_AC, { key: 'name', dir: -1 })))
      .toEqual(['Coach A', 'Coach B', 'Coach C']);
    expect(names(perfSortedBy(rows, PERF_COLS_AC, { key: 'name', dir: 1 })))
      .toEqual(['Coach C', 'Coach B', 'Coach A']);
  });
});

describe('a blank is not a score', () => {
  // The whole point: no Win Score yet must not read as the worst Win Score.
  const rows = [
    ac('Has one',   { avg_win_score: 58 }),
    ac('Blank',     { avg_win_score: null }),
    ac('Has a low', { avg_win_score: 41 }),
  ];

  test('blanks sit at the bottom, biggest first', () => {
    expect(names(perfSortedBy(rows, PERF_COLS_AC, { key: 'win_score', dir: 1 })))
      .toEqual(['Has one', 'Has a low', 'Blank']);
  });

  test('blanks sit at the bottom flipped too', () => {
    expect(names(perfSortedBy(rows, PERF_COLS_AC, { key: 'win_score', dir: -1 })))
      .toEqual(['Has a low', 'Has one', 'Blank']);
  });

  test('two blanks hold their order', () => {
    const two = [ac('X', { avg_win_score: null }), ac('Y', { avg_win_score: null })];
    expect(names(perfSortedBy(two, PERF_COLS_AC, { key: 'win_score', dir: 1 })))
      .toEqual(['X', 'Y']);
  });
});

describe('what counts as blank', () => {
  test('nothing missed and nothing late is a real zero, not a blank', () => {
    expect(perfRoutines({ routines_missed: 0, routines_late: 0 })).toBe(0);
    expect(perfRoutines({})).toBeNull();
    expect(perfRoutines({ routines_missed: 2, routines_late: 1 })).toBe(3);
  });

  test('a zero sorts above a blank, because zero missed is the best score', () => {
    const rows = [
      ac('None',  { routines_missed: 0, routines_late: 0 }),
      ac('Blank', {}),
      ac('Three', { routines_missed: 3 }),
    ];
    expect(names(perfSortedBy(rows, PERF_COLS_AC, { key: 'routines', dir: -1 })))
      .toEqual(['None', 'Three', 'Blank']);
  });

  test('labour outside the 5-60% window is not a figure', () => {
    expect(perfLaborPct({ labor_pct: 28.4 })).toBe(28.4);
    expect(perfLaborPct({ act_labor_pct: 31 })).toBe(31);
    expect(perfLaborPct({ labor_pct: 0 })).toBeNull();
    expect(perfLaborPct({ labor_pct: 412 })).toBeNull();
    expect(perfLaborPct({})).toBeNull();
  });
});

describe('the header shows which way it is pointing', () => {
  test('the sorted column is marked and carries an arrow', () => {
    const html = perfTheadFor(PERF_COLS_AC, { key: 'growth_pct', dir: 1 });
    expect(html).toContain('class="perf-sort active" onclick="setPerfSort(\'growth_pct\',false)"');
    expect(html).toContain('Growth ▾');
    expect(html).toContain('class="perf-sort" onclick="setPerfSort(\'net_sales\',false)"');
  });

  test('flipped shows the other arrow', () => {
    expect(perfTheadFor(PERF_COLS_AC, { key: 'growth_pct', dir: -1 })).toContain('Growth ▴');
  });

  test('the rank column is not clickable', () => {
    expect(perfTheadFor(PERF_COLS_AC, perfSortOpen())).toContain('<th>#</th>');
  });

  test('every other column is clickable, both tables', () => {
    for (const cols of [PERF_COLS_AC, PERF_COLS_STORE]) {
      const html = perfTheadFor(cols, perfSortOpen());
      for (const c of cols.filter(c => c.k)) {
        expect(html).toContain(`setPerfSort('${c.k}'`);
      }
    }
  });

  function perfSortOpen() { return { key: 'net_sales', dir: 1 }; }
});
