const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8').replace(/\r\n/g, '\n');
const cancelStart = appSource.indexOf('function cancelPendingPlaybackLookups(){');
const cancelEnd = appSource.indexOf('\n', cancelStart);
const historyStart = appSource.indexOf('async function playHistoryItem(item){');
const historyEnd = appSource.indexOf('\n\n// Android DetailScreen parity', historyStart);
const latestStart = appSource.indexOf('async function playLatestEpisode(anime){');
const latestEnd = appSource.indexOf('\nfunction normalizeSearchText', latestStart);
assert.ok(cancelStart >= 0 && cancelEnd > cancelStart, 'Missing playback lookup cancellation helper');
assert.ok(historyStart >= 0 && historyEnd > historyStart, 'Missing history playback handler');
assert.ok(latestStart >= 0 && latestEnd > latestStart, 'Missing home latest-episode handler');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const pending = new Map(), calls = [];
  const context = vm.createContext({
    latestEpisodeRequestId: 0,
    historyPlaybackRequestId: 0,
    playbackRequestId: 0,
    state: { season: [], top: [], library: [] },
    displayTitles: new Map(),
    PROVIDER_SOURCES: ['reanime'],
    URL,
    window: { lilac: {
      providerDetail: anime => {
        const request = deferred();
        pending.set(anime.mal_id, request);
        return request.promise;
      },
      providerResolve: async episode => { calls.push({ type: 'resolve', episode }); return { url: 'file:///synthetic.mp4' }; },
      linkkfEpisodes: async () => []
    } },
    titleOf: anime => anime?.title || '',
    imageOf: anime => anime?.image || '',
    animeTitleKey: anime => anime?.mal_id || anime?.id || '',
    episodeRef: episode => String(episode?.url || episode?.token || episode?.id || episode?.number || ''),
    episodeNumberOf: episode => Number(episode?.number) || Number(String(episode?.name || '').match(/\d+/)?.[0]) || 1,
    jobByRef: () => null,
    downloadedSeries: () => [],
    nearbyEpisodes: () => [],
    toast: message => calls.push({ type: 'toast', message }),
    openDetail: id => calls.push({ type: 'detail', id }),
    resolveIntoPlayer: async (resolver, name, playback) => {
      calls.push({ type: 'player', name, playback });
      await resolver();
    },
    play: (...args) => calls.push({ type: 'direct', args })
  });
  vm.runInContext(appSource.slice(cancelStart, cancelEnd), context);
  vm.runInContext(appSource.slice(historyStart, historyEnd) + '\nglobalThis.playHistoryItem = playHistoryItem;', context);
  vm.runInContext(appSource.slice(latestStart, latestEnd) + '\nglobalThis.playLatestEpisode = playLatestEpisode;', context);
  return { context, pending, calls };
}

function historyItem(id, number) {
  const anime = { provider: 'reanime', mal_id: `reanime:${id}`, title: id };
  const episode = { provider: 'reanime', number, name: String(number), url: `https://reanime.test/${id}/${number}` };
  return { name: `${id} · ${number}화`, subtitleTitle: id, image: '', anime, episode, progress: 42 };
}

test('a late history detail response cannot replace the most recently selected continue card', async () => {
  const h = setup(), firstItem = historyItem('first', 2), secondItem = historyItem('second', 5);
  const first = h.context.playHistoryItem(firstItem);
  const second = h.context.playHistoryItem(secondItem);

  h.pending.get(secondItem.anime.mal_id).resolve({ data: secondItem.anime, episodes: [secondItem.episode] });
  await second;
  h.pending.get(firstItem.anime.mal_id).resolve({ data: firstItem.anime, episodes: [firstItem.episode] });
  await first;

  const players = h.calls.filter(call => call.type === 'player');
  assert.equal(players.length, 1);
  assert.equal(players[0].playback.episode.url, secondItem.episode.url);
  assert.equal(players[0].playback.resumeProgress, secondItem.progress);
  assert.deepEqual(h.calls.filter(call => call.type === 'resolve').map(call => call.episode.url), [secondItem.episode.url]);
});

test('leaving playback navigation cancels an outstanding history detail lookup', async () => {
  const h = setup(), item = historyItem('pending', 3);
  const request = h.context.playHistoryItem(item);
  h.context.cancelPendingPlaybackLookups();
  h.pending.get(item.anime.mal_id).resolve({ data: item.anime, episodes: [item.episode] });
  await request;

  assert.equal(h.calls.some(call => call.type === 'player' || call.type === 'resolve'), false);
  assert.match(appSource, /if\(name!==current\)cancelPendingPlaybackLookups\(\)/);
  assert.match(appSource, /async function openDetail\(id\)\s*\{\s*cancelPendingPlaybackLookups\(\)/);
  assert.match(appSource, /async function doSearch\(query\)\s*\{\s*query=query\.trim\(\); if\(!query\)return;cancelPendingPlaybackLookups\(\)/);
});

test('a newer Continue selection cancels a pending home latest-episode lookup', async () => {
  const h = setup(), latestAnime = { provider: 'reanime', mal_id: 'reanime:latest', title: '최신', latestEpisodeNumber: 7 };
  const item = historyItem('continue', 2), latest = h.context.playLatestEpisode(latestAnime), history = h.context.playHistoryItem(item);

  h.pending.get(item.anime.mal_id).resolve({ data: item.anime, episodes: [item.episode] });
  await history;
  h.pending.get(latestAnime.mal_id).resolve({ data: latestAnime, episodes: [{ provider: 'reanime', number: 7, url: 'https://reanime.test/latest/7' }] });
  await latest;

  const players = h.calls.filter(call => call.type === 'player');
  assert.equal(players.length, 1);
  assert.equal(players[0].playback.episode.url, item.episode.url);
});

test('a newer home latest-episode selection cancels a pending Continue lookup', async () => {
  const h = setup(), item = historyItem('continue', 2), latestAnime = { provider: 'reanime', mal_id: 'reanime:latest', title: '최신', latestEpisodeNumber: 7 };
  const history = h.context.playHistoryItem(item), latest = h.context.playLatestEpisode(latestAnime);

  h.pending.get(latestAnime.mal_id).resolve({ data: latestAnime, episodes: [{ provider: 'reanime', number: 7, url: 'https://reanime.test/latest/7' }] });
  await latest;
  h.pending.get(item.anime.mal_id).resolve({ data: item.anime, episodes: [item.episode] });
  await history;

  const players = h.calls.filter(call => call.type === 'player');
  assert.equal(players.length, 1);
  assert.equal(players[0].playback.episode.url, 'https://reanime.test/latest/7');
});
