// The two accesses added in October 2026, and the password rules that came
// with them. No database here — these are the decisions that live in code.

const { USER_ROSTER } = require('../routes/auth');
const { requireAuth, requireModule } = require('../middleware/auth');
const { visiblePeople } = require('../services/rc-scope');

const find = u => USER_ROSTER.find(r => r.username === u);

describe('roster', () => {
  const harold   = find('hlacoste');
  const jillian  = find('jbuhler');
  const krystina = find('kreyes');

  test('Jillian and Krystina exist and start forced to change', () => {
    for (const u of [jillian, krystina]) {
      expect(u).toBeDefined();
      expect(u.must_change).toBe(true);
    }
  });

  test('both see exactly what Harold sees', () => {
    const mine = visiblePeople({ name: harold.name, role: harold.role, scope: harold.scope }).sort();
    for (const u of [jillian, krystina]) {
      expect(visiblePeople({ name: u.name, role: u.role, scope: u.scope }).sort()).toEqual(mine);
    }
  });

  test('Jillian may reset passwords, Krystina may not', () => {
    expect(jillian.admin).toBe(true);
    expect(!!krystina.admin).toBe(false);
  });

  test('Krystina alone is kept out of Tracker', () => {
    expect(krystina.no_tracker).toBe(true);
    expect(USER_ROSTER.filter(u => u.no_tracker).map(u => u.username)).toEqual(['kreyes']);
  });

  test('usernames stay unique', () => {
    const names = USER_ROSTER.map(u => u.username);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('gates', () => {
  const run = (mw, user) => {
    const res = { code: null, body: null,
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; } };
    let passed = false;
    mw({ session: { user } }, res, () => { passed = true; });
    return { passed, ...res };
  };

  test('a user who must change their password gets no API', () => {
    const r = run(requireAuth, { username: 'kreyes', must_change: true, tracker: true });
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
    expect(r.body.mustChangePassword).toBe(true);
  });

  test('once changed, the API opens up', () => {
    expect(run(requireAuth, { username: 'kreyes', must_change: false }).passed).toBe(true);
  });

  test('Tracker turns away a user it is off for, and nobody else', () => {
    const off = run(requireModule('tracker'), { username: 'kreyes', tracker: false });
    expect(off.passed).toBe(false);
    expect(off.code).toBe(403);
    expect(off.body.requestAccess).toBe(true);

    expect(run(requireModule('tracker'), { username: 'jbuhler', tracker: true }).passed).toBe(true);
  });
});
