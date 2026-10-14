'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertSettings, DEFAULT_SETTINGS, PATCH_IDS, readSettingsFileState, writeSettingsFile, settingsFilePath
} = require('./settings.cjs');
const { assertIsolatedTarget, createIsolatedTarget } = require('./isolated-target.cjs');
const { makeLilacAnimePatchPlan } = require('../patch-manager/adapters/lilacanime-independent.cjs');
const { readState, applyPersistent, rollbackPersistent } = require('../patch-manager/persistent.cjs');
const { hashBytes, readVerifiedFile } = require('../patch-manager/core.cjs');

function allDisabled() {
  return assertSettings(DEFAULT_SETTINGS);
}

function flagsEqual(left, right) {
  return PATCH_IDS.every(id => left.patches[id] === right.patches[id]);
}

function currentReceiptMatches(root, receipt) {
  if (!receipt || receipt.status !== 'applied') return false;
  try {
    return Object.entries(receipt.files || {}).every(([file, record]) =>
      hashBytes(readVerifiedFile(root, file)) === record.patchedSha256);
  } catch { return false; }
}

function getActiveState(root) {
  const saved = readSettingsFileState(root);
  const settings = saved.settings;
  const state = readState(root);
  const receipt = state.lastApplied?.status === 'applied' ? state.lastApplied : null;
  const legacyPatch05Receipt = typeof receipt?.patchSet === 'string' && /(?:-|\+)patch-05(?:\+|$)/.test(receipt.patchSet);
  return {
    settings, state, receipt,
    receiptMatches: receipt ? currentReceiptMatches(root, receipt) : false,
    legacyPatch05Migration: saved.legacyPatch05 || legacyPatch05Receipt
  };
}

function summarizePlan(plan) {
  return {
    status: plan.status,
    version: plan.version,
    profile: plan.profile,
    patches: Object.fromEntries(PATCH_IDS.map(id => {
      const patch = plan.patches[id];
      return [id, {
        selection: patch?.selection || 'off',
        status: patch?.status || 'blocked',
        needsIsolatedValidation: patch?.needsIsolatedValidation === true,
        issues: (patch?.issues || []).map(issue => ({
          kind: String(issue.kind || 'unknown'),
          file: typeof issue.file === 'string' ? issue.file : undefined
        }))
      }];
    }))
  };
}

function inspectTarget(targetRoot) {
  const root = assertIsolatedTarget(targetRoot);
  const { settings, state, receipt, receiptMatches, legacyPatch05Migration } = getActiveState(root);
  const settingsStored = fs.existsSync(settingsFilePath(root));
  if (receipt) {
    return {
      mode: receiptMatches ? 'applied' : 'modified-after-apply',
      version: receipt.version,
      profile: 'official-source-16c9a3d1-v0515',
      settings,
      settingsStored,
      legacyPatch05Migration,
      patches: Object.fromEntries(PATCH_IDS.map(id => [id, {
        selection: settings.patches[id] ? 'on' : 'off',
        status: receiptMatches ? (settings.patches[id] ? 'applied' : 'disabled') : 'blocked',
        issues: []
      }])),
      receiptId: receipt.id,
      backupAvailable: Boolean(receipt.files && Object.keys(receipt.files).length),
      latest: state.latest?.status || 'unknown'
    };
  }
  const plan = makeLilacAnimePatchPlan(root, { patches: Object.fromEntries(PATCH_IDS.map(id => [id, true])) });
  return {
    mode: 'ready',
    ...summarizePlan(plan),
    settings,
    settingsStored,
    legacyPatch05Migration,
    receiptId: null,
    backupAvailable: false,
    latest: state.latest?.status || 'not-applied'
  };
}

function canModify(targetRoot, options) {
  const callback = options?.isAppRunning || isIsolatedAppRunning;
  return !callback(targetRoot);
}

function isIsolatedAppRunning(targetRoot) {
  if (process.platform !== 'win32') throw new Error('격리 사본 실행 상태 확인은 Windows에서만 지원합니다.');
  const command = [
    "$target = [IO.Path]::GetFullPath($env:DINO_LILAC_TARGET_ROOT).TrimEnd([char]92)",
    "$running = Get-CimInstance Win32_Process -Filter \"name='LilacAnime.exe' OR name='electron.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1",
    "if ($running) { 'running' } else { 'stopped' }"
  ].join('; ');
  let output;
  try {
    output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', timeout: 6000, windowsHide: true,
      env: { ...process.env, DINO_LILAC_TARGET_ROOT: path.resolve(targetRoot) },
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    throw new Error('격리 대상 앱의 실행 여부를 확인할 수 없어 변경을 중단했습니다.');
  }
  if (output !== 'running' && output !== 'stopped') throw new Error('격리 대상 앱 상태를 확인하지 못해 변경을 중단했습니다.');
  return output === 'running';
}

function createTargetFromSource(sourceRoot) {
  return createIsolatedTarget(sourceRoot);
}

function applySettings(targetRoot, rawSettings, options = {}) {
  const root = assertIsolatedTarget(targetRoot);
  const requested = assertSettings(rawSettings);
  if (!canModify(root, options)) return { status: 'app-running', changed: false };
  let active = getActiveState(root);
  if (active.receipt && !active.receiptMatches) {
    return { status: 'modified-after-apply', changed: false, receiptId: active.receipt.id };
  }
  if (active.receipt && flagsEqual(active.settings, requested) && !active.legacyPatch05Migration) {
    return { status: 'already-applied', changed: false, receiptId: active.receipt.id, settings: active.settings };
  }
  if (active.receipt) {
    const rolledBack = rollbackPersistent(root, { isAppRunning: options.isAppRunning || isIsolatedAppRunning });
    if (rolledBack.status !== 'rolled-back') return { ...rolledBack, changed: false };
    writeSettingsFile(root, allDisabled());
    active = getActiveState(root);
  }

  if (!PATCH_IDS.some(id => requested.patches[id])) {
    writeSettingsFile(root, allDisabled());
    return { status: active.state.lastApplied?.status === 'rolled-back' ? 'rolled-back' : 'disabled', changed: Boolean(active.state.lastApplied?.status === 'rolled-back'), settings: allDisabled() };
  }

  const plan = makeLilacAnimePatchPlan(root, requested);
  const effective = { patches: Object.fromEntries(PATCH_IDS.map(id => [
    id, requested.patches[id] && plan.patches[id]?.status === 'structural-candidate'
  ])) };
  const blocked = PATCH_IDS.filter(id => requested.patches[id] && !effective.patches[id]);
  if (!plan.manifest || !PATCH_IDS.some(id => effective.patches[id])) {
    writeSettingsFile(root, allDisabled());
    return { status: 'blocked', changed: false, plan: summarizePlan(plan), blocked, settings: allDisabled() };
  }

  const result = applyPersistent(root, plan.manifest, { isAppRunning: options.isAppRunning || isIsolatedAppRunning });
  if (!['applied', 'already-applied'].includes(result.status)) return { ...result, plan: summarizePlan(plan), blocked };
  try {
    writeSettingsFile(root, effective);
  } catch (error) {
    const rollback = rollbackPersistent(root, { isAppRunning: options.isAppRunning || isIsolatedAppRunning });
    try { writeSettingsFile(root, allDisabled()); } catch {}
    throw new Error(rollback.status === 'rolled-back'
      ? `설정 저장에 실패해 패치 적용을 복구했습니다: ${error.message}`
      : `설정 저장과 패치 복구가 모두 완료되지 않았습니다 (${rollback.status}): ${error.message}`);
  }
  return {
    ...result,
    status: blocked.length ? 'partially-applied' : result.status,
    plan: summarizePlan(plan),
    blocked,
    settings: effective
  };
}

function restoreTarget(targetRoot, options = {}) {
  const root = assertIsolatedTarget(targetRoot);
  if (!canModify(root, options)) return { status: 'app-running', changed: false };
  const result = rollbackPersistent(root, { isAppRunning: options.isAppRunning || isIsolatedAppRunning });
  if (['rolled-back', 'nothing-to-rollback'].includes(result.status)) {
    writeSettingsFile(root, allDisabled());
    const state = readState(root);
    const lastReceipt = [...state.history].reverse().find(receipt => receipt.id === result.receiptId) || state.lastApplied;
    if (result.status === 'rolled-back' && lastReceipt && !Object.entries(lastReceipt.files || {}).every(([file, record]) => {
      if (!record.originalExists) return !fs.existsSync(path.join(root, ...file.split('/')));
      return hashBytes(readVerifiedFile(root, file)) === record.originalSha256;
    })) throw new Error('원본 백업과 복구된 파일의 SHA-256이 일치하지 않습니다.');
    return { ...result, settings: allDisabled(), restorationVerified: result.status === 'rolled-back' };
  }
  return result;
}

module.exports = {
  createTargetFromSource,
  inspectTarget,
  applySettings,
  restoreTarget,
  isIsolatedAppRunning
};
