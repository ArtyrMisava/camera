import { api } from './api.js';
import { CameraPlayer, safeFileName, stamp } from './player.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  user: null,
  needsSetup: false,
  cameras: [],
  groups: [],
  warnings: [],
  presets: [],
  layout: Number(localStorage.getItem('layout') || 2),
  activeGroup: 'all',
  search: '',
  soloCameraId: null,
  visibleIds: [],
  players: new Map(), // cameraId -> CameraPlayer
  statuses: new Map(), // `${id}:${quality}` -> статус
  health: null,
};

// ============================================================ вход

const authScreen = $('#authScreen');
const app = $('#app');

async function boot() {
  const session = await api.session().catch(() => ({ needsSetup: false, user: null }));
  state.needsSetup = session.needsSetup;
  if (session.title) $('#appTitle').textContent = session.title;

  if (!session.user) {
    showAuth();
    return;
  }
  state.user = session.user;
  await enterApp();
}

function showAuth() {
  authScreen.hidden = false;
  app.hidden = true;

  const setupMode = state.needsSetup;
  $('#authTitle').textContent = setupMode ? 'Первая настройка' : 'Вход в систему';
  $('#authSubtitle').textContent = setupMode
    ? 'Создайте учётную запись администратора'
    : 'Видеонаблюдение Amatek';
  $('#authDisplayWrap').hidden = !setupMode;
  $('#authConfirmWrap').hidden = !setupMode;
  $('#authSubmit').textContent = setupMode ? 'Создать администратора' : 'Войти';
  $('#authPassword').autocomplete = setupMode ? 'new-password' : 'current-password';
  $('#authHint').textContent = setupMode
    ? 'Пароль минимум 8 символов. Эта учётная запись получит полные права.'
    : '';
  setTimeout(() => $('#authUsername').focus(), 50);
}

$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('#authError');
  errorBox.hidden = true;
  const username = $('#authUsername').value.trim();
  const password = $('#authPassword').value;

  if (state.needsSetup) {
    if (password !== $('#authConfirm').value) {
      errorBox.textContent = 'Пароли не совпадают';
      errorBox.hidden = false;
      return;
    }
    try {
      await api.setup({ username, displayName: $('#authDisplayName').value.trim() || username, password });
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      return;
    }
  } else {
    try {
      await api.login({ username, password });
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      return;
    }
  }

  const session = await api.session();
  state.user = session.user;
  state.needsSetup = false;
  await enterApp();
});

// ============================================================ приложение

async function enterApp() {
  authScreen.hidden = true;
  app.hidden = false;

  const name = state.user.displayName || state.user.username;
  $('#userName').textContent = name;
  $('#userAvatar').textContent = name.slice(0, 1).toUpperCase();
  $('#usersMenuItem').hidden = state.user.role !== 'admin';
  setLayout(state.layout, { silent: true });

  await loadCameras({ initial: true });
  loadPresets();
}

async function loadCameras({ initial = false } = {}) {
  try {
    const data = await api.cameras();
    state.cameras = data.cameras;
    state.groups = data.groups;
    state.warnings = data.warnings || [];
    state.statuses = new Map((data.statuses || []).map((item) => [`${item.id}:${item.quality}`, item]));
    if (data.title) $('#appTitle').textContent = data.title;
    $('#appSubtitle').textContent = `${state.cameras.length} камер · ${state.user.role === 'admin' ? 'администратор' : 'наблюдатель'}`;
    renderNotice();
    renderGroups();
    renderCameraList();
    applyLayout(initial ? undefined : state.visibleIds.filter(Boolean));
  } catch (error) {
    if (error.status === 401) {
      authScreen.hidden = false;
      app.hidden = true;
      showAuth();
      return;
    }
    toast(error.message, 'error');
  }
}

function renderNotice() {
  const notice = $('#notice');
  const text = state.warnings.length
    ? `Предупреждения конфигурации: ${state.warnings.join('; ')}`
    : '';
  notice.hidden = !text;
  notice.textContent = text;
}

const thumbCache = new Map();

function thumbUrl(camera) {
  const bucket = Math.floor(Date.now() / 30_000);
  const cached = thumbCache.get(camera.id);
  if (cached && cached.bucket === bucket) return cached.url;
  const url = `/api/cameras/${encodeURIComponent(camera.id)}/snapshot?v=${bucket}`;
  thumbCache.set(camera.id, { bucket, url });
  return url;
}

function renderGroups() {
  const chips = $('#groupChips');
  chips.innerHTML = '';
  const make = (label, value) => {
    const button = document.createElement('button');
    button.className = `chip${state.activeGroup === value ? ' active' : ''}`;
    button.textContent = label;
    button.addEventListener('click', () => {
      state.activeGroup = value;
      renderGroups();
      renderCameraList();
      applyLayout();
    });
    chips.append(button);
  };
  make('Все камеры', 'all');
  for (const group of state.groups) make(group, group);
}

function filteredCameras() {
  const search = state.search.trim().toLowerCase();
  return state.cameras.filter((camera) => {
    if (state.activeGroup !== 'all' && camera.group !== state.activeGroup) return false;
    if (!search) return true;
    return `${camera.name} ${camera.group} ${camera.host}`.toLowerCase().includes(search);
  });
}

function renderCameraList() {
  const list = $('#cameraList');
  list.innerHTML = '';
  const cameras = filteredCameras();
  $('#cameraCount').textContent = String(cameras.length);

  for (const camera of cameras) {
    const row = document.createElement('button');
    row.className = `camera-row${state.visibleIds.includes(camera.id) ? ' active' : ''}${camera.enabled ? '' : ' disabled'}`;
    row.type = 'button';
    const status = state.statuses.get(`${camera.id}:main`);
    const dotClass = !camera.enabled ? '' : status?.status === 'live' ? 'live' : status?.status === 'error' ? 'err' : 'warn';

    row.innerHTML = `
      <img class="camera-thumb" alt="" src="${thumbUrl(camera)}" loading="lazy" />
      <span class="camera-meta">
        <span class="name">${escapeHtml(camera.name)}</span>
        <span class="sub">${escapeHtml(camera.group)} · ${camera.enabled ? (camera.demo ? 'демо' : escapeHtml(camera.host || 'RTSP')) : 'отключена'}</span>
      </span>
      <span class="dot ${dotClass}"></span>`;
    row.querySelector('img').addEventListener('error', (event) => {
      event.target.style.visibility = 'hidden';
    });
    row.addEventListener('click', () => {
      toggleCameraInGrid(camera.id);
    });
    list.append(row);
  }
}

function renderPresets() {
  const box = $('#presetsList');
  box.innerHTML = '';
  if (!state.presets.length) {
    box.innerHTML = '<p class="muted" style="margin:0;font-size:12px">Пока нет сохранённых наборов</p>';
    return;
  }
  for (const preset of state.presets) {
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <button class="apply" type="button">
        <span class="title">${escapeHtml(preset.name)}</span>
        <span class="sub">${preset.cameraIds.length} камер</span>
      </button>
      ${state.user?.role === 'admin' ? '<button class="del" type="button" title="Удалить">&times;</button>' : ''}`;
    row.querySelector('.apply').addEventListener('click', () => {
      state.soloCameraId = null;
      state.activeGroup = 'all';
      state.search = '';
      $('#search').value = '';
      setLayout(sideForCount(preset.cameraIds.length), { silent: true });
      applyLayout(preset.cameraIds);
      renderGroups();
    });
    row.querySelector('.del')?.addEventListener('click', async () => {
      await api.deletePreset(preset.id).catch((error) => toast(error.message, 'error'));
      loadPresets();
    });
    box.append(row);
  }
}

async function loadPresets() {
  try {
    const data = await api.presets();
    state.presets = data.presets;
    renderPresets();
  } catch {
    /* пресеты не критичны */
  }
}

// ============================================================ раскладка

function sideForCount(count) {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

function slotsForLayout() {
  return state.layout * state.layout;
}

function setLayout(layout, { silent = false } = {}) {
  state.layout = Math.min(4, Math.max(1, Number(layout) || 1));
  localStorage.setItem('layout', String(state.layout));
  $('#grid').dataset.layout = String(state.layout);
  $$('#layoutPicker button').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.layout) === state.layout);
  });
  if (!silent) applyLayout();
}

function candidatesForGrid() {
  const cameras = filteredCameras().filter((camera) => camera.enabled);
  if (state.soloCameraId) {
    const solo = state.cameras.find((camera) => camera.id === state.soloCameraId);
    return solo ? [solo] : cameras;
  }
  return cameras;
}

function toggleCameraInGrid(cameraId) {
  const camera = state.cameras.find((item) => item.id === cameraId);
  if (camera && !camera.enabled) {
    toast(`«${camera.name}» отключена в config/cameras.json`, 'error');
    return;
  }
  if (state.soloCameraId === cameraId) {
    // повторный клик по «одиночной» камере возвращает сетку
    state.soloCameraId = null;
    state.pinnedSelection = false;
    setLayout(state.layout, { silent: true });
    applyLayout();
    return;
  }
  if (state.layout === 1) {
    state.soloCameraId = cameraId;
    state.pinnedSelection = false;
    applyLayout();
    return;
  }
  // добавляем камеру в набор, вытесняя самую старую из переполнения
  const current = [...state.visibleIds];
  const index = current.indexOf(cameraId);
  if (index >= 0) current.splice(index, 1);
  else current.push(cameraId);
  state.visibleIds = current.slice(-slotsForLayout());
  state.pinnedSelection = true;
  applyLayout();
}

async function applyLayout(explicitIds) {
  const grid = $('#grid');
  const slots = slotsForLayout();
  let cameras;

  if (explicitIds) {
    state.pinnedSelection = explicitIds.length > 0;
    state.soloCameraId = explicitIds.length === 1 ? explicitIds[0] : null;
    cameras = explicitIds.map((id) => state.cameras.find((camera) => camera.id === id)).filter(Boolean).slice(0, slots);
    state.visibleIds = cameras.map((camera) => camera.id);
  } else {
    cameras = candidatesForGrid();
    if (state.soloCameraId) {
      state.visibleIds = cameras.map((camera) => camera.id);
    } else if (state.pinnedSelection) {
      const pinned = state.visibleIds
        .map((id) => state.cameras.find((camera) => camera.id === id))
        .filter(Boolean);
      const allowed = new Set(cameras.map((camera) => camera.id));
      cameras = pinned.filter((camera) => allowed.has(camera.id)).slice(0, slots);
      if (!cameras.length) state.pinnedSelection = false;
      state.visibleIds = cameras.map((camera) => camera.id);
    }
    if (!state.pinnedSelection) {
      cameras = cameras.slice(0, slots);
      state.visibleIds = cameras.map((camera) => camera.id);
    }
  }

  $('#emptyState').hidden = state.cameras.length > 0;
  renderCameraList();

  // останавливаем плееры, которых больше нет на экране
  const wanted = new Set(cameras.map((camera) => camera.id));
  for (const [id, player] of state.players) {
    if (!wanted.has(id)) {
      player.destroy();
      state.players.delete(id);
    }
  }

  const template = $('#tileTemplate');
  const existing = new Map(
    $$('.tile[data-camera-id]', grid).map((tile) => [tile.dataset.cameraId, tile])
  );
  const orderedTiles = [];

  for (const camera of cameras) {
    let tile = existing.get(camera.id);
    if (!tile) {
      tile = template.content.firstElementChild.cloneNode(true);
      tile.dataset.cameraId = camera.id;
      tile.querySelector('.tile-name').textContent = camera.name;
      tile.querySelector('.tile-poster').style.backgroundImage = `url("${thumbUrl(camera)}")`;
      wireTile(tile, camera);
      const player = new CameraPlayer(tile, camera, {
        quality: localStorage.getItem(`quality:${camera.id}`) || 'main',
        onStatus: (status) => updateBadge(tile, status),
      });
      state.players.set(camera.id, player);
      player.start();
    }
    orderedTiles.push(tile);
  }

  // переставляем плитки без пересоздания плееров:
  // replaceChildren() вставил бы узлы заново и сбросил бы <video>
  syncTiles(grid, orderedTiles);
  fillEmptySlots(grid, slots - orderedTiles.length);
  updateHealth();
}

function syncTiles(grid, tiles) {
  const wanted = new Set(tiles);
  for (const child of [...grid.children]) {
    if (!wanted.has(child)) child.remove();
  }
  tiles.forEach((tile, index) => {
    const current = grid.children[index];
    if (current === tile) return;
    grid.insertBefore(tile, current || null);
  });
}

function fillEmptySlots(grid, count) {
  for (let i = 0; i < count; i += 1) {
    const blank = document.createElement('article');
    blank.className = 'tile';
    blank.innerHTML = '<div class="tile-overlay"><span class="tile-name muted">Свободный слот</span></div>';
    grid.append(blank);
  }
}

function wireTile(tile, camera) {
  $$('.tile-actions button', tile).forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const action = button.dataset.act;
      const player = state.players.get(camera.id);

      if (action === 'solo') {
        state.soloCameraId = camera.id;
        setLayout(1, { silent: false });
      } else if (action === 'fullscreen') {
        if (document.fullscreenElement) document.exitFullscreen();
        else tile.requestFullscreen?.();
      } else if (action === 'quality') {
        if (!player) return;
        const next = player.quality === 'main' ? 'sub' : 'main';
        localStorage.setItem(`quality:${camera.id}`, next);
        button.textContent = next === 'sub' ? 'sub' : 'main';
        player.quality = next;
        await player.restart();
        toast(`${camera.name}: ${next === 'sub' ? 'дополнительный поток' : 'основной поток'}`, 'ok');
      } else if (action === 'snapshot') {
        try {
          await player?.snapshot();
        } catch (error) {
          toast(error.message, 'error');
        }
      } else if (action === 'diag') {
        openDiagnostics(camera.id);
      }
    });
  });

  // двойной клик — развернуть камеру
  tile.addEventListener('dblclick', () => {
    state.soloCameraId = camera.id;
    setLayout(1);
  });

  const quality = localStorage.getItem(`quality:${camera.id}`);
  if (quality === 'sub') tile.querySelector('[data-act="quality"]').textContent = 'main';
  else tile.querySelector('[data-act="quality"]').textContent = 'sub';
}

function updateBadge(tile, status) {
  const badge = tile.querySelector('.tile-badge');
  if (!badge) return;
  if (!status) {
    badge.textContent = '';
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.classList.toggle('err', status.status === 'error');
  const map = { live: 'LIVE', starting: 'запуск…', error: 'нет связи', idle: 'ожидание' };
  badge.textContent = map[status.status] || status.status;
  if (status.status === 'live') tile.classList.remove('loading');
}

$('#layoutPicker').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-layout]');
  if (!button) return;
  state.soloCameraId = null;
  state.pinnedSelection = false;
  setLayout(Number(button.dataset.layout));
});

$('#search').addEventListener('input', (event) => {
  state.search = event.target.value;
  state.pinnedSelection = false;
  renderCameraList();
  applyLayout();
});

$('#sidebarToggle').addEventListener('click', () => {
  const sidebar = $('#sidebar');
  if (window.matchMedia('(max-width: 980px)').matches) sidebar.classList.toggle('open');
  else sidebar.classList.toggle('hidden');
});

// ============================================================ пользовательское меню

$('#userBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  $('#userDropdown').hidden = !$('#userDropdown').hidden;
});

document.addEventListener('click', () => {
  $('#userDropdown').hidden = true;
});

$('#userDropdown').addEventListener('click', (event) => {
  const action = event.target.closest('button')?.dataset.action;
  if (!action) return;
  $('#userDropdown').hidden = true;
  if (action === 'logout') {
    api.logout().finally(() => location.reload());
  } else if (action === 'profile') {
    openPasswordModal();
  } else if (action === 'users') {
    openUsersModal();
  } else if (action === 'diagnostics') {
    openDiagnostics();
  }
});

$('#diagnosticsLink').addEventListener('click', () => openDiagnostics());
$('#presetBtn').addEventListener('click', openPresetModal);

// ============================================================ состояние связи

function updateHealth() {
  const statuses = [...state.statuses.values()];
  const live = statuses.filter((item) => item.status === 'live').length;
  const errors = statuses.filter((item) => item.status === 'error').length;
  const dot = $('#healthDot');
  dot.className = 'dot';
  if (errors) {
    dot.classList.add('err');
    $('#healthText').textContent = `Проблемы с ${errors} потоком(и)`;
  } else if (live) {
    dot.classList.add('ok');
    $('#healthText').textContent = `${live} поток(ов) активно`;
  } else {
    $('#healthText').textContent = 'Потоки запускаются по запросу';
  }
}

async function pollStatuses() {
  if (app.hidden) return;
  try {
    const data = await api.status();
    state.statuses = new Map(data.statuses.map((item) => [`${item.id}:${item.quality}`, item]));
    for (const tile of $$('.tile')) {
      const id = tile.dataset.cameraId;
      if (!id) continue;
      const quality = state.players.get(id)?.quality || 'main';
      const status = state.statuses.get(`${id}:${quality}`);
      if (status) updateBadge(tile, status);
    }
    updateHealth();
    if (modal.hidden) renderCameraList();
  } catch (error) {
    if (error.status === 401) location.reload();
  }
}

setInterval(pollStatuses, 5_000);

// ============================================================ модальные окна

const modal = $('#modal');
$('#modalClose').addEventListener('click', closeModal);
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

function openModal(title, bodyNode) {
  $('#modalTitle').textContent = title;
  $('#modalBody').replaceChildren(bodyNode);
  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
  $('#modalBody').replaceChildren();
}

function openPasswordModal() {
  const form = document.createElement('form');
  form.className = 'modal-body-inner';
  form.innerHTML = `
    <label class="field"><span>Текущий пароль</span><input name="current" type="password" required autocomplete="current-password" /></label>
    <label class="field"><span>Новый пароль</span><input name="next" type="password" minlength="8" required autocomplete="new-password" /></label>
    <label class="field"><span>Повторите новый пароль</span><input name="confirm" type="password" minlength="8" required autocomplete="new-password" /></label>
    <div class="actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>`;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    if (data.get('next') !== data.get('confirm')) {
      toast('Пароли не совпадают', 'error');
      return;
    }
    try {
      await api.changePassword({ currentPassword: data.get('current'), newPassword: data.get('next') });
      closeModal();
      toast('Пароль обновлён', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  openModal('Смена пароля', form);
}

function openPresetModal() {
  const name = prompt('Название набора', `${state.activeGroup === 'all' ? 'Все камеры' : state.activeGroup} — ${state.visibleIds.length}`);
  if (!name) return;
  api
    .savePreset({ name, layout: String(state.layout), cameraIds: state.visibleIds })
    .then(() => {
      loadPresets();
      toast('Пресет сохранён', 'ok');
    })
    .catch((error) => toast(error.message, 'error'));
}

async function openDiagnostics(cameraId) {
  if (cameraId) {
    const camera = state.cameras.find((item) => item.id === cameraId);
    const box = document.createElement('div');
    box.innerHTML = `<p class="muted" style="margin:0">Загрузка…</p>`;
    openModal(`Диагностика · ${camera?.name || cameraId}`, box);

    const render = async (quality = 'main') => {
      try {
        const data = await api.diagnostics(cameraId, quality);
        box.innerHTML = `
          <dl class="kv">
            <dt>Камера</dt><dd>${escapeHtml(data.name)}</dd>
            <dt>Статус потока</dt><dd>${escapeHtml(data.status?.status || 'не запущен')}</dd>
            <dt>Разрешение / FPS</dt><dd>${escapeHtml(data.status?.resolution || '—')} · ${data.status?.fps || 0} fps</dd>
            <dt>Битрейт</dt><dd>${data.status?.bitrateKbps ? `${data.status.bitrateKbps} кбит/с` : '—'}</dd>
            <dt>Зрителей</dt><dd>${data.status?.clients ?? 0}</dd>
            <dt>Последний снимок</dt><dd>${data.snapshotAge === null ? 'нет' : `${data.snapshotAge} с назад`}</dd>
          </dl>
          ${data.status?.error ? `<div class="notice">${escapeHtml(data.status.error)}</div>` : ''}
          <pre class="log">${escapeHtml((data.log || []).join('\n') || 'Лог пуст')}</pre>
          <div class="actions">
            <button class="btn btn-sm" data-quality="main">Перезапустить (основной)</button>
            <button class="btn btn-sm" data-quality="sub">Перезапустить (доп.)</button>
          </div>`;
        $$('button[data-quality]', box).forEach((button) => {
          button.addEventListener('click', async () => {
            const player = state.players.get(cameraId);
            if (player) {
              player.quality = button.dataset.quality;
              await player.restart();
            }
            render(button.dataset.quality);
          });
        });
      } catch (error) {
        box.innerHTML = `<div class="notice">${escapeHtml(error.message)}</div>`;
      }
    };
    render();
    return;
  }

  // Общая диагностика
  const box = document.createElement('div');
  openModal('Диагностика системы', box);
  const statuses = [...state.statuses.values()];
  box.innerHTML = `
    <dl class="kv">
      <dt>Камер в конфигурации</dt><dd>${state.cameras.length}</dd>
      <dt>Демо-камер</dt><dd>${state.cameras.filter((camera) => camera.demo).length}</dd>
      <dt>Активных потоков</dt><dd>${statuses.filter((item) => item.status === 'live').length}</dd>
      <dt>Потоков с ошибкой</dt><dd>${statuses.filter((item) => item.status === 'error').length}</dd>
      <dt>Активных плееров</dt><dd>${state.players.size}</dd>
    </dl>
    ${state.warnings.length ? `<div class="notice">${escapeHtml(state.warnings.join('; '))}</div>` : ''}
    <table class="users">
      <thead><tr><th>Камера</th><th>Поток</th><th>Статус</th><th>FPS</th><th>Битрейт</th></tr></thead>
      <tbody>
        ${statuses.map((item) => `
          <tr>
            <td>${escapeHtml(item.name)}</td>
            <td>${item.quality === 'sub' ? 'доп.' : 'осн.'}</td>
            <td>${escapeHtml(item.status)}</td>
            <td>${item.fps || 0}</td>
            <td>${item.bitrateKbps ? `${item.bitrateKbps} кбит/с` : '—'}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">Потоки ещё не запускались</td></tr>'}
      </tbody>
    </table>
    <p class="muted" style="margin:0;font-size:12px">Потоки запускаются только когда камера открыта в сетке, и останавливаются через 25 секунд без зрителей — это экономит CPU.</p>`;
}

async function openUsersModal() {
  const box = document.createElement('div');
  openModal('Пользователи', box);

  const render = async () => {
    try {
      const data = await api.users();
      box.innerHTML = `
        <table class="users">
          <thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th></th></tr></thead>
          <tbody>
            ${data.users.map((user) => `
              <tr>
                <td>${escapeHtml(user.username)}</td>
                <td>${escapeHtml(user.display_name)}</td>
                <td>${user.role === 'admin' ? 'администратор' : 'наблюдатель'}</td>
                <td style="text-align:right;white-space:nowrap">
                  <button class="btn btn-sm" data-reset="${user.id}">Пароль</button>
                  ${user.id === state.user.userId ? '' : `<button class="btn btn-sm btn-danger" data-del="${user.id}">Удалить</button>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
        <form class="row-2" id="newUserForm">
          <label class="field"><span>Логин</span><input name="username" required minlength="3" /></label>
          <label class="field"><span>Имя</span><input name="displayName" /></label>
          <label class="field"><span>Пароль</span><input name="password" type="password" required minlength="8" /></label>
          <label class="field"><span>Роль</span>
            <select name="role"><option value="viewer">Наблюдатель</option><option value="admin">Администратор</option></select>
          </label>
          <div class="actions" style="grid-column:1/-1"><button class="btn btn-primary" type="submit">Добавить пользователя</button></div>
        </form>`;

      $('#newUserForm', box).addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const payload = Object.fromEntries(new FormData(form));
        try {
          await api.createUser(payload);
          toast('Пользователь добавлен', 'ok');
          render();
        } catch (error) {
          toast(error.message, 'error');
        }
      });

      $$('[data-del]', box).forEach((button) => {
        button.addEventListener('click', async () => {
          if (!confirm('Удалить пользователя?')) return;
          try {
            await api.deleteUser(Number(button.dataset.del));
            render();
          } catch (error) {
            toast(error.message, 'error');
          }
        });
      });

      $$('[data-reset]', box).forEach((button) => {
        button.addEventListener('click', async () => {
          const password = prompt('Новый пароль (минимум 8 символов)');
          if (!password) return;
          try {
            await api.setUserPassword(Number(button.dataset.reset), password);
            toast('Пароль изменён', 'ok');
          } catch (error) {
            toast(error.message, 'error');
          }
        });
      });
    } catch (error) {
      box.innerHTML = `<div class="notice">${escapeHtml(error.message)}</div>`;
    }
  };

  render();
}

// ============================================================ утилиты

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 4_000);
}

window.addEventListener('beforeunload', () => {
  for (const player of state.players.values()) player.destroy();
});

boot();
