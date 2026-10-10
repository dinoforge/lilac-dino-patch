const test = require('node:test');
const assert = require('node:assert/strict');
const { resetAniListClientState } = require('../electron/anilist-client.cjs');
const { fetchWeekdayEpisodes, mapWeekdayEpisodes, validCandidates, clearWeekdayEpisodeCache } = require('../electron/weekday-episodes.cjs');

test.beforeEach(() => { resetAniListClientState(); clearWeekdayEpisodeCache(); });

test('weekday AniList mapping retains only upcoming exact episodes for current provider candidates', () => {
  const anime = { provider: 'miruro', id: 'm1', anilistId: 101, availableEpisodeCount: 6 };
  const byId = validCandidates('miruro', [anime, { provider: 'reanime', anilistId: 102, subbed: 3 }]);
  const mapped = mapWeekdayEpisodes('miruro', byId, [
    { media: { id: 101 }, episode: 7, airingAt: 1500 },
    { media: { id: 101 }, episode: 8, airingAt: 2500 },
    { media: { id: 101 }, episode: 6, airingAt: 900 },
    { media: { id: 999 }, episode: 2, airingAt: 1800 }
  ], 1000, 2000);
  assert.deepEqual(mapped.map(item => [item.episode, item.airingAt]), [[7, 1500]]);
  assert.equal(mapped[0].anime, anime);
});

test('weekday schedule query accepts next episode beyond current uploads and caches the result', async () => {
  const now = 1_800_000_000_000, anime = { provider: 'reanime', id: 'a1', anilistId: 101, subbed: 6 };
  let calls = 0, requestBody;
  const fetchImpl = async (_, options) => {
    calls++; requestBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ data: { Page: { airingSchedules: [{ media: { id: 101 }, episode: 7, airingAt: now / 1000 + 800 }] } } }) };
  };
  const first = await fetchWeekdayEpisodes('reanime', [anime], { fetchImpl, now, minIntervalMs: 0 });
  const second = await fetchWeekdayEpisodes('reanime', [anime], { fetchImpl, now: now + 1000, minIntervalMs: 0 });
  assert.equal(calls, 1);
  assert.equal(first.data[0].episode, 7);
  assert.equal(second.fromCache, true);
  assert.deepEqual(requestBody.variables.ids, [101]);
  assert.equal(requestBody.variables.until - requestBody.variables.after, 7 * 24 * 60 * 60);
});

test('quarter refresh bypasses cached AniList data and a late older request cannot overwrite it', async () => {
  const now = 1_800_000_000_000, anime = { provider: 'reanime', anilistId: 303, subbed: 5 };
  let calls = 0, releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return oldResponse;
    return { ok: true, status: 200, json: async () => ({ data: { Page: { airingSchedules: [{ media: { id: 303 }, episode: 9, airingAt: now / 1000 + 900 }] } } }) };
  };
  const oldRequest = fetchWeekdayEpisodes('reanime', [anime], { fetchImpl, now, minIntervalMs: 0 });
  const refreshed = await fetchWeekdayEpisodes('reanime', [anime], { fetchImpl, now: now + 1000, minIntervalMs: 0, refresh: true });
  releaseOld({ ok: true, status: 200, json: async () => ({ data: { Page: { airingSchedules: [{ media: { id: 303 }, episode: 8, airingAt: now / 1000 + 800 }] } } }) });
  await oldRequest;
  const cached = await fetchWeekdayEpisodes('reanime', [anime], { fetchImpl, now: now + 2000, minIntervalMs: 0 });
  assert.equal(calls, 2);
  assert.equal(refreshed.data[0].episode, 9);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.data[0].episode, 9);
});

test('concurrent weekday schedule requests for the same provider candidates share one query', async () => {
  const now = 1_800_000_000_000, anime = { provider: 'reanime', anilistId: 202, subbed: 4 };
  let calls = 0, release;
  const response = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => { calls++; return response; };
  const first = fetchWeekdayEpisodes('reanime', [anime], { fetchImpl, now, minIntervalMs: 0 });
  const second = fetchWeekdayEpisodes('reanime', [anime], { fetchImpl, now, minIntervalMs: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release({ ok: true, status: 200, json: async () => ({ data: { Page: { airingSchedules: [] } } }) });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.data.length, 0);
  assert.equal(secondResult.data.length, 0);
});

test('unsupported providers return no fabricated weekday schedule', async () => {
  const result = await fetchWeekdayEpisodes('animenosub', [{ provider: 'animenosub', anilistId: 101, availableEpisodeCount: 3 }]);
  assert.deepEqual(result, { supported: false, data: [] });
});
