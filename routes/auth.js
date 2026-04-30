const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// All users share the default password: welcome1@
const DEFAULT_PASSWORD_HASH = '$2a$10$CMS4xDFNmb2.SavfTs2FHufXBO1LjX5Z4YtUWH.t8EWdZ6aHLTPuG';

// ── Org hierarchy (from Master Alignment P5 REV 042326) ────────────────────
// scope: { type, ac_name?, area?, region_coach?, rc_name?, area_coaches?, vp_name?, region_coaches? }
const USER_ROSTER = [
  // ── VPs ──────────────────────────────────────────────────────────────────
  { username: 'cmagner', email: 'cmagner@ayvazpizza.com', name: 'Chad Magner', role: 'vp',
    scope: { type: 'vp', vp_name: 'Chad Magner',
      region_coaches: ['Lori Schwartz'] } },
  { username: 'mhester', email: 'mhester@ayvazpizza.com', name: 'Matt Hester', role: 'vp',
    scope: { type: 'vp', vp_name: 'Matt Hester',
      region_coaches: ['Harold Lacoste', 'Preston Arnwine', 'Terrance Spillane'] } },
  { username: 'tkrumwiede', email: 'tkrumwiede@ayvazpizza.com', name: 'Tracy Krumwiede', role: 'vp',
    scope: { type: 'vp', vp_name: 'Tracy Krumwiede',
      region_coaches: ['Jerry Warren', 'Jose Lozano Sr.', 'Papa Diack', 'Theresa McDaniel'] } },

  // ── RDOs (Region Coaches) ─────────────────────────────────────────────────
  { username: 'hlacoste', email: 'hlacoste@ayvazpizza.com', name: 'Harold Lacoste', role: 'rdo',
    scope: { type: 'rdo', rc_name: 'Harold Lacoste', vp: 'Matt Hester',
      area_coaches: ['Darian Spikes','Ebony Simmons','Jadon McNeil','Jorge Garcia','Marc Gannon','Michelle Meehan'] } },
  { username: 'parnwine', email: 'parnwine@ayvazpizza.com', name: 'Preston Arnwine', role: 'rdo',
    scope: { type: 'rdo', rc_name: 'Preston Arnwine', vp: 'Matt Hester',
      area_coaches: ['Emmanuel Boateng','Erin Pizzo','Royal Mitchell','Russell Kowalczyk','Stepfen White'] } },
  { username: 'tspillane', email: 'tspillane@ayvazpizza.com', name: 'Terrance Spillane', role: 'rdo',
    scope: { type: 'rdo', rc_name: 'Terrance Spillane', vp: 'Matt Hester',
      area_coaches: ['Brenda Marta','Constance Miranda','Eric Harstine','Javier Martinez','Kevin Dunn','Max Losey','Oscar Gutierrez','Tami Elliott-Baker'] } },
  { username: 'jwarren', email: 'jwarren@ayvazpizza.com', name: 'Jerry Warren', role: 'rdo',
    scope: { type: 'rdo', rc_name: 'Jerry Warren', vp: 'Tracy Krumwiede',
      area_coaches: ['Alpha Garza','Amanda Spikes','Imran Awan (Kiosks-Express)','Larry (Steve) Battenfield','Thomas Cobb'] } },
  { username: 'jlozano', email: 'jlozano@ayvazpizza.com', name: 'Jose Lozano Sr.', role: 'rdo',
    scope: { type: 'rdo', rc_name: 'Jose Lozano Sr.', vp: 'Tracy Krumwiede',
      area_coaches: ['Jacob Maldonado','Joel Salinas','Jose Flores','Lee Duran','Maria Avila','Michelle Cavazos','Roberto Sanchez','Ruben Gonzalez'] } },
  { username: 'pdiack', email: 'pdiack@ayvazpizza.com', name: 'Papa Diack', role: 'rdo',
    scope: { type: 'rdo', rc_name: 'Papa Diack', vp: 'Tracy Krumwiede',
      area_coaches: ['Jeffrey Washburn','Maria Delgado-Perez','Rachel Hightower','Ravin Lott','Reginald Brown','Robert Thomas','Shayda Willison'] } },
  { username: 'tmcdaniel', email: 'tmcdaniel@ayvazpizza.com', name: 'Theresa McDaniel', role: 'rdo',
    scope: { type: 'rdo', rc_name: 'Theresa McDaniel', vp: 'Tracy Krumwiede',
      area_coaches: ['Bahram Kaman','Brian Marzan','Cesar Robles','Donna Dittmar','Freddy (Antonio) Sandoval','Jesse Luna','Kyle Smith','Luigi Andinolfi'] } },
  { username: 'lschwartz', email: 'lschwartz@ayvazpizza.com', name: 'Lori Schwartz', role: 'rdo',
    scope: { type: 'rdo', rc_name: 'Lori Schwartz', vp: 'Chad Magner',
      area_coaches: ['Debbra Selvig','Derek King','Scott Fiksdal','Szymon Lubas','Va Vang'] } },

  // ── Area Coaches ──────────────────────────────────────────────────────────
  // Harold Lacoste's region
  { username: 'dspikes',    email: 'dspikes@ayvazpizza.com',    name: 'Darian Spikes',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Darian Spikes',    area: 'Area 2011', region_coach: 'Harold Lacoste',   vp: 'Matt Hester' } },
  { username: 'esimmons',   email: 'esimmons@ayvazpizza.com',   name: 'Ebony Simmons',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Ebony Simmons',    area: 'Area 2016', region_coach: 'Harold Lacoste',   vp: 'Matt Hester' } },
  { username: 'jmcneil',    email: 'jmcneil@ayvazpizza.com',    name: 'Jadon McNeil',     role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Jadon McNeil',     area: 'Area 2022', region_coach: 'Harold Lacoste',   vp: 'Matt Hester' } },
  { username: 'jgarcia',    email: 'jgarcia@ayvazpizza.com',    name: 'Jorge Garcia',     role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Jorge Garcia',     area: 'Area 2000', region_coach: 'Harold Lacoste',   vp: 'Matt Hester' } },
  { username: 'mgannon',    email: 'mgannon@ayvazpizza.com',    name: 'Marc Gannon',      role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Marc Gannon',      area: 'Area 2015', region_coach: 'Harold Lacoste',   vp: 'Matt Hester' } },
  { username: 'mmeehan',    email: 'mmeehan@ayvazpizza.com',    name: 'Michelle Meehan',  role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Michelle Meehan',  area: 'Area 2034', region_coach: 'Harold Lacoste',   vp: 'Matt Hester' } },
  // Preston Arnwine's region
  { username: 'eboateng',   email: 'eboateng@ayvazpizza.com',   name: 'Emmanuel Boateng', role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Emmanuel Boateng', area: 'Area 2017', region_coach: 'Preston Arnwine',  vp: 'Matt Hester' } },
  { username: 'epizzo',     email: 'epizzo@ayvazpizza.com',     name: 'Erin Pizzo',       role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Erin Pizzo',       area: 'Area 2004', region_coach: 'Preston Arnwine',  vp: 'Matt Hester' } },
  { username: 'rmitchell',  email: 'rmitchell@ayvazpizza.com',  name: 'Royal Mitchell',   role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Royal Mitchell',   area: 'Area 2009', region_coach: 'Preston Arnwine',  vp: 'Matt Hester' } },
  { username: 'rkowalczyk', email: 'rkowalczyk@ayvazpizza.com', name: 'Russell Kowalczyk',role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Russell Kowalczyk',area: 'Area 2048', region_coach: 'Preston Arnwine',  vp: 'Matt Hester' } },
  { username: 'swhite',     email: 'swhite@ayvazpizza.com',     name: 'Stepfen White',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Stepfen White',    area: 'Area 2041', region_coach: 'Preston Arnwine',  vp: 'Matt Hester' } },
  // Terrance Spillane's region
  { username: 'bmarta',     email: 'bmarta@ayvazpizza.com',     name: 'Brenda Marta',     role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Brenda Marta',     area: 'Area 2002', region_coach: 'Terrance Spillane',vp: 'Matt Hester' } },
  { username: 'cmiranda',   email: 'cmiranda@ayvazpizza.com',   name: 'Constance Miranda',role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Constance Miranda',area: 'Area 2010', region_coach: 'Terrance Spillane',vp: 'Matt Hester' } },
  { username: 'eharstine',  email: 'eharstine@ayvazpizza.com',  name: 'Eric Harstine',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Eric Harstine',    area: 'Area 2033', region_coach: 'Terrance Spillane',vp: 'Matt Hester' } },
  { username: 'jmartinez',  email: 'jmartinez@ayvazpizza.com',  name: 'Javier Martinez',  role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Javier Martinez',  area: 'Area 2024', region_coach: 'Terrance Spillane',vp: 'Matt Hester' } },
  { username: 'kdunn',      email: 'kdunn@ayvazpizza.com',      name: 'Kevin Dunn',       role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Kevin Dunn',       area: 'Area 2055', region_coach: 'Terrance Spillane',vp: 'Matt Hester' } },
  { username: 'mlosey',     email: 'mlosey@ayvazpizza.com',     name: 'Max Losey',        role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Max Losey',        area: 'Area 2039', region_coach: 'Terrance Spillane',vp: 'Matt Hester' } },
  { username: 'ogutierrez', email: 'ogutierrez@ayvazpizza.com', name: 'Oscar Gutierrez',  role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Oscar Gutierrez',  area: 'Area 2043', region_coach: 'Terrance Spillane',vp: 'Matt Hester' } },
  { username: 'tbaker',     email: 'tbaker@ayvazpizza.com',     name: 'Tami Elliott-Baker',role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Tami Elliott-Baker',area:'Area 2008', region_coach: 'Terrance Spillane',vp: 'Matt Hester' } },
  // Jerry Warren's region
  { username: 'agarza',     email: 'agarza@ayvazpizza.com',     name: 'Alpha Garza',      role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Alpha Garza',      area: 'Area 2042', region_coach: 'Jerry Warren',     vp: 'Tracy Krumwiede' } },
  { username: 'aspikes',    email: 'aspikes@ayvazpizza.com',    name: 'Amanda Spikes',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Amanda Spikes',    area: 'Area 2001', region_coach: 'Jerry Warren',     vp: 'Tracy Krumwiede' } },
  { username: 'imranaway',  email: 'imranaway@gulshaninc.com',  name: 'Imran Awan (Kiosks-Express)', role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Imran Awan (Kiosks-Express)', area: 'Area 2100', region_coach: 'Jerry Warren', vp: 'Tracy Krumwiede' } },
  { username: 'sbattenfield',email:'sbattenfield@ayvazpizza.com',name:'Larry (Steve) Battenfield',role:'area_coach',
    scope: { type: 'area_coach', ac_name: 'Larry (Steve) Battenfield', area: 'Area 2050', region_coach: 'Jerry Warren', vp: 'Tracy Krumwiede' } },
  { username: 'tcobb',      email: 'tcobb@ayvazpizza.com',      name: 'Thomas Cobb',      role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Thomas Cobb',      area: 'Area 2030', region_coach: 'Jerry Warren',     vp: 'Tracy Krumwiede' } },
  // Jose Lozano's region
  { username: 'jmaldonado', email: 'jmaldonado@ayvazpizza.com', name: 'Jacob Maldonado',  role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Jacob Maldonado',  area: 'Area 2021', region_coach: 'Jose Lozano Sr.',  vp: 'Tracy Krumwiede' } },
  { username: 'jsalinas',   email: 'jsalinas@ayvazpizza.com',   name: 'Joel Salinas',     role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Joel Salinas',     area: 'Area 2019', region_coach: 'Jose Lozano Sr.',  vp: 'Tracy Krumwiede' } },
  { username: 'jflores',    email: 'jflores@ayvazpizza.com',    name: 'Jose Flores',      role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Jose Flores',      area: 'Area 2027', region_coach: 'Jose Lozano Sr.',  vp: 'Tracy Krumwiede' } },
  { username: 'lduran',     email: 'lduran@ayvazpizza.com',     name: 'Lee Duran',        role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Lee Duran',        area: 'Area 2035', region_coach: 'Jose Lozano Sr.',  vp: 'Tracy Krumwiede' } },
  { username: 'mavila',     email: 'mavila@ayvazpizza.com',     name: 'Maria Avila',      role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Maria Avila',      area: 'Area 2038', region_coach: 'Jose Lozano Sr.',  vp: 'Tracy Krumwiede' } },
  { username: 'mcavazos',   email: 'mcavazos@ayvazpizza.com',   name: 'Michelle Cavazos', role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Michelle Cavazos', area: 'Area 2040', region_coach: 'Jose Lozano Sr.',  vp: 'Tracy Krumwiede' } },
  { username: 'rsanchez',   email: 'rsanchez@ayvazpizza.com',   name: 'Roberto Sanchez',  role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Roberto Sanchez',  area: 'Area 2029', region_coach: 'Jose Lozano Sr.',  vp: 'Tracy Krumwiede' } },
  { username: 'rgonzalez',  email: 'rgonzalez@ayvazpizza.com',  name: 'Ruben Gonzalez',   role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Ruben Gonzalez',   area: 'Area 2047', region_coach: 'Jose Lozano Sr.',  vp: 'Tracy Krumwiede' } },
  // Papa Diack's region
  { username: 'jwashburn',  email: 'jwashburn@ayvazpizza.com',  name: 'Jeffrey Washburn', role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Jeffrey Washburn', area: 'Area 2054', region_coach: 'Papa Diack',       vp: 'Tracy Krumwiede' } },
  { username: 'mperez',     email: 'mperez@ayvazpizza.com',     name: 'Maria Delgado-Perez',role:'area_coach',
    scope: { type: 'area_coach', ac_name: 'Maria Delgado-Perez',area:'Area 2006',region_coach:'Papa Diack',         vp: 'Tracy Krumwiede' } },
  { username: 'rhightower', email: 'rhightower@ayvazpizza.com', name: 'Rachel Hightower', role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Rachel Hightower', area: 'Area 2045', region_coach: 'Papa Diack',       vp: 'Tracy Krumwiede' } },
  { username: 'rlott',      email: 'rlott@ayvazpizza.com',      name: 'Ravin Lott',       role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Ravin Lott',       area: 'Area 2051', region_coach: 'Papa Diack',       vp: 'Tracy Krumwiede' } },
  { username: 'rbrown',     email: 'rbrown@ayvazpizza.com',     name: 'Reginald Brown',   role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Reginald Brown',   area: 'Area 2046', region_coach: 'Papa Diack',       vp: 'Tracy Krumwiede' } },
  { username: 'rthomas',    email: 'rthomas@ayvazpizza.com',    name: 'Robert Thomas',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Robert Thomas',    area: 'Area 2037', region_coach: 'Papa Diack',       vp: 'Tracy Krumwiede' } },
  { username: 'swillison',  email: 'swillison@ayvazpizza.com',  name: 'Shayda Willison',  role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Shayda Willison',  area: 'Area 2059', region_coach: 'Papa Diack',       vp: 'Tracy Krumwiede' } },
  // Theresa McDaniel's region
  { username: 'bkaman',     email: 'bkaman@ayvazpizza.com',     name: 'Bahram Kaman',     role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Bahram Kaman',     area: 'Area 2025', region_coach: 'Theresa McDaniel', vp: 'Tracy Krumwiede' } },
  { username: 'bmarzan',    email: 'bmarzan@ayvazpizza.com',    name: 'Brian Marzan',     role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Brian Marzan',     area: 'Area 2032', region_coach: 'Theresa McDaniel', vp: 'Tracy Krumwiede' } },
  { username: 'crobles',    email: 'crobles@ayvazpizza.com',    name: 'Cesar Robles',     role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Cesar Robles',     area: 'Area 2007', region_coach: 'Theresa McDaniel', vp: 'Tracy Krumwiede' } },
  { username: 'ddittmar',   email: 'ddittmar@ayvazpizza.com',   name: 'Donna Dittmar',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Donna Dittmar',    area: 'Area 2014', region_coach: 'Theresa McDaniel', vp: 'Tracy Krumwiede' } },
  { username: 'fsandoval',  email: 'fsandoval@ayvazpizza.com',  name: 'Freddy (Antonio) Sandoval',role:'area_coach',
    scope: { type: 'area_coach', ac_name: 'Freddy (Antonio) Sandoval',area:'Area 2031',region_coach:'Theresa McDaniel',vp:'Tracy Krumwiede' } },
  { username: 'jluna',      email: 'jluna@ayvazpizza.com',      name: 'Jesse Luna',       role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Jesse Luna',       area: 'Area 2028', region_coach: 'Theresa McDaniel', vp: 'Tracy Krumwiede' } },
  { username: 'kylesmith',  email: 'kylesmith@ayvazpizza.com',  name: 'Kyle Smith',       role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Kyle Smith',       area: 'Area 2056', region_coach: 'Theresa McDaniel', vp: 'Tracy Krumwiede' } },
  { username: 'landinolfi', email: 'landinolfi@ayvazpizza.com', name: 'Luigi Andinolfi',  role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Luigi Andinolfi',  area: 'Area 2036', region_coach: 'Theresa McDaniel', vp: 'Tracy Krumwiede' } },
  // Lori Schwartz's region (Chad Magner)
  { username: 'dselvig',    email: 'dselvig@ayvazpizza.com',    name: 'Debbra Selvig',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Debbra Selvig',    area: 'Area 2013', region_coach: 'Lori Schwartz',    vp: 'Chad Magner' } },
  { username: 'dking',      email: 'dking@ayvazpizza.com',      name: 'Derek King',       role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Derek King',       area: 'Area 2057', region_coach: 'Lori Schwartz',    vp: 'Chad Magner' } },
  { username: 'sfiksdal',   email: 'sfiksdal@ayvazpizza.com',   name: 'Scott Fiksdal',    role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Scott Fiksdal',    area: 'Area 2049', region_coach: 'Lori Schwartz',    vp: 'Chad Magner' } },
  { username: 'slubas',     email: 'slubas@ayvazpizza.com',     name: 'Szymon Lubas',     role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Szymon Lubas',     area: 'Area 2044', region_coach: 'Lori Schwartz',    vp: 'Chad Magner' } },
  { username: 'vvang',      email: 'vvang@ayvazpizza.com',      name: 'Va Vang',          role: 'area_coach',
    scope: { type: 'area_coach', ac_name: 'Va Vang',          area: 'Area 2012', region_coach: 'Lori Schwartz',    vp: 'Chad Magner' } },
];

const USER_MAP = new Map();
USER_ROSTER.forEach((u, idx) => {
  const user = { id: idx + 1, ...u, passwordHash: DEFAULT_PASSWORD_HASH };
  USER_MAP.set(u.username.toLowerCase(), user);
  USER_MAP.set(u.email.toLowerCase(), user);
});

router.post('/login', async (req, res) => {
  const identifier = (req.body.email || req.body.username || '').trim().toLowerCase();
  const { password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/email and password required.' });
  }
  const user = USER_MAP.get(identifier);
  if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
  req.session.user = {
    id: user.id, name: user.name, email: user.email,
    username: user.username, role: user.role, scope: user.scope
  };
  return res.json({ success: true, user: { name: user.name, role: user.role, username: user.username, scope: user.scope } });
});

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed.' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

module.exports = router;

// Export USER_ROSTER for Intel module cache generation
module.exports.USER_ROSTER = USER_ROSTER;
