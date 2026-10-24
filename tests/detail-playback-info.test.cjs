'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const info = require('../src/detail-playback-info.js');

const anime = { provider: 'miruro', id: 'series-1', mal_id: 'miruro:series-1', year: 2026, season: 'FALL', type: 'TV' };
const episodes = [
  { provider: 'miruro', id: 'ep-1', number: 1, playable: true },
  { provider: 'miruro', id: 'ep-2', number: 2, playable: true }
];

test('detail summary uses only the actually loaded episode list', () => {
  const result = info.summarize({ ...anime, availableEpisodes: 24 }, episodes, []);
  assert.deepEqual(result, {
    lookupStatus: 'loaded', episodeCount: 2, latestEpisodeNumber: 2,
    resolution: '', format: '', qualityEpisode: null, resume: null,
    playbackStatus: 'unchecked', playbackEpisode: null
  });
  assert.equal(info.summarize(anime, null, []).lookupStatus, 'unqueried');
  assert.equal(info.summarize(anime, { error: true }, []).lookupStatus, 'failed');
  assert.deepEqual(info.summarize(anime, { episodes: [] }, []), {
    lookupStatus: 'loaded', episodeCount: 0, latestEpisodeNumber: null,
    resolution: '', format: '', qualityEpisode: null, resume: null,
    playbackStatus: 'none', playbackEpisode: null
  });
});

test('resume history is isolated to the selected source work, season, provider and episode', () => {
  const history = [
    { updated: 8, progress: 52, episode: episodes[1], anime, positionSeconds: 755,
      playbackInfo: { provider: 'miruro', sourceId: 'series-1', width: 1920, height: 1080, format: 'HLS' } },
    { updated: 9, progress: 40, episode: { provider: 'reanime', number: 2 }, anime: { ...anime, provider: 'reanime', id: 'series-1' },
      playbackInfo: { provider: 'reanime', sourceId: 'series-1', width: 3840, height: 2160, format: 'MP4' } },
    { updated: 10, progress: 30, episode: { provider: 'miruro', number: 2 }, anime: { ...anime, season: 'SPRING' } },
    { updated: 11, progress: 65, episode: { provider: 'miruro', number: 2 }, anime: { ...anime, id: 'other-series' } }
  ];
  const result = info.summarize(anime, episodes, history);
  assert.deepEqual(result, {
    lookupStatus: 'loaded', episodeCount: 2, latestEpisodeNumber: 2,
    resolution: '1080p', format: 'HLS', qualityEpisode: { number: 2, name: '' },
    resume: { episode: 2, positionSeconds: 755, progress: 52 },
    playbackStatus: 'unchecked', playbackEpisode: null
  });
});

test('unknown playback facts stay hidden and legacy progress is not converted to a guessed time', () => {
  const history = [{ updated: 1, progress: 23, episode: episodes[0], anime }];
  const result = info.summarize(anime, episodes, history);
  assert.deepEqual(result, {
    lookupStatus: 'loaded', episodeCount: 2, latestEpisodeNumber: 2,
    resolution: '', format: '', qualityEpisode: null,
    resume: { episode: 1, positionSeconds: null, progress: 23 },
    playbackStatus: 'unchecked', playbackEpisode: null
  });
  assert.equal(info.formatPosition(755), '12:35');
  assert.equal(info.formatPosition(null), '');
});

test('episode identity prefers a confirmed source reference over the same episode number', () => {
  assert.equal(info.sameEpisode(episodes[1], { ...episodes[1], id: 'another-source-episode' }), false);
  assert.equal(info.sameEpisode({ provider: 'miruro', number: 2 }, { provider: 'miruro', number: 2 }), true);
  const result = info.summarize(anime, episodes, [{
    updated: 1, progress: 44,
    episode: { provider: 'miruro', id: 'another-source-episode', number: 2 }, anime,
    playbackInfo: { provider: 'miruro', sourceId: 'series-1', width: 3840, height: 2160, format: 'MP4' }
  }]);
  assert.equal(result.resolution, '');
  assert.equal(result.resume, null);
});

test('playback result is isolated to the exact selected source and episode', () => {
  const attempt = { anime, episode: episodes[1], status: 'confirmed', updated: 10 };
  const result = info.summarize(anime, episodes, [], [attempt]);
  assert.equal(result.playbackStatus, 'confirmed');
  assert.equal(result.playbackEpisode, '2화');
  assert.equal(info.summarize({ ...anime, provider: 'reanime' }, episodes, [], [attempt]).playbackStatus, 'unchecked');
  assert.equal(info.summarize(anime, episodes, [], [{ ...attempt, episode: { ...episodes[1], id: 'other-ep' } }]).playbackStatus, 'unchecked');
  assert.equal(info.summarize(anime, episodes, [], [{ ...attempt, status: 'failed' }]).playbackStatus, 'failed');
  assert.equal(info.summarize(anime, episodes, [], [{ ...attempt, status: 'restricted' }]).playbackStatus, 'restricted');
  assert.equal(info.summarize(anime, episodes, [], [{ ...attempt, status: 'checking' }]).playbackStatus, 'checking');
  assert.equal(info.summarize(anime, episodes, [], [{ ...attempt, status: 'unverified' }]).playbackStatus, 'unchecked');
});
