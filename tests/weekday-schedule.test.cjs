const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesScheduledWork, matchScheduledSources, combineScheduledSources, mergeWeekdaySchedules, localWeekday, scheduleCacheKey, episodeAvailability, providerFallbackState, settleProviderSchedule } = require('../src/weekday-schedule.js');

test('weekday cache keys are isolated by calendar quarter and keep old keys addressable', () => {
  const prior = scheduleCacheKey('reanime', new Date(2026, 2, 31));
  const current = scheduleCacheKey('reanime', new Date(2026, 3, 1));
  assert.equal(prior, 'weekdaySchedule:v3:2026:1:reanime');
  assert.equal(current, 'weekdaySchedule:v3:2026:2:reanime');
  assert.notEqual(prior, current);
  assert.notEqual(current, 'weekdaySchedule:v2:reanime');
});

test('weekday source matching uses AniList identity when both sources have it', () => {
  const anchor = { provider: 'linkkf', anilistId: 101, title: 'Series', year: '2026' };
  assert.equal(matchesScheduledWork(anchor, { provider: 'reanime', anilistId: 101, title: 'Different translation' }), true);
  assert.equal(matchesScheduledWork(anchor, { provider: 'miruro', anilistId: 202, title: 'Series', year: '2026' }), false);
});

test('weekday title fallback requires exact title and year and rejects season or format conflicts', () => {
  const anchor = { provider: 'linkkf', title: 'Example Season 2', year: '2026', type: 'TV' };
  assert.equal(matchesScheduledWork(anchor, { provider: 'animenosub', title: 'Example Season 2', year: 2026, type: 'TV' }), true);
  assert.equal(matchesScheduledWork(anchor, { provider: 'animenosub', title: 'Example Season 2', year: 2025, type: 'TV' }), false);
  assert.equal(matchesScheduledWork(anchor, { provider: 'animenosub', title: 'Example Season 3', year: 2026, type: 'TV' }), false);
  assert.equal(matchesScheduledWork(anchor, { provider: 'ohli24', title: 'Example Season 2', year: 2026, type: 'Movie' }), false);
  assert.equal(matchesScheduledWork(anchor, { provider: 'miruro', title: 'Example Season 2', type: 'TV' }), false);
});

test('weekday source matching keeps at most one exact work per provider', () => {
  const anchor = { provider: 'linkkf', anilistId: 101, title: 'Series' };
  const matches = matchScheduledSources(anchor, [
    { provider: 'reanime', anilistId: 101, id: 'a' },
    { provider: 'reanime', anilistId: 101, id: 'b' },
    { provider: 'miruro', anilistId: 202, id: 'c' }
  ]);
  assert.deepEqual(matches.map(item => item.id), ['a']);
});

test('weekday source combination keeps its anchor once and adds exact matches from other providers', () => {
  const anchor = { provider: 'reanime', anilistId: 101, id: 'r-original' };
  const combined = combineScheduledSources(anchor, [
    { provider: 'reanime', anilistId: 101, id: 'r-search-duplicate' },
    { provider: 'linkkf', anilistId: 101, id: 'lk-match' },
    { provider: 'miruro', anilistId: 202, id: 'wrong-work' }
  ]);
  assert.deepEqual(combined.map(item => item.id), ['r-original', 'lk-match']);
});

test('weekday lists merge exact upcoming episodes into a source timetable without losing the episode number', () => {
  const linkkf = Array.from({ length: 7 }, () => []);
  linkkf[2] = [{ provider: 'linkkf', id: 'lk-1', mal_id: 'linkkf:lk-1', title: 'Series', year: 2026, anilistId: 101 }];
  const timestamp = Math.floor(new Date(2026, 5, 3, 20, 0, 0).getTime() / 1000);
  const days = mergeWeekdaySchedules(linkkf, [
    { anime: { provider: 'miruro', id: 'm-1', mal_id: 'miruro:m-1', title: 'Localized title', anilistId: 101 }, episode: 7, airingAt: timestamp },
    { anime: { provider: 'reanime', id: 'r-2', mal_id: 'reanime:r-2', title: 'Another title', anilistId: 202 }, episode: 2, airingAt: timestamp }
  ]);
  const linked = days[2].find(item => item.provider === 'linkkf');
  assert.equal(linked.weekdayEpisodeNumber, 7);
  assert.equal(linked.anilistId, 101, 'the verified AniList identity remains available for later provider matching');
  assert.deepEqual(linked.weekdaySources, ['linkkf', 'miruro']);
  assert.equal(days[localWeekday(timestamp)].some(item => item.anilistId === 202 && item.weekdayEpisodeNumber === 2), true);
});

test('availability is determined only from the exact episode entry', () => {
  const episodes = [{ number: 1 }, { number: 2, playable: false }, { number: 4, playable: true }];
  assert.equal(episodeAvailability(episodes, 1), 'provided');
  assert.equal(episodeAvailability(episodes, 2), 'provided');
  assert.equal(episodeAvailability(episodes, 4), 'playable');
  assert.equal(episodeAvailability(episodes, 3), 'missing');
  assert.equal(episodeAvailability([], 3), 'missing');
  assert.equal(episodeAvailability(null, 3), 'failed');
  assert.equal(episodeAvailability(episodes, 0), 'failed');
});

test('unmatched search results never count as an exact provider episode match', () => {
  assert.equal(providerFallbackState({ state: 'ready', resultCount: 7 }, false), 'missing');
  assert.equal(providerFallbackState({ state: 'partial', resultCount: 1 }, false), 'failed');
  assert.equal(providerFallbackState({ state: 'ready', resultCount: 1 }, true), 'checking');
});

test('provider schedule requests settle independently on success, rejection, or timeout', async () => {
  const success = await settleProviderSchedule('Re:Anime', async () => ['episode'], { timeoutMs: 50 });
  assert.equal(success.state, 'success');
  assert.deepEqual(success.value, ['episode']);

  const failure = await settleProviderSchedule('Miruro', async () => { throw new Error('offline'); }, { timeoutMs: 50 });
  assert.equal(failure.state, 'failed');
  assert.match(failure.error.message, /offline/);

  const timedOut = await settleProviderSchedule('Linkkf', () => new Promise(() => {}), { timeoutMs: 5 });
  assert.equal(timedOut.state, 'timeout');
  assert.ok(timedOut.elapsedMs >= 0);
});
