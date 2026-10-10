'use strict';

// Separate Windows top-level window: does not inject into LilacAnime or read its files.
const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { quarterForDate } = require('../../src/quarter-selection.js');
const { buildDemoWeek } = require('../core/catalog.cjs');
const { dockOverlay, isRect } = require('./geometry.cjs');

const runFile = promisify(execFile);
const APP_ID = 'com.dinoforge.animeplayer.companion.overlay.test';
const APP_NAME = 'LilacAnime Companion Overlay (Test)';
const HTML = path.join(__dirname, 'index.html');
const PROFILE = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'LilacAnime-Companion-Overlay-Test');
app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.setPath('userData', path.join(PROFILE, 'userData'));
app.setPath('sessionData', path.join(PROFILE, 'sessionData'));
app.setPath('cache', path.join(PROFILE, 'cache'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let window = null;
let following = false;
let busy = false;
let interval = null;
let previousStatus = '';

function report(status, message) {
  const value = { status, message, following };
  const key = JSON.stringify(value);
  if (key === previousStatus) return;
  previousStatus = key;
  if (window && !window.isDestroyed()) window.webContents.send('overlay:status', value);
}

function senderAllowed(event) {
  try { return path.resolve(fileURLToPath(event.senderFrame.url)).toLowerCase() === HTML.toLowerCase(); }
  catch { return false; }
}

function ipc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!senderAllowed(event)) throw new Error('Untrusted overlay IPC sender');
    return handler(...args);
  });
}

function validProbe(value) {
  if (!value || !Array.isArray(value.windows) || value.windows.length > 20) return null;
  const windows = [];
  for (const item of value.windows) {
    if (!item || item.title !== 'LilacAnime' || !Number.isSafeInteger(item.pid) || item.pid <= 0 ||
        !/^\d+$/.test(item.hwnd) || typeof item.foreground !== 'boolean' || !isRect(item.rect)) return null;
    windows.push(item);
  }
  return windows;
}

async function scan() {
  if (!following || busy || !window || window.isDestroyed()) return;
  busy = true;
  try {
    if (process.platform !== 'win32') throw new Error('Windows 전용 창 탐색입니다.');
    const { stdout } = await runFile('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'windows-probe.ps1')],
      { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 32768 });
    const windows = validProbe(JSON.parse(stdout));
    if (!windows) throw new Error('창 검색 결과를 검증할 수 없습니다.');
    if (windows.length !== 1) {
      window.setAlwaysOnTop(false);
      report(windows.length ? 'ambiguous' : 'missing',
        windows.length ? 'LilacAnime 창이 여러 개라 자동 연결하지 않습니다.' : 'LilacAnime 창을 찾지 못했습니다. 창을 켜면 다시 확인합니다.');
      return;
    }
    const target = windows[0];
    // DWM delivers physical screen coordinates. Electron geometry uses DIP.
    const dipRect = screen.screenToDipRect(null, target.rect);
    if (!isRect(dipRect)) throw new Error('화면 배율 좌표를 변환할 수 없습니다.');
    const display = screen.getDisplayMatching(dipRect);
    const current = window.getBounds();
    const dock = dockOverlay(dipRect, display.workArea,
      { width: current.width, height: current.height, gap: 10 });
    if (dock.mode !== 'docked') {
      window.setAlwaysOnTop(false);
      report('manual', '원본 창을 가리지 않는 공간이 없어 수동 배치합니다.');
      return;
    }
    const old = window.getBounds();
    if (old.x !== dock.bounds.x || old.y !== dock.bounds.y)
      window.setPosition(dock.bounds.x, dock.bounds.y, false);
    // Only stay topmost while LilacAnime or this overlay has focus.
    window.setAlwaysOnTop(target.foreground || window.isFocused(), 'floating');
    report('docked', 'LilacAnime 창 ' + (dock.side === 'right' ? '오른쪽' : '왼쪽') + '에 붙어 있습니다. 데이터는 합성 예시입니다.');
  } catch (error) {
    following = false; // Fail closed. Do not change the original window.
    if (interval) { clearInterval(interval); interval = null; }
    if (window && !window.isDestroyed()) window.setAlwaysOnTop(false);
    report('error', '창 추적 중단: ' + String(error.message || error).slice(0, 160));
  } finally { busy = false; }
}

function stop() {
  following = false;
  if (interval) { clearInterval(interval); interval = null; }
  if (window && !window.isDestroyed()) window.setAlwaysOnTop(false);
  report('stopped', '창 따라가기를 해제했습니다. 원본은 변경되지 않았습니다.');
  return { following: false };
}

function calendar() {
  const now = new Date();
  const current = quarterForDate(now);
  const year = now.getFullYear();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  return {
    year, quarter, currentQuarter: current,
    todayIndex: (now.getDay() + 6) % 7,
    days: buildDemoWeek({ year, quarter }, now),
    synthetic: true
  };
}

function create() {
  window = new BrowserWindow({
    width: 358, height: 568, minWidth: 326, minHeight: 444,
    show: false, resizable: true, frame: true, alwaysOnTop: false,
    title: APP_NAME, backgroundColor: '#121212', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== 'file://' + HTML.replace(/\\/g, '/')) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { stop(); window = null; });
  window.loadFile(HTML);
}

app.whenReady().then(() => {
  if (!gotLock) return;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }));
  ipc('overlay:calendar', () => calendar());
  ipc('overlay:start', () => {
    if (process.platform !== 'win32') return { following: false, reason: 'Windows 전용 기능입니다.' };
    if (!following) {
      following = true;
      previousStatus = '';
      interval = setInterval(scan, 1500);
      void scan();
    }
    return { following: true };
  });
  ipc('overlay:stop', () => stop());
  create();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => stop());
