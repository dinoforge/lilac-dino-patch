'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchJikanJapaneseSeasonSchedule,
  clearJikanJapaneseSeasonScheduleCache
} = require('../electron/jikan-japanese-season.cjs');

const response = (data, hasNextPage = false, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ data, pagination: { has_next_page: hasNextPage } })
});
const entry = (malId, overrides = {}) => ({
  mal_id: malId,
  type: 'TV',
  year: 2026,
  season: 'fall',
  broadcast: { day: 'Mondays', time: '25:30', timezone: 'Asia/Tokyo' },
  ...overrides
});

test.beforeEach(() => clearJikanJapaneseSeasonScheduleCache());

test('matches Jikan seasonal broadcast by exact MAL ID and preserves Japanese extended hour', async () => {
  let calls = 0, requestedUrl = '';
  const result = await fetchJikanJapaneseSeasonSchedule([
    { malId: 101, catalogId: 'reanime:show-a', year: 2026, season: 'Fall 2026', format: 'TV' }
  ], {
    year: 2026, season: 'fall', minIntervalMs: 0, now: Date.now,
    fetchImpl: async url => { calls++; requestedUrl = url; return response([entry(101)]); }
  });
  assert.equal(calls, 1);
  assert.match(requestedUrl, /\/seasons\/2026\/fall\?/);
  assert.match(requestedUrl, /filter=tv/);
  assert.equal(result.state, 'complete');
  assert.equal(result.matchedCatalogCount, 1);
  assert.deepEqual(result.items.map(item => [item.source, item.malId, item.broadcastDay, item.broadcastTime, item.timeZone]), [
    ['Jikan', 101, 'Monday', '25:30', 'Asia/Tokyo']
  ]);
});

test('matches an ID-less catalog item only by a unique exact alias plus verified year, season, and TV metadata', async () => {
  const result = await fetchJikanJapaneseSeasonSchedule([
    { catalogId: 'reanime:show-idless', anilistId: 901, aliases: ['進撃の巨人', 'Attack on Titan'], year: 2026, season: 'Fall 2026', format: 'TV' }
  ], {
    year: 2026, season: 'fall', minIntervalMs: 0,
    fetchImpl: async () => response([{
      ...entry(901), title: 'Attack on Titan', title_english: 'Attack on Titan', title_japanese: '進撃の巨人', title_synonyms: ['Shingeki no Kyojin']
    }])
  });
  assert.equal(result.state, 'complete');
  assert.equal(result.matchedCatalogCount, 1);
  assert.deepEqual(result.items.map(item => [item.catalogId, item.anilistId, item.identityMatch, item.broadcastDay, item.broadcastTime]), [
    ['reanime:show-idless', 901, 'exact-title-season', 'Monday', '25:30']
  ]);
});

test('keeps title-only candidates unmatched when season metadata disagrees or the alias is ambiguous', async () => {
  const result = await fetchJikanJapaneseSeasonSchedule([
    { catalogId: 'winter-copy', aliases: ['Same Japanese Title'], year: 2026, season: 'Winter 2026', format: 'TV' },
    { catalogId: 'fall-one', aliases: ['Duplicate Title'], year: 2026, season: 'Fall 2026', format: 'TV' },
    { catalogId: 'fall-two', aliases: ['Duplicate Title'], year: 2026, season: 'Fall 2026', format: 'TV' }
  ], {
    year: 2026, season: 'fall', minIntervalMs: 0,
    fetchImpl: async () => response([
      { ...entry(902), title: 'Same Japanese Title' },
      { ...entry(903), title: 'Duplicate Title' }
    ])
  });
  assert.equal(result.state, 'complete');
  assert.equal(result.items.length, 0);
  assert.equal(result.matchedCatalogCount, 0);
  assert.equal(result.ambiguousCount, 1);
});

test('does not fall back to an exact title if a catalog item already has a conflicting MAL ID', async () => {
  const result = await fetchJikanJapaneseSeasonSchedule([
    { malId: 999, catalogId: 'show-wrong-mal', aliases: ['Exact Title'], year: 2026, season: 'Fall 2026', format: 'TV' }
  ], {
    year: 2026, season: 'fall', minIntervalMs: 0,
    fetchImpl: async () => response([{ ...entry(904), title: 'Exact Title' }])
  });
  assert.equal(result.state, 'complete');
  assert.equal(result.items.length, 0);
  assert.equal(result.matchedCatalogCount, 0);
});

test('paginates in seasonal batches and accepts only exact season, TV and JST broadcast metadata', async () => {
  let calls = 0;
  const result = await fetchJikanJapaneseSeasonSchedule([
    { malId: 101, catalogId: 'show-a', year: 2026, season: 'Fall 2026', format: 'TV' },
    { malId: 102, catalogId: 'show-b', year: 2026, season: 'Fall 2026', format: 'TV' },
    { malId: 103, catalogId: 'show-c', year: 2026, season: 'Fall 2026', format: 'TV' },
    { malId: 104, catalogId: 'show-d', year: 2026, season: 'Fall 2026', format: 'TV' }
  ], {
    year: 2026, season: 'fall', minIntervalMs: 0,
    fetchImpl: async (_url) => {
      calls++;
      return calls === 1
        ? response([entry(101), entry(102, { season: 'winter' }), entry(103, { type: 'Movie' })], true)
        : response([entry(104, { broadcast: { day: 'Sunday', time: '20:00', timezone: 'Asia/Seoul' } })], false);
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.items.map(item => item.malId), [101]);
  assert.equal(result.metadataMismatchCount, 2);
  assert.equal(result.missingBroadcastCount, 1);
});

test('keeps provider rate limits and request errors separate from a missing schedule', async () => {
  const limited = await fetchJikanJapaneseSeasonSchedule([
    { malId: 201, catalogId: 'show-e', year: 2026, season: 'Fall 2026' }
  ], { year: 2026, season: 'fall', minIntervalMs: 0,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  assert.equal(limited.state, 'failed');
  assert.equal(limited.errorCode, 'rate-limited');
  assert.equal(limited.failureStage, 'http');
  assert.equal(limited.httpStatus, 429);

  const timedOut = await fetchJikanJapaneseSeasonSchedule([
    { malId: 202, catalogId: 'show-f', year: 2026, season: 'Fall 2026' }
  ], { year: 2026, season: 'fall', minIntervalMs: 0, requestTimeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })) });
  assert.equal(timedOut.state, 'failed');
  assert.equal(timedOut.errorCode, 'request-timeout');
  assert.equal(timedOut.failureStage, 'network');
  assert.equal(timedOut.requestCount, 1);
  assert.equal(timedOut.requestStarted, true);
  assert.equal(timedOut.httpStatus, null);
});

test('shares a successful page set through a short-lived cache', async () => {
  let calls = 0;
  const args = [{ malId: 301, catalogId: 'show-g', year: 2026, season: 'Fall 2026' }];
  const fetchImpl = async () => { calls++; return response([entry(301)]); };
  const first = await fetchJikanJapaneseSeasonSchedule(args, { year: 2026, season: 'fall', minIntervalMs: 0, fetchImpl });
  const second = await fetchJikanJapaneseSeasonSchedule(args, { year: 2026, season: 'fall', minIntervalMs: 0, fetchImpl });
  assert.equal(first.state, 'complete');
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1);
});
