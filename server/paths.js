import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ROOT = root;
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
export const HLS_DIR = path.join(DATA_DIR, 'hls');
export const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
export const DB_FILE = path.join(DATA_DIR, 'app.db');
export const PUBLIC_DIR = path.join(root, 'public');
export const FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

export function ensureDirs() {
  for (const dir of [DATA_DIR, HLS_DIR, SNAPSHOT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * ffmpeg/ffprobe: сначала пробуем системные бинарники (быстрее и свежее),
 * затем — статические сборки из npm.
 */
function resolveBinary(envVar, npmPackage, npmRelPath, systemName) {
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) return process.env[envVar];

  const candidates = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, systemName));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    return require(npmPackage).path;
  } catch {
    const fallback = path.join(root, 'node_modules', npmRelPath);
    return fs.existsSync(fallback) ? fallback : systemName;
  }
}

export const FFMPEG = resolveBinary(
  'FFMPEG_PATH',
  '@ffmpeg-installer/ffmpeg',
  '@ffmpeg-installer/linux-x64/ffmpeg',
  'ffmpeg'
);

export const FFPROBE = resolveBinary(
  'FFPROBE_PATH',
  '@ffprobe-installer/ffprobe',
  '@ffprobe-installer/linux-x64/ffprobe',
  'ffprobe'
);
