const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { QUARTER_PROVIDERS, quarterForDate, quarterPeriod, quarterQuery } = require('../electron/quarter-catalog.cjs');
const { quarterForDate: rendererQuarterForDate, selectionRecord, resolveSelection, createCalendarWatcher } = require('../src/quarter-selection.js');
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

test('calendar rollover dates advance to the correct quarter and year', () => {
  const boundaries = [
    [new Date(2026, 2, 31), new Date(2026, 3, 1), 2026, 2],
    [new Date(2026, 5, 30), new Date(2026, 6, 1), 2026, 3],
    [new Date(2026, 8, 30), new Date(2026, 9, 1), 2026, 4],
    [new Date(2026, 11, 31), new Date(2027, 0, 1), 2027, 1]
  ];
  for (const [before, after, year, quarter] of boundaries) {
    const watcher = createCalendarWatcher(before), change = watcher.check(after);
    assert.equal(change.quarterChanged, true);
    assert.deepEqual(change.current, rendererQuarterForDate(after));
    assert.equal(change.current.year, year);
    assert.equal(change.current.quarter, quarter);
  }
  assert.deepEqual(rendererQuarterForDate(new Date(2027, 0, 1)), quarterForDate(new Date(2027, 0, 1)));
});

test('calendar checks do no work on the same date and do not report a quarter rollover on ordinary days', () => {
  const start = new Date(2026, 3, 1), watcher = createCalendarWatcher(start);
  assert.equal(watcher.check(start), null);
  const nextDay = watcher.check(new Date(2026, 3, 2));
  assert.equal(nextDay.dateChanged, true);
  assert.equal(nextDay.quarterChanged, false);
  assert.equal(watcher.check(new Date(2026, 3, 2)), null);
});

test('a prior quarter selection persists only within the calendar quarter when it was chosen', () => {
  const saved = selectionRecord(2025, 4, new Date(2026, 3, 2));
  const sameQuarter = resolveSelection(saved, new Date(2026, 5, 30));
  assert.deepEqual(sameQuarter.selection, { year: 2025, quarter: 4, label: '2025년 4분기' });
  assert.equal(sameQuarter.migrated, false);

  const nextQuarter = resolveSelection(saved, new Date(2026, 6, 1));
  assert.deepEqual(nextQuarter.selection, { year: 2026, quarter: 3, season: 'SUMMER', label: '2026년 3분기' });
  assert.equal(nextQuarter.migrated, true);
  const userPickedPastAgain = selectionRecord(2025, 4, new Date(2026, 6, 2));
  assert.deepEqual(resolveSelection(userPickedPastAgain, new Date(2026, 8, 30)).selection, { year: 2025, quarter: 4, label: '2025년 4분기' });
});

test('legacy quarter settings migrate without preserving an undated stale selection', () => {
  const stale = resolveSelection({ year: 2025, quarter: 3 }, new Date(2026, 3, 1));
  assert.deepEqual(stale.selection, { year: 2026, quarter: 2, season: 'SPRING', label: '2026년 2분기' });
  assert.deepEqual(stale.record, { version: 2, year: 2026, quarter: 2, calendarYear: 2026, calendarQuarter: 2 });
  assert.equal(stale.migrated, true);

  const same = resolveSelection({ year: 2026, quarter: 2 }, new Date(2026, 3, 1));
  assert.deepEqual(same.selection, { year: 2026, quarter: 2, label: '2026년 2분기' });
  assert.equal(same.migrated, true);
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

test('quarter selection uses the existing list while official schedule interfaces remain', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const catalogUpdates = fs.readFileSync(path.join(root, 'src/catalog-updates.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  assert.match(html, /id="quarterYear"/);
  assert.match(html, /id="quarterTabs"/);
  assert.match(html, /id="quarterTabs"[^>]*role="group"/);
  assert.match(html, /quarter-selection\.js/);
  assert.match(app, /window\.lilac\.providerQuarter\(provider,year,quarter\)/);
  assert.match(app, /quarterCache:/);
  assert.match(app, /LilacQuarterSelection\.resolveSelection\(saved\)/);
  assert.match(app, /LilacQuarterSelection\.selectionRecord\(year,quarter\)/);
  assert.match(app, /!quarterSource&&Boolean\(state\.current&&!homeSeason\?\.length\)/, 'Empty quarter lists must keep their selection and status controls visible');
  assert.match(app, /state\.quarterSelection=null;state\.quarterShows=\[\]/, 'Unsupported sources must clear the previous quarter selection');
  assert.match(app, /quarterRequest===initialQuarterRequest/, 'Late initial results must not overwrite a newly selected quarter');
  assert.match(app, /request!==quarterRequest\|\|provider!==state\.source/, 'Late quarter results must not overwrite a newer selection or source');
  assert.match(app, /calendarWatcher\.check\(new Date\(\)\)/);
  assert.match(app, /window\.addEventListener\('focus',checkCalendarOnResume\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange',checkCalendarOnResume\)/);
  assert.doesNotMatch(html, /seasonCalendarView|season-calendar\.css|season-calendar\.js/);
  assert.doesNotMatch(app, /LilacSeasonCalendar|openWeekdayScheduleAnime|weekdayAvailabilityCache/);
  assert.match(catalogUpdates, /showHomeList\(homeItems\(\), label\)/, 'season see-all uses the existing in-app list');
  assert.doesNotMatch(app, /\$\('#seeAllSeason'\)\.onclick/, 'the season see-all button has one handler owned by catalog-updates.js');
  assert.doesNotMatch(app, /loadLinkkfSchedule|linkkfSchedule|scheduleCacheKey/, 'the old duplicate Linkkf/AniList home schedule collector is removed');
  assert.doesNotMatch(preload, /providerWeekdayEpisodes|japaneseSeasonSchedule/);
  assert.doesNotMatch(main, /provider:weekday-episodes|provider:japanese-season-schedule/);
  assert.match(app, /분기별 목록을 불러오지 못했습니다: \$\{e\.message\}.*quarterRetry/, 'Home-load failures must expose a quarter retry action');
  assert.match(preload, /providerQuarter: \(provider, year, quarter\) => ipcRenderer\.invoke\('provider:quarter'/);
  assert.match(preload, /providerSchedule: \(provider, day\) => ipcRenderer\.invoke\('provider:schedule'/);
  assert.match(preload, /weeklySchedule: day => ipcRenderer\.invoke\('anime:weekly-schedule'/);
  assert.match(main, /ipcMain\.handle\('provider:quarter'/);
  assert.match(main, /createProviderSchedule\(/);
  assert.match(main, /ipcMain\.handle\('provider:schedule'/);
  assert.match(main, /ipcMain\.handle\('anime:weekly-schedule'/);
  assert.match(main, /ipcMain\.handle\('linkkf:schedule'/, 'the existing Linkkf handler remains available');
  assert.match(html, /id="scheduleSection" class="hidden" aria-hidden="true"><\/div>/, 'retain only the hidden host integration anchor');
  assert.equal(fs.existsSync(path.join(root, 'src/season-calendar.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'electron/weekday-episodes.cjs')), false);
  assert.equal(fs.existsSync(path.join(root, 'electron/season-jst-schedule.cjs')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/weekday-schedule.js')), true, 'shared Companion schedule helper stays intact');
  assert.match(html, /<section id="allView" class="view">[\s\S]*?id="catalogFilters"/);
  assert.doesNotMatch(html, /weekly-schedule\.js/);
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

test('loading a new quarter keeps the previous quarter catalog cache intact', async () => {
  const oldItem = { provider: 'reanime', id: 'old-q1', mal_id: 'reanime:old-q1', title: '이전 분기 작품' };
  const nextItem = { provider: 'reanime', id: 'new-q2', mal_id: 'reanime:new-q2', title: '새 분기 작품' };
  const harness = quarterCacheHarness(async () => ({ data: [nextItem] }));
  const oldKey = 'quarterCache:reanime:2026:1';
  harness.storage.set(oldKey, JSON.stringify({ savedAt: 1_800_000_000_000, items: [oldItem] }));
  const result = await harness.context.fetchQuarterItems('reanime', 2026, 2, { refresh: true });
  assert.equal(result.items[0].mal_id, 'reanime:new-q2');
  assert.equal(harness.storage.has(oldKey), true);
  assert.equal(JSON.parse(harness.storage.get(oldKey)).items[0].mal_id, 'reanime:old-q1');
});
