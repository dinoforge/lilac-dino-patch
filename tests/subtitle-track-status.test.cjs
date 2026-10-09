const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const start = appSource.indexOf('function isKoreanTrack(track)');
const end = appSource.indexOf('// Korean translation', start);
assert.ok(start >= 0 && end > start, 'Subtitle track UI section exists');
const trackSource = appSource.slice(start, end);

function element() {
  const classes = new Set();
  return {
    attributes: {}, children: [], classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    replaceChildren(...items) { this.children = items; },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function harness(provider, tracks = [], providerSubtitleTracks = async () => ({ tracks: [] })) {
  const selectors = [
    '#subtitleTracks', '#subtitleTrackList', '#subtitleTracks .sheet-tracks-head b',
    '#psSubtitleSources [data-source="linkkf"]', '#psSubtitleSources [data-source="reanime"]',
    '#subtitleTrackState', '#reloadSubtitleTracks'
  ];
  const elements = new Map(selectors.map(selector => [selector, element()]));
  const sourceLabel = element();
  const sourceButton = { ...element(), querySelector: () => sourceLabel };
  let calls = 0;
  const context = vm.createContext({
    currentPlaybackContext: { episode: { provider }, subtitleTracks: tracks, subtitleTrackStatus: tracks.length ? 'loaded' : 'idle' },
    playbackRequestId: 1,
    window: { lilac: { providerSubtitleTracks: async episode => { calls++; return providerSubtitleTracks(episode); } } },
    $: selector => elements.get(selector) || element(),
    $$: () => [sourceButton],
    openSheet: () => 'reanime',
    escapeHtml: value => String(value),
    selectSubtitleTrack() {},
    document: { createElement: () => element() }
  });
  vm.runInContext(`${trackSource}\nglobalThis.renderTracks = renderSubtitleTracks; globalThis.loadTracks = loadMissingSubtitleTracks;`, context);
  return { context, elements, calls: () => calls };
}

test('Miruro empty track list is reported as empty and has no unsupported retry', async () => {
  const h = harness('miruro');
  h.context.currentPlaybackContext.subtitleTrackStatus = 'loaded';
  h.context.renderTracks();
  assert.equal(h.elements.get('#subtitleTrackState').textContent, '이 회차에는 선택 가능한 자막 트랙이 없습니다.');
  assert.equal(h.elements.get('#reloadSubtitleTracks').classList.contains('hidden'), true);
  await h.context.loadTracks();
  assert.equal(h.calls(), 0);
});

test('Re:Anime distinguishes an empty response from a failed request and can retry', async () => {
  let shouldFail = true;
  const h = harness('reanime', [], async () => {
    if (shouldFail) throw new Error('temporary provider failure');
    return { tracks: [], referer: 'https://example.invalid/' };
  });

  await h.context.loadTracks();
  assert.equal(h.context.currentPlaybackContext.subtitleTrackStatus, 'error');
  assert.match(h.elements.get('#subtitleTrackState').textContent, /불러오지 못했습니다/);
  assert.equal(h.elements.get('#reloadSubtitleTracks').classList.contains('hidden'), false);

  shouldFail = false;
  await h.context.loadTracks();
  assert.equal(h.calls(), 2);
  assert.equal(h.context.currentPlaybackContext.subtitleTrackStatus, 'loaded');
  assert.equal(h.elements.get('#subtitleTrackState').textContent, '이 회차에는 선택 가능한 자막 트랙이 없습니다.');
  assert.equal(h.elements.get('#reloadSubtitleTracks').classList.contains('hidden'), false);
});

test('available tracks remain selectable and hide retry', () => {
  const h = harness('reanime', [{ url: 'https://example.invalid/ko.vtt', label: '한국어', language: 'ko', format: 'vtt' }]);
  h.context.renderTracks();
  assert.equal(h.elements.get('#subtitleTrackState').textContent, '1개 트랙');
  assert.equal(h.elements.get('#subtitleTrackList').children.length, 1);
  assert.equal(h.elements.get('#reloadSubtitleTracks').classList.contains('hidden'), true);
});
