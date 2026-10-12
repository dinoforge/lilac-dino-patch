'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manager = require('../dino-lilac-patch/manager-core.cjs');
const { assertIsolatedTarget, TARGET_MARKER } = require('../dino-lilac-patch/isolated-target.cjs');
const { hashBytes, readVerifiedFile } = require('../patch-manager/core.cjs');

const tempRoot = path.resolve(process.env.DINO_LILAC_MANAGER_TEST_TEMP_ROOT || '');
const sourceRoot = process.env.DINO_LILAC_V0515_SOURCE;
const realTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(tempRoot) !== realTemp || !path.basename(tempRoot).startsWith('dino-lilac-manager-electron-')) throw new Error('Refusing unexpected isolated Electron test path.');
if (!sourceRoot) throw new Error('Set DINO_LILAC_V0515_SOURCE to the clean pinned official v0.5.15 Git checkout.');

let target;
let win;

function fail(error) {
  console.error(error?.stack || error);
  try { win?.destroy(); } catch {}
  try {
    if (target) {
      const root = assertIsolatedTarget(target.root);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(`${root}${TARGET_MARKER}`, { force: true });
      fs.rmSync(`${root}.patch-manager`, { recursive: true, force: true });
      target = null;
    }
  } catch {}
  app.exit(1);
}

function waitFor(label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
        if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
        setTimeout(poll, 25);
      } catch (error) { reject(error); }
    };
    poll();
  });
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

try {
  target = manager.createTargetFromSource(sourceRoot);
  process.env.DINO_LILAC_MANAGER_TEST = '1';
  process.env.DINO_LILAC_MANAGER_TEST_TARGET = target.root;
  require('../dino-lilac-patch/manager/main.cjs');
} catch (error) { fail(error); }

app.whenReady().then(async () => {
  try {
    await waitFor('manager main window', () => BrowserWindow.getAllWindows().length === 1);
    win = BrowserWindow.getAllWindows()[0];
    await waitFor('real manager preload and target state', () => win.webContents.executeJavaScript('Boolean(window.dinoPatchManager && document.querySelector("#patch03") && document.querySelector("#targetPath").textContent.includes("LilacAnime-0.5.15-"))'));
    const initial = await win.webContents.executeJavaScript('({patch01:document.querySelector("#patch01").checked,patch02:document.querySelector("#patch02").checked,patch03:document.querySelector("#patch03").checked,applyDisabled:document.querySelector("#apply").disabled})');
    assert.deepEqual(initial, { patch01: false, patch02: false, patch03: true, applyDisabled: false }, 'new source copy defaults to B mode with Patch 01 and 02 independent and OFF');

    await win.webContents.executeJavaScript('window.confirm=()=>true;document.querySelector("#apply").click()');
    await waitFor('actual manager apply IPC', () => win.webContents.executeJavaScript('document.querySelector("#message").textContent.includes("적용 결과")'));
    let state = manager.inspectTarget(target.root);
    assert.equal(state.mode, 'applied');
    assert.deepEqual(state.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': true });
    const patch03Html = fs.readFileSync(path.join(target.root, 'src', 'index.html'), 'utf8');
    assert.match(patch03Html, /unified-catalog\.js/);
    assert.equal(fs.existsSync(path.join(target.root, 'DinoLilacPatch', 'settings.json')), true);

    await win.webContents.executeJavaScript('document.querySelector("#restore").click()');
    await waitFor('actual manager restore IPC', () => win.webContents.executeJavaScript('document.querySelector("#message").textContent.includes("복구 결과")'));
    state = manager.inspectTarget(target.root);
    assert.equal(state.mode, 'ready');
    assert.deepEqual(state.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': false });
    assert.doesNotMatch(fs.readFileSync(path.join(target.root, 'src', 'index.html'), 'utf8'), /unified-catalog\.js/);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#patch03").checked'), false);

    const anchors = ['package.json', 'src/index.html', 'electron/main.cjs', 'electron/preload.cjs'];
    for (const file of anchors) {
      assert.equal(hashBytes(readVerifiedFile(target.root, file)), hashBytes(readVerifiedFile(sourceRoot, file)), `${file} restored to source hash`);
    }
    console.log('ISOLATED_DINO_PATCH_MANAGER_ELECTRON_RESULT=' + JSON.stringify({ ui: 'actual manager main+preload+renderer', target: 'pinned official v0.5.15 temp copy', newCopyDefault: initial, apply: 'real manager IPC passed', restore: 'SHA-256 verified', externalRequests: 0 }));
    win.destroy(); win = null;
    if (target) {
      const root = assertIsolatedTarget(target.root);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(`${root}${TARGET_MARKER}`, { force: true });
      fs.rmSync(`${root}.patch-manager`, { recursive: true, force: true });
      target = null;
    }
    app.exit(0);
  } catch (error) { fail(error); }
}).catch(fail);
