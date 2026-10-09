const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup({ source = 'reanime', current = [], quarterShows = [], quarterSelection = null, library = [], history = [], feed = async () => ({ data: [], nextOffset: 36, done: true }) } = {}) {
  const elements = new Map(), calls = [], storage = new Map();
  function element(id) {
    const classes = new Set();
    return {
      id, textContent: '', children: [], items: [], dataset: {}, attributes: {}, onclick: null,
      classList: {
        contains: name => classes.has(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      replaceChildren(...children) { this.children = children; this.items = children; },
      closest() { return this.section; },
      click() { this.clickCount = (this.clickCount || 0) + 1; this.onclick?.(); }
    };
  }
  const ids = ['homeOrder', 'homeOrderNote', 'seasonTitle', 'seasonRail', 'libraryView', 'libraryOrder', 'libraryOrderNote', 'libraryGrid', 'seeAllSeason', 'catalogFilterReset'];
  for (const id of ids) elements.set(id, element(id));
  elements.get('libraryView').classList.add('active');
  const section = element('homeSection');
  elements.get('seasonRail').section = section;
  const homeButtons = ['season', 'updated'].map(order => { const button = element('home-' + order); button.dataset.order = order; return button; });
  const libraryButtons = ['saved', 'updated'].map(order => { const button = element('library-' + order); button.dataset.order = order; return button; });
  const state = { source, current, season: current, quarterShows, quarterSelection, currentLabel: '', library, history };
  const context = vm.createContext({
    state,
    QUARTER_PROVIDERS: ['reanime', 'animenosub', 'miruro'],
    SOURCE_LABELS: { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkkf: 'Linkkf' },
    window: { lilac: { catalogUpdates: (provider, offset) => { calls.push({ provider, offset }); return feed(provider, offset); } } },
    localStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) },
    $: selector => {
      if (selector === '#homeOrder [data-order="season"]') return homeButtons[0];
      if (selector === '#homeOrder [data-order="updated"]') return homeButtons[1];
      return elements.get(selector.slice(1));
    },
    $$: selector => selector === '#homeOrder button' ? homeButtons : selector === '#libraryOrder button' ? libraryButtons : [],
    renderCards: (selector, items) => elements.get(selector.slice(1)).replaceChildren(...items),
    showHomeList: (items, label) => { context.homeList = { items, label }; },
    switchView: view => { context.view = view; }
  });
  const moduleSource = fs.readFileSync(path.join(__dirname, '../src/catalog-updates.js'), 'utf8');
  vm.runInContext(moduleSource + '\nglobalThis.api = catalogUpdateUI;', context);
  return { context, state, elements, homeButtons, libraryButtons, calls, storage, section };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a pending recent home result cannot replace the selected season or quarter', async () => {
  const request = deferred();
  const h = setup({ source: 'ohli24', current: [{ mal_id: 'season', title: '이번 시즌' }], feed: () => request.promise });
  h.context.api.renderHome();
  const pending = h.homeButtons[1].onclick();
  assert.deepEqual(h.calls, [{ provider: 'ohli24', offset: 0 }]);
  h.homeButtons[0].onclick();
  request.resolve({ data: [{ mal_id: 'recent', title: '최근 회차' }], nextOffset: 36, done: true });
  await pending;
  assert.deepEqual(h.elements.get('seasonRail').items.map(item => item.mal_id), ['season']);
  assert.equal(h.elements.get('seasonTitle').textContent, '이번 시즌 신작');

  const quarter = setup({ source: 'miruro', quarterShows: [{ mal_id: 'quarter' }], quarterSelection: { label: '2026년 2분기' } });
  quarter.context.api.renderHome();
  assert.equal(quarter.elements.get('seasonTitle').textContent, '2026년 2분기');
  assert.equal(quarter.homeButtons[0].textContent, '선택한 분기');
  assert.deepEqual(quarter.elements.get('seasonRail').items.map(item => item.mal_id), ['quarter']);
  const emptyQuarter = setup({ source: 'miruro', quarterSelection: { label: '2026년 2분기' } });
  emptyQuarter.context.api.renderHome();
  assert.equal(emptyQuarter.section.classList.contains('hidden'), false);
});

test('library update order overlays fresh metadata without changing saved order', async () => {
  const saved = [
    { mal_id: 'older', provider: 'reanime', title: '저장 이름' },
    { mal_id: 'newer', provider: 'reanime', title: '기존 이름' },
    { mal_id: 'linkkf', provider: 'linkkf', title: '링크케이에프' }
  ];
  const h = setup({ library: saved, feed: async () => ({
    data: [{ mal_id: 'newer', title: '갱신 이름', updatedAt: '2026-10-08T00:00:00Z' }],
    nextOffset: 36, done: true
  }) });
  await h.libraryButtons[1].onclick();
  assert.deepEqual(h.elements.get('libraryGrid').items.map(item => item.mal_id), ['newer', 'older', 'linkkf']);
  assert.equal(h.elements.get('libraryGrid').items[0].title, '갱신 이름');
  assert.deepEqual(h.state.library.map(item => item.mal_id), ['older', 'newer', 'linkkf']);
  assert.match(h.elements.get('libraryOrderNote').textContent, /Linkkf: 업데이트순 미지원/);
});

test('switching back to saved order ignores an older pending library response', async () => {
  const request = deferred();
  const h = setup({
    library: [{ mal_id: 'first', provider: 'reanime' }, { mal_id: 'second', provider: 'reanime' }],
    feed: () => request.promise
  });
  const pending = h.libraryButtons[1].onclick();
  h.libraryButtons[0].onclick();
  request.resolve({ data: [{ mal_id: 'second', updatedAt: '2026-10-08T00:00:00Z' }], nextOffset: 36, done: true });
  await pending;
  assert.deepEqual(h.elements.get('libraryGrid').items.map(item => item.mal_id), ['first', 'second']);
  assert.equal(h.elements.get('libraryOrderNote').textContent, '');
});

test('library NEW markers compare uploaded episode counts for every supported source without mutating saved items', async () => {
  const saved = [
    { provider: 'reanime', mal_id: 'reanime:one', availableEpisodes: 6 },
    { provider: 'miruro', mal_id: 'miruro:two', availableEpisodeCount: 6 },
    { provider: 'animenosub', mal_id: 'animenosub:three', availableEpisodes: 6 },
    { provider: 'ohli24', mal_id: 'ohli24:four', availableEpisodes: 6 }
  ];
  const updates = {
    reanime: { provider: 'reanime', mal_id: 'reanime:one', availableEpisodes: 7, subbed: 7, dubbed: 6 },
    miruro: { provider: 'miruro', mal_id: 'miruro:two', availableEpisodeCount: 7 },
    animenosub: { provider: 'animenosub', mal_id: 'animenosub:three', availableEpisodes: 7 },
    ohli24: { provider: 'ohli24', mal_id: 'ohli24:four', availableEpisodes: 7 }
  };
  const h = setup({ library: saved, feed: async provider => ({ data: [updates[provider]], nextOffset: 36, done: true }) });

  await h.context.api.renderLibrary();

  assert.deepEqual(h.elements.get('libraryGrid').items.map(item => item.libraryUpdateNew), [true, true, true, true]);
  assert.deepEqual(h.state.library, saved);
});

test('unknown legacy episode baselines are initialized once and later episode growth is marked NEW', async () => {
  const saved = { provider: 'ohli24', mal_id: 'ohli24:legacy', title: '기존 작품' };
  const update = { provider: 'ohli24', mal_id: saved.mal_id, availableEpisodes: 12 };
  const h = setup({ library: [saved], feed: async () => ({ data: [update], nextOffset: 36, done: true }) });

  await h.context.api.renderLibrary();
  assert.equal(h.elements.get('libraryGrid').items[0].libraryUpdateNew, undefined);
  assert.equal(JSON.parse(h.storage.get('libraryUpdateBaselines'))['ohli24:ohli24:legacy'], 12);

  update.availableEpisodes = 13;
  await h.context.api.renderLibrary();
  assert.equal(h.elements.get('libraryGrid').items[0].libraryUpdateNew, true);
});

test('watching a newly available episode advances its baseline and hides NEW', async () => {
  const saved = { provider: 'animenosub', mal_id: 'animenosub:show', availableEpisodes: 6 };
  const update = { provider: 'animenosub', mal_id: saved.mal_id, availableEpisodes: 7 };
  const h = setup({ library: [saved], feed: async () => ({ data: [update], nextOffset: 2, done: true }) });

  await h.context.api.renderLibrary();
  assert.equal(h.elements.get('libraryGrid').items[0].libraryUpdateNew, true);
  h.context.api.markEpisodeSeen(saved, { number: 7 });
  await h.context.api.renderLibrary();
  assert.equal(h.elements.get('libraryGrid').items[0].libraryUpdateNew, undefined);
});

test('library update sources are queried only while the library view is active', async () => {
  const h = setup({ library: [{ provider: 'reanime', mal_id: 'reanime:show', availableEpisodes: 1 }] });
  h.elements.get('libraryView').classList.remove('active');

  await h.context.api.renderLibrary();

  assert.deepEqual(h.calls, []);
});

test('a watched latest episode suppresses NEW but another provider history does not', async () => {
  const saved = { provider: 'reanime', mal_id: 'reanime:show', availableEpisodes: 6 };
  const update = { provider: 'reanime', mal_id: saved.mal_id, availableEpisodes: 7 };
  const h = setup({
    library: [saved],
    history: [{ anime: { provider: 'miruro', mal_id: saved.mal_id }, episode: { number: 7 }, progress: 80 }],
    feed: async () => ({ data: [update], nextOffset: 36, done: true })
  });

  await h.context.api.renderLibrary();
  assert.equal(h.elements.get('libraryGrid').items[0].libraryUpdateNew, true);
  h.state.history[0].anime.provider = 'reanime';
  await h.context.api.renderLibrary();
  assert.equal(h.elements.get('libraryGrid').items[0].libraryUpdateNew, undefined);
});

test('unsupported provider hides home update ordering and recent see-all opens the updated catalog', async () => {
  const h = setup({ source: 'linkkf' });
  h.context.api.renderHome();
  assert.equal(h.elements.get('homeOrder').classList.contains('hidden'), true);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/catalog-updates.js'), 'utf8'), /linkani/i);

  const supported = setup({ feed: async () => ({ data: [{ mal_id: 'one' }], nextOffset: 36, done: true }) });
  await supported.homeButtons[1].onclick();
  supported.elements.get('seeAllSeason').onclick();
  assert.equal(supported.storage.get('allSort:reanime'), 'updated');
  assert.equal(supported.elements.get('catalogFilterReset').clickCount, 1);
  assert.equal(supported.context.view, 'all');
});
