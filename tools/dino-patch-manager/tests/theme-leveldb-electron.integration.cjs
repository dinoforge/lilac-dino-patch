'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const managerRoot = path.resolve(__dirname, '..');
const appName = 'lilacanime-desktop';
const testThemes = ['dark', 'light', 'system'];

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertTempChild(value, label) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const actual = fs.realpathSync.native(value);
  assert.notEqual(actual.toLocaleLowerCase(), temp.toLocaleLowerCase(), `${label} cannot be OS Temp itself.`);
  assert.ok(isWithin(actual, temp), `${label} must be inside OS Temp.`);
  return actual;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function treeHash(root) {
  const records = [];
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in disposable profile: ${childRelative}`);
      if (entry.isDirectory()) walk(child, childRelative);
      else if (entry.isFile()) records.push([childRelative, hashFile(child)]);
      else throw new Error(`Unexpected non-file in disposable profile: ${childRelative}`);
    }
  };
  walk(root);
  const digest = crypto.createHash('sha256');
  for (const [name, hash] of records) digest.update(name).update('\0').update(hash).update('\n');
  return { count: records.length, sha256: digest.digest('hex').toUpperCase(), records };
}

function copyRegularTree(source, destination) {
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite fixture evidence: ${destination}`);
  fs.mkdirSync(destination, { recursive: false });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in LevelDB source: ${entry.name}`);
    if (entry.isDirectory()) copyRegularTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else throw new Error(`Unexpected non-regular LevelDB source entry: ${entry.name}`);
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function stopOwnedProcessTree(child) {
  if (child.exitCode !== null) return true;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, shell: false });
  } else {
    child.kill();
  }
  return waitForExit(child, 5000);
}

function writeElectronThemeProfile({ electronExe, profileRoot, theme, originUrl = null }) {
  const appData = path.join(profileRoot, 'appData');
  const paths = {
    appData,
    userData: path.join(profileRoot, 'userData'),
    // Electron stores Chromium Local Storage beneath sessionData. Mirror the
    // official default's appData/<appName> Local Storage location while keeping
    // the explicit userData and sessionData paths distinct for this probe.
    sessionData: path.join(appData, appName),
    temp: path.join(profileRoot, 'temp'),
    cache: path.join(profileRoot, 'cache'),
    logs: path.join(profileRoot, 'logs'),
    crashDumps: path.join(profileRoot, 'crashDumps'),
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  const resultFile = path.join(profileRoot, `electron-paths-${crypto.randomUUID()}.json`);
  const htmlFile = path.join(profileRoot, 'theme.html');
  const preloadFile = path.join(profileRoot, 'preload.cjs');
  const mainFile = path.join(profileRoot, 'probe-main.cjs');
  fs.writeFileSync(htmlFile, `<!doctype html><meta charset="utf-8"><script>const value=new URLSearchParams(location.search).get('theme'); if(value==='__delete_theme__') localStorage.removeItem('theme'); else localStorage.setItem('theme',value); window.themeProbe.complete(location.origin, value==='__delete_theme__'?null:value);</script>`, 'utf8');
  fs.writeFileSync(preloadFile, [
    "const { contextBridge, ipcRenderer } = require('electron');",
    "contextBridge.exposeInMainWorld('themeProbe', { complete: (origin, value) => ipcRenderer.send('theme-probe-complete', { origin, value }) });",
  ].join('\n'), 'utf8');
  fs.writeFileSync(mainFile, [
    "const { app, BrowserWindow, ipcMain } = require('electron');",
    "const fs = require('node:fs'); const path = require('node:path');",
    `const paths = ${JSON.stringify(paths)}; const resultFile = ${JSON.stringify(resultFile)}; const expectedValue = ${JSON.stringify(theme === '__delete_theme__' ? null : theme)}; const expectedOrigin = ${JSON.stringify(originUrl ? new URL(originUrl).origin : 'file://')}; const pageUrl = ${JSON.stringify(originUrl)}; const htmlFile = ${JSON.stringify(htmlFile)};`,
    `app.setName(${JSON.stringify(appName)});`,
    "for (const key of ['appData','userData','sessionData','temp','logs','crashDumps']) app.setPath(key, paths[key]);",
    "app.commandLine.appendSwitch('disk-cache-dir', paths.cache);",
    "app.whenReady().then(() => {",
    "  ipcMain.once('theme-probe-complete', (_event, payload) => {",
    "    if (!payload || payload.origin !== expectedOrigin || payload.value !== expectedValue) { console.error('isolated storage probe mismatch'); app.exit(2); return; }",
    "    const actual = {}; for (const key of ['appData','userData','sessionData','temp','logs','crashDumps']) actual[key] = app.getPath(key); actual.cache = app.commandLine.getSwitchValue('disk-cache-dir');",
    "    fs.writeFileSync(resultFile, JSON.stringify({ origin: payload.origin, value: payload.value, paths: actual }), { flag: 'wx' });",
    "    setTimeout(() => app.quit(), 400);",
    "  });",
    `  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } }); const url = pageUrl ? new URL(pageUrl) : null; if (url) { url.searchParams.set('theme', ${JSON.stringify(theme)}); win.loadURL(url.href).catch(error => { console.error(error.stack || error); app.exit(2); }); } else { win.loadFile(htmlFile, { query: { theme: ${JSON.stringify(theme)} } }).catch(error => { console.error(error.stack || error); app.exit(2); }); }`,
    "}).catch(error => { console.error(error.stack || error); app.exit(2); });",
    "app.on('window-all-closed', () => app.quit());",
  ].join('\n'), 'utf8');

  const child = spawn(electronExe, [mainFile], {
    cwd: profileRoot,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APPDATA: appData },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { if (output.length < 5000) output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (output.length < 5000) output += chunk.toString('utf8'); });
  return { child, paths, resultFile, expectedOrigin: originUrl ? new URL(originUrl).origin : 'file://', output: () => output, wait: () => waitForExit(child, 15000) };
}

async function writeThemeAndClose(options) {
  const probe = writeElectronThemeProfile(options);
  if (!(await probe.wait())) {
    const stopped = await stopOwnedProcessTree(probe.child);
    throw new Error(`Electron theme writer timed out; its owned process tree stopped=${stopped}. ${probe.output()}`);
  }
  assert.equal(probe.child.exitCode, 0, `Isolated Electron theme writer failed: ${probe.output()}`);
  assert.ok(fs.existsSync(probe.resultFile), 'Electron did not report successful file:// localStorage completion.');
  const result = JSON.parse(fs.readFileSync(probe.resultFile, 'utf8'));
  assert.equal(result.origin, probe.expectedOrigin);
  for (const [key, expected] of Object.entries(probe.paths)) {
    const actual = key === 'cache' ? result.paths.cache : result.paths[key];
    assert.equal(path.resolve(actual).toLowerCase(), path.resolve(expected).toLowerCase(), `Electron app.getPath(${key}) must be isolated.`);
    assert.ok(isWithin(actual, path.dirname(options.profileRoot)), `Electron ${key} must stay under OS Temp.`);
  }
  const sessionLevelDbPath = path.join(probe.paths.sessionData, 'Local Storage', 'leveldb');
  assert.ok(fs.existsSync(path.join(sessionLevelDbPath, 'CURRENT')), 'Chromium must create its file-origin Local Storage LevelDB under its configured sessionData.');
  return { levelDbPath: sessionLevelDbPath, paths: probe.paths };
}

function makeOfficialSourceFixture(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'electron'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: appName, version: '0.5.54' }), 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), "const theme = localStorage.getItem('theme') || 'dark'; localStorage.setItem('theme', theme);", 'utf8');
  fs.writeFileSync(path.join(root, 'electron', 'main.cjs'), "win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));", 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'index.html'), '<!doctype html>', 'utf8');
}

async function readTheme({ electronExe, runRoot, sourceRoot, appDataRoot, moduleRoot, busy = false }) {
  const readerRoot = path.join(runRoot, `electron-theme-reader-${crypto.randomUUID()}`);
  const paths = {
    appData: path.join(readerRoot, 'appData'),
    userData: path.join(readerRoot, 'userData'),
    sessionData: path.join(readerRoot, 'sessionData'),
    temp: path.join(readerRoot, 'temp'),
    cache: path.join(readerRoot, 'cache'),
    logs: path.join(readerRoot, 'logs'),
    crashDumps: path.join(readerRoot, 'crashDumps'),
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  const resultFile = path.join(readerRoot, 'theme-read-result.json');
  const readerMain = path.join(readerRoot, 'reader-main.cjs');
  const helperPath = path.join(managerRoot, 'electron-app', 'theme-leveldb.cjs');
  fs.writeFileSync(readerMain, [
    "const { app, nativeTheme } = require('electron');",
    "const fs = require('node:fs');",
    `const paths = ${JSON.stringify(paths)}; const resultFile = ${JSON.stringify(resultFile)};`,
    `const sourceRoot = ${JSON.stringify(sourceRoot)}; const appDataRoot = ${JSON.stringify(appDataRoot)}; const moduleRoot = ${JSON.stringify(moduleRoot)}; const helperPath = ${JSON.stringify(helperPath)};`,
    `const busy = ${JSON.stringify(Boolean(busy))};`,
    "app.setName('DinoThemeReaderProbe');",
    "for (const key of ['appData','userData','sessionData','temp','logs','crashDumps']) app.setPath(key, paths[key]);",
    "app.commandLine.appendSwitch('disk-cache-dir', paths.cache);",
    "app.whenReady().then(async () => { const helper = require(helperPath); const result = await helper.readOfficialLevelDbTheme(sourceRoot, { appDataRoot, moduleRoot, managerPid: process.pid, detectRunning: () => busy ? ({status:'BUSY',reason:'synthetic busy fixture'}) : ({status:'SAFE'}), resolveSystemTheme: () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light' }); const runtimePaths = {}; for (const key of ['appData','userData','sessionData','temp','logs','crashDumps']) runtimePaths[key] = app.getPath(key); runtimePaths.cache = app.commandLine.getSwitchValue('disk-cache-dir'); fs.writeFileSync(resultFile, JSON.stringify({result,runtimePaths}), {flag:'wx'}); app.quit(); }).catch(error => { console.error(error.stack || error); app.exit(2); });",
  ].join('\n'), 'utf8');
  const child = spawn(electronExe, [readerMain], { cwd: readerRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let output = '';
  child.stdout.on('data', (chunk) => { if (output.length < 5000) output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (output.length < 5000) output += chunk.toString('utf8'); });
  if (!(await waitForExit(child, 15000))) {
    const stopped = await stopOwnedProcessTree(child);
    throw new Error(`Electron LevelDB reader timed out; its owned process tree stopped=${stopped}. ${output}`);
  }
  assert.equal(child.exitCode, 0, `Electron LevelDB reader failed: ${output}`);
  const payload = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const runtimePaths = payload.runtimePaths;
  const actualPaths = ['appData', 'userData', 'sessionData', 'temp', 'cache', 'logs', 'crashDumps'].map((key) => path.resolve(runtimePaths[key]).toLowerCase());
  assert.equal(new Set(actualPaths).size, 7, 'The Electron reader must use seven distinct Temp runtime paths.');
  for (const value of Object.values(runtimePaths)) assert.ok(isWithin(value, readerRoot), 'The Electron reader runtime must remain in its OS Temp profile.');
  return payload.result;
}

async function startForeignOriginFixtureServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end("<!doctype html><meta charset='utf-8'><script>const value=new URLSearchParams(location.search).get('theme');localStorage.setItem('theme',value);window.themeProbe.complete(location.origin,value);</script>");
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function run() {
  if (process.platform !== 'win32') throw new Error('This integration test requires Windows Electron 38.8.6.');
  const [moduleRootArg, fixtureParentArg] = process.argv.slice(2);
  if (!moduleRootArg || !fixtureParentArg) throw new Error('Usage: node theme-leveldb-electron.integration.cjs <temp-module-root> <project-test-artifacts-root>');
  const temp = fs.realpathSync.native(os.tmpdir());
  const moduleRoot = assertTempChild(moduleRootArg, 'classic-level package root');
  const fixtureParent = fs.realpathSync.native(fixtureParentArg);
  if (!isWithin(fixtureParent, managerRoot) || fixtureParent === managerRoot) throw new Error('Fixture output must be inside the manager test-artifacts directory.');
  const packageJson = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'electron', 'package.json'), 'utf8'));
  const electronExe = path.join(moduleRoot, 'electron', 'dist', 'electron.exe');
  assert.equal(packageJson.version, '38.8.6');
  assert.ok(fs.existsSync(electronExe), 'Existing Electron 38.8.6 runtime is required.');
  const runRoot = fs.mkdtempSync(path.join(temp, 'DinoTheme-Electron-LevelDB-'));
  const sourceRoot = path.join(runRoot, 'official-v0.5.54-contract');
  const profileRoot = path.join(runRoot, 'electron-profile');
  const appDataRoot = path.join(profileRoot, 'appData');
  const appNameRoot = path.join(appDataRoot, appName);
  fs.mkdirSync(sourceRoot, { recursive: false });
  fs.mkdirSync(profileRoot, { recursive: false });
  fs.mkdirSync(appDataRoot, { recursive: false });
  makeOfficialSourceFixture(sourceRoot);
  const profiles = {};
  const copiedFixtures = [];
  let cleanOnSuccess = true;
  try {
    for (const theme of testThemes) {
      const written = await writeThemeAndClose({ electronExe, profileRoot, theme });
      process.stderr.write(`stage=electron-stored-${theme}\n`);
      const officialDefaultStoragePath = path.join(appNameRoot, 'Local Storage', 'leveldb');
      assert.equal(path.resolve(written.levelDbPath).toLowerCase(), path.resolve(officialDefaultStoragePath).toLowerCase());
      process.stderr.write(`stage=reader-open-${theme}\n`);
      const result = await readTheme({ electronExe, runRoot, sourceRoot, appDataRoot, moduleRoot });
      assert.deepEqual({ status: result.status, setting: result.setting, theme: result.theme, readOnly: result.readOnly }, {
        status: 'READ', setting: theme, theme: theme === 'system' ? 'light' : theme, readOnly: true,
      });
      const snapshot = treeHash(officialDefaultStoragePath);
      const after = await readTheme({ electronExe, runRoot, sourceRoot, appDataRoot, moduleRoot });
      assert.deepEqual({ status: after.status, setting: after.setting, theme: after.theme }, { status: 'READ', setting: theme, theme: theme === 'system' ? 'light' : theme });
      const afterSnapshot = treeHash(officialDefaultStoragePath);
      assert.deepEqual(afterSnapshot, snapshot, 'The official Local Storage database source must remain unchanged by reads.');
      const fixtureDestination = path.join(fixtureParent, `${theme}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
      copyRegularTree(officialDefaultStoragePath, fixtureDestination);
      const fixtureDigest = treeHash(fixtureDestination);
      profiles[theme] = { result: after, sourceDatabaseHash: snapshot.sha256, savedFixture: fixtureDestination, savedFixtureHash: fixtureDigest.sha256 };
      copiedFixtures.push(fixtureDestination);
    }

    await writeThemeAndClose({ electronExe, profileRoot, theme: 'dark' });
    await writeThemeAndClose({ electronExe, profileRoot, theme: 'light' });
    const latest = await readTheme({ electronExe, runRoot, sourceRoot, appDataRoot, moduleRoot });
    assert.equal(latest.setting, 'light', 'Newest valid file-origin value must win over older values and a foreign origin.');

    await writeThemeAndClose({ electronExe, profileRoot, theme: 'dark' });
    const foreign = await startForeignOriginFixtureServer();
    try {
      await writeThemeAndClose({ electronExe, profileRoot, theme: 'light', originUrl: foreign.url });
    } finally {
      await new Promise((resolve, reject) => foreign.server.close((error) => error ? reject(error) : resolve()));
    }
    const foreignOriginIgnored = await readTheme({ electronExe, runRoot, sourceRoot, appDataRoot, moduleRoot });
    assert.equal(foreignOriginIgnored.setting, 'dark', 'A newer setting under another origin must not replace the official file-origin theme.');

    await writeThemeAndClose({ electronExe, profileRoot, theme: 'dark' });
    await writeThemeAndClose({ electronExe, profileRoot, theme: '__delete_theme__' });
    const deleted = await readTheme({ electronExe, runRoot, sourceRoot, appDataRoot, moduleRoot });
    assert.equal(deleted.status, 'FALLBACK', 'A tombstone must not resurrect an older theme value.');

    const missingAppData = path.join(runRoot, 'missing-appData');
    fs.mkdirSync(missingAppData, { recursive: false });
    const missing = await readTheme({ electronExe, runRoot, sourceRoot, appDataRoot: missingAppData, moduleRoot });
    assert.equal(missing.status, 'NOT_PRESENT');
    const busy = await readTheme({ electronExe, runRoot, sourceRoot, appDataRoot, moduleRoot, busy: true });
    assert.equal(busy.status, 'FALLBACK');
    const corruptProfile = path.join(runRoot, 'corrupt-appData');
    copyRegularTree(appDataRoot, corruptProfile);
    fs.writeFileSync(path.join(corruptProfile, appName, 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-MISSING\n', 'utf8');
    const corrupt = await readTheme({ electronExe, runRoot, sourceRoot, appDataRoot: corruptProfile, moduleRoot });
    assert.equal(corrupt.status, 'FALLBACK');

    const summary = {
      status: 'PASS',
      electronVersion: packageJson.version,
      officialContract: { version: '0.5.54', appName, origin: 'file://' },
      settings: profiles,
      latestWriteWins: true,
      foreignOriginIgnored: foreignOriginIgnored.setting === 'dark',
      deletionMarkerHonored: true,
      missingDatabaseFallback: true,
      busyDatabaseFallback: true,
      corruptDatabaseFallback: true,
      originalDatabaseMutatedByReader: false,
      retainedDisposableFixtures: copiedFixtures,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    cleanOnSuccess = false;
    process.stderr.write(`Theme LevelDB Temp evidence retained at ${runRoot}\n`);
    throw error;
  } finally {
    if (cleanOnSuccess) {
      const resolvedRunRoot = fs.realpathSync.native(runRoot);
      if (resolvedRunRoot !== temp && isWithin(resolvedRunRoot, temp) && path.basename(resolvedRunRoot).startsWith('DinoTheme-Electron-LevelDB-')) {
        fs.rmSync(resolvedRunRoot, { recursive: true, force: true });
      }
    }
  }
}

run().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
