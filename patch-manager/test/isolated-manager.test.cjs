'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manager = require('../../dino-lilac-patch/manager-core.cjs');
const { TARGET_MARKER, assertIsolatedTarget } = require('../../dino-lilac-patch/isolated-target.cjs');
const { PATCH_IDS, settingsFilePath } = require('../../dino-lilac-patch/settings.cjs');
const { hashBytes, readVerifiedFile } = require('../core.cjs');

test('manager rejects arbitrary folders and permits no production-target path', () => {
  assert.throws(() => assertIsolatedTarget(fs.realpathSync(os.tmpdir())), /manager-created isolated source copy/);
  assert.throws(() => manager.createTargetFromSource(fs.realpathSync(os.tmpdir())), /official v0\.5\.15|clean Git checkout/);
});

const sourceRoot = process.env.DINO_LILAC_V0515_SOURCE;
test('pinned official source can be copied, independently patched, and hash-verified on restore', {
  skip: sourceRoot ? false : 'DINO_LILAC_V0515_SOURCE is required for the official-source integration check'
}, () => {
  const target = manager.createTargetFromSource(sourceRoot);
  const root = target.root;
  const targetReal = assertIsolatedTarget(root);
  assert.equal(targetReal, root);
  assert.notEqual(targetReal, fs.realpathSync(sourceRoot));
  const anchors = ['package.json', 'src/index.html', 'electron/main.cjs', 'electron/preload.cjs'];
  const originalHashes = Object.fromEntries(anchors.map(file => [file, hashBytes(readVerifiedFile(sourceRoot, file))]));
  try {
    const alias = `${root}-junction`;
    fs.symlinkSync(root, alias, 'junction');
    try { assert.throws(() => manager.inspectTarget(alias), /symlink or junction/); }
    finally { fs.unlinkSync(alias); }

    const stateLink = `${root}.patch-manager`;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-lilac-manager-state-outside-'));
    fs.symlinkSync(outside, stateLink, 'junction');
    try { assert.throws(() => manager.inspectTarget(root), /Patch manager state path/); }
    finally { fs.unlinkSync(stateLink); fs.rmSync(outside, { recursive: true, force: true }); }

    let state = manager.inspectTarget(root);
    assert.equal(state.mode, 'ready');
    assert.equal(state.settingsStored, false);
    assert.equal(fs.existsSync(settingsFilePath(root)), false);

    const refused = manager.applySettings(root, { patches: { 'patch-01': false, 'patch-02': false, 'patch-03': true } }, { isAppRunning: () => true });
    assert.equal(refused.status, 'app-running');
    assert.equal(fs.existsSync(settingsFilePath(root)), false);

    const patch03 = manager.applySettings(root, { patches: { 'patch-01': false, 'patch-02': false, 'patch-03': true } }, { isAppRunning: () => false });
    assert.equal(patch03.status, 'applied');
    assert.deepEqual(patch03.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': true });
    assert.match(fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8'), /unified-catalog\.js/);
    state = manager.inspectTarget(root);
    assert.equal(state.mode, 'applied');
    assert.equal(state.backupAvailable, true);

    const switchToA = manager.applySettings(root, { patches: { 'patch-01': true, 'patch-02': true, 'patch-03': false } }, { isAppRunning: () => false });
    assert.equal(switchToA.status, 'applied');
    assert.deepEqual(switchToA.settings.patches, { 'patch-01': true, 'patch-02': true, 'patch-03': false });
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8'), /unified-catalog\.js/);

    const restored = manager.restoreTarget(root, { isAppRunning: () => false });
    assert.equal(restored.status, 'rolled-back');
    assert.equal(restored.restorationVerified, true);
    for (const file of anchors) assert.equal(hashBytes(readVerifiedFile(root, file)), originalHashes[file], `${file} restored to its pinned source hash`);
    state = manager.inspectTarget(root);
    assert.equal(state.mode, 'ready');
    assert.deepEqual(state.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': false });
    assert.deepEqual(PATCH_IDS, ['patch-01', 'patch-02', 'patch-03']);
  } finally {
    assert.equal(assertIsolatedTarget(root), root, 'cleanup is limited to the manager-created temp copy');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}${TARGET_MARKER}`, { force: true });
    fs.rmSync(`${root}.patch-manager`, { recursive: true, force: true });
  }
});
