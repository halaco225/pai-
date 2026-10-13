const path = require('path');
const { parseSusDbs, cheeseFromRows, STORE_RE } = require('../services/parsers/sus-dbs-parser');

const FIXTURE = path.join(__dirname, 'fixtures', 'sus-dbs-sample.xlsx');
const DATE    = '2026-10-11';

describe('parseSusDbs', () => {
  const out = parseSusDbs(FIXTURE, DATE);

  test('emits one cheese_usage row per store that reported', () => {
    expect(out.softIndicators.length).toBe(36);          // 37 blocks, one blank
    expect(out.softIndicators.every(r => r.indicator === 'cheese_usage')).toBe(true);
  });

  test('value is actual usage and target is ideal usage', () => {
    const first = out.softIndicators.find(r => r.store_id === '038876');
    expect(first).toEqual({
      store_id: '038876', metric_date: DATE,
      indicator: 'cheese_usage', value: 80, target: 81.9, source: 'ODS',
    });
  });

  test('strips the leading S so ids match store_assignments', () => {
    expect(out.softIndicators.every(r => /^\d{6}$/.test(r.store_id))).toBe(true);
  });

  test('skips a store whose cheese row is blank rather than calling it zero', () => {
    expect(out.softIndicators.find(r => r.store_id === '039385')).toBeUndefined();
    expect(out.skipped).toEqual(['039385']);
  });

  test('the territory rolls up to the sum of its stores', () => {
    const ideal  = out.softIndicators.reduce((a, s) => a + s.target, 0);
    const actual = out.softIndicators.reduce((a, s) => a + s.value, 0);
    expect(Number((ideal - actual).toFixed(2))).toBe(-48.22);
  });

  test("target minus value reproduces the report's own Variance column", () => {
    const s = out.softIndicators.find(r => r.store_id === '038876');
    expect(Number((s.target - s.value).toFixed(2))).toBe(1.9);
  });
});

describe('cheeseFromRows', () => {
  test('finds the columns by header name, not by position', () => {
    const rows = [
      ['S012345 (Somewhere)'],
      ['DAILY CRITICAL ITEMS'],
      ['', 'Actual Usage', 'Ideal Usage', 'Variance'],   // columns swapped
      ['CHEESE', 50, 60, 10],
    ];
    const out = cheeseFromRows(rows, '2026-10-11');
    expect(out.softIndicators[0]).toMatchObject({ store_id: '012345', value: 50, target: 60 });
  });

  test('emits nothing when the header has no Ideal/Actual columns', () => {
    const rows = [
      ['S012345 (Somewhere)'],
      ['DAILY CRITICAL ITEMS'],
      ['', 'Something Else', 'Another Thing'],
      ['CHEESE', 50, 60, 10],
    ];
    const out = cheeseFromRows(rows, '2026-10-11');
    expect(out.softIndicators).toHaveLength(0);
    expect(out.skipped).toContain('012345');
  });

  test('a cheese row before any store header is ignored', () => {
    const out = cheeseFromRows([['', 'Ideal Usage', 'Actual Usage'], ['CHEESE', 1, 2, 3]], '2026-10-11');
    expect(out.softIndicators).toHaveLength(0);
  });

  test('STORE_RE reads the id and name out of a block header', () => {
    expect(STORE_RE.exec('S038876 (Wells Street)').slice(1, 3)).toEqual(['038876', 'Wells Street']);
  });
});
