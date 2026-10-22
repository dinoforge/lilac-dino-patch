// Focused live provider-detail smoke. Reports omit provider URLs and profile data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-patch03-live-'));
const paths = Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.join(tempRoot, name)]));
for (const value of Object.values(paths)) fs.mkdirSync(value, { recursive: true });
for (const [name, value] of Object.entries(paths)) app.setPath(name, value);
for (const [name, value] of Object.entries(paths)) assert.equal(path.resolve(app.getPath(name)), path.resolve(value));
assert.ok(path.resolve(app.getPath('userData')).startsWith(path.resolve(os.tmpdir())));
assert.ok(path.resolve(app.getPath('sessionData')).startsWith(path.resolve(os.tmpdir())));
app.disableHardwareAcceleration();

const consoleErrors = [], windows = [], providerDetailIpcCalls = [];
const liveEvidence = { tempRoot, paths };
let mainWindow;
app.on('browser-window-created', (_event, win) => {
  windows.push({ id: win.id, webContentsId: win.webContents.id });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) consoleErrors.push({ level, message, line, sourceId });
  });
  win.webContents.on('did-finish-load', () => {
    if (/\/src\/index\.html(?:$|[?#])/.test(win.webContents.getURL())) mainWindow = win;
  });
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await pause(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function evaluate(code, label) {
  assert.ok(mainWindow && !mainWindow.isDestroyed(), `main window required for ${label}`);
  try {
    return await mainWindow.webContents.executeJavaScript(code);
  } catch (error) {
    throw new Error(`Renderer evaluation failed at ${label}: ${String(error?.message || error)}`);
  }
}

async function run() {
  const originalIpcHandle = ipcMain.handle.bind(ipcMain);
  const instrumentedIpcHandle = (channel, listener) => {
    if (channel !== 'provider:detail') return originalIpcHandle(channel, listener);
    return originalIpcHandle(channel, async (event, anime, ...args) => {
      const call = {
        provider: String(anime?.provider || ''),
        sourceId: String(anime?.mal_id || anime?.id || ''),
        title: String(anime?.title || ''),
        state: 'pending',
        startedAt: Date.now()
      };
      providerDetailIpcCalls.push(call);
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
      }
    });
  };
  ipcMain.handle = instrumentedIpcHandle;
  assert.equal(ipcMain.handle, instrumentedIpcHandle, 'the live harness must observe provider:detail IPC before starting the app');
  require('../electron/main.cjs');
  await app.whenReady();
  await waitFor(() => mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading(), 30000, 'isolated app renderer');
  await pause(1200);

  const startup = await evaluate(`(() => ({
    title: document.title,
    homeVisible: document.querySelector('#homeView')?.classList.contains('active') === true,
    seasonCards: document.querySelectorAll('#seasonRail .anime-card').length,
    seasonRailChildren: document.querySelector('#seasonRail')?.children.length ?? null,
    seasonStatus: document.querySelector('#quarterStatus')?.textContent || '',
    dropCaptionsElement: Boolean(document.querySelector('#dropCaptions')),
    calendarEntry: Boolean(document.querySelector('#seeAllSeason')),
    seasonCalendarRemoved: !document.querySelector('#seasonCalendarView') && typeof window.LilacSeasonCalendar === 'undefined',
    allExplorer: Boolean(document.querySelector('#allView #catalogFilters'))
  }))()`, 'startup checks');
  liveEvidence.startup = startup;

  const searches = [];
  if (process.env.PATCH03_SKIP_PROVIDER_SEARCH !== '1') {
    const queries = process.env.PATCH03_LIVE_QUERY
      ? [process.env.PATCH03_LIVE_QUERY]
      : ['葬送のフリーレン', '転生貴族、鑑定スキルで成り上がる 第3期'];
    for (const query of queries) {
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
        || document.querySelector('#detailContent .empty-state h3')?.textContent === '정보를 불러오지 못했어요'
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
        || document.querySelector('#detailContent .empty-state h3')?.textContent === '정보를 불러오지 못했어요'))`, `${targetProvider} detail after source switch`), 30000, `${targetProvider} detail result`);
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
    assert.match(after.playbackInfoText, new RegExp(`^회차\\s+${after.episodeHeadingCount}개$`), 'the compact count must match the selected provider episode list; unverified playback facts stay hidden');
    assert.equal(after.detailError, '', 'the selected provider detail must not show an error');

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
          || document.querySelector('#detailContent .empty-state h3')?.textContent === '정보를 불러오지 못했어요'))`, 'returned source detail result'), 30000, `${initialProvider} detail after return`);
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
      assert.match(returned.playbackInfoText, new RegExp(`^회차\\s+${returned.episodeHeadingCount}개$`));
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

  const report = {
    tempRoot, paths, electronVersion: process.versions.electron, executable: process.execPath,
    mainPid: process.pid, rendererPid: mainWindow.webContents.getOSProcessId(), windowIds: windows,
    startup, startupConsoleErrors: consoleErrors, searches, identityChecks, detailLinkage,
    linkAniExternalRequestSkipped: false, providerDetailIpcCalls
  };
  fs.writeFileSync(path.join(tempRoot, 'report.json'), JSON.stringify(report, null, 2));
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
    identityChecks, detailLinkage, linkAniExternalRequestSkipped: false, providerDetailIpcCalls
  };
  console.log(`PATCH03_PROVIDER_LIVE_REPORT ${JSON.stringify(summary)}`);
  assert.equal(startup.homeVisible, true);
  assert.notEqual(startup.seasonRailChildren, null, 'the official season rail should exist');
  assert.equal(startup.seasonCalendarRemoved, true, 'the dedicated Patch 01 calendar is removed');
  assert.equal(startup.dropCaptionsElement, false, 'the removed control should not be required');
  assert.equal(consoleErrors.some(item => /Uncaught (?:TypeError|ReferenceError|SyntaxError)/.test(item.message)), false,
    'the renderer must finish initialization without an uncaught JavaScript exception');
}

run().then(() => app.quit(), error => {
  try {
    const safeError = { message: String(error?.message || error), stack: String(error?.stack || '') };
    fs.writeFileSync(path.join(tempRoot, 'failure-report.json'), JSON.stringify({
      ...liveEvidence,
      electronVersion: process.versions.electron,
      executable: process.execPath,
      mainPid: process.pid,
      rendererPid: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getOSProcessId() : null,
      windowIds: windows,
      startupConsoleErrors: consoleErrors,
      error: safeError
    }, null, 2));
  } catch {}
  console.error(error?.stack || error);
  try { app.quit(); } catch {}
  process.exitCode = 1;
});
