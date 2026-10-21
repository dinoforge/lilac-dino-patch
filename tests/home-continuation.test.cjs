const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(root, 'src/ott.css'), 'utf8');

test('continue watching is the compact first home rail, ahead of hero and discovery rows', () => {
  const home = html.slice(html.indexOf('<section id="homeView"'), html.indexOf('<section id="searchView"'));
  const continueAt = home.indexOf('id="continueSection"');
  const heroAt = home.indexOf('id="hero"');
  const latestAt = home.indexOf('id="latestEpisodeSection"');
  const scheduleAt = home.indexOf('id="scheduleSection"');
  assert.ok(continueAt >= 0 && continueAt < heroAt && heroAt < latestAt && latestAt < scheduleAt);
  assert.match(home, /<div id="scheduleSection" class="hidden" aria-hidden="true"><\/div>/, 'the hidden anchor remains for host integrations without rendering a duplicate weekly schedule');
  assert.doesNotMatch(home, /id="scheduleRail"|이번 주 방영표|scheduleTabs/);
  assert.doesNotMatch(html, /weekly-schedule\.css/, 'home does not load styles for the removed duplicate schedule UI');
  assert.ok(app.includes('hasContinue=latest.length>0;'));
  assert.ok(app.includes("classList.toggle('has-continue',hasContinue)"));
  assert.match(css, /#homeView\.has-continue\{padding-top:calc\(var\(--ott-head\) \+ 12px\)\}/);
  assert.match(css, /#homeView #continueSection \.continue-card\{flex:0 0 clamp\(150px,13vw,190px\)\}/);
});

test('continue history renders before awaiting the downloads IPC during startup', () => {
  const initAt = app.indexOf('async function init(){');
  const historyAt = app.indexOf('sanitizeExpiredProxyHistory(state.history)', initAt);
  const continueAt = app.indexOf('renderContinue(); renderLibrary();', initAt);
  const downloadsAt = app.indexOf('state.downloads=await window.lilac.downloads()', initAt);
  assert.ok(initAt >= 0 && historyAt > initAt && continueAt > historyAt && downloadsAt > continueAt);
  assert.match(app, /if\(sanitizedHistory\.changed\)store\.set\('history',state\.history\)/);
  assert.match(app, /async function playHistoryItem\(item\)\{if\(!item\?\.episode&&!item\?\.src\)/);
});

const sanitizerStart = app.indexOf('function sanitizeExpiredProxyHistory(');
const sanitizerEnd = app.indexOf('\n\nasync function init()', sanitizerStart);
assert.ok(sanitizerStart >= 0 && sanitizerEnd > sanitizerStart, 'Missing expired playback URL sanitizer');
const sanitizerSource = app.slice(sanitizerStart, sanitizerEnd);
function sanitizeHistory(items) {
  const context = vm.createContext({});
  vm.runInContext(sanitizerSource, context);
  return JSON.parse(JSON.stringify(context.sanitizeExpiredProxyHistory(items)));
}

test('startup removes expired loopback media URLs without deleting watch history', () => {
  const episodeRecord = {
    key: 'reanime:https://reanime.to/watch/test?ep=1',
    src: 'http://127.0.0.1:41234/__flix/session-one/master.m3u8',
    name: '작품 · 1화', subtitleTitle: '작품', progress: 38, updated: 100,
    episode: { provider: 'reanime', number: 1, url: 'https://reanime.to/watch/test?ep=1' },
    anime: { provider: 'reanime', id: 'test', title: '작품' }
  };
  const legacyRecord = {
    src: 'http://127.0.0.1:8765/__flix/session-two/master.m3u8',
    name: '직접 재생 · 1화', subtitleTitle: '직접 재생', progress: 12, updated: 200, episode: null
  };
  const directRecord = { key: 'direct:one', src: 'https://media.example.test/video.mp4', name: '일반 영상', progress: 5 };
  const result = sanitizeHistory([episodeRecord, legacyRecord, directRecord]);

  assert.equal(result.changed, true);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items[0], { ...episodeRecord, src: '' });
  assert.deepEqual(result.items[1], { ...legacyRecord, key: 'expired-flix:session-two', src: '', playbackSourceExpired: true });
  assert.deepEqual(result.items[2], directRecord);
  assert.equal(result.items[0].episode.url, episodeRecord.episode.url, 'provider episode identity remains available for re-resolution');
});

test('expired history URLs are migrated once and unplayable legacy entries stay out of continue watching', () => {
  const first = sanitizeHistory([{ src: 'http://127.0.0.1:9000/__flix/legacy-id/master.m3u8', name: '이전 영상', progress: 40 }]);
  const second = sanitizeHistory(first.items);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.items, first.items);

  const start = app.indexOf('function latestHistoryByAnime('), end = app.indexOf('\nfunction renderContinue()', start);
  assert.ok(start >= 0 && end > start, 'Missing continue-history selector');
  const context = vm.createContext({});
  vm.runInContext(app.slice(start, end), context);
  const visible = JSON.parse(JSON.stringify(context.latestHistoryByAnime([
    { key: 'expired-flix:legacy-id', name: '이전 영상', src: '', episode: null },
    { key: 'reanime:one', name: '작품 · 1화', episode: { provider: 'reanime' } },
    { key: 'direct:two', name: '직접 영상', src: 'https://media.example.test/video.mp4' }
  ])));
  assert.equal(visible.length, 2);
  assert.ok(visible.every(item => item.episode || item.src));
});
