const { app, BrowserWindow, dialog, ipcMain, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { readOfficialLevelDbTheme } = require('./theme-leveldb.cjs');
const { toExtendedWindowsPath } = require('./windows-path.cjs');
const { takeSourceSnapshot } = require('./source-snapshot.cjs');

const MANAGER_DIR = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const SOURCE_DIR = path.resolve(__dirname, '..');
const MANAGER_ENTRY = app.isPackaged
  ? path.join(process.resourcesPath, 'manager-engine', 'DinoPatchManagerEngine.exe')
  : path.join(SOURCE_DIR, 'manager_bridge.py');
// The packaged Electron executable provides Node CLI mode for isolated contract checks.
const TEST_ROOT_VALUE = process.env.DINO_MANAGER_TEST_ROOT || '';
const TEST_PROFILE_VALUE = process.env.DINO_MANAGER_TEST_PROFILE_ROOT || '';
const TEST_OS_TEMP_ROOT_VALUE = process.env.DINO_MANAGER_TEST_OS_TEMP_ROOT || '';
const TEST_MODE = Boolean(TEST_ROOT_VALUE || TEST_PROFILE_VALUE || TEST_OS_TEMP_ROOT_VALUE);
const SOURCE_WATCH_LIMIT = 4096;

let mainWindow = null;
let currentRoot = null;
let busy = false;
let appInfo = null;
let runtimePaths = null;
let latestUpdate = null;
let themeRefreshPromise = null;
const sourceMonitor = { root: null, watchers: [], watchedDirectories: [], timer: null, baseline: null, scanning: false, pending: false, pendingReason: '', warningSent: false };

function normalized(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function ensureRegularDirectory(value, label) {
  const target = path.resolve(value);
  fs.mkdirSync(target, { recursive: true });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 경로가 일반 디렉터리가 아닙니다.`);
  const canonical = fs.realpathSync.native(target);
  if (normalized(target) !== normalized(canonical)) throw new Error(`${label} 경로가 바로가기나 링크를 포함합니다.`);
  return canonical;
}

function resolveTestOsTempRoot() {
  if (!TEST_OS_TEMP_ROOT_VALUE) throw new Error('테스트용 OS Temp 기준 경로가 지정되지 않았습니다.');
  if (!path.isAbsolute(TEST_OS_TEMP_ROOT_VALUE)) throw new Error('테스트용 OS Temp 기준 경로는 절대경로여야 합니다.');
  const requested = path.resolve(TEST_OS_TEMP_ROOT_VALUE);
  const canonical = fs.realpathSync.native(requested);
  if (normalized(requested) !== normalized(canonical)) throw new Error('테스트용 OS Temp 기준 경로가 링크 또는 junction을 통과합니다.');
  return canonical;
}

function requireTempChild(value, label) {
  if (!value) throw new Error(`${label} OS Temp 경로가 지정되지 않았습니다.`);
  if (!path.isAbsolute(value)) throw new Error(`${label} 경로는 절대경로여야 합니다.`);
  const tempRoot = resolveTestOsTempRoot();
  const candidate = path.resolve(value);
  if (normalized(candidate) === normalized(tempRoot) || !isWithin(candidate, tempRoot)) {
    throw new Error(`${label} 경로는 OS Temp 아래의 이번 실행 전용 하위 폴더여야 합니다.`);
  }

  let current = tempRoot;
  const relative = path.relative(tempRoot, candidate);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`${label} 경로에 일반 디렉터리가 아닌 항목이나 링크가 있습니다.`);
      }
      if (normalized(fs.realpathSync.native(current)) !== normalized(current)) {
        throw new Error(`${label} 경로가 심볼릭 링크 또는 junction을 통과합니다.`);
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw error;
    }
  }

  const canonical = ensureRegularDirectory(candidate, label);
  if (normalized(canonical) !== normalized(candidate) || !isWithin(canonical, tempRoot)) {
    throw new Error(`${label} 경로의 실제 위치가 OS Temp 경로와 일치하지 않습니다.`);
  }
  return canonical;
}

function resolveRuntimePaths() {
  let base;
  let isolatedTarget = null;
  if (TEST_MODE) {
    isolatedTarget = requireTempChild(TEST_ROOT_VALUE, '테스트 원본');
    base = requireTempChild(TEST_PROFILE_VALUE, '테스트 프로필');
    if (isWithin(base, isolatedTarget) || isWithin(isolatedTarget, base)) {
      throw new Error('테스트 원본과 관리자 프로필은 서로 겹치지 않는 별도 경로여야 합니다.');
    }
    process.env.APPDATA = path.join(base, 'appData');
  } else if (app.isPackaged) {
    base = path.join(MANAGER_DIR, 'runtime');
  } else {
    base = path.join(os.tmpdir(), `DinoPatchManager-dev-${process.pid}`);
  }

  const paths = {
    appData: ensureRegularDirectory(path.join(base, 'appData'), 'appData'),
    userData: ensureRegularDirectory(path.join(base, 'userData'), 'userData'),
    sessionData: ensureRegularDirectory(path.join(base, 'sessionData'), 'sessionData'),
    temp: ensureRegularDirectory(path.join(base, 'temp'), 'temp'),
    cache: ensureRegularDirectory(path.join(base, 'cache'), 'cache'),
    logs: ensureRegularDirectory(path.join(base, 'logs'), 'logs'),
    crashDumps: ensureRegularDirectory(path.join(base, 'crashDumps'), 'crashDumps'),
    base,
    isolatedTarget,
  };
  const named = ['appData', 'userData', 'sessionData', 'temp', 'cache', 'logs', 'crashDumps'];
  for (let first = 0; first < named.length; first += 1) {
    for (let second = first + 1; second < named.length; second += 1) {
      if (normalized(paths[named[first]]) === normalized(paths[named[second]])) {
        throw new Error(`Electron 격리 경로가 중복됩니다: ${named[first]} / ${named[second]}`);
      }
    }
  }
  // Electron 38.8.6 aliases getPath('cache') to appData on Windows. Setting
  // that legacy path key after appData silently redirects appData as well.
  // Keep appData explicit and isolate Chromium's disk cache via its supported
  // command-line switch instead of app.setPath('cache').
  for (const key of ['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']) app.setPath(key, paths[key]);
  if (TEST_MODE && normalized(app.commandLine.getSwitchValue('user-data-dir')) !== normalized(paths.userData)) {
    app.commandLine.removeSwitch('user-data-dir');
    app.commandLine.appendSwitch('user-data-dir', paths.userData);
  }
  app.commandLine.appendSwitch('disk-cache-dir', paths.cache);
  app.commandLine.appendSwitch('crash-dumps-dir', paths.crashDumps);
  return paths;
}

function verifyRuntimePaths() {
  const checks = {};
  for (const key of ['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']) {
    const actual = fs.realpathSync.native(app.getPath(key));
    checks[key] = { expected: runtimePaths[key], actual, matches: normalized(actual) === normalized(runtimePaths[key]) };
    if (!checks[key].matches) throw new Error(`Electron ${key} 경로가 격리 설정과 다릅니다 (expected=${runtimePaths[key]}, actual=${actual}).`);
  }
  if (TEST_MODE) {
    const userDataSwitch = app.commandLine.getSwitchValue('user-data-dir');
    if (!userDataSwitch) throw new Error('Chromium --user-data-dir 경로가 지정되지 않았습니다.');
    const actualUserData = fs.realpathSync.native(userDataSwitch);
    checks.chromiumUserData = { expected: runtimePaths.userData, actual: actualUserData, matches: normalized(actualUserData) === normalized(runtimePaths.userData) };
    if (!checks.chromiumUserData.matches) throw new Error(`Chromium user-data-dir 경로가 격리 설정과 다릅니다 (expected=${runtimePaths.userData}, actual=${actualUserData}).`);
  }
  const cacheSwitch = app.commandLine.getSwitchValue('disk-cache-dir');
  if (!cacheSwitch) throw new Error('Chromium 디스크 캐시 격리 경로가 설정되지 않았습니다.');
  const actualCache = fs.realpathSync.native(cacheSwitch);
  checks.cache = { expected: runtimePaths.cache, actual: actualCache, matches: normalized(actualCache) === normalized(runtimePaths.cache) };
  if (!checks.cache.matches) throw new Error(`Chromium cache 경로가 격리 설정과 다릅니다 (expected=${runtimePaths.cache}, actual=${actualCache}).`);
  return checks;
}

function setEnvironmentValue(env, name, value) {
  const existing = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing && existing !== name) {
    env[existing] = value;
    delete env[name];
  } else {
    env[name] = value;
  }
}

function sendProgress(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('manager:progress', String(message || '').slice(0, 1000));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function closeSourceWatchers() {
  for (const watcher of sourceMonitor.watchers) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  sourceMonitor.watchers = [];
  sourceMonitor.watchedDirectories = [];
}

function sendSourceChange(snapshot, reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('manager:source-change', {
    root: sourceMonitor.root,
    version: snapshot.version,
    reason: String(reason || '공식 원본 파일 변경').slice(0, 300),
  });
}

function installSourceWatchers(snapshot) {
  const directories = snapshot.directories;
  if (sourceMonitor.watchedDirectories.length === directories.length
    && sourceMonitor.watchedDirectories.every((value, index) => value === directories[index])) return;
  if (directories.length > SOURCE_WATCH_LIMIT) throw new Error(`공식 소스 폴더 수가 감시 한도 ${SOURCE_WATCH_LIMIT}개를 넘습니다.`);
  closeSourceWatchers();
  const created = [];
  try {
    for (const directory of directories) {
      const watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : '';
        scheduleSourceScan(name ? `파일 변경 감지 · ${name.slice(0, 120)}` : '공식 소스 파일 변경 감지');
      });
      watcher.on('error', (error) => {
        closeSourceWatchers();
        sourceMonitor.warningSent = true;
        sendProgress(`공식 소스 변경 감시를 중단했습니다 (${error.code || error.name}). 관리자 실행 시 자동 검사와 고급 도구의 수동 재검사는 계속 사용할 수 있습니다.`);
      });
      created.push(watcher);
    }
    sourceMonitor.watchers = created;
    sourceMonitor.watchedDirectories = directories.slice();
  } catch (error) {
    for (const watcher of created) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    sourceMonitor.watchers = [];
    sourceMonitor.watchedDirectories = [];
    throw error;
  }
}

function setSourceWatchRoot(rootValue) {
  const root = fs.realpathSync.native(rootValue);
  if (sourceMonitor.root && normalized(sourceMonitor.root) === normalized(root)
    && sourceMonitor.baseline && sourceMonitor.watchers.length) return;
  closeSourceWatchers();
  if (sourceMonitor.timer) clearTimeout(sourceMonitor.timer);
  sourceMonitor.timer = null;
  sourceMonitor.pending = false;
  sourceMonitor.root = root;
  sourceMonitor.baseline = takeSourceSnapshot(root);
  installSourceWatchers(sourceMonitor.baseline);
}

function scheduleSourceScan(reason, waitMs = 900, attempt = 0) {
  if (!sourceMonitor.root) return;
  sourceMonitor.pendingReason = String(reason || '공식 원본 변경 감지');
  if (busy || sourceMonitor.scanning) {
    sourceMonitor.pending = true;
    return;
  }
  if (sourceMonitor.timer) clearTimeout(sourceMonitor.timer);
  sourceMonitor.timer = setTimeout(() => {
    sourceMonitor.timer = null;
    void verifyStableSourceChange(sourceMonitor.pendingReason, attempt);
  }, waitMs);
}

async function readSourceSnapshotWithRetry(root, retries = 3) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return takeSourceSnapshot(root);
    } catch (error) {
      // Missing files may be part of an atomic installer swap. A directory at
      // app.asar is an invalid layout, not a condition to retry indefinitely.
      if (error.code !== 'ENOENT' || attempt >= retries) throw error;
      await delay(200 * (attempt + 1));
    }
  }
}

async function verifyStableSourceChange(reason, attempt = 0) {
  if (!sourceMonitor.root) return;
  if (busy || sourceMonitor.scanning) {
    sourceMonitor.pending = true;
    return;
  }
  sourceMonitor.scanning = true;
  sourceMonitor.pending = false;
  let retryMissingArchive = false;
  try {
    const first = await readSourceSnapshotWithRetry(sourceMonitor.root);
    await delay(450);
    const second = await readSourceSnapshotWithRetry(sourceMonitor.root);
    await delay(450);
    const third = await readSourceSnapshotWithRetry(sourceMonitor.root);
    if (first.signature !== second.signature || second.signature !== third.signature) {
      sendProgress('공식 원본 파일이 아직 변경 중입니다. 파일 지문이 안정될 때까지 적용을 보류합니다.');
      if (attempt < 3) scheduleSourceScan('공식 원본 안정화 재확인', 1500, attempt + 1);
      return;
    }
    installSourceWatchers(third);
    const previous = sourceMonitor.baseline;
    sourceMonitor.baseline = third;
    sourceMonitor.warningSent = false;
    if (previous && previous.signature !== third.signature) sendSourceChange(third, reason);
  } catch (error) {
    sourceMonitor.warningSent = true;
    if (error.code === 'ENOENT' && attempt < 3) {
      // Keep the parent-directory watchers while an updater swaps app.asar.
      retryMissingArchive = true;
      sendProgress(`공식 설치본 app.asar가 일시적으로 불안정합니다 (${error.code}). 원본을 변경하지 않고 안정화 후 다시 확인합니다.`);
    } else {
      closeSourceWatchers();
      // A persistent invalid path must stop the timer, not trigger another
      // full hash from the pending watcher queue.
      sourceMonitor.pending = false;
      sourceMonitor.pendingReason = '';
      sendProgress(`실시간 원본 변경 감시 중단 (${error.code || error.name}): ${String(error.message || error).slice(0, 300)}. 자동 감시와 별개로 수동 적용 버튼에서 안전 검사를 다시 요청할 수 있습니다.`);
    }
  } finally {
    sourceMonitor.scanning = false;
    if (retryMissingArchive) scheduleSourceScan('설치본 app.asar 파일 안정화 재확인', 1600, attempt + 1);
    else if (sourceMonitor.pending && !sourceMonitor.warningSent) scheduleSourceScan(sourceMonitor.pendingReason || '공식 원본 변경 재확인', 900);
  }
}

async function refreshSourceMonitorAfterOperation(operation, result) {
  if (!sourceMonitor.root) return;
  try {
    const first = await readSourceSnapshotWithRetry(sourceMonitor.root);
    await delay(200);
    const second = await readSourceSnapshotWithRetry(sourceMonitor.root);
    if (first.signature !== second.signature) {
      sourceMonitor.pending = true;
      scheduleSourceScan('관리자 작업 중 공식 원본이 계속 변경됨', 900, 0);
      return;
    }
    const previous = sourceMonitor.baseline;
    installSourceWatchers(second);
    sourceMonitor.baseline = second;
    sourceMonitor.pending = false;
    if (!previous || previous.signature === second.signature) return;
    if (result && result.sourceUpdateDetected) return;
    const expectedPatchMutation = /초기 검사|자동 적용|패치 적용|패치 해제|백업 복원/.test(operation);
    if (previous.version !== second.version || !expectedPatchMutation) {
      sendSourceChange(second, previous.version !== second.version ? `공식 버전 변경 · ${previous.version} → ${second.version}` : '공식 소스 지문 변경');
    }
  } catch (error) {
    sourceMonitor.warningSent = true;
    // The operation result is still authoritative. A watcher problem must not
    // convert an already verified patch state to an unknown/failed operation.
    sourceMonitor.pending = error.code === 'ENOENT';
    sourceMonitor.pendingReason = sourceMonitor.pending ? '작업 후 설치본 변경 감시 재확인' : '';
    if (error.code === 'INVALID_ARCHIVE') {
      closeSourceWatchers();
      sendProgress(`실시간 감시를 중지했습니다: ${String(error.message || error).slice(0, 300)}. app.asar가 실제 파일이 되기 전까지 자동 재시도하지 않습니다.`);
    } else if (error.code === 'ENOENT') {
      sendProgress(`설치본 app.asar 상태가 변하는 중입니다 (${error.code}). 패치 결과는 따로 유지하고 원본 감시를 다시 시도합니다.`);
    } else {
      sendProgress(`실시간 원본 감시만 갱신하지 못했습니다 (${error.code || error.name}): ${String(error.message || error).slice(0, 250)}. 수동 적용은 독립 검사로 진행할 수 있습니다.`);
    }
  }
}

function bridgeEnvironment() {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  if (app.isPackaged) {
    // Used only when Python launches its Node contract-check subprocesses.
    // Never enable ELECTRON_RUN_AS_NODE in the Electron GUI process itself.
    env.DINO_MANAGER_NODE_EXE = process.execPath;
  }
  if (TEST_MODE) {
    setEnvironmentValue(env, 'APPDATA', runtimePaths.appData);
    setEnvironmentValue(env, 'LOCALAPPDATA', ensureRegularDirectory(path.join(runtimePaths.base, 'localAppData'), 'LOCALAPPDATA'));
    setEnvironmentValue(env, 'TEMP', runtimePaths.temp);
    setEnvironmentValue(env, 'TMP', runtimePaths.temp);
    setEnvironmentValue(env, 'TMPDIR', runtimePaths.temp);
    setEnvironmentValue(env, 'USERPROFILE', runtimePaths.base);
    setEnvironmentValue(env, 'HOME', runtimePaths.base);
  }
  return env;
}

function runBridge(request) {
  return new Promise((resolve, reject) => {
    let executable;
    let args;
    if (app.isPackaged) {
      executable = MANAGER_ENTRY;
      args = [];
    } else {
      executable = process.env.DINO_MANAGER_PYTHON_EXE || process.env.PYTHON || 'python';
      args = [MANAGER_ENTRY];
    }

    const spawnExecutable = toExtendedWindowsPath(executable);
    const spawnArguments = args.map((argument) => toExtendedWindowsPath(argument));
    const spawnCwd = toExtendedWindowsPath(SOURCE_DIR);
    if (app.isPackaged && !fs.existsSync(spawnExecutable)) {
      return reject(new Error('패치 엔진 실행 파일이 배포 폴더에 없습니다.'));
    }
    if (!app.isPackaged && !fs.existsSync(spawnArguments[0])) {
      return reject(new Error('개발용 패치 엔진 연결 파일을 찾지 못했습니다.'));
    }

    const child = spawn(spawnExecutable, spawnArguments, {
      cwd: spawnCwd,
      env: bridgeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let finalResult = null;
    let finalError = null;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.length > 128 * 1024) {
        finalError = new Error('패치 엔진 응답이 허용 크기를 넘었습니다.');
        return;
      }
      try {
        const message = JSON.parse(line);
        if (message.type === 'progress') sendProgress(message.message);
        else if (message.type === 'result') finalResult = message.result;
        else if (message.type === 'error') finalError = new Error(String(message.error || '패치 엔진 작업에 실패했습니다.'));
      } catch {
        finalError = new Error('패치 엔진에서 읽을 수 없는 응답을 받았습니다.');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8').slice(0, 16 * 1024 - stderr.length);
    });
    child.on('error', (error) => reject(new Error(`패치 엔진을 실행하지 못했습니다 (${error.code || error.name}).`)));
    child.on('close', (code) => {
      if (finalError) return reject(finalError);
      if (code !== 0 || !finalResult) {
        const suffix = stderr.trim() ? ` · ${stderr.trim().slice(0, 500)}` : '';
        return reject(new Error(`패치 엔진이 결과 없이 종료됐습니다 (exit ${code}).${suffix}`));
      }
      resolve(finalResult);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function requireRoot() {
  if (!currentRoot || !fs.existsSync(currentRoot)) throw new Error('확인된 LilacAnime 원본 폴더가 없습니다. 원본 폴더를 선택하세요.');
  return currentRoot;
}

async function startAutomaticCheck() {
  let root = runtimePaths.isolatedTarget || currentRoot;
  if (!root && app.isPackaged) {
    const discovered = await runBridge({ operation: 'discover', start: MANAGER_DIR });
    root = discovered.path || null;
  }
  if (!root) return { status: 'NO_SOURCE', reason: '관리자 실행 경로의 상위에서 공식 LilacAnime 소스 폴더를 찾지 못했습니다.' };
  currentRoot = root;
  try {
    setSourceWatchRoot(root);
  } catch (error) {
    closeSourceWatchers();
    sourceMonitor.root = root;
    sourceMonitor.baseline = null;
    sendProgress(`실시간 원본 감시를 설정하지 못했습니다 (${error.code || error.name}): ${String(error.message || error).slice(0, 260)}. 자동 감시는 보류하지만 읽기 전용 상태 검사는 계속할 수 있습니다.`);
  }
  sendProgress('공식 원본을 확인하고, 호환되면 백업 후 디노 패치를 자동 적용합니다.');
  return runBridge({ operation: 'startup', root });
}

async function withOperation(operation, work) {
  if (busy) throw new Error('다른 관리자 작업이 진행 중입니다. 완료될 때까지 기다려 주세요.');
  busy = true;
  sendProgress(`${operation} 작업을 시작합니다.`);
  let result;
  try {
    result = await work();
    sendProgress(`${operation} 작업이 끝났습니다.`);
    return result;
  } finally {
    try {
      // Only these operations can change the official files. Avoid rehashing
      // app.asar after read-only checks and diagnostics.
      if (/초기 검사|패치 적용|패치 해제|백업 복원/.test(operation)) {
        await refreshSourceMonitorAfterOperation(operation, result);
      }
    } finally {
      busy = false;
      if (sourceMonitor.pending) {
        const reason = sourceMonitor.pendingReason || '공식 원본 변경 재확인';
        sourceMonitor.pending = false;
        scheduleSourceScan(reason, 900);
      }
    }
  }
}

async function performThemeRefresh() {
  let themeResult;
  if (!currentRoot) {
    themeResult = await runBridge({ operation: 'themeFallback' });
  } else {
    const levelDbResult = await readOfficialLevelDbTheme(currentRoot, {
      appDataRoot: process.env.APPDATA,
      moduleRoot: app.isPackaged ? path.join(process.resourcesPath, 'manager-node', 'node_modules') : null,
      managerPid: process.pid,
      resolveSystemTheme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    });
    if (levelDbResult.status === 'READ') {
      themeResult = levelDbResult;
    } else if (levelDbResult.status === 'NOT_PRESENT') {
      // Keep compatibility with the original SQLite storage used by older
      // Chromium releases; LevelDB, when present, always takes precedence.
      themeResult = await runBridge({ operation: 'theme', root: currentRoot });
    } else {
      const fallback = await runBridge({ operation: 'themeFallback' });
      themeResult = { ...fallback, reason: levelDbResult.reason };
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('manager:theme', themeResult);
  return themeResult;
}

function refreshTheme() {
  if (themeRefreshPromise) return themeRefreshPromise;
  themeRefreshPromise = performThemeRefresh().finally(() => {
    themeRefreshPromise = null;
  });
  return themeRefreshPromise;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 800,
    minWidth: 800,
    minHeight: 760,
    show: true,
    title: 'LilacAnime DinoPatch',
    autoHideMenuBar: true,
    backgroundColor: '#111820',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('file://')) event.preventDefault();
  });
  let revealed = false;
  const revealWindow = () => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', revealWindow);
  mainWindow.webContents.once('did-finish-load', revealWindow);
  mainWindow.on('focus', () => { void refreshTheme().catch(() => {}); });
  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadFile(path.join(__dirname, 'index.html')).catch((error) => {
    sendProgress(`관리자 화면을 불러오지 못했습니다: ${error.message || error}`);
    revealWindow();
  });
}

function requireAction(action) {
  if (!['apply', 'uninstall', 'restore', 'approveUpdate'].includes(action)) throw new Error('허용되지 않은 확인 작업입니다.');
}

function installIpc() {
  ipcMain.handle('manager:getInfo', async () => {
    if (!appInfo) appInfo = await runBridge({ operation: 'info' });
    return { ...appInfo, isPackaged: app.isPackaged, runtimePaths: verifyRuntimePaths() };
  });
  ipcMain.handle('manager:startup', () => withOperation('초기 검사', startAutomaticCheck));
  ipcMain.handle('manager:chooseRoot', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '공식 LilacAnime 소스 폴더 선택',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    let selected = fs.realpathSync.native(result.filePaths[0]);
    if (path.basename(selected).toLowerCase() === 'resources'
        && fs.existsSync(path.join(selected, 'app.asar'))
        && fs.existsSync(path.join(path.dirname(selected), 'LilacAnime.exe'))) {
      selected = fs.realpathSync.native(path.dirname(selected));
    }
    const isSource = fs.existsSync(path.join(selected, 'package.json'))
      && fs.existsSync(path.join(selected, 'src', 'app.js'))
      && fs.existsSync(path.join(selected, 'electron', 'main.cjs'));
    const isInstalled = fs.existsSync(path.join(selected, 'LilacAnime.exe'))
      && fs.existsSync(path.join(selected, 'resources', 'app.asar'));
    if (!isSource && !isInstalled) {
      throw new Error('선택한 폴더에 공식 LilacAnime 소스나 설치본이 없습니다. 소스 폴더 또는 LilacAnime.exe가 있는 설치 폴더를 선택하세요.');
    }
    currentRoot = selected;
    try {
      setSourceWatchRoot(currentRoot);
    } catch (error) {
      closeSourceWatchers();
      sourceMonitor.root = currentRoot;
      sourceMonitor.baseline = null;
      sendProgress(`실시간 원본 감시를 설정하지 못했습니다 (${error.code || error.name}). 다음 실행과 수동 재검사는 계속 사용할 수 있습니다.`);
    }
    return currentRoot;
  });
  ipcMain.handle('manager:inspect', () => withOperation('상태 확인', () => runBridge({ operation: 'inspect', root: requireRoot() })));
  ipcMain.handle('manager:apply', () => withOperation('패치 적용', () => runBridge({ operation: 'apply', root: requireRoot() })));
  ipcMain.handle('manager:uninstall', () => withOperation('패치 해제', () => runBridge({ operation: 'uninstall', root: requireRoot() })));
  ipcMain.handle('manager:backups', () => withOperation('백업 목록 조회', () => runBridge({ operation: 'backups', root: requireRoot() })));
  ipcMain.handle('manager:restore', (_event, backupId) => withOperation('백업 복원', () => {
    if (typeof backupId !== 'string' || !/^[A-Za-z0-9T._-]{8,80}$/.test(backupId)) throw new Error('선택한 백업 ID 형식이 올바르지 않습니다.');
    return runBridge({ operation: 'restore', root: requireRoot(), backupId });
  }));
  ipcMain.handle('manager:history', () => withOperation('작업 기록 조회', () => runBridge({ operation: 'history', root: requireRoot() })));
  ipcMain.handle('manager:diagnostics', () => withOperation('진단 조회', () => runBridge({ operation: 'diagnostics' })));
  ipcMain.handle('manager:checkUpdates', () => withOperation('공식 업데이트 확인', async () => {
    if (!appInfo) appInfo = await runBridge({ operation: 'info' });
    const target = currentRoot ? await runBridge({ operation: 'inspect', root: currentRoot }) : null;
    latestUpdate = await runBridge({
      operation: 'updateCheck',
      currentVersion: target ? target.version : appInfo.officialVersion,
      ...(currentRoot ? { root: currentRoot } : {}),
    });
    return latestUpdate;
  }));
  ipcMain.handle('manager:approveUpdate', () => {
    if (!latestUpdate) throw new Error('먼저 공식 최신 버전을 확인하세요.');
    return runBridge({ operation: 'updateApprove', updateInfo: latestUpdate });
  });
  ipcMain.handle('manager:refreshTheme', () => refreshTheme());
  ipcMain.handle('manager:runtimeInfo', () => verifyRuntimePaths());
  ipcMain.handle('manager:confirm', async (_event, action) => {
    requireAction(action);
    if (TEST_MODE && process.env.DINO_MANAGER_AUTOCONFIRM === '1') return true;
    const messages = {
      apply: ['수동 패치 적용', '자동 감시와 별도로 현재 원본을 다시 확인합니다. 호환성·파일 지문·원본 백업이 검증된 경우에만 패치합니다. 이전에 직접 해제했다면 이 작업으로 다시 적용합니다. 계속할까요?'],
      uninstall: ['패치 해제', '디노 패치가 변경한 공식 파일만 백업본으로 되돌립니다. 현재 파일의 지문이 예상과 다르면 중단합니다. 계속할까요?'],
      restore: ['백업 복원', '선택한 백업의 파일 지문과 현재 상태가 맞을 때만 원본을 복원합니다. 계속할까요?'],
      approveUpdate: ['공식 업데이트 검토', '새 공식 버전 설치는 현재 관리자에서 지원하지 않습니다. 안전하게 업데이트 적용이 거부되는 것을 확인할까요?'],
    };
    const [title, message] = messages[action];
    const result = await dialog.showMessageBox(mainWindow, { type: 'warning', title, message, buttons: ['취소', '계속'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  });
}

runtimePaths = resolveRuntimePaths();
// Preserve existing profile identity for backward compatibility.
app.setName('DinoPatchManager');
app.setAppUserModelId('com.dino.lilac.patchmanager');
const HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!HAS_SINGLE_INSTANCE_LOCK) app.quit();
installIpc();

app.whenReady().then(() => {
  if (!HAS_SINGLE_INSTANCE_LOCK) return;
  verifyRuntimePaths();
  createWindow();
  nativeTheme.on('updated', () => { void refreshTheme().catch(() => {}); });
}).catch((error) => {
  const message = String(error && error.message ? error.message : error);
  if (TEST_MODE) {
    process.stderr.write(`TEST ISOLATION FAILURE: ${message}\n`);
    app.exit(70);
    return;
  }
  dialog.showErrorBox('LilacAnime DinoPatch 시작 실패', message);
  app.quit();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
app.on('before-quit', () => {
  if (sourceMonitor.timer) clearTimeout(sourceMonitor.timer);
  sourceMonitor.timer = null;
  closeSourceWatchers();
});
app.on('window-all-closed', () => app.quit());
