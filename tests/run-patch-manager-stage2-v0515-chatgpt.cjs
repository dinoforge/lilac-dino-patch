'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createIsolatedTarget, assertIsolatedTarget, TARGET_MARKER } = require('../dino-lilac-patch/isolated-target.cjs');
const { makeLilacAnimePatchPlan } = require('../patch-manager/adapters/lilacanime-independent.cjs');
const { applyPersistent, rollbackPersistent } = require('../patch-manager/persistent.cjs');

if (process.platform !== 'win32') throw new Error('The official v0.5.15 isolated Electron test is Windows-only.');
const sourceRoot = process.env.LILAC_UPSTREAM_V0515_SOURCE;
if (!sourceRoot) throw new Error('Set LILAC_UPSTREAM_V0515_SOURCE to the clean pinned official v0.5.15 source clone.');
const repoRoot = path.resolve(__dirname, '..');
const electronCli = path.join(repoRoot, 'node_modules', 'electron', 'cli.js');
if (!fs.existsSync(electronCli)) throw new Error('Repository Electron runtime is unavailable.');
const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dino-patch02-chatgpt-test-'));
let target = null;
let exitCode = 1;

function ensureOwned(candidate, prefix) {
  const real = fs.realpathSync(candidate), temp = fs.realpathSync(os.tmpdir());
  const relative = path.relative(temp, real), stat = fs.lstatSync(real);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(stat.isSymbolicLink(), false);
  assert.ok(path.basename(real).startsWith(prefix));
  return real;
}

function removeOwnedFile(file, parent, namePrefix) {
  if (!fs.existsSync(file)) return;
  const parentReal = fs.realpathSync(parent);
  assert.equal(path.dirname(path.resolve(file)), parentReal);
  assert.ok(path.basename(file).startsWith(namePrefix));
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  fs.rmSync(file, { recursive: stat.isDirectory(), force: true });
}

try {
  ensureOwned(tempRoot, 'dino-patch02-chatgpt-test-');
  target = createIsolatedTarget(sourceRoot);
  const isolatedRoot = assertIsolatedTarget(target.root);
  const plan = makeLilacAnimePatchPlan(isolatedRoot, { patches: { 'patch-01': false, 'patch-02': true, 'patch-03': false } });
  assert.equal(plan.status, 'ready-for-isolated-application');
  assert.equal(plan.profile, 'official-source-16c9a3d1-v0515');
  assert.equal(plan.manifest.actions.some(action => action.file === 'src/integrated-search.js' || action.file === 'src/unified-catalog.js'), false);
  const applied = applyPersistent(isolatedRoot, plan.manifest);
  assert.equal(applied.status, 'applied');

  const child = spawnSync(process.execPath, [electronCli, path.join(__dirname, 'patch-manager-stage2-v0515-chatgpt.electron.cjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
    timeout: 120_000,
    env: { ...process.env, DINO_PATCH02_E2E_ROOT: tempRoot, DINO_PATCH02_E2E_TARGET: isolatedRoot }
  });
  if (child.error) throw child.error;
  exitCode = Number.isInteger(child.status) ? child.status : 1;
} catch (error) {
  console.error(error?.stack || error);
  exitCode = 1;
} finally {
  if (target) {
    try {
      const root = assertIsolatedTarget(target.root);
      rollbackPersistent(root);
      const managedParent = path.dirname(root);
      removeOwnedFile(root, managedParent, 'LilacAnime-0.5.15-');
      removeOwnedFile(`${root}${TARGET_MARKER}`, managedParent, `${path.basename(root)}${TARGET_MARKER}`);
      removeOwnedFile(`${root}.patch-manager`, managedParent, `${path.basename(root)}.patch-manager`);
    } catch (error) {
      console.error('isolated target cleanup failed:', error?.stack || error);
      exitCode = 1;
    }
  }
  try {
    const root = ensureOwned(tempRoot, 'dino-patch02-chatgpt-test-');
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    console.error('temporary profile cleanup failed:', error?.stack || error);
    exitCode = 1;
  }
}

process.exitCode = exitCode;
