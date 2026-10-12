'use strict';

// Persistent apply/reconcile/rollback is deliberately confined to marked trees
// under the OS temp folder. Production installation paths are not accepted.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { FIXTURE_MARKER, assertSyntheticFixture, noLinksRecursive, stageSynthetic } = require('./staging.cjs');
const { assertIsolatedTarget, stageIsolatedTarget } = require('../dino-lilac-patch/isolated-target.cjs');
const { hashBytes, readVerifiedFile, inspect } = require('./core.cjs');

const STATE_DIR = '.lilac-patch-manager';
const STATE_FILE = 'state.json';
const LOCK_FILE = 'lock';

function assertManagedTarget(root) {
  const full = path.resolve(root);
  return fs.existsSync(path.join(full, FIXTURE_MARKER)) || fs.existsSync(`${full}${FIXTURE_MARKER}`)
    ? assertSyntheticFixture(full)
    : assertIsolatedTarget(root);
}

function stageManagedTarget(root, manifest) {
  const full = path.resolve(root);
  return fs.existsSync(path.join(full, FIXTURE_MARKER)) || fs.existsSync(`${full}${FIXTURE_MARKER}`)
    ? stageSynthetic(full, manifest)
    : stageIsolatedTarget(root, manifest);
}

function statePaths(root) {
  const dir = `${path.resolve(root)}.patch-manager`;
  const state = path.join(dir, STATE_FILE), lock = path.join(dir, LOCK_FILE), backups = path.join(dir, 'backups');
  const assertPath = (target, kind) => {
    let stat;
    try { stat = fs.lstatSync(target); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) throw new Error('Patch manager state path is not a safe regular path');
    const actual = fs.realpathSync(target), expected = path.resolve(target);
    const fold = value => process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
    if (fold(actual) !== fold(expected)) throw new Error('Patch manager state path resolves outside its expected location');
  };
  assertPath(dir, 'directory');
  assertPath(state, 'file');
  assertPath(lock, 'file');
  assertPath(backups, 'directory');
  return { dir, state, lock, backups };
}

function readState(root) {
  assertManagedTarget(root);
  const { state } = statePaths(root);
  if (!fs.existsSync(state)) return { schema: 1, latest: null, lastApplied: null, history: [] };
  const stat = fs.lstatSync(state);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Patch state file is unsafe');
  const value = JSON.parse(fs.readFileSync(state, 'utf8'));
  if (value?.schema !== 1 || !Array.isArray(value.history)) throw new Error('Patch state file is invalid');
  return value;
}

function atomicWrite(file, bytes) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function writeState(root, value) {
  assertManagedTarget(root);
  const { dir, state } = statePaths(root);
  fs.mkdirSync(dir, { recursive: true });
  statePaths(root);
  atomicWrite(state, `${JSON.stringify(value, null, 2)}\n`);
}

function acquireLock(root) {
  assertManagedTarget(root);
  const { dir, lock } = statePaths(root);
  fs.mkdirSync(dir, { recursive: true });
  statePaths(root);
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
  fs.writeFileSync(descriptor, `${process.pid}\n`);
  fs.closeSync(descriptor);
  return () => { try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
}

function versionOf(root) {
  const pkg = JSON.parse(readVerifiedFile(root, 'package.json').toString('utf8'));
  return String(pkg.version || '');
}

function currentActionHash(root, action) {
  try { return hashBytes(readVerifiedFile(root, action.file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function candidateFingerprint(root, manifest) {
  const entries = { version: versionOf(root) };
  const files = new Set([...Object.keys(manifest.expectedFiles), ...manifest.actions.map(action => action.file)]);
  for (const file of [...files].sort()) {
    try { entries[file] = hashBytes(readVerifiedFile(root, file)); }
    catch (error) { entries[file] = `unreadable:${error.code || error.message}`; }
  }
  return hashBytes(JSON.stringify(entries));
}

function alreadyApplied(root, manifest, state) {
  const receipt = state.lastApplied;
  if (!receipt || receipt.status !== 'applied' || receipt.patchSet !== (manifest.patchSet || 'preview') || receipt.version !== manifest.version) return false;
  return Object.entries(receipt.files || {}).every(([file, record]) => currentActionHash(root, { file }) === record.patchedSha256);
}

function captureBackup(root, stageRoot, manifest, receiptId) {
  const { backups, dir: stateDir } = statePaths(root);
  fs.mkdirSync(backups, { recursive: true });
  statePaths(root);
  const backupDir = path.join(backups, receiptId);
  fs.mkdirSync(backupDir, { recursive: false });
  const files = {};
  for (const action of manifest.actions) {
    const target = path.join(root, ...action.file.split('/'));
    const staged = path.join(stageRoot, ...action.file.split('/'));
    const stagedBytes = fs.readFileSync(staged);
    const patchedSha256 = hashBytes(stagedBytes);
    if (fs.existsSync(target)) {
      const originalBytes = readVerifiedFile(root, action.file);
      const backup = path.join(backupDir, ...action.file.split('/'));
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, originalBytes, { flag: 'wx' });
      files[action.file] = { originalExists: true, originalSha256: hashBytes(originalBytes), patchedSha256, backup: path.relative(stateDir, backup).replace(/\\/g, '/') };
    } else {
      files[action.file] = { originalExists: false, originalSha256: null, patchedSha256, backup: null };
    }
  }
  return { backupDir, files };
}

function replaceTarget(root, relative, bytes) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWrite(target, bytes);
}

function applyStagedFiles(root, stageRoot, files) {
  for (const [relative, record] of Object.entries(files)) {
    const staged = path.join(stageRoot, ...relative.split('/'));
    replaceTarget(root, relative, fs.readFileSync(staged));
    if (currentActionHash(root, { file: relative }) !== record.patchedSha256) throw new Error(`Post-write verification failed: ${relative}`);
  }
}

function restoreReceiptFiles(root, receipt, { allowOriginal = false } = {}) {
  for (const [relative, record] of Object.entries(receipt.files || {})) {
    const current = currentActionHash(root, { file: relative });
    if (current !== record.patchedSha256 && !(allowOriginal && current === record.originalSha256)) {
      throw new Error(`Current file changed after patch; refusing to overwrite: ${relative}`);
    }
    if (record.originalExists) {
      const bytes = readVerifiedFile(statePaths(root).dir, record.backup);
      if (hashBytes(bytes) !== record.originalSha256) throw new Error(`Backup fingerprint mismatch: ${relative}`);
    }
  }
  for (const [relative, record] of Object.entries(receipt.files || {})) {
    const target = path.join(root, ...relative.split('/'));
    if (record.originalExists) {
      replaceTarget(root, relative, readVerifiedFile(statePaths(root).dir, record.backup));
    } else if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
}

function applyUnlocked(root, manifest, options = {}) {
  const base = assertManagedTarget(root);
  noLinksRecursive(base);
  if (options.isAppRunning?.(base)) return { status: 'app-running', changed: false };
  const state = readState(base);
  if (alreadyApplied(base, manifest, state)) return { status: 'already-applied', changed: false, receiptId: state.lastApplied.id };
  const eligibility = inspect(base, manifest);
  if (eligibility.status !== 'eligible-for-isolated-preview') return { ...eligibility, changed: false };

  const staged = stageManagedTarget(base, manifest);
  if (!['staged-synthetic-preview', 'staged-isolated-source'].includes(staged.status)) return { ...staged, changed: false };
  if (options.isAppRunning?.(base)) {
    fs.rmSync(staged.stageContainer, { recursive: true, force: true });
    return { status: 'app-running', changed: false };
  }
  const id = crypto.randomUUID();
  let receipt;
  try {
    const backup = captureBackup(base, staged.stagedRoot, manifest, id);
    receipt = {
      id,
      patchSet: manifest.patchSet || 'preview',
      version: manifest.version,
      createdAt: new Date().toISOString(),
      status: 'applying',
      files: backup.files
    };
    const applying = readState(base);
    applying.latest = { status: 'applying', receiptId: id };
    writeState(base, applying);
    applyStagedFiles(base, staged.stagedRoot, receipt.files);
    receipt.status = 'applied';
    const next = readState(base);
    next.lastApplied = receipt;
    next.history.push(receipt);
    next.latest = { status: 'applied', receiptId: id };
    writeState(base, next);
    return { status: 'applied', changed: true, receiptId: id, files: Object.keys(receipt.files) };
  } catch (error) {
    if (receipt) {
      try {
        restoreReceiptFiles(base, receipt, { allowOriginal: true });
        const failed = readState(base);
        failed.latest = { status: 'rolled-back-after-failure', receiptId: id, error: error.message };
        writeState(base, failed);
      } catch (restoreError) {
        const failed = readState(base);
        failed.latest = { status: 'manual-recovery-required', receiptId: id, error: error.message, restoreError: restoreError.message };
        writeState(base, failed);
        throw new AggregateError([error, restoreError], 'Patch failed and rollback needs manual recovery');
      }
    }
    throw error;
  } finally {
    fs.rmSync(staged.stageContainer, { recursive: true, force: true });
  }
}

function applyPersistent(root, manifest, options = {}) {
  const base = assertManagedTarget(root);
  const release = acquireLock(base);
  if (!release) return { status: 'manager-busy', changed: false };
  try { return applyUnlocked(base, manifest, options); }
  finally { release(); }
}

function rollbackPersistent(root, options = {}) {
  const base = assertManagedTarget(root);
  const release = acquireLock(base);
  if (!release) return { status: 'manager-busy', changed: false };
  try {
    noLinksRecursive(base);
    if (options.isAppRunning?.(base)) return { status: 'app-running', changed: false };
    const state = readState(base), receipt = state.lastApplied;
    if (!receipt || receipt.status !== 'applied') return { status: 'nothing-to-rollback', changed: false };
    restoreReceiptFiles(base, receipt);
    receipt.status = 'rolled-back';
    state.history = state.history.map(entry => entry.id === receipt.id ? { ...entry, status: 'rolled-back' } : entry);
    state.latest = { status: 'rolled-back', receiptId: receipt.id };
    writeState(base, state);
    return { status: 'rolled-back', changed: true, receiptId: receipt.id };
  } finally { release(); }
}

async function reconcileAfterUpdate(root, manifest, {
  updateCompleteConfirmed = false,
  isAppRunning = () => false,
  settleMs = 1500,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const base = assertManagedTarget(root);
  if (updateCompleteConfirmed !== true) return { status: 'update-not-confirmed', changed: false };
  const release = acquireLock(base);
  if (!release) return { status: 'manager-busy', changed: false };
  try {
    noLinksRecursive(base);
    if (isAppRunning(base)) return { status: 'app-running', changed: false };
    const first = candidateFingerprint(base, manifest);
    await delay(settleMs);
    if (isAppRunning(base)) return { status: 'app-running', changed: false };
    const second = candidateFingerprint(base, manifest);
    if (first !== second) {
      const state = readState(base);
      state.latest = { status: 'update-still-changing', checkedAt: new Date().toISOString() };
      writeState(base, state);
      return { status: 'update-still-changing', changed: false };
    }
    const state = readState(base);
    if (alreadyApplied(base, manifest, state)) return { status: 'already-applied', changed: false, receiptId: state.lastApplied.id };
    const eligibility = inspect(base, manifest);
    if (eligibility.status !== 'eligible-for-isolated-preview') {
      state.latest = { status: 'unsupported-update', checkedAt: new Date().toISOString(), reason: eligibility.reason, file: eligibility.file || null, version: eligibility.version || null };
      writeState(base, state);
      return { status: 'unsupported-update', changed: false, reason: eligibility.reason, file: eligibility.file || null, version: eligibility.version || null };
    }
    const result = applyUnlocked(base, manifest, { isAppRunning });
    return result.status === 'applied' ? { ...result, status: 'reapplied' } : result;
  } finally { release(); }
}

module.exports = { STATE_DIR, STATE_FILE, candidateFingerprint, readState, applyPersistent, rollbackPersistent, reconcileAfterUpdate };
