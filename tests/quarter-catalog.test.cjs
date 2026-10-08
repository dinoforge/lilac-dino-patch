const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { QUARTER_PROVIDERS, quarterForDate, quarterPeriod, quarterQuery } = require('../electron/quarter-catalog.cjs');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function quarterCacheHarness(providerQuarter) {
  const storage = new Map();
  let now = 1_800_000_000_000;
  class FixedDate extends Date { static now() { return now; } }
  const localStorage = {
    get length() { return storage.size; },
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    key: index => [...storage.keys()][index] ?? null
  };
  const start = appSource.indexOf('const QUARTER_PROVIDERS='), end = appSource.indexOf('\nfunction allSort()', start);
  assert.ok(start >= 0 && end > start, 'Missing quarter cache helpers');
  const context = vm.createContext({ Date: FixedDate, localStorage, window: { lilac: { providerQuarter } } });
  vm.runInContext(appSource.slice(start, end), context);
  return { context, storage, advance: ms => { now += ms; } };
}

test('calendar months map to the four anime quarters', () => {
  const cases = [[0, 1, 'WINTER'], [3, 2, 'SPRING'], [6, 3, 'SUMMER'], [9, 4, 'FALL']];
  for (const [month, quarter, season] of cases) {
    assert.deepEqual(quarterForDate(new Date(2026, month, 1)), { year: 2026, quarter, season, label: `2026년 ${quarter}분기` });
  }
});

test('quarter selection rejects invalid ranges', () => {
  const now = new Date(2026, 9, 9);
  assert.throws(() => quarterPeriod(1959, 1, now), RangeError);
  assert.throws(() => quarterPeriod(2027, 1, now), RangeError);
  assert.throws(() => quarterPeriod(2026, 5, now), RangeError);
  assert.deepEqual(quarterPeriod('2024', '2', now), { year: 2024, quarter: 2, season: 'SPRING', label: '2024년 2분기' });
});

test('provider filters use explicit season and year fields only where supported', () => {
  const period = quarterPeriod(2025, 4, new Date(2026, 9, 9));
  assert.deepEqual(quarterQuery('reanime', period), { season: 'FALL', year: 2025 });
  assert.deepEqual(quarterQuery('miruro', period), { season: 'FALL', season_year: 2025 });
  assert.deepEqual(quarterQuery('animenosub', period), { season: 'fall-2025' });
  assert.deepEqual(QUARTER_PROVIDERS, ['reanime', 'miruro', 'animenosub']);
  assert.equal(quarterQuery('linkkf', period), null);
  assert.equal(quarterQuery('ohli24', period), null);
});

test('quarter selection is connected through the renderer, preload and IPC handler', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  assert.match(html, /id="quarterYear"/);
  assert.match(html, /id="quarterTabs"/);
  assert.match(html, /id="quarterTabs"[^>]*role="group"/);
  assert.match(app, /window\.lilac\.providerQuarter\(provider,year,quarter\)/);
  assert.match(app, /quarterCache:/);
  assert.match(app, /!quarterSource&&Boolean\(state\.current&&!homeSeason\?\.length\)/, 'Empty quarter lists must keep their selection and status controls visible');
  assert.match(app, /state\.quarterSelection=null;state\.quarterShows=\[\]/, 'Unsupported sources must clear the previous quarter selection');
  assert.match(app, /quarterRequest===initialQuarterRequest/, 'Late initial results must not overwrite a newly selected quarter');
  assert.match(app, /분기별 목록을 불러오지 못했습니다: \$\{e\.message\}.*quarterRetry/, 'Home-load failures must expose a quarter retry action');
  assert.match(preload, /providerQuarter: \(provider, year, quarter\) => ipcRenderer\.invoke\('provider:quarter'/);
  assert.match(main, /ipcMain\.handle\('provider:quarter'/);
});

test('quarter lists are reused from the 12-hour cache and stale data survives a failed refresh', async () => {
  let requests = 0;
  const item = { provider: 'reanime', id: 'show-1', mal_id: 'reanime:show-1', title: 'Sample Show', url: 'https://reanime.example/anime/show-1' };
  const harness = quarterCacheHarness(async () => { requests++; return { data: [item] }; });
  const first = await harness.context.fetchQuarterItems('reanime', 2026, 4);
  const cached = await harness.context.fetchQuarterItems('reanime', 2026, 4);
  assert.equal(first.fromCache, false);
  assert.equal(cached.fromCache, true);
  assert.equal(requests, 1);

  harness.advance(12 * 60 * 60 * 1000 + 1);
  harness.context.window.lilac.providerQuarter = async () => { requests++; throw new Error('offline'); };
  const stale = await harness.context.fetchQuarterItems('reanime', 2026, 4);
  assert.equal(stale.stale, true);
  assert.equal(stale.items[0].mal_id, 'reanime:show-1');
  assert.equal(requests, 2);
});
