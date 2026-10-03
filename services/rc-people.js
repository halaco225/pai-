// services/rc-people.js
//
// Phone and timezone for a person, from RC Tracker's roster.
//
// data/people.json is a copy of rc-tracker/people.json. The two apps deploy
// separately, so a copy is the pragmatic answer for now — but a copy drifts,
// and P10 already moved two region coaches between VPs and retired one VP
// outright. rosterDrift() surfaces the disagreement instead of letting it sit;
// server.js logs it at boot.

// people.json holds 62 staff phone numbers and is NOT in git — the same rule
// RC Tracker has always applied to it (rc-tracker/.gitignore:3). On Render it
// is a Secret File. Missing, the brief sender simply has no one to text and
// says so, rather than failing to boot.
const fs   = require('fs');
const path = require('path');

function loadPeople() {
  const candidates = [
    process.env.PEOPLE_JSON_PATH,                        // explicit override
    '/etc/secrets/people.json',                          // Render Secret File
    path.join(__dirname, '..', 'people.json'),           // app root
    path.join(__dirname, '..', 'data', 'people.json'),   // local dev
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.error(`[rc-people] ${p} is unreadable: ${err.message}`);
    }
  }
  console.error('[rc-people] people.json not found — brief texts are off until it is added as a Render Secret File');
  return {};
}

const PEOPLE = loadPeople();
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
