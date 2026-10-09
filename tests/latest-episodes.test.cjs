const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { requestAniListGraphQL, clearAniListCooldown } = require('../electron/anilist-client.cjs');
const { fetchLatestEpisodes, mapLatestEpisodes, validCandidates, clearLatestEpisodeCache } = require('../electron/latest-episodes.cjs');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

const now = 1_800_000_000_000;
const nowSeconds = Math.floor(now / 1000);
const anime = (id, availableEpisodeCount, provider = 'miruro') => ({ provider, id: String(id), anilistId: id, availableEpisodeCount, title: `Show ${id}` });
const clearAniListTestState = () => { clearLatestEpisodeCache(); clearAniListCooldown(); };

test('latest airing cards match only the selected source and currently available episodes', () => {
  const candidates = [anime(10, 8), anime(11, 2), anime(12, 10, 'reanime')];
  const byId = validCandidates('miruro', candidates);
  const mapped = mapLatestEpisodes('miruro', byId, [
    { media: { id: 10 }, episode: 8, airingAt: nowSeconds - 5 },
    { media: { id: 10 }, episode: 7, airingAt: nowSeconds - 20 },
    { media: { id: 11 }, episode: 3, airingAt: nowSeconds - 2 },
    { media: { id: 99 }, episode: 1, airingAt: nowSeconds - 1 }
  ], nowSeconds);
  assert.deepEqual(mapped.map(item => [item.anime.id, item.episode]), [['10', 8]]);
});

test('future, stale, and invalid airing schedules are not shown', () => {
  const byId = validCandidates('reanime', [{ provider: 'reanime', anilistId: 20, subbed: 10, dubbed: 0 }]);
  const mapped = mapLatestEpisodes('reanime', byId, [
    { media: { id: 20 }, episode: 8, airingAt: nowSeconds + 1 },
    { media: { id: 20 }, episode: 9, airingAt: nowSeconds - 15 * 86400 },
    { media: { id: 20 }, episode: 0, airingAt: nowSeconds - 60 }
  ], nowSeconds);
  assert.deepEqual(mapped, []);
});

test('AniList request is cached briefly and only trusted provider IDs are sent', async () => {
  clearAniListTestState();
  let requests = 0, body;
  const fetchImpl = async (_url, options) => {
    requests++;
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: { Page: { airingSchedules: [{ media: { id: 31 }, episode: 5, airingAt: nowSeconds - 30 }] } } }) };
  };
  const candidates = [anime(31, 6), { ...anime(32, 9), provider: 'animenosub' }, { provider: 'miruro', anilistId: 'bad', availableEpisodeCount: 4 }];
  const first = await fetchLatestEpisodes('miruro', candidates, { fetchImpl, now });
  const second = await fetchLatestEpisodes('miruro', candidates, { fetchImpl, now: now + 1000 });
  assert.equal(requests, 1);
  assert.deepEqual(body.variables.ids, [31]);
  assert.equal(first.data[0].episode, 5);
  assert.equal(second.fromCache, true);
});

test('AniList 429 honors Retry-After and reuses stale results without sending more requests', async () => {
  clearAniListTestState();
  const candidates = [anime(131, 6)], firstNow = now;
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    if (requests === 1) return { status: 200, ok: true, json: async () => ({ data: { Page: { airingSchedules: [{ media: { id: 131 }, episode: 5, airingAt: Math.floor(firstNow / 1000) - 30 }] } } }) };
    if (requests === 2) return { status: 429, ok: false, headers: { get: name => name === 'Retry-After' ? '20' : null } };
    const retriedNow = firstNow + 16 * 60 * 1000;
    return { status: 200, ok: true, json: async () => ({ data: { Page: { airingSchedules: [{ media: { id: 131 }, episode: 6, airingAt: Math.floor(retriedNow / 1000) - 30 }] } } }) };
  };
  const first = await fetchLatestEpisodes('miruro', candidates, { fetchImpl, now: firstNow });
  const limitedAt = firstNow + 16 * 60 * 1000;
  const limited = await fetchLatestEpisodes('miruro', candidates, { fetchImpl, now: limitedAt });
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.retryAfterAt, limitedAt + 20_000);
  assert.equal(limited.data[0].episode, first.data[0].episode);
  const deferred = await fetchLatestEpisodes('miruro', candidates, { fetchImpl, now: limitedAt + 10_000 });
  assert.equal(deferred.rateLimited, true);
  assert.equal(requests, 2);
  const retried = await fetchLatestEpisodes('miruro', candidates, { fetchImpl, now: limited.retryAfterAt });
  assert.equal(retried.rateLimited, undefined);
  assert.equal(retried.data[0].episode, 6);
  assert.equal(requests, 3);
});

test('AniList 429 without a usable Retry-After waits for its documented one-minute window', async () => {
  clearAniListTestState();
  let requests = 0;
  const fetchImpl = async () => { requests++; return { status: 429, headers: { get: () => null } }; };
  const limited = await fetchLatestEpisodes('reanime', [{ provider: 'reanime', anilistId: 132, subbed: 3 }], { fetchImpl, now });
  assert.equal(limited.retryAfterAt, now + 60_000);
  const deferred = await fetchLatestEpisodes('reanime', [{ provider: 'reanime', anilistId: 132, subbed: 3 }], { fetchImpl, now: now + 30_000 });
  assert.equal(deferred.rateLimited, true);
  assert.equal(requests, 1);
});

test('a 429 from an AniList title lookup also defers the latest episode query', async () => {
  clearAniListTestState();
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    if (requests === 1) return { status: 429, ok: false, headers: { get: name => name === 'Retry-After' ? '20' : null } };
    return { status: 200, ok: true, json: async () => ({ data: { Page: { airingSchedules: [{ media: { id: 133 }, episode: 4, airingAt: nowSeconds - 30 }] } } }) };
  };
  await assert.rejects(requestAniListGraphQL('query { Media { id } }', {}, { fetchImpl, now }), error => error.code === 'ANILIST_RATE_LIMITED');
  const candidates = [anime(133, 5)];
  const deferred = await fetchLatestEpisodes('miruro', candidates, { fetchImpl, now: now + 1000 });
  assert.equal(deferred.rateLimited, true);
  assert.equal(deferred.retryAfterAt, now + 20_000);
  assert.equal(requests, 1);
  const retried = await fetchLatestEpisodes('miruro', candidates, { fetchImpl, now: deferred.retryAfterAt });
  assert.equal(retried.data[0].episode, 4);
  assert.equal(requests, 2);
});

test('clearing the latest episode cache does not bypass the shared AniList cooldown', async t => {
  clearAniListTestState();
  t.after(clearAniListCooldown);
  let requests = 0;
  await assert.rejects(requestAniListGraphQL('query { Media { id } }', {}, {
    now,
    fetchImpl: async () => { requests++; return { status: 429, headers: { get: () => '20' } }; }
  }), error => error.code === 'ANILIST_RATE_LIMITED');

  clearLatestEpisodeCache();
  await assert.rejects(requestAniListGraphQL('query { Media { id } }', {}, {
    now: now + 1000,
    fetchImpl: async () => { requests++; return { status: 200 }; }
  }), error => error.code === 'ANILIST_RATE_LIMITED');
  assert.equal(requests, 1);
});

test('unsupported sources return an explicit unsupported result without a network call', async () => {
  let requests = 0;
  const result = await fetchLatestEpisodes('animenosub', [anime(40, 4)], { fetchImpl: async () => { requests++; } });
  assert.deepEqual(result, { supported: false, data: [] });
  assert.equal(requests, 0);
});

test('latest episode home rail is connected through HTML, renderer, preload, and IPC', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  assert.match(html, /id="latestEpisodeSection"/);
  assert.match(html, /id="latestEpisodeRail"/);
  assert.match(app, /window\.lilac\.providerLatestEpisodes\(provider/);
  assert.match(app, /latestEpisodeCache:v1:/, 'The renderer should persist its short-lived latest-episode cache');
  assert.match(app, /item\.playable!==false/, 'The clicked episode must be checked against the provider detail');
  assert.match(preload, /providerLatestEpisodes: \(provider, candidates\) => ipcRenderer\.invoke\('provider:latest-episodes'/);
  assert.match(main, /ipcMain\.handle\('provider:latest-episodes'/);
  assert.equal((main.match(/requestAniListGraphQL\(/g) || []).length, 5);
  assert.equal(main.includes("fetch('https://graphql.anilist.co'"), false);
});

test('renderer cache restores recent cards only while the current source still has those episodes', () => {
  const values = new Map();
  let time = now;
  class FixedDate extends Date { static now() { return time; } }
  const start = appSource.indexOf('const latestEpisodeCacheKey='), end = appSource.indexOf('\nfunction showLatestEpisodeItems', start);
  assert.ok(start >= 0 && end > start, 'Missing renderer latest-episode cache helpers');
  const context = vm.createContext({
    Date: FixedDate,
    store: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, set: (key, value) => values.set(key, value) }
  });
  vm.runInContext(`${appSource.slice(start, end)}\nglobalThis.helpers={rememberLatestEpisodeItems,cachedLatestEpisodeItems};`, context);
  const candidate = { provider: 'reanime', id: 'show', anilistId: 44, subbed: 6, dubbed: 0 };
  context.helpers.rememberLatestEpisodeItems('reanime', [{ ...candidate, latestEpisodeNumber: 5, latestAiringAt: nowSeconds - 120 }]);
  assert.equal(context.helpers.cachedLatestEpisodeItems('reanime', [candidate]).items[0].latestEpisodeNumber, 5);
  assert.equal(context.helpers.cachedLatestEpisodeItems('reanime', [{ ...candidate, subbed: 4 }]).items.length, 0);
  time += 13 * 60 * 60 * 1000;
  assert.equal(context.helpers.cachedLatestEpisodeItems('reanime', [candidate]), null);
});
