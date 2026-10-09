const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const diagnostics = require('../src/player-diagnostics.js');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('playback failure entries retain only approved fields and a server hostname', () => {
  const entry = diagnostics.createEntry({
    context: {
      episode: { provider: 'reanime', title: '작품 비밀 제목' },
      currentUrl: 'https://cdn.example.test/private/episode.m3u8?token=secret&signature=private',
      streamHeaders: { Cookie: 'session=secret' },
      subtitleReferer: 'https://secret.example.test/?key=secret'
    },
    failure: { stage: 'hls-playback', mediaType: 'hls', errorCategory: 'networkError', message: 'private error' },
    occurredAt: '2026-10-10T01:02:03.000Z'
  });

  assert.deepEqual(entry, {
    occurredAt: '2026-10-10T01:02:03.000Z',
    provider: 'reanime',
    stage: 'hls-playback',
    playback: 'online',
    mediaType: 'hls',
    serverHost: 'cdn.example.test',
    videoErrorCode: null,
    errorCategory: 'networkError'
  });
  assert.doesNotMatch(JSON.stringify(entry), /작품 비밀 제목|private|secret|Cookie/i);
});

test('unknown provider, stage, media type, and error details are discarded', () => {
  const entry = diagnostics.createEntry({
    context: { episode: { provider: 'attacker.example/path' }, currentUrl: 'file:///C:/private/video.mkv', offline: true },
    failure: { stage: 'https://secret.test', mediaType: 'secret', videoErrorCode: 1, errorCategory: 'secret', message: 'secret' },
    occurredAt: 'not-a-date'
  });
  assert.equal(entry.provider, 'unknown');
  assert.equal(entry.stage, 'playback');
  assert.equal(entry.playback, 'offline');
  assert.equal(entry.mediaType, 'native');
  assert.equal(entry.serverHost, null);
  assert.equal(entry.videoErrorCode, null);
  assert.equal(entry.errorCategory, null);
  assert.ok(!Number.isNaN(Date.parse(entry.occurredAt)));
});

test('report contains the last five allowlisted entries and omits arbitrary fields', () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({
    occurredAt: `2026-10-10T00:00:0${index}.000Z`, provider: 'miruro', stage: 'hls-playback',
    playback: 'online', mediaType: 'hls', serverHost: 'edge.example', videoErrorCode: 3,
    errorCategory: 'mediaError', title: 'private title', url: 'https://secret.test/?token=abc', cookie: 'secret'
  }));
  const report = diagnostics.formatReport({ app: { version: '0.5.6', platform: 'win32', arch: 'x64' }, entries });
  assert.match(report, /버전: 0\.5\.6/);
  assert.match(report, /운영체제: win32 x64/);
  assert.equal((report.match(/공급원=miruro/g) || []).length, 5);
  assert.doesNotMatch(report, /00:00:00\.000Z|00:00:01\.000Z|private title|secret\.test|token=abc|cookie/i);
});

test('app version IPC is user-invoked through the player diagnostics copy UI', () => {
  const html = read('src/index.html'), preload = read('electron/preload.cjs'), main = read('electron/main.cjs'), app = read('src/app.js');
  assert.match(html, /id="copyPlayerDiagnostics"[^>]*>오류 정보 복사/);
  assert.match(html, /작품명·전체 주소·쿠키·자막 내용은 들어가지 않으며/);
  assert.ok(html.indexOf('player-diagnostics.js') < html.indexOf('app.js'));
  assert.match(preload, /appDiagnosticInfo: \(\) => ipcRenderer\.invoke\('app:diagnostic-info'\)/);
  assert.match(main, /ipcMain\.handle\('app:diagnostic-info',\(\)=>\(\{version:app\.getVersion\(\),platform:process\.platform,arch:process\.arch\}\)\)/);
  assert.match(app, /window\.lilac\.copyText\(window\.LilacPlayerDiagnostics\.formatReport\(\{app,entries:playerFailureHistory\}\)\)/);
  assert.match(app, /playerFailureHistory\.length>5/);
});
