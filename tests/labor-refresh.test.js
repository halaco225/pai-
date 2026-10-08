// tests/labor-refresh.test.js
const { laborRefreshDue, CATCHUP_START, RETRY_SPACING_MIN,
        DEFAULT_SEND_LOCAL } = require('../services/brief-sms');

// Fourth posts the previous day's punches through the morning, long after the
// 6am pipeline reads them. On 2026-10-05 Senoia read 10.00 actual against 26.00
// scheduled at 6am and 25.55 by mid-morning. On 2026-10-08 the region still
// read 464 hours under at 07:30; the finished day was 73 hours over.
//
// So there is no single hour that is reliably late enough, and the design is a
// window that keeps pulling rather than one well-chosen alarm.
describe('catch-up window', () => {
  beforeEach(() => { jest.resetModules(); });

  test('starts well before the send and ends at it', () => {
    expect(CATCHUP_START).toBe('07:00');
    expect(DEFAULT_SEND_LOCAL).toBe('08:30');
  });

  test('not due before the window opens', () => {
    expect(laborRefreshDue(new Date('2026-10-09T10:59:00Z'))).toBe(false); // 06:59 EDT
  });

  test('due as soon as it opens', () => {
    expect(laborRefreshDue(new Date('2026-10-09T11:00:00Z'))).toBe(true);  // 07:00 EDT
  });

  // Past the send there is nothing left to catch up for, and a pull then would
  // cost a Fourth round trip for no one's benefit.
  test('not due once the send time has passed', () => {
    expect(laborRefreshDue(new Date('2026-10-09T12:31:00Z'))).toBe(false); // 08:31 EDT
  });

  test('not due in the middle of the night', () => {
    expect(laborRefreshDue(new Date('2026-10-09T06:00:00Z'))).toBe(false); // 02:00 EDT
  });

  test('holds across the DST boundary', () => {
    expect(laborRefreshDue(new Date('2026-11-12T12:00:00Z'))).toBe(true);  // 07:00 EST
    expect(laborRefreshDue(new Date('2026-11-12T11:59:00Z'))).toBe(false); // 06:59 EST
  });
});

describe('retry spacing', () => {
  beforeEach(() => { jest.resetModules(); });

  test('attempts are spaced, not fired back to back', () => {
    expect(RETRY_SPACING_MIN).toBe(15);
  });

  // The two-minute tick would otherwise spend every attempt inside ten minutes,
  // which is the same as making one attempt.
  test('not due again straight after a pull', () => {
    const fresh = require('../services/brief-sms');
    fresh.refreshLabor(new Date('2026-10-09T11:00:00Z'));                 // 07:00
    expect(fresh.laborRefreshDue(new Date('2026-10-09T11:02:00Z'))).toBe(false); // 07:02
  });

  test('due again once the spacing has elapsed', () => {
    const fresh = require('../services/brief-sms');
    fresh.refreshLabor(new Date('2026-10-09T11:00:00Z'));                 // 07:00
    expect(fresh.laborRefreshDue(new Date('2026-10-09T11:15:00Z'))).toBe(true);  // 07:15
  });

  test('a fresh day pulls again regardless of spacing', () => {
    const fresh = require('../services/brief-sms');
    fresh.refreshLabor(new Date('2026-10-09T11:00:00Z'));
    expect(fresh.laborRefreshDue(new Date('2026-10-10T11:00:00Z'))).toBe(true);
  });
});
