// tests/scheduler-gate.test.js
const { eligible, PULL_AFTER_LOCAL, PULL_TZ } = require('../services/scheduler');

describe('pull gate', () => {
  test('anchors to 6am Eastern', () => {
    expect(PULL_TZ).toBe('America/New_York');
    expect(PULL_AFTER_LOCAL).toBe('06:00');
  });

  // Yesterday waits for the source report; older gaps are stale already.
  test('yesterday is not eligible before 6am Eastern', () => {
    expect(eligible('2026-10-14', new Date('2026-10-15T09:59:00Z'))).toBe(false); // 05:59 EDT
  });

  test('yesterday is eligible at 6am Eastern', () => {
    expect(eligible('2026-10-14', new Date('2026-10-15T10:00:00Z'))).toBe(true); // 06:00 EDT
  });

  // The point of the change: no annual cron edit.
  test('the gate holds after DST ends', () => {
    expect(eligible('2026-11-14', new Date('2026-11-15T10:59:00Z'))).toBe(false); // 05:59 EST
    expect(eligible('2026-11-14', new Date('2026-11-15T11:00:00Z'))).toBe(true);  // 06:00 EST
  });

  test('an older gap is always eligible', () => {
    expect(eligible('2026-10-10', new Date('2026-10-15T09:00:00Z'))).toBe(true);
  });
});
