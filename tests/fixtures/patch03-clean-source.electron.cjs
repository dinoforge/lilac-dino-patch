const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain } = require('electron');

const root = path.resolve(process.env.PATCH03_TEST_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-clean-patch03-')));
assert.equal(path.dirname(root), path.resolve(os.tmpdir()), 'validation profile must be directly under OS Temp');
assert.match(path.basename(root), /^lilac-clean-patch03-[a-z0-9-]+$/i);
const paths = Object.fromEntries(['appData', 'userData', 'sessionData'].map(key => [key, path.join(root, key)]));
for (const value of Object.values(paths)) fs.mkdirSync(value, { recursive: true });
assert.equal(new Set(Object.values(paths).map(value => path.resolve(value))).size, 3);
for (const [key, value] of Object.entries(paths)) app.setPath(key, value);
for (const [key, value] of Object.entries(paths)) assert.equal(path.resolve(app.getPath(key)), path.resolve(value));
app.disableHardwareAcceleration();

const logFile = path.join(root, `electron-${process.pid}.jsonl`);
const calls = { catalog: [], detail: [], resolve: [] };
const windows = [];
let mainWindow = null;
let loadCount = 0;
const errors = [];
function safeError(error) {
  const cause = error?.cause;
  return {
    name: String(error?.name || 'Error'),
    code: String(error?.code || cause?.code || ''),
    message: String(error?.message || error).split('\n')[0].replace(/https?:\/\/[^\s"'<>]+/g, '[url redacted]').slice(0, 240)
  };
}
function stage(name, data = {}) {
  const row = { at: new Date().toISOString(), stage: name, pid: process.pid, electron: process.versions.electron, ...data };
  fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`);
  console.log(`PATCH03_CLEAN ${JSON.stringify(row)}`);
  return row;
}
process.on('uncaughtExceptionMonitor', error => stage('uncaught-exception', safeError(error)));
process.on('unhandledRejection', error => stage('unhandled-rejection', safeError(error)));
app.on('child-process-gone', (_event, details) => stage('child-process-gone', { type: details?.type, reason: details?.reason, exitCode: details?.exitCode }));
app.on('browser-window-created', (_event, win) => {
  windows.push(win);
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) {
      const item = { level, message: String(message).replace(/https?:\/\/[^\s"'<>]+/g, '[url redacted]').slice(0, 240) };
      errors.push(item); stage('renderer-console-error', item);
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => stage('renderer-process-gone', { reason: details?.reason, exitCode: details?.exitCode }));
  win.webContents.on('did-finish-load', () => {
    if (/\/src\/index\.html(?:$|[?#])/.test(win.webContents.getURL())) {
      mainWindow = win; loadCount++;
      stage('renderer-load-finished', { loadCount, windowId: win.id, webContentsId: win.webContents.id });
    }
  });
});

const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (!['provider:catalog', 'provider:detail', 'provider:resolve'].includes(channel)) return originalHandle(channel, listener);
  return originalHandle(channel, async (event, ...args) => {
    const startedAt = Date.now();
    const record = { channel, state: 'pending', startedAt };
    if (channel === 'provider:catalog') {
      record.provider = String(args[0] || '');
      record.query = String(args[1] || '');
      calls.catalog.push(record);
      stage('provider-catalog-start', { provider: record.provider, query: record.query });
    } else if (channel === 'provider:detail') {
      const anime = args[0] || {};
      record.provider = String(anime.provider || '');
      record.sourceId = String(anime.mal_id || anime.id || '');
      calls.detail.push(record);
      stage('provider-detail-start', { provider: record.provider, sourceId: record.sourceId });
    } else {
      const episode = args[0] || {};
      record.provider = String(episode.provider || '');
      record.sourceAnimeId = String(episode.animeId || episode.anime_id || '');
      record.episodeNumber = episode.number ?? null;
      calls.resolve.push(record);
      stage('provider-resolve-start', { provider: record.provider, sourceAnimeId: record.sourceAnimeId, episodeNumber: record.episodeNumber });
    }
    try {
      const result = await listener(event, ...args);
      record.state = 'resolved';
      if (channel === 'provider:catalog') record.resultCount = Array.isArray(result?.data) ? result.data.length : null;
      if (channel === 'provider:detail') record.episodeCount = Array.isArray(result?.episodes) ? result.episodes.length : null;
      if (channel === 'provider:resolve') {
        record.hasStream = Boolean(result?.url);
        record.hls = typeof result?.hls === 'boolean' ? result.hls : null;
      }
      return result;
    } catch (error) {
      record.state = 'failed'; record.error = safeError(error);
      throw error;
    } finally {
      record.durationMs = Date.now() - startedAt;
      stage(`${channel.replace(':', '-')}-finished`, { provider: record.provider, state: record.state, durationMs: record.durationMs,
        resultCount: record.resultCount ?? null, episodeCount: record.episodeCount ?? null, hasStream: record.hasStream ?? null, error: record.error || null });
    }
  });
};

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await pause(200);
  }
  throw new Error(`Timed out at ${label} after ${timeoutMs}ms`);
}
async function evaluate(source, timeoutMs = 30000) {
  assert.ok(mainWindow && !mainWindow.isDestroyed(), 'application main window must exist');
  try {
    return await Promise.race([
      mainWindow.webContents.executeJavaScript(source),
      new Promise((_, reject) => setTimeout(() => reject(new Error('renderer evaluation timed out')), timeoutMs))
    ]);
  } catch (error) {
    stage('renderer-evaluation-failed', { snippet: String(source).slice(0, 220), error: safeError(error) });
    throw error;
  }
}
async function rendererLoadedAfter(previous, label) {
  await waitFor(() => mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading() && loadCount > previous, 25000, label);
  await pause(150);
}

async function run() {
  stage('isolated-paths-verified', { paths: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(value)])) });
  require('../electron/main.cjs');
  await app.whenReady();
  await waitFor(() => mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading(), 45000, 'official main window and renderer load');
  stage('official-main-window-ready', { windowId: mainWindow.id, webContentsId: mainWindow.webContents.id, loadCount });
  stage('renderer-evaluation-sanity', { result: await evaluate('1 + 1') });
  const originalSettings = await evaluate(`(() => ({
    bridge: window.__dinoPatch03Bridge?.active === true,
    providerOptions: [...document.querySelectorAll('#contentSource option')].map(item => item.value),
    providerButtons: [...document.querySelectorAll('#sourceChoices button')].map(item => item.dataset.value),
    source: state.source,
    dialogCount: document.querySelectorAll('#detailDialog').length,
    officialSchedule: Boolean(document.querySelector('#scheduleSection #scheduleTabs') && document.querySelector('#scheduleRail')),
    sevenColumnView: Boolean(document.querySelector('#seasonCalendarView'))
  }))()`);
  assert.equal(originalSettings.bridge, true, 'Patch 03 bridge must load against the clean official renderer');
  assert.ok(originalSettings.providerOptions.includes('integrated'));
  assert.ok(originalSettings.providerOptions.includes('linkkf'));
  assert.ok(originalSettings.providerButtons.includes('integrated'));
  assert.ok(originalSettings.providerButtons.includes('linkkf'));
  assert.equal(originalSettings.dialogCount, 1);
  stage('clean-renderer-ready', originalSettings);

  const verifyOnly = process.argv.includes('--verify-integrated');
  if (verifyOnly) {
    const persisted = await evaluate(`(() => ({
      savedMode: localStorage.getItem('contentSource'),
      savedProvider: localStorage.getItem('contentSourceProvider'),
      selectedSetting: document.querySelector('#contentSource').value,
      stateProvider: state.source,
      bridgeMode: window.__dinoPatch03Bridge.getMode()
    }))()`);
    assert.equal(persisted.savedMode, 'integrated');
    assert.equal(persisted.selectedSetting, 'integrated');
    assert.equal(persisted.bridgeMode, 'integrated');
    assert.equal(persisted.stateProvider, persisted.savedProvider);
    stage('integrated-setting-restored-after-new-process', persisted);
    return;
  }

  const initialProvider = await evaluate(`state.source`);
  const beforeSettingReload = loadCount;
  const clicked = await evaluate(`(() => { const button=document.querySelector('#sourceChoices button[data-value="integrated"]'); if(!button)return false;button.click();return true })()`);
  assert.equal(clicked, true);
  await rendererLoadedAfter(beforeSettingReload, 'integrated setting reload');
  const integratedState = await evaluate(`({mode:localStorage.getItem('contentSource'),last:localStorage.getItem('contentSourceProvider'),setting:document.querySelector('#contentSource').value,state:state.source})`);
  assert.equal(integratedState.mode, 'integrated');
  assert.equal(integratedState.setting, 'integrated');
  assert.equal(integratedState.last, initialProvider);
  assert.equal(integratedState.state, initialProvider);
  stage('integrated-setting-selected', integratedState);

  const catalogStart = calls.catalog.length;
  const searchResult = await evaluate(`window.doSearch('Frieren: Beyond Journey’s End Season 2').then(() => ({
    cards: document.querySelectorAll('#searchGrid .anime-card').length,
    filters: [...document.querySelectorAll('#searchProviderFilters button')].map(button => ({provider:button.dataset.provider,state:button.dataset.state,text:button.textContent})),
    status: document.querySelector('#searchStatus').textContent,
    groups: window.__dinoPatch03Bridge.getSearchSnapshot()
  }))`, 200000);
  const integratedCatalogCalls = calls.catalog.slice(catalogStart);
  stage('integrated-search-finished', { cardCount: searchResult.cards, filters: searchResult.filters, status: searchResult.status,
    providersCalled: [...new Set(integratedCatalogCalls.map(call => call.provider))], callCount: integratedCatalogCalls.length,
    groupedSourceCounts: searchResult.groups.map(group => group.sourceItems.length) });
  assert.deepEqual([...new Set(integratedCatalogCalls.map(call => call.provider))].sort(), ['animenosub', 'linkani', 'miruro', 'ohli24', 'reanime'].sort(),
    'integrated query must use the five Patch 03 sources and exclude Linkkf');
  assert.ok(searchResult.filters.some(item => item.provider === 'all'));

  const candidate = searchResult.groups.find(group => group.sourceItems.length > 1) || searchResult.groups[0];
  let selectedDetail = null;
  if (candidate) {
    const primary = candidate.sourceItems[0];
    const detailStart = calls.detail.length;
    await evaluate(`window.openDetail(${JSON.stringify(primary.sourceId)})`, 90000);
    if (candidate.sourceItems.length > 1) {
      await waitFor(() => evaluate(`Boolean(document.querySelector('#detailContent .detail-actions') && document.querySelector('#detailContent .detail-source-picker'))`),
        30000, 'grouped detail picker render');
    }
    selectedDetail = await evaluate(`({
      hasDetailActions: Boolean(document.querySelector('#detailContent .detail-actions')),
      pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
      sourceIds: [...document.querySelectorAll('#detailContent [data-provider-source]')].map(button=>button.dataset.providerSource),
      episodeRows: document.querySelectorAll('#episodeBlock .episode-btn').length,
      title: document.querySelector('#detailContent .detail-info h1')?.textContent || ''
    })`);
    if (candidate.sourceItems.length > 1 && selectedDetail.hasDetailActions) {
      assert.equal(selectedDetail.pickerCount, 1, 'grouped sources must use one existing detail dialog picker');
      assert.equal(selectedDetail.sourceIds.length, candidate.sourceItems.length);
      const nextSource = candidate.sourceItems.find(item => item.sourceId !== primary.sourceId);
      const switchStart = calls.detail.length;
      const sourceButtonClicked = await evaluate(`(() => {
        const button = [...document.querySelectorAll('#detailContent [data-provider-source]')]
          .find(item => item.dataset.providerSource === ${JSON.stringify(nextSource.sourceId)});
        if (!button) return false;
        button.click();
        return true;
      })()`);
      assert.equal(sourceButtonClicked, true, 'the existing detail source picker must switch providers');
      await waitFor(() => calls.detail.slice(switchStart).some(call => call.sourceId === nextSource.sourceId && call.state !== 'pending'), 90000, 'selected provider detail IPC');
      await waitFor(() => evaluate(`document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource === ${JSON.stringify(nextSource.sourceId)} && document.querySelectorAll('#episodeBlock .episode-btn').length > 0`),
        30000, 'selected provider detail render');
      selectedDetail = await evaluate(`({
        hasDetailActions: Boolean(document.querySelector('#detailContent .detail-actions')),
        pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
        activeId: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || '',
        episodeRows: document.querySelectorAll('#episodeBlock .episode-btn').length,
        title: document.querySelector('#detailContent .detail-info h1')?.textContent || ''
      })`);
      if (selectedDetail.hasDetailActions) {
        assert.equal(selectedDetail.pickerCount, 1);
        assert.equal(selectedDetail.activeId, nextSource.sourceId);
      }
    }
    stage('integrated-group-detail', { providers: candidate.sourceItems.map(item => item.provider), sourceIds: candidate.sourceItems.map(item => item.sourceId), selectedDetail,
      detailCalls: calls.detail.slice(detailStart).map(call => ({ provider: call.provider, state: call.state, episodeCount: call.episodeCount ?? null, durationMs: call.durationMs ?? null })) });
  } else {
    stage('integrated-group-detail-not-available', { reason: 'external provider searches returned no result cards' });
  }

  let playback = { attempted: false, result: 'not run' };
  if (candidate && selectedDetail?.episodeRows > 0) {
    playback.attempted = true;
    const beforeResolve = calls.resolve.length;
    await evaluate(`document.querySelector('#episodeBlock .episode-btn:not(:disabled)')?.click()`);
    await waitFor(() => calls.resolve.slice(beforeResolve).some(call => call.state !== 'pending'), 100000, 'official provider:resolve');
    const resolve = calls.resolve.slice(beforeResolve)[0];
    const beforeTime = await evaluate(`({time:document.querySelector('#video')?.currentTime||0,width:document.querySelector('#video')?.videoWidth||0,height:document.querySelector('#video')?.videoHeight||0,paused:document.querySelector('#video')?.paused??true})`);
    await pause(5000);
    const afterTime = await evaluate(`({time:document.querySelector('#video')?.currentTime||0,width:document.querySelector('#video')?.videoWidth||0,height:document.querySelector('#video')?.videoHeight||0,paused:document.querySelector('#video')?.paused??true})`);
    playback = { attempted: true, provider: resolve?.provider || '', resolveState: resolve?.state || 'not observed', hasStream: resolve?.hasStream || false,
      beforeTime, afterTime, actuallyPlaying: afterTime.time > beforeTime.time + 0.5 && afterTime.width > 0 && afterTime.height > 0 };
    stage('official-playback-path', playback);
  }

  const providerStart = calls.catalog.length;
  const beforeProviderReload = loadCount;
  await evaluate(`(() => { const select=document.querySelector('#contentSource');select.value='reanime';select.dispatchEvent(new Event('change'));return true })()`);
  await rendererLoadedAfter(beforeProviderReload, 'individual provider setting reload');
  const individualState = await evaluate(`({mode:localStorage.getItem('contentSource'),setting:document.querySelector('#contentSource').value,state:state.source,bridgeMode:window.__dinoPatch03Bridge.getMode()})`);
  assert.equal(individualState.mode, 'reanime');
  assert.equal(individualState.setting, 'reanime');
  assert.equal(individualState.state, 'reanime');
  const individualSearchStart = calls.catalog.length;
  await evaluate(`window.doSearch('Frieren: Beyond Journey’s End Season 2')`, 90000);
  const individualProviders = [...new Set(calls.catalog.slice(individualSearchStart).map(call => call.provider))];
  assert.ok(individualProviders.every(provider => provider === 'reanime'), `individual mode called other provider(s): ${individualProviders.join(',')}`);
  stage('individual-mode-restored', { state: individualState, providersCalled: individualProviders,
    integratedStartupCatalogCalls: calls.catalog.slice(providerStart, individualSearchStart).map(call => call.provider) });

  const beforeIntegratedReload = loadCount;
  await evaluate(`(() => { const select=document.querySelector('#contentSource');select.value='integrated';select.dispatchEvent(new Event('change'));return true })()`);
  await rendererLoadedAfter(beforeIntegratedReload, 'integrated setting final persistence reload');
  stage('integrated-mode-persisted-for-restart', await evaluate(`({mode:localStorage.getItem('contentSource'),last:localStorage.getItem('contentSourceProvider'),state:state.source,setting:document.querySelector('#contentSource').value})`));
  stage('first-process-summary', { integratedProvidersCalled: [...new Set(integratedCatalogCalls.map(call => call.provider))],
    individualProviders, groupFound: Boolean(candidate), selectedDetail, playback, consoleErrorCount: errors.length,
    ipc: { catalog: calls.catalog.length, detail: calls.detail.length, resolve: calls.resolve.length }, logFile });
}

const hardDeadline = setTimeout(() => { stage('hard-deadline'); app.exit(124); }, 240000);
run().then(() => { clearTimeout(hardDeadline); stage('test-completed'); app.quit(); }, error => {
  clearTimeout(hardDeadline);
  stage('test-failed', { name: error?.name, message: String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/g, '[url redacted]').slice(0, 500),
    stack: String(error?.stack || '').split('\n').slice(0, 5).join('\n'), ipc: { catalog: calls.catalog.length, detail: calls.detail.length, resolve: calls.resolve.length }, logFile });
  process.exitCode = 1; app.quit();
});
