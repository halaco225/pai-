// tests/sales-backfill.test.js
const { salesBackfillDue, backfillSales, MAX_SALES_BACKFILLS } = require('../services/brief-sms');

// 2026-10-08: the 6am ODS pull hit a 404 at the CSRF step, intel_dbs_metrics
// held nothing for Oct 7, and the 8:05 text went out with no sales and no
// growth. Re-running the same pipeline by hand filled the day in within about
// ninety seconds, so it is worth attempting before the text goes.
describe('salesBackfillDue', () => {
  beforeEach(() => { jest.resetModules(); });

  test('not due before the window opens', () => {
    expect(salesBackfillDue(new Date('2026-10-09T10:59:00Z'))).toBe(false); // 06:59 EDT
  });

  test('due as soon as it opens', () => {
    expect(salesBackfillDue(new Date('2026-10-09T11:00:00Z'))).toBe(true);  // 07:00 EDT
  });

  test('not due once the send time has passed', () => {
    expect(salesBackfillDue(new Date('2026-10-09T12:31:00Z'))).toBe(false); // 08:31 EDT
  });

  test('not due overnight', () => {
    expect(salesBackfillDue(new Date('2026-10-09T06:00:00Z'))).toBe(false); // 02:00 EDT
  });

  test('not due again straight after an attempt', () => {
    const fresh = require('../services/brief-sms');
    fresh.backfillSales(new Date('2026-10-09T11:00:00Z'));
    expect(fresh.salesBackfillDue(new Date('2026-10-09T11:02:00Z'))).toBe(false);
  });

  test('due again once the spacing has elapsed', () => {
    const fresh = require('../services/brief-sms');
    fresh.backfillSales(new Date('2026-10-09T11:00:00Z'));
    expect(fresh.salesBackfillDue(new Date('2026-10-09T11:15:00Z'))).toBe(true);
  });

  // Re-running the whole pipeline is not free, and a source that is genuinely
  // down will not change its mind before breakfast.
  test('gives up after a bounded number of runs', () => {
    const fresh = require('../services/brief-sms');
    let t = new Date('2026-10-09T11:00:00Z');
    for (let i = 0; i < MAX_SALES_BACKFILLS; i++) {
      fresh.backfillSales(t);
      t = new Date(t.getTime() + 20 * 60000);
    }
    expect(fresh.salesBackfillDue(t)).toBe(false);
  });

  test('holds across the DST boundary', () => {
    const fresh = require('../services/brief-sms');
    expect(fresh.salesBackfillDue(new Date('2026-11-12T12:00:00Z'))).toBe(true);  // 07:00 EST
    expect(fresh.salesBackfillDue(new Date('2026-11-12T11:59:00Z'))).toBe(false); // 06:59 EST
  });
});
