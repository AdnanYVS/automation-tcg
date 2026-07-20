const { getSessionUser } = require('../../services/auth');

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Bu işlem için giriş yapmanız gerekiyor.',
    });
  }

  req.user = user;
  return next();
}

function requireAuthPage(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    const nextPath = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login.html?next=${nextPath}`);
  }

  req.user = user;
  return next();
}

module.exports = {
  requireAuth,
  requireAuthPage,
};
