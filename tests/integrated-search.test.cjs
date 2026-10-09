const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { groupResults, filterGroups, chooseSource, searchProviders, mergeSearchResults } = require('../src/integrated-search.js');
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

test('ambiguous MAL bridges do not merge different AniList identities or an unlinked result', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100, malId: 900 }),
    item('miruro', 'b', { anilistId: 101, malId: 900 }),
    item('linkkf', 'c', { malId: 900 })
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group => group.sourceItems.length), [1, 1, 1]);
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
    SOURCE_LABELS: { reanime: 'RE:Anime', miruro: 'Miruro' },
    escapeHtml: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.renderPicker = detailSourcePickerMarkup;`, context);
  const markup = context.renderPicker({ sourceItems: [item('reanime', 'one'), item('miruro', 'two')] }, item('miruro', 'two'));
  assert.match(markup, /RE:Anime/);
  assert.match(markup, /Miruro/);
  assert.match(markup, /data-detail-source="miruro:two" aria-pressed="true"/);
  assert.equal(context.renderPicker({ sourceItems: [item('reanime', 'one')] }, item('reanime', 'one')), '');
});

test('search UI loads the grouping model before app code and routes source changes through real item IDs', () => {
  assert.match(htmlSource, /id="searchProviderFilters"[^>]*role="group"/);
  assert.ok(htmlSource.indexOf('src="integrated-search.js"') < htmlSource.indexOf('src="app.js"'));
  assert.match(appSource, /LilacIntegratedSearch\.searchProviders\(/);
  assert.match(appSource, /const first=await LilacIntegratedSearch\.searchProviders\(\{\.\.\.searchOptions,query\}\)/);
  assert.match(appSource, /const extra=await LilacIntegratedSearch\.searchProviders\(\{\.\.\.searchOptions,query:'',terms:variants,localSearch:async\(\)=>null\}\)/);
  assert.match(appSource, /LilacIntegratedSearch\.chooseSource\(group,\{provider:currentSearchFilter,preferredProvider:state\.source,sourceId\}\)/);
  assert.match(appSource, /openDetail\(button\.dataset\.detailSource,\{groupKey:group\?\.groupKey\|\|'',sourceId:button\.dataset\.detailSource\}\)/);
});
