'use strict';
/**
 * Who the Daily Intel queries think they are serving.
 *
 * Harold covers a region but is asked about Matt Hester's whole territory —
 * his own, Lori Schwartz's and Preston Arnwine's. The VP view already does
 * exactly that, including the per-region filter, so rather than teach twenty
 * queries a fourth role, an admin Region Coach who explicitly asks for the
 * territory is handed the VP shape and every existing `role === 'vp'` branch
 * works unchanged.
 *
 * The three conditions are the whole security boundary, so they are here, in
 * one function, with a test each:
 *   - the user asked for it: ?scope=territory. Never on by default.
 *   - the user is an admin Region Coach. A non-admin RDO cannot widen, which
 *     keeps Lori and Preston out of each other's regions.
 *   - the territory is the one they already sit under — their own scope.vp,
 *     never a name from the request.
 * And reads only: a GET can be widened, a write cannot.
 */

function territoryRegionCoaches(roster, vpName) {
  const out = [];
  for (const u of roster) {
    if (u.role !== 'rdo' || !u.scope || u.scope.vp !== vpName) continue;
    const rc = u.scope.rc_name || u.name;
    if (rc && !out.includes(rc)) out.push(rc);
  }
  return out;
}

function intelUser(req, roster) {
  const user = req && req.session && req.session.user;
  if (!user) return user;
  if ((req.method || 'GET') !== 'GET') return user;
  if (!req.query || req.query.scope !== 'territory') return user;
  if (user.role !== 'rdo' || user.admin !== true) return user;

  const vpName = user.scope && user.scope.vp;
  if (!vpName) return user;

  return {
    ...user,
    role: 'vp',
    viewingTerritory: true,          // so a handler can tell, if it ever needs to
    scope: {
      type: 'vp',
      vp_name: vpName,
      region_coaches: territoryRegionCoaches(roster || [], vpName),
    },
  };
}

module.exports = { intelUser, territoryRegionCoaches };
