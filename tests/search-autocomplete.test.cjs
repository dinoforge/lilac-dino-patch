const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const start = appSource.indexOf('function normalizeSearchText');
const end = appSource.indexOf('\nconst searchAutocompleteControls', start);
assert.ok(start >= 0 && end > start, 'Missing local search suggestion helpers');
const context = vm.createContext({});
vm.runInContext(`${appSource.slice(start, end)}\nthis.searchHelpers = { nextRecentSearches, buildSearchSuggestionData };`, context);
const { nextRecentSearches, buildSearchSuggestionData } = context.searchHelpers;

test('recent searches are normalized, deduplicated newest first, and capped at ten', () => {
  const history = ['Demon Slayer', ' Frieren ', 'DEMON SLAYER', 'ＡＢＣ'];
  const next = JSON.parse(JSON.stringify(nextRecentSearches(history, '  demon   slayer  ')));
  assert.deepEqual(next, ['demon   slayer', 'Frieren', 'ＡＢＣ']);
  const capped = JSON.parse(JSON.stringify(nextRecentSearches(Array.from({ length: 12 }, (_, index) => `Show ${index}`), 'Newest')));
  assert.equal(capped.length, 10);
  assert.equal(capped[0], 'Newest');
  assert.equal(capped.at(-1), 'Show 8');
});

test('suggestions match cached Korean, English, and Japanese titles without duplicate works', () => {
  const titles = [
    { mal_id: 1, title: 'Kimetsu no Yaiba', title_english: 'Demon Slayer', title_japanese: '鬼滅の刃', year: 2019, type: 'TV' },
    { mal_id: 1, title: 'Kimetsu no Yaiba', title_english: 'Demon Slayer', title_japanese: '鬼滅の刃', year: 2019, type: 'TV' },
    { mal_id: 2, title: 'Sousou no Frieren', title_english: "Frieren: Beyond Journey's End", title_japanese: '葬送のフリーレン', year: 2023, type: 'TV' }
  ];
  const getKnown = item => item.mal_id === 1 ? { ko: '귀멸의 칼날' } : { ko: '장송의 프리렌' };
  const rows = JSON.parse(JSON.stringify(buildSearchSuggestionData('귀멸', titles, ['귀멸의 칼날', '다른 작품'], getKnown)));
  assert.deepEqual(rows.recent.map(item => item.label), ['귀멸의 칼날']);
  assert.deepEqual(rows.anime.map(item => [item.label, item.query, item.detail]), [['귀멸의 칼날', '귀멸의 칼날', '2019 · TV']]);

  const englishRows = JSON.parse(JSON.stringify(buildSearchSuggestionData('frieren', titles, [], getKnown, 'ko')));
  assert.deepEqual(englishRows.anime.map(item => item.label), ['장송의 프리렌']);
  const japaneseRows = JSON.parse(JSON.stringify(buildSearchSuggestionData('鬼滅', titles, [], getKnown, 'ko')));
  assert.deepEqual(japaneseRows.anime.map(item => item.label), ['귀멸의 칼날']);
});
