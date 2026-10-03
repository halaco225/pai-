// tests/brief-due.test.js
const { isDue, recipients, briefCacheDate, SEND_WINDOW_MINUTES } = require('../services/brief-sms');

// The pipeline caches each brief under its DATA date (yesterday-Eastern), not
// the date it runs. Looking it up under today finds nothing, every single day,
// and the text silently never arrives. Verified against live data: the brief
// read on Oct 2 was cached at cache_date 2026-10-01.
describe('briefCacheDate', () => {
  test('is yesterday in Eastern, not today', () => {
    expect(briefCacheDate(new Date('2026-10-03T12:05:00Z'))).toBe('2026-10-02'); // 08:05 EDT
  });

  // 04:30 UTC is 00:30 EDT on the 3rd — Eastern has already rolled over, so
  // the data date is the 2nd. An hour earlier it would still be the 1st.
  test('tracks the Eastern day, not the UTC day', () => {
    expect(briefCacheDate(new Date('2026-10-03T04:30:00Z'))).toBe('2026-10-02'); // 00:30 EDT
    expect(briefCacheDate(new Date('2026-10-03T03:30:00Z'))).toBe('2026-10-01'); // 23:30 EDT, 2nd
  });

  test('uses Eastern regardless of the recipient zone', () => {
    // 07:05 MDT on the 3rd is 09:05 EDT on the 3rd — data date is the 2nd.
    expect(briefCacheDate(new Date('2026-10-03T13:05:00Z'))).toBe('2026-10-02');
  });

  test('crosses a month boundary', () => {
    expect(briefCacheDate(new Date('2026-11-01T12:05:00Z'))).toBe('2026-10-31');
  });
});

const HAROLD = { name: 'Harold Lacoste', phone: '+12258101361', tz: 'America/New_York' };

describe('isDue', () => {
  const base = { person: HAROLD, sendLocal: '08:05', consented: true, alreadySentDates: [] };

  test('due at the send time', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T12:05:00Z') })).toBe(true); // 08:05 EDT
  });

  test('not due before the send time', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T12:04:00Z') })).toBe(false); // 08:04 EDT
  });

  // A restart or a slow tick must not mean a skipped day.
  test('still due a few minutes late', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T12:12:00Z') })).toBe(true); // 08:12 EDT
  });

  // But an app that boots at 4pm must not fire the morning brief.
  test('not due once the window has closed', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T20:00:00Z') })).toBe(false); // 16:00 EDT
  });

  test('window is explicit, not accidental', () => {
    expect(SEND_WINDOW_MINUTES).toBe(30);
  });

  test('not due twice on the same local date', () => {
    expect(isDue({
      ...base,
      now: new Date('2026-10-05T12:05:00Z'),
      alreadySentDates: ['2026-10-05'],
    })).toBe(false);
  });

  test('due again the next day', () => {
    expect(isDue({
      ...base,
      now: new Date('2026-10-06T12:05:00Z'),
      alreadySentDates: ['2026-10-05'],
    })).toBe(true);
  });

  test('never due without consent', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T12:05:00Z'), consented: false })).toBe(false);
  });

  test('never due without a phone number', () => {
    expect(isDue({
      ...base,
      person: { ...HAROLD, phone: '' },
      now: new Date('2026-10-05T12:05:00Z'),
    })).toBe(false);
  });

  // 8:05 means 8:05 where they are, in November as in October.
  test('holds after DST ends', () => {
    expect(isDue({ ...base, now: new Date('2026-11-05T13:05:00Z') })).toBe(true);  // 08:05 EST
    expect(isDue({ ...base, now: new Date('2026-11-05T12:05:00Z') })).toBe(false); // 07:05 EST
  });

  // Central and Mountain recipients get their own 8:05, not Harold's.
  test('each zone gets its own local 8:05', () => {
    const ct = { ...HAROLD, name: 'Jerry Warren', tz: 'America/Chicago' };
    expect(isDue({ ...base, person: ct, now: new Date('2026-10-05T13:05:00Z') })).toBe(true);  // 08:05 CDT
    expect(isDue({ ...base, person: ct, now: new Date('2026-10-05T12:05:00Z') })).toBe(false); // 07:05 CDT
  });
});

describe('recipients', () => {
  test('defaults to Harold alone', () => {
    expect(recipients({})).toEqual(['hlacoste']);
  });

  test('reads a comma list from the environment', () => {
    expect(recipients({ PAI_BRIEF_RECIPIENTS: 'hlacoste,jwarren' })).toEqual(['hlacoste', 'jwarren']);
  });

  test('tolerates spaces and trailing commas', () => {
    expect(recipients({ PAI_BRIEF_RECIPIENTS: ' hlacoste , jwarren , ' })).toEqual(['hlacoste', 'jwarren']);
  });

  test('an empty setting means send to nobody, not to everybody', () => {
    expect(recipients({ PAI_BRIEF_RECIPIENTS: '' })).toEqual([]);
  });
});
