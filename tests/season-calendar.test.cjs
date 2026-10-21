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

test('the season calendar combines native provider schedules with separate AniList/Jikan evidence', () => {
  assert.deepEqual(Array.from(model.SCHEDULE_PROVIDERS, provider => model.PROVIDER_NAMES[provider]),
    ['RE:Anime', 'Miruro', 'Animenosub', '애니24', '링크애니']);
  assert.equal(model.SCHEDULE_PROVIDERS.includes('linkkf'), false);
  assert.match(source, /function requestProviderSchedule\(provider, day, dateKey/);
  assert.match(source, /root\.LilacProviderScheduleClient =/);
  assert.match(source, /root\.lilac\.providerSchedule\(provider, day\)/);
  assert.match(source, /async function collectProviderScheduleEvidence\(dates, includeCurrentWeek\)/);
  assert.match(source, /root\.LilacSeasonCalendarModel\.collectProviderScheduleEvidence = collectProviderScheduleEvidence/);
  const loadStart = source.indexOf('async function load(items, selection, label)');
  const loadEnd = source.indexOf('\n  function open(items, label', loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  const loadSource = source.slice(loadStart, loadEnd);
  assert.match(loadSource, /root\.lilac\.japaneseSeasonSchedule\(apiCandidates, from, until, selectedYear, selectedSeason\)/);
  assert.match(loadSource, /model\.collectProviderScheduleEvidence\(dates, includeCurrentWeek\)/);
  assert.match(loadSource, /model\.reconcileScheduleVotes\(/);
  assert.match(loadSource, /scheduleBasis: 'provider-release-vote'/);
  assert.match(loadSource, /공급 사이트 공개 일정 기준 · AniList\/Jikan 별도 근거/);
  assert.match(source, /heading\.textContent = '일정 확인 불가 작품'/);
  assert.match(source, /const badge = '일정 확인 불가'/);
  assert.match(source, /badge: '일정 충돌'/);
  assert.match(source, /trackLabels\[event\.track\]/);
  assert.match(source, /AniList·Jikan 및 공식 방송 정보는 보조 근거로만 보존합니다/);
});

test('verified AniList airing events assign a Japanese weekday while a failed Jikan request stays partial', () => {
  const anime = { provider: 'reanime', id: 'one', mal_id: 'reanime:one', title: 'Series One',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV' };
  const candidates = model.japaneseScheduleCandidates([anime], 2026, 4);
  const result = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [{ anilistId: 410, episode: 3,
      airingAt: Date.parse('2026-10-19T10:00:00Z') / 1000, countryOfOrigin: 'JP', format: 'TV', season: 'FALL', seasonYear: 2026 }] },
    Jikan: { state: 'failed', errorCode: 'connect-timeout', items: [] }
  } }, candidates, 2026, 4);
  assert.equal(result.state, 'partial');
  assert.equal(result.assigned[0].length, 1);
  assert.equal(result.assigned[0][0].anime, anime);
  assert.equal(result.assigned[0][0].item.events[0].episode, 3);
  assert.equal(result.unknown.length, 0);
  assert.equal(result.conflictCount, 0);
});

test('Jikan exact-title seasonal metadata is retained as supplemental evidence without an episode number', () => {
  const anime = { provider: 'reanime', id: 'idless', mal_id: 'reanime:idless', title: '정확한 제목',
    title_japanese: '正確な題名', year: 2026, season: 'FALL', type: 'TV' };
  const candidates = model.japaneseScheduleCandidates([anime], 2026, 4);
  assert.equal(candidates[0].anilistId, null);
  assert.equal(candidates[0].malId, null);
  const result = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'not-requested', items: [] },
    Jikan: { state: 'complete', items: [{ source: 'Jikan', catalogId: 'reanime:idless', malId: null,
      identityMatch: 'exact-title-season', broadcastDay: 'Monday', broadcastTime: '25:30',
      timeZone: 'Asia/Tokyo', verifiedJapaneseBroadcast: true, countryOfOrigin: 'JP', format: 'TV',
      season: 'FALL', seasonYear: 2026 }] }
  } }, candidates, 2026, 4);
  assert.equal(result.state, 'complete');
  assert.equal(result.assignedCardCount, 0);
  assert.equal(result.scheduleEvidence[0].source, 'Jikan');
  assert.equal(result.scheduleEvidence[0].episode, null);
  assert.deepEqual(Array.from(result.unknown, item => item.mal_id), ['reanime:idless']);
  const voted = model.reconcileScheduleVotes(result, [], candidates, 2026, 4);
  assert.equal(voted.voteResults.length, 0);
  assert.equal(voted.supplementalEvidence[0].reason, 'episode-number-unavailable');
});

test('AniList and Jikan stay one related source group and Jikan weekly slots without episode IDs do not vote', () => {
  const anime = { provider: 'reanime', id: 'late', mal_id: 'reanime:late', title: 'Late Night',
    anilistId: 411, year: 2026, season: 'FALL', type: 'TV' };
  const candidates = model.japaneseScheduleCandidates([anime], 2026, 4);
  const result = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [{ anilistId: 411, episode: 4,
      airingAt: Date.parse('2026-10-19T16:30:00Z') / 1000, countryOfOrigin: 'JP', format: 'TV', season: 'FALL', seasonYear: 2026 }] },
    Jikan: { state: 'complete', items: [{ source: 'Jikan', catalogId: 'reanime:late', malId: null,
      identityMatch: 'exact-title-season', broadcastDay: 'Monday', broadcastTime: '25:30',
      timeZone: 'Asia/Tokyo', verifiedJapaneseBroadcast: true, countryOfOrigin: 'JP', format: 'TV',
      season: 'FALL', seasonYear: 2026 }] }
  } }, candidates, 2026, 4);
  const voted = model.reconcileScheduleVotes(result, [], candidates, 2026, 4);
  assert.equal(voted.assigned[0].length, 0);
  assert.equal(voted.assigned[1].length, 1);
  assert.deepEqual(Array.from(voted.assigned[1][0].item.events, event => event.source), ['AniList']);
  assert.equal(voted.voteResults[0].dayVotes['화'], 1);
  assert.equal(voted.voteResults[0].sourceVotes[0].voteGroup, 'schedule-index');
  assert.equal(voted.supplementalEvidence.some(event => event.source === 'Jikan' && event.reason === 'episode-number-unavailable'), true);
  assert.equal(voted.sourceRelationships.at(-1).relationship, 'upstream-independence-unverified');
  assert.equal(result.conflictCount, 0);
});

test('Jikan broadcast-day metadata without exact episode identity does not conflict with AniList airing evidence', () => {
  const anime = { provider: 'reanime', id: 'conflict', mal_id: 'reanime:conflict', title: 'Conflict Show',
    anilistId: 412, year: 2026, season: 'FALL', type: 'TV' };
  const candidates = model.japaneseScheduleCandidates([anime], 2026, 4);
  const result = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [{ anilistId: 412, episode: 5,
      airingAt: Date.parse('2026-10-20T11:00:00Z') / 1000, countryOfOrigin: 'JP', format: 'TV', season: 'FALL', seasonYear: 2026 }] },
    Jikan: { state: 'complete', items: [{ source: 'Jikan', catalogId: 'reanime:conflict', malId: null,
      identityMatch: 'exact-title-season', broadcastDay: 'Monday', broadcastTime: '20:00',
      timeZone: 'Asia/Tokyo', verifiedJapaneseBroadcast: true, countryOfOrigin: 'JP', format: 'TV',
      season: 'FALL', seasonYear: 2026 }] }
  } }, candidates, 2026, 4);
  const voted = model.reconcileScheduleVotes(result, [], candidates, 2026, 4);
  assert.equal(voted.assigned[1].length, 1);
  assert.equal(voted.conflictCount, 0);
  assert.equal(voted.voteResults[0].dayVotes['화'], 1);
  assert.equal(voted.supplementalEvidence.some(event => event.source === 'Jikan'), true);
  assert.equal(result.unknown.length, 0);
});

test('an unsuccessful schedule response leaves series unassigned and unknown without fabricating weekdays', () => {
  const anime = { provider: 'reanime', id: 'unknown', mal_id: 'reanime:unknown', title: 'Unknown Show',
    year: 2026, season: 'FALL', type: 'TV' };
  const candidates = model.japaneseScheduleCandidates([anime], 2026, 4);
  const result = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'not-requested', items: [] },
    Jikan: { state: 'failed', errorCode: 'connect-timeout', items: [] }
  } }, candidates, 2026, 4);
  assert.equal(result.state, 'failed');
  assert.equal(result.assignedCardCount, 0);
  assert.deepEqual(Array.from(result.unknown, item => item.mal_id), ['reanime:unknown']);
});

test('home weekly and quarter calendar callers share each provider-day request and its cached response', async () => {
  let requests = 0;
  browser.lilac = { providerSchedule: async (provider, day) => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { provider, day, native: true, items: [] };
  } };
  const client = browser.LilacProviderScheduleClient;
  const [home, quarter] = await Promise.all([
    client.get('reanime', 1, '2026-10-19'),
    client.get('reanime', 1, '2026-10-19')
  ]);
  assert.equal(requests, 1);
  assert.equal(home, quarter);
  assert.deepEqual(await client.get('reanime', 1, '2026-10-19'), home);
  assert.equal(requests, 1);
  await client.get('reanime', 2, '2026-10-20');
  assert.equal(requests, 2, 'another day remains a separate providerSchedule request');
  await client.get('reanime', 1, '2026-10-19', { refresh: true });
  assert.equal(requests, 3, 'an explicit refresh bypasses the renderer cache while retaining the official IPC path');
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

test('provider-site evidence requires active numbered series releases and preserves same-episode weekday conflicts', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const reanime = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const miruro = { provider: 'miruro', id: 'm-1', mal_id: 'miruro:m-1', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
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

  const differentEpisodes = model.reconcileProviderScheduleEvidence([
    { provider: 'reanime', day: 0, anime: reanime, episode: 5 },
    { provider: 'miruro', day: 1, anime: miruro, episode: 6 }
  ], [catalog]);
  assert.equal(differentEpisodes.conflictCount, 1);
  assert.equal(differentEpisodes.conflicts[0].kind, 'providers-disagree-on-episode');
  assert.equal(differentEpisodes.assignedCount, 0);
  assert.equal(differentEpisodes.assignedCardCount, 0);
  assert.equal(differentEpisodes.unknown.length, 0);
});

test('weekly-release eligibility excludes films, specials, unknown formats, inactive shows, and unnumbered rows', () => {
  const baseAnime = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const event = { provider: 'reanime', day: 0, anime: baseAnime, episode: 1, airingStatus: 'Airing', currentWeek: true };
  assert.equal(model.weeklyReleaseEligibility(event, baseAnime).eligible, true);
  assert.equal(model.weeklyReleaseEligibility({ ...event, anime: { ...baseAnime, type: 'Movie' } }, baseAnime).reason, 'format-movie');
  assert.equal(model.weeklyReleaseEligibility({ ...event, anime: { ...baseAnime, type: 'OVA' } }, baseAnime).reason, 'format-ova');
  assert.equal(model.weeklyReleaseEligibility({ ...event, anime: { ...baseAnime, type: 'TV Special' } }, baseAnime).reason, 'format-special');
  assert.equal(model.weeklyReleaseEligibility({ ...event, anime: { ...baseAnime, type: 'Anime' } }, { ...baseAnime, type: 'Anime' }).reason, 'format-unverified');
  assert.equal(model.weeklyReleaseEligibility({ ...event, anime: { ...baseAnime, status: 'Finished Airing' } }, baseAnime).reason, 'not-currently-releasing');
  assert.equal(model.weeklyReleaseEligibility({ ...event, episode: undefined }, baseAnime).reason, 'new-episode-unverified');
  assert.equal(model.weeklyReleaseEligibility({ ...event, episode: 2.5 }, baseAnime).reason, 'new-episode-unverified');
  assert.equal(model.weeklyReleaseEligibility({ ...event, cancelled: true }, baseAnime).reason, 'cancelled');

  const ona = { ...baseAnime, type: 'ONA' };
  assert.equal(model.weeklyReleaseEligibility({ ...event, anime: ona }, ona).eligible, true);
  assert.equal(model.weeklyReleaseEligibility({ ...event, anime: { ...ona, status: '' }, airingStatus: '' }, { ...ona, status: '' }).reason,
    'release-status-unverified');
});

test('a provider batch of multiple episodes is withheld, while eligible evidence from another week feed is still usable', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const batched = model.reconcileProviderScheduleEvidence([
    { provider: 'reanime', day: 0, anime: catalog, episode: 5 },
    { provider: 'reanime', day: 0, anime: catalog, episode: 6 },
    { provider: 'miruro', day: 2, anime: { ...catalog, provider: 'miruro', id: 'mirror-a', mal_id: 'miruro:mirror-a' }, episode: 6 }
  ], [catalog]);
  assert.equal(batched.excludedBatchRows.length, 2);
  assert.equal(batched.assignedCount, 1);
  assert.equal(batched.assignedCardCount, 1);
  assert.equal(batched.assigned[2][0].item.events[0].episode, 6);
});

test('catalog keeps unverified series outside the seven weekdays and excludes non-series without adding calendar cards', () => {
  const series = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A', type: 'TV', status: 'RELEASING' };
  const movie = { provider: 'reanime', id: 'movie-a', mal_id: 'reanime:movie-a', title: 'Movie A', type: 'Movie', status: 'RELEASING' };
  const finished = { provider: 'reanime', id: 'series-b', mal_id: 'reanime:series-b', title: 'Finished', type: 'TV', status: 'Finished Airing' };
  const result = model.reconcileProviderScheduleEvidence([], [series, movie, finished]);
  assert.deepEqual(Array.from(result.unknown, item => item.mal_id), [series.mal_id]);
  assert.deepEqual(Array.from(result.excludedCatalog, item => item.reason).sort(), ['format-movie', 'not-currently-releasing']);
  assert.equal(result.assignedCardCount, 0);
});

test('subtitle and dub entries for the same work, episode, and weekday render as one card with both sources', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const result = model.reconcileProviderScheduleEvidence([
    { provider: 'reanime', day: 0, anime: catalog, episode: 5, time: '21:00', track: 'sub' },
    { provider: 'reanime', day: 0, anime: catalog, episode: 5, time: '21:00', track: 'dub' }
  ], [catalog]);
  assert.equal(result.assigned[0].length, 1);
  assert.equal(result.assignedCardCount, 1);
  assert.deepEqual(Array.from(result.assigned[0][0].item.events, event => event.track), ['sub', 'dub']);
  assert.equal(result.duplicateRows, 0, 'different language tracks are preserved as events, not discarded duplicate rows');
});

test('same work and day from multiple providers remains one card with all episode evidence', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const miruro = { provider: 'miruro', id: 'mirror-a', mal_id: 'miruro:mirror-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const result = model.reconcileProviderScheduleEvidence([
    { provider: 'reanime', day: 0, anime: catalog, episode: 5, time: '19:00' },
    { provider: 'miruro', day: 0, anime: miruro, episode: 5, time: '22:00' }
  ], [catalog]);
  assert.equal(result.assigned[0].length, 1);
  assert.equal(result.assignedCardCount, 1);
  assert.deepEqual(Array.from(result.assigned[0][0].item.events, event => event.episode), [5, 5]);
  assert.deepEqual(Array.from(result.assigned[0][0].item.events, event => event.provider), ['reanime', 'miruro']);
});

test('provider-site repeated evidence is deduplicated and unmatched schedule rows remain outside catalog counts', () => {
  const catalog = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const event = { provider: 'reanime', id: 'series-a', mal_id: 'reanime:series-a', title: 'Series A',
    anilistId: 410, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
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

test('weekday votes count each schedule source once after work, season, and episode matching', () => {
  const catalog = { provider: 'reanime', id: 'vote-show', mal_id: 'reanime:vote-show', title: 'Vote Show',
    title_japanese: '投票作品', anilistId: 420, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const candidates = model.japaneseScheduleCandidates([catalog], 2026, 4);
  const base = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [{ anilistId: 420, episode: 8,
      airingAt: Date.parse('2026-10-20T10:00:00Z') / 1000, countryOfOrigin: 'JP', format: 'TV', season: 'FALL', seasonYear: 2026 }] },
    Jikan: { state: 'complete', items: [] }
  } }, candidates, 2026, 4);
  const reanime = { ...catalog }, miruro = { ...catalog, provider: 'miruro', id: 'miruro-vote-show', mal_id: 'miruro:vote-show' };
  const result = model.reconcileScheduleVotes(base, [
    { provider: 'reanime', day: 0, anime: reanime, episode: 8, track: 'sub', airingStatus: 'Airing' },
    { provider: 'reanime', day: 0, anime: reanime, episode: 8, track: 'dub', airingStatus: 'Airing' },
    { provider: 'miruro', day: 0, anime: miruro, episode: 8, track: 'sub', airingStatus: 'Airing' }
  ], candidates, 2026, 4);

  assert.equal(result.assigned[0].length, 1);
  assert.equal(result.assigned[1].length, 0);
  assert.equal(JSON.stringify(result.voteResults[0].dayVotes), JSON.stringify({ '월': 2, '화': 1 }));
  assert.equal(result.voteResults[0].winnerDay, 0);
  assert.equal(result.voteResults[0].sourceVotes.length, 3);
  assert.equal(result.duplicateTrackRows, 1, 'sub/dub rows from one provider remain one weekday vote');
  assert.equal(result.sourceVoteSummary['provider:reanime'].votes, 1);
  assert.equal(result.sourceVoteSummary['provider:miruro'].votes, 1);
  assert.equal(result.sourceVoteSummary['schedule-index'].votes, 1);
});

test('a tie between exact episode weekday votes is held as a conflict, not assigned', () => {
  const catalog = { provider: 'reanime', id: 'tie-show', mal_id: 'reanime:tie-show', title: 'Tie Show',
    anilistId: 421, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const candidates = model.japaneseScheduleCandidates([catalog], 2026, 4);
  const base = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [{ anilistId: 421, episode: 2,
      airingAt: Date.parse('2026-10-20T10:00:00Z') / 1000, countryOfOrigin: 'JP', format: 'TV', season: 'FALL', seasonYear: 2026 }] },
    Jikan: { state: 'not-requested', items: [] }
  } }, candidates, 2026, 4);
  const provider = { provider: 'reanime', id: 'tie-show', mal_id: 'reanime:tie-show', title: 'Tie Show',
    anilistId: 421, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const result = model.reconcileScheduleVotes(base, [
    { provider: 'reanime', day: 0, anime: provider, episode: 2, airingStatus: 'Airing' }
  ], candidates, 2026, 4);

  assert.equal(result.assignedCardCount, 0);
  assert.equal(result.voteConflicts.length, 1);
  assert.equal(result.conflicts[0].kind, 'schedule-vote-tie');
  assert.equal(JSON.stringify(result.voteResults[0].dayVotes), JSON.stringify({ '월': 1, '화': 1 }));
  assert.equal(result.unknownCount, 0, 'a known tie is not mislabeled as no schedule evidence');
});

test('AniList and Jikan disagreements share one evidence group and cannot leave a stale assignment', () => {
  const catalog = { provider: 'reanime', id: 'related-show', mal_id: 'reanime:related-show', title: 'Related Show',
    anilistId: 422, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const candidates = model.japaneseScheduleCandidates([catalog], 2026, 4);
  const base = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [{ anilistId: 422, episode: 7,
      airingAt: Date.parse('2026-10-20T10:00:00Z') / 1000, countryOfOrigin: 'JP', format: 'TV', season: 'FALL', seasonYear: 2026 }] },
    Jikan: { state: 'complete', items: [{ source: 'Jikan', catalogId: 'reanime:related-show', malId: null,
      identityMatch: 'exact-title-season', episode: 7, broadcastDay: 'Monday', broadcastTime: '25:30',
      timeZone: 'Asia/Tokyo', verifiedJapaneseBroadcast: true, countryOfOrigin: 'JP', format: 'TV',
      season: 'FALL', seasonYear: 2026 }] }
  } }, candidates, 2026, 4);
  const result = model.reconcileScheduleVotes(base, [], candidates, 2026, 4);

  assert.equal(result.assignedCardCount, 0);
  assert.equal(result.conflicts[0].kind, 'source-schedule-conflict');
  assert.equal(result.sourceScheduleConflicts.length, 1);
  assert.equal(result.voteConflicts.length, 0, 'one shared source group disagreement is not mislabeled as a vote tie');
  assert.deepEqual(Array.from(result.sourceScheduleConflicts[0].conflicts[0].providers), ['AniList', 'Jikan']);
});

test('provider rows without episode numbers and unmatched or different-season rows never cast votes', () => {
  const catalog = { provider: 'reanime', id: 'strict-show', mal_id: 'reanime:strict-show', title: 'Strict Show',
    anilistId: 423, year: 2026, season: 'FALL', type: 'TV', status: 'RELEASING' };
  const candidates = model.japaneseScheduleCandidates([catalog], 2026, 4);
  const response = { sources: { AniList: { state: 'not-requested', items: [] }, Jikan: { state: 'not-requested', items: [] } } };
  const base = model.reconcileJapaneseBroadcastSchedule(response, candidates, 2026, 4);
  const same = { ...catalog };
  const wrongSeason = { ...catalog, provider: 'miruro', id: 'm-spring', mal_id: 'miruro:spring', season: 'SPRING' };
  const result = model.reconcileScheduleVotes(base, [
    { provider: 'reanime', day: 2, anime: same, sourceNote: 'weekday list without episode' },
    { provider: 'miruro', day: 1, anime: wrongSeason, episode: 4, airingStatus: 'Airing' },
    { provider: 'animenosub', day: 4, anime: { ...wrongSeason, provider: 'animenosub', id: 'unmatched', mal_id: 'animenosub:unmatched', anilistId: 999 }, episode: 4, airingStatus: 'Airing' }
  ], candidates, 2026, 4);

  assert.equal(result.voteResults.length, 0);
  assert.equal(result.providerEvidenceCounts.reanime.supplementalRows, 1);
  assert.equal(result.providerEvidenceCounts.miruro.unmatchedRows, 1);
  assert.equal(result.providerEvidenceCounts.animenosub.unmatchedRows, 1);
  assert.equal(result.unknownCount, 1);
});

test('official Japanese TV schedules resolve only exact 2026 Fall catalog identities and preserve the four non-TV or unverified items', () => {
  const unresolved = [
    { catalogId: 'reanime:steel-ball-run-jojo-s-bizarre-adventure-2nd-3rd-stage-r98jbs', title_japanese: 'ジョジョの奇妙な冒険 スティール・ボール・ラン 2nd＆3rd STAGE', anilistId: 210482, type: 'ONA' },
    { catalogId: 'reanime:umayuru-full-gate-bupz4n', title_japanese: 'うまゆるふるげ〜と!', anilistId: 215835, type: 'ONA' },
    { catalogId: 'reanime:my-girlfriend-s-friend-mini-anime-5sw2fa', title_japanese: '彼女の友達 ミニアニメ', anilistId: 217782, type: 'TV_SHORT' },
    { catalogId: 'reanime:delivery-kitten-unyan-k9mfbr', title_japanese: '子猫の配達員うーにゃん', anilistId: 207217, type: 'ONA' }
  ];
  const catalog = [...model.OFFICIAL_JAPANESE_BROADCASTS.map(record => ({
    provider: 'reanime', id: record.catalogId, mal_id: record.catalogId, catalogId: record.catalogId,
    title: record.titleJapanese, title_japanese: record.titleJapanese, title_english: record.titleJapanese,
    anilistId: record.anilistId, year: 2026, season: 'FALL', type: record.catalogId.includes('reincarnated-as-a-sword')
      || record.catalogId.includes('overgeared') || record.catalogId.includes('a-wild-last-boss')
      || record.catalogId.includes('magical-explorer') || record.catalogId.includes('a-tale-of-the-secret-saint')
      || record.catalogId.includes('romelia-war') ? 'ONA' : record.catalogId.includes('i-m-dating')
        || record.catalogId.includes('my-girlfriend') || record.catalogId.includes('mouse-cursor') ? 'TV_SHORT' : 'TV',
    status: 'Releasing'
  })), ...unresolved.map(item => ({
    provider: 'reanime', id: item.catalogId, mal_id: item.catalogId, title: item.title_japanese,
    title_japanese: item.title_japanese, anilistId: item.anilistId, year: 2026, season: 'FALL', type: item.type, status: 'Releasing'
  }))];
  const candidates = model.japaneseScheduleCandidates(catalog, 2026, 4);
  const base = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [] }, Jikan: { state: 'failed', errorCode: 'request-timeout', items: [] }
  } }, candidates, 2026, 4);
  const result = model.applyOfficialJapaneseBroadcasts(base, candidates, 2026, 4);

  assert.equal(model.OFFICIAL_JAPANESE_BROADCASTS.length, 13);
  assert.equal(result.officialScheduleEvidence.length, 13);
  assert.equal(result.assignedCount, 13);
  assert.equal(result.assignedCardCount, 13);
  assert.equal(result.unknownCount, 4);
  assert.equal(result.weeklyReleaseCount + result.unverifiedWeeklyCount + result.excludedCatalogCount, catalog.length);
  assert.deepEqual(Array.from(result.assigned, day => day.length), [4, 0, 1, 0, 1, 3, 4]);
  assert.equal(result.state, 'partial', 'an official schedule does not hide the failed Jikan source');
  const lateNight = result.assigned[2].find(row => row.anime.anilistId === 159042).item.events[0];
  assert.deepEqual([lateNight.day, lateNight.time, lateNight.timeBasis, lateNight.station], [2, '24:00', 'JST', 'TOKYO MX']);
  assert.ok(result.officialScheduleEvidence.every(item => item.sourceUrl.startsWith('https://') && item.evidence && item.checkedAt));
  assert.ok(unresolved.every(item => result.unknown.some(anime => anime.mal_id === item.catalogId)));
});

test('official schedule matches without AniList IDs require the exact catalog ID, Japanese title, year, and season', () => {
  const schedule = model.OFFICIAL_JAPANESE_BROADCASTS.find(item => item.catalogId === 'reanime:psyren-9qpamm');
  const wrong = { provider: 'reanime', id: schedule.catalogId, mal_id: schedule.catalogId,
    title: 'PSYREN Season 2', title_japanese: 'PSYREN 第2期', year: 2026, season: 'FALL', type: 'TV', status: 'Releasing' };
  const candidates = model.japaneseScheduleCandidates([wrong], 2026, 4);
  const base = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [] }, Jikan: { state: 'failed', errorCode: 'request-timeout', items: [] }
  } }, candidates, 2026, 4);
  const result = model.applyOfficialJapaneseBroadcasts(base, candidates, 2026, 4);
  assert.equal(result.assignedCount, 0);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.rejectedOfficialSchedules.find(item => item.catalogId === schedule.catalogId).reason, 'exact-japanese-title-mismatch');
});

test('official Japanese broadcast records remain supplemental when a source schedule already assigns the episode', () => {
  const schedule = model.OFFICIAL_JAPANESE_BROADCASTS.find(item => item.anilistId === 159042);
  const anime = { provider: 'reanime', id: schedule.catalogId, mal_id: schedule.catalogId, title: schedule.titleJapanese,
    title_japanese: schedule.titleJapanese, anilistId: schedule.anilistId, year: 2026, season: 'FALL', type: 'ONA', status: 'Releasing' };
  const candidates = model.japaneseScheduleCandidates([anime], 2026, 4);
  const base = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [{ anilistId: schedule.anilistId, episode: 3,
      airingAt: Date.parse('2026-10-07T15:00:00Z') / 1000, countryOfOrigin: 'JP', format: 'TV', season: 'FALL', seasonYear: 2026 }] },
    Jikan: { state: 'not-requested', items: [] }
  } }, candidates, 2026, 4);
  const result = model.applyOfficialJapaneseBroadcasts(base, candidates, 2026, 4);
  assert.equal(result.assigned[2].length, 0);
  assert.equal(result.assigned[3].length, 1, 'the AniList absolute instant maps to its actual Seoul weekday');
  assert.deepEqual(Array.from(result.assigned[3][0].item.events, event => event.source), ['AniList']);
  assert.equal(result.assigned[3][0].item.supplementalEvidence[0].time, '24:00');
  assert.equal(result.officialScheduleEvidence[0].evidenceRole, 'supplemental');
});

test('official Japanese TV evidence is preserved as supplemental instead of conflicting with a different release schedule', () => {
  const schedule = model.OFFICIAL_JAPANESE_BROADCASTS.find(item => item.anilistId === 159042);
  const anime = { provider: 'reanime', id: schedule.catalogId, mal_id: schedule.catalogId, title: schedule.titleJapanese,
    title_japanese: schedule.titleJapanese, anilistId: schedule.anilistId, year: 2026, season: 'FALL', type: 'ONA', status: 'Releasing' };
  const candidates = model.japaneseScheduleCandidates([anime], 2026, 4);
  const base = model.reconcileJapaneseBroadcastSchedule({ sources: {
    AniList: { state: 'complete', items: [{ anilistId: schedule.anilistId, episode: 3,
      airingAt: Date.parse('2026-10-07T16:00:00Z') / 1000, countryOfOrigin: 'JP', format: 'TV', season: 'FALL', seasonYear: 2026 }] },
    Jikan: { state: 'not-requested', items: [] }
  } }, candidates, 2026, 4);
  const result = model.applyOfficialJapaneseBroadcasts(base, candidates, 2026, 4);
  assert.equal(result.assigned[3].length, 1);
  assert.equal(result.assignedCount, 1);
  assert.equal(result.conflictCount, 0);
  assert.equal(result.officialScheduleEvidence[0].outcome, 'supplemental-different-schedule-basis');
  assert.equal(result.assigned[3][0].item.supplementalEvidence[0].source, 'official-tv');
});
