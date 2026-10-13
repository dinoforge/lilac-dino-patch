'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  HOME, SESSION_PARTITION, safeNavigation, createEmbeddedChatGPTBrowser
} = require('../../electron/embedded-chatgpt-web.cjs');
const {
  validateJob, validateFileJob, inspectScript, focusComposerScript, clickAttachButtonScript, clickSendScript, clearComposerScript, clickStopScript,
  MAX_SUBTITLE_FILE_BYTES, safeResultFileUrl,
  createWebAutoTranslation
} = require('../../electron/chatgpt-web-ui-driver.cjs');
const { registerPatch02Handlers } = require('../../electron/patch-manager-stage2.cjs');
const { makeLilacAnimeV0514Manifest } = require('../adapters/lilacanime-v0.5.14.cjs');
const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/patch-manager-stage2.js'), 'utf8');

function makeBrowserMock({ failLoad = false } = {}) {
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.events = {};
      this.destroyed = false;
      this.hidden = false;
      this.loaded = [];
      this.shown = 0;
      this.focused = 0;
      this.webContents = {
        events: {},
        session: { setPermissionRequestHandler: cb => { this.permission = cb; } },
        on: (name, callback) => { this.webContents.events[name] = callback; },
        setWindowOpenHandler: callback => { this.popupHandler = callback; }
      };
      windows.push(this);
    }
    on(name, cb) { this.events[name] = cb; }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) {
      this.loaded.push(url);
      if (failLoad) throw Error('mock network failure');
    }
    show() { this.shown++; }
    hide() { this.hidden = true; }
    focus() { this.focused++; }
    destroy() { this.destroyed = true; this.events.closed?.(); }
  }
  return { BrowserWindow, windows };
}

test('embedded ChatGPT uses a dedicated sandboxed profile and reuses its window', async () => {
  const mock = makeBrowserMock();
  const service = createEmbeddedChatGPTBrowser(mock);
  assert.deepEqual(await service.open(), { opened: true, reused: false, embedded: true });
  assert.equal(mock.windows.length, 1);
  const current = mock.windows[0];
  assert.deepEqual(current.loaded, [HOME]);
  assert.equal(current.options.webPreferences.partition, SESSION_PARTITION);
  assert.equal(current.options.webPreferences.nodeIntegration, false);
  assert.equal(current.options.webPreferences.contextIsolation, true);
  assert.equal(current.options.webPreferences.sandbox, true);
  assert.equal(current.options.webPreferences.webviewTag, false);
  assert.equal(current.options.webPreferences.webSecurity, true);
  assert.equal(current.options.webPreferences.backgroundThrottling, false);
  let allowed;
  current.permission(null, 'camera', ok => { allowed = ok; });
  assert.equal(allowed, false);
  assert.deepEqual(await service.open(), { opened: true, reused: true, embedded: true });
  assert.equal(mock.windows.length, 1);
  assert.equal(current.focused, 1);
  assert.equal(service.hide(), true);
  assert.equal(current.hidden, true);
  current.destroy();
  assert.deepEqual(await service.open(), { opened: true, reused: false, embedded: true });
  assert.equal(mock.windows.length, 2);
});

test('embedded window refuses unsafe navigation or popup schemes', async () => {
  assert.equal(safeNavigation('https://chatgpt.com/'), true);
  for (const url of ['http://chatgpt.com/', 'file:///D:/LilacAnime/app.asar', 'javascript:alert(1)', 'data:text/html,hi', 'not a url']) {
    assert.equal(safeNavigation(url), false, url);
  }
  const mock = makeBrowserMock();
  await createEmbeddedChatGPTBrowser(mock).open();
  const current = mock.windows[0];
  let stopped = 0;
  current.webContents.events['will-navigate']({ preventDefault() { stopped++; } }, 'file:///C:/secret');
  current.webContents.events['will-navigate']({ preventDefault() { stopped++; } }, 'https://chatgpt.com/c/example');
  assert.equal(stopped, 1);
  assert.deepEqual(current.popupHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  const login = current.popupHandler({ url: 'https://accounts.google.com/' });
  assert.equal(login.action, 'allow');
  assert.equal(login.overrideBrowserWindowOptions.webPreferences.partition, SESSION_PARTITION);
  assert.equal(login.overrideBrowserWindowOptions.webPreferences.sandbox, true);
});

test('embedded page load failure destroys the dedicated window', async () => {
  const mock = makeBrowserMock({ failLoad: true });
  await assert.rejects(createEmbeddedChatGPTBrowser(mock).open(), /열지 못했습니다/);
  assert.equal(mock.windows[0].destroyed, true);
});

test('web UI scripts compile and automatic translation captures only a new stable response', async () => {
  const prompt = 'Translate synthetic cue IDs 1 and 2.';
  const conversationPath = '/c/synthetic-thread';
  const scripts = [inspectScript(prompt, true), focusComposerScript(conversationPath), clickSendScript(prompt, conversationPath),
    clearComposerScript(prompt, conversationPath), clickStopScript(conversationPath)];
  for (const script of scripts) new Function('return ' + script);
  for (const script of scripts.slice(1)) {
    assert.equal(vm.runInNewContext(script, { location: { hostname: 'chatgpt.com', pathname: '/c/other-thread' } }), false,
      'focus, send, clear, and stop actions are bound to the original conversation');
  }
  assert.deepEqual(validateJob({ jobKey: 'test-job-key-1', batchIndex: 0, prompt }), { jobKey: 'test-job-key-1', batchIndex: 0, prompt });
  assert.throws(() => validateJob({ jobKey: 'bad', batchIndex: 0, prompt: '' }), /비어 있거나 크기 제한/);

  let sent = false, inserted = '', clock = 0, inspections = 0;
  const webContents = {
    isDestroyed: () => false,
    insertText: async text => { inserted = text; },
    executeJavaScript: async script => {
      if (script.includes('dino-chatgpt-auto:focus')) return true;
      if (script.includes('dino-chatgpt-auto:send')) { sent = true; return true; }
      if (script.includes('dino-chatgpt-auto:inspect')) {
        inspections++;
        const base = { host: 'chatgpt.com', pathname: '/c/synthetic-thread', loginRequired: false, challenge: false,
          composerCount: 1, composerEmpty: !sent && !script.includes(JSON.stringify(prompt)),
          composerMatchesExpected: script.includes(JSON.stringify(prompt)), sendButtonCount: script.includes(JSON.stringify(prompt)) ? 1 : 0,
          sendButtonEnabled: script.includes(JSON.stringify(prompt)),
          userCount: sent ? 1 : 0, latestUserMatchesExpected: sent, assistantCount: sent && inspections > 2 ? 1 : 0,
          assistantText: sent && inspections > 2 ? '{"1":"안녕","2":"고마워"}' : '', generating: false };
        return base;
      }
      return false;
    }
  };
  const win = { webContents, isDestroyed: () => false };
  const driver = createWebAutoTranslation({ getWindow: () => win, pollIntervalMs: 10, stableMs: 500, now: () => clock, sleep: async ms => { clock += ms; } });
  const result = await driver.run({ jobKey: 'test-job-key-1', batchIndex: 0, prompt });
  assert.equal(inserted, prompt);
  assert.equal(result.ok, true);
  assert.equal(result.batchIndex, 0);
  assert.equal(result.response, '{"1":"안녕","2":"고마워"}');
  assert.equal(result.sent, true);
  assert.equal(driver.busy(), false);
});

test('web UI automation stops before sending when the account page is logged out or unsupported', async () => {
  let executed = 0, inserted = 0;
  const driver = createWebAutoTranslation({ getWindow: () => ({ isDestroyed: () => false, webContents: {
    isDestroyed: () => false,
    insertText: async () => { inserted++; },
    executeJavaScript: async script => { executed++; return { host: 'chatgpt.com', pathname: '/auth/login', loginRequired: true, challenge: false, composerCount: 0 }; }
  } }) });
  await assert.rejects(driver.run({ jobKey: 'test-job-key-1', batchIndex: 0, prompt: 'Synthetic prompt.' }), error => error.code === 'CHATGPT_LOGIN_REQUIRED' && error.sent === false);
  assert.equal(executed, 1);
  assert.equal(inserted, 0);
  assert.equal(driver.busy(), false);
});

test('web driver rejects a concurrent job and cancellation waits for the active input step', async () => {
  const prompt = 'Synthetic concurrency cue.';
  let releaseInsert, announceInsert, sendCount = 0;
  const insertGate = new Promise(resolve => { releaseInsert = resolve; });
  const insertStarted = new Promise(resolve => { announceInsert = resolve; });
  const driver = createWebAutoTranslation({ getWindow: () => ({ isDestroyed: () => false, webContents: {
    isDestroyed: () => false,
    insertText: async () => { announceInsert(); await insertGate; },
    executeJavaScript: async script => {
      if (script.includes('dino-chatgpt-auto:focus')) return true;
      if (script.includes('dino-chatgpt-auto:send')) { sendCount++; return true; }
      if (script.includes('dino-chatgpt-auto:inspect')) {
        const prepared = script.includes(JSON.stringify(prompt));
        return { host: 'chatgpt.com', pathname: '/', loginRequired: false, challenge: false,
          composerCount: 1, composerEmpty: !prepared, composerMatchesExpected: prepared,
          sendButtonCount: prepared ? 1 : 0, sendButtonEnabled: prepared, userCount: 0, latestUserMatchesExpected: false,
          assistantCount: 0, assistantText: '', generating: false };
      }
      return false;
    }
  } }) });
  const running = driver.run({ jobKey: 'active-job-key-1', batchIndex: 0, prompt });
  await insertStarted;
  await assert.rejects(driver.run({ jobKey: 'active-job-key-2', batchIndex: 0, prompt }), error => error.code === 'WEB_TRANSLATION_BUSY');
  const cancelling = driver.cancel('active-job-key-1');
  releaseInsert();
  assert.deepEqual(await cancelling, { cancelled: true, sent: false, stopRequested: false, settled: true });
  await assert.rejects(running, error => error.code === 'CANCELLED' && error.sent === false);
  assert.equal(sendCount, 0);
});

test('whole-file web driver attaches one complete SRT before one instruction and downloads a new SRT response', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-whole-driver-test-'));
  const filePath = path.join(tempDir, 'subtitle-to-translate.srt');
  const prompt = 'Translate the attached complete subtitle to Korean once.';
  const source = '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n';
  const translated = '1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n';
  fs.writeFileSync(filePath, source, 'utf8');
  const order = [];
  let sent = false, fileWasSet = false, clock = 0;
  const session = new EventEmitter();
  const debuggerClient = {
    attached: false,
    isAttached() { return this.attached; },
    attach() { this.attached = true; },
    detach() { this.attached = false; },
    async sendCommand(method, params = {}) {
      order.push(method);
      if (method === 'DOM.enable') return {};
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [2] };
      if (method === 'DOM.describeNode') return { node: { attributes: ['type', 'file', 'accept', '.srt'] } };
      if (method === 'DOM.setFileInputFiles') {
        assert.deepEqual(params.files, [filePath]);
        fileWasSet = true;
        order.push('attached-file');
        return {};
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    }
  };
  const webContents = {
    debugger: debuggerClient,
    session,
    isDestroyed: () => false,
    async insertText(value) { order.push('instruction-input'); assert.equal(value, prompt); },
    async executeJavaScript(script) {
      if (script.includes('dino-chatgpt-auto:send')) { order.push('instruction-send'); sent = true; return true; }
      if (script.includes('dino-chatgpt-auto:inspect')) {
        const base = { host: 'chatgpt.com', pathname: '/c/whole-file-test', loginRequired: false, challenge: false,
          composerCount: 1, composerEmpty: !sent, composerMatchesExpected: script.includes(JSON.stringify(prompt)),
          sendButtonCount: script.includes(JSON.stringify(prompt)) ? 1 : 0,
          sendButtonEnabled: script.includes(JSON.stringify(prompt)), userCount: sent ? 1 : 0,
          latestUserMatchesExpected: sent, latestUserHasFileName: sent, assistantCount: sent ? 1 : 0,
          assistantText: '', generating: false, selectedFileCount: fileWasSet && !sent ? 1 : 0,
          expectedFileInputMatches: fileWasSet && !sent, composerFileNameVisible: fileWasSet && !sent, composerHasAttachmentMarker: fileWasSet && !sent,
          uploadBusy: false, resultFileCount: sent ? 1 : 0,
          resultFileName: sent ? 'translated_subtitles.srt' : '',
          resultFileHref: sent ? 'https://chatgpt.com/backend-api/files/translated_subtitles.srt' : '' };
        if (script.includes(JSON.stringify(prompt)) && !sent) {
          base.composerEmpty = false;
          base.composerMatchesExpected = true;
          base.sendButtonCount = 1;
          base.sendButtonEnabled = true;
          base.selectedFileCount = fileWasSet ? 1 : 0;
          base.expectedFileInputMatches = true;
          base.composerFileNameVisible = true;
          base.composerHasAttachmentMarker = true;
        }
        return base;
      }
      if (script.includes('dino-chatgpt-auto:focus')) return true;
      if (script.includes('dino-chatgpt-auto:attach-button')) return false;
      return false;
    },
    downloadURL(url) {
      order.push('result-download');
      const item = new EventEmitter();
      let targetPath = '';
      item.getURL = () => url;
      item.getFilename = () => 'translated_subtitles.srt';
      item.setSavePath = value => { targetPath = value; fs.writeFileSync(targetPath, translated, 'utf8'); };
      item.cancel = () => {};
      session.emit('will-download', {}, item, webContents);
      setImmediate(() => item.emit('done', {}, 'completed'));
      assert.ok(targetPath);
    }
  };
  const window = { hidden: true, webContents, isDestroyed: () => false,
    show() { assert.fail('background driver must not show the ChatGPT window'); },
    focus() { assert.fail('background driver must not focus the ChatGPT window'); } };
  const driver = createWebAutoTranslation({ getWindow: () => window, pollIntervalMs: 10, stableMs: 10,
    timeoutMs: 1000, now: () => clock, sleep: async ms => { clock += ms; } });
  try {
    assert.equal(validateFileJob({ jobKey: 'whole-file-job-1', prompt, fileName: 'subtitle-to-translate.srt', filePath, tempDir }).fileBytes,
      Buffer.byteLength(source));
    assert.equal(MAX_SUBTITLE_FILE_BYTES, 12_000_000);
    assert.equal(safeResultFileUrl('https://chatgpt.com/backend-api/files/result.srt'), true);
    assert.equal(safeResultFileUrl('file:///C:/private/result.srt'), false);
    assert.doesNotThrow(() => new Function('return ' + clickAttachButtonScript('/c/whole-file-test')));

    const phases = [];
    const result = await driver.runFile({ jobKey: 'whole-file-job-1', prompt, fileName: 'subtitle-to-translate.srt', filePath, tempDir }, {
      onProgress: value => phases.push(value)
    });
    assert.equal(result.ok, true);
    assert.equal(result.sent, true);
    assert.equal(result.attached, true);
    assert.deepEqual(result.responseFile, { name: 'translated_subtitles.srt', content: translated });
    assert.equal(order.filter(item => item === 'instruction-input').length, 1);
    assert.equal(order.filter(item => item === 'instruction-send').length, 1);
    assert.ok(order.indexOf('attached-file') < order.indexOf('instruction-input'));
    assert.ok(order.indexOf('instruction-input') < order.indexOf('instruction-send'));
    assert.ok(phases.some(value => value.phase === 'authenticated'));
    assert.ok(phases.some(value => value.phase === 'waiting-attachment'));
    assert.equal(phases.find(value => value.phase === 'sending-instructions')?.sendAttempted, true);
    assert.equal(phases.find(value => value.phase === 'waiting-full-file-response')?.sent, true);
    assert.equal(driver.status().attached, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('whole-file web driver stops before prompting when ChatGPT attachment cannot be confirmed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-whole-no-attach-test-'));
  const filePath = path.join(tempDir, 'subtitle-to-translate.srt');
  const prompt = 'Translate the complete subtitle once.';
  fs.writeFileSync(filePath, '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n', 'utf8');
  let inserted = 0, clock = 0;
  const debuggerClient = {
    isAttached: () => false, attach() {}, detach() {},
    async sendCommand(method) {
      if (method === 'DOM.enable') return {};
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [2] };
      if (method === 'DOM.describeNode') return { node: { attributes: ['type', 'file', 'accept', '.srt'] } };
      if (method === 'DOM.setFileInputFiles') return {};
      throw new Error(`Unexpected CDP method: ${method}`);
    }
  };
  const driver = createWebAutoTranslation({ getWindow: () => ({ isDestroyed: () => false, webContents: {
    debugger: debuggerClient, isDestroyed: () => false,
    insertText: async () => { inserted++; },
    executeJavaScript: async script => {
      if (script.includes('dino-chatgpt-auto:inspect')) return { host: 'chatgpt.com', pathname: '/c/test', loginRequired: false, challenge: false,
        composerCount: 1, composerEmpty: true, composerMatchesExpected: false, sendButtonCount: 0, sendButtonEnabled: false,
        userCount: 0, assistantCount: 0, generating: false, selectedFileCount: 0, expectedFileInputMatches: false,
        composerFileNameVisible: false, composerHasAttachmentMarker: false, uploadBusy: true };
      if (script.includes('dino-chatgpt-auto:attach-button')) return false;
      return false;
    }
  } }), pollIntervalMs: 100, now: () => clock, sleep: async ms => { clock += 45_000; } });
  try {
    await assert.rejects(driver.runFile({ jobKey: 'whole-file-job-2', prompt, fileName: 'subtitle-to-translate.srt', filePath, tempDir }),
      error => error.code === 'CHATGPT_FILE_ATTACHMENT_UNCONFIRMED' && error.sent === false && error.attached === true);
    assert.equal(inserted, 0);
    assert.equal(driver.status().sent, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ChatGPT web automation is a separate enabled route and deletion remains disabled', () => {
  const settingsStart = rendererSource.indexOf('function addManualTranslationSettings()');
  const settingsEnd = rendererSource.indexOf('function addManualTranslationUi()', settingsStart);
  const settings = rendererSource.slice(settingsStart, settingsEnd);
  assert.match(settings, /choice\.textContent = 'ChatGPT 전체 파일 백그라운드 번역'/);
  assert.match(settings, /id="patch0102ChatGPTAutoStart" type="button" aria-describedby/);
  assert.match(settings, /choice\.addEventListener\('click',/);
  assert.match(settings, /id="patch0102ChatGPTDeleteUnavailable" type="button" disabled/);
  assert.match(settings, /수동 번역 준비/);
  assert.match(settings, /메인 프로세스가 진행률·취소·복구 상태를 관리/);
  assert.match(rendererSource, /id = 'patch0102WebAutoStart'/);
  assert.match(rendererSource, /ChatGPT 전체 파일 백그라운드 번역/);
  assert.match(rendererSource, /const runAuto = async/);
  assert.match(rendererSource, /patchStartChatGPTWebBackgroundTranslation/);
  assert.doesNotMatch(rendererSource, /patchChatGPTWebTranslateFile/);
  assert.doesNotMatch(rendererSource, /runLegacyBatchedAuto|waitForWebResult/);
  assert.match(rendererSource, /patchCancelChatGPTWebBackgroundTranslation/);
  const autoStart = rendererSource.slice(rendererSource.indexOf('const runAuto = async'), rendererSource.indexOf('const copyPrompt = async'));
  assert.doesNotMatch(autoStart, /patchOpenChatGPTEmbedded/, 'automatic translation must use the existing app-owned ChatGPT window');
  assert.match(autoStart, /patchStartChatGPTWebBackgroundTranslation/);
  assert.match(rendererSource, /자동 재전송하지 않습니다/);
  assert.match(rendererSource, /value\.inflightBatch === value\.index/);
});

test('background translation playback lease restores only the original playing video after apply', async () => {
  const declaration = name => {
    const start = rendererSource.indexOf(`const ${name} =`);
    const end = rendererSource.indexOf('\n    };', start);
    assert.ok(start >= 0 && end > start, `renderer helper ${name} must exist`);
    return rendererSource.slice(start, end + '\n    };'.length);
  };
  const video = {
    currentSrc: 'blob:synthetic-video', currentTime: 42, paused: false, ended: false, pauseCalls: 0, playCalls: 0,
    pause() { this.pauseCalls++; this.paused = true; },
    async play() { this.playCalls++; this.paused = false; }
  };
  const context = {
    $: selector => selector === '#video' ? video : null,
    videoSource: item => String(item?.currentSrc || item?.src || ''),
    playbackRequestId: 8,
    subtitleStoreKey: () => 'show-1-episode-3',
    setStatus() {}
  };
  const helpers = vm.runInNewContext([
    declaration('capturePlaybackLease'), declaration('playbackLeaseMatches'), declaration('resumePlaybackLease'),
    '({ capturePlaybackLease, playbackLeaseMatches, resumePlaybackLease })'
  ].join('\n'), context);

  const lease = helpers.capturePlaybackLease();
  assert.equal(lease.position, 42);
  assert.equal(lease.wasPlaying, true);
  assert.equal(video.pauseCalls, 1, 'the player is paused synchronously when the lease is captured');
  assert.equal(video.paused, true);
  video.currentTime = 90;
  assert.equal(helpers.playbackLeaseMatches(lease), true);
  assert.equal(await helpers.resumePlaybackLease(lease), true);
  assert.equal(video.currentTime, 42, 'the original playhead is restored before playback resumes');
  assert.equal(video.playCalls, 1);

  video.paused = true;
  const originallyPaused = helpers.capturePlaybackLease();
  assert.equal(originallyPaused.wasPlaying, false);
  assert.equal(await helpers.resumePlaybackLease(originallyPaused), false);
  assert.equal(video.playCalls, 1, 'an originally paused video stays paused');

  video.paused = false;
  const stale = helpers.capturePlaybackLease();
  context.playbackRequestId++;
  assert.equal(await helpers.resumePlaybackLease(stale), false);
  assert.equal(video.paused, true, 'a different playback request is never resumed');
  assert.equal(video.playCalls, 1);
});

test('completed background result waits for the subtitle track and rejects a changed playback', async () => {
  const declaration = name => {
    const start = rendererSource.indexOf(`const ${name} =`);
    const end = rendererSource.indexOf('\n    };', start);
    assert.ok(start >= 0 && end > start, `renderer helper ${name} must exist`);
    return rendererSource.slice(start, end + '\n    };'.length);
  };
  const makeHarness = ({ readyState = 0 } = {}) => {
    const status = { textContent: '' };
    const track = {
      readyState, listeners: Object.create(null), removed: false,
      addEventListener(name, callback) { this.listeners[name] = callback; },
      remove() { this.removed = true; }
    };
    const video = {
      currentSrc: 'blob:synthetic-video', currentTime: 18, paused: false, ended: false, pauseCalls: 0, playCalls: 0,
      pause() { this.pauseCalls++; this.paused = true; },
      async play() { this.playCalls++; this.paused = false; },
      querySelector(selector) { return selector === 'track' ? track : null; }
    };
    const source = { path: 'source.vtt', src: 'file:///source.vtt' };
    const translation = { jobKey: 'whole-file-job-test', playbackId: 8, episodeKey: 'show-1-episode-3', subtitle: source, stopRequested: false };
    const context = {
      $: selector => selector === '#video' ? video : selector === '#subtitleState' ? status : null,
      videoSource: item => String(item?.currentSrc || item?.src || ''), playbackRequestId: 8,
      subtitleStoreKey: () => 'show-1-episode-3', setStatus() {}, render() {}, queueMicrotask,
      currentSubtitle: source, translation, currentSubtitlePath: 'source.vtt', sourceBeforeTranslation: null,
      abandonedBackgroundJobs: new Set(), pendingBackgroundApply: new Map(), completedBackgroundApply: new Set(),
      attachSubtitle(src, label, meta) {
        context.currentSubtitle = { src, label, ...meta };
        if (translation.applyingBackgroundResult) {
          translation.subtitle = context.currentSubtitle;
          translation.applyingBackgroundResult = false;
        }
      }
    };
    const functions = vm.runInNewContext([
      declaration('capturePlaybackLease'), declaration('playbackLeaseMatches'),
      declaration('resumePlaybackLease'), declaration('applyBackgroundResult'),
      '({ capturePlaybackLease, applyBackgroundResult })'
    ].join('\n'), context);
    translation.playbackLease = functions.capturePlaybackLease();
    return { context, functions, track, video, status, translation };
  };
  const task = {
    jobKey: 'whole-file-job-test', status: 'completed', playbackId: 8, episodeKey: 'show-1-episode-3', sourcePath: 'source.vtt',
    sourceLabel: 'Japanese', savedSubtitle: { path: 'translated.vtt', url: 'file:///translated.vtt' }
  };
  const success = makeHarness();
  success.video.currentTime = 39;
  assert.equal(success.functions.applyBackgroundResult(task), true);
  assert.equal(success.video.paused, true);
  assert.equal(success.video.playCalls, 0, 'saved output alone does not resume playback');
  success.track.listeners.load();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(success.video.currentTime, 18);
  assert.equal(success.video.playCalls, 1, 'playback resumes only after the attached subtitle track loads');
  assert.equal(success.context.completedBackgroundApply.has(task.jobKey), true);

  const failed = makeHarness({ readyState: 3 });
  assert.equal(failed.functions.applyBackgroundResult(task), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(failed.video.paused, true, 'a subtitle load error never resumes playback');
  assert.equal(failed.video.playCalls, 0);

  const stale = makeHarness();
  assert.equal(stale.functions.applyBackgroundResult(task), true);
  stale.context.playbackRequestId++;
  stale.track.listeners.load();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stale.video.playCalls, 0, 'a different playback request is never resumed');
  assert.equal(stale.track.removed, true, 'a late translated track is removed after the playback changes');
});

test('automatic video resume is gated on the saved subtitle track load event and task identity', () => {
  const applyStart = rendererSource.indexOf('const applyBackgroundResult = task =>');
  const applyEnd = rendererSource.indexOf('const receiveBackgroundTask = task =>', applyStart);
  const apply = rendererSource.slice(applyStart, applyEnd);
  assert.match(rendererSource, /autoButton\.addEventListener\('click',[\s\S]*?capturePlaybackLease\(\)/);
  assert.match(apply, /Number\(task\.playbackId\) === playbackRequestId/);
  assert.match(apply, /task\.episodeKey === subtitleStoreKey\(\)/);
  assert.match(apply, /track\.addEventListener\('load'/);
  assert.match(apply, /track\.addEventListener\('error'/);
  const finishStart = apply.indexOf('const finishApply = async loaded =>');
  const finishEnd = apply.indexOf("track.addEventListener('load'", finishStart);
  const finishApply = apply.slice(finishStart, finishEnd);
  assert.match(finishApply, /if \(!loaded\)[\s\S]*?return;/);
  assert.match(finishApply, /await resumePlaybackLease\(lease\)/,
    'playback restoration lives inside the callback after successful track load');
  assert.match(rendererSource, /stale\.fileMode \? api\.patchCancelChatGPTWebBackgroundTranslation/);
  assert.match(rendererSource, /translation\.stopRequested\)\) return false/);
});

test('login-required background state keeps the original playback lease for retry', () => {
  const start = rendererSource.indexOf('const receiveBackgroundTask = task =>');
  const end = rendererSource.indexOf('api.onPatchChatGPTWebBackgroundUpdate', start);
  const declaration = rendererSource.slice(start, end).trim().replace(/;$/, '');
  assert.ok(start >= 0 && end > start, 'background state receiver must exist');
  const lease = { position: 12, wasPlaying: true };
  const context = {
    translation: {
      jobKey: 'needs-login-job', episodeKey: 'show-1-episode-3', sourcePath: 'source.vtt',
      sourceFingerprint: 'fingerprint', playbackLease: lease
    },
    playbackRequestId: 8,
    subtitleStoreKey: () => 'show-1-episode-3',
    currentSubtitle: { path: 'source.vtt' },
    abandonedBackgroundJobs: new Set(), pendingBackgroundApply: new Map(), completedBackgroundApply: new Set(),
    applyBackgroundResult() { return false; }, render() {}
  };
  vm.runInNewContext(`${declaration}; receiveBackgroundTask({ jobKey: 'needs-login-job', status: 'needs-user', episodeKey: 'show-1-episode-3', sourcePath: 'source.vtt', sourceFingerprint: 'fingerprint' });`, context);
  assert.equal(context.translation.status, 'error', 'the UI still reports that user action is required');
  assert.equal(context.translation.playbackLease, lease, 'the original playing state survives login and confirmation waits');
  assert.equal(context.translation.autoRunning, false);
});

test('Patch 02 exposes embedded window IPC but only opens it when called', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-web-ipc-'));
  const mock = makeBrowserMock();
  const handlers = new Map();
  try {
    const registered = registerPatch02Handlers({
      ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
      app: { getPath: name => path.join(userData, name) },
      subtitleStore: { save: () => ({ path: 'translated.vtt' }) },
      clipboard: { writeText() {}, readText() { return ''; } },
      shell: { showItemInFolder() {} },
      electron: mock
    });
    assert.ok(registered.includes('patch:chatgpt-web:open'));
    assert.ok(registered.includes('patch:chatgpt-web:translate'));
    assert.ok(registered.includes('patch:chatgpt-web:translate-file'));
    assert.ok(registered.includes('patch:chatgpt-web:cancel'));
    assert.ok(registered.includes('patch:chatgpt-web:background:start'));
    assert.ok(registered.includes('patch:chatgpt-web:background:status'));
    assert.ok(registered.includes('patch:chatgpt-web:background:cancel'));
    assert.equal(handlers.has('patch:chatgpt-web:translate'), true);
    assert.equal(handlers.has('patch:chatgpt-web:translate-file'), true);
    assert.equal(handlers.has('patch:chatgpt-web:background:start'), true);
    assert.equal(handlers.has('siwc:connect'), false);
    assert.equal(mock.windows.length, 0);
    const closed = await handlers.get('patch:chatgpt-web:translate')(null, { jobKey: 'test-job-key-1', batchIndex: 0, prompt: 'Translate this.' });
    assert.equal(closed.ok, false);
    assert.equal(closed.code, 'CHATGPT_WINDOW_CLOSED');
    assert.equal(mock.windows.length, 0, 'the renderer must open the dedicated window before starting a job');
    const noFileWindow = await handlers.get('patch:chatgpt-web:translate-file')(null, {
      jobKey: 'whole-file-ipc-1', prompt: 'Translate the attached complete subtitle.',
      content: '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n'
    });
    assert.equal(noFileWindow.ok, false);
    assert.equal(noFileWindow.code, 'CHATGPT_WINDOW_CLOSED');
    assert.equal(noFileWindow.sent, false);
    assert.equal(noFileWindow.attached, false);
    assert.equal(mock.windows.length, 0, 'the file IPC must not create a new ChatGPT window or session');
    const noBackgroundWindow = await handlers.get('patch:chatgpt-web:background:start')(null, {
      jobKey: 'whole-file-background-1', prompt: 'Translate the complete attached SRT to Korean.',
      content: '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n', episodeKey: 'episode-1',
      sourcePath: 'D:\\isolated\\source.vtt', sourceFingerprint: 'fingerprint-1', sourceLabel: '일본어 자막', playbackId: 1
    });
    assert.equal(noBackgroundWindow.ok, false);
    assert.equal(noBackgroundWindow.code, 'CHATGPT_WINDOW_CLOSED');
    assert.equal(mock.windows.length, 0, 'background start must not create or focus a ChatGPT window');
    const result = await handlers.get('patch:chatgpt-web:open')();
    assert.equal(result.embedded, true);
    assert.equal(mock.windows.length, 1);
    const unsupported = await handlers.get('patch:chatgpt-web:translate')(null, { jobKey: 'test-job-key-2', batchIndex: 0, prompt: 'Translate this.' });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'CHATGPT_PAGE_UNAVAILABLE');
    assert.equal(unsupported.sent, false);
    assert.deepEqual(await handlers.get('patch:chatgpt-web:cancel')(null, 'test-job-key-2'), {
      cancelled: false, sent: false, stopRequested: false, settled: true, phase: 'checking-page'
    });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('official v0.5.14 patch manifest carries embedded bridge and no SIWC runtime', () => {
  const manifest = makeLilacAnimeV0514Manifest();
  const files = manifest.actions.filter(action => action.kind === 'add-file').map(action => action.file);
  assert.ok(files.includes('electron/embedded-chatgpt-web.cjs'));
  assert.ok(files.includes('electron/chatgpt-web-ui-driver.cjs'));
  assert.ok(files.includes('electron/chatgpt-background-translation.cjs'));
  assert.ok(!files.includes('electron/siwc-client.cjs'));
  assert.ok(!files.includes('src/siwc-subtitle-bridge.js'));
  const preload = manifest.actions.find(action => action.file === 'electron/preload.cjs').content;
  const html = manifest.actions.find(action => action.file === 'src/index.html').content;
  assert.match(preload, /patchOpenChatGPTEmbedded/);
  assert.match(preload, /patchChatGPTWebTranslate/);
  assert.match(preload, /patchChatGPTWebTranslateFile/);
  assert.match(preload, /patchCancelChatGPTWebTranslation/);
  assert.match(preload, /patchStartChatGPTWebBackgroundTranslation/);
  assert.match(preload, /onPatchChatGPTWebBackgroundUpdate/);
  assert.doesNotMatch(preload, /SIWC|siwc/);
  assert.doesNotMatch(html, /siwc/i);
});
