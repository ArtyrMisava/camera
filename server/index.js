import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { config } from './config.js';
import { HLS_DIR, SNAPSHOT_DIR, PUBLIC_DIR, FFMPEG, ensureDirs } from './paths.js';
import { StreamManager } from './streams.js';
import {
  bootstrapAdmin,
  changeOwnPassword,
  createSession,
  currentUser,
  destroySession,
  login,
  requireAdmin,
  requireAuth,
  validatePassword,
} from './auth.js';
import { countUsers, createUser, db, deleteUser, listUsers, updateUserPassword } from './db.js';

ensureDirs();

const app = express();
const server = http.createServer(app);
const manager = new StreamManager(config);

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Файлы HLS нельзя кэшировать: иначе браузер надолго «запоминает» старые сегменты
app.use('/hls', express.static(HLS_DIR, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

app.get('/snapshots/:file', requireAuth, (req, res) => {
  const file = path.join(SNAPSHOT_DIR, path.basename(req.params.file));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(file);
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// ------------------------------------------------------------------ API: вход

app.get('/api/session', (req, res) => {
  res.json({
    needsSetup: countUsers() === 0,
    user: currentUser(req),
    title: config.server.title,
  });
});

app.post('/api/setup', (req, res) => {
  const result = bootstrapAdmin(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  const session = createSession(res, result.user);
  res.json({ user: { username: result.user.username, role: result.user.role, displayName: result.user.display_name }, session: Boolean(session) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login({ username, password });
  if (result.error) return res.status(401).json({ error: result.error });
  createSession(res, result.user);
  res.json({
    user: { username: result.user.username, role: result.user.role, displayName: result.user.display_name },
  });
});

app.post('/api/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.post('/api/profile/password', requireAuth, (req, res) => {
  const result = changeOwnPassword(req.user.userId, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ API: камеры

app.get('/api/cameras', requireAuth, (req, res) => {
  res.json({
    ...config.summary(),
    statuses: manager.listStatuses(),
    user: req.user,
  });
});

app.get('/api/cameras/:id/snapshot', requireAuth, async (req, res) => {
  const camera = config.getCamera(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Камера не найдена' });
  const file = await manager.snapshot(camera, { force: req.query.refresh === '1' });
  if (!file) {
    const previous = manager.snapshotPath(camera.id);
    if (fs.existsSync(previous)) {
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(previous);
    }
    return res.status(503).json({ error: 'Снимок недоступен: камера не отвечает' });
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(file);
});

// ------------------------------------------------------------------ API: HLS-потоки

app.get('/api/stream/:id/start', requireAuth, (req, res) => {
  const camera = config.getCamera(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Камера не найдена' });
  if (!camera.enabled) return res.status(409).json({ error: 'Камера отключена в конфигурации' });
  const quality = req.query.quality === 'sub' ? 'sub' : 'main';
  const stream = req.query.stream !== undefined ? Number(req.query.stream) : undefined;
  const entry = manager.getOrCreate(camera, quality, Number.isFinite(stream) ? stream : undefined);
  entry.addClient();
  const token = `${req.user.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  clientTokens.set(token, entry);
  res.json({
    url: `/hls/${entry.dir.split(path.sep).pop()}/index.m3u8`,
    token,
    status: entry.toJSON(),
  });
});

const clientTokens = new Map();

app.post('/api/stream/stop', requireAuth, (req, res) => {
  const token = String(req.body?.token || '');
  const entry = clientTokens.get(token);
  if (entry) {
    clientTokens.delete(token);
    entry.removeClient();
  }
  res.json({ ok: true });
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json({ statuses: manager.listStatuses() });
});

// ------------------------------------------------------------------ API: пресеты

app.get('/api/presets', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM presets ORDER BY id').all();
  res.json({ presets: rows.map((row) => ({ ...row, cameraIds: JSON.parse(row.camera_ids) })) });
});

app.post('/api/presets', requireAuth, (req, res) => {
  const { name, layout, cameraIds } = req.body || {};
  if (!name || !Array.isArray(cameraIds) || cameraIds.length === 0) {
    return res.status(400).json({ error: 'Нужны название и список камер' });
  }
  const info = db
    .prepare('INSERT INTO presets (name, layout, camera_ids) VALUES (?, ?, ?)')
    .run(String(name).slice(0, 60), String(layout || 'auto'), JSON.stringify(cameraIds));
  res.json({ id: Number(info.lastInsertRowid) });
});

app.delete('/api/presets/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM presets WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ------------------------------------------------------------------ API: пользователи

app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ users: listUsers() });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, displayName, password, role } = req.body || {};
  if (!username || String(username).trim().length < 3) return res.status(400).json({ error: 'Логин должен быть не короче 3 символов' });
  const problem = validatePassword(password);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const user = createUser({ username, displayName, password, role: role === 'admin' ? 'admin' : 'viewer' });
    res.json({ user });
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) return res.status(409).json({ error: 'Такой логин уже существует' });
    res.status(500).json({ error: 'Не удалось создать пользователя' });
  }
});

app.post('/api/users/:id/password', requireAdmin, (req, res) => {
  const problem = validatePassword(req.body?.password);
  if (problem) return res.status(400).json({ error: problem });
  updateUserPassword(Number(req.params.id), req.body.password);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.userId) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  const admins = listUsers().filter((user) => user.role === 'admin');
  const target = listUsers().find((user) => user.id === id);
  if (target?.role === 'admin' && admins.length === 1) {
    return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
  }
  deleteUser(id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ API: диагностика

app.get('/api/diagnostics/:id', requireAuth, (req, res) => {
  const camera = config.getCamera(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Камера не найдена' });
  const entry = manager.streams.get(manager.key(camera.id, req.query.quality === 'sub' ? 'sub' : 'main'));
  res.json({
    id: camera.id,
    name: camera.name,
    enabled: camera.enabled,
    rtsp: camera.demo ? 'demo' : undefined,
    status: entry ? entry.toJSON() : null,
    log: entry ? entry.logTail.slice(-12) : [],
    snapshotAge: manager.snapshotAge(camera.id).ageSeconds,
  });
});

// ------------------------------------------------------------------ 404 / ошибки

app.use('/api', (req, res) => res.status(404).json({ error: 'Метод API не найден' }));

app.use((error, req, res, next) => {
  console.error('[http]', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ------------------------------------------------------------------ запуск

const PORT = Number(process.env.PORT || config.server.port || 8080);
const HOST = process.env.HOST || '0.0.0.0';

manager.startSnapshotLoop(config.cameras.filter((camera) => camera.enabled));

config.on('change', () => {
  console.log('[config] конфигурация камер перезагружена');
  manager.startSnapshotLoop(config.cameras.filter((camera) => camera.enabled));
});
config.watch();

if (!fs.existsSync(FFMPEG) && !FFMPEG.includes(path.sep)) {
  console.warn('[ffmpeg] бинарник не найден — трансляция не заработает. Укажите FFMPEG_PATH.');
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Видеонаблюдение Amatek → http://localhost:${PORT}`);
  console.log(`  Камер в конфигурации: ${config.cameras.length}, пользователей: ${countUsers()}`);
  if (config.warnings.length) {
    for (const warning of config.warnings) console.warn(`  ! ${warning}`);
  }
  if (countUsers() === 0) console.log('  Первый вход: придумайте учётную запись администратора в окне входа.');
  console.log('');
});

function shutdown() {
  manager.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
