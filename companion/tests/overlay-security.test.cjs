'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'overlay');
const load = name => fs.readFileSync(path.join(root, name), 'utf8');

test('overlay has an independent entrypoint, ID and user profile', () => {
  const pkg = JSON.parse(load('package.json'));
  const main = load('main.cjs');
  assert.equal(pkg.main, 'main.cjs');
  assert.match(main, /setAppUserModelId\(APP_ID\)/);
  assert.match(main, /LilacAnime-Companion-Overlay-Test/);
  assert.match(main, /setPath\('userData'/);
  assert.match(main, /setPath\('sessionData'/);
  assert.match(main, /setPath\('cache'/);
  assert.doesNotMatch(main, /D:\\\\LilacAnime|%APPDATA%|lilacanime-desktop-updater/i);
});

test('does not expose debuggers, direct player actions, native injection or remote requests', () => {
  const main = load('main.cjs'), bridge = load('preload.cjs');
  const probe = load('windows-probe.ps1'), html = load('index.html');
  assert.doesNotMatch(main+bridge+probe, /webContents\.debugger|remote-debugging-port|app\.asar|OpenProcess|ReadProcessMemory|WriteProcessMemory|SendInput|mouse_event|keybd_event/i);
  assert.match(html, /connect-src 'none'/);
  assert.match(main, /onBeforeRequest[\s\S]+cancel: true/);
  assert.match(main, /following = false/);
  assert.match(main, /overlay:start/);
  assert.match(main, /overlay:stop/);
  assert.doesNotMatch(bridge, /providerPlay|providerResolve|rawIpc|executeJavaScript|openExternal/i);
});

test('probe observes process/window geometry only after opt-in and checks exact process', () => {
  const main = load('main.cjs'), probe = load('windows-probe.ps1');
  assert.match(main, /if \(!following \|\| busy/);
  assert.match(main, /GetDisplayMatching|screen\.getDisplayMatching/);
  assert.match(probe, /Get-Process -Name 'LilacAnime'/);
  assert.match(probe, /MainWindowTitle -ne 'LilacAnime'/);
  assert.doesNotMatch(probe, /Get-Content|Set-Content|Remove-Item|Start-Process|Get-CimInstance|Get-WmiObject|Get-ChildItem|Registry|Invoke-WebRequest/i);
});

test('fixture-only wording and keyboard-accessible controls are explicit', () => {
  const html = load('index.html'), ui = load('renderer.js');
  assert.match(html, /합성 데이터/);
  assert.match(html, /실제 영상 재생 가능 여부가 아닙니다/);
  assert.match(html, /원본 창 따라가기/);
  assert.match(ui, /aria-selected/);
  assert.match(ui, /addEventListener\('click'/);
});
