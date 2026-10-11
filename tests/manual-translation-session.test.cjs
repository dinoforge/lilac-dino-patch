'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManualTranslationSessionStore, registerManualTranslationSessionIpc } = require('../electron/manual-translation-session.cjs');

const fingerprint = 'a'.repeat(64);
const secondFingerprint = 'b'.repeat(64);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-manual-session-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1000;
  const timers = [];
  const store = createManualTranslationSessionStore({
    userDataPath: root,
    now: () => now,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: timer => { timer.cleared = true; }
  });
  return { root, timers, getNow: () => now, setNow: value => { now = value; }, store };
}
function session(overrides = {}) {
  return {
    sourcePath: 'source.vtt', sourceLabel: '일본어 원본', title: '테스트 작품', episode: 4,
    language: 'japanese', index: 1, batchCount: 3, totalCueCount: 55,
    translations: { 1: '안녕하세요', 2: '다음 대사' }, answer: '{"translations":[]}',
    status: 'awaiting-response', message: 'ChatGPT 응답 대기', ...overrides
  };
}

test('manual translation defaults to cleanup after apply and stores only bounded cleanup preferences', t => {
  const { store } = fixture(t);
  assert.deepEqual(store.getSettings(), { autoCleanup: true, cleanupTiming: 'immediate' });
  assert.deepEqual(store.saveSettings({ autoCleanup: false, cleanupTiming: 'on-close', ignored: 'nope' }), { autoCleanup: false, cleanupTiming: 'on-close' });
  assert.deepEqual(store.getSettings(), { autoCleanup: false, cleanupTiming: 'on-close' });
  assert.deepEqual(store.saveSettings({ autoCleanup: 'yes', cleanupTiming: 'invalid' }), { autoCleanup: true, cleanupTiming: 'immediate' });
});

test('session is resumable only for the same episode and source fingerprint', t => {
  const { store } = fixture(t);
  store.save('reanime:series-1:4', fingerprint, session());
  assert.equal(store.load('reanime:series-1:4', fingerprint).answer, '{"translations":[]}');
  assert.equal(store.load('reanime:series-1:5', fingerprint), null);
  assert.equal(store.load('reanime:series-1:4', secondFingerprint), null);
  assert.equal(store.load('../../profile', fingerprint), null, 'untrusted episode keys are hashed and never used as paths');
  assert.throws(() => store.save('reanime:series-1:4', 'not-a-hash', session()), /지문/);
});

test('rejects malformed progress, foreign data sizes, and invalid translation IDs', t => {
  const { store } = fixture(t);
  assert.throws(() => store.save('episode', fingerprint, session({ index: 8 })), /진행/);
  assert.throws(() => store.save('episode', fingerprint, session({ language: 'korean' })), /언어/);
  assert.throws(() => store.save('episode', fingerprint, session({ translations: { bad: '번역' } })), /문장 데이터/);
  assert.throws(() => store.save('episode', fingerprint, session({ answer: 'x'.repeat(2_000_001) })), /너무 큽니다/);
});

test('delayed cleanup removes only an expired completed session and keeps saved subtitle data untouched', t => {
  const { root, store, setNow } = fixture(t);
  store.saveSettings({ autoCleanup: true, cleanupTiming: 'five-minutes' });
  store.save('episode', fingerprint, session({ index: 3, status: 'completed', cleanupAt: 301_000 }));
  store.save('episode', secondFingerprint, session({ status: 'error', cleanupAt: 301_000 }));
  fs.mkdirSync(path.join(root, 'subtitles', 'translated'), { recursive: true });
  const translated = path.join(root, 'subtitles', 'translated', 'keep.vtt');
  fs.writeFileSync(translated, 'WEBVTT\n');
  setNow(302_000);
  assert.equal(store.load('episode', fingerprint), null);
  assert.equal(store.load('episode', secondFingerprint).status, 'error');
  assert.equal(fs.readFileSync(translated, 'utf8'), 'WEBVTT\n');
});

test('five-minute cleanup is enforced by the main process and rescheduled after restart', t => {
  const { root, store, getNow, setNow, timers } = fixture(t);
  store.saveSettings({ autoCleanup: true, cleanupTiming: 'five-minutes' });
  store.save('episode', fingerprint, session({ index: 3, status: 'completed' }));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 300_000);

  const restartedTimers = [];
  const restarted = createManualTranslationSessionStore({
    userDataPath: root,
    now: getNow,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      restartedTimers.push(timer);
      return timer;
    },
    clearTimeoutImpl() {}
  });
  assert.equal(restarted.cleanupExpiredCompleted(), 0);
  assert.equal(restartedTimers.length, 1);
  assert.equal(restartedTimers[0].delay, 300_000);

  setNow(301_000);
  timers[0].callback();
  assert.equal(store.load('episode', fingerprint), null);
  assert.equal(restarted.load('episode', fingerprint), null);
});

test('on-close cleanup deletes only completed work, not interrupted or failed work', t => {
  const { store } = fixture(t);
  store.saveSettings({ autoCleanup: true, cleanupTiming: 'on-close' });
  store.save('episode', fingerprint, session({ index: 3, status: 'completed' }));
  store.save('episode', secondFingerprint, session({ status: 'cancelled' }));
  assert.equal(store.cleanupOnClose(), 1);
  assert.equal(store.load('episode', fingerprint), null);
  assert.equal(store.load('episode', secondFingerprint).status, 'cancelled');
  store.saveSettings({ autoCleanup: false, cleanupTiming: 'on-close' });
  store.save('episode', fingerprint, session({ index: 3, status: 'completed' }));
  assert.equal(store.cleanupOnClose(), 0);
});

test('reveals only existing files inside the app managed translated subtitle directory', t => {
  const { root, store } = fixture(t), dir = path.join(root, 'subtitles', 'translated');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'saved.vtt'), outside = path.join(root, 'outside.vtt');
  fs.writeFileSync(file, 'WEBVTT\n'); fs.writeFileSync(outside, 'WEBVTT\n');
  const shown = [];
  assert.equal(store.revealSavedSubtitle(file, { showItemInFolder: value => shown.push(value) }), true);
  assert.equal(shown[0], fs.realpathSync(file));
  assert.throws(() => store.revealSavedSubtitle(outside, { showItemInFolder() {} }), /앱이 저장한/);
});

test('translated subtitle lookup is scoped to the same episode and exact source path', t => {
  const { root } = fixture(t), handlers = new Map();
  const rows = [
    { key: 'show|episode-1', source: 'chatgpt', from: 'source-en.vtt' },
    { key: 'show|episode-1', source: 'chatgpt', from: 'source-ja.vtt' },
    { key: 'show|episode-2', source: 'chatgpt', from: 'source-en.vtt' },
    { key: 'show|episode-1', source: 'reanime', from: 'source-en.vtt' }
  ];
  registerManualTranslationSessionIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => root, once() {} }, shell: {},
    subtitleStore: { list: key => rows.filter(row => row.key === key) }
  });
  const exists = handlers.get('manual-translation:translated-exists');
  assert.equal(exists({}, 'show|episode-1', 'source-en.vtt'), true);
  assert.equal(exists({}, 'show|episode-1', 'source-ja.vtt'), true);
  assert.equal(exists({}, 'show|episode-1', 'source-other.vtt'), false);
  assert.equal(exists({}, 'show|episode-2', 'source-en.vtt'), true);
  assert.equal(exists({}, 'show|episode-1', 'x'.repeat(16_385)), false);
});
