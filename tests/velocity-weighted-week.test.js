// A tester reported that make and production times on the Velocity screen did
// not agree with what Velocity itself reports for the same week.
//
// The week's figure was a plain mean of the daily averages, so a 7-delivery
// Tuesday weighed exactly as much as a 36-delivery Friday. Weighting by the
// day's volume fixes that. These pin it down, including the case the old code
// got silently wrong: a day with an IST but no bucket split counted as 0%.
//
// One honest limit, confirmed with Harold on 2026-11-17: the only count in the
// Speed of Service report is "# Del", while Make and Production in it are all
// orders. So the weight is a proxy for how busy the day was, not the exact
// order count behind those two figures. Unequal days are no longer treated as
// equal, which was the error worth fixing; it is not yet the true mean.

const { computeWTD, meanOverOrders, parseMinutes } = require('../services/velocity-compute');
const { ALIGNMENT } = require('../services/velocity-alignment');

const day = (orders, over = {}) => ({ total_orders: orders, ...over });

describe('meanOverOrders', () => {
  test('weights each day by the orders it was measured over', () => {
    // (2 x 10 + 8 x 40) / 50 = 6.8 — a plain mean would say 5.
    const days = [day(10, { v: 2 }), day(40, { v: 8 })];
    expect(meanOverOrders(days, d => d.v)).toBeCloseTo(6.8, 10);
  });

  test('the busy day moves the week more than the quiet one', () => {
    const quietBusy = [day(7, { v: 10 }), day(36, { v: 20 })];
    const naive = (10 + 20) / 2;
    const real = meanOverOrders(quietBusy, d => d.v);
    expect(real).toBeGreaterThan(naive);
    expect(real).toBeCloseTo((10 * 7 + 20 * 36) / 43, 10);
  });

  test('equal volume days come out as the plain mean', () => {
    const days = [day(20, { v: 3 }), day(20, { v: 5 })];
    expect(meanOverOrders(days, d => d.v)).toBeCloseTo(4, 10);
  });

  test('a day with no figure is left out, not counted as zero', () => {
    const days = [day(10, { v: 4 }), day(10, { v: null }), day(10, {})];
    expect(meanOverOrders(days, d => d.v ?? null)).toBeCloseTo(4, 10);
  });

  test('no figures at all is no answer, not zero', () => {
    expect(meanOverOrders([day(10, { v: null })], d => d.v)).toBeNull();
    expect(meanOverOrders([], d => d.v)).toBeNull();
    expect(meanOverOrders(null, d => d.v)).toBeNull();
  });

  test('counts missing everywhere falls back to a plain mean rather than losing the week', () => {
    const days = [{ v: 2 }, { v: 8 }];
    expect(meanOverOrders(days, d => d.v)).toBeCloseTo(5, 10);
  });

  test('a zero or negative count is treated as no count', () => {
    const days = [day(0, { v: 2 }), day(-5, { v: 8 })];
    expect(meanOverOrders(days, d => d.v)).toBeCloseTo(5, 10);
  });

  test('when only some days carry a count, the countless ones sit out', () => {
    // 4 is the only weighable day, so it is the week.
    const days = [day(10, { v: 4 }), { v: 99 }];
    expect(meanOverOrders(days, d => d.v)).toBeCloseTo(4, 10);
  });

  test('an infinite or NaN figure is not a figure', () => {
    const days = [day(10, { v: NaN }), day(10, { v: Infinity }), day(10, { v: 6 })];
    expect(meanOverOrders(days, d => d.v)).toBeCloseTo(6, 10);
  });
});

describe('the week on the screen', () => {
  // computeWTD only reports stores it has alignment for, so take one from there
  // rather than naming a real store in a public repo.
  const storeId = Object.keys(ALIGNMENT)[0];

  test('there is a store to test with', () => {
    expect(typeof storeId).toBe('string');
    expect(storeId.length).toBeGreaterThan(0);
  });

  const records = [
    { store_id: storeId, record_date: '2026-05-05', total_orders: 10,
      ist_avg: '15', ist_lt19_pct: '90', make_time: '02:00', production_time: '10:00' },
    { store_id: storeId, record_date: '2026-05-06', total_orders: 40,
      ist_avg: '25', ist_lt19_pct: '50', make_time: '06:00', production_time: '20:00' },
  ];

  test('make and production are averaged over orders', () => {
    const [store] = computeWTD(records);
    // (2 x 10 + 6 x 40) / 50 = 5.2 ; a plain mean would have said 4.
    expect(store.wtd_make_min).toBeCloseTo(5.2, 2);
    // (10 x 10 + 20 x 40) / 50 = 18 ; a plain mean would have said 15.
    expect(store.wtd_prod_min).toBeCloseTo(18, 2);
  });

  test('IST and the under-19 share are weighted the same way', () => {
    const [store] = computeWTD(records);
    expect(store.wtd_ist).toBeCloseTo(23, 1);        // (15x10 + 25x40)/50
    expect(store.wtd_lt19_pct).toBeCloseTo(58, 1);   // (90x10 + 50x40)/50
  });

  test('orders for the week are still the plain total', () => {
    const [store] = computeWTD(records);
    expect(store.wtd_orders).toBe(50);
  });

  test('a day with an IST but no bucket split no longer counts as 0%', () => {
    const [store] = computeWTD([
      { store_id: storeId, record_date: '2026-05-05', total_orders: 10,
        ist_avg: '15', ist_lt19_pct: '90' },
      { store_id: storeId, record_date: '2026-05-06', total_orders: 10,
        ist_avg: '15', ist_lt19_pct: null },
    ]);
    expect(store.wtd_lt19_pct).toBeCloseTo(90, 1);
  });
});

describe('the orders column says which orders it counts', () => {
  const fs = require('fs');
  const path = require('path');
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  // It is filled from the Speed of Service report's "# Del" — deliveries only —
  // and both the screen and the export used to call it total orders. A tester
  // comparing it against Velocity's real order count found it short, correctly.
  test('the export header does not claim to be a total', () => {
    const exporter = read('services/velocity-export.js');
    expect(exporter).toContain("'Delivery Orders'");
    expect(exporter).not.toContain("'Total Orders'");
  });

  test('the screen column says delivery too', () => {
    const page = read('public/velocity.html');
    expect(page).toMatch(/<th[^>]*>Del Orders<\/th>/);
    expect(page).not.toMatch(/<th>Orders<\/th>/);
  });
});

describe('parseMinutes still reads the report formats', () => {
  test('mm:ss, decimal minutes and an Excel day fraction', () => {
    expect(parseMinutes('02:08')).toBeCloseTo(2 + 8 / 60, 6);
    expect(parseMinutes('13:45')).toBeCloseTo(13 + 45 / 60, 6);
    expect(parseMinutes('18.034268')).toBeCloseTo(18.034268, 6);
    expect(parseMinutes(0.5)).toBeCloseTo(720, 2);
    expect(parseMinutes(null)).toBeNull();
    expect(parseMinutes('—')).toBeNull();
  });
});
