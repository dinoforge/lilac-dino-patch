const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createPlayerStreamHeaders } = require('../electron/player-stream-headers.cjs');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

test('starting a newer provider resolve clears previous state and ignores late results', () => {
  const headers = createPlayerStreamHeaders();
  const older = headers.begin();
  headers.complete(older, 'miruro', { url: 'https://old-cdn.example/master.m3u8', headers: { Referer: 'https://old.example/' } });
  assert.ok(headers.hasFallback());

  const current = headers.begin();
  assert.equal(headers.hasFallback(), false);
  assert.equal(headers.forRequest('old-cdn.example', true), null);
  assert.equal(headers.complete(older, 'miruro', { url: 'https://old-cdn.example/master.m3u8', headers: { Cookie: 'old=1' } }), false);
  assert.equal(headers.forRequest('old-cdn.example', true), null);

  assert.equal(headers.complete(current, 'reanime', { url: 'https://current-cdn.example/master.m3u8', referer: 'https://reanime.to/' }), true);
  assert.deepEqual(headers.forRequest('current-cdn.example'), { Referer: 'https://reanime.to/' });
  assert.equal(headers.forRequest('other-cdn.example', true), null);
});

test('only the selected Miruro stream supplies its fallback headers to player media requests', () => {
  const headers = createPlayerStreamHeaders(), requestId = headers.begin();
  headers.complete(requestId, 'miruro', {
    url: 'https://edge-a.example/master.m3u8',
    headers: { Referer: 'https://www.miruro.to/watch/1', Origin: 'https://www.miruro.to', Cookie: 'session=1', 'Sec-Fetch-Site': 'cross-site' }
  });
  assert.deepEqual(headers.forRequest('edge-a.example'), {
    Referer: 'https://www.miruro.to/watch/1', Origin: 'https://www.miruro.to', Cookie: 'session=1'
  });
  assert.deepEqual(headers.forRequest('edge-b.example', true), {
    Referer: 'https://www.miruro.to/watch/1', Origin: 'https://www.miruro.to', Cookie: 'session=1'
  });
  assert.equal(headers.forRequest('edge-b.example', false), null);
});

test('local proxy URLs are not assigned remote credentials and resolver discovery has no session side effect', () => {
  const headers = createPlayerStreamHeaders(), requestId = headers.begin();
  headers.complete(requestId, 'reanime', {
    url: 'http://127.0.0.1:8765/__flix/abc', headers: { Cookie: 'remote=1' }, referer: 'https://flixcloud.cc/e/abc'
  });
  assert.equal(headers.forRequest('127.0.0.1:8765', true), null);

  const start = mainSource.indexOf('async function resolveStreamPage('), end = mainSource.indexOf('\nfunction simpleTitle(', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(mainSource.slice(start, end), /playerStreamHeaders|resolvedStreamHeaders/);
});

test('both main-player resolve handlers scope header state to the latest selected result', () => {
  const linkStart = mainSource.indexOf("ipcMain.handle('linkkf:resolve'");
  const providerStart = mainSource.indexOf("ipcMain.handle('provider:resolve'");
  const subtitleStart = mainSource.indexOf("ipcMain.handle('provider:subtitle-tracks'", providerStart);
  assert.ok(linkStart >= 0 && providerStart > linkStart && subtitleStart > providerStart);
  const linkHandler = mainSource.slice(linkStart, providerStart);
  const providerHandler = mainSource.slice(providerStart, subtitleStart);
  assert.match(linkHandler, /playerStreamHeaders\.begin\(\)/);
  assert.match(linkHandler, /playerStreamHeaders\.complete\(requestId,'linkkf',stream\)/);
  assert.match(providerHandler, /playerStreamHeaders\.begin\(\)/);
  assert.match(providerHandler, /playerStreamHeaders\.complete\(requestId,episode\?\.provider,stream\)/);
  assert.match(mainSource, /playerStreamHeaders\.forRequest\(host,playerMediaRequest\(details\)\)/);
});
