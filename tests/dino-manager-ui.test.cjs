const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const managerRoot = path.resolve(__dirname, '..', 'tools', 'dino-patch-manager');
const appRoot = path.join(managerRoot, 'electron-app');
const read = (relative) => fs.readFileSync(path.join(managerRoot, relative), 'utf8');
const themeLevelDb = require(path.join(appRoot, 'theme-leveldb.cjs'));
const { toExtendedWindowsPath, WINDOWS_EXTENDED_PATH_THRESHOLD } = require(path.join(appRoot, 'windows-path.cjs'));

test('Electron UI retains A layout tokens and lists only the real Dino Patch', () => {
  const html = read('electron-app/index.html');
  const css = read('electron-app/manager.css');
  assert.match(css, /#111820/i);
  assert.match(css, /rgba\(23,\s*32,\s*41,\s*\.96\)/i);
  assert.match(css, /#2b3944/i);
  assert.match(css, /#9ad6b7/i);
  assert.match(css, /border-radius:\s*16px/);
  assert.match(css, /border-radius:\s*9px/);
  assert.match(html, /LilacAnime DinoPatch/);
  assert.doesNotMatch(html, /통합 검색 · 동일 작품 연결|Patch 0[123]|요일표와 회차 데이터 보강|한국어 자막 수동 번역/);
  assert.doesNotMatch(html, /eyebrow|공식 원본 보호 · 안전한 패치 관리/);
  assert.equal((html.match(/id="detailDialog"/g) || []).length, 0);
  assert.equal((html.match(/class="patch-row"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="patchDetails"|id="patchOfficialBase"/, 'Redundant fold-out patch details are removed.');
  assert.doesNotMatch(html, /id="(?:apply|rowApply)"/);
  assert.match(html, /id="uninstall"/);
  assert.doesNotMatch(html, /요일표|자막 번역 패치|Patch 0[123]/);
  assert.match(css, /radial-gradient\(ellipse at 80% -20%, #25403f/);
});

test('patch-list screen keeps source, global actions, backups, history and bottom status', () => {
  const html = read('electron-app/index.html');
  const css = read('electron-app/manager.css');
  const renderer = read('electron-app/renderer.js');
  for (const id of ['managerVersion', 'targetPath', 'officialVersion', 'targetPatchVersion', 'patchBadge', 'autoManageStatus', 'message', 'detail', 'busyBadge', 'safetyCard', 'safetyTitle', 'safetyMessage', 'history', 'inspect', 'uninstall', 'backupSelect', 'restore']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="(?:compatBadge|patchState|patchVersion)"/);
  assert.equal((html.match(/class="status-chip/g) || []).length, 2, 'Only patch state and transient activity are shown.');
  assert.match(html, /id="patchListHeading">패치 목록/);
  assert.match(html, /id="patchRows" class="patch-list"/);
  assert.match(html, /실행 시 자동 검사 · 필요 시 적용/);
  assert.doesNotMatch(html, /전체 검사|전체 적용|id="(?:apply|rowApply)"/);
  assert.match(html, /class="patch-row"/);
  assert.doesNotMatch(html, /class="patch-details"/);
  assert.match(html, /원본 폴더/);
  assert.match(html, /id="safetyCard" class="safety"[^>]*hidden/);
  assert.match(html, /id="activityStatus" class="result-actions" hidden/);
  assert.doesNotMatch(html, /기능<\/dt>|관리자가 기록한 변경만 되돌립니다/);
  assert.match(html, /<section class="card advanced-tools" aria-label="고급 도구">/);
  assert.doesNotMatch(html, /<details class="card advanced-tools"/);
  const advanced = html.match(/<section class="card advanced-tools"[^>]*>([\s\S]*?)<\/section>\s*<section class="result-card"/)?.[1] || '';
  assert.match(advanced, /id="inspect"[\s\S]*id="uninstall"[\s\S]*id="backupSelect"[\s\S]*id="restore"[\s\S]*id="history"/);
  assert.match(advanced, /id="checkUpdates"[\s\S]*id="diagnostics"[\s\S]*class="log-details"/);
  assert.doesNotMatch(advanced, /id="approveUpdate"/);
  assert.match(html, /id="history"/);
  assert.match(html, /백업 및 작업 기록/);
  assert.doesNotMatch(html.match(/<section class="card patch-list-card"[\s\S]*?<\/section>/)?.[0] || '', /inspect|apply|uninstall|backupSelect|restore/);
  const sourceActions = html.match(/<div class="button-row source-actions">([\s\S]*?)<\/div>/)?.[1] || '';
  const resultActions = html.match(/<div id="activityStatus" class="result-actions"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  assert.doesNotMatch(sourceActions, /id="inspect"/);
  assert.doesNotMatch(resultActions, /id="history"/);
  assert.match(html, /복원은 선택한 백업의 파일 지문을 확인한 뒤 진행합니다/);
  assert.match(css, /#targetPath[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\[hidden\] \{ display: none !important/);
  assert.match(css, /\.safety p \{ margin-top:/);
  assert.match(css, /\.result-card \{ margin-top: 0;/);
  assert.doesNotMatch(css, /\.advanced-tools\s*>\s*summary/);
  assert.doesNotMatch(css, /\.shell\s*\{[^}]*min-height:\s*100vh/);
  assert.doesNotMatch(css, /\.result-card \{[^}]*position:\s*sticky/);
  assert.match(css, /\.patch-list-card \{ display: flex; flex: 0 0 auto;/);
  assert.match(css, /\.patch-list \{[\s\S]*max-height: min\(640px, calc\(100vh - 150px\)\);[\s\S]*overflow-y: auto/);
  assert.doesNotMatch(css, /\.patch-list-card \{[^}]*flex:\s*1/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-height: 720px\)/);
  assert.match(css, /body \{[\s\S]*?min-height:\s*100vh/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(renderer, /function renderSafety\(/);
  assert.match(renderer, /function setDetail\(/);
  assert.match(renderer, /elements\.activityStatus\.hidden = !state\.busy/);
  assert.match(renderer, /elements\.safetyCard\.hidden = !expanded/);
  assert.match(renderer, /elements\.themeStatus\.hidden = true/);
  assert.match(renderer, /setChip\(elements\.patchBadge, label, tone\)/);
  assert.match(renderer, /function setAutoManageStatus\(/);
  assert.match(renderer, /Source checks and patch application run automatically/);
  assert.doesNotMatch(renderer, /elements\.apply|rowApply|canApply/);
  assert.match(renderer, /managementSummaryByStatus/);
  assert.doesNotMatch(renderer, /elements\.(?:compatBadge|patchState)/);
  assert.doesNotMatch(renderer, /`대상: \$\{state\.root\}`/);
});

test('Electron boundary is context isolated, sandboxed and allow-listed', () => {
  const main = read('electron-app/main.cjs');
  const preload = read('electron-app/preload.cjs');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /shell:\s*false/);
  assert.doesNotMatch(main, /exec\s*\(/);
  assert.match(preload, /exposeInMainWorld\('dinoManager'/);
  assert.doesNotMatch(preload, /send\s*\(\s*[^'"`]/);
  assert.match(main, /DINO_MANAGER_TEST_ROOT/);
  assert.match(main, /DINO_MANAGER_TEST_PROFILE_ROOT/);
  assert.match(main, /DINO_MANAGER_TEST_OS_TEMP_ROOT/);
  assert.match(main, /did-finish-load', revealWindow/);
});

test('default Electron window fits the patch-list layout', () => {
  const main = read('electron-app/main.cjs');
  const css = read('electron-app/manager.css');
  const smoke = read('tests/electron_ui_smoke.cjs');
  assert.match(main, /width:\s*920,\s*height:\s*800,\s*minWidth:\s*800,\s*minHeight:\s*760/);
  assert.match(css, /\.safety \{ display: grid;/);
  assert.match(css, /\.detail \{ max-height:\s*105px; overflow:\s*auto;/);
  assert.match(smoke, /SetWindowPos/);
  assert.match(smoke, /GetDpiForWindow/);
  assert.match(smoke, /\{ width: 900, height: 760 \}[\s\S]*\{ width: 920, height: 800 \}[\s\S]*\{ width: 960, height: 820 \}/);
  assert.match(smoke, /const minimumWindow = \{ width: 800, height: 760 \}/);
  assert.match(smoke, /longErrorLayout\.detailScrollHeight > longErrorLayout\.detailClientHeight/);
  assert.match(smoke, /DINO_MANAGER_SMOKE_APP_ROOT/);
  assert.match(smoke, /A21-final-vs-\$\{candidateLabel\}-window-comparison\.png/);
});

test('patch list collapses for one real patch and bounds multi-patch fixtures', () => {
  const html = read('electron-app/index.html');
  const css = read('electron-app/manager.css');
  const smoke = read('tests/electron_ui_smoke.cjs');
  assert.equal((html.match(/class="patch-row"/g) || []).length, 1, 'Production must expose only the actual Dino Patch.');
  assert.match(css, /\.patch-list-card \{[^}]*min-height: 0; max-height: none/);
  assert.match(css, /\.patch-list \{[^}]*max-height:[^}]*overflow-y: auto/);
  for (const count of [1, 3, 5, 10]) assert.match(smoke, new RegExp(`count === ${count}|fixtureCounts[^\\]]*${count}`));
  assert.match(smoke, /patchPanelSlackPx/);
  assert.match(smoke, /synthetic patch fixture/i);
  assert.match(smoke, /patchListScrollHeight > fixtureLayout\.patchListHeight/);
  assert.match(smoke, /DINO_MANAGER_SMOKE_APP_ROOT/);
});

test('Electron cache isolation does not redirect the appData profile', () => {
  const main = read('electron-app/main.cjs');
  assert.match(main, /\['appData',\s*'userData',\s*'sessionData',\s*'temp',\s*'logs',\s*'crashDumps'\]\) app\.setPath\(key, paths\[key\]\)/);
  assert.match(main, /appendSwitch\('disk-cache-dir',\s*paths\.cache\)/);
  assert.match(main, /getSwitchValue\('disk-cache-dir'\)/);
  assert.doesNotMatch(main, /app\.setPath\('cache',\s*paths\.cache\)/);
});

test('test mode pins and verifies Chromium userData before creating a manager window', () => {
  const main = read('electron-app/main.cjs');
  const smoke = read('tests/electron_ui_smoke.cjs');
  const switchSetup = main.indexOf("app.commandLine.appendSwitch('user-data-dir', paths.userData)");
  const ready = main.indexOf('app.whenReady().then');
  const windowCreation = main.indexOf('createWindow();', ready);
  assert.ok(switchSetup >= 0 && switchSetup < ready && ready < windowCreation, 'Test userData must be selected and checked before the manager window is created.');
  assert.match(main, /TEST_MODE && normalized\(app\.commandLine\.getSwitchValue\('user-data-dir'\)\) !== normalized\(paths\.userData\)/);
  assert.match(main, /checks\.chromiumUserData[\s\S]*runtimePaths\.userData/);
  assert.match(main, /TEST ISOLATION FAILURE:[\s\S]*app\.exit\(70\)/);
  assert.match(main, /function resolveTestOsTempRoot\(\)/);
  assert.match(main, /const tempRoot = resolveTestOsTempRoot\(\)/);
  assert.match(main, /if \(!path\.isAbsolute\(value\)\)/);
  assert.match(main, /symbolic link or junction|심볼릭 링크 또는 junction/);
  assert.match(smoke, /`--user-data-dir=\$\{runtimePaths\.userData\}`/);
  assert.match(smoke, /DINO_MANAGER_TEST_OS_TEMP_ROOT:\s*fs\.realpathSync\.native\(os\.tmpdir\(\)\)/);
  assert.match(smoke, /processTreeFromWindows\(child\.pid\)/);
  assert.match(smoke, /getCommandLineSwitch\(item\.CommandLine, 'user-data-dir'\)/);
  assert.match(smoke, /DINO_MANAGER_SMOKE_OUTPUT_ROOT/);
});

test('test profile validation rejects relative paths, traversal, and junctions before creating children', () => {
  const main = read('electron-app/main.cjs');
  const start = main.indexOf('function normalized');
  const end = main.indexOf('function resolveRuntimePaths', start);
  assert.ok(start >= 0 && end > start, 'The tested runtime path validators must be present.');
  const validators = main.slice(start, end);
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(tempRoot, 'dino-profile-guard-'));
  const linkedTarget = path.join(tempRoot, `dino-profile-target-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(linkedTarget);
    const validatorContext = { fs, path, os: { tmpdir: () => tempRoot }, TEST_MODE: true, TEST_OS_TEMP_ROOT_VALUE: tempRoot };
    const { requireTempChild, resolveTestOsTempRoot } = vm.runInNewContext(`${validators}\n({ requireTempChild, resolveTestOsTempRoot })`, validatorContext);
    assert.equal(resolveTestOsTempRoot().toLocaleLowerCase(), tempRoot.toLocaleLowerCase());
    assert.throws(() => vm.runInNewContext(`${validators}\nresolveTestOsTempRoot()`, { fs, path, os: { tmpdir: () => tempRoot }, TEST_MODE: true, TEST_OS_TEMP_ROOT_VALUE: '' }), /OS Temp 기준 경로가 지정되지 않았습니다/);
    assert.throws(() => requireTempChild(path.relative(tempRoot, scratch), 'test profile'), /절대경로/);
    const outside = path.resolve(tempRoot, '..', `dino-profile-outside-${process.pid}-${Date.now()}`);
    assert.equal(fs.existsSync(outside), false);
    assert.throws(() => requireTempChild(outside, 'test profile'), /OS Temp/);
    assert.equal(fs.existsSync(outside), false, 'An invalid external path must not be created before rejection.');
    const junction = path.join(scratch, 'junction');
    fs.symlinkSync(linkedTarget, junction, 'junction');
    const escapedChild = path.join(junction, 'child');
    assert.throws(() => requireTempChild(escapedChild, 'test profile'), /링크|junction/i);
    assert.equal(fs.existsSync(path.join(linkedTarget, 'child')), false, 'A junction target must not receive files.');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(linkedTarget, { recursive: true, force: true });
  }
});

test('packaged engine keeps Windows PATH intact and isolates its test profile', () => {
  const main = read('electron-app/main.cjs');
  const smoke = read('tests/electron_ui_smoke.cjs');
  assert.match(main, /env\.DINO_MANAGER_NODE_EXE = process\.execPath/);
  assert.match(main, /env: bridgeEnvironment\(\)/);
  assert.match(main, /PYTHONUTF8:\s*'1'/);
  assert.match(main, /PYTHONIOENCODING:\s*'utf-8'/);
  assert.match(main, /readline\.createInterface\(\{ input: child\.stdout/);
  assert.match(main, /chunk\.toString\('utf8'\)/);
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME']) {
    assert.match(main, new RegExp(`setEnvironmentValue\\(env, '${key}',`));
  }
  assert.match(smoke, /Failed smoke workspace retained for diagnosis/);
});

test('packaged bridge uses extended Windows paths for long executable, arguments and cwd', () => {
  const main = read('electron-app/main.cjs');
  const builder = read('build-electron.cjs');
  const longLocalPath = `C:\\${'nested\\'.repeat(36)}DinoPatchManagerEngine.exe`;
  const normalizedLocalPath = path.win32.normalize(longLocalPath);
  assert.ok(normalizedLocalPath.length >= WINDOWS_EXTENDED_PATH_THRESHOLD);
  assert.equal(toExtendedWindowsPath(longLocalPath, 'win32'), `\\\\?\\${normalizedLocalPath}`);
  assert.equal(toExtendedWindowsPath(`C:\\${'x'.repeat(WINDOWS_EXTENDED_PATH_THRESHOLD - 3)}`, 'win32'), `\\\\?\\C:\\${'x'.repeat(WINDOWS_EXTENDED_PATH_THRESHOLD - 3)}`);
  assert.equal(toExtendedWindowsPath(`C:\\${'x'.repeat(WINDOWS_EXTENDED_PATH_THRESHOLD - 4)}`, 'win32'), `C:\\${'x'.repeat(WINDOWS_EXTENDED_PATH_THRESHOLD - 4)}`);

  const longUncPath = `\\\\server\\share\\${'nested\\'.repeat(36)}DinoPatchManagerEngine.exe`;
  const normalizedUncPath = path.win32.normalize(longUncPath);
  assert.equal(toExtendedWindowsPath(longUncPath, 'win32'), `\\\\?\\UNC\\${normalizedUncPath.slice(2)}`);
  assert.equal(toExtendedWindowsPath(longLocalPath, 'linux'), longLocalPath);
  assert.equal(toExtendedWindowsPath('python', 'win32'), 'python');
  assert.equal(toExtendedWindowsPath(`\\\\?\\${normalizedLocalPath}`, 'win32'), `\\\\?\\${normalizedLocalPath}`);

  assert.match(main, /const spawnExecutable = toExtendedWindowsPath\(executable\)/);
  assert.match(main, /const spawnArguments = args\.map\(\(argument\) => toExtendedWindowsPath\(argument\)\)/);
  assert.match(main, /const spawnCwd = toExtendedWindowsPath\(SOURCE_DIR\)/);
  assert.match(main, /spawn\(spawnExecutable, spawnArguments, \{\s*cwd: spawnCwd/);
  assert.match(builder, /'windows-path\.cjs'/);
});

test('renderer distinguishes a connected engine from an incompatible source', () => {
  const renderer = read('electron-app/renderer.js');
  assert.match(renderer, /if \(state\.info\) \{[\s\S]*원본 호환성 검사 또는 안전한 적용을 완료하지 못했습니다\./);
  assert.match(renderer, /관리자 엔진 연결은 확인되었습니다/);
  assert.match(renderer, /적용 중단/);
  assert.match(renderer, /관리자 엔진을 시작하지 못했습니다\./);
  assert.match(renderer, /확인 불가/);
  assert.match(renderer, /COMPATIBILITY_UNKNOWN: \['호환성 확인 필요', 'bad'\]/);
  assert.match(renderer, /COMPATIBILITY_UNKNOWN: \['호환성 확인 필요 · 적용 중단', 'bad'\]/);
  assert.match(renderer, /if \(structural && state\.status === 'UNPATCHED'\) label = '구조 호환 · 미적용'/);
  assert.match(renderer, /실제 Electron 동작·영상 재생 검증은 포함하지 않습니다/);
  assert.match(renderer, /공식 업데이트 적용은 지원되지 않아 원본을 변경하지 않았습니다\./);
  assert.match(renderer, /elements\.message\.textContent = `\$\{label\} 완료`/);
  assert.match(renderer, /const fresh = await window\.dinoManager\.inspect\(\)/);
  assert.match(renderer, /읽기 전용 재검사 결과/);
  assert.match(renderer, /state\.status = 'PARTIAL_OR_UNKNOWN'/);
  assert.match(renderer, /파일 변경 작업은 잠깁니다/);
  assert.match(renderer, /const details = \[/);
  assert.match(renderer, /setDetail\(details\.join\('\\n'\)\)/);
});

test('official theme refreshes on startup, window focus, and system theme changes without polling', () => {
  const main = read('electron-app/main.cjs');
  const renderer = read('electron-app/renderer.js');
  assert.match(renderer, /await window\.dinoManager\.refreshTheme\(\)/);
  assert.match(main, /mainWindow\.on\('focus', \(\) => \{ void refreshTheme\(\)\.catch\(\(\) => \{\}\); \}\)/);
  assert.match(main, /nativeTheme\.on\('updated', \(\) => \{ void refreshTheme\(\)\.catch\(\(\) => \{\}\); \}\)/);
  assert.doesNotMatch(main, /setInterval\(\(\) => \{ void refreshTheme\(\)/);
  assert.doesNotMatch(renderer, /window\.addEventListener\('focus'.*refreshTheme/);
  assert.match(main, /readOfficialLevelDbTheme\(currentRoot/);
  assert.match(main, /themeRefreshPromise/);
  assert.match(read('electron-app/theme-leveldb.cjs'), /META:' \+ ORIGIN/);
  assert.match(read('electron-app/theme-leveldb.cjs'), /encodeDomStorageKey\('theme', 1\)/);
  assert.match(read('electron-app/theme-leveldb.cjs'), /createIfMissing: false/);
  assert.match(read('electron-app/theme-leveldb.cjs'), /DinoThemeLevelDB-/);
  assert.match(read('electron-app/theme-leveldb.cjs'), /sha256: fileDigest\(fullPath\)/);
  assert.match(read('electron-app/theme-leveldb.cjs'), /canonicalDirectory, directory/);
});

test('LevelDB theme reader scopes the exact file origin and reflects the latest logical value', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-theme-reader-contract-'));
  const sourceRoot = path.join(scratch, 'official-source');
  const appData = path.join(scratch, 'profile');
  const dbPath = path.join(appData, 'lilacanime-desktop', 'Local Storage', 'leveldb');
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'electron'), { recursive: true });
  fs.mkdirSync(dbPath, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'lilacanime-desktop', version: '0.5.54' }));
  fs.writeFileSync(path.join(sourceRoot, 'src', 'app.js'), "localStorage.getItem('theme'); localStorage.setItem('theme', 'dark');");
  fs.writeFileSync(path.join(sourceRoot, 'electron', 'main.cjs'), "win.loadFile('src/index.html');");
  fs.writeFileSync(path.join(dbPath, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(dbPath, 'MANIFEST-000001'), 'synthetic manifest fixture');
  fs.writeFileSync(path.join(dbPath, '000003.log'), 'synthetic write log fixture');

  const valueMap = new Map();
  const key = Buffer.concat([Buffer.from('_file://\0', 'ascii'), themeLevelDb.encodeDomStorageKey('theme', 1)]);
  valueMap.set(Buffer.from('VERSION').toString('hex'), Buffer.from('1'));
  valueMap.set(Buffer.from('META:file://').toString('hex'), Buffer.from('origin metadata'));
  valueMap.set(key.toString('hex'), Buffer.from([1, ...Buffer.from('dark', 'latin1')]));
  const createDb = (location, options) => {
    assert.equal(options.createIfMissing, false);
    assert.equal(options.errorIfExists, false);
    assert.notEqual(path.resolve(location), path.resolve(dbPath), 'Only the Temp snapshot may be opened.');
    return {
      open: async () => {},
      get: async (requestedKey) => valueMap.get(Buffer.from(requestedKey).toString('hex')),
      close: async () => {},
    };
  };
  const detectRunning = () => ({ status: 'SAFE' });

  try {
    const originalDigest = fs.readFileSync(path.join(dbPath, '000003.log')).toString('hex');
    const dark = await themeLevelDb.readOfficialLevelDbTheme(sourceRoot, { appDataRoot: appData, createDb, detectRunning });
    assert.deepEqual({ status: dark.status, setting: dark.setting, theme: dark.theme, readOnly: dark.readOnly }, { status: 'READ', setting: 'dark', theme: 'dark', readOnly: true });
    valueMap.set(key.toString('hex'), Buffer.from([1, ...Buffer.from('light', 'latin1')]));
    const light = await themeLevelDb.readOfficialLevelDbTheme(sourceRoot, { appDataRoot: appData, createDb, detectRunning });
    assert.equal(light.theme, 'light');
    valueMap.set(key.toString('hex'), Buffer.from([1, ...Buffer.from('system', 'latin1')]));
    const system = await themeLevelDb.readOfficialLevelDbTheme(sourceRoot, { appDataRoot: appData, createDb, detectRunning, resolveSystemTheme: () => 'light' });
    assert.equal(system.setting, 'system');
    assert.equal(system.theme, 'light');
    assert.equal(fs.readFileSync(path.join(dbPath, '000003.log')).toString('hex'), originalDigest, 'The source LevelDB must remain unchanged.');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('LevelDB theme reader fails closed for missing, foreign, malformed and in-use values', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-theme-reader-fail-closed-'));
  const sourceRoot = path.join(scratch, 'official-source');
  const appData = path.join(scratch, 'profile');
  const dbPath = path.join(appData, 'lilacanime-desktop', 'Local Storage', 'leveldb');
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'electron'), { recursive: true });
  fs.mkdirSync(dbPath, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'lilacanime-desktop', version: '0.5.54' }));
  fs.writeFileSync(path.join(sourceRoot, 'src', 'app.js'), "localStorage.getItem('theme'); localStorage.setItem('theme', 'dark');");
  fs.writeFileSync(path.join(sourceRoot, 'electron', 'main.cjs'), "win.loadFile('src/index.html');");
  fs.writeFileSync(path.join(dbPath, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(dbPath, 'MANIFEST-000001'), 'synthetic manifest fixture');
  fs.writeFileSync(path.join(dbPath, '000003.log'), 'synthetic write log fixture');

  const maps = new Map();
  const originPrefix = Buffer.from('_file://\0', 'ascii');
  const themeKey = Buffer.concat([originPrefix, themeLevelDb.encodeDomStorageKey('theme', 1)]);
  const foreignKey = Buffer.concat([Buffer.from('_https://other.invalid\0', 'ascii'), themeLevelDb.encodeDomStorageKey('theme', 1)]);
  maps.set(Buffer.from('VERSION').toString('hex'), Buffer.from('1'));
  maps.set(Buffer.from('META:file://').toString('hex'), Buffer.from('origin metadata'));
  const createDb = () => ({ open: async () => {}, get: async (requested) => maps.get(Buffer.from(requested).toString('hex')), close: async () => {} });

  try {
    maps.set(foreignKey.toString('hex'), Buffer.from([1, ...Buffer.from('dark')]));
    let result = await themeLevelDb.readOfficialLevelDbTheme(sourceRoot, { appDataRoot: appData, createDb, detectRunning: () => ({ status: 'SAFE' }) });
    assert.equal(result.status, 'FALLBACK', 'A different origin must not supply the theme.');

    maps.delete(foreignKey.toString('hex'));
    maps.set(themeKey.toString('hex'), Buffer.from([1, ...Buffer.from('deleted') ]));
    result = await themeLevelDb.readOfficialLevelDbTheme(sourceRoot, { appDataRoot: appData, createDb, detectRunning: () => ({ status: 'SAFE' }) });
    assert.equal(result.status, 'FALLBACK', 'Unknown values must not be shown as current themes.');

    let opened = false;
    result = await themeLevelDb.readOfficialLevelDbTheme(sourceRoot, {
      appDataRoot: appData,
      createDb: () => { opened = true; throw new Error('must not open'); },
      detectRunning: () => ({ status: 'BUSY', reason: 'test process open' }),
    });
    assert.equal(result.status, 'FALLBACK');
    assert.equal(opened, false, 'An in-use profile must be rejected before snapshot parsing.');

    fs.writeFileSync(path.join(dbPath, 'CURRENT'), 'MISSING-MANIFEST\n');
    result = await themeLevelDb.readOfficialLevelDbTheme(sourceRoot, { appDataRoot: appData, createDb, detectRunning: () => ({ status: 'SAFE' }) });
    assert.equal(result.status, 'FALLBACK', 'Corrupt LevelDB metadata must fail closed.');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('renderer keeps manager actions disabled while its backup IPC is pending', () => {
  const renderer = read('electron-app/renderer.js');
  assert.match(renderer, /const wasBusy = state\.busy;\s*const messageBeforeLoad = elements\.message\.textContent;[\s\S]*?if \(!wasBusy\) setBusy\(true, '백업 목록을 불러오는 중/);
  assert.match(renderer, /finally \{\s*if \(!wasBusy\) \{\s*setBusy\(false\);\s*if \(elements\.message\.textContent === '백업 목록을 불러오는 중/);
  assert.match(renderer, /백업 목록 조회 실패/);
});

test('restore picker only exposes restorable backups and blocks known unsafe states', () => {
  const renderer = read('electron-app/renderer.js');
  const html = read('electron-app/index.html');
  assert.match(renderer, /item\.restorable === true/);
  assert.match(renderer, /const selectedBackup = state\.backups\.find\(\(item\) => item\.id === elements\.backupSelect\.value && item\.restorable === true\)/);
  assert.match(renderer, /const restoreAllowedForState = \['APPLIED', 'ALREADY_APPLIED', 'UNPATCHED'\]\.includes\(state\.status\)/);
  assert.match(renderer, /if \(state\.busy \|\| !selectedBackup \|\| !\['APPLIED', 'ALREADY_APPLIED', 'UNPATCHED'\]\.includes\(state\.status\)\) return/);
  assert.match(renderer, /state\.backups = \[\];\s*elements\.backupSelect\.replaceChildren\(new Option\('백업 목록 확인 중/);
  assert.match(renderer, /백업 목록 확인 실패/);
  assert.match(renderer, /복원 가능한 백업 없음/);
  assert.match(html, /id="restore"[^>]*disabled/);
});

test('installed ASAR snapshot never falls through to source package.json during atomic replacement', () => {
  const { takeSourceSnapshot } = require(path.join(appRoot, 'source-snapshot.cjs'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-asar-monitor-race-'));
  try {
    const target = path.join(directory, 'LilacAnime');
    const resources = path.join(target, 'resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(target, 'LilacAnime.exe'), 'installed-marker');
    const archive = path.join(resources, 'app.asar');
    const pendingArchive = path.join(resources, 'app.asar.replacing');
    fs.writeFileSync(archive, 'original-bytes');
    const before = takeSourceSnapshot(target);
    assert.equal(before.version, 'installed-asar');
    assert.equal(before.files['resources/app.asar'], before.signature);
    assert.equal(before.directories.length, 2);

    // Simulate an update or transactional installer moving the archive away.
    fs.renameSync(archive, pendingArchive);
    assert.throws(() => takeSourceSnapshot(target), (error) => {
      assert.equal(error.code, 'ENOENT');
      assert.match(error.message, /resources\\/app\\.asar/);
      assert.doesNotMatch(error.message, /package\\.json/);
      return true;
    });
    // Do not create package.json. The installed archive must remain recognized.
    fs.renameSync(pendingArchive, archive);
    const afterRestore = takeSourceSnapshot(target);
    assert.equal(afterRestore.signature, before.signature);
    fs.writeFileSync(archive, 'new-install-version');
    const afterUpdate = takeSourceSnapshot(target);
    assert.notEqual(afterUpdate.signature, before.signature);
    assert.equal(afterUpdate.version, 'installed-asar');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('source monitoring keeps official release lookup separate from source installation', () => {
  const renderer = read('electron-app/renderer.js');
  const html = read('electron-app/index.html');
  const main = read('electron-app/main.cjs');
  assert.doesNotMatch(html, /approveUpdate|자동 설치 미지원/);
  assert.match(html, /버전 조회만 합니다\. 소스 파일은 변경하지 않습니다/);
  assert.match(main, /require\('\.\/source-snapshot\.cjs'\)/);
  assert.match(read('electron-app/source-snapshot.cjs'), /function takeSourceSnapshot\(/);
  assert.match(main, /fs\.watch\(directory/);
  assert.match(main, /scheduleSourceScan\(/);
  assert.match(main, /manager:source-change/);
  assert.match(renderer, /onSourceChange\(/);
  assert.match(renderer, /runSourceChangeRecheck\(/);
  assert.match(renderer, /window\.dinoManager\.startup\(\)/);
  assert.match(main, /operation: 'updateCheck',[\s\S]*?currentVersion: target \? target\.version : appInfo\.officialVersion,[\s\S]*?root: currentRoot/);
  assert.match(renderer, /sourceChangeSummary[\s\S]*sourceArchiveDownloaded === false/);
  assert.match(renderer, /UPDATE_PREFLIGHT_BLOCKED/);
  assert.match(renderer, /patchCompatibility/);
});

test('independent Windows build pins its toolchain and validates bundled engine resources', () => {
  const buildScript = read('build_electron_windows.ps1');
  const builder = read('build-electron.cjs');
  assert.match(buildScript, /\$projectRoot = .*Join-Path \$managerSource/);
  assert.match(buildScript, /function Get-RelativePathCompat/);
  assert.doesNotMatch(buildScript, /::GetRelativePath\(/);
  assert.match(buildScript, /function Invoke-PythonJsonProbe/);
  assert.match(buildScript, /dpm-build-python-/);
  assert.match(buildScript, /\[Parameter\(Mandatory = \$true\)\][\s\S]*\[string\]\$PythonExe/);
  assert.match(buildScript, /OS 임시/);
  assert.match(buildScript, /기존 산출물 덮어쓰기를 거부/);
  assert.match(buildScript, /& \$npmPath ci --include=dev/);
  assert.match(buildScript, /build-toolchain\.json/);
  assert.match(buildScript, /requirements-build\.txt/);
  assert.match(buildScript, /npm ci 대상이 이번 실행의 Temp staging 밖/);
  assert.match(buildScript, /Join-Path \$managerSource "test-artifacts"/);
  assert.match(buildScript, /independent-build-/);
  assert.match(buildScript, /fixture 경로가 재분석 지점입니다/);
  assert.match(buildScript, /패키지에서 필수 파일이 없습니다/);
  assert.match(buildScript, /패키지는 검증됐지만 임시 staging 정리에 실패했습니다/);
  assert.match(buildScript, /Invoke-EngineInfo \$engineExe/);
  assert.match(buildScript, /Invoke-EngineInfo \$appEngineExe/);
  assert.doesNotMatch(buildScript, /D:\\Codex-Coding-Folder\\LilacAnime-Player/);
  assert.doesNotMatch(buildScript, /D:\\Codex-Coding-Folder\\tools\\python314-build/);
  assert.match(buildScript, /npm_config_cache/);
  assert.match(buildScript, /npm_config_logs_dir/);
  assert.match(buildScript, /npm_config_userconfig/);
  assert.match(buildScript, /npm_config_globalconfig/);
  assert.match(buildScript, /package-lock\.json/);
  assert.match(buildScript, /LilacAnime-DinoPatch-Electron-v.*\$BuildName/);
  assert.match(read('build-toolchain.json'), /"pyinstaller": "6\.21\.0"/);
  assert.match(read('requirements-build.txt'), /^pyinstaller==6\.21\.0$/m);
  assert.match(read('electron-app/package.json'), /"electron-builder": "26\.15\.3"/);
  assert.match(builder, /DinoPatchManagerEngine\.exe/);
  assert.match(builder, /classic-level/);
  assert.match(builder, /manager-engine.*patches.*patch03.*manifest\.json/);
  assert.match(builder, /'theme-leveldb\.cjs'/);
  assert.match(builder, /manager-node\/node_modules/);
  assert.match(read('tests/electron_ui_smoke.cjs'), /path\.join\(sourceRoot, 'DinoPatchManager', 'LilacAnime-DinoPatch\.exe'\)/);
  assert.match(read('tests/electron_ui_smoke.cjs'), /LilacAnime-DinoPatch-Electron-v1\.2\.4-A22-final/);
  assert.match(read('tests/electron_ui_smoke.cjs'), /LilacAnime-DinoPatch-Electron-v1\.2\.4-A22-final/);
  assert.match(read('tests/electron_ui_smoke.cjs'), /DINO_MANAGER_SMOKE_APP_ROOT/);
  assert.match(read('tests/electron_ui_smoke.cjs'), /manager-electron-system-theme\.png/);
  assert.match(read('tests/electron_ui_smoke.cjs'), /__delete_theme__/);
  assert.match(read('tests/electron_ui_smoke.cjs'), /A21-final-vs-\$\{candidateLabel\}-window-comparison\.png/);
});

test('build path validator rejects a target outside the manager release directory', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-manager-path-guard-'));
  try {
    const project = path.join(scratch, 'project');
    const manager = path.join(project, 'tools', 'dino-patch-manager');
    const stage = path.join(scratch, 'stage');
    const engine = path.join(scratch, 'engine');
    const electronDist = path.join(scratch, 'electron');
    for (const directory of [manager, stage, engine, path.join(engine, '_internal'), electronDist]) fs.mkdirSync(directory, { recursive: true });
    for (const file of [path.join(stage, 'main.cjs'), path.join(stage, 'package.json'), path.join(engine, 'DinoPatchManagerEngine.exe'), path.join(scratch, 'node.exe'), path.join(electronDist, 'electron.exe')]) fs.writeFileSync(file, 'test');
    const { validateBuildPaths } = require(path.join(managerRoot, 'build-electron.cjs'));
    assert.throws(() => validateBuildPaths({
      managerRoot: manager,
      projectRoot: project,
      stageRoot: stage,
      engineRoot: engine,
      nodeExe: path.join(scratch, 'node.exe'),
      outputRoot: path.join(scratch, 'outside'),
      electronDist,
      tempRoot: scratch,
    }), /release/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('A27 isolation smoke launches only the package copied inside the isolated official source', () => {
  const smoke = fs.readFileSync(path.join(managerRoot, 'tests', 'electron-profile-isolation-v055.smoke.cjs'), 'utf8');
  assert.match(smoke, /const deployedAppRoot = path\.join\(sourceRoot, 'DinoPatchManager'\)/);
  assert.match(smoke, /const exePath = path\.join\(deployedAppRoot, 'LilacAnime-DinoPatch\.exe'\)/);
  assert.match(smoke, /copyDirectory\(appRoot, deployedAppRoot\)/);
  assert.match(smoke, /copyOfficialSnapshot\(sourceRoot, path\.join\(testRoot, 'official-patched'\), appliedEntries\)/);
  assert.match(smoke, /requireTempDirectory\(deployedAppRoot, 'Copied A27 deployment'\)/);
  assert.match(smoke, /restart-auto-reapply/);
  assert.doesNotMatch(smoke, /click\(second\.cdp, '#apply'\)/);
  assert.match(smoke, /click\(third\.cdp, '#restore'\)/);
  assert.match(smoke, /ToBase64String\(\[Text\.Encoding\]::Unicode\.GetBytes\(\$json\)\)/);
  assert.match(smoke, /toString\('utf16le'\)/);
});

test('live provider smoke pins the official app profile switches and saves state captures', () => {
  const smoke = fs.readFileSync(path.join(__dirname, 'patch03-providers-live.electron.cjs'), 'utf8');
  assert.match(smoke, /\['appData', 'userData', 'sessionData', 'localAppData', 'cache', 'temp', 'logs', 'crashDumps'\]/);
  assert.match(smoke, /pinSwitch\('user-data-dir', paths\.userData\)/);
  assert.match(smoke, /pinSwitch\('disk-cache-dir', paths\.cache\)/);
  assert.match(smoke, /pinSwitch\('crash-dumps-dir', paths\.crashDumps\)/);
  assert.match(smoke, /captureUiState\('startup-home'\)/);
  assert.match(smoke, /captureUiState\('detail-source-picker-episodes'\)/);
  assert.match(smoke, /captureUiState\('playback-frame'\)/);
});
