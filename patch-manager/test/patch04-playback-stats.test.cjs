'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/patch04-playback-stats.js'), 'utf8');

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.className = '';
    this.classList = {
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      }
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(child) { child.parentElement = this; this.children.push(child); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  querySelector(selector) {
    if (selector === '#patch04PlaybackStatsToggle') return this.toggle || null;
    return null;
  }
  set innerHTML(value) {
    this.html = String(value);
    if (this.html.includes('patch04PlaybackStatsToggle')) this.toggle = new Element('input');
  }
}

function createHarness({ enabled = true, measured = true } = {}) {
  const video = new Element('video');
  Object.assign(video, {
    paused: false, videoWidth: measured ? 960 : 0, videoHeight: measured ? 540 : 0,
    currentTime: 65.4, duration: 3600, playbackRate: 1.25,
    currentSrc: measured ? 'https://cdn.example.test/episode/master.m3u8' : '',
    buffered: { length: measured ? 1 : 0, start: () => 60, end: () => 80 },
    getVideoPlaybackQuality: measured ? () => ({ droppedVideoFrames: 3 }) : undefined,
    frameCallback: null,
    requestVideoFrameCallback(callback) { this.frameCallback = callback; return 7; },
    cancelVideoFrameCallback() { this.frameCallback = null; }
  });
  const stage = new Element('main');
  const settings = new Element('aside');
  const qualityParent = new Element('section');
  settings.querySelector = selector => selector === '#psQuality' ? { parentElement: qualityParent } : null;
  const head = new Element('head');
  const document = {
    head,
    querySelector: selector => ({ '#video': video, '#videoStage': stage, '#playerSettings': settings, '#patch04PlaybackStatsStyle': null })[selector] || null,
    createElement: tag => new Element(tag)
  };
  const local = new Map([['playerPlaybackStats', enabled ? 'true' : 'false']]);
  const localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, String(value)) };
  let now = 100;
  const context = vm.createContext({
    window: { DinoLilacPatchFeatures: { 'patch-04': true } }, document, localStorage,
    performance: { now: () => now }, URL,
    hlsPlayer: measured ? { levels: [{ width: 1280, height: 720, bitrate: 3_200_000, videoCodec: 'avc1', audioCodec: 'mp4a' }], manualLevel: -1, currentLevel: 0 } : null,
    currentPlaybackContext: measured ? { currentUrl: video.currentSrc, videoServer: 'Miruro' } : {},
    setInterval: () => 1, clearInterval: () => {}
  });
  vm.runInContext(source, context, { filename: 'patch04-playback-stats.js' });
  const overlay = stage.children[0];
  const group = qualityParent.children[0];
  return { video, stage, head, overlay, group, qualityParent, toggle: group?.toggle, local, setNow: value => { now = value; } };
}

test('Patch 04 remains absent when its independent feature flag is OFF', () => {
  const context = vm.createContext({ window: { DinoLilacPatchFeatures: { 'patch-04': false } }, document: { querySelector() { throw new Error('Patch 04 touched the player while OFF'); } } });
  assert.doesNotThrow(() => vm.runInContext(source, context));
});

test('Patch 04 setting reports measured playback values and labels unavailable metrics', () => {
  const app = createHarness({ enabled: true, measured: true });
  assert.equal(app.overlay.id, 'patch04PlaybackStatsOverlay');
  assert.equal(app.qualityParent.children[0], app.group, 'the settings group is mounted beside existing quality controls');
  assert.match(app.overlay.textContent, /해상도 960×540/);
  assert.match(app.overlay.textContent, /드롭 프레임 3/);
  assert.match(app.overlay.textContent, /HLS 화질·비트레이트 1280×720 · 3\.20 Mbps/);
  assert.match(app.overlay.textContent, /재생 1:05 \/ 1:00:00 · 속도 1\.25x/);
  assert.match(app.overlay.textContent, /공급원 Miruro · 서버 cdn\.example\.test/);
  app.video.listeners.get('playing')();
  assert.equal(typeof app.video.frameCallback, 'function');
  const firstFrame = app.video.frameCallback;
  firstFrame(100, { presentedFrames: 1 });
  app.setNow(1100);
  app.video.frameCallback(1100, { presentedFrames: 32 });
  assert.match(app.overlay.textContent, /FPS 31\.0/);
  app.video.paused = true;
  app.video.listeners.get('pause')();
  assert.equal(app.video.frameCallback, null);
});

test('Patch 04 does not invent values when playback metadata is unavailable', () => {
  const app = createHarness({ enabled: true, measured: false });
  assert.match(app.overlay.textContent, /해상도 확인 불가/);
  assert.match(app.overlay.textContent, /FPS 확인 불가 · 드롭 프레임 확인 불가/);
  assert.match(app.overlay.textContent, /영상·오디오 코덱 확인 불가/);
  assert.match(app.overlay.textContent, /HLS 화질·비트레이트 확인 불가/);
  assert.match(app.overlay.textContent, /공급원 확인 불가 · 서버 확인 불가/);
});
