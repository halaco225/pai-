// tests/sales-backfill.test.js
const { salesBackfillDue, backfillSales } = require('../services/brief-sms');

// 2026-10-08: the 6am ODS pull hit a 404 at the CSRF step, intel_dbs_metrics
// held nothing for Oct 7, and the 8:05 text went out with no sales and no
// growth. Re-running the same pipeline by hand filled the day in within about
// ninety seconds, so it is worth one automatic attempt before the text goes.
describe('salesBackfillDue', () => {
  test('not due before the refresh time', () => {
    expect(salesBackfillDue(new Date('2026-10-09T11:29:00Z'))).toBe(false); // 07:29 EDT
  });

  test('due at the refresh time', () => {
    expect(salesBackfillDue(new Date('2026-10-09T11:30:00Z'))).toBe(true);  // 07:30 EDT
  });

  // Past the send there is nothing left to fix for today.
  test('not due once the send time has passed', () => {
    expect(salesBackfillDue(new Date('2026-10-09T12:06:00Z'))).toBe(false); // 08:06 EDT
  });

  test('not due overnight', () => {
    expect(salesBackfillDue(new Date('2026-10-09T06:00:00Z'))).toBe(false); // 02:00 EDT
  });

  // A pipeline that fails twice is not a blip, and a two-minute tick would
  // otherwise re-run the whole thing for the length of the window.
  test('only fires once for a given day', () => {
    jest.resetModules();
    const fresh = require('../services/brief-sms');
    const t = new Date('2026-10-10T11:31:00Z');
    expect(fresh.salesBackfillDue(t)).toBe(true);
    fresh.backfillSales(t);                      // marks the day as checked
    expect(fresh.salesBackfillDue(t)).toBe(false);
  });

  test('holds across the DST boundary', () => {
    jest.resetModules();
    const fresh = require('../services/brief-sms');
    expect(fresh.salesBackfillDue(new Date('2026-11-12T12:30:00Z'))).toBe(true);  // 07:30 EST
    expect(fresh.salesBackfillDue(new Date('2026-11-12T12:29:00Z'))).toBe(false); // 07:29 EST
  });
});
