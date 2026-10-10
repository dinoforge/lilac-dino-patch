// Packaged Electron main/preload Phase 1 smoke test with fail-closed network fixtures.
// Build the app first, then run: npm run test:phase1-main
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const electron = require('electron');
const { app, BrowserWindow, net, session } = electron;
const clipboardWrites = [];
const originalClipboardWriteText = electron.clipboard.writeText;
electron.clipboard.writeText = text => { clipboardWrites.push(String(text)); };
const externalOpenRequests = [];
const originalShellOpenExternal = electron.shell.openExternal;
electron.shell.openExternal = async url => { externalOpenRequests.push(String(url)); };
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const assert = require('node:assert/strict');
assert.notEqual(electron.clipboard.writeText, originalClipboardWriteText, 'the smoke test intercepts clipboard writes before loading the packaged main process');
assert.notEqual(electron.shell.openExternal, originalShellOpenExternal, 'the smoke test intercepts external browser launches before loading the packaged main process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const repo = path.resolve(__dirname, '..');
const formatVttTime = milliseconds => {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
};
const syntheticJapaneseSubtitle = `WEBVTT\n\n${Array.from({ length: 26 }, (_, index) => {
  const start = 1_000 + index * 250;
  return `${index + 1}\n${formatVttTime(start)} --> ${formatVttTime(start + 200)}\n日本語の合成台詞 ${index + 1}`;
}).join('\n\n')}\n`;
const restartMode = process.env.LILAC_PHASE1_RESTART_MODE || '';
const sharedTempRoot = process.env.LILAC_PHASE1_SHARED_ROOT ? path.resolve(process.env.LILAC_PHASE1_SHARED_ROOT) : '';
const parentTempRoot = process.env.LILAC_PHASE1_TEMP_ROOT ? path.resolve(process.env.LILAC_PHASE1_TEMP_ROOT) : '';
if (restartMode && !['seed', 'verify'].includes(restartMode)) throw new Error(`Unknown source restart mode: ${restartMode}`);
if (Boolean(restartMode) !== Boolean(sharedTempRoot)) throw new Error('Source restart mode requires a shared temporary profile root.');
if (restartMode && parentTempRoot) throw new Error('Source restart mode cannot use the standalone Phase 1 temporary profile root.');
if (sharedTempRoot && !path.basename(sharedTempRoot).startsWith('lilac-source-restart-')) {
  throw new Error(`Refusing an unexpected shared profile path: ${sharedTempRoot}`);
}
if (parentTempRoot) {
  const tempParent = path.resolve(os.tmpdir());
  if (path.dirname(parentTempRoot) !== tempParent || !path.basename(parentTempRoot).startsWith('lilac-phase1-main-')) {
    throw new Error(`Refusing an unexpected Phase 1 profile path: ${parentTempRoot}`);
  }
  const tempStat = fs.lstatSync(parentTempRoot);
  if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) {
    throw new Error(`Refusing a non-directory or linked Phase 1 profile path: ${parentTempRoot}`);
  }
}
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
for (const file of ['src/app.js', 'src/player.js', 'src/weekday-schedule.js', 'electron/weekday-episodes.cjs']) {
  assert.deepEqual(
    asar.extractFile(appAsar, file.replaceAll('/', '\\')),
    fs.readFileSync(path.join(repo, file)),
    `the packaged renderer ${file} matches the current source`
  );
}
for (const file of [
  'electron/translation-prompts.cjs',
  'docs/prompts/영어 번역 프롬프트.txt',
  'docs/prompts/일본어 번역 프롬프트.txt',
  'docs/prompts/Reazon_작품용_단어사전_예시.txt'
]) {
  assert.deepEqual(
    asar.extractFile(appAsar, file.replaceAll('/', '\\')),
    fs.readFileSync(path.join(repo, file)),
    `the packaged prompt resource ${file} matches the supplied source`
  );
}

const tempRoot = sharedTempRoot || parentTempRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-phase1-main-'));
const userData = path.join(tempRoot, 'profile');
const sessionData = path.join(tempRoot, 'session');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(sessionData, { recursive: true });
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
const nativeAppPipMode = process.env.LILAC_PHASE1_NATIVE_PIP === '1';
const originalBrowserWindowShow = BrowserWindow.prototype.show;
BrowserWindow.prototype.show = function hideSmokeWindow() {};

const fetchAttempts = [];
const fixtureRequests = [];
const anilistRequests = [];
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
      player.setup({subtitles:[{url:"https://subtitles.invalid/phase1-ko.vtt",language:"ko",label:"한국어",format:"vtt"},{url:"https://subtitles.invalid/phase1-ja.vtt",language:"ja",label:"日本語",format:"vtt"}]});
      window.jwplayer = () => ({ getPlaylistItem: () => ({ file: media, sources: [{ file: media }] }), play: () => Promise.resolve() });
      fetch(media).catch(() => {});
    </script></body></html>`);
    return;
  }
  if (requestUrl.pathname === '/ohli-player') {
    const masterUrl = `${localBase}/ohli-master.m3u8`;
    const subtitleUrl = `${localBase}/ohli-caption.srt`;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body><video></video><script>
      window.jwplayer = () => ({ getPlaylist: () => [{ tracks: [{ kind: 'captions', file: ${JSON.stringify(subtitleUrl)} }] }], play: () => Promise.resolve() });
      fetch(${JSON.stringify(masterUrl)}).catch(() => {});
    </script></body></html>`);
    return;
  }
  if (requestUrl.pathname === '/ohli-master.m3u8') {
    response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\n/ohli-variant.m3u8\n');
    return;
  }
  if (requestUrl.pathname === '/ohli-caption.srt') {
    response.writeHead(200, { 'content-type': 'application/x-subrip; charset=utf-8' });
    response.end('1\n00:00:01,000 --> 00:00:02,000\n합성 애니24 원본 자막\n');
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
function communityBloggerFeed(source, host) {
  const href = `https://subtitles.invalid/phase1-community-${source}.vtt`;
  return {
    feed: {
      'openSearch$totalResults': { $t: '2' },
      entry: [animeFixture.title.english, animeFixture.title.native].map((title, index) => ({
        title: { $t: `${title} 1화` },
        link: [{ rel: 'alternate', href: `https://${host}/posts/${source}-${index + 1}` }],
        content: { $t: `<p>합성 ${source} 게시물</p><a href="${href}">1화 자막</a>` }
      }))
    }
  };
}
const miruroQuarterFixture = {
  id: 'phase1-miruro-quarter',
  title: { english: 'Miruro Quarter Fixture', native: '미루로 분기 합성작', romaji: 'Miruro Quarter Fixture' },
  format: 'TV', season: 'FALL', season_year: 2026, started_on: '2026-10-01',
  episode_count: 12, episode_counts: { raw: 2, sub: 2 }, status: 'RELEASING',
  external_ids: { anilist: [62005], mal: [72005] }, cover_url: ''
};

function response(body, status = 200, contentType = 'application/json') {
  const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

function miruroResponse(body) {
  const data = zlib.gzipSync(Buffer.from(JSON.stringify(body)));
  const key = Buffer.from('miruro/catalog');
  for (let index = 0; index < data.length; index++) data[index] ^= key[index % key.length];
  return new Response(data, { headers: { 'content-type': 'application/octet-stream' } });
}

function fixtureResponse(rawUrl, requestInit = {}) {
  const url = new URL(String(rawUrl));
  if (url.hostname === 'graphql.anilist.co') {
    const request = JSON.parse(String(requestInit.body || '{}'));
    anilistRequests.push({ query: String(request.query || ''), variables: request.variables || {} });
    const now = Number(request.variables?.now) || Math.floor(Date.now() / 1000);
    fixtureRequests.push(url.href);
    return response({ data: { Page: { airingSchedules: [
      { episode: 2, airingAt: now - 120, media: { id: 62001 } },
      { episode: 3, airingAt: now - 30, media: { id: 62001 } },
      { episode: 2, airingAt: now + 30, media: { id: 62001 } },
      { episode: 1, airingAt: now - 13 * 24 * 60 * 60, media: { id: 62001 } },
      { episode: 3, airingAt: now - 100, media: { id: 62004 } },
      { episode: 5, airingAt: now - 20, media: { id: 62004 } },
      { episode: 4, airingAt: now - 10, media: { id: 62008 } },
      { episode: 1, airingAt: now - 60, media: { id: 62002 } }
    ] } } });
  }
  if (url.hostname === 'api.anissia.net' && url.pathname.startsWith('/anime/list/0')) {
    fixtureRequests.push(url.href);
    return response({ code: 'ok', data: { content: [
      { animeNo: 93001, subject: animeFixture.title.english },
      { animeNo: 93002, subject: animeFixture.title.native }
    ] } });
  }
  if (url.hostname === 'api.anissia.net' && /^\/anime\/caption\/animeNo\/(?:93001|93002)$/.test(url.pathname)) {
    fixtureRequests.push(url.href);
    return response({ code: 'ok', data: [{
      name: '합성 자막 제작자', website: 'https://phase1-anissia.blogspot.com/posts/maker', updDt: '2026-10-10'
    }] });
  }
  if (['kairan03.blogspot.com', 'csora556.blogspot.com', 'phase1-anissia.blogspot.com'].includes(url.hostname)
    && url.pathname === '/feeds/posts/default') {
    fixtureRequests.push(url.href);
    const source = url.hostname === 'kairan03.blogspot.com' ? 'kairan'
      : url.hostname === 'csora556.blogspot.com' ? 'csora' : 'anissia';
    return response(communityBloggerFeed(source, url.hostname));
  }
  if (url.hostname === 'phase1-anissia.blogspot.com' && url.pathname.startsWith('/posts/')) {
    fixtureRequests.push(url.href);
    return response('<!doctype html><html><head><meta property="og:title" content="합성 자막 제작자 게시물"></head><body><a href="https://subtitles.invalid/phase1-community-anissia.vtt">1화 자막</a></body></html>', 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'linkkf1.5imgdarr.top' && url.pathname === '/api/singlefilter.php') {
    fixtureRequests.push(url.href);
    const tag = Number(url.searchParams.get('categorytagid'));
    return response({ data: tag === 21189 ? [{ postid: '81001', postname: '합성 월요일 방영작' }] : [] });
  }
  if (url.hostname === 'query.wikidata.org' && url.pathname === '/sparql') {
    fixtureRequests.push(url.href);
    return response({ head: { vars: ['ko', 'seriesKo'] }, results: { bindings: [] } });
  }
  if (url.hostname === 'animenosub.to' && url.pathname === '/sitemap_index.xml') {
    fixtureRequests.push(url.href);
    return response('<sitemapindex><sitemap><loc>https://animenosub.to/anime-sitemap1.xml</loc></sitemap></sitemapindex>', 200, 'application/xml');
  }
  if (url.hostname === 'animenosub.to' && url.pathname === '/anime-sitemap1.xml') {
    fixtureRequests.push(url.href);
    return response('<urlset><url><loc>https://animenosub.to/anime/phase1-settings-series/</loc><image:image><image:loc>data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==</image:loc></image:image></url></urlset>', 200, 'application/xml');
  }
  if (url.hostname === 'animenosub.to' && url.pathname === '/' && !url.search) {
    fixtureRequests.push(url.href);
    return response('<article class="bs"><a href="/anime/phase1-settings-series/"><img alt="설정 전환 합성 작품" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><span class="epx">3화</span></a></article>', 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'animenosub.to' && url.pathname === '/anime/'
    && url.searchParams.get('order') === 'update' && url.searchParams.get('page') === '1') {
    fixtureRequests.push(url.href);
    return response('<article class="bs"><a href="/anime/phase1-update-series"><img alt="합성 Animenosub 최신작" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><span class="epx">12화</span></a></article>', 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'animenosub.to' && url.pathname === '/anime/'
    && url.searchParams.has('season[0]') && url.searchParams.get('order') === 'popular') {
    fixtureRequests.push(url.href);
    return response('<article class="bs"><a href="/anime/phase1-quarter-series"><img alt="합성 Animenosub 분기작" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><span class="epx">4화</span></a></article><article class="bs"><a href="/anime/phase1-upcoming-series"><img alt="합성 예정작" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><span class="epx">1화</span><span class="ans-status-ribbon">Upcoming</span></a></article>', 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'animenosub.to' && url.pathname === '/anime/'
    && url.searchParams.get('status') === 'ongoing' && url.searchParams.get('order') === 'popular') {
    fixtureRequests.push(url.href);
    return response('<article class="bs"><a href="/anime/phase1-quarter-series/"><img alt="합성 Animenosub 방영작" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><span class="epx">4화</span></a></article>', 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'animenosub.to' && url.pathname === '/anime/phase1-quarter-series/') {
    fixtureRequests.push(url.href);
    return response('<!doctype html><html><head><meta name="description" content="합성 상세 줄거리"></head><body><h1>합성 Animenosub 분기작</h1></body></html>', 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'www.ohli24.net' && url.pathname === '/ing') {
    fixtureRequests.push(url.href);
    return response('<div class="show-item"><a class="show-item-img-link" href="/81002/phase1-update.html"><img src="/poster.jpg" title="합성 애니24 최신작"></a><div class="show-item-title">합성 애니24 최신작</div><span class="show-item-eps">13화</span></div>', 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'www.ohli24.net' && url.pathname === '/81002/phase1-special.html') {
    fixtureRequests.push(url.href);
    return response('<!doctype html><html><head><meta property="og:title" content="합성 애니24 특별 회차"></head><body><ul class="article-box-meta"><li><span>원제</span><span>합성 특별작</span></li><li><span>총화수</span><span>10화</span></li></ul><div class="eps-item"><a href="/81002/phase1-10.html">10화</a><a href="/81002/phase1-9-5.html">9.5화</a><a href="/81002/phase1-9.html">9화</a><a href="/81002/phase1-8.html">8화</a></div></body></html>', 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'www.ohli24.net' && url.pathname === '/81002/phase1-9-5.html') {
    fixtureRequests.push(url.href);
    return response(`<!doctype html><html><body><iframe id="video" src="${localBase}/ohli-player"></iframe></body></html>`, 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'www.miruro.to' && url.pathname === '/api/v1/anime') {
    fixtureRequests.push(url.href);
    const selectedQuarter = url.searchParams.get('season') === 'FALL' && url.searchParams.get('season_year') === '2026';
    return miruroResponse({ data: selectedQuarter ? [miruroQuarterFixture, {
      ...miruroQuarterFixture, id: 'phase1-miruro-empty', episode_counts: { raw: 1 }, external_ids: { anilist: [62006] }
    }] : [], has_more: false, next_cursor: null });
  }
  if (url.hostname === 'www.miruro.to' && url.pathname === '/api/v1/anime/phase1-miruro-quarter/episodes') {
    fixtureRequests.push(url.href);
    return miruroResponse({ data: [{ episode_number: 1, kind: 'regular', aired_on: '2026-10-09' }] });
  }
  if (url.hostname === 'www.miruro.to' && url.pathname === '/api/v1/anime/phase1-miruro-empty/episodes') {
    fixtureRequests.push(url.href);
    return miruroResponse({ data: [] });
  }
  if (url.hostname === 'reanime.to' && url.pathname === '/api/v1/search') {
    fixtureRequests.push(url.href);
    const matchesSearch = url.searchParams.get('q') === SEARCH_TITLE;
    const requestedSeason = url.searchParams.get('season');
    const requestedYear = Number(url.searchParams.get('year'));
    const matchesQuarter = ['FALL', 'SUMMER'].includes(requestedSeason)
      && [2025, 2026].includes(requestedYear);
    const matches = matchesSearch || matchesQuarter;
    const result = matchesQuarter && !(requestedSeason === 'FALL' && requestedYear === 2026) ? {
      ...animeFixture,
      anime_id: `phase1-quarter-ui-${requestedYear}-${requestedSeason.toLowerCase()}`,
      title: { english: '분기 선택 UI 합성작', native: '分期選択合成作品', romaji: 'Quarter Selection UI Fixture' },
      season: requestedSeason,
      season_year: requestedYear,
      anilist_id: 62007,
      mal_id: 72007
    } : animeFixture;
    return response({ data: matches ? [result] : [], total: matches ? 1 : 0 });
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
    return response('<script>player.setup({subtitles:[{url:"https://subtitles.invalid/phase1-ko.vtt",language:"ko",label:"한국어",format:"vtt"},{url:"https://subtitles.invalid/phase1-ja.vtt",language:"ja",label:"日本語",format:"vtt"}]});</script>', 200, 'text/html');
  }
  if (url.hostname === 'subtitles.invalid' && url.pathname === '/phase1-ko.vtt') {
    fixtureRequests.push(url.href);
    return response('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n합성 한국어 자막\n', 200, 'text/vtt');
  }
  if (url.hostname === 'subtitles.invalid' && url.pathname === '/phase1-ja.vtt') {
    fixtureRequests.push(url.href);
    return response(syntheticJapaneseSubtitle, 200, 'text/vtt');
  }
  if (url.hostname === 'subtitles.invalid' && /^\/phase1-community-(?:kairan|csora|anissia)\.vtt$/.test(url.pathname)) {
    fixtureRequests.push(url.href);
    const source = url.pathname.match(/community-(kairan|csora|anissia)/)[1];
    const label = source === 'kairan' ? 'Kairan' : source === 'csora' ? 'Csora' : 'Anissia';
    return response(`WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n합성 ${label} 한글 자막\n`, 200, 'text/vtt');
  }
  if (url.hostname === 'jimaku.cc' && url.pathname === '/') {
    fixtureRequests.push(url.href);
    return response(`<!doctype html><html><body><div class="entry" data-extra='{"anilist_id":62001}'><a href="/entry/62001">Fixture</a></div></body></html>`, 200, 'text/html; charset=utf-8');
  }
  if (url.hostname === 'jimaku.cc' && url.pathname === '/entry/62001') {
    fixtureRequests.push(url.href);
    return response('<!doctype html><html><body></body></html>', 200, 'text/html; charset=utf-8');
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

globalThis.fetch = async (input, requestInit = {}) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  fetchAttempts.push(url);
  return fixtureResponse(url, requestInit);
};
net.fetch = async (input, requestInit = {}) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  fetchAttempts.push(url);
  return fixtureResponse(url, requestInit);
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

async function dispatchTrustedClick(win, selector) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  assert.ok(point, `control exists for native click: ${selector}`);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, button: 'none'
  });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
  });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
  });
}

async function runNativeAppPipProbe(win) {
  originalBrowserWindowShow.call(win);
  win.focus();
  await win.webContents.executeJavaScript('showPlayerControls()');
  await waitFor('visible packaged PIP button', () => win.webContents.executeJavaScript(`(() => {
    const player = document.querySelector('#immersivePlayer');
    const button = document.querySelector('#miniPlayer');
    const rect = button?.getBoundingClientRect();
    return player?.classList.contains('controls-visible') && rect?.width > 0 && rect?.height > 0;
  })()`));
  await win.webContents.debugger.attach('1.3');
  await dispatchTrustedClick(win, '#miniPlayer');

  const entered = await waitFor('the packaged player enters native PIP', () => win.webContents.executeJavaScript(`(() => {
    const video = document.pictureInPictureElement;
    const button = document.querySelector('#miniPlayer');
    if (!video || !button?.classList.contains('active')) return null;
    window.__phase1NativePipTracks = video.srcObject?.getTracks() || [];
    return { source: video.classList.contains('pip-source'), width: video.videoWidth,
      height: video.videoHeight, tracks: window.__phase1NativePipTracks.length };
  })()`), 10000);
  assert.equal(entered.source, true, JSON.stringify(entered));
  assert.equal(entered.width, 320, JSON.stringify(entered));
  assert.equal(entered.height, 180, JSON.stringify(entered));
  assert.ok(entered.tracks > 0, JSON.stringify(entered));

  await win.webContents.executeJavaScript('showPlayerControls()');
  await dispatchTrustedClick(win, '#miniPlayer');
  const closed = await waitFor('the packaged player releases native PIP resources', () => win.webContents.executeJavaScript(`(() => {
    const video = document.querySelector('video.pip-source');
    const tracks = window.__phase1NativePipTracks || [];
    const clean = !document.pictureInPictureElement
      && !document.querySelector('#miniPlayer')?.classList.contains('active')
      && video?.paused && video.srcObject === null && tracks.length > 0
      && tracks.every(track => track.readyState === 'ended');
    return clean ? { closed: true, paused: video.paused, sourceReleased: video.srcObject === null,
      tracksEnded: tracks.every(track => track.readyState === 'ended') } : null;
  })()`), 10000);
  assert.equal(closed.closed, true, JSON.stringify(closed));
  assert.equal(closed.paused, true, JSON.stringify(closed));
  assert.equal(closed.sourceReleased, true, JSON.stringify(closed));
  assert.equal(closed.tracksEnded, true, JSON.stringify(closed));
  win.webContents.debugger.detach();
  win.hide();
  console.log('Native PIP app integration passed: packaged player button entered and exited PIP with Korean HLS playback paused; capture track ended and stream released.');
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

async function runSourceRestartProbe(win) {
  let subtitlePreferenceState = null;
  const communitySubtitleEvidence = [];
  if (restartMode === 'seed') {
    await waitFor('default source before selecting Animenosub', () => win.webContents.executeJavaScript(`(() =>
      state.source === 'reanime' && document.querySelector('#contentSource')?.value === 'reanime'
    )()`), 15000);
    const reloadFinished = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for the seed source-choice reload')), 15000);
      win.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    });
    const selectedSource = await win.webContents.executeJavaScript(`(() => {
      switchView('settings');
      window.showSettingsPane?.('playback');
      const button = document.querySelector('#sourceChoices button[data-value="animenosub"]');
      if (!button) return null;
      button.click();
      return localStorage.getItem('contentSource');
    })()`);
    assert.equal(selectedSource, 'animenosub', 'the first process saved the provider through the settings button');
    await reloadFinished;
  }
  const restored = await waitFor(`${restartMode} process loads the Animenosub home`, () => win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#seasonRail .anime-card');
    const title = card?.querySelector('h3')?.textContent || '';
    if (state.source !== 'animenosub' || localStorage.getItem('contentSource') !== 'animenosub'
      || document.querySelector('#contentSource')?.value !== 'animenosub'
      || title !== '합성 Animenosub 분기작') return null;
    return {
      source: state.source,
      title,
      selected: document.querySelector('#sourceChoices button[data-value="animenosub"]')?.classList.contains('selected')
    };
  })()`), 25000);
  assert.equal(restored.selected, true, 'the selected provider is reflected in settings after the renderer starts');
  let resumeState = null;
  if (restartMode === 'seed') {
    const search = await win.webContents.executeJavaScript(
      `window.lilac.providerCatalog('reanime', ${JSON.stringify(SEARCH_TITLE)}, 0, '')`
    );
    assert.equal(search.data.length, 1, 'the seed process found the Re:Anime restart fixture');
    const detail = await win.webContents.executeJavaScript(
      `window.lilac.providerDetail(${JSON.stringify(search.data[0])})`
    );
    assert.equal(detail.episodes.length, 1, 'the seed process loaded the restart fixture episode');
    const episode = JSON.stringify(detail.episodes[0]);
    const anime = JSON.stringify(detail.data);
    const stream = await win.webContents.executeJavaScript(`window.lilac.providerResolve(${episode})`);
    const proxyOrigin = new URL(stream.url).origin;
    assert.equal(new URL(stream.url).hostname, '127.0.0.1', 'the seed playback resolves to the app-owned loopback proxy');
    allowedBrowserOrigins.add(proxyOrigin);
    await win.webContents.executeJavaScript(`(async () => {
      const episode = ${episode}, anime = ${anime};
      await window.resolveIntoPlayer(
        () => window.lilac.providerResolve(episode),
        ${JSON.stringify(`${animeFixture.title.english} · 1화`)},
        { episode, anime, serverOverride: 'HD-2' },
        ${JSON.stringify(animeFixture.title.english)},
        1
      );
      return true;
    })()`);
    await waitFor('seed process decodes the fixture episode before saving progress', () =>
      win.webContents.executeJavaScript(`(() => {
        const video = document.querySelector('#video');
        return video?.readyState >= 2 && video.videoWidth === 320 && video.videoHeight === 180;
      })()`), 20000).catch(async error => {
        const playback = await win.webContents.executeJavaScript(`(() => ({
          view: document.querySelector('.view.active')?.id || '',
          readyState: document.querySelector('#video')?.readyState || 0,
          currentTime: document.querySelector('#video')?.currentTime || 0,
          width: document.querySelector('#video')?.videoWidth || 0,
          height: document.querySelector('#video')?.videoHeight || 0,
          server: currentPlaybackContext?.videoServer || '',
          url: currentPlaybackContext?.currentUrl || '',
          resolving: Boolean(currentPlaybackContext?.resolving),
          playerMeta: document.querySelector('#playerMeta')?.textContent || '',
          downloadStatus: document.querySelector('#downloadStatus')?.textContent || ''
        }))()`);
        throw new Error(`${error.message}; seed player snapshot: ${JSON.stringify(playback)}; recent fixture requests: ${JSON.stringify(fixtureRequests.slice(-12))}; denied fetches: ${JSON.stringify(deniedUnknownFetches)}`);
      });
    const pausedAtCue = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      if (!video) return false;
      video.pause();
      video.currentTime = 1;
      return true;
    })()`);
    assert.equal(pausedAtCue, true, 'the packaged player can hold the synthetic video on a subtitle cue');
    for (const provider of [
      { source: 'kairan', host: 'kairan03.blogspot.com', cue: '합성 Kairan 한글 자막' },
      { source: 'csora', host: 'csora556.blogspot.com', cue: '합성 Csora 한글 자막' },
      { source: 'anissia', host: 'phase1-anissia.blogspot.com', cue: '합성 Anissia 한글 자막' }
    ]) {
      const requestOffset = fixtureRequests.length;
      const clicked = await win.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('#psSubtitleSources button[data-source="${provider.source}"]');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      assert.equal(clicked, true, `the packaged player exposes the ${provider.source} subtitle source button`);
      const applied = await waitFor(`packaged ${provider.source} source button → preload/main subtitle IPC → saved subtitle`, () =>
        win.webContents.executeJavaScript(`(async () => {
          const saved = await window.lilac.savedSubtitles(subtitleStoreKey());
          const entry = saved.find(item => item.source === ${JSON.stringify(provider.source)});
          const status = document.querySelector('#psSubtitleSources button[data-source="${provider.source}"] [data-source-status]');
          return entry && status?.dataset.availability === 'available'
            ? { source: entry.source, label: entry.label, path: entry.path, availability: status.dataset.availability }
            : null;
        })()`), 20000);
      assert.equal(applied.source, provider.source);
      assert.equal(applied.availability, 'available', `${provider.source} availability is shown for this episode`);
      assert.match(applied.label, new RegExp(provider.source === 'kairan' ? 'Kairan' : provider.source === 'csora' ? 'Csora' : 'Anissia'));
      assert.ok(applied.path && fs.existsSync(applied.path), `${provider.source} subtitle was saved under the isolated app profile`);
      const activeCue = await waitFor(`${provider.source} subtitle cue is active in the packaged player`, () =>
        win.webContents.executeJavaScript(`(() => {
          const video = document.querySelector('#video');
          const cues = [...(video?.textTracks || [])].flatMap(track => [...(track.activeCues || [])]).map(cue => cue.text).join(' ');
          return cues.includes(${JSON.stringify(provider.cue)}) ? cues : '';
        })()`), 10000);
      assert.match(activeCue, new RegExp(provider.cue));
      const providerRequests = fixtureRequests.slice(requestOffset).map(rawUrl => new URL(rawUrl));
      assert.ok(providerRequests.some(url => url.hostname === provider.host && url.pathname === '/feeds/posts/default'),
        `${provider.source} was resolved from its synthetic Blogger feed through main-process fetch`);
      assert.ok(providerRequests.some(url => url.hostname === 'subtitles.invalid' && url.pathname === `/phase1-community-${provider.source}.vtt`),
        `${provider.source} fixture subtitle was downloaded through main-process fetch`);
      if (provider.source === 'anissia') {
        assert.ok(providerRequests.some(url => url.hostname === 'api.anissia.net' && url.pathname.startsWith('/anime/list/0')),
          'Anissia search reached the synthetic anime registry endpoint');
        assert.ok(providerRequests.some(url => url.hostname === 'api.anissia.net' && url.pathname.startsWith('/anime/caption/animeNo/')),
          'Anissia search reached the synthetic maker endpoint');
        assert.ok(providerRequests.some(url => url.hostname === provider.host && url.pathname.startsWith('/posts/')),
          'Anissia followed the maker post link through the synthetic fixture');
      }
      communitySubtitleEvidence.push({ source: provider.source, label: applied.label, availability: applied.availability, cue: provider.cue });
    }
    const selectedSubtitleSource = await win.webContents.executeJavaScript(`(() => {
      const initialDefault = localStorage.getItem('subtitleSource');
      const button = document.querySelector('#psSubtitleSources button[data-source="reanime"]');
      if (!button) return null;
      button.click();
      const anime = currentPlaybackContext.anime;
      const key = anime?.id ? (anime.provider || '') + ':' + anime.id : '';
      const picks = JSON.parse(localStorage.getItem('seriesSubtitlePick') || '{}');
      const selected = picks[key];
      return {
        source: selected?.source || null,
        status: document.querySelector('#seriesSubtitleSourceStatus')?.textContent || '',
        resetDisabled: document.querySelector('#resetSeriesSubtitleSource')?.disabled ?? true,
        initialDefault,
        currentDefault: localStorage.getItem('subtitleSource')
      };
    })()`);
    assert.ok(selectedSubtitleSource, 'the packaged Re:Anime subtitle source button is present');
    assert.equal(selectedSubtitleSource.source, 'reanime', 'the real source button saves a per-series subtitle preference');
    assert.equal(selectedSubtitleSource.status, '이 작품 출처: Re:Anime');
    assert.equal(selectedSubtitleSource.resetDisabled, false);
    assert.equal(selectedSubtitleSource.currentDefault, selectedSubtitleSource.initialDefault, 'choosing a work source does not change the settings default');
    subtitlePreferenceState = { selected: selectedSubtitleSource.source, settingsDefault: selectedSubtitleSource.currentDefault };
    const savedPosition = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      video.currentTime = 2;
      video.dispatchEvent(new Event('timeupdate'));
      saveHistorySoon();
      const history = JSON.parse(localStorage.getItem('history') || '[]');
      const saved = history.find(item => item.episode?.provider === 'reanime' && item.episode?.number === 1);
      video.pause();
      return { currentTime: video.currentTime, duration: video.duration, savedProgress: saved?.progress ?? null };
    })()`);
    assert.ok(savedPosition.duration >= 3.8 && savedPosition.duration <= 4.2, JSON.stringify(savedPosition));
    assert.equal(savedPosition.savedProgress, 50, JSON.stringify(savedPosition));
    const savedCard = await waitFor('50 percent progress saved before the Electron process exits', () =>
      win.webContents.executeJavaScript("document.querySelector('#continueRail .continue-card')?.innerText || ''"), 10000);
    assert.match(savedCard, /EP\.1\s*·\s*50%/, savedCard);
    // Let Chromium flush its isolated localStorage profile before this process exits.
    await new Promise(resolve => setTimeout(resolve, 750));
    resumeState = { savedCard, savedPosition };
  } else {
    const persistedSubtitleSource = await win.webContents.executeJavaScript(`(() => {
      const picks = JSON.parse(localStorage.getItem('seriesSubtitlePick') || '{}');
      const selected = picks['reanime:${SLUG}'];
      return { source: selected?.source || null, settingsDefault: localStorage.getItem('subtitleSource') };
    })()`);
    assert.equal(persistedSubtitleSource.source, 'reanime', 'the per-series subtitle source survived the process restart');
    subtitlePreferenceState = { persisted: persistedSubtitleSource.source, settingsDefault: persistedSubtitleSource.settingsDefault };
    const persistedCard = await waitFor('saved 50 percent watch history after a full app restart', () =>
      win.webContents.executeJavaScript(`(() => {
        const text = document.querySelector('#continueRail .continue-card')?.innerText || '';
        return /EP\\.1\\s*·\\s*50%/.test(text) ? text : '';
      })()`), 15000).catch(async error => {
      const state = await win.webContents.executeJavaScript(`(() => ({
        history: state.history.map(item => ({ key: item.key, progress: item.progress, provider: item.episode?.provider, episode: item.episode?.number })),
        historyStorage: JSON.parse(localStorage.getItem('history') || '[]').map(item => ({ key: item.key, progress: item.progress, provider: item.episode?.provider, episode: item.episode?.number })),
        continueText: document.querySelector('#continueRail')?.innerText || '',
        source: state.source
      }))()`);
      throw new Error(`${error.message}; restart profile diagnostics: ${JSON.stringify(state)}`);
    });
    assert.match(persistedCard, /EP\.1\s*·\s*50%/, persistedCard);
    const resolveCallsBeforeResume = fixtureRequests.filter(url => url.includes(`/api/watch/${SLUG}/1`)).length;
    const savedEpisode = await win.webContents.executeJavaScript(`(() => {
      const item = state.history.find(entry => entry.episode?.provider === 'reanime');
      return item?.episode || null;
    })()`);
    assert.ok(savedEpisode, 'the restarted app restored the saved Re:Anime episode metadata');
    const stream = await win.webContents.executeJavaScript(`window.lilac.providerResolve(${JSON.stringify(savedEpisode)})`);
    const proxyOrigin = new URL(stream.url).origin;
    assert.equal(new URL(stream.url).hostname, '127.0.0.1', 'the resumed episode resolves to the app-owned loopback proxy');
    allowedBrowserOrigins.add(proxyOrigin);
    await win.webContents.executeJavaScript(`(() => {
      window.onlineSubtitleFor = async () => null;
      document.querySelector('#continueRail .continue-card').click();
    })()`);
    await waitFor('continue card resumes the saved episode after process restart', () =>
      win.webContents.executeJavaScript(`(() => {
        const video = document.querySelector('#video');
        const cues = [...(video?.textTracks?.[0]?.activeCues || [])].map(cue => cue.text).join(' ');
        const ready = video?.readyState >= 2 && video.videoWidth === 320 && video.currentTime >= 1.8
          && video.currentTime < 2.8 && cues.includes('합성 한국어 자막');
        if (ready) video.pause();
        return ready;
      })()`), 25000);
    const resolveCallsAfterResume = fixtureRequests.filter(url => url.includes(`/api/watch/${SLUG}/1`)).length;
    assert.ok(resolveCallsAfterResume > resolveCallsBeforeResume, 'the restarted app resolved the saved episode through main IPC');
    resumeState = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('#video');
      return { currentTime: video.currentTime, duration: video.duration,
        cue: [...(video.textTracks?.[0]?.activeCues || [])].map(item => item.text).join(' ') };
    })()`);
    assert.ok(resumeState.currentTime >= 1.8 && resumeState.currentTime < 2.8, JSON.stringify(resumeState));
    assert.match(resumeState.cue, /합성 한국어 자막/);
    const restoredSubtitlePreferenceUi = await waitFor('restored per-series subtitle source appears in the resumed player', () =>
      win.webContents.executeJavaScript(`(() => {
        const status = document.querySelector('#seriesSubtitleSourceStatus');
        const reset = document.querySelector('#resetSeriesSubtitleSource');
        return status?.textContent === '이 작품 출처: Re:Anime' && reset && !reset.disabled
          ? { status: status.textContent, resetDisabled: reset.disabled } : null;
      })()`), 5000);
    assert.equal(restoredSubtitlePreferenceUi.status, '이 작품 출처: Re:Anime');
    assert.equal(restoredSubtitlePreferenceUi.resetDisabled, false);
    const resetPreference = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('#resetSeriesSubtitleSource');
      if (!button) return null;
      button.click();
      const picks = JSON.parse(localStorage.getItem('seriesSubtitlePick') || '{}');
      const selected = picks['reanime:${SLUG}'];
      return {
        source: selected?.source || null,
        status: document.querySelector('#seriesSubtitleSourceStatus')?.textContent || '',
        disabled: button.disabled
      };
    })()`);
    assert.ok(resetPreference, 'the packaged per-series source reset button is present');
    assert.equal(resetPreference.source, null, 'reset removes the per-series source preference');
    assert.equal(resetPreference.status, '설정 기본값: 자동');
    assert.equal(resetPreference.disabled, true);
    subtitlePreferenceState.restoredStatus = restoredSubtitlePreferenceUi.status;
    subtitlePreferenceState.resetStatus = resetPreference.status;
  }
  assert.equal(deniedUnknownFetches.length, 0, `the source restart used only registered fixture URLs: ${deniedUnknownFetches.join(', ')}`);
  assert.equal(deniedBrowserRequests.length, 0, `the source restart made no browser requests outside local fixtures: ${deniedBrowserRequests.join(', ')}`);
  console.log(`Source restart ${restartMode} passed: ${restored.source}, ${restored.title}; community subtitle buttons/IPC: ${JSON.stringify(communitySubtitleEvidence)}; subtitle preference: ${JSON.stringify(subtitlePreferenceState)}; resume evidence: ${JSON.stringify(resumeState)}; fixture calls: ${fixtureRequests.length}; unknown fetches: 0; blocked browser requests: 0.`);
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

    if (restartMode) {
      await runSourceRestartProbe(win);
      await new Promise(resolve => localPlayerServer.close(resolve));
      app.quit();
      return;
    }

    const actualAppInfo = await win.webContents.executeJavaScript('window.lilac.appDiagnosticInfo()');
    assert.equal(actualAppInfo.platform, process.platform);
    assert.equal(actualAppInfo.arch, process.arch);
    assert.match(actualAppInfo.version, /^\d+\.\d+\.\d+$/);
    const diagnosticPayload = {
      app: { version: actualAppInfo.version, platform: actualAppInfo.platform, arch: actualAppInfo.arch, token: 'private-token' },
      entries: Array.from({ length: 7 }, (_, index) => ({
        occurredAt: `2026-10-10T00:00:0${index}.000Z`, provider: 'reanime', stage: 'hls-playback',
        playback: 'online', mediaType: 'hls', serverHost: 'edge.example', videoErrorCode: 3,
        errorCategory: 'networkError', title: 'private title', url: 'https://secret.example/?token=abc', cookie: 'secret'
      }))
    };
    const diagnosticReport = await win.webContents.executeJavaScript(
      `window.LilacPlayerDiagnostics.formatReport(${JSON.stringify(diagnosticPayload)})`
    );
    assert.equal((diagnosticReport.match(/공급원=reanime/g) || []).length, 5);
    assert.doesNotMatch(diagnosticReport, /private title|secret\.example|token=abc|cookie/i);
    assert.equal(await win.webContents.executeJavaScript(`window.lilac.copyText(${JSON.stringify(diagnosticReport)})`), true);
    assert.deepEqual(clipboardWrites, [diagnosticReport], 'the real packaged preload/main IPC reaches only the test clipboard sink');
    const emptyCopyError = await win.webContents.executeJavaScript(
      "window.lilac.copyText('').then(() => '', error => error.message)"
    );
    assert.match(emptyCopyError, /비어 있거나/);
    const largeCopyError = await win.webContents.executeJavaScript(
      "window.lilac.copyText('x'.repeat(2_000_001)).then(() => '', error => error.message)"
    );
    assert.match(largeCopyError, /너무 큽니다/);
    assert.deepEqual(clipboardWrites, [diagnosticReport], 'invalid clipboard inputs never reach the clipboard sink');
    const uiCopyStart = clipboardWrites.length;
    assert.equal(await win.webContents.executeJavaScript("Boolean(document.querySelector('#copyPlayerDiagnostics'))"), true);
    await win.webContents.executeJavaScript("document.querySelector('#copyPlayerDiagnostics').click()");
    const uiDiagnosticReport = await waitFor('diagnostics button reaches packaged clipboard IPC', () =>
      clipboardWrites.length > uiCopyStart ? clipboardWrites[uiCopyStart] : null);
    assert.match(uiDiagnosticReport, /LilacAnime 재생 진단 정보/);
    assert.ok(uiDiagnosticReport.includes(`앱 버전: ${actualAppInfo.version}`));
    assert.doesNotMatch(uiDiagnosticReport, /private title|secret\.example|token=abc|cookie/i);
    const diagnosticStatus = await waitFor('diagnostics UI shows successful copy status', () =>
      win.webContents.executeJavaScript("document.querySelector('#playerDiagnosticStatus')?.textContent || ''"));
    assert.match(diagnosticStatus, /복사됐어요/);

    const quarterResult = await win.webContents.executeJavaScript(
      "window.lilac.providerQuarter('reanime', 2026, 4)"
    );
    assert.equal(quarterResult.label, '2026년 4분기');
    assert.equal(quarterResult.data.length, 1);
    assert.equal(quarterResult.data[0].id, SLUG);
    assert.equal(quarterResult.data[0].provider, 'reanime');
    const quarterRequest = fixtureRequests.map(url => new URL(url)).find(url => url.hostname === 'reanime.to'
      && url.pathname === '/api/v1/search' && url.searchParams.get('season') === 'FALL'
      && url.searchParams.get('year') === '2026');
    assert.ok(quarterRequest, 'the real main handler requested the selected RE:Anime season and year');

    const miruroQuarter = await win.webContents.executeJavaScript(
      "window.lilac.providerQuarter('miruro', 2026, 4)"
    );
    assert.equal(miruroQuarter.label, '2026년 4분기');
    assert.equal(miruroQuarter.data.length, 1, 'Miruro quarter excludes series without a playable episode');
    assert.equal(miruroQuarter.data[0].id, 'phase1-miruro-quarter');
    assert.equal(miruroQuarter.data[0].provider, 'miruro');
    assert.equal(miruroQuarter.data[0].availableEpisodes, 2);
    assert.ok(fixtureRequests.some(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'www.miruro.to' && url.pathname === '/api/v1/anime'
        && url.searchParams.get('season') === 'FALL' && url.searchParams.get('season_year') === '2026';
    }), 'Miruro main handler requested the selected season and year');

    const animenosubQuarter = await win.webContents.executeJavaScript(
      "window.lilac.providerQuarter('animenosub', 2026, 4)"
    );
    assert.equal(animenosubQuarter.label, '2026년 4분기');
    assert.equal(animenosubQuarter.data.length, 1, 'Animenosub quarter excludes Upcoming cards');
    assert.equal(animenosubQuarter.data[0].provider, 'animenosub');
    assert.equal(animenosubQuarter.data[0].title, '합성 Animenosub 분기작');
    assert.equal(animenosubQuarter.data[0].availableEpisodes, 4);

    const latestCandidates = [
      { provider: 'reanime', anilistId: 62001, subbed: 2, dubbed: 0, title: '합성 최신 방영작' },
      { provider: 'reanime', anilistId: 62002, subbed: 0, dubbed: 0, title: '미방영 합성 작품' },
      { provider: 'miruro', anilistId: 62003, availableEpisodeCount: 5, title: '다른 출처 작품' }
    ];
    const latestResult = await win.webContents.executeJavaScript(
      `window.lilac.providerLatestEpisodes('reanime', ${JSON.stringify(latestCandidates)})`
    );
    assert.equal(latestResult.supported, true);
    assert.equal(latestResult.fromCache, false);
    assert.equal(latestResult.data.length, 1);
    assert.equal(latestResult.data[0].anime.title, '합성 최신 방영작');
    assert.equal(latestResult.data[0].episode, 2, 'latest airing excludes future and unavailable episodes');
    const latestCached = await win.webContents.executeJavaScript(
      `window.lilac.providerLatestEpisodes('reanime', ${JSON.stringify(latestCandidates)})`
    );
    assert.equal(latestCached.fromCache, true, 'latest airing reuses the cached schedule');
    const unsupportedLatest = await win.webContents.executeJavaScript(
      `window.lilac.providerLatestEpisodes('linkkf', ${JSON.stringify(latestCandidates)})`
    );
    assert.equal(unsupportedLatest.supported, false);
    assert.equal(anilistRequests.length, 1, 'only the supported valid Re:Anime AniList candidates were queried once');
    assert.deepEqual(anilistRequests[0].variables.ids, [62001]);
    assert.ok(anilistRequests[0].query.includes('airingSchedules'));
    const miruroLatest = await win.webContents.executeJavaScript(
      "window.lilac.providerLatestEpisodes('miruro', [{ provider: 'miruro', anilistId: 62004, availableEpisodeCount: 4, title: '합성 Miruro 최신작' }])"
    );
    assert.equal(miruroLatest.supported, true);
    assert.equal(miruroLatest.data.length, 1);
    assert.equal(miruroLatest.data[0].anime.title, '합성 Miruro 최신작');
    assert.equal(miruroLatest.data[0].episode, 3, 'Miruro latest airing excludes episodes past its available count');
    assert.equal(anilistRequests.length, 2, 'Re:Anime and Miruro each issue one provider-scoped AniList request');
    assert.deepEqual(anilistRequests[1].variables.ids, [62004]);
    assert.ok(anilistRequests[1].query.includes('airingSchedules'));

    const weekdayCandidates = [
      { provider: 'reanime', anilistId: 62001, subbed: 2, title: '합성 요일표 방영작' },
      { provider: 'miruro', anilistId: 62004, availableEpisodeCount: 4, title: '합성 Miruro 방영작' }
    ];
    const weekdayRequestStart = anilistRequests.length;
    const weekdayResult = await win.webContents.executeJavaScript(
      `window.lilac.providerWeekdayEpisodes('reanime', ${JSON.stringify(weekdayCandidates)})`
    );
    assert.equal(weekdayResult.supported, true);
    assert.equal(weekdayResult.fromCache, false);
    assert.equal(weekdayResult.data.length, 1);
    assert.equal(weekdayResult.data[0].episode, 2, 'weekday schedule includes only the next seven days and exact candidate AniList IDs');
    assert.deepEqual(weekdayResult.data[0].anime, weekdayCandidates[0]);
    const exactWeekdayRequests = anilistRequests.slice(weekdayRequestStart).filter(request =>
      JSON.stringify(request.variables.ids) === JSON.stringify([62001])
    );
    assert.ok(exactWeekdayRequests.length >= 1, 'weekday lookup uses the real packaged provider IPC');
    assert.equal(exactWeekdayRequests[0].variables.until - exactWeekdayRequests[0].variables.after, 7 * 24 * 60 * 60);
    const weekdayCached = await win.webContents.executeJavaScript(
      `window.lilac.providerWeekdayEpisodes('reanime', ${JSON.stringify(weekdayCandidates)})`
    );
    assert.equal(weekdayCached.fromCache, true, 'weekday schedules reuse the provider-scoped cache');
    const unsupportedWeekday = await win.webContents.executeJavaScript(
      `window.lilac.providerWeekdayEpisodes('animenosub', ${JSON.stringify(weekdayCandidates)})`
    );
    assert.deepEqual(unsupportedWeekday, { supported: false, data: [] });

    const schedule = await win.webContents.executeJavaScript('window.lilac.linkkfSchedule()');
    assert.equal(schedule.days.length, 7, 'Linkkf main IPC returns Monday through Sunday');
    assert.deepEqual(schedule.unavailableDays, []);
    assert.equal(schedule.days[0].length, 1);
    assert.equal(schedule.days[0][0].provider, 'linkkf');
    assert.equal(schedule.days[0][0].title, '합성 월요일 방영작');
    assert.equal(schedule.days.slice(1).reduce((total, day) => total + day.length, 0), 0);

    const previousHomeSource = await win.webContents.executeJavaScript('state.source');
    await win.webContents.executeJavaScript(`(() => {
      state.source = 'animenosub';
      switchView('home');
      document.querySelector('#homeOrder [data-order="updated"]').click();
    })()`);
    const recentUpdateCard = await waitFor('recent-update card rendered from packaged main IPC', () =>
      win.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('#seasonRail .anime-card');
        const note = document.querySelector('#homeOrderNote')?.textContent || '';
        if (document.querySelector('#seasonTitle')?.textContent !== '최근 업데이트'
          || card?.querySelector('h3')?.textContent !== '합성 Animenosub 최신작'
          || note !== '소스의 최근 회차 업데이트 목록입니다.') return null;
        return {
          title: card.querySelector('h3').textContent,
          episode: card.querySelector('p')?.textContent || '',
          note,
          selected: document.querySelector('#homeOrder [data-order="updated"]')?.getAttribute('aria-checked')
        };
      })()`)
    );
    assert.match(recentUpdateCard.episode, /업로드 12화/);
    assert.equal(recentUpdateCard.selected, 'true', 'the recent-updates sort control remains selected after rendering');
    assert.equal(fixtureRequests.filter(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'animenosub.to' && url.pathname === '/anime/' && url.searchParams.get('order') === 'update';
    }).length, 1, 'the home renderer reached the real packaged catalog:updates IPC and its Animenosub feed');
    await win.webContents.executeJavaScript(`(() => {
      state.source = ${JSON.stringify(previousHomeSource)};
      document.querySelector('#homeOrder [data-order="season"]').click();
    })()`);

    await win.webContents.executeJavaScript(`(() => {
      state.source = 'reanime';
      switchView('home');
      setupQuarterControls('reanime');
      const year = document.querySelector('#quarterYear');
      year.value = '2025';
      year.dispatchEvent(new Event('change'));
    })()`);
    const selectedYearQuarter = await waitFor('quarter year selection rendered from packaged main IPC', () =>
      win.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('#seasonRail .anime-card');
        if (document.querySelector('#seasonTitle')?.textContent !== '2025년 4분기' || !card) return null;
        return {
          title: document.querySelector('#seasonTitle').textContent,
          cardTitle: card.querySelector('h3')?.textContent || '',
          cardId: card.dataset.id,
          year: document.querySelector('#quarterYear').value,
          selectedQuarter: document.querySelector('#quarterTabs [data-quarter="4"]')?.getAttribute('aria-pressed')
        };
      })()`)
    );
    assert.equal(selectedYearQuarter.year, '2025');
    assert.equal(selectedYearQuarter.selectedQuarter, 'true');
    assert.equal(selectedYearQuarter.cardTitle, '분기 선택 UI 합성작');
    assert.equal(selectedYearQuarter.cardId, 'reanime:phase1-quarter-ui-2025-fall');
    await win.webContents.executeJavaScript(`document.querySelector('#quarterTabs [data-quarter="3"]').click()`);
    const selectedQuarter = await waitFor('quarter tab selection rendered from packaged main IPC', () =>
      win.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('#seasonRail .anime-card');
        if (document.querySelector('#seasonTitle')?.textContent !== '2025년 3분기' || !card) return null;
        return {
          title: document.querySelector('#seasonTitle').textContent,
          cardTitle: card.querySelector('h3')?.textContent || '',
          cardId: card.dataset.id,
          year: document.querySelector('#quarterYear').value,
          selectedQuarter: document.querySelector('#quarterTabs [data-quarter="3"]')?.getAttribute('aria-pressed')
        };
      })()`)
    );
    assert.equal(selectedQuarter.year, '2025');
    assert.equal(selectedQuarter.selectedQuarter, 'true');
    assert.equal(selectedQuarter.cardTitle, '분기 선택 UI 합성작');
    assert.equal(selectedQuarter.cardId, 'reanime:phase1-quarter-ui-2025-summer');
    assert.ok(fixtureRequests.some(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'reanime.to' && url.pathname === '/api/v1/search'
        && url.searchParams.get('year') === '2025' && url.searchParams.get('season') === 'FALL';
    }), 'the year control reached the real packaged quarter IPC');
    assert.ok(fixtureRequests.some(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'reanime.to' && url.pathname === '/api/v1/search'
        && url.searchParams.get('year') === '2025' && url.searchParams.get('season') === 'SUMMER';
    }), 'the quarter tab reached the real packaged quarter IPC');
    await win.webContents.executeJavaScript(`(() => {
      state.source = ${JSON.stringify(previousHomeSource)};
      setupQuarterControls(state.source);
      catalogUpdateUI.renderHome();
    })()`);

    const latestUiCandidate = [{
      provider: 'reanime', id: 'phase1-latest-ui', mal_id: 'reanime:phase1-latest-ui',
      anilistId: 62008, title: '합성 최신 방영 UI 카드', subbed: 4, dubbed: 0
    }];
    await win.webContents.executeJavaScript(`(() => {
      state.source = 'reanime';
      localStorage.removeItem('latestEpisodeCache:v1:reanime');
      return loadLatestEpisodeRail('reanime', ${JSON.stringify(latestUiCandidate)});
    })()`);
    const latestUi = await win.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('#latestEpisodeTitle')?.textContent,
      status: document.querySelector('#latestEpisodeStatus')?.textContent,
      cards: [...document.querySelectorAll('#latestEpisodeRail .anime-card')].map(card => ({
        title: card.querySelector('h3')?.textContent,
        episode: card.querySelector('.latest-episode-badge')?.textContent
      }))
    }))()`);
    assert.equal(latestUi.title, '최신 방영 회차');
    assert.match(latestUi.status, /최근 14일 방영 회차 1개/);
    assert.deepEqual(latestUi.cards, [{ title: '합성 최신 방영 UI 카드', episode: 'EP.4' }]);
    assert.deepEqual(anilistRequests.at(-1).variables.ids, [62008], 'the latest-airing UI called the real packaged IPC for its selected provider candidate');

    const scheduleRequestsBeforeUI = fixtureRequests.filter(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'linkkf1.5imgdarr.top' && url.pathname === '/api/singlefilter.php'
        && url.searchParams.has('categorytagid');
    }).length;
    const expectedScheduleIndex = (new Date().getDay() + 6) % 7;
    const scheduleLabels = ['월', '화', '수', '목', '금', '토', '일'];
    await win.webContents.executeJavaScript(`(() => {
      state.source = 'linkkf';
      switchView('home');
      return loadWeekdaySchedule();
    })()`);
    const selectedToday = await waitFor('today weekday tab and Linkkf schedule rendered through packaged main IPC', () =>
      win.webContents.executeJavaScript(`(() => {
        const tabs = [...document.querySelectorAll('#scheduleTabs button')];
        const selected = tabs.findIndex(button => button.getAttribute('aria-selected') === 'true');
        const rail = document.querySelector('#scheduleRail');
        if (selected !== ${expectedScheduleIndex} || !rail || rail.classList.contains('loading-cards')) return null;
        return { label: tabs[selected]?.textContent, railText: rail.textContent, tabCount: tabs.length };
      })()`)
    );
    assert.equal(selectedToday.label, scheduleLabels[expectedScheduleIndex]);
    assert.equal(selectedToday.tabCount, 7);
    await win.webContents.executeJavaScript(`document.querySelectorAll('#scheduleTabs button')[0].click()`);
    const mondayCard = await waitFor('Monday Linkkf card rendered after selecting the weekday tab', () =>
      win.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('#scheduleRail .anime-card');
        if (card?.querySelector('h3')?.textContent !== '합성 월요일 방영작') return null;
        return {
          title: card.querySelector('h3').textContent,
          selected: document.querySelectorAll('#scheduleTabs button')[0]?.getAttribute('aria-selected')
        };
      })()`)
    );
    assert.equal(mondayCard.selected, 'true');
    const scheduleRequestsAfterUI = fixtureRequests.filter(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'linkkf1.5imgdarr.top' && url.pathname === '/api/singlefilter.php'
        && url.searchParams.has('categorytagid');
    }).length;
    assert.equal(scheduleRequestsAfterUI - scheduleRequestsBeforeUI, 7, 'the home schedule UI reached all seven real Linkkf main IPC queries');
    await win.webContents.executeJavaScript(`(() => {
      state.source = ${JSON.stringify(previousHomeSource)};
      document.querySelector('#scheduleSection').classList.add('hidden');
      document.querySelector('#latestEpisodeSection').classList.add('hidden');
      setupQuarterControls(state.source);
      catalogUpdateUI.renderHome();
    })()`);

    const animenosubUpdates = await win.webContents.executeJavaScript("window.lilac.catalogUpdates('animenosub', 0)");
    assert.equal(animenosubUpdates.data.length, 1);
    assert.equal(animenosubUpdates.data[0].provider, 'animenosub');
    assert.equal(animenosubUpdates.data[0].title, '합성 Animenosub 최신작');
    assert.equal(animenosubUpdates.data[0].availableEpisodes, 12);
    assert.equal(animenosubUpdates.nextOffset, 2);
    assert.equal(animenosubUpdates.done, false);
    const animenosubCached = await win.webContents.executeJavaScript("window.lilac.catalogUpdates('animenosub', 0)");
    assert.equal(animenosubCached.data[0].id, animenosubUpdates.data[0].id);
    assert.equal(fixtureRequests.filter(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'animenosub.to' && url.pathname === '/anime/' && url.searchParams.get('order') === 'update';
    }).length, 1, 'Animenosub page results are reused by the main-process cache');

    const ohliUpdates = await win.webContents.executeJavaScript("window.lilac.catalogUpdates('ohli24', 0)");
    assert.equal(ohliUpdates.data.length, 1);
    assert.equal(ohliUpdates.data[0].provider, 'ohli24');
    assert.equal(ohliUpdates.data[0].title, '합성 애니24 최신작');
    assert.equal(ohliUpdates.data[0].availableEpisodes, 13);
    assert.equal(ohliUpdates.data[0].url, 'https://www.ohli24.net/81002/phase1-update.html');
    assert.equal(ohliUpdates.done, true);

    const ohliSpecial = await win.webContents.executeJavaScript(
      "window.lilac.providerDetail({ provider: 'ohli24', id: 'ohli24:phase1-special', title: '합성 애니24 특별작', url: 'https://www.ohli24.net/81002/phase1-special.html' })"
    );
    assert.deepEqual(ohliSpecial.episodes.map(episode => episode.number), [8, 9, 9.5, 10]);
    assert.equal(ohliSpecial.data.availableEpisodes, 10);
    const ohliSpecialEpisode = ohliSpecial.episodes.find(episode => episode.number === 9.5);
    const ohliStream = await win.webContents.executeJavaScript(
      `window.lilac.providerResolve(${JSON.stringify(ohliSpecialEpisode)})`
    );
    assert.equal(ohliStream.burnedKorean, false);
    assert.match(ohliStream.subtitleUrl, /^file:/);
    assert.ok(fs.existsSync(ohliStream.subtitlePath));
    assert.match(fs.readFileSync(ohliStream.subtitlePath, 'utf8'), /합성 애니24 원본 자막/);
    assert.equal(ohliStream.subtitleLabel, '애니24 한국어 자막');

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
    assert.equal(trackResult.tracks.length, 2);
    assert.equal(trackResult.tracks[0].language, 'ko');
    assert.equal(trackResult.tracks[0].label, '한국어');
    assert.equal(trackResult.tracks[0].url, 'https://subtitles.invalid/phase1-ko.vtt');
    const japaneseTrack = trackResult.tracks.find(track => track.language === 'ja');
    assert.equal(japaneseTrack?.url, 'https://subtitles.invalid/phase1-ja.vtt');

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
    assert.equal(resolvedStream.subtitleTracks.length, 2, 'the packaged resolver preserves Korean and Japanese track choices for the episode');
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
    const uiSearchCallsBefore = fixtureRequests.filter(rawUrl => new URL(rawUrl).searchParams.get('q') === SEARCH_TITLE).length;
    await win.webContents.executeJavaScript(`(() => {
      LilacIntegratedSearch.PROVIDERS.splice(0, LilacIntegratedSearch.PROVIDERS.length, 'reanime');
      const searchProviders = LilacIntegratedSearch.searchProviders;
      LilacIntegratedSearch.searchProviders = options => searchProviders({ ...options, localSearch: async () => null });
      window.onlineSubtitleFor = async () => null;
      document.querySelector('#pageSearch').value = ${JSON.stringify(SEARCH_TITLE)};
      document.querySelector('#searchButton').click();
    })()`);
    const uiSearchResult = await waitFor('packaged search UI result from actual Re:Anime IPC', () =>
      win.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('#searchGrid .anime-card')];
        const card = cards.find(item => item.textContent.includes(${JSON.stringify(animeFixture.title.english)}));
        return card ? { count: cards.length, text: card.textContent } : null;
      })()`), 25000);
    assert.equal(uiSearchResult.count, 1, 'the renderer search button and actual Re:Anime IPC produced one isolated fixture result');
    assert.match(uiSearchResult.text, /Main Handler Fixture/);
    assert.ok(fixtureRequests.filter(rawUrl => new URL(rawUrl).searchParams.get('q') === SEARCH_TITLE).length > uiSearchCallsBefore,
      'the renderer search button reached the packaged Re:Anime catalog handler');
    const uiDetailCallsBefore = fixtureRequests.filter(url => url.includes(`/api/v1/anime/${SLUG}/episodes`)).length;
    await win.webContents.executeJavaScript("document.querySelector('#searchGrid .anime-card').click()");
    await waitFor('packaged detail dialog opened from the search result click', () =>
      win.webContents.executeJavaScript("Boolean(document.querySelector('#detailDialog')?.open)"), 5000);
    const uiDetail = await waitFor('packaged detail dialog and episode from the actual Re:Anime handler', () =>
      win.webContents.executeJavaScript(`(() => {
        const episode = document.querySelector('#episodeBlock .episode-btn');
        const content = document.querySelector('#detailContent')?.textContent || '';
        if (!document.querySelector('#detailDialog')?.open || content.includes('작품 정보를 불러오는 중')) return null;
        return {
          episode: episode?.textContent.trim() || '',
          title: document.querySelector('#detailContent h1')?.textContent.trim() || '',
          error: content.slice(0, 500)
        };
      })()`), 25000);
    assert.match(uiDetail.title, /메인 처리기 검증 작품/, JSON.stringify(uiDetail));
    assert.ok(uiDetail.episode, `the detail UI should render an episode button: ${JSON.stringify(uiDetail)}`);
    assert.ok(fixtureRequests.filter(url => url.includes(`/api/v1/anime/${SLUG}/episodes`)).length > uiDetailCallsBefore,
      'clicking the search result reached the packaged Re:Anime detail handler');
    const resolveCallsBeforeUiPlay = fixtureRequests.filter(url => url.includes(`/api/watch/${SLUG}/1`)).length;
    await win.webContents.executeJavaScript("document.querySelector('#episodeBlock .episode-btn').click()");
    await waitFor('episode button playback through packaged provider:resolve IPC and Korean subtitle', async () =>
      win.webContents.executeJavaScript(`(() => {
        const video = document.querySelector('#video');
        const cueText = [...(video?.textTracks?.[0]?.activeCues || [])].map(cue => cue.text).join(' ');
        const ready = video?.readyState >= 2 && video.videoWidth === 320 && video.videoHeight === 180
          && video.currentTime >= 1 && cueText.includes('합성 한국어 자막');
        if (ready) video.pause();
        return ready;
      })()`), 25000);
    const resolveCallsAfterUiPlay = fixtureRequests.filter(url => url.includes(`/api/watch/${SLUG}/1`)).length;
    assert.ok(resolveCallsAfterUiPlay > resolveCallsBeforeUiPlay, 'clicking the actual episode button reached the packaged main process resolver');
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
    if (nativeAppPipMode) await runNativeAppPipProbe(win);

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

    const promptBefore = clipboardWrites.length;
    const externalBefore = externalOpenRequests.length;
    const manualTranslationStarted = await win.webContents.executeJavaScript(`(async () => {
      const selected = await selectSubtitleTrack(${JSON.stringify(japaneseTrack)});
      if (!selected) return false;
      openPlayerSettings(true, document.querySelector('#manualChatgptRow'));
      document.querySelector('#translateChatgpt').click();
      return true;
    })()`);
    assert.equal(manualTranslationStarted, true, 'the packaged player selected the synthetic Japanese episode track');
    await waitFor('manual translation panel for the selected episode track', () => win.webContents.executeJavaScript(`Boolean(
      manualChatgptTranslation?.batches.length === 2 && !document.querySelector('#manualChatgptPanel').classList.contains('hidden')
    )`)).catch(async error => {
      const diagnostic = await win.webContents.executeJavaScript(`(() => ({
        subtitleSource: currentSubtitle?.source || null,
        subtitlePath: currentSubtitle?.path || null,
        translatable: translatableSubtitle(),
        selectedTrack: currentPlaybackContext.selectedSubtitleTrack || null,
        contextTracks: (currentPlaybackContext.subtitleTracks || []).map(track => ({ url: track.url, language: track.language, label: track.label })),
        episodeProvider: currentPlaybackContext.episode?.provider || null,
        state: manualChatgptTranslation ? { batches: manualChatgptTranslation.batches.length, index: manualChatgptTranslation.index } : null,
        status: document.querySelector('#manualChatgptStatus')?.textContent || '',
        rowHidden: document.querySelector('#manualChatgptRow')?.classList.contains('hidden')
      }))()`);
      console.error(`Manual translation integration diagnostic: ${JSON.stringify(diagnostic)}`);
      throw error;
    });
    await win.webContents.executeJavaScript("document.querySelector('#manualChatgptCopyOpen').click()");
    const firstTranslationPrompt = await waitFor('packaged Japanese prompt copied through the intercepted clipboard IPC', () =>
      clipboardWrites.length > promptBefore ? clipboardWrites.at(-1) : null);
    const originalJapanesePrompt = fs.readFileSync(path.join(repo, 'docs', 'prompts', '일본어 번역 프롬프트.txt'), 'utf8');
    assert.ok(firstTranslationPrompt.includes(originalJapanesePrompt), 'the UI sends the exact full Japanese prompt file');
    assert.match(firstTranslationPrompt, /번역 원문 언어 판정: 일본어/);
    assert.match(firstTranslationPrompt, /뒤 문맥 \(번역 대상 아님\):\s*\[\{"id":25,"text":"日本語の合成台詞 25"\},\{"id":26,"text":"日本語の合成台詞 26"\}\]/);
    assert.deepEqual(externalOpenRequests.slice(externalBefore), ['https://chatgpt.com/'], 'opening ChatGPT is intercepted and no real browser is launched');

    const firstBatchResponse = JSON.stringify({ translations: Array.from({ length: 24 }, (_, index) => ({ id: index + 1, text: `한국어 번역 ${index + 1}` })) });
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#manualChatgptAnswer').value = ${JSON.stringify(firstBatchResponse)};
      document.querySelector('#manualChatgptApply').click();
    })()`);
    await waitFor('first translated batch accepted with remaining cues pending', () => win.webContents.executeJavaScript('manualChatgptTranslation?.index === 1'));
    const secondPromptBefore = clipboardWrites.length;
    await win.webContents.executeJavaScript("document.querySelector('#manualChatgptCopyOpen').click()");
    const secondTranslationPrompt = await waitFor('second Japanese request includes preceding dialogue context', () =>
      clipboardWrites.length > secondPromptBefore ? clipboardWrites.at(-1) : null);
    assert.match(secondTranslationPrompt, /앞 문맥 \(번역 대상 아님\):\s*\[\{"id":23,"text":"日本語の合成台詞 23"\},\{"id":24,"text":"日本語の合成台詞 24"\}\]/);
    const lastBatchResponse = JSON.stringify({ translations: [25, 26].map(id => ({ id, text: `한국어 번역 ${id}` })) });
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#manualChatgptAnswer').value = ${JSON.stringify(lastBatchResponse)};
      document.querySelector('#manualChatgptApply').click();
    })()`);
    const savedManualTranslation = await waitFor('manual translation saved and applied to the same episode', () => win.webContents.executeJavaScript(`(async () => {
      if (currentSubtitle?.source !== 'chatgpt' || !currentSubtitle.path) return null;
      const key = subtitleStoreKey();
      const entries = await window.lilac.savedSubtitles(key);
      const entry = entries.find(item => item.source === 'chatgpt' && item.path === currentSubtitle.path);
      return entry ? { key, path: currentSubtitle.path, source: currentSubtitle.source, episodeNumber: currentPlaybackContext.episode?.number } : null;
    })()`));
    assert.equal(savedManualTranslation.source, 'chatgpt');
    assert.equal(savedManualTranslation.episodeNumber, 1);
    assert.ok(path.resolve(savedManualTranslation.path).startsWith(`${path.resolve(userData)}${path.sep}`), 'the translated subtitle is stored inside this test-only userData profile');
    assert.ok(fixtureRequests.includes('https://subtitles.invalid/phase1-ja.vtt'), 'the selected Japanese subtitle was fetched through the packaged main process');
    const translatedSubtitleText = fs.readFileSync(savedManualTranslation.path, 'utf8');
    const sourceTimecodes = [...syntheticJapaneseSubtitle.matchAll(/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/gm)].map(match => match[0]);
    const translatedTimecodes = [...translatedSubtitleText.matchAll(/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/gm)].map(match => match[0]);
    assert.deepEqual(translatedTimecodes, sourceTimecodes, 'all translated cues keep the source order and original timestamps');
    assert.match(translatedSubtitleText, /00:00:01\.000 --> 00:00:01\.200\n한국어 번역 1/);
    assert.match(translatedSubtitleText, /00:00:07\.250 --> 00:00:07\.450\n한국어 번역 26/);

    const sourcePicker = await win.webContents.executeJavaScript(`(() => {
      switchView('settings');
      window.showSettingsPane?.('playback');
      const button = document.querySelector('#sourceChoices button[data-value="animenosub"]');
      return { found: Boolean(button), label: button?.textContent.trim() || '' };
    })()`);
    assert.equal(sourcePicker.found, true, 'the packaged settings expose the Animenosub source choice');
    const sourceReloadFinished = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for the source-choice renderer reload')), 15000);
      win.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    });
    const selectedSource = await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#sourceChoices button[data-value="animenosub"]').click();
      return localStorage.getItem('contentSource');
    })()`);
    assert.equal(selectedSource, 'animenosub', 'the actual source choice stores the selected provider');
    await sourceReloadFinished;
    await waitFor('selected provider after settings reload', () => win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('#contentSource');
      return state.source === 'animenosub' && localStorage.getItem('contentSource') === 'animenosub'
        && select?.value === 'animenosub';
    })()`), 15000);
    const animenosubSitemap = await waitFor('Animenosub catalog sitemap after source selection', () => {
      const index = fixtureRequests.some(rawUrl => {
        const url = new URL(rawUrl);
        return url.hostname === 'animenosub.to' && url.pathname === '/sitemap_index.xml';
      });
      const sitemap = fixtureRequests.some(rawUrl => {
        const url = new URL(rawUrl);
        return url.hostname === 'animenosub.to' && url.pathname === '/anime-sitemap1.xml';
      });
      return index && sitemap;
    }, 15000);
    assert.equal(animenosubSitemap, true, 'the selected source activated its catalog index');
    const switchedHome = await waitFor('Animenosub quarter home card after settings reload', () => win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('#seasonRail .anime-card');
      const title = card?.querySelector('h3')?.textContent || '';
      if (state.source !== 'animenosub' || localStorage.getItem('contentSource') !== 'animenosub'
        || title !== '합성 Animenosub 분기작') return null;
      return {
        source: state.source,
        title,
        quarter: document.querySelector('#seasonTitle')?.textContent || '',
        selectedButton: document.querySelector('#sourceChoices button[data-value="animenosub"]')?.classList.contains('selected')
      };
    })()`), 20000);
    assert.match(switchedHome.quarter, /4분기/);
    assert.equal(switchedHome.selectedButton, true, 'settings reflect the persisted provider on the reloaded renderer');

    assert.ok(fixtureRequests.some(url => new URL(url).searchParams.get('q') === SEARCH_TITLE), 'search reached the synthetic Re:Anime API');
    assert.ok(fixtureRequests.some(url => new URL(url).hostname === 'linkkf1.5imgdarr.top'
      && new URL(url).pathname === '/api/singlefilter.php'), 'the weekly schedule reached all seven Linkkf API partitions');
    assert.ok(fixtureRequests.some(url => new URL(url).hostname === 'graphql.anilist.co'), 'the latest episode IPC reached the AniList GraphQL client');
    assert.ok(fixtureRequests.some(url => new URL(url).hostname === 'animenosub.to'
      && new URL(url).pathname === '/anime/' && new URL(url).searchParams.get('order') === 'update'), 'Animenosub latest updates reached its update-sorted feed');
    assert.ok(fixtureRequests.some(url => new URL(url).hostname === 'www.ohli24.net'
      && new URL(url).pathname === '/ing'), 'Ani24 latest updates reached its airing feed');
    assert.ok(fixtureRequests.some(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'animenosub.to' && url.pathname === '/anime/'
        && url.searchParams.get('season[0]') === 'fall-2026' && url.searchParams.get('order') === 'popular';
    }), 'Animenosub quarter listing reached its selected-season page');
    assert.ok(fixtureRequests.some(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'animenosub.to' && url.pathname === '/' && !url.search;
    }), 'the source switch loaded Animenosub through its regular catalog page');
    assert.ok(fixtureRequests.some(rawUrl => {
      const url = new URL(rawUrl);
      return url.hostname === 'www.miruro.to' && url.pathname === '/api/v1/anime/phase1-miruro-quarter/episodes';
    }), 'Miruro checked episode availability for the selected-quarter candidates');
    assert.ok(fixtureRequests.some(url => new URL(url).hostname === 'api.aniskip.com'), 'the player received an empty synthetic AniSkip response');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/v1/anime/${SLUG}/episodes`)), 'detail reached the synthetic episode API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/watch/${SLUG}/1`)), 'subtitle lookup reached the synthetic episode-server API');
    assert.ok(fixtureRequests.some(url => url.includes(`/api/watch/${SLUG}/99`)), 'unavailable resolve reached the synthetic episode-server API');
    assert.ok(fixtureRequests.some(url => url === 'https://subtitles.invalid/phase1-ko.vtt'), 'resolved stream downloaded the synthetic Korean VTT');
    assert.ok(fixtureRequests.some(url => localBase && url.startsWith(`${localBase}/master.m3u8`)), 'the app proxy fetched only the synthetic loopback manifest');
    assert.ok(fixtureRequests.some(url => localBase && url === `${localBase}/segment000.ts`), 'the app proxy fetched only the synthetic loopback segment');
    assert.ok(localBrowserRequests.includes('/ohli-player'), 'the packaged Ohli24 resolver opened the synthetic local player');
    assert.ok(localBrowserRequests.includes('/ohli-master.m3u8'), 'the Ohli24 fixture exposed a local HLS master');
    assert.ok(localBrowserRequests.includes('/ohli-caption.srt'), 'the Ohli24 resolver downloaded the local caption file');
    assert.equal(redirectedFlixRequests.length, 4, 'all FlixCloud fixture loads were redirected before external network access');
    assert.ok(redirectedFlixRequests.some(url => new URL(url).searchParams.get('server') === 'HD-1'), 'the main process resolved the alternate HD-1 server');
    assert.ok(localBrowserRequests.some(url => url.startsWith(`/e/${SLUG}?server=`)), 'the resolver loaded both local server fixtures');
    assert.ok(localBrowserRequests.some(url => url.startsWith('/master.m3u8?server=')), 'the resolver observed synthetic HLS manifest requests for both servers');
    const rendererProxyRequests = allowedLoopbackBrowserRequests.filter(url => url.startsWith(`${streamUrl.origin}/__flix/`));
    assert.ok(rendererProxyRequests.length >= 6, 'the packaged renderer fetched HLS manifests and media segments for initial play, resume, and server fallback');
    assert.ok(fetchAttempts.length > 0, 'the test exercised the packaged main process network boundary');
    assert.equal(deniedUnknownFetches.length, 0, `no unregistered main-process URL was requested: ${deniedUnknownFetches.join(', ')}`);
    assert.equal(deniedBrowserRequests.length, 0, `no external browser request was allowed or attempted: ${deniedBrowserRequests.join(', ')}`);

    console.log('Packaged Phase 1 smoke passed: actual main IPC Re:Anime/Miruro/Animenosub quarter catalogs and Re:Anime quarter selection UI, Re:Anime latest-airing UI, Linkkf current-day/weekday schedule UI, Animenosub/Ani24 update feeds and synthetic Ohli24 9.5 episode plus local caption resolution, Animenosub recent-updates home card, settings source selection and reload into the Animenosub home, renderer search button → result card → detail → episode button → packaged resolver playback, Korean subtitle parsing and save, loopback HLS decode, persisted resume, automatic same-kind server fallback, and an in-app Japanese prompt → manual translation → episode-scoped save with original cue timings and order. ChatGPT browser opening and clipboard writes use test-only interceptors; no real ChatGPT request is sent.');
    console.log(`Playback: ${playbackState.width}x${playbackState.height} at ${playbackState.currentTime.toFixed(2)}s; resume: ${resumeState.currentTime.toFixed(2)}s from saved 50%; fallback: ${fallbackState.server} at ${fallbackState.currentTime.toFixed(2)}s with selected subtitle; synthetic HTTP fixture calls: ${fixtureRequests.length}; FlixCloud redirects to loopback: ${redirectedFlixRequests.length}; local resolver requests: ${localBrowserRequests.length}; renderer proxy requests: ${rendererProxyRequests.length}; local proxy requests: ${localProxyRequests.length}; denied unknown fetches: 0; blocked browser requests: 0; external network calls: 0.`);
    await new Promise(resolve => localPlayerServer.close(resolve));
    app.quit();
  } catch (error) { fail(error); }
}).catch(fail);

process.on('exit', () => {
  try { if (localPlayerServer.listening) localPlayerServer.close(); } catch {}
  if (!sharedTempRoot && !parentTempRoot) try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
