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
recordStage('electron-script-start', { executable: process.execPath, nodeVersion: process.versions.node, tempRoot });
if (configuredTempRoot) {
  assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()), 'shared test profile must live directly under OS Temp');
  assert.match(path.basename(tempRoot), /^dino-patch03-source-mode-[a-z0-9-]+$/i, 'shared profile must use the dedicated test prefix');
  const stat = fs.lstatSync(tempRoot);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'shared profile root must be a real directory');
}
const paths = Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.join(tempRoot, name)]));
for (const value of Object.values(paths)) fs.mkdirSync(value, { recursive: true });
for (const [name, value] of Object.entries(paths)) app.setPath(name, value);
for (const [name, value] of Object.entries(paths)) assert.equal(path.resolve(app.getPath(name)), path.resolve(value));
assert.ok(path.resolve(app.getPath('userData')).startsWith(path.resolve(os.tmpdir())));
assert.ok(path.resolve(app.getPath('sessionData')).startsWith(path.resolve(os.tmpdir())));
recordStage('isolated-paths-verified', { paths: Object.fromEntries(Object.entries(paths).map(([name, value]) => [name, path.resolve(value)])) });
app.disableHardwareAcceleration();

const consoleErrors = [], windows = [], ipcCalls = [], providerDetailIpcCalls = [], providerCatalogIpcCalls = [];
const liveEvidence = { tempRoot, paths };
let mainWindow, rendererLoadCount = 0;
let lastStage = 'isolated-paths-verified';
const hardDeadlineMs = Math.max(30000, Number(process.env.PATCH03_HARD_DEADLINE_MS) || 150000);
function setStage(stage, details = {}) { lastStage = stage; return recordStage(stage, details); }
process.on('uncaughtExceptionMonitor', error => setStage('main-uncaught-exception', { message: String(error?.message || error), stack: String(error?.stack || '').split('\n').slice(0, 8).join('\n') }));
process.on('unhandledRejection', reason => setStage('main-unhandled-rejection', { message: String(reason?.message || reason), stack: String(reason?.stack || '').split('\n').slice(0, 8).join('\n') }));
process.on('exit', code => recordStage('main-process-exit', { code, lastStage }));
app.on('child-process-gone', (_event, details) => setStage('child-process-gone', details));
app.on('ready', () => setStage('app-ready', { appPaths: Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.resolve(app.getPath(name))])) }));
app.on('before-quit', () => setStage('app-before-quit'));
app.on('will-quit', () => setStage('app-will-quit'));
app.on('browser-window-created', (_event, win) => {
  windows.push({ id: win.id, webContentsId: win.webContents.id });
  setStage('browser-window-created', { windowId: win.id, webContentsId: win.webContents.id, rendererPid: win.webContents.getOSProcessId() });
  win.webContents.on('did-start-loading', () => setStage('renderer-load-start', { windowId: win.id, url: win.webContents.getURL() }));
  win.webContents.on('dom-ready', () => setStage('renderer-dom-ready', { windowId: win.id, url: win.webContents.getURL() }));
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const error = { level, message: String(message).replace(/https?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, 'https://$1/[path redacted]'), line, sourceId };
      consoleErrors.push(error); setStage('renderer-console-error', { windowId: win.id, ...error });
    }
  });
  win.webContents.on('did-finish-load', () => {
    setStage('renderer-load-finished', { windowId: win.id, url: win.webContents.getURL() });
    if (/\/src\/index\.html(?:$|[?#])/.test(win.webContents.getURL())) { mainWindow = win; rendererLoadCount++; }
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => setStage('renderer-load-failed', {
    windowId: win.id, errorCode, errorDescription, url: String(validatedURL || '').replace(/https?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, 'https://$1/[path redacted]'), isMainFrame
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
function assertEpisodeInfo(text, count) {
  assert.ok(String(text || '').startsWith(`회차 ${count}개`), 'the mini summary count must match the loaded provider episode list');
  assert.match(String(text || ''), /재생 시 확인/, 'unplayed episodes must not imply playback success');
  assert.doesNotMatch(String(text || ''), /\b(?:1080p|720p|HLS|MP4|이어보기)\b/, 'a fresh isolated profile has no verified playback facts');
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
    await selectSourceSetting('integrated', 'select integrated content source', `state.contentSourceMode === 'integrated'
      && localStorage.getItem('contentSource') === 'integrated'
      && document.querySelector('#contentSource')?.value === 'integrated'`);
  } else if (sourceModeTest === 'verify') {
    await waitFor(() => evaluate(`state.contentSourceMode === 'integrated'
      && localStorage.getItem('contentSource') === 'integrated'
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
    contentSourceMode: state.contentSourceMode,
    contentSourceSetting: document.querySelector('#contentSource')?.value || '',
    savedContentSource: localStorage.getItem('contentSource') || '',
    activeProvider: state.source,
    savedIndividualProvider: localStorage.getItem('contentSourceProvider') || ''
  }))()`, 'startup checks');
  liveEvidence.startup = startup;
  if (sourceModeTest === 'verify') {
    assert.equal(startup.contentSourceMode, 'integrated');
    assert.equal(startup.contentSourceSetting, 'integrated');
    assert.equal(startup.savedContentSource, 'integrated');
    const expectedProvider = process.env.PATCH03_EXPECTED_INDIVIDUAL_PROVIDER || 'miruro';
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
        query: currentSearchQuery,
        groups: currentSearchGroups.map(group => ({
          title: group.title,
          groupKey: group.groupKey,
          sources: (group.sourceItems || []).map(item => ({
            provider: item.provider, id: item.id, sourceId: item.mal_id,
            title: item.title, titleEnglish: item.title_english || '', titleJapanese: item.title_japanese || '',
            year: item.year || '', type: item.type || '', anilistId: item.anilistId || null, malId: item.malId || null,
            availableEpisodes: item.availableEpisodes || null
          }))
        })),
        statuses: currentSearchStatuses,
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
    const targetProvider = process.env.PATCH03_VERIFY_PROVIDER || 'animenosub';
    const expectedAnilistId = Number(process.env.PATCH03_EXPECTED_ANILIST_ID) || 0;
    const counterpartProviders = targetProvider === 'miruro' ? ['reanime'] : targetProvider === 'reanime' ? ['miruro'] : ['reanime', 'miruro'];
    const group = search?.groups.find(item => item.sources.some(source => source.provider === targetProvider)
      && (!expectedAnilistId || item.sources.some(source => Number(source.anilistId) === expectedAnilistId))
      && counterpartProviders.some(provider => item.sources.some(source => source.provider === provider)));
    if (!group) console.log(`PATCH03_GROUP_DIAGNOSTIC ${JSON.stringify({ targetProvider, query: search?.query, statuses: search?.statuses, groups: search?.groups.map(item => ({ title: item.title, sources: item.sources.map(source => ({ provider: source.provider, title: source.title, year: source.year, type: source.type, anilistId: source.anilistId, malId: source.malId, sourceId: source.sourceId })) })) })}`);
    assert.ok(group, `live search must group the ${targetProvider} candidate with a catalog source`);
    const target = group.sources.find(source => source.provider === targetProvider);
    await evaluate(`openDetail(${JSON.stringify(group.mal_id)}, { groupKey: ${JSON.stringify(group.groupKey)} })`, 'open grouped source detail');
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
      const currentId = window.openDetail?.currentSourceId || '';
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
      sources: [...document.querySelectorAll('#detailContent [data-detail-source]')].map(button => ({
        id: button.dataset.detailSource, label: button.textContent.trim(), active: button.getAttribute('aria-pressed') === 'true'
      }))
      });
    })()`, 'initial source picker and detail diagnostics');
    before.providerDetailCalls = providerDetailIpcCalls.slice();
    before.detailCall = [...providerDetailIpcCalls].reverse().find(call => call.sourceId === before.currentSourceId)
      || providerDetailIpcCalls.at(-1) || null;
    liveEvidence.initialDetail = before;
    liveEvidence.providerDetailIpcCalls = providerDetailIpcCalls;
    if (initialWaitError || before.detailError || !before.detailCall || before.detailCall.state !== 'resolved') {
      const partial = { tempRoot, paths, electronVersion: process.versions.electron, executable: process.execPath,
        mainPid: process.pid, rendererPid: mainWindow.webContents.getOSProcessId(), windowIds: windows,
        startup, startupConsoleErrors: consoleErrors, searches, identityChecks, detailLinkage: { before },
        initialWaitError, linkAniExternalRequestSkipped: false, providerDetailIpcCalls };
      fs.writeFileSync(path.join(tempRoot, 'report.json'), JSON.stringify(partial, null, 2));
      console.log(`PATCH03_PROVIDER_LIVE_DIAGNOSTIC ${JSON.stringify({ before, initialWaitError, tempRoot })}`);
      throw new Error(`Initial ${before.detailCall?.provider || 'provider'} detail did not load: ${before.detailErrorText || initialWaitError || before.detailCall?.state}`);
    }
    const switched = await evaluate(`(() => {
      const button = [...document.querySelectorAll('#detailContent [data-detail-source]')]
        .find(item => item.dataset.detailSource === ${JSON.stringify(target.sourceId)});
      if (!button) return false;
      button.click(); return true;
    })()`, `select live ${targetProvider} source`);
    assert.equal(switched, true, `grouped detail must expose the live ${targetProvider} candidate`);
    await waitFor(() => evaluate(`Boolean(window.openDetail?.currentSourceId === ${JSON.stringify(target.sourceId)}
      && (document.querySelector('#detailContent #episodeBlock .episode-section')
        || document.querySelector('#detailContent .detail-playback-info')?.textContent?.length > 0))`, `${targetProvider} detail after source switch`), 30000, `${targetProvider} detail result`);
    const after = await evaluate(`(() => ({
      sourceId: window.openDetail?.currentSourceId || '',
      title: document.querySelector('#detailContent h1')?.textContent || '',
      pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
      activeSourceId: document.querySelector('#detailContent [data-detail-source][aria-pressed="true"]')?.dataset.detailSource || '',
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
    detailLinkage = { groupKey: group.groupKey, providers: group.sources.map(source => source.provider), targetId: target.sourceId, before, after };
    assert.equal(before.pickerCount, 1);
    assert.equal(after.pickerCount, 1);
    assert.equal(after.sourceId, target.sourceId);
    assert.equal(after.activeSourceId, target.sourceId, 'the active selector and loaded source ID must agree');
    assert.ok(after.episodeHeadingCount > 0, 'the selected provider must render its real episode count');
    assert.equal(after.episodeRows, after.episodeHeadingCount, 'the displayed rows and selected provider count must agree');
    assert.equal(after.providerDetailCall?.episodeCount, after.episodeHeadingCount, 'the displayed count must match the actual provider:detail IPC response');
    assertEpisodeInfo(after.playbackInfoText, after.episodeHeadingCount);
    assert.equal(after.detailError, '', 'the selected provider detail must not show an error');

    const sourceSwitchMatrix = [
      { provider: before.detailCall.provider, sourceId: before.currentSourceId, state: before.detailCall.state, episodeCount: before.episodeHeadingCount, pickerCount: before.pickerCount },
      { provider: targetProvider, sourceId: after.sourceId, state: after.providerDetailCall?.state || 'no-ipc', episodeCount: after.episodeHeadingCount, pickerCount: after.pickerCount }
    ];
    for (const provider of ['reanime', 'miruro', 'ohli24']) {
      const candidate = group.sources.find(source => source.provider === provider);
      if (!candidate || provider === before.detailCall.provider || provider === targetProvider) continue;
      const clickAccepted = await evaluate(`(() => {
        const button = [...document.querySelectorAll('#detailContent [data-detail-source]')]
          .find(item => item.dataset.detailSource === ${JSON.stringify(candidate.sourceId)});
        if (!button) return false; button.click(); return true;
      })()`, `select matched ${provider} source`);
      assert.equal(clickAccepted, true, `the existing selector must expose the matched ${provider} source`);
      await waitFor(() => evaluate(`Boolean(window.openDetail?.currentSourceId === ${JSON.stringify(candidate.sourceId)}
        && (document.querySelector('#episodeBlock .episode-section')
          || document.querySelector('#detailContent .detail-playback-info')?.textContent?.length > 0))`, `${provider} source settled`), 30000, `${provider} source result`);
      const result = await evaluate(`(() => ({
        sourceId: window.openDetail?.currentSourceId || '',
        activeSourceId: document.querySelector('#detailContent [data-detail-source][aria-pressed="true"]')?.dataset.detailSource || '',
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
        assertEpisodeInfo(result.playbackInfoText, result.episodeCount);
      }
      sourceSwitchMatrix.push({ provider, sourceId: candidate.sourceId, state: call?.state || (result.error ? 'error-ui' : 'no-ipc'), episodeCount: result.episodeCount, episodeRows: result.episodeRows, pickerCount: result.pickerCount, playbackInfoText: result.playbackInfoText, error: result.error, detailCall: call });
    }

    const rapidCandidates = ['reanime', 'miruro'].map(provider => group.sources.find(source => source.provider === provider)).filter(Boolean);
    let rapidSwitch = { state: rapidCandidates.length === 2 ? 'not-run' : 'not-available-in-matched-group' };
    if (rapidCandidates.length === 2) {
      const [first, last] = rapidCandidates;
      const callOffset = providerDetailIpcCalls.length;
      const rapidClicked = await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('#detailContent [data-detail-source]')];
        const first = buttons.find(item => item.dataset.detailSource === ${JSON.stringify(first.sourceId)});
        const last = buttons.find(item => item.dataset.detailSource === ${JSON.stringify(last.sourceId)});
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
      const finalState = await evaluate(`(() => ({
        sourceId: window.openDetail?.currentSourceId || '',
        activeSourceId: document.querySelector('#detailContent [data-detail-source][aria-pressed="true"]')?.dataset.detailSource || '',
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
        assertEpisodeInfo(finalState.playbackInfoText, lastCall.episodeCount);
      }
    }
    detailLinkage.sourceSwitchMatrix = sourceSwitchMatrix;
    detailLinkage.rapidSwitch = rapidSwitch;

    const initialProvider = before.detailCall.provider;
    if (initialProvider !== targetProvider && ['reanime', 'miruro'].includes(initialProvider) && ['reanime', 'miruro'].includes(targetProvider)) {
      const initialSource = before.sources.find(source => source.active);
      const returnButton = await evaluate(`(() => {
        const button = [...document.querySelectorAll('#detailContent [data-detail-source]')]
          .find(item => item.dataset.detailSource === ${JSON.stringify(initialSource?.id || '')});
        if (!button) return false;
        button.click(); return true;
      })()`, `return to live ${initialProvider} source`);
      assert.equal(returnButton, true, `the picker must allow returning to ${initialProvider}`);
      await waitFor(() => evaluate(`Boolean(window.openDetail?.currentSourceId === ${JSON.stringify(initialSource.id)}
        && (document.querySelector('#episodeBlock .episode-section')
          || document.querySelector('#detailContent .detail-playback-info')?.textContent?.length > 0))`, 'returned source detail result'), 30000, `${initialProvider} detail after return`);
      const returned = await evaluate(`(() => ({
        sourceId: window.openDetail?.currentSourceId || '',
        activeSourceId: document.querySelector('#detailContent [data-detail-source][aria-pressed="true"]')?.dataset.detailSource || '',
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
      assertEpisodeInfo(returned.playbackInfoText, returned.episodeHeadingCount);
      assert.equal(returned.detailError, '');
    }

    mainWindow.setSize(560, 820);
    await pause(400);
    detailLinkage.narrowWindow = await evaluate(`(() => {
      const dialog = document.querySelector('#detailDialog'), picker = document.querySelector('#detailContent .detail-source-picker');
      if (!dialog || !picker) return null;
      const d = dialog.getBoundingClientRect(), p = picker.getBoundingClientRect();
      return { viewportWidth: innerWidth, dialogWidth: Math.round(d.width), pickerWidth: Math.round(p.width),
        pickerClientWidth: picker.clientWidth, pickerScrollWidth: picker.scrollWidth,
        pickerButtons: [...picker.querySelectorAll('button')].map(button => ({
          left: Math.round(button.getBoundingClientRect().left - p.left), right: Math.round(button.getBoundingClientRect().right - p.left),
          clipped: button.getBoundingClientRect().left < p.left || button.getBoundingClientRect().right > p.right
        })) };
    })()`, 'narrow detail layout');
    liveEvidence.narrowWindow = detailLinkage.narrowWindow;
    assert.ok(detailLinkage.narrowWindow, 'the detail source picker must remain present in a narrow window');
    assert.ok(detailLinkage.narrowWindow.dialogWidth <= detailLinkage.narrowWindow.viewportWidth + 2,
      'the detail dialog must stay within the narrow viewport');
    assert.ok(detailLinkage.narrowWindow.pickerButtons.length > 0
      && detailLinkage.narrowWindow.pickerButtons.every(button => !button.clipped),
    'the source picker controls must remain visible without clipping');
    fs.writeFileSync(path.join(tempRoot, 'detail-narrow.png'), (await mainWindow.capturePage()).toPNG());
  }

  let sourceModeFlow = null;
  if (sourceModeTest === 'exercise') {
    const individualProvider = process.env.PATCH03_INDIVIDUAL_PROVIDER || 'miruro';
    assert.ok(['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'].includes(individualProvider),
      'individual return must use a Patch 03 provider');
    await selectSourceSetting(individualProvider, 'return to an individual content provider', `state.contentSourceMode === 'provider'
      && state.source === ${JSON.stringify(individualProvider)}
      && localStorage.getItem('contentSource') === ${JSON.stringify(individualProvider)}
      && document.querySelector('#contentSource')?.value === ${JSON.stringify(individualProvider)}`);
    const individualCallOffset = providerCatalogIpcCalls.length;
    const individualSearch = await evaluate(`(async () => {
      await doSearch(${JSON.stringify(process.env.PATCH03_LIVE_QUERY || '葬送のフリーレン')});
      return { query: currentSearchQuery, groupCount: currentSearchGroups.length,
        statuses: currentSearchStatuses.map(item => ({ provider: item.provider, resultCount: item.resultCount, error: item.error || '' })) };
    })()`, `individual ${individualProvider} search`);
    const individualCalls = providerCatalogIpcCalls.slice(individualCallOffset);
    const individualProviders = [...new Set(individualCalls.map(call => call.provider))].sort();
    assert.deepEqual(individualProviders, [individualProvider],
      'individual mode must call only the selected provider');
    assert.equal(individualCalls.some(call => call.provider === 'linkkf'), false,
      'Linkkf remains outside Patch 03 individual and integrated catalog calls');

    await selectSourceSetting('integrated', 'restore integrated content source', `state.contentSourceMode === 'integrated'
      && localStorage.getItem('contentSource') === 'integrated'
      && document.querySelector('#contentSource')?.value === 'integrated'`);
    sourceModeFlow = { individualProvider, individualSearch, individualProviderCalls: individualCalls,
      individualProviders, restoredMode: 'integrated', restoredProvider: await evaluate('state.source', 'preserved provider after returning to integrated') };
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
    tempRoot, paths, electronVersion: process.versions.electron, executable: process.execPath,
    mainPid: process.pid, rendererPid: mainWindow.webContents.getOSProcessId(), windowIds: windows,
    startup, startupConsoleErrors: consoleErrors, searches, identityChecks, detailLinkage, standaloneDetails, sourceModeFlow,
    linkAniExternalRequestSkipped: false, providerDetailIpcCalls
  };
  const reportFile = sourceModeTest ? `${sourceModeTest}-report.json` : 'report.json';
  fs.writeFileSync(path.join(tempRoot, reportFile), JSON.stringify(report, null, 2));
  const summary = {
    tempRoot, electronVersion: report.electronVersion, mainPid: report.mainPid, rendererPid: report.rendererPid,
    paths, startup, startupConsoleErrors: consoleErrors,
    searches: searches.map(search => ({
      query: search.query, groupCount: search.groups.length,
      providerCounts: Object.fromEntries(search.statuses.map(status => [status.provider, status.resultCount])),
      multiSourceGroups: search.groups.filter(group => group.sources.length > 1).map(group => ({
        title: group.title, sources: group.sources.map(item => item.provider)
      })),
      targetCandidates: search.groups.flatMap(group => group.sources.filter(item => ['animenosub', 'ohli24'].includes(item.provider))
        .map(item => ({ title: item.title, provider: item.provider, year: item.year, id: item.sourceId })))
    })),
    identityChecks, detailLinkage, standaloneDetails, sourceModeFlow, linkAniExternalRequestSkipped: false,
    providerCatalogIpcCalls, providerDetailIpcCalls
  };
  console.log(`PATCH03_PROVIDER_LIVE_REPORT ${JSON.stringify(summary)}`);
  assert.equal(startup.homeVisible, true);
  assert.notEqual(startup.seasonRailChildren, null, 'the official season rail should exist');
  assert.equal(startup.seasonCalendarRemoved, true, 'the dedicated Patch 01 calendar is removed');
  assert.equal(startup.dropCaptionsElement, false, 'the removed control should not be required');
  assert.equal(consoleErrors.some(item => /Uncaught (?:TypeError|ReferenceError|SyntaxError)/.test(item.message)), false,
    'the renderer must finish initialization without an uncaught JavaScript exception');
}

run().then(() => { setStage('test-completed'); app.quit(); }, error => {
  try {
    const safeError = { message: String(error?.message || error), stack: String(error?.stack || '') };
    fs.writeFileSync(path.join(tempRoot, 'failure-report.json'), JSON.stringify({
      ...liveEvidence,
      electronVersion: process.versions.electron,
      executable: process.execPath,
      mainPid: process.pid,
      rendererPid: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getOSProcessId() : null,
      windowIds: windows,
      lastStage,
      ipcCalls,
      providerCatalogIpcCalls,
      providerDetailIpcCalls,
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
  const timeoutReport = {
    timedOut: true, hardDeadlineMs, lastStage, pendingIpc, pendingCatalog, pendingDetail,
    appPaths: Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.resolve(app.getPath(name))])),
    mainPid: process.pid,
    rendererPid: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getOSProcessId() : null
  };
  try { fs.writeFileSync(path.join(tempRoot, 'hard-timeout-report.json'), JSON.stringify(timeoutReport, null, 2)); } catch {}
  setStage('hard-deadline', timeoutReport);
  app.exit(124);
}, hardDeadlineMs);
