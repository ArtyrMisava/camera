import crypto from 'node:crypto';
import {
  countUsers,
  createUser,
  findUserByName,
  verifyPassword,
  updateUserPassword,
  MIN_PASSWORD_LENGTH,
  db,
} from './db.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 часов
const COOKIE_NAME = 'cam_session';

/** Сессии в памяти: при перезапуске сервера нужно войти заново. */
const sessions = new Map();

function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

export function createSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, username: user.username, role: user.role, displayName: user.display_name, expiresAt: Date.now() + SESSION_TTL_MS });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  return token;
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Требуется вход в систему' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  const user = req.user || currentUser(req);
  if (!user) return res.status(401).json({ error: 'Требуется вход в систему' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Недостаточно прав' });
  req.user = user;
  next();
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
  }
  return null;
}

/**
 * Первый запуск: пользователей нет, поэтому создаём администратора.
 * Пароль в открытом виде досоздаётся только если его длина проходит валидацию,
 * иначе — сообщаем клиенту, что нужно придумать более надёжный.
 */
export function bootstrapAdmin({ username, displayName, password }) {
  if (countUsers() > 0) return { error: 'Администратор уже создан' };
  if (!username || String(username).trim().length < 3) return { error: 'Логин должен быть не короче 3 символов' };
  const problem = validatePassword(password);
  if (problem) return { error: problem };
  if (findUserByName(username)) return { error: 'Такой логин уже занят' };
  const user = createUser({ username, displayName, password, role: 'admin' });
  return { user };
}

export function login({ username, password }) {
  const record = findUserByName(username);
  if (!record) return { error: 'Неверный логин или пароль' };
  if (!verifyPassword(String(password || ''), record.password_hash, record.password_salt)) {
    return { error: 'Неверный логин или пароль' };
  }
  return { user: record };
}

export function changeOwnPassword(userId, { currentPassword, newPassword }) {
  const record = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!record) return { error: 'Пользователь не найден' };
  if (!verifyPassword(String(currentPassword || ''), record.password_hash, record.password_salt)) {
    return { error: 'Текущий пароль указан неверно' };
  }
  const problem = validatePassword(newPassword);
  if (problem) return { error: problem };
  updateUserPassword(userId, newPassword);
  return { ok: true };
}

export { validatePassword };
