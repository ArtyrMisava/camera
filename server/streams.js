import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FFMPEG, HLS_DIR, SNAPSHOT_DIR, FONT_REGULAR } from './paths.js';
import { buildRtspUrl } from './config.js';

const IDLE_STOP_MS = 25_000; // стрим без зрителей живёт ещё 25 с (быстрое переключение не рвёт картинку)
const STARTUP_TIMEOUT_MS = 20_000;
const BACKOFF_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000];
const SNAPSHOT_INTERVAL_MS = 30_000;
const STATS_INTERVAL_MS = 15_000;

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'camera';
}

/** Вырезает учётные данные из любых строк ffmpeg — они уходят в клиент и в лог. */
export function sanitize(text) {
  return String(text)
    .replace(/rtsp:\/\/[^\s"']*/gi, (match) => match.replace(/\/\/([^:@/\s]+):([^@\s]*)@/, '//$1:***@').replace(/password=[^&.\s]*/gi, 'password=***'))
    .replace(/\/\/([^:@/\s]+):([^@\s]+)@/g, '//$1:***@');
}

function esc(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

class CameraStream extends EventEmitter {
  constructor(camera, options) {
    super();
    this.camera = camera;
    this.options = options;
    this.dir = path.join(HLS_DIR, safeName(camera.id));
    this.playlist = path.join(this.dir, 'index.m3u8');
    this.proc = null;
    this.status = 'idle'; // idle | starting | live | error | stopped
    this.error = null;
    this.attempt = 0;
    this.restartTimer = null;
    this.idleTimer = null;
    this.startupTimer = null;
    this.stats = { fps: 0, width: 0, height: 0, bitrateKbps: 0, startedAt: null };
    this.statsTimer = null;
    this.clients = 0;
    this.logTail = [];
    this.lastKnownGood = null;
  }

  get quality() {
    return this.options.quality;
  }

  get viewersNeeded() {
    return this.alwaysOn || this.clients > 0;
  }

  inputArgs() {
    if (this.camera.demo) {
      // Демо-режим: синтетическая картинка, чтобы интерфейс можно было проверить без железа
      const label = esc(this.camera.name);
      const source = this.options.quality === 'sub' ? '640x360' : '1280x720';
      return [
        '-re',
        '-f', 'lavfi',
        '-i', `testsrc2=size=${source}:rate=15,drawtext=fontfile='${FONT_REGULAR}':text='${label}':fontcolor=white:fontsize=h/14:x=(w-tw)/2:y=h/2-th/2:box=1:boxcolor=black@0.6:boxborderw=16`,
      ];
    }
    const url = buildRtspUrl(this.camera, { stream: this.options.stream });
    const args = [];
    if (this.camera.transport === 'udp') {
      args.push('-rtsp_transport', 'udp');
    } else {
      args.push('-rtsp_transport', 'tcp');
    }
    args.push(
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-allowed_media_types', 'video',
      '-rw_timeout', '10000000',
      '-i', url
    );
    return args;
  }

  outputArgs() {
    const { quality } = this.options;
    const maxWidth = quality === 'sub' ? 960 : this.camera.maxWidth || 0;
    const fps = this.camera.fps || 0;
    const gop = 2 * Math.max(1, fps || 15);

    const filters = [];
    if (maxWidth) filters.push(`scale='min(${maxWidth},iw)':-2`);
    if (fps) filters.push(`fps=${fps}`);

    const args = [];
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p');
    args.push('-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
    args.push('-b:v', quality === 'sub' ? '900k' : '2500k', '-maxrate', quality === 'sub' ? '1200k' : '3500k', '-bufsize', '1500k');
    args.push('-an');
    args.push(
      '-f', 'hls',
      '-hls_time', String(this.options.segmentSeconds),
      '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+omit_endlist+independent_segments+temp_file',
      '-hls_segment_type', 'mpegts',
      '-hls_allow_cache', '0',
      '-hls_segment_filename', path.join(this.dir, 'seg_%05d.ts'),
      this.playlist
    );
    return args;
  }

  start() {
    if (this.proc) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearIdleTimer();
    fs.mkdirSync(this.dir, { recursive: true });
    this.status = 'starting';
    this.error = null;
    this.emit('status', this);

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-nostats',
      '-y',
      ...this.inputArgs(),
      ...this.outputArgs(),
    ];

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.startedAt = Date.now();

    const onData = (chunk) => {
      const text = sanitize(chunk.toString());
      this.logTail.push(...text.split('\n').filter(Boolean).slice(-10));
      this.logTail = this.logTail.slice(-20);
      if (/(moov atom not found|Invalid data|could not find codec|Connection refused|timed out|401|403|404|Input\/output error|Server returned|method DESCRIBE failed|method OPTIONS failed|Unauthorized)/i.test(text)) {
        this.error = text.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) || this.error;
        this.emit('status', this);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    this.startupTimer = setTimeout(() => {
      if (this.status === 'starting') {
        this.error = this.error || 'Не удалось получить поток за 20 секунд (проверьте адрес, логин и пароль)';
        this.emit('status', this);
        this.kill('timeout');
      }
    }, STARTUP_TIMEOUT_MS);

    const watchPlaylist = () => {
      if (this.proc !== proc) return;
      if (fs.existsSync(this.playlist)) {
        clearTimeout(this.startupTimer);
        if (this.status !== 'live') {
          this.status = 'live';
          this.attempt = 0;
          this.stats.startedAt = Date.now();
          this.emit('status', this);
          this.collectStats();
          this.startStatsTimer();
        }
      } else if (this.status === 'starting' && Date.now() - this.startedAt > STARTUP_TIMEOUT_MS) {
        this.error = this.error || 'Поток не запустился';
        this.kill('timeout');
        return;
      }
      if (this.status !== 'live') this.retryCheck = setTimeout(watchPlaylist, 400);
    };
    this.retryCheck = setTimeout(watchPlaylist, 600);

    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      clearTimeout(this.startupTimer);
      clearTimeout(this.retryCheck);
      this.stopStatsTimer();
      if (this.stopping) {
        this.stopping = false;
        this.status = 'idle';
        this.emit('status', this);
        return;
      }
      this.status = 'error';
      if (!this.error) this.error = `ffmpeg завершился с кодом ${code}`;
      this.emit('status', this);
      if (this.viewersNeeded) this.scheduleRestart();
    });
  }

  scheduleRestart() {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.viewersNeeded) this.start();
    }, delay || 500);
  }

  async collectStats() {
    if (this.camera.demo) {
      const wide = this.options.quality !== 'sub';
      this.stats.fps = 15;
      this.stats.width = wide ? 1280 : 640;
      this.stats.height = wide ? 720 : 360;
      this.stats.bitrateKbps = wide ? 2500 : 900;
      this.emit('status', this);
      return;
    }
    const { FFPROBE } = await import('./paths.js');
    const url = buildRtspUrl(this.camera, { stream: this.options.stream });
    const args = ['-v', 'error', '-rtsp_transport', this.camera.transport === 'udp' ? 'udp' : 'tcp', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate,bit_rate', '-of', 'json', url];
    const proc = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    const killer = setTimeout(() => proc.kill('SIGKILL'), 12_000);
    proc.on('exit', () => {
      clearTimeout(killer);
      try {
        const stream = JSON.parse(out).streams?.[0];
        if (!stream) return;
        const [num, den] = String(stream.avg_frame_rate || '0/1').split('/').map(Number);
        this.stats.fps = den ? Math.round((num / den) * 10) / 10 : 0;
        this.stats.width = stream.width || 0;
        this.stats.height = stream.height || 0;
        this.stats.bitrateKbps = Math.round((Number(stream.bit_rate) || 0) / 1000);
        this.lastKnownGood = Date.now();
        this.emit('status', this);
      } catch { /* игнорируем */ }
    });
  }

  startStatsTimer() {
    this.stopStatsTimer();
    this.statsTimer = setInterval(() => {
      if (this.status === 'live') this.collectStats();
    }, STATS_INTERVAL_MS);
    this.statsTimer.unref?.();
  }

  stopStatsTimer() {
    clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  kill(reason = 'stop') {
    this.stopping = true;
    clearTimeout(this.startupTimer);
    clearTimeout(this.retryCheck);
    const proc = this.proc;
    if (!proc) {
      this.stopping = false;
      this.status = 'idle';
      return;
    }
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.proc === proc) proc.kill('SIGKILL');
    }, 2_000).unref?.();
  }

  addClient() {
    this.clients += 1;
    this.clearIdleTimer();
    if (!this.proc && !this.restartTimer) this.start();
    else if (!this.proc && this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      this.start();
    }
    return this.clients;
  }

  removeClient() {
    this.clients = Math.max(0, this.clients - 1);
    if (!this.viewersNeeded) this.scheduleIdleStop();
    return this.clients;
  }

  scheduleIdleStop() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.viewersNeeded) this.stop();
    }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  stop() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.clearIdleTimer();
    this.attempt = 0;
    this.kill('manual');
    this.status = 'idle';
    this.emit('status', this);
  }

  toJSON() {
    return {
      id: this.camera.id,
      name: this.camera.name,
      quality: this.options.quality,
      status: this.status,
      error: this.error,
      clients: this.clients,
      fps: this.stats.fps,
      resolution: this.stats.width ? `${this.stats.width}×${this.stats.height}` : '',
      bitrateKbps: this.stats.bitrateKbps,
      uptimeSeconds: this.status === 'live' && this.stats.startedAt ? Math.round((Date.now() - this.stats.startedAt) / 1000) : 0,
    };
  }
}

export class StreamManager extends EventEmitter {
  constructor(cameraStore) {
    super();
    this.cameraStore = cameraStore;
    this.streams = new Map(); // key = cameraId:quality
    this.snapshotTimers = new Map();
    this.alwaysOnCameras = new Set(
      cameraStore.cameras.filter((camera) => camera.enabled && camera.warm).map((camera) => camera.id)
    );
  }

  key(cameraId, quality) {
    return `${cameraId}:${quality}`;
  }

  getOrCreate(camera, quality = 'main', stream) {
    const key = this.key(camera.id, quality);
    let entry = this.streams.get(key);
    if (entry) return entry;
    entry = new CameraStream(camera, {
      quality,
      stream: stream ?? (quality === 'sub' ? 1 : camera.stream),
      segmentSeconds: this.cameraStore.defaults.segmentSeconds,
    });
    entry.alwaysOn = this.alwaysOnCameras.has(camera.id);
    entry.on('status', () => this.emit('status', entry.toJSON()));
    this.streams.set(key, entry);
    return entry;
  }

  listStatuses() {
    return [...this.streams.values()].map((entry) => entry.toJSON());
  }

  stopAll() {
    for (const entry of this.streams.values()) entry.stop();
    for (const timer of this.snapshotTimers.values()) clearInterval(timer);
    this.snapshotTimers.clear();
  }

  stopCamera(cameraId) {
    for (const entry of this.streams.values()) {
      if (entry.camera.id === cameraId) entry.stop();
    }
    this.alwaysOnCameras.delete(cameraId);
    const timer = this.snapshotTimers.get(cameraId);
    if (timer) clearInterval(timer);
    this.snapshotTimers.delete(cameraId);
  }

  snapshotPath(cameraId) {
    return path.join(SNAPSHOT_DIR, `${safeName(cameraId)}.jpg`);
  }

  snapshotAge(cameraId) {
    try {
      const stat = fs.statSync(this.snapshotPath(cameraId));
      return { mtimeMs: stat.mtimeMs, ageSeconds: Math.round((Date.now() - stat.mtimeMs) / 1000) };
    } catch {
      return { mtimeMs: 0, ageSeconds: null };
    }
  }

  async snapshot(camera, { force = false } = {}) {
    const file = this.snapshotPath(camera.id);
    const existing = this.snapshotAge(camera.id);
    if (!force && existing.ageSeconds !== null && existing.ageSeconds < 5) return file;

    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (camera.demo) {
      args.push('-f', 'lavfi', '-i', `color=c=#0f172a:s=1280x720`, '-frames:v', '1');
    } else {
      args.push('-rtsp_transport', 'tcp', '-rw_timeout', '8000000', '-i', buildRtspUrl(camera, { stream: camera.stream }));
    }
    const drawtext = [
      `fontfile='${FONT_REGULAR}'`,
      `text='${esc(camera.name)}'`,
      `fontcolor=white@0.9`,
      `fontsize=h/24`,
      `box=1`,
      `boxcolor=black@0.55`,
      `boxborderw=8`,
      `x=12`,
      `y=h-th-12`,
    ].join(':');
    const filters = [`drawtext=${drawtext}`];
    if (camera.maxWidth) filters.unshift(`scale='min(${camera.maxWidth},iw)':-2`);
    args.push('-vf', filters.join(','), '-frames:v', '1', '-q:v', '4', file);

    return new Promise((resolve) => {
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0 && fs.existsSync(file) ? file : null);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  startSnapshotLoop(cameras) {
    for (const camera of cameras) {
      if (this.snapshotTimers.has(camera.id)) continue;
      const run = () => this.snapshot(camera).catch(() => {});
      run();
      const timer = setInterval(run, SNAPSHOT_INTERVAL_MS);
      timer.unref?.();
      this.snapshotTimers.set(camera.id, timer);
    }
  }
}

export { CameraStream };
