// Authentication middleware for protected API routes

const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  // A user who has not yet chosen a password can do exactly one thing, and it
  // lives on /api/auth, which does not pass through here.
  if (req.session.user.must_change) {
    return res.status(403).json({ error: 'Password change required.', mustChangePassword: true });
  }
  next();
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
    if (req.session.user.must_change) {
      return res.status(403).json({ error: 'Password change required.', mustChangePassword: true });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden. Insufficient permissions.' });
    }
    next();
  };
};

// Named people who may build audit templates without holding an RDO or VP
// role. Jorge Garcia builds his own food safety tests; nothing else about his
// area coach access changes, and he still only reaches the templates he made.
// When this widens to every area coach, add 'area_coach' to the roles below
// and empty this list.
const TEMPLATE_EDITORS = ['jgarcia'];

const mayEditTemplates = (user) =>
  !!user && (['rdo', 'vp'].includes(user.role) || TEMPLATE_EDITORS.includes(user.username));

// The role check, plus the names above. Allow-listed people still go through
// requireAuth, so a forced password change still stops them.
const requireTemplateEditor = (req, res, next) =>
  TEMPLATE_EDITORS.includes(req.session && req.session.user && req.session.user.username)
    ? requireAuth(req, res, next)
    : requireRole('rdo', 'vp')(req, res, next);

// Per-module access. `tracker: false` on a session user means the module is
// off for them; the page shows a request-access note instead of a 404.
const requireModule = (name) => (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  if (req.session.user[name] === false) {
    return res.status(403).json({ error: `You do not have access to ${name}.`, requestAccess: true });
  }
  next();
};

module.exports = {
  requireAuth, requireRole, requireModule,
  requireTemplateEditor, mayEditTemplates, TEMPLATE_EDITORS,
};
