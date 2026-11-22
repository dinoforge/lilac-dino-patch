'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ORIGIN = 'file://';
const PROFILE_PROCESS_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
$ignored = [System.Collections.Generic.HashSet[int]]::new()
$managerPid = 0
if ([int]::TryParse($env:DINO_THEME_MANAGER_PID, [ref]$managerPid) -and $managerPid -gt 0) { [void]$ignored.Add($managerPid) }
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($process in $processes) {
    $id = [int]$process.ProcessId
    if (-not $ignored.Contains($id) -and $ignored.Contains([int]$process.ParentProcessId)) {
      [void]$ignored.Add($id)
      $changed = $true
    }
  }
}
$active = @($processes | Where-Object {
  $id = [int]$_.ProcessId
  if ($ignored.Contains($id)) { return $false }
  if ($_.Name -ieq $env:DINO_THEME_OFFICIAL_EXE) { return $true }
  # Source runs use electron.exe; block conservatively if another instance is
  # present because WMI cannot reliably prove which profile it has open.
  if ($_.Name -ieq 'electron.exe') { return $true }
  return $false
} | ForEach-Object { [pscustomobject]@{ processId = [int]$_.ProcessId; name = [string]$_.Name } })
ConvertTo-Json -InputObject ([pscustomobject]@{ active = $active }) -Depth 3 -Compress
`;

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function sameWindowsPath(left, right) {
  return path.resolve(left).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
    === path.resolve(right).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
}

function fail(reason) {
  return { status: 'FALLBACK', reason, readOnly: true };
}

function getSourceContract(root) {
  const canonicalRoot = fs.realpathSync.native(root);
  const packagePath = path.join(canonicalRoot, 'package.json');
  const rendererPath = path.join(canonicalRoot, 'src', 'app.js');
  const mainPath = path.join(canonicalRoot, 'electron', 'main.cjs');
  for (const item of [packagePath, rendererPath, mainPath]) {
    if (!fs.statSync(item).isFile()) throw new Error('required source file missing');
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const renderer = fs.readFileSync(rendererPath, 'utf8');
  const main = fs.readFileSync(mainPath, 'utf8');
  if (!/localStorage\.getItem\(\s*['"]theme['"]\s*\)/.test(renderer)
      || !/localStorage\.setItem\(\s*['"]theme['"]/.test(renderer)
      || !/\.loadFile\s*\(/.test(main)) {
    throw new Error('official theme storage contract is not recognized');
  }
  if (/app\.setPath\s*\(\s*['"](?:userData|sessionData)['"]/.test(main)) {
    throw new Error('official profile path is explicitly overridden');
  }
  const appName = String(packageJson.productName || packageJson.name || '').trim();
  if (!appName || appName === '.' || appName === '..' || path.basename(appName) !== appName || /[\\/]/.test(appName)) {
    throw new Error('official Electron app name is invalid');
  }
  const executableName = String((packageJson.build && packageJson.build.productName) || packageJson.productName || appName).trim() + '.exe';
  if (path.basename(executableName) !== executableName || /[\\/]/.test(executableName)) {
    throw new Error('official executable name is invalid');
  }
  return { canonicalRoot, appName, executableName };
}

function inspectRunningProcesses({ officialExeName, managerPid, powershellPath = 'powershell.exe' }) {
  if (process.platform !== 'win32') return { status: 'UNKNOWN', reason: 'Windows 프로세스 상태를 확인할 수 없는 운영체제입니다.' };
  const result = spawnSync(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROFILE_PROCESS_QUERY], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    shell: false,
    env: { ...process.env, DINO_THEME_MANAGER_PID: String(managerPid || process.pid), DINO_THEME_OFFICIAL_EXE: officialExeName },
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) return { status: 'UNKNOWN', reason: '공식 프로필 사용 프로세스 상태를 확인하지 못했습니다.' };
  try {
    const payload = JSON.parse(String(result.stdout || '').trim());
    const active = Array.isArray(payload.active) ? payload.active : (payload.active ? [payload.active] : []);
    if (active.length) return { status: 'BUSY', reason: '공식 앱 또는 다른 Electron 프로세스가 실행 중이어서 프로필 복사와 읽기를 건너뛰었습니다.' };
    return { status: 'SAFE' };
  } catch {
    return { status: 'UNKNOWN', reason: '공식 프로필 사용 프로세스 확인 결과를 해석하지 못했습니다.' };
  }
}

function dbInventory(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (!entries.length) throw new Error('LevelDB directory is empty');
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name === '.' || entry.name === '..') {
      throw new Error('LevelDB directory contains a non-regular entry');
    }
    const fullPath = path.join(directory, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('LevelDB file is not regular');
    records.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, sha256: fileDigest(fullPath) });
  }
  records.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const current = records.find((entry) => entry.name === 'CURRENT');
  if (!current) throw new Error('LevelDB CURRENT file is missing');
  const manifestName = fs.readFileSync(path.join(directory, 'CURRENT'), 'utf8').trim();
  if (!/^MANIFEST-\d+$/.test(manifestName) || !records.some((entry) => entry.name === manifestName)) {
    throw new Error('LevelDB manifest reference is invalid');
  }
  return records;
}

function fileDigest(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function createStableSnapshot(sourceDirectory, tempRoot = os.tmpdir()) {
  const osTemp = fs.realpathSync.native(tempRoot);
  const snapshotRoot = fs.mkdtempSync(path.join(osTemp, 'DinoThemeLevelDB-'));
  const canonicalSnapshot = fs.realpathSync.native(snapshotRoot);
  if (canonicalSnapshot === osTemp || !isWithin(canonicalSnapshot, osTemp)) {
    throw new Error('LevelDB snapshot path is outside OS Temp');
  }
  try {
    const before = dbInventory(sourceDirectory);
    for (const entry of before) {
      const from = path.join(sourceDirectory, entry.name);
      const to = path.join(canonicalSnapshot, entry.name);
      if (fileDigest(from) !== entry.sha256) throw new Error('LevelDB source changed before snapshot copy');
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      if (fileDigest(to) !== entry.sha256) throw new Error('LevelDB snapshot file digest mismatch');
    }
    const after = dbInventory(sourceDirectory);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('LevelDB changed during snapshot');
    return canonicalSnapshot;
  } catch (error) {
    fs.rmSync(canonicalSnapshot, { recursive: true, force: true });
    throw error;
  }
}

function encodeDomStorageKey(text, format) {
  if (format === 1) return Buffer.concat([Buffer.from([1]), Buffer.from(text, 'latin1')]);
  if (format === 0) return Buffer.concat([Buffer.from([0]), Buffer.from(text, 'utf16le')]);
  throw new Error('unsupported Chromium string format');
}

function decodeDomStorageString(value) {
  const bytes = Buffer.from(value || []);
  if (bytes.length < 2) return null;
  const format = bytes[0];
  if (format === 1) return bytes.subarray(1).toString('latin1');
  if (format === 0 && (bytes.length - 1) % 2 === 0) return bytes.subarray(1).toString('utf16le');
  return null;
}

function decodeVersion(value) {
  if (value === undefined) return null;
  return Buffer.from(value).toString('ascii');
}

async function loadClassicLevel(options) {
  if (options.createDb) return options.createDb;
  const modulePath = options.moduleRoot
    ? path.join(options.moduleRoot, 'classic-level')
    : 'classic-level';
  const loaded = require(modulePath);
  if (!loaded || typeof loaded.ClassicLevel !== 'function') throw new Error('classic-level API is unavailable');
  return (location, dbOptions) => new loaded.ClassicLevel(location, dbOptions);
}

async function readOfficialLevelDbTheme(rootValue, options = {}) {
  let profile;
  try {
    profile = getSourceContract(rootValue);
  } catch (error) {
    return fail(`공식 테마 저장 구조를 확인하지 못했습니다 (${error.message === 'official theme storage contract is not recognized' ? '저장 계약 불일치' : '원본 구조 오류'}).`);
  }

  const appDataValue = String(options.appDataRoot || process.env.APPDATA || '').trim();
  if (!appDataValue) return fail('Windows APPDATA 경로를 확인할 수 없어 공식 테마 저장소를 읽지 않았습니다.');
  let appData;
  try {
    appData = fs.realpathSync.native(appDataValue);
  } catch {
    return fail('공식 APPDATA 경로를 확인할 수 없어 테마를 읽지 않았습니다.');
  }
  const profileDirectory = path.join(appData, profile.appName);
  const localStorageDirectory = path.join(profileDirectory, 'Local Storage');
  const levelDbDirectory = path.join(localStorageDirectory, 'leveldb');
  try {
    for (const directory of [profileDirectory, localStorageDirectory, levelDbDirectory]) {
      let stat;
      try {
        stat = fs.lstatSync(directory);
      } catch (error) {
        if (error && error.code === 'ENOENT') return { status: 'NOT_PRESENT', readOnly: true };
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return fail('공식 Chromium 프로필 경로에 링크 또는 지원하지 않는 구조가 있어 읽기를 중단했습니다.');
      const canonicalDirectory = fs.realpathSync.native(directory);
      if (!isWithin(canonicalDirectory, appData) || !sameWindowsPath(canonicalDirectory, directory)) {
        return fail('Chromium 프로필 경로가 공식 APPDATA 아래의 실제 저장소와 일치하지 않아 읽기를 중단했습니다.');
      }
    }
  } catch {
    return fail('공식 Chromium LevelDB 경로를 안전하게 확인하지 못했습니다.');
  }

  const detectRunning = options.detectRunning || inspectRunningProcesses;
  let processState;
  try {
    processState = await Promise.resolve(detectRunning({
      officialExeName: profile.executableName,
      managerPid: options.managerPid || process.pid,
      powershellPath: options.powershellPath,
    }));
  } catch {
    return fail('공식 프로필 사용 상태를 확인하지 못해 LevelDB를 읽지 않았습니다.');
  }
  if (!processState || processState.status !== 'SAFE') {
    return fail(processState && processState.reason ? processState.reason : '공식 앱 종료 여부를 확인하지 못해 LevelDB를 읽지 않았습니다.');
  }

  let snapshotRoot = null;
  let db = null;
  try {
    snapshotRoot = createStableSnapshot(levelDbDirectory, options.tempRoot || os.tmpdir());
    const processAfterCopy = await Promise.resolve(detectRunning({
      officialExeName: profile.executableName,
      managerPid: options.managerPid || process.pid,
      powershellPath: options.powershellPath,
    }));
    if (!processAfterCopy || processAfterCopy.status !== 'SAFE') throw new Error('프로필 사용 프로세스가 복사 중 감지되었습니다.');

    const createDb = await loadClassicLevel(options);
    db = createDb(snapshotRoot, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
      createIfMissing: false,
      errorIfExists: false,
    });
    await db.open();
    const version = decodeVersion(await db.get(Buffer.from('VERSION')));
    if (version !== '1') throw new Error('지원하지 않는 Chromium Local Storage 스키마입니다.');
    const originMeta = await db.get(Buffer.from('META:' + ORIGIN, 'ascii'));
    if (originMeta === undefined) throw new Error('공식 file origin 메타데이터가 없습니다.');

    const originPrefix = Buffer.from('_' + ORIGIN + '\0', 'ascii');
    const latin1Key = Buffer.concat([originPrefix, encodeDomStorageKey('theme', 1)]);
    const utf16Key = Buffer.concat([originPrefix, encodeDomStorageKey('theme', 0)]);
    const latin1Value = await db.get(latin1Key);
    const utf16Value = await db.get(utf16Key);
    // Chromium's LocalStorageImpl gives Latin1 the precedence when both
    // historical key encodings are present.
    const storedValue = latin1Value !== undefined ? latin1Value : utf16Value;
    const setting = decodeDomStorageString(storedValue);
    if (!['dark', 'light', 'system'].includes(setting)) throw new Error('지원되는 현재 테마 값이 없거나 형식이 올바르지 않습니다.');
    const theme = setting === 'system'
      ? ((options.resolveSystemTheme && options.resolveSystemTheme()) || 'dark')
      : setting;
    if (!['dark', 'light'].includes(theme)) throw new Error('시스템 테마 응답이 올바르지 않습니다.');
    return { status: 'READ', theme, setting, source: 'Chromium Local Storage (file://)', readOnly: true };
  } catch (error) {
    return fail(`공식 Chromium LevelDB를 안전하게 읽지 못했습니다 (${String(error && (error.code || error.name) || 'READ_ERROR')}). 원본 저장소는 변경하지 않았습니다.`);
  } finally {
    if (db) {
      try { await db.close(); } catch { /* only the disposable snapshot was opened */ }
    }
    if (snapshotRoot) {
      try {
        const temp = fs.realpathSync.native(options.tempRoot || os.tmpdir());
        const actual = fs.realpathSync.native(snapshotRoot);
        if (actual !== temp && isWithin(actual, temp) && path.basename(actual).startsWith('DinoThemeLevelDB-')) {
          fs.rmSync(actual, { recursive: true, force: true });
        }
      } catch { /* retain an uncertain snapshot rather than remove an unknown path */ }
    }
  }
}

module.exports = {
  decodeDomStorageString,
  encodeDomStorageKey,
  inspectRunningProcesses,
  readOfficialLevelDbTheme,
};
