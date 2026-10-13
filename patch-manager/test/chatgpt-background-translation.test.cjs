'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatGPTBackgroundTranslation } = require('../../electron/chatgpt-background-translation.cjs');

const SOURCE = '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n\n2\n00:00:03,000 --> 00:00:04,000\nありがとう\n';
const RESULT = '1\n00:00:01,000 --> 00:00:02,000\n안녕하세요\n\n2\n00:00:03,000 --> 00:00:04,000\n고마워요\n';

function makeApp(root) {
  const app = new EventEmitter();
  app.getPath = name => { assert.equal(name, 'temp'); return root; };
  app.isReady = () => true;
  app.quit = () => { app.quitCalls = (app.quitCalls || 0) + 1; };
  return app;
}

function makeRequest(overrides = {}) {
  return {
    jobKey: 'whole-file-job-01', prompt: 'Translate the attached full SRT to Korean once.', content: SOURCE,
    episodeKey: 'anime-1-ep-1', sourcePath: 'D:\\isolated\\subtitles\\source.vtt',
    sourceFingerprint: 'synthetic-fingerprint-01', sourceLabel: '일본어 자막', title: 'Synthetic Episode',
    episode: 1, language: 'japanese', sourceKind: 'reanime', playbackId: 44,
    ...overrides
  };
}

async function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for a background task state.');
}

test('main process owns the whole-file task, hides only its ChatGPT window, and validates/saves once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-background-test-'));
  const app = makeApp(root), notifications = [], updates = [], saved = [];
  const window = {
    hidden: false, isDestroyed: () => false, hide() { this.hidden = true; },
    webContents: { isDestroyed: () => false }
  };
  let releaseResponse, driverCalls = 0;
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  const driver = {
    async runFile(input, { onProgress }) {
      driverCalls++;
      assert.equal(fs.readFileSync(input.filePath, 'utf8'), SOURCE);
      await onProgress({ phase: 'authenticated', conversationPath: '/c/background-test', attached: false, sent: false, sendAttempted: false });
      assert.equal(window.hidden, true, 'the app-owned ChatGPT window is hidden before upload');
      assert.equal(player.playing, true, 'the video playback state remains untouched');
      await onProgress({ phase: 'attaching-source-file', attached: true, sent: false, sendAttempted: false });
      await onProgress({ phase: 'waiting-attachment', attached: true, sent: false, sendAttempted: false });
      await onProgress({ phase: 'preparing-instructions', attached: true, sent: false, sendAttempted: false });
      await onProgress({ phase: 'sending-instructions', attached: true, sent: false, sendAttempted: true });
      await onProgress({ phase: 'waiting-full-file-response', attached: true, sent: true, sendAttempted: true });
      await responseGate;
      await onProgress({ phase: 'downloading-result-file', attached: true, sent: true, sendAttempted: true });
      return { ok: true, jobKey: input.jobKey, sent: true, attached: true,
        responseFile: { name: 'translated_subtitles.srt', content: RESULT } };
    },
    async cancel() { return { cancelled: false }; }
  };
  const player = { playing: true };
  class FakeNotification {
    constructor(options) { notifications.push(options); }
    show() {}
    static isSupported() { return true; }
  }
  const manager = createChatGPTBackgroundTranslation({
    app, driver, getWindow: () => window, Notification: FakeNotification,
    saveSubtitle: async input => {
      saved.push(input);
      const file = path.join(root, 'translated.vtt');
      fs.writeFileSync(file, input.text, 'utf8');
      return { path: file, url: `file://${file}` };
    }
  });
  const sender = { isDestroyed: () => false, send: (channel, value) => updates.push({ channel, value }) };
  try {
    const started = await manager.start(makeRequest(), sender);
    assert.equal(started.ok, true);
    assert.equal(started.task.status, 'running');
    await waitFor(() => driverCalls === 1);
    await waitFor(() => manager.getStatus()?.phase === 'waiting-full-file-response');
    assert.equal(manager.getStatus().sendAttempted, true);
    assert.equal(manager.getStatus().progress, 55);
    releaseResponse();
    await waitFor(() => manager.getStatus()?.status === 'completed');

    assert.equal(driverCalls, 1, 'the complete SRT request was issued once');
    assert.equal(saved.length, 1, 'validated output was saved once');
    assert.match(saved[0].text, /^WEBVTT\n/);
    assert.match(saved[0].text, /00:00:01\.000 --> 00:00:02\.000/);
    assert.match(saved[0].text, /00:00:03\.000 --> 00:00:04\.000/);
    assert.equal(manager.getStatus().savedSubtitle.path, path.join(root, 'translated.vtt'));
    assert.equal(manager.getStatus().progress, 100);
    assert.ok(updates.some(item => item.value.phase === 'waiting-full-file-response'));
    assert.ok(notifications.some(item => item.title === '자막 백그라운드 번역 시작'));
    assert.ok(notifications.some(item => item.title === '한국어 자막 번역 완료'));
    assert.equal(window.hidden, true);
    assert.equal(player.playing, true);
  } finally {
    releaseResponse();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('whole-file timestamp mismatch never saves, and a sent request cannot be resent automatically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-background-uncertain-'));
  const app = makeApp(root);
  const window = { isDestroyed: () => false, hide() {}, webContents: { isDestroyed: () => false } };
  let calls = 0, saves = 0;
  const driver = {
    async runFile(input, { onProgress }) {
      calls++;
      await onProgress({ phase: 'authenticated' });
      await onProgress({ phase: 'attaching-source-file', attached: true });
      await onProgress({ phase: 'sending-instructions', attached: true, sendAttempted: true });
      await onProgress({ phase: 'waiting-full-file-response', attached: true, sent: true, sendAttempted: true });
      const invalidTime = RESULT.replace('00:00:01,000 --> 00:00:02,000', '00:00:01,500 --> 00:00:02,000');
      return { ok: true, jobKey: input.jobKey, sent: true, attached: true,
        responseFile: { name: 'translated_subtitles.srt', content: invalidTime } };
    },
    async cancel() { return { cancelled: false }; }
  };
  const manager = createChatGPTBackgroundTranslation({
    app, driver, getWindow: () => window,
    saveSubtitle: async () => { saves++; return { path: 'unused.vtt', url: 'file:///unused.vtt' }; }
  });
  try {
    const bad = await manager.start(makeRequest({
      content: SOURCE,
      jobKey: 'bad-result-job-01'
    }));
    assert.equal(bad.ok, true);
    await waitFor(() => manager.getStatus()?.status === 'error');
    assert.equal(saves, 0);
    assert.equal(manager.getStatus().errorCode, 'WHOLE_FILE_VALIDATION_FAILED', manager.getStatus().message);
    assert.equal(manager.getStatus().sendAttempted, true);
    assert.equal(manager.getStatus().attached, true);
    const anotherSource = await manager.start(makeRequest({
      jobKey: 'different-source-job', episodeKey: 'anime-1-ep-2', sourceFingerprint: 'different-fingerprint'
    }));
    assert.equal(anotherSource.ok, false);
    assert.equal(anotherSource.requiresUserReview, true, 'an unresolved ChatGPT response blocks a second request in the shared conversation');
    const retry = await manager.start(makeRequest({ jobKey: 'second-job-uncertain' }));
    assert.equal(retry.ok, false);
    assert.equal(retry.requiresUserReview, true);
    assert.equal(retry.code, 'CHATGPT_PREVIOUS_REQUEST_UNCERTAIN');
    assert.equal(calls, 1, 'uncertain delivery is never retried automatically');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a login requirement pauses the job, keeps the ChatGPT window visible, and alerts the user', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-background-login-'));
  const app = makeApp(root), notifications = [];
  const window = { hidden: false, isDestroyed: () => false, hide() { this.hidden = true; }, webContents: { isDestroyed: () => false } };
  class FakeNotification {
    constructor(options) { notifications.push(options); }
    show() {}
    static isSupported() { return true; }
  }
  const driver = {
    async runFile() { const e = new Error('내장 ChatGPT 로그인이 필요합니다.'); e.code = 'CHATGPT_LOGIN_REQUIRED'; throw e; },
    async cancel() { return { cancelled: false }; }
  };
  const manager = createChatGPTBackgroundTranslation({
    app, driver, getWindow: () => window, Notification: FakeNotification,
    saveSubtitle: async () => { assert.fail('A login-required task must not save output.'); }
  });
  try {
    const started = await manager.start(makeRequest({ jobKey: 'login-required-job' }));
    assert.equal(started.ok, true);
    await waitFor(() => manager.getStatus()?.status === 'needs-user');
    assert.equal(manager.getStatus().errorCode, 'CHATGPT_LOGIN_REQUIRED');
    assert.equal(window.hidden, false, 'the user can sign in directly in the app-owned ChatGPT window');
    assert.ok(notifications.some(item => item.title === 'ChatGPT 확인이 필요합니다'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('app exit stops an active task and leaves a recoverable interruption record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dino-chatgpt-background-quit-'));
  const app = makeApp(root), window = { isDestroyed: () => false, hide() {}, webContents: { isDestroyed: () => false } };
  let rejectRun, runEntered;
  const entered = new Promise(resolve => { runEntered = resolve; });
  const driver = {
    runFile: () => new Promise((_, reject) => { rejectRun = reject; runEntered(); }),
    async cancel() {
      const error = new Error('cancelled on quit');
      error.code = 'CANCELLED'; error.sent = true; error.attached = true; error.sendAttempted = true;
      rejectRun(error);
      return { cancelled: true, sent: true, attached: true };
    }
  };
  const manager = createChatGPTBackgroundTranslation({
    app, driver, getWindow: () => window,
    saveSubtitle: async () => { assert.fail('No output exists during shutdown.'); }
  });
  try {
    await manager.start(makeRequest({ jobKey: 'shutdown-job-01' }));
    await entered;
    let prevented = false;
    app.emit('before-quit', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    await waitFor(() => app.quitCalls === 1);
    const status = manager.getStatus();
    assert.equal(status.status, 'interrupted');
    assert.equal(status.sendAttempted, true);
    assert.equal(status.responseAvailable, false);
    assert.ok(fs.existsSync(path.join(root, 'dino-lilac-patch02-chatgpt', 'shutdown-job-01', 'source.srt')));
    assert.ok(fs.existsSync(path.join(root, 'dino-lilac-patch02-chatgpt', 'shutdown-job-01', 'instruction.txt')));

    const restored = createChatGPTBackgroundTranslation({
      app, driver, getWindow: () => window,
      saveSubtitle: async () => { assert.fail('No output is available to recover.'); }
    });
    assert.equal(restored.getStatus().status, 'interrupted');
    assert.equal(restored.getStatus().sendAttempted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
