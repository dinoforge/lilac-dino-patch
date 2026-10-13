'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, session } = require('electron');
const { assertIsolatedTarget } = require('../dino-lilac-patch/isolated-target.cjs');

const targetRoot = process.env.DINO_PATCH02_E2E_TARGET || '';
const tempRoot = process.env.DINO_PATCH02_E2E_ROOT || '';
const expectedTemp = fs.realpathSync(os.tmpdir());
if (!targetRoot || !tempRoot) throw new Error('The wrapper must provide an isolated v0.5.15 target and profile directory.');
const target = assertIsolatedTarget(targetRoot);
const tempRelative = path.relative(expectedTemp, fs.realpathSync(tempRoot));
if (!tempRelative || tempRelative.startsWith('..') || path.isAbsolute(tempRelative) ||
    !path.basename(tempRoot).startsWith('dino-patch02-chatgpt-test-')) throw new Error('Refusing a test profile outside the owned temporary directory.');

const userData = path.join(tempRoot, 'userData');
const sessionData = path.join(tempRoot, 'sessionData');
const cache = path.join(tempRoot, 'cache');
for (const directory of [userData, sessionData, cache]) fs.mkdirSync(directory, { recursive: true });
app.setName('Dino Lilac Patch 02 isolated ChatGPT test');
app.setAppUserModelId('org.codex.synthetic.lilac.patch02');
app.setPath('userData', userData);
app.setPath('sessionData', sessionData);
app.setPath('cache', cache);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();

const episodeKey = 'synthetic-show|season-1|episode-2';
const subtitles = new Map();
const subtitleEntries = [];
const saved = [];
const copied = [];
const blockedRequests = [];
const confirmMessages = [];
let embeddedWindow = null;
let rendererWindow = null;
let holdNextResponse = false;
const pageCalls = [];

class MockChatGPTWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.loaded = [];
    this.turns = [];
    this.composer = '';
    this.pending = null;
    this.webContents = {
      session: { setPermissionRequestHandler: () => {} },
      on() {}, setWindowOpenHandler() {}, isDestroyed: () => this.destroyed,
      insertText: async text => { if (this.composer) throw new Error('Composer is not empty'); this.composer = String(text); },
      executeJavaScript: script => this.executePageScript(String(script))
    };
    embeddedWindow = this;
  }
  on() {}
  isDestroyed() { return this.destroyed; }
  async loadURL(url) { this.loaded.push(url); }
  show() {}
  focus() {}
  destroy() { this.destroyed = true; }
  async executePageScript(script) {
    pageCalls.push(script.slice(0, 48));
    if (script.includes('dino-chatgpt-auto:focus')) return true;
    if (script.includes('dino-chatgpt-auto:send')) {
      if (!this.composer || !script.includes(JSON.stringify(this.composer)) || this.pending && !this.pending.turn.response && !this.pending.stopped) return false;
      const prompt = this.composer;
      const marker = '번역할 문장:';
      const position = prompt.lastIndexOf(marker);
      const items = JSON.parse(prompt.slice(position + marker.length).trim());
      const response = JSON.stringify({ translations: items.map(item => ({ id: item.id, text: `모의 번역 ${item.id}` })) });
      const turn = { prompt, response: null };
      this.turns.push(turn);
      this.pending = { turn, response, polls: 0, held: holdNextResponse, stopped: false };
      holdNextResponse = false;
      this.composer = '';
      return true;
    }
    if (script.includes('dino-chatgpt-auto:stop')) {
      if (!this.pending || this.pending.turn.response) return false;
      this.pending.stopped = true;
      return true;
    }
    if (script.includes('dino-chatgpt-auto:clear')) { this.composer = ''; return true; }
    if (!script.includes('dino-chatgpt-auto:inspect')) return false;
    const lastTurn = this.turns[this.turns.length - 1] || null;
    if (this.pending && !this.pending.turn.response && !this.pending.stopped) {
      this.pending.polls++;
      if (!this.pending.held && this.pending.polls >= 3) {
        this.pending.turn.response = this.pending.response;
      }
    }
    const assistantTurns = this.turns.filter(turn => typeof turn.response === 'string');
    return {
      host: 'chatgpt.com', pathname: '/c/isolated-synthetic-thread', loginRequired: false, challenge: false,
      composerCount: 1, composerEmpty: !this.composer.trim(),
      composerMatchesExpected: Boolean(this.composer && script.includes(JSON.stringify(this.composer))),
      sendButtonCount: 1, sendButtonEnabled: true,
      userCount: this.turns.length,
      latestUserMatchesExpected: Boolean(lastTurn && script.includes(JSON.stringify(lastTurn.prompt))),
      assistantCount: assistantTurns.length,
      assistantText: assistantTurns.at(-1)?.response || '',
      generating: Boolean(this.pending && !this.pending.turn.response && !this.pending.stopped)
    };
  }
}

function vtt(language, count, start = 1) {
  const line = language === 'english' ? 'This is synthetic dialogue' : 'これは試験用の台詞です';
  return `WEBVTT\n\n${Array.from({ length: count }, (_, i) => {
    const cue = start + i, seconds = String(cue).padStart(2, '0');
    return `${cue}\n00:00:${seconds}.000 --> 00:00:${seconds}.800\n${line} ${cue}`;
  }).join('\n\n')}\n`;
}

function writeSubtitle(name, text) {
  const file = path.join(userData, name);
  fs.writeFileSync(file, text, { flag: 'wx' });
  subtitles.set(name, { path: file, src: pathToFileURL(file).href, text });
  return subtitles.get(name);
}

function writeHarness(initialSubtitle) {
  const htmlFile = path.join(target, 'src', 'patch-manager-stage2-chatgpt-harness.html');
  const preloadFile = path.join(target, 'src', 'patch-manager-stage2-chatgpt-preload.cjs');
  const source = JSON.stringify({ path: initialSubtitle.path, src: initialSubtitle.src });
  const script = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:14px Arial,sans-serif;background:#101016;color:#f4f2fa;margin:20px}.hidden{display:none!important}
    .setting-block{display:grid;gap:8px}.patch0102-manual-actions{display:flex;gap:6px;flex-wrap:wrap}
    #patch0102ManualAnswer{width:100%;min-height:100px;background:#1a1a24;color:#f4f2fa}
  </style></head><body>
    <section data-settings-pane="translate"><div id="jimakuTranslateChoices"><button data-value="off">끄기</button><button data-value="cloud">번역 API</button><button data-value="local">로컬 AI</button></div></section>
    <div id="subtitleTranslateRow"></div><p id="subtitleState"></p><input id="skipTitle" value="합성 작품"><input id="skipEpisode" value="2"><p id="playerTitle">합성 작품</p>
    <script>
      let currentSubtitle=${source},currentSubtitlePath='',playbackRequestId=1,currentPlaybackContext={subtitleTitle:'합성 작품',episode:{number:2}};
      let activeEpisodeKey='${episodeKey}';
      window.patchFixtureState={confirms:[],allowUncertainResend:false};
      window.confirm=message=>{window.patchFixtureState.confirms.push(String(message));return window.patchFixtureState.allowUncertainResend};
      function subtitleStoreKey(){return activeEpisodeKey}
      function attachSubtitle(src,label,meta){currentSubtitle={src,path:meta.path,label,...meta};currentSubtitlePath=meta.path}
      function clearSubtitle(){currentSubtitle=null;currentSubtitlePath=''}
      window.attachSubtitle=attachSubtitle;window.clearSubtitle=clearSubtitle;
      window.selectTestSubtitle=(name,key)=>{const subtitle=window.testSubtitles[name];activeEpisodeKey=key;window.attachSubtitle(subtitle.src,subtitle.label,{path:subtitle.path,source:subtitle.source})};
      window.testSubtitles=Object.create(null);
      window.addEventListener('error',event=>{window.patchFixtureState.error=event.error?.stack||event.message||'renderer error'});
      window.addEventListener('unhandledrejection',event=>{window.patchFixtureState.error=String(event.reason?.stack||event.reason||'unhandled rejection')});
    </script>
    <script src="patch-manager-feature-flags.js"></script>
    <script src="manual-subtitle-translation.js"></script>
    <script src="patch-manager-stage2.js"></script>
  </body></html>`;
  fs.writeFileSync(htmlFile, script, 'utf8');
  const preload = `'use strict';\nconst {contextBridge,ipcRenderer}=require('electron');\ncontextBridge.exposeInMainWorld('lilac',{
    patchTranslationPrompt:(...args)=>ipcRenderer.invoke('patch:translation-prompt',...args),
    patchCopyText:(...args)=>ipcRenderer.invoke('patch:clipboard-copy',...args),
    patchReadText:(...args)=>ipcRenderer.invoke('patch:clipboard-read',...args),
    patchOpenChatGPTEmbedded:(...args)=>ipcRenderer.invoke('patch:chatgpt-web:open',...args),
    patchChatGPTWebTranslate:(...args)=>ipcRenderer.invoke('patch:chatgpt-web:translate',...args),
    patchCancelChatGPTWebTranslation:(...args)=>ipcRenderer.invoke('patch:chatgpt-web:cancel',...args),
    patchSaveManualSubtitle:(...args)=>ipcRenderer.invoke('patch:manual-subtitle-save',...args),
    patchManualTranslationSettings:(...args)=>ipcRenderer.invoke('manual-translation:settings:get',...args),
    patchSaveManualTranslationSettings:(...args)=>ipcRenderer.invoke('manual-translation:settings:save',...args),
    patchManualTranslationSession:(...args)=>ipcRenderer.invoke('manual-translation:session:get',...args),
    patchSaveManualTranslationSession:(...args)=>ipcRenderer.invoke('manual-translation:session:save',...args),
    patchRemoveManualTranslationSession:(...args)=>ipcRenderer.invoke('manual-translation:session:remove',...args),
    patchHasManualTranslationForSource:(...args)=>ipcRenderer.invoke('manual-translation:translated-exists',...args),
    patchRevealManualSubtitle:(...args)=>ipcRenderer.invoke('manual-translation:subtitle:reveal',...args),
    patchManualTranslationSource:(...args)=>ipcRenderer.invoke('manual-translation:source:get',...args)
});\n`;
  fs.writeFileSync(preloadFile, preload, 'utf8');
  return { htmlFile, preloadFile };
}

function waitFor(label, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (Date.now() > deadline) {
        const state = await rendererWindow?.webContents.executeJavaScript(`({
          status:document.querySelector('#patch0102ManualStatus')?.textContent||'',
          progress:document.querySelector('#patch0102ManualProgress')?.textContent||'',
          answerLength:document.querySelector('#patch0102ManualAnswer')?.value.length||0,
          subtitleState:document.querySelector('#subtitleState')?.textContent||'',
          autoDisabled:document.querySelector('#patch0102WebAutoStart')?.disabled,
          currentSubtitle:currentSubtitle?.path||null,
          error:window.patchFixtureState?.error||null,
          confirms:window.patchFixtureState?.confirms||[]
        })`).catch(error => ({ error: error.message }));
        console.error(`timeout_state_${label}=`, JSON.stringify({
          ...state, turns: embeddedWindow?.turns?.length || 0,
          pageCalls: pageCalls.slice(-8),
          pending: embeddedWindow?.pending && { polls: embeddedWindow.pending.polls, held: embeddedWindow.pending.held,
            responseReady: Boolean(embeddedWindow.pending.turn.response), stopped: embeddedWindow.pending.stopped }
        }));
        return reject(new Error(`Timed out waiting for ${label}`));
      }
      try { if (await predicate()) return resolve(); }
      catch (error) { return reject(new Error(`${label}: ${error?.stack || error}`)); }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function manualResponse(start, count, label) {
  return JSON.stringify({ translations: Array.from({ length: count }, (_, index) => ({ id: start + index, text: `${label} ${start + index}` })) });
}

async function applyManualResponse(response) {
  await rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102ManualAnswer').value=${JSON.stringify(response)};document.querySelector('#patch0102ManualAnswer').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#patch0102ManualApply').click()`);
}

async function run() {
  const japanese = writeSubtitle('source-ja.vtt', vtt('japanese', 30));
  const english = writeSubtitle('source-en.vtt', vtt('english', 30));
  const interrupted = writeSubtitle('source-stop.vtt', vtt('english', 1));
  const harness = writeHarness(japanese);
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/i.test(details.url)) { blockedRequests.push(details.url); callback({ cancel: true }); }
    else callback({});
  });

  const { registerPatch0102Handlers } = require(path.join(target, 'electron', 'patch-manager-stage2.cjs'));
  registerPatch0102Handlers({
    ipcMain: require('electron').ipcMain, app,
    electron: { BrowserWindow: MockChatGPTWindow },
    clipboard: { writeText: text => copied.push(String(text)), readText: () => '' },
    shell: { showItemInFolder() {} },
    subtitleStore: {
      list: key => subtitleEntries.filter(item => item.key === key),
      save: (key, value) => {
        const item = { id: `chatgpt-${saved.length + 1}`, key, ...value, url: pathToFileURL(value.path).href };
        subtitleEntries.unshift(item); saved.push(item); return item;
      }
    }
  }, { 'patch-01': false, 'patch-02': true });

  rendererWindow = new BrowserWindow({
    show: false, width: 1024, height: 720,
    webPreferences: { preload: harness.preloadFile, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const errors = [];
  rendererWindow.webContents.on('render-process-gone', (_event, details) => errors.push(`render-process-gone:${details.reason}`));
  rendererWindow.webContents.on('console-message', event => { if (event.level >= 2) errors.push(event.message); });
  await rendererWindow.loadFile(harness.htmlFile);
  await rendererWindow.webContents.executeJavaScript(`window.testSubtitles={
    english:{path:${JSON.stringify(english.path)},src:${JSON.stringify(english.src)},label:'English',source:'animosub'},
    interrupted:{path:${JSON.stringify(interrupted.path)},src:${JSON.stringify(interrupted.src)},label:'English',source:'animosub'}
  }`);
  await waitFor('Patch 02 controls in official v0.5.15 isolated copy', async () => rendererWindow.webContents.executeJavaScript(`Boolean(document.querySelector('#patch0102ManualStart') && document.querySelector('#patch0102WebAutoStart'))`));
  const toggles = await rendererWindow.webContents.executeJavaScript(`({
    flags:window.DinoLilacPatchFeatures,
    oldModes:[...document.querySelectorAll('#jimakuTranslateChoices button[data-value]')].map(button=>button.dataset.value),
    autoDisabled:document.querySelector('#patch0102WebAutoStart').disabled,
    autoSettingsDisabled:document.querySelector('#patch0102ChatGPTAutoStart').disabled,
    deleteDisabled:document.querySelector('#patch0102ChatGPTDeleteUnavailable').disabled
  })`);
  assert.deepEqual(toggles.flags, { 'patch-01': false, 'patch-02': true, 'patch-03': false });
  assert.deepEqual(toggles.oldModes, ['off', 'cloud', 'local']);
  assert.equal(toggles.autoDisabled, false);
  assert.equal(toggles.autoSettingsDisabled, false);
  assert.equal(toggles.deleteDisabled, true);

  await rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102ManualStart').click()`);
  console.log('Patch 02 manual renderer started');
  await waitFor('manual Japanese subtitle batch preparation', async () => rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102ManualPanel') && !document.querySelector('#patch0102ManualPanel').classList.contains('hidden')`));
  await rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102ManualCopy').click()`);
  await waitFor('manual Japanese request copied and embedded window opened', () => copied.length === 1 && embeddedWindow?.loaded.length === 1);
  assert.match(copied[0], /일본어/);
  const manualInput = await rendererWindow.webContents.executeJavaScript(`({
    progress:document.querySelector('#patch0102ManualProgress').textContent,
    mode:[...document.querySelectorAll('#jimakuTranslateChoices button[data-value]')].map(button=>button.dataset.value)
  })`);
  assert.match(manualInput.progress, /0\/30문장/);
  assert.deepEqual(manualInput.mode, ['off', 'cloud', 'local']);
  await applyManualResponse(manualResponse(1, 24, '수동 번역'));
  await waitFor('manual first batch validated', async () => rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102ManualProgress').textContent.startsWith('24/30문장 (80%) · 묶음 2/2')`));
  await rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102ManualCopy').click()`);
  await waitFor('manual second batch copied', () => copied.length === 2);
  await applyManualResponse(manualResponse(25, 6, '수동 번역'));
  await waitFor('manual WebVTT saved and applied', async () => rendererWindow.webContents.executeJavaScript(`document.querySelector('#subtitleState').textContent.includes('ChatGPT 수동 번역 자막을 저장하고 적용했습니다.')`));
  console.log('Patch 02 manual 30-cue WebVTT saved and applied');
  const manualVtt = fs.readFileSync(saved[0].path, 'utf8');
  assert.equal(saved[0].label, 'ChatGPT 수동 번역');
  assert.equal((manualVtt.match(/--> /g) || []).length, 30);
  assert.match(manualVtt, /수동 번역 1/); assert.match(manualVtt, /수동 번역 30/);
  assert.equal(await rendererWindow.webContents.executeJavaScript(`currentSubtitle.source === 'chatgpt' && currentSubtitle.path === ${JSON.stringify(saved[0].path)}`), true);

  await rendererWindow.webContents.executeJavaScript(`window.selectTestSubtitle('english','synthetic-show|season-1|episode-3');document.querySelector('#patch0102WebAutoStart').click()`);
  console.log('Patch 02 automatic English renderer started');
  await waitFor('automatic English batch sequence saved and applied', async () => rendererWindow.webContents.executeJavaScript(`document.querySelector('#subtitleState').textContent.includes('ChatGPT 웹 자동 번역 자막을 저장하고 적용했습니다.')`), 10_000);
  assert.equal(embeddedWindow.turns.length, 2, 'the 30-cue source is delivered as two ordered UI batches');
  assert.match(embeddedWindow.turns[0].prompt, /영어/);
  assert.match(embeddedWindow.turns[1].prompt, /영어/);
  const autoVtt = fs.readFileSync(saved[1].path, 'utf8');
  assert.equal(saved[1].label, 'ChatGPT 웹 자동 번역');
  assert.equal((autoVtt.match(/--> /g) || []).length, 30);
  assert.match(autoVtt, /모의 번역 1/); assert.match(autoVtt, /모의 번역 30/);
  assert.equal(await rendererWindow.webContents.executeJavaScript(`currentSubtitle.source === 'chatgpt' && currentSubtitle.path === ${JSON.stringify(saved[1].path)}`), true);

  await rendererWindow.webContents.executeJavaScript(`window.selectTestSubtitle('interrupted','synthetic-show|season-1|episode-4');window.patchFixtureState.allowUncertainResend=false`);
  holdNextResponse = true;
  const previousTurnCount = embeddedWindow.turns.length;
  await rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102WebAutoStart').click()`);
  await waitFor('automatic request in flight before user cancellation', () => embeddedWindow.turns.length === previousTurnCount + 1);
  await rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102ManualStop').click()`);
  await waitFor('cancelled automatic batch state persisted', async () => rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102ManualProgress').textContent.includes('중단')`));
  await waitFor('automatic job released after cancellation', async () => rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102WebAutoStart').disabled===false`));
  await rendererWindow.webContents.reload();
  await waitFor('Patch 02 renderer reloaded from saved session', async () => rendererWindow.webContents.executeJavaScript(`Boolean(document.querySelector('#patch0102WebAutoStart'))`));
  await rendererWindow.webContents.executeJavaScript(`window.testSubtitles={interrupted:{path:${JSON.stringify(interrupted.path)},src:${JSON.stringify(interrupted.src)},label:'English',source:'animosub'}};window.selectTestSubtitle('interrupted','synthetic-show|season-1|episode-4')`);
  await rendererWindow.webContents.executeJavaScript(`document.querySelector('#patch0102WebAutoStart').click()`);
  await waitFor('resumed uncertain automatic batch asks for explicit confirmation', async () => rendererWindow.webContents.executeJavaScript(`window.patchFixtureState.confirms.some(message=>message.includes('중복 전송'))`));
  assert.equal(embeddedWindow.turns.length, previousTurnCount + 1, 'cancelled/in-flight batches are not sent again automatically');
  await rendererWindow.webContents.executeJavaScript(`window.patchFixtureState.allowUncertainResend=true;document.querySelector('#patch0102WebAutoStart').click()`);
  await waitFor('explicitly confirmed retry completes and applies', () => saved.length === 3, 30_000);
  assert.equal(await rendererWindow.webContents.executeJavaScript(`currentSubtitle.source === 'chatgpt' && currentSubtitle.path === ${JSON.stringify(saved[2].path)}`), true);
  assert.equal(embeddedWindow.turns.length, previousTurnCount + 2, 'only the user-confirmed continuation retries the uncertain cue');
  assert.equal(saved.length, 3);
  assert.equal(blockedRequests.length, 0, 'the isolated renderer and mocked ChatGPT page made no external HTTP requests');
  assert.deepEqual(errors, []);
  console.log('PATCH02_V0515_ELECTRON_RESULT=' + JSON.stringify({
    target: 'manager-created isolated copy of official v0.5.15', patches: { 'patch-01': false, 'patch-02': true, 'patch-03': false },
    manual: 'Japanese 30 cues, 2 user-delivered batches, validated and saved/applied',
    automatic: 'English 30 cues, 2 mocked UI batches, response collected/validated and saved/applied',
    cancelAndResume: 'in-flight request stopped; renderer reloaded from saved session; no silent retry; explicit confirmation required; completed retry saved/applied',
    oldTranslationModes: toggles.oldModes, conversationDeletion: 'disabled', externalHttpRequests: blockedRequests.length
  }));
  rendererWindow.destroy(); rendererWindow = null; app.quit();
}

try {
  app.whenReady().then(run).catch(error => {
    console.error(error?.stack || error);
    try { rendererWindow?.destroy(); } catch {}
    app.exit(1);
  });
} catch (error) {
  console.error(error?.stack || error);
  app.exit(1);
}
