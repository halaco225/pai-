const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// All users share the default password: welcome1@
const DEFAULT_PASSWORD_HASH = '$2a$10$CMS4xDFNmb2.SavfTs2FHufXBO1LjX5Z4YtUWH.t8EWdZ6aHLTPuG';

const USER_ROSTER = [
  // VPs
  { username: 'cmagner', email: 'cmagner@ayvazpizza.com', name: 'Chad Magner', role: 'vp' },
  { username: 'mhester', email: 'mhester@ayvazpizza.com', name: 'Matt Hester', role: 'vp' },
  { username: 'tkrumwiede', email: 'tkrumwiede@ayvazpizza.com', name: 'Tracy Krumwiede', role: 'vp' },
  // RDOs
  { username: 'hlacoste', email: 'hlacoste@ayvazpizza.com', name: 'Harold Lacoste', role: 'rdo' },
  { username: 'jlozano', email: 'jlozano@ayvazpizza.com', name: 'Jose Lozano Sr.', role: 'rdo' },
  { username: 'jwarren', email: 'jwarren@ayvazpizza.com', name: 'Jerry Warren', role: 'rdo' },
  { username: 'lschwartz', email: 'lschwartz@ayvazpizza.com', name: 'Lori Schwartz', role: 'rdo' },
  { username: 'parnwine', email: 'parnwine@ayvazpizza.com', name: 'Preston Arnwine', role: 'rdo' },
  { username: 'pdiack', email: 'pdiack@ayvazpizza.com', name: 'Papa Diack', role: 'rdo' },
  { username: 'tmcdaniel', email: 'tmcdaniel@ayvazpizza.com', name: 'Theresa McDaniel', role: 'rdo' },
  { username: 'tspillane', email: 'tspillane@ayvazpizza.com', name: 'Terrance Spillane', role: 'rdo' },
  // Area Coaches
  { username: 'agarza', email: 'agarza@ayvazpizza.com', name: 'Alpha Garza', role: 'area_coach' },
  { username: 'aspikes', email: 'aspikes@ayvazpizza.com', name: 'Amanda Spikes', role: 'area_coach' },
  { username: 'bkaman', email: 'bkaman@ayvazpizza.com', name: 'Bahram Kaman', role: 'area_coach' },
  { username: 'bmarta', email: 'bmarta@ayvazpizza.com', name: 'Brenda Marta', role: 'area_coach' },
  { username: 'bmarzan', email: 'bmarzan@ayvazpizza.com', name: 'Brian Marzan', role: 'area_coach' },
  { username: 'cmiranda', email: 'cmiranda@ayvazpizza.com', name: 'Constance Miranda', role: 'area_coach' },
  { username: 'crobles', email: 'crobles@ayvazpizza.com', name: 'Cesar Robles', role: 'area_coach' },
  { username: 'ddittmar', email: 'ddittmar@ayvazpizza.com', name: 'Donna Dittmar', role: 'area_coach' },
  { username: 'dking', email: 'dking@ayvazpizza.com', name: 'Derek King', role: 'area_coach' },
  { username: 'dselvig', email: 'dselvig@ayvazpizza.com', name: 'Debbra Selvig', role: 'area_coach' },
  { username: 'dspikes', email: 'dspikes@ayvazpizza.com', name: 'Darian Spikes', role: 'area_coach' },
  { username: 'eboateng', email: 'eboateng@ayvazpizza.com', name: 'Emmanuel Boateng', role: 'area_coach' },
  { username: 'eharstine', email: 'eharstine@ayvazpizza.com', name: 'Eric Harstine', role: 'area_coach' },
  { username: 'epizzo', email: 'epizzo@ayvazpizza.com', name: 'Erin Pizzo', role: 'area_coach' },
  { username: 'esimmons', email: 'esimmons@ayvazpizza.com', name: 'Ebony Simmons', role: 'area_coach' },
  { username: 'fsandoval', email: 'fsandoval@ayvazpizza.com', name: 'Freddy (Antonio) Sandoval', role: 'area_coach' },
  { username: 'imranaway', email: 'imranaway@gulshaninc.com', name: 'Imran Awan (Kiosks-Express)', role: 'area_coach' },
  { username: 'jflores', email: 'jflores@ayvazpizza.com', name: 'Jose Flores', role: 'area_coach' },
  { username: 'jgarcia', email: 'jgarcia@ayvazpizza.com', name: 'Jorge Garcia', role: 'area_coach' },
  { username: 'jluna', email: 'jluna@ayvazpizza.com', name: 'Jesse Luna', role: 'area_coach' },
  { username: 'jmaldonado', email: 'jmaldonado@ayvazpizza.com', name: 'Jacob Maldonado', role: 'area_coach' },
  { username: 'jmartinez', email: 'jmartinez@ayvazpizza.com', name: 'Javier Martinez', role: 'area_coach' },
  { username: 'jmcneil', email: 'jmcneil@ayvazpizza.com', name: 'Jadon McNeil', role: 'area_coach' },
  { username: 'jsalinas', email: 'jsalinas@ayvazpizza.com', name: 'Joel Salinas', role: 'area_coach' },
  { username: 'jwashburn', email: 'jwashburn@ayvazpizza.com', name: 'Jeffrey Washburn', role: 'area_coach' },
  { username: 'kdunn', email: 'kdunn@ayvazpizza.com', name: 'Kevin Dunn', role: 'area_coach' },
  { username: 'kylesmith', email: 'kylesmith@ayvazpizza.com', name: 'Kyle Smith', role: 'area_coach' },
  { username: 'landinolfi', email: 'landinolfi@ayvazpizza.com', name: 'Luigi Andinolfi', role: 'area_coach' },
  { username: 'lduran', email: 'lduran@ayvazpizza.com', name: 'Lee Duran', role: 'area_coach' },
  { username: 'mavila', email: 'mavila@ayvazpizza.com', name: 'Maria Avila', role: 'area_coach' },
  { username: 'mcavazos', email: 'mcavazos@ayvazpizza.com', name: 'Michelle Cavazos', role: 'area_coach' },
  { username: 'mgannon', email: 'mgannon@ayvazpizza.com', name: 'Marc Gannon', role: 'area_coach' },
  { username: 'mlosey', email: 'mlosey@ayvazpizza.com', name: 'Max Losey', role: 'area_coach' },
  { username: 'mmeehan', email: 'mmeehan@ayvazpizza.com', name: 'Michelle Meehan', role: 'area_coach' },
  { username: 'mperez', email: 'mperez@ayvazpizza.com', name: 'Maria Delgado-Perez', role: 'area_coach' },
  { username: 'ogutierrez', email: 'ogutierrez@ayvazpizza.com', name: 'Oscar Gutierrez', role: 'area_coach' },
  { username: 'rbrown', email: 'rbrown@ayvazpizza.com', name: 'Reginald Brown', role: 'area_coach' },
  { username: 'rgonzalez', email: 'rgonzalez@ayvazpizza.com', name: 'Ruben Gonzalez', role: 'area_coach' },
  { username: 'rhightower', email: 'rhightower@ayvazpizza.com', name: 'Rachel Hightower', role: 'area_coach' },
  { username: 'rkowalczyk', email: 'rkowalczyk@ayvazpizza.com', name: 'Russell Kowalczyk', role: 'area_coach' },
  { username: 'rlott', email: 'rlott@ayvazpizza.com', name: 'Ravin Lott', role: 'area_coach' },
  { username: 'rmitchell', email: 'rmitchell@ayvazpizza.com', name: 'Royal Mitchell', role: 'area_coach' },
  { username: 'rsanchez', email: 'rsanchez@ayvazpizza.com', name: 'Roberto Sanchez', role: 'area_coach' },
  { username: 'rthomas', email: 'rthomas@ayvazpizza.com', name: 'Robert Thomas', role: 'area_coach' },
  { username: 'sbattenfield', email: 'sbattenfield@ayvazpizza.com', name: 'Larry (Steve) Battenfield', role: 'area_coach' },
  { username: 'sfiksdal', email: 'sfiksdal@ayvazpizza.com', name: 'Scott Fiksdal', role: 'area_coach' },
  { username: 'slubas', email: 'slubas@ayvazpizza.com', name: 'Szymon Lubas', role: 'area_coach' },
  { username: 'swhite', email: 'swhite@ayvazpizza.com', name: 'Stepfen White', role: 'area_coach' },
  { username: 'swillison', email: 'swillison@ayvazpizza.com', name: 'Shayda Willison', role: 'area_coach' },
  { username: 'tbaker', email: 'tbaker@ayvazpizza.com', name: 'Tami Elliott-Baker', role: 'area_coach' },
  { username: 'tcobb', email: 'tcobb@ayvazpizza.com', name: 'Thomas Cobb', role: 'area_coach' },
  { username: 'vvang', email: 'vvang@ayvazpizza.com', name: 'Va Vang', role: 'area_coach' }
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
    username: user.username, role: user.role
  };
  return res.json({ success: true, user: { name: user.name, role: user.role, username: user.username } });
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
