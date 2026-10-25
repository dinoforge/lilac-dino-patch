const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PROVIDERS, groupResults, filterGroups, chooseSource, searchProviders, mergeSearchResults, providersNeedingTitleVariants, titleVariantTerms } = require('../src/integrated-search.js');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

const item = (provider, id, values = {}) => ({ provider, mal_id: `${provider}:${id}`, title: '같은 제목', ...values });

test('groups exact AniList identities while retaining each provider item', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100, title: '한국어 제목' }),
    item('miruro', 'b', { anilistId: 100, title: 'Same Title' }),
    item('ohli24', 'c', { anilistId: 200, title: '같은 제목' })
  ], 'miruro');

  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, 'Same Title', 'the selected provider supplies the preferred card metadata');
  assert.deepEqual(groups[0].sourceItems.map(source => source.provider), ['miruro', 'reanime']);
  assert.equal(groups[0].sourceCount, 2);
  assert.equal(groups[1].sourceItems.length, 1);
});

test('a unique MAL ID bridges an AniList item and an item without an AniList ID', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100, malId: 900 }),
    item('animenosub', 'b', { malId: 900 })
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sourceItems.map(source => source.provider), ['reanime', 'animenosub']);
});

test('verified multilingual aliases bridge providers only with matching year and compatible format', () => {
  const groups = groupResults([
    item('reanime', 'jp', { title: 'Shingeki no Kyojin', title_japanese: '進撃の巨人', year: 2013, type: 'TV' }),
    item('linkani', 'ko', { title: '진격의 거인', title_english: 'Attack on Titan', year: 2013, type: 'TV', synonyms: ['Shingeki no Kyojin'] })
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sourceItems.map(source => source.provider), ['reanime', 'linkani']);

  assert.equal(groupResults([
    item('reanime', 'one', { title: 'Same Show', year: 2013, type: 'TV' }),
    item('linkani', 'two', { title: 'Same Show', year: 2014, type: 'TV' })
  ]).length, 2);
  assert.equal(groupResults([
    item('reanime', 'series', { title: 'Same Show', title_english: 'Same Show', year: 2013, type: 'TV' }),
    item('linkani', 'movie', { title: 'Same Show', title_english: 'Same Show', year: 2013, type: 'Movie' })
  ]).length, 2);
});

test('the original displayed localized title is a grouping alias without weakening season checks', () => {
  const groups = groupResults([
    item('reanime', 'jp', { title: 'Sousou no Frieren', displayTitle: '장송의 프리렌', year: 2023, type: 'TV' }),
    item('ohli24', 'ko', { title: '葬送のフリーレン', displayTitle: '장송의 프리렌', year: 2023, type: 'TV' })
  ]);
  assert.equal(groups.length, 1);

  assert.equal(groupResults([
    item('reanime', 'season-one', { displayTitle: '장송의 프리렌', year: 2023, season: '1', type: 'TV' }),
    item('ohli24', 'season-two', { displayTitle: '장송의 프리렌', year: 2026, season: '2', type: 'TV' })
  ]).length, 2, 'a localized title cannot override different season metadata');
  assert.equal(groupResults([
    item('reanime', 'series', { displayTitle: '장송의 프리렌', year: 2023, type: 'TV' }),
    item('ohli24', 'movie', { displayTitle: '장송의 프리렌', year: 2023, type: 'Movie' })
  ]).length, 2, 'a localized title cannot merge a series and a movie');
});

test('exact season-qualified series aliases can bridge a provider item missing year when the match is unique', () => {
  const groups = groupResults([
    item('reanime', 'season-three', {
      anilistId: 185756, malId: 60601,
      title: "As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World Season 3",
      year: 2026, type: 'TV'
    }),
    item('animenosub', 'season-three', {
      title: 'As a Reincarnated Aristocrat, I’ll Use My Appraisal Skill to Rise in the World Season 3',
      type: 'TV', availableEpisodes: 4
    })
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupKey, 'anilist:185756');
  assert.deepEqual(groups[0].sourceItems.map(source => source.provider), ['reanime', 'animenosub']);
});

test('yearless season-qualified aliases remain separate when they could match multiple seasons', () => {
  const groups = groupResults([
    item('reanime', 'season-three-2026', {
      anilistId: 185756,
      title: "As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World Season 3",
      year: 2026, type: 'TV'
    }),
    item('miruro', 'season-three-2027', {
      anilistId: 209939,
      title: "As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World Season 3",
      year: 2027, type: 'TV'
    }),
    item('animenosub', 'season-three-unknown-year', {
      title: "As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World Season 3",
      type: 'TV'
    })
  ]);

  assert.equal(groups.length, 3, 'an ambiguous yearless item must stay unlinked');
  assert.ok(groups.every(group => group.sourceItems.length === 1));
});

test('season or part suffixes prevent title-only matches when the other source has no season metadata', () => {
  assert.equal(groupResults([
    item('reanime', 'season-two', { title: 'Example Season 2', year: 2024 }),
    item('linkani', 'unspecified', { title: 'Example', year: 2024 })
  ]).length, 2);
  assert.equal(groupResults([
    item('reanime', 'jp', { title: '進撃の巨人 第2期', year: 2017 }),
    item('linkani', 'other', { title: '진격의 거인', title_japanese: '進撃の巨人', year: 2017 })
  ]).length, 2);
});

test('title-only aliases never merge two entries from the same provider', () => {
  const groups = groupResults([
    item('reanime', 'first', { title: 'Same Show', year: 2022 }),
    item('reanime', 'second', { title: 'Same Show', year: 2022 })
  ]);
  assert.equal(groups.length, 2);
});

test('ambiguous MAL bridges do not merge different AniList identities or an unlinked result', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100, malId: 900 }),
    item('miruro', 'b', { anilistId: 101, malId: 900 }),
    item('animenosub', 'c', { malId: 900 })
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group => group.sourceItems.length), [1, 1, 1]);
});

test('Linkkf stays outside Patch 03 aggregation while original Linkkf IPC remains available', () => {
  assert.deepEqual(PROVIDERS, ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani']);
  assert.deepEqual(groupResults([item('linkkf', 'legacy')]), []);
  const preload = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.match(preload, /linkkfResolve: episode => ipcRenderer\.invoke\('linkkf:resolve', episode\)/);
  assert.match(main, /ipcMain\.handle\('linkkf:resolve'/);
});

test('same-title seasons and candidates without stable IDs remain separate', () => {
  const groups = groupResults([
    item('reanime', 'season-1', { anilistId: 100 }),
    item('miruro', 'season-2', { anilistId: 101 }),
    item('animenosub', 'unknown-1'),
    item('ohli24', 'unknown-2')
  ]);

  assert.equal(groups.length, 4);
  assert.ok(groups.every(group => group.sourceItems.length === 1));
});

test('duplicate provider entries collapse by provider item ID, not by title', () => {
  const groups = groupResults([
    item('reanime', 'same', { anilistId: 100, title: '먼저 온 제목' }),
    item('reanime', 'same', { anilistId: 100, title: '늦게 온 중복' }),
    item('reanime', 'different', { anilistId: 100, title: '같은 작품의 다른 항목' })
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].sourceItems.length, 2);
  assert.equal(groups[0].sourceItems[0].title, '먼저 온 제목');
});

test('provider filters retain groups that include that provider and source choice honors the filter', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100 }),
    item('miruro', 'b', { anilistId: 100 }),
    item('ohli24', 'c', { anilistId: 200 })
  ]);

  const filtered = filterGroups(groups, 'miruro');
  assert.equal(filtered.length, 1);
  assert.equal(chooseSource(filtered[0], { provider: 'miruro', preferredProvider: 'reanime' }).provider, 'miruro');
  assert.equal(chooseSource(filtered[0], { preferredProvider: 'reanime' }).provider, 'reanime');
  assert.equal(chooseSource(filtered[0], { preferredProvider: 'reanime', preferredSourceProvider: 'miruro' }).provider, 'miruro');
  assert.equal(chooseSource(filtered[0], { sourceId: 'miruro:b' }).provider, 'miruro');
});

test('search checks every provider and records a successful empty result separately from an error', async () => {
  const calls = [];
  const result = await searchProviders({
    providers: ['reanime', 'miruro'],
    query: 'test',
    search: async (provider, query) => {
      calls.push(`${provider}:${query}`);
      if (provider === 'miruro') throw new Error('offline');
      return { data: [] };
    }
  });

  assert.deepEqual(calls, ['reanime:test', 'miruro:test']);
  assert.equal(result.statuses.find(status => status.provider === 'reanime').state, 'ready');
  assert.equal(result.statuses.find(status => status.provider === 'reanime').resultCount, 0);
  assert.equal(result.statuses.find(status => status.provider === 'miruro').state, 'failed');
});

test('Korean query uses the local Korean catalog and skips providers that return newest posts for Korean searches', async () => {
  const calls = [], localCalls = [];
  const result = await searchProviders({
    providers: ['reanime', 'animenosub', 'miruro'],
    query: '한국 제목',
    terms: ['Korean Title'],
    localSearch: async provider => {
      localCalls.push(provider);
      return provider === 'reanime' ? [item('reanime', 'local')] : null;
    },
    search: async (provider, query) => {
      calls.push(`${provider}:${query}`);
      return { data: [item(provider, query)] };
    }
  });

  assert.deepEqual(calls, ['reanime:한국 제목', 'reanime:Korean Title', 'animenosub:Korean Title', 'miruro:Korean Title']);
  assert.deepEqual(localCalls, ['reanime', 'animenosub', 'miruro']);
  assert.equal(result.items.some(anime => anime.mal_id === 'reanime:local'), true);
  assert.equal(result.statuses.find(status => status.provider === 'animenosub').state, 'ready');
});

test('search limits concurrent provider requests and reports partial provider failures', async () => {
  let active = 0, maximum = 0;
  const result = await searchProviders({
    providers: ['reanime'],
    query: 'one',
    terms: ['two', 'three'],
    concurrency: 2,
    search: async (_provider, query) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      if (query === 'two') throw new Error('one title variant failed');
      return { data: [item('reanime', query)] };
    }
  });

  assert.equal(maximum, 2);
  assert.equal(result.statuses[0].state, 'partial');
  assert.equal(result.statuses[0].resultCount, 2);
});

test('merged query and title-variant runs deduplicate provider items and preserve partial errors', () => {
  const merged = mergeSearchResults(
    { items: [item('reanime', 'a')], statuses: [
      { provider: 'reanime', state: 'ready', attempts: 1, successes: 1, failures: 0 },
      { provider: 'miruro', state: 'failed', attempts: 1, successes: 0, failures: 1 }
    ] },
    { items: [item('reanime', 'a', { title: 'duplicate' }), item('miruro', 'b')], statuses: [
      { provider: 'reanime', state: 'partial', attempts: 2, successes: 1, failures: 1 },
      { provider: 'miruro', state: 'partial', attempts: 2, successes: 1, failures: 1 }
    ] }
  );

  assert.equal(merged.items.length, 2);
  assert.deepEqual(merged.statuses.map(status => [status.provider, status.state, status.resultCount]), [
    ['reanime', 'partial', 1], ['miruro', 'partial', 1]
  ]);
});

test('title variants target only successfully checked providers with no results', () => {
  const result = { statuses: [
    { provider: 'reanime', state: 'ready', resultCount: 2 },
    { provider: 'miruro', state: 'ready', resultCount: 0 },
    { provider: 'animenosub', state: 'failed', resultCount: 0 },
    { provider: 'ohli24', state: 'partial', resultCount: 0 },
    { provider: 'linkani', state: 'ready', resultCount: 0 }
  ] };
  assert.deepEqual(providersNeedingTitleVariants(result, PROVIDERS), ['miruro', 'linkani']);
  assert.deepEqual(titleVariantTerms({
    query: 'Sousou no Frieren',
    displayTitles: ['장송의 프리렌', ' 장송의 프리렌 '],
    variants: ['葬送のフリーレン', 'Sousou no Frieren', 'Frieren'],
    limit: 3
  }), ['장송의 프리렌', '葬送のフリーレン', 'Frieren']);
});

test('integrated search only asks ready-empty providers for resolved title variants, not unrelated result titles', async () => {
  const calls = [], applied = [], searchSource = appSource.slice(
    appSource.indexOf('async function doSearch(query) {'),
    appSource.indexOf('\nfunction showPendingPlayer', appSource.indexOf('async function doSearch(query) {'))
  );
  const element = () => ({ textContent: '', replaceChildren() {}, classList: { add() {}, remove() {} } });
  const elements = new Map();
  const getElement = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  let titleVariantCalls = 0;
  let run = 0;
  const first = { items: [item('reanime', 'found', { displayTitle: '검색어와 무관한 첫 결과' })], statuses: [
    { provider: 'reanime', state: 'ready', attempts: 1, successes: 1, failures: 0, resultCount: 1 },
    { provider: 'miruro', state: 'ready', attempts: 1, successes: 1, failures: 0, resultCount: 0 },
    { provider: 'animenosub', state: 'failed', attempts: 1, successes: 0, failures: 1, resultCount: 0 }
  ] };
  const extra = { items: [], statuses: [
    { provider: 'miruro', state: 'ready', attempts: 1, successes: 1, failures: 0, resultCount: 0 }
  ] };
  const integratedApi = { ...require('../src/integrated-search.js') };
  const context = vm.createContext({
    state: { contentSourceMode: 'integrated', source: 'reanime' },
    SOURCE_LABELS: {}, currentSearchStatuses: [], currentSearchGroups: [], currentSearchFilter: 'all', currentSearchQuery: '',
    searchGroupsByKey: new Map(), LilacIntegratedSearch: integratedApi,
    cancelPendingPlaybackLookups() {}, saveRecentSearch() {}, switchView() {},
    contentSearchProviders: () => ['reanime', 'miruro', 'animenosub'], searchKoreanCatalog() {},
    titleOf: anime => anime.displayTitle || anime.title,
    applyIntegratedSearchResult: result => applied.push(result),
    window: { lilac: {
      providerCatalog() {}, titleVariants: async () => { titleVariantCalls++; return ['원본 다국어 표기']; }
    } },
    $: getElement
  });
  context.window.lilac.providerCatalog = () => {};
  integratedApi.searchProviders = async options => {
    calls.push({ providers: [...options.providers], query: options.query, terms: [...(options.terms || [])] });
    run++;
    return run === 1 ? first : extra;
  };
  vm.runInContext(`${searchSource}\nthis.runSearch=doSearch;`, context);

  await context.runSearch('typed title');
  assert.deepEqual(calls, [
    { providers: ['reanime', 'miruro', 'animenosub'], query: 'typed title', terms: [] },
    { providers: ['miruro'], query: '', terms: ['원본 다국어 표기'] }
  ]);
  assert.equal(titleVariantCalls, 1);
  assert.equal(applied.length, 2);

  calls.length = 0;
  const allFound = { ...first, statuses: first.statuses.map(status => ({ ...status, state: 'ready', resultCount: 1 })) };
  integratedApi.searchProviders = async options => { calls.push(options); return allFound; };
  await context.runSearch('all found');
  assert.equal(calls.length, 1, 'a complete first pass must not invoke title lookup or supplementary search');
  assert.equal(titleVariantCalls, 1);
});

test('Ani24 search reports a failed catalog request instead of a successful zero when both search boards fail', async () => {
  const start = mainSource.indexOf('async function ohliSearch(query){');
  const end = mainSource.indexOf('\nfunction ohliItems', start);
  assert.ok(start >= 0 && end > start, 'Ani24 search adapter is present');
  let boardCalls = 0;
  const networkError = new Error('net::ERR_CONNECTION_RESET');
  const context = vm.createContext({
    spaceKey: value => String(value || '').replace(/\s+/g, ''),
    ohliAiring: async () => { throw networkError; },
    ohliBoard: async () => { boardCalls++; throw networkError; },
    searchIgnoringSpaces: async () => []
  });
  vm.runInContext(`${mainSource.slice(start, end)}\nthis.search=ohliSearch;`, context);

  await assert.rejects(context.search('葬送のフリーレン 第2期'), /ERR_CONNECTION_RESET/);
  assert.equal(boardCalls, 2, 'the initial completed and movie searches are isolated and both observed');
});

test('Ani24 keeps a genuine empty catalog result distinct when search boards responded', async () => {
  const start = mainSource.indexOf('async function ohliSearch(query){');
  const end = mainSource.indexOf('\nfunction ohliItems', start);
  let spaceFallbacks = 0;
  const context = vm.createContext({
    spaceKey: value => String(value || '').replace(/\s+/g, ''),
    ohliAiring: async () => { throw new Error('optional airing list unavailable'); },
    ohliBoard: async () => ({ data: [] }),
    searchIgnoringSpaces: async () => { spaceFallbacks++; return []; }
  });
  vm.runInContext(`${mainSource.slice(start, end)}\nthis.search=ohliSearch;`, context);

  assert.deepEqual(Array.from(await context.search('葬送のフリーレン 第2期')), []);
  assert.equal(spaceFallbacks, 1, 'successful empty board responses still allow the bounded existing spelling fallback');
});

test('Re:Anime detail and episode fallbacks share a lazy page loader', () => {
  const start = mainSource.indexOf("ipcMain.handle('provider:detail'");
  const end = mainSource.indexOf("ipcMain.handle('provider:resolve'", start);
  assert.ok(start >= 0 && end > start, 'provider detail IPC handler is present');
  const handler = mainSource.slice(start, end);
  const reanimeStart = handler.indexOf("if (anime.provider === 'reanime')");
  const genericPageStart = handler.indexOf('const html=await providerFetch(anime.url', reanimeStart);
  assert.ok(reanimeStart >= 0 && genericPageStart > reanimeStart, 'Re:Anime handles its API routes before the generic page fetch');
  const reanimeBranch = handler.slice(reanimeStart, genericPageStart);
  assert.match(reanimeBranch, /let pagePromise = null/);
  assert.match(reanimeBranch, /const page = \(\) => \{/);
  assert.match(reanimeBranch, /pagePromise = providerFetch\(anime\.url/);
  assert.match(reanimeBranch, /rean[i]meDetail\(anime, page\)/i);
  assert.match(reanimeBranch, /rean[i]meEpisodes\(detail, page\)/i);
  assert.match(reanimeBranch, /return \{ data: detail, episodes, unavailable: false \}/);
});

test('the app exposes only the original resolve path, not unused external player-window IPCs', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(['"](?:provider|linkkf):play['"]/);
  assert.doesNotMatch(preloadSource, /(?:providerPlay|linkkfPlay)\s*:/);
  assert.match(mainSource, /ipcMain\.handle\(['"]provider:resolve['"]/);
  assert.match(mainSource, /ipcMain\.handle\(['"]linkkf:resolve['"]/);
  assert.match(preloadSource, /providerResolve\s*:/);
  assert.match(preloadSource, /linkkfResolve\s*:/);
});

test('detail source picker identifies the active raw provider item and hides for a single source', () => {
  const start = appSource.indexOf('function detailSourcePickerMarkup(');
  const end = appSource.indexOf('\nasync function openDetail', start);
  assert.ok(start >= 0 && end > start, 'Missing detail source picker');
  const context = vm.createContext({
    SOURCE_LABELS: { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkani: '링크애니' },
    LilacIntegratedSearch: { PROVIDERS },
    escapeHtml: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.renderPicker = detailSourcePickerMarkup;`, context);
  const markup = context.renderPicker({ sourceItems: [item('reanime', 'one'), item('miruro', 'two')] }, item('miruro', 'two'));
  assert.match(markup, /RE:Anime/);
  assert.match(markup, /Miruro/);
  assert.match(markup, /data-detail-source="miruro:two" aria-pressed="true"/);
  assert.equal(context.renderPicker({ sourceItems: [item('reanime', 'one')] }, item('reanime', 'one')), '');
  const pending = context.renderPicker({ sourceItems: [item('reanime', 'one')], sourceSearchPending: true }, item('reanime', 'one'));
  assert.match(pending, /같은 작품의 다른 공급원을 확인 중/);
  assert.equal((pending.match(/data-detail-source=/g) || []).length, 1);
  const failed = context.renderPicker({ sourceItems: [item('reanime', 'one')], sourceSearchStatuses: [{ provider: 'linkani', state: 'failed' }] }, item('reanime', 'one'));
  assert.match(failed, /확인 실패: 링크애니/);
});

test('a source catalog detail starts one bounded cross-provider lookup without changing the app default', () => {
  assert.match(appSource, /if\(!group\)\{\s*const catalogAnime=animeById\(id\);\s*if\(catalogAnime&&LilacIntegratedSearch\.PROVIDERS\.includes\(catalogAnime\.provider\)\)/);
  assert.match(appSource, /providers:LilacIntegratedSearch\.PROVIDERS\.filter\(provider=>provider!==baseItem\.provider\)/);
  assert.match(appSource, /if\(group\?\.sourceSearchPending\)discoverDetailSources\(group,a\)\.catch\(\(\)=>\{\}\)/);
  assert.match(appSource, /const savedProviderUnavailable=Boolean\(savedPreference&&!group\.sourceSearchPending/);
  assert.match(appSource, /state\.source/);
});

test('detail source discovery keeps the matching season and never changes the global source', async () => {
  const start = appSource.indexOf('function detailSourceLookupKey(');
  const end = appSource.indexOf('\nfunction detailPlaybackInfoMarkup', start);
  assert.ok(start >= 0 && end > start, 'Missing detail source discovery');
  const current = item('reanime', 'final', { mal_id: 'reanime:final', title: 'Attack on Titan The Final Season', title_japanese: '進撃の巨人 The Final Season', anilistId: 110277, year: 2020, type: 'TV' });
  const sourceItems = [], searched = [];
  let titleVariantCalls = 0;
  const context = vm.createContext({
    LilacIntegratedSearch: require('../src/integrated-search.js'),
    detailSourceDiscoveryCache: new Map(),
    state: { source: 'reanime' },
    window: { lilac: {
      titleVariants: async () => { titleVariantCalls++; return []; },
      providerCatalog: async provider => {
        searched.push(provider);
        if (provider === 'miruro') return { data: [
          item('miruro', 'wrong-part', { mal_id: 'miruro:wrong-part', title: 'Attack on Titan The Final Season Part 2', title_japanese: '進撃の巨人 The Final Season Part 2', anilistId: 104578, year: 2020, type: 'TV' }),
          item('miruro', 'final', { mal_id: 'miruro:final', title: '進撃の巨人 The Final Season', title_japanese: '進撃の巨人 The Final Season', anilistId: 110277, year: 2020, type: 'TV' })
        ] };
        return { data: [] };
      }
    } },
    titleOf: anime => anime.title,
    rememberAnime: anime => sourceItems.push(anime),
    openDetail: { currentGroupKey: 'detail-source:reanime:final' },
    refreshDetailSourcePicker: () => {},
    readWorkSourcePreference: () => null,
    SOURCE_LABELS: { reanime: 'RE:Anime', miruro: 'Miruro' },
    toast: () => {}
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.discover = discoverDetailSources;`, context);
  const group = { groupKey: 'detail-source:reanime:final', sourceSearchPending: true, sourceSearchBaseProvider: 'reanime', sourceSearchBaseId: 'final', sourceItems: [current], preferenceKeys: [] };
  await Promise.all([context.discover(group, current), context.discover(group, current)]);
  assert.equal(context.state.source, 'reanime');
  assert.deepEqual(group.sourceItems.map(source => source.mal_id).sort(), ['miruro:final', 'reanime:final']);
  assert.ok(searched.includes('miruro'));
  assert.equal(titleVariantCalls, 1, 'reopening the same detail while lookup is pending shares the in-flight work');
  assert.equal(searched.length, 8, 'the one lookup searches a bounded set of title variants across the other providers');
  assert.equal(group.sourceSearchResolved, true);
  assert.equal(group.sourceSearchPending, false);
});

test('detail source picker does not show catalog episode estimates as loaded episodes', () => {
  const start = appSource.indexOf('function detailSourcePickerMarkup(');
  const end = appSource.indexOf('\nfunction bindDetailSourcePicker', start);
  assert.ok(start >= 0 && end > start, 'Missing detail source picker');
  const context = vm.createContext({
    SOURCE_LABELS: { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkani: '링크애니' },
    LilacIntegratedSearch: { PROVIDERS },
    escapeHtml: value => String(value)
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.renderPicker = detailSourcePickerMarkup;`, context);
  const markup = context.renderPicker({ sourceItems: [
    { provider: 'reanime', mal_id: 'reanime:one', availableEpisodeCount: 24, episodes: 24 },
    { provider: 'miruro', mal_id: 'miruro:one', availableEpisodes: 12 }
  ] }, { mal_id: 'reanime:one' });
  assert.match(markup, /RE:Anime/);
  assert.match(markup, /Miruro/);
  assert.doesNotMatch(markup, /최대|24화|12화|weekday-source-picker|data-schedule-provider/);
});

test('search UI loads the grouping model before app code and routes source changes through real item IDs', () => {
  assert.match(htmlSource, /id="searchProviderFilters"[^>]*role="group"/);
  assert.ok(htmlSource.indexOf('src="integrated-search.js"') < htmlSource.indexOf('src="app.js"'));
  assert.match(appSource, /LilacIntegratedSearch\.searchProviders\(/);
  assert.match(appSource, /providers:contentSearchProviders\(state\.contentSourceMode,state\.source\)/);
  assert.match(appSource, /const first=await LilacIntegratedSearch\.searchProviders\(\{\.\.\.searchOptions,query\}\)/);
  assert.match(appSource, /const missingProviders=LilacIntegratedSearch\.providersNeedingTitleVariants\(first,searchOptions\.providers\)/);
  assert.match(appSource, /providers:missingProviders,query:'',terms,localSearch:async\(\)=>null/);
  assert.match(appSource, /displayTitle:titleOf\(item\)/);
  assert.match(appSource, /LilacIntegratedSearch\.chooseSource\(group,\{provider:sourceId\?'all':currentSearchFilter,preferredProvider:state\.source,sourceId:requestedSourceId,preferredSourceProvider:sourceId\?'':savedPreference\?\.provider\}\)/);
  assert.match(appSource, /function bindDetailSourcePicker\(group\)[\s\S]*?openDetail\(button\.dataset\.detailSource,\{groupKey:group\.groupKey,sourceId:button\.dataset\.detailSource,rememberSource:true\}\)/);
  assert.match(appSource, /function showHomeList\(list,label\)\{invalidateIntegratedSearch\(\);switchView\('search'\);hideIntegratedSearchFilters\(\);\$\('#filterBar'\)\.classList\.toggle\('hidden',state\.source!=='linkkf'\)/);
});

test('the integrated setting persists independently from the last individual provider', () => {
  const start = appSource.indexOf('function migrateContentSource(');
  const end = appSource.indexOf('\nconst savedContentSource=', start);
  assert.ok(start >= 0 && end > start, 'Missing content source mode helpers');
  const context = vm.createContext({ LilacIntegratedSearch: require('../src/integrated-search.js') });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.mode=contentSourceMode;this.provider=migrateContentSource;this.searchProviders=contentSearchProviders;`, context);

  assert.equal(context.mode('integrated'), 'integrated');
  assert.equal(context.provider('integrated', 'ohli24'), 'ohli24');
  assert.equal(context.provider('integrated', 'unknown'), 'reanime');
  assert.deepEqual(Array.from(context.searchProviders('integrated', 'ohli24')), PROVIDERS);
  assert.deepEqual(Array.from(context.searchProviders('provider', 'miruro')), ['miruro']);
  assert.deepEqual(Array.from(context.searchProviders('provider', 'linkkf')), []);
  assert.match(htmlSource, /button data-value="integrated">통합<\/button>/);
  assert.match(htmlSource, /<option value="integrated">통합<\/option>/);
  for (const provider of ['linkkf', 'ohli24', 'linkani', 'animenosub', 'reanime', 'miruro']) {
    assert.match(htmlSource, new RegExp(`data-value="${provider}"`), `${provider} remains in the original setting`);
    assert.match(htmlSource, new RegExp(`<option value="${provider}"`), `${provider} remains in the native select`);
  }
  assert.match(appSource, /source: migrateContentSource\(savedContentSource,localStorage\.getItem\('contentSourceProvider'\)\), contentSourceMode: contentSourceMode\(savedContentSource\)/);
  assert.match(appSource, /if\(selected==='integrated'\)\{if\(state\.contentSourceMode!=='integrated'\)localStorage\.setItem\('contentSourceProvider',state\.source\);state\.contentSourceMode='integrated'\}/);
  assert.match(appSource, /localStorage\.setItem\('contentSource',selected\)/);
});

test('a delayed provider detail cannot block integrated-mode reload or overwrite a newer detail', async () => {
  const openStart = appSource.indexOf('async function openDetail(');
  const guardText = 'if(openDetail.token!==token)return;';
  const guardEnd = appSource.indexOf(guardText, openStart);
  assert.ok(openStart >= 0 && guardEnd > openStart, 'openDetail must guard results after providerDetail resolves');
  const openDetailPrefix = appSource.slice(openStart, guardEnd + guardText.length);
  const settingSource = appSource.match(/\$\('#contentSource'\)\.onchange=e=>\{[\s\S]*?setTimeout\(\(\)=>location\.reload\(\),600\)\};/)?.[0];
  assert.ok(settingSource, 'the original content-source setting handler is present');

  const detailContent = { innerHTML: '', scrollTop: 0 };
  const detailDialog = { open: false, showModal() { this.open = true; } };
  const sourceControl = { onchange: null, value: 'ohli24' };
  const local = new Map([['contentSource', 'ohli24']]);
  const reloadTimers = [];
  const pendingDetails = new Map();
  const animeByKey = new Map();
  const groups = new Map();
  const rendered = [];
  const state = { source: 'ohli24', contentSourceMode: 'provider', library: [] };
  const context = vm.createContext({
    state,
    currentSearchFilter: 'all',
    searchGroupsByKey: groups,
    LilacIntegratedSearch: require('../src/integrated-search.js'),
    cancelPendingPlaybackLookups() {},
    animeById: id => animeByKey.get(String(id)),
    readWorkSourcePreference: () => null,
    saveWorkSourcePreference: () => true,
    rememberAnime() {},
    toast() {},
    detailContent,
    rendered,
    $: selector => selector === '#detailDialog' ? detailDialog
      : selector === '#detailContent' ? detailContent
        : selector === '#contentSource' ? sourceControl : null,
    localStorage: {
      getItem: key => local.has(key) ? local.get(key) : null,
      setItem: (key, value) => local.set(key, String(value))
    },
    syncSettingChoices() {},
    setTimeout: (callback, delay) => { reloadTimers.push({ callback, delay }); return reloadTimers.length; },
    location: { reloadCount: 0, reload() { this.reloadCount++; } },
    window: { lilac: {
      providerDetail: anime => new Promise(resolve => pendingDetails.set(anime.id, { anime, resolve }))
    } }
  });
  vm.runInContext(`${openDetailPrefix}\nrendered.push(a.title); detailContent.innerHTML=a.title;\n} catch(error) { throw error; }\n}`, context);
  vm.runInContext(settingSource, context);

  const addSource = (id, title, groupKey) => {
    const anime = { provider: 'ohli24', id, mal_id: `ohli24:${id}`, title, title_english: title, title_japanese: title, year: 2026, type: 'TV', url: `https://ani.ohli24.com/c/${id}` };
    animeByKey.set(anime.mal_id, anime);
    groups.set(groupKey, { groupKey, sourceItems: [anime], preferenceKeys: [], sourceSearchPending: false });
    return anime;
  };
  const slow = addSource('slow', 'Slow detail', 'slow-group');
  const fast = addSource('fast', 'Fast detail', 'fast-group');
  const modeSlow = addSource('mode-slow', 'Mode transition pending detail', 'mode-slow-group');

  const slowCall = context.openDetail(slow.mal_id, { groupKey: 'slow-group' });
  assert.equal(pendingDetails.has(slow.id), true, 'the mock provider detail remains unresolved');
  const fastCall = context.openDetail(fast.mal_id, { groupKey: 'fast-group' });
  pendingDetails.get(fast.id).resolve({ data: fast, episodes: [], unavailable: false });
  await fastCall;
  assert.deepEqual(Array.from(rendered), ['Fast detail']);
  pendingDetails.get(slow.id).resolve({ data: slow, episodes: [], unavailable: false });
  await slowCall;
  assert.deepEqual(Array.from(rendered), ['Fast detail'], 'a late provider response must not replace the newer detail');
  assert.equal(detailContent.innerHTML, 'Fast detail');

  const modeSlowCall = context.openDetail(modeSlow.mal_id, { groupKey: 'mode-slow-group' });
  assert.equal(pendingDetails.has(modeSlow.id), true, 'a second mock provider detail is still pending during mode change');
  sourceControl.onchange({ target: { value: 'integrated' } });
  assert.equal(state.contentSourceMode, 'integrated');
  assert.equal(local.get('contentSource'), 'integrated');
  assert.equal(local.get('contentSourceProvider'), 'ohli24');
  assert.equal(reloadTimers.at(-1).delay, 600);
  reloadTimers.at(-1).callback();
  assert.equal(context.location.reloadCount, 1, 'mode reload is scheduled before the provider request resolves');
  context.openDetail.token = Symbol('new document');
  detailContent.innerHTML = 'new document';
  pendingDetails.get(modeSlow.id).resolve({ data: modeSlow, episodes: [], unavailable: false });
  await modeSlowCall;
  assert.equal(detailContent.innerHTML, 'new document', 'the old document response must not replace the reloaded screen');
});

test('individual Linkkf search stays on the original Linkkf IPC and outside Patch 03 groups', () => {
  assert.match(appSource, /if\(state\.contentSourceMode!=='integrated'&&state\.source==='linkkf'\)\{[\s\S]*?window\.lilac\.linkkfSearch\(query\)/);
  assert.match(appSource, /LilacIntegratedSearch\.PROVIDERS\.slice\(\)/);
  assert.deepEqual(PROVIDERS, ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani']);
  assert.ok(!PROVIDERS.includes('linkkf'));
});

test('full catalog indexing starts on an active-source Korean search, not at app startup', async () => {
  const start = appSource.indexOf('const catalogIndexActivationPending=new Set()');
  const end = appSource.indexOf('\nasync function handleCalendarChange', start);
  assert.ok(start >= 0 && end > start, 'Missing lazy Korean catalog search helper');
  assert.doesNotMatch(appSource, /activateCatalog\(state\.source\)/, 'startup must not begin a full catalog download');
  const calls = [];
  const context = vm.createContext({
    state: { source: 'reanime' },
    window: { lilac: {
      activateCatalog: provider => { calls.push(`activate:${provider}`); return Promise.resolve({}); },
      catalogKoreanSearch: (provider, query) => { calls.push(`search:${provider}:${query}`); return [`${provider}:${query}`]; }
    } },
    renderCatalogIndex: () => {}
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.search = searchKoreanCatalog;`, context);
  assert.equal(context.search('reanime', 'Attack on Titan'), null);
  assert.equal(context.search('miruro', '진격의 거인'), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(Array.from(context.search('reanime', '진격의 거인')), ['reanime:진격의 거인']);
  assert.deepEqual(Array.from(context.search('reanime', '강철의 거인')), ['reanime:강철의 거인']);
  await Promise.resolve();
  assert.deepEqual(calls, [
    'activate:reanime',
    'search:reanime:진격의 거인',
    'search:reanime:강철의 거인'
  ]);
});
