// services/rc-scope.js
//
// Turns a P.AI session user into the set of people whose follow-ups they may
// see. Pure — no I/O — so the boundaries are testable without a database.
//
// This is the substance of moving Tracker behind the login. RC Tracker today
// has no authentication at all: anyone who finds the URL picks a name from a
// dropdown and reads all 62 people's follow-ups.

const { USER_ROSTER } = require('../routes/auth');

// Everyone an RDO covers: their area coaches, plus themselves.
function rdoPeople(scope, name) {
  const acs = scope.area_coaches || [];
  return [...acs, scope.rc_name || name];
}

// Everyone a VP covers: each of their region coaches, each of those coaches'
// area coaches, plus themselves. Walks USER_ROSTER rather than trusting a
// denormalised list, so a roster edit in one place does not silently widen or
// narrow someone's scope.
function vpPeople(scope, name) {
  const rcs  = scope.region_coaches || [];
  const seen = new Set([scope.vp_name || name, ...rcs]);
  for (const rc of rcs) {
    const entry = USER_ROSTER.find(u => u.role === 'rdo' && (u.scope.rc_name || u.name) === rc);
    for (const ac of (entry && entry.scope.area_coaches) || []) seen.add(ac);
  }
  return [...seen];
}

/**
 * Person names this user may see follow-ups for.
 * Returns [] for an unknown shape — deny by default, never "everyone".
 */
function visiblePeople(user) {
  if (!user || !user.scope) return [];
  const scope = user.scope;

  switch (scope.type || user.role) {
    case 'area_coach': return [scope.ac_name || user.name];
    case 'rdo':        return rdoPeople(scope, user.name);
    case 'vp':         return vpPeople(scope, user.name);
    default:           return [];
  }
}

// Can this user see this person's items? Used per row, so a name that is not
// in scope cannot be read even if its id is guessed.
function canSee(user, personName) {
  return visiblePeople(user).includes(personName);
}

module.exports = { visiblePeople, canSee };
