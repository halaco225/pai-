// tests/sms-layout.test.js
const { renderForSms, shortLabel, dayLabel } = require('../services/brief-sms');

// Roughly where a phone wraps a proportional font at default size. The first
// version of this message used fixed-width columns, which looked right in a
// terminal and arrived as four ragged lines per area on an actual phone.
const PHONE_WIDTH = 32;

const REGION = {
  level: 'region', childLevel: 'area',
  own: { sales: 121808, growth_pct: 9.0, ist: 20.3, act_hrs: null, sch_hrs: null,
         hrs_variance: null, win: null, missed_routines: 1 },
  rows: [
    { label: 'Area 2034 — Michelle Meehan', sales: 14271, growth_pct: -7.9, ist: 26.2,
      hrs_variance: null, win: null, missed_routines: 1 },
    { label: 'Area 2016 — Ebony Simmons', sales: 26549, growth_pct: 1.8, ist: 22.7,
      hrs_variance: null, win: null, missed_routines: 0 },
    { label: 'Area 2015 — Marc Gannon', sales: 23554, growth_pct: 26.5, ist: 16.9,
      hrs_variance: null, win: null, missed_routines: 0 },
  ],
};

const lines = s => s.split(String.fromCharCode(10));

describe('renderForSms', () => {
  const out = renderForSms(REGION, { fiscalCode: 'P10W1', dateLabel: 'Oct 2' });

  test('no line is wide enough to wrap on a phone', () => {
    for (const l of lines(out)) expect(l.length).toBeLessThanOrEqual(PHONE_WIDTH);
  });

  test('leads with the level, period and data date', () => {
    expect(lines(out)[0]).toBe('REGION · P10W1 · Oct 2');
  });

  test('puts the name and money on one line, the rest underneath', () => {
    const i = lines(out).findIndex(l => l.startsWith('Meehan'));
    expect(lines(out)[i]).toBe('Meehan $14,271 -7.9%');
    expect(lines(out)[i + 1]).toBe('  26.2m · !1');
  });

  // A dash in every row leaves the reader guessing whether it means zero.
  test('says once that something is not reporting', () => {
    expect(out).toContain('Labor & WIN not reporting');
    expect(out).not.toMatch(/—\s+—/);
  });

  test('best performer comes first', () => {
    const body = lines(out).slice(lines(out).indexOf('AREAS best first') + 1);
    expect(body[0]).toMatch(/^Gannon/);     // +26.5%, the strongest
  });

  // The heading names whatever the reader is actually looking at.
  test('heading matches the viewer level', () => {
    const asVp = renderForSms({ ...REGION, childLevel: 'region' }, {});
    const asAc = renderForSms({ ...REGION, childLevel: 'store' }, {});
    expect(asVp).toContain('REGIONS best first');
    expect(asAc).toContain('STORES best first');
  });

  test('a clean area carries no missed-routine marker', () => {
    const i = lines(out).findIndex(l => l.startsWith('Simmons'));
    expect(lines(out)[i + 1]).not.toContain('!');
  });

  test('shows labor and WIN once they report', () => {
    const withData = JSON.parse(JSON.stringify(REGION));
    withData.own.act_hrs = 11058; withData.own.sch_hrs = 10916; withData.own.hrs_variance = 142;
    withData.own.win = 58;
    withData.rows[0].win = 47; withData.rows[0].hrs_variance = -19;
    const o = renderForSms(withData, { fiscalCode: 'P10W1', dateLabel: 'Oct 2' });
    expect(o).toContain('Labor +142h');
    expect(o).toContain('WIN 58.0%');
    expect(o).toContain('W47%');
    expect(o).toContain('L-19');
    expect(o).not.toContain('not reporting');
    for (const l of lines(o)) expect(l.length).toBeLessThanOrEqual(PHONE_WIDTH);
  });

  test('stays short enough for a handful of SMS segments', () => {
    expect(out.length).toBeLessThan(500);
  });
});

// Store rows keep their full name. Surnames are only right for people.
describe('store rows keep their names', () => {
  const storeView = {
    level: 'area', childLevel: 'store',
    own: { sales: 20691, growth_pct: 7.2, ist: 22.0, act_hrs: 1, sch_hrs: 1,
           hrs_variance: -20, win: 50.1, missed_routines: 0 },
    rows: [
      { label: 'Union City',    sales: 3724, growth_pct: 0.7,  ist: 25, hrs_variance: 1,  win: 44, missed_routines: 0 },
      { label: 'Jefferson St',  sales: 3266, growth_pct: -5.4, ist: 19, hrs_variance: -9, win: 48, missed_routines: 0 },
      { label: 'Miracle Strip', sales: 2681, growth_pct: -5.4, ist: 28, hrs_variance: 12, win: 52, missed_routines: 1 },
    ],
  };
  const out = renderForSms(storeView, { dateLabel: 'Oct 4' });

  test('does not reduce a store to its last word', () => {
    expect(out).toContain('Union City');
    expect(out).toContain('Jefferson St');
    expect(out).toContain('Miracle Strip');
    expect(out).not.toMatch(/^City /m);
    expect(out).not.toMatch(/^St /m);
  });

  test('heading says STORES for an area coach', () => {
    expect(out).toContain('STORES best first');
  });

  test('still fits a phone', () => {
    for (const l of out.split(String.fromCharCode(10))) expect(l.length).toBeLessThanOrEqual(PHONE_WIDTH);
  });
});

describe('shortLabel', () => {
  test('reduces an area label to the coach surname', () => {
    expect(shortLabel('Area 2034 — Michelle Meehan')).toBe('Meehan');
  });

  test('ignores a generational suffix', () => {
    expect(shortLabel('Jose Lozano Sr.')).toBe('Lozano');
  });

  test('leaves a single word alone', () => {
    expect(shortLabel('Senoia')).toBe('Senoia');
  });

  test('does not throw on nothing', () => {
    expect(shortLabel('')).toBe('');
    expect(shortLabel(null)).toBe('');
  });
});

describe('dayLabel', () => {
  test('formats the data date', () => {
    expect(dayLabel('2026-10-02')).toBe('Oct 2');
    expect(dayLabel('2026-01-15')).toBe('Jan 15');
  });

  // Parsed from the string, never through Date, which would read a bare date
  // as UTC midnight and show the previous day in any US timezone.
  test('does not shift the day', () => {
    expect(dayLabel('2026-03-01')).toBe('Mar 1');
  });

  test('returns empty for junk rather than Invalid Date', () => {
    expect(dayLabel('')).toBe('');
    expect(dayLabel(null)).toBe('');
  });
});
