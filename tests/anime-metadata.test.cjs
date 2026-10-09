const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compareRelease, episodeLabel, releaseDate } = require('../src/anime-metadata.js');

test('release dates prefer full air dates and fall back to calendar quarters', () => {
  assert.equal(releaseDate({ aired: '2024-04-02', year: 2023, season: 'FALL' }), 20240402);
  assert.equal(releaseDate({ year: 2025, season: 'FALL' }), 20251001);
  assert.equal(releaseDate({ year: 2025, season: 'SPRING' }), 20250401);
  assert.equal(releaseDate({}), 0);
});

test('release comparator sorts newer shows first without inventing dates for unknown shows', () => {
  assert.ok(compareRelease({ year: 2026, season: 'WINTER' }, { year: 2025, season: 'FALL' }) < 0);
  assert.ok(compareRelease({ year: 2025, season: 'FALL' }, {}) < 0);
});

test('episode labels distinguish uploaded episodes from announced total episodes', () => {
  assert.equal(episodeLabel({ provider: 'reanime', subbed: 8, dubbed: 10, episodes: 12 }), '업로드 10화 / 총 12화');
  assert.equal(episodeLabel({ provider: 'miruro', availableEpisodeCount: 7, totalEpisodes: 12 }), '업로드 7화 / 총 12화');
  assert.equal(episodeLabel({ provider: 'ohli24', episodes: 24 }), '업로드 24화');
  assert.equal(episodeLabel({ episodes: 12 }), '총 12화');
  assert.equal(episodeLabel({ provider: 'animenosub', availableEpisodes: 0 }), '');
});
