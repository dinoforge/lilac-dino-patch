'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manager = require('../dino-lilac-patch/manager-core.cjs');
const { assertIsolatedTarget, TARGET_MARKER } = require('../dino-lilac-patch/isolated-target.cjs');
const { hashBytes, readVerifiedFile } = require('../patch-manager/core.cjs');

const tempRoot = path.resolve(process.env.DINO_LILAC_MANAGER_TEST_TEMP_ROOT || '');
const sourceRoot = process.env.DINO_LILAC_SOURCE_ROOT || process.env.DINO_LILAC_V0515_SOURCE;
const realTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(tempRoot) !== realTemp || !path.basename(tempRoot).startsWith('dino-lilac-manager-electron-')) throw new Error('Refusing unexpected isolated Electron test path.');
if (!sourceRoot) throw new Error('Set DINO_LILAC_SOURCE_ROOT to a clean pinned official v0.5.15 or v0.5.21 Git checkout.');
const sourceVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
const officialFiles = execFileSync('git', ['-C', sourceRoot, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(file =>
  file === 'package.json' || file === 'package-lock.json' || /^(?:electron|src|build)\//.test(file)
);

function assertOfficialFilesRestored(targetRoot, label) {
  for (const file of officialFiles) {
    assert.equal(hashBytes(readVerifiedFile(targetRoot, file)), hashBytes(readVerifiedFile(sourceRoot, file)), `${label}: ${file} matches the official source SHA-256`);
  }
}

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
    await waitFor('real manager preload and target state', () => win.webContents.executeJavaScript(`Boolean(window.dinoPatchManager && document.querySelector("#patch05") && document.querySelector("#targetPath").textContent.includes("LilacAnime-${sourceVersion}-"))`));
    const initial = await win.webContents.executeJavaScript('({patch01:document.querySelector("#patch01").checked,patch02:document.querySelector("#patch02").checked,patch03:document.querySelector("#patch03").checked,patch04:document.querySelector("#patch04").checked,patch05:document.querySelector("#patch05").checked,applyDisabled:document.querySelector("#apply").disabled,patch02Label:document.querySelector("label[for=patch02] strong").textContent})');
    assert.deepEqual(initial, { patch01: false, patch02: false, patch03: true, patch04: false, patch05: false, applyDisabled: false, patch02Label: 'ChatGPT 자막 번역 (베타)' }, 'new source copy defaults to B mode; five independent switches are visible');
    assert.match(await win.webContents.executeJavaScript('document.querySelector("label[for=patch02] small").textContent'), /수동 번역 및 SRT 전체 파일 자동 번역/);

    await win.webContents.executeJavaScript('window.confirm=()=>true;document.querySelector("#apply").click()');
    await waitFor('actual manager apply IPC', () => win.webContents.executeJavaScript('document.querySelector("#message").textContent.includes("적용 결과")'));
    let state = manager.inspectTarget(target.root);
    assert.equal(state.mode, 'applied');
    assert.deepEqual(state.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': true, 'patch-04': false, 'patch-05': false });
    const patch03Html = fs.readFileSync(path.join(target.root, 'src', 'index.html'), 'utf8');
    assert.match(patch03Html, /unified-catalog\.js/);
    assert.equal(fs.existsSync(path.join(target.root, 'DinoLilacPatch', 'settings.json')), true);

    await win.webContents.executeJavaScript('document.querySelector("#restore").click()');
    await waitFor('actual manager restore IPC', () => win.webContents.executeJavaScript('document.querySelector("#message").textContent.includes("복구 결과")'));
    state = manager.inspectTarget(target.root);
    assert.equal(state.mode, 'ready');
    assert.deepEqual(state.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': false, 'patch-04': false, 'patch-05': false });
    assertOfficialFilesRestored(target.root, 'Patch 03 restore');
    assert.doesNotMatch(fs.readFileSync(path.join(target.root, 'src', 'index.html'), 'utf8'), /unified-catalog\.js/);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#patch03").checked'), false);

    const applySingle = async (checkboxId, patchId, expectedPayload, expectedAnchor) => {
      await win.webContents.executeJavaScript(`(()=>{for(const id of ['patch01','patch02','patch03','patch04','patch05'])document.querySelector('#'+id).checked=false;document.querySelector('#${checkboxId}').checked=true;window.confirm=()=>true;document.querySelector('#apply').click();})()`);
      await waitFor(`${patchId} manager apply`, () => win.webContents.executeJavaScript('document.querySelector("#message").textContent.includes("적용 결과")'));
      const appliedState = manager.inspectTarget(target.root);
      assert.equal(appliedState.settings.patches[patchId], true);
      assert.equal(fs.existsSync(path.join(target.root, ...expectedPayload.split('/'))), true, `${patchId} payload is part of the real manager application`);
      assert.match(fs.readFileSync(path.join(target.root, ...expectedAnchor.file.split('/')), 'utf8'), expectedAnchor.pattern);
      await win.webContents.executeJavaScript('document.querySelector("#restore").click()');
      await waitFor(`${patchId} manager restore`, () => win.webContents.executeJavaScript('document.querySelector("#message").textContent.includes("복구 결과")'));
      assert.equal(manager.inspectTarget(target.root).mode, 'ready');
      assert.equal(fs.existsSync(path.join(target.root, ...expectedPayload.split('/'))), false, `${patchId} payload is removed by restore`);
      assertOfficialFilesRestored(target.root, `${patchId} restore`);
    };
    await applySingle('patch01', 'patch-01', 'src/weekday-schedule.js', { file: 'src/index.html', pattern: /weekday-schedule\.js/ });
    await applySingle('patch02', 'patch-02', 'src/manual-subtitle-translation.js', { file: 'src/index.html', pattern: /manual-subtitle-translation\.js/ });
    await applySingle('patch04', 'patch-04', 'src/patch04-playback-stats.js', { file: 'src/index.html', pattern: /patch04-playback-stats\.js/ });
    await applySingle('patch05', 'patch-05', 'electron/patch-manager-stage5.cjs', { file: 'electron/preload.cjs', pattern: /patchEpisodeQuality/ });

    assertOfficialFilesRestored(target.root, 'all individual patch restores');
    console.log('ISOLATED_DINO_PATCH_MANAGER_ELECTRON_RESULT=' + JSON.stringify({ ui: 'actual manager main+preload+renderer', target: `pinned official v${sourceVersion} temp copy`, newCopyDefault: initial, apply: 'Patch 01-05 independently applied through actual manager UI and restored', restore: 'SHA-256 verified', externalRequests: 0 }));
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
