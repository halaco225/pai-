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

// The change-password screen once rendered with no styling at all, because
// the gate redirected the stylesheet too. These pin which requests it moves.
describe('must-change gate', () => {
  const express = require('express');
  const request = require('supertest');
  const gate = require('../middleware/must-change');

  const appFor = user => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user }; next(); });
    app.use(gate);
    app.get('/css/styles.css', (_q, r) => r.type('css').send('body{}'));
    app.get('/dashboard', (_q, r) => r.send('dash'));
    app.get('/change-password', (_q, r) => r.send('change'));
    app.get('/api/tracker/me', (_q, r) => r.json({ ok: true }));
    app.post('/api/auth/change-password', (_q, r) => r.json({ ok: true }));
    return app;
  };

  const forced = () => appFor({ username: 'kreyes', must_change: true });

  test('a stylesheet is served, not redirected', async () => {
    const r = await request(forced()).get('/css/styles.css').set('Accept', 'text/css,*/*;q=0.1');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/css/);
  });

  test('a page is redirected', async () => {
    const r = await request(forced()).get('/dashboard').set('Accept', 'text/html');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/change-password');
  });

  test('the change-password page itself is not redirected', async () => {
    expect((await request(forced()).get('/change-password').set('Accept', 'text/html')).status).toBe(200);
  });

  test('the API is left to its own gate, never redirected', async () => {
    expect((await request(forced()).get('/api/tracker/me')).status).toBe(200);
    expect((await request(forced()).post('/api/auth/change-password')).status).toBe(200);
  });

  test('a user who is not forced is untouched', async () => {
    const app = appFor({ username: 'hlacoste', must_change: false });
    expect((await request(app).get('/dashboard').set('Accept', 'text/html')).status).toBe(200);
  });

  test('a signed-out visitor is untouched', async () => {
    expect((await request(appFor(null)).get('/dashboard').set('Accept', 'text/html')).status).toBe(200);
  });
});
