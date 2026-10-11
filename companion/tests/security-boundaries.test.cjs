'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('prototype has a unique Electron identity and separate user, session, and cache paths', () => {
  const metadata = JSON.parse(read('package.json'));
  const main = read('electron/main.cjs');
  const originalPackage = JSON.parse(fs.readFileSync(path.resolve(root, '..', 'package.json'), 'utf8'));
  assert.notEqual(metadata.appId, 'com.lilac.anime.desktop');
  assert.notEqual(metadata.productName, 'LilacAnime');
  assert.equal(originalPackage.build.appId, 'com.lilac.anime.desktop');
  assert.equal(originalPackage.build.productName, 'LilacAnime');
  assert.equal(originalPackage.build.files.includes('companion/**/*'), false, 'the Companion prototype is not packaged into LilacAnime');
  assert.match(main, /LilacAnime-Companion-Prototype/);
  assert.match(main, /app\.setPath\('userData', USER_DATA_PATH\)/);
  assert.match(main, /app\.setPath\('sessionData', SESSION_DATA_PATH\)/);
  assert.match(main, /app\.setPath\('cache', CACHE_PATH\)/);
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
});

test('renderer isolation, network denial, and trusted-file IPC boundaries are explicit', () => {
  const main = read('electron/main.cjs');
  const preload = read('electron/preload.cjs');
  const html = read('renderer/index.html');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /onBeforeRequest[\s\S]*cancel: true/);
  assert.match(main, /function trustedSender/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(main, /remote-debugging-port|webContents\.debugger|executeJavaScript|app\.asar/i);
  assert.doesNotMatch(preload, /readFile|writeFile|fetch\(|XMLHttpRequest|process\.env|appData/i);
  assert.doesNotMatch(main, /D:\\\\LilacAnime|%APPDATA%|lilacanime-desktop/i);
});

test('bridge contains no original-player control or provider network channel', () => {
  const preload = read('electron/preload.cjs');
  const main = read('electron/main.cjs');
  assert.match(preload, /calendarState/);
  assert.match(preload, /chooseSubtitle/);
  assert.match(preload, /applyResponse/);
  assert.match(preload, /exportSubtitle/);
  assert.doesNotMatch(preload, /providerPlay|providerResolve|linkkf|reanime|miruro|animenosub|ohli24/i);
  assert.doesNotMatch(main, /provider:play|provider:resolve|linkkfFetch|providerFetch|webContents\.send\(['"]player:/i);
  assert.match(main, /shell\.openExternal\('https:\/\/chatgpt\.com\/'\)/);
  assert.deepEqual([...main.matchAll(/https?:\/\/[a-z0-9.-]+(?:\/[^\s'"`]*)?/gi)].map(match => match[0]), ['https://chatgpt.com/']);
});

test('compatibility report does not claim original app runtime support', () => {
  const compatibility = JSON.parse(read('compatibility.json'));
  assert.equal(compatibility.versionStates['0.5.14'].state, 'untested');
  assert.equal(compatibility.inAppExtensionApi.state, 'unsupported');
  assert.equal(compatibility.playbackControl.state, 'unsupported');
  assert.equal(compatibility.independentCompanionWindow.state, 'untested');
});
