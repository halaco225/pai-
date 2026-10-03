// tests/scheduler-gate.test.js
const { eligible, gateOpen, PULL_AFTER_LOCAL, PULL_TZ } = require('../services/scheduler');

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

// gateOpen is what the intel pipeline route asks before running an undated
// batch. The Render cron fires at a fixed 10:00 UTC, which is 6am Eastern in
// summer but 5am once DST ends — without this the brief would be built an hour
// early for seven months of the year.
describe('gateOpen', () => {
  test('shut at 5:59am Eastern', () => {
    expect(gateOpen(new Date('2026-10-15T09:59:00Z'))).toBe(false);
  });

  test('open at 6:00am Eastern', () => {
    expect(gateOpen(new Date('2026-10-15T10:00:00Z'))).toBe(true);
  });

  // The case that motivated this: the cron's 10:00 UTC is 5am EST.
  test('shut when the winter cron fires at 10:00 UTC', () => {
    expect(gateOpen(new Date('2026-11-15T10:00:00Z'))).toBe(false); // 05:00 EST
  });

  test('open an hour later in winter', () => {
    expect(gateOpen(new Date('2026-11-15T11:00:00Z'))).toBe(true);  // 06:00 EST
  });

  test('open through the rest of the day', () => {
    expect(gateOpen(new Date('2026-11-15T20:00:00Z'))).toBe(true);  // 15:00 EST
  });
});
