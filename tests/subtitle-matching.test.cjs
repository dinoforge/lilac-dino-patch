const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const start = mainSource.indexOf('// "S02E05" counts as episode 5 only');
const end = mainSource.indexOf('const COMMUNITY_FILE=', start);
assert.ok(start >= 0 && end > start, 'Missing community subtitle file matching helpers');

function setup() {
  const context = vm.createContext({ fs, path });
  vm.runInContext(`${mainSource.slice(start, end)}\nthis.subtitleMatching = { communityFileEpisodeNumbers, communityFileMatches, selectCommunitySubtitleCandidate };`, context);
  return context.subtitleMatching;
}

test('subtitle archive selects the exact episode even when other episodes appear first', () => {
  const matching = setup();
  const selected = matching.selectCommunitySubtitleCandidate([
    'Show.E01.1080p.ass',
    'Show.S02E05.1080p.ass',
    'Show.E03.1080p.ass'
  ], 5, false);

  assert.equal(selected, 'Show.S02E05.1080p.ass');
});

test('subtitle archive rejects an explicitly numbered file for a different episode', () => {
  const matching = setup();
  const selected = matching.selectCommunitySubtitleCandidate(['Show.E01.ass'], 2, false);

  assert.equal(selected, null);
});

test('direct episode posts may still supply one unnumbered subtitle file', () => {
  const matching = setup();
  const selected = matching.selectCommunitySubtitleCandidate(['subtitle.ass'], 2, false);

  assert.equal(selected, 'subtitle.ass');
});

test('codec bit depth and audio channel metadata are not treated as episode numbers', () => {
  const matching = setup();
  const selected = matching.selectCommunitySubtitleCandidate(['Show.10bit.5.1.ass'], 2, false);

  assert.equal(selected, 'Show.10bit.5.1.ass');
});

test('unnumbered season bundles are used only for episode one and prefer the largest subtitle', () => {
  const matching = setup(), candidates = ['small.ass', 'large.srt'];
  const size = file => file === 'large.srt' ? 900 : 100;

  assert.equal(matching.selectCommunitySubtitleCandidate(candidates, 1, true, size), 'large.srt');
  assert.equal(matching.selectCommunitySubtitleCandidate(candidates, 2, true, size), null);
});

test('file episode parsing keeps S02E05 and ignores a hexadecimal CRC tag', () => {
  const matching = setup();
  assert.equal(matching.communityFileMatches('Show.S02E05.[5A2B3C4D].ass', 5), true);
  assert.equal(matching.communityFileMatches('Show.S02E05.[5A2B3C4D].ass', 2), false);
  assert.deepEqual([...matching.communityFileEpisodeNumbers('Show.[5A2B3C4D].ass')], []);
});
