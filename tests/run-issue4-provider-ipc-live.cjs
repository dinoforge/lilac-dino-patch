'use strict';

// One-pass, real-network verification of the official v0.5.15 main-process IPC.
// It runs only a manager-created OS-temp source copy, uses fresh temporary app paths,
// calls catalog/search -> detail -> episode-list once per provider, and never resolves
// or opens a stream. The saved result intentionally contains no titles, URLs, IDs,
// response bodies, account data, cookies, or subtitle contents.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const manager = require('../dino-lilac-patch/manager-core.cjs');
const { assertIsolatedTarget, TARGET_MARKER } = require('../dino-lilac-patch/isolated-target.cjs');
const { copyTree } = require('../patch-manager/staging.cjs');

const repo = path.resolve(__dirname, '..');
const sourceRoot = process.env.DINO_LILAC_V0515_SOURCE;
if (!sourceRoot) throw new Error('Set DINO_LILAC_V0515_SOURCE to the clean pinned official v0.5.15 Git checkout.');
if (process.platform !== 'win32') throw new Error('The isolated official-app IPC run is configured for Windows only.');
const electronExe = process.env.LILAC_ELECTRON_EXE || path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) throw new Error('The repository Electron runtime is not installed.');
const dependencyRoot = process.env.LILAC_NODE_MODULES || path.join(repo, 'node_modules');
if (!fs.existsSync(path.join(dependencyRoot, 'cheerio')) || !fs.existsSync(path.join(dependencyRoot, 'adm-zip'))) throw new Error('Set LILAC_NODE_MODULES to the installed official-source runtime dependencies.');
const issue5DiagnosticMode = process.env.LILAC_ISSUE5_CAUSE_DIAGNOSTICS === '1';
const issue4LaunchDiagnosticMode = process.env.LILAC_ISSUE4_DIAGNOSTIC === '1';
const reportName = issue5DiagnosticMode && issue4LaunchDiagnosticMode ? 'issue-5-manager-launch-diagnostic.json'
  : issue5DiagnosticMode ? 'issue-5-provider-diagnostics.json'
    : issue4LaunchDiagnosticMode ? 'issue-4-manager-launch-diagnostic.json' : 'issue-4-provider-ipc-live-redacted.json';
const reportPath = path.join(repo, 'docs', 'verification', reportName);
const tempParent = fs.realpathSync(os.tmpdir());
const runRoot = path.join(tempParent, `dino-lilac-issue4-ipc-${randomUUID()}`);
fs.mkdirSync(runRoot, { recursive: false });
let managedTarget;
let child;

async function probe() {
  const progress = (provider, stage, extra = {}) => ipcRenderer.send('issue4:provider-ipc-progress', { provider, stage, ...extra });
  const sourceArray = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.results) ? value.results : [];
  // The probe is appended to preload.cjs and therefore runs in Electron's isolated world.
  // contextBridge.exposeInMainWorld('lilac', ...) is only visible in the page's main world;
  // exercise the same IPC channels directly here instead of dereferencing window.lilac.
  const api = {
    providerCatalog: (provider, query = '', offset = 0, sort = '') => ipcRenderer.invoke('provider:catalog', provider, query, offset, sort),
    providerDetail: anime => ipcRenderer.invoke('provider:detail', anime),
    linkkfSearch: query => ipcRenderer.invoke('linkkf:search', query),
    linkkfDetail: id => ipcRenderer.invoke('linkkf:detail', id),
    linkkfEpisodes: id => ipcRenderer.invoke('linkkf:episodes', id)
  };
  const safeFailure = error => {
    const status = Number(error?.status || error?.statusCode || error?.response?.status) || null;
    const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : 'Error';
    const message = String(error?.message || '');
    const missingProperty = message.match(/^Cannot read properties of (?:undefined|null) \(reading '[A-Za-z0-9_$-]{1,40}'\)$/);
    const messageClass = message === 'fetch failed' ? 'fetch-failed'
      : message === 'Failed to fetch' ? 'failed-to-fetch'
        : /^No handler registered/.test(message) ? 'ipc-handler-missing'
          : /^HTTP \d{3}$/.test(message) ? 'http-error'
            : missingProperty ? 'missing-property-access'
              : /^[A-Za-z_$][A-Za-z0-9_$]{0,39} is not a function$/.test(message) ? 'not-a-function'
                : name === 'TypeError' ? 'type-error-unclassified' : 'other-error';
    return { status: 'error', errorName: name, httpStatus: status, ...(issue5DiagnosticMode ? { messageClass } : {}) };
  };
  const withTimeout = (promise, timeoutMs) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  const output = [];
  const timeoutMs = 25000;
  const selectedProvider = issue5DiagnosticMode ? String(process.env.LILAC_ISSUE5_PROVIDER || '') : '';
  const providers = selectedProvider ? (selectedProvider === 'linkkf' ? [] : [selectedProvider]) : ['reanime', 'miruro', 'animenosub', 'ohli24'];
  let stopAfterTimeout = false;
  for (const provider of providers) {
    const row = { provider, searchCalls: 1, detailCalls: 0, episodesIpcCalls: 0, episodeListRoute: 'provider:detail.episodes' };
    output.push(row);
    progress(provider, 'search-started');
    let results;
    try {
      const query = issue5DiagnosticMode && selectedProvider === 'ohli24' && provider === 'ohli24' ? '나루토' : 'Naruto';
      const response = await withTimeout(api.providerCatalog(provider, query, 0, ''), timeoutMs);
      results = sourceArray(response);
      row.search = results.length ? 'ok' : 'empty';
      row.resultCount = results.length;
      progress(provider, `search-${row.search}`, { resultCount: results.length });
    } catch (error) {
      const failure = safeFailure(error);
      Object.assign(row, { search: failure.status, error: failure });
      progress(provider, 'search-error', { errorName: failure.errorName, httpStatus: failure.httpStatus });
      if (failure.errorName === 'TimeoutError') { stopAfterTimeout = true; break; }
      continue;
    }
    if (!results.length) { row.detail = 'not-run-no-result'; row.episodes = 'not-run-no-result'; continue; }
    row.detailCalls = 1;
    progress(provider, 'detail-started');
    try {
      const detail = await withTimeout(api.providerDetail(results[0]), timeoutMs);
      row.detail = 'ok';
      const episodes = Array.isArray(detail?.episodes) ? detail.episodes : [];
      row.episodes = episodes.length ? 'ok' : 'empty';
      row.episodeCount = episodes.length;
      progress(provider, `detail-${row.detail}`, { episodeCount: episodes.length });
    } catch (error) {
      const failure = safeFailure(error);
      row.detail = 'error'; row.episodes = 'not-run-detail-failed'; row.error = failure;
      progress(provider, 'detail-error', { errorName: failure.errorName, httpStatus: failure.httpStatus });
      if (failure.errorName === 'TimeoutError') { stopAfterTimeout = true; break; }
    }
  }

  if (stopAfterTimeout) {
    for (const provider of providers.slice(output.length)) output.push({ provider, searchCalls: 0, detailCalls: 0, episodesIpcCalls: 0, search: 'not-run-after-timeout', detail: 'not-run-after-timeout', episodes: 'not-run-after-timeout' });
  }

  const linkkf = { provider: 'linkkf', searchCalls: 1, detailCalls: 0, episodesIpcCalls: 0, episodeListRoute: 'linkkf:episodes' };
  output.push(linkkf);
  if (selectedProvider && selectedProvider !== 'linkkf') {
    Object.assign(linkkf, { searchCalls: 0, search: 'not-run-selected-provider', detail: 'not-run-selected-provider', episodes: 'not-run-selected-provider' });
  } else if (stopAfterTimeout) {
    Object.assign(linkkf, { searchCalls: 0, search: 'not-run-after-timeout', detail: 'not-run-after-timeout', episodes: 'not-run-after-timeout' });
  } else {
  progress('linkkf', 'search-started');
  let linkkfResults;
  try {
    const response = await withTimeout(api.linkkfSearch('Naruto'), timeoutMs);
    linkkfResults = sourceArray(response);
    linkkf.search = linkkfResults.length ? 'ok' : 'empty';
    linkkf.resultCount = linkkfResults.length;
    progress('linkkf', `search-${linkkf.search}`, { resultCount: linkkfResults.length });
  } catch (error) { const failure = safeFailure(error); linkkf.search = 'error'; linkkf.error = failure; progress('linkkf', 'search-error', { errorName: failure.errorName, httpStatus: failure.httpStatus }); }
  if (linkkfResults?.length) {
    const item = linkkfResults[0];
    linkkf.detailCalls = 1;
    progress('linkkf', 'detail-started');
    let detailOk = false;
    try {
      const detail = await withTimeout(api.linkkfDetail(item.id), timeoutMs);
      linkkf.detail = detail?.data ? 'ok' : 'empty';
      detailOk = Boolean(detail?.data);
      progress('linkkf', `detail-${linkkf.detail}`);
    } catch (error) { const failure = safeFailure(error); linkkf.detail = 'error'; linkkf.error = failure; progress('linkkf', 'detail-error', { errorName: failure.errorName, httpStatus: failure.httpStatus }); }
    if (detailOk) {
      linkkf.episodesIpcCalls = 1;
      progress('linkkf', 'episodes-started');
      try {
        const episodes = await withTimeout(api.linkkfEpisodes(item.id), timeoutMs);
        const count = Array.isArray(episodes) ? episodes.reduce((sum, server) => sum + (Array.isArray(server?.episodes) ? server.episodes.length : 0), 0) : 0;
        linkkf.episodes = count ? 'ok' : 'empty';
        linkkf.episodeCount = count;
        progress('linkkf', `episodes-${linkkf.episodes}`, { episodeCount: count });
      } catch (error) { const failure = safeFailure(error); linkkf.episodes = 'error'; linkkf.error = failure; progress('linkkf', 'episodes-error', { errorName: failure.errorName, httpStatus: failure.httpStatus }); }
    } else linkkf.episodes = 'not-run-detail-failed';
  } else linkkf.detail = linkkf.episodes = 'not-run-no-result';
  }

  const summary = {
    schema: 1,
    runAt: new Date().toISOString(),
    app: { sourceProfile: 'official-source-16c9a3d1-v0515', version: '0.5.15', sourceCommit: '16c9a3d1631061a72831e0657434003940daf531' },
    isolation: { managerCreatedTempCopy: true, freshUserDataSessionCacheDownloadsVideos: true, accountLogin: false },
    scope: { ...(issue5DiagnosticMode ? {} : { query: 'Naruto' }), callsPerProvider: 'one search IPC; one detail IPC when search returns a result; first four providers return episodes inside detail, Linkkf has one separate episode-list IPC', streamResolution: false, retriesAddedByProbe: false, ...(issue5DiagnosticMode ? { linkkfNetworkRequestCap: 12 } : {}) },
    providers: output,
    result: output.every(row => row.search === 'ok' && row.detail === 'ok' && row.episodes === 'ok') ? 'all-metadata-routes-reached' : 'partial-or-blocked'
  };
  ipcRenderer.send('issue4:provider-ipc-report', summary);
}

async function run() {
  managedTarget = manager.createTargetFromSource(sourceRoot);
  const applied = manager.applySettings(managedTarget.root, { patches: { 'patch-01': false, 'patch-02': false, 'patch-03': true } });
  if (!['applied', 'already-applied'].includes(applied.status)) throw new Error(`Patch 03 isolated apply failed: ${applied.status}`);

  const appRoot = path.join(runRoot, 'app');
  copyTree(managedTarget.root, appRoot);
  // Reuse the already installed, read-only project dependencies from the execution copy.
  // The manager-created source target itself remains link-free and is never launched directly.
  fs.symlinkSync(dependencyRoot, path.join(appRoot, 'node_modules'), 'junction');
  const profile = path.join(runRoot, 'app-profile');
  for (const name of ['userData', 'sessionData', 'cache', 'downloads', 'videos', 'logs', 'temp', 'crashDumps']) fs.mkdirSync(path.join(profile, name), { recursive: true });
  const reportTemp = path.join(runRoot, 'provider-report.json');
const progressTemp = path.join(runRoot, 'provider-progress.json');
const diagnosticTemp = path.join(runRoot, 'provider-diagnostics.json');
  const mainFile = path.join(appRoot, 'electron', 'main.cjs');
  const mainOriginal = fs.readFileSync(mainFile, 'utf8');
  const loadAnchor = "win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));";
  const reportAnchor = 'app.whenReady().then(async () => {';
  if (!mainOriginal.includes(loadAnchor) || !mainOriginal.includes(reportAnchor)) throw new Error('Pinned source main-process test anchors changed; refusing instrumentation.');
  const diagnosticBootstrap = issue5DiagnosticMode ? String.raw`
const __issue5Fs = require('node:fs');
const __issue5Rows = new Map();
const __issue5Counts = new Map();
const __issue5Failed = new Set();
const __issue5Runtime = { node: process.versions.node || null, electron: process.versions.electron || null, chromium: process.versions.chrome || null, nodeFetch: typeof globalThis.fetch === 'function', electronNetFetch: typeof __issue4Electron.net.fetch === 'function', proxyEnvironmentPresent: { http: Boolean(process.env.HTTP_PROXY || process.env.http_proxy), https: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy), all: Boolean(process.env.ALL_PROXY || process.env.all_proxy), noProxy: Boolean(process.env.NO_PROXY || process.env.no_proxy), nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY === '1', extraCa: Boolean(process.env.NODE_EXTRA_CA_CERTS) } };
const __issue5Trace = (stage, details = {}) => {
  try { __issue5Fs.appendFileSync(process.env.DINO_LILAC_IPC_TRACE, JSON.stringify({ at: new Date().toISOString(), stage, ...details }) + '\n'); } catch {}
};
__issue5Trace('main-start', { appReady: __issue4Electron.app.isReady() });
__issue4Electron.app.on('ready', () => __issue5Trace('app-ready'));
__issue4Electron.app.on('browser-window-created', (_event, win) => {
  __issue5Trace('window-created');
  win.webContents.on('did-start-loading', () => __issue5Trace('load-started'));
  win.webContents.on('dom-ready', () => __issue5Trace('dom-ready'));
  win.webContents.on('did-finish-load', () => __issue5Trace('load-finished'));
  win.webContents.on('did-fail-load', (_event, code, description) => __issue5Trace('load-failed', { code: Number(code) || null, description: String(description || '').slice(0, 100) }));
  win.webContents.on('render-process-gone', (_event, info) => __issue5Trace('renderer-gone', { reason: String(info && info.reason || '').slice(0, 40) }));
});
setInterval(() => __issue5Trace('app-state', { appReady: __issue4Electron.app.isReady(), windows: __issue4Electron.BrowserWindow.getAllWindows().length }), 5000).unref();
const __issue5Code = error => {
  for (const value of [error && error.code, error && error.cause && error.cause.code, error && error.cause && error.cause.cause && error.cause.cause.code]) {
    if (typeof value === 'string' && /^(?:ERR|UND_ERR)_[A-Z0-9_]+$|^E(?:AI_AGAIN|NOTFOUND|CERT_[A-Z0-9_]+|CONN[A-Z0-9_]*|HOSTUNREACH|NETUNREACH|TIMEDOUT)$/.test(value)) return value;
  }
  const message = String(error && error.message || '');
  return message.match(/(?:net::)?((?:ERR|UND_ERR)_[A-Z0-9_]+|E(?:AI_AGAIN|NOTFOUND|CERT_[A-Z0-9_]+|CONN[A-Z0-9_]*|HOSTUNREACH|NETUNREACH|TIMEDOUT))/)?.[1] || null;
};
const __issue5Name = error => typeof (error && error.name) === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : 'Error';
const __issue5MessageClass = error => {
  const message = String(error && error.message || '');
  if (message === 'fetch failed') return 'fetch-failed';
  if (message === 'Failed to fetch') return 'failed-to-fetch';
  if (/^No handler registered/.test(message)) return 'ipc-handler-missing';
  if (/^HTTP \d{3}$/.test(message)) return 'http-error';
  if (/^Cannot read properties of (?:undefined|null) \(reading '[A-Za-z0-9_$-]{1,40}'\)$/.test(message)) return 'missing-property-access';
  if (/^[A-Za-z_$][A-Za-z0-9_$]{0,39} is not a function$/.test(message)) return 'not-a-function';
  return __issue5Name(error) === 'TypeError' ? 'type-error-unclassified' : 'other-error';
};
const __issue5Frames = error => String(error && error.stack || '').split(/\r?\n/).slice(1, 6).map(line => {
  const match = line.match(/^\s*at\s+(.*?)\s+\((?:.*[\\/])?([^\\/():]+):(\d+):(\d+)\)$/);
  return match ? match[1] + ' (' + match[2] + ':' + match[3] + ':' + match[4] + ')' : line.trim().replace(/https?:\/\/\S+/g, '<url>').slice(0, 120);
});
const __issue5Phase = (error, status) => {
  if (Number.isInteger(status)) return 'http';
  const code = __issue5Code(error) || '';
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_DNS/.test(code)) return 'dns';
  if (/CERT|TLS|SSL/.test(code)) return 'tls';
  if (/CONN|TIMEDOUT|HOSTUNREACH|NETUNREACH|UND_ERR_CONNECT|ERR_TUNNEL|ERR_CONNECTION/.test(code)) return 'connect';
  if (__issue5Name(error) === 'SyntaxError') return 'parse';
  return 'unknown';
};
const __issue5Record = row => {
  const key = [row.provider, row.transport, row.phase, row.errorName || '', row.causeCode || '', row.httpStatus || '', row.outcome || '', row.messageClass || '', ...(row.stackFrames || [])].join('|');
  const current = __issue5Rows.get(key) || { ...row, count: 0 };
  current.count++;
  __issue5Rows.set(key, current);
  try { __issue5Fs.writeFileSync(process.env.DINO_LILAC_IPC_DIAGNOSTICS, JSON.stringify({ runtime: __issue5Runtime, requests: [...__issue5Rows.values()] }, null, 2) + '\n'); } catch {}
};
try { __issue5Fs.writeFileSync(process.env.DINO_LILAC_IPC_DIAGNOSTICS, JSON.stringify({ runtime: __issue5Runtime, requests: [] }, null, 2) + '\n'); } catch {}
const __issue5ProviderFor = input => {
  let host = '';
  try { host = new URL(typeof input === 'string' ? input : input && input.url || String(input)).hostname.toLowerCase(); } catch { return null; }
  if (host === 'reanime.to' || host.endsWith('.reanime.to')) return 'reanime';
  if (host === 'miruro.to' || host.endsWith('.miruro.to')) return 'miruro';
  if (host === 'animenosub.to' || host.endsWith('.animenosub.to')) return 'animenosub';
  if (host === 'ohli24.net' || host.endsWith('.ohli24.net') || host === 'ani.ohli24.com' || host.endsWith('.ohli24.com')) return 'ohli24';
  if (host.endsWith('.5imgdarr.top') || host === 'linkkf.app' || host.endsWith('.linkkf.app')) return 'linkkf';
  return null;
};
const __issue5WrapFetch = (target, key, transport) => {
  const original = target[key].bind(target);
  target[key] = async (...args) => {
    const provider = __issue5ProviderFor(args[0]);
    if (provider === 'linkkf') {
      const count = __issue5Counts.get(provider) || 0;
      if (__issue5Failed.has(provider) || count >= 12) throw Object.assign(new Error('issue5 diagnostic request cap'), { code: 'ISSUE5_DIAGNOSTIC_CAP' });
      __issue5Counts.set(provider, count + 1);
    }
    try {
      const response = await original(...args);
      if (provider) __issue5Record({ provider, transport, phase: 'http', errorName: null, causeCode: null, httpStatus: Number(response.status) || null, outcome: response.ok ? 'success' : 'rejected' });
      return response;
    } catch (error) {
      if (provider === 'linkkf' && __issue5Code(error) !== 'ISSUE5_DIAGNOSTIC_CAP') __issue5Failed.add(provider);
      if (provider && __issue5Code(error) !== 'ISSUE5_DIAGNOSTIC_CAP') __issue5Record({ provider, transport, phase: __issue5Phase(error), errorName: __issue5Name(error), causeCode: __issue5Code(error), causeName: __issue5Name(error && error.cause), causeCodeNested: error && error.cause && typeof error.cause.code === 'string' ? error.cause.code : null, messageClass: __issue5MessageClass(error), stackFrames: __issue5Frames(error), httpStatus: null, outcome: 'error' });
      throw error;
    }
  };
};
__issue5WrapFetch(globalThis, 'fetch', 'node-fetch');
try { __issue5WrapFetch(__issue4Electron.net, 'fetch', 'electron-net-fetch'); } catch { __issue5Record({ provider: 'ohli24', transport: 'electron-net-fetch', phase: 'hook', errorName: 'HookError', causeCode: null, httpStatus: null, outcome: 'unavailable' }); }
const __issue5OriginalHandle = __issue4Electron.ipcMain.handle.bind(__issue4Electron.ipcMain);
__issue4Electron.ipcMain.handle = (channel, handler) => __issue5OriginalHandle(channel, async (event, ...args) => {
  const provider = channel === 'provider:catalog' ? String(args[0] || '') : channel === 'linkkf:search' ? 'linkkf' : channel === 'provider:detail' ? String(args[0] && args[0].provider || '') : '';
  if (['reanime','miruro','animenosub','ohli24','linkkf'].includes(provider)) __issue5Record({ provider, transport: 'ipc', phase: 'handler-start', errorName: null, causeCode: null, httpStatus: null, outcome: 'started' });
  try { return await handler(event, ...args); }
  catch (error) {
    if (['reanime','miruro','animenosub','ohli24','linkkf'].includes(provider)) __issue5Record({ provider, transport: 'ipc', phase: __issue5Phase(error), errorName: __issue5Name(error), causeCode: __issue5Code(error), httpStatus: Number(String(error && error.message || '').match(/(?:HTTP|실패|요청 실패)\D*(\d{3})/)?.[1]) || null, messageClass: __issue5MessageClass(error), stackFrames: __issue5Frames(error), outcome: 'error' });
    throw error;
  }
});
` : '';
  const bootstrap = [
    "const __issue4Electron = require('electron');",
    "const __issue4Path = require('node:path');",
    "const __issue4Module = require('node:module');",
    "__issue4Module.globalPaths.unshift(process.env.DINO_LILAC_TEST_NODE_MODULES);",
    "module.paths.unshift(process.env.DINO_LILAC_TEST_NODE_MODULES);",
    "const __issue4Profile = process.env.DINO_LILAC_ISOLATED_PROFILE;",
    "for (const __key of ['userData','sessionData','cache','downloads','videos','logs','temp','crashDumps']) __issue4Electron.app.setPath(__key, __issue4Path.join(__issue4Profile,__key));",
    "__issue4Electron.app.setName('LilacAnimeIssue4IPCProbe');",
    diagnosticBootstrap,
    ''
  ].join('\n');
  const reporter = "ipcMain.on('issue4:provider-ipc-progress', (_event, progress) => { try { const file=process.env.DINO_LILAC_IPC_PROGRESS; const current=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[]; current.push(progress); fs.writeFileSync(file,JSON.stringify(current,null,2)); } catch {} });\nipcMain.on('issue4:provider-ipc-report', (_event, summary) => { try { fs.writeFileSync(process.env.DINO_LILAC_IPC_REPORT, JSON.stringify(summary, null, 2) + '\\n', { flag: 'wx' }); } finally { setTimeout(() => app.exit(0), 50); } });\n";
  const instrumentedMain = bootstrap + mainOriginal.replace('const win = new BrowserWindow({', 'const win = new BrowserWindow({ show: false,')
    .replace(loadAnchor, "win.loadFile(path.join(__dirname, '..', 'src', 'issue4-provider-ipc-probe.html'));")
    .replace(reportAnchor, reporter + reportAnchor);
  fs.writeFileSync(mainFile, instrumentedMain, 'utf8');
  const src = path.join(appRoot, 'src');
  fs.writeFileSync(path.join(src, 'issue4-provider-ipc-probe.html'), "<!doctype html><html><head><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'self'\"></head><body></body></html>\n", 'utf8');
  // The app's existing isolated preload is the only bridge. Append a one-shot test invocation there.
  const preload = path.join(appRoot, 'electron', 'preload.cjs');
  const preloadText = fs.readFileSync(preload, 'utf8');
  if (!preloadText.includes("contextBridge.exposeInMainWorld('lilac'")) throw new Error('Expected official v0.5.15 Lilac preload bridge was not found.');
  const diagnostic = process.env.LILAC_ISSUE4_DIAGNOSTIC === '1';
  const script = `\nwindow.addEventListener('DOMContentLoaded', () => {\n  if (${diagnostic}) { ipcRenderer.send('issue4:provider-ipc-report', {schema:1,runAt:new Date().toISOString(),app:{sourceProfile:'official-source-16c9a3d1-v0515',version:'0.5.15',sourceCommit:'16c9a3d1631061a72831e0657434003940daf531'},isolation:{managerCreatedIsolatedCopy:true,freshUserDataSessionCacheDownloadsVideos:true,accountLogin:false},scope:{streamResolution:false,providerCalls:0},providers:[],result:'harness-only-no-provider-calls'}); return; }\n  const run = ${probe.toString()};\n  run().catch(error => { const rawName=String(error&&error.name||'Error');const name=/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(rawName)?rawName:'Error';const codes=[error&&error.code,error&&error.cause&&error.cause.code].filter(value=>typeof value==='string'&&/^(?:ERR|UND_ERR)_[A-Z0-9_]+$|^E(?:AI_AGAIN|CERT_[A-Z0-9_]+|CONN[A-Z0-9_]*|HOSTUNREACH|NETUNREACH|TIMEDOUT)$/.test(value));const message=String(error&&error.message||'').replace(/https?:\/\/[^\s"'<>]+/gi,'<url>').replace(/[A-Z]:\\[^\s"'<>]+/gi,'<path>').replace(/\bNaruto\b/gi,'<query>').replace(/\b(cookie|token|password|authorization)\b[\s:=]+\S+/gi,'$1=<redacted>').slice(0,160);const missingMatch=message.match(/^([A-Za-z_$][A-Za-z0-9_$]*) is not defined$/);const missingGlobal=['ipcRenderer','window','AbortSignal','URL','setTimeout','clearTimeout','Promise'].includes(missingMatch&&missingMatch[1])?missingMatch[1]:null;ipcRenderer.send('issue4:provider-ipc-report', {schema:1,runAt:new Date().toISOString(),app:{sourceProfile:'official-source-16c9a3d1-v0515',version:'0.5.15',sourceCommit:'16c9a3d1631061a72831e0657434003940daf531'},isolation:{managerCreatedIsolatedCopy:true,freshUserDataSessionCacheDownloadsVideos:true,accountLogin:false},scope:{streamResolution:false,retriesAddedByProbe:false},providers:[],probeFailure:{errorName:name,causeCode:codes[0]||null,missingGlobal,safeMessage:message},result:'probe-failed'}); });\n});\n`;
  const scriptWithMode = script.replace('  const run = ', `  const issue5DiagnosticMode = ${issue5DiagnosticMode};\n  const run = `);
  const failureStart = scriptWithMode.indexOf('  run().catch(error => {');
  const failureEnd = scriptWithMode.indexOf('\n});\n', failureStart);
  if (failureStart < 0 || failureEnd < 0) throw new Error('The isolated provider probe failure handler could not be located.');
  const safeFailureHandler = "  run().catch(error => { const rawName=String(error&&error.name||'Error');const errorName=/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(rawName)?rawName:'Error';const rawCode=String(error&&error.code||error&&error.cause&&error.cause.code||'');const causeCode=/^(ERR|UND_ERR)_[A-Z0-9_]+$|^E[A-Z0-9_]+$/.test(rawCode)?rawCode:null;const message=String(error&&error.message||'');const missing=message.match(/^([A-Za-z_$][A-Za-z0-9_$]{0,39}) is not defined$/);ipcRenderer.send('issue4:provider-ipc-report',{schema:1,runAt:new Date().toISOString(),app:{sourceProfile:'official-source-16c9a3d1-v0515',version:'0.5.15',sourceCommit:'16c9a3d1631061a72831e0657434003940daf531'},isolation:{managerCreatedIsolatedCopy:true,freshUserDataSessionCacheDownloadsVideos:true,accountLogin:false},scope:{streamResolution:false,retriesAddedByProbe:false},providers:[],probeFailure:{errorName,causeCode,missingGlobal:missing?missing[1]:null},result:'probe-failed'}); });";
  const safeScript = scriptWithMode.slice(0, failureStart) + safeFailureHandler + scriptWithMode.slice(failureEnd);
  const instrumentedScript = issue5DiagnosticMode ? safeScript.replace("window.addEventListener('DOMContentLoaded', () => {", "window.addEventListener('DOMContentLoaded', () => { ipcRenderer.send('issue4:provider-ipc-progress', { provider: 'harness', stage: 'dom-ready' });") : safeScript;
  fs.writeFileSync(preload, preloadText + instrumentedScript, 'utf8');

  let childOutput = '';
  const scrubOutput = value => String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/[A-Z]:\\[^\s"'<>]+/gi, '<path>')
    .slice(-2400);
  child = spawn(electronExe, [appRoot], {
    cwd: appRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_PATH: [dependencyRoot, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter),
      LILAC_SMOKE_REANIME: '',
      DINO_LILAC_ISOLATED_PROFILE: profile,
      DINO_LILAC_TEST_NODE_MODULES: dependencyRoot,
      DINO_LILAC_IPC_REPORT: reportTemp,
      DINO_LILAC_IPC_PROGRESS: progressTemp,
      DINO_LILAC_IPC_DIAGNOSTICS: diagnosticTemp,
      DINO_LILAC_IPC_TRACE: path.join(runRoot, 'provider-trace.jsonl')
    }
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childOutput = `${childOutput}${chunk.toString('utf8')}`.slice(-12000); });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  const deadline = Date.now() + (issue5DiagnosticMode ? 75000 : diagnostic ? 45000 : 360000);
  let progressCount = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(reportTemp)) break;
    if (exit) throw new Error(`Isolated LilacAnime exited before reporting (code=${exit.code}, signal=${exit.signal}) ${scrubOutput(childOutput)}`);
    if (/App threw an error during load|Cannot find module/i.test(childOutput)) {
      try { child.kill(); } catch {}
      throw new Error(`Isolated LilacAnime failed to load before provider IPC. ${scrubOutput(childOutput)}`);
    }
    if (fs.existsSync(progressTemp)) {
      const progress = JSON.parse(fs.readFileSync(progressTemp, 'utf8'));
      for (const row of progress.slice(progressCount)) process.stdout.write(`IPC ${row.provider}: ${row.stage}${row.resultCount != null ? ` (${row.resultCount}건)` : ''}${row.httpStatus ? ` HTTP ${row.httpStatus}` : ''}\n`);
      progressCount = progress.length;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (!fs.existsSync(reportTemp)) {
    try { child.kill(); } catch {}
    const progress = fs.existsSync(progressTemp) ? JSON.parse(fs.readFileSync(progressTemp, 'utf8')) : [];
    const incomplete = {
      schema: 1,
      runAt: new Date().toISOString(),
      app: { sourceProfile: 'official-source-16c9a3d1-v0515', version: '0.5.15', sourceCommit: '16c9a3d1631061a72831e0657434003940daf531' },
      isolation: { managerCreatedTempCopy: true, freshUserDataSessionCacheDownloadsVideos: true, accountLogin: false },
      scope: { streamResolution: false, retriesAddedByProbe: false },
      progress,
      providers: ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkkf'].map(provider => ({ provider, status: progress.filter(row => row.provider === provider).at(-1)?.stage || 'unconfirmed' })),
      ...(issue5DiagnosticMode ? { harnessTrace: fs.existsSync(path.join(runRoot, 'provider-trace.jsonl')) ? fs.readFileSync(path.join(runRoot, 'provider-trace.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { stage: 'trace-invalid' }; } }) : [] } : {}),
      result: 'incomplete-timeout-provider-state-unconfirmed'
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(incomplete, null, 2)}\n`, 'utf8');
    throw new Error(`Timed out waiting for the one-pass provider IPC result. ${scrubOutput(childOutput)}`);
  }
  const result = JSON.parse(fs.readFileSync(reportTemp, 'utf8'));
  if (issue5DiagnosticMode) result.networkDiagnostics = fs.existsSync(diagnosticTemp) ? JSON.parse(fs.readFileSync(diagnosticTemp, 'utf8')) : { runtime: null, requests: [] };
  const exitDeadline = Date.now() + 7000;
  while (!exit && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result.providers.map(({ provider, search, resultCount, detail, episodes, episodeCount }) => ({ provider, search, resultCount: resultCount ?? 0, detail, episodes, episodeCount: episodeCount ?? 0 })))}\n`);
  const selectedProvider = issue5DiagnosticMode ? process.env.LILAC_ISSUE5_PROVIDER : '';
  const selectedResult = selectedProvider ? result.providers.find(row => row.provider === selectedProvider) : null;
  const selectedProviderSucceeded = Boolean(selectedResult && selectedResult.search === 'ok' &&
    (selectedResult.detailCalls === 0 || selectedResult.detail === 'ok') &&
    (selectedResult.episodesIpcCalls === 0 || selectedResult.episodes === 'ok'));
  process.exitCode = ['all-metadata-routes-reached', 'harness-only-no-provider-calls'].includes(result.result) || selectedProviderSucceeded ? 0 : 2;
}

run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }).finally(() => {
  if (child && !child.killed) { try { child.kill(); } catch {} }
  try {
    if (managedTarget?.root) {
      const root = assertIsolatedTarget(managedTarget.root);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(`${root}${TARGET_MARKER}`, { force: true });
      fs.rmSync(`${root}.patch-manager`, { recursive: true, force: true });
    }
  } catch {}
  try {
    const modulesLink = path.join(runRoot, 'app', 'node_modules');
    if (fs.existsSync(modulesLink) && fs.lstatSync(modulesLink).isSymbolicLink()) fs.unlinkSync(modulesLink);
    const current = fs.realpathSync(runRoot), rel = path.relative(tempParent, current);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && path.basename(current).startsWith('dino-lilac-issue4-ipc-')) fs.rmSync(current, { recursive: true, force: true });
  } catch {}
});
