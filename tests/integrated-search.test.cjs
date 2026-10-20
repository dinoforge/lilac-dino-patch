const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PROVIDERS, groupResults, filterGroups, chooseSource, searchProviders, mergeSearchResults } = require('../src/integrated-search.js');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');

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
  const end = appSource.indexOf('\nfunction setWeekdayAvailability', start);
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

test('weekday picker does not count unrelated search results as episode availability', () => {
  const start = appSource.indexOf('function detailSourcePickerMarkup(');
  const end = appSource.indexOf('\nasync function checkWeekdaySourceEpisodes', start);
  assert.ok(start >= 0 && end > start, 'Missing weekday availability helpers');
  const weekdays = require('../src/weekday-schedule.js');
  const context = vm.createContext({
    SOURCE_LABELS: { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkani: '링크애니' },
    LilacIntegratedSearch: { PROVIDERS },
    LilacWeekdaySchedule: weekdays,
    openDetail: { currentGroupKey: '', currentSourceId: '' },
    $: () => null,
    escapeHtml: value => String(value)
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.renderPicker = detailSourcePickerMarkup;`, context);
  const group = {
    weekdaySchedule: true, scheduleSearchReady: true, sourceItems: [], scheduleAvailability: {},
    scheduleSearchStatuses: [{ provider: 'reanime', state: 'ready', resultCount: 7 }]
  };
  const markup = context.renderPicker(group, { mal_id: 'reanime:anchor' });
  const reanimeRow = markup.match(/<div class="weekday-source-state" data-schedule-provider="reanime"[^>]*>(.*?)<\/div>/)?.[1] || '';
  assert.match(reanimeRow, /미제공/);
  assert.doesNotMatch(reanimeRow, /제공 확인/);
});

test('search UI loads the grouping model before app code and routes source changes through real item IDs', () => {
  assert.match(htmlSource, /id="searchProviderFilters"[^>]*role="group"/);
  assert.ok(htmlSource.indexOf('src="integrated-search.js"') < htmlSource.indexOf('src="app.js"'));
  assert.match(appSource, /LilacIntegratedSearch\.searchProviders\(/);
  assert.match(appSource, /const first=await LilacIntegratedSearch\.searchProviders\(\{\.\.\.searchOptions,query\}\)/);
  assert.match(appSource, /const extra=await LilacIntegratedSearch\.searchProviders\(\{\.\.\.searchOptions,query:'',terms:variants,localSearch:async\(\)=>null\}\)/);
  assert.match(appSource, /LilacIntegratedSearch\.chooseSource\(group,\{provider:sourceId\?'all':currentSearchFilter,preferredProvider:state\.source,sourceId:requestedSourceId,preferredSourceProvider:sourceId\?'':savedPreference\?\.provider\}\)/);
  assert.match(appSource, /function bindDetailSourcePicker\(group\)[\s\S]*?openDetail\(button\.dataset\.detailSource,\{groupKey:group\.groupKey,sourceId:button\.dataset\.detailSource,rememberSource:true\}\)/);
  assert.match(appSource, /function showHomeList\(list,label\)\{invalidateIntegratedSearch\(\);switchView\('search'\);hideIntegratedSearchFilters\(\);\$\('#filterBar'\)\.classList\.toggle\('hidden',state\.source!=='linkkf'\)/);
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
