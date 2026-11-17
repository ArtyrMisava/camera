// Копирует браузерную сборку hls.js в public/vendor, чтобы работало без CDN и сборщика.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(path.dirname(require.resolve('hls.js/package.json')), 'dist', 'hls.min.js');
const target = path.join(root, 'public', 'vendor', 'hls.min.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`hls.js → ${path.relative(root, target)}`);
