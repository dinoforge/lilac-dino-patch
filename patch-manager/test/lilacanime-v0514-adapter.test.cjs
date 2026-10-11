'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  EXPECTED_FILES,
  PROMPT_HASHES,
  makeLilacAnimeV0514Manifest
} = require('../adapters/lilacanime-v0.5.14.cjs');
const { hashBytes, inspect } = require('../core.cjs');
const { cleanupSyntheticFixture } = require('../staging.cjs');
const { applyPersistent, rollbackPersistent, reconcileAfterUpdate } = require('../persistent.cjs');

const upstreamRoot = process.env.LILAC_UPSTREAM_SOURCE || '';
const upstreamAvailable = Boolean(upstreamRoot && fs.existsSync(path.join(upstreamRoot, '.git')));

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function trackedFiles(root) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer' });
  if (result.status !== 0) throw new Error(`Cannot enumerate isolated upstream source: ${result.stderr.toString('utf8')}`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function snapshot(root, files) {
  return Object.fromEntries(files.map(file => [file, sha256(fs.readFileSync(path.join(root, ...file.split('/'))))]));
}

function createMarkedSourceCopy(sourceRoot) {
  const temp = fs.realpathSync(os.tmpdir());
  const source = fs.realpathSync(sourceRoot);
  const relativeSource = path.relative(temp, source);
  assert.ok(relativeSource && !relativeSource.startsWith('..') && !path.isAbsolute(relativeSource),
    'upstream source must be the isolated temporary v0.5.14 clone');
  assert.notEqual(path.resolve(source), path.resolve('D:\\LilacAnime'));

  const files = trackedFiles(source);
  const root = fs.mkdtempSync(path.join(temp, 'lilac-v0514-patch-fixture-'));
  const marker = {
    root: path.basename(root),
    kind: 'synthetic',
    safety: 'no-real-installation',
    nonce: crypto.randomBytes(16).toString('hex')
  };
  try {
    for (const relative of files) {
      const sourceFile = path.join(source, ...relative.split('/'));
      const stat = fs.lstatSync(sourceFile);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `unsupported upstream entry: ${relative}`);
      const destination = path.join(root, ...relative.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(sourceFile, destination, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(`${root}.lilac-patch-manager-synthetic-fixture.json`, JSON.stringify(marker), { flag: 'wx' });
    fs.writeFileSync(path.join(root, '.lilac-patch-manager-synthetic-fixture.json'), JSON.stringify(marker), { flag: 'wx' });
    return { root, files, sourceRoot: source };
  } catch (error) {
    if (fs.existsSync(`${root}.lilac-patch-manager-synthetic-fixture.json`)) cleanupSyntheticFixture(root);
    else fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function withUpstreamFixture(fn) {
  const fixture = createMarkedSourceCopy(upstreamRoot);
  try {
    return await fn(fixture);
  } finally {
    cleanupSyntheticFixture(fixture.root);
  }
}

test('v0.5.14 adapter fingerprints the isolated official source and pins original prompt bytes', {
  skip: !upstreamAvailable && 'Set LILAC_UPSTREAM_SOURCE to the isolated official v0.5.14 clone'
}, async () => withUpstreamFixture(({ root }) => {
  const manifest = makeLilacAnimeV0514Manifest();
  assert.deepEqual(inspect(root, manifest), { status: 'eligible-for-isolated-preview', version: '0.5.14' });
  for (const [file, expected] of Object.entries(EXPECTED_FILES)) {
    assert.equal(hashBytes(fs.readFileSync(path.join(root, ...file.split('/')))), expected, file);
  }
  for (const [name, expected] of Object.entries(PROMPT_HASHES)) {
    const projectPrompt = path.join(__dirname, '..', '..', 'docs', 'prompts', name);
    assert.equal(sha256(fs.readFileSync(projectPrompt)), expected, name);
    const action = manifest.actions.find(item => item.kind === 'add-file' && item.file.endsWith(name));
    assert.ok(action, `prompt payload missing: ${name}`);
    assert.equal(sha256(Buffer.from(action.contentBase64, 'base64')), expected, name);
  }
}));

test('patch 01/02 applies only to a marked v0.5.14 copy and rollback restores every source byte', {
  skip: !upstreamAvailable && 'Set LILAC_UPSTREAM_SOURCE to the isolated official v0.5.14 clone'
}, async () => withUpstreamFixture(({ root, files, sourceRoot }) => {
  const manifest = makeLilacAnimeV0514Manifest();
  const before = snapshot(sourceRoot, files);
  const result = applyPersistent(root, manifest);
  assert.equal(result.status, 'applied');
  assert.deepEqual(snapshot(sourceRoot, files), before, 'the isolated upstream source clone must remain read-only');
  assert.match(fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8'), /registerPatch0102Handlers/);
  assert.match(fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8'), /patchSaveManualSubtitle/);
  assert.match(fs.readFileSync(path.join(root, 'electron', 'subtitle-store.cjs'), 'utf8'), /'chatgpt'/);
  assert.match(fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8'),
    /patch-manager-stage2-core\.js[\s\S]*weekday-schedule\.js[\s\S]*manual-subtitle-translation\.js[\s\S]*patch-manager-stage2\.js/);
  for (const action of manifest.actions.filter(item => item.kind === 'add-file')) {
    assert.ok(fs.existsSync(path.join(root, ...action.file.split('/'))), action.file);
  }

  const rollback = rollbackPersistent(root);
  assert.equal(rollback.status, 'rolled-back');
  assert.deepEqual(snapshot(root, files), before);
  for (const action of manifest.actions.filter(item => item.kind === 'add-file')) {
    assert.equal(fs.existsSync(path.join(root, ...action.file.split('/'))), false, action.file);
  }
}));

test('unsupported upstream version is left byte-for-byte untouched after update reconciliation', {
  skip: !upstreamAvailable && 'Set LILAC_UPSTREAM_SOURCE to the isolated official v0.5.14 clone'
}, async () => withUpstreamFixture(async ({ root }) => {
  const manifest = makeLilacAnimeV0514Manifest();
  assert.equal(applyPersistent(root, manifest).status, 'applied');
  const packageFile = path.join(root, 'package.json');
  const htmlFile = path.join(root, 'src', 'index.html');
  fs.writeFileSync(packageFile, JSON.stringify({ name: 'LilacAnime', version: '0.5.15' }, null, 2) + '\n');
  fs.writeFileSync(htmlFile, '<!doctype html>\n<!-- synthetic updater output -->\n');
  const packageBefore = fs.readFileSync(packageFile);
  const htmlBefore = fs.readFileSync(htmlFile);
  const result = await reconcileAfterUpdate(root, manifest, {
    updateCompleteConfirmed: true,
    settleMs: 0
  });
  assert.equal(result.status, 'unsupported-update');
  assert.equal(result.reason, 'version-unverified');
  assert.deepEqual(fs.readFileSync(packageFile), packageBefore);
  assert.deepEqual(fs.readFileSync(htmlFile), htmlBefore);
}));
