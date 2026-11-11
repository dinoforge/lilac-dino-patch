const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const managerRoot = path.resolve(__dirname, '..');
const appRoot = path.resolve(process.env.DINO_MANAGER_A27_APP_ROOT || '');
const sourceRoot = path.resolve(process.env.DINO_MANAGER_A27_SOURCE_ROOT || '');
const testRoot = path.resolve(process.env.DINO_MANAGER_A27_TEST_ROOT || '');
const profileRoot = path.join(testRoot, 'manager-profile');
const capturesRoot = path.join(testRoot, 'captures');
const reportsRoot = path.join(testRoot, 'reports');
const packageExePath = path.join(appRoot, 'LilacAnime-DinoPatch.exe');
const deployedAppRoot = path.join(sourceRoot, 'DinoPatchManager');
const exePath = path.join(deployedAppRoot, 'LilacAnime-DinoPatch.exe');
const enginePath = path.join(appRoot, 'resources', 'manager-engine', 'DinoPatchManagerEngine.exe');
const osTempRoot = fs.realpathSync.native(os.tmpdir());
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'patches', 'patch03', 'manifest.json'), 'utf8'));
const profile = manifest.additionalOfficialSources?.find((item) => item.officialVersion === '0.5.55');

function normalized(value) { return path.resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US'); }
function fileHash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }
function within(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function requireTempDirectory(value, label) {
  assert.ok(value && path.isAbsolute(value), `${label} must be an explicit absolute path.`);
  const resolved = fs.realpathSync.native(value);
  assert.equal(normalized(value), normalized(resolved), `${label} must not use a symlink or junction.`);
  assert.ok(within(resolved, osTempRoot) && normalized(resolved) !== normalized(osTempRoot), `${label} must be a dedicated child of OS Temp.`);
  return resolved;
}
function treeEntries(root, excludedTopLevel = new Set()) {
  const entries = new Map();
  function visit(directory, relative = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relative && excludedTopLevel.has(item.name)) continue;
      const child = path.join(directory, item.name);
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`Unexpected symlink in official source: ${name}`);
      if (item.isDirectory()) visit(child, name);
      else if (item.isFile()) entries.set(name, crypto.createHash('sha256').update(fs.readFileSync(child)).digest('hex').toUpperCase());
      else throw new Error(`Unexpected special file in official source: ${name}`);
    }
  }
  visit(root);
  return entries;
}
function digestEntries(entries) {
  const hash = crypto.createHash('sha256');
  for (const [name, digest] of [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    hash.update(name, 'utf8').update('\0').update(Buffer.from(digest, 'hex')).update('\n');
  }
  return { count: entries.size, sha256: hash.digest('hex').toUpperCase() };
}
function changedFiles(before, after) {
  const result = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (!before.has(name)) result.push({ path: name, kind: 'added' });
    else if (!after.has(name)) result.push({ path: name, kind: 'removed' });
    else if (before.get(name) !== after.get(name)) result.push({ path: name, kind: 'modified' });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function copyDirectory(source, destination) {
  assert.ok(fs.existsSync(source) && fs.statSync(source).isDirectory(), 'A27 app package must exist.');
  assert.equal(fs.existsSync(destination), false, 'Refusing to overwrite an existing manager deployment.');
  const result = spawnSync('robocopy.exe', [path.resolve(source), path.resolve(destination), '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:0', '/W:0', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (result.error || result.status === null || result.status >= 8) throw new Error(`A27 package copy failed (${result.status ?? result.error?.code ?? 'unknown'}).`);
}
function copyOfficialSnapshot(sourceRoot, snapshotRoot, entries) {
  assert.equal(fs.existsSync(snapshotRoot), false, 'Refusing to overwrite an existing patched-source snapshot.');
  fs.mkdirSync(snapshotRoot);
  requireTempDirectory(snapshotRoot, 'Patched official source snapshot');
  for (const name of [...entries.keys()].sort()) {
    const source = path.join(sourceRoot, ...name.split('/'));
    const target = path.join(snapshotRoot, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  const snapshot = digestEntries(treeEntries(snapshotRoot));
  assert.deepEqual(snapshot, digestEntries(entries), 'Patched official source snapshot must match the live A27-applied source tree.');
  return snapshot;
}
function getPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('DevTools request timed out.')));
    request.on('error', reject);
  });
}
async function waitForTarget(child, port, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`A27 exited before DevTools was ready (${child.exitCode}).`);
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('A27 DevTools page did not become ready.');
}
async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || 'DevTools command failed.'));
    else resolve(message.result || {});
  });
  return {
    command(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    },
    close() { try { socket.close(); } catch {} },
  };
}
async function evaluate(cdp, expression) {
  const result = await cdp.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.result?.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
  return result.result?.value;
}
async function waitForUi(cdp, predicate, label, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < end) {
    current = await evaluate(cdp, `(() => ({busy:document.getElementById('busyBadge')?.textContent?.trim() || '', patch:document.getElementById('patchBadge')?.textContent?.trim() || '', message:document.getElementById('message')?.textContent?.trim() || '', detail:document.getElementById('detail')?.textContent?.trim() || '', backupCount:document.getElementById('backupSelect')?.options.length || 0, root:document.getElementById('targetPath')?.textContent?.trim() || ''}))()`);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(current)}`);
}
async function click(cdp, selector) {
  const result = await evaluate(cdp, `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e||e.disabled)return false; for(let p=e.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement)p.open=true; e.click(); return true; })()`);
  assert.equal(result, true, `${selector} must be available in the manager UI.`);
}
async function saveScreenshot(cdp, filePath) {
  const result = await cdp.command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'), { flag: 'wx' });
}
function processTree(rootPid) {
  const script = `$ErrorActionPreference='Stop'; $rootId=${Number(rootPid)}; $all=@(Get-CimInstance Win32_Process); $owned=[System.Collections.Generic.HashSet[uint32]]::new(); [void]$owned.Add([uint32]$rootId); do{$added=$false;foreach($item in $all){if($owned.Contains([uint32]$item.ParentProcessId)-and $owned.Add([uint32]$item.ProcessId)){$added=$true}}}while($added); $rows=@($all|Where-Object{$owned.Contains([uint32]$_.ProcessId)}|Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine); $json=ConvertTo-Json -InputObject $rows -Compress -Depth 4; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($json))`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'ascii', windowsHide: true, shell: false, timeout: 10000 }).trim();
  const json = Buffer.from(output, 'base64').toString('utf16le');
  const parsed = JSON.parse(json || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}
function userDataSwitch(commandLine) {
  const match = /(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(String(commandLine || ''));
  return match ? match[1] || match[2] || match[3] : null;
}
function waitExit(child, ms) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([once(child, 'exit').then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
}
async function closeManager(handle) {
  if (handle.cdp) {
    try { await Promise.race([evaluate(handle.cdp, 'window.close()'), new Promise((resolve) => setTimeout(resolve, 1000))]); } catch {}
    handle.cdp.close();
  }
  if (await waitExit(handle.child, 10000)) return;
  const stop = spawnSync('taskkill.exe', ['/PID', String(handle.child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (stop.status === null || stop.status >= 1 || !(await waitExit(handle.child, 5000))) throw new Error('Could not stop the newly started A27 process tree.');
  throw new Error('A27 did not close normally; only its newly created process tree was stopped.');
}
function processEnvironment(overrides) {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
    if (key && key !== name) { env[key] = value; delete env[name]; }
    else env[name] = value;
  }
  return env;
}
async function launchManager(targetRoot, managerProfile, label, expectedPatch = '적용됨 · 호환') {
  const runtime = Object.fromEntries(['appData', 'userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps', 'localAppData'].map((name) => [name, path.join(managerProfile, name)]));
  for (const folder of Object.values(runtime)) fs.mkdirSync(folder, { recursive: true });
  for (const value of Object.values(runtime)) requireTempDirectory(fs.realpathSync.native(value), `A27 ${label} profile path`);
  assert.equal(new Set(Object.values(runtime).map(normalized)).size, Object.keys(runtime).length, 'A27 profile paths must be distinct.');
  assert.ok(!within(managerProfile, targetRoot) && !within(targetRoot, managerProfile), 'Manager profile and official source must be separate.');
  const portServer = net.createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
  const child = spawn(exePath, [
    `--user-data-dir=${runtime.userData}`, `--disk-cache-dir=${runtime.cache}`, `--crash-dumps-dir=${runtime.crashDumps}`,
    `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
  ], {
    cwd: path.dirname(exePath), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: processEnvironment({
      APPDATA: runtime.appData, LOCALAPPDATA: runtime.localAppData, USERPROFILE: managerProfile, HOME: managerProfile,
      TEMP: runtime.temp, TMP: runtime.temp, TMPDIR: runtime.temp,
      DINO_MANAGER_TEST_ROOT: targetRoot, DINO_MANAGER_TEST_PROFILE_ROOT: managerProfile,
      DINO_MANAGER_TEST_OS_TEMP_ROOT: osTempRoot, DINO_MANAGER_AUTOCONFIRM: '1',
    }),
  });
  let output = '';
  child.stdout.on('data', (chunk) => { if (output.length < 16000) output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (output.length < 16000) output += chunk.toString('utf8'); });
  let cdp = null;
  try {
    const target = await waitForTarget(child, port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.command('Runtime.enable');
    await cdp.command('Page.enable');
    const state = await waitForUi(cdp, (item) => item.busy === '대기' && item.patch === expectedPatch, `${label} startup`);
    const info = await evaluate(cdp, 'window.dinoManager.getInfo()');
    assert.ok(info.isPackaged, 'A27 GUI must run from the packaged application.');
    for (const key of ['appData', 'userData', 'sessionData', 'temp', 'cache', 'logs', 'crashDumps', 'chromiumUserData']) {
      assert.equal(info.runtimePaths[key]?.matches, true, `${key} must match the explicitly isolated manager path.`);
      assert.ok(within(info.runtimePaths[key].actual, managerProfile), `${key} must stay under the isolated manager profile.`);
    }
    const tree = processTree(child.pid);
    const exeCanonical = fs.realpathSync.native(exePath).toLocaleLowerCase();
    const processes = tree.filter((item) => item.ExecutablePath && fs.realpathSync.native(item.ExecutablePath).toLocaleLowerCase() === exeCanonical);
    assert.ok(processes.some((item) => Number(item.ProcessId) === Number(child.pid)), 'New A27 main process must be in the inspected process tree.');
    assert.ok(processes.some((item) => /--type=renderer\b/i.test(item.CommandLine || '')), 'A real Chromium renderer process must be in the inspected process tree.');
    const isolatedProcesses = processes.map((item) => {
      assert.ok(item.CommandLine, `A27 process ${item.ProcessId} command line must be readable.`);
      const userData = userDataSwitch(item.CommandLine);
      assert.ok(userData, `A27 process ${item.ProcessId} must expose --user-data-dir.`);
      assert.equal(normalized(fs.realpathSync.native(userData)), normalized(runtime.userData), `A27 process ${item.ProcessId} used a different Chromium profile.`);
      return { pid: Number(item.ProcessId), parentPid: Number(item.ParentProcessId), name: item.Name, type: /--type=([^\s]+)/i.exec(item.CommandLine)?.[1] || 'browser', userDataRelative: path.relative(testRoot, userData) };
    });
    await saveScreenshot(cdp, path.join(capturesRoot, `${label}.png`));
    return { child, cdp, state, info, runtime, isolatedProcesses, output: () => output };
  } catch (error) {
    if (cdp) cdp.close();
    if (child.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, shell: false });
      await waitExit(child, 5000);
    }
    const safeOutput = output.replaceAll(testRoot, '<OS_TEMP_TEST_ROOT>').replaceAll(appRoot, '<A27_PACKAGE>');
    throw new Error(`${label} failed: ${error.message}\n${safeOutput}`, { cause: error });
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'This smoke requires Windows.');
  assert.ok(profile, 'The v0.5.55 compatibility profile must exist.');
  requireTempDirectory(testRoot, 'A27 v0.5.55 test root');
  requireTempDirectory(sourceRoot, 'Official v0.5.55 source');
  requireTempDirectory(profileRoot, 'A27 manager profile root');
  fs.mkdirSync(capturesRoot, { recursive: false });
  fs.mkdirSync(reportsRoot, { recursive: false });
  assert.ok(within(sourceRoot, testRoot) && within(profileRoot, testRoot), 'The official source and manager profile must be children of the new OS Temp test root.');
  assert.ok(!within(sourceRoot, profileRoot) && !within(profileRoot, sourceRoot), 'The official source and manager profile must not overlap.');
  assert.ok(fs.existsSync(packageExePath) && fs.existsSync(enginePath), 'The A27 EXE and bundled Python engine must exist.');
  const packageInfo = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  assert.equal(packageInfo.version, '0.5.55');
  assert.equal(packageInfo.name, 'lilacanime-desktop');
  const beforeEntries = treeEntries(sourceRoot, new Set(['DinoPatchManager']));
  const beforeTree = digestEntries(beforeEntries);
  assert.equal(beforeTree.count, profile.officialTreeFileCount);
  assert.equal(beforeTree.sha256, profile.officialTreeSha256);
  const packageHashes = {
    executable: fileHash(packageExePath),
    appAsar: fileHash(path.join(appRoot, 'resources', 'app.asar')),
    managerEngine: fileHash(enginePath),
  };
  copyDirectory(appRoot, deployedAppRoot);
  requireTempDirectory(deployedAppRoot, 'Copied A27 deployment');
  assert.equal(fileHash(exePath), packageHashes.executable, 'Copied A27 shell EXE must match the read-only build input.');
  assert.equal(fileHash(path.join(deployedAppRoot, 'resources', 'app.asar')), packageHashes.appAsar, 'Copied A27 app.asar must match the read-only build input.');
  const deployedEngine = path.join(deployedAppRoot, 'resources', 'manager-engine', 'DinoPatchManagerEngine.exe');
  assert.equal(fileHash(deployedEngine), packageHashes.managerEngine, 'Copied A27 manager engine must match the read-only build input.');

  const runs = [];
  let first = null;
  let second = null;
  let third = null;
  try {
    first = await launchManager(sourceRoot, profileRoot, 'first-auto-apply');
    assert.ok(first.state.root.toLocaleLowerCase().includes(sourceRoot.toLocaleLowerCase()), 'Manager must auto-detect the v0.5.55 source root.');
    assert.ok(first.state.backupCount >= 1, 'First automatic apply must create a backup.');
    const appliedEntries = treeEntries(sourceRoot, new Set(['DinoPatchManager']));
    const modifications = changedFiles(beforeEntries, appliedEntries);
    assert.deepEqual(modifications, [
      { path: 'src/app.js', kind: 'modified' },
      { path: 'src/index.html', kind: 'modified' },
      { path: 'src/integrated-search.css', kind: 'added' },
      { path: 'src/integrated-search.js', kind: 'added' },
      { path: 'src/patch03-bridge.js', kind: 'added' },
    ]);
    const patchedSnapshot = copyOfficialSnapshot(sourceRoot, path.join(testRoot, 'official-patched'), appliedEntries);
    runs.push({ label: 'first-auto-apply', status: first.state.patch, backupCount: first.state.backupCount, changedFiles: modifications, processes: first.isolatedProcesses });
    await closeManager(first); first = null;

    second = await launchManager(sourceRoot, profileRoot, 'restart-idempotent');
    assert.equal(second.state.backupCount, 1, 'Relaunch must not duplicate the original backup.');
    runs.push({ label: 'restart-idempotent', status: second.state.patch, backupCount: second.state.backupCount, processes: second.isolatedProcesses });
    await click(second.cdp, '#uninstall');
    const uninstalled = await waitForUi(second.cdp, (item) => item.busy === '대기' && item.patch === '호환 · 미적용', 'A27 UI uninstall');
    assert.deepEqual(digestEntries(treeEntries(sourceRoot, new Set(['DinoPatchManager']))), beforeTree, 'Uninstall must restore all official v0.5.55 files.');
    runs.push({ label: 'uninstall', status: uninstalled.patch, officialTreeRestored: true });
    await closeManager(second); second = null;

    third = await launchManager(sourceRoot, profileRoot, 'restart-auto-reapply');
    const reapplied = third.state;
    assert.equal(reapplied.backupCount, 1, 'Reapply must reuse the original backup.');
    runs.push({ label: 'restart-auto-reapply', status: reapplied.patch, backupCount: reapplied.backupCount, processes: third.isolatedProcesses });
    await click(third.cdp, '#restore');
    const restored = await waitForUi(third.cdp, (item) => item.busy === '대기' && item.patch === '호환 · 미적용', 'A27 UI backup restore');
    assert.deepEqual(digestEntries(treeEntries(sourceRoot, new Set(['DinoPatchManager']))), beforeTree, 'Backup restore must return the official tree to the pinned baseline.');
    runs.push({ label: 'backup-restore', status: restored.patch, officialTreeRestored: true });
    await closeManager(third); third = null;

    const finalTree = digestEntries(treeEntries(sourceRoot, new Set(['DinoPatchManager'])));
    assert.deepEqual(finalTree, beforeTree);
    const report = {
      status: 'PASS', officialVersion: profile.officialVersion, officialCommit: profile.officialCommit,
      officialGitTree: '4aa940186722f7aa118fc4dcae843cc84023c84d',
      localArchiveSha256: profile.officialArchiveSha256, officialTree: beforeTree, restoredTree: finalTree,
      packageHashes, patchedSourceSnapshot: { path: 'official-patched', ...patchedSnapshot }, runs, screenshots: ['captures/first-auto-apply.png', 'captures/restart-idempotent.png', 'captures/restart-auto-reapply.png'],
      profilePathMode: 'separate OS Temp directories; actual app.getPath and Chromium process switch checked',
    };
    const reportPath = path.join(reportsRoot, 'a27-v055-isolation-smoke.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ ...report, testRoot: '<OS_TEMP_TEST_ROOT>', reportPath: 'reports/a27-v055-isolation-smoke.json' }, null, 2)}\n`);
  } finally {
    if (first) await closeManager(first);
    if (second) await closeManager(second);
    if (third) await closeManager(third);
  }
}

main().catch((error) => {
  const safeMessage = String(error?.stack || error).replaceAll(testRoot, '<OS_TEMP_TEST_ROOT>').replaceAll(appRoot, '<A27_PACKAGE>');
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
