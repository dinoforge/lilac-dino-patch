const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { keepLine, quietCut, vttOf } = require('../electron/whisper.cjs');
const { SubtitleStore } = require('../electron/subtitle-store.cjs');

test('sound captions, made-up endings, loops and one repeated sign are left out', () => {
  const recent = [];
  const kept = ['(音楽)', '♪~', '（拍手）', 'ご視聴ありがとうございました', 'この世は腐ってる', 'この世は腐ってる', 'まったくくだらねえ', 'この世は腐ってる', 'あああああ', '毎日毎日']
    .filter(text => keepLine(text, recent));
  assert.deepEqual(kept, ['この世は腐ってる', 'まったくくだらねえ', '毎日毎日']);
});
test('a piece is cut at the quietest moment between 18 and 30 seconds', () => {
  const samples = new Int16Array(16000 * 40).map((_, i) => Math.round(Math.sin(i / 7) * 8000));
  samples.fill(0, 16000 * 24, 16000 * 24 + 8000); // half a second of silence at 24 s
  const at = quietCut(samples, 18, 30) / 16000;
  assert.ok(at > 24 && at < 24.5, `cut at ${at}`);
});
test('the subtitle is written in time order', () => {
  const vtt = vttOf([{ start: 61.5, end: 63, text: 'B' }, { start: 2, end: 2.1, text: 'A' }]);
  assert.match(vtt, /^WEBVTT\n\n00:00:02\.000 --> 00:00:02\.500\nA\n\n00:01:01\.500 --> 00:01:03\.000\nB\n/);
});
test('saving a Whisper subtitle preserves legacy ChatGPT and other episode records', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-subtitle-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'isolated-userData'), files = path.join(root, 'samples');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(files, { recursive: true });
  const managedWhisperDir = path.join(userData, 'subtitles', 'whisper');
  fs.mkdirSync(managedWhisperDir, { recursive: true });
  const legacyPath = path.join(files, 'legacy-chatgpt.vtt'), providerPath = path.join(files, 'provider.vtt'), whisperPath = path.join(managedWhisperDir, 'whisper.vtt');
  fs.writeFileSync(legacyPath, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nlegacy subtitle\n');
  fs.writeFileSync(providerPath, 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nprovider subtitle\n');
  fs.writeFileSync(whisperPath, 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nrecognized speech\n');
  const key = encodeURIComponent('https://example.invalid/episode/7');
  const legacy = { id: 'legacy-chatgpt', source: 'chatgpt', label: 'ChatGPT 번역 자막', path: legacyPath, saved: 100, converter: 2 };
  const provider = { id: 'provider', source: 'provider', label: '사이트 자막', path: providerPath, saved: 90, converter: 2 };
  const storeFile = path.join(userData, 'subtitle-store.json');
  fs.writeFileSync(storeFile, JSON.stringify({ [key]: [legacy, provider] }));
  const app = { getPath: name => { assert.equal(name, 'userData'); return userData; } };

  const store = new SubtitleStore({ app });
  const before = store.list(key);
  assert.deepEqual(before.map(entry => entry.source), ['chatgpt', 'provider']);
  assert.match(fs.readFileSync(before[0].path, 'utf8'), /legacy subtitle/);
  assert.match(before[0].url, /^file:/);
  assert.equal(store.save(key, { source: 'whisper', label: 'Whisper 일본어 자막', path: whisperPath }).source, 'whisper');

  const reloaded = new SubtitleStore({ app });
  const after = reloaded.list(key);
  assert.deepEqual(after.map(entry => entry.source), ['whisper', 'chatgpt', 'provider']);
  const savedLegacy = after.find(entry => entry.source === 'chatgpt');
  for (const field of Object.keys(legacy)) assert.equal(savedLegacy[field], legacy[field], `legacy ${field} is unchanged`);
  assert.match(fs.readFileSync(savedLegacy.path, 'utf8'), /legacy subtitle/);
  assert.match(fs.readFileSync(after.find(entry => entry.source === 'whisper').path, 'utf8'), /recognized speech/);
  assert.match(after.find(entry => entry.source === 'whisper').url, /^file:/);
  assert.equal(fs.existsSync(legacyPath), true);
  assert.equal(fs.existsSync(providerPath), true);

  reloaded.save(key, { source: 'whisper', label: 'Whisper 일본어 자막', path: whisperPath });
  assert.equal(new SubtitleStore({ app }).list(key).filter(entry => entry.source === 'whisper').length, 1, 'same-source same-path saves replace only that source record');
  assert.equal(new SubtitleStore({ app }).list(key).some(entry => entry.source === 'chatgpt'), true);

  const sharedKey = encodeURIComponent('https://example.invalid/episode/shared');
  reloaded.data[sharedKey] = [{ ...legacy, id: 'shared-chatgpt', path: whisperPath }];
  reloaded.write();
  const sharedWhisper = reloaded.save(sharedKey, { source: 'whisper', label: 'Whisper 일본어 자막', path: whisperPath });
  assert.deepEqual(new SubtitleStore({ app }).list(sharedKey).map(entry => entry.source), ['whisper', 'chatgpt'], 'source remains part of the episode record identity even for a shared file');
  assert.equal(new SubtitleStore({ app }).remove(sharedKey, sharedWhisper.id), true);
  assert.equal(fs.existsSync(whisperPath), true, 'removing Whisper does not delete a file still referenced by the ChatGPT record');
  assert.deepEqual(new SubtitleStore({ app }).list(sharedKey).map(entry => entry.source), ['chatgpt']);

  const newChatgptPath = path.join(files, 'new-chatgpt.vtt');
  fs.writeFileSync(newChatgptPath, 'WEBVTT\n');
  assert.equal(reloaded.save('new-chatgpt-entry', { source: 'chatgpt', path: newChatgptPath }).source, 'user', 'new retired ChatGPT saves do not re-enable the old web workflow');
});

test('automatic Whisper is enabled by default and can be turned off', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/whisper.js'), 'utf8');
  const expression = source.match(/const whisperAuto = \(\) => ([^;]+);/)?.[1];
  assert.ok(expression, 'automatic Whisper preference exists');
  const context = vm.createContext({ localStorage: { getItem: () => null } });
  assert.equal(vm.runInContext(expression, context), true);
  context.localStorage.getItem = () => 'false';
  assert.equal(vm.runInContext(expression, context), false);
});

test('a saved Whisper subtitle is not applied until the official runtime and model are available', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/whisper.js'), 'utf8');
  const start = source.indexOf('async function startWhisper(manual = false) {');
  const end = source.indexOf('\n// Into Korean', start);
  assert.ok(start >= 0 && end > start, 'startWhisper source exists');
  const entry = { source: 'whisper', path: 'saved-whisper.vtt', url: 'file:///saved-whisper.vtt' };
  let statusCalls = 0, savedCalls = 0, applied = null, translated = null;
  const context = vm.createContext({
    whisperRun: null, whisperRunning: () => false, subtitleStoreKey: () => 'episode-key', playbackRequestId: 5,
    currentPlaybackContext: { currentUrl: 'https://example.invalid/episode.m3u8' },
    window: { lilac: {
      savedSubtitles: async key => { savedCalls++; assert.equal(key, 'episode-key'); return [entry]; },
      whisperStatus: async () => { statusCalls++; return { runtime: false, models: [] }; }
    } },
    applySavedSubtitle: value => { applied = value; },
    translateWhisper: (file, manual) => { translated = { file, manual }; }
  });
  vm.runInContext(source.slice(start, end), context);

  assert.equal(await context.startWhisper(false), false);
  assert.equal(statusCalls, 1);
  assert.equal(savedCalls, 0, 'saved captions are checked only after runtime/model availability');
  assert.equal(applied, null);
  assert.equal(translated, null);
});

test('a saved Whisper subtitle is reused after runtime and model validation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/whisper.js'), 'utf8');
  const start = source.indexOf('async function startWhisper(manual = false) {');
  const end = source.indexOf('\n// Into Korean', start);
  const entry = { source: 'whisper', path: 'saved-whisper.vtt', url: 'file:///saved-whisper.vtt' };
  let statusCalls = 0, savedCalls = 0, applied = null, translated = null;
  const context = vm.createContext({
    whisperRun: null, whisperRunning: () => false, subtitleStoreKey: () => 'episode-key', playbackRequestId: 5,
    currentPlaybackContext: { currentUrl: 'https://example.invalid/episode.m3u8' },
    window: { lilac: {
      savedSubtitles: async key => { savedCalls++; assert.equal(key, 'episode-key'); return [entry]; },
      whisperStatus: async () => { statusCalls++; return { runtime: true, model: 'small', models: [{ id: 'small', installed: true }] }; }
    } },
    applySavedSubtitle: value => { applied = value; },
    translateWhisper: (file, manual) => { translated = { file, manual }; }
  });
  vm.runInContext(source.slice(start, end), context);

  assert.equal(await context.startWhisper(false), true);
  assert.equal(statusCalls, 1);
  assert.equal(savedCalls, 1);
  assert.equal(applied, entry);
  assert.deepEqual(translated, { file: 'saved-whisper.vtt', manual: false });
});

test('a saved Whisper result is selectable through the existing subtitle attachment path', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const start = appSource.indexOf('function applySavedSubtitle(entry)');
  const end = appSource.indexOf('\n// The subtitle sheet:', start);
  assert.ok(start >= 0 && end > start, 'applySavedSubtitle source exists');
  const entry = { source: 'whisper', label: 'Whisper 일본어 자막', path: 'saved-whisper.vtt', url: 'file:///saved-whisper.vtt', from: 'input.vtt', fromName: 'Whisper' };
  const attached = [];
  const context = vm.createContext({
    currentPlaybackContext: { subtitleTracks: [] },
    attachSubtitle: (...args) => attached.push(args)
  });
  vm.runInContext(appSource.slice(start, end), context);

  context.applySavedSubtitle(entry);

  assert.equal(context.currentSubtitlePath, entry.path);
  assert.equal(attached.length, 1);
  assert.equal(attached[0][0], entry.url);
  assert.equal(attached[0][1], entry.label);
  assert.equal(attached[0][2].path, entry.path);
  assert.equal(attached[0][2].source, 'whisper');
  assert.equal(attached[0][2].from, entry.from);
  assert.equal(attached[0][2].fromName, entry.fromName);
  assert.equal(attached[0][2].saved, true);
});

test('a Whisper result saves beside another active subtitle without replacing it', async () => {
  const whisperSource = fs.readFileSync(path.join(__dirname, '../src/whisper.js'), 'utf8');
  const start = whisperSource.indexOf('async function startWhisper(manual = false) {');
  const end = whisperSource.indexOf('\n// Into Korean', start);
  assert.ok(start >= 0 && end > start, 'startWhisper source exists');
  const key = 'episode-key', saved = [], rendered = [], saves = [], reads = [];
  const context = vm.createContext({
    whisperRun: null, whisperRunId: 0, whisperRunning: () => false,
    subtitleStoreKey: () => key, playbackRequestId: 8,
    currentPlaybackContext: { currentUrl: 'https://example.invalid/episode.m3u8', streamHeaders: {}, savedSubtitleEntries: [] },
    currentSubtitle: { source: 'provider', path: 'provider.vtt' }, currentSubtitlePath: 'provider.vtt',
    playbackDuration: () => 600, pressSubtitleSource() {}, renderSubtitleSheet() {}, showWhisperProgress() {},
    stopWhisperLive() {}, translateWhisper() {}, autoTranslateProvider: () => null, autoProvider: () => null,
    renderSavedSubtitleList: entries => rendered.push(entries.map(entry => entry.source)),
    window: { lilac: {
      savedSubtitles: async requestedKey => { reads.push(requestedKey); return [...saved]; },
      whisperStatus: async () => ({ runtime: true, model: 'small', models: [{ id: 'small', installed: true }] }),
      geminiSettings: async () => ({}),
      whisperTranscribe: async () => ({ path: 'whisper-result.vtt', url: 'file:///whisper-result.vtt', lines: 4 }),
      saveSubtitle: async (requestedKey, entry) => {
        saves.push({ requestedKey, entry });
        saved.unshift({ ...entry, source: 'whisper', id: 'saved-whisper' });
        return saved[0];
      }
    } },
    $: selector => selector === '#video' ? { currentTime: 0 } : { textContent: '' }
  });
  vm.runInContext(whisperSource.slice(start, end), context);

  assert.equal(await context.startWhisper(false), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(saves.length, 1);
  assert.equal(saves[0].requestedKey, key);
  assert.equal(saves[0].entry.source, 'whisper');
  assert.equal(context.currentPlaybackContext.savedSubtitleEntries.some(entry => entry.source === 'whisper'), false);
  assert.deepEqual(reads, [key]);
  assert.deepEqual(rendered, []);
  assert.equal(context.currentSubtitlePath, 'provider.vtt', 'the active subtitle remains selected');
});
