// Packaged Electron main/preload Phase 1 smoke test with fail-closed network fixtures.
// Build the app first, then run: npm run test:phase1-main
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const { app, BrowserWindow, net, session } = require('electron');
const asar = require('@electron/asar');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const appAsar = path.join(repo, 'dist', 'win-unpacked', 'resources', 'app.asar');
assert.ok(fs.existsSync(appAsar), `packaged app.asar exists: ${appAsar}`);
assert.ok(fs.existsSync(path.join(appAsar, 'electron', 'main.cjs')), 'packaged main entry exists');
assert.deepEqual(
  asar.extractFile(appAsar, 'electron/main.cjs'),
  fs.readFileSync(path.join(repo, 'electron', 'main.cjs')),
  'the packaged main process matches the current source'
);
assert.deepEqual(
  asar.extractFile(appAsar, 'electron/preload.cjs'),
  fs.readFileSync(path.join(repo, 'electron', 'preload.cjs')),
  'the packaged preload matches the current source'
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-phase1-main-'));
const userData = path.join(tempRoot, 'profile');
const sessionData = path.join(tempRoot, 'session');
fs.mkdirSync(userData);
fs.mkdirSync(sessionData);
app.setPath('userData', userData);
app.setPath('sessionData', sessionData);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.disableHardwareAcceleration();
BrowserWindow.prototype.show = function hideSmokeWindow() {};

const fetchAttempts = [];
const fixtureRequests = [];
const deniedBrowserRequests = [];
const deniedUnknownFetches = [];
const SEARCH_TITLE = '메인 처리기 검증 작품';
const SLUG = 'phase1-main-fixture';
const animeFixture = {
  anime_id: SLUG,
  title: { english: 'Main Handler Fixture', native: '메인 처리기 검증 작품', romaji: 'Main Handler Fixture' },
  cover_image: { extra_large: '' },
  format: 'TV',
  season: 'FALL',
  season_year: 2026,
  episodes: 2,
  subbed: 2,
  dubbed: 0,
  average_score: 82,
  anilist_id: 62001,
  mal_id: 72001,
  status: 'RELEASING',
  description: '합성 main-process 테스트 작품'
};

function response(body, status = 200, contentType = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

function fixtureResponse(rawUrl) {
  const url = new URL(String(rawUrl));
  if (url.hostname === 'reanime.to' && url.pathname === '/api/v1/search') {
    fixtureRequests.push(url.href);
    const matches = url.searchParams.get('q') === SEARCH_TITLE;
    return response({ data: matches ? [animeFixture] : [], total: matches ? 1 : 0 });
  }
  if (url.hostname === 'reanime.to' && url.pathname === `/anime/${SLUG}`) {
    fixtureRequests.push(url.href);
    return response('<!doctype html><html><head><title>fixture</title></head><body><h1>합성 상세</h1></body></html>', 200, 'text/html');
  }
  if (url.hostname === 'reanime.to' && url.pathname === `/api/v1/anime/${SLUG}`) {
    fixtureRequests.push(url.href);
    return response({
      ...animeFixture,
      title: { ...animeFixture.title },
      episodes_total: 2,
      genres: ['Drama'],
      studios: [{ name: 'Fixture Studio' }],
      start_date: { year: 2026, month: 10, day: 1 },
      end_date: null
    });
  }
  if (url.hostname === 'reanime.to' && url.pathname === `/api/v1/anime/${SLUG}/episodes`) {
    fixtureRequests.push(url.href);
    return response({ data: [{ episode_number: 1, title: '첫 번째 회차', playable: true, subbed: true }] });
  }
  if (url.hostname === 'reanime.to' && url.pathname.startsWith(`/api/watch/${SLUG}/`)) {
    fixtureRequests.push(url.href);
    const number = Number(url.pathname.split('/').at(-1));
    return response({ episode_links: number === 1 ? [{
      serverName: 'HD-2',
      dataLink: `https://flixcloud.cc/e/${SLUG}`
    }] : [] });
  }
  if (url.hostname === 'flixcloud.cc' && url.pathname === `/e/${SLUG}`) {
    fixtureRequests.push(url.href);
    return response('<script>player.setup({subtitles:[{url:"https://subtitles.invalid/phase1-ko.vtt",language:"ko",label:"한국어",format:"vtt"}]});</script>', 200, 'text/html');
  }
  deniedUnknownFetches.push(url.href);
  return response('blocked by phase1-main fixture', 503, 'text/plain');
}

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  fetchAttempts.push(url);
  return fixtureResponse(url);
};
net.fetch = async (input) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  fetchAttempts.push(url);
  return fixtureResponse(url);
};

function blockSessionRequests(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const scheme = new URL(details.url).protocol;
    if (scheme === 'file:' || scheme === 'data:' || scheme === 'blob:') callback({ cancel: false });
    else {
      deniedBrowserRequests.push(details.url);
      callback({ cancel: true });
    }
  });
}

function fail(error) {
  console.error(error?.stack || error);
  try { app.exit(1); } catch { process.exitCode = 1; }
}

function waitFor(label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
        if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
        setTimeout(poll, 30);
      } catch (error) { reject(error); }
    };
    poll();
  });
}

app.once('ready', () => blockSessionRequests(session.defaultSession));
require(path.join(appAsar, 'electron', 'main.cjs'));

app.whenReady().then(async () => {
  try {
    const win = await waitFor('packaged app window', () => BrowserWindow.getAllWindows().find(item => !item.isDestroyed()));
    await waitFor('packaged preload API', () => win.webContents.executeJavaScript('Boolean(window.lilac && window.lilac.providerCatalog)'));

    const search = await win.webContents.executeJavaScript(
      `window.lilac.providerCatalog('reanime', ${JSON.stringify(SEARCH_TITLE)}, 0, '')`
    );
    assert.equal(search.data.length, 1, 'the real packaged main handler returns one fixture search result');
    assert.equal(search.data[0].id, SLUG);
    assert.equal(search.data[0].title, animeFixture.title.english);
    assert.equal(search.data[0].provider, 'reanime');

    const detail = await win.webContents.executeJavaScript(
      `window.lilac.providerDetail(${JSON.stringify(search.data[0])})`
    );
    assert.equal(detail.data.synopsis, animeFixture.description);
    assert.equal(detail.data.title_japanese, animeFixture.title.native);
    assert.equal(detail.episodes.length, 1);
    assert.equal(detail.episodes[0].number, 1);
    assert.equal(detail.episodes[0].playable, true);

    const trackResult = await win.webContents.executeJavaScript(
      `window.lilac.providerSubtitleTracks(${JSON.stringify(detail.episodes[0])})`
    );
    assert.equal(trackResult.tracks.length, 1);
    assert.equal(trackResult.tracks[0].language, 'ko');
    assert.equal(trackResult.tracks[0].label, '한국어');
    assert.equal(trackResult.tracks[0].url, 'https://subtitles.invalid/phase1-ko.vtt');

    const noServerEpisode = {
      ...detail.episodes[0],
      number: 99,
      anilistId: null,
      url: `https://reanime.to/watch/${SLUG}?ep=99`
    };
    const resolveError = await win.webContents.executeJavaScript(
      `(async () => { try { await window.lilac.providerResolve(${JSON.stringify(noServerEpisode)}); return ''; } catch (error) { return String(error.message || error); } })()`
    );
    assert.match(resolveError, /현재 RE:Anime에서 재생할 수 없습니다/, 'main resolve handler reports the unavailable fixture episode');

    assert.ok(fixtureRequests.some(url => new URL(url).searchParams.get('q') === SEARCH_TITLE), 'search reached the synthetic Re:Anime API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/v1/anime/${SLUG}/episodes`)), 'detail reached the synthetic episode API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/watch/${SLUG}/1`)), 'subtitle lookup reached the synthetic episode-server API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/watch/${SLUG}/99`)), 'resolve reached the synthetic unavailable-server API');
    assert.ok(fetchAttempts.length > 0, 'the test exercised the packaged main process network boundary');

    console.log('Packaged Phase 1 main-process smoke passed: actual main IPC handlers, synthetic Re:Anime search/detail/episodes, Korean subtitle-track parsing, and unavailable-server resolve feedback.');
    console.log(`Synthetic HTTP fixture calls: ${fixtureRequests.length}; denied unknown fetch calls: ${deniedUnknownFetches.length}; blocked browser requests: ${deniedBrowserRequests.length}; actual external network calls: 0; isolated userData: ${userData}.`);
    app.quit();
  } catch (error) { fail(error); }
}).catch(fail);

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
