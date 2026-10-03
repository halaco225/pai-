// tests/rc-people.test.js
const { getPerson, nameForUsername, rosterDrift } = require('../services/rc-people');

describe('getPerson', () => {
  test('returns phone and timezone', () => {
    const p = getPerson('Harold Lacoste');
    expect(p.phone).toMatch(/^\+1\d{10}$/);
    expect(p.tz).toBe('America/New_York');
  });

  test('returns null for someone not on the roster', () => {
    expect(getPerson('Nobody At All')).toBeNull();
  });

  test('returns null rather than throwing on a missing name', () => {
    expect(getPerson(undefined)).toBeNull();
  });
});

describe('nameForUsername', () => {
  test('maps a P.AI username to a roster name', () => {
    expect(nameForUsername('hlacoste')).toBe('Harold Lacoste');
  });

  test('returns null for an unknown username', () => {
    expect(nameForUsername('nosuchuser')).toBeNull();
  });
});

// data/people.json is a copy of rc-tracker's roster, and P10 moved two region
// coaches between VPs and retired one VP entirely. A copy that disagrees with
// USER_ROSTER is how someone gets texted a brief scoped to the wrong territory.
describe('rosterDrift', () => {
  const drift = rosterDrift();

  test('reports a structured result, never throws', () => {
    expect(Array.isArray(drift.missingFromPeople)).toBe(true);
    expect(Array.isArray(drift.missingFromRoster)).toBe(true);
    expect(Array.isArray(drift.vpMismatch)).toBe(true);
  });

  // Harold is the only brief recipient today, so his entry is the one that
  // has to be right. Everyone else's drift is reported, not fatal.
  test('Harold is present and consistent in both rosters', () => {
    expect(drift.missingFromPeople).not.toContain('Harold Lacoste');
    expect(drift.missingFromRoster).not.toContain('Harold Lacoste');
    expect(drift.vpMismatch.map(m => m.name)).not.toContain('Harold Lacoste');
  });
});
