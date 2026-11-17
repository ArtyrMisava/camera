import { api } from './api.js';

const Hls = window.Hls;

/**
 * Один плеер = одна плитка: запускает ffmpeg-трансляцию на сервере,
 * подключает HLS в браузере и корректно освобождает ресурсы.
 */
export class CameraPlayer {
  constructor(tile, camera, { quality = 'main', onStatus } = {}) {
    this.tile = tile;
    this.camera = camera;
    this.quality = quality;
    this.onStatus = onStatus;
    this.hls = null;
    this.token = null;
    this.destroyed = false;
    this.retryTimer = null;
    this.retries = 0;
    this.video = tile.querySelector('.tile-video');
  }

  async start() {
    this.setLoading(true);
    try {
      const { url, token, status } = await api.startStream(this.camera.id, { quality: this.quality });
      if (this.destroyed) {
        api.stopStream(token).catch(() => {});
        return;
      }
      this.token = token;
      this.onStatus?.(status);
      this.attach(url);
    } catch (error) {
      this.fail(error.message);
    }
  }

  attach(url) {
    if (!this.video) return;

    if (Hls && Hls.isSupported()) {
      this.hls?.destroy();
      const hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 6,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 4,
      });
      this.hls = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) this.scheduleRetry(data.details || 'Ошибка HLS');
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.setLoading(false);
        this.retries = 0;
        this.tile.classList.remove('error');
        this.video.play().catch(() => {});
      });
      hls.loadSource(url);
      hls.attachMedia(this.video);
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = url;
      this.video.play().catch(() => {});
      this.setLoading(false);
    } else {
      this.fail('Браузер не поддерживает HLS-воспроизведение');
    }
  }

  scheduleRetry(reason) {
    if (this.destroyed) return;
    this.setLoading(true);
    this.retries += 1;
    if (this.retries > 8) {
      this.fail(reason === 'bufferStalledError' ? 'Поток нестабилен, попробуйте дополнительный поток' : `Ошибка потока: ${reason}`);
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.restart(), Math.min(1000 * this.retries, 6000));
  }

  async restart() {
    if (this.destroyed) return;
    this.releaseServerStream();
    this.hls?.destroy();
    this.hls = null;
    this.retries = Math.max(0, this.retries);
    await this.start();
  }

  releaseServerStream() {
    const token = this.token;
    this.token = null;
    if (token) api.stopStream(token).catch(() => {});
  }

  setLoading(state) {
    this.tile.classList.toggle('loading', Boolean(state));
  }

  fail(message) {
    this.setLoading(false);
    this.tile.classList.add('error');
    const box = this.tile.querySelector('.tile-error');
    if (box) {
      box.hidden = false;
      box.textContent = message;
    }
    this.onStatus?.({ status: 'error', error: message });
  }

  async snapshot() {
    const video = this.video;
    if (video && video.videoWidth) {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      downloadCanvas(canvas, this.camera.name);
      return;
    }
    // запасной вариант — снимок, сделанный сервером
    const response = await fetch(`/api/cameras/${encodeURIComponent(this.camera.id)}/snapshot?refresh=1`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Снимок недоступен');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${safeFileName(this.camera.name)}_${stamp()}.jpg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5_000);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    this.hls?.destroy();
    this.hls = null;
    this.releaseServerStream();
  }
}

export function downloadCanvas(canvas, name) {
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/jpeg', 0.92);
  link.download = `${safeFileName(name)}_${stamp()}.jpg`;
  link.click();
}

export function safeFileName(value) {
  return String(value).trim().replace(/[^\wа-яА-ЯёЁ-]+/g, '_').slice(0, 40) || 'camera';
}

export function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
