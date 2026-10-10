const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
const start = appSource.indexOf('function subtitleAvailabilityLabel');
const end = appSource.indexOf('\nfunction currentSubtitleAvailability', start);
assert.ok(start >= 0 && end > start, 'Missing subtitle availability status helpers');
const context = vm.createContext({});
vm.runInContext(`${appSource.slice(start, end)}\nthis.subtitleHelpers = { subtitleAvailabilityLabel, subtitleAvailabilityStatusFromError };`, context);
const helpers = context.subtitleHelpers;

test('subtitle provider status distinguishes found, missing, checking, and failed checks', () => {
  assert.equal(helpers.subtitleAvailabilityLabel('available'), '있음');
  assert.equal(helpers.subtitleAvailabilityLabel('unavailable'), '없음');
  assert.equal(helpers.subtitleAvailabilityLabel('checking'), '확인 중');
  assert.equal(helpers.subtitleAvailabilityLabel('error'), '확인 실패');
  assert.equal(helpers.subtitleAvailabilityLabel('unknown'), '미확인');
  assert.equal(helpers.subtitleAvailabilityStatusFromError(new Error('Kairan 자막 게시물을 찾지 못했습니다.')), 'unavailable');
  assert.equal(helpers.subtitleAvailabilityStatusFromError(new Error('사용 가능한 자막 파일을 추출하지 못했습니다.')), 'unavailable');
  assert.equal(helpers.subtitleAvailabilityStatusFromError(new Error('Csora HTTP 503')), 'error');
});

const onlineSubtitleStart = appSource.indexOf('const ONLINE_SUBTITLE_SOURCES=');
const onlineSubtitleEnd = appSource.indexOf('\nfunction attachOnlineSubtitle(', onlineSubtitleStart);
assert.ok(onlineSubtitleStart >= 0 && onlineSubtitleEnd > onlineSubtitleStart, 'Missing online subtitle search state');
const onlineSubtitleSource = appSource.slice(onlineSubtitleStart, onlineSubtitleEnd);

function createOnlineSubtitleContext() {
  const requests = [];
  let context;
  context = vm.createContext({
    playbackRequestId: 1,
    currentEpisodeKey: 'reanime:episode-1',
    subtitleStoreKey: () => context.currentEpisodeKey,
    seriesKey: () => 'reanime:show-1',
    preferredSubtitleSource: () => 'kairan',
    window: {
      lilac: {
        findSubtitle(source, title, episode, anime) {
          return new Promise(resolve => requests.push({ source, title, episode, anime, resolve }));
        }
      }
    },
    $$: () => []
  });
  vm.runInContext(`${onlineSubtitleSource}\nthis.subtitleAvailabilityMap = subtitleAvailabilityByEpisode;`, context);
  return { context, requests };
}

test('reused pending subtitle search updates availability for the current playback request', async () => {
  const h = createOnlineSubtitleContext(), anime = { provider: 'reanime', id: 'show-1' };
  const firstPlayback = h.context.onlineSubtitleFor('테스트 애니', 1, anime);
  assert.equal(h.requests.length, 3);
  h.context.playbackRequestId++;
  const replay = h.context.onlineSubtitleFor('테스트 애니', 1, anime);
  assert.strictEqual(replay, firstPlayback, 'the pending episode search is reused');

  h.requests.find(request => request.source === 'kairan').resolve({ path: 'episode-1.vtt', url: 'subtitle://episode-1' });
  h.requests.find(request => request.source === 'csora').resolve(null);
  h.requests.find(request => request.source === 'anissia').resolve(null);
  const result = await replay;

  assert.equal(result.source, 'kairan');
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.subtitleAvailabilityMap.get('reanime:episode-1'))), {
    kairan: 'available', csora: 'unavailable', anissia: 'unavailable'
  });

  h.context.playbackRequestId++;
  const availability = h.context.subtitleAvailabilityMap.get('reanime:episode-1');
  for (const source of ['kairan', 'csora', 'anissia']) availability[source] = 'checking';
  const cachedResult = h.context.onlineSubtitleFor('테스트 애니', 1, anime);
  assert.strictEqual(cachedResult, firstPlayback, 'a completed match is cached for the episode');
  await cachedResult;
  assert.deepEqual(JSON.parse(JSON.stringify(availability)), {
    kairan: 'available', csora: 'unavailable', anissia: 'unavailable'
  });
  assert.equal(h.requests.length, 3, 'replay does not duplicate subtitle network requests');
});

function extractMain(startMarker, endMarker) {
  const start = mainSource.indexOf(startMarker), end = mainSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Missing main-process source between ${startMarker} and ${endMarker}`);
  return mainSource.slice(start, end);
}

const failureHelpers = extractMain('function subtitleNotFoundError(', '\n// Blogger feeds return');
const anissiaFinder = extractMain('async function findAnissiaSubtitle(', '\nasync function downloadHls');

function createNoResult(message = '자막을 찾지 못했습니다.') {
  const error = new Error(message);
  error.code = 'SUBTITLE_NOT_FOUND';
  return error;
}

test('trying title variants preserves a source failure instead of reporting no subtitle', async () => {
  const context = vm.createContext({
    findCommunitySubtitle: async (_, title) => {
      if (title === '영문 제목') throw new Error('Kairan HTTP 503');
      throw createNoResult('Kairan 자막 게시물을 찾지 못했습니다.');
    },
    findAnissiaSubtitle: async (_, title) => { throw createNoResult(`Anissia ${title} 미발견`); }
  });
  vm.runInContext(`${failureHelpers}\nthis.findByTitles = findCommunitySubtitleByTitles;`, context);

  await assert.rejects(
    context.findByTitles('kairan', ['영문 제목', '한국어 제목'], 3, {}),
    error => error.message === 'Kairan HTTP 503' && helpers.subtitleAvailabilityStatusFromError(error) === 'error'
  );
});

test('all title variants with no match remain a genuine unavailable result', async () => {
  const context = vm.createContext({
    findCommunitySubtitle: async () => { throw createNoResult('Kairan 자막 게시물을 찾지 못했습니다.'); },
    findAnissiaSubtitle: async () => { throw createNoResult('Anissia 자막을 찾지 못했습니다.'); }
  });
  vm.runInContext(`${failureHelpers}\nthis.findByTitles = findCommunitySubtitleByTitles;`, context);

  await assert.rejects(
    context.findByTitles('kairan', ['제목 A', '제목 B'], 3, {}),
    error => error.code === 'SUBTITLE_NOT_FOUND' && helpers.subtitleAvailabilityStatusFromError(error) === 'unavailable'
  );
});

test('the next title variant can still return a matching subtitle', async () => {
  const context = vm.createContext({
    findCommunitySubtitle: async (_, title) => {
      if (title === '제목 A') throw createNoResult('Kairan 자막 게시물을 찾지 못했습니다.');
      return { path: 'title-b.vtt' };
    },
    findAnissiaSubtitle: async () => { throw createNoResult('Anissia 자막을 찾지 못했습니다.'); }
  });
  vm.runInContext(`${failureHelpers}\nthis.findByTitles = findCommunitySubtitleByTitles;`, context);

  const result = await context.findByTitles('kairan', ['제목 A', '제목 B'], 3, {});
  assert.equal(result.path, 'title-b.vtt');
  assert.equal(result.searchTitle, '제목 B');
});

function createAnissiaContext(tistoryPosts, { captions, linkedPost, fetchPost, extractWinPng } = {}) {
  const context = vm.createContext({
    URL,
    anissiaMakers: async () => ({ anime: { subject: '테스트 작품' }, captions: captions || [{ website: 'https://maker.tistory.com/post', name: 'maker' }] }),
    naverBlogRef: () => null,
    anissiaLinkedPost: linkedPost || (async () => null),
    anissiaNickname: () => '',
    tistoryPosts,
    communitySeason: () => 1,
    communityPostEpisodes: () => ({ has: () => true }),
    communityScore: () => 1,
    communityTitle: value => value,
    communityPostTitle: post => post.title || '',
    rankCommunityPosts: posts => posts.length ? [{ links: [] }] : [],
    providerFetch: fetchPost || (async () => 'fixture'),
    winPngSubtitle: extractWinPng || (async () => null),
    downloadCommunityMatch: async () => ({ path: 'found.vtt' })
  });
  vm.runInContext(`${failureHelpers}\n${anissiaFinder}\nthis.findAnissiaSubtitle = findAnissiaSubtitle;`, context);
  return context;
}

test('Anissia reports an empty search as unavailable', async () => {
  const context = createAnissiaContext(async () => []);
  await assert.rejects(
    context.findAnissiaSubtitle('테스트 작품', 1),
    error => error.code === 'SUBTITLE_NOT_FOUND' && helpers.subtitleAvailabilityStatusFromError(error) === 'unavailable'
  );
});

test('Anissia preserves maker network errors as failed checks', async () => {
  const context = createAnissiaContext(async () => { throw new Error('Tistory HTTP 503'); });
  await assert.rejects(
    context.findAnissiaSubtitle('테스트 작품', 1),
    error => error.message === 'Tistory HTTP 503' && helpers.subtitleAvailabilityStatusFromError(error) === 'error'
  );
});

test('Anissia continues to later makers after an earlier maker fails', async () => {
  const context = createAnissiaContext(async () => [{ title: '테스트 작품 1화', url: 'https://maker.tistory.com/post', html: 'fixture' }], {
    captions: [
      { website: 'https://unstable.example/post', name: 'first' },
      { website: 'https://maker.tistory.com/post', name: 'second' }
    ],
    linkedPost: async url => {
      if (url.includes('unstable')) throw new Error('Maker HTTP 503');
      return null;
    }
  });

  const result = await context.findAnissiaSubtitle('테스트 작품', 1);
  assert.equal(result.path, 'found.vtt');
  assert.equal(result.maker, 'second');
});

test('Anissia preserves a post-body fetch error as a failed check', async () => {
  const context = createAnissiaContext(async () => [{ title: '테스트 작품 1화', url: 'https://maker.tistory.com/post', html: 'index' }], {
    fetchPost: async () => { throw new Error('Tistory post HTTP 503'); }
  });

  await assert.rejects(
    context.findAnissiaSubtitle('테스트 작품', 1),
    error => error.message === 'Tistory post HTTP 503' && helpers.subtitleAvailabilityStatusFromError(error) === 'error'
  );
});

test('Anissia preserves an image subtitle extraction error as a failed check', async () => {
  const context = createAnissiaContext(async () => [], {
    extractWinPng: async () => { throw new Error('WinPNG HTTP 502'); }
  });

  await assert.rejects(
    context.findAnissiaSubtitle('테스트 작품', 1),
    error => error.message === 'WinPNG HTTP 502' && helpers.subtitleAvailabilityStatusFromError(error) === 'error'
  );
});

test('per-episode source chips are connected to online checks and retain the selected provider', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const player = fs.readFileSync(path.join(root, 'src/player.js'), 'utf8');
  assert.match(html, /data-source="kairan"><b>Kairan<\/b><small data-source-status aria-live="polite">미확인<\/small>/);
  assert.match(html, /data-source="csora"><b>Csora<\/b><small data-source-status aria-live="polite">미확인<\/small>/);
  assert.match(html, /data-source="anissia"><b>Anissia<\/b><small data-source-status aria-live="polite">미확인<\/small>/);
  assert.match(player, /setSubtitleAvailability\(source, 'checking', requestId\)/);
  assert.match(player, /setSubtitleAvailability\(source, 'available', requestId\)/);
});
