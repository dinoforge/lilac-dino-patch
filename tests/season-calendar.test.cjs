const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/season-calendar.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const browser = { LilacSeasonCalendarModel: null };
vm.runInNewContext(source, vm.createContext({ window: browser, document: { querySelector: () => null } }));
const model = browser.LilacSeasonCalendarModel;
const helperStart = appSource.indexOf('function episodeNumberOf(episode)');
const helperEnd = appSource.indexOf('\nfunction jobByRef', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'episode title helpers must be defined before episode rendering');
const episodeContext = vm.createContext({});
vm.runInContext(appSource.slice(helperStart, helperEnd), episodeContext);

test('season schedule matching prefers an exact provider ID and rejects conflicting year or format', () => {
  const candidate = { provider: 'reanime', id: 'show-1', mal_id: 'reanime:show-1', title: 'Series', year: '2026', type: 'TV' };
  assert.equal(model.resolve({ anime: { ...candidate } }, [candidate], 'reanime'), candidate);
  assert.equal(model.resolve({ anime: { ...candidate, year: '2025' } }, [candidate], 'reanime'), null);
  assert.equal(model.resolve({ anime: { ...candidate, type: 'Movie' } }, [candidate], 'reanime'), null);
});

test('cross-provider matching uses verified AniList or MAL IDs with season compatibility', () => {
  const candidate = { provider: 'reanime', id: 'a', mal_id: 'reanime:a', title: 'Series 2', anilistId: 400, year: 2026, season: 'FALL', type: 'TV' };
  const same = { provider: 'miruro', id: 'm', mal_id: 'miruro:m', title: '別題', anilistId: 400, year: 2026, season: 'FALL', type: 'TV' };
  const wrongSeason = { ...same, season: 'SPRING' };
  assert.equal(model.resolve({ anime: same }, [candidate], 'reanime'), candidate);
  assert.equal(model.resolve({ anime: wrongSeason }, [candidate], 'reanime'), null);
});

test('title fallback requires an exact alias and matching year, with ambiguous results left unlinked', () => {
  const first = { provider: 'reanime', id: 'a', mal_id: 'reanime:a', title: 'Series', title_japanese: 'シリーズ', year: 2026, type: 'TV' };
  const exact = { provider: 'reanime', id: 'b', mal_id: 'reanime:b', title_japanese: 'シリーズ', year: 2026, type: 'TV' };
  const noYear = { ...exact, year: '' };
  const similar = { ...exact, title_japanese: 'シリーズ 2' };
  assert.equal(model.resolve({ anime: exact }, [first], 'reanime'), first);
  assert.equal(model.resolve({ anime: noYear }, [first], 'reanime'), null);
  assert.equal(model.resolve({ anime: similar }, [first], 'reanime'), null);
  assert.equal(model.resolve({ anime: exact }, [first, { ...first, mal_id: 'reanime:duplicate' }], 'reanime'), null);
});

test('explicit sequel parts and movie/OVA formats never collapse into a series by title alone', () => {
  const series = { provider: 'reanime', id: 'show', mal_id: 'reanime:show', title: 'Example Season 2', year: 2026, type: 'TV' };
  const partOne = { provider: 'miruro', id: 'other', mal_id: 'miruro:other', title: 'Example Season 1', year: 2026, type: 'TV' };
  const movie = { provider: 'miruro', id: 'movie', mal_id: 'miruro:movie', title: 'Example Season 2', year: 2026, type: 'Movie' };
  assert.equal(model.resolve({ anime: partOne }, [series], 'reanime'), null);
  assert.equal(model.resolve({ anime: movie }, [series], 'reanime'), null);
});

test('episode titles fall back to the localized episode number instead of throwing while detail rows render', () => {
  assert.equal(episodeContext.episodeTitle({ number: 3, name: '3', title: 'Episode 3' }), '3화');
  assert.equal(episodeContext.episodeTitle({ number: 4, name: '4', title: '결전 전야' }), '결전 전야');
  assert.equal(episodeContext.episodeTitle({ name: '12화' }), '12화');
});

test('season calendar converts absolute airing instants to JST without adding nine hours twice', () => {
  const airingAt = Date.parse('2026-10-19T10:00:00.000Z') / 1000;
  const result = model.normalizeJapaneseAiring({ basis: 'japanese-broadcast', airingAt, timeZone: 'UTC' });
  assert.equal(result.weekday, '월');
  assert.equal(result.time, '19:00');
  assert.equal(result.timeZone, 'Asia/Tokyo');
});

test('verified local schedule times convert from their stated timezone into JST', () => {
  const utc = model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', localDateTime: '2026-10-19T10:00', timeZone: 'UTC'
  });
  const alreadyTokyo = model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', localDateTime: '2026-10-19T19:00', timeZone: 'Asia/Tokyo'
  });
  assert.deepEqual([utc.weekday, utc.time], ['월', '19:00']);
  assert.deepEqual([alreadyTokyo.weekday, alreadyTokyo.time], ['월', '19:00']);
});

test('Japanese 24-to-29 hour notation stays on its declared broadcast day', () => {
  const lateNight = model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', broadcastDay: 'Monday', broadcastTime: '25:30', timeZone: 'Asia/Tokyo'
  });
  const midnight = model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', broadcastDay: '월요일', broadcastTime: '24:00', timeZone: 'Asia/Tokyo'
  });
  const latestExtendedHour = model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', broadcastDay: 'Monday', broadcastTime: '29:59', timeZone: 'Asia/Tokyo'
  });
  assert.deepEqual([lateNight.weekday, lateNight.time, lateNight.actualWeekdayIndex, lateNight.actualTime],
    ['월', '25:30', 1, '01:30']);
  assert.deepEqual([midnight.weekday, midnight.time, midnight.actualWeekdayIndex, midnight.actualTime],
    ['월', '24:00', 1, '00:00']);
  assert.deepEqual([latestExtendedHour.weekday, latestExtendedHour.time, latestExtendedHour.actualWeekdayIndex, latestExtendedHour.actualTime],
    ['월', '29:59', 1, '05:59']);
  assert.equal(model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', broadcastDay: 'Monday', broadcastTime: '30:00', timeZone: 'Asia/Tokyo'
  }), null);
});

test('JST day assignment handles midnight and weekday changes from explicit UTC wall times', () => {
  const midnight = model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', localDateTime: '2026-10-18T15:30', timeZone: 'UTC'
  });
  const nextDay = model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', localDateTime: '2026-10-19T16:00', timeZone: 'UTC'
  });
  assert.deepEqual([midnight.date, midnight.weekday, midnight.time], ['2026-10-19', '월', '00:30']);
  assert.deepEqual([nextDay.date, nextDay.weekday, nextDay.time], ['2026-10-20', '화', '01:00']);
});

test('unverified or timezone-free schedule metadata is left unassigned', () => {
  assert.equal(model.normalizeJapaneseAiring({ airingAt: Date.parse('2026-10-19T10:00:00Z') / 1000 }), null);
  assert.equal(model.normalizeJapaneseAiring({
    basis: 'japanese-broadcast', localDateTime: '2026-10-19T10:00'
  }), null);
});

test('provider-site schedule matching prefers verified IDs and rejects conflicting external IDs', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    title_japanese: 'シリーズ A', anilistId: 410, year: 2026, season: 'FALL', type: 'TV' };
  const same = { provider: 'miruro', id: 'm-1', mal_id: 'miruro:m-1', title: '別題', anilistId: 410,
    year: 2026, season: 'FALL', type: 'TV' };
  const wrongId = { ...same, anilistId: 411, title: 'Series A', title_japanese: 'シリーズ A' };
  assert.equal(model.strictProviderScheduleMatch({ anime: same }, [catalog], 'miruro').anime, catalog);
  const rejected = model.strictProviderScheduleMatch({ anime: wrongId }, [catalog], 'miruro');
  assert.equal(rejected.anime, null);
  assert.equal(rejected.reason, 'identifier-conflict');
});

test('the calendar queries providerSchedule directly and labels the supplier-site basis', () => {
  assert.deepEqual(Array.from(model.SCHEDULE_PROVIDERS, provider => model.PROVIDER_NAMES[provider]),
    ['RE:Anime', 'Miruro', 'Animenosub', '애니24']);
  assert.match(source, /window\.lilac\.providerSchedule\(provider, providerDay\)/);
  assert.doesNotMatch(source, /window\.lilac\.japaneseSeasonSchedule\(/);
  assert.match(source, /공급 사이트 일정 기준/);
  assert.doesNotMatch(source, /일본 방영 기준 · JST/);
});

test('provider-site title matching requires exact aliases, same year, and compatible season and format', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    title_japanese: 'シリーズ A', year: 2026, season: 'FALL', type: 'TV' };
  const candidate = { provider: 'animenosub', id: 'a-1', mal_id: 'animenosub:a-1', title: 'シリーズ A',
    year: 2026, season: 'FALL', type: 'TV' };
  assert.equal(model.strictProviderScheduleMatch({ anime: candidate }, [catalog], 'animenosub').anime, catalog);
  assert.equal(model.strictProviderScheduleMatch({ anime: { ...candidate, year: '' } }, [catalog], 'animenosub').reason, 'year-unverified');
  assert.equal(model.strictProviderScheduleMatch({ anime: { ...candidate, season: 'SPRING' } }, [catalog], 'animenosub').reason,
    'season-year-format-mismatch');
  assert.equal(model.strictProviderScheduleMatch({ anime: { ...candidate, type: 'Movie' } }, [catalog], 'animenosub').reason,
    'season-year-format-mismatch');
});

test('provider-site evidence preserves source and distinguishes same-episode weekday conflict from multiple unverified days', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV' };
  const reanime = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV' };
  const miruro = { provider: 'miruro', id: 'm-1', mal_id: 'miruro:m-1', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV' };
  const conflict = model.reconcileProviderScheduleEvidence([
    { provider: 'reanime', day: 0, anime: reanime, episode: 5, time: '20:30', timed: true, timeBasis: '한국 시간' },
    { provider: 'miruro', day: 1, anime: miruro, episode: 5, time: '21:00', timed: true, timeBasis: '한국 시간' }
  ], [catalog]);
  assert.equal(conflict.conflictCount, 1);
  assert.equal(conflict.assignedCount, 0);
  assert.deepEqual(Array.from(conflict.conflicts[0].events, event => event.provider), ['reanime', 'miruro']);
  assert.equal(conflict.conflicts[0].events[0].timeBasis, '한국 시간');
  assert.equal(conflict.scheduleEvidence[0].catalogId, catalog.mal_id);
  assert.equal(conflict.scheduleEvidence[0].sourceTitle, 'Series A');

  const multipleEpisodes = model.reconcileProviderScheduleEvidence([
    { provider: 'reanime', day: 0, anime: reanime, episode: 5 },
    { provider: 'miruro', day: 1, anime: miruro, episode: 6 }
  ], [catalog]);
  assert.equal(multipleEpisodes.conflictCount, 0);
  assert.equal(multipleEpisodes.multiDayUnresolvedCount, 1);
  assert.equal(multipleEpisodes.unknown.length, 0);
});

test('provider-site repeated evidence is deduplicated and unmatched schedule rows remain outside catalog counts', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV' };
  const event = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV' };
  const result = model.reconcileProviderScheduleEvidence([
    { provider: 'reanime', day: 0, anime: event, episode: 5 },
    { provider: 'reanime', day: 0, anime: event, episode: 5 },
    { provider: 'miruro', day: 2, anime: { ...event, id: 'm-1', provider: 'miruro', title: 'Series A', anilistId: 999 }, episode: 5 }
  ], [catalog]);
  assert.equal(result.assignedCount, 1);
  assert.equal(result.duplicateRows, 1);
  assert.equal(result.unmatchedCount, 1);
  assert.equal(result.identifierConflictCount, 1);
  assert.equal(result.unknown.length, 0);
});
