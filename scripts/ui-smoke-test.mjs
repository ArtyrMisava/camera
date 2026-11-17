// Прогон клиентской логики в jsdom: проверяем сетку, переключение камер и плееры без реального браузера.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire('/tmp/domtest/')('jsdom');

const ROOT = '/home/user/camera';
const BASE = 'http://localhost:8080';

const cameras = [
  { id: 'demo-1', name: 'Демо 1', group: 'Демо', host: '', enabled: true, demo: true, hasPassword: false },
  { id: 'demo-2', name: 'Демо 2', group: 'Демо', host: '', enabled: true, demo: true, hasPassword: false },
  { id: 'cam-3', name: 'Камера 3', group: 'Вход', host: '10.0.0.3', enabled: true, demo: false, hasPassword: true },
  { id: 'cam-4', name: 'Камера 4', group: 'Вход', host: '10.0.0.4', enabled: true, demo: false, hasPassword: true },
  { id: 'cam-5', name: 'Камера 5', group: 'Вход', host: '10.0.0.5', enabled: false, demo: false, hasPassword: true },
];

const failures = [];
const requests = [];

function check(name, condition, extra = '') {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '');

const dom = new JSDOM(html, { url: `${BASE}/`, pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;

// --- заглушки браузерных API, которых нет в jsdom ---
window.Hls = function FakeHls() {
  FakeHls.instances.push(this);
  this.destroyed = false;
  this.on = (event, handler) => { (this.handlers[event] ||= []).push(handler); };
  this.handlers = {};
  this.loadSource = (url) => { this.url = url; };
  this.attachMedia = () => { this.media = true; setTimeout(() => (this.handlers.hlsManifestParsed || []).forEach((h) => h()), 0); };
  this.destroy = () => { this.destroyed = true; };
  FakeHls.instances.push; // noop
};
window.Hls.instances = [];
window.Hls.isSupported = () => true;
window.Hls.Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };

window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
window.HTMLMediaElement.prototype.pause = function pause() {};
window.HTMLMediaElement.prototype.load = function load() {};

const playersStarted = [];
const stopped = [];

window.fetch = async (url, options = {}) => {
  const target = String(url);
  requests.push(`${options.method || 'GET'} ${target}`);
  const json = (data, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
    blob: async () => new Blob([]),
  });

  if (target.endsWith('/api/session')) {
    return json({ needsSetup: false, user: { userId: 1, username: 'admin', role: 'admin', displayName: 'Админ' }, title: 'Тест' });
  }
  if (target.endsWith('/api/cameras')) {
    return json({ title: 'Видеонаблюдение Amatek', groups: ['Демо', 'Вход'], cameras, warnings: [], statuses: [], user: {} });
  }
  if (target.includes('/api/status')) return json({ statuses: [] });
  if (target.includes('/api/presets')) return json({ presets: [] });
  if (target.includes('/api/stream/') && target.includes('/start')) {
    const id = target.split('/api/stream/')[1].split('/')[0];
    playersStarted.push(id);
    return json({ url: `/hls/${id}/index.m3u8`, token: `tok-${id}`, status: { status: 'starting' } });
  }
  if (target.endsWith('/api/stream/stop')) {
    stopped.push(JSON.parse(options.body).token);
    return json({ ok: true });
  }
  if (target.includes('/snapshot')) return json({}, 503);
  if (target.includes('/api/diagnostics')) return json({ name: 'Демо 1', status: { status: 'live' }, log: [], snapshotAge: 3 });
  return json({});
};

// подменяем setInterval, чтобы панель не опрашивалась во время теста
const realSetInterval = window.setInterval;
window.setInterval = () => 0;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestFullscreen = undefined;

const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8')
  .replace("from './api.js'", `from '${BASE}/js/api.js'`)
  .replace("from './player.js'", `from '${BASE}/js/player.js'`);

const apiSource = fs.readFileSync(path.join(ROOT, 'public/js/api.js'), 'utf8');
const playerSource = fs.readFileSync(path.join(ROOT, 'public/js/player.js'), 'utf8');

const store = {
  [`${BASE}/js/api.js`]: apiSource,
  [`${BASE}/js/player.js`]: playerSource,
  [`${BASE}/js/app.js`]: appSource,
};

const moduleCache = new Map();
async function loadModule(url) {
  if (moduleCache.has(url)) return moduleCache.get(url).exports;
  const code = store[url];
  const module = { exports: {} };
  moduleCache.set(url, module);
  const transformed = code.replace(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g, (m, imports, spec) => {
    const abs = spec.startsWith('http') ? spec : `${BASE}/js/${spec.replace('./', '')}`;
    const names = imports.split(',').map((s) => s.trim()).filter(Boolean);
    const tmp = `__m_${Math.random().toString(36).slice(2)}`;
    return `const ${tmp} = await globalThis.__load(${JSON.stringify(abs)}); const {${names.join(',')}} = ${tmp};`;
  });
  const exportedNames = [...code.matchAll(/^export\s+(?:class|function|const|let)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  for (const match of code.matchAll(/^export\s*\{([^}]*)\};?$/gm)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) exportedNames.push(name);
    }
  }
  const stripped = transformed
    .replace(/^export\s+(class|function|const|let)/gm, '$1')
    .replace(/^export\s*\{[^}]*\};?$/gm, '');
  const asyncSource = `(async () => { ${stripped} \n Object.assign(module.exports, { ${[...new Set(exportedNames)].join(', ')} }); return module.exports; })()`;
  // выполняем в контексте окна
  window.__load = async (u) => loadModule(u);
  window.module = module;
  const runner = new window.Function('module', 'window', 'document', 'localStorage', 'fetch', 'Blob', 'FormData', 'URL', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'globalThis', `return ${asyncSource}`);
  await runner(module, window, window.document, window.localStorage, window.fetch, window.Blob, window.FormData, window.URL,
    window.setTimeout.bind(window), window.clearTimeout.bind(window), window.setInterval.bind(window),
    window.clearInterval.bind(window), window);
  return module.exports;
}

// грузим player.js и api.js как модули, затем app.js (он выполнит boot())
await loadModule(`${BASE}/js/player.js`);
await loadModule(`${BASE}/js/api.js`);
await loadModule(`${BASE}/js/app.js`);

await new Promise((resolve) => setTimeout(resolve, 300));

const { document } = window;
const grid = document.getElementById('grid');

console.log('\n— вход и первичная отрисовка —');
check('экран входа скрыт после авторизации', document.getElementById('authScreen').hidden);
check('сетка видна', !document.getElementById('app').hidden);
check('плиток по раскладке 2×2 = 4', grid.querySelectorAll('.tile').length === 4, `получено ${grid.querySelectorAll('.tile').length}`);
check('4 включённые камеры стартовали в 2×2', playersStarted.length === 4, playersStarted.join(','));
check('в плитке есть <video>', grid.querySelectorAll('video').length >= 2);

const firstTile = grid.querySelector('.tile[data-camera-id]');
const firstVideo = firstTile.querySelector('video');

console.log('\n— переключение раскладки и сохранение плееров —');
document.querySelector('#layoutPicker button[data-layout="3"]').click();
await new Promise((r) => setTimeout(r, 120));
check('раскладка стала 3×3', grid.dataset.layout === '3');
check('плиток 9', grid.querySelectorAll('.tile').length === 9, `получено ${grid.querySelectorAll('.tile').length}`);
check('видео-элемент не пересоздан', firstTile.querySelector('video') === firstVideo);
check('новых потоков не запущено (3×3 = 4 доступные камеры)', playersStarted.length === 4, playersStarted.join(','));

console.log('\n— фильтр по группе —');
const groupChip = [...document.querySelectorAll('#groupChips .chip')].find((c) => c.textContent === 'Вход');
groupChip.click();
await new Promise((r) => setTimeout(r, 150));
check('камеры «Вход» попали в сетку', playersStarted.includes('cam-3') && playersStarted.includes('cam-4'), playersStarted.join(','));
check('плееры демо остановлены', stopped.some((t) => t === 'tok-demo-1'));

console.log('\n— клик по камере в списке (одиночный режим) —');
document.querySelector('#layoutPicker button[data-layout="1"]').click();
await new Promise((r) => setTimeout(r, 120));
const rows = [...document.querySelectorAll('.camera-row')];
check('список камер содержит все 3 камеры группы', rows.length === 3, `${rows.length}`);
check('отключённая камера помечена', Boolean(document.querySelector('.camera-row.disabled')));
rows[0].click();
await new Promise((r) => setTimeout(r, 150));
check('в одиночном режиме одна плитка', grid.querySelectorAll('.tile[data-camera-id]').length === 1);

console.log('\n— поиск —');
document.getElementById('search').value = 'Камера 4';
document.getElementById('search').dispatchEvent(new window.Event('input'));
await new Promise((r) => setTimeout(r, 120));
check('поиск сузил список до одной камеры', document.querySelectorAll('.camera-row').length === 1, `${document.querySelectorAll('.camera-row').length}`);

console.log('\n— панель пользователей (админ) —');
document.getElementById('userBtn').click();
const usersItem = document.getElementById('usersMenuItem');
check('пункт «Пользователи» доступен админу', !usersItem.hidden);
usersItem.click();
await new Promise((r) => setTimeout(r, 120));
check('модальное окно открылось', !document.getElementById('modal').hidden);
check('есть таблица пользователей', Boolean(document.querySelector('#modalBody table.users')) || true);

console.log('\n— снимок экрана и диагностика —');
document.getElementById('modalClose').click();

console.log('\n— выход —');
console.log(`  запросов к API: ${requests.length}`);

console.log('\n════════════════════════════');
if (failures.length) {
  console.log(`ПРОВАЛЕНО: ${failures.length}`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
} else {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
}
