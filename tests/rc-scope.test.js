// tests/rc-scope.test.js
const { visiblePeople, canSee } = require('../services/rc-scope');
const { USER_ROSTER } = require('../routes/auth');

const harold = USER_ROSTER.find(u => u.username === 'hlacoste');   // RDO
const darian = USER_ROSTER.find(u => u.username === 'dspikes');    // area coach
const matt   = USER_ROSTER.find(u => u.username === 'mhester');    // VP

describe('area coach', () => {
  test('sees only themselves', () => {
    expect(visiblePeople(darian)).toEqual(['Darian Spikes']);
  });

  test('cannot see a peer in another area', () => {
    expect(canSee(darian, 'Ebony Simmons')).toBe(false);
  });

  test('cannot see their own RDO', () => {
    expect(canSee(darian, 'Harold Lacoste')).toBe(false);
  });
});

describe('RDO', () => {
  const seen = visiblePeople(harold);

  test('sees their own area coaches', () => {
    expect(seen).toEqual(expect.arrayContaining(['Darian Spikes', 'Ebony Simmons', 'Michelle Meehan']));
  });

  test('sees themselves', () => {
    expect(seen).toContain('Harold Lacoste');
  });

  test('does not see another region', () => {
    expect(canSee(harold, 'Erin Pizzo')).toBe(false);       // Preston's area coach
    expect(canSee(harold, 'Preston Arnwine')).toBe(false);  // another RDO
  });
});

describe('VP', () => {
  const seen = visiblePeople(matt);

  test('sees their region coaches', () => {
    expect(seen).toEqual(expect.arrayContaining(['Harold Lacoste', 'Preston Arnwine']));
  });

  test('sees area coaches two levels down', () => {
    expect(seen).toEqual(expect.arrayContaining(['Darian Spikes', 'Erin Pizzo']));
  });

  test('does not see another VP territory', () => {
    expect(canSee(matt, 'Jerry Warren')).toBe(false);    // Tracy's RDO
    expect(canSee(matt, 'Alpha Garza')).toBe(false);     // Jerry's area coach
  });

  test('sees strictly more than any one of their RDOs', () => {
    const haroldSees = visiblePeople(harold);
    expect(seen.length).toBeGreaterThan(haroldSees.length);
    for (const p of haroldSees) expect(seen).toContain(p);
  });
});

// Deny by default. An unrecognised shape must never mean "everyone".
describe('unknown or missing scope', () => {
  test('returns nothing rather than everything', () => {
    expect(visiblePeople(null)).toEqual([]);
    expect(visiblePeople({})).toEqual([]);
    expect(visiblePeople({ name: 'X', role: 'wat', scope: { type: 'wat' } })).toEqual([]);
  });

  test('canSee is false for everyone under an unknown scope', () => {
    expect(canSee({}, 'Harold Lacoste')).toBe(false);
  });
});
