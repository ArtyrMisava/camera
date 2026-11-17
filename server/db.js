import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { DB_FILE, ensureDirs } from './paths.js';

ensureDirs();

export const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer',
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS presets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    layout     TEXT NOT NULL,
    camera_ids TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ------------------------------------------------------------------ пароли

export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const candidate = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function findUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(String(username || ''));
}

export function createUser({ username, displayName, password, role = 'viewer' }) {
  const { hash, salt } = hashPassword(password);
  const info = db
    .prepare(
      'INSERT INTO users (username, display_name, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)'
    )
    .run(username.trim(), (displayName || username).trim(), role, hash, salt);
  return db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export function listUsers() {
  return db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY id').all();
}

export function updateUserPassword(userId, password) {
  const { hash, salt } = hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, userId);
}

export function deleteUser(userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}
