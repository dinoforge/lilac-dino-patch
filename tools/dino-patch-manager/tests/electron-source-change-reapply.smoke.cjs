const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const osTemp = fs.realpathSync.native(os.tmpdir());
const official054Commit = 'e4ac62214f5c4863eebae5052633e7f9f33dcbaa';
const official054ArchiveSha256 = '007B0141D416614829DACF5494CFC44FD2A1EA80AA58E7E50C856D0FCDBF27CD';
const official055Commit = '207693ea7ee31b83276ac793b35136055a24de26';
const patchModules = new Set([
  'src/integrated-search.js',
  'src/integrated-search.css',
  'src/patch03-bridge.js',
]);
const managerAppRoot = path.resolve(process.env.DINO_MANAGER_PACKAGE_ROOT || '');
const managerLabel = `A${/-A(\d+)-final$/i.exec(path.basename(path.dirname(managerAppRoot)))?.[1] || '35'}`;
const sourceChangeMode = process.env.DINO_MANAGER_SOURCE_CHANGE_MODE || 'running';
const v054Archive = path.resolve(process.env.DINO_MANAGER_OFFICIAL_054_ARCHIVE || '');
const v055ArchiveInput = process.env.DINO_MANAGER_OFFICIAL_055_ARCHIVE ? path.resolve(process.env.DINO_MANAGER_OFFICIAL_055_ARCHIVE) : null;
const testRoot = path.resolve(process.env.DINO_MANAGER_SOURCE_CHANGE_TEST_ROOT || path.join(osTemp, `Dino-${managerLabel}-SourceChange-${crypto.randomUUID()}`));
const sourceRoot = path.join(testRoot, 'LilacAnime-source');
const profileRoot = path.join(testRoot, 'manager-profile');
const archiveRoot = path.join(testRoot, 'archives');
const updatedExtractRoot = path.join(testRoot, 'official-v055-extract');
const captureRoot = path.join(testRoot, 'captures');
const reportPath = path.join(testRoot, 'report.json');

function within(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function requireTempLocation(candidate, label) {
  const resolved = fs.realpathSync.native(candidate);
  assert.ok(within(resolved, osTemp), `${label} must stay in OS Temp.`);
  assert.equal(resolved.toLocaleLowerCase(), path.resolve(candidate).toLocaleLowerCase(), `${label} must not resolve through a link.`);
  return resolved;
}

function requireTempChild(candidate, label) {
  const resolved = requireTempLocation(candidate, label);
  assert.notEqual(resolved.toLocaleLowerCase(), osTemp.toLocaleLowerCase(), `${label} must be a dedicated OS Temp child.`);
  return resolved;
}

function treeEntries(root, excludedTop = new Set()) {
  const result = new Map();
  const visit = (directory, relative = '') => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relative && excludedTop.has(item.name)) continue;
      const absolute = path.join(directory, item.name);
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`Unexpected link in test source: ${name}`);
      if (item.isDirectory()) visit(absolute, name);
      else if (item.isFile()) result.set(name, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex').toUpperCase());
      else throw new Error(`Unexpected special file in test source: ${name}`);
    }
  };
  visit(root);
  return result;
}

function digestEntries(entries) {
  const hash = crypto.createHash('sha256');
  for (const [name, digest] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name, 'utf8').update('\0').update(Buffer.from(digest, 'hex')).update('\n');
  }
  return { count: entries.size, sha256: hash.digest('hex').toUpperCase() };
}

function copyOfficialFiles(source, destination, entries) {
  assert.equal(fs.existsSync(destination), false, 'Refusing to overwrite a test source directory.');
  fs.mkdirSync(destination, { recursive: false });
  for (const name of [...entries.keys()].sort()) {
    const target = path.join(destination, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, ...name.split('/')), target, fs.constants.COPYFILE_EXCL);
  }
  assert.deepEqual(digestEntries(treeEntries(destination)), digestEntries(entries), 'Copied official source must match its verified snapshot.');
}

function downloadArchive(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many official source archive redirects.'));
    const request = https.get(url, { headers: { 'User-Agent': `DinoPatchManager-${managerLabel}-SourceChange-Smoke` } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(downloadArchive(new URL(response.headers.location, url), destination, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Official source archive request failed with HTTP ${response.statusCode}.`));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) request.destroy(new Error('Official source archive exceeded 32 MiB.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (!size) return reject(new Error('Official source archive was empty.'));
        try {
          fs.writeFileSync(destination, Buffer.concat(chunks), { flag: 'wx' });
          resolve(destination);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(90000, () => request.destroy(new Error('Official source archive request timed out.')));
    request.on('error', reject);
  });
}

function validateArchiveEntries(archive) {
  const listing = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000 });
  for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replace(/\\/g, '/');
    assert.equal(path.posix.isAbsolute(normalized), false, `Archive contains an absolute path: ${entry}`);
    assert.equal(/^[A-Za-z]:/.test(normalized), false, `Archive contains a drive path: ${entry}`);
    assert.equal(normalized.split('/').includes('..'), false, `Archive contains a traversal path: ${entry}`);
  }
}

function extractOfficialArchive(archive, destination, expectedDirectory) {
  fs.mkdirSync(destination, { recursive: false });
  validateArchiveEntries(archive);
  execFileSync('tar', ['-xf', archive, '-C', destination], { cwd: destination, windowsHide: true, shell: false, timeout: 120000 });
  const root = path.join(destination, expectedDirectory);
  requireTempChild(root, 'Extracted official source');
  return root;
}

function overlayOfficialUpdate(liveRoot, updateRoot) {
  const before = treeEntries(liveRoot, new Set(['DinoPatchManager']));
  const updated = treeEntries(updateRoot);
  for (const name of before.keys()) {
    if (updated.has(name) || patchModules.has(name)) continue;
    fs.unlinkSync(path.join(liveRoot, ...name.split('/')));
  }
  for (const name of updated.keys()) {
    const destination = path.join(liveRoot, ...name.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(updateRoot, ...name.split('/')), destination);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(liveRoot, 'package.json'), 'utf8')).version, '0.5.55');
  return { before: digestEntries(before), official: digestEntries(updated) };
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
    const request = require('node:http').get(url, { timeout: 1500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('DevTools endpoint timed out.')));
    request.on('error', reject);
  });
}

async function waitForTarget(child, port) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`${managerLabel} exited before DevTools was ready (${child.exitCode}).`);
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${managerLabel} DevTools page did not become ready.`);
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
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message || 'DevTools command failed.'));
    else item.resolve(message.result || {});
  });
  return {
    command(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch {} },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.result?.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
  return result.result?.value;
}

async function waitForUi(cdp, predicate, label, timeoutMs = 180000) {
  const end = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < end) {
    latest = await evaluate(cdp, `(() => ({patch:document.getElementById('patchBadge')?.textContent?.trim()||'',busy:document.getElementById('busyBadge')?.textContent?.trim()||'',message:document.getElementById('message')?.textContent?.trim()||'',detail:document.getElementById('detail')?.textContent?.trim()||'',backupCount:document.getElementById('backupSelect')?.options.length||0}))()`);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

async function saveScreenshot(cdp, filename) {
  const result = await cdp.command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(filename, Buffer.from(result.data, 'base64'), { flag: 'wx' });
}

function commandSwitch(commandLine, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)["']?--${escaped}=([^"']+)["'](?=\\s|$)|(?:^|\\s)--${escaped}=(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, 'i').exec(String(commandLine || ''));
  return match ? match[1] || match[2] || match[3] || match[4] : null;
}

function inspectProcessTree(rootPid, exePath, expectedUserData) {
  const script = `$ErrorActionPreference='Stop'; $rootId=${Number(rootPid)}; $all=@(Get-CimInstance Win32_Process); $owned=[System.Collections.Generic.HashSet[uint32]]::new(); [void]$owned.Add([uint32]$rootId); do{$added=$false;foreach($item in $all){if($owned.Contains([uint32]$item.ParentProcessId)-and $owned.Add([uint32]$item.ProcessId)){$added=$true}}}while($added); $rows=@($all|Where-Object{$owned.Contains([uint32]$_.ProcessId)}|Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine); $json=ConvertTo-Json -InputObject $rows -Compress -Depth 4; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($json))`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'ascii', windowsHide: true, shell: false, timeout: 10000 }).trim();
  const parsed = JSON.parse(Buffer.from(output, 'base64').toString('utf16le') || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const normalizedExe = fs.realpathSync.native(exePath).toLocaleLowerCase();
  const electronRows = rows.filter((item) => item.ExecutablePath && fs.realpathSync.native(item.ExecutablePath).toLocaleLowerCase() === normalizedExe);
  assert.ok(electronRows.some((item) => Number(item.ProcessId) === Number(rootPid)), `Process inventory must include the newly launched ${managerLabel} main process.`);
  assert.ok(electronRows.some((item) => /--type=renderer\b/i.test(item.CommandLine || '')), 'A Chromium renderer child must be present.');
  const inspected = [];
  for (const item of electronRows) {
    const type = /--type=([^\s]+)/i.exec(item.CommandLine || '')?.[1] || 'browser';
    if (type === 'crashpad-handler') continue;
    const profile = commandSwitch(item.CommandLine, 'user-data-dir');
    assert.ok(profile, `Chromium process ${item.ProcessId} (${type}) must expose --user-data-dir.`);
    assert.equal(fs.realpathSync.native(profile).toLocaleLowerCase(), fs.realpathSync.native(expectedUserData).toLocaleLowerCase(), `Chromium process ${item.ProcessId} must use the isolated userData.`);
    inspected.push({ pid: Number(item.ProcessId), parentPid: Number(item.ParentProcessId), name: item.Name, type, userData: profile });
  }
  return inspected;
}

async function launchManager({ expectedStartupPatch = '적용됨' } = {}) {
  const packagedExe = path.join(managerAppRoot, 'LilacAnime-DinoPatch.exe');
  const packagedEngine = path.join(managerAppRoot, 'resources', 'manager-engine', 'DinoPatchManagerEngine.exe');
  assert.ok(fs.existsSync(packagedExe) && fs.existsSync(packagedEngine), `${managerLabel} package and bundled engine must exist.`);
  const deployed = path.join(sourceRoot, 'DinoPatchManager');
  const copy = spawnSync('robocopy.exe', [path.resolve(managerAppRoot), path.resolve(deployed), '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:0', '/W:0', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (copy.error || copy.status === null || copy.status >= 8) throw new Error(`Could not deploy ${managerLabel} into the isolated source (${copy.error?.message || copy.status}).`);
  const exe = path.join(deployed, 'LilacAnime-DinoPatch.exe');
  const engine = path.join(deployed, 'resources', 'manager-engine', 'DinoPatchManagerEngine.exe');
  assert.ok(fs.existsSync(exe) && fs.existsSync(engine), `${managerLabel} must be executed from the DinoPatchManager folder inside the isolated source.`);
  const runtime = Object.fromEntries(['appData', 'userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps', 'localAppData'].map((name) => [name, path.join(profileRoot, name)]));
  for (const value of Object.values(runtime)) fs.mkdirSync(value, { recursive: true });
  for (const value of Object.values(runtime)) requireTempChild(value, 'Manager runtime path');
  assert.equal(new Set(Object.values(runtime).map((value) => value.toLocaleLowerCase())).size, Object.keys(runtime).length, 'Manager runtime paths must be distinct.');
  const portServer = net.createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
  const child = spawn(exe, [
    `--user-data-dir=${runtime.userData}`,
    `--disk-cache-dir=${runtime.cache}`,
    `--crash-dumps-dir=${runtime.crashDumps}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
  ], {
    cwd: deployed,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      APPDATA: runtime.appData,
      LOCALAPPDATA: runtime.localAppData,
      USERPROFILE: profileRoot,
      HOME: profileRoot,
      DINO_MANAGER_TEST_OS_TEMP_ROOT: osTemp,
      DINO_MANAGER_TEST_ROOT: sourceRoot,
      DINO_MANAGER_TEST_PROFILE_ROOT: profileRoot,
      DINO_MANAGER_AUTOCONFIRM: '1',
      TEMP: runtime.temp,
      TMP: runtime.temp,
      TMPDIR: runtime.temp,
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { if (output.length < 20000) output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (output.length < 20000) output += chunk.toString('utf8'); });
  let cdp;
  try {
    const target = await waitForTarget(child, port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.command('Runtime.enable');
    await cdp.command('Page.enable');
    const state = await waitForUi(cdp, (value) => value.busy === '대기' && value.patch.includes(expectedStartupPatch), `${managerLabel} initial startup state`);
    const info = await evaluate(cdp, 'window.dinoManager.getInfo()');
    for (const key of ['appData', 'userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps', 'chromiumUserData']) {
      assert.equal(info.runtimePaths[key].matches, true, `${key} must be isolated to this OS Temp profile.`);
    }
    const childPaths = inspectProcessTree(child.pid, exe, runtime.userData);
    return { child, cdp, state, info, runtime, childPaths, output: () => output };
  } catch (error) {
    if (cdp) cdp.close();
    await stopOwnedProcess(child);
    throw new Error(`${managerLabel} GUI launch failed: ${error.message}${output ? `\n${output}` : ''}`, { cause: error });
  }
}

function waitExit(child, milliseconds) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([once(child, 'exit').then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), milliseconds))]);
}

async function stopOwnedProcess(child) {
  if (child.exitCode !== null) return true;
  const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, shell: false });
  if (stopped.status === null || stopped.status >= 1 || !(await waitExit(child, 5000))) throw new Error(`Could not stop the newly created ${managerLabel} process tree.`);
  return false;
}

async function closeManager(handle) {
  if (!handle) return true;
  try { await Promise.race([evaluate(handle.cdp, 'window.close()'), new Promise((resolve) => setTimeout(resolve, 1000))]); } catch {}
  handle.cdp.close();
  if (await waitExit(handle.child, 10000)) return true;
  await stopOwnedProcess(handle.child);
  throw new Error(`${managerLabel} did not close normally; only its newly created process tree was stopped.`);
}

async function main() {
  assert.equal(process.platform, 'win32', 'This smoke test requires Windows Electron.');
  assert.ok(['running', 'closed'].includes(sourceChangeMode), 'Source change mode must be running or closed.');
  assert.ok(fs.existsSync(v054Archive), 'A previously verified v0.5.54 archive is required.');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v054Archive)).digest('hex').toUpperCase(), official054ArchiveSha256, 'The v0.5.54 input archive must match its pinned SHA-256.');
  assert.equal(fs.existsSync(testRoot), false, 'Refusing to overwrite a prior source-change test root.');
  requireTempLocation(path.dirname(testRoot), 'Test root parent');
  fs.mkdirSync(testRoot, { recursive: false });
  requireTempChild(testRoot, 'Test root');
  fs.mkdirSync(archiveRoot, { recursive: false });
  fs.mkdirSync(captureRoot, { recursive: false });
  fs.mkdirSync(profileRoot, { recursive: false });
  const baseExtractRoot = path.join(testRoot, 'official-v054-extract');
  const source054 = extractOfficialArchive(v054Archive, baseExtractRoot, `LilacAnime-desktop-${official054Commit}`);
  const baseEntries = treeEntries(source054);
  assert.equal(baseEntries.size, 141, 'The official v0.5.54 source file count must match the verified baseline.');
  copyOfficialFiles(source054, sourceRoot, baseEntries);

  const updatedArchive = path.join(archiveRoot, `official-${official055Commit}.zip`);
  if (v055ArchiveInput) {
    const verifiedArchive = fs.realpathSync.native(v055ArchiveInput);
    requireTempChild(path.dirname(verifiedArchive), 'Reused v0.5.55 archive parent');
    fs.copyFileSync(verifiedArchive, updatedArchive, fs.constants.COPYFILE_EXCL);
  } else {
    await downloadArchive(`https://github.com/whispelyn-byte/LilacAnime-desktop/archive/${official055Commit}.zip`, updatedArchive);
  }
  const updatedSource = extractOfficialArchive(updatedArchive, updatedExtractRoot, `LilacAnime-desktop-${official055Commit}`);
  const updatedPackage = JSON.parse(fs.readFileSync(path.join(updatedSource, 'package.json'), 'utf8'));
  assert.equal(updatedPackage.version, '0.5.55', 'The update fixture must be official v0.5.55 source.');
  const updatedEntries = treeEntries(updatedSource);
  assert.equal(updatedEntries.size, 145, 'The v0.5.55 source file count must match the recorded official version.');

  let handle = await launchManager();
  try {
    await saveScreenshot(handle.cdp, path.join(captureRoot, `${managerLabel.toLowerCase()}-v054-applied-before-source-change.png`));
    const beforeUpdate = digestEntries(treeEntries(sourceRoot, new Set(['DinoPatchManager'])));
    let overlayReport;
    let reapplied;
    if (sourceChangeMode === 'closed') {
      await closeManager(handle);
      handle = null;
      overlayReport = overlayOfficialUpdate(sourceRoot, updatedSource);
      handle = await launchManager();
      reapplied = handle.state;
      assert.ok(reapplied.detail.includes('v0.5.55') && reapplied.detail.includes('자동 적용'), 'A fresh manager launch must detect the source update made while it was closed and reapply the compatible patch.');
      await saveScreenshot(handle.cdp, path.join(captureRoot, `${managerLabel.toLowerCase()}-source-update-after-restart.png`));
    } else {
      overlayReport = overlayOfficialUpdate(sourceRoot, updatedSource);
      await saveScreenshot(handle.cdp, path.join(captureRoot, `${managerLabel.toLowerCase()}-source-update-in-progress.png`));
      reapplied = await waitForUi(
        handle.cdp,
        (state) => state.busy === '대기' && state.patch.includes('적용됨') && state.detail.includes('v0.5.55') && state.detail.includes('자동 적용'),
        `${managerLabel} detects the official source change and reapplies the compatible patch`,
        240000,
      );
    }
    const backupResult = await evaluate(handle.cdp, 'window.dinoManager.backups()');
    const backups = Array.isArray(backupResult.items) ? backupResult.items : [];
    assert.equal(backups.length, 2, 'The superseded original backup and one current-version backup must be retained.');
    assert.equal(backups.filter((item) => item.restorable === true).length, 1, 'Only the v0.5.55 backup may remain restorable.');
    const history = await evaluate(handle.cdp, 'window.dinoManager.history()');
    assert.ok(history.items.some((item) => item.action === 'OFFICIAL_SOURCE_CHANGE_DETECTED' && item.result === 'PASS'), 'The source transition must be recorded as verified.');
    const liveEntries = treeEntries(sourceRoot, new Set(['DinoPatchManager']));
    const extras = [...liveEntries.keys()].filter((name) => !updatedEntries.has(name));
    assert.deepEqual(new Set(extras), patchModules, 'Only the three declared Dino Patch modules may be added.');
    const changedOfficial = [...updatedEntries.keys()].filter((name) => liveEntries.get(name) && liveEntries.get(name) !== updatedEntries.get(name));
    assert.deepEqual(new Set(changedOfficial), new Set(['src/app.js', 'src/index.html']), 'Only the two intended official connection files may differ after reapply.');
    await saveScreenshot(handle.cdp, path.join(captureRoot, `${managerLabel.toLowerCase()}-v055-auto-reapplied.png`));

    await evaluate(handle.cdp, `(() => { const d=document.querySelector('.advanced-tools'); d.open=true; const b=document.getElementById('uninstall'); if(!b||b.disabled) throw new Error('Uninstall is unavailable.'); b.click(); return true; })()`);
    const unapplied = await waitForUi(
      handle.cdp,
      (state) => state.busy === '대기' && state.patch.includes('수동 해제') && state.detail.includes('다시 적용하지 않습니다'),
      `${managerLabel} explicit uninstall state`,
    );
    const restored = digestEntries(treeEntries(sourceRoot, new Set(['DinoPatchManager'])));
    assert.deepEqual(restored, digestEntries(updatedEntries), 'Uninstall must restore the complete official v0.5.55 tree.');
    await saveScreenshot(handle.cdp, path.join(captureRoot, `${managerLabel.toLowerCase()}-v055-restored-after-uninstall.png`));
    const backupsAfterUninstall = await evaluate(handle.cdp, 'window.dinoManager.backups()');
    const backupIdsAfterUninstall = (backupsAfterUninstall.items || []).map((item) => item.id).sort();
    assert.deepEqual(backupIdsAfterUninstall, backups.map((item) => item.id).sort(), 'Uninstall must preserve the existing backup records without creating another backup.');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const stableUninstall = await waitForUi(
      handle.cdp,
      (state) => state.busy === '대기' && state.patch.includes('수동 해제') && state.detail.includes('변경될 때까지 자동으로 다시 적용하지 않습니다'),
      `${managerLabel} does not reapply after a source watcher notification`,
      5000,
    );
    assert.deepEqual(digestEntries(treeEntries(sourceRoot, new Set(['DinoPatchManager']))), digestEntries(updatedEntries), 'A watcher recheck must not mutate a manually uninstalled source.');
    await closeManager(handle);
    handle = await launchManager({ expectedStartupPatch: '수동 해제' });
    const afterRestart = handle.state;
    assert.ok(afterRestart.patch.includes('수동 해제') && afterRestart.detail.includes('변경될 때까지 자동으로 다시 적용하지 않습니다'), 'A fresh manager launch must preserve the explicit manual uninstall.');
    assert.deepEqual(digestEntries(treeEntries(sourceRoot, new Set(['DinoPatchManager']))), digestEntries(updatedEntries), 'Restart must not reapply the patch to the unchanged official source.');
    await saveScreenshot(handle.cdp, path.join(captureRoot, `${managerLabel.toLowerCase()}-v055-manual-uninstall-after-restart.png`));

    const report = {
      status: 'PASS',
      manager: `${managerLabel}-final`,
      sourceChangeMode,
      officialFrom: { version: '0.5.54', fileCount: baseEntries.size, tree: digestEntries(baseEntries) },
      officialTo: { version: updatedPackage.version, commit: official055Commit, fileCount: updatedEntries.size, archiveSha256: crypto.createHash('sha256').update(fs.readFileSync(updatedArchive)).digest('hex').toUpperCase(), tree: digestEntries(updatedEntries) },
      beforeExternalUpdate: beforeUpdate,
      observedOverlay: overlayReport,
      guiAfterReapply: reapplied,
      backups: backups.map(({ id, officialVersion, restorable }) => ({ id, officialVersion, restorable })),
      changedOfficialFiles: changedOfficial,
      addedPatchModules: extras,
      restoredOfficialTree: restored,
      guiAfterUninstall: unapplied,
      guiAfterUninstallQuietPeriod: stableUninstall,
      guiAfterRestart: afterRestart,
      backupIdsAfterUninstall,
      runtimePaths: handle.info.runtimePaths,
      chromiumProcesses: handle.childPaths,
      captures: captureRoot,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await closeManager(handle);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
