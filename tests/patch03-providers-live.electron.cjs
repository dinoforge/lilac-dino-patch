// Focused live provider-detail smoke. External requests are limited to one query per selected provider;
// LinkAni is skipped because a recent isolated run recorded ERR_CONNECTION_RESET.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-patch03-live-'));
const paths = Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.join(tempRoot, name)]));
for (const value of Object.values(paths)) fs.mkdirSync(value, { recursive: true });
for (const [name, value] of Object.entries(paths)) app.setPath(name, value);
for (const [name, value] of Object.entries(paths)) assert.equal(path.resolve(app.getPath(name)), path.resolve(value));
assert.ok(path.resolve(app.getPath('userData')).startsWith(path.resolve(os.tmpdir())));
assert.ok(path.resolve(app.getPath('sessionData')).startsWith(path.resolve(os.tmpdir())));
app.disableHardwareAcceleration();

const consoleErrors = [], windows = [];
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
  return mainWindow.webContents.executeJavaScript(code);
}

async function run() {
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
    calendarGrid: Boolean(document.querySelector('#seasonCalendarGrid')),
    calendarModuleReady: typeof window.LilacSeasonCalendar?.open === 'function',
    allExplorer: Boolean(document.querySelector('#allView #catalogFilters'))
  }))()`, 'startup checks');

  const searches = [];
  if (process.env.PATCH03_SKIP_PROVIDER_SEARCH !== '1') {
    // Do not retry the previously failed LinkAni route in this run.
    await evaluate(`(() => {
      const original = window.lilac.providerCatalog;
      window.__linkAniSkipped = 0;
      window.lilac.providerCatalog = (provider, ...args) => {
        if (provider === 'linkani') { window.__linkAniSkipped++; return Promise.resolve({ data: [], offset: 1, nextOffset: null, done: true }); }
        return original(provider, ...args);
      };
      return true;
    })()`, 'skip LinkAni during provider search');

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
        linkAniSkipped: window.__linkAniSkipped
      }; })()`, `actual integrated search ${query}`);
      searches.push(result);
    }
  }

  const identityChecks = [];
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

  let detailLinkage = null;
  if (process.env.PATCH03_VERIFY_DETAIL === '1') {
    const search = searches.find(item => item.query === process.env.PATCH03_LIVE_QUERY) || searches[0];
    const targetProvider = process.env.PATCH03_VERIFY_PROVIDER || 'animenosub';
    const group = search?.groups.find(item => item.sources.some(source => source.provider === targetProvider)
      && item.sources.some(source => ['reanime', 'miruro'].includes(source.provider)));
    if (!group) console.log(`PATCH03_GROUP_DIAGNOSTIC ${JSON.stringify({ targetProvider, query: search?.query, statuses: search?.statuses, groups: search?.groups.map(item => ({ title: item.title, sources: item.sources.map(source => ({ provider: source.provider, title: source.title, year: source.year, type: source.type, anilistId: source.anilistId, malId: source.malId, sourceId: source.sourceId })) })) })}`);
    assert.ok(group, `live search must group the ${targetProvider} candidate with a catalog source`);
    const target = group.sources.find(source => source.provider === targetProvider);
    await evaluate(`openDetail(${JSON.stringify(group.mal_id)}, { groupKey: ${JSON.stringify(group.groupKey)} })`, 'open grouped source detail');
    await waitFor(() => evaluate(`Boolean(document.querySelector('#detailDialog')?.open
      && document.querySelector('#detailContent .detail-source-picker')
      && document.querySelector('#detailContent #episodeBlock')?.children.length)`, 'initial grouped detail'), 30000, 'initial grouped detail and episode list');
    const before = await evaluate(`(() => ({
      title: document.querySelector('#detailContent h1')?.textContent || '',
      pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
      episodeCount: document.querySelector('#episodeBlock')?.children.length || 0,
      sources: [...document.querySelectorAll('#detailContent [data-detail-source]')].map(button => ({
        id: button.dataset.detailSource, label: button.textContent.trim(), active: button.getAttribute('aria-pressed') === 'true'
      }))
    }))()`, 'initial source picker');
    const switched = await evaluate(`(() => {
      const button = [...document.querySelectorAll('#detailContent [data-detail-source]')]
        .find(item => item.dataset.detailSource === ${JSON.stringify(target.sourceId)});
      if (!button) return false;
      button.click(); return true;
    })()`, `select live ${targetProvider} source`);
    assert.equal(switched, true, `grouped detail must expose the live ${targetProvider} candidate`);
    await waitFor(() => evaluate(`Boolean(window.openDetail?.currentSourceId === ${JSON.stringify(target.sourceId)}
      && document.querySelector('#detailContent h1')
      && document.querySelector('#episodeBlock')?.children.length)`, `${targetProvider} detail after source switch`), 30000, `${targetProvider} detail and episodes`);
    const after = await evaluate(`(() => ({
      sourceId: window.openDetail?.currentSourceId || '',
      title: document.querySelector('#detailContent h1')?.textContent || '',
      pickerCount: document.querySelectorAll('#detailContent .detail-source-picker').length,
      episodeCount: document.querySelector('#episodeBlock')?.children.length || 0,
      episodeLabels: [...(document.querySelector('#episodeBlock')?.children || [])].slice(0, 6).map(node => node.textContent.trim())
    }))()`, 'selected AnimenoSub source result');
    detailLinkage = { groupKey: group.groupKey, providers: group.sources.map(source => source.provider), targetId: target.sourceId, before, after };
    assert.equal(before.pickerCount, 1);
    assert.equal(after.pickerCount, 1);
    assert.equal(after.sourceId, target.sourceId);
    assert.ok(after.episodeCount > 0, 'the selected provider must load its own real episodes');
  }

  const report = {
    tempRoot, paths, electronVersion: process.versions.electron, executable: process.execPath,
    mainPid: process.pid, rendererPid: mainWindow.webContents.getOSProcessId(), windowIds: windows,
    startup, startupConsoleErrors: consoleErrors, searches, identityChecks, detailLinkage,
    linkAniExternalRequestSkipped: true
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
    identityChecks, detailLinkage, linkAniExternalRequestSkipped: true
  };
  console.log(`PATCH03_PROVIDER_LIVE_REPORT ${JSON.stringify(summary)}`);
  assert.equal(startup.homeVisible, true);
  assert.notEqual(startup.seasonRailChildren, null, 'the official season rail should exist');
  assert.equal(startup.dropCaptionsElement, false, 'the removed control should not be required');
  assert.equal(consoleErrors.some(item => /Uncaught (?:TypeError|ReferenceError|SyntaxError)/.test(item.message)), false,
    'the renderer must finish initialization without an uncaught JavaScript exception');
}

run().then(() => app.quit(), error => {
  console.error(error?.stack || error);
  try { app.quit(); } catch {}
  process.exitCode = 1;
});
