// Packaged Electron main/preload Phase 1 smoke test with fail-closed network fixtures.
// Build the app first, then run: npm run test:phase1-main
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const { app, BrowserWindow, net, session } = require('electron');
const { execFileSync } = require('node:child_process');
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
for (const file of ['src/app.js', 'src/player.js']) {
  assert.deepEqual(
    asar.extractFile(appAsar, file),
    fs.readFileSync(path.join(repo, file)),
    `the packaged renderer ${file} matches the current source`
  );
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-phase1-main-'));
const userData = path.join(tempRoot, 'profile');
const sessionData = path.join(tempRoot, 'session');
fs.mkdirSync(userData);
fs.mkdirSync(sessionData);
const hlsManifestPath = path.join(tempRoot, 'synthetic.m3u8');
const hlsSegmentPath = path.join(tempRoot, 'segment000.ts');
execFileSync(require('ffmpeg-static'), [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
  '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '96', '-keyint_min', '96',
  '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-f', 'hls', '-hls_time', '10', '-hls_list_size', '0',
  '-hls_segment_filename', path.join(tempRoot, 'segment%03d.ts'), hlsManifestPath
], { stdio: 'pipe' });
const syntheticManifest = fs.readFileSync(hlsManifestPath, 'utf8');
const syntheticSegment = fs.readFileSync(hlsSegmentPath);
assert.match(syntheticManifest, /segment000\.ts/);
assert.ok(syntheticSegment.length >= 376, 'the synthetic HLS segment is long enough to contain MPEG-TS sync bytes');
assert.ok([0, 188, 376].every(offset => syntheticSegment[offset] === 0x47), 'the synthetic HLS segment has MPEG-TS sync bytes');
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
const allowedLoopbackBrowserRequests = [];
const localProxyRequests = [];
const deniedUnknownFetches = [];
const guardedSessions = new WeakSet();
const SEARCH_TITLE = '메인 처리기 검증 작품';
const SLUG = 'phase1-main-fixture';
let localBase = '';
const allowedBrowserOrigins = new Set();
const localPlayerServer = http.createServer((request, response) => {
  localBrowserRequests.push(request.url || '/');
  response.setHeader('access-control-allow-origin', '*');
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  if (requestUrl.pathname === `/e/${SLUG}`) {
    const serverName = requestUrl.searchParams.get('server') || 'HD-2';
    const mediaUrl = `http://127.0.0.1:${localPlayerServer.address().port}/master.m3u8?server=${encodeURIComponent(serverName)}`;
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
  if (requestUrl.pathname === '/master.m3u8') {
    response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    response.end(syntheticManifest);
    return;
  }
  if (requestUrl.pathname === '/segment000.ts') {
    response.writeHead(200, { 'content-type': 'video/mp2t' });
    response.end(syntheticSegment);
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
  const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
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
    return response({ episode_links: number === 1 ? [
      { serverName: 'HD-2', dataLink: `https://flixcloud.cc/e/${SLUG}?server=HD-2` },
      { serverName: 'HD-1', dataLink: `https://flixcloud.cc/e/${SLUG}?server=HD-1` }
    ] : [] });
  }
  if (url.hostname === 'flixcloud.cc' && url.pathname === `/e/${SLUG}`) {
    fixtureRequests.push(url.href);
    return response('<script>player.setup({subtitles:[{url:"https://subtitles.invalid/phase1-ko.vtt",language:"ko",label:"한국어",format:"vtt"}]});</script>', 200, 'text/html');
  }
  if (url.hostname === 'subtitles.invalid' && url.pathname === '/phase1-ko.vtt') {
    fixtureRequests.push(url.href);
    return response('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n합성 한국어 자막\n', 200, 'text/vtt');
  }
  if (url.hostname === 'api.aniskip.com' && url.pathname.startsWith('/v2/skip-times/')) {
    fixtureRequests.push(url.href);
    return response({ found: true, results: [] });
  }
  if (localBase && url.origin === localBase && url.pathname === '/master.m3u8') {
    fixtureRequests.push(url.href);
    return response(syntheticManifest, 200, 'application/vnd.apple.mpegurl');
  }
  if (localBase && url.origin === localBase && url.pathname === '/segment000.ts') {
    fixtureRequests.push(url.href);
    return response(syntheticSegment, 200, 'video/mp2t');
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
    const loopback = url.hostname === '127.0.0.1' && allowedBrowserOrigins.has(url.origin);
    if (loopback) { allowedLoopbackBrowserRequests.push(`${url.origin}${url.pathname}`); callback({ cancel: false }); return; }
    if (url.hostname === 'flixcloud.cc' && url.pathname === `/e/${SLUG}`) {
      redirectedFlixRequests.push(details.url);
      callback({ redirectURL: `${localBase}${url.pathname}${url.search}` });
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
  localProxyRequests.push(url.pathname);
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode, body, text: body.toString('utf8') });
      });
    }).on('error', reject);
  });
}

app.on('session-created', blockSessionRequests);
app.once('ready', () => blockSessionRequests(session.defaultSession));
require(path.join(appAsar, 'electron', 'main.cjs'));

app.whenReady().then(async () => {
  try {
    await new Promise((resolve, reject) => {
      if (localPlayerServer.listening) { localBase = `http://127.0.0.1:${localPlayerServer.address().port}`; allowedBrowserOrigins.add(localBase); resolve(); return; }
      localPlayerServer.once('listening', () => { localBase = `http://127.0.0.1:${localPlayerServer.address().port}`; allowedBrowserOrigins.add(localBase); resolve(); });
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
    allowedBrowserOrigins.add(streamUrl.origin);
    assert.ok(resolvedStream.subtitlePath && fs.existsSync(resolvedStream.subtitlePath), `the synthetic Korean VTT is saved under isolated userData: ${JSON.stringify({ resolvedStream, fixtureRequests, redirectedFlixRequests, localBrowserRequests, deniedBrowserRequests })}`);
    assert.match(resolvedStream.subtitlePath, new RegExp(`^${userData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(resolvedStream.subtitleUrl, /^file:\/\//i);
    assert.equal(resolvedStream.subtitleTracks[0].language, 'ko');
    const proxiedManifest = await requestLoopback(resolvedStream.url);
    assert.equal(proxiedManifest.status, 200);
    assert.match(proxiedManifest.text, /^#EXTM3U/);
    assert.match(proxiedManifest.text, /#EXTINF:[\d.]+,[\r\n]+http:\/\/127\.0\.0\.1:\d+\/__flix\//,
      'the app proxy rewrites the fixture manifest segment to its own loopback route');
    const segmentUrl = proxiedManifest.text.split(/\r?\n/).find(line => line.startsWith('http://127.0.0.1:') && line.includes('/__flix/'));
    assert.ok(segmentUrl, 'the synthetic manifest has a rewritten segment URL');
    const proxiedSegment = await requestLoopback(segmentUrl);
    assert.equal(proxiedSegment.status, 200);
    assert.deepEqual(proxiedSegment.body, syntheticSegment, 'the app proxy returned the playable synthetic MPEG-TS segment bytes');

    const fixtureEpisode = JSON.stringify(detail.episodes[0]);
    const playbackTitle = `${animeFixture.title.english} · 1화`;
    const playbackStarted = await win.webContents.executeJavaScript(`(async () => {
      if (typeof window.resolveIntoPlayer !== 'function') return false;
      const episode = ${fixtureEpisode};
      await window.resolveIntoPlayer(
        () => window.lilac.providerResolve(episode),
        ${JSON.stringify(playbackTitle)},
        { episode, serverOverride: 'HD-2' },
        ${JSON.stringify(animeFixture.title.english)},
        1
      );
      return true;
    })()`);
    assert.equal(playbackStarted, true, 'the packaged renderer resolved the episode through its production player flow');
    await waitFor('packaged HLS video decode and Korean cue', async () => win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      const cueText = [...(video?.textTracks?.[0]?.activeCues || [])].map(cue => cue.text).join(' ');
      const ready = video?.readyState >= 2 && video.videoWidth === 320 && video.videoHeight === 180
        && video.currentTime >= 1 && cueText.includes('합성 한국어 자막');
      if (ready) video.pause();
      return ready;
    })()`), 25000);
    const playbackState = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      return {
        readyState: video.readyState,
        currentTime: video.currentTime,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        subtitleMode: video.textTracks[0]?.mode || '',
        activeCueText: [...(video.textTracks[0]?.activeCues || [])].map(cue => cue.text).join(' ')
      };
    })()`);
    assert.equal(playbackState.width, 320);
    assert.equal(playbackState.height, 180);
    assert.ok(playbackState.currentTime >= 1 && playbackState.currentTime < 3, JSON.stringify(playbackState));
    assert.equal(playbackState.subtitleMode, 'showing');
    assert.match(playbackState.activeCueText, /합성 한국어 자막/);

    await new Promise(resolve => setTimeout(resolve, 5200));
    const progressCardText = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      video.currentTime = 2;
      video.dispatchEvent(new Event('timeupdate'));
      return document.querySelector('#continueRail .continue-card')?.innerText || '';
    })()`);
    assert.match(progressCardText, /EP\.1\s*·\s*50%/, `the actual player stored the two-second HLS position: ${progressCardText}`);
    await new Promise(resolve => setTimeout(resolve, 200));
    const reloadFinished = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await reloadFinished;
    await waitFor('packaged preload after history reload', () => win.webContents.executeJavaScript('Boolean(window.lilac && window.lilac.providerResolve)'));
    const persistedProgressText = await waitFor('continue card after history reload', async () => win.webContents.executeJavaScript(
      "document.querySelector('#continueRail .continue-card')?.innerText || ''"
    ), 8000);
    assert.match(persistedProgressText, /EP\.1\s*·\s*50%/, `the updated HLS progress survives reload: ${persistedProgressText}`);
    const resumed = await win.webContents.executeJavaScript(`(async () => {
      const episode = ${fixtureEpisode};
      await window.resolveIntoPlayer(
        () => window.lilac.providerResolve(episode),
        ${JSON.stringify(playbackTitle)},
        { episode, serverOverride: 'HD-2', resumeProgress: 50 },
        ${JSON.stringify(animeFixture.title.english)},
        1
      );
      return true;
    })()`);
    assert.equal(resumed, true, 'the packaged player accepted the persisted HLS resume position');
    await waitFor('packaged HLS playback resumed from its saved position', async () => win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      const cueText = [...(video?.textTracks?.[0]?.activeCues || [])].map(cue => cue.text).join(' ');
      const ready = video?.readyState >= 2 && video.videoWidth === 320 && video.currentTime >= 1.8
        && video.currentTime < 2.8 && cueText.includes('합성 한국어 자막');
      if (ready) video.pause();
      return ready;
    })()`), 25000);
    const resumeState = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      return { currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight,
        subtitleMode: video.textTracks[0]?.mode || '',
        activeCueText: [...(video.textTracks[0]?.activeCues || [])].map(cue => cue.text).join(' ') };
    })()`);
    assert.ok(resumeState.currentTime >= 1.8 && resumeState.currentTime < 2.8, JSON.stringify(resumeState));
    assert.equal(resumeState.width, 320);
    assert.equal(resumeState.height, 180);
    assert.equal(resumeState.subtitleMode, 'showing');
    assert.match(resumeState.activeCueText, /합성 한국어 자막/);

    const fallbackStarted = await win.webContents.executeJavaScript(`(() => {
      if (typeof hlsPlayer === 'undefined' || !hlsPlayer || typeof hlsPlayer.trigger !== 'function'
        || currentPlaybackContext.videoServer !== 'HD-2') return false;
      hlsPlayer.trigger(window.Hls.Events.ERROR, {
        type: window.Hls.ErrorTypes.OTHER_ERROR,
        details: 'synthetic-fatal-playback-error',
        fatal: true
      });
      return true;
    })()`);
    assert.equal(fallbackStarted, true, 'the packaged Hls.js instance accepted a fatal synthetic playback error');
    await waitFor('automatic fallback server playback with subtitle and resume position', async () => win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      const cueText = [...(video?.textTracks?.[0]?.activeCues || [])].map(cue => cue.text).join(' ');
      const ready = currentPlaybackContext.videoServer === 'HD-1' && video?.readyState >= 2
        && video.videoWidth === 320 && video.currentTime >= 1.8 && video.currentTime < 2.8
        && cueText.includes('합성 한국어 자막');
      if (ready) video.pause();
      return ready;
    })()`), 25000);
    const fallbackState = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      return {
        server: currentPlaybackContext.videoServer,
        resumeSeconds: currentPlaybackContext.resumeSeconds,
        selectedSubtitleTrack: currentPlaybackContext.selectedSubtitleTrack,
        currentTime: video.currentTime,
        width: video.videoWidth,
        height: video.videoHeight,
        subtitleMode: video.textTracks[0]?.mode || '',
        activeCueText: [...(video.textTracks[0]?.activeCues || [])].map(cue => cue.text).join(' ')
      };
    })()`);
    assert.equal(fallbackState.server, 'HD-1');
    assert.ok(fallbackState.resumeSeconds >= 1.8 && fallbackState.resumeSeconds < 2.8, JSON.stringify(fallbackState));
    assert.ok(fallbackState.currentTime >= 1.8 && fallbackState.currentTime < 2.8, JSON.stringify(fallbackState));
    assert.equal(fallbackState.selectedSubtitleTrack, trackResult.tracks[0].url);
    assert.equal(fallbackState.width, 320);
    assert.equal(fallbackState.height, 180);
    assert.equal(fallbackState.subtitleMode, 'showing');
    assert.match(fallbackState.activeCueText, /합성 한국어 자막/);

    assert.ok(fixtureRequests.some(url => new URL(url).searchParams.get('q') === SEARCH_TITLE), 'search reached the synthetic Re:Anime API');
    assert.ok(fixtureRequests.some(url => new URL(url).hostname === 'api.aniskip.com'), 'the player received an empty synthetic AniSkip response');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/v1/anime/${SLUG}/episodes`)), 'detail reached the synthetic episode API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/watch/${SLUG}/1`)), 'subtitle lookup reached the synthetic episode-server API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/watch/${SLUG}/99`)), 'unavailable resolve reached the synthetic episode-server API');
    assert.ok(fixtureRequests.some(url => url === 'https://subtitles.invalid/phase1-ko.vtt'), 'resolved stream downloaded the synthetic Korean VTT');
    assert.ok(fixtureRequests.some(url => localBase && url.startsWith(`${localBase}/master.m3u8`)), 'the app proxy fetched only the synthetic loopback manifest');
    assert.ok(fixtureRequests.some(url => localBase && url === `${localBase}/segment000.ts`), 'the app proxy fetched only the synthetic loopback segment');
    assert.equal(redirectedFlixRequests.length, 4, 'all FlixCloud fixture loads were redirected before external network access');
    assert.ok(redirectedFlixRequests.some(url => new URL(url).searchParams.get('server') === 'HD-1'), 'the main process resolved the alternate HD-1 server');
    assert.ok(localBrowserRequests.some(url => url.startsWith(`/e/${SLUG}?server=`)), 'the resolver loaded both local server fixtures');
    assert.ok(localBrowserRequests.some(url => url.startsWith('/master.m3u8?server=')), 'the resolver observed synthetic HLS manifest requests for both servers');
    const rendererProxyRequests = allowedLoopbackBrowserRequests.filter(url => url.startsWith(`${streamUrl.origin}/__flix/`));
    assert.ok(rendererProxyRequests.length >= 6, 'the packaged renderer fetched HLS manifests and media segments for initial play, resume, and server fallback');
    assert.ok(fetchAttempts.length > 0, 'the test exercised the packaged main process network boundary');
    assert.equal(deniedUnknownFetches.length, 0, `no unregistered main-process URL was requested: ${deniedUnknownFetches.join(', ')}`);
    assert.equal(deniedBrowserRequests.length, 0, `no external browser request was allowed or attempted: ${deniedBrowserRequests.join(', ')}`);

    console.log('Packaged Phase 1 main-process smoke passed: actual main IPC search/detail/episodes, Korean subtitle parsing and save, loopback HLS decode, Korean WebVTT cue, persisted resume, and automatic same-kind server fallback.');
    console.log(`Playback: ${playbackState.width}x${playbackState.height} at ${playbackState.currentTime.toFixed(2)}s; resume: ${resumeState.currentTime.toFixed(2)}s from saved 50%; fallback: ${fallbackState.server} at ${fallbackState.currentTime.toFixed(2)}s with selected subtitle; synthetic HTTP fixture calls: ${fixtureRequests.length}; FlixCloud redirects to loopback: ${redirectedFlixRequests.length}; local resolver requests: ${localBrowserRequests.length}; renderer proxy requests: ${rendererProxyRequests.length}; local proxy requests: ${localProxyRequests.length}; denied unknown fetches: 0; blocked browser requests: 0; external network calls: 0.`);
    await new Promise(resolve => localPlayerServer.close(resolve));
    app.quit();
  } catch (error) { fail(error); }
}).catch(fail);

process.on('exit', () => {
  try { if (localPlayerServer.listening) localPlayerServer.close(); } catch {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
