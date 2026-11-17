// Добавляет в config/cameras.json демонстрационные камеры (синтетическая картинка),
// чтобы можно было проверить интерфейс до подключения реального оборудования.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.CAMERAS_CONFIG ? path.resolve(process.env.CAMERAS_CONFIG) : path.join(root, 'config', 'cameras.json');

const config = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : { server: { port: 8080 }, defaults: { segmentSeconds: 2 }, groups: [], cameras: [] };

config.cameras ||= [];
const demoCameras = [
  { id: 'demo-1', name: 'Демо стенд · улица', group: 'Демо', demo: true, enabled: true },
  { id: 'demo-2', name: 'Демо стенд · склад', group: 'Демо', demo: true, enabled: true },
];

for (const camera of demoCameras) {
  if (!config.cameras.some((existing) => existing.id === camera.id)) config.cameras.push(camera);
}
config.groups = [...new Set([...(config.groups || []), 'Демо'])];

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Демо-камеры добавлены в ${path.relative(root, file)}`);
