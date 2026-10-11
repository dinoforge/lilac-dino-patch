'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  HOME, SESSION_PARTITION, safeNavigation, createEmbeddedChatGPTBrowser
} = require('../../electron/embedded-chatgpt-web.cjs');
const { AUTOMATIC_OUTPUT_UNAVAILABLE, createWebAutoTranslation } = require('../../electron/chatgpt-web-ui-driver.cjs');
const { registerPatch02Handlers } = require('../../electron/patch-manager-stage2.cjs');
const { makeLilacAnimeV0514Manifest } = require('../adapters/lilacanime-v0.5.14.cjs');
const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/patch-manager-stage2.js'), 'utf8');

function makeBrowserMock({ failLoad = false } = {}) {
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.events = {};
      this.destroyed = false;
      this.loaded = [];
      this.shown = 0;
      this.focused = 0;
      this.webContents = {
        events: {},
        session: { setPermissionRequestHandler: cb => { this.permission = cb; } },
        on: (name, callback) => { this.webContents.events[name] = callback; },
        setWindowOpenHandler: callback => { this.popupHandler = callback; }
      };
      windows.push(this);
    }
    on(name, cb) { this.events[name] = cb; }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) {
      this.loaded.push(url);
      if (failLoad) throw Error('mock network failure');
    }
    show() { this.shown++; }
    focus() { this.focused++; }
    destroy() { this.destroyed = true; this.events.closed?.(); }
  }
  return { BrowserWindow, windows };
}

test('embedded ChatGPT uses a dedicated sandboxed profile and reuses its window', async () => {
  const mock = makeBrowserMock();
  const service = createEmbeddedChatGPTBrowser(mock);
  assert.deepEqual(await service.open(), { opened: true, reused: false, embedded: true });
  assert.equal(mock.windows.length, 1);
  const current = mock.windows[0];
  assert.deepEqual(current.loaded, [HOME]);
  assert.equal(current.options.webPreferences.partition, SESSION_PARTITION);
  assert.equal(current.options.webPreferences.nodeIntegration, false);
  assert.equal(current.options.webPreferences.contextIsolation, true);
  assert.equal(current.options.webPreferences.sandbox, true);
  assert.equal(current.options.webPreferences.webviewTag, false);
  assert.equal(current.options.webPreferences.webSecurity, true);
  let allowed;
  current.permission(null, 'camera', ok => { allowed = ok; });
  assert.equal(allowed, false);
  assert.deepEqual(await service.open(), { opened: true, reused: true, embedded: true });
  assert.equal(mock.windows.length, 1);
  assert.equal(current.focused, 1);
  current.destroy();
  assert.deepEqual(await service.open(), { opened: true, reused: false, embedded: true });
  assert.equal(mock.windows.length, 2);
});

test('embedded window refuses unsafe navigation or popup schemes', async () => {
  assert.equal(safeNavigation('https://chatgpt.com/'), true);
  for (const url of ['http://chatgpt.com/', 'file:///D:/LilacAnime/app.asar', 'javascript:alert(1)', 'data:text/html,hi', 'not a url']) {
    assert.equal(safeNavigation(url), false, url);
  }
  const mock = makeBrowserMock();
  await createEmbeddedChatGPTBrowser(mock).open();
  const current = mock.windows[0];
  let stopped = 0;
  current.webContents.events['will-navigate']({ preventDefault() { stopped++; } }, 'file:///C:/secret');
  current.webContents.events['will-navigate']({ preventDefault() { stopped++; } }, 'https://chatgpt.com/c/example');
  assert.equal(stopped, 1);
  assert.deepEqual(current.popupHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  const login = current.popupHandler({ url: 'https://accounts.google.com/' });
  assert.equal(login.action, 'allow');
  assert.equal(login.overrideBrowserWindowOptions.webPreferences.partition, SESSION_PARTITION);
  assert.equal(login.overrideBrowserWindowOptions.webPreferences.sandbox, true);
});

test('embedded page load failure destroys the dedicated window', async () => {
  const mock = makeBrowserMock({ failLoad: true });
  await assert.rejects(createEmbeddedChatGPTBrowser(mock).open(), /열지 못했습니다/);
  assert.equal(mock.windows[0].destroyed, true);
});

test('experimental web translation fails closed without opening or reading ChatGPT', async () => {
  let opened = 0;
  const driver = createWebAutoTranslation({ open: async () => { opened++; }, getWindow: () => { opened++; return null; } });
  await assert.rejects(driver.run({ jobKey: 'test-job-key-1', prompt: 'Translate these subtitle cues.' }), error => error.message === AUTOMATIC_OUTPUT_UNAVAILABLE);
  await assert.rejects(driver.run({ jobKey: 'bad', prompt: '' }), /비어 있거나 크기 제한/);
  assert.equal(opened, 0);
  assert.equal(driver.busy(), false);
  assert.equal(driver.cancel(), true);
});

test('experimental ChatGPT web entry is enabled without changing existing translation mode selection', () => {
  const settingsStart = rendererSource.indexOf('function addManualTranslationSettings()');
  const settingsEnd = rendererSource.indexOf('function addManualTranslationUi()', settingsStart);
  const settings = rendererSource.slice(settingsStart, settingsEnd);
  assert.match(settings, /id = 'patch0102ChatGPTAutoUnavailable'/);
  assert.match(settings, /choice\.textContent = 'ChatGPT 웹 자동 번역 \(실험\)'/);
  assert.match(settings, /choice\.addEventListener\('click',/);
  assert.doesNotMatch(settings, /choice\.disabled = true/);
  assert.match(settings, /id="patch0102ChatGPTDeleteUnavailable" type="button" disabled/);
  assert.match(settings, /수동 번역 준비/);
  assert.match(settings, /현재 묶음의 번역 요청을 복사하고 내장 창을 여는 준비만/);
  assert.match(rendererSource, /id = 'patch0102WebAutoStart'/);
  assert.match(rendererSource, /const runAuto = async/);
  assert.doesNotMatch(rendererSource, /patchChatGPTWebTranslate|patchChatGPTWebCancel/);
  assert.match(rendererSource, /자동 전송과 응답 수집은 지원하지 않습니다/);
  assert.match(rendererSource, /if \(!value\.persisted\) throw new Error/);
  assert.match(rendererSource, /value\.inflightBatch === value\.index/);
});

test('Patch 02 exposes embedded window IPC but only opens it when called', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-web-ipc-'));
  const mock = makeBrowserMock();
  const handlers = new Map();
  try {
    const registered = registerPatch02Handlers({
      ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
      app: { getPath: name => { assert.equal(name, 'userData'); return userData; } },
      subtitleStore: { save: () => ({ path: 'translated.vtt' }) },
      clipboard: { writeText() {}, readText() { return ''; } },
      shell: { showItemInFolder() {} },
      electron: mock
    });
    assert.ok(registered.includes('patch:chatgpt-web:open'));
    assert.ok(registered.includes('patch:chatgpt-web:translate'));
    assert.ok(registered.includes('patch:chatgpt-web:cancel'));
    assert.equal(handlers.has('patch:chatgpt-web:translate'), true);
    assert.equal(handlers.has('siwc:connect'), false);
    assert.equal(mock.windows.length, 0);
    await assert.rejects(handlers.get('patch:chatgpt-web:translate')(null, { jobKey: 'test-job-key-1', prompt: 'Translate this.' }), error => error.message === AUTOMATIC_OUTPUT_UNAVAILABLE);
    assert.equal(mock.windows.length, 0, 'the unavailable handler does not open ChatGPT');
    const result = await handlers.get('patch:chatgpt-web:open')();
    assert.equal(result.embedded, true);
    assert.equal(mock.windows.length, 1);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('official v0.5.14 patch manifest carries embedded bridge and no SIWC runtime', () => {
  const manifest = makeLilacAnimeV0514Manifest();
  const files = manifest.actions.filter(action => action.kind === 'add-file').map(action => action.file);
  assert.ok(files.includes('electron/embedded-chatgpt-web.cjs'));
  assert.ok(files.includes('electron/chatgpt-web-ui-driver.cjs'));
  assert.ok(!files.includes('electron/siwc-client.cjs'));
  assert.ok(!files.includes('src/siwc-subtitle-bridge.js'));
  const preload = manifest.actions.find(action => action.file === 'electron/preload.cjs').content;
  const html = manifest.actions.find(action => action.file === 'src/index.html').content;
  assert.match(preload, /patchOpenChatGPTEmbedded/);
  assert.doesNotMatch(preload, /patchChatGPTWebTranslate|patchChatGPTWebCancel/);
  assert.doesNotMatch(preload, /SIWC|siwc/);
  assert.doesNotMatch(html, /siwc/i);
});
