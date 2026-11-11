const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const managerRoot = path.resolve(__dirname, '..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const builtAppRoot = path.resolve(process.env.DINO_MANAGER_SMOKE_APP_ROOT || path.join(managerRoot, 'release', 'LilacAnime-DinoPatch-Electron-v1.2.4-A22-final', 'win-unpacked'));
const candidateLabel = /-A(\d+)-final$/i.exec(path.basename(path.dirname(builtAppRoot)))?.[0]?.slice(1).replace(/-final$/i, '') || 'A22';
const builtExe = path.join(builtAppRoot, 'LilacAnime-DinoPatch.exe');
const engineExe = path.join(builtAppRoot, 'resources', 'manager-engine', 'DinoPatchManagerEngine.exe');
const pythonExe = process.env.DINO_MANAGER_PYTHON_EXE || 'D:\\Codex-Coding-Folder\\tools\\python314-build\\Scripts\\python.exe';
const officialCommit = 'e4ac62214f5c4863eebae5052633e7f9f33dcbaa';
const officialArchiveSha256 = '007B0141D416614829DACF5494CFC44FD2A1EA80AA58E7E50C856D0FCDBF27CD';
const aCommit = '9e2c8bf6774426ed827aacf8e7c890d7d8358d58';
const screenshotParent = process.env.DINO_MANAGER_SMOKE_OUTPUT_ROOT
  ? path.resolve(process.env.DINO_MANAGER_SMOKE_OUTPUT_ROOT)
  : path.join(managerRoot, 'test-artifacts');
const screenshotFolderName = `A-Electron-compare-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const screenshotRoot = path.join(screenshotParent, screenshotFolderName);
const a20ScreenshotRoot = path.join(screenshotParent, 'A-Electron-compare-2026-10-30T17-58-15-105Z');
const a20DefaultScreenshot = path.join(a20ScreenshotRoot, 'manager-electron-default-window.png');
const a20LayoutPath = path.join(managerRoot, 'test-artifacts', 'A-Electron-compare-2026-10-31T02-19-18-407Z', 'layout-comparison.json');
const a21FinalScreenshotRoot = path.join(screenshotParent, 'A-Electron-compare-2026-10-30T18-24-36-037Z');
const a21FinalDefaultScreenshot = path.join(a21FinalScreenshotRoot, 'manager-electron-default-window.png');

function within(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeTempRoot(value, label) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(value);
  assert.notEqual(root.toLocaleLowerCase(), temp.toLocaleLowerCase(), `${label} must be a unique OS Temp child`);
  assert.ok(within(root, temp), `${label} must stay under OS Temp`);
  return root;
}

function prepareIsolatedManagerPaths(profileRoot, sourceRoot) {
  const profileInput = path.resolve(profileRoot);
  const profileStat = fs.lstatSync(profileInput);
  assert.ok(profileStat.isDirectory() && !profileStat.isSymbolicLink(), 'Manager profile root must not be a symbolic link or junction.');
  assert.equal(fs.realpathSync.native(profileInput).toLocaleLowerCase(), profileInput.toLocaleLowerCase(), 'Manager profile root must resolve to itself.');
  const profile = safeTempRoot(profileRoot, 'Manager profile');
  const source = fs.realpathSync.native(sourceRoot);
  assert.ok(!within(profile, source) && !within(source, profile), 'Manager profile and official source must be separate roots.');
  const paths = Object.fromEntries(['appData', 'userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps', 'localAppData']
    .map((name) => [name, path.join(profile, name)]));
  for (const [name, directory] of Object.entries(paths)) {
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `${name} must be a real directory.`);
    assert.equal(fs.realpathSync.native(directory).toLocaleLowerCase(), path.resolve(directory).toLocaleLowerCase(), `${name} must not resolve through a link.`);
    assert.ok(within(directory, profile), `${name} must remain beneath the dedicated OS Temp profile.`);
  }
  assert.equal(new Set(Object.values(paths).map((value) => value.toLocaleLowerCase())).size, Object.keys(paths).length, 'Manager runtime paths must be distinct.');
  return paths;
}

function processTreeFromWindows(rootPid) {
  const pid = Number(rootPid);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'A valid newly spawned Electron PID is required.');
  const script = `$ErrorActionPreference='Stop'; $rootId=${pid}; $all=@(Get-CimInstance Win32_Process); $owned=[System.Collections.Generic.HashSet[uint32]]::new(); [void]$owned.Add([uint32]$rootId); do { $added=$false; foreach($item in $all){ if($owned.Contains([uint32]$item.ParentProcessId) -and $owned.Add([uint32]$item.ProcessId)){ $added=$true } } } while($added); $rows=@($all | Where-Object { $owned.Contains([uint32]$_.ProcessId) } | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine); $json=ConvertTo-Json -InputObject $rows -Compress -Depth 4; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($json))`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'ascii', windowsHide: true, shell: false, timeout: 10000,
  }).trim();
  const parsed = JSON.parse(Buffer.from(output, 'base64').toString('utf16le') || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function getCommandLineSwitch(commandLine, name) {
  if (typeof commandLine !== 'string') return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)["']?--${escaped}=([^"']+)["'](?=\\s|$)|(?:^|\\s)--${escaped}=(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, 'i').exec(commandLine);
  return match ? (match[1] || match[2] || match[3]) : null;
}

function environmentWithOverrides(overrides) {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    const existing = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (existing && existing !== name) {
      env[existing] = value;
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

function makeFile(parent, name, contents) {
  const fullPath = path.join(parent, name);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

function treeDigest(root, ignored = new Set()) {
  const entries = [];
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (ignored.has(itemRelative)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in test source tree: ${itemRelative}`);
      if (entry.isDirectory()) visit(absolute, itemRelative);
      else if (entry.isFile()) entries.push([itemRelative, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest()]);
    }
  }
  visit(root, '');
  const hash = crypto.createHash('sha256');
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [name, contentHash] of entries) hash.update(name, 'utf8').update('\0').update(contentHash).update('\n');
  return { count: entries.length, sha256: hash.digest('hex').toUpperCase() };
}

function safeCopy(source, destination) {
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite test destination: ${destination}`);
  const inspect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to copy symlink: ${full}`);
      if (entry.isDirectory()) inspect(full);
    }
  };
  inspect(source);
  if (process.platform === 'win32') {
    const copied = spawnSync('robocopy.exe', [path.resolve(source), path.resolve(destination), '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:0', '/W:0', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8', windowsHide: true, shell: false });
    if (copied.error || copied.status === null || copied.status >= 8) throw new Error(`Windows isolated deployment copy failed: ${copied.error ? copied.error.message : copied.stderr || copied.stdout || copied.status}`);
    return;
  }
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
}

function downloadOfficialArchive(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'DinoPatchManager-Electron-Smoke' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(downloadOfficialArchive(new URL(response.headers.location, url), destination));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Official source archive request failed with HTTP ${response.statusCode}.`));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) request.destroy(new Error('Official source archive exceeds the 32 MiB validation limit.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (size === 0) return reject(new Error('Official source archive was empty.'));
        try { fs.writeFileSync(destination, Buffer.concat(chunks), { flag: 'wx' }); resolve(destination); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(90000, () => request.destroy(new Error('Official source archive request timed out.')));
    request.on('error', reject);
  });
}

async function resolveOfficialArchive(tempRoot) {
  const manifestPath = path.join(projectRoot, 'patches', 'patch03', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.officialCommit, officialCommit, 'The local patch manifest must use the pinned official commit.');
  assert.equal(manifest.officialArchiveSha256, officialArchiveSha256, 'The local patch manifest must pin the official source archive hash.');
  let archivePath = process.env.DINO_MANAGER_OFFICIAL_ARCHIVE;
  if (archivePath) {
    archivePath = fs.realpathSync.native(path.resolve(archivePath));
    safeTempRoot(path.dirname(archivePath), 'Reused official source archive');
  } else {
    archivePath = path.join(tempRoot, 'official-v0.5.54.zip');
    await downloadOfficialArchive(`https://github.com/whispelyn-byte/LilacAnime-desktop/archive/${officialCommit}.zip`, archivePath);
  }
  assert.ok(fs.statSync(archivePath).isFile(), 'Official archive input must be a regular file.');
  const actualArchiveHash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex').toUpperCase();
  assert.equal(actualArchiveHash, officialArchiveSha256, 'Official source archive SHA-256 mismatch.');
  return { archivePath, manifest, archiveSha256: actualArchiveHash };
}

async function getPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('CDP endpoint timed out')));
    request.on('error', reject);
  });
}

async function waitForTarget(child, port, label, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`${label} exited before DevTools became ready (exit ${child.exitCode}).`);
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} DevTools target was not ready: ${lastError ? lastError.message : 'timeout'}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function terminateChildTree(child) {
  if (child.exitCode !== null) return true;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, shell: false });
  } else {
    child.kill();
  }
  return waitForChildExit(child, 5000);
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
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP command failed'));
      else resolve(message.result || {});
    }
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
  const response = await cdp.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'UI evaluation failed');
  return response.result && response.result.value;
}

async function waitForUi(cdp, predicate, label, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await evaluate(cdp, `(() => ({busy: document.getElementById('busyBadge')?.textContent, patch: document.getElementById('patchBadge')?.textContent || document.getElementById('patchState')?.textContent, message: document.getElementById('message')?.textContent, detail: document.getElementById('detail')?.textContent, theme: document.getElementById('themeStatus')?.textContent, update: document.getElementById('updateStatus')?.textContent, backupCount: document.getElementById('backupSelect')?.options.length, historyRendered: Boolean(document.querySelector('.log-details')?.open && document.getElementById('log')?.textContent.includes('PATCH_APPLY')), logTail: document.getElementById('log')?.textContent.slice(-700)}))()`);
    if (predicate(last)) return last;
    if (last.message === '관리자 엔진을 시작하지 못했습니다.') throw new Error(`${label} failed: ${last.detail || 'engine error detail unavailable'}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

async function click(cdp, selector, label) {
  const clicked = await evaluate(cdp, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) return false; for (let parent = element.parentElement; parent; parent = parent.parentElement) { if (parent instanceof HTMLDetailsElement) parent.open = true; } element.click(); return true; })()`);
  assert.equal(clicked, true, `Expected enabled UI button: ${label}`);
}

async function saveScreenshot(cdp, filePath) {
  const result = await cdp.command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'), { flag: 'wx' });
}

async function emulateViewport(cdp, width, height, scale = 1) {
  await cdp.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function nativeWindowBounds(processId, width = 0, height = 0) {
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DinoManagerWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  public static IntPtr FindVisibleWindow(uint targetProcessId) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((hWnd, extra) => { uint owner; GetWindowThreadProcessId(hWnd, out owner); if(owner!=targetProcessId || !IsWindowVisible(hWnd)) return true; var title=new StringBuilder(256); GetWindowText(hWnd,title,title.Capacity); if(title.ToString().Contains("LilacAnime DinoPatch")){ found=hWnd; return false; } return true; }, IntPtr.Zero);
    return found;
  }
}
'@
$pidValue = __PROCESS_ID__
$hWnd = [DinoManagerWindow]::FindVisibleWindow([uint32]$pidValue)
if ($hWnd -eq [IntPtr]::Zero) { throw "No visible manager window belongs to PID $pidValue." }
$dpi = [DinoManagerWindow]::GetDpiForWindow($hWnd)
if (-not $dpi) { $dpi = 96 }
$desiredWidth = __WINDOW_WIDTH__
$desiredHeight = __WINDOW_HEIGHT__
if ($desiredWidth -gt 0 -and $desiredHeight -gt 0) {
  $rect = [DinoManagerWindow+RECT]::new()
  if (-not [DinoManagerWindow]::GetWindowRect($hWnd, [ref]$rect)) { throw 'GetWindowRect failed.' }
  $physicalWidth = [int][Math]::Round($desiredWidth * $dpi / 96.0)
  $physicalHeight = [int][Math]::Round($desiredHeight * $dpi / 96.0)
  if (-not [DinoManagerWindow]::SetWindowPos($hWnd, [IntPtr]::Zero, $rect.Left, $rect.Top, $physicalWidth, $physicalHeight, 0x14)) { throw 'SetWindowPos failed.' }
}
$actual = [DinoManagerWindow+RECT]::new()
if (-not [DinoManagerWindow]::GetWindowRect($hWnd, [ref]$actual)) { throw 'GetWindowRect failed.' }
$physicalWidth = $actual.Right - $actual.Left
$physicalHeight = $actual.Bottom - $actual.Top
[pscustomobject]@{ width=[int][Math]::Round($physicalWidth * 96.0 / $dpi); height=[int][Math]::Round($physicalHeight * 96.0 / $dpi); physicalWidth=$physicalWidth; physicalHeight=$physicalHeight; dpi=$dpi } | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(script.replace('__PROCESS_ID__', String(processId)).replace('__WINDOW_WIDTH__', String(width)).replace('__WINDOW_HEIGHT__', String(height)), 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`Native Electron window measurement failed: ${(result.stderr || result.stdout || result.status).trim()}`);
  const outputLine = result.stdout.trim().split(/\r?\n/).at(-1);
  return JSON.parse(outputLine);
}

async function getWindowBounds(handle) {
  return { bounds: nativeWindowBounds(handle.child.pid) };
}

async function resizeWindow(handle, width, height) {
  nativeWindowBounds(handle.child.pid, width, height);
  await new Promise((resolve) => setTimeout(resolve, 450));
  return nativeWindowBounds(handle.child.pid);
}

function pngDimensions(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Not a valid PNG: ${filePath}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function readLayout(cdp) {
  return evaluate(cdp, `(() => {
    const path = document.getElementById('targetPath');
    const tools = document.querySelector('.advanced-tools') || document.querySelector('.management-tools');
    const safetyCard = document.getElementById('safetyCard') || document.querySelector('.safety');
    const safetyMessage = document.getElementById('safetyMessage') || safetyCard?.querySelector('p');
    const detail = document.getElementById('detail');
    const patchCard = document.querySelector('.patch-list-card');
    const patchList = document.querySelector('.patch-list');
    const patchRows = Array.from(document.querySelectorAll('.patch-list-card .patch-row'));
    const listHeading = document.querySelector('.list-heading');
    const rowBounds = patchRows.map((row) => row.getBoundingClientRect());
    const rowStackHeight = rowBounds.length ? Math.round(rowBounds.at(-1).bottom - rowBounds[0].top) : 0;
    const cardStyle = patchCard ? getComputedStyle(patchCard) : null;
    const cardVerticalPadding = cardStyle ? parseFloat(cardStyle.paddingTop) + parseFloat(cardStyle.paddingBottom) : 0;
    const headingHeight = listHeading ? Math.round(listHeading.getBoundingClientRect().height) + parseFloat(getComputedStyle(listHeading).marginBottom) : 0;
    const listVisibleHeight = patchList ? patchList.clientHeight : rowStackHeight;
    const patchPanelSlackPx = patchCard ? Math.max(0, Math.round(patchCard.clientHeight - cardVerticalPadding - headingHeight - listVisibleHeight)) : 0;
    const overlaps = (left, right) => {
      if (!left || !right) return false;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    };
    const criticalPairs = [
      ['header title and version', document.querySelector('.brand h1'), document.querySelector('.topbar-meta')],
      ['source path and folder button', document.querySelector('.location-copy'), document.querySelector('.source-actions')],
      ['task label and message', document.getElementById('resultHeading'), document.querySelector('.message')],
      ['patch list and task status', patchCard, document.querySelector('.result-card')],
    ];
    const viewportWidth = document.documentElement.clientWidth;
    const overflowing = Array.from(document.querySelectorAll('body *')).map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.id, className: String(element.className || ''), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter((rect) => rect.left < -1 || rect.right > viewportWidth + 1).slice(0, 8);
    return {
      width: viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.clientHeight,
      bodyBottom: Math.round(document.body.getBoundingClientRect().bottom),
      scrollHeight: document.documentElement.scrollHeight,
      scrollRequired: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      contentBottom: Math.round(document.querySelector('.shell').getBoundingClientRect().bottom),
      cardHeights: Object.fromEntries(['.source-card', '.patch-list-card', '.backup-card', '.result-card', '.advanced-tools'].map((selector) => { const node=document.querySelector(selector); return [selector, node ? Math.round(node.getBoundingClientRect().height) : 0]; })),
      patchRowCount: patchRows.length,
      patchRowStackHeight: rowStackHeight,
      patchPanelSlackPx,
      patchListHeight: patchList ? patchList.clientHeight : 0,
      patchListScrollHeight: patchList ? patchList.scrollHeight : rowStackHeight,
      patchListMaxHeight: patchList ? getComputedStyle(patchList).maxHeight : 'unbounded',
      patchListOverflowY: patchList ? getComputedStyle(patchList).overflowY : 'none',
      autoManageStatus: document.getElementById('autoManageStatus')?.textContent || null,
      actionStates: Object.fromEntries(['inspect', 'uninstall'].map((id) => { const button=document.getElementById(id); return [id, button ? { disabled:button.disabled, classes:button.className } : null]; })),
      devicePixelRatio: window.devicePixelRatio,
      advancedOpen: Boolean(tools && (tools.tagName !== 'DETAILS' || tools.open)),
      advancedCollapsible: tools?.tagName === 'DETAILS',
      statusGapPx: Math.round(document.querySelector('.result-card').getBoundingClientRect().top - tools.getBoundingClientRect().bottom),
      safetyExpanded: safetyCard?.classList.contains('is-expanded') || false,
      safetyMessageDisplay: safetyMessage ? getComputedStyle(safetyMessage).display : 'missing',
      detailHidden: detail ? detail.hidden : false,
      detailClientHeight: detail ? detail.clientHeight : 0,
      detailScrollHeight: detail ? detail.scrollHeight : 0,
      detailOverflowY: detail ? getComputedStyle(detail).overflowY : 'missing',
      detailMaxHeight: detail ? getComputedStyle(detail).maxHeight : 'missing',
      overlappingCriticalElements: criticalPairs.filter(([, left, right]) => overlaps(left, right)).map(([name]) => name),
      mainStatusChipCount: document.querySelectorAll('.patch-row .status-chip').length,
      safetyCardHidden: safetyCard ? safetyCard.hidden : false,
      activityStatusHidden: document.getElementById('activityStatus') ? document.getElementById('activityStatus').hidden : null,
      visibleStatusChipCount: Array.from(document.querySelectorAll('.patch-row .status-chip, .result-actions .status-chip')).filter((node) => !node.hidden && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden').length,
      visibleControls: ['chooseRoot', 'inspect'].filter((id) => { const node=document.getElementById(id); const rect=node.getBoundingClientRect(); const style=getComputedStyle(node); return rect.width>0 && rect.height>0 && rect.top>=0 && rect.bottom<=document.documentElement.clientHeight && style.visibility!=='hidden' && style.display!=='none'; }),
      pathTitle: path.title,
      pathOverflow: getComputedStyle(path).textOverflow,
      overflowing,
      focusId: document.activeElement && document.activeElement.id,
      focusVisible: Boolean(document.activeElement && document.activeElement.matches(':focus-visible')),
    };
  })()`);
}

function buildSyntheticPatchFixtureMarkup(count) {
  const rows = Array.from({ length: count }, (_, index) => {
    const status = index % 4;
    const state = [
      { label: '적용됨', tone: 'good', applyDisabled: true, applyClass: 'secondary', uninstallDisabled: false },
      { label: '미적용 · 호환', tone: 'warn', applyDisabled: false, applyClass: 'primary', uninstallDisabled: true },
      { label: '검사 중', tone: 'neutral', applyDisabled: true, applyClass: 'secondary', uninstallDisabled: true },
      { label: '변경 충돌', tone: 'bad', applyDisabled: true, applyClass: 'secondary', uninstallDisabled: true },
    ][status];
    const longCopy = index === count - 1;
    const title = longCopy ? '다국어 검색 결과를 안전하게 연결하는 장문 테스트 패치 이름' : `테스트 패치 ${String(index + 1).padStart(2, '0')}`;
    const description = longCopy ? '긴 설명이 있는 테스트 fixture · 패치 이름과 기능 설명이 길어져도 버튼과 상태를 밀어내지 않아야 합니다.' : '목록 줄바꿈 및 상태 간격 테스트';
    return `<article class="patch-row synthetic-patch-fixture" data-fixture-index="${index}">
      <div class="patch-row-main"><div class="patch-mark" aria-hidden="true">${index + 1}</div>
        <div class="patch-copy"><div class="patch-title-line"><h3>${title}</h3><span class="patch-version">v1.${index}.0</span></div><p>${description}</p></div>
        <span class="status-chip ${state.tone}">${state.label}</span>
        <div class="row-actions"><button class="button ${state.applyClass}" data-fixture-action="apply" ${state.applyDisabled ? 'disabled' : ''}>적용</button><button class="button danger" data-fixture-action="uninstall" ${state.uninstallDisabled ? 'disabled' : ''}>해제</button></div>
      </div>
      <details class="patch-details" ${index === 0 && count === 3 ? 'open' : ''}><summary>세부 정보</summary><div class="patch-detail-grid"><div><span>테스트 상태</span><strong>${state.label}</strong></div><div class="patch-detail-wide"><span>테스트 설명</span><strong>${description}</strong></div></div></details>
    </article>`;
  });
  return rows.join('');
}

async function mountSyntheticPatchFixture(cdp, count) {
  const markup = buildSyntheticPatchFixtureMarkup(count);
  await evaluate(cdp, `(() => { const list=document.getElementById('patchRows'); if(!list) throw new Error('Synthetic patch fixture requires the patch-list container.'); list.innerHTML=${JSON.stringify(markup)}; })()`);
  return readLayout(cdp);
}

async function installThemeFixture(profileRoot, theme, sourceRoot) {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const appName = String(packageInfo.productName || packageInfo.name || '').trim();
  if (!appName || path.basename(appName) !== appName || ['.', '..'].includes(appName)) throw new Error('Pinned source does not expose a safe Electron app name.');
  const probeRoot = path.join(profileRoot, `electron-theme-writer-${crypto.randomUUID()}`);
  fs.mkdirSync(probeRoot, { recursive: false });
  const paths = {
    appData: path.join(profileRoot, 'appData'),
    userData: path.join(profileRoot, 'userData'),
    // Official LilacAnime leaves sessionData at Electron's default userData
    // location. Keep the test's explicit runtime paths distinct while placing
    // the synthetic official profile under APPDATA/<package name>.
    sessionData: path.join(profileRoot, 'appData', appName),
    temp: path.join(profileRoot, 'theme-temp'),
    cache: path.join(profileRoot, 'theme-cache'),
    logs: path.join(profileRoot, 'theme-logs'),
    crashDumps: path.join(profileRoot, 'theme-crashDumps'),
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  const resultPath = path.join(probeRoot, 'paths.json');
  makeFile(probeRoot, 'package.json', JSON.stringify({ name: appName, version: packageInfo.version, main: 'main.cjs' }));
  makeFile(probeRoot, 'index.html', '<!doctype html><meta charset="utf-8"><script>const value=new URLSearchParams(location.search).get("theme"); if(value==="__delete_theme__") localStorage.removeItem("theme"); else localStorage.setItem("theme",value); window.themeWriter.saved(value);</script>');
  makeFile(probeRoot, 'preload.cjs', [
    "const { contextBridge, ipcRenderer } = require('electron');",
    "contextBridge.exposeInMainWorld('themeWriter', { saved: (value) => ipcRenderer.send('theme-saved', value) });",
  ].join('\n'));
  makeFile(probeRoot, 'main.cjs', [
    "const { app, BrowserWindow, ipcMain } = require('electron');",
    "const fs = require('node:fs'); const path = require('node:path');",
    `const paths = ${JSON.stringify(paths)}; const resultPath = ${JSON.stringify(resultPath)}; const expected = ${JSON.stringify(theme)};`,
    `app.setName(${JSON.stringify(appName)});`,
    "for (const key of ['appData','userData','sessionData','temp','logs','crashDumps']) app.setPath(key, paths[key]);",
    "app.commandLine.appendSwitch('disk-cache-dir', paths.cache);",
    "app.whenReady().then(() => { const actual = {}; for (const key of ['appData','userData','sessionData','temp','logs','crashDumps']) actual[key] = app.getPath(key); actual.cache = app.commandLine.getSwitchValue('disk-cache-dir'); ipcMain.once('theme-saved', (_event, value) => { if (value !== expected) { console.error('Theme value mismatch'); app.exit(2); return; } fs.writeFileSync(resultPath, JSON.stringify({value, paths:actual}), {flag:'wx'}); setTimeout(() => app.quit(), 400); }); const win = new BrowserWindow({ show:false, webPreferences:{ preload:path.join(__dirname,'preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true } }); win.loadFile(path.join(__dirname,'index.html'), { query:{ theme:expected } }).catch(error => { console.error(error.stack || error); app.exit(2); }); }).catch(error => { console.error(error.stack || error); app.exit(2); });",
    "app.on('window-all-closed', () => app.quit());",
  ].join('\n'));
  const child = spawn(electronExe, [path.join(probeRoot, 'main.cjs')], {
    cwd: probeRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APPDATA: paths.appData },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { if (output.length < 4000) output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (output.length < 4000) output += chunk.toString('utf8'); });
  if (!(await waitForChildExit(child, 15000))) {
    const exited = await terminateChildTree(child);
    throw new Error(`Isolated Chromium LevelDB writer timed out; child tree exited=${exited}. ${output}`);
  }
  if (child.exitCode !== 0 || !fs.existsSync(resultPath)) throw new Error(`Isolated Chromium LevelDB writer failed for ${theme}. exit=${child.exitCode}; ${output}`);
  const written = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  for (const key of ['appData', 'userData', 'sessionData', 'temp', 'cache', 'logs', 'crashDumps']) {
    const actual = key === 'cache' ? written.paths.cache : written.paths[key];
    assert.equal(path.resolve(actual).toLowerCase(), path.resolve(paths[key]).toLowerCase(), `Isolated Electron ${key} must match its Temp profile.`);
    assert.ok(within(actual, profileRoot), `Isolated Electron ${key} must remain beneath its Temp profile.`);
  }
  const levelDbDirectory = path.join(paths.sessionData, 'Local Storage', 'leveldb');
  assert.ok(fs.existsSync(path.join(levelDbDirectory, 'CURRENT')), 'Chromium must produce a real Local Storage LevelDB for the file origin.');
  return { levelDbDirectory, written };
}

function installLegacyThemeFixture(profileRoot, theme, appName) {
  const database = path.join(profileRoot, 'appData', appName, 'Local Storage', 'file__0.localstorage');
  const code = [
    'import pathlib, sqlite3, sys',
    'p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True)',
    'db=sqlite3.connect(p)',
    'db.execute("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)")',
    'db.execute("INSERT OR REPLACE INTO ItemTable(key,value) VALUES(?,?)", ("theme", sys.argv[2]))',
    'db.commit(); db.close()',
  ].join('; ');
  const result = spawnSync(pythonExe, ['-c', code, database, theme], { encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`Legacy theme fixture creation failed: ${result.stderr || result.error || result.status}`);
}

async function startPackagedManager({ sourceRoot, profileRoot, theme, label, expectedPatch = '적용됨 · 호환', waitForUpdate = false, staleLegacyTheme = null, prepareTheme = true }) {
  const runtimePaths = prepareIsolatedManagerPaths(profileRoot, sourceRoot);
  if (prepareTheme) await installThemeFixture(profileRoot, theme, sourceRoot);
  const packageInfo = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const appName = String(packageInfo.productName || packageInfo.name || '').trim();
  if (staleLegacyTheme) installLegacyThemeFixture(profileRoot, staleLegacyTheme, appName);
  const themeDbDirectory = path.join(profileRoot, 'appData', appName, 'Local Storage', 'leveldb');
  const themeDbBefore = fs.existsSync(themeDbDirectory) ? treeDigest(themeDbDirectory) : null;
  const deployedExe = path.join(sourceRoot, 'DinoPatchManager', 'LilacAnime-DinoPatch.exe');
  if (!fs.existsSync(deployedExe)) throw new Error(`${label} is missing the manager executable inside the isolated official source copy.`);
  const port = await getPort();
  const child = spawn(deployedExe, [
    `--user-data-dir=${runtimePaths.userData}`,
    `--disk-cache-dir=${runtimePaths.cache}`,
    `--crash-dumps-dir=${runtimePaths.crashDumps}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
  ], {
    cwd: path.join(sourceRoot, 'DinoPatchManager'),
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environmentWithOverrides({
      APPDATA: runtimePaths.appData,
      LOCALAPPDATA: runtimePaths.localAppData,
      USERPROFILE: profileRoot,
      HOME: profileRoot,
      DINO_MANAGER_TEST_OS_TEMP_ROOT: fs.realpathSync.native(os.tmpdir()),
      TEMP: runtimePaths.temp,
      TMP: runtimePaths.temp,
      TMPDIR: runtimePaths.temp,
      DINO_MANAGER_TEST_ROOT: sourceRoot,
      DINO_MANAGER_TEST_PROFILE_ROOT: profileRoot,
      DINO_MANAGER_AUTOCONFIRM: '1',
    }),
  });
  let processOutput = '';
  child.stdout.on('data', (chunk) => { if (processOutput.length < 30000) processOutput += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (processOutput.length < 30000) processOutput += chunk.toString('utf8'); });
  let cdp = null;
  try {
    const target = await waitForTarget(child, port, label, 15000);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.command('Runtime.enable');
    await cdp.command('Page.enable');
    const result = await waitForUi(cdp, (state) => state.busy === '대기' && state.patch === expectedPatch, `${label} startup state`);
    if (themeDbBefore) assert.deepEqual(treeDigest(themeDbDirectory), themeDbBefore, 'Reading the Chromium theme database must not alter its source files.');
    const info = await evaluate(cdp, 'window.dinoManager.getInfo()');
    assert.ok(info && info.isPackaged, 'The GUI process must be the packaged Electron application.');
    for (const key of ['appData', 'userData', 'sessionData', 'temp', 'cache', 'logs', 'crashDumps', 'chromiumUserData']) assert.equal(info.runtimePaths[key].matches, true, `${key} must match its isolated Electron path.`);
    assert.equal(new Set(['appData', 'userData', 'sessionData', 'temp', 'cache', 'logs', 'crashDumps'].map((key) => info.runtimePaths[key].actual.toLowerCase())).size, 7, 'Electron profile and runtime paths must be distinct.');
    assert.ok(info.runtimePaths.userData.actual.toLowerCase().includes(profileRoot.toLowerCase()), 'Electron profile must stay in the test Temp root.');
    const processTree = processTreeFromWindows(child.pid);
    const deployedPath = fs.realpathSync.native(deployedExe).toLocaleLowerCase();
    const electronProcesses = processTree.filter((item) => item.ExecutablePath && fs.realpathSync.native(item.ExecutablePath).toLocaleLowerCase() === deployedPath);
    assert.ok(electronProcesses.some((item) => Number(item.ProcessId) === Number(child.pid)), 'The inspected process tree must include the newly spawned manager main process.');
    assert.ok(electronProcesses.some((item) => /--type=renderer\b/i.test(item.CommandLine || '')), 'A Chromium renderer child must be present in the inspected process tree.');
    const processProfilePaths = electronProcesses.map((item) => {
      assert.ok(item.CommandLine, `Process ${item.ProcessId} command line must be queryable.`);
      const value = getCommandLineSwitch(item.CommandLine, 'user-data-dir');
      assert.ok(value, `Process ${item.ProcessId} (${item.Name}, type=${/--type=([^\s]+)/i.exec(item.CommandLine)?.[1] || 'browser'}) must expose --user-data-dir: ${String(item.CommandLine).slice(0, 500)}`);
      assert.equal(fs.realpathSync.native(value).toLocaleLowerCase(), fs.realpathSync.native(runtimePaths.userData).toLocaleLowerCase(), `Process ${item.ProcessId} must use the dedicated Temp userData.`);
      return { pid: Number(item.ProcessId), parentPid: Number(item.ParentProcessId), name: item.Name, startedAt: item.CreationDate, userData: value, type: /--type=([^\s]+)/i.exec(item.CommandLine)?.[1] || 'browser' };
    });
    if (['적용 완료', '적용됨 · 호환'].includes(expectedPatch)) assert.ok(result.backupCount >= 1, 'Initial apply should expose an original backup.');
    if (waitForUpdate) await waitForUi(cdp, (state) => state.busy === '대기' && state.update && !state.update.includes('확인 전'), `${label} official update lookup`);
    return { child, cdp, port, info, processProfilePaths, targetId: target.id, output: () => processOutput };
  } catch (error) {
    if (cdp) cdp.close();
    const exited = await terminateChildTree(child);
    const output = processOutput.trim() ? `\nElectron stdout/stderr:\n${processOutput.trim()}` : '\nElectron stdout/stderr: (none)';
    throw new Error(`${label} failed before UI automation (${error.message}); test process tree exited=${exited}.${output}`, { cause: error });
  }
}

async function closeManager(handle) {
  try {
    await Promise.race([
      handle.cdp.command('Runtime.evaluate', { expression: 'window.close()', awaitPromise: true }),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {}
  handle.cdp.close();
  if (await waitForChildExit(handle.child, 10000)) return true;
  const stopped = await terminateChildTree(handle.child);
  if (!stopped) throw new Error('The isolated Electron test process tree could not be stopped.');
  throw new Error('The isolated Electron app did not exit normally after its window was closed; its test process tree was terminated.');
}

function writeAPrototypePreview(tempRoot) {
  const preview = path.join(tempRoot, 'a-electron-preview');
  fs.mkdirSync(preview, { recursive: false });
  const readGitFile = (relative) => execFileSync('git', ['show', `${aCommit}:${relative}`], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(preview, 'index.html'), readGitFile('dino-lilac-patch/manager/index.html'));
  fs.writeFileSync(path.join(preview, 'manager.css'), readGitFile('dino-lilac-patch/manager/manager.css'));
  fs.writeFileSync(path.join(preview, 'renderer.js'), '');
  fs.writeFileSync(path.join(preview, 'package.json'), JSON.stringify({ name: 'dino-a-static-preview', version: '1.0.0', main: 'preview.cjs' }, null, 2));
  fs.writeFileSync(path.join(preview, 'preview.cjs'), [
    "const { app, BrowserWindow } = require('electron');",
    "const path = require('node:path');",
    "const base = process.env.DINO_MANAGER_PREVIEW_PROFILE;",
    "for (const [key, name] of [['appData','appData'],['userData','userData'],['sessionData','sessionData'],['temp','temp'],['logs','logs'],['crashDumps','crashDumps']]) { const p=path.join(base,name); require('node:fs').mkdirSync(p,{recursive:true}); app.setPath(key,p); }",
    "const cache=path.join(base,'cache'); require('node:fs').mkdirSync(cache,{recursive:true}); app.commandLine.appendSwitch('disk-cache-dir',cache);",
    "app.whenReady().then(()=>{const w=new BrowserWindow({width:980,height:820,show:true,autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}); w.loadFile(path.join(__dirname,'index.html'));});",
    "app.on('window-all-closed',()=>app.quit());",
  ].join('\n'));
  return preview;
}

async function captureAPrototype(preview, tempRoot, outputPath) {
  const profile = path.join(tempRoot, 'a-preview-profile');
  fs.mkdirSync(profile, { recursive: false });
  const profileStat = fs.lstatSync(profile);
  assert.ok(profileStat.isDirectory() && !profileStat.isSymbolicLink(), 'A preview profile must be an isolated normal directory.');
  const profileDirs = Object.fromEntries(['appData', 'userData', 'sessionData', 'temp', 'cache', 'logs', 'crashDumps'].map((name) => [name, path.join(profile, name)]));
  for (const directory of Object.values(profileDirs)) {
    fs.mkdirSync(directory, { recursive: true });
    assert.equal(fs.realpathSync.native(directory).toLocaleLowerCase(), path.resolve(directory).toLocaleLowerCase(), 'Preview runtime directories must not use links.');
  }
  const port = await getPort();
  const child = spawn(electronExe, [
    `--user-data-dir=${profileDirs.userData}`,
    `--disk-cache-dir=${profileDirs.cache}`,
    `--crash-dumps-dir=${profileDirs.crashDumps}`,
    preview,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
  ], {
    cwd: preview, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: environmentWithOverrides({
      DINO_MANAGER_PREVIEW_PROFILE: profile,
      APPDATA: profileDirs.appData,
      LOCALAPPDATA: path.join(profile, 'localAppData'),
      USERPROFILE: profile,
      HOME: profile,
      TEMP: profileDirs.temp,
      TMP: profileDirs.temp,
      TMPDIR: profileDirs.temp,
    }),
  });
  let cdp = null;
  try {
    const target = await waitForTarget(child, port, 'A original preview');
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.command('Page.enable');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await saveScreenshot(cdp, outputPath);
  } finally {
    if (cdp) {
      try { await Promise.race([cdp.command('Runtime.evaluate', { expression: 'window.close()', awaitPromise: true }), new Promise((resolve) => setTimeout(resolve, 1500))]); } catch {}
      cdp.close();
    }
    if (!(await waitForChildExit(child, 5000))) {
      if (!(await terminateChildTree(child))) throw new Error('A original preview Electron process tree could not be stopped.');
      throw new Error('A original preview did not exit normally after closing its window; its isolated process tree was terminated.');
    }
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This smoke test requires Windows Electron.');
  if (process.env.DINO_MANAGER_SMOKE_OUTPUT_ROOT) safeTempRoot(screenshotParent, 'Screenshot output');
  if (!fs.existsSync(builtExe) || !fs.existsSync(engineExe) || !fs.existsSync(electronExe)) throw new Error(`Build ${candidateLabel}-final and use the existing Electron 38.8.6 package before running this smoke test.`);
  if (!fs.existsSync(a20DefaultScreenshot) || !fs.existsSync(a20LayoutPath)) throw new Error(`The preserved A20 baseline screenshot and layout must be available at ${a20ScreenshotRoot}.`);
  if (!fs.existsSync(a21FinalDefaultScreenshot)) throw new Error(`The A21-final comparison screenshot must be preserved at ${a21FinalScreenshotRoot}.`);
  if (fs.existsSync(screenshotRoot)) throw new Error(`Refusing to overwrite existing screenshots: ${screenshotRoot}`);
  fs.mkdirSync(screenshotParent, { recursive: true });
  fs.mkdirSync(screenshotRoot, { recursive: false });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Dino Patch Manager 검증-'));
  safeTempRoot(tempRoot, 'Smoke workspace');
  let smokePassed = false;
  const extractionRoot = path.join(tempRoot, 'official-extracted');
  const profileRoot = path.join(tempRoot, 'manager-profile');
  fs.mkdirSync(extractionRoot, { recursive: false });
  fs.mkdirSync(profileRoot, { recursive: false });
  const archive = await resolveOfficialArchive(tempRoot);
  execFileSync('tar', ['-xf', archive.archivePath, '-C', extractionRoot], { cwd: tempRoot, stdio: 'ignore' });
  const sourceRoot = path.join(extractionRoot, `LilacAnime-desktop-${officialCommit}`);
  safeTempRoot(sourceRoot, 'Extracted official source');
  const packageInfo = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  assert.equal(packageInfo.version, '0.5.54');
  const baselineTree = treeDigest(sourceRoot);
  assert.equal(baselineTree.count, archive.manifest.officialTreeFileCount, 'Official archive file count must match the pinned manifest.');
  assert.equal(baselineTree.sha256, archive.manifest.officialTreeSha256, 'Official archive file tree must match the pinned manifest.');
  const deploymentPath = path.join(sourceRoot, 'DinoPatchManager');
  safeCopy(builtAppRoot, deploymentPath);
  const sourceTreeWithManager = treeDigest(sourceRoot, new Set(['DinoPatchManager']));
  assert.deepEqual(sourceTreeWithManager, baselineTree, 'Adding the manager bundle must not alter official files.');

  const aPreview = writeAPrototypePreview(tempRoot);
  await captureAPrototype(aPreview, tempRoot, path.join(screenshotRoot, 'A-original-electron-preview.png'));

  let first = null;
  let second = null;
  let baselineLayout = null;
  let baselineSameViewportLayout = null;
  try {
    const a20ReferenceLayout = JSON.parse(fs.readFileSync(a20LayoutPath, 'utf8')).defaultWindow.A20;
    const a20LayoutReport = JSON.parse(fs.readFileSync(a20LayoutPath, 'utf8'));
    const a20Panel = a20LayoutReport.patchPanelComparison.A20;
    const a20SameViewport = a20LayoutReport.sameViewport;
    const a20ReferenceImage = pngDimensions(a20DefaultScreenshot);
    assert.deepEqual(a20ReferenceImage, { width: a20ReferenceLayout.width, height: a20ReferenceLayout.height }, 'The preserved A20 screenshot must be an actual default-window client capture.');
    assert.equal(a20ReferenceLayout.configured.width, 920, 'The preserved A20 baseline was measured at the 920 px configured width.');
    assert.equal(a20ReferenceLayout.configured.height, 800, 'The preserved A20 baseline was measured at the 800 px configured height.');
    baselineLayout = {
      ...a20ReferenceLayout,
      patchPanelSlackPx: a20Panel.unusedAreaPx,
      patchRowStackHeight: a20Panel.rowStackHeight,
      cardHeights: { '.patch-list-card': a20Panel.panelHeight },
    };
    baselineSameViewportLayout = {
      width: a20SameViewport.width,
      height: a20SameViewport.height,
      contentBottom: a20SameViewport.A20ContentBottom,
      patchPanelSlackPx: a20SameViewport.A20PatchPanelSlackPx,
      scrollWidth: a20SameViewport.width + a20SameViewport.A20HorizontalOverflow,
    };
    const a20NativeWindow = { bounds: { width: a20ReferenceLayout.configured.width, height: a20ReferenceLayout.configured.height } };
    fs.copyFileSync(a20DefaultScreenshot, path.join(screenshotRoot, 'manager-a20-before.png'), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(a20DefaultScreenshot, path.join(screenshotRoot, 'manager-a20-same-viewport.png'), fs.constants.COPYFILE_EXCL);

    first = await startPackagedManager({ sourceRoot, profileRoot, theme: 'dark', label: 'dark manager run', staleLegacyTheme: 'light' });
    await waitForUi(first.cdp, (state) => state.theme && state.theme.includes('자동 연동 · dark'), 'Dark theme read-only sync');
    await evaluate(first.cdp, `document.getElementById('message').textContent='패치 상태 확인 완료'`);
    const a22NativeWindow = await getWindowBounds(first);
    assert.equal(a22NativeWindow.bounds.width, 920, `The packaged ${candidateLabel} manager must open at 920 px width.`);
    assert.equal(a22NativeWindow.bounds.height, 800, `The packaged ${candidateLabel} manager must open at 800 px height.`);
    const defaultWindowLayout = await readLayout(first.cdp);
    assert.ok(defaultWindowLayout.contentBottom > 0, 'The whole dashboard must be measurable.');
    assert.ok(defaultWindowLayout.statusGapPx >= 0 && defaultWindowLayout.statusGapPx <= 16, 'The task status must immediately follow the always-visible tools.');
    assert.ok(defaultWindowLayout.scrollWidth <= defaultWindowLayout.width, 'The actual default window must not scroll horizontally.');
    assert.deepEqual(defaultWindowLayout.overlappingCriticalElements, [], 'The actual default window must not overlap the header, path controls or status.');
    assert.equal(defaultWindowLayout.width, baselineLayout.width, `A20 and ${candidateLabel} comparison must use the same client width.`);
    assert.equal(defaultWindowLayout.height, baselineLayout.height, `A20 and ${candidateLabel} comparison must use the same client height.`);
    assert.ok(baselineLayout.patchPanelSlackPx >= 40, `The A20 baseline should reproduce the large empty patch-list area: ${baselineLayout.patchPanelSlackPx}px.`);
    assert.ok(defaultWindowLayout.patchPanelSlackPx <= 24, `${candidateLabel} should size the one-patch panel to its contents: ${defaultWindowLayout.patchPanelSlackPx}px unused.`);
    assert.equal(defaultWindowLayout.patchRowCount, 1, 'The real packaged manager must list only its one implemented patch.');
    assert.match(defaultWindowLayout.autoManageStatus || '', /자동 검사 완료 · 적용됨/);
    assert.equal(defaultWindowLayout.actionStates.inspect.disabled, false, 'Manual recheck remains available inside advanced tools.');
    assert.equal(defaultWindowLayout.actionStates.uninstall.disabled, false, 'Uninstall must remain enabled for an applied patch.');
    const a20ViewportRatio = baselineLayout.width / baselineLayout.height;
    const a22ViewportRatio = defaultWindowLayout.width / defaultWindowLayout.height;
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-electron-default-window.png'));

    const officialAppName = String(packageInfo.productName || packageInfo.name || '').trim();
    const themeDatabase = path.join(profileRoot, 'appData', officialAppName, 'Local Storage', 'leveldb');
    await installThemeFixture(profileRoot, 'system', sourceRoot);
    const systemThemeResult = await evaluate(first.cdp, 'window.dinoManager.refreshTheme()');
    assert.equal(systemThemeResult.status, 'READ', 'System theme must be read from the Chromium LevelDB record.');
    assert.equal(systemThemeResult.setting, 'system');
    assert.ok(['dark', 'light'].includes(systemThemeResult.theme), 'System mode must resolve through Electron nativeTheme.');
    await waitForUi(first.cdp, (state) => state.theme && state.theme.includes('자동 연동 · system'), 'System theme setting read');
    const systemLayout = await readLayout(first.cdp);
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-electron-system-theme.png'));

    await installThemeFixture(profileRoot, 'invalid-theme-value', sourceRoot);
    const invalidThemeResult = await evaluate(first.cdp, 'window.dinoManager.refreshTheme()');
    assert.equal(invalidThemeResult.status, 'FALLBACK', 'Unknown LevelDB values must fall back instead of being displayed as official settings.');
    assert.ok(['dark', 'light'].includes(invalidThemeResult.theme));
    const fallbackUi = await waitForUi(first.cdp, (state) => state.theme && state.theme.includes('테마 읽기 불가'), 'Invalid theme fallback status');
    assert.ok(fallbackUi.theme.includes('시스템') || fallbackUi.theme.includes('Windows'), 'Theme read failure must be distinguished from patch compatibility.');
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-theme-read-fallback.png'));

    await installThemeFixture(profileRoot, 'dark', sourceRoot);
    await installThemeFixture(profileRoot, '__delete_theme__', sourceRoot);
    installLegacyThemeFixture(profileRoot, 'light', officialAppName);
    const deletedThemeResult = await evaluate(first.cdp, 'window.dinoManager.refreshTheme()');
    assert.equal(deletedThemeResult.status, 'FALLBACK', 'A Chromium deletion marker must not resurrect an older theme value.');
    const deletedFallbackUi = await waitForUi(first.cdp, (state) => state.theme && state.theme.includes('테마 읽기 불가'), 'Deleted LevelDB value fallback');
    assert.ok(deletedFallbackUi.theme.includes('시스템') || deletedFallbackUi.theme.includes('Windows'));
    const legacyAndLevelDbDigest = treeDigest(themeDatabase);
    assert.ok(legacyAndLevelDbDigest.count > 0, 'The synthetic Chromium profile must retain its LevelDB files.');
    await installThemeFixture(profileRoot, 'dark', sourceRoot);
    const sourceDatabaseBeforeAndAfter = treeDigest(themeDatabase);
    const restoredThemeResult = await evaluate(first.cdp, 'window.dinoManager.refreshTheme()');
    assert.equal(restoredThemeResult.status, 'READ');
    assert.equal(restoredThemeResult.setting, 'dark');
    assert.deepEqual(treeDigest(themeDatabase), sourceDatabaseBeforeAndAfter, 'Manager reads must not modify the official LevelDB files.');
    void systemLayout;

    const candidateWindows = [
      { width: 900, height: 760 },
      { width: 920, height: 800 },
      { width: 960, height: 820 },
    ];
    const candidateLayouts = [];
    for (const candidate of candidateWindows) {
      const actualWindow = await resizeWindow(first, candidate.width, candidate.height);
      assert.equal(actualWindow.width, candidate.width, `Electron must accept the ${candidate.width}×${candidate.height} test width.`);
      assert.equal(actualWindow.height, candidate.height, `Electron must accept the ${candidate.width}×${candidate.height} test height.`);
      const layout = await readLayout(first.cdp);
      assert.ok(layout.scrollWidth <= layout.width, `Candidate ${candidate.width}×${candidate.height} must not overflow horizontally.`);
      assert.ok(layout.statusGapPx >= 0 && layout.statusGapPx <= 16, `Candidate ${candidate.width}×${candidate.height} has a large gap before task status.`);
      assert.deepEqual(layout.overlappingCriticalElements, [], `Candidate ${candidate.width}×${candidate.height} must not overlap text or controls.`);
      candidateLayouts.push({ configuredWindow: candidate, actualWindow, rendererViewport: { width: layout.width, height: layout.height }, aspectRatio: candidate.width / candidate.height, contentBottom: layout.contentBottom, emptyBelowContentPx: layout.height - layout.contentBottom, scrollRequired: layout.scrollRequired, scrollWidth: layout.scrollWidth, overlappingCriticalElements: layout.overlappingCriticalElements });
    }
    const minimumWindow = { width: 800, height: 760 };
    const minimumActualWindow = await resizeWindow(first, minimumWindow.width, minimumWindow.height);
    assert.equal(minimumActualWindow.width, minimumWindow.width, 'Electron must allow the configured minimum width.');
    assert.equal(minimumActualWindow.height, minimumWindow.height, 'Electron must allow the configured minimum height.');
    const minimumLayout = await readLayout(first.cdp);
    assert.ok(minimumLayout.scrollWidth <= minimumLayout.width, 'The minimum window must not introduce horizontal scrolling.');
    assert.deepEqual(minimumLayout.overlappingCriticalElements, [], 'The minimum window must not overlap primary dashboard content.');
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-minimum-viewport.png'));
    assert.ok(minimumLayout.statusGapPx >= 0 && minimumLayout.statusGapPx <= 16, 'Small windows may vertically scroll but must not reserve a blank status gap.');

    const minimumToolsLayout = await readLayout(first.cdp);
    assert.ok(minimumToolsLayout.scrollWidth <= minimumToolsLayout.width, 'Expanded advanced tools at minimum width must not scroll horizontally.');
    assert.deepEqual(minimumToolsLayout.overlappingCriticalElements, [], 'Expanded advanced tools at minimum width must not overlap primary content.');
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-minimum-tools-open.png'));

    await evaluate(first.cdp, `(() => { const detail=document.getElementById('detail'); const safety=document.getElementById('safetyCard'); safety.hidden=false; safety.classList.add('is-expanded'); detail.hidden=false; detail.textContent=Array.from({length:28},(_,i)=>'호환성 진단 항목 '+(i+1)+': 테스트 화면 안에서 긴 오류 설명의 내부 스크롤을 확인합니다.').join('\\n'); })()`);
    const longErrorLayout = await readLayout(first.cdp);
    assert.equal(longErrorLayout.detailOverflowY, 'auto', 'Long compatibility details must use their own scroll area.');
    assert.ok(Number.parseFloat(longErrorLayout.detailMaxHeight) <= 112, 'Long compatibility details must remain height-limited.');
    assert.ok(longErrorLayout.detailScrollHeight > longErrorLayout.detailClientHeight, 'Synthetic long diagnostics must exercise the internal detail scrollbar.');
    assert.ok(longErrorLayout.scrollWidth <= longErrorLayout.width, 'Long diagnostics must not create horizontal overflow.');
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-long-error-detail.png'));
    await evaluate(first.cdp, `(() => { const detail=document.getElementById('detail'); const safety=document.getElementById('safetyCard'); detail.hidden=true; detail.textContent=''; safety.hidden=true; })()`);
    const restoredDefaultWindow = await resizeWindow(first, 920, 800);
    assert.equal(restoredDefaultWindow.width, 920, `The ${candidateLabel} capture window must be restored to its native default width.`);
    assert.equal(restoredDefaultWindow.height, 800, `The ${candidateLabel} capture window must be restored to its native default height.`);

    assert.equal(baselineSameViewportLayout.width, defaultWindowLayout.width, `The preserved A20 baseline must use the ${candidateLabel} default CSS width.`);
    assert.equal(baselineSameViewportLayout.height, defaultWindowLayout.height, `The preserved A20 baseline must use the ${candidateLabel} default CSS height.`);
    const initialLayout = defaultWindowLayout;
    assert.equal(initialLayout.advancedOpen, true, 'Advanced tools must be visible without expanding a panel.');
    assert.equal(initialLayout.advancedCollapsible, false, 'Advanced tools must not be an accordion.');
    assert.ok(initialLayout.scrollWidth <= initialLayout.width, 'Default dashboard must not overflow horizontally.');
    assert.equal(initialLayout.pathOverflow, 'ellipsis', 'Long root paths should not take over the dashboard.');
    assert.ok(initialLayout.pathTitle.includes('LilacAnime-desktop'), 'The full source path must remain available as the path title.');
    assert.equal(initialLayout.mainStatusChipCount, 1, 'Only one primary patch status chip should be visible.');
    assert.equal(initialLayout.visibleStatusChipCount, 1, 'Idle state should show only the primary patch status.');
    assert.equal(initialLayout.activityStatusHidden, true, 'Idle progress status should be hidden.');
    assert.equal(initialLayout.safetyCardHidden, true, 'Normal state should hide the safety card.');
    assert.equal(initialLayout.safetyExpanded, false, 'Normal state should not expand the warning card.');
    assert.equal(initialLayout.detailHidden, true, 'Successful state should not display empty or repetitive detail.');
    assert.ok(initialLayout.statusGapPx <= 16, 'Default window should show the work status directly after tool controls.');
    assert.deepEqual(initialLayout.overlappingCriticalElements, [], `The ${candidateLabel} default window must not overlap key text or controls.`);
    assert.ok(initialLayout.visibleControls.includes('chooseRoot') && initialLayout.visibleControls.includes('inspect'), 'Root selection and whole-list inspection must remain directly available.');
    const configuredWindowSize = { A20: { width: 920, height: 800, minWidth: 800, minHeight: 760 }, [candidateLabel]: { width: 920, height: 800, minWidth: 800, minHeight: 760 } };
    const configuredAspectRatio = { A20: configuredWindowSize.A20.width / configuredWindowSize.A20.height, [candidateLabel]: configuredWindowSize[candidateLabel].width / configuredWindowSize[candidateLabel].height };
    const patchPanelHeightReductionPx = baselineLayout.cardHeights['.patch-list-card'] - defaultWindowLayout.cardHeights['.patch-list-card'];
    const patchPanelSlackReductionPx = baselineLayout.patchPanelSlackPx - defaultWindowLayout.patchPanelSlackPx;
    const patchPanelSlackReductionPercent = baselineLayout.patchPanelSlackPx > 0 ? Number((patchPanelSlackReductionPx / baselineLayout.patchPanelSlackPx * 100).toFixed(1)) : null;
    const fixtureLayouts = [];
    const layoutMetricsReport = {
      configuredWindowSize,
      configuredAspectRatio,
      viewportAspectRatio: { A20: a20ViewportRatio, [candidateLabel]: a22ViewportRatio },
      windowRatioChangePercent: Number(((a22ViewportRatio / a20ViewportRatio - 1) * 100).toFixed(1)),
      patchPanelComparison: {
        A20: { panelHeight: baselineLayout.cardHeights['.patch-list-card'], rowStackHeight: baselineLayout.patchRowStackHeight, unusedAreaPx: baselineLayout.patchPanelSlackPx },
        [candidateLabel]: { panelHeight: defaultWindowLayout.cardHeights['.patch-list-card'], rowStackHeight: defaultWindowLayout.patchRowStackHeight, unusedAreaPx: defaultWindowLayout.patchPanelSlackPx },
        panelHeightReductionPx: patchPanelHeightReductionPx,
        unusedAreaReductionPx: patchPanelSlackReductionPx,
        unusedAreaReductionPercent: patchPanelSlackReductionPercent,
      },
      defaultWindow: {
        A20: { configured: a20NativeWindow.bounds, width: baselineLayout.width, height: baselineLayout.height, contentBottom: baselineLayout.contentBottom, bodyBottom: baselineLayout.bodyBottom, scrollRequired: baselineLayout.scrollRequired },
        [candidateLabel]: { configured: a22NativeWindow.bounds, width: defaultWindowLayout.width, height: defaultWindowLayout.height, contentBottom: defaultWindowLayout.contentBottom, bodyBottom: defaultWindowLayout.bodyBottom, emptyBelowContentPx: defaultWindowLayout.height - defaultWindowLayout.contentBottom, scrollRequired: defaultWindowLayout.scrollRequired },
      },
      minimumWindow: { configured: minimumWindow, actual: minimumActualWindow, layout: minimumLayout },
      minimumToolsOpen: { scrollWidth: minimumToolsLayout.scrollWidth, width: minimumToolsLayout.width, height: minimumToolsLayout.height, contentBottom: minimumToolsLayout.contentBottom, scrollRequired: minimumToolsLayout.scrollRequired },
      longErrorDetail: { clientHeight: longErrorLayout.detailClientHeight, scrollHeight: longErrorLayout.detailScrollHeight, overflowY: longErrorLayout.detailOverflowY, maxHeight: longErrorLayout.detailMaxHeight, horizontalOverflow: longErrorLayout.scrollWidth - longErrorLayout.width },
      sameViewport: {
        width: initialLayout.width, height: initialLayout.height,
        A20ContentBottom: baselineSameViewportLayout.contentBottom, [`${candidateLabel}ContentBottom`]: initialLayout.contentBottom,
        A20PatchPanelSlackPx: baselineSameViewportLayout.patchPanelSlackPx, [`${candidateLabel}PatchPanelSlackPx`]: initialLayout.patchPanelSlackPx,
        A20HorizontalOverflow: baselineSameViewportLayout.scrollWidth - baselineSameViewportLayout.width,
        [`${candidateLabel}HorizontalOverflow`]: initialLayout.scrollWidth - initialLayout.width,
      },
      fixtureLayouts,
      candidateLayouts,
    };
    fs.writeFileSync(path.join(screenshotRoot, 'layout-comparison.json'), JSON.stringify(layoutMetricsReport, null, 2), { flag: 'wx' });
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-electron-dark.png'));
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-auto-apply-complete.png'));

    const condensedPatchList = await evaluate(first.cdp, `(() => ({ rowCount: document.querySelectorAll('.patch-row').length, redundantDetails: Boolean(document.getElementById('patchDetails')), redundantBase: Boolean(document.getElementById('patchOfficialBase')), version: document.getElementById('targetPatchVersion').textContent, statusSpacing: getComputedStyle(document.querySelector('.result-card')).marginTop }))()`);
    assert.equal(condensedPatchList.rowCount, 1, 'Only the actual patch should be listed.');
    assert.equal(condensedPatchList.redundantDetails, false, 'Duplicate expandable patch details must be removed.');
    assert.equal(condensedPatchList.redundantBase, false, 'Redundant fixed official baseline must not be shown.');
    assert.match(condensedPatchList.version, /1\\.0\\.0/);
    assert.equal(condensedPatchList.statusSpacing, '0px', 'Task status must directly follow the cards without reserved space.');
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-compact-patch-list.png'));

    const realOnePatchLayout = await readLayout(first.cdp);
    assert.equal(realOnePatchLayout.patchRowCount, 1, 'Production starts with exactly one real patch row.');
    assert.ok(realOnePatchLayout.patchPanelSlackPx <= 24, 'A single patch must not leave a large blank area inside the panel.');
    await evaluate(first.cdp, `(() => { const list=document.getElementById('patchRows'); if(!list) throw new Error('Production patch list was not found.'); window.__dinoPatchRowsOriginalNodes=Array.from(list.childNodes); list.replaceChildren(); })()`);
    const fixtureCounts = [1, 3, 5, 10];
    for (const count of fixtureCounts) {
      const fixtureLayout = await mountSyntheticPatchFixture(first.cdp, count);
      assert.equal(fixtureLayout.patchRowCount, count, `Synthetic patch fixture should render ${count} rows.`);
      assert.ok(fixtureLayout.scrollWidth <= fixtureLayout.width, `${count}-row fixture must not overflow horizontally.`);
      assert.deepEqual(fixtureLayout.overlappingCriticalElements, [], `${count}-row fixture must not let the task status cover patch rows.`);
      assert.ok(fixtureLayout.patchPanelSlackPx <= 24, `${count}-row fixture must not add blank space below the list.`);
      assert.ok(fixtureLayout.patchListMaxHeight !== 'none', `${count}-row fixture must have a bounded list viewport.`);
      const fixtureStates = await evaluate(first.cdp, `Array.from(document.querySelectorAll('.synthetic-patch-fixture')).map((row) => ({state:row.querySelector('.status-chip')?.textContent, applyDisabled:row.querySelector('[data-fixture-action="apply"]')?.disabled, applyPrimary:row.querySelector('[data-fixture-action="apply"]')?.classList.contains('primary'), uninstallDisabled:row.querySelector('[data-fixture-action="uninstall"]')?.disabled}))`);
      assert.equal(fixtureStates[0].applyDisabled, true, 'Applied fixture must not allow re-apply.');
      assert.equal(fixtureStates[0].applyPrimary, false, 'Applied fixture must not emphasize a disabled apply action.');
      assert.equal(fixtureStates[0].uninstallDisabled, false, 'Applied fixture must allow uninstall.');
      if (count >= 2) {
        assert.equal(fixtureStates[1].applyDisabled, false, 'Compatible unapplied fixture must allow apply.');
        assert.equal(fixtureStates[1].applyPrimary, true, 'Compatible unapplied fixture should emphasize apply.');
        assert.equal(fixtureStates[1].uninstallDisabled, true, 'Unapplied fixture must not allow uninstall.');
      }
      if (count < 10) {
        assert.equal(fixtureLayout.patchListScrollHeight, fixtureLayout.patchListHeight, `${count} rows should expand naturally without an inner scrollbar.`);
      } else {
        assert.ok(fixtureLayout.patchListScrollHeight > fixtureLayout.patchListHeight, 'Ten rows must scroll inside the list instead of extending the page indefinitely.');
        assert.equal(fixtureLayout.patchListOverflowY, 'auto');
      }
      await saveScreenshot(first.cdp, path.join(screenshotRoot, `manager-patch-list-${count}-synthetic-fixture.png`));
      fixtureLayouts.push({ count, panelHeight: fixtureLayout.cardHeights['.patch-list-card'], panelSlackPx: fixtureLayout.patchPanelSlackPx, rowStackHeight: fixtureLayout.patchRowStackHeight, listHeight: fixtureLayout.patchListHeight, listScrollHeight: fixtureLayout.patchListScrollHeight, listMaxHeight: fixtureLayout.patchListMaxHeight, scrollRequired: fixtureLayout.patchListScrollHeight > fixtureLayout.patchListHeight });
    }
    await evaluate(first.cdp, `(() => { const list=document.getElementById('patchRows'); if(!list || !window.__dinoPatchRowsOriginalNodes) throw new Error('Production patch rows could not be restored after synthetic layout checks.'); list.replaceChildren(...window.__dinoPatchRowsOriginalNodes); delete window.__dinoPatchRowsOriginalNodes; })()`);
    await readLayout(first.cdp);
    const layoutComparisonPath = path.join(screenshotRoot, 'layout-comparison.json');
    const layoutComparison = JSON.parse(fs.readFileSync(layoutComparisonPath, 'utf8'));
    layoutComparison.fixtureLayouts = fixtureLayouts;
    fs.writeFileSync(layoutComparisonPath, JSON.stringify(layoutComparison, null, 2), { flag: 'w' });

    const manualDetails = await evaluate(first.cdp, `(() => { const details=document.querySelector('.advanced-tools'); return {visible:details.getBoundingClientRect().height > 100, controls:['inspect','apply','recover','history','uninstall','backupSelect','restore','checkUpdates','diagnostics'].every((id)=>document.getElementById(id)), oneManualApply:document.querySelectorAll('#apply').length===1&&!document.getElementById('rowApply'), logsInsideAdvanced:details.contains(document.querySelector('.log-details')), updateControlsOutsideMain:!document.querySelector('.patch-list-card').contains(document.getElementById('checkUpdates')), contentHeight:Math.round(details.getBoundingClientRect().height)}; })()`);
    assert.equal(manualDetails.visible, true, 'Advanced tools must always be visible.');
    assert.equal(manualDetails.controls, true, 'Existing inspect, history, patch, restore, update and diagnostic controls must remain present.');
    assert.equal(manualDetails.oneManualApply, true, 'Manual apply must exist exactly once and stay outside the patch-list row.');
    assert.equal(manualDetails.logsInsideAdvanced, true, 'Detailed logs must stay inside the tool section.');
    assert.equal(manualDetails.updateControlsOutsideMain, true, 'Official updater controls must stay out of the main patch-list area.');
    const manualToolsLayout = await readLayout(first.cdp);
    assert.ok(manualToolsLayout.scrollWidth <= manualToolsLayout.width, 'Expanded advanced tools must not introduce horizontal overflow at the default size.');
    assert.deepEqual(manualToolsLayout.overlappingCriticalElements, [], 'Expanded advanced tools must not overlap primary content.');
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-manual-tools-open.png'));
    await click(first.cdp, '#checkUpdates', '공식 업데이트 조회 (고급 도구)');
    const updateState = await waitForUi(first.cdp, (state) => state.busy === '대기' && state.update && state.update !== '업데이트 확인 전', 'Explicit update lookup in advanced tools');
    if (updateState.update.startsWith('공식 새 버전')) {
      const updateControls = await evaluate(first.cdp, `({installButton:Boolean(document.getElementById('approveUpdate')),status:document.getElementById('updateStatus').textContent})`);
      assert.equal(updateControls.installButton, false, 'The manager can check official releases but must not expose a source-install action.');
      assert.match(updateControls.status, /설치 미지원/);
      const treeBeforeUpdateReview = treeDigest(sourceRoot, new Set(['DinoPatchManager']));
      assert.deepEqual(treeDigest(sourceRoot, new Set(['DinoPatchManager'])), treeBeforeUpdateReview, 'Reviewing an unsupported release must not modify the official source.');
    }

    await evaluate(first.cdp, 'document.activeElement && document.activeElement.blur()');
    await first.cdp.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await first.cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const focusLayout = await readLayout(first.cdp);
    assert.ok(['inspect', 'chooseRoot'].includes(focusLayout.focusId), `Tab navigation should reach the first dashboard action, got ${focusLayout.focusId}.`);
    assert.equal(focusLayout.focusVisible, true, 'Keyboard focus must be visually indicated.');

    await emulateViewport(first.cdp, 732, 641, 1);
    const narrowLayout = await readLayout(first.cdp);
    assert.ok(narrowLayout.scrollWidth <= narrowLayout.width, `Narrow viewport must not introduce horizontal overflow: ${JSON.stringify(narrowLayout)}`);
    await saveScreenshot(first.cdp, path.join(screenshotRoot, 'manager-narrow-viewport.png'));
    for (const scale of [1, 1.25, 1.5]) {
      await emulateViewport(first.cdp, initialLayout.width, initialLayout.height, scale);
      const scaledLayout = await readLayout(first.cdp);
      assert.ok(scaledLayout.scrollWidth <= scaledLayout.width, `Layout must fit at emulated ${Math.round(scale * 100)}% Windows scaling.`);
      assert.ok(Math.abs(scaledLayout.devicePixelRatio - scale) < 0.02, `Chromium must emulate ${Math.round(scale * 100)}% scale.`);
    }
    await first.cdp.command('Emulation.clearDeviceMetricsOverride');

    await click(first.cdp, '#inspect', '상태 확인');
    await waitForUi(first.cdp, (state) => state.busy === '대기' && state.patch === '적용됨 · 호환' && state.backupCount === 1, 'Repeat inspection without duplicate backup');
    await closeManager(first);
    first = null;

    second = await startPackagedManager({ sourceRoot, profileRoot, theme: 'light', label: 'light manager run' });
    await waitForUi(second.cdp, (state) => state.theme && state.theme.includes('자동 연동 · light'), 'Light theme read-only sync');
    const lightLayout = await readLayout(second.cdp);
    assert.ok(lightLayout.bodyBottom >= lightLayout.height, 'The light-theme page background must fill the complete Electron window.');
    assert.ok(lightLayout.scrollWidth <= lightLayout.width, 'The light-theme dashboard must not clip horizontally.');
    await saveScreenshot(second.cdp, path.join(screenshotRoot, 'manager-electron-light.png'));
    const runtimePaths = second.info.runtimePaths;
    await click(second.cdp, '#history', '작업 기록');
    const historyState = await waitForUi(second.cdp, (state) => state.historyRendered, 'History button renders engine records');
    assert.equal(historyState.historyRendered, true, 'History button must render actual engine records.');
    await click(second.cdp, '#uninstall', '패치 해제');
    await waitForUi(second.cdp, (state) => state.busy === '대기' && state.patch === '호환 · 미적용', 'Uninstall button');
    const unappliedActions = await evaluate(second.cdp, `({inspectDisabled:document.getElementById('inspect').disabled,uninstallDisabled:document.getElementById('uninstall').disabled,status:document.getElementById('autoManageStatus').textContent})`);
    assert.equal(unappliedActions.inspectDisabled, false, 'A compatible source can be rechecked through the automatic apply path.');
    assert.equal(unappliedActions.uninstallDisabled, true, 'Unapplied patch must disable uninstall.');
    await saveScreenshot(second.cdp, path.join(screenshotRoot, 'manager-unapplied-auto-recheck.png'));
    await click(second.cdp, '#inspect', '원본 다시 확인 및 자동 적용');
    await waitForUi(second.cdp, (state) => state.busy === '대기' && state.patch === '적용됨 · 호환', 'Manual recheck auto-applies a compatible source');
    const appliedActions = await evaluate(second.cdp, `({inspectDisabled:document.getElementById('inspect').disabled,uninstallDisabled:document.getElementById('uninstall').disabled})`);
    assert.equal(appliedActions.inspectDisabled, false, 'The recheck remains available after application.');
    assert.equal(appliedActions.uninstallDisabled, false, 'Applied patch must enable uninstall.');
    const availableBackupControls = await evaluate(second.cdp, `({options:document.getElementById('backupSelect').options.length, selected:document.getElementById('backupSelect').value, backupText:document.getElementById('backupSelect').options[0]?.textContent, selectDisabled:document.getElementById('backupSelect').disabled, restoreDisabled:document.getElementById('restore').disabled})`);
    assert.equal(availableBackupControls.options, 1, 'Only the current restorable backup should be listed after reapply.');
    assert.ok(availableBackupControls.selected, 'The restorable backup should be selected by default.');
    assert.match(availableBackupControls.backupText, /복원 가능/);
    assert.equal(availableBackupControls.selectDisabled, false);
    assert.equal(availableBackupControls.restoreDisabled, false);
    await click(second.cdp, '#restore', '백업 복원');
    await waitForUi(second.cdp, (state) => state.busy === '대기' && state.patch === '호환 · 미적용', 'Restore button');
    const restoredBackupControls = await evaluate(second.cdp, `({options:document.getElementById('backupSelect').options.length, selected:document.getElementById('backupSelect').value, backupText:document.getElementById('backupSelect').options[0]?.textContent, selectDisabled:document.getElementById('backupSelect').disabled, restoreDisabled:document.getElementById('restore').disabled})`);
    assert.equal(restoredBackupControls.options, 1, 'A restored backup must no longer appear as an available restore target.');
    assert.equal(restoredBackupControls.selected, '', 'No non-restorable backup may remain selected.');
    assert.equal(restoredBackupControls.backupText, '복원 가능한 백업 없음');
    assert.equal(restoredBackupControls.selectDisabled, true);
    assert.equal(restoredBackupControls.restoreDisabled, true, 'Restore must stay disabled when no restorable backup exists.');
    await saveScreenshot(second.cdp, path.join(screenshotRoot, 'manager-restored-backups-unavailable.png'));
    const restoredTree = treeDigest(sourceRoot, new Set(['DinoPatchManager']));
    assert.deepEqual(restoredTree, baselineTree, 'Uninstall and restore must leave the official source tree byte-identical.');
    await closeManager(second);
    second = null;

    const packageFile = path.join(sourceRoot, 'package.json');
    const originalPackage = fs.readFileSync(packageFile);
    const originalPackageInfo = JSON.parse(originalPackage.toString('utf8'));
    const patchStateDir = path.join(sourceRoot, 'DinoPatchManager', 'state');
    const backupDir = path.join(sourceRoot, 'DinoPatchManager', 'backups');
    const stateBeforeCompatibilityChecks = treeDigest(patchStateDir);
    const backupsBeforeCompatibilityChecks = treeDigest(backupDir);
    const compatibilityProfile = path.join(tempRoot, 'compatibility profile');
    fs.mkdirSync(compatibilityProfile, { recursive: false });

    originalPackageInfo.version = '0.5.55';
    fs.writeFileSync(packageFile, JSON.stringify(originalPackageInfo, null, 2));
    let compatibility = null;
    try {
      compatibility = await startPackagedManager({
        sourceRoot, profileRoot: compatibilityProfile, theme: 'dark', label: 'unsupported-version manager run',
        expectedPatch: '적용 중단', waitForUpdate: false,
      });
      const unsupportedUi = await evaluate(compatibility.cdp, '({ message: document.getElementById("message").textContent, detail: document.getElementById("detail").textContent, detailHidden: document.getElementById("detail").hidden, safetyExpanded: document.getElementById("safetyCard").classList.contains("is-expanded") })');
      assert.match(unsupportedUi.detail, /공식 원본 파일 수가 다릅니다/);
      assert.match(unsupportedUi.detail, /기대 145, 확인 141/);
      assert.equal(unsupportedUi.detailHidden, false, 'Unsupported version details should remain visible.');
      assert.equal(unsupportedUi.safetyExpanded, true, 'Unsupported version should expand the safety explanation.');
      await saveScreenshot(compatibility.cdp, path.join(screenshotRoot, 'manager-unsupported-version.png'));
      assert.deepEqual(treeDigest(patchStateDir), stateBeforeCompatibilityChecks, 'Unsupported version handling must not alter manager state.');
      assert.deepEqual(treeDigest(backupDir), backupsBeforeCompatibilityChecks, 'Unsupported version handling must not add or change backups.');
    } finally {
      if (compatibility) { await closeManager(compatibility); compatibility = null; }
      fs.writeFileSync(packageFile, originalPackage);
    }

    const appFile = path.join(sourceRoot, 'src', 'app.js');
    const originalApp = fs.readFileSync(appFile);
    const missingFileProfile = path.join(tempRoot, 'missing source profile');
    fs.mkdirSync(missingFileProfile, { recursive: false });
    fs.unlinkSync(appFile);
    let missingFileManager = null;
    try {
      missingFileManager = await startPackagedManager({
        sourceRoot, profileRoot: missingFileProfile, theme: 'dark', label: 'missing-source-file manager run',
        expectedPatch: '적용 중단', waitForUpdate: false,
      });
      const missingUi = await evaluate(missingFileManager.cdp, '({ message: document.getElementById("message").textContent, detail: document.getElementById("detail").textContent, detailHidden: document.getElementById("detail").hidden, safetyExpanded: document.getElementById("safetyCard").classList.contains("is-expanded") })');
      assert.match(missingUi.detail, /지원되는 LilacAnime 소스 구조가 아닙니다/);
      assert.equal(missingUi.detailHidden, false, 'Missing source details should remain visible.');
      assert.equal(missingUi.safetyExpanded, true, 'Missing source errors should expand the safety explanation.');
      await saveScreenshot(missingFileManager.cdp, path.join(screenshotRoot, 'manager-missing-source-file.png'));
      assert.deepEqual(treeDigest(patchStateDir), stateBeforeCompatibilityChecks, 'Missing required source files must not alter manager state.');
      assert.deepEqual(treeDigest(backupDir), backupsBeforeCompatibilityChecks, 'Missing required source files must not add or change backups.');
    } finally {
      if (missingFileManager) { await closeManager(missingFileManager); missingFileManager = null; }
      fs.writeFileSync(appFile, originalApp);
    }

    assert.deepEqual(treeDigest(sourceRoot, new Set(['DinoPatchManager'])), baselineTree, 'Rejected compatibility cases must leave the official source byte-identical.');

    second = await startPackagedManager({ sourceRoot, profileRoot, theme: 'light', label: 'conflict-protection manager run' });
    const userEdit = '\n// test-only user edit: must survive conflict rejection\n';
    fs.appendFileSync(appFile, userEdit, 'utf8');
    await click(second.cdp, '#uninstall', '충돌 상태의 패치 해제');
    await waitForUi(second.cdp, (state) => state.busy === '대기' && state.patch === '파일 충돌' && state.detail.includes('사용자 변경') && state.message.includes('실패'), 'Uninstall conflict rejection with fresh source inspection');
    assert.ok(fs.readFileSync(appFile, 'utf8').includes(userEdit.trim()), 'A conflicting user edit must remain untouched.');
    const conflictActions = await evaluate(second.cdp, `({recheckDisabled:document.getElementById('inspect').disabled,uninstallDisabled:document.getElementById('uninstall').disabled,restoreDisabled:document.getElementById('restore').disabled})`);
    assert.deepEqual(conflictActions, { recheckDisabled: false, uninstallDisabled: true, restoreDisabled: true }, 'A verified conflict must keep recheck available and block file-changing actions.');
    const conflictExpanded = await evaluate(second.cdp, 'document.getElementById("safetyCard").classList.contains("is-expanded") && !document.getElementById("detail").hidden');
    assert.equal(conflictExpanded, true, 'File conflict should expand the safety explanation and show its cause.');
    await saveScreenshot(second.cdp, path.join(screenshotRoot, 'manager-conflict-protection.png'));
    await closeManager(second);
    second = null;

    await captureComparison(screenshotRoot);
    await captureA20WindowComparisons(screenshotRoot);
    captureA21FinalComparison(screenshotRoot);
    smokePassed = true;
    process.stdout.write(`${JSON.stringify({
      status: 'PASS', officialCommit, officialArchiveSha256: archive.archiveSha256, originalFileCount: baselineTree.count,
      originalTreeHash: baselineTree.sha256, restoredTreeHash: restoredTree.sha256, managerExe: builtExe, runtimePaths,
      layout: {
        configuredWindowSize, configuredAspectRatio, viewportAspectRatio: { A20: a20ViewportRatio, [candidateLabel]: a22ViewportRatio },
        windowRatioChangePercent: Number(((a22ViewportRatio / a20ViewportRatio - 1) * 100).toFixed(1)),
        patchPanelComparison: {
          A20: { panelHeight: baselineLayout.cardHeights['.patch-list-card'], rowStackHeight: baselineLayout.patchRowStackHeight, unusedAreaPx: baselineLayout.patchPanelSlackPx },
          [candidateLabel]: { panelHeight: defaultWindowLayout.cardHeights['.patch-list-card'], rowStackHeight: defaultWindowLayout.patchRowStackHeight, unusedAreaPx: defaultWindowLayout.patchPanelSlackPx },
          panelHeightReductionPx: patchPanelHeightReductionPx, unusedAreaReductionPx: patchPanelSlackReductionPx, unusedAreaReductionPercent: patchPanelSlackReductionPercent,
        },
        defaultWindow: defaultWindowLayout, A20SameViewport: baselineSameViewportLayout, minimumWindow: minimumLayout,
        expandedAdvancedTools: minimumToolsLayout, longErrorDetail: longErrorLayout, fixtureLayouts, candidateLayouts, lightTheme: lightLayout,
      },
      screenshots: screenshotRoot,
      checks: [
        'official archive integrity', `preserved A20 screenshot/layout and ${candidateLabel} manager compared at the same default window size`,
        `A20 patch-list unused area measured against ${candidateLabel}`, `A21-final and ${candidateLabel}-final same-window PNG comparison`, 'real single patch row and 1/3/5/10 synthetic layout fixtures',
        '1/3/5 rows grow naturally; 10 rows use bounded inner scrolling', 'applied/unapplied row action priority verified',
        '900x760, 920x800 and 960x820 candidates measured in Electron', 'minimum window and advanced tools remain usable',
        'long compatibility details scroll internally without horizontal overflow', 'default BrowserWindow has no page overflow or clipping',
        'official source auto-detected', 'automatic apply', 'inspect did not duplicate backup', 'restart remained APPLIED',
        'dark/light theme read-only sync and full-window background', 'single primary patch status', 'idle status and normal safety note hidden',
        'error safety details expanded', 'default dashboard hierarchy and path truncation',
        'updater controls remain advanced and existing engine actions remain accessible', 'unsupported updater install remains disabled', 'keyboard focus', 'narrow viewport layout',
        '100/125/150 percent Chromium scale emulation', 'history/uninstall/apply/backup-restore buttons', 'only restorable backups are selectable and restored backups disappear',
        'restored official source tree equals baseline', 'unsupported version and missing files rejected without source writes',
        'conflicting edit preserved; failed operation re-inspected and file-changing actions stayed disabled', 'packaged manager ran real apply through bundled engine',
      ],
    }, null, 2)}\n`);
  } finally {
    let processTreesStopped = true;
    if (first) {
      try { await closeManager(first); } catch (error) { processTreesStopped = first.child.exitCode !== null; process.stderr.write(`${error.message}\n`); }
    }
    if (second) {
      try { await closeManager(second); } catch (error) { processTreesStopped = processTreesStopped && second.child.exitCode !== null; process.stderr.write(`${error.message}\n`); }
    }
    const resolved = fs.realpathSync.native(tempRoot);
    const osTemp = fs.realpathSync.native(os.tmpdir());
    if (!smokePassed) {
      process.stderr.write(`Failed smoke workspace retained for diagnosis: ${resolved}\n`);
    } else if (within(resolved, osTemp) && resolved !== osTemp && processTreesStopped) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); }
      catch (error) { process.stderr.write(`Test Temp cleanup not completed (preserved at ${resolved}): ${error.code || error.name}.\n`); }
    } else if (!processTreesStopped) {
      process.stderr.write(`Test Temp cleanup skipped because an Electron process may still be running: ${resolved}\n`);
    }
  }
}

function captureComparison(artifactDir) {
  const powershell = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $root='${artifactDir.replace(/'/g, "''")}'; $paths=@((Join-Path $root 'A-original-electron-preview.png'),(Join-Path $root 'manager-electron-dark.png'),(Join-Path $root 'manager-electron-light.png')); foreach($p in $paths){if(-not(Test-Path -LiteralPath $p -PathType Leaf)){throw "Missing screenshot: $p"}}; $images=@($paths|ForEach-Object{[System.Drawing.Image]::FromFile($_)}); try{$gap=20; $label=34; $width=[int](($images|Measure-Object -Property Width -Maximum).Maximum); $height=[int](($images|Measure-Object -Property Height -Maximum).Maximum); $canvasWidth=[int](($width*3)+($gap*4)); $canvasHeight=[int]($height+$label); $bitmap=[System.Drawing.Bitmap]::new($canvasWidth,$canvasHeight); $graphics=[System.Drawing.Graphics]::FromImage($bitmap); try{$graphics.Clear([System.Drawing.Color]::FromArgb(17,24,32)); $font=[System.Drawing.Font]::new('Segoe UI',12,[System.Drawing.FontStyle]::Bold); try{for($i=0;$i -lt 3;$i++){$x=$gap+($i*($width+$gap)); $graphics.DrawString(@('A 원본','Electron 관리자 · 다크','Electron 관리자 · 라이트')[$i],$font,[System.Drawing.Brushes]::White,[single]$x,[single]8); $graphics.DrawImage($images[$i],$x, $label, $width, $height)}}finally{$font.Dispose()}; $bitmap.Save((Join-Path $root 'A-vs-Electron-comparison.png'),[System.Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}}finally{foreach($img in $images){$img.Dispose()}}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershell], { encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`PNG comparison composition failed: ${result.stderr || result.stdout || result.status}`);
}

function captureA20WindowComparisons(artifactDir) {
  const powershell = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $root='${artifactDir.replace(/'/g, "''")}'; function SavePair($paths,$output,$labels){foreach($p in $paths){if(-not(Test-Path -LiteralPath $p -PathType Leaf)){throw "Missing screenshot: $p"}}; $images=@($paths|ForEach-Object{[System.Drawing.Image]::FromFile($_)}); try{$gap=20; $label=34; $width=[int](($images|Measure-Object -Property Width -Maximum).Maximum); $height=[int](($images|Measure-Object -Property Height -Maximum).Maximum); $bitmap=[System.Drawing.Bitmap]::new([int]($width*2+$gap*3),[int]($height+$label)); $graphics=[System.Drawing.Graphics]::FromImage($bitmap); try{$graphics.Clear([System.Drawing.Color]::FromArgb(17,24,32)); $font=[System.Drawing.Font]::new('Segoe UI',12,[System.Drawing.FontStyle]::Bold); try{for($i=0;$i -lt 2;$i++){$x=$gap+($i*($width+$gap)); $graphics.DrawString($labels[$i],$font,[System.Drawing.Brushes]::White,[single]$x,[single]8); $graphics.DrawImage($images[$i],$x,$label,$images[$i].Width,$images[$i].Height)}}finally{$font.Dispose()}; $bitmap.Save((Join-Path $root $output),[System.Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}}finally{foreach($img in $images){$img.Dispose()}}}; SavePair @((Join-Path $root 'manager-a20-before.png'),(Join-Path $root 'manager-electron-default-window.png')) 'A20-vs-${candidateLabel}-window-comparison.png' @('A20 · 920×800','${candidateLabel} · 920×800'); SavePair @((Join-Path $root 'manager-a20-same-viewport.png'),(Join-Path $root 'manager-electron-default-window.png')) 'A20-vs-${candidateLabel}-same-viewport-comparison.png' @('A20 · ${candidateLabel} 동일 뷰포트','${candidateLabel} · 기본 뷰포트');`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershell], { encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`A20/${candidateLabel} PNG comparison composition failed: ${result.stderr || result.stdout || result.status}`);
}

function captureA21FinalComparison(artifactDir) {
  const updatedScreenshot = path.join(artifactDir, 'manager-electron-default-window.png');
  const baselineDimensions = pngDimensions(a21FinalDefaultScreenshot);
  const updatedDimensions = pngDimensions(updatedScreenshot);
  assert.deepEqual(updatedDimensions, baselineDimensions, `A21-final and ${candidateLabel}-final captures must use the same actual client viewport.`);
  const { width, height } = baselineDimensions;
  const left = a21FinalDefaultScreenshot.replace(/'/g, "''");
  const right = updatedScreenshot.replace(/'/g, "''");
  const output = path.join(artifactDir, `A21-final-vs-${candidateLabel}-window-comparison.png`);
  const destination = output.replace(/'/g, "''");
  const powershell = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $paths=@('${left}','${right}'); $images=@($paths|ForEach-Object{[System.Drawing.Image]::FromFile($_)}); try{$gap=20; $label=34; $width=${width}; $height=${height}; $bitmap=[System.Drawing.Bitmap]::new([int]($width*2+$gap*3),[int]($height+$label)); $graphics=[System.Drawing.Graphics]::FromImage($bitmap); try{$graphics.Clear([System.Drawing.Color]::FromArgb(17,24,32)); $font=[System.Drawing.Font]::new('Segoe UI',12,[System.Drawing.FontStyle]::Bold); try{$graphics.DrawString('A21-final · ${width}×${height} 뷰포트',$font,[System.Drawing.Brushes]::White,[single]$gap,[single]8); $graphics.DrawString('${candidateLabel}-final · ${width}×${height} 뷰포트',$font,[System.Drawing.Brushes]::White,[single]($gap+$width+$gap),[single]8)}finally{$font.Dispose()}; $graphics.DrawImage($images[0],$gap,$label,$width,$height); $graphics.DrawImage($images[1],$gap*2+$width,$label,$width,$height); $bitmap.Save('${destination}',[System.Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}}finally{foreach($img in $images){$img.Dispose()}}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershell], { encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`A21-final/${candidateLabel}-final comparison composition failed: ${result.stderr || result.stdout || result.status}`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
