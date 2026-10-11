'use strict';

// Dedicated first-party UI window inside the patched Electron application.
// Do not inject scripts into ChatGPT, scrape its DOM/output, or read credentials.
// This is an embedded browser, not a guarantee of a fixed ChatGPT website layout.
const HOME = 'https://chatgpt.com/';
const SESSION_PARTITION = 'persist:dino-lilac-chatgpt-web';

function safeNavigation(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'about:' && parsed.href === 'about:blank';
  } catch { return false; }
}

function createEmbeddedChatGPTBrowser({ BrowserWindow, shell, partition = SESSION_PARTITION }) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow is required');
  if (typeof partition !== 'string' || !/^persist:dino-lilac-[a-z0-9-]+$/.test(partition))
    throw new Error('Unrecognized ChatGPT browser partition');
  let win = null;
  async function open() {
    if (win && !win.isDestroyed()) {
      if (typeof win.show === 'function') win.show();
      if (typeof win.focus === 'function') win.focus();
      return { opened: true, reused: true, embedded: true };
    }
    win = new BrowserWindow({
      title: '디노 라일락 패치 · ChatGPT 웹 번역',
      width: 1120, height: 840, minWidth: 800, minHeight: 600,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        partition, nodeIntegration: false, contextIsolation: true, sandbox: true,
        webSecurity: true, webviewTag: false, allowRunningInsecureContent: false,
        spellcheck: true
      }
    });
    const current = win;
    current.on('closed', () => { if (win === current) win = null; });
    current.webContents.on('will-navigate', (event, url) => {
      // Login may traverse other HTTPS providers; refuse filesystem/JS/data schemes.
      if (!safeNavigation(url)) event.preventDefault();
    });
    current.webContents.setWindowOpenHandler(({ url }) => {
      // Any popup remains user-controlled and uses the system browser.
      // Never automatically transfer cookies between browser profiles.
      if (safeNavigation(url) && /^https:\/\//i.test(url) && shell?.openExternal)
        Promise.resolve(shell.openExternal(url)).catch(() => {});
      return { action: 'deny' };
    });
    const isolatedSession = current.webContents.session;
    if (typeof isolatedSession?.setPermissionRequestHandler === 'function')
      isolatedSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    try {
      await current.loadURL(HOME);
      if (!current.isDestroyed()) current.show();
      return { opened: true, reused: false, embedded: true };
    } catch (error) {
      if (!current.isDestroyed()) current.destroy();
      throw new Error('ChatGPT 내장 화면을 열지 못했습니다: ' + error.message);
    }
  }
  return { open, getWindow: () => win, home: HOME, partition };
}

module.exports = { HOME, SESSION_PARTITION, safeNavigation, createEmbeddedChatGPTBrowser };
