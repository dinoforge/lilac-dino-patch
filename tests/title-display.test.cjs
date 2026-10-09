const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const titleDisplay = require('../src/title-display.js');

const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');

test('uses a Korean source title or translation as the primary title', () => {
  assert.equal(titleDisplay.primaryTitle({ title: '薬屋のひとりごと', title_japanese: '薬屋のひとりごと' }, '약사의 혼잣말'), '약사의 혼잣말');
  assert.equal(titleDisplay.primaryTitle({ title: '한국어 원제', title_english: 'English title' }), '한국어 원제');
});

test('falls back to the original title when no Korean title is known', () => {
  assert.equal(titleDisplay.primaryTitle({ title: 'English title', title_english: 'English title', title_japanese: '日本語の題名' }), '日本語の題名');
  assert.equal(titleDisplay.primaryTitle({ title: 'English title' }), 'English title');
});

test('shows a distinct original title and suppresses a duplicate', () => {
  const anime = { title: 'English title', title_english: 'English title', title_japanese: '日本語の題名' };
  assert.equal(titleDisplay.originalTitle(anime, '한국어 제목'), '日本語の題名');
  assert.equal(titleDisplay.originalTitle(anime, '日本語の題名'), '');
  assert.equal(titleDisplay.originalTitle({ title: '한국어 원제', title_english: 'English title' }, '한국어 원제'), 'English title');
});

test('still queues Korean lookup when a saved display cache has only an English title', () => {
  const start = app.indexOf('const displayTitles=');
  const end = app.indexOf('// A saved item\'s title', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = { LilacTitleDisplay: titleDisplay, setTimeout: () => 1, clearTimeout: () => {} };
  vm.runInNewContext(`${app.slice(start, end)}\nthis.titleTest={displayTitles,pendingTitles,titleOf};`, context);
  const key = 'reanime:12';
  context.titleTest.displayTitles.set(key, { en: 'English title' });
  assert.equal(context.titleTest.titleOf({ provider: 'reanime', id: 12, title: 'English title', title_japanese: '日本語の題名' }), '日本語の題名');
  assert.equal(context.titleTest.pendingTitles.has(key), true);
});

test('clears a previous player original title when switching to direct playback', () => {
  const start = app.indexOf('function updatePlayerTitle(){');
  const end = app.indexOf('\nfunction titleAttr', start);
  const heading = { textContent: '재생 준비 중' };
  const original = { textContent: '이전 작품', hidden: false, dataset: { originalTitleFor: 'reanime:12' } };
  const context = { currentPlaybackContext: {}, $: selector => selector === '#playerTitle' ? heading : original };
  vm.runInNewContext(`${app.slice(start, end)}\nthis.clearPlayerTitle=updatePlayerTitle;`, context);
  context.clearPlayerTitle();
  assert.equal(original.textContent, '');
  assert.equal(original.hidden, true);
  assert.equal(original.dataset.originalTitleFor, undefined);
});

test('wires Korean-first and original-title display into home, detail, continue, and player views', () => {
  assert.doesNotMatch(app, /titleLanguage/);
  assert.doesNotMatch(html, /titleLanguageChoices|id="titleLanguage"/);
  assert.match(html, /한국어 제목을 우선 표시하고 확인된 원제는 보조로 표시합니다/);
  assert.match(app, /buildSearchSuggestionData\([^\n]+,'ko'\)/);
  assert.match(app, /originalTitleMarkup\(a,'anime-card-native'\)/);
  assert.match(app, /originalTitleMarkup\(a,'detail-native','p'\)/);
  assert.match(app, /originalTitleMarkup\(h\.anime,'continue-original'\)/);
  assert.match(app, /originalTitleMarkup\(h\.anime,'history-original'\)/);
  assert.match(app, /originalTitleMarkup\(job\.anime,'download-original'\)/);
  assert.match(html, /id="heroOriginalTitle"/);
  assert.match(html, /id="playerOriginalTitle"/);
});
