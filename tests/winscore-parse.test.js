// tests/winscore-parse.test.js
const { storeIdFrom, pctFrom } = require('../services/intel-smg-winscore-browser');

describe('storeIdFrom', () => {
  // Real labels, copied from the live report on 2026-10-03.
  test('reads the 6-digit store number after the dash', () => {
    expect(storeIdFrom('1P038876 - 038876,8080 WELLS STREET, STE 2B,SENOIA,GA')).toBe('038876');
    expect(storeIdFrom('1P039375 - 039375,4221 BELLS FERRY DR., #103,KENNESAW,GA')).toBe('039375');
  });

  test('keeps the leading zero, because store_assignments does', () => {
    expect(storeIdFrom('1P039377 - 039377,1575 W. MCINTOSH RD.,GRIFFIN,GA')).toBe('039377');
  });

  // The aggregate row is not a store. Treating it as one would file the whole
  // region's score against a made-up store id.
  test('returns null for the Combined row', () => {
    expect(storeIdFrom('Combined')).toBeNull();
  });

  // The failure that made the old favorite useless: a region row's PPP1393282
  // contains six consecutive digits and must never read as a store.
  test('never mistakes a region or area node for a store', () => {
    expect(storeIdFrom('R-KDGI08-LACOSTE, HAROLD - PPP1393282REGNKDGI08')).toBeNull();
    expect(storeIdFrom('A-DGI0401-GANNON, MARC - PPP1393282AREADGI0401')).toBeNull();
  });

  test('handles the parenthesised form used elsewhere in SMG', () => {
    expect(storeIdFrom('(038876) Senoia - Pizza Hut')).toBe('038876');
  });

  test('returns null for junk rather than guessing', () => {
    expect(storeIdFrom('')).toBeNull();
    expect(storeIdFrom(null)).toBeNull();
    expect(storeIdFrom('Store')).toBeNull();
  });
});

describe('pctFrom', () => {
  test('reads a percentage', () => {
    expect(pctFrom('47%')).toBe(47);
    expect(pctFrom('58%')).toBe(58);
  });

  test('reads a decimal percentage', () => {
    expect(pctFrom('76.4%')).toBe(76.4);
  });

  test('returns null when there is no number, not zero', () => {
    // Zero would be written to the database as a real score of 0%.
    expect(pctFrom('—')).toBeNull();
    expect(pctFrom('')).toBeNull();
    expect(pctFrom(null)).toBeNull();
  });
});
