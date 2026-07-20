const express = require('express');
const {
  login,
  logout,
  getSessionUser,
  buildSessionCookie,
  clearSessionCookie,
} = require('../../services/auth');

const router = express.Router();

router.get('/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Oturum bulunamadı.' });
  }

  return res.json({ success: true, data: { user } });
});

router.post('/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Kullanıcı adı ve şifre zorunludur.' });
    }

    const result = await login(username, password);
    res.setHeader('Set-Cookie', buildSessionCookie(result.session.token));

    return res.json({
      success: true,
      data: {
        user: result.user,
        expiresAt: result.session.expiresAt,
      },
    });
  } catch (error) {
    return res.status(401).json({ success: false, error: error.message });
  }
});

router.post('/auth/logout', (req, res) => {
  logout(req);
  res.setHeader('Set-Cookie', clearSessionCookie());
  return res.json({ success: true });
});

module.exports = router;
