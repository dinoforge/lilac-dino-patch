'use strict';

// Logged-out boundary tests. No ChatGPT account, token, cookie, public web
// request or installed LilacAnime profile is used in this deterministic suite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEmbeddedChatGPTBrowser, HOME, SESSION_PARTITION } =
  require('../../electron/embedded-chatgpt-web.cjs');
const { registerPatch02Handlers } = require('../../electron/patch-manager-stage2.cjs');

function blankAccountBrowser({ fails = 0 } = {}) {
  const windows = [];
  let remainingFailures = fails;
  let protectedReads = 0;
  let pageExecutions = 0;
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.events = {};
      this.urls = [];
      this.shown = 0;
      this.focused = 0;
      this.authenticated = false; // a brand-new logged-out session
      this.webContents = {
        session: {
          setPermissionRequestHandler: fn => { this.permissionRequest = fn; },
          cookies: {
            get() { protectedReads++; throw new Error('Must never inspect cookies'); }
          }
        },
        on: (event, handler) => { this.events[event] = handler; },
        setWindowOpenHandler: handler => { this.popupHandler = handler; },
        executeJavaScript: () => {
          pageExecutions++;
          throw new Error('Must never inspect page content when logged out');
        }
      };
      windows.push(this);
    }
    on(event, handler) { this.events[event] = handler; }
    async loadURL(url) {
      this.urls.push(url);
      if (remainingFailures-- > 0) throw new Error('simulated anonymous network failure');
    }
    isDestroyed() { return this.destroyed; }
    show() { this.shown++; }
    focus() { this.focused++; }
    destroy() { this.destroyed = true; this.events.closed?.(); }
  }
  return {
    BrowserWindow, windows,
    get protectedReads() { return protectedReads; },
    get pageExecutions() { return pageExecutions; }
  };
}

test('logged-out clean browser opens home without reading account state or submitting prompts', async () => {
  const mock = blankAccountBrowser();
  const browser = createEmbeddedChatGPTBrowser(mock);
  assert.equal(mock.windows.length, 0, 'never open the browser before a click');
  assert.deepEqual(await browser.open(), { opened: true, reused: false, embedded: true });
  const win = mock.windows[0];
  assert.equal(win.authenticated, false);
  assert.deepEqual(win.urls, [HOME]);
  assert.equal(win.options.webPreferences.partition, SESSION_PARTITION);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.webviewTag, false);
  assert.equal(mock.protectedReads, 0);
  assert.equal(mock.pageExecutions, 0);
  assert.equal(win.shown, 1);
  assert.deepEqual(await browser.open(), { opened: true, reused: true, embedded: true });
  assert.equal(mock.windows.length, 1, 'opening it again reuses the same logged-out window');
  assert.equal(mock.protectedReads, 0);
  assert.equal(mock.pageExecutions, 0);
});

test('logged-out Patch 02 IPC stops safely without sending or saving a subtitle', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-web-logged-out-'));
  const handlers = new Map();
  const mock = blankAccountBrowser();
  let copied = 0, saved = 0;
  try {
    registerPatch02Handlers({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      app: { getPath: name => {
        assert.equal(name, 'userData');
        return userData;
      } },
      clipboard: {
        writeText() { copied++; },
        readText() { copied++; return ''; }
      },
      subtitleStore: { save() { saved++; return { path: 'unused.vtt' }; } },
      shell: { showItemInFolder() {} },
      electron: mock
    });
    assert.equal(mock.windows.length, 0);
    const unopened = await handlers.get('patch:chatgpt-web:translate')(null, {
      jobKey: 'logged-out-fixture-1', batchIndex: 0, prompt: 'Translate this synthetic cue.'
    });
    assert.equal(unopened.code, 'CHATGPT_WINDOW_CLOSED');
    assert.equal(mock.windows.length, 0, 'the translation IPC does not open the browser implicitly');
    assert.equal(saved, 0);
    assert.equal(copied, 0);
    assert.deepEqual(await handlers.get('patch:chatgpt-web:open')(), {
      opened: true, reused: false, embedded: true
    });
    assert.equal(mock.windows[0].authenticated, false);
    const blocked = await handlers.get('patch:chatgpt-web:translate')(null, {
      jobKey: 'logged-out-fixture-2', batchIndex: 0, prompt: 'Translate this synthetic cue.'
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.sent, false);
    assert.equal(blocked.code, 'CHATGPT_PAGE_UNAVAILABLE');
    assert.equal(saved, 0, 'no translated subtitle is saved without a verified response');
    assert.equal(copied, 0, 'the test never reads the system clipboard');
    assert.equal(mock.protectedReads, 0);
    assert.equal(mock.pageExecutions, 1, 'only page-level logged-out preflight was attempted');
    assert.deepEqual(await handlers.get('patch:chatgpt-web:cancel')(null, 'logged-out-fixture-2'), {
      cancelled: false, sent: false, stopRequested: false, settled: true, phase: 'checking-page'
    });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('logged-out page load failure is handled without accepting a false login result', async () => {
  const mock = blankAccountBrowser({ fails: 1 });
  const service = createEmbeddedChatGPTBrowser(mock);
  await assert.rejects(service.open(), /내장 화면을 열지 못했습니다/);
  assert.equal(mock.windows.length, 1);
  assert.equal(mock.windows[0].destroyed, true);
  assert.equal(mock.windows[0].shown, 0);
  assert.equal(mock.protectedReads, 0);
  assert.equal(mock.pageExecutions, 0);
  assert.deepEqual(await service.open(), { opened: true, reused: false, embedded: true });
  assert.equal(mock.windows.length, 2);
  assert.equal(mock.windows[1].authenticated, false);
});

test('logged-out UI explains manual login while offering separate automatic and manual routes', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/patch-manager-stage2.js'), 'utf8');
  assert.match(source, /브라우저 로그인은 사용자가 직접 합니다/);
  assert.match(source, /ChatGPT 자막 번역 \(베타\)/);
  assert.match(source, /const runAuto = async/);
  assert.match(source, /자동 재전송하지 않습니다/);
  assert.match(source, /id="patch0102ChatGPTDeleteUnavailable" type="button" disabled/);
  assert.match(source, /patch0102ManualImport/);
});
