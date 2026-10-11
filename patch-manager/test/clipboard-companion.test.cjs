'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerPatch0102Handlers } = require('../../electron/patch-manager-stage2.cjs');
const { parseWebVtt, parseResponse, renderWebVtt } = require('../../src/manual-subtitle-translation.js');
const { makeLilacAnimeV0514Manifest } = require('../adapters/lilacanime-v0.5.14.cjs');

function isolatedClipboardHandlers(clipboard) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-clipboard-companion-'));
  const handlers = new Map();
  try {
    registerPatch0102Handlers({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      app: { getPath: name => { assert.equal(name, 'userData'); return root; } },
      subtitleStore: { save: () => true },
      clipboard,
      shell: { showItemInFolder: () => {} }
    });
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  return { handlers, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('clipboard is read only on explicit IPC invocation; there is no background polling', () => {
  let reads = 0;
  const expected = '{"translations":[{"id":1,"text":"안녕"}]}';
  const fixture = isolatedClipboardHandlers({
    writeText: () => {},
    readText: () => { reads++; return expected; }
  });
  try {
    assert.equal(reads, 0);
    const handler = fixture.handlers.get('patch:clipboard-read');
    assert.equal(typeof handler, 'function');
    assert.equal(handler(), expected);
    assert.equal(reads, 1);
  } finally { fixture.cleanup(); }
});

test('clipboard read rejects empty, oversized, and unavailable content', () => {
  let clipboardText = ' ';
  const clipboard = { writeText: () => {}, readText: () => clipboardText };
  const fixture = isolatedClipboardHandlers(clipboard);
  try {
    const handler = fixture.handlers.get('patch:clipboard-read');
    assert.throws(() => handler(), /비어 있습니다/);
    clipboardText = 'X'.repeat(2_000_001);
    assert.throws(() => handler(), /너무 큽니다/);
    delete clipboard.readText;
    assert.throws(() => handler(), /읽을 수 없습니다/);
  } finally { fixture.cleanup(); }
});

test('validated ChatGPT clipboard response preserves original subtitle timecodes', () => {
  const source = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:00:03.000 --> 00:00:04.000\nGoodbye\n';
  const parsed = parseWebVtt(source);
  const response = '{"translations":[{"id":1,"text":"안녕하세요"},{"id":2,"text":"안녕히 가세요"}]}';
  const output = renderWebVtt(parsed, parseResponse(response, [1, 2]));
  assert.match(output, /00:00:01\.000 --> 00:00:02\.000\n안녕하세요/);
  assert.match(output, /00:00:03\.000 --> 00:00:04\.000\n안녕히 가세요/);
  assert.throws(() => parseResponse('{"translations":[{"id":999,"text":"아님"}]}', [1, 2]), /번역 ID/);
});

test('v0.5.14 preload exposes the bridge and renderer keeps clipboard import user-driven', () => {
  const manifest = makeLilacAnimeV0514Manifest();
  const preloadAction = manifest.actions.find(action => action.file === 'electron/preload.cjs');
  assert.match(preloadAction.content, /patchReadText: \(\) => ipcRenderer\.invoke\('patch:clipboard-read'\)/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'patch-manager-stage2.js'), 'utf8');
  assert.match(renderer, /patch0102ManualImport/);
  assert.match(renderer, /addEventListener\('click', importClipboard\)/);
  assert.match(renderer, /manual\.parseResponse\(response, value\.batches\[value\.index\]/);
  assert.match(renderer, /await apply\(\)/);
});
