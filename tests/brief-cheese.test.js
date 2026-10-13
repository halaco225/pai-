const { renderForSms } = require('../services/brief-sms');

const own = (over = {}) => ({
  label: 'REGION', stores: 3, sales: 93614, growth_pct: 19.6,
  ist: 19.9, act_hrs: 100, sch_hrs: 72, hrs_variance: 28, labor_partial: false,
  win: 56, missed_routines: 6, cheese_var: -48.22, ...over,
});
const card = (ownOver = {}, rows = []) =>
  ({ level: 'region', childLevel: 'area', own: own(ownOver), rows });

describe('cheese in the sms', () => {
  test('favorable variance carries a plus', () => {
    expect(renderForSms(card({ cheese_var: 1.9 }))).toContain('chz +1.90');
  });

  test('unfavorable variance carries a minus', () => {
    expect(renderForSms(card())).toContain('chz -48.22');
  });

  test('it takes its own line under labor, so nothing wraps', () => {
    const ls = renderForSms(card()).split('\n');
    const i  = ls.findIndex(l => l.startsWith('Labor '));
    expect(ls[i + 1]).toBe('chz -48.22');
  });

  // 32 is where a phone wraps a proportional font; see tests/sms-layout.test.js.
  test('no cheese line is wide enough to wrap', () => {
    const body = renderForSms(card({}, [
      { label: 'Darian Spikes', sales: 18224, growth_pct: 3.3, ist: 19.0, win: 50,
        hrs_variance: -7, missed_routines: 1, cheese_var: -203.44 },
    ]));
    for (const l of body.split('\n')) expect(l.length).toBeLessThanOrEqual(32);
  });

  test('each breakdown row carries its own', () => {
    const body = renderForSms(card({}, [
      { label: 'Darian Spikes', sales: 18224, growth_pct: 3.3, ist: 19.0, win: 50,
        hrs_variance: -7, missed_routines: 1, cheese_var: 1.9 },
    ]));
    expect(body).toContain('chz +1.90');
  });

  test('a row carries cheese on its own third line, under the detail', () => {
    const ls = renderForSms(card({}, [
      { label: 'Darian Spikes', sales: 18224, growth_pct: 3.3, ist: 19.0, win: 50,
        hrs_variance: -7, missed_routines: 1, cheese_var: 1.9 },
    ])).split('\n');
    const i = ls.findIndex(l => l.startsWith('Spikes'));
    expect(ls[i + 1]).toBe('  19.0m · W50% · L-7 · HB1');
    expect(ls[i + 2]).toBe('  chz +1.90');
  });

  test('absent cheese prints nothing and is named as not reporting', () => {
    const body = renderForSms(card({ cheese_var: null }));
    expect(body).not.toContain('chz');
    expect(body).toContain('Chz not reporting');
  });

  test('a row with no cheese simply omits the field', () => {
    const body = renderForSms(card({}, [
      { label: 'Darian Spikes', sales: 18224, growth_pct: 3.3, ist: 19.0, win: 50,
        hrs_variance: -7, missed_routines: 1, cheese_var: null },
    ]));
    expect(body.split('\n').filter(l => l.includes('chz')).length).toBe(1);   // the own line only
  });

  test('zero is a real variance, not an absence', () => {
    const body = renderForSms(card({ cheese_var: 0 }));
    expect(body).toContain('chz +0.00');
    expect(body).not.toContain('Chz not reporting');
  });
});
