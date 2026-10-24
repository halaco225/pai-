// A user who has not yet chosen a password gets one page until they do.
//
// It lives here rather than inline in server.js because the first version
// redirected every GET, stylesheets included, and the change-password screen
// arrived with no styling at all — a browser asking for CSS was handed an
// HTML page. That is the case the test pins.

module.exports = function mustChangePassword(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.must_change) return next();
  if (req.method !== 'GET') return next();
  if (req.path === '/change-password' || req.path.startsWith('/api/')) return next();
  // Only whole pages are redirected. A navigation asks for text/html; a
  // stylesheet, script or image does not.
  if (!String(req.headers.accept || '').includes('text/html')) return next();
  return res.redirect('/change-password');
};
