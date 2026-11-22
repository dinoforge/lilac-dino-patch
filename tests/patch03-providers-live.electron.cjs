// Focused live provider-detail smoke. Reports omit provider URLs and profile data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const configuredTempRoot = process.env.PATCH03_LIVE_ROOT ? path.resolve(process.env.PATCH03_LIVE_ROOT) : '';
const tempRoot = configuredTempRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'dino-patch03-live-'));
const progressPath = path.join(tempRoot, 'progress.jsonl');
function recordStage(stage, details = {}) {
  const record = { at: new Date().toISOString(), stage, pid: process.pid,
    electronVersion: process.versions.electron || null, ...details };
  try { fs.appendFileSync(progressPath, `${JSON.stringify(record)}\n`); } catch {}
  console.log(`PATCH03_STAGE ${JSON.stringify(record)}`);
  return record;
}
function safeRendererUrl(value) {
  const url = String(value || '');
  if (/\/src\/index\.html(?:$|[?#])/.test(url)) return 'file:///official-src/src/index.html';
  return url.replace(/https?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, 'https://$1/[path redacted]');
}
recordStage('electron-script-start', { executable: '<ELECTRON_BINARY>', nodeVersion: process.versions.node, tempRoot: '<OS_TEMP_TEST_ROOT>' });
if (configuredTempRoot) {
  assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()), 'shared test profile must live directly under OS Temp');
  assert.match(path.basename(tempRoot), /^dino-patch03-source-mode-[a-z0-9-]+$/i, 'shared profile must use the dedicated test prefix');
  const stat = fs.lstatSync(tempRoot);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'shared profile root must be a real directory');
}
const paths = Object.fromEntries(['appData', 'userData', 'sessionData', 'localAppData', 'cache', 'temp', 'logs', 'crashDumps']
  .map(name => [name, path.join(tempRoot, name)]));
const reportPaths = Object.fromEntries(Object.entries(paths).map(([name, value]) => [name, path.relative(tempRoot, value)]));
for (const value of Object.values(paths)) fs.mkdirSync(value, { recursive: true });
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']) app.setPath(name, paths[name]);
const pinSwitch = (name, value) => {
  if (path.resolve(app.commandLine.getSwitchValue(name) || '.') !== path.resolve(value)) {
    app.commandLine.removeSwitch(name);
    app.commandLine.appendSwitch(name, value);
  }
};
pinSwitch('user-data-dir', paths.userData);
pinSwitch('disk-cache-dir', paths.cache);
pinSwitch('crash-dumps-dir', paths.crashDumps);
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']) {
  assert.equal(path.resolve(app.getPath(name)), path.resolve(paths[name]));
}
for (const [name, switchName] of [['userData', 'user-data-dir'], ['cache', 'disk-cache-dir'], ['crashDumps', 'crash-dumps-dir']]) {
  assert.equal(path.resolve(app.commandLine.getSwitchValue(switchName)), path.resolve(paths[name]));
}
assert.equal(path.resolve(process.env.LOCALAPPDATA || ''), path.resolve(paths.localAppData));
assert.ok(path.resolve(app.getPath('userData')).startsWith(path.resolve(os.tmpdir())));
assert.ok(path.resolve(app.getPath('sessionData')).startsWith(path.resolve(os.tmpdir())));
recordStage('isolated-paths-verified', { paths: reportPaths });
app.disableHardwareAcceleration();

const consoleErrors = [], windows = [], ipcCalls = [], providerDetailIpcCalls = [], providerCatalogIpcCalls = [], providerResolveIpcCalls = [];
const liveEvidence = { tempRoot: '<OS_TEMP_TEST_ROOT>', paths: reportPaths };
let mainWindow, rendererLoadCount = 0;
let lastStage = 'isolated-paths-verified';
const hardDeadlineMs = Math.max(30000, Number(process.env.PATCH03_HARD_DEADLINE_MS) || 150000);
function setStage(stage, details = {}) { lastStage = stage; return recordStage(stage, details); }
process.on('uncaughtExceptionMonitor', error => setStage('main-uncaught-exception', { message: String(error?.message || error), stack: String(error?.stack || '').split('\n').slice(0, 8).join('\n') }));
process.on('unhandledRejection', reason => setStage('main-unhandled-rejection', { message: String(reason?.message || reason), stack: String(reason?.stack || '').split('\n').slice(0, 8).join('\n') }));
process.on('exit', code => recordStage('main-process-exit', { code, lastStage }));
app.on('child-process-gone', (_event, details) => setStage('child-process-gone', details));
app.on('ready', () => setStage('app-ready', { appPaths: Object.fromEntries(['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps'].map(name => [name, path.relative(tempRoot, app.getPath(name))])) }));
app.on('before-quit', () => setStage('app-before-quit'));
app.on('will-quit', () => setStage('app-will-quit'));
app.on('browser-window-created', (_event, win) => {
  windows.push({ id: win.id, webContentsId: win.webContents.id });
  setStage('browser-window-created', { windowId: win.id, webContentsId: win.webContents.id, rendererPid: win.webContents.getOSProcessId() });
  win.webContents.on('did-start-loading', () => setStage('renderer-load-start', { windowId: win.id, url: safeRendererUrl(win.webContents.getURL()) }));
  win.webContents.on('dom-ready', () => setStage('renderer-dom-ready', { windowId: win.id, url: safeRendererUrl(win.webContents.getURL()) }));
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const rendererUrl = win.webContents.getURL();
      const error = { level, message: String(message).replace(/https?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, 'https://$1/[path redacted]'), line, sourceId,
        rendererUrl: safeRendererUrl(rendererUrl),
        appRenderer: /\/src\/index\.html(?:$|[?#])/.test(rendererUrl) };
      consoleErrors.push(error); setStage('renderer-console-error', { windowId: win.id, ...error });
    }
  });
  win.webContents.on('did-finish-load', () => {
    setStage('renderer-load-finished', { windowId: win.id, url: safeRendererUrl(win.webContents.getURL()) });
    if (/\/src\/index\.html(?:$|[?#])/.test(win.webContents.getURL())) { mainWindow = win; rendererLoadCount++; }
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => setStage('renderer-load-failed', {
    windowId: win.id, errorCode, errorDescription, url: safeRendererUrl(validatedURL), isMainFrame
  }));
  win.webContents.on('render-process-gone', (_event, details) => setStage('renderer-process-gone', { windowId: win.id, details }));
  win.on('unresponsive', () => setStage('browser-window-unresponsive', { windowId: win.id }));
  win.on('responsive', () => setStage('browser-window-responsive', { windowId: win.id }));
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms at ${label}`)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - started);
    if (await withTimeout(Promise.resolve().then(predicate), Math.min(5000, remaining), `${label} predicate`)) return;
    await pause(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function evaluate(code, label) {
  assert.ok(mainWindow && !mainWindow.isDestroyed(), `main window required for ${label}`);
  recordStage('renderer-evaluate-start', { label, windowId: mainWindow.id, webContentsId: mainWindow.webContents.id });
  try {
    const timeout = Math.max(1000, Number(process.env.PATCH03_RENDERER_CALL_TIMEOUT_MS) || 45000);
    const result = await withTimeout(mainWindow.webContents.executeJavaScript(code), timeout, `renderer evaluation ${label}`);
    recordStage('renderer-evaluate-finished', { label, windowId: mainWindow.id });
    return result;
  } catch (error) {
    recordStage('renderer-evaluate-failed', { label, message: String(error?.message || error) });
    throw new Error(`Renderer evaluation failed at ${label}: ${String(error?.message || error)}`);
  }
}
async function captureUiState(name) {
  if (process.env.PATCH03_CAPTURE_PNG !== '1') return;
  assert.ok(/^[a-z0-9-]+$/i.test(name), 'screenshot names must be fixed safe identifiers');
  const captures = path.join(tempRoot, 'captures');
  fs.mkdirSync(captures, { recursive: true });
  const png = (await mainWindow.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(captures, `${name}.png`), png, { flag: 'wx' });
  setStage('screenshot-captured', { name, bytes: png.length });
}

async function run() {
  setStage('main-module-load-start');
  const originalIpcHandle = ipcMain.handle.bind(ipcMain);
  const instrumentedIpcHandle = (channel, listener) => {
    if (channel === 'provider:catalog') return originalIpcHandle(channel, async (event, provider, query = '', ...args) => {
      const call = { provider: String(provider || ''), query: String(query || ''), state: 'pending', startedAt: Date.now() };
      providerCatalogIpcCalls.push(call);
      setStage('provider-catalog-start', { provider: call.provider });
      try {
        const result = await listener(event, provider, query, ...args);
        call.state = 'resolved';
        call.resultCount = Array.isArray(result?.data) ? result.data.length : null;
        setStage('provider-catalog-finished', { provider: call.provider, state: call.state, resultCount: call.resultCount, durationMs: Date.now() - call.startedAt });
        return result;
      } catch (error) {
        call.state = 'failed';
        call.error = String(error?.message || error).split('\n')[0].replace(/https?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, 'https://$1/[path redacted]');
        setStage('provider-catalog-failed', { provider: call.provider, message: call.error, durationMs: Date.now() - call.startedAt });
        throw error;
      } finally { call.durationMs = Date.now() - call.startedAt; }
    });
    if (channel === 'provider:detail') return originalIpcHandle(channel, async (event, anime, ...args) => {
      const call = {
        provider: String(anime?.provider || ''),
        sourceId: String(anime?.mal_id || anime?.id || ''),
        title: String(anime?.title || ''),
        state: 'pending',
        startedAt: Date.now()
      };
      providerDetailIpcCalls.push(call);
      setStage('provider-detail-start', { provider: call.provider, sourceId: call.sourceId });
      try {
        const result = await listener(event, anime, ...args);
        call.state = 'resolved';
        call.episodeCount = Array.isArray(result?.episodes) ? result.episodes.length : null;
        call.unavailable = result?.unavailable === true;
        return result;
      } catch (error) {
        call.state = 'failed';
        call.error = String(error?.message || error).replace(/https?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, 'https://$1/[path redacted]');
        call.stack = String(error?.stack || '').split('\n').slice(0, 8).join('\n')
          .replace(/https?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, 'https://$1/[path redacted]');
        throw error;
      } finally {
        call.durationMs = Date.now() - call.startedAt;
        setStage('provider-detail-finished', { provider: call.provider, state: call.state, episodeCount: call.episodeCount ?? null, durationMs: call.durationMs });
      }
    });
    if (channel === 'provider:resolve') return originalIpcHandle(channel, async (event, episode, ...args) => {
      const rawEpisodeId = episode?.episodeId ?? episode?.episode_id ?? episode?.id ?? null;
      const call = {
        provider: String(episode?.provider || ''),
        sourceAnimeId: episode?.animeId == null ? null : String(episode.animeId),
        episodeId: rawEpisodeId == null ? null : (typeof rawEpisodeId === 'number' || /^[A-Za-z0-9._:-]{1,128}$/.test(String(rawEpisodeId)) ? rawEpisodeId : null),
        episodeNumber: episode?.number ?? null,
        episodeName: String(episode?.name || ''),
        episodeFields: episode && typeof episode === 'object' ? Object.keys(episode).sort() : [],
        state: 'pending',
        startedAt: Date.now()
      };
      providerResolveIpcCalls.push(call);
      setStage('provider-resolve-start', { provider: call.provider, sourceAnimeId: call.sourceAnimeId, episodeId: call.episodeId, episodeNumber: call.episodeNumber });
      try {
        const result = await listener(event, episode, ...args);
        const streamUrl = String(result?.url || '');
        call.state = 'resolved';
        call.hasStreamUrl = Boolean(streamUrl);
        call.urlProtocol = streamUrl ? (() => { try { return new URL(streamUrl).protocol } catch { return 'invalid' } })() : null;
        call.hls = typeof result?.hls === 'boolean' ? result.hls : null;
        call.mimeType = String(result?.mimeType || result?.contentType || '');
        call.format = call.hls === true ? 'HLS' : call.mimeType.toLowerCase() === 'video/mp4' ? 'MP4' : null;
        return result;
      } catch (error) {
        call.state = 'failed';
        call.errorName = String(error?.name || 'Error');
        const message = String(error?.message || error);
        call.httpStatus = Number(message.match(/\b([45]\d\d)\b/)?.[1]) || null;
        call.errorCode = String(error?.code || message.match(/\bERR_[A-Z_]+\b/)?.[0] || '');
        call.errorSummary = message.split('\n')[0]
          .replace(/https?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, 'https://$1/[path redacted]')
          .replace(/([?&](?:token|key|sig|signature|auth|authorization)=)[^&\s]*/gi, '$1[redacted]')
          .slice(0, 240);
        throw error;
      } finally {
        call.durationMs = Date.now() - call.startedAt;
        setStage('provider-resolve-finished', { provider: call.provider, sourceAnimeId: call.sourceAnimeId, episodeId: call.episodeId, episodeNumber: call.episodeNumber, state: call.state, hasStreamUrl: call.hasStreamUrl || false, httpStatus: call.httpStatus || null, durationMs: call.durationMs });
      }
    });
    return originalIpcHandle(channel, async (event, ...args) => {
      const call = { channel: String(channel), state: 'pending', startedAt: Date.now() };
      ipcCalls.push(call);
      setStage('ipc-handler-start', { channel: call.channel });
      try {
        const result = await listener(event, ...args);
        call.state = 'resolved';
        setStage('ipc-handler-finished', { channel: call.channel, state: call.state, durationMs: Date.now() - call.startedAt });
        return result;
      } catch (error) {
        call.state = 'failed';
        call.errorName = String(error?.name || 'Error');
        setStage('ipc-handler-failed', { channel: call.channel, errorName: call.errorName, durationMs: Date.now() - call.startedAt });
        throw error;
      } finally { call.durationMs = Date.now() - call.startedAt; }
    });
  };
  ipcMain.handle = instrumentedIpcHandle;
  assert.equal(ipcMain.handle, instrumentedIpcHandle, 'the live harness must observe provider:detail IPC before starting the app');
  require('../electron/main.cjs');
  setStage('main-module-load-finished');
  await app.whenReady();
  setStage('app-when-ready-resolved');
  await waitFor(() => mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading(), 30000, 'isolated app renderer');
  setStage('renderer-first-load-complete', { windowId: mainWindow.id, webContentsId: mainWindow.webContents.id, rendererPid: mainWindow.webContents.getOSProcessId() });
  await pause(1200);

  let seasonRailLoad = null;
  if (process.env.PATCH03_WAIT_SEASON_RAIL === '1') {
    await waitFor(() => evaluate(`(() => {
      const rail = document.querySelector('#seasonRail');
      const status = document.querySelector('#quarterStatus')?.textContent?.trim() || '';
      const settledStatus = /등록된 작품이 없습니다|불러오지 못했습니다|가져오지 못해|저장해 두었습니다/.test(status);
      return Boolean(rail && !rail.classList.contains('loading-cards')
        && !/불러오는 중|확인하고 있습니다/.test(status)
        && (rail.querySelector('.anime-card') || settledStatus));
    })()`, 'official season rail settled'), 45000, 'official season rail request and render');
    seasonRailLoad = await evaluate(`(() => ({
      cardCount: document.querySelectorAll('#seasonRail .anime-card').length,
      status: document.querySelector('#quarterStatus')?.textContent?.trim() || '',
      loading: document.querySelector('#seasonRail')?.classList.contains('loading-cards') || false,
      selectedProvider: state.source,
      selectedSeason: state.quarterSelection ? { year: state.quarterSelection.year, quarter: state.quarterSelection.quarter } : null
    }))()`, 'official season rail settled snapshot');
    setStage('official-season-rail-settled', seasonRailLoad);
  }

  const sourceModeTest = process.env.PATCH03_SOURCE_MODE_TEST || '';
  async function selectSourceSetting(value, label, predicate) {
    const priorLoadCount = rendererLoadCount;
    const clicked = await evaluate(`(() => {
      switchView('settings'); window.showSettingsPane?.('playback');
      const button = document.querySelector('#sourceChoices button[data-value=${JSON.stringify(value)}]');
      if (!button) return false; button.click(); return true;
    })()`, `${label} setting click`);
    assert.equal(clicked, true, `the original settings must expose ${value}`);
    await waitFor(() => rendererLoadCount > priorLoadCount && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading(),
      20000, `${label} document reload`);
    setStage('settings-reload-complete', { value, rendererLoadCount });
    await pause(120);
    await waitFor(() => evaluate(predicate, `${label} persisted state`), 15000, `${label} persisted state`);
  }
  if (sourceModeTest === 'exercise') {
    await selectSourceSetting('integrated', 'select integrated content source', `window.__dinoPatch03Bridge?.getMode() === 'integrated'
      && localStorage.getItem('lilacDinoPatch.searchMode') === 'integrated'
      && localStorage.getItem('contentSource') !== 'integrated'
      && document.querySelector('#contentSource')?.value === 'integrated'`);
  } else if (sourceModeTest === 'verify') {
    await waitFor(() => evaluate(`window.__dinoPatch03Bridge?.getMode() === 'integrated'
      && localStorage.getItem('lilacDinoPatch.searchMode') === 'integrated'
      && localStorage.getItem('contentSource') !== 'integrated'
      && document.querySelector('#contentSource')?.value === 'integrated'`, 'integrated setting restored on fresh process'), 30000, 'integrated setting restart');
  }

  const startup = await evaluate(`(() => ({
    title: document.title,
    homeVisible: document.querySelector('#homeView')?.classList.contains('active') === true,
    seasonCards: document.querySelectorAll('#seasonRail .anime-card').length,
    seasonRailChildren: document.querySelector('#seasonRail')?.children.length ?? null,
    seasonStatus: document.querySelector('#quarterStatus')?.textContent || '',
    dropCaptionsElement: Boolean(document.querySelector('#dropCaptions')),
    calendarEntry: Boolean(document.querySelector('#seeAllSeason')),
    seasonCalendarRemoved: !document.querySelector('#seasonCalendarView') && typeof window.LilacSeasonCalendar === 'undefined',
    allExplorer: Boolean(document.querySelector('#allView #catalogFilters')),
    contentSourceMode: window.__dinoPatch03Bridge?.getMode() || '',
    contentSourceSetting: document.querySelector('#contentSource')?.value || '',
    savedContentSource: localStorage.getItem('contentSource') || '',
    activeProvider: state.source,
    savedIndividualProvider: localStorage.getItem('contentSourceProvider') || ''
  }))()`, 'startup checks');
  liveEvidence.startup = startup;
  liveEvidence.seasonRailLoad = seasonRailLoad;
  await captureUiState('startup-home');
  if (sourceModeTest === 'verify') {
    assert.equal(startup.contentSourceMode, 'integrated');
    assert.equal(startup.contentSourceSetting, 'integrated');
    const expectedProvider = process.env.PATCH03_EXPECTED_INDIVIDUAL_PROVIDER || 'miruro';
    assert.equal(startup.savedContentSource, expectedProvider, 'integrated mode leaves the official provider setting valid');
    assert.equal(startup.activeProvider, expectedProvider, 'integrated mode keeps the last individual provider for existing home and schedule paths');
    assert.equal(startup.savedIndividualProvider, expectedProvider, 'the individual provider preference stays separate from integrated mode');
  }

  const searches = [];
  if (process.env.PATCH03_SKIP_PROVIDER_SEARCH !== '1') {
    const queries = process.env.PATCH03_LIVE_QUERY
      ? [process.env.PATCH03_LIVE_QUERY]
      : ['葬送のフリーレン', '転生貴族、鑑定スキルで成り上がる 第3期'];
    for (const query of queries) {
      const providerCallOffset = providerCatalogIpcCalls.length;
      const result = await evaluate(`(async () => { await doSearch(${JSON.stringify(query)}); return {
        query: document.querySelector('#pageSearch')?.value || ${JSON.stringify(query)},
        groups: (window.__dinoPatch03Bridge?.getSearchSnapshot?.() || []).map((group, index) => {
          const sources = (group.sourceItems || []).map(item => {
            const anime = typeof window.animeById === 'function' ? window.animeById(item.sourceId) : null;
            return {
              provider: item.provider, id: String(anime?.id ?? anime?.mal_id ?? item.sourceId), sourceId: item.sourceId,
              title: anime?.title || group.title, titleEnglish: anime?.title_english || '', titleJapanese: anime?.title_japanese || '',
              year: anime?.year || '', type: anime?.type || '', anilistId: anime?.anilistId || anime?.anilist_id || null,
              malId: anime?.malId || anime?.mal_id || null, availableEpisodes: anime?.availableEpisodes || null
            };
          });
          return { title: group.title, groupKey: 'bridge-snapshot-' + index, mal_id: sources[0]?.sourceId || '', sources, sourceItems: sources };
        }),
        statuses: [...document.querySelectorAll('#searchProviderFilters button[data-provider]')].map(button => {
          const count = /·\\s*(\\d+)/.exec(button.textContent || '');
          return { provider: button.dataset.provider, state: button.dataset.state || 'ready', resultCount: count ? Number(count[1]) : 0 };
        }),
        cards: [...document.querySelectorAll('#searchGrid .anime-card')].map(card => ({
          sourceId: card.dataset.id || '', title: card.querySelector('h3')?.textContent?.trim() || ''
        })),
      }; })()`, `actual integrated search ${query}`);
      result.providerCalls = providerCatalogIpcCalls.slice(providerCallOffset);
      if (sourceModeTest === 'exercise') {
        const requestedProviders = [...new Set(result.providerCalls.map(call => call.provider))].sort();
        assert.deepEqual(requestedProviders, ['animenosub', 'linkani', 'miruro', 'ohli24', 'reanime'],
          'integrated mode must request the five configured Patch 03 providers only');
        assert.equal(result.providerCalls.some(call => call.provider === 'linkkf'), false,
          'Linkkf must not enter integrated search');
      }
      searches.push(result);
      await captureUiState(`search-${searches.length}`);
    }
  }
  liveEvidence.searches = searches;

  const identityChecks = [];
  if (process.env.PATCH03_VERIFY_IDENTITY === '1') {
    for (const search of searches) {
      const candidate = search.groups.find(group => group.sources.some(item => ['animenosub', 'ohli24'].includes(item.provider)));
      if (!candidate) continue;
      for (const provider of ['animenosub', 'ohli24']) {
        const item = candidate.sources.find(source => source.provider === provider);
        if (!item) continue;
        const detail = await evaluate(`window.lilac.providerDetail(animeById(${JSON.stringify(item.sourceId)}))`, `${provider} real detail and episodes`);
        identityChecks.push({
          query: search.query,
          provider,
          searchIdentity: item,
          detailIdentity: {
            title: detail?.data?.title || '', titleEnglish: detail?.data?.title_english || '',
            titleJapanese: detail?.data?.title_japanese || '', year: detail?.data?.year || '',
            type: detail?.data?.type || '', anilistId: detail?.data?.anilistId || null, malId: detail?.data?.malId || null
          },
          episodeCount: detail?.episodes?.length || 0,
          episodeNumbers: (detail?.episodes || []).slice(0, 12).map(episode => episode.number),
          unavailable: detail?.unavailable === true,
          groupSourceProviders: candidate.sources.map(source => source.provider)
        });
      }
    }
  }

  let detailLinkage = null;
  if (process.env.PATCH03_VERIFY_DETAIL === '1') {
    const search = searches.find(item => item.query === process.env.PATCH03_LIVE_QUERY) || searches[0];
    const activeSearchQuery = await evaluate("document.querySelector('#pageSearch')?.value || ''", 'active search query before grouped detail');
    if (activeSearchQuery !== search.query) {
      await evaluate(`doSearch(${JSON.stringify(search.query)})`, 'restore selected live search results before detail selection');
      await captureUiState('detail-search-context');
    }
    const targetProvider = process.env.PATCH03_VERIFY_PROVIDER || 'animenosub';
    const expectedAnilistId = Number(process.env.PATCH03_EXPECTED_ANILIST_ID) || 0;
    const counterpartProviders = targetProvider === 'miruro' ? ['reanime'] : targetProvider === 'reanime' ? ['miruro'] : ['reanime', 'miruro'];
    const group = search?.groups.find(item => item.sources.some(source => source.provider === targetProvider)
      && (!expectedAnilistId || item.sources.some(source => Number(source.anilistId) === expectedAnilistId))
      && counterpartProviders.some(provider => item.sources.some(source => source.provider === provider)));
    if (!group) console.log(`PATCH03_GROUP_DIAGNOSTIC ${JSON.stringify({ targetProvider, query: search?.query, statuses: search?.statuses, groups: search?.groups.map(item => ({ title: item.title, sources: item.sources.map(source => ({ provider: source.provider, title: source.title, year: source.year, type: source.type, anilistId: source.anilistId, malId: source.malId, sourceId: source.sourceId })) })) })}`);
    assert.ok(group, `live search must group the ${targetProvider} candidate with a catalog source`);
    const target = group.sources.find(source => source.provider === targetProvider);
    const groupCardEvidence = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('#searchGrid .anime-card')];
      const sourceIds = ${JSON.stringify(group.sources.map(source => source.sourceId))};
      const card = cards.find(item => sourceIds.includes(item.dataset.id));
      const evidence = { expectedSourceIds: sourceIds, cardIds: cards.map(item => item.dataset.id || ''),
        matchedCardId: card?.dataset.id || '', title: card?.querySelector('h3')?.textContent?.trim() || '' };
      if (card) { card.click(); evidence.clicked = true; } else evidence.clicked = false;
      return evidence;
    })()`, 'open grouped search result card');
    liveEvidence.groupCardEvidence = groupCardEvidence;
    setStage('grouped-search-card-selection', groupCardEvidence);
    assert.equal(groupCardEvidence.clicked, true, 'the visible grouped result card must open the official detail dialog');
    let initialWaitError = '';
    try {
      await waitFor(() => evaluate(`Boolean(document.querySelector('#detailDialog')?.open && (
        document.querySelector('#detailContent #episodeBlock .episode-section')
        || document.querySelector('#detailContent .detail-playback-info')?.textContent?.length > 0
      ))`, 'initial grouped detail settled'), 30000, 'initial grouped detail result');
    } catch (error) { initialWaitError = String(error?.message || error); }
    const before = await evaluate(`(() => {
      const section = document.querySelector('#episodeBlock .episode-section');
      const heading = section?.querySelector('.episode-block-head h3 small')?.textContent || '';
      const detailError = document.querySelector('#detailContent .empty-state h3')?.textContent || '';
      const currentId = document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '';
      return ({
      title: document.querySelector('#detailContent h1')?.textContent || '',
      pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
      episodeCount: document.querySelector('#episodeBlock')?.children.length || 0,
      episodeRows: section?.querySelectorAll('.episode-row.rich').length || 0,
      episodeHeadingCount: Number.parseInt(heading, 10) || 0,
      playbackInfoText: document.querySelector('#detailContent .detail-playback-info')?.textContent?.trim() || '',
      detailError,
      detailErrorText: document.querySelector('#detailContent .empty-state')?.textContent?.trim() || '',
      currentSourceId: currentId,
      sources: [...document.querySelectorAll('#detailContent [data-provider-source]')].map(button => ({
        id: button.dataset.providerSource, label: button.textContent.trim(), active: button.getAttribute('aria-pressed') === 'true'
      }))
      });
    })()`, 'initial source picker and detail diagnostics');
    before.providerDetailCalls = providerDetailIpcCalls.slice();
    before.detailCall = [...providerDetailIpcCalls].reverse().find(call => call.sourceId === before.currentSourceId)
      || providerDetailIpcCalls.at(-1) || null;
    liveEvidence.initialDetail = before;
    liveEvidence.providerDetailIpcCalls = providerDetailIpcCalls;
    if (initialWaitError || before.detailError || !before.detailCall || before.detailCall.state !== 'resolved') {
      const partial = { tempRoot: '<OS_TEMP_TEST_ROOT>', paths: reportPaths, electronVersion: process.versions.electron, executable: '<ELECTRON_BINARY>',
        mainPid: process.pid, rendererPid: mainWindow.webContents.getOSProcessId(), windowIds: windows,
        startup, startupConsoleErrors: consoleErrors, searches, identityChecks, detailLinkage: { before },
        initialWaitError, linkAniExternalRequestSkipped: false, providerDetailIpcCalls };
      fs.writeFileSync(path.join(tempRoot, 'report.json'), JSON.stringify(partial, null, 2));
      console.log(`PATCH03_PROVIDER_LIVE_DIAGNOSTIC ${JSON.stringify({ before, initialWaitError, tempRoot: '<OS_TEMP_TEST_ROOT>' })}`);
      throw new Error(`Initial ${before.detailCall?.provider || 'provider'} detail did not load: ${before.detailErrorText || initialWaitError || before.detailCall?.state}`);
    }
    const switched = await evaluate(`(() => {
      const button = [...document.querySelectorAll('#detailContent [data-provider-source]')]
        .find(item => item.dataset.providerSource === ${JSON.stringify(target.sourceId)});
      if (!button) return false;
      button.click(); return true;
    })()`, `select live ${targetProvider} source`);
    assert.equal(switched, true, `grouped detail must expose the live ${targetProvider} candidate`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource === ${JSON.stringify(target.sourceId)}
      && (document.querySelector('#detailContent #episodeBlock .episode-section')
        || document.querySelector('#detailContent .detail-playback-info')?.textContent?.length > 0))`, `${targetProvider} detail after source switch`), 30000, `${targetProvider} detail result`);
    const after = await evaluate(`(() => ({
      sourceId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
      title: document.querySelector('#detailContent h1')?.textContent || '',
      pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
      activeSourceId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
      episodeCount: document.querySelector('#episodeBlock')?.children.length || 0,
      episodeRows: document.querySelectorAll('#episodeBlock .episode-section .episode-row.rich').length,
      episodeHeadingCount: Number.parseInt(document.querySelector('#episodeBlock .episode-block-head h3 small')?.textContent || '', 10) || 0,
      playbackInfoText: document.querySelector('#detailContent .detail-playback-info')?.textContent?.trim() || '',
      detailError: document.querySelector('#detailContent .empty-state h3')?.textContent || '',
      episodeLabels: [...(document.querySelector('#episodeBlock')?.children || [])].slice(0, 6).map(node => node.textContent.trim())
    }))()`, 'selected AnimenoSub source result');
    after.providerDetailCalls = providerDetailIpcCalls.slice();
    after.providerDetailCall = [...providerDetailIpcCalls].reverse().find(call => call.sourceId === target.sourceId) || null;
    liveEvidence.selectedDetail = after;
    liveEvidence.providerDetailIpcCalls = providerDetailIpcCalls;
    await captureUiState('detail-source-picker-episodes');
    detailLinkage = { groupKey: group.groupKey, providers: group.sources.map(source => source.provider), targetId: target.sourceId, before, after };
    assert.equal(before.pickerCount, 1);
    assert.equal(after.pickerCount, 1);
    assert.equal(after.sourceId, target.sourceId);
    assert.equal(after.activeSourceId, target.sourceId, 'the active selector and loaded source ID must agree');
    assert.ok(after.episodeHeadingCount > 0, 'the selected provider must render its real episode count');
    assert.equal(after.episodeRows, after.episodeHeadingCount, 'the displayed rows and selected provider count must agree');
    assert.equal(after.providerDetailCall?.episodeCount, after.episodeHeadingCount, 'the displayed count must match the actual provider:detail IPC response');
    assert.equal(after.detailError, '', 'the selected provider detail must not show an error');

    const sourceSwitchMatrix = [
      { provider: before.detailCall.provider, sourceId: before.currentSourceId, state: before.detailCall.state, episodeCount: before.episodeHeadingCount, pickerCount: before.pickerCount },
      { provider: targetProvider, sourceId: after.sourceId, state: after.providerDetailCall?.state || 'no-ipc', episodeCount: after.episodeHeadingCount, pickerCount: after.pickerCount }
    ];
    for (const provider of ['reanime', 'miruro', 'animenosub', 'ohli24']) {
      const candidate = group.sources.find(source => source.provider === provider);
      if (!candidate || provider === before.detailCall.provider || provider === targetProvider) continue;
      const clickAccepted = await evaluate(`(() => {
        const button = [...document.querySelectorAll('#detailContent [data-provider-source]')]
          .find(item => item.dataset.providerSource === ${JSON.stringify(candidate.sourceId)});
        if (!button) return false; button.click(); return true;
      })()`, `select matched ${provider} source`);
      assert.equal(clickAccepted, true, `the existing selector must expose the matched ${provider} source`);
      await waitFor(() => evaluate(`Boolean(document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource === ${JSON.stringify(candidate.sourceId)}
        && (document.querySelector('#episodeBlock .episode-section')
          || document.querySelector('#detailContent .detail-playback-info')?.textContent?.length > 0))`, `${provider} source settled`), 30000, `${provider} source result`);
      const result = await evaluate(`(() => ({
        sourceId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
        activeSourceId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
        pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
        episodeCount: Number.parseInt(document.querySelector('#episodeBlock .episode-block-head h3 small')?.textContent || '', 10) || 0,
        episodeRows: document.querySelectorAll('#episodeBlock .episode-section .episode-row.rich').length,
        playbackInfoText: document.querySelector('#detailContent .detail-playback-info')?.textContent?.trim() || '',
        error: document.querySelector('#detailContent .empty-state h3')?.textContent || ''
      }))()`, `${provider} source snapshot`);
      const call = [...providerDetailIpcCalls].reverse().find(item => item.provider === provider && item.sourceId === candidate.sourceId) || null;
      assert.equal(result.sourceId, candidate.sourceId, `${provider} must remain the selected source`);
      assert.equal(result.activeSourceId, candidate.sourceId, `${provider} selector and loaded source must agree`);
      assert.equal(result.pickerCount, 1, 'the shared detail dialog must contain exactly one source selector');
      if (call?.state === 'resolved' && call.episodeCount > 0) {
        assert.equal(result.episodeRows, result.episodeCount, `${provider} rendered episodes must match the loaded list`);
        assert.equal(result.episodeCount, call.episodeCount, `${provider} mini count must match its detail IPC response`);
      }
      sourceSwitchMatrix.push({ provider, sourceId: candidate.sourceId, state: call?.state || (result.error ? 'error-ui' : 'no-ipc'), episodeCount: result.episodeCount, episodeRows: result.episodeRows, pickerCount: result.pickerCount, playbackInfoText: result.playbackInfoText, error: result.error, detailCall: call });
    }

    const rapidCandidates = ['reanime', 'miruro'].map(provider => group.sources.find(source => source.provider === provider)).filter(Boolean);
    let rapidSwitch = { state: rapidCandidates.length === 2 ? 'not-run' : 'not-available-in-matched-group' };
    if (rapidCandidates.length === 2) {
      const [first, last] = rapidCandidates;
      const callOffset = providerDetailIpcCalls.length;
      const rapidClicked = await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('#detailContent [data-provider-source]')];
        const first = buttons.find(item => item.dataset.providerSource === ${JSON.stringify(first.sourceId)});
        const last = buttons.find(item => item.dataset.providerSource === ${JSON.stringify(last.sourceId)});
        if (!first || !last) return false;
        first.click(); last.click(); return true;
      })()`, 'rapid RE:Anime and Miruro source change');
      assert.equal(rapidClicked, true, 'the matched RE:Anime and Miruro sources must be selectable');
      const settleDeadline = Date.now() + 40000;
      while (Date.now() < settleDeadline) {
        const calls = providerDetailIpcCalls.slice(callOffset).filter(call => [first.sourceId, last.sourceId].includes(call.sourceId));
        if (calls.length >= 2 && calls.every(call => call.state !== 'pending')) break;
        await pause(200);
      }
      await waitFor(() => evaluate(`document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource === ${JSON.stringify(last.sourceId)}`,
        'rapid provider switch final detail render'), 30000, 'latest rapid source detail render');
      const finalState = await evaluate(`(() => ({
        sourceId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
        activeSourceId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
        episodeCount: Number.parseInt(document.querySelector('#episodeBlock .episode-block-head h3 small')?.textContent || '', 10) || 0,
        episodeRows: document.querySelectorAll('#episodeBlock .episode-section .episode-row.rich').length,
        playbackInfoText: document.querySelector('#detailContent .detail-playback-info')?.textContent?.trim() || ''
      }))()`, 'rapid provider switch final state');
      const calls = providerDetailIpcCalls.slice(callOffset);
      const firstCall = [...calls].reverse().find(call => call.sourceId === first.sourceId) || null;
      const lastCall = [...calls].reverse().find(call => call.sourceId === last.sourceId) || null;
      rapidSwitch = { state: lastCall?.state || 'no-ipc', previousProvider: 'reanime', previousSourceId: first.sourceId,
        selectedProvider: 'miruro', selectedSourceId: last.sourceId, final: finalState, firstCall, finalCall: lastCall };
      assert.equal(finalState.sourceId, last.sourceId, 'a late response must not change the most recently selected source');
      assert.equal(finalState.activeSourceId, last.sourceId, 'the active selector must remain on the most recently selected source');
      if (lastCall?.state === 'resolved' && lastCall.episodeCount > 0) {
        assert.equal(finalState.episodeCount, lastCall.episodeCount);
        assert.equal(finalState.episodeRows, lastCall.episodeCount);
      }
    }
    detailLinkage.sourceSwitchMatrix = sourceSwitchMatrix;
    detailLinkage.rapidSwitch = rapidSwitch;

    const initialProvider = before.detailCall.provider;
    if (initialProvider !== targetProvider && ['reanime', 'miruro'].includes(initialProvider) && ['reanime', 'miruro'].includes(targetProvider)) {
      const initialSource = before.sources.find(source => source.active);
      const returnButton = await evaluate(`(() => {
        const button = [...document.querySelectorAll('#detailContent [data-provider-source]')]
          .find(item => item.dataset.providerSource === ${JSON.stringify(initialSource?.id || '')});
        if (!button) return false;
        button.click(); return true;
      })()`, `return to live ${initialProvider} source`);
      assert.equal(returnButton, true, `the picker must allow returning to ${initialProvider}`);
      await waitFor(() => evaluate(`Boolean(document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource === ${JSON.stringify(initialSource.id)}
        && (document.querySelector('#episodeBlock .episode-section')
          || document.querySelector('#detailContent .detail-playback-info')?.textContent?.length > 0))`, 'returned source detail result'), 30000, `${initialProvider} detail after return`);
      const returned = await evaluate(`(() => ({
        sourceId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
        activeSourceId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
        pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
        episodeHeadingCount: Number.parseInt(document.querySelector('#episodeBlock .episode-block-head h3 small')?.textContent || '', 10) || 0,
        episodeRows: document.querySelectorAll('#episodeBlock .episode-section .episode-row.rich').length,
        playbackInfoText: document.querySelector('#detailContent .detail-playback-info')?.textContent?.trim() || '',
        detailError: document.querySelector('#detailContent .empty-state h3')?.textContent || ''
      }))()`, `returned ${initialProvider} episode list`);
      returned.providerDetailCalls = providerDetailIpcCalls.slice();
      returned.providerDetailCall = [...providerDetailIpcCalls].reverse().find(call => call.sourceId === initialSource.id) || null;
      liveEvidence.returnedDetail = returned;
      detailLinkage.returned = returned;
      assert.equal(returned.sourceId, initialSource.id);
      assert.equal(returned.activeSourceId, initialSource.id);
      assert.equal(returned.pickerCount, 1);
      assert.ok(returned.episodeHeadingCount > 0);
      assert.equal(returned.episodeRows, returned.episodeHeadingCount);
      assert.equal(returned.providerDetailCall?.episodeCount, returned.episodeHeadingCount);
      assert.equal(returned.detailError, '');
    }

    const originalWindowSize = mainWindow.getSize();
    const originalViewportWidth = await evaluate('innerWidth', 'original detail viewport width');
    const wasMaximized = mainWindow.isMaximized();
    const wasFullScreen = mainWindow.isFullScreen();
    if (wasFullScreen) mainWindow.setFullScreen(false);
    if (wasMaximized) mainWindow.unmaximize();
    // The official desktop window enforces minWidth: 980 via DesktopState.bounds().
    // Measure at that supported narrow width instead of requesting an impossible 560px window.
    mainWindow.setSize(980, 820);
    await waitFor(() => evaluate(`(() => {
      const dialog = document.querySelector('#detailDialog');
      const rect = dialog?.getBoundingClientRect();
      return Boolean(dialog?.open && innerWidth >= 900 && innerWidth <= 1000 && rect?.width > 0 && rect?.height > 0);
    })()`, 'open detail at narrow viewport'), 12000, 'narrow viewport and open detail dialog');
    await waitFor(() => evaluate(`(() => {
      const dialog = document.querySelector('#detailDialog');
      const title = document.querySelector('#detailContent .detail-info h1');
      const picker = document.querySelector('#detailContent .detail-source-picker');
      const row = document.querySelector('#episodeBlock .episode-section .episode-row.rich');
      return Boolean(dialog?.open && title?.getBoundingClientRect().height > 0
        && picker?.getBoundingClientRect().height > 0 && row?.getBoundingClientRect().height > 0
        && getComputedStyle(title).visibility === 'visible'
        && Number(getComputedStyle(title).opacity) > .98);
    })()`, 'painted detail content at narrow viewport'), 5000, 'visible title, picker, and episode row');
    await pause(450);
    detailLinkage.narrowWindow = await evaluate(`(() => {
      const dialog = document.querySelector('#detailDialog'), picker = document.querySelector('#detailContent .detail-source-picker');
      if (!dialog || !picker) return null;
      const d = dialog.getBoundingClientRect(), p = picker.getBoundingClientRect();
      const content = document.querySelector('#detailContent');
      const title = document.querySelector('#detailContent .detail-info h1');
      const row = document.querySelector('#episodeBlock .episode-section .episode-row.rich');
      const chain = []; for (let node = title; node && node !== dialog.parentElement; node = node.parentElement) {
        const style = getComputedStyle(node); chain.push({ tag: node.tagName, className: String(node.className || ''), opacity: Number(style.opacity), visibility: style.visibility, display: style.display });
        if (node === dialog) break;
      }
      return { dialogOpen: dialog.open, viewportWidth: innerWidth, viewportHeight: innerHeight,
        dialogLeft: Math.round(d.left), dialogRight: Math.round(d.right), dialogWidth: Math.round(d.width),
        dialogHeight: Math.round(d.height), pickerWidth: Math.round(p.width),
        pickerClientWidth: picker.clientWidth, pickerScrollWidth: picker.scrollWidth,
        title: title?.textContent?.trim() || '', titleRectHeight: title?.getBoundingClientRect().height || 0,
        episodeRowRectHeight: row?.getBoundingClientRect().height || 0, visibilityChain: chain,
        episodeRows: document.querySelectorAll('#episodeBlock .episode-section .episode-row.rich').length,
        contentClientHeight: content?.clientHeight || 0, contentScrollHeight: content?.scrollHeight || 0,
        contentOverflowY: getComputedStyle(content).overflowY,
        pickerButtons: [...picker.querySelectorAll('button')].map(button => ({
          left: Math.round(button.getBoundingClientRect().left - p.left), right: Math.round(button.getBoundingClientRect().right - p.left),
          clipped: button.getBoundingClientRect().left < p.left || button.getBoundingClientRect().right > p.right
        })) };
    })()`, 'narrow detail layout');
    liveEvidence.narrowWindow = detailLinkage.narrowWindow;
    assert.ok(detailLinkage.narrowWindow?.dialogOpen, 'narrow layout must be measured while the original detail dialog is open');
    assert.ok(detailLinkage.narrowWindow.viewportWidth >= 900 && detailLinkage.narrowWindow.viewportWidth <= 1000,
      'the renderer viewport must be close to the supported 980px minimum width');
    assert.ok(detailLinkage.narrowWindow.dialogWidth > 0 && detailLinkage.narrowWindow.dialogHeight > 0,
      'the open detail dialog must have a non-zero measured rectangle');
    assert.ok(detailLinkage.narrowWindow.dialogLeft >= -2
      && detailLinkage.narrowWindow.dialogRight <= detailLinkage.narrowWindow.viewportWidth + 2,
    'the detail dialog must stay within the narrow viewport');
    assert.ok(detailLinkage.narrowWindow.pickerWidth > 0 && detailLinkage.narrowWindow.episodeRows > 0,
      'the source picker and episode rows must remain visible at narrow width');
    assert.ok(detailLinkage.narrowWindow.title && detailLinkage.narrowWindow.titleRectHeight > 0
      && detailLinkage.narrowWindow.episodeRowRectHeight > 0
      && detailLinkage.narrowWindow.visibilityChain.every(node => node.display !== 'none'
        && node.visibility === 'visible' && node.opacity > .98),
    'the detail title, picker, and episode content must be visibly painted before capture');
    assert.ok(detailLinkage.narrowWindow.pickerButtons.length > 0
      && detailLinkage.narrowWindow.pickerButtons.every(button => !button.clipped),
    'the source picker controls must remain visible without clipping');
    fs.writeFileSync(path.join(tempRoot, 'detail-narrow.png'), (await mainWindow.capturePage()).toPNG());
    mainWindow.setSize(...originalWindowSize);
    if (wasMaximized) mainWindow.maximize();
    if (wasFullScreen) mainWindow.setFullScreen(true);
    await waitFor(() => evaluate(`Math.abs(innerWidth - ${Number(originalViewportWidth)}) <= 4`, 'restore original detail viewport'),
      12000, 'restore original window size');

    let playbackConnection = null;
    if (process.env.PATCH03_VERIFY_PLAYBACK === '1') {
      const sourceSelected = await evaluate(`document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource === ${JSON.stringify(target.sourceId)}`,
        'playback target source already selected');
      if (!sourceSelected) {
        const selected = await evaluate(`(() => {
          const button = [...document.querySelectorAll('#detailContent [data-provider-source]')]
            .find(item => item.dataset.providerSource === ${JSON.stringify(target.sourceId)});
          if (!button) return false; button.click(); return true;
        })()`, `select ${targetProvider} for original playback`);
        assert.equal(selected, true, `the existing detail picker must select ${targetProvider} before playback`);
        await waitFor(() => evaluate(`Boolean(document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource === ${JSON.stringify(target.sourceId)}
          && document.querySelector('#episodeBlock .episode-section .episode-btn:not(:disabled)'))`, `${targetProvider} episode list ready for playback`), 30000, `${targetProvider} episode list before playback`);
      }
      const resolveOffset = providerResolveIpcCalls.length;
      const clickedEpisode = await evaluate(`(() => {
        const button = document.querySelector('#episodeBlock .episode-section .episode-row.rich:not(.unavailable) .episode-btn:not(:disabled)');
        const video = document.querySelector('#video');
        if (!button || !video) return null;
        video.muted = true; video.volume = 0;
        const evidence = { events: [], maxCurrentTime: 0, loadedData: false, playing: false, errorCode: null };
        window.__patch03PlaybackEvidence = evidence;
        for (const name of ['loadedmetadata', 'loadeddata', 'playing', 'timeupdate', 'error']) video.addEventListener(name, () => {
          evidence.events.push(name);
          evidence.maxCurrentTime = Math.max(evidence.maxCurrentTime, Number(video.currentTime) || 0);
          evidence.loadedData = evidence.loadedData || name === 'loadeddata';
          evidence.playing = evidence.playing || name === 'playing';
          evidence.errorCode = name === 'error' ? video.error?.code || null : evidence.errorCode;
        });
        const selectedSourceId = document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '';
        const episodeNumber = button.querySelector('.episode-number')?.textContent?.trim() || '';
        const loadedEpisodeRows = document.querySelectorAll('#episodeBlock .episode-row.rich').length;
        button.click();
        return { selectedSourceId, episodeNumber, loadedEpisodeRows };
      })()`, 'click one existing provider episode');
      assert.ok(clickedEpisode, 'one real episode row must be clickable in the existing detail dialog');
      setStage('provider-episode-clicked', clickedEpisode);
      const resolveDeadline = Date.now() + 45000;
      while (Date.now() < resolveDeadline) {
        const calls = providerResolveIpcCalls.slice(resolveOffset);
        if (calls.length && calls.every(call => call.state !== 'pending')) break;
        await pause(200);
      }
      const resolveCalls = providerResolveIpcCalls.slice(resolveOffset);
      const firstResolve = resolveCalls[0] || null;
      if (firstResolve?.state === 'resolved' && firstResolve.hasStreamUrl) {
        try {
          await waitFor(() => evaluate(`(() => {
            const video = document.querySelector('#video'), evidence = window.__patch03PlaybackEvidence;
            return Boolean(video && Number(video.currentTime) >= 10 && video.readyState >= 2 && video.videoWidth > 0
              && evidence?.playing && evidence?.loadedData);
          })()`, 'actual video time and decoded frame progress'), 30000, '10 seconds of video playback');
        } catch {}
      }
      const videoEvidence = await evaluate(`(() => {
        const video = document.querySelector('#video'), evidence = window.__patch03PlaybackEvidence || {};
        if (video && !video.paused) video.pause();
        return {
          currentTimeSeconds: Number.isFinite(video?.currentTime) ? Number(video.currentTime.toFixed(2)) : 0,
          readyState: video?.readyState ?? 0,
          videoWidth: video?.videoWidth ?? 0,
          videoHeight: video?.videoHeight ?? 0,
          hasCurrentSource: Boolean(video?.currentSrc),
          paused: video?.paused ?? true,
          loadedData: evidence.loadedData === true,
          playingEvent: evidence.playing === true,
          events: [...new Set(evidence.events || [])],
          mediaErrorCode: evidence.errorCode || video?.error?.code || null
        };
      })()`, 'actual player state without exposing stream URL');
      const sameProviderOnly = resolveCalls.every(call => call.provider === targetProvider);
      const identityMatches = Boolean(firstResolve && firstResolve.provider === targetProvider
        && (firstResolve.sourceAnimeId == null || String(firstResolve.sourceAnimeId) === String(target.id)));
      const playbackConfirmed = Boolean(videoEvidence.currentTimeSeconds >= 10 && videoEvidence.readyState >= 2
        && videoEvidence.videoWidth > 0 && videoEvidence.playingEvent && videoEvidence.loadedData);
      playbackConnection = {
        selectedProvider: targetProvider, selectedSourceId: target.sourceId, selectedSourceAnimeId: target.id,
        clickedEpisode, resolveCalls, sameProviderOnly, identityMatches,
        streamResolution: firstResolve?.state === 'resolved' ? (firstResolve.hasStreamUrl ? 'stream-url-obtained' : 'resolved-without-stream-url')
          : firstResolve?.state === 'failed' ? 'stream-request-failed' : firstResolve?.state || 'provider-resolve-not-observed',
        actualPlayback: playbackConfirmed ? '10-seconds-and-decoded-frame-confirmed'
          : firstResolve?.hasStreamUrl ? 'stream-url-obtained-but-playback-not-confirmed' : 'not-confirmed',
        videoEvidence
      };
      assert.ok(firstResolve, 'the original provider:resolve IPC must be reached by clicking a real episode row');
      assert.equal(firstResolve.provider, targetProvider, 'the selected provider must reach the original stream resolver');
      if (firstResolve.sourceAnimeId != null) assert.equal(String(firstResolve.sourceAnimeId), String(target.id),
        'the provider-specific anime ID must reach the original stream resolver');
      setStage('provider-playback-check-finished', { provider: targetProvider, identityMatches, sameProviderOnly, streamResolution: playbackConnection.streamResolution, actualPlayback: playbackConnection.actualPlayback, videoEvidence });
      liveEvidence.playbackConnection = playbackConnection;
      await captureUiState('playback-frame');
    }

  }

  let sourceModeFlow = null;
  if (sourceModeTest === 'exercise') {
    const individualProvider = process.env.PATCH03_INDIVIDUAL_PROVIDER || 'miruro';
    assert.ok(['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'].includes(individualProvider),
      'individual return must use a Patch 03 provider');
    await selectSourceSetting(individualProvider, 'return to an individual content provider', `window.__dinoPatch03Bridge?.getMode() === 'provider'
      && state.source === ${JSON.stringify(individualProvider)}
      && localStorage.getItem('contentSource') === ${JSON.stringify(individualProvider)}
      && document.querySelector('#contentSource')?.value === ${JSON.stringify(individualProvider)}`);
    const individualCallOffset = providerCatalogIpcCalls.length;
    const individualSearch = await evaluate(`(async () => {
      await doSearch(${JSON.stringify(process.env.PATCH03_LIVE_QUERY || '葬送のフリーレン')});
      return { query: document.querySelector('#pageSearch')?.value || ${JSON.stringify(process.env.PATCH03_LIVE_QUERY || '葬送のフリーレン')},
        groupCount: document.querySelectorAll('#searchGrid .anime-card').length,
        cards: [...document.querySelectorAll('#searchGrid .anime-card')].map(card => {
          const anime = animeById(card.dataset.id);
          return { sourceId: card.dataset.id, providerAnimeId: anime?.id == null ? '' : String(anime.id),
            provider: anime?.provider || '', title: anime?.title || '',
            anilistId: anime?.anilistId || anime?.anilist_id || null, malId: anime?.malId || anime?.mal_id_external || null,
            year: anime?.year || null, type: anime?.type || '' };
        }),
        searchStatus: document.querySelector('#searchStatus')?.textContent?.trim() || '',
        statuses: [...document.querySelectorAll('#searchProviderFilters button[data-provider]')].map(button => ({
          provider: button.dataset.provider, state: button.dataset.state || 'ready', label: button.textContent.trim()
        })) };
    })()`, `individual ${individualProvider} search`);
    const individualCalls = providerCatalogIpcCalls.slice(individualCallOffset);
    const individualProviders = [...new Set(individualCalls.map(call => call.provider))].sort();
    assert.deepEqual(individualProviders, [individualProvider],
      'individual mode must call only the selected provider');
    assert.equal(individualCalls.some(call => call.provider === 'linkkf'), false,
      'Linkkf remains outside Patch 03 individual and integrated catalog calls');

    let individualDetail = null, individualPlayback = null;
    if (process.env.PATCH03_VERIFY_INDIVIDUAL_DETAIL === '1') {
      const expectedAnilistId = Number(process.env.PATCH03_EXPECTED_ANILIST_ID) || 0;
      const expectedSourceId = String(process.env.PATCH03_EXPECTED_SOURCE_ID || '');
      const candidate = individualSearch.cards.find(item => item.provider === individualProvider
        && (!expectedAnilistId || Number(item.anilistId) === expectedAnilistId)
        && (!expectedSourceId || item.sourceId === expectedSourceId));
      assert.ok(candidate, `individual ${individualProvider} search must return a candidate${expectedAnilistId ? ` with AniList ID ${expectedAnilistId}` : ''}${expectedSourceId ? ` with source ID ${expectedSourceId}` : ''}`);
      const catalogCallOffset = providerCatalogIpcCalls.length, detailCallOffset = providerDetailIpcCalls.length;
      await evaluate(`(() => {
        const card = [...document.querySelectorAll('#searchGrid .anime-card')]
          .find(item => item.dataset.id === ${JSON.stringify(candidate.sourceId)});
        if (!card) return false; card.click(); return true;
      })()`, `open individual ${individualProvider} search result`)
        .then(opened => assert.equal(opened, true, 'the official search card must be clickable'));
      await waitFor(() => evaluate(`Boolean(document.querySelector('#detailDialog')?.open
        && document.querySelector('#episodeBlock .episode-section .episode-row.rich'))`,
      'individual source detail and episode rows'), 30000, 'individual source detail and episode list');
      const snapshot = await evaluate(`(() => ({
        mode: window.__dinoPatch03Bridge?.getMode() || '', provider: state.source,
        sourceId: '',
        title: document.querySelector('#detailContent h1')?.textContent || '',
        pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
        episodeCount: Number.parseInt(document.querySelector('#episodeBlock .episode-block-head h3 small')?.textContent || '', 10) || 0,
        episodeRows: document.querySelectorAll('#episodeBlock .episode-section .episode-row.rich').length,
        detailError: document.querySelector('#detailContent .empty-state h3')?.textContent || ''
      }))()`, 'individual provider detail snapshot');
      const detailCall = providerDetailIpcCalls.slice(detailCallOffset).find(call => call.sourceId === candidate.sourceId) || null;
      snapshot.sourceId = detailCall?.sourceId || '';
      const catalogCallsAfterDetail = providerCatalogIpcCalls.slice(catalogCallOffset);
      const crossProviderCatalogCallsAfterDetail = catalogCallsAfterDetail.filter(call => call.provider !== individualProvider);
      individualDetail = { candidate, snapshot, detailCall, crossProviderCatalogCallsAfterDetail };
      assert.equal(snapshot.mode, 'provider');
      assert.equal(snapshot.provider, individualProvider);
      assert.equal(snapshot.sourceId, candidate.sourceId, 'the source-specific ID must be retained in detail');
      assert.equal(snapshot.pickerCount, 0, 'individual mode must not render the Patch 03 source picker');
      assert.ok(snapshot.episodeCount > 0, 'the real provider detail must return episodes');
      assert.equal(snapshot.episodeRows, snapshot.episodeCount, 'the official episode renderer must match the loaded list');
      assert.equal(detailCall?.state, 'resolved', 'the official provider:detail IPC must resolve the selected source');
      assert.equal(detailCall?.provider, individualProvider);
      assert.equal(detailCall?.episodeCount, snapshot.episodeCount);
      assert.equal(crossProviderCatalogCallsAfterDetail.length, 0, 'individual detail must not start Patch 03 cross-provider discovery');

      if (process.env.PATCH03_VERIFY_INDIVIDUAL_PLAYBACK === '1') {
        const resolveCallOffset = providerResolveIpcCalls.length;
        const clickedEpisode = await evaluate(`(() => {
          const button = document.querySelector('#episodeBlock .episode-section .episode-row.rich:not(.unavailable) .episode-btn:not(:disabled)');
          const video = document.querySelector('#video');
          if (!button || !video) return null;
          video.muted = true; video.volume = 0;
          const evidence = { events: [], maxCurrentTime: 0, loadedData: false, playing: false, errorCode: null };
          window.__patch03IndividualPlaybackEvidence = evidence;
          for (const name of ['loadedmetadata', 'loadeddata', 'playing', 'timeupdate', 'error']) video.addEventListener(name, () => {
            evidence.events.push(name); evidence.maxCurrentTime = Math.max(evidence.maxCurrentTime, Number(video.currentTime) || 0);
            evidence.loadedData = evidence.loadedData || name === 'loadeddata'; evidence.playing = evidence.playing || name === 'playing';
            evidence.errorCode = name === 'error' ? video.error?.code || null : evidence.errorCode;
          });
          const row = button.closest('.episode-row');
          const number = row?.querySelector('.episode-number')?.textContent?.trim() || '';
          button.click(); return { number, loadedRows: document.querySelectorAll('#episodeBlock .episode-row.rich').length };
        })()`, `resolve individual ${individualProvider} episode`);
        assert.ok(clickedEpisode, 'an actual episode row must be selectable');
        await waitFor(() => providerResolveIpcCalls.slice(resolveCallOffset).length > 0
          && providerResolveIpcCalls.slice(resolveCallOffset).every(call => call.state !== 'pending'),
        45000, 'individual provider:resolve completion');
        const resolveCall = providerResolveIpcCalls.slice(resolveCallOffset)[0];
        assert.equal(resolveCall.provider, individualProvider, 'the selected individual provider must reach provider:resolve');
        if (resolveCall.sourceAnimeId != null) assert.equal(String(resolveCall.sourceAnimeId), String(candidate.providerAnimeId));
        if (resolveCall.state === 'resolved' && resolveCall.hasStreamUrl) {
          try {
            await waitFor(() => evaluate(`(() => {
              const video = document.querySelector('#video'), evidence = window.__patch03IndividualPlaybackEvidence;
              return Boolean(video && Number(video.currentTime) >= 10 && video.readyState >= 2 && video.videoWidth > 0
                && evidence?.playing && evidence?.loadedData);
            })()`, 'individual actual video progress'), 30000, '10 seconds of individual playback');
          } catch {}
        }
        const videoEvidence = await evaluate(`(() => {
          const video = document.querySelector('#video'), evidence = window.__patch03IndividualPlaybackEvidence || {};
          if (video && !video.paused) video.pause();
          return { currentTimeSeconds: Number.isFinite(video?.currentTime) ? Number(video.currentTime.toFixed(2)) : 0,
            readyState: video?.readyState ?? 0, videoWidth: video?.videoWidth ?? 0, videoHeight: video?.videoHeight ?? 0,
            paused: video?.paused ?? true, loadedData: evidence.loadedData === true, playingEvent: evidence.playing === true,
            events: [...new Set(evidence.events || [])], mediaErrorCode: evidence.errorCode || video?.error?.code || null };
        })()`, 'individual player state without exposing stream URL');
        individualPlayback = {
          selectedProvider: individualProvider, selectedSourceId: candidate.sourceId,
          selectedProviderAnimeId: candidate.providerAnimeId, clickedEpisode,
          resolveCall: { provider: resolveCall.provider, sourceAnimeId: resolveCall.sourceAnimeId,
            episodeId: resolveCall.episodeId, episodeNumber: resolveCall.episodeNumber, state: resolveCall.state,
            hasStreamUrl: resolveCall.hasStreamUrl || false, httpStatus: resolveCall.httpStatus || null,
            errorCode: resolveCall.errorCode || '', errorSummary: resolveCall.errorSummary || '' },
          actualPlayback: videoEvidence.currentTimeSeconds >= 10 && videoEvidence.readyState >= 2 && videoEvidence.videoWidth > 0
            && videoEvidence.playingEvent && videoEvidence.loadedData ? '10-seconds-and-decoded-frame-confirmed'
            : resolveCall.hasStreamUrl ? 'stream-url-obtained-but-playback-not-confirmed' : 'not-confirmed',
          videoEvidence
        };
      }
    }

    await selectSourceSetting('integrated', 'restore integrated content source', `window.__dinoPatch03Bridge?.getMode() === 'integrated'
      && localStorage.getItem('lilacDinoPatch.searchMode') === 'integrated'
      && localStorage.getItem('contentSource') !== 'integrated'
      && document.querySelector('#contentSource')?.value === 'integrated'`);
    sourceModeFlow = { individualProvider, individualSearch, individualProviderCalls: individualCalls,
      individualProviders, individualDetail, individualPlayback, restoredMode: 'integrated', restoredProvider: await evaluate('state.source', 'preserved provider after returning to integrated') };
    assert.equal(sourceModeFlow.restoredProvider, individualProvider, 'returning to integrated mode must retain the last individual provider');
    assert.equal(await evaluate("localStorage.getItem('contentSourceProvider')", 'stored individual provider after returning to integrated'), individualProvider);
    liveEvidence.sourceModeFlow = sourceModeFlow;
  }

  const standaloneDetails = [];
  const detailSearch = searches.find(item => item.query === process.env.PATCH03_LIVE_QUERY) || searches[0];
  const standaloneSourceId = String(process.env.PATCH03_VERIFY_STANDALONE_SOURCE_ID || '');
  for (const provider of String(process.env.PATCH03_VERIFY_STANDALONE_PROVIDERS || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const candidate = detailSearch?.groups.flatMap(group => group.sources).find(item => item.provider === provider
      && (!standaloneSourceId || item.sourceId === standaloneSourceId));
    if (!candidate) { standaloneDetails.push({ provider, state: 'no-search-result' }); continue; }
    try {
      const detail = await evaluate(`window.lilac.providerDetail(animeById(${JSON.stringify(candidate.sourceId)}))`, `${provider} standalone real detail`);
      standaloneDetails.push({
        provider, state: detail?.unavailable ? 'unavailable' : Array.isArray(detail?.episodes) ? 'resolved' : 'no-episode-list',
        searchIdentity: candidate,
        detailIdentity: {
          title: detail?.title || '', titleEnglish: detail?.title_english || '', titleJapanese: detail?.title_japanese || '',
          year: detail?.year || '', type: detail?.type || '', anilistId: detail?.anilistId || null, malId: detail?.malId || null
        },
        episodeCount: Array.isArray(detail?.episodes) ? detail.episodes.length : 0,
        episodeNumbers: (detail?.episodes || []).slice(0, 12).map(episode => episode.number),
        unavailable: detail?.unavailable === true,
        providerDetailCall: [...providerDetailIpcCalls].reverse().find(call => call.sourceId === candidate.sourceId) || null
      });
    } catch (error) {
      standaloneDetails.push({ provider, state: 'failed', error: String(error?.message || error).split('\n')[0] });
    }
  }
  liveEvidence.standaloneDetails = standaloneDetails;

  const report = {
    tempRoot: '<OS_TEMP_TEST_ROOT>', paths: reportPaths, electronVersion: process.versions.electron, executable: '<ELECTRON_BINARY>',
    mainPid: process.pid, rendererPid: mainWindow.webContents.getOSProcessId(), windowIds: windows,
    startup, seasonRailLoad, startupConsoleErrors: consoleErrors, searches, identityChecks, detailLinkage, standaloneDetails, sourceModeFlow,
    playbackConnection: liveEvidence.playbackConnection || null,
    linkAniExternalRequestSkipped: false, providerDetailIpcCalls, providerResolveIpcCalls
  };
  const reportFile = sourceModeTest ? `${sourceModeTest}-report.json` : 'report.json';
  fs.writeFileSync(path.join(tempRoot, reportFile), JSON.stringify(report, null, 2));
  const summary = {
    tempRoot: '<OS_TEMP_TEST_ROOT>', electronVersion: report.electronVersion, mainPid: report.mainPid, rendererPid: report.rendererPid,
    paths: reportPaths, startup, startupConsoleErrors: consoleErrors,
    searches: searches.map(search => ({
      query: search.query, groupCount: search.groups.length,
      providerCounts: Object.fromEntries(search.statuses.map(status => [status.provider, status.resultCount])),
      multiSourceGroups: search.groups.filter(group => group.sources.length > 1).map(group => ({
        title: group.title, sources: group.sources.map(item => item.provider)
      })),
      targetCandidates: search.groups.flatMap(group => group.sources.filter(item => ['animenosub', 'ohli24'].includes(item.provider))
        .map(item => ({ title: item.title, provider: item.provider, year: item.year, id: item.sourceId })))
    })),
    identityChecks, detailLinkage, standaloneDetails, sourceModeFlow, seasonRailLoad,
    playbackConnection: report.playbackConnection, linkAniExternalRequestSkipped: false,
    providerCatalogIpcCalls, providerDetailIpcCalls, providerResolveIpcCalls
  };
  console.log(`PATCH03_PROVIDER_LIVE_REPORT ${JSON.stringify(summary)}`);
  assert.equal(startup.homeVisible, true);
  assert.notEqual(startup.seasonRailChildren, null, 'the official season rail should exist');
  assert.equal(startup.seasonCalendarRemoved, true, 'the dedicated Patch 01 calendar is removed');
  assert.equal(startup.dropCaptionsElement, true, 'the official subtitle translation setting must remain available');
  assert.equal(consoleErrors.some(item => item.appRenderer && item.level >= 3
    && /Uncaught (?:TypeError|ReferenceError|SyntaxError)/.test(item.message)), false,
  'the app renderer must finish initialization without an uncaught JavaScript exception');
}

run().then(() => { setStage('test-completed'); app.quit(); }, error => {
  try {
    const safeError = {
      message: String(error?.message || error).replaceAll(tempRoot, '<OS_TEMP_TEST_ROOT>'),
      stack: String(error?.stack || '').replaceAll(tempRoot, '<OS_TEMP_TEST_ROOT>')
    };
    fs.writeFileSync(path.join(tempRoot, 'failure-report.json'), JSON.stringify({
      ...liveEvidence,
      electronVersion: process.versions.electron,
      executable: '<ELECTRON_BINARY>',
      mainPid: process.pid,
      rendererPid: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getOSProcessId() : null,
      windowIds: windows,
      lastStage,
      ipcCalls,
      providerCatalogIpcCalls,
      providerDetailIpcCalls,
      providerResolveIpcCalls,
      startupConsoleErrors: consoleErrors,
      error: safeError
    }, null, 2));
  } catch {}
  console.error(error?.stack || error);
  try { app.exit(1); } catch { process.exitCode = 1; }
});

setTimeout(() => {
  const pendingIpc = ipcCalls.filter(call => call.state === 'pending').map(({ channel, startedAt }) => ({ channel, elapsedMs: Date.now() - startedAt }));
  const pendingCatalog = providerCatalogIpcCalls.filter(call => call.state === 'pending').map(({ provider, startedAt }) => ({ provider, elapsedMs: Date.now() - startedAt }));
  const pendingDetail = providerDetailIpcCalls.filter(call => call.state === 'pending').map(({ provider, sourceId, startedAt }) => ({ provider, sourceId, elapsedMs: Date.now() - startedAt }));
  const pendingResolve = providerResolveIpcCalls.filter(call => call.state === 'pending').map(({ provider, sourceAnimeId, episodeNumber, startedAt }) => ({ provider, sourceAnimeId, episodeNumber, elapsedMs: Date.now() - startedAt }));
  const timeoutReport = {
    timedOut: true, hardDeadlineMs, lastStage, pendingIpc, pendingCatalog, pendingDetail, pendingResolve,
    appPaths: Object.fromEntries(['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps'].map(name => [name, path.relative(tempRoot, app.getPath(name))])),
    mainPid: process.pid,
    rendererPid: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getOSProcessId() : null
  };
  try { fs.writeFileSync(path.join(tempRoot, 'hard-timeout-report.json'), JSON.stringify(timeoutReport, null, 2)); } catch {}
  setStage('hard-deadline', timeoutReport);
  app.exit(124);
}, hardDeadlineMs);
