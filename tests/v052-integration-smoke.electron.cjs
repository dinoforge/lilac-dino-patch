const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-v052-startup-'));
const isolated = Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.join(root, name)]));
for (const value of Object.values(isolated)) fs.mkdirSync(value, { recursive: true });
for (const [name, value] of Object.entries(isolated)) app.setPath(name, value);
for (const [name, value] of Object.entries(isolated)) assert.equal(path.resolve(app.getPath(name)), path.resolve(value));
assert.ok(Object.values(isolated).every(value => path.resolve(value).startsWith(path.resolve(os.tmpdir()))));
app.disableHardwareAcceleration();

let window = null, loaded = false, finished = false;
const errors = [];
const stage = { startedAt: new Date().toISOString(), mainPid: process.pid, electron: process.versions.electron, isolated };
const timeout = setTimeout(() => {
  console.error(JSON.stringify({ ...stage, result: 'timeout', loaded, errors }));
  app.exit(124);
}, 25000);
app.on('browser-window-created', (_event, win) => {
  window = win;
  win.hide();
  stage.windowId = win.id;
  stage.rendererPid = win.webContents.getOSProcessId();
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(String(message)); });
  win.webContents.once('did-finish-load', async () => {
    loaded = true;
    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const state = await win.webContents.executeJavaScript(`({ready:document.readyState, schedule:!!document.querySelector('#scheduleSection'), tabs:document.querySelectorAll('#scheduleTabs [role="tab"]').length, seasonRail:!!document.querySelector('#seasonRail'), detailDialog:!!document.querySelector('#detailDialog')})`);
      stage.renderer = state;
      assert.equal(state.ready, 'complete');
      assert.equal(state.schedule, true);
      assert.equal(state.tabs, 7);
      assert.equal(state.seasonRail, true);
      assert.equal(state.detailDialog, true);
      assert.equal(errors.some(message => /Uncaught (?:TypeError|ReferenceError|SyntaxError)/.test(message)), false);
      stage.result = 'PASS';
      stage.appPathsMatch = Object.fromEntries(Object.keys(isolated).map(name => [name, path.resolve(app.getPath(name)) === path.resolve(isolated[name])]));
      console.log(`V052_STARTUP_SMOKE ${JSON.stringify(stage)}`);
      clearTimeout(timeout);
      finished = true;
      app.quit();
    } catch (error) {
      console.error(`V052_STARTUP_SMOKE ${JSON.stringify({ ...stage, result: 'FAIL', message: error.message, stack: error.stack, errors })}`);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});
process.on('uncaughtException', error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.stack || error); clearTimeout(timeout); app.exit(1); });
app.on('before-quit', () => { if (!finished) console.error(`V052_STARTUP_SMOKE ${JSON.stringify({ ...stage, result: 'QUIT_BEFORE_READY', loaded, errors })}`); });
require('../electron/main.cjs');
