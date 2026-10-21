const test = require('node:test');
const assert = require('node:assert/strict');
const { resetAniListClientState } = require('../electron/anilist-client.cjs');
const {
  fetchJapaneseSeasonSchedule,
  clearJapaneseSeasonScheduleCache
} = require('../electron/season-jst-schedule.cjs');

const now = Date.parse('2026-10-18T12:00:00.000Z');
const from = Math.floor(Date.parse('2026-10-18T15:00:00.000Z') / 1000);
const until = from + 7 * 24 * 60 * 60;
const response = (schedules, hasNextPage = false) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { Page: { pageInfo: { hasNextPage }, airingSchedules: schedules } } })
});
const jikanResponse = (data, hasNextPage = false) => ({
  ok: true, status: 200,
  json: async () => ({ data, pagination: { has_next_page: hasNextPage } })
});
const row = (id, episode, airingAt, countryOfOrigin = 'JP', format = 'TV', extra = {}) => ({
  media: { id, countryOfOrigin, format, season: 'FALL', seasonYear: 2026, ...extra },
  episode,
  airingAt
});

test.beforeEach(() => {
  resetAniListClientState();
  clearJapaneseSeasonScheduleCache();
});

test('queries one bounded AniList week without excluding future episodes and keeps only Japanese TV rows by exact ID', async () => {
  let calls = 0, body, query;
  const result = await fetchJapaneseSeasonSchedule([101, '102', 101, 'bad'], {
    from, until, now, minIntervalMs: 0,
    fetchImpl: async (_, options) => {
      calls++;
      body = JSON.parse(options.body);
      query = body.query;
      return response([
        row(101, 4, from + 60),
        row(102, 2, from + 120, 'US'),
        row(101, 5, from + 180, 'JP', 'MOVIE'),
        row(999, 1, from + 240)
      ]);
    }
  });
  assert.equal(calls, 1);
  assert.doesNotMatch(query, /notYetAired\s*:/);
  assert.deepEqual(body.variables.ids, [101, 102]);
  assert.equal(body.variables.from, from - 1);
  assert.equal(body.variables.until, until);
  assert.equal(result.state, 'complete');
  assert.equal(result.sources.AniList.requestCount, 1);
  assert.equal(result.sources.AniList.requestDiagnostics.requestStarted, true);
  assert.equal(result.timeZone, 'Asia/Tokyo');
  assert.deepEqual(result.items.map(item => [item.anilistId, item.episode]), [[101, 4]]);
  assert.equal(result.rejectedCountryCount, 1);
  assert.equal(result.rejectedFormatCount, 1);
  assert.equal(result.unmatchedCount, 1);
});

test('paginates until complete and shares a successful result through cache', async () => {
  let calls = 0;
  const fetchImpl = async (_, options) => {
    calls++;
    const page = JSON.parse(options.body).variables.page;
    return page === 1
      ? response([row(101, 1, from + 100)], true)
      : response([row(101, 2, from + 200)], false);
  };
  const first = await fetchJapaneseSeasonSchedule([101], { from, until, now, minIntervalMs: 0, fetchImpl });
  const second = await fetchJapaneseSeasonSchedule([101], { from, until, now: now + 1000, minIntervalMs: 0, fetchImpl });
  assert.equal(calls, 2);
  assert.equal(first.pageCount, 2);
  assert.equal(first.sources.AniList.requestCount, 2);
  assert.equal(first.state, 'complete');
  assert.deepEqual(first.items.map(item => item.episode), [1, 2]);
  assert.equal(second.fromCache, true);
});

test('a late page failure preserves confirmed rows as partial and does not cache the incomplete week', async () => {
  let calls = 0;
  const fetchImpl = async (_, options) => {
    calls++;
    const page = JSON.parse(options.body).variables.page;
    return page === 1 ? response([row(101, 1, from + 100)], true) : { ok: false, status: 500, json: async () => ({}) };
  };
  const first = await fetchJapaneseSeasonSchedule([101], { from, until, now, minIntervalMs: 0, fetchImpl });
  const second = await fetchJapaneseSeasonSchedule([101], { from, until, now: now + 1000, minIntervalMs: 0, fetchImpl });
  assert.equal(first.state, 'partial');
  assert.equal(first.errorCode, 'AniList:http-500');
  assert.equal(first.items.length, 1);
  assert.equal(second.state, 'partial');
  assert.equal(calls, 4);
});

test('unavailable and malformed schedule requests remain explicit failures', async () => {
  const invalid = await fetchJapaneseSeasonSchedule([101], { from, until: from + 9 * 24 * 60 * 60, now });
  assert.equal(invalid.state, 'failed');
  assert.equal(invalid.errorCode, 'invalid-range');
  const limited = await fetchJapaneseSeasonSchedule([101], {
    from, until, now, minIntervalMs: 0,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => '30' },
      body: { cancel: async () => {} }
    })
  });
  assert.equal(limited.state, 'failed');
  assert.equal(limited.errorCode, 'AniList:rate-limited');
});

test('a stalled AniList queue or fetch settles the Patch 01 request as timeout', async () => {
  const startedAt = Date.now();
  const result = await fetchJapaneseSeasonSchedule([101], {
    from, until, now, minIntervalMs: 0, requestTimeoutMs: 20,
    fetchImpl: () => new Promise(() => {})
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.errorCode, 'AniList:request-timeout');
  assert.equal(result.sources.AniList.failureStage, 'network');
  assert.ok(Date.now() - startedAt < 1000);
});

test('reports transport, HTTP and GraphQL failures separately with request size diagnostics', async () => {
  const candidate = [{ anilistId: 701, catalogId: 'show-a' }];
  const dns = await fetchJapaneseSeasonSchedule(candidate, {
    from, until, seasonYear: 2026, season: 'FALL', now, minIntervalMs: 0,
    fetchImpl: async () => { const cause = Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' }); throw Object.assign(new TypeError('fetch failed'), { cause }); }
  });
  assert.equal(dns.sources.AniList.errorCode, 'dns-enotfound');
  assert.equal(dns.sources.AniList.failureStage, 'network');
  assert.equal(dns.sources.AniList.requestDiagnostics.networkErrorCode, 'ENOTFOUND');
  assert.ok(dns.sources.AniList.requestDiagnostics.requestBodyBytes > 0);
  assert.equal(dns.sources.AniList.httpStatus, null);

  const http = await fetchJapaneseSeasonSchedule([{ anilistId: 702 }], {
    from: from + 1, until, seasonYear: 2026, season: 'FALL', now, minIntervalMs: 0,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  assert.equal(http.sources.AniList.errorCode, 'http-500');
  assert.equal(http.sources.AniList.failureStage, 'http');
  assert.equal(http.sources.AniList.httpStatus, 500);

  const graphql = await fetchJapaneseSeasonSchedule([{ anilistId: 703 }], {
    from: from + 2, until, seasonYear: 2026, season: 'FALL', now, minIntervalMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Unknown field AiringSchedule.media.format', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }) })
  });
  assert.equal(graphql.sources.AniList.errorCode, 'graphql-error');
  assert.equal(graphql.sources.AniList.failureStage, 'graphql');
  assert.deepEqual(graphql.sources.AniList.requestDiagnostics.graphqlErrorCodes, ['GRAPHQL_VALIDATION_FAILED']);
});

test('uses Jikan season broadcast by numeric MAL ID while retaining AniList ID-less catalog candidates', async () => {
  const candidates = [
    { catalogId: 'show-a', anilistId: 704, malId: 1704, year: 2026, season: 'FALL 2026', format: 'TV' },
    { catalogId: 'show-b', malId: 1705, year: 2026, season: 'FALL 2026', format: 'TV' },
    { catalogId: 'show-c', year: 2026, season: 'FALL 2026', format: 'TV' }
  ];
  const result = await fetchJapaneseSeasonSchedule(candidates, {
    from, until, seasonYear: 2026, season: 'FALL', now, minIntervalMs: 0, jikanMinIntervalMs: 0,
    fetchImpl: async () => response([row(704, 7, from + 90)]),
    jikanFetchImpl: async () => jikanResponse([
      { mal_id: 1704, type: 'TV', year: 2026, season: 'fall', broadcast: { day: 'Mondays', time: '25:30', timezone: 'Asia/Tokyo' } },
      { mal_id: 1705, type: 'TV', year: 2026, season: 'fall', broadcast: { day: 'Tuesdays', time: '22:00', timezone: 'Asia/Tokyo' } }
    ])
  });
  assert.equal(result.sources.AniList.state, 'complete');
  assert.equal(result.sources.Jikan.state, 'complete');
  assert.equal(result.state, 'complete');
  assert.equal(result.requestDiagnostics.catalogCandidateCount, 3);
  assert.equal(result.requestDiagnostics.catalogAniListIdCount, 1);
  assert.equal(result.requestDiagnostics.catalogMalIdCount, 2);
  assert.equal(result.requestDiagnostics.unverifiedIdentityCount, 1);
  assert.deepEqual(result.items.filter(item => item.source === 'Jikan').map(item => [item.malId, item.broadcastDay, item.broadcastTime]), [
    [1704, 'Monday', '25:30'], [1705, 'Tuesday', '22:00']
  ]);
});

test('allows a verified Jikan exact-title-season result for a catalog item without MAL ID', async () => {
  const result = await fetchJapaneseSeasonSchedule([
    { catalogId: 'reanime:catalog-a', anilistId: 1701, malId: null, aliases: ['日本語の作品名', 'Japanese Series'], year: 2026, season: 'FALL 2026', format: 'TV' }
  ], {
    from, until, seasonYear: 2026, season: 'FALL', now, minIntervalMs: 0, jikanMinIntervalMs: 0,
    fetchImpl: async () => response([]),
    jikanFetchImpl: async () => jikanResponse([{
      mal_id: 2701, type: 'TV', year: 2026, season: 'fall', title: 'Japanese Series',
      title_japanese: '日本語の作品名', title_synonyms: ['Alternate Name'],
      broadcast: { day: 'Mondays', time: '25:30', timezone: 'Asia/Tokyo' }
    }])
  });
  assert.equal(result.sources.Jikan.state, 'complete');
  assert.equal(result.sources.Jikan.matchedCatalogCount, 1);
  assert.deepEqual(result.items.map(item => [item.source, item.catalogId, item.identityMatch, item.broadcastDay, item.broadcastTime]), [
    ['Jikan', 'reanime:catalog-a', 'exact-title-season', 'Monday', '25:30']
  ]);
});
