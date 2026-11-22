'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const safety = require('../scripts/patch03-validation-safety.cjs');
const { parseArgs } = require('../scripts/validate-patch03-clean-source.cjs');

const projectRoot = path.resolve(__dirname, '..');

test('validation targets must be a canonical child of OS Temp and must not overlap the developer project', t => {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const targetRoot = fs.mkdtempSync(path.join(tempRoot, 'lilac-safety-target-'));
  t.after(() => fs.rmSync(targetRoot, { recursive: true, force: true }));

  assert.equal(safety.assertIsolatedTempTarget({ projectRoot, targetRoot, tempRoot }).targetRoot, fs.realpathSync.native(targetRoot));
  assert.throws(() => safety.assertIsolatedTempTarget({ projectRoot, targetRoot: projectRoot, tempRoot }), /child of the verified OS Temp root|overlaps the development project/);
  assert.throws(() => safety.assertIsolatedTempTarget({ projectRoot, targetRoot: path.join(projectRoot, 'validation'), tempRoot }), /child of the verified OS Temp root|overlaps the development project/);
  assert.throws(() => safety.assertIsolatedTempTarget({ projectRoot, targetRoot: path.dirname(projectRoot), tempRoot }), /child of the verified OS Temp root|overlaps the development project/);
});

test('the validator requires its exact project working directory before any installation option can be used', () => {
  assert.throws(() => safety.assertProjectWorkingDirectory(projectRoot, os.tmpdir()), /unexpected working directory/);
  assert.doesNotThrow(() => safety.assertProjectWorkingDirectory(projectRoot, process.cwd()));
});

test('dependency installation is opt-in and cannot be silently enabled by the default arguments', () => {
  assert.equal(parseArgs([]).installDependencies, false);
  assert.equal(safety.installRequested([]), false);
  assert.equal(parseArgs(['--archive', 'source.zip']).installDependencies, false);
  assert.equal(parseArgs(['--archive', 'source.zip', '--install-dependencies']).installDependencies, true);
  assert.throws(() => parseArgs(['--dependencies-from', 'C:\\temp\\deps', '--install-dependencies']), /Choose either/);
  assert.throws(() => parseArgs(['--run-electron']), /needs an explicit/);
});

test('npm-install identity must be outside the app tree and match the pinned official package', t => {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const sessionRoot = fs.mkdtempSync(path.join(tempRoot, 'lilac-install-guard-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  const targetRoot = path.join(sessionRoot, 'official-source');
  fs.mkdirSync(targetRoot);
  fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({ version: '0.5.54' }));
  fs.writeFileSync(path.join(targetRoot, 'package-lock.json'), '{}');
  const identityFile = path.join(sessionRoot, 'identity.json');
  fs.writeFileSync(identityFile, JSON.stringify({
    targetRoot,
    officialVersion: '0.5.54',
    officialCommit: 'e4ac62214f5c4863eebae5052633e7f9f33dcbaa',
    archiveSha256: '0'.repeat(64)
  }));
  const validated = safety.assertInstallIdentity({
    projectRoot,
    targetRoot,
    tempRoot,
    identityFile,
    expectedVersion: '0.5.54',
    expectedCommit: 'e4ac62214f5c4863eebae5052633e7f9f33dcbaa'
  });
  assert.equal(validated.targetRoot, fs.realpathSync.native(targetRoot));
  assert.throws(() => safety.assertInstallIdentity({
    projectRoot,
    targetRoot: projectRoot,
    tempRoot,
    identityFile,
    expectedVersion: '0.5.54',
    expectedCommit: 'e4ac62214f5c4863eebae5052633e7f9f33dcbaa'
  }), /OS Temp root|child of the verified OS Temp root|overlaps the development project/);
});
