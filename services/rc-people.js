// services/rc-people.js
//
// Phone and timezone for a person, from RC Tracker's roster.
//
// data/people.json is a copy of rc-tracker/people.json. The two apps deploy
// separately, so a copy is the pragmatic answer for now — but a copy drifts,
// and P10 already moved two region coaches between VPs and retired one VP
// outright. rosterDrift() surfaces the disagreement instead of letting it sit;
// server.js logs it at boot.

const PEOPLE = require('../data/people.json');
const { USER_ROSTER } = require('../routes/auth');

function getPerson(name) {
  if (!name) return null;
  return PEOPLE[name] || null;
}

function nameForUsername(username) {
  if (!username) return null;
  const u = USER_ROSTER.find(r => r.username === username);
  return u ? u.name : null;
}

// What the roster and the copy disagree about. Reported, not thrown: a brief
// for one person should not be blocked by someone else's stale VP field.
function rosterDrift() {
  const rosterNames = new Set(USER_ROSTER.map(u => u.name));
  const peopleNames = new Set(Object.keys(PEOPLE));

  const missingFromPeople = [...rosterNames].filter(n => !peopleNames.has(n));
  const missingFromRoster = [...peopleNames].filter(n => !rosterNames.has(n));

  // people.json carries a `vp` label per person; USER_ROSTER carries scope.vp
  // for area coaches and scope.vp / scope.vp_name higher up. Compare only where
  // both sides actually state one.
  const vpMismatch = [];
  for (const u of USER_ROSTER) {
    const p = PEOPLE[u.name];
    if (!p || !p.vp) continue;
    const rosterVp = u.scope && (u.scope.vp || u.scope.vp_name);
    if (!rosterVp) continue;
    if (rosterVp !== p.vp) vpMismatch.push({ name: u.name, roster: rosterVp, people: p.vp });
  }

  return { missingFromPeople, missingFromRoster, vpMismatch };
}

// One line at boot, so drift is visible without anyone going looking.
function logRosterDrift() {
  const d = rosterDrift();
  const n = d.missingFromPeople.length + d.missingFromRoster.length + d.vpMismatch.length;
  if (!n) { console.log('   Roster: people.json matches USER_ROSTER ✓'); return d; }

  console.warn(`   Roster: ${n} disagreement(s) between people.json and USER_ROSTER`);
  if (d.missingFromPeople.length) console.warn(`     no phone/tz on file: ${d.missingFromPeople.join(', ')}`);
  if (d.missingFromRoster.length) console.warn(`     no login on file:    ${d.missingFromRoster.join(', ')}`);
  for (const m of d.vpMismatch) console.warn(`     VP differs: ${m.name} — roster says ${m.roster}, people.json says ${m.people}`);
  return d;
}

module.exports = { getPerson, nameForUsername, rosterDrift, logRosterDrift, PEOPLE };
