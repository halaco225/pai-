// tests/labor-refresh.test.js
const { laborRefreshDue, LABOR_REFRESH_LOCAL } = require('../services/brief-sms');

// Fourth posts the previous day's punches well after the 6am pipeline runs.
// On 2026-10-05 Senoia read 10.00 actual against 26.00 scheduled at 6am and
// 25.55 by mid-morning. The 8:05 text said the region was 535 hours under when
// the day was roughly flat, so labor is re-pulled between 07:30 and the send.
describe('laborRefreshDue', () => {
  beforeEach(() => { jest.resetModules(); });

  test('refresh time sits before the send time', () => {
    expect(LABOR_REFRESH_LOCAL).toBe('07:30');
  });

  test('not due before the refresh time', () => {
    // 11:29 UTC = 07:29 EDT
    expect(laborRefreshDue(new Date('2026-10-07T11:29:00Z'))).toBe(false);
  });

  test('due at the refresh time', () => {
    expect(laborRefreshDue(new Date('2026-10-07T11:30:00Z'))).toBe(true);
  });

  // Once it has sent there is nothing left to refresh for, and a pull then
  // would only cost a Fourth round trip for no one's benefit.
  test('not due once the send time has passed', () => {
    // 12:06 UTC = 08:06 EDT, past the 08:05 send
    expect(laborRefreshDue(new Date('2026-10-07T12:06:00Z'))).toBe(false);
  });

  test('not due in the middle of the night', () => {
    expect(laborRefreshDue(new Date('2026-10-07T06:00:00Z'))).toBe(false); // 02:00 EDT
  });

  // 07:30 was itself a guess, and on 10/8 it was still too early: the text
  // said 464 hours under where the finished day was 73 hours over. So it keeps
  // pulling while the day still reads half-finished -- but bounded, because a
  // two-minute tick would otherwise hammer Fourth for the whole window.
  test('tries again while the day still looks half-read', () => {
    const fresh = require('../services/brief-sms');
    const t = new Date('2026-10-08T11:31:00Z');
    expect(fresh.laborRefreshDue(t)).toBe(true);
    fresh.refreshLabor(t);
    expect(fresh.laborRefreshDue(t)).toBe(true);
  });

  test('gives up after a bounded number of tries', () => {
    jest.resetModules();
    const fresh = require('../services/brief-sms');
    const t = new Date('2026-10-08T11:31:00Z');
    for (let i = 0; i < fresh.MAX_LABOR_REFRESHES; i++) fresh.refreshLabor(t);
    expect(fresh.laborRefreshDue(t)).toBe(false);
  });

  test('holds across the DST boundary', () => {
    // 12:30 UTC = 07:30 EST in November
    expect(laborRefreshDue(new Date('2026-11-10T12:30:00Z'))).toBe(true);
    expect(laborRefreshDue(new Date('2026-11-10T12:29:00Z'))).toBe(false);
  });
});
