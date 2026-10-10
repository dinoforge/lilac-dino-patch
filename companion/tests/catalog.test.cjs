'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const quarter = require('../../src/quarter-selection.js');
const schedule = require('../../src/weekday-schedule.js');
const { DEMO_WORKS, PROVIDERS, buildDemoWeek, matchDemoSources, sourceRows, sourceStatus } = require('../core/catalog.cjs');

test('Companion derives the selected weekday schedule using Patch 01 merge logic', () => {
  const now = new Date(2026, 9, 11, 12, 0, 0); // Sunday, local time
  const selection = quarter.quarterForDate(now);
  const week = buildDemoWeek(selection, now);
  assert.equal(week.length, 7);
  assert.equal(week[6][0].title, '새벽의 망원경');
  assert.deepEqual(week[0][0].weekdaySources, ['linkkf', 'reanime', 'miruro']);
  assert.equal(week.flat().length, DEMO_WORKS.length);
  assert.ok(week.flat().every(item => item.synthetic === true));
  assert.ok(week.flat().every(item => item.year === 2026 && item.season === '가을 4분기'));
});

test('schedule identity deduplicates the same AniList work but keeps different seasons separate', () => {
  const anchor = { provider: 'linkkf', id: 'sample-1', title: '유리 정원의 편지 1기', title_english: 'Letters from Glass Garden Season 1', year: 2026, type: 'TV' };
  const same = { provider: 'miruro', id: 'other-id', anilistId: undefined, title: '유리 정원의 편지', title_english: 'Letters from Glass Garden Season 1', year: 2026, type: 'TV' };
  const sequel = { provider: 'miruro', id: 'sequel-id', title: '유리 정원의 편지', title_english: 'Letters from Glass Garden Season 2', year: 2026, type: 'TV' };
  const withoutId = { ...anchor, anilistId: undefined };
  assert.deepEqual(matchDemoSources(withoutId, [same, sequel]), [withoutId, same]);

  const authoritative = { ...anchor, anilistId: 910002 };
  const matchingId = { ...sequel, anilistId: 910002 };
  assert.deepEqual(matchDemoSources(authoritative, [matchingId]).map(item => item.provider), ['linkkf', 'miruro']);
});

test('five provider states distinguish exact playable, exact provided, missing, checking, and failure', () => {
  assert.deepEqual(PROVIDERS.map(provider => provider.id), ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkkf']);
  const rows = sourceRows(DEMO_WORKS[0]);
  assert.equal(rows.length, 5);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.provider, row.status])), {
    reanime: 'playable', miruro: 'provided', animenosub: 'missing', ohli24: 'failed', linkkf: 'playable'
  });
  assert.equal(sourceStatus('playable', [{ number: 4, playable: true }], 5), 'missing', 'a different episode must not count');
  assert.equal(schedule.episodeAvailability([{ number: 4, playable: false }], 4), 'provided');
  assert.equal(schedule.providerFallbackState({ state: 'searching' }, true), 'checking');
  assert.equal(schedule.providerFallbackState({ state: 'failed' }, false), 'failed');
});

test('same-quarter historical browsing persists, then calendar-quarter rollover selects the new quarter', () => {
  const june = new Date(2026, 5, 30, 23, 59, 0);
  const july = new Date(2026, 6, 1, 0, 1, 0);
  const pastChoice = quarter.selectionRecord(2025, 4, june);
  assert.equal(quarter.resolveSelection(pastChoice, new Date(2026, 4, 3)).selection.label, '2025년 4분기');
  assert.equal(quarter.resolveSelection(pastChoice, july).selection.label, '2026년 3분기');
  assert.equal(quarter.quarterForDate(new Date(2026, 11, 31)).label, '2026년 4분기');
  assert.equal(quarter.quarterForDate(new Date(2027, 0, 1)).label, '2027년 1분기');
});
