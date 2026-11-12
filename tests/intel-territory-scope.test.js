// Harold covers a region but is asked about Matt Hester's whole territory, so
// an admin Region Coach can ask Daily Intel for the territory and gets the VP
// view. That is a widening of what someone can read, and the four conditions
// that hold it in place are the only thing standing between "Harold sees the
// territory he is accountable for" and "every Region Coach reads every other
// region". One test each.

const { intelUser, territoryRegionCoaches } = require('../services/intel-scope');
const { USER_ROSTER } = require('../routes/auth');

const req = (user, query = {}, method = 'GET') => ({ session: { user }, query, method });

const harold = USER_ROSTER.find(u => u.username === 'hlacoste');
const preston = USER_ROSTER.find(u => u.username === 'parnwine');
const matt = USER_ROSTER.find(u => u.username === 'mhester');

test('the roster has the people this depends on', () => {
  expect(harold.role).toBe('rdo');
  expect(harold.admin).toBe(true);
  expect(harold.scope.vp).toBe('Matt Hester');
  expect(preston.admin).toBeUndefined();     // a plain Region Coach
  expect(matt.role).toBe('vp');
});

test('an admin Region Coach asking for the territory gets the VP view', () => {
  const u = intelUser(req(harold, { scope: 'territory' }), USER_ROSTER);
  expect(u.role).toBe('vp');
  expect(u.scope.vp_name).toBe('Matt Hester');
  expect(u.scope.region_coaches).toEqual(expect.arrayContaining(['Harold Lacoste', 'Lori Schwartz', 'Preston Arnwine']));
  expect(u.viewingTerritory).toBe(true);
  expect(u.username).toBe(harold.username);  // still the same person
});

test('without asking, nothing changes', () => {
  expect(intelUser(req(harold), USER_ROSTER)).toBe(harold);
  expect(intelUser(req(harold, { scope: 'region' }), USER_ROSTER)).toBe(harold);
});

test('a non-admin Region Coach cannot widen', () => {
  expect(intelUser(req(preston, { scope: 'territory' }), USER_ROSTER)).toBe(preston);
});

test('an area coach cannot widen', () => {
  const ac = USER_ROSTER.find(u => u.role === 'area_coach');
  expect(intelUser(req(ac, { scope: 'territory' }), USER_ROSTER)).toBe(ac);
});

test('only reads widen — a write stays in the real scope', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    expect(intelUser(req(harold, { scope: 'territory' }, method), USER_ROSTER)).toBe(harold);
  }
});

test('the territory comes from the roster, never from the request', () => {
  const u = intelUser(req({ ...harold, scope: { ...harold.scope, vp: 'Matt Hester' } },
    { scope: 'territory', vp_name: 'Tracy Krumwiede', orgType: 'territory' }), USER_ROSTER);
  expect(u.scope.vp_name).toBe('Matt Hester');
  expect(u.scope.region_coaches).not.toContain('Jerry Warren');   // Tracy's side
});

test('an admin with no VP above them cannot widen', () => {
  const orphan = { ...harold, scope: { type: 'rdo', rc_name: 'Harold Lacoste' } };
  expect(intelUser(req(orphan, { scope: 'territory' }), USER_ROSTER)).toBe(orphan);
});

test('a VP is untouched by the flag', () => {
  expect(intelUser(req(matt, { scope: 'territory' }), USER_ROSTER)).toBe(matt);
});

test('no session, no crash', () => {
  expect(intelUser({ session: {}, query: {}, method: 'GET' }, USER_ROSTER)).toBeUndefined();
  expect(intelUser({}, USER_ROSTER)).toBeUndefined();
});

test('region coaches are listed once each, by their region name', () => {
  // Three roster entries share Harold's region scope (he, Jillian, Krystina).
  const rcs = territoryRegionCoaches(USER_ROSTER, 'Matt Hester');
  expect(rcs.filter(r => r === 'Harold Lacoste')).toHaveLength(1);
  expect(rcs).toHaveLength(3);
  expect(territoryRegionCoaches(USER_ROSTER, 'Nobody At All')).toEqual([]);
});
