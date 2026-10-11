'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { hashBytes, inspect, readVerifiedFile } = require('../core.cjs');

const sourceRoot = process.env.LILAC_UPSTREAM_SOURCE || '';
const repoRoot = path.resolve(__dirname, '../..');
const patchBase = '64749271b8a57fad84ee52dae622c6bb7c1e294d';
const patch01 = 'b79a69a49521d80dd0c1a26915bbda624ea79366';
const patch02 = '2715f8158c37754448e89abc1552302d7706711c';
const anchorFiles = ['package.json', 'src/app.js', 'src/index.html', 'electron/main.cjs', 'electron/preload.cjs'];

function trackedBlob(relative) {
  return execFileSync('git', ['show', `${patchBase}:${relative}`], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
}

function dryRunPatch(target, commit) {
  const diff = execFileSync('git', ['diff', '--binary', '--no-ext-diff', patchBase, commit, '--', ':!WORK_STATE.md'], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024
  });
  return spawnSync('git', ['-C', target, 'apply', '--check', '-'], { input: diff, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

test('official v0.5.14 source rejects the legacy Patch 01/02 fingerprints without writes', {
  skip: !sourceRoot || !fs.existsSync(path.join(sourceRoot, 'package.json'))
}, () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, '0.5.14');
  const before = new Map(anchorFiles.map(file => [file, hashBytes(readVerifiedFile(sourceRoot, file))]));
  const mismatches = anchorFiles.filter(file => hashBytes(trackedBlob(file)) !== before.get(file));
  assert.ok(mismatches.includes('src/app.js'));
  assert.ok(mismatches.includes('src/index.html'));
  assert.ok(mismatches.includes('electron/main.cjs'));
  assert.ok(mismatches.includes('electron/preload.cjs'));

  const expectedFiles = Object.fromEntries(anchorFiles.map(file => [file, file === 'package.json'
    ? before.get(file)
    : hashBytes(trackedBlob(file))]));
  const eligibility = inspect(sourceRoot, {
    schema: 1,
    purpose: 'isolated-preview',
    version: '0.5.14',
    expectedFiles,
    actions: [{ kind: 'insert-before', file: 'src/app.js', anchor: '/* PATCH-01-SLOT */', content: '/* patch */\n' }]
  });
  assert.deepEqual(eligibility, { status: 'incompatible', reason: 'hash-mismatch', file: 'src/app.js' });

  const patch01Result = dryRunPatch(sourceRoot, patch01);
  const patch02Result = dryRunPatch(sourceRoot, patch02);
  assert.notEqual(patch01Result.status, 0, `Patch 01 unexpectedly applied: ${patch01Result.stdout}`);
  assert.notEqual(patch02Result.status, 0, `Patch 02 unexpectedly applied: ${patch02Result.stdout}`);
  assert.match(patch01Result.stderr, /electron\/main\.cjs|src\/app\.js|src\/index\.html/i);
  assert.match(patch02Result.stderr, /electron\/main\.cjs|src\/app\.js/i);
  for (const file of anchorFiles) assert.equal(hashBytes(readVerifiedFile(sourceRoot, file)), before.get(file), `${file} remained unchanged`);
  console.log(JSON.stringify({ version: packageJson.version, mismatches, patch01: patch01Result.stderr.trim(), patch02: patch02Result.stderr.trim() }, null, 2));
});
