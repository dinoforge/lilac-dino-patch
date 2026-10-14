'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Catalog = require('../src/unified-catalog.js');
const IntegratedSearch = require('../src/integrated-search.js');

test('episode sources merge by the same resolved series and episode number despite title differences', () => {
  const seriesKey = 'anilist:12345';
  const groups = Catalog.groupEpisodes([
    { provider: 'reanime', seriesKey, episode: { name: '1화', number: 1 }, anime: { title: '작품' }, seriesEpisodes: [] },
    { provider: 'miruro', seriesKey, episode: { name: 'Episode 1', number: 1 }, anime: { title: '작품' }, seriesEpisodes: [] },
    { provider: 'linkkf', seriesKey, serverName: '서버 A', episode: { name: '1화', number: 1, token: 'one-a' }, anime: { title: '작품' }, seriesEpisodes: [] },
    { provider: 'linkkf', seriesKey, serverName: '서버 B', episode: { name: 'Episode 1', number: 1, token: 'one-b' }, anime: { title: '작품' }, seriesEpisodes: [] },
    { provider: 'ohli24', seriesKey, episode: { name: 'Episode 1', number: 1 }, anime: { title: '작품' }, seriesEpisodes: [] }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].choices.length, 5);
  assert.equal(groups[0].choices.filter(choice => choice.provider === 'linkkf').length, 2);
});

test('episode number alone never merges sources when episode titles are missing', () => {
  const groups = Catalog.groupEpisodes([
    { provider: 'reanime', episode: { number: 3 }, anime: {} },
    { provider: 'miruro', episode: { number: 3 }, anime: {} }
  ]);
  assert.equal(groups.length, 2);
});

test('episode parser prefers the episode number over a season number', () => {
  assert.equal(Catalog.episodeNumber({ name: 'S02E03' }), 3);
  assert.equal(Catalog.episodeNumber({ name: 'Season 2 Episode 10' }), 10);
});

test('catalog continues with healthy providers when one browse source fails', async () => {
  const lilac = {
    providerCatalog: async provider => {
      if (provider === 'miruro') throw new Error('offline');
      return { data: [{ id: `${provider}-one`, mal_id: `${provider}:one`, title: 'Work', provider }] };
    },
    linkkfHome: async () => ({ data: [{ id: '55', mal_id: 'linkkf:55', provider: 'linkkf', title: 'Work' }] })
  };
  const service = Catalog.createCatalogService({ lilac, integratedSearch: IntegratedSearch, timeoutMs: 100 });
  const result = await service.browse();
  assert.equal(result.statuses.find(value => value.provider === 'miruro').state, 'failed');
  assert.ok(result.items.some(value => value.provider === 'reanime'));
  assert.ok(result.items.some(value => value.provider === 'linkkf'));
});

test('details preserve completed provider episodes when another source fails', async () => {
  const goodAnime = { provider: 'reanime', id: 'one', mal_id: 'reanime:one', title: 'Work' };
  const linkkfAnime = { provider: 'linkkf', id: '77', mal_id: 'linkkf:77', title: 'Work' };
  const service = Catalog.createCatalogService({
    integratedSearch: IntegratedSearch,
    timeoutMs: 100,
    lilac: {
      providerDetail: async () => ({ data: goodAnime, episodes: [{ name: '2화', number: 2, token: 'r2' }] }),
      linkkfDetail: async () => { throw new Error('offline'); },
      linkkfEpisodes: async () => []
    }
  });
  const result = await service.details({ sourceItems: [goodAnime, linkkfAnime] });
  assert.equal(result.results[0].episodes.length, 1);
  assert.match(result.results[1].error, /offline/);
  assert.equal(result.groupedEpisodes.length, 1);
  assert.equal(result.groupedEpisodes[0].choices[0].provider, 'reanime');
});

test('service applies a bounded timeout and does not retry a slow provider request', async () => {
  let calls = 0;
  const service = Catalog.createCatalogService({
    integratedSearch: IntegratedSearch,
    timeoutMs: 10,
    lilac: { providerCatalog: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return { data: [] }; }, linkkfHome: async () => ({ data: [] }) }
  });
  const result = await service.browse();
  assert.equal(calls, 4);
  assert.equal(result.statuses.filter(value => value.state === 'failed').length, 4);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(calls, 4, 'a timeout is surfaced without automatic retries');
});
