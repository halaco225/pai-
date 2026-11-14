// The automation token was a literal in nine files and in render.yaml, and
// this repo is public: anyone who read the source could run the pipeline, read
// its logs and post uploads. These tests keep it out of the source and keep
// the check honest.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// The literal that leaked, split so this file is not itself a copy of it.
const LEAKED = '38b8091924e1' + '5f85583454212a9860038';

test('no token literal is left in the code or the blueprint', () => {
  const files = ['routes/intel.js', 'routes/brief.js', 'services/scheduler.js',
                 'services/brief-sms.js', 'services/automation-token.js',
                 'scripts/backfill-intel.js', '.github/scripts/smg-pull.js',
                 'render.yaml'];
  for (const f of files) {
    // A 32-hex run assigned to anything token-shaped is the shape of the bug.
    expect(read(f)).not.toMatch(/['"][0-9a-f]{32}['"]/);
  }
  expect(read('render.yaml')).not.toContain(LEAKED);
});

test('render.yaml keeps both automation tokens out of the repo', () => {
  const y = read('render.yaml');
  for (const key of ['INTEL_AUTOMATION_TOKEN', 'VELOCITY_AUTOMATION_TOKEN']) {
    const re = new RegExp('- key: ' + key + '\\s*\\n\\s*sync: false');
    expect(y).toMatch(re);
  }
});

describe('tokenOk', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; jest.resetModules(); });

  const load = env => {
    jest.resetModules();
    Object.assign(process.env, env);
    return require('../services/automation-token');
  };

  const req = (token, header) => ({ query: token ? { token } : {}, headers: header ? { 'x-automation-token': header } : {} });

  test('accepts the configured token, by query or by header', () => {
    const { tokenOk } = load({ INTEL_AUTOMATION_TOKEN: 'abc123' });
    expect(tokenOk(req('abc123'))).toBe(true);
    expect(tokenOk(req(null, 'abc123'))).toBe(true);
  });

  test('refuses the leaked literal, which is the whole point', () => {
    const { tokenOk } = load({ INTEL_AUTOMATION_TOKEN: 'abc123' });
    expect(tokenOk(req(LEAKED))).toBe(false);
  });

  test('refuses a wrong token, a missing one, and an empty one', () => {
    const { tokenOk } = load({ INTEL_AUTOMATION_TOKEN: 'abc123' });
    expect(tokenOk(req('nope'))).toBe(false);
    expect(tokenOk(req(''))).toBe(false);
    expect(tokenOk({ query: {}, headers: {} })).toBe(false);
    expect(tokenOk({})).toBe(false);
  });

  test('the regen token is taken only where it is asked for', () => {
    const { tokenOk } = load({ INTEL_AUTOMATION_TOKEN: 'abc123', INTEL_REGEN_TOKEN: 'regen9' });
    expect(tokenOk(req('regen9'))).toBe(false);
    expect(tokenOk(req('regen9'), { regen: true })).toBe(true);
  });

  test('with no env var set, outside callers are refused and the boot token still works', () => {
    delete process.env.INTEL_AUTOMATION_TOKEN;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { tokenOk, automationToken } = load({});
    const boot = automationToken();
    expect(boot).toMatch(/^[0-9a-f]{48}$/);     // random, not guessable
    expect(tokenOk(req(boot))).toBe(true);      // the scheduler, in this process
    expect(tokenOk(req(LEAKED))).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a length mismatch does not throw', () => {
    const { sameToken } = load({ INTEL_AUTOMATION_TOKEN: 'abc123' });
    expect(sameToken('short', 'muchlongervalue')).toBe(false);
    expect(sameToken(undefined, 'abc123')).toBe(false);
  });
});
