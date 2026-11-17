import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FFMPEG, ROOT } from './paths.js';

export const CONFIG_FILE = process.env.CAMERAS_CONFIG
  ? path.resolve(process.env.CAMERAS_CONFIG)
  : path.join(ROOT, 'config', 'cameras.json');

const VENDORS = new Set(['amatek-nvr', 'amatek-xmeye', 'generic']);

/** Шаблоны RTSP для поддерживаемых вендоров. */
export const RTSP_TEMPLATES = {
  // NVR «F-серии»: rtsp://user:pass@ip:554/00  (канал с нуля, вторым символом — поток)
  'amatek-nvr': 'rtsp://{userAuth}{host}:{port}/{channelIndex}{stream}',
  // XMEye-совместимые (AR-*, IP-камеры Amatek):
  'amatek-xmeye': 'rtsp://{host}:{port}/user={user}&password={password}&channel={channel}&stream={stream}.sdp',
  // Типовой ONVIF/generic вариант
  generic: 'rtsp://{userAuth}{host}:{port}/Streaming/Channels/{channel}{stream}',
};

const DEFAULTS = {
  transport: 'tcp',
  segmentSeconds: 2,
  maxWidth: 0, // 0 = без масштабирования
  fps: 0, // 0 = как в источнике
  audio: false,
};

function urlEncode(value) {
  return encodeURIComponent(String(value ?? ''));
}

/**
 * Собирает RTSP-ссылку. Пароль никогда не попадает в клиентские ответы —
 * только в аргументы ffmpeg.
 */
export function buildRtspUrl(camera, { stream, quality } = {}) {
  const streamIndex = stream ?? (quality === 'sub' ? 1 : camera.stream ?? 0);
  const template = camera.rtsp || RTSP_TEMPLATES[camera.vendor || 'generic'];
  const host = camera.host || '127.0.0.1';
  const port = camera.port || 554;
  const user = camera.username || '';
  const password = camera.password || '';

  return template
    .replaceAll('{host}', host)
    .replaceAll('{port}', String(port))
    // без логина «user:pass@» не подставляется, но и «@» из шаблона убирается
    .replaceAll('{userAuth}', user ? `${urlEncode(user)}:${urlEncode(password)}@` : '')
    .replaceAll('{user}', user)
    .replaceAll('{password}', password)
    .replaceAll('{channel}', String(camera.channel ?? 1))
    .replaceAll('{channelIndex}', String(Math.max(0, (camera.channel ?? 1) - 1)))
    .replaceAll('{stream}', String(streamIndex))

}

function redactRtsp(value) {
  return String(value).replace(/\/\/([^:@/]+):([^@]*)@/, '//$1:***@').replace(/password=[^&.]*/gi, 'password=***');
}

function normalizeCamera(raw, index) {
  const id = String(raw.id || `cam-${index + 1}`).trim();
  const name = String(raw.name || id).trim();
  const camera = {
    id,
    name,
    group: raw.group ? String(raw.group).trim() : 'Без группы',
    vendor: VENDORS.has(raw.vendor) ? raw.vendor : 'generic',
    host: raw.host ? String(raw.host).trim() : '',
    port: Number(raw.port) || 554,
    username: raw.username ?? '',
    password: raw.password ?? '',
    channel: Number(raw.channel) || 1,
    stream: Number.isFinite(Number(raw.stream)) ? Number(raw.stream) : 0,
    rtsp: raw.rtsp ? String(raw.rtsp).trim() : '',
    transport: raw.transport === 'udp' ? 'udp' : DEFAULTS.transport,
    audio: Boolean(raw.audio),
    maxWidth: Number.isFinite(Number(raw.maxWidth)) ? Number(raw.maxWidth) : DEFAULTS.maxWidth,
    fps: Number.isFinite(Number(raw.fps)) ? Number(raw.fps) : DEFAULTS.fps,
    enabled: raw.enabled !== false,
    demo: raw.demo ? String(raw.demo) : '',
    warm: Boolean(raw.warm),
    notes: raw.notes ? String(raw.notes) : '',
  };
  return camera;
}

export function publicCamera(camera) {
  return {
    id: camera.id,
    name: camera.name,
    group: camera.group,
    vendor: camera.vendor,
    host: camera.host,
    port: camera.port,
    username: camera.username,
    channel: camera.channel,
    stream: camera.stream,
    transport: camera.transport,
    audio: camera.audio,
    maxWidth: camera.maxWidth,
    enabled: camera.enabled,
    demo: Boolean(camera.demo),
    notes: camera.notes,
    hasPassword: Boolean(camera.password),
    rtsp: camera.demo ? '' : redactRtsp(camera.rtsp || buildRtspUrl(camera)),
  };
}

class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this.cameras = [];
    this.groups = [];
    this.server = { port: 8080, title: 'Видеонаблюдение Amatek' };
    this.defaults = { ...DEFAULTS };
    this.warnings = [];
    this.watcher = null;
  }

  load() {
    this.warnings = [];
    if (!fs.existsSync(CONFIG_FILE)) {
      this.cameras = [];
      this.groups = [];
      this.warnings.push(`Файл конфигурации не найден: ${CONFIG_FILE}`);
      return this;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (error) {
      this.warnings.push(`Ошибка чтения config/cameras.json: ${error.message}`);
      return this;
    }

    this.server = { ...this.server, ...(parsed.server || {}) };
    this.defaults = { ...DEFAULTS, ...(parsed.defaults || {}) };

    const seen = new Set();
    const cameras = [];
    (parsed.cameras || []).forEach((raw, index) => {
      const camera = normalizeCamera(raw, index);
      if (seen.has(camera.id)) {
        this.warnings.push(`Дублирующийся id камеры: ${camera.id} — запись ${index + 1} пропущена`);
        return;
      }
      if (!camera.demo && !camera.rtsp && !camera.host) {
        this.warnings.push(`Камера «${camera.name}»: не задан host или rtsp — пропущена`);
        return;
      }
      seen.add(camera.id);
      cameras.push(camera);
    });

    this.cameras = cameras;
    const declared = Array.isArray(parsed.groups) ? parsed.groups.map(String) : [];
    const fromCameras = cameras.map((camera) => camera.group);
    this.groups = [...new Set([...declared, ...fromCameras])];
    return this;
  }

  watch() {
    if (this.watcher) return;
    let timer = null;
    this.watcher = fs.watch(path.dirname(CONFIG_FILE), (event, filename) => {
      if (filename && path.basename(String(filename)) !== path.basename(CONFIG_FILE)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const before = JSON.stringify(this.cameras);
        this.load();
        if (JSON.stringify(this.cameras) !== before) {
          this.emit('change', this);
        }
      }, 300);
    });
    this.watcher.on('error', () => {});
  }

  getCamera(id) {
    return this.cameras.find((camera) => camera.id === id) || null;
  }

  summary() {
    return {
      title: this.server.title,
      groups: this.groups,
      cameras: this.cameras.map(publicCamera),
      warnings: this.warnings,
      configFile: path.relative(ROOT, CONFIG_FILE),
      ffmpegPath: FFMPEG,
    };
  }
}

export const config = new ConfigStore().load();
