const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} exists`);
  return source.slice(start, end);
}

const subtitleDecoders = sourceBetween(mainSource,
  '// Korean SRT/SMI files are often CP949 or UTF-16 rather than UTF-8.',
  '// Korean titles for Re:ANIME entries', 'subtitle converters');
const subtitleResult = sourceBetween(mainSource, 'function subtitleResult(',
  '\n// Downloads a remote VTT/SRT/ASS subtitle', 'subtitle result mapper');
const subtitlePicker = sourceBetween(mainSource, "ipcMain.handle('file:subtitle', async () => {",
  '\n  // Default ASS font:', 'user subtitle picker IPC');
const subtitleAttachment = sourceBetween(appSource,
  'let currentSubtitle=null,subtitleFontPromise=null,manualChatgptTranslation=null,manualChatgptPanelOpen=false;',
  '// A series whose Korean subtitle (a fansub, the site\'s Korean track) the user set aside', 'renderer subtitle attachment');
const openSubtitleClick = sourceBetween(appSource, "$('#openSubtitle').onclick=async()=>{",
  "\n$('#findSubtitle').onclick", 'open subtitle button handler');

async function withTempDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-user-subtitle-flow-'));
  try { await run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function makeTrack(video) {
  const listeners = new Map();
  return {
    kind: '', label: '', srclang: '', src: '', default: false, mode: 'disabled',
    addEventListener(name, listener) { listeners.set(name, listener); },
    remove() { video.textTracks = video.textTracks.filter(track => track !== this); video.children = video.children.filter(track => track !== this); },
    fire(name) { listeners.get(name)?.(); }
  };
}

test('user subtitle picker copies ASS, hands it to JASSUB, and ignores stale dialog results', async () => {
  await withTempDirectory(async directory => {
    const sourceDirectory = path.join(directory, 'source');
    const userData = path.join(directory, 'app-data');
    fs.mkdirSync(sourceDirectory);
    const sourceAss = path.join(sourceDirectory, 'episode.ass');
    const sourceFont = path.join(sourceDirectory, 'Malgun Gothic.ttf');
    const assText = '[Events]\r\nFormat: Start, End, Text\r\nDialogue: 0:00:01.00,0:00:03.00,한국어 자막\r\n';
    fs.writeFileSync(sourceAss, Buffer.from(`\uFEFF${assText}`, 'utf16le'));
    fs.writeFileSync(sourceFont, Buffer.from('synthetic font asset'));

    const handlers = new Map();
    let dialogOptions;
    const mainContext = vm.createContext({
      fs, path, TextDecoder, pathToFileURL,
      app: { getPath: name => name === 'userData' ? userData : directory },
      dialog: { showOpenDialog: async options => { dialogOptions = options; return { canceled: false, filePaths: [sourceAss] }; } },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
    });
    vm.runInContext(subtitleDecoders, mainContext);
    vm.runInContext(subtitleResult, mainContext);
    vm.runInContext(subtitlePicker, mainContext);

    const picker = handlers.get('file:subtitle');
    assert.equal(typeof picker, 'function');
    const selected = await picker();
    assert.deepEqual(Array.from(dialogOptions.filters[0].extensions), ['vtt', 'srt', 'ass', 'ssa', 'smi', 'sami']);
    assert.equal(selected.path.endsWith(`${path.sep}episode.vtt`), true);
    assert.equal(selected.assPath.endsWith(`${path.sep}episode.ass`), true);
    assert.equal(selected.assUrl, pathToFileURL(selected.assPath).href);
    assert.equal(fs.readFileSync(selected.path, 'utf8').includes('한국어 자막'), true);
    assert.equal(fs.readFileSync(sourceAss).equals(Buffer.from(`\uFEFF${assText}`, 'utf16le')), true, 'source subtitle is preserved');
    assert.equal(fs.readFileSync(path.join(path.dirname(selected.assPath), 'Malgun Gothic.ttf'), 'utf8'), 'synthetic font asset');
    assert.equal(Array.from(selected.fonts).length, 1);

    const video = {
      textTracks: [], children: [],
      append(track) { this.textTracks.push(track); this.children.push(track); },
      querySelectorAll(selector) { return selector === 'track' ? [...this.children] : []; }
    };
    const openButton = {};
    const elements = new Map([
      ['#video', video], ['#openSubtitle', openButton], ['#subtitleEnabled', { checked: true }],
      ['#subtitleState', { textContent: '' }]
    ]);
    const jassubCalls = [], remembered = [], toasts = [];
    const uiContext = vm.createContext({
      window: { lilac: {
        chooseSubtitleDetails: async () => selected,
        defaultSubtitleFont: async () => ({ family: 'Malgun Gothic', data: Uint8Array.of(1, 2, 3) })
      }, LilacAss: {
        destroy() {},
        async attach(target, options) { jassubCalls.push({ target, options }); return true; }
      } },
      localStorage: { getItem: key => key === 'assEffects' ? 'true' : key === 'subtitleSync' ? '125' : null },
      document: { createElement: name => name === 'track' ? makeTrack(video) : { textContent: '', innerHTML: '' } },
      $: selector => elements.get(selector) || { textContent: '', checked: false },
      fetch: () => Promise.reject(new Error('offline fixture; no network fetch allowed')),
      currentPlaybackContext: { koreanFound: false }, currentSubtitlePath: null,
      playbackRequestId: 1, subtitleSelectionRequestId: 0,
      KOREAN_SOURCES: ['kairan', 'csora', 'anissia', 'linkkf'], translating: null,
      applyVttLayout() {}, toast: message => toasts.push(message),
      rememberSubtitle: subtitle => remembered.push(subtitle), renderSubtitleSheet() {},
      renderDiscoveredFonts() {}, translatingNow: () => false, showTranslatedLines() {}
    });
    uiContext.beginSubtitleSelection = () => ++uiContext.subtitleSelectionRequestId;
    vm.runInContext(`${subtitleAttachment}\n${openSubtitleClick}\n`+
      'globalThis.getCurrentSubtitle = () => currentSubtitle; globalThis.advanceSubtitleSelection = () => ++subtitleSelectionRequestId;', uiContext);
    await openButton.onclick();
    await new Promise(resolve => setImmediate(resolve));

    const attachedSubtitle = uiContext.getCurrentSubtitle();
    assert.equal(uiContext.currentSubtitlePath, selected.path);
    assert.equal(attachedSubtitle.source, 'user');
    assert.equal(attachedSubtitle.path, selected.path);
    assert.equal(attachedSubtitle.assPath, selected.assPath);
    assert.equal(video.children.length, 1);
    assert.equal(video.children[0].src, selected.url);
    assert.equal(video.children[0].kind, 'subtitles');
    assert.equal(video.children[0].srclang, 'ko');
    assert.equal(attachedSubtitle.assRendering, true);
    assert.equal(video.textTracks[0].mode, 'hidden', 'the simple WebVTT fallback does not duplicate the ASS overlay');
    assert.equal(jassubCalls.length, 1);
    assert.equal(jassubCalls[0].target, video);
    assert.equal(jassubCalls[0].options.subUrl, selected.assUrl);
    assert.deepEqual(Array.from(jassubCalls[0].options.fonts), Array.from(selected.fonts));
    assert.equal(jassubCalls[0].options.offsetMs, 125);
    assert.equal(remembered.length, 1);

    video.children[0].fire('load');
    assert.match(elements.get('#subtitleState').textContent, /사용자 자막 적용됨 · ASS 효과/);
    assert.equal(toasts.length, 1);

    const appliedBeforeStaleResults = uiContext.getCurrentSubtitle();
    let releasePicker;
    uiContext.window.lilac.chooseSubtitleDetails = () => new Promise(resolve => { releasePicker = resolve; });
    const staleAfterSourceChange = openButton.onclick();
    uiContext.advanceSubtitleSelection();
    releasePicker({ ...selected, path: path.join(directory, 'older.ass') });
    await staleAfterSourceChange;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(uiContext.getCurrentSubtitle(), appliedBeforeStaleResults, 'a newer subtitle choice wins');
    assert.equal(uiContext.currentSubtitlePath, selected.path);
    assert.equal(video.children.length, 1);
    assert.equal(jassubCalls.length, 1);

    const staleAfterEpisodeChange = openButton.onclick();
    uiContext.playbackRequestId++;
    releasePicker({ ...selected, path: path.join(directory, 'previous-episode.ass') });
    await staleAfterEpisodeChange;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(uiContext.getCurrentSubtitle(), appliedBeforeStaleResults, 'a result from the previous episode is discarded');
    assert.equal(uiContext.currentSubtitlePath, selected.path);
    assert.equal(video.children.length, 1);
    assert.equal(jassubCalls.length, 1);
  });
});

test('user subtitle picker prevents overlapping dialogs and recovers after an IPC error', async () => {
  const button = { disabled: false };
  const messages = [], attached = [];
  let calls = 0, rejectDialog;
  const context = vm.createContext({
    window: { lilac: { chooseSubtitleDetails: () => {
      calls++;
      return new Promise((_, reject) => { rejectDialog = reject; });
    } } },
    $: selector => selector === '#openSubtitle' ? button : null,
    playbackRequestId: 1, subtitleSelectionRequestId: 0, currentSubtitlePath: null,
    beginSubtitleSelection: () => ++context.subtitleSelectionRequestId,
    attachSubtitle: (...args) => attached.push(args), toast: message => messages.push(message)
  });
  vm.runInContext(openSubtitleClick, context);

  const pending = button.onclick();
  assert.equal(button.disabled, true, 'the picker is disabled while the native dialog is open');
  await button.onclick();
  assert.equal(calls, 1, 'a second click cannot open a second native dialog');

  rejectDialog(new Error('synthetic IPC failure'));
  await pending;
  assert.equal(button.disabled, false, 'the picker is re-enabled after failure');
  assert.deepEqual(messages, ['사용자 자막을 열지 못했습니다. 파일을 다시 선택해 주세요.']);
  assert.deepEqual(attached, []);
  assert.equal(context.currentSubtitlePath, null);
});
