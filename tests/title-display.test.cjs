const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const titleDisplay = require('../src/title-display.js');

const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

test('uses a Korean source title or translation as the primary title', () => {
  assert.equal(titleDisplay.primaryTitle({ title: '薬屋のひとりごと', title_japanese: '薬屋のひとりごと' }, '약사의 혼잣말'), '약사의 혼잣말');
  assert.equal(titleDisplay.primaryTitle({ title: '한국어 원제', title_english: 'English title' }), '한국어 원제');
  assert.equal(titleDisplay.primaryTitle({ title: 'English title', title_korean: '공급원 한국어 제목' }, '캐시 제목'), '공급원 한국어 제목');
  assert.equal(titleDisplay.primaryTitle({ title: 'English title', title_japanese: '日本語の題名' }, '저장된 한국어 제목'), '저장된 한국어 제목');
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

test('keeps the original visible immediately and looks up missing Korean titles only when visible', async () => {
  const start = app.indexOf('const displayTitles=');
  const end = app.indexOf('\nfunction refreshTitleElements', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  let resolveRequest;
  const calls = [], refreshed = [];
  class FakeIntersectionObserver {
    static instance;
    constructor(callback) { this.callback = callback; this.observed = []; FakeIntersectionObserver.instance = this; }
    observe(node) { this.observed.push(node); }
    unobserve(node) { this.observed = this.observed.filter(value => value !== node); }
    intersect(node) { this.callback([{ target: node, isIntersecting: true }]); }
  }
  class FakeMutationObserver { constructor(callback) { this.callback = callback; } observe() {} }
  const context = vm.createContext({
    LilacTitleDisplay: titleDisplay,
    IntersectionObserver: FakeIntersectionObserver,
    MutationObserver: FakeMutationObserver,
    document: { nodeType: 9, body: {}, querySelectorAll: () => [] },
    window: { lilac: { resolveTitles: items => { calls.push(items); return new Promise(resolve => { resolveRequest = resolve; }); } } },
    refreshTitleElements: keys => refreshed.push(...keys)
  });
  vm.runInContext(`${app.slice(start, end)}\nthis.titleTest={displayTitles,pendingTitles,titleLookupStarted,titleOf,observeTitleLookupNodes};`, context);
  const anime = { provider: 'reanime', id: 12, mal_id: 'reanime:12', title: 'English title', title_japanese: '日本語の題名' };
  const key = 'reanime:12';
  assert.equal(context.titleTest.titleOf(anime), '日本語の題名', 'a delayed title request cannot block the initial title');
  assert.equal(calls.length, 0, 'rendering an off-screen title does not request title metadata');
  const element = { nodeType: 1, dataset: { titleFor: key }, matches: selector => selector === '[data-title-for]', querySelectorAll: () => [] };
  context.titleTest.observeTitleLookupNodes(element);
  assert.equal(calls.length, 0, 'observing a non-intersecting card does not issue a request');
  FakeIntersectionObserver.instance.intersect(element);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1, 'each visible work is enriched independently');
  assert.equal(calls[0][0].id, 12);
  resolveRequest([{ key, ko: '확인된 한국어 제목', en: 'English title' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.titleTest.titleOf(anime), '확인된 한국어 제목');
  assert.deepEqual(refreshed, [key], 'the returned title refreshes the existing element by key');
});

test('bounds visible title enrichment and coalesces duplicate work requests', async () => {
  assert.match(app, /TITLE_LOOKUP_CONCURRENCY=4/);
  assert.match(app, /window\.lilac\.resolveTitles\(\[item\]\)/);
  assert.match(app, /new IntersectionObserver/);
  assert.match(main, /const displayTitlePending=new Map\(\)/);
  const start = main.indexOf('const displayTitlePending=new Map();');
  const end = main.indexOf('\nasync function resolveDisplayTitleUnshared', start);
  assert.ok(start >= 0 && end > start);
  let resolveCore, calls = 0;
  const context = vm.createContext({ resolveDisplayTitleUnshared: () => { calls++; return new Promise(resolve => { resolveCore = resolve; }); } });
  vm.runInContext(`${main.slice(start, end)}\nthis.resolveTitle=resolveDisplayTitle;this.pendingTitleMap=displayTitlePending;`, context);
  const anime = { provider: 'miruro', id: 'series-1', title: '日本語題名' };
  const first = context.resolveTitle(anime), second = context.resolveTitle({ ...anime });
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolveCore({ key: 'miruro:series-1', ko: '제목' });
  await first;
  assert.equal(context.pendingTitleMap.size, 0);
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
  assert.doesNotMatch(html, /season-calendar\.js|id="seasonCalendarView"/, 'the removed Patch 01 calendar is no longer loaded by the app');
});
