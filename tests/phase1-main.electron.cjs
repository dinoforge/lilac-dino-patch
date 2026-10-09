// Packaged Electron main/preload Phase 1 smoke test with fail-closed network fixtures.
// Build the app first, then run: npm run test:phase1-main
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const { app, BrowserWindow, net, session } = require('electron');
const asar = require('@electron/asar');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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
const redirectedFlixRequests = [];
const localBrowserRequests = [];
const deniedUnknownFetches = [];
const guardedSessions = new WeakSet();
const SEARCH_TITLE = '메인 처리기 검증 작품';
const SLUG = 'phase1-main-fixture';
let localBase = '';
const localPlayerServer = http.createServer((request, response) => {
  localBrowserRequests.push(request.url || '/');
  response.setHeader('access-control-allow-origin', '*');
  if (request.url === `/e/${SLUG}`) {
    const mediaUrl = `http://127.0.0.1:${localPlayerServer.address().port}/master.m3u8`;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body><video></video><script>
      window.__pk = 'fixture-key';
      const media = ${JSON.stringify(mediaUrl)};
      const player = { setup: () => {} };
      player.setup({subtitles:[{url:"https://subtitles.invalid/phase1-ko.vtt",language:"ko",label:"한국어",format:"vtt"}]});
      window.jwplayer = () => ({ getPlaylistItem: () => ({ file: media, sources: [{ file: media }] }), play: () => Promise.resolve() });
      fetch(media).catch(() => {});
    </script></body></html>`);
    return;
  }
  if (request.url === '/master.m3u8') {
    response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n');
    return;
  }
  response.writeHead(404).end();
});
localPlayerServer.listen(0, '127.0.0.1');
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
  if (url.hostname === 'subtitles.invalid' && url.pathname === '/phase1-ko.vtt') {
    fixtureRequests.push(url.href);
    return response('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n합성 한국어 자막\n', 200, 'text/vtt');
  }
  if (localBase && url.origin === localBase && url.pathname === '/master.m3u8') {
    fixtureRequests.push(url.href);
    return response('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n', 200, 'application/vnd.apple.mpegurl');
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
  if (guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const url = new URL(details.url);
    const loopback = localBase && url.origin === localBase;
    if (loopback) { callback({ cancel: false }); return; }
    if (url.hostname === 'flixcloud.cc' && url.pathname === `/e/${SLUG}`) {
      redirectedFlixRequests.push(details.url);
      callback({ redirectURL: `${localBase}${url.pathname}` });
      return;
    }
    deniedBrowserRequests.push(details.url);
    callback({ cancel: true });
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

function requestLoopback(urlText) {
  const url = new URL(urlText);
  if (url.hostname !== '127.0.0.1') throw new Error(`Refusing non-loopback test request: ${url.origin}`);
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

app.on('session-created', blockSessionRequests);
app.once('ready', () => blockSessionRequests(session.defaultSession));
require(path.join(appAsar, 'electron', 'main.cjs'));

app.whenReady().then(async () => {
  try {
    await new Promise((resolve, reject) => {
      if (localPlayerServer.listening) { localBase = `http://127.0.0.1:${localPlayerServer.address().port}`; resolve(); return; }
      localPlayerServer.once('listening', () => { localBase = `http://127.0.0.1:${localPlayerServer.address().port}`; resolve(); });
      localPlayerServer.once('error', reject);
    });
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

    const resolvedStream = await win.webContents.executeJavaScript(
      `window.lilac.providerResolve(${JSON.stringify(detail.episodes[0])})`
    );
    const streamUrl = new URL(resolvedStream.url);
    assert.equal(streamUrl.hostname, '127.0.0.1', 'FlixCloud resolve returns the app-owned loopback proxy');
    assert.match(streamUrl.pathname, /^\/__flix\/[a-f0-9]+\//);
    assert.ok(resolvedStream.subtitlePath && fs.existsSync(resolvedStream.subtitlePath), `the synthetic Korean VTT is saved under isolated userData: ${JSON.stringify({ resolvedStream, fixtureRequests, redirectedFlixRequests, localBrowserRequests, deniedBrowserRequests })}`);
    assert.match(resolvedStream.subtitlePath, new RegExp(`^${userData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(resolvedStream.subtitleTracks[0].language, 'ko');
    const proxiedManifest = await requestLoopback(resolvedStream.url);
    assert.equal(proxiedManifest.status, 200);
    assert.match(proxiedManifest.body, /^#EXTM3U/);
    assert.match(proxiedManifest.body, /#EXTINF:4,[\r\n]+http:\/\/127\.0\.0\.1:\d+\/__flix\//,
      'the app proxy rewrites the fixture manifest segment to its own loopback route');

    assert.ok(fixtureRequests.some(url => new URL(url).searchParams.get('q') === SEARCH_TITLE), 'search reached the synthetic Re:Anime API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/v1/anime/${SLUG}/episodes`)), 'detail reached the synthetic episode API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/watch/${SLUG}/1`)), 'subtitle lookup reached the synthetic episode-server API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/watch/${SLUG}/99`)), 'unavailable resolve reached the synthetic episode-server API');
    assert.ok(fixtureRequests.some(url => url === 'https://subtitles.invalid/phase1-ko.vtt'), 'resolved stream downloaded the synthetic Korean VTT');
    assert.ok(fixtureRequests.some(url => localBase && url === `${localBase}/master.m3u8`), 'the app proxy fetched only the synthetic loopback manifest');
    assert.equal(redirectedFlixRequests.length, 1, 'the FlixCloud page was redirected before external network access');
    assert.ok(localBrowserRequests.includes(`/e/${SLUG}`), 'the resolver loaded the local player fixture');
    assert.ok(localBrowserRequests.includes('/master.m3u8'), 'the resolver observed the synthetic HLS manifest request');
    assert.ok(fetchAttempts.length > 0, 'the test exercised the packaged main process network boundary');

    console.log('Packaged Phase 1 main-process smoke passed: actual main IPC search/detail/episodes, Korean subtitle parsing and save, unavailable-server feedback, and successful loopback-only HLS proxy resolution.');
    console.log(`Synthetic HTTP fixture calls: ${fixtureRequests.length}; FlixCloud redirects to loopback: ${redirectedFlixRequests.length}; local resolver requests: ${localBrowserRequests.length}; denied unknown fetches: ${deniedUnknownFetches.length}; blocked browser requests: ${deniedBrowserRequests.length}; external network calls: 0.`);
    await new Promise(resolve => localPlayerServer.close(resolve));
    app.quit();
  } catch (error) { fail(error); }
}).catch(fail);

process.on('exit', () => {
  try { if (localPlayerServer.listening) localPlayerServer.close(); } catch {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
