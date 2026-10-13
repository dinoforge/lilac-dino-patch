'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
  HOME, SESSION_PARTITION, safeNavigation, createEmbeddedChatGPTBrowser
} = require('../../electron/embedded-chatgpt-web.cjs');
const {
  validateJob, inspectScript, focusComposerScript, clickSendScript, clearComposerScript, clickStopScript,
  createWebAutoTranslation
} = require('../../electron/chatgpt-web-ui-driver.cjs');
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

test('web UI scripts compile and automatic translation captures only a new stable response', async () => {
  const prompt = 'Translate synthetic cue IDs 1 and 2.';
  const conversationPath = '/c/synthetic-thread';
  const scripts = [inspectScript(prompt, true), focusComposerScript(conversationPath), clickSendScript(prompt, conversationPath),
    clearComposerScript(prompt, conversationPath), clickStopScript(conversationPath)];
  for (const script of scripts) new Function('return ' + script);
  for (const script of scripts.slice(1)) {
    assert.equal(vm.runInNewContext(script, { location: { hostname: 'chatgpt.com', pathname: '/c/other-thread' } }), false,
      'focus, send, clear, and stop actions are bound to the original conversation');
  }
  assert.deepEqual(validateJob({ jobKey: 'test-job-key-1', batchIndex: 0, prompt }), { jobKey: 'test-job-key-1', batchIndex: 0, prompt });
  assert.throws(() => validateJob({ jobKey: 'bad', batchIndex: 0, prompt: '' }), /비어 있거나 크기 제한/);

  let sent = false, inserted = '', clock = 0, inspections = 0;
  const webContents = {
    isDestroyed: () => false,
    insertText: async text => { inserted = text; },
    executeJavaScript: async script => {
      if (script.includes('dino-chatgpt-auto:focus')) return true;
      if (script.includes('dino-chatgpt-auto:send')) { sent = true; return true; }
      if (script.includes('dino-chatgpt-auto:inspect')) {
        inspections++;
        const base = { host: 'chatgpt.com', pathname: '/c/synthetic-thread', loginRequired: false, challenge: false,
          composerCount: 1, composerEmpty: !sent && !script.includes(JSON.stringify(prompt)),
          composerMatchesExpected: script.includes(JSON.stringify(prompt)), sendButtonCount: 1,
          sendButtonEnabled: script.includes(JSON.stringify(prompt)),
          userCount: sent ? 1 : 0, latestUserMatchesExpected: sent, assistantCount: sent && inspections > 2 ? 1 : 0,
          assistantText: sent && inspections > 2 ? '{"1":"안녕","2":"고마워"}' : '', generating: false };
        return base;
      }
      return false;
    }
  };
  const win = { webContents, isDestroyed: () => false };
  const driver = createWebAutoTranslation({ getWindow: () => win, pollIntervalMs: 10, stableMs: 500, now: () => clock, sleep: async ms => { clock += ms; } });
  const result = await driver.run({ jobKey: 'test-job-key-1', batchIndex: 0, prompt });
  assert.equal(inserted, prompt);
  assert.equal(result.ok, true);
  assert.equal(result.batchIndex, 0);
  assert.equal(result.response, '{"1":"안녕","2":"고마워"}');
  assert.equal(result.sent, true);
  assert.equal(driver.busy(), false);
});

test('web UI automation stops before sending when the account page is logged out or unsupported', async () => {
  let executed = 0, inserted = 0;
  const driver = createWebAutoTranslation({ getWindow: () => ({ isDestroyed: () => false, webContents: {
    isDestroyed: () => false,
    insertText: async () => { inserted++; },
    executeJavaScript: async script => { executed++; return { host: 'chatgpt.com', pathname: '/auth/login', loginRequired: true, challenge: false, composerCount: 0 }; }
  } }) });
  await assert.rejects(driver.run({ jobKey: 'test-job-key-1', batchIndex: 0, prompt: 'Synthetic prompt.' }), error => error.code === 'CHATGPT_LOGIN_REQUIRED' && error.sent === false);
  assert.equal(executed, 1);
  assert.equal(inserted, 0);
  assert.equal(driver.busy(), false);
});

test('web driver rejects a concurrent job and cancellation waits for the active input step', async () => {
  const prompt = 'Synthetic concurrency cue.';
  let releaseInsert, announceInsert, sendCount = 0;
  const insertGate = new Promise(resolve => { releaseInsert = resolve; });
  const insertStarted = new Promise(resolve => { announceInsert = resolve; });
  const driver = createWebAutoTranslation({ getWindow: () => ({ isDestroyed: () => false, webContents: {
    isDestroyed: () => false,
    insertText: async () => { announceInsert(); await insertGate; },
    executeJavaScript: async script => {
      if (script.includes('dino-chatgpt-auto:focus')) return true;
      if (script.includes('dino-chatgpt-auto:send')) { sendCount++; return true; }
      if (script.includes('dino-chatgpt-auto:inspect')) {
        const prepared = script.includes(JSON.stringify(prompt));
        return { host: 'chatgpt.com', pathname: '/', loginRequired: false, challenge: false,
          composerCount: 1, composerEmpty: !prepared, composerMatchesExpected: prepared,
          sendButtonCount: 1, sendButtonEnabled: true, userCount: 0, latestUserMatchesExpected: false,
          assistantCount: 0, assistantText: '', generating: false };
      }
      return false;
    }
  } }) });
  const running = driver.run({ jobKey: 'active-job-key-1', batchIndex: 0, prompt });
  await insertStarted;
  await assert.rejects(driver.run({ jobKey: 'active-job-key-2', batchIndex: 0, prompt }), error => error.code === 'WEB_TRANSLATION_BUSY');
  const cancelling = driver.cancel('active-job-key-1');
  releaseInsert();
  assert.deepEqual(await cancelling, { cancelled: true, sent: false, stopRequested: false, settled: true });
  await assert.rejects(running, error => error.code === 'CANCELLED' && error.sent === false);
  assert.equal(sendCount, 0);
});

test('ChatGPT web automation is a separate enabled route and deletion remains disabled', () => {
  const settingsStart = rendererSource.indexOf('function addManualTranslationSettings()');
  const settingsEnd = rendererSource.indexOf('function addManualTranslationUi()', settingsStart);
  const settings = rendererSource.slice(settingsStart, settingsEnd);
  assert.match(settings, /choice\.textContent = 'ChatGPT 웹 자동 번역 \(실험\)'/);
  assert.match(settings, /id="patch0102ChatGPTAutoStart" type="button" aria-describedby/);
  assert.match(settings, /choice\.addEventListener\('click',/);
  assert.match(settings, /id="patch0102ChatGPTDeleteUnavailable" type="button" disabled/);
  assert.match(settings, /수동 번역 준비/);
  assert.match(settings, /로그인 필요, 접근 확인/);
  assert.match(rendererSource, /id = 'patch0102WebAutoStart'/);
  assert.match(rendererSource, /ChatGPT 웹 자동 번역 \(실험\)/);
  assert.match(rendererSource, /const runAuto = async/);
  assert.match(rendererSource, /patchChatGPTWebTranslate|patchCancelChatGPTWebTranslation/);
  assert.match(rendererSource, /중복 전송/);
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
    const closed = await handlers.get('patch:chatgpt-web:translate')(null, { jobKey: 'test-job-key-1', batchIndex: 0, prompt: 'Translate this.' });
    assert.equal(closed.ok, false);
    assert.equal(closed.code, 'CHATGPT_WINDOW_CLOSED');
    assert.equal(mock.windows.length, 0, 'the renderer must open the dedicated window before starting a job');
    const result = await handlers.get('patch:chatgpt-web:open')();
    assert.equal(result.embedded, true);
    assert.equal(mock.windows.length, 1);
    const unsupported = await handlers.get('patch:chatgpt-web:translate')(null, { jobKey: 'test-job-key-2', batchIndex: 0, prompt: 'Translate this.' });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'CHATGPT_PAGE_UNAVAILABLE');
    assert.equal(unsupported.sent, false);
    assert.deepEqual(await handlers.get('patch:chatgpt-web:cancel')(null, 'test-job-key-2'), {
      cancelled: false, sent: false, stopRequested: false, settled: true, phase: 'checking-page'
    });
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
  assert.match(preload, /patchChatGPTWebTranslate/);
  assert.match(preload, /patchCancelChatGPTWebTranslation/);
  assert.doesNotMatch(preload, /SIWC|siwc/);
  assert.doesNotMatch(html, /siwc/i);
});
