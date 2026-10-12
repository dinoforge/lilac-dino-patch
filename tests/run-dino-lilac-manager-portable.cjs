'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('The packaged DinoLilacPatch test is Windows-only.');

const repoRoot = path.resolve(__dirname, '..');
const executable = path.resolve(process.env.DINO_LILAC_MANAGER_EXE || path.join(repoRoot, 'dist', 'dino-lilac-patch-issue5', 'DinoLilacPatch.exe'));
const sourceRoot = process.env.DINO_LILAC_V0515_SOURCE;
const originalTemp = fs.realpathSync(os.tmpdir());
const sessionRoot = path.join(originalTemp, `dino-lilac-portable-test-${crypto.randomUUID()}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let target;
let child;
let socket;
let sessionCreated = false;
const pending = new Map();
let nextId = 0;

if (!sourceRoot) throw new Error('Set DINO_LILAC_V0515_SOURCE to the clean pinned official v0.5.15 Git checkout.');
if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw new Error('The built standalone DinoLilacPatch.exe was not found.');

function assertOwnedSessionRoot(candidate) {
  const real = fs.realpathSync(candidate);
  const relative = path.relative(originalTemp, real);
  const stat = fs.lstatSync(real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || stat.isSymbolicLink() ||
      !path.basename(real).startsWith('dino-lilac-portable-test-')) {
    throw new Error('Refusing to clean an unexpected packaged-manager test path.');
  }
  return real;
}

async function choosePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForPage(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error('The portable manager exited before exposing its test window.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(item => item.type === 'page' && /dino-lilac-patch[\\/]manager[\\/]index\.html/i.test(decodeURIComponent(item.url || '')));
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('The standalone EXE did not expose its local manager page for UI verification.');
}

function attachDebugger(url) {
  const wsUrl = new URL(url);
  wsUrl.hostname = '127.0.0.1';
  socket = new WebSocket(wsUrl.href);
  socket.addEventListener('message', async event => {
    try {
      const raw = typeof event.data === 'string' ? event.data : await event.data.text();
      const message = JSON.parse(raw);
      if (!message.id) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error('Chrome DevTools command failed.'));
      else waiter.resolve(message.result || {});
    } catch {}
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('The standalone manager UI closed during verification.'));
    pending.clear();
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to the standalone manager UI.')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to the standalone manager UI.')); }, { once: true });
  });
}

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error('The standalone manager UI script failed.');
  return result.result?.value;
}

async function waitFor(label, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForUiResult(needle, label) {
  return waitFor(label, async () => {
    const value = await evaluate("({text:document.querySelector('#message')?.textContent||'',tone:document.querySelector('#message')?.dataset.tone||''})");
    if (value?.tone === 'error') throw new Error(`The manager reported an error during ${label}.`);
    return value?.text?.includes(needle) ? value.text : null;
  });
}

function hashFile(root, relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, ...relative.split('/')))).digest('hex');
}

async function setFlags(flags) {
  const ids = { 'patch-01': 'patch01', 'patch-02': 'patch02', 'patch-03': 'patch03' };
  await evaluate(`(()=>{const flags=${JSON.stringify(flags)};for(const [patch,id] of Object.entries(${JSON.stringify(ids)})){document.getElementById(id).checked=flags[patch]===true;}return true;})()`);
}

async function applyFlags(flags, expectedPayload) {
  await setFlags(flags);
  await evaluate("window.confirm=()=>true;document.getElementById('apply').click();true");
  await waitForUiResult('적용 결과', 'apply');
  const state = target && require('../dino-lilac-patch/manager-core.cjs').inspectTarget(target.root);
  assert.equal(state?.mode, 'applied');
  assert.deepEqual(state.settings.patches, flags);
  for (const id of ['patch-01', 'patch-02', 'patch-03']) {
    assert.equal(state.patches[id].status, flags[id] ? 'applied' : 'disabled');
  }
  if (expectedPayload) assert.equal(fs.existsSync(path.join(target.root, ...expectedPayload.split('/'))), true, `${expectedPayload} packaged payload was applied`);
  const unifiedScript = path.join(target.root, 'src', 'unified-catalog.js');
  if (flags['patch-03']) {
    assert.equal(fs.existsSync(unifiedScript), true, 'Patch 03 ON includes the integrated catalog payload');
    assert.match(fs.readFileSync(path.join(target.root, 'src', 'index.html'), 'utf8'), /unified-catalog\.js/, 'Patch 03 ON wires the integrated catalog into the source');
  } else {
    assert.equal(fs.existsSync(unifiedScript), false, 'Patch 03 OFF keeps the source A path');
  }
}

async function restoreAndCheck(anchors) {
  await evaluate("window.confirm=()=>true;document.getElementById('restore').click();true");
  await waitForUiResult('복구 결과', 'restore');
  const manager = require('../dino-lilac-patch/manager-core.cjs');
  const state = manager.inspectTarget(target.root);
  assert.equal(state.mode, 'ready');
  assert.deepEqual(state.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': false });
  for (const file of anchors) assert.equal(hashFile(target.root, file), hashFile(sourceRoot, file), `${file} restored to the official source hash`);
}

async function run() {
  fs.mkdirSync(sessionRoot, { recursive: false });
  sessionCreated = true;
  process.env.TEMP = sessionRoot;
  process.env.TMP = sessionRoot;

  const manager = require('../dino-lilac-patch/manager-core.cjs');
  const { assertIsolatedTarget, TARGET_MARKER } = require('../dino-lilac-patch/isolated-target.cjs');
  target = manager.createTargetFromSource(sourceRoot);
  assertIsolatedTarget(target.root);

  const port = await choosePort();
  child = spawn(executable, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], {
    cwd: sessionRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, DINO_LILAC_MANAGER_TEST: '1', DINO_LILAC_MANAGER_TEST_TARGET: target.root }
  });
  const page = await waitForPage(port);
  await attachDebugger(page.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor('manager renderer and preload', () => evaluate("Boolean(window.dinoPatchManager && document.getElementById('patch01') && document.getElementById('patch02') && document.getElementById('patch03'))"));

  const initial = await evaluate("({patch01:document.getElementById('patch01').checked,patch02:document.getElementById('patch02').checked,patch03:document.getElementById('patch03').checked,target:document.getElementById('targetPath').textContent})");
  assert.deepEqual({ patch01: initial.patch01, patch02: initial.patch02, patch03: initial.patch03 }, { patch01: false, patch02: false, patch03: true });
  const anchors = ['package.json', 'src/index.html', 'electron/main.cjs', 'electron/preload.cjs'];
  const scenarios = [
    { patches: { 'patch-01': true, 'patch-02': false, 'patch-03': false }, payload: 'src/weekday-schedule.js' },
    { patches: { 'patch-01': false, 'patch-02': true, 'patch-03': false }, payload: 'electron/chatgpt-web-ui-driver.cjs' },
    { patches: { 'patch-01': false, 'patch-02': false, 'patch-03': true }, payload: 'src/unified-catalog.js' }
  ];
  for (const scenario of scenarios) {
    await applyFlags(scenario.patches, scenario.payload);
    await restoreAndCheck(anchors);
  }

  const finalState = manager.inspectTarget(target.root);
  assert.deepEqual(finalState.settings.patches, { 'patch-01': false, 'patch-02': false, 'patch-03': false });
  process.stdout.write(`DINO_LILAC_PORTABLE_E2E_RESULT=${JSON.stringify({ executableLaunch: 'passed', workingDirectoryOutsideCheckout: true, patchToggles: 'each patch ON independently; remaining patches OFF', applyRestoreCycles: 3, restoredAnchorHashes: 4, target: 'manager-created OS-temp official source copy' })}\n`);

  try { await send('Browser.close'); } catch {}
}

run().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  try { socket?.close(); } catch {}
  if (child && child.exitCode === null) {
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(8000)]);
    if (child.exitCode === null) { try { child.kill(); } catch {} }
  }
  try {
    if (target) {
      const { assertIsolatedTarget, TARGET_MARKER } = require('../dino-lilac-patch/isolated-target.cjs');
      const root = assertIsolatedTarget(target.root);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(`${root}${TARGET_MARKER}`, { force: true });
      fs.rmSync(`${root}.patch-manager`, { recursive: true, force: true });
    }
  } catch {}
  try { if (sessionCreated) fs.rmSync(assertOwnedSessionRoot(sessionRoot), { recursive: true, force: true }); } catch {}
});
