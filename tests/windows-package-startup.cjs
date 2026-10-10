const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') throw new Error('The packaged executable smoke test only runs on Windows.');

const repo = path.resolve(__dirname, '..');
const exe = path.join(repo, 'dist', 'win-unpacked', 'LilacAnime.exe');
const appAsar = path.join(repo, 'dist', 'win-unpacked', 'resources', 'app.asar');
const expectedVersion = require('../package.json').version;
assert.ok(fs.existsSync(exe), `the unpacked Windows executable exists: ${exe}`);
assert.ok(fs.existsSync(appAsar), `the packaged app archive exists: ${appAsar}`);

const tempParent = path.resolve(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'lilac-phase1-exe-'));
const profileRoot = path.join(tempRoot, 'profile');
const appDataRoot = path.join(tempRoot, 'roaming');
const localAppDataRoot = path.join(tempRoot, 'local');
const tempFilesRoot = path.join(tempRoot, 'temp');
for (const directory of [profileRoot, appDataRoot, localAppDataRoot, tempFilesRoot]) {
  fs.mkdirSync(directory, { recursive: true });
}

function cleanupTempRoot() {
  const target = path.resolve(tempRoot);
  if (path.dirname(target) !== tempParent || !/^lilac-phase1-exe-[A-Za-z0-9_-]+$/.test(path.basename(target))) {
    throw new Error(`Refusing to remove an unexpected Windows exe smoke path: ${target}`);
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove a non-directory or linked Windows exe smoke path: ${target}`);
  }
  const allowed = new Set(['profile', 'roaming', 'local', 'temp']);
  const unexpected = fs.readdirSync(target).filter(name => !allowed.has(name));
  if (unexpected.length) throw new Error(`Refusing unexpected Windows exe smoke files: ${unexpected.join(', ')}`);
  fs.rmSync(target, { recursive: true, force: true });
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, response => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200, `DevTools ${pathname} responds successfully`);
          resolve(JSON.parse(chunks.join('')));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(1500, () => request.destroy(new Error(`DevTools ${pathname} timed out`)));
    request.once('error', reject);
  });
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const onError = event => reject(new Error(`Could not connect to the packaged app DevTools socket: ${event.message || 'unknown error'}`));
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('open', () => {
      socket.removeEventListener('error', onError);
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || 'DevTools command failed'));
        else waiter.resolve(message.result || {});
      });
      socket.addEventListener('close', () => {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('The packaged app DevTools socket closed.'));
        }
        pending.clear();
      });
      resolve({
        send(method, params = {}) {
          const id = ++nextId;
          return new Promise((resolveCommand, rejectCommand) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`DevTools ${method} timed out`));
            }, 5000);
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { socket.close(); } catch {} }
      });
    });
  });
}

async function waitFor(label, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : ''}`);
}

function evaluate(cdp, expression) {
  return cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }).then(reply => {
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text || 'Packaged app JavaScript evaluation failed');
    return reply.result?.value;
  });
}

async function main() {
  const port = await freeLoopbackPort();
  let child;
  let cdp;
  let exitState;
  let output = '';
  let resolveExit;
  const exitPromise = new Promise(resolve => { resolveExit = resolve; });
  const ensureRunning = () => {
    if (exitState) throw new Error(exitState.error?.message || `Packaged app exited ${exitState.code ?? exitState.signal}.${output ? ` ${output}` : ''}`);
  };

  try {
    child = spawn(exe, [
      `--user-data-dir=${profileRoot}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--disable-background-networking',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check'
    ], {
      cwd: path.dirname(exe),
      windowsHide: true,
      env: {
        ...process.env,
        APPDATA: appDataRoot,
        LOCALAPPDATA: localAppDataRoot,
        TEMP: tempFilesRoot,
        TMP: tempFilesRoot
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-6000); });
    }
    child.once('error', error => {
      exitState = { error };
      resolveExit(exitState);
    });
    child.once('exit', (code, signal) => {
      exitState = { code, signal };
      resolveExit(exitState);
    });

    const version = await waitFor('packaged executable DevTools endpoint', () => {
      ensureRunning();
      return requestJson(port, '/json/version');
    });
    assert.match(version.Browser || '', /^Chrome\//, JSON.stringify(version));
    const targets = await waitFor('packaged application page target', async () => {
      ensureRunning();
      const pages = await requestJson(port, '/json/list');
      return pages.find(target => target.type === 'page' && target.url.includes('index.html')) || null;
    });
    assert.ok(targets.webSocketDebuggerUrl, JSON.stringify(targets));
    cdp = await connectCdp(targets.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    const shell = await waitFor('packaged LilacAnime home and preload bridge', async () => {
      ensureRunning();
      const state = await evaluate(cdp, `(() => ({
        title: document.title,
        ready: document.readyState,
        url: location.href,
        home: !!document.querySelector('#homeView'),
        homeActive: !!document.querySelector('#homeView.view.active'),
        searchInput: !!document.querySelector('#pageSearch'),
        searchButton: !!document.querySelector('#searchButton'),
        bridge: typeof window.lilac
      }))()`);
      return state?.ready !== 'loading' && state?.home && state?.searchInput && state?.bridge === 'object' ? state : null;
    });
    assert.equal(shell.title, 'LilacAnime', JSON.stringify(shell));
    assert.equal(shell.homeActive, true, JSON.stringify(shell));
    assert.equal(shell.searchButton, true, JSON.stringify(shell));
    assert.match(shell.url, /app\.asar.*index\.html/i, JSON.stringify(shell));

    const appInfo = await evaluate(cdp, 'window.lilac.appDiagnosticInfo()');
    assert.equal(appInfo.platform, 'win32', JSON.stringify(appInfo));
    assert.equal(appInfo.version, expectedVersion, JSON.stringify(appInfo));
    assert.equal(appInfo.arch, 'x64', JSON.stringify(appInfo));
    assert.ok(fs.existsSync(path.join(profileRoot, 'DevToolsActivePort')), 'remote debugging used the isolated temporary Chromium profile');

    const resumeBoundary = await evaluate(cdp, `(() => {
      const episode = { provider: 'reanime', number: 3, name: '3' };
      const primary = document.createElement('button'), alternate = document.createElement('button');
      let selected = null;
      bindResumeActions(primary, alternate, { episode, progress: 95 }, (pickedEpisode, options) => {
        selected = { number: pickedEpisode.number, options };
      });
      const primaryLabel = primary.textContent, alternateLabel = alternate.textContent;
      const alternateVisible = !alternate.classList.contains('hidden');
      alternate.click();
      return {
        primaryLabel,
        alternateLabel,
        alternateVisible,
        selected,
        belowBoundary: resumePosition(94.99),
        defaultAtBoundary: resumePosition(95),
        explicitContinueAtBoundary: resumePosition(95, 'continue')
      };
    })()`);
    assert.match(resumeBoundary.primaryLabel, /3화 처음부터/, JSON.stringify(resumeBoundary));
    assert.match(resumeBoundary.alternateLabel, /3화 이어보기/, JSON.stringify(resumeBoundary));
    assert.equal(resumeBoundary.alternateVisible, true, JSON.stringify(resumeBoundary));
    assert.deepEqual(resumeBoundary.selected, { number: 3, options: { resumeMode: 'continue', resumeProgress: 95 } });
    assert.equal(resumeBoundary.belowBoundary, 94.99, JSON.stringify(resumeBoundary));
    assert.equal(resumeBoundary.defaultAtBoundary, 0, JSON.stringify(resumeBoundary));
    assert.equal(resumeBoundary.explicitContinueAtBoundary, 95, JSON.stringify(resumeBoundary));

    const episodeEnd = await evaluate(cdp, `(() => {
      const previousSibling = window.siblingEpisode, previousPlay = window.playSiblingEpisode;
      const previousHistory = state.history, previousHistoryKey = currentHistoryKey;
      const completedRecord = { key: 'phase1-packaged-end-test', progress: 32, updated: 1 };
      let automaticPlayCalls = 0;
      try {
        state.history = [completedRecord];
        currentHistoryKey = completedRecord.key;
        window.siblingEpisode = () => ({ provider: 'reanime', number: 4, name: '4' });
        window.playSiblingEpisode = () => { automaticPlayCalls++; };
        handleEpisodeEnded();
        return {
          message: document.querySelector('#downloadStatus')?.textContent || '',
          automaticPlayCalls,
          completedProgress: state.history.find(item => item.key === completedRecord.key)?.progress
        };
      } finally {
        state.history = previousHistory;
        currentHistoryKey = previousHistoryKey;
        window.siblingEpisode = previousSibling;
        window.playSiblingEpisode = previousPlay;
      }
    })()`);
    assert.equal(episodeEnd.message, '재생이 끝났습니다. 다음 화는 직접 선택해 주세요.', JSON.stringify(episodeEnd));
    assert.equal(episodeEnd.automaticPlayCalls, 0, JSON.stringify(episodeEnd));
    assert.equal(episodeEnd.completedProgress, 100, JSON.stringify(episodeEnd));

    console.log(`Packaged Windows exe startup passed: ${path.basename(exe)} loaded app.asar, home/search UI, preload bridge and app-info IPC (${appInfo.version}, ${appInfo.platform}/${appInfo.arch}); resume boundary, 100 percent completion save and manual next-episode behavior passed; profile and DNS resolution were isolated under ${tempRoot}.`);
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch {}
      cdp.close();
    }
    if (child && !exitState) {
      const closed = await Promise.race([exitPromise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 8000))]);
      if (!closed && child.pid) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
        await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 5000))]);
      }
      if (!exitState) throw new Error(`Could not stop the packaged app process ${child.pid}; preserving its temporary profile. ${output}`);
    }
    if (!child || exitState) cleanupTempRoot();
  }

  if (exitState?.error) throw exitState.error;
  if (exitState?.code !== 0) throw new Error(`Packaged app exited ${exitState?.code ?? exitState?.signal}.${output ? `\n${output}` : ''}`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
