// Проверка формирования RTSP-ссылок под разные линейки Amatek.
import assert from 'node:assert/strict';
import { buildRtspUrl } from '../server/config.js';

const cases = [
  {
    title: 'NVR F-серии, канал 1, основной поток',
    camera: { vendor: 'amatek-nvr', host: '192.168.1.88', port: 554, username: 'admin', password: '12345', channel: 1, stream: 0 },
    expected: 'rtsp://admin:12345@192.168.1.88:554/00',
  },
  {
    title: 'NVR F-серии, канал 3, доп. поток',
    camera: { vendor: 'amatek-nvr', host: '192.168.1.88', port: 554, username: 'admin', password: '12345', channel: 3, stream: 1 },
    expected: 'rtsp://admin:12345@192.168.1.88:554/21',
  },
  {
    title: 'NVR F-серии, 13-й канал',
    camera: { vendor: 'amatek-nvr', host: '10.0.0.5', port: 554, username: 'admin', password: 'p@ss', channel: 13, stream: 0 },
    expected: 'rtsp://admin:p%40ss@10.0.0.5:554/120',
  },
  {
    title: 'XMEye (IP-камера Amatek), канал 1, основной',
    camera: { vendor: 'amatek-xmeye', host: '192.168.1.10', port: 554, username: 'admin', password: '12345', channel: 1, stream: 0 },
    expected: 'rtsp://192.168.1.10:554/user=admin&password=12345&channel=1&stream=0.sdp',
  },
  {
    title: 'XMEye, регистратор AR-серии, канал 2',
    camera: { vendor: 'amatek-xmeye', host: '192.168.0.1', port: 554, username: 'user', password: 'pass', channel: 2, stream: 0 },
    expected: 'rtsp://192.168.0.1:554/user=user&password=pass&channel=2&stream=0.sdp',
  },
  {
    title: 'ONVIF/generic, канал 1, основной',
    camera: { vendor: 'generic', host: '192.168.1.20', port: 554, username: 'admin', password: 'x', channel: 1, stream: 0 },
    expected: 'rtsp://admin:x@192.168.1.20:554/Streaming/Channels/10',
  },
  {
    title: 'Собственный шаблон ссылки',
    camera: { rtsp: 'rtsp://{userAuth}{host}:{port}/live/ch{channel}', host: '10.1.1.1', port: 8554, username: 'u', password: 'p', channel: 4 },
    expected: 'rtsp://u:p@10.1.1.1:8554/live/ch4',
  },
  {
    title: 'Без авторизации',
    camera: { vendor: 'amatek-nvr', host: '10.2.2.2', port: 554, username: '', password: '', channel: 1, stream: 0 },
    expected: 'rtsp://10.2.2.2:554/00',
  },
  {
    title: 'Нестандартный порт RTSP',
    camera: { vendor: 'amatek-nvr', host: '10.2.2.2', port: 1554, username: 'admin', password: 'p', channel: 2, stream: 0 },
    expected: 'rtsp://admin:p@10.2.2.2:1554/10',
  },
];

let failed = 0;
for (const testCase of cases) {
  const actual = buildRtspUrl(testCase.camera);
  try {
    assert.equal(actual, testCase.expected);
    console.log(`  ✓ ${testCase.title}`);
  } catch {
    failed += 1;
    console.log(`  ✗ ${testCase.title}\n      ожидалось: ${testCase.expected}\n      получено:  ${actual}`);
  }
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВСЕ ССЫЛКИ ФОРМИРУЮТСЯ ВЕРНО');
process.exit(failed ? 1 : 0);
