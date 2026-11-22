const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow } = require('electron');
const { installPopupBlocker } = require('../electron/popup-policy.cjs');

const root = path.join(os.tmpdir(), `dino-popup-policy-${randomUUID()}`);
const isolatedPaths = Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.join(root, name)]));
for (const value of Object.values(isolatedPaths)) fs.mkdirSync(value, { recursive: true });
for (const [name, value] of Object.entries(isolatedPaths)) app.setPath(name, value);
for (const [name, value] of Object.entries(isolatedPaths)) assert.equal(path.resolve(app.getPath(name)), path.resolve(value));
assert.ok(Object.values(isolatedPaths).every(value => value.startsWith(path.resolve(os.tmpdir()))));
app.disableHardwareAcceleration();
installPopupBlocker(app);

const createdWindows = [];
app.on('browser-window-created', (_event, window) => createdWindows.push(window));
const hardDeadline = setTimeout(() => {
  console.error('Timed out validating popup policy in isolated Electron.');
  app.exit(124);
}, 15000);

app.whenReady().then(async () => {
  const opener = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await opener.loadURL('data:text/html,<button id="open" onclick="window.open(\'about:blank\')">open</button>');
  await opener.webContents.executeJavaScript("document.querySelector('#open').click()");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(createdWindows.length, 1, 'page-created popup must be denied');

  const appCreated = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  assert.equal(createdWindows.length, 2, 'the policy must not block an app-created BrowserWindow');
  console.log(JSON.stringify({
    result: 'PASS', electronVersion: process.versions.electron, mainPid: process.pid,
    appPaths: Object.fromEntries(Object.entries(isolatedPaths).map(([name]) => [name, path.resolve(app.getPath(name))])),
    explicitAppWindowCreated: !appCreated.isDestroyed(), pagePopupCount: createdWindows.length - 2
  }));
  clearTimeout(hardDeadline);
  opener.destroy(); appCreated.destroy(); app.quit();
}).catch(error => {
  clearTimeout(hardDeadline);
  console.error(error?.stack || error);
  app.exit(1);
});
