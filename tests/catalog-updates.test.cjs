const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCatalogUpdates, decodeData } = require('../electron/catalog-updates.cjs');

test('Svelte data references resolve without evaluating site scripts', () => {
  const payload = [{ latestAired: 1 }, [2, 4], { anime_id: 3 }, 'one', { anime_id: 5 }, 'two'];
  assert.deepEqual(decodeData(payload).latestAired.map(item => item.anime_id), ['one', 'two']);
});

test('Re:Anime update results sort newest first, paginate, and reuse one snapshot', async () => {
  const rows = Array.from({ length: 37 }, (_, index) => ({
    id: `series-${index + 1}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  }));
  const encoded = [{ latestAired: 1 }, []];
  rows.forEach(row => {
    const rowIndex = encoded.length;
    encoded[1].push(rowIndex);
    encoded.push({ id: rowIndex + 1, updatedAt: rowIndex + 2 }, row.id, row.updatedAt);
  });
  let fetchCount = 0;
  const updates = createCatalogUpdates({
    reanimeBase: 'https://reanime.test',
    reanimeFetch: async url => { fetchCount++; assert.equal(url, 'https://reanime.test/__data.json'); return { nodes: [{ data: encoded }] }; },
    reanimeItems: items => items.map(item => ({ mal_id: item.id, updatedAt: item.updatedAt }))
  });

  const first = await updates.page('reanime', 0);
  const second = await updates.page('reanime', first.nextOffset);
  assert.equal(first.data.length, 36);
  assert.equal(first.data[0].mal_id, 'series-37');
  assert.equal(first.done, false);
  assert.equal(second.data.length, 1);
  assert.equal(second.data[0].mal_id, 'series-1');
  assert.equal(second.done, true);
  assert.equal(fetchCount, 1);
});

test('Miruro uses the latest aired episode per series and excludes not-yet-ready episodes', async () => {
  const now = Date.now();
  const air = hoursAgo => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
  const calls = [];
  const updates = createCatalogUpdates({
    miruroApi: async (endpoint, params) => {
      calls.push({ endpoint, params });
      if (endpoint === 'schedule') return { data: [
        { anime_id: 'a', air_at: air(4) }, { anime_id: 'a', air_at: air(2) },
        { anime_id: 'b', air_at: air(3) }, { anime_id: 'c', air_at: air(0.2) }
      ], has_more: false };
      return { data: params.id_in.split(',').map(id => ({ id, episode_counts: { raw: 4 } })) };
    },
    miruroItem: item => ({ mal_id: item.id, title: item.id })
  });

  const result = await updates.page('miruro', 0);
  assert.deepEqual(result.data.map(item => item.mal_id), ['a', 'b']);
  assert.equal(result.data[0].updatedAt, air(2));
  assert.match(result.note, /최근 2주/);
  assert.equal(calls.filter(call => call.endpoint === 'schedule').length, 1);
  assert.equal(calls.find(call => call.endpoint === 'anime').params.id_in, 'a,b');
});

test('Animenosub and 애니24 use their update feeds, while unsupported sources stay unavailable', async () => {
  const requests = [];
  const updates = createCatalogUpdates({
    animenosubBase: 'https://animenosub.test',
    animenosubFetch: async url => { requests.push(url); return '<article class="bs"><a href="/anime/series-1">series-1</a></article>'; },
    animenosubItems: html => html.includes('series-1') ? [{ mal_id: 'series-1' }] : [],
    ohliBase: 'https://ohli.test',
    ohliFetch: async url => { requests.push(url); return 'airing list'; },
    ohliItems: html => html === 'airing list' ? [{ mal_id: 'ohli-1' }] : []
  });

  const first = await updates.page('animenosub', 0);
  const cached = await updates.page('animenosub', 0);
  const ohli = await updates.page('ohli24', 0);
  assert.equal(first.data[0].mal_id, 'series-1');
  assert.equal(first.nextOffset, 2);
  assert.equal(first.done, false);
  assert.deepEqual(cached, first);
  assert.match(requests[0], /\/anime\/\?order=update&page=1$/);
  assert.equal(ohli.data[0].mal_id, 'ohli-1');
  assert.equal(ohli.done, true);
  assert.equal(requests[1], 'https://ohli.test/ing');
  assert.deepEqual(updates.supported, ['reanime', 'miruro', 'animenosub', 'ohli24']);
  await assert.rejects(updates.page('linkani', 0), /최근 업데이트순/);
  await assert.rejects(updates.page('linkkf', 0), /최근 업데이트순/);
});

test('recent update sort is wired only through the existing source catalog loader', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  assert.ok(app.includes("reanime:['popular','year','updated','score']"));
  assert.ok(app.includes("ohli24:['default','updated']"));
  assert.ok(app.includes("updated:'최근 업데이트순'"));
  assert.ok(app.includes("providerCatalog(state.source,'',sorted.offset,sorted.sort)"));
  assert.ok(main.includes("if(sort==='updated')return catalogUpdates.page(provider,offset);"));
  assert.ok(main.includes("updatedAt:a.episode?.aired||''"));
  assert.ok(main.includes("if (sort && !query) return sortedCatalog(provider, String(sort), offset);"));
  assert.ok(preload.includes("providerCatalog: (provider, query = '', offset = 0, sort = '')"));
});

test('the renderer update feed is connected through preload and IPC without adding LinkAni', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src/catalog-updates.js'), 'utf8');
  assert.ok(main.includes("ipcMain.handle('catalog:updates', (_, provider, offset) => catalogUpdates.page(String(provider || ''), offset))"));
  assert.ok(preload.includes("catalogUpdates: (provider, offset = 0) => ipcRenderer.invoke('catalog:updates', provider, offset)"));
  assert.match(ui, /const supported = \['reanime', 'miruro', 'animenosub', 'ohli24'\]/);
  assert.doesNotMatch(ui, /linkani/i);
});

test('Animenosub counts the newest uploaded episode across duplicate listing cards', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('function animenosubList('), end = source.indexOf('\nfunction animenosubDetail', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    cheerio: require('cheerio'),
    URL,
    ANIMENOSUB_WEB: 'https://animenosub.test',
    absoluteUrl: (value, base) => { try { return new URL(value, base).href; } catch { return ''; } }
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.parse = animenosubList;', context);
  const html = '<article><a href="/anime/series"><img alt="작품" src="/poster.jpg"><span class="epx">6화</span></a></article>'
    + '<article><a href="/anime/series"><img alt="작품" src="/poster.jpg"><span class="epx">12화</span></a></article>';
  assert.equal(context.parse(html)[0].availableEpisodes, 12);
});

test('Re:Anime keeps missing uploaded-episode counts unknown while preserving an explicit zero', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('function reanimeItems('), end = source.indexOf('\nfunction absoluteUrl', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ REANIME_WEB: 'https://reanime.test' });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.parse = reanimeItems;', context);

  const [unknown, zero, known] = context.parse([
    { anime_id: 'unknown', title: 'Unknown', episodes: 12 },
    { anime_id: 'zero', title: 'Zero', subbed: 0, dubbed: 0 },
    { anime_id: 'known', title: 'Known', subbed: 8, dubbed: 10 }
  ]);
  assert.equal(unknown.availableEpisodes, null);
  assert.equal(unknown.totalEpisodes, 12);
  assert.equal(zero.availableEpisodes, 0);
  assert.equal(known.availableEpisodes, 10);
});
