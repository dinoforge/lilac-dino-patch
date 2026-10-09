const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const start = appSource.indexOf('// Detail "재생"');
const end = appSource.indexOf('// A story the source gives in English', start);
assert.ok(start >= 0 && end > start, 'Missing resume helpers in app.js');

function setup(history = []) {
  const state = { history };
  const episodeRef = episode => encodeURIComponent(String(episode.url || episode.token || episode.id || episode.number || ''));
  const context = vm.createContext({ state, episodeRef, playLabel: label => label });
  vm.runInContext(appSource.slice(start, end), context);
  return context;
}

function episode(provider, number, playable = true) {
  return { provider, number, name: String(number), url: `https://${provider}.invalid/watch/${number}`, playable };
}

test('resumeEpisode chooses a playable same-provider history episode only', () => {
  const anime = { mal_id: 42, provider: 'reanime' };
  const selected = episode('reanime', 2);
  const context = setup([
    { episode: episode('reanime', 4, false), progress: 70, anime },
    { episode: episode('miruro', 2), progress: 82, anime: { ...anime, provider: 'miruro' } },
    { episode: selected, progress: 31, anime }
  ]);

  const target = context.resumeEpisode(anime, [selected, episode('reanime', 4, false)]);
  assert.equal(target.episode, selected);
  assert.equal(target.progress, 31);
  assert.equal(target.resume, true);
  assert.equal(target.matched, true);
});

test('resumeEpisode falls back to the first playable episode when saved episode is unavailable', () => {
  const anime = { mal_id: 7, provider: 'reanime' };
  const first = episode('reanime', 1);
  const context = setup([{ episode: episode('reanime', 3, false), progress: 44, anime }]);

  const target = context.resumeEpisode(anime, [first, episode('reanime', 3, false)]);
  assert.equal(target.episode, first);
  assert.equal(target.progress, 0);
  assert.equal(target.matched, false);
});

test('resumeEpisode does not match number-only history from a different anime on the same provider', () => {
  const anime = { mal_id: 7, provider: 'reanime' };
  const first = { provider: 'reanime', number: 1, name: '1', playable: true };
  const otherAnimeEpisode = { provider: 'reanime', number: 1, name: '1' };
  const context = setup([{ episode: otherAnimeEpisode, progress: 82, anime: { mal_id: 9, provider: 'reanime' } }]);

  const target = context.resumeEpisode(anime, [first]);
  assert.equal(target.episode, first);
  assert.equal(target.progress, 0);
  assert.equal(target.matched, false);
});

test('resumeEpisode keeps number-only legacy history when the same anime is identified', () => {
  const anime = { mal_id: 42, provider: 'reanime' };
  const current = { provider: 'reanime', number: 2, name: '2', playable: true };
  const saved = { provider: 'reanime', number: 2, name: '2' };
  const context = setup([{ episode: saved, progress: 31, anime }]);

  const target = context.resumeEpisode(anime, [current]);
  assert.equal(target.episode, current);
  assert.equal(target.progress, 31);
  assert.equal(target.matched, true);
});

test('resumeEpisode uses matching provider-scoped anime IDs for older history without a MAL ID', () => {
  const anime = { id: 'series-a', provider: 'reanime' };
  const current = { provider: 'reanime', number: 2, name: '2', playable: true };
  const saved = { provider: 'reanime', number: 2, name: '2' };
  const context = setup([{ episode: saved, progress: 46, anime }]);

  const target = context.resumeEpisode(anime, [current]);
  assert.equal(target.progress, 46);
  assert.equal(target.matched, true);
});

test('resumeEpisode preserves a legacy record with an exact URL and no anime metadata', () => {
  const anime = { provider: 'reanime' };
  const url = 'https://re-anime.invalid/watch/legacy-episode';
  const current = { provider: 'reanime', number: 1, url, playable: true };
  const saved = { provider: 'reanime', number: 1, url };
  const context = setup([{ episode: saved, progress: 55, anime: null }]);

  const target = context.resumeEpisode(anime, [current]);
  assert.equal(target.progress, 55);
  assert.equal(target.matched, true);
});

test('resumeAction offers start-over alongside ordinary resume below 95 percent', () => {
  const context = setup();
  const target = { episode: episode('reanime', 3), progress: 28 };
  const primary = context.resumeAction(target);
  const alternate = context.resumeAction(target, 'alternate');

  assert.equal(primary.label, '3화 이어보기');
  assert.equal(primary.showAlternate, true);
  assert.deepEqual(JSON.parse(JSON.stringify(primary.options)), { resumeMode: 'continue', resumeProgress: 28 });
  assert.equal(alternate.label, '3화 처음부터');
  assert.deepEqual(JSON.parse(JSON.stringify(alternate.options)), { resumeProgress: 0 });
});

test('resumeAction lets users continue at 95 percent or restart explicitly', () => {
  const context = setup();
  const target = { episode: episode('reanime', 3), progress: 96 };
  const primary = context.resumeAction(target);
  const alternate = context.resumeAction(target, 'alternate');

  assert.equal(primary.label, '3화 처음부터');
  assert.deepEqual(JSON.parse(JSON.stringify(primary.options)), { resumeProgress: 0 });
  assert.equal(alternate.label, '3화 이어보기');
  assert.deepEqual(JSON.parse(JSON.stringify(alternate.options)), { resumeMode: 'continue', resumeProgress: 96 });
});

test('resumePosition preserves the 95 percent default and honors an explicit continue choice', () => {
  const context = setup();
  assert.equal(context.resumePosition(28), 28);
  assert.equal(context.resumePosition(96), 0);
  assert.equal(context.resumePosition(96, 'continue'), 96);
  assert.equal(context.resumePosition(100, 'continue'), 0);
  assert.match(appSource, /pendingResumeProgress=resumePosition\(savedProgress,context\.resumeMode\)/);
});

test('detail buttons bind the alternate action and its explicit resume position', () => {
  const context = setup(), classes = new Set(['hidden']), primary = { innerHTML: '' }, selected = [];
  const alternate = {
    classList: { toggle(name, force) { force ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) },
    setAttribute(name, value) { this[name] = value; }
  };
  const target = { episode: episode('reanime', 3), progress: 96 };
  context.bindResumeActions(primary, alternate, target, (...args) => selected.push(args));

  assert.equal(primary.innerHTML, '3화 처음부터');
  assert.equal(alternate.textContent, '3화 이어보기');
  assert.equal(alternate.classList.contains('hidden'), false);
  alternate.onclick();
  assert.equal(selected[0][0], target.episode);
  assert.deepEqual(JSON.parse(JSON.stringify(selected[0][1])), { resumeMode: 'continue', resumeProgress: 96 });
});

test('completed and unstarted episodes do not show a second resume action', () => {
  const context = setup();
  for (const progress of [0, 100]) {
    const action = context.resumeAction({ episode: episode('reanime', 1), progress });
    assert.equal(action.showAlternate, false);
    assert.equal(action.label, '1화 재생');
    const classes = new Set();
    const alternate = { classList: { toggle(name, force) { force ? classes.add(name) : classes.delete(name); } }, setAttribute() {} };
    context.bindResumeActions({ innerHTML: '' }, alternate, { episode: episode('reanime', 1), progress }, () => {});
    assert.equal(classes.has('hidden'), true);
  }
});
