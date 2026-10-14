'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupEpisodes } = require('../../src/unified-catalog.js');

const entry = (provider, seriesKey, episode) => ({ provider, seriesKey, episode: { number: 12, ...episode }, anime: { id: provider } });

test('same cross-provider series and numbered episode merge when localized episode titles differ', () => {
  const groups = groupEpisodes([
    entry('reanime', 'anilist:804', { title: 'Episode 12', name: '12화' }),
    entry('miruro', 'anilist:804', { title: '그날의 맹세', name: '12화' })
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].choices.map(choice => choice.provider), ['reanime', 'miruro']);
});

test('equal episode numbers from different works or seasons do not merge', () => {
  const groups = groupEpisodes([
    entry('reanime', 'anilist:804-season-1', { title: 'Episode 12' }),
    entry('miruro', 'anilist:804-season-2', { title: 'Episode 12' }),
    entry('animenosub', 'anilist:999', { title: 'Episode 12' })
  ]);
  assert.equal(groups.length, 3);
  assert.ok(groups.every(group => group.choices.length === 1));
});

test('special episodes remain separate even when their series identity and number match', () => {
  const groups = groupEpisodes([
    entry('reanime', 'mal:100', { number: 12, title: 'Episode 12' }),
    entry('miruro', 'mal:100', { number: 12, title: 'Special 12' })
  ]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => group.choices.length === 1));
});

test('missing shared series identity never merges episodes by number alone', () => {
  const groups = groupEpisodes([
    { provider: 'reanime', episode: { number: 12, title: 'Episode 12', id: 'a' } },
    { provider: 'miruro', episode: { number: 12, title: 'Episode 12', id: 'b' } }
  ]);
  assert.equal(groups.length, 2);
});
