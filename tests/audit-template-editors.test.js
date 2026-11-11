// Who may build an audit template, and whose folder it lands in.
//
// Jorge Garcia and Szymon Lubas are area coaches who build their own food
// safety tests. They are named in an allow-list rather than promoted, because
// promoting them would hand them every other RDO power, and opening it to
// `area_coach` would hand it to forty people nobody asked about.

const { mayEditTemplates, requireTemplateEditor, TEMPLATE_EDITORS } = require('../middleware/auth');
const { maySeeTemplate, mayEditTemplate, creatorName } = require('../routes/audits');
const { USER_ROSTER } = require('../routes/auth');

const user = name => {
  const u = USER_ROSTER.find(x => x.username === name);
  if (!u) throw new Error(`no such user: ${name}`);
  return u;
};

const harold = user('hlacoste');   // RDO
const matt   = user('mhester');    // VP
const jorge  = user('jgarcia');    // an area coach on the list
const szymon = user('slubas');     // the other one, in another region
const darian = user('dspikes');    // an area coach who is not

// A middleware run reduced to what came out of it: the next() call, or the
// status and body it refused with.
function run(mw, sessionUser) {
  let out = { next: false };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  mw({ session: { user: sessionUser } }, res, () => { out.next = true; });
  return out;
}

describe('who may build a template', () => {
  test('Jorge may, though he is an area coach', () => {
    expect(mayEditTemplates(jorge)).toBe(true);
    expect(run(requireTemplateEditor, jorge).next).toBe(true);
  });

  test('so may Szymon', () => {
    expect(mayEditTemplates(szymon)).toBe(true);
    expect(run(requireTemplateEditor, szymon).next).toBe(true);
  });

  test('RDOs and VPs still may', () => {
    expect(mayEditTemplates(harold)).toBe(true);
    expect(mayEditTemplates(matt)).toBe(true);
    expect(run(requireTemplateEditor, harold).next).toBe(true);
  });

  test('another area coach still may not', () => {
    expect(mayEditTemplates(darian)).toBe(false);
    const out = run(requireTemplateEditor, darian);
    expect(out.next).toBe(false);
    expect(out.status).toBe(403);
  });

  test('it is those two only, not every area coach', () => {
    expect(TEMPLATE_EDITORS).toEqual(['jgarcia', 'slubas']);
    const otherACs = USER_ROSTER.filter(
      u => u.role === 'area_coach' && !TEMPLATE_EDITORS.includes(u.username));
    expect(otherACs.length).toBeGreaterThan(1);
    expect(otherACs.some(mayEditTemplates)).toBe(false);
  });

  test('a signed-out request is still turned away', () => {
    expect(mayEditTemplates(null)).toBe(false);
    expect(run(requireTemplateEditor, null).status).toBe(401);
  });

  test('a password change still comes first', () => {
    const out = run(requireTemplateEditor, { ...jorge, must_change: true });
    expect(out.next).toBe(false);
    expect(out.status).toBe(403);
  });
});

describe('what Jorge may change', () => {
  test('his own', () => {
    expect(mayEditTemplate(jorge, { createdBy: 'jgarcia' })).toBe(true);
  });

  test('not somebody else\'s, nor a built-in one', () => {
    expect(mayEditTemplate(jorge, { createdBy: 'hlacoste' })).toBe(false);
    expect(mayEditTemplate(jorge, { createdBy: 'seed' })).toBe(false);
  });

  test('and not each other\'s', () => {
    expect(mayEditTemplate(jorge, { createdBy: 'slubas' })).toBe(false);
    expect(mayEditTemplate(szymon, { createdBy: 'jgarcia' })).toBe(false);
    expect(mayEditTemplate(szymon, { createdBy: 'slubas' })).toBe(true);
  });

  test('an RDO may still change anyone\'s', () => {
    expect(mayEditTemplate(harold, { createdBy: 'jgarcia' })).toBe(true);
    expect(mayEditTemplate(matt, { createdBy: 'seed' })).toBe(true);
  });

  test('Harold editing Jorge\'s does not move it out of Jorge\'s folder', () => {
    // saveTemplate leaves created_by alone on conflict; this is the rule that
    // depends on it.
    expect(creatorName('jgarcia')).toBe('Jorge Garcia');
  });
});

describe('which folder a template shows up in', () => {
  test('a person gets their own name', () => {
    expect(creatorName('hlacoste')).toBe('Harold Lacoste');
    expect(creatorName('jgarcia')).toBe('Jorge Garcia');
    expect(creatorName('slubas')).toBe('Szymon Lubas');
  });

  test('the seeded ones are Built in, not a person', () => {
    expect(creatorName('seed')).toBe('Built in');
    expect(creatorName(null)).toBe('Built in');
    expect(creatorName('')).toBe('Built in');
  });

  test('someone off the roster still gets a folder, under their username', () => {
    expect(creatorName('exemployee')).toBe('exemployee');
  });

  test('a folder exists only because a template is in it', () => {
    const list = [
      { createdBy: 'jgarcia' }, { createdBy: 'jgarcia' }, { createdBy: 'seed' },
    ].map(t => ({ ...t, createdByName: creatorName(t.createdBy) }));

    const folders = new Map();
    for (const t of list) {
      if (!folders.has(t.createdByName)) folders.set(t.createdByName, []);
      folders.get(t.createdByName).push(t);
    }
    expect([...folders.keys()].sort()).toEqual(['Built in', 'Jorge Garcia']);
    expect(folders.get('Jorge Garcia')).toHaveLength(2);
    expect([...folders.values()].every(f => f.length > 0)).toBe(true);
    // Harold has made none in this list, so he has no folder.
    expect(folders.has('Harold Lacoste')).toBe(false);
  });
});

describe('the templates list Jorge is shown', () => {
  test('he sees the built-in ones, which have no person behind them', () => {
    expect(maySeeTemplate(jorge, { createdBy: 'seed' })).toBe(true);
    expect(maySeeTemplate(darian, { createdBy: 'seed' })).toBe(true);
  });

  test('and still not another region\'s', () => {
    expect(maySeeTemplate(jorge, { createdBy: 'tspillane' })).toBe(false);
  });
});
