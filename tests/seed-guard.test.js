// tests/seed-guard.test.js
const { seedDeletionAllowed, SEED_MIN_ACTIVE, SEED_MAX_DELETE } = require('../services/db');

describe('seedDeletionAllowed', () => {
  test('thresholds are explicit', () => {
    expect(SEED_MIN_ACTIVE).toBe(300);
    expect(SEED_MAX_DELETE).toBe(25);
  });

  // The normal case the debrief describes: P10 drops three stadium kiosks.
  test('allows a normal refresh dropping a few closed stores', () => {
    expect(seedDeletionAllowed(367, 3)).toBe(true);
  });

  test('allows deleting nothing', () => {
    expect(seedDeletionAllowed(367, 0)).toBe(true);
  });

  // The hazard this guard exists for: the alignment module half-loads, so
  // activeIds is short and the old code would delete nearly every store.
  test('refuses when the alignment looks truncated', () => {
    expect(seedDeletionAllowed(1, 366)).toBe(false);
    expect(seedDeletionAllowed(50, 320)).toBe(false);
  });

  test('refuses an implausibly large deletion even with a full alignment', () => {
    expect(seedDeletionAllowed(367, 120)).toBe(false);
  });

  test('allows exactly at the delete ceiling, refuses one past it', () => {
    expect(seedDeletionAllowed(367, 25)).toBe(true);
    expect(seedDeletionAllowed(367, 26)).toBe(false);
  });

  test('allows exactly at the active floor, refuses one below it', () => {
    expect(seedDeletionAllowed(300, 3)).toBe(true);
    expect(seedDeletionAllowed(299, 3)).toBe(false);
  });

  // An operator who has looked at the list and means it.
  test('force overrides both thresholds', () => {
    expect(seedDeletionAllowed(1, 366, true)).toBe(true);
  });
});
