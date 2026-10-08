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
      { label: '039378', sales: 3724, growth_pct: 0.7,  ist: 25, hrs_variance: 1,  win: 44, missed_routines: 0 },
      { label: '039379', sales: 3266, growth_pct: -5.4, ist: 19, hrs_variance: -9, win: 48, missed_routines: 0 },
      { label: '039412', sales: 2681, growth_pct: -5.4, ist: 28, hrs_variance: 12, win: 52, missed_routines: 1 },
    ],
  };
  const out = renderForSms(storeView, { dateLabel: 'Oct 4' });

  // Store numbers, because two of Harold's stores are both named Senoia and
  // the number is what identifies a store on every other report.
  test('shows the store number, untouched', () => {
    expect(out).toContain('039378');
    expect(out).toContain('039379');
    expect(out).toContain('039412');
    expect(out).not.toMatch(/^City /m);
  });

  test('keeps the leading zero', () => {
    expect(out).toMatch(/^039378 /m);
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

// 2026-10-08: the ODS pull 404'd, intel_dbs_metrics was empty for Oct 7, and
// the 8:05 text went out with no sales and no growth anywhere in it — reading
// like a normal brief that simply had nothing to say about money.
describe('a day with no sales data', () => {
  const noSales = {
    level: 'region', childLevel: 'area',
    own: { sales: null, growth_pct: null, ist: 20.5, act_hrs: 1, sch_hrs: 1,
           hrs_variance: -464, win: 56.0, missed_routines: 5 },
    rows: [
      { label: 'Area 2016 — Ebony Simmons', sales: null, growth_pct: null,
        ist: 16.6, win: 60, hrs_variance: -132, missed_routines: 1 },
    ],
  };
  const out = renderForSms(noSales, { dateLabel: 'Oct 7' });

  test('says sales is not reporting rather than going quiet', () => {
    expect(out).toContain('Sales not reporting');
  });

  test('still shows the numbers that did arrive', () => {
    expect(out).toContain('Labor -464h');
    expect(out).toContain('WIN 56.0% PTD');
    expect(out).toContain('IST 20.5m');
  });

  test('still fits a phone', () => {
    for (const l of out.split(String.fromCharCode(10))) expect(l.length).toBeLessThanOrEqual(PHONE_WIDTH);
  });
});

// Fourth posts the previous day's punches through the morning. Read early, the
// region looked 464 hours under schedule; read the same day at 2pm it was 73
// hours over. A number that wrong is worse than no number at all.
describe('labor that is still arriving', () => {
  const halfRead = {
    level: 'region', childLevel: 'area',
    own: { sales: 72415, growth_pct: 9.7, ist: 20.5, act_hrs: 735, sch_hrs: 1270,
           hrs_variance: -464, win: 56.0, missed_routines: 5, labor_partial: true },
    rows: [
      { label: 'Area 2016 — Ebony Simmons', sales: 13769, growth_pct: -9.7,
        ist: 16.6, win: 60, hrs_variance: -132, missed_routines: 1 },
    ],
  };
  const out = renderForSms(halfRead, { dateLabel: 'Oct 7' });

  test('says so instead of printing the variance', () => {
    expect(out).toContain('Labor still posting');
    expect(out).not.toContain('-464');
  });

  test('drops the per-area figure too, which is just as half-read', () => {
    expect(out).not.toContain('L-132');
  });

  test('everything else still goes out', () => {
    expect(out).toContain('Sales $72,415 +9.7%');
    expect(out).toContain('WIN 56.0% PTD');
  });

  // Once the punches have landed the flag is absent and the number prints.
  test('prints the variance once the day is complete', () => {
    const complete = JSON.parse(JSON.stringify(halfRead));
    complete.own.labor_partial = false;
    complete.own.hrs_variance = 73;
    const o = renderForSms(complete, { dateLabel: 'Oct 7' });
    expect(o).toContain('Labor +73h');
    expect(o).not.toContain('still posting');
    expect(o).toContain('L-132');
  });

  test('still fits a phone', () => {
    for (const l of out.split(String.fromCharCode(10))) expect(l.length).toBeLessThanOrEqual(PHONE_WIDTH);
  });
});
