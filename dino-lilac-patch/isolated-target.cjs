'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashBytes, readVerifiedFile } = require('../patch-manager/core.cjs');
const { noLinksRecursive, copyTree } = require('../patch-manager/staging.cjs');
const { makeLilacAnimePatchPlan } = require('../patch-manager/adapters/lilacanime-independent.cjs');

const TARGET_MARKER = '.dino-lilac-patch-mvp-target.json';
const TARGETS_RELATIVE = path.join('DinoLilacPatch-MVP', 'isolated-targets');
const OFFICIAL_V0515_PROFILE = 'official-source-16c9a3d1-v0515';
const OFFICIAL_V0515_COMMIT = '16c9a3d1631061a72831e0657434003940daf531';
const OFFICIAL_V0515_ORIGIN = 'https://github.com/whispelyn-byte/lilacanime-desktop.git';
const OFFICIAL_V0521_PROFILE = 'official-source-bf801196-v0521';
const OFFICIAL_V0521_COMMIT = 'bf80119686fd42d2fcf704ce4946e28461e09f60';
const OFFICIAL_SOURCE_PROFILES = Object.freeze([
  Object.freeze({ profile: OFFICIAL_V0515_PROFILE, version: '0.5.15', commit: OFFICIAL_V0515_COMMIT }),
  Object.freeze({ profile: OFFICIAL_V0521_PROFILE, version: '0.5.21', commit: OFFICIAL_V0521_COMMIT })
]);
const ALL_PATCHES = Object.freeze({ patches: { 'patch-01': true, 'patch-02': true, 'patch-03': true, 'patch-04': true } });
const SOURCE_CONTENT = Object.freeze(['package.json', 'package-lock.json', 'electron', 'src', 'build']);
const PROFILE_FILES = Object.freeze(['package.json', 'src/index.html', 'electron/main.cjs', 'electron/preload.cjs']);

function within(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function protectedRoots() {
  return [
    'D:\\LilacAnime',
    process.env.APPDATA && path.join(process.env.APPDATA, 'lilacanime-desktop'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'lilacanime-desktop-updater')
  ].filter(Boolean).map(value => path.resolve(value));
}

function assertNotProtected(candidate, label) {
  const full = path.resolve(candidate);
  const fold = value => process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  for (const protectedRoot of protectedRoots()) {
    const protectedKey = fold(protectedRoot), candidateKey = fold(full);
    if (candidateKey === protectedKey || within(protectedRoot, full) || within(full, protectedRoot)) {
      throw new Error(`${label} points to a protected LilacAnime installation or user-data path`);
    }
  }
  return full;
}

function targetsRoot() {
  const temp = fs.realpathSync(os.tmpdir());
  assertNotProtected(temp, 'OS temporary directory');
  return path.join(temp, TARGETS_RELATIVE);
}

function markerPath(root) {
  return `${path.resolve(root)}${TARGET_MARKER}`;
}

function sourceProfile(root) {
  const requested = path.resolve(root);
  const requestedStat = fs.lstatSync(requested);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) throw new Error('Select an official LilacAnime source directory without links');
  const full = assertNotProtected(fs.realpathSync(requested), 'Source directory');
  if (fs.existsSync(path.join(full, 'resources', 'app.asar'))) {
    throw new Error('Packaged app.asar installs are not supported by this MVP');
  }
  if (process.platform !== 'win32') throw new Error('The isolated source manager currently supports Windows only');
  let commit, origin, changes;
  try {
    const git = args => execFileSync('git', ['-C', full, ...args], { encoding: 'utf8', timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    commit = git(['rev-parse', 'HEAD']);
    origin = git(['remote', 'get-url', 'origin']).toLocaleLowerCase('en-US');
    changes = git(['status', '--porcelain', '--untracked-files=all']);
  } catch {
    throw new Error('공식 v0.5.15 또는 v0.5.21의 고정 커밋 체크아웃을 선택해 주세요.');
  }
  const official = OFFICIAL_SOURCE_PROFILES.find(item => item.commit === commit);
  if (!official || origin !== OFFICIAL_V0515_ORIGIN || changes) throw new Error('소스는 고정된 공식 v0.5.15 또는 v0.5.21 커밋이어야 합니다.');
  const runningCheck = [
    "$target = [IO.Path]::GetFullPath($env:DINO_LILAC_SOURCE_ROOT).TrimEnd([char]92)",
    "$running = Get-CimInstance Win32_Process -Filter \"name='LilacAnime.exe' OR name='electron.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1",
    "if ($running) { 'running' } else { 'stopped' }"
  ].join('; ');
  let runningState;
  try {
    runningState = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', runningCheck], {
      encoding: 'utf8', timeout: 6000, windowsHide: true,
      env: { ...process.env, DINO_LILAC_SOURCE_ROOT: full },
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    throw new Error('Could not verify whether the selected source app is running; refusing to copy it');
  }
  if (runningState !== 'stopped') throw new Error('Close the selected LilacAnime source app before making an isolated copy');
  const plan = makeLilacAnimePatchPlan(full, ALL_PATCHES);
  if (plan.profile !== official.profile || plan.version !== official.version ||
      Object.values(plan.patches).some(patch => patch.status !== 'structural-candidate')) {
    throw new Error(`공식 LilacAnime v${official.version} 구조 지문이 검토된 프로필과 일치하지 않습니다.`);
  }
  const sourceHashes = Object.fromEntries(PROFILE_FILES.map(file => [file, hashBytes(readVerifiedFile(full, file))]));
  return { root: full, profile: plan.profile, version: plan.version, sourceHashes };
}

function copySourceContent(sourceRoot, targetRoot) {
  for (const relative of SOURCE_CONTENT) {
    const source = path.join(sourceRoot, ...relative.split('/'));
    const destination = path.join(targetRoot, ...relative.split('/'));
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Source contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      copyTree(source, destination);
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    } else {
      throw new Error(`Source entry is not a regular file or directory: ${relative}`);
    }
  }
}

function copiedContentFingerprint(root) {
  const entries = {};
  const visit = relative => {
    const full = path.join(root, ...relative.split('/'));
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Source contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new Error(`Source contains a symlink: ${relative}/${entry.name}`);
        visit(`${relative}/${entry.name}`);
      }
      return;
    }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error(`Source contains unsupported content: ${relative}`);
    entries[relative] = hashBytes(fs.readFileSync(full));
  };
  for (const relative of SOURCE_CONTENT) visit(relative);
  return hashBytes(JSON.stringify(entries));
}

function createIsolatedTarget(sourceRoot) {
  const source = sourceProfile(sourceRoot);
  const sourceFingerprint = copiedContentFingerprint(source.root);
  const parent = targetsRoot();
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  if (parentReal !== path.resolve(parent) || fs.lstatSync(parent).isSymbolicLink()) {
    throw new Error('Isolated target directory must not use a symlink or junction');
  }
  const root = path.join(parentReal, `LilacAnime-${source.version}-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: false });
  try {
    copySourceContent(source.root, root);
    const sourceAgain = sourceProfile(source.root);
    if (sourceAgain.profile !== source.profile || sourceAgain.version !== source.version ||
        copiedContentFingerprint(source.root) !== sourceFingerprint || copiedContentFingerprint(root) !== sourceFingerprint) {
      throw new Error('Official source changed while its isolated copy was being created');
    }
    for (const file of PROFILE_FILES) {
      if (hashBytes(readVerifiedFile(root, file)) !== source.sourceHashes[file]) {
        throw new Error(`Isolated source copy verification failed: ${file}`);
      }
    }
    noLinksRecursive(root);
    const marker = {
      schema: 1,
      kind: 'manager-created-isolated-source',
      safety: 'os-temp-only-no-install-or-profile',
      root: path.basename(root),
      nonce: crypto.randomBytes(16).toString('hex'),
      profile: source.profile,
      version: source.version,
      sourceHashes: source.sourceHashes,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(markerPath(root), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
    return { root, profile: marker.profile, version: marker.version, marker: TARGET_MARKER };
  } catch (error) {
    // This path was created uniquely by this call and is still under the verified temp root.
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function assertIsolatedTarget(root) {
  const requested = path.resolve(root);
  const requestedStat = fs.lstatSync(requested);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) throw new Error('Isolated target must be selected directly and cannot use a symlink or junction');
  const full = fs.realpathSync(requested);
  const targets = targetsRoot();
  if (!fs.existsSync(targets)) throw new Error('Only a manager-created isolated source copy under the OS temp directory can be patched');
  const parent = fs.realpathSync(targets);
  if (parent !== path.resolve(targets) || !within(parent, full) || path.dirname(full) !== parent) {
    throw new Error('Only a manager-created isolated source copy under the OS temp directory can be patched');
  }
  const stat = fs.lstatSync(full);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Isolated target path is not a regular directory');
  noLinksRecursive(full);
  const markerFile = markerPath(full), markerStat = fs.lstatSync(markerFile);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 16_384) {
    throw new Error('Isolated target marker is unsafe');
  }
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (marker?.schema !== 1 || marker.kind !== 'manager-created-isolated-source' ||
      marker.safety !== 'os-temp-only-no-install-or-profile' || marker.root !== path.basename(full) ||
      !OFFICIAL_SOURCE_PROFILES.some(item => item.profile === marker.profile && item.version === marker.version) ||
      !/^[a-f0-9]{32}$/.test(marker.nonce) || !marker.sourceHashes ||
      PROFILE_FILES.some(file => !/^[a-f0-9]{64}$/.test(marker.sourceHashes[file] || ''))) {
    throw new Error('Isolated target marker is invalid or unsupported');
  }
  return full;
}

function stageIsolatedTarget(root, manifest) {
  const base = assertIsolatedTarget(root);
  const { inspect, renderPatchedSource } = require('../patch-manager/core.cjs');
  noLinksRecursive(base);
  const eligibility = inspect(base, manifest);
  if (eligibility.status !== 'eligible-for-isolated-preview') return { ...eligibility, stagedRoot: null };
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-lilac-patch-stage-'));
  const destination = path.join(container, 'app');
  try {
    copyTree(base, destination);
    for (const action of manifest.actions) {
      const file = path.join(destination, ...action.file.split('/'));
      if (action.kind === 'add-file') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(action.contentBase64, 'base64'), { flag: 'wx' });
      } else {
        const source = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, renderPatchedSource(source, action), 'utf8');
      }
    }
    return { status: 'staged-isolated-source', stagedRoot: destination, stageContainer: container, originalRootUnchanged: true };
  } catch (error) {
    fs.rmSync(container, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  TARGET_MARKER,
  OFFICIAL_V0515_PROFILE,
  OFFICIAL_V0515_COMMIT,
  OFFICIAL_V0521_PROFILE,
  OFFICIAL_V0521_COMMIT,
  OFFICIAL_SOURCE_PROFILES,
  SOURCE_CONTENT,
  PROFILE_FILES,
  copiedContentFingerprint,
  targetsRoot,
  sourceProfile,
  createIsolatedTarget,
  assertIsolatedTarget,
  stageIsolatedTarget
};
