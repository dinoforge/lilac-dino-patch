const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { latestUpdatedEpisodes } = require('../src/home-discovery.js');

const root = path.join(__dirname, '..');

test('home update cards use each supported source episode count and keep feed order', () => {
  const items = latestUpdatedEpisodes('animenosub', [
    { provider: 'animenosub', mal_id: 'one', url: 'https://animenosub.test/anime/one', availableEpisodes: 8, title: '첫 작품' },
    { provider: 'animenosub', mal_id: 'two', url: 'https://animenosub.test/anime/two', availableEpisodes: null },
    { provider: 'animenosub', mal_id: 'three', url: 'https://animenosub.test/anime/three', episodes: 4 },
    { provider: 'ohli24', mal_id: 'foreign', url: 'https://ohli.test/one', availableEpisodes: 12 },
    { provider: 'animenosub', mal_id: 'one', url: 'https://animenosub.test/anime/one', availableEpisodes: 10, title: '첫 작품 최신 카드' },
    { provider: 'animenosub', mal_id: 'invalid', availableEpisodes: 2 }
  ]);

  assert.deepEqual(items.map(item => [item.mal_id, item.latestEpisodeNumber, item.latestEpisodeKind]), [
    ['one', 10, 'updated'], ['three', 4, 'updated']
  ]);
  assert.equal(items[0].title, '첫 작품 최신 카드');
});

test('home update cards are limited to Animenosub and Ohli24 and require a positive episode number', () => {
  const ohli = latestUpdatedEpisodes('ohli24', [
    { provider: 'ohli24', mal_id: 'one', url: 'https://ohli.test/one', episodes: '5' },
    { provider: 'ohli24', mal_id: 'zero', url: 'https://ohli.test/zero', availableEpisodes: 0 },
    { provider: 'ohli24', mal_id: 'fraction', url: 'https://ohli.test/fraction', availableEpisodes: 1.5 }
  ]);
  assert.deepEqual(ohli.map(item => item.latestEpisodeNumber), [5]);
  assert.deepEqual(latestUpdatedEpisodes('linkkf', ohli), []);
  assert.deepEqual(latestUpdatedEpisodes('reanime', ohli), []);
});

test('home update feed is loaded through the existing provider IPC, cached per source, and revalidated before playback', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  assert.ok(html.indexOf('src="home-discovery.js"') < html.indexOf('src="app.js"'));
  assert.match(html, /id="latestEpisodeTitle"/);
  assert.match(app, /window\.lilac\.catalogUpdates\(provider,0\)/);
  assert.match(app, /latestUpdatedEpisodeCache:v1:/);
  assert.match(app, /cached\.age<30\*60\*1000/);
  assert.match(app, /providerDetail\(anime\)/);
  assert.match(app, /episodes\.find\(item=>item\?\.provider===anime\.provider&&Number\(item\.number\)===number&&item\.playable!==false\)/);
});

function setupLatestRail({ source = 'animenosub', feed = async () => ({ data: [] }), saved = [] } = {}) {
  const elements = new Map(), storage = new Map(saved), calls = [];
  function element(id) {
    const classes = new Set();
    return {
      id, textContent: '', children: [],
      classList: {
        contains: name => classes.has(name),
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
      },
      replaceChildren(...children) { this.children = children; }
    };
  }
  for (const id of ['latestEpisodeSection', 'latestEpisodeRail', 'latestEpisodeStatus', 'latestEpisodeTitle', 'seeAllLatestEpisodes', 'latestEpisodeRetry']) elements.set(id, element(id));
  const state = { source, latestEpisodes: [] };
  const context = vm.createContext({
    state,
    LilacHomeDiscovery: { latestUpdatedEpisodes },
    store: {
      get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback; },
      set(key, value) { storage.set(key, value); }
    },
    window: { lilac: { catalogUpdates: async (provider, offset) => { calls.push({ provider, offset }); return feed(provider, offset); } } },
    $: selector => elements.get(selector.slice(1)),
    renderCards(selector, items) { elements.get(selector.slice(1)).replaceChildren(...items); }
  });
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const start = app.indexOf('let latestEpisodeRequest=0;');
  const end = app.indexOf('// Android SearchScreen (Linkkf): 태그 필터', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(app.slice(start, end) + '\nglobalThis.loadLatestEpisodeRail = loadLatestEpisodeRail;', context);
  return { context, elements, state, storage, calls };
}

test('home update rail loads once, persists source results, and reuses a fresh saved list', async () => {
  const feed = async () => ({
    note: '공급원 최신 회차',
    data: [{ provider: 'animenosub', mal_id: 'show', title: '작품', url: 'https://animenosub.test/anime/show', availableEpisodes: 7 }]
  });
  const h = setupLatestRail({ feed });
  await h.context.loadLatestEpisodeRail('animenosub', []);
  assert.deepEqual(h.calls, [{ provider: 'animenosub', offset: 0 }]);
  assert.equal(h.elements.get('latestEpisodeTitle').textContent, '최신 업데이트 회차');
  assert.equal(h.elements.get('latestEpisodeRail').children[0].latestEpisodeNumber, 7);
  assert.match(h.elements.get('latestEpisodeStatus').textContent, /공급원 최신 회차/);
  await h.context.loadLatestEpisodeRail('animenosub', []);
  assert.equal(h.calls.length, 1);
  assert.equal(h.elements.get('latestEpisodeStatus').textContent, '저장된 최신 업데이트 회차 1개');
});

test('home update rail keeps saved cards and exposes retry when the refresh fails', async () => {
  const cachedAt = Date.now() - 31 * 60 * 1000;
  const saved = [['latestUpdatedEpisodeCache:v1:ohli24', {
    savedAt: cachedAt,
    items: [{ provider: 'ohli24', mal_id: 'show', title: '저장 작품', url: 'https://ohli.test/show', availableEpisodes: 4 }]
  }]];
  const h = setupLatestRail({ source: 'ohli24', saved, feed: async () => { throw new Error('mock refresh failure'); } });
  await h.context.loadLatestEpisodeRail('ohli24', []);
  assert.equal(h.elements.get('latestEpisodeTitle').textContent, '최신 업데이트 회차');
  assert.equal(h.elements.get('latestEpisodeRail').children[0].title, '저장 작품');
  assert.match(h.elements.get('latestEpisodeStatus').textContent, /저장된 회차 1개를 표시 중/);
  assert.equal(h.elements.get('latestEpisodeRetry').classList.contains('hidden'), false);
});

function setupLatestPlayback({ anime, episodes }) {
  const calls = [], messages = [];
  const context = vm.createContext({
    window: { lilac: {
      providerDetail: async item => { calls.push({ type: 'detail', item }); return { data: item, episodes }; },
      providerResolve: async episode => { calls.push({ type: 'resolve', episode }); return { url: 'file:///synthetic.mp4' }; }
    } },
    titleOf: item => item.title,
    imageOf: item => item.image || '',
    nearbyEpisodes: () => [],
    resolveIntoPlayer: (resolver, name, playback, title, episodeNumber) => {
      calls.push({ type: 'player', name, playback, title, episodeNumber, resolver });
    },
    toast: message => messages.push(message),
    openDetail: id => calls.push({ type: 'openDetail', id })
  });
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const start = app.indexOf('async function playLatestEpisode(anime){');
  const end = app.indexOf('\nfunction normalizeSearchText', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(app.slice(start, end) + '\nglobalThis.playLatestEpisode = playLatestEpisode;', context);
  return { context, calls, messages, anime };
}

test('latest episode playback never crosses any selected provider boundary', async () => {
  const providers = ['animenosub', 'ohli24', 'reanime', 'miruro'];
  for (const provider of providers) {
    const otherProvider = providers.find(candidate => candidate !== provider);
    const anime = { provider, mal_id: `${provider}:show`, title: '작품', latestEpisodeNumber: 7 };
    const h = setupLatestPlayback({ anime, episodes: [
      { provider: otherProvider, number: 7, url: `https://${otherProvider}.test/wrong-source` },
      { provider, number: 7, playable: false, url: `https://${provider}.test/unplayable` },
      { provider, number: 6, url: `https://${provider}.test/wrong-number` },
      { provider, number: 7, url: `https://${provider}.test/selected` }
    ] });

    await h.context.playLatestEpisode(anime);
    const player = h.calls.find(call => call.type === 'player');
    assert.ok(player, `${provider} should select its available episode`);
    assert.equal(player.playback.episode.url, `https://${provider}.test/selected`);
    assert.equal(player.playback.episode.provider, provider);
    assert.equal(player.episodeNumber, 7);
    await player.resolver();
    assert.equal(h.calls.find(call => call.type === 'resolve').episode.url, `https://${provider}.test/selected`);
    assert.deepEqual(h.messages, []);
  }
});

test('latest episode playback opens detail instead of resolving a same-number foreign episode', async () => {
  const anime = { provider: 'ohli24', mal_id: 'ohli24:show', title: '작품', latestEpisodeNumber: 3 };
  const h = setupLatestPlayback({ anime, episodes: [{ provider: 'miruro', number: 3, url: 'https://miruro.test/wrong-source' }] });

  await h.context.playLatestEpisode(anime);
  assert.equal(h.calls.some(call => call.type === 'player' || call.type === 'resolve'), false);
  assert.deepEqual(h.calls.filter(call => call.type === 'openDetail').map(call => call.id), ['ohli24:show']);
  assert.match(h.messages[0], /현재 공급원에서 재생 가능한 회차로 확인되지 않았습니다/);
});
