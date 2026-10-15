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

// Which stores' audit responses a viewer may read. Same deny-by-default rule,
// applied to stores instead of people.
describe('visibleStores', () => {
  const { visibleStores } = require('../services/rc-scope');

  const assignments = {
    '39167': { store_id: '39167', area_coach: 'Darian Spikes',  region_coach: 'Harold Lacoste', vp: 'Matt Hester' },
    '39170': { store_id: '39170', area_coach: 'Ebony Simmons',  region_coach: 'Harold Lacoste', vp: 'Matt Hester' },
    '39500': { store_id: '39500', area_coach: 'Erin Pizzo',     region_coach: 'Preston Arnwine', vp: 'Matt Hester' },
    '39600': { store_id: '39600', area_coach: 'Jerry Warren',   region_coach: 'Jerry Warren',    vp: 'Tracy Krumwiede' },
    '39700': { store_id: '39700', area_coach: null,             region_coach: 'Harold Lacoste', vp: 'Matt Hester' },
    '39800': { store_id: '39800', area_coach: null,             region_coach: null,              vp: null },
  };

  test('an area coach sees only their own stores', () => {
    expect([...visibleStores(darian, assignments)]).toEqual(['39167']);
  });

  test('an RDO sees their area coaches\' stores', () => {
    expect([...visibleStores(harold, assignments)].sort()).toEqual(['39167', '39170', '39700']);
  });

  test('an RDO does not see another region', () => {
    expect(visibleStores(harold, assignments).has('39500')).toBe(false);
    expect(visibleStores(harold, assignments).has('39600')).toBe(false);
  });

  test('a VP sees every store under their region coaches', () => {
    const seen = visibleStores(matt, assignments);
    expect(seen.has('39167')).toBe(true);
    expect(seen.has('39500')).toBe(true);
    expect(seen.has('39600')).toBe(false); // other VP
  });

  test('a store with an empty AC seat still rolls up to its RDO', () => {
    expect(visibleStores(harold, assignments).has('39700')).toBe(true);
  });

  test('a store with no coach at all belongs to nobody', () => {
    for (const user of [darian, harold, matt]) {
      expect(visibleStores(user, assignments).has('39800')).toBe(false);
    }
  });

  test('an unknown scope sees no stores', () => {
    expect([...visibleStores({}, assignments)]).toEqual([]);
    expect([...visibleStores(null, assignments)]).toEqual([]);
  });
});
