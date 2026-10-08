const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fetchLatestEpisodes, mapLatestEpisodes, validCandidates, clearLatestEpisodeCache } = require('../electron/latest-episodes.cjs');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

const now = 1_800_000_000_000;
const nowSeconds = Math.floor(now / 1000);
const anime = (id, availableEpisodeCount, provider = 'miruro') => ({ provider, id: String(id), anilistId: id, availableEpisodeCount, title: `Show ${id}` });

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
  clearLatestEpisodeCache();
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
