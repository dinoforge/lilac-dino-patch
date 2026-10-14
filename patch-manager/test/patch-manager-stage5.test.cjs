'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeHttpsUrl, parseMasterPlaylist, inspectHlsCandidate,
  registerPatch05Handlers
} = require('../../electron/patch-manager-stage5.cjs');

function response(url, status, body) {
  return { url, status, ok: status >= 200 && status < 300, async text() { return body; } };
}

test('Patch 05 accepts public HTTPS HLS only and parses exact master variant metadata', () => {
  assert.equal(safeHttpsUrl('http://cdn.example.test/master.m3u8'), null);
  assert.equal(safeHttpsUrl('https://127.0.0.1/master.m3u8'), null);
  assert.equal(safeHttpsUrl('https://192.168.1.10/master.m3u8'), null);
  assert.equal(safeHttpsUrl('https://media.example.test/master.m3u8').hostname, 'media.example.test');
  const variants = parseMasterPlaylist(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4200000,AVERAGE-BANDWIDTH=3500000,RESOLUTION=1920x1080\n1080/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\n720/index.m3u8\n',
    'https://media.example.test/master.m3u8'
  );
  assert.deepEqual(variants.map(item => [item.width, item.height, item.bitrate, item.url]), [
    [1920, 1080, 3500000, 'https://media.example.test/1080/index.m3u8'],
    [1280, 720, 1800000, 'https://media.example.test/720/index.m3u8']
  ]);
});

test('Patch 05 shows only variant playlists that return a real media playlist', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith('/master.m3u8')) return response(url, 200,
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\n720.m3u8\n');
    if (url.endsWith('/1080.m3u8')) return response(url, 200, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n');
    return response(url, 404, 'not found');
  };
  const result = await inspectHlsCandidate({ server: 'HD-2', url: 'https://media.example.test/master.m3u8' }, { fetchImpl });
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.qualities.map(item => item.label), ['1080p · 4500 kbps']);
  assert.deepEqual(calls, [
    'https://media.example.test/master.m3u8',
    'https://media.example.test/1080.m3u8',
    'https://media.example.test/720.m3u8'
  ]);
  assert.equal(Object.hasOwn(result.qualities[0], 'url'), false, 'stream URLs never cross to the renderer');
});

test('Patch 05 preserves HTTP 429 as a normal limited state and does not retry', async () => {
  let calls = 0;
  const result = await inspectHlsCandidate({ server: 'SUB', url: 'https://media.example.test/master.m3u8' }, {
    fetchImpl: async url => { calls++; return response(url, 429, ''); }
  });
  assert.equal(result.state, 'rate-limited');
  assert.equal(calls, 1);
});

test('Patch 05 rejects a private-network redirect before requesting its destination', async () => {
  const calls = [];
  const result = await inspectHlsCandidate({ server: 'redirect-test', url: 'https://media.example.test/master.m3u8' }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      return { ...response(url, 302, ''), headers: { get: () => 'http://127.0.0.1/private.m3u8' } };
    }
  });
  assert.equal(result.state, 'unknown');
  assert.match(result.message, /리디렉션을 차단/);
  assert.deepEqual(calls, [{ url: 'https://media.example.test/master.m3u8', redirect: 'manual' }]);
});

test('Patch 05 IPC inspects only the explicitly requested episode and returns no stream URL', async () => {
  const handlers = new Map(), lookups = [];
  const fetchImpl = async url => url.endsWith('/master.m3u8')
    ? response(url, 200, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720\n720.m3u8\n')
    : response(url, 200, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts\n');
  registerPatch05Handlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    miruroApi: async path => { lookups.push(path); return { tracks: [{ track: 'raw', providers: [{ provider: 'sample', servers: [{ server: 'server-a', streams: [{ format: 'hls', url: 'https://cdn.example.test/master.m3u8' }] }] }] }] }; },
    MIRURO_KINDS: { raw: 'RAW' }, fetchImpl
  });
  const handler = handlers.get('patch:episode-quality');
  const result = await handler({}, { provider: 'miruro', animeId: 44, number: 12 });
  assert.deepEqual(lookups, ['anime/44/episodes/12/play']);
  assert.equal(result.state, 'ready');
  assert.equal(result.providers[0].server, 'RAW - sample server-a');
  assert.equal(result.providers[0].qualities[0].height, 720);
  assert.equal(JSON.stringify(result).includes('master.m3u8'), false);
});

test('Patch 05 IPC treats provider HTTP 429 without retrying or falling through to other episodes', async () => {
  const handlers = new Map();
  let calls = 0;
  registerPatch05Handlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    miruroApi: async () => { calls++; const error = new Error('429'); error.status = 429; throw error; },
    MIRURO_KINDS: { raw: 'RAW' }
  });
  const result = await handlers.get('patch:episode-quality')({}, { provider: 'miruro', animeId: 44, number: 12 });
  assert.equal(result.state, 'rate-limited');
  assert.equal(calls, 1);
});
