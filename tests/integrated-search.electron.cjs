// Packaged renderer/preload Phase 1 smoke test with synthetic IPC only; run with:
// npm run test:phase1-electron
// To run against a patched official source copy, set LILAC_FUNCTIONAL_SOURCE_ROOT.
let testStage = 'initialization';
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const asar = require('@electron/asar');

const repo = path.resolve(__dirname, '..');
const officialSourceRoot = process.env.LILAC_FUNCTIONAL_SOURCE_ROOT
  ? path.resolve(process.env.LILAC_FUNCTIONAL_SOURCE_ROOT)
  : null;
const asarPath = officialSourceRoot ? null : path.join(repo, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (asarPath) assert.ok(fs.existsSync(asarPath), `packaged app.asar exists: ${asarPath}`);
const appRoot = officialSourceRoot || path.join(asarPath, 'src');
const htmlPath = path.join(appRoot, officialSourceRoot ? 'src' : '', 'index.html');
const preloadPath = officialSourceRoot
  ? path.join(officialSourceRoot, 'electron', 'preload.cjs')
  : path.join(asarPath, 'electron', 'preload.cjs');
const preloadSource = officialSourceRoot
  ? fs.readFileSync(preloadPath, 'utf8')
  : asar.extractFile(asarPath, 'electron/preload.cjs').toString('utf8');
const channels = [...new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]))];
assert.ok(channels.includes('provider:catalog'));
assert.ok(channels.includes('provider:detail'));
assert.ok(fs.existsSync(htmlPath));

const requestedTempRoot = process.env.LILAC_FUNCTIONAL_TEMP_ROOT;
const tempRoot = requestedTempRoot
  ? path.resolve(requestedTempRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-integrated-search-'));
const relativeTempRoot = path.relative(path.resolve(os.tmpdir()), tempRoot);
assert.ok(relativeTempRoot && !path.isAbsolute(relativeTempRoot) && relativeTempRoot !== '..' && !relativeTempRoot.startsWith(`..${path.sep}`),
  'the functional test root must stay inside the configured OS Temp directory');
fs.mkdirSync(tempRoot, { recursive: true });
if (!requestedTempRoot && process.env.LILAC_FUNCTIONAL_KEEP_TEMP !== '1') {
  process.on('exit', () => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {} });
}
const runtimePaths = Object.fromEntries(['appData', 'userData', 'sessionData', 'temp', 'cache', 'logs', 'crashDumps']
  .map(name => [name, path.join(tempRoot, name)]));
const userData = runtimePaths.userData;
const sessionData = runtimePaths.sessionData;
const downloadsRoot = path.join(tempRoot, 'downloads');
for (const directory of [...Object.values(runtimePaths), downloadsRoot]) fs.mkdirSync(directory, { recursive: true });
assert.equal(fs.realpathSync.native(tempRoot).toLocaleLowerCase(), path.resolve(tempRoot).toLocaleLowerCase(),
  'the functional test root must not traverse a symlink or junction');

const videoPath = path.join(tempRoot, 'synthetic-episode.mp4');
const subtitlePath = path.join(tempRoot, 'synthetic-korean.vtt');
execFileSync(require('ffmpeg-static'), [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x3f80a8:s=320x180:r=24',
  '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath
], { stdio: 'pipe' });
fs.writeFileSync(subtitlePath, 'WEBVTT\n\n00:00:00.500 --> 00:00:04.000\n한국어 합성 자막 첫 문장\n\n00:00:04.500 --> 00:00:08.000\n한국어 합성 자막 두 번째 문장\n');
const videoUrl = pathToFileURL(videoPath).href;
const subtitleUrl = pathToFileURL(subtitlePath).href;

app.setPath('userData', userData);
app.setPath('appData', runtimePaths.appData);
app.setPath('sessionData', sessionData);
app.setPath('temp', runtimePaths.temp);
app.setPath('logs', runtimePaths.logs);
app.setPath('crashDumps', runtimePaths.crashDumps);
app.commandLine.removeSwitch('user-data-dir');
app.commandLine.appendSwitch('user-data-dir', userData);
app.commandLine.appendSwitch('disk-cache-dir', runtimePaths.cache);
app.commandLine.appendSwitch('crash-dumps-dir', runtimePaths.crashDumps);
app.disableHardwareAcceleration();

const captureRoot = process.env.LILAC_FUNCTIONAL_CAPTURE_ROOT
  ? path.resolve(process.env.LILAC_FUNCTIONAL_CAPTURE_ROOT)
  : null;
if (captureRoot) fs.mkdirSync(captureRoot, { recursive: true });

const blockedRequests = [];
const ipcCalls = [];
const rendererErrors = [];
let copiedDiagnostics = '';
let titleVariantsResolved = false;
let titleVariantSearchStarted = false;
let delayedProviderSearchStarted = false;
let resolveDelayedProviderSearchStarted;
let resolveDelayedProviderSearchResults;
const delayedProviderSearchStartedPromise = new Promise(resolve => { resolveDelayedProviderSearchStarted = resolve; });
const delayedProviderSearchResults = new Promise(resolve => { resolveDelayedProviderSearchResults = resolve; });
let win;

function fail(error) {
  console.error(`E2E_STAGE=${testStage}`);
  console.error(error?.stack || error);
  process.exitCode = 1;
  try { win?.destroy(); } catch {}
  app.exit(1);
}

const items = {
  reanime: {
    provider: 'reanime', id: 'ra-smoke', mal_id: 'reanime:ra-smoke', title: '통합 검색 테스트',
    title_english: 'Unified Search Test', anilistId: 100, malId: 900, year: 2026, type: 'TV'
  },
  animenosub: {
    provider: 'animenosub', id: 'as-smoke', mal_id: 'animenosub:as-smoke', title: '통합 검색 테스트',
    title_english: 'Unified Search Test', malId: 900, year: 2026, type: 'TV'
  },
  miruro: {
    provider: 'miruro', id: 'mi-smoke', mal_id: 'miruro:mi-smoke', title: '통합 검색 테스트',
    title_english: 'Unified Search Test', anilistId: 100, malId: 900, year: 2026, type: 'TV'
  },
  ohli24: {
    provider: 'ohli24', id: 'oh-smoke', mal_id: 'ohli24:oh-smoke', title: '별도 작품',
    title_english: 'Separate Work', anilistId: 200, year: 2025, type: 'TV'
  },
  linkkf: {
    provider: 'linkkf', id: 'lk-smoke', mal_id: 'linkkf:lk-smoke', title: '식별자 없는 작품',
    title_english: 'Unlinked Work', year: 2024, type: 'TV'
  }
};

function providerSearch(provider, query) {
  if (!String(query || '').trim()) return { data: [], total: 0, nextOffset: null, done: true };
  const item = items[provider];
  return { data: item ? [{ ...item }] : [], total: item ? 1 : 0, nextOffset: null, done: true };
}

function linkkfSearch(query) {
  return String(query || '').trim() ? [{ ...items.linkkf }] : [];
}

function reanimeEpisodes() {
  return [1, 2].map(number => ({
    provider: 'reanime', id: `ra-smoke-episode-${number}`, animeId: items.reanime.id,
    name: String(number), number, title: `${number}화`,
    url: `https://reanime.to/watch/${items.reanime.id}?ep=${number}`, playable: true
  }));
}

async function fixture(channel, args) {
  ipcCalls.push({ channel, args });
  switch (channel) {
    case 'anime:season':
    case 'anime:top': return { data: [] };
    case 'provider:schedule': {
      const weekdayNames = ['일', '월', '화', '수', '목', '금', '토'];
      const weekday = weekdayNames[Number(args[1])] || '알 수 없는';
      return {
        provider: args[0], native: false, timed: true, note: '격리 테스트 합성 방영 일정',
        items: [{
          title: `합성 ${weekday}요일 일정`, originalTitle: `Synthetic ${weekday} Schedule`,
          time: '19:00', episode: 2, genres: ['테스트']
        }]
      };
    }
    case 'downloads:list': return [];
    case 'downloads:root': return downloadsRoot;
    case 'provider:catalog':
      if (args[0] === 'reanime' && args[1] === '검색 전환 지연 테스트') {
        delayedProviderSearchStarted = true;
        resolveDelayedProviderSearchStarted();
        return delayedProviderSearchResults;
      }
      return providerSearch(args[0], args[1]);
    case 'provider:season': return { data: [], label: '모의 시즌' };
    case 'provider:quarter': return { items: [], label: '모의 분기' };
    case 'provider:airing':
    case 'provider:latest-episodes': return { data: [] };
    case 'provider:detail': return {
      data: { ...args[0], synopsis: '모의 상세 정보' },
      episodes: args[0]?.provider === 'reanime' ? reanimeEpisodes() : [], unavailable: false
    };
    case 'provider:resolve': return {
      url: videoUrl, subtitleUrl, subtitleLabel: 'Re:Anime 한국어 자막',
      subtitleTracks: [{ url: subtitleUrl, label: '한국어', language: 'ko', format: 'vtt' }],
      servers: [], referer: ''
    };
    case 'app:diagnostic-info': return { version: '0.5.9', platform: 'win32', arch: 'x64' };
    case 'clipboard:copy-text': copiedDiagnostics = String(args[0] || ''); return true;
    case 'subtitle-store:list':
    case 'jimaku:list':
    case 'oped:get': return [];
    case 'subtitle:find': return null;
    case 'linkkf:search': return linkkfSearch(args[0]);
    case 'catalog:search-korean': return args[0] === 'reanime' ? [{ ...items.reanime }]
      : args[0] === 'animenosub' ? [{ ...items.animenosub }] : [];
    case 'titles:variants':
      if (args[0] === '통합 검색 테스트') {
        titleVariantSearchStarted = true;
        await new Promise(resolve => setTimeout(resolve, 1000));
        titleVariantsResolved = true;
      }
      return args[0] === '경합 확인 테스트' ? [] : ['Unified Search Test'];
    case 'titles:resolve': return [];
    case 'catalog:index:state': return { sources: [], tmdb: false };
    case 'tmdb:get': return { key: '' };
    case 'gemini:get': return { localModels: [] };
    case 'subtitle-cache:usage': return { total: 0, removable: 0 };
    case 'update:state': return { status: 'disabled', current: 'smoke' };
    case 'catalog:activate': return { sources: [], tmdb: false };
    case 'cover:data': return args[0] || '';
    case 'anime:overview': return { synopsis: '' };
    default: return undefined;
  }
}

async function waitFor(label, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

app.whenReady().then(async () => {
  testStage = 'window creation and renderer load';
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(?:file:|data:|blob:)/i.test(details.url)) callback({ cancel: false });
    else { blockedRequests.push(details.url); callback({ cancel: true }); }
  });

  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => fixture(channel, args));

  const createWindow = () => {
    const window = new BrowserWindow({
      show: process.env.LILAC_FUNCTIONAL_SHOW_WINDOW === '1',
      width: 1200,
      height: 900,
      webPreferences: {
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', (_event, details) => {
      if (details.level >= 3) rendererErrors.push(`${details.message} (${details.sourceId}:${details.lineNumber})`);
    });
    window.webContents.on('render-process-gone', (_event, details) => fail(new Error(`Renderer exited: ${details.reason}`)));
    return window;
  };

  const saveCapture = async (name, revealSelector = null) => {
    if (!captureRoot) return null;
    if (revealSelector) {
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(revealSelector)})?.scrollIntoView({ block: 'start', inline: 'nearest' })`);
    }
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 350));
    const destination = path.join(captureRoot, name);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(destination, image.toPNG(), { flag: 'wx' });
    return destination;
  };

  win = createWindow();
  await win.loadFile(htmlPath);

  await waitFor('initial app render', () => win.webContents.executeJavaScript('Boolean(window.lilac && document.querySelector("#searchButton"))'));
  for (const key of ['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']) {
    assert.equal(fs.realpathSync.native(app.getPath(key)).toLocaleLowerCase(), fs.realpathSync.native(runtimePaths[key]).toLocaleLowerCase(),
      `Electron ${key} must use the isolated functional-test path`);
  }
  assert.equal(fs.realpathSync.native(app.commandLine.getSwitchValue('user-data-dir')).toLocaleLowerCase(),
    fs.realpathSync.native(userData).toLocaleLowerCase(), 'Chromium user-data-dir must use the isolated profile');
  assert.equal(fs.realpathSync.native(app.commandLine.getSwitchValue('disk-cache-dir')).toLocaleLowerCase(),
    fs.realpathSync.native(runtimePaths.cache).toLocaleLowerCase(), 'Chromium cache must use the isolated profile');
  const expiredEpisode = {
    provider: 'reanime', id: 'ra-smoke-episode-1', animeId: items.reanime.id,
    name: '1', number: 1, title: '1화', url: 'https://reanime.to/watch/ra-smoke?ep=1', playable: true
  };
  const migrationHistory = officialSourceRoot
    ? [{
      key: 'miruro:synthetic-previous-episode',
      src: videoUrl,
      name: '기존 합성 재생 · 1화', subtitleTitle: '기존 합성 재생', progress: 41, updated: Date.now(),
      episode: {
        provider: 'miruro', id: 'mi-previous-episode', animeId: 'mi-previous-series',
        name: '1', number: 1, title: '1화', url: videoUrl, playable: true
      },
      anime: { provider: 'miruro', id: 'mi-previous-series', mal_id: 'miruro:synthetic-previous-series', title: '기존 합성 재생' }
    }]
    : [
      {
        key: 'reanime:https://reanime.to/watch/ra-smoke?ep=1',
        src: 'http://127.0.0.1:41001/__flix/expired-session-one/master.m3u8',
        name: '통합 검색 테스트 · 1화', subtitleTitle: '통합 검색 테스트', progress: 41, updated: Date.now(),
        episode: expiredEpisode, anime: { ...items.reanime }
      },
      {
        src: 'http://127.0.0.1:41002/__flix/expired-session-two/master.m3u8',
        name: '이전 직접 재생 · 1화', subtitleTitle: '이전 직접 재생', progress: 18, updated: Date.now() - 1000,
        episode: null
      }
    ];
  const syntheticLibrary = [{ provider: 'reanime', id: 'synthetic-favorite-01', mal_id: 'reanime:synthetic-favorite-01', title: '합성 즐겨찾기' }];
  const syntheticSeriesSubtitlePick = { 'reanime:100': { source: 'animenosub', at: 1760000000000 } };
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem('theme', 'light');
    localStorage.setItem('contentSource', 'integrated');
    localStorage.setItem('contentSourceProvider', 'miruro');
    localStorage.setItem('defaultSpeed', '1.25');
    localStorage.setItem('subtitleSource', 'animenosub');
    localStorage.setItem('subtitleSize', '108');
    localStorage.setItem('subtitleSync', '125');
    localStorage.setItem('library', ${JSON.stringify(JSON.stringify(syntheticLibrary))});
    localStorage.setItem('seriesSubtitlePick', ${JSON.stringify(JSON.stringify(syntheticSeriesSubtitlePick))});
    localStorage.setItem('history', ${JSON.stringify(JSON.stringify(migrationHistory))});
  })()`);
  const legacyProfileBeforeMigration = await win.webContents.executeJavaScript(`({
    contentSource: localStorage.getItem('contentSource'),
    provider: localStorage.getItem('contentSourceProvider')
  })`);
  assert.equal(legacyProfileBeforeMigration.contentSource, 'integrated', 'reproduces the legacy Dino sentinel in the original setting key');
  assert.equal(legacyProfileBeforeMigration.provider, 'miruro');
  const migrationReload = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload();
  await migrationReload;
  const migratedHistory = await waitFor(officialSourceRoot ? 'valid synthetic watch history persistence' : 'expired local proxy history migration', async () => {
    const state = await win.webContents.executeJavaScript(`(() => {
      const entries = JSON.parse(localStorage.getItem('history') || '[]');
      return {
        entries,
        continueCards: document.querySelectorAll('#continueRail .continue-card').length
      };
    })()`);
    if (officialSourceRoot) {
      return state.entries.length === 1 && state.entries[0]?.src === videoUrl
        && state.entries[0]?.progress === 41 && state.continueCards === 1 ? state : null;
    }
    return state.entries.length === 2 && state.entries[0]?.src === '' && state.entries[1]?.src === ''
      && state.entries[1]?.key === 'expired-flix:expired-session-two' && state.continueCards === 1 ? state : null;
  });
  if (officialSourceRoot) {
    assert.equal(migratedHistory.entries[0].episode.url, videoUrl,
      'valid synthetic playback metadata and its resume position survive startup');
  } else {
    assert.equal(migratedHistory.entries[0].episode.url, expiredEpisode.url,
      'watch metadata survives while the expired proxy address is removed');
    assert.equal(migratedHistory.entries[1].playbackSourceExpired, true,
      'legacy direct-play history remains in storage and records why it cannot resume');
  }
  assert.equal(migratedHistory.entries[0].progress, 41);
  assert.equal(migratedHistory.continueCards, 1,
    'the history without a playable source does not appear in continue watching');
  const seededProfile = await win.webContents.executeJavaScript(`({
    theme: localStorage.getItem('theme'),
    light: document.body.classList.contains('light'),
    contentSource: localStorage.getItem('contentSource'),
    provider: localStorage.getItem('contentSourceProvider'),
    dinoSearchMode: localStorage.getItem('lilacDinoPatch.searchMode'),
    speed: localStorage.getItem('defaultSpeed'),
    subtitleSource: localStorage.getItem('subtitleSource'),
    subtitleSize: localStorage.getItem('subtitleSize'),
    subtitleSync: localStorage.getItem('subtitleSync'),
    library: JSON.parse(localStorage.getItem('library') || '[]'),
    seriesSubtitlePick: JSON.parse(localStorage.getItem('seriesSubtitlePick') || '{}')
  })`);
  assert.equal(seededProfile.theme, 'light');
  assert.equal(seededProfile.light, true, 'the synthetic Light theme is applied by the official renderer');
  assert.equal(seededProfile.contentSource, officialSourceRoot ? 'miruro' : 'integrated',
    'the official patched source migrates legacy mode while the packaged root app keeps its independent schema');
  assert.equal(seededProfile.provider, 'miruro');
  assert.equal(seededProfile.dinoSearchMode, officialSourceRoot ? 'integrated' : null);
  assert.equal(seededProfile.speed, '1.25');
  assert.equal(seededProfile.subtitleSource, 'animenosub');
  assert.equal(seededProfile.subtitleSize, '108');
  assert.equal(seededProfile.subtitleSync, '125');
  assert.deepEqual(seededProfile.library, syntheticLibrary);
  assert.deepEqual(seededProfile.seriesSubtitlePick, syntheticSeriesSubtitlePick);

  testStage = 'official weekly schedule tabs';
  await waitFor('initial official weekly schedule', () => win.webContents.executeJavaScript(`
    document.querySelector('#scheduleRail')?.getAttribute('aria-busy') === 'false'
      && document.querySelectorAll('#scheduleRail .schedule-show').length === 1
  `));
  const scheduleCallsBeforeWeekdayClicks = ipcCalls.filter(call => call.channel === 'provider:schedule').length;
  const weekdays = ['월', '화', '수', '목', '금', '토', '일'];
  for (let index = 0; index < weekdays.length; index++) {
    await win.webContents.executeJavaScript(`document.querySelectorAll('#scheduleTabs [role="tab"]')[${index}].click()`);
    const dayState = await waitFor(`${weekdays[index]}요일 schedule content`, () => win.webContents.executeJavaScript(`(() => {
      const tabs = [...document.querySelectorAll('#scheduleTabs [role="tab"]')];
      const selected = tabs.findIndex(button => button.getAttribute('aria-selected') === 'true');
      return {
        selected,
        busy: document.querySelector('#scheduleRail')?.getAttribute('aria-busy') || '',
        status: document.querySelector('#scheduleStatus')?.textContent || '',
        cards: [...document.querySelectorAll('#scheduleRail .schedule-show')].map(button => button.textContent.trim())
      };
    })()`).then(state => state.selected === index && state.busy === 'false' && state.cards.length === 1 ? state : null));
    assert.ok(dayState.status.includes(`${weekdays[index]}요일`));
    assert.ok(dayState.cards[0].includes(`합성 ${weekdays[index]}요일 일정`));
    if (index === 0) await saveCapture('official-v058-weekly-schedule-monday.png', '#scheduleSection');
  }
  assert.equal(ipcCalls.filter(call => call.channel === 'provider:schedule').length - scheduleCallsBeforeWeekdayClicks, 7,
    'the existing official weekly schedule requests each selected weekday through its provider contract');

  await saveCapture('official-v058-weekly-schedule-sunday.png', '#scheduleSection');

  testStage = 'integrated search race';
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#pageSearch');
    input.value = '통합 검색 테스트';
    document.querySelector('#searchButton').click();
  })()`);

  await waitFor('delayed title-variant lookup start', () => titleVariantSearchStarted && !titleVariantsResolved);
  const pendingVariantSearch = await win.webContents.executeJavaScript(`({
    cards: document.querySelectorAll('#searchGrid .anime-card').length,
    status: document.querySelector('#searchStatus')?.textContent || ''
  })`);
  assert.equal(pendingVariantSearch.cards, 0, 'the integrated-search renderer waits for title variants before applying a partial result set');
  assert.ok(pendingVariantSearch.status.includes('검색 중'));

  const staleVariantSearchesBefore = ipcCalls.filter(call => call.channel === 'provider:catalog' && call.args[1] === 'Unified Search Test').length;
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#pageSearch');
    input.value = '경합 확인 테스트';
    document.querySelector('#searchButton').click();
  })()`);
  const replacementSearch = await waitFor('replacement results without title variants', async () => {
    const state = await win.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('#searchGrid .anime-card').length,
      status: document.querySelector('#searchStatus')?.textContent || ''
    })`);
    return state.cards === 2 && state.status.includes('경합 확인 테스트') ? state : null;
  });
  assert.ok(replacementSearch.status.includes('경합 확인 테스트'));
  await waitFor('stale title variants completion', () => titleVariantsResolved);
  await new Promise(resolve => setTimeout(resolve, 50));
  const afterStaleResponse = await win.webContents.executeJavaScript(`({
    cards: document.querySelectorAll('#searchGrid .anime-card').length,
    status: document.querySelector('#searchStatus')?.textContent || ''
  })`);
  assert.equal(afterStaleResponse.cards, 2);
  assert.ok(afterStaleResponse.status.includes('경합 확인 테스트'), 'a late previous search cannot replace the current query');
  assert.equal(ipcCalls.filter(call => call.channel === 'provider:catalog' && call.args[1] === 'Unified Search Test').length, staleVariantSearchesBefore,
    'the stale title variant is never sent to providers after the search was superseded');

  await win.webContents.executeJavaScript(`(() => {
    state.top = ${JSON.stringify([items.ohli24])};
    const input = document.querySelector('#pageSearch');
    input.value = '검색 전환 지연 테스트';
    document.querySelector('#searchButton').click();
  })()`);
  await waitFor('delayed provider search request', () => delayedProviderSearchStarted);
  await win.webContents.executeJavaScript("document.querySelector('#seeAllTop').click()");
  const homeListBeforeLateSearch = await win.webContents.executeJavaScript(`({
    ids: [...document.querySelectorAll('#searchGrid .anime-card')].map(card => card.dataset.id),
    status: document.querySelector('#searchStatus')?.textContent || ''
  })`);
  assert.deepEqual(homeListBeforeLateSearch, {
    ids: [items.ohli24.mal_id], status: '인기 애니메이션 1개 · 인기순'
  });
  resolveDelayedProviderSearchResults({ data: [{
    ...items.reanime, mal_id: 'reanime:late-search-result', title: '늦게 도착한 검색 결과', title_english: 'Late Search Result'
  }] });
  await new Promise(resolve => setTimeout(resolve, 50));
  const homeListAfterLateSearch = await win.webContents.executeJavaScript(`({
    ids: [...document.querySelectorAll('#searchGrid .anime-card')].map(card => card.dataset.id),
    status: document.querySelector('#searchStatus')?.textContent || ''
  })`);
  assert.deepEqual(homeListAfterLateSearch, homeListBeforeLateSearch,
    'a late search result must not replace the home discovery list currently shown in the search view');

  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#pageSearch');
    input.value = '제목 변형 검색';
    document.querySelector('#searchButton').click();
  })()`);
  const mergedVariantResults = await waitFor('merged variant results', async () => {
    const state = await win.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('#searchGrid .anime-card').length,
      status: document.querySelector('#searchStatus')?.textContent || '',
      providers: [...document.querySelectorAll('#searchProviderFilters [data-provider]')].map(button => button.dataset.provider),
      groups: window.__dinoPatch03Bridge?.getSearchSnapshot?.() || []
    })`);
    const grouped = state.groups.find(group => group.sourceItems.length === 3
      && group.sourceItems.some(item => item.provider === 'reanime')
      && group.sourceItems.some(item => item.provider === 'miruro')
      && group.sourceItems.some(item => item.provider === 'animenosub'));
    return state.cards === 2 && state.status.includes('제목 변형 검색') && state.providers.length === 6 && grouped ? state : null;
  });
  assert.equal(mergedVariantResults.groups.length, 2);
  await saveCapture('patched-v058-integrated-search-grouped-results.png');

  testStage = 'detail source picker';
  await win.webContents.executeJavaScript(`document.querySelector('#searchProviderFilters [data-provider="miruro"]').click()`);
  const miruroView = await waitFor('Miruro provider filter', async () => win.webContents.executeJavaScript(`({
    cards: document.querySelectorAll('#searchGrid .anime-card').length,
    pressed: document.querySelector('#searchProviderFilters [data-provider="miruro"]')?.getAttribute('aria-pressed')
  })`));
  assert.deepEqual(miruroView, { cards: 1, pressed: 'true' });

  await win.webContents.executeJavaScript(`document.querySelector('#searchGrid .anime-card').click()`);
  await waitFor('detail source picker', () => win.webContents.executeJavaScript('Boolean(document.querySelector("#detailContent [data-provider-source]"))'))
    .catch(async error => {
      const detail = await win.webContents.executeJavaScript(`({
        open: document.querySelector('#detailDialog')?.open || false,
        content: document.querySelector('#detailContent')?.textContent?.trim() || '',
        sourceButtons: [...document.querySelectorAll('#detailContent [data-provider-source]')].map(button => ({id:button.dataset.providerSource,pressed:button.getAttribute('aria-pressed')})),
        bridge: window.__dinoPatch03Bridge?.getSearchSnapshot?.() || []
      })`);
      await saveCapture('official-v058-detail-failure.png');
      const detailCalls = ipcCalls.filter(call => call.channel === 'provider:detail');
      throw new Error(`${error.message}; detail=${JSON.stringify(detail)}; provider-detail-calls=${JSON.stringify(detailCalls)}; renderer-errors=${JSON.stringify(rendererErrors)}`);
    });
  const initialSelection = await win.webContents.executeJavaScript(`({
    count: document.querySelectorAll('#detailContent [data-provider-source]').length,
    selected: document.querySelector('#detailContent [data-provider-source][aria-pressed="true"]')?.dataset.providerSource || ''
  })`);
  assert.equal(initialSelection.count, 3);
  assert.equal(initialSelection.selected, items.miruro.mal_id, 'details initially follow the active Miruro result filter');
  await saveCapture('patched-v058-official-detail-provider-picker.png');

  await win.webContents.executeJavaScript(`document.querySelector('#detailContent [data-provider-source="${items.reanime.mal_id}"]').click()`);
  await waitFor('selected Re:Anime detail refresh', async () => win.webContents.executeJavaScript(`
    document.querySelector('#detailContent [data-provider-source="${items.reanime.mal_id}"]')?.getAttribute('aria-pressed') === 'true'
  `));
  await waitFor('Re:Anime episode list', () => win.webContents.executeJavaScript('Boolean(document.querySelector("#detailContent .episode-btn"))'));
  await saveCapture('patched-v058-official-detail-reanime-episodes.png');
  await win.webContents.executeJavaScript('document.querySelector("#detailContent .episode-btn").click()');

  testStage = 'local MP4 and VTT playback';
  let lastPlaybackState = null;
  const firstPlayback = await waitFor('local MP4 and Korean track metadata', async () => {
    lastPlaybackState = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video'), track = video?.querySelector('track');
      return {
        readyState: video?.readyState, duration: video?.duration, currentSrc: video?.currentSrc,
        videoError: video?.error ? { code: video.error.code, message: video.error.message } : null,
        subtitleState: document.querySelector('#subtitleState')?.textContent || '',
        trackCount: video?.textTracks?.length || 0, trackReadyState: track?.readyState,
        language: track?.srclang, mode: track?.track?.mode
      };
    })()`);
    return lastPlaybackState.readyState >= 1 && lastPlaybackState.duration >= 11.9 && lastPlaybackState.trackReadyState === 2
      ? { duration: lastPlaybackState.duration, language: lastPlaybackState.language, mode: lastPlaybackState.mode }
      : null;
  }, 8000).catch(error => {
    const resolved = ipcCalls.filter(call => call.channel === 'provider:resolve').length;
    throw new Error(`${error.message}; media=${JSON.stringify(lastPlaybackState)}; providerResolve calls=${resolved}; blocked requests=${blockedRequests.length}; renderer errors=${rendererErrors.join(' | ')}`);
  });
  assert.equal(firstPlayback.language, 'ko');
  assert.equal(firstPlayback.mode, 'showing');
  await saveCapture('patched-v058-local-mp4-korean-vtt-player.png');

  await win.webContents.executeJavaScript(`(async () => {
    const video = document.querySelector('#video');
    video.pause();
    const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    video.currentTime = 1.2;
    await Promise.race([seeked, new Promise(resolve => setTimeout(resolve, 1000))]);
  })()`);
  const firstCue = await waitFor('first active Korean subtitle cue', () => win.webContents.executeJavaScript(`(() => {
    const video = document.querySelector('#video');
    if (!video) return null;
    video.pause();
    if (video.currentTime < 0.5 || video.currentTime > 3.9) { video.currentTime = 1.2; return null; }
    const cue = video.textTracks?.[0]?.activeCues?.[0]?.text || '';
    return cue.includes('첫 문장') ? cue : null;
  })()`));
  assert.ok(firstCue.includes('첫 문장'));
  await saveCapture('patched-v058-local-mp4-korean-vtt-active-cue.png');

  await win.webContents.executeJavaScript(`(async () => {
    const video = document.querySelector('#video');
    const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    video.currentTime = 3.25;
    await Promise.race([seeked, new Promise(resolve => setTimeout(resolve, 1000))]);
    video.dispatchEvent(new Event('timeupdate'));
    video.pause();
    video.dispatchEvent(new Event('pause'));
  })()`);
  const savedProgress = await win.webContents.executeJavaScript(`(() => {
    const history = JSON.parse(localStorage.getItem('history') || '[]');
    const item = history.find(entry => entry.episode?.provider === 'reanime');
    return item ? { progress: item.progress, number: item.episode.number } : null;
  })()`);
  assert.ok(savedProgress, 'playing an episode writes its watch history');
  assert.equal(savedProgress.number, 1);
  assert.ok(savedProgress.progress >= 24 && savedProgress.progress <= 29, `saved resume progress is near 27% (${savedProgress.progress}%)`);

  testStage = 'continue card resume and history persistence';
  const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload();
  await reloaded;
  const expectedProgressText = `${savedProgress.progress}%`;
  const continueCard = await waitFor('continue card restored after page reload', () => win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#continueRail .continue-card');
    return card?.textContent?.includes('EP.1') && card.textContent.includes(${JSON.stringify(expectedProgressText)}) ? card.textContent : null;
  })()`));
  assert.ok(continueCard.includes('EP.1'));
  const resolveCountBeforeContinue = ipcCalls.filter(call => call.channel === 'provider:resolve').length;
  await win.webContents.executeJavaScript('document.querySelector("#continueRail .continue-card").click()');
  const resumedPlayback = await waitFor('continued local MP4 restored near saved position', () => win.webContents.executeJavaScript(`(() => {
    const video = document.querySelector('#video'), track = video?.querySelector('track');
    const cue = video?.textTracks?.[0]?.activeCues?.[0]?.text || '';
    return video?.readyState >= 1 && video.duration >= 11.9 && video.currentTime >= 2.6
      && track?.track?.mode === 'showing' && cue.includes('한국어 합성 자막')
      ? { currentTime: video.currentTime, language: track.srclang, mode: track.track.mode, cue }
      : null;
  })()`), 8000);
  assert.ok(ipcCalls.filter(call => call.channel === 'provider:resolve').length > resolveCountBeforeContinue,
    'continue card resolves the saved episode again');
  assert.ok(resumedPlayback.currentTime <= 4, `resumed position is near 3.25s (${resumedPlayback.currentTime}s)`);
  assert.equal(resumedPlayback.language, 'ko');
  assert.equal(resumedPlayback.mode, 'showing');
  assert.ok(ipcCalls.some(call => call.channel === 'provider:detail' && call.args[0]?.provider === 'reanime'));
  assert.ok(ipcCalls.some(call => call.channel === 'provider:detail' && call.args[0]?.provider === 'miruro'));

  let detailResumedPlayback = null;
  if (!officialSourceRoot) {
    testStage = 'packaged detail resume-choice UI';
    await win.webContents.executeJavaScript(`(async () => {
      const video = document.querySelector('#video');
      const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      video.currentTime = 11.5;
      await Promise.race([seeked, new Promise(resolve => setTimeout(resolve, 1000))]);
      video.pause();
      const history = JSON.parse(localStorage.getItem('history') || '[]');
      const episode = history.find(entry => entry.episode?.provider === 'reanime' && Number(entry.episode?.number) === 1);
      if (!episode) throw new Error('The saved Re:Anime episode is missing before the detail resume check');
      episode.progress = 96;
      localStorage.setItem('history', JSON.stringify(history));
      const inMemoryEpisode = state.history.find(entry => entry.episode?.provider === 'reanime' && Number(entry.episode?.number) === 1);
      if (!inMemoryEpisode) throw new Error('The in-memory Re:Anime episode is missing before the detail resume check');
      inMemoryEpisode.progress = 96;
    })()`);
    const detailReloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await detailReloaded;
    await win.webContents.executeJavaScript(`(() => {
      window.rememberAnime(${JSON.stringify(items.reanime)});
      window.openDetail(${JSON.stringify(items.reanime.mal_id)});
    })()`);
    const detailResumeChoice = await waitFor('detail screen resume choice at 96 percent', () => win.webContents.executeJavaScript(`(() => {
      const primary = document.querySelector('#detailContent .detail-play');
      const alternate = document.querySelector('#detailContent .detail-resume-choice');
      return primary && alternate && !alternate.classList.contains('hidden')
        ? { primary: primary.textContent.trim(), alternate: alternate.textContent.trim() }
        : null;
    })()`));
    assert.match(detailResumeChoice.primary, /1화 처음부터/);
    assert.match(detailResumeChoice.alternate, /1화 이어보기/);
    await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      video.addEventListener('seeked', () => video.pause(), { once: true });
      document.querySelector('#detailContent .detail-resume-choice').click();
    })()`);
    detailResumedPlayback = await waitFor('detail resume choice restores saved position', () => win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      if (video?.duration >= 11.9 && video.currentTime >= 11.3) {
        video.pause();
        return { currentTime: video.currentTime, duration: video.duration };
      }
      return null;
    })()`), 8000);
    assert.ok(detailResumedPlayback.currentTime < detailResumedPlayback.duration,
      'the explicit detail choice resumes before the episode ends');
  }

  if (!officialSourceRoot) {
    testStage = 'privacy-filtered playback diagnostics';
    await win.webContents.executeJavaScript(`(() => {
      window.showPlayerFailure('합성 재생 실패', {
        stage: 'hls-playback', mediaType: 'hls', errorCategory: 'networkError',
        message: 'PRIVATE_DIAGNOSTIC_DETAIL_SHOULD_NOT_COPY',
        url: 'https://private.example.test/secret.m3u8?token=synthetic-secret'
      });
      for (let index = 0; index < 6; index++) {
        window.recordPlayerFailure({
          stage: 'hls-playback', mediaType: 'hls', errorCategory: 'networkError',
          message: 'PRIVATE_DIAGNOSTIC_DETAIL_SHOULD_NOT_COPY'
        });
      }
      document.querySelector('#copyPlayerDiagnostics').click();
    })()`);
    await waitFor('diagnostic copy confirmation', async () => {
      const status = await win.webContents.executeJavaScript('document.querySelector("#playerDiagnosticStatus")?.textContent || ""');
      return copiedDiagnostics && status.includes('오류 정보가 복사됐어요') ? true : null;
    });
    assert.match(copiedDiagnostics, /버전: 0\.5\.9/);
    assert.match(copiedDiagnostics, /운영체제: win32 x64/);
    assert.equal((copiedDiagnostics.match(/공급원=reanime/g) || []).length, 5,
      'the user-invoked report contains no more than the latest five failures');
    assert.doesNotMatch(copiedDiagnostics, /PRIVATE_DIAGNOSTIC_DETAIL_SHOULD_NOT_COPY|private\.example\.test|secret\.m3u8|synthetic-secret/i,
      'arbitrary error text and full media URLs are excluded from the copied report');
  }

  testStage = 'window close progress flush';
  const closeTime = await win.webContents.executeJavaScript(`(async () => {
    const video = document.querySelector('#video');
    const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    video.currentTime = 6.25;
    await Promise.race([seeked, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (${JSON.stringify(Boolean(officialSourceRoot))}) {
      video.dispatchEvent(new Event('timeupdate'));
      video.pause();
      video.dispatchEvent(new Event('pause'));
    } else {
      const history = JSON.parse(localStorage.getItem('history') || '[]');
      const episode = history.find(entry => entry.episode?.provider === 'reanime' && Number(entry.episode?.number) === 1);
      if (!episode) throw new Error('The current Re:Anime episode is missing before the window-close check');
      episode.progress = 96;
      localStorage.setItem('history', JSON.stringify(history));
      const inMemoryEpisode = state.history.find(entry => entry.episode?.provider === 'reanime' && Number(entry.episode?.number) === 1);
      if (!inMemoryEpisode) throw new Error('The in-memory Re:Anime episode is missing before the window-close check');
      inMemoryEpisode.progress = 96;
    }
    return { currentTime: video.currentTime, duration: video.duration };
  })()`);
  assert.ok(Math.abs(closeTime.currentTime - 6.25) < 0.05,
    `the test seek resolves near 6.25 seconds (${closeTime.currentTime}s)`);
  assert.equal(closeTime.duration, 12);
  const windowClosed = new Promise(resolve => win.once('closed', resolve));
  win.close();
  await windowClosed;
  win = createWindow();
  await win.loadFile(htmlPath);
  await waitFor('application reload after window close', () => win.webContents.executeJavaScript(
    'Boolean(window.lilac && document.querySelector("#searchButton"))'
  ));
  const closeResumedProgress = await win.webContents.executeJavaScript(`(() => {
    const history = JSON.parse(localStorage.getItem('history') || '[]');
    return history.find(entry => entry.episode?.provider === 'reanime' && Number(entry.episode?.number) === 1)?.progress ?? null;
  })()`);
  if (officialSourceRoot) {
    assert.ok(closeResumedProgress >= 50 && closeResumedProgress <= 54,
      `the official source persists the last timeupdate progress near 52% (${closeResumedProgress}%)`);
  } else {
    assert.equal(closeResumedProgress, 52,
      'closing the Electron window flushes the live position instead of retaining the older saved value');
  }
  const persistedProfileAfterFlow = await win.webContents.executeJavaScript(`({
    theme: localStorage.getItem('theme'),
    contentSource: localStorage.getItem('contentSource'),
    provider: localStorage.getItem('contentSourceProvider'),
    dinoSearchMode: localStorage.getItem('lilacDinoPatch.searchMode'),
    speed: localStorage.getItem('defaultSpeed'),
    subtitleSource: localStorage.getItem('subtitleSource'),
    subtitleSize: localStorage.getItem('subtitleSize'),
    subtitleSync: localStorage.getItem('subtitleSync'),
    library: JSON.parse(localStorage.getItem('library') || '[]'),
    seriesSubtitlePick: JSON.parse(localStorage.getItem('seriesSubtitlePick') || '{}')
  })`);
  assert.equal(persistedProfileAfterFlow.theme, 'light');
  assert.equal(persistedProfileAfterFlow.contentSource, officialSourceRoot ? 'miruro' : 'integrated');
  assert.equal(persistedProfileAfterFlow.provider, 'miruro');
  assert.equal(persistedProfileAfterFlow.dinoSearchMode, officialSourceRoot ? 'integrated' : null);
  assert.equal(persistedProfileAfterFlow.speed, '1.25');
  assert.equal(persistedProfileAfterFlow.subtitleSource, 'animenosub');
  assert.equal(persistedProfileAfterFlow.subtitleSize, '108');
  assert.equal(persistedProfileAfterFlow.subtitleSync, '125');
  assert.deepEqual(persistedProfileAfterFlow.library, syntheticLibrary);
  assert.deepEqual(persistedProfileAfterFlow.seriesSubtitlePick, syntheticSeriesSubtitlePick);

  assert.deepEqual(blockedRequests, [], `unexpected external request attempts were blocked: ${blockedRequests.join(', ')}`);
  assert.deepEqual(rendererErrors, [], `renderer console errors: ${rendererErrors.join('; ')}`);
  const searchCalls = ipcCalls.filter(call => ['provider:catalog', 'catalog:search-korean', 'linkkf:search'].includes(call.channel));
  assert.ok(searchCalls.length >= 8, `synthetic provider search calls recorded (${searchCalls.length})`);
  console.log(`Packaged Phase 1 smoke passed: ${officialSourceRoot ? 'valid synthetic watch-history persistence' : 'expired proxy history preservation'}, integrated search, source picker, local episode playback, active Korean VTT, saved progress and continue-watch resume, ${officialSourceRoot ? 'official v0.5.58 detail resume-choice and diagnostic-copy UI not present and not tested' : '96% detail start-over/continue choice and privacy-filtered diagnostic copy'}, live progress flush on Electron window close.`);
  console.log(`Synthetic search IPC calls: ${searchCalls.length}; provider resolve calls: ${ipcCalls.filter(call => call.channel === 'provider:resolve').length}; saved progress: ${savedProgress.progress}%; resumed at: ${resumedPlayback.currentTime.toFixed(2)}s.`);
  if (detailResumedPlayback) console.log(`Detail alternate resume position: ${detailResumedPlayback.currentTime.toFixed(2)}s / ${detailResumedPlayback.duration.toFixed(2)}s.`);
  console.log(`Window-close resume position: ${closeResumedProgress}% (current playback was ${closeTime.currentTime.toFixed(2)}s / ${closeTime.duration.toFixed(2)}s).`);
  console.log(`Renderer errors: ${rendererErrors.length}; blocked external request attempts: ${blockedRequests.length}; userData and synthetic media: isolated temp folder.`);
  console.log(`Input: ${officialSourceRoot ? `official source copy ${officialSourceRoot}` : `packaged app.asar ${asarPath}`}. Synthetic settings, theme, favorite, subtitle preference and watch history survived the renderer and window restart.`);
  const actualElectronPaths = Object.fromEntries(['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']
    .map(name => [name, app.getPath(name)]));
  const normalizePath = value => path.resolve(value).toLocaleLowerCase();
  for (const [name, actualPath] of Object.entries(actualElectronPaths)) {
    assert.equal(normalizePath(actualPath), normalizePath(runtimePaths[name]), `Electron ${name} path is isolated`);
  }
  const chromiumPaths = {
    userData: app.commandLine.getSwitchValue('user-data-dir'),
    cache: app.commandLine.getSwitchValue('disk-cache-dir'),
    crashDumps: app.commandLine.getSwitchValue('crash-dumps-dir')
  };
  for (const [name, actualPath] of Object.entries(chromiumPaths)) {
    assert.equal(normalizePath(actualPath), normalizePath(name === 'userData' ? runtimePaths.userData : runtimePaths[name]),
      `Chromium ${name} path is isolated`);
  }
  console.log(`Isolated Electron paths: ${JSON.stringify(actualElectronPaths)}; Chromium paths: ${JSON.stringify(chromiumPaths)}`);
  if (captureRoot) console.log(`Functional GUI captures: ${captureRoot}`);
  win.destroy();
  app.quit();
}).catch(fail);
