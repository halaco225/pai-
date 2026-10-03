// tests/localtime.test.js
const { localDate, localHHMM, minusDays, isAtOrAfter } = require('../services/localtime');

const ET = 'America/New_York';
const CT = 'America/Chicago';

describe('localDate', () => {
  test('returns YYYY-MM-DD in the given zone', () => {
    expect(localDate(new Date('2026-10-02T16:00:00Z'), ET)).toBe('2026-10-02');
  });

  // 03:30 UTC on the 3rd is still the 2nd in both US zones. Using UTC dates
  // for a local-day decision is an off-by-one every single night.
  test('is still yesterday just after UTC midnight', () => {
    expect(localDate(new Date('2026-10-03T03:30:00Z'), ET)).toBe('2026-10-02');
    expect(localDate(new Date('2026-10-03T03:30:00Z'), CT)).toBe('2026-10-02');
  });

  // Eastern and Central disagree for one hour each night.
  test('zones can disagree about today', () => {
    const t = new Date('2026-10-03T04:30:00Z'); // 00:30 ET, 23:30 CT
    expect(localDate(t, ET)).toBe('2026-10-03');
    expect(localDate(t, CT)).toBe('2026-10-02');
  });
});

describe('localHHMM', () => {
  test('is zero-padded 24-hour', () => {
    // 12:05 UTC = 08:05 EDT
    expect(localHHMM(new Date('2026-10-03T12:05:00Z'), ET)).toBe('08:05');
  });

  // The whole reason this file exists: the same wall-clock time is a
  // different UTC instant before and after DST ends (2026-11-01).
  test('6am Eastern is 10:00 UTC in summer and 11:00 UTC in winter', () => {
    expect(localHHMM(new Date('2026-10-15T10:00:00Z'), ET)).toBe('06:00'); // EDT
    expect(localHHMM(new Date('2026-11-15T11:00:00Z'), ET)).toBe('06:00'); // EST
  });
});

describe('minusDays', () => {
  test('subtracts without timezone drift', () => {
    expect(minusDays('2026-10-03', 1)).toBe('2026-10-02');
  });

  test('crosses a month boundary', () => {
    expect(minusDays('2026-10-01', 1)).toBe('2026-09-30');
  });

  test('crosses the DST boundary without losing a day', () => {
    expect(minusDays('2026-11-02', 1)).toBe('2026-11-01');
  });
});

describe('isAtOrAfter', () => {
  test('true at the boundary minute', () => {
    expect(isAtOrAfter(new Date('2026-10-15T10:00:00Z'), ET, '06:00')).toBe(true);
  });

  test('false a minute before', () => {
    expect(isAtOrAfter(new Date('2026-10-15T09:59:00Z'), ET, '06:00')).toBe(false);
  });

  test('still true later the same day', () => {
    expect(isAtOrAfter(new Date('2026-10-15T20:00:00Z'), ET, '06:00')).toBe(true);
  });

  test('holds after DST ends', () => {
    expect(isAtOrAfter(new Date('2026-11-15T11:00:00Z'), ET, '06:00')).toBe(true);
    expect(isAtOrAfter(new Date('2026-11-15T10:59:00Z'), ET, '06:00')).toBe(false);
  });
});
