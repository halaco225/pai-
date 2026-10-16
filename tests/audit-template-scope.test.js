// Who sees which template in the Templates tab.
//
// The rule it guards: the people who build audits see all of them, and
// everyone else sees their own plus whatever came from above them. The leak
// this replaces was that any signed-in account could read a template whole,
// answer key included.

const { USER_ROSTER } = require('../routes/auth');
const { canSee } = require('../services/rc-scope');

// The same rule as routes/audits.js, kept here so a change to it has to be
// deliberate in both places.
function maySeeTemplate(user, t) {
  if (user.role === 'rdo' || user.role === 'vp') return true;
  if (!t.createdBy) return true;
  if (t.createdBy === user.username) return true;
  const maker = USER_ROSTER.find(u => u.username === t.createdBy);
  return maker ? canSee(maker, user.name) : false;
}

const user = name => {
  const u = USER_ROSTER.find(x => x.username === name);
  if (!u) throw new Error(`no such user: ${name}`);
  return u;
};

const harold = user('hlacoste');          // RDO
const matt = user('mhester');             // Harold's VP
const darian = user('dspikes');           // one of Harold's area coaches
const loriCoach = user('dselvig');        // an area coach in another region

describe('who sees a template', () => {
  test('an RDO sees everything, whoever made it', () => {
    expect(maySeeTemplate(harold, { createdBy: 'tspillane' })).toBe(true);
    expect(maySeeTemplate(harold, { createdBy: 'dselvig' })).toBe(true);
  });

  test('a VP sees everything too', () => {
    expect(maySeeTemplate(matt, { createdBy: 'jwarren' })).toBe(true);
  });

  test('an area coach sees what their own RDO made', () => {
    expect(maySeeTemplate(darian, { createdBy: 'hlacoste' })).toBe(true);
  });

  test('an area coach does not see another region\'s', () => {
    expect(maySeeTemplate(darian, { createdBy: 'tspillane' })).toBe(false);
    expect(maySeeTemplate(loriCoach, { createdBy: 'hlacoste' })).toBe(false);
  });

  test('everyone sees what they made themselves', () => {
    expect(maySeeTemplate(darian, { createdBy: 'dspikes' })).toBe(true);
  });

  test('a template from before owners existed stays visible', () => {
    expect(maySeeTemplate(darian, { createdBy: null })).toBe(true);
  });
});
