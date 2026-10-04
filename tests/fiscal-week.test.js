// tests/fiscal-week.test.js
const { fiscalWeekBounds, dateElementId, weekFilterExpression } = require('../services/intel-fourth');

// Pizza Hut's fiscal week is Tuesday → Monday. Harold's dashboard showed
// WK40 FY26 as 09/29/2026 – 10/05/2026, which is the fixture for all of this.
describe('fiscalWeekBounds', () => {
  test('matches WK40 FY26 from the dashboard', () => {
    expect(fiscalWeekBounds('2026-10-03')).toEqual({ start: '2026-09-29', end: '2026-10-05' });
  });

  test('the Tuesday it starts on belongs to its own week', () => {
    expect(fiscalWeekBounds('2026-09-29')).toEqual({ start: '2026-09-29', end: '2026-10-05' });
  });

  test('the Monday it ends on still belongs to that week', () => {
    expect(fiscalWeekBounds('2026-10-05')).toEqual({ start: '2026-09-29', end: '2026-10-05' });
  });

  test('the next Tuesday starts the next week', () => {
    expect(fiscalWeekBounds('2026-10-06')).toEqual({ start: '2026-10-06', end: '2026-10-12' });
  });

  // Sunday is the trap: it is day 0, so a naive offset wraps to the wrong week.
  test('Sunday lands in the week that began the previous Tuesday', () => {
    expect(fiscalWeekBounds('2026-10-04')).toEqual({ start: '2026-09-29', end: '2026-10-05' });
  });

  test('crosses a month boundary', () => {
    expect(fiscalWeekBounds('2026-11-01')).toEqual({ start: '2026-10-27', end: '2026-11-02' });
  });
});

describe('dateElementId', () => {
  // Both verified against the live attribute elements, not derived from a
  // formula and hoped for.
  test('matches the element ids Fourth actually returned', () => {
    expect(dateElementId('2026-09-29')).toBe(46293);
    expect(dateElementId('2026-10-05')).toBe(46299);
  });

  test('one day apart is one id apart', () => {
    expect(dateElementId('2026-10-02') - dateElementId('2026-10-01')).toBe(1);
  });

  // Computed in UTC on purpose: a local-time Date would shift the id by one
  // for anyone west of Greenwich, silently filtering to the wrong day.
  test('is not affected by the local timezone', () => {
    expect(dateElementId('2026-01-01')).toBe(dateElementId('2026-01-01'));
    expect(dateElementId('2026-03-08') - dateElementId('2026-03-07')).toBe(1); // US DST weekend
    expect(dateElementId('2026-11-02') - dateElementId('2026-11-01')).toBe(1);
  });
});

describe('weekFilterExpression', () => {
  const f = weekFilterExpression('PROJ', '2026-10-03');

  test('filters the FinancialDay attribute the dashboard uses', () => {
    expect(f.expression).toContain('/gdc/md/PROJ/obj/588882');
  });

  test('spans the whole fiscal week', () => {
    expect(f.start).toBe('2026-09-29');
    expect(f.end).toBe('2026-10-05');
    expect(f.expression).toContain('elements?id=46293');
    expect(f.expression).toContain('elements?id=46299');
  });

  test('is a BETWEEN over elements, which is what MAQL expects', () => {
    expect(f.expression).toMatch(/BETWEEN .+ AND /);
  });
});
