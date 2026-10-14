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
    await waitFor('real manager preload and target state', () => win.webContents.executeJavaScript(`Boolean(window.dinoPatchManager && document.querySelector("#patch04") && !document.querySelector("#patch05") && document.querySelector("#targetPath").textContent.includes("LilacAnime-${sourceVersion}-"))`));
    const initial = await win.webContents.executeJavaScript('({patch01:document.querySelector("#patch01").checked,patch02:document.querySelector("#patch02").checked,patch03:document.querySelector("#patch03").checked,patch04:document.querySelector("#patch04").checked,patch05Visible:Boolean(document.querySelector("#patch05")),applyDisabled:document.querySelector("#apply").disabled,patch02Label:document.querySelector("label[for=patch02] strong").textContent})');
    assert.deepEqual(initial, { patch01: false, patch02: false, patch03: true, patch04: false, patch05Visible: false, applyDisabled: false, patch02Label: 'ChatGPT 자막 번역 (베타)' }, 'the manager exposes only Patch 01-04 and new source copies default to Patch 03');
    assert.match(await win.webContents.executeJavaScript('document.querySelector("label[for=patch02] small").textContent'), /수동 번역 및 SRT 전체 파일 자동 번역/);
    const combinations = [];
    for (const p1 of [false, true]) for (const p2 of [false, true]) for (const p3 of [false, true]) for (const p4 of [false, true]) {
      combinations.push({ 'patch-01': p1, 'patch-02': p2, 'patch-03': p3, 'patch-04': p4 });
    }
    const settingsValue = flags => ({ patches: flags });
    const settingsJson = () => JSON.parse(fs.readFileSync(path.join(target.root, 'DinoLilacPatch', 'settings.json'), 'utf8'));
    for (const flags of combinations) {
      const enabledCount = Object.values(flags).filter(Boolean).length;
      const ids = ['patch-01', 'patch-02', 'patch-03', 'patch-04'];
      await win.webContents.executeJavaScript(`(()=>{const flags=${JSON.stringify(flags)};const ids=${JSON.stringify(ids)};for(const patch of ids){const checkbox=document.querySelector('#patch'+patch.slice(-2));checkbox.checked=flags[patch];}window.confirm=()=>true;document.querySelector('#apply').click();})()`);
      await waitFor(`actual manager apply ${JSON.stringify(flags)}`, () => win.webContents.executeJavaScript('document.querySelector("#message").textContent.includes("적용 결과")'));
      let state = manager.inspectTarget(target.root);
      assert.deepEqual(state.settings, settingsValue(flags));
      assert.deepEqual(settingsJson(), settingsValue(flags), 'persisted settings contain only Patch 01-04');
      if (enabledCount) {
        const indexHtml = fs.readFileSync(path.join(target.root, 'src', 'index.html'), 'utf8');
        const mainSource = fs.readFileSync(path.join(target.root, 'electron', 'main.cjs'), 'utf8');
        const preloadSource = fs.readFileSync(path.join(target.root, 'electron', 'preload.cjs'), 'utf8');
        const flagsSource = fs.readFileSync(path.join(target.root, 'src', 'patch-manager-feature-flags.js'), 'utf8');
        assert.equal(indexHtml.includes('unified-catalog.js'), flags['patch-03']);
        assert.equal(indexHtml.includes('patch05-episode-quality.js'), flags['patch-03'], 'quality UI is integrated with Patch 03 only');
        assert.equal(fs.existsSync(path.join(target.root, 'src', 'patch05-episode-quality.css')), flags['patch-03']);
        assert.equal(fs.existsSync(path.join(target.root, 'electron', 'patch-manager-stage5.cjs')), flags['patch-03']);
        assert.equal(preloadSource.includes('patchEpisodeQuality'), flags['patch-03']);
        assert.equal(mainSource.includes('registerPatch05Handlers'), flags['patch-03']);
        assert.equal(flagsSource.includes('"patch-03":true'), flags['patch-03']);
        assert.equal(flagsSource.includes('patch-05'), false, 'no independent Patch 05 feature flag is emitted');
        assert.equal(fs.existsSync(path.join(target.root, 'src', 'patch04-playback-stats.js')), flags['patch-04']);
        assert.equal(fs.existsSync(path.join(target.root, 'src', 'weekday-schedule.js')), flags['patch-01']);
        assert.equal(fs.existsSync(path.join(target.root, 'src', 'manual-subtitle-translation.js')), flags['patch-02']);
        assert.equal(state.mode, 'applied');
        await win.webContents.executeJavaScript('document.querySelector("#restore").click()');
        await waitFor(`actual manager restore ${JSON.stringify(flags)}`, () => win.webContents.executeJavaScript('document.querySelector("#message").textContent.includes("복구 결과")'));
        state = manager.inspectTarget(target.root);
        assert.equal(state.mode, 'ready');
        assert.deepEqual(state.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': false, 'patch-04': false });
        assertOfficialFilesRestored(target.root, `restore ${JSON.stringify(flags)}`);
        for (const file of ['src/patch05-episode-quality.js', 'src/patch05-episode-quality.css', 'electron/patch-manager-stage5.cjs', 'src/patch04-playback-stats.js']) {
          assert.equal(fs.existsSync(path.join(target.root, ...file.split('/'))), false, `restore removes ${file}`);
        }
      } else {
        assert.equal(state.mode, 'ready', 'all OFF leaves the official source untouched');
        assertOfficialFilesRestored(target.root, 'all patches OFF');
      }
    }
    assertOfficialFilesRestored(target.root, 'all 16 apply/restore combinations');
    console.log('ISOLATED_DINO_PATCH_MANAGER_ELECTRON_RESULT=' + JSON.stringify({ ui: 'actual manager main+preload+renderer', target: `pinned official v${sourceVersion} temp copy`, newCopyDefault: initial, combinations: 16, applyRestore: 'all Patch 01-04 combinations through actual manager UI', patch03Quality: 'included iff Patch 03 ON', restore: 'tracked-source SHA-256 verified after each enabled combination', externalRequests: 0 }));
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
