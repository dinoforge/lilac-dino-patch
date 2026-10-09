const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const manualSubtitle = require('../src/manual-subtitle-translation.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('src/index.html');
const app = read('src/app.js');
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
const store = read('electron/subtitle-store.cjs');

test('player has an explicit ChatGPT copy and paste workflow', () => {
  for (const id of ['translateChatgpt', 'manualChatgptCopyOpen', 'manualChatgptAnswer', 'manualChatgptApply', 'manualChatgptCancel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /manual-subtitle-translation\.js[\s\S]*app\.js/);
  assert.match(app, /copyText\(prompt\)/);
  assert.match(app, /openExternal\('https:\/\/chatgpt\.com\/'\)/);
  assert.match(app, /saveManualSubtitle\(/);
  assert.match(app, /'gemini','chatgpt','user','jimaku'\]\.includes\(source\)\|\|currentPlaybackContext\.siteKorean/);
  assert.match(app, /'gemini','chatgpt'/);
});

test('ChatGPT workflow writes only to the clipboard and never submits or calls a translation API', () => {
  assert.match(preload, /copyText:\s*text\s*=>\s*ipcRenderer\.invoke\('clipboard:copy-text',\s*text\)/);
  assert.match(main, /ipcMain\.handle\('clipboard:copy-text'/);
  assert.match(main, /clipboard\.writeText\(text\)/);
  assert.doesNotMatch(main, /clipboard\.readText/);
  assert.doesNotMatch(app, /generativelanguage\.googleapis\.com|api\.openai\.com/);
});

test('manual results are validated as WebVTT and saved under the ChatGPT subtitle source', () => {
  assert.match(main, /subtitle:manual-save/);
  assert.match(main, /WEBVTT/);
  assert.match(main, /subtitles','translated'/);
  assert.match(main, /source:'chatgpt'/);
  assert.match(preload, /saveManualSubtitle:\s*input\s*=>\s*ipcRenderer\.invoke\('subtitle:manual-save',\s*input\)/);
  assert.match(store, /'chatgpt'/);
  assert.match(app, /chatgpt:'ChatGPT 번역'/);
});

test('keeps a completed translation retryable when saving the subtitle fails', async () => {
  const start = app.indexOf('async function saveManualChatgptResult(state){');
  const end = app.indexOf("\n$('#translateChatgpt')", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const parsed = manualSubtitle.parseWebVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n原文\n');
  const state = { parsed, batches: manualSubtitle.makeBatches(parsed.cues), index: 0, translations: {}, requestId: 7, sourcePath: 'source.vtt', sourceLabel: '원본 자막', episodeKey: 'reanime:1', busy: false };
  const controls = new Map([
    ['#manualChatgptAnswer', { value: '{"translations":[{"id":1,"text":"번역"}]}' }],
    ['#manualChatgptStatus', { textContent: '' }],
    ['#subtitleState', { textContent: '' }]
  ]);
  let saveAttempts = 0, parseAttempts = 0, attached = null;
  const context = {
    manualChatgptTranslation: state,
    manualChatgptPanelOpen: true,
    currentSubtitle: { path: state.sourcePath },
    currentSubtitlePath: state.sourcePath,
    currentPlaybackContext: {},
    playbackRequestId: state.requestId,
    subtitleStoreKey: () => state.episodeKey,
    manualChatgptIsCurrent: value => Boolean(value && value.requestId === context.playbackRequestId && value.sourcePath === context.currentSubtitle.path && value.episodeKey === state.episodeKey),
    window: {
      LilacManualSubtitle: { ...manualSubtitle, parseResponse: (...args) => { parseAttempts++; return manualSubtitle.parseResponse(...args); } },
      lilac: { saveManualSubtitle: async () => { if (++saveAttempts === 1) throw new Error('disk full'); return { path: 'translated.vtt', url: 'subtitle://translated.vtt' }; } }
    },
    $: selector => controls.get(selector),
    renderManualChatgptPanel() {},
    attachSubtitle(...args) { attached = args; }
  };
  vm.runInNewContext(`${app.slice(start, end)}\nthis.applyManualChatgptBatch=applyManualChatgptBatch;`, context);

  await context.applyManualChatgptBatch();
  assert.equal(state.index, state.batches.length);
  assert.equal(state.translations[1], '번역');
  assert.equal(state.busy, false);
  assert.match(controls.get('#manualChatgptStatus').textContent, /다시 시도할 수 있습니다/);
  assert.equal(saveAttempts, 1);
  assert.equal(parseAttempts, 1);

  await context.applyManualChatgptBatch();
  assert.equal(saveAttempts, 2);
  assert.equal(parseAttempts, 1);
  assert.equal(context.manualChatgptTranslation, null);
  assert.equal(attached[1], 'ChatGPT 수동 번역');
  assert.equal(controls.get('#subtitleState').textContent, 'ChatGPT 수동 번역을 적용했습니다.');
});
