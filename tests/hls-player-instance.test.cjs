const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const start = appSource.indexOf('function bindHlsPlayerEvents(');
const end = appSource.indexOf('\nfunction play(', start);
assert.ok(start >= 0 && end > start, 'Missing HLS player event binding function');
const bindingSource = appSource.slice(start, end);

class FakeHls {
  constructor() { this.handlers = new Map(); this.levels = []; this.startLoadCount = 0; this.recoveryCount = 0; this.swapCount = 0; }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, data = {}) { this.handlers.get(event)?.(event, data); }
  startLoad() { this.startLoadCount++; }
  recoverMediaError() { this.recoveryCount++; }
  swapAudioCodec() { this.swapCount++; }
}

function setup() {
  const status = { textContent: '' }, messages = [], calls = [];
  const video = { paused: false, currentTime: 0, playCount: 0, play() { this.playCount++; return Promise.resolve(); } };
  const context = vm.createContext({
    Hls: {
      Events: { MANIFEST_PARSED: 'manifest', LEVEL_SWITCHED: 'level', FRAG_BUFFERED: 'buffered', FRAG_CHANGED: 'changed', ERROR: 'error' },
      ErrorDetails: { FRAG_PARSING_ERROR: 'parse' },
      ErrorTypes: { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' }
    },
    $: selector => selector === '#downloadStatus' ? status : {},
    applyDefaultQuality: () => calls.push('quality'),
    renderQualityChoices: () => calls.push('quality-ui'),
    scheduleOpEdAnalysis: () => calls.push('analysis'),
    playerSettingsOpen: () => false,
    toast: message => messages.push(message),
    hlsPlayer: null
  });
  vm.runInContext(bindingSource, context);
  return { context, status, messages, calls, video };
}

test('events from a replaced HLS instance cannot start recovery or change the active player UI', () => {
  const h = setup(), old = new FakeHls(), active = new FakeHls();
  h.context.hlsPlayer = old;
  h.context.bindHlsPlayerEvents(old, h.video);
  h.context.hlsPlayer = active;
  h.context.bindHlsPlayerEvents(active, h.video);
  h.status.textContent = '새 회차 재생목록을 불러오는 중';

  old.emit('manifest');
  old.emit('level');
  old.emit('buffered');
  old.emit('error', { fatal: true, type: 'network', details: 'old-network' });
  old.emit('error', { fatal: true, type: 'media', details: 'old-media' });

  assert.equal(h.video.playCount, 0);
  assert.deepEqual(h.calls, []);
  assert.equal(active.startLoadCount, 0);
  assert.equal(active.recoveryCount, 0);
  assert.equal(h.status.textContent, '새 회차 재생목록을 불러오는 중');
  assert.deepEqual(h.messages, []);

  active.emit('manifest');
  active.emit('error', { fatal: true, type: 'network', details: 'active-network' });
  assert.equal(h.video.playCount, 1);
  assert.equal(active.startLoadCount, 1);
  assert.equal(h.status.textContent, '영상 서버에 다시 연결하는 중...');
  assert.deepEqual(h.calls, ['quality', 'quality-ui', 'analysis']);
});

test('play wires the event handlers to the newly assigned HLS instance', () => {
  assert.match(appSource, /const instance=hlsPlayer=new Hls\(/);
  assert.match(appSource, /bindHlsPlayerEvents\(instance,video\)/);
});
