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
const reportName = process.env.LILAC_ISSUE4_DIAGNOSTIC === '1' ? 'issue-4-manager-launch-diagnostic.json' : 'issue-4-provider-ipc-live-redacted.json';
const reportPath = path.join(repo, 'docs', 'verification', reportName);
const tempParent = fs.realpathSync(os.tmpdir());
const runRoot = path.join(tempParent, `dino-lilac-issue4-ipc-${randomUUID()}`);
fs.mkdirSync(runRoot, { recursive: false });
let managedTarget;
let child;

async function probe() {
  const progress = (provider, stage, extra = {}) => ipcRenderer.send('issue4:provider-ipc-progress', { provider, stage, ...extra });
  const sourceArray = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.results) ? value.results : [];
  const safeFailure = error => {
    const status = Number(error?.status || error?.statusCode || error?.response?.status) || null;
    const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : 'Error';
    return { status: 'error', errorName: name, httpStatus: status };
  };
  const withTimeout = (promise, timeoutMs) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  const output = [];
  const timeoutMs = 25000;
  const providers = ['reanime', 'miruro', 'animenosub', 'ohli24'];
  let stopAfterTimeout = false;
  for (const provider of providers) {
    const row = { provider, searchCalls: 1, detailCalls: 0, episodesIpcCalls: 0, episodeListRoute: 'provider:detail.episodes' };
    output.push(row);
    progress(provider, 'search-started');
    let results;
    try {
      const response = await withTimeout(window.lilac.providerCatalog(provider, 'Naruto', 0, ''), timeoutMs);
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
      const detail = await withTimeout(window.lilac.providerDetail(results[0]), timeoutMs);
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
  if (stopAfterTimeout) {
    Object.assign(linkkf, { searchCalls: 0, search: 'not-run-after-timeout', detail: 'not-run-after-timeout', episodes: 'not-run-after-timeout' });
  } else {
  progress('linkkf', 'search-started');
  let linkkfResults;
  try {
    const response = await withTimeout(window.lilac.linkkfSearch('Naruto'), timeoutMs);
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
      const detail = await withTimeout(window.lilac.linkkfDetail(item.id), timeoutMs);
      linkkf.detail = detail?.data ? 'ok' : 'empty';
      detailOk = Boolean(detail?.data);
      progress('linkkf', `detail-${linkkf.detail}`);
    } catch (error) { const failure = safeFailure(error); linkkf.detail = 'error'; linkkf.error = failure; progress('linkkf', 'detail-error', { errorName: failure.errorName, httpStatus: failure.httpStatus }); }
    if (detailOk) {
      linkkf.episodesIpcCalls = 1;
      progress('linkkf', 'episodes-started');
      try {
        const episodes = await withTimeout(window.lilac.linkkfEpisodes(item.id), timeoutMs);
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
    scope: { query: 'Naruto', callsPerProvider: 'one search IPC; one detail IPC when search returns a result; first four providers return episodes inside detail, Linkkf has one separate episode-list IPC', streamResolution: false, retriesAddedByProbe: false },
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
  const mainFile = path.join(appRoot, 'electron', 'main.cjs');
  const mainOriginal = fs.readFileSync(mainFile, 'utf8');
  const loadAnchor = "win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));";
  const reportAnchor = 'app.whenReady().then(async () => {';
  if (!mainOriginal.includes(loadAnchor) || !mainOriginal.includes(reportAnchor)) throw new Error('Pinned source main-process test anchors changed; refusing instrumentation.');
  const bootstrap = [
    "const __issue4Electron = require('electron');",
    "const __issue4Path = require('node:path');",
    "const __issue4Module = require('node:module');",
    "__issue4Module.globalPaths.unshift(process.env.DINO_LILAC_TEST_NODE_MODULES);",
    "module.paths.unshift(process.env.DINO_LILAC_TEST_NODE_MODULES);",
    "const __issue4Profile = process.env.DINO_LILAC_ISOLATED_PROFILE;",
    "for (const __key of ['userData','sessionData','cache','downloads','videos','logs','temp','crashDumps']) __issue4Electron.app.setPath(__key, __issue4Path.join(__issue4Profile,__key));",
    "__issue4Electron.app.setName('LilacAnimeIssue4IPCProbe');",
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
  const script = `\nwindow.addEventListener('DOMContentLoaded', () => {\n  if (${diagnostic}) { ipcRenderer.send('issue4:provider-ipc-report', {schema:1,runAt:new Date().toISOString(),app:{sourceProfile:'official-source-16c9a3d1-v0515',version:'0.5.15',sourceCommit:'16c9a3d1631061a72831e0657434003940daf531'},isolation:{managerCreatedTempCopy:true,freshUserDataSessionCacheDownloadsVideos:true,accountLogin:false},scope:{streamResolution:false,providerCalls:0},providers:[],result:'harness-only-no-provider-calls'}); return; }\n  const run = ${probe.toString()};\n  run().catch(() => ipcRenderer.send('issue4:provider-ipc-report', {schema:1,runAt:new Date().toISOString(),app:{sourceProfile:'official-source-16c9a3d1-v0515',version:'0.5.15',sourceCommit:'16c9a3d1631061a72831e0657434003940daf531'},isolation:{managerCreatedTempCopy:true,freshUserDataSessionCacheDownloadsVideos:true,accountLogin:false},scope:{streamResolution:false,retriesAddedByProbe:false},providers:[],result:'probe-failed'}));\n});\n`;
  fs.writeFileSync(preload, preloadText + script, 'utf8');

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
      DINO_LILAC_IPC_PROGRESS: progressTemp
    }
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childOutput = `${childOutput}${chunk.toString('utf8')}`.slice(-12000); });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  const deadline = Date.now() + (diagnostic ? 45000 : 360000);
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
      result: 'incomplete-timeout-provider-state-unconfirmed'
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(incomplete, null, 2)}\n`, 'utf8');
    throw new Error(`Timed out waiting for the one-pass provider IPC result. ${scrubOutput(childOutput)}`);
  }
  const result = JSON.parse(fs.readFileSync(reportTemp, 'utf8'));
  const exitDeadline = Date.now() + 7000;
  while (!exit && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result.providers.map(({ provider, search, resultCount, detail, episodes, episodeCount }) => ({ provider, search, resultCount: resultCount ?? 0, detail, episodes, episodeCount: episodeCount ?? 0 })))}\n`);
  process.exitCode = result.result === 'all-metadata-routes-reached' ? 0 : 2;
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
