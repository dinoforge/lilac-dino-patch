// Packaged renderer/preload Phase 1 smoke test with synthetic IPC only; run with:
// npm run test:phase1-electron
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
const asarPath = path.join(repo, 'dist', 'win-unpacked', 'resources', 'app.asar');
assert.ok(fs.existsSync(asarPath), `packaged app.asar exists: ${asarPath}`);
const appRoot = path.join(asarPath, 'src');
const htmlPath = path.join(appRoot, 'index.html');
const preloadPath = path.join(asarPath, 'electron', 'preload.cjs');
const preloadSource = asar.extractFile(asarPath, 'electron/preload.cjs').toString('utf8');
const channels = [...new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]))];
assert.ok(channels.includes('provider:catalog'));
assert.ok(channels.includes('provider:detail'));
assert.ok(fs.existsSync(htmlPath));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-integrated-search-'));
process.on('exit', () => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {} });
const userData = path.join(tempRoot, 'profile');
const sessionData = path.join(tempRoot, 'session');
const downloadsRoot = path.join(tempRoot, 'downloads');
fs.mkdirSync(userData);
fs.mkdirSync(sessionData);
fs.mkdirSync(downloadsRoot);
assert.equal(path.dirname(tempRoot), os.tmpdir(), 'Electron user data is isolated under the OS temp folder');

const videoPath = path.join(tempRoot, 'synthetic-episode.mp4');
const subtitlePath = path.join(tempRoot, 'synthetic-korean.vtt');
execFileSync(require('ffmpeg-static'), [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
  '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath
], { stdio: 'pipe' });
fs.writeFileSync(subtitlePath, 'WEBVTT\n\n00:00:00.500 --> 00:00:04.000\n한국어 합성 자막 첫 문장\n\n00:00:04.500 --> 00:00:08.000\n한국어 합성 자막 두 번째 문장\n');
const videoUrl = pathToFileURL(videoPath).href;
const subtitleUrl = pathToFileURL(subtitlePath).href;

app.setPath('userData', userData);
app.setPath('sessionData', sessionData);
app.disableHardwareAcceleration();

const blockedRequests = [];
const ipcCalls = [];
const rendererErrors = [];
let copiedDiagnostics = '';
let titleVariantsResolved = false;
let delayedProviderSearchStarted = false;
let resolveDelayedProviderSearchStarted;
let resolveDelayedProviderSearchResults;
const delayedProviderSearchStartedPromise = new Promise(resolve => { resolveDelayedProviderSearchStarted = resolve; });
const delayedProviderSearchResults = new Promise(resolve => { resolveDelayedProviderSearchResults = resolve; });
let win;

function fail(error) {
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
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(?:file:|data:|blob:)/i.test(details.url)) callback({ cancel: false });
    else { blockedRequests.push(details.url); callback({ cancel: true }); }
  });

  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => fixture(channel, args));

  const createWindow = () => {
    const window = new BrowserWindow({
      show: false,
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
  win = createWindow();
  await win.loadFile(htmlPath);

  await waitFor('initial app render', () => win.webContents.executeJavaScript('Boolean(window.lilac && document.querySelector("#searchButton"))'));
  const expiredEpisode = {
    provider: 'reanime', id: 'ra-smoke-episode-1', animeId: items.reanime.id,
    name: '1', number: 1, title: '1화', url: 'https://reanime.to/watch/ra-smoke?ep=1', playable: true
  };
  const migrationHistory = [
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
  await win.webContents.executeJavaScript(`localStorage.setItem('history', ${JSON.stringify(JSON.stringify(migrationHistory))})`);
  const migrationReload = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload();
  await migrationReload;
  const migratedHistory = await waitFor('expired local proxy history migration', async () => {
    const state = await win.webContents.executeJavaScript(`(() => {
      const entries = JSON.parse(localStorage.getItem('history') || '[]');
      return {
        entries,
        continueCards: document.querySelectorAll('#continueRail .continue-card').length
      };
    })()`);
    return state.entries.length === 2 && state.entries[0]?.src === '' && state.entries[1]?.src === ''
      && state.entries[1]?.key === 'expired-flix:expired-session-two' && state.continueCards === 1 ? state : null;
  });
  assert.equal(migratedHistory.entries[0].episode.url, expiredEpisode.url,
    'watch metadata survives while the expired proxy address is removed');
  assert.equal(migratedHistory.entries[0].progress, 41);
  assert.equal(migratedHistory.entries[1].playbackSourceExpired, true,
    'legacy direct-play history remains in storage and records why it cannot resume');
  assert.equal(migratedHistory.continueCards, 1,
    'the history without a playable source does not appear in continue watching');

  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#pageSearch');
    input.value = '통합 검색 테스트';
    document.querySelector('#searchButton').click();
  })()`);

  await waitFor('first phase results before title variants return', async () => {
    const state = await win.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('#searchGrid .anime-card').length,
      status: document.querySelector('#searchStatus')?.textContent || '',
      providers: [...document.querySelectorAll('#searchProviderFilters [data-provider]')].map(button => button.dataset.provider)
    })`);
    return !titleVariantsResolved && state.cards >= 3 && state.status.includes('다른 제목 표기 준비 중') ? state : null;
  });
  assert.equal(titleVariantsResolved, false, 'first-page cards appear while title-variant lookup is still pending');

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
    return state.cards === 3 && state.status.includes('경합 확인 테스트') && !state.status.includes('다른 제목 표기 준비 중') ? state : null;
  });
  assert.ok(replacementSearch.status.includes('경합 확인 테스트'));
  await waitFor('stale title variants completion', () => titleVariantsResolved);
  await new Promise(resolve => setTimeout(resolve, 50));
  const afterStaleResponse = await win.webContents.executeJavaScript(`({
    cards: document.querySelectorAll('#searchGrid .anime-card').length,
    status: document.querySelector('#searchStatus')?.textContent || ''
  })`);
  assert.equal(afterStaleResponse.cards, 3);
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
  await waitFor('merged variant results', async () => {
    const state = await win.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('#searchGrid .anime-card').length,
      count: document.querySelector('#searchGrid .source-count-badge')?.textContent || '',
      providers: [...document.querySelectorAll('#searchProviderFilters [data-provider]')].map(button => button.dataset.provider)
    })`);
    return titleVariantsResolved && state.cards === 3 && state.count === '3개 소스' && state.providers.length === 6 ? state : null;
  });

  await win.webContents.executeJavaScript(`document.querySelector('#searchProviderFilters [data-provider="miruro"]').click()`);
  const miruroView = await waitFor('Miruro provider filter', async () => win.webContents.executeJavaScript(`({
    cards: document.querySelectorAll('#searchGrid .anime-card').length,
    pressed: document.querySelector('#searchProviderFilters [data-provider="miruro"]')?.getAttribute('aria-pressed')
  })`));
  assert.deepEqual(miruroView, { cards: 1, pressed: 'true' });

  await win.webContents.executeJavaScript(`document.querySelector('#searchGrid .anime-card').click()`);
  await waitFor('detail source picker', () => win.webContents.executeJavaScript('Boolean(document.querySelector("#detailContent [data-detail-source]"))'));
  const initialSelection = await win.webContents.executeJavaScript(`({
    count: document.querySelectorAll('#detailContent [data-detail-source]').length,
    selected: document.querySelector('#detailContent [data-detail-source][aria-pressed="true"]')?.dataset.detailSource || ''
  })`);
  assert.equal(initialSelection.count, 3);
  assert.equal(initialSelection.selected, items.miruro.mal_id, 'details initially follow the active Miruro result filter');

  await win.webContents.executeJavaScript(`document.querySelector('#detailContent [data-detail-source="${items.reanime.mal_id}"]').click()`);
  await waitFor('selected Re:Anime detail refresh', async () => win.webContents.executeJavaScript(`
    document.querySelector('#detailContent [data-detail-source="${items.reanime.mal_id}"]')?.getAttribute('aria-pressed') === 'true'
  `));
  await waitFor('Re:Anime episode list', () => win.webContents.executeJavaScript('Boolean(document.querySelector("#detailContent .episode-btn"))'));
  await win.webContents.executeJavaScript('document.querySelector("#detailContent .episode-btn").click()');

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
  const detailResumedPlayback = await waitFor('detail resume choice restores saved position', () => win.webContents.executeJavaScript(`(() => {
    const video = document.querySelector('#video');
    if (video?.duration >= 11.9 && video.currentTime >= 11.3) {
      video.pause();
      return { currentTime: video.currentTime, duration: video.duration };
    }
    return null;
  })()`), 8000);
  assert.ok(detailResumedPlayback.currentTime < detailResumedPlayback.duration,
    'the explicit detail choice resumes before the episode ends');

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

  const closeTime = await win.webContents.executeJavaScript(`(async () => {
    const video = document.querySelector('#video');
    const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    video.currentTime = 6.25;
    await Promise.race([seeked, new Promise(resolve => setTimeout(resolve, 1000))]);
    const history = JSON.parse(localStorage.getItem('history') || '[]');
    const episode = history.find(entry => entry.episode?.provider === 'reanime' && Number(entry.episode?.number) === 1);
    if (!episode) throw new Error('The current Re:Anime episode is missing before the window-close check');
    episode.progress = 96;
    localStorage.setItem('history', JSON.stringify(history));
    const inMemoryEpisode = state.history.find(entry => entry.episode?.provider === 'reanime' && Number(entry.episode?.number) === 1);
    if (!inMemoryEpisode) throw new Error('The in-memory Re:Anime episode is missing before the window-close check');
    inMemoryEpisode.progress = 96;
    return { currentTime: video.currentTime, duration: video.duration };
  })()`);
  assert.equal(closeTime.currentTime, 6.25);
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
  assert.equal(closeResumedProgress, 52,
    'closing the Electron window flushes the live position instead of retaining the older saved value');

  assert.deepEqual(blockedRequests, [], `unexpected external request attempts were blocked: ${blockedRequests.join(', ')}`);
  assert.deepEqual(rendererErrors, [], `renderer console errors: ${rendererErrors.join('; ')}`);
  const searchCalls = ipcCalls.filter(call => ['provider:catalog', 'catalog:search-korean', 'linkkf:search'].includes(call.channel));
  assert.ok(searchCalls.length >= 8, `synthetic provider search calls recorded (${searchCalls.length})`);
  console.log(`Packaged Phase 1 smoke passed: expired proxy history preservation, integrated search, source picker, local episode playback, active Korean VTT, saved progress and continue-watch resume, 96% detail start-over/continue choice, live progress flush on Electron window close, and user-invoked privacy-filtered diagnostics copy.`);
  console.log(`Synthetic search IPC calls: ${searchCalls.length}; provider resolve calls: ${ipcCalls.filter(call => call.channel === 'provider:resolve').length}; saved progress: ${savedProgress.progress}%; resumed at: ${resumedPlayback.currentTime.toFixed(2)}s.`);
  console.log(`Detail alternate resume position: ${detailResumedPlayback.currentTime.toFixed(2)}s / ${detailResumedPlayback.duration.toFixed(2)}s.`);
  console.log(`Window-close resume position: ${closeResumedProgress}% (current playback was ${closeTime.currentTime.toFixed(2)}s / ${closeTime.duration.toFixed(2)}s).`);
  console.log(`Renderer errors: ${rendererErrors.length}; blocked external request attempts: ${blockedRequests.length}; userData and synthetic media: isolated temp folder.`);
  win.destroy();
  app.quit();
}).catch(fail);
