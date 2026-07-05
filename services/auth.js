require('dotenv').config();

const crypto = require('crypto');
const {
  countAdminUsers,
  findAdminUserByUsername,
  createAdminUser,
  createAdminSession,
  findAdminSession,
  deleteAdminSession,
  deleteExpiredAdminSessions,
} = require('../db');

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'tcg_session';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':');
  if (!salt || !hash) return false;

  const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const left = Buffer.from(hash, 'hex');
  const right = Buffer.from(candidate, 'hex');
  if (left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator === -1) return [part, ''];
        const key = part.slice(0, separator);
        const value = part.slice(separator + 1);
        return [key, decodeURIComponent(value)];
      }),
  );
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE] || null;
}

function buildSessionCookie(token, { maxAgeMs = SESSION_TTL_MS } = {}) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function seedAdminUsersFromEnv() {
  if (countAdminUsers() > 0) return;

  const raw = process.env.ADMIN_USERS || '';
  const entries = raw.split(',').map((part) => part.trim()).filter(Boolean);

  if (!entries.length) {
    console.warn('[auth] ADMIN_USERS tanımlı değil. Panel girişi yapılamaz.');
    return;
  }

  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator === -1) continue;

    const username = entry.slice(0, separator).trim();
    const password = entry.slice(separator + 1);
    if (!username || !password) continue;

    createAdminUser({
      username,
      passwordHash: hashPassword(password),
      displayName: username,
    });
    console.log(`[auth] Admin kullanıcısı oluşturuldu: ${username}`);
  }
}

function createSession(userId) {
  deleteExpiredAdminSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  createAdminSession({ token, userId, expiresAt });
  return { token, expiresAt };
}

function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;

  deleteExpiredAdminSessions();
  const session = findAdminSession(token);
  if (!session || !session.is_active) return null;

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    deleteAdminSession(token);
    return null;
  }

  return {
    id: session.user_id,
    username: session.username,
    displayName: session.display_name || session.username,
  };
}

async function login(username, password) {
  const user = findAdminUserByUsername(username);
  if (!user || !user.is_active) {
    throw new Error('Kullanıcı adı veya şifre hatalı.');
  }

  if (!verifyPassword(password, user.password_hash)) {
    throw new Error('Kullanıcı adı veya şifre hatalı.');
  }

  const session = createSession(user.id);
  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
    },
    session,
  };
}

function logout(req) {
  const token = getSessionToken(req);
  if (token) deleteAdminSession(token);
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  seedAdminUsersFromEnv,
  login,
  logout,
  getSessionUser,
  getSessionToken,
  buildSessionCookie,
  clearSessionCookie,
};
