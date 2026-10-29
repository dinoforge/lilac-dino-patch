const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/player.js'), 'utf8');
const playerCss = fs.readFileSync(path.join(__dirname, '../src/player-android.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
function appSection(start, end) {
  const first = appSource.indexOf(start), last = appSource.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'Missing app section: ' + start);
  return appSource.slice(first, last);
}
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing player section: ${start}`);
  return source.slice(first, last);
}
function classList(...initial) {
  const values = new Set(initial);
  return { contains: value => values.has(value), add: value => values.add(value), remove: value => values.delete(value), toggle(value, on) { on ? values.add(value) : values.delete(value); } };
}
function setup() {
  const events = {}, playerEvents = {}, timers = new Map(), storage = new Map();
  let timerId = 0, now = 0;
  const player = { classList: classList('controls-visible'), contains: () => false, clientWidth: 2100, clientHeight: 900,
    addEventListener: (name, fn) => { (playerEvents[name] ||= []).push(fn); } };
  const video = { playbackRate: 1.5, paused: false, ended: false, style: {}, playCount: 0, pauseCount: 0,
    play() { this.paused = false; this.playCount++; return Promise.resolve(); },
    pause() { this.paused = true; this.pauseCount++; events['video:pause']?.(); },
    addEventListener: (name, fn) => { events[`video:${name}`] = fn; },
    setPointerCapture(id) { this.capturedPointer = id; }, hasPointerCapture(id) { return this.capturedPointer === id; },
    releasePointerCapture(id) { if (this.capturedPointer === id) this.capturedPointer = null; } };
  const indicator = { classList: classList('hidden') }, stage = { style: {} };
  const document = { body: { classList: classList('player-mode') }, activeElement: { tagName: 'BODY', matches: () => false }, addEventListener: (name, fn) => { events[name] = fn; } };
  const context = vm.createContext({ document, window: { addEventListener: (name, fn) => { events[name] = fn; } },
    $: selector => ({ '#video': video, '#immersivePlayer': player, '#playerSpeedBoost': indicator, '#videoStage': stage }[selector]), $$: () => [],
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    playerLocked: false, playerSettingsOpen: () => false, showPlayerControls: () => {},
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(section('// Delay the short-press', '// Outside the player'), context);
  const key = (repeat = false) => ({ key: ' ', code: 'Space', repeat, preventDefault() { this.prevented = true; } });
  const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  return { context, video, player, playerEvents, indicator, events, storage, stage, key, advance, document };
}

function setupPip({ rejectPip = false } = {}) {
  const storage = new Map(), intervalCallbacks = new Map(), toasts = [];
  let intervalId = 0, streamFps = 0, videoCreates = 0;
  const miniPlayer = { classList: classList() }, subtitleEnabled = { checked: true };
  const canvasContext = {
    drawCalls: 0, captions: [],
    fillRect() {},
    drawImage() { this.drawCalls++; },
    measureText(value) { return { width: [...value].length * 10 }; },
    strokeText() {},
    fillText(value) { this.captions.push(value); }
  };
  const captureTrack = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [captureTrack] };
  const canvas = {
    width: 0, height: 0,
    getContext: () => canvasContext,
    captureStream(fps) { streamFps = fps; return stream; }
  };
  const videoListeners = new Map();
  const emit = (listeners, name) => { for (const listener of listeners.get(name) || []) listener(); };
  const realVideoListeners = new Map();
  const realVideo = {
    readyState: 0, videoWidth: 640, videoHeight: 360, paused: false,
    textTracks: [{ activeCues: [{ text: '한국어 PIP 자막' }] }], playCount: 0, pauseCount: 0,
    addEventListener(name, listener) { (realVideoListeners.get(name) || realVideoListeners.set(name, []).get(name)).push(listener); },
    play() { if (!this.paused) return Promise.resolve(); this.paused = false; this.playCount++; emit(realVideoListeners, 'play'); return Promise.resolve(); },
    pause() { if (this.paused) return; this.paused = true; this.pauseCount++; emit(realVideoListeners, 'pause'); }
  };
  const hiddenVideo = {
    className: '', muted: false, playsInline: false, paused: true, srcObject: null, playCount: 0,
    addEventListener(name, listener) { (videoListeners.get(name) || videoListeners.set(name, []).get(name)).push(listener); },
    async play() { if (this.paused) { this.paused = false; this.playCount++; emit(videoListeners, 'play'); } },
    pause() { if (!this.paused) { this.paused = true; emit(videoListeners, 'pause'); } },
    async requestPictureInPicture() {
      if (rejectPip) throw new Error('PIP unsupported');
      document.pictureInPictureElement = this;
    },
    emit(name) { emit(videoListeners, name); }
  };
  const player = { clientWidth: 1280, clientHeight: 720 };
  const document = {
    pictureInPictureElement: null,
    body: { append() {} },
    createElement(name) { if (name === 'video') { videoCreates++; return hiddenVideo; } return canvas; },
    async exitPictureInPicture() { this.pictureInPictureElement = null; hiddenVideo.emit('leavepictureinpicture'); }
  };
  const context = vm.createContext({
    document, window: { LilacAss: null },
    $: selector => ({ '#video': realVideo, '#immersivePlayer': player, '#miniPlayer': miniPlayer, '#subtitleEnabled': subtitleEnabled }[selector]),
    localStorage: { getItem: key => storage.get(key) ?? null },
    playerAspect: () => 'original', PLAYER_ASPECTS: { original: 16 / 9 }, vttBaseline: () => 85,
    currentSubtitle: null, toast: message => toasts.push(message),
    setInterval(fn, ms) { const id = ++intervalId; intervalCallbacks.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervalCallbacks.delete(id); }
  });
  vm.runInContext(section('function vttPipText(', '\nfunction vttLines('), context);
  vm.runInContext(section('// --- Picture-in-picture', '// --- Media controls'), context);
  vm.runInContext(appSection("$('#miniPlayer').onclick", "$('#togglePlayer').onclick"), context);
  return { document, realVideo, hiddenVideo, canvas, canvasContext, captureTrack, intervalCallbacks,
    miniPlayer, toasts, getVideoCreates: () => videoCreates, getStreamFps: () => streamFps };
}

test('picture-in-picture VTT captions decode named and numeric references', () => {
  const context = vm.createContext({});
  vm.runInContext(section('function vttPipText(', '// VTT cues drawn'), context);
  const lines = context.vttLines({ measureText: value => ({ width: [...value].length }) }, '&lt;3 &quot;hello&quot; &#39;yes&#39; &#12354; &amp;', 1000);
  assert.deepEqual(Array.from(lines), ['<3 "hello" \'yes\' あ &']);
});

test('short Space press toggles once on release despite repeated keydown', () => {
  const h = setup(); h.context.handlePlayerKey(h.key());
  h.advance(100); h.context.handlePlayerKey(h.key(true));
  assert.equal(h.video.pauseCount, 0);
  h.events.keyup(h.key()); h.events.keyup(h.key());
  assert.equal(h.video.pauseCount, 1);
  h.context.handlePlayerKey(h.key()); h.advance(100); h.events.keyup(h.key());
  assert.equal(h.video.playCount, 1);
});

test('holding Space boosts to 2x and restores the previous rate without pausing or saving it', () => {
  const h = setup(); h.context.handlePlayerKey(h.key()); h.advance(399);
  assert.equal(h.video.playbackRate, 1.5);
  h.advance(1); h.context.handlePlayerKey(h.key(true));
  assert.equal(h.video.playbackRate, 2);
  assert.equal(h.indicator.classList.contains('hidden'), false);
  h.events.keyup(h.key());
  assert.equal(h.video.playbackRate, 1.5); assert.equal(h.video.pauseCount, 0);
  assert.equal(h.indicator.classList.contains('hidden'), true); assert.equal(h.storage.size, 0);
});

test('focus loss, hidden window, pause and media replacement cancel a hold', () => {
  for (const name of ['blur', 'visibilitychange', 'video:pause', 'video:ended', 'video:emptied', 'video:loadstart']) {
    const h = setup(); h.context.handlePlayerKey(h.key()); h.advance(400); h.document.hidden = true;
    h.events[name](); h.events.keyup(h.key());
    assert.equal(h.video.playbackRate, 1.5, name); assert.equal(h.video.pauseCount, 0, name);
  }
  const h = setup(); h.context.handlePlayerKey(h.key()); h.events.blur(); h.advance(500);
  assert.equal(h.video.playbackRate, 1.5); h.events.keyup(h.key()); assert.equal(h.video.pauseCount, 0);
});

test('settings, text inputs and modified Space retain their native behavior', () => {
  for (const configure of [h => { h.context.playerSettingsOpen = () => true; }, h => { h.document.activeElement = { tagName: 'INPUT', type: 'text' }; }, h => { h.document.activeElement.isContentEditable = true; }]) {
    const h = setup(); configure(h); const event = h.key(); h.context.handlePlayerKey(event); h.advance(500); h.events.keyup(event);
    assert.equal(event.prevented, undefined); assert.equal(h.video.playbackRate, 1.5); assert.equal(h.video.pauseCount, 0);
  }
  const h = setup(), event = { ...h.key(), ctrlKey: true }; h.context.handlePlayerKey(event); h.advance(500);
  assert.equal(event.prevented, undefined); assert.equal(h.video.playbackRate, 1.5);
});

test('a manually selected speed during a boost is kept', () => {
  const h = setup(); h.context.handlePlayerKey(h.key()); h.advance(400); h.video.playbackRate = 1.25; h.events.keyup(h.key());
  assert.equal(h.video.playbackRate, 1.25);
});

test('holding the left mouse button on the playing video temporarily boosts to 2x and suppresses the click', () => {
  const h = setup(), pointer = { pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true, target: h.video };
  h.playerEvents.pointerdown[0](pointer); h.advance(400);
  assert.equal(h.video.playbackRate, 2); assert.equal(h.indicator.classList.contains('hidden'), false);
  h.events.pointerup({ pointerId: 7 });
  assert.equal(h.video.playbackRate, 1.5); assert.equal(h.indicator.classList.contains('hidden'), true);
  assert.equal(h.video.capturedPointer, null);
  const click = { pointerId: 7, button: 0, detail: 1, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  h.playerEvents.click[0](click);
  assert.equal(click.prevented, true); assert.equal(click.stopped, true);
});

test('a short video click keeps its normal action and mouse holds ignore controls, touch, and paused video', () => {
  const h = setup(), click = { button: 0, detail: 1, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  h.playerEvents.pointerdown[0]({ pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, target: h.video });
  h.events.pointerup({ pointerId: 1 }); h.playerEvents.click[0](click);
  assert.equal(click.prevented, false); assert.equal(h.video.playbackRate, 1.5);

  for (const [label, configure] of [
    ['control target', event => { event.target = {}; }],
    ['touch', event => { event.pointerType = 'touch'; }],
    ['right button', event => { event.button = 2; }],
    ['non-primary pointer', event => { event.isPrimary = false; }],
    ['paused video', (event, video) => { video.paused = true; }]
  ]) {
    const next = setup(), event = { pointerId: 2, pointerType: 'mouse', button: 0, isPrimary: true, target: next.video };
    configure(event, next.video); next.playerEvents.pointerdown[0](event); next.advance(500);
    assert.equal(next.video.playbackRate, 1.5, label);
  }
});

test('mouse speed hold cancels when the pointer is released or the window loses focus', () => {
  for (const finish of [
    h => h.events.pointercancel({ pointerId: 8 }),
    h => h.events.blur(),
    h => h.events.pointermove({ pointerId: 8, buttons: 0 })
  ]) {
    const h = setup();
    h.playerEvents.pointerdown[0]({ pointerId: 8, pointerType: 'mouse', button: 0, isPrimary: true, target: h.video });
    h.advance(400); assert.equal(h.video.playbackRate, 2);
    finish(h); assert.equal(h.video.playbackRate, 1.5); assert.equal(h.indicator.classList.contains('hidden'), true);
  }
});

test('speed shortcuts reach 3x and 4x, respect the upper limit and step back', () => {
  const h = setup(), speed = { value: '2' }, originalSelect = h.context.$;
  h.context.$ = selector => selector === '#speed' ? speed : originalSelect(selector);
  h.context.toast = () => {};
  vm.runInContext(appSource.match(/const SPEED_OPTIONS=\[[^\]]+\];/)[0], h.context);
  h.video.playbackRate = 2;
  for (const [key, expected] of [[']', 3], [']', 4], [']', 4], ['[', 3], ['[', 2]]) {
    h.context.handlePlayerKey({ key });
    assert.equal(h.video.playbackRate, expected); assert.equal(speed.value, String(expected));
  }
});

test('keyboard seeks show the destination without raising the full player controls', () => {
  const hint = { className: 'player-seek-hint', classList: classList(), children: [], replaceChildren(...children) { this.children = children; } };
  const player = { classList: classList(), contains: () => false };
  const video = { currentTime: 100, duration: 1000, paused: false, volume: 1, muted: false };
  let controlsShown = 0;
  const context = vm.createContext({
    document: { activeElement: { tagName: 'BODY', isContentEditable: false }, fullscreenElement: null, createElement: () => ({ textContent: '' }) },
    $: selector => ({ '#video': video, '#immersivePlayer': player, '#playerSeekHint': hint }[selector] || null),
    localStorage: { getItem: key => key === 'seekSeconds' ? '10' : null },
    playerLocked: false, playerSettingsOpen: () => false, playerFlag: () => false,
    showPlayerControls: () => { controlsShown++; }, seekPlayer: time => { video.currentTime = time; },
    formatTime: time => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`,
    setTimeout: () => 1, clearTimeout() {}
  });
  vm.runInContext(section('let seekHint = null;', 'function resetAutoSkipState()'), context);
  const start = source.indexOf('function handlePlayerKey(event) {'), end = source.indexOf('async function takeScreenshot()', start);
  assert.ok(start >= 0 && end > start, 'player keyboard handler exists');
  vm.runInContext(source.slice(start, end), context);

  const key = (value, code) => ({ key: value, code, preventDefault() { this.prevented = true; } });
  context.handlePlayerKey(key('ArrowLeft', 'ArrowLeft'));
  assert.equal(video.currentTime, 90);
  assert.equal(hint.className, 'player-seek-hint back');
  assert.equal(hint.children[0].textContent, '−10초');
  assert.equal(hint.children[1].textContent, '1:30');
  assert.equal(controlsShown, 0);

  context.handlePlayerKey(key('ArrowLeft', 'ArrowLeft'));
  assert.equal(video.currentTime, 80);
  assert.equal(hint.children[0].textContent, '−20초', 'repeated seeks in the same direction accumulate');

  context.handlePlayerKey(key('5', 'Digit5'));
  assert.equal(video.currentTime, 500);
  assert.equal(hint.className, 'player-seek-hint jump');
  assert.deepEqual(hint.children.map(child => child.textContent), ['8:20']);
  assert.equal(controlsShown, 0);
  assert.equal(require('cheerio').load(indexHtml)('#playerSeekHint').length, 1);
  assert.match(playerCss, /\.player-seek-hint\.show\s*\{\s*opacity:\s*1/);
});

test('3x and 4x settings persist in the playback select and default slider', () => {
  const h = setup(), originalSelect = h.context.$;
  const $html = require('cheerio').load(indexHtml);
  const buttons = $html('#psSpeeds button').map((_, node) => ({ dataset: { speed: $html(node).attr('data-speed') } })).get();
  const elements = { '#speed': { value: '1' }, '#defaultSpeed': { value: '4' }, '#speedLabel': { textContent: '' } };
  h.context.$ = selector => elements[selector] || originalSelect(selector);
  h.context.$$ = () => buttons; h.context.syncPlayerSettingsUI = () => {};
  vm.runInContext(appSource.match(/const SPEED_OPTIONS=\[[^\]]+\];/)[0], h.context);
  vm.runInContext(section("$$('#psSpeeds button').forEach(button => button.onclick", "$('#previousEpisode').onclick"), h.context);
  for (const speed of [3, 4]) {
    buttons.find(button => Number(button.dataset.speed) === speed).onclick();
    assert.equal(h.video.playbackRate, speed); assert.equal(h.storage.get('defaultSpeed'), String(speed));
    assert.equal(elements['#speed'].value, String(speed)); assert.equal(elements['#speedLabel'].textContent, `${speed.toFixed(2)}x`);
    assert.ok($html(`#speed option[value="${speed}"]`).length);
    assert.ok(Number(elements['#defaultSpeed'].value) <= Number($html('#defaultSpeed').attr('max')));
    h.context.handlePlayerKey(h.key()); h.advance(400); h.events.keyup(h.key());
    assert.equal(h.video.playbackRate, speed); assert.equal(h.storage.get('defaultSpeed'), String(speed));
  }
});

test('quality status distinguishes actual output from selected and automatic HLS levels', () => {
  const nodes = new Map();
  const makeNode = () => ({ textContent: '', children: [], classList: classList(), replaceChildren(...children) { this.children = children; } });
  for (const id of ['#psQuality', '#psQualityList', '#psQualityActual', '#video']) nodes.set(id, makeNode());
  const video = nodes.get('#video'); video.videoWidth = 1280; video.videoHeight = 720;
  const context = vm.createContext({
    hlsPlayer: { levels: [{ height: 480 }, { height: 1080 }], manualLevel: -1, currentLevel: 0, autoLevelEnabled: true },
    $: selector => nodes.get(selector),
    qualityLabel: level => `${level.height}p`,
    localStorage: { setItem() {}, getItem() { return null; } },
    document: { createElement: () => ({ classList: classList(), setAttribute() {} }) },
    syncSettingChoices() {}
  });
  vm.runInContext(section('function renderQualityChoices()', '\n// Previous / next episode'), context);
  context.renderQualityChoices();
  assert.equal(nodes.get('#psQualityActual').textContent, '자동 · 현재 480p · 실제 영상 해상도 1280 × 720 · 720p');
  assert.equal(nodes.get('#psQuality').classList.contains('hidden'), false);
  assert.equal(nodes.get('#psQualityList').children.length, 3);

  context.hlsPlayer.autoLevelEnabled = false; context.hlsPlayer.currentLevel = 1;
  context.renderQualityChoices();
  assert.equal(nodes.get('#psQualityActual').textContent, '선택 1080p · 실제 영상 해상도 1280 × 720 · 720p');

  context.hlsPlayer.autoLevelEnabled = true; context.hlsPlayer.currentLevel = 0;
  context.hlsPlayer.levels = [{ height: 720 }];
  nodes.get('#video').videoWidth = 0; nodes.get('#video').videoHeight = 0;
  context.renderQualityChoices();
  assert.equal(nodes.get('#psQualityActual').textContent, '자동 · 현재 720p · 실제 출력 확인 중');
  assert.equal(nodes.get('#psQualityList').children.length, 0);

  context.hlsPlayer = null;
  nodes.get('#video').videoWidth = 1920; nodes.get('#video').videoHeight = 1080;
  context.renderQualityChoices();
  assert.equal(nodes.get('#psQuality').classList.contains('hidden'), false);
  assert.equal(nodes.get('#psQualityActual').textContent, '실제 영상 해상도 1920 × 1080 · 1080p');

  nodes.get('#video').videoWidth = 0; nodes.get('#video').videoHeight = 0;
  context.renderQualityChoices();
  assert.equal(nodes.get('#psQualityActual').textContent, '화질 확인 불가');
  assert.match(fs.readFileSync(path.join(__dirname, '../src/player.js'), 'utf8'), /addEventListener\('emptied', renderQualityChoices\)/);
});

test('aspect presets stretch within their ratio; fill uses all of an ultrawide window', () => {
  const h = setup(); vm.runInContext(section('const PLAYER_ASPECTS', 'new ResizeObserver(applyPlayerAspect)'), h.context);
  for (const [aspect, width, height, fit] of [['original', 2100, 900, 'contain'], ['21:9', 2100, 900, 'fill'], ['16:9', 1600, 900, 'fill'], ['4:3', 1200, 900, 'fill'], ['fill', 2100, 900, 'fill'], ['invalid', 2100, 900, 'contain']]) {
    h.storage.set('playerAspect', aspect); h.context.applyPlayerAspect();
    assert.ok(Math.abs(parseFloat(h.stage.style.width) - width) < 0.001); assert.ok(Math.abs(parseFloat(h.stage.style.height) - height) < 0.001);
    assert.equal(parseFloat(h.stage.style.left), (2100 - width) / 2); assert.equal(h.video.style.objectFit, fit);
  }
  h.storage.set('playerAspect', '21:9'); h.player.clientWidth = 600; h.player.clientHeight = 500; h.context.applyPlayerAspect();
  assert.equal(parseFloat(h.stage.style.width), 600); assert.ok(Math.abs(parseFloat(h.stage.style.height) - 600 * 9 / 21) < 0.001);
});

test('VTT dialogue stays centered within a safe width and retains sync and top placement', () => {
  const h = setup(), cues = [{ startTime: 1, endTime: 3 }, { startTime: 2, endTime: 4, lilacTop: true }];
  h.video.textTracks = [{ cues }]; h.context.flattenVttCues = () => {}; h.context.vttBaseline = () => 85;
  vm.runInContext(section('function applyVttLayout()', '// Android subtitle source chips'), h.context);
  h.storage.set('subtitleSync', '500'); h.context.applyVttLayout(); h.context.applyVttLayout();
  for (const cue of cues) { assert.equal(cue.size, 100); assert.equal(cue.position, 50); assert.equal(cue.positionAlign, 'center'); assert.equal(cue.align, 'center'); }
  assert.match(playerCss, /#video::-webkit-media-text-track-display\s*\{[^}]*padding-inline:\s*5%;[^}]*box-sizing:\s*border-box/s);
  assert.equal(cues[0].startTime, 1.5); assert.equal(cues[0].line, 85); assert.equal(cues[0].lineAlign, 'end');
  assert.equal(cues[1].line, 5); assert.equal(cues[1].lineAlign, 'start');
});

test('PIP wraps long Korean and unspaced Japanese text, including explicit newlines', () => {
  const h = setup();
  vm.runInContext(section('function vttPipText(', '\nfunction vttLines('), h.context);
  vm.runInContext(section('function vttLines(', '// VTT cues drawn'), h.context);
  const ctx = { measureText: value => ({ width: [...value].length * 10 }) };
  for (const text of ['아주 긴 대사가 창 너비를 넘어도 잘리지 않습니다', '空白のないとても長い字幕も折り返します', '<i>첫째 줄</i>\n둘째 줄 &amp; 마지막']) {
    const lines = h.context.vttLines(ctx, text, 80);
    assert.ok(lines.length > 1); assert.ok(lines.every(line => ctx.measureText(line).width <= 80));
  }
});

test('PIP button waits for decoded video, composes Korean captions, and releases capture on close', async () => {
  const h = setupPip();
  await h.miniPlayer.onclick();
  assert.deepEqual(h.toasts, ['먼저 영상을 재생하세요.']);
  assert.equal(h.getVideoCreates(), 0);

  h.realVideo.readyState = 2;
  await h.miniPlayer.onclick();
  assert.equal(h.document.pictureInPictureElement, h.hiddenVideo);
  assert.equal(h.miniPlayer.classList.contains('active'), true);
  assert.equal(h.hiddenVideo.className, 'pip-source');
  assert.equal(h.canvas.width, 640); assert.equal(h.canvas.height, 360);
  assert.equal(h.canvasContext.drawCalls, 1);
  assert.ok(h.canvasContext.captions.includes('한국어 PIP 자막'));
  assert.equal(h.getStreamFps(), 30);
  assert.equal(h.intervalCallbacks.size, 1);
  assert.equal(h.captureTrack.stopped, false);

  h.hiddenVideo.pause();
  assert.equal(h.realVideo.paused, true);
  await h.realVideo.play();
  assert.equal(h.hiddenVideo.paused, false);

  await h.miniPlayer.onclick();
  assert.equal(h.document.pictureInPictureElement, null);
  assert.equal(h.hiddenVideo.paused, true);
  assert.equal(h.hiddenVideo.srcObject, null);
  assert.equal(h.captureTrack.stopped, true);
  assert.equal(h.miniPlayer.classList.contains('active'), false);
  assert.equal(h.intervalCallbacks.size, 0);
  assert.equal(h.realVideo.paused, false);
});

test('PIP request failure stops the hidden video and capture stream', async () => {
  const h = setupPip({ rejectPip: true });
  h.realVideo.readyState = 2;
  await h.miniPlayer.onclick();
  assert.equal(h.hiddenVideo.paused, true);
  assert.equal(h.hiddenVideo.srcObject, null);
  assert.equal(h.captureTrack.stopped, true);
  assert.equal(h.miniPlayer.classList.contains('active'), false);
  assert.equal(h.intervalCallbacks.size, 0);
  assert.deepEqual(h.toasts, ['PIP를 열지 못했습니다: PIP unsupported']);
});

test('PIP capability failures are explained and leave no timer, capture stream, or active state', async () => {
  for (const removeCapability of [
    h => { delete h.canvas.captureStream; },
    h => { delete h.hiddenVideo.requestPictureInPicture; }
  ]) {
    const h = setupPip();
    h.realVideo.readyState = 2;
    removeCapability(h);
    await h.miniPlayer.onclick();
    assert.equal(h.hiddenVideo.paused, true);
    assert.equal(h.hiddenVideo.srcObject, null);
    assert.equal(h.miniPlayer.classList.contains('active'), false);
    assert.equal(h.intervalCallbacks.size, 0);
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0], /^PIP를 열지 못했습니다: /);
  }
});

test('ASS canvas follows stretched video bounds and returns to the original bounds', async () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../src/ass-renderer.js'), 'utf8').replace(/^import JASSUB[^\n]*\n/m, '');
  const created = [], video = { style: { objectFit: 'fill' }, clientWidth: 2100, clientHeight: 900, offsetLeft: 0, offsetTop: 0 };
  class Renderer {
    constructor() { this.ready = Promise.resolve(); this._canvas = { style: {} }; created.push(this); }
    _getElementBoundingBox() { return { x: 250, y: 0, width: 1600, height: 900 }; }
    async resize() { this.bounds = this._getElementBoundingBox(video, 1920, 1080); }
    async destroy() { this.destroyed = true; }
  }
  const window = { dispatchEvent() {} }, context = vm.createContext({ window, JASSUB: Renderer, Event, URL, Blob });
  vm.runInContext(rendererSource, context);
  assert.equal(await window.LilacAss.attach(video, { subUrl: 'subtitle.ass' }), true);
  assert.equal(created[0].bounds.width, 2100); assert.equal(created[0].bounds.height, 900); assert.equal(created[0].bounds.x, 0);
  video.style.objectFit = 'contain'; window.LilacAss.resize(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(created[0].bounds.width, 1600); assert.equal(created[0].bounds.x, 250);
  await window.LilacAss.destroy(); assert.equal(window.LilacAss.active, false);
});

test('subtitle sync accepts large positive and negative values without the old 5-second cap', () => {
  const $html = require('cheerio').load(indexHtml);
  for (const id of ['subtitleSync', 'psSubtitleSync']) {
    const input = $html(`#${id}`);
    assert.equal(input.attr('type'), 'number'); assert.equal(input.attr('step'), '250');
    assert.equal(input.attr('min'), undefined); assert.equal(input.attr('max'), undefined);
  }
  const h = setup(), offsets = [], cue = { startTime: 120, endTime: 125 };
  h.video.textTracks = [{ cues: [cue] }]; h.context.flattenVttCues = () => {}; h.context.vttBaseline = () => 85;
  h.context.setSubtitleSetting = (key, value) => h.storage.set(key, String(value));
  h.context.toast = () => {};
  h.context.window.LilacAss = { setOffset: value => offsets.push(value) };
  vm.runInContext(section('function applyVttLayout()', '// Android subtitle source chips'), h.context);
  vm.runInContext(section('function setSubtitleSync(', '// VTT placement and sync'), h.context);
  assert.equal(h.context.setSubtitleSync(90000), true); assert.equal(cue.startTime, 210); assert.equal(offsets.at(-1), 90000);
  assert.equal(h.context.setSubtitleSync(-90000), true); assert.equal(cue.startTime, 30); assert.equal(offsets.at(-1), -90000);
  assert.equal(h.context.setSubtitleSync(Infinity), false); assert.equal(h.context.setSubtitleSync(''), false); assert.equal(cue.startTime, 30);
  h.context.setSubtitleSync(5500);
  h.context.handlePlayerKey({ key: 'x', code: 'KeyX', preventDefault() {} });
  assert.equal(h.storage.get('subtitleSync'), '6000');
});

test('manual subtitle timing edits persist from both settings surfaces on change', () => {
  const h = setup(), offsets = [];
  const elements = Object.fromEntries(['#subtitleSync', '#subtitleSyncLabel', '#psSubtitleSync', '#psSyncLabel'].map(selector => [selector, { value: '0', textContent: '0', oninput: null, onchange: null }]));
  const originalSelect = h.context.$;
  h.context.$ = selector => elements[selector] || originalSelect(selector);
  h.context.$$ = () => [];
  h.context.syncPlayerSettingsUI = () => {};
  h.context.applyVttLayout = () => {};
  h.context.window.LilacAss = { setOffset: value => offsets.push(value) };
  const bindingStart = appSource.indexOf("$('#subtitleSync').oninput="), bindingEnd = appSource.indexOf('};', bindingStart) + 2;
  assert.ok(bindingStart >= 0 && bindingEnd > bindingStart, 'Missing settings page sync input binding');
  vm.runInContext(appSource.slice(bindingStart, bindingEnd), h.context);
  vm.runInContext(section('function setSubtitleSetting(', 'function setSubtitleSync('), h.context);
  vm.runInContext(section('function setSubtitleSync(', '// VTT placement and sync'), h.context);
  vm.runInContext(section("$('#psSubtitleSync').onchange =", "$('#psVttStyle').onchange ="), h.context);

  assert.equal(elements['#subtitleSync'].oninput, null);
  for (const [selector, value] of [['#psSubtitleSync', '750'], ['#subtitleSync', '-1000']]) {
    const input = elements[selector]; input.value = value; input.onchange({ target: input });
    assert.equal(h.storage.get('subtitleSync'), value);
    assert.equal(offsets.at(-1), Number(value));
  }
});

test('renderer and Electron subtitle resolvers recognize the same Korean track metadata', () => {
  const helper = source => {
    const start = source.indexOf('function isKoreanTrack('), end = source.indexOf('\n', start);
    assert.ok(start >= 0 && end > start, 'Missing Korean track detector');
    return source.slice(start, end);
  };
  const renderer = vm.createContext({}), main = vm.createContext({});
  vm.runInContext(helper(appSource), renderer);
  vm.runInContext(helper(mainSource), main);
  const korean = [
    { language: 'ko', label: 'Track 1' },
    { language: 'ko-KR', label: 'Track 2' },
    { language: 'kor', label: 'Track 3' },
    { label: '한국어' },
    { label: 'Korean' },
    { url: 'https://cdn.example/subtitle_kor_track.vtt' }
  ];
  const other = [
    { language: 'en-US', label: 'English' },
    { language: 'ja-JP', label: '日本語' },
    { language: 'koala', label: 'Track 4' }
  ];
  for (const detector of [renderer.isKoreanTrack, main.isKoreanTrack]) {
    for (const track of korean) assert.equal(detector(track), true);
    for (const track of other) assert.equal(detector(track), false);
  }
});

test('ending an episode saves completion, exposes controls, and never starts the next episode automatically', () => {
  const status = { textContent: '' }, calls = [];
  const context = vm.createContext({
    currentHistoryKey: 'episode-key',
    state: { history: [{ key: 'episode-key', progress: 83 }] },
    saveHistorySoon: () => calls.push('save'),
    siblingEpisode: () => ({ number: 2 }),
    $: selector => selector === '#downloadStatus' ? status : null,
    showPlayerControls: () => calls.push('controls'),
    playSiblingEpisode: () => calls.push('autoplay')
  });
  vm.runInContext(appSection('function handleEpisodeEnded()', "\n$('#video').addEventListener('ended'"), context);
  context.handleEpisodeEnded();
  assert.equal(status.textContent, '재생이 끝났습니다. 다음 화는 직접 선택해 주세요.');
  assert.equal(context.state.history[0].progress, 100);
  assert.deepEqual(calls, ['save', 'controls']);

  context.siblingEpisode = () => null;
  context.handleEpisodeEnded();
  assert.equal(status.textContent, '마지막 회차입니다.');
  assert.deepEqual(calls, ['save', 'controls', 'save', 'controls']);
  assert.match(source, /\$\('#nextEpisode'\)\.onclick\s*=\s*\(\)\s*=>\s*playSiblingEpisode\(siblingEpisode\(1\)\)/);
});

test('continue card progress markup closes its width attribute before the episode label', () => {
  const start = appSource.indexOf('function renderContinue(){'), end = appSource.indexOf('init();', start);
  assert.ok(start >= 0 && end > start, 'Missing continue card renderer');
  const render = appSource.slice(start, end);
  const progress = render.match(/history-progress"><i style="width:\$\{Math\.max\(0,Math\.min\(100,h\.progress\|\|0\)\)\}%([^<]*)<\/i>/);
  assert.ok(progress, 'continue progress element is present');
  assert.equal(progress[1], '">');
});


test('LinkAni content-source migration retains the source and does not touch saved user data', () => {
  const storage = new Map([['contentSource', 'linkani'], ['history', '["keep"]'], ['library', '["keep"]']]);
  const context = vm.createContext({ localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value))
  } });
  vm.runInContext(appSection('function migrateContentSource(', '\nconst state ='), context);
  assert.equal(context.migrateContentSource('linkani'), 'linkani');
  assert.equal(storage.get('contentSource'), 'linkani');
  assert.equal(storage.get('history'), '["keep"]');
  assert.equal(storage.get('library'), '["keep"]');
  assert.equal(context.migrateContentSource('miruro'), 'miruro');
});

test('LinkAni is a selectable source and Patch 03 provider while original Linkkf remains separate', () => {
  const providerList = appSource.match(/const PROVIDER_SOURCES=\[([^\]]+)\]/)?.[1] || '';
  assert.ok(providerList);
  assert.match(providerList, /linkani/);
  const integrated = fs.readFileSync(path.join(__dirname, '../src/integrated-search.js'), 'utf8');
  assert.match(integrated, /PROVIDERS = \['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'\]/);
  assert.match(indexHtml, /(?:data-value|option value)="linkani"/i);
  assert.match(mainSource, /LINKANI_WEB|linkaniFetch|linkaniItems|linkaniDetail|resolveLinkaniEpisode/);
  assert.match(mainSource, /ipcMain\.handle\('linkkf:resolve'/);
  assert.doesNotMatch(integrated.match(/const PROVIDERS = \[([^\]]+)\]/)?.[1] || '', /linkkf/i);
});

test('AI subtitle selection does not treat a retired ChatGPT record as a current AI translation', async () => {
  const entry = { source: 'chatgpt', path: 'legacy-chatgpt.vtt', url: 'file:///legacy-chatgpt.vtt' };
  const applied = [], actions = [], notices = [];
  const context = vm.createContext({
    playbackRequestId: 12, subtitleSelectionRequestId: 4, currentPlaybackContext: {},
    subtitleStoreKey: () => 'episode-key',
    window: { lilac: { savedSubtitles: async key => { assert.equal(key, 'episode-key'); return [entry]; }, geminiSettings: async () => ({}) } },
    pressSubtitleSource: source => actions.push(['pressed', source]),
    preferAiSubtitle: enabled => actions.push(['preferred', enabled]),
    renderSubtitleSheet: () => actions.push(['render']),
    applySavedSubtitle: saved => applied.push(saved),
    autoTranslateProvider: () => null, autoProvider: () => null, toast: message => notices.push(message)
  });
  vm.runInContext(section('async function switchSubtitleSource(', '// Quality:'), context);

  await context.switchSubtitleSource('ai', 4, 12);

  assert.equal(context.currentPlaybackContext.sheetSource, null);
  assert.deepEqual(actions, [['pressed', 'ai'], ['preferred', true], ['render']]);
  assert.deepEqual(applied, []);
  assert.match(notices[0], /번역 API 키나 로컬 AI 모델/);
});

function subtitleSourceHarness() {
  const h = setup(), savedRequests = [], findRequests = [], searched = [], attached = [], sourcePicks = [];
  const controls = new Map([
    ['#subtitleSource', { value: '' }],
    ['#subtitleState', { textContent: '' }],
    ['#skipTitle', { value: '테스트 애니' }],
    ['#skipEpisode', { value: '1' }]
  ]);
  const originalSelect = h.context.$;
  h.context.$ = selector => controls.get(selector) || originalSelect(selector);
  Object.assign(h.context, {
    currentPlaybackContext: { episodeKey: 'reanime:one', anime: { provider: 'reanime', id: 'one' } },
    currentSubtitle: { path: 'currently-playing.vtt' },
    currentSubtitlePath: 'currently-playing.vtt',
    playbackRequestId: 1,
    subtitleSelectionRequestId: 0,
    KOREAN_SOURCES: ['kairan', 'csora', 'anissia'],
    SUBTITLE_SOURCE_LABELS: { kairan: 'Kairan', csora: 'Csora', anissia: 'Anissia' },
    renderSubtitleSheet() {},
    beginSubtitleSelection: () => ++h.context.subtitleSelectionRequestId,
    pressSubtitleSource: source => { h.context.currentPlaybackContext.pressedSource = source; h.context.currentPlaybackContext.pressedFor = h.context.currentSubtitle; },
    preferAiSubtitle() {},
    rememberSeriesSubtitleSource(source) { sourcePicks.push(source); },
    syncSettingChoices() {},
    syncPlayerSettingsUI() {},
    subtitleStoreKey: () => h.context.currentPlaybackContext.episodeKey,
    subtitleSearchAnime: () => h.context.currentPlaybackContext.anime,
    setSubtitleAvailability() {},
    communityLabel(source) { return `${source} 자막`; },
    subtitleAvailabilityStatusFromError() { return 'error'; },
    attachSubtitle(url, label, options) { this.currentSubtitle = { url, label, ...options }; attached.push(options.source); },
    window: {
      lilac: {
        savedSubtitles(key) { return new Promise(resolve => savedRequests.push({ key, resolve })); },
        findSubtitle(source) { searched.push(source); return new Promise(resolve => findRequests.push({ source, resolve })); }
      }
    }
  });
  vm.runInContext(section('async function selectSubtitleSource(source)', '// Quality: the HLS variants'), h.context);
  return { ...h, controls, savedRequests, findRequests, searched, attached, sourcePicks };
}

test('subtitle source preference is per series and reset preserves its other saved picks', () => {
  const storage = new Map([
    ['subtitleSource', 'kairan'],
    ['seriesSubtitlePick', JSON.stringify({
      'reanime:one': { source: 'csora', jimaku: { release: 'kept' }, ai: 'local', at: 1 },
      'reanime:two': { source: 'linkkf', jimaku: { release: 'other' }, at: 2 }
    })]
  ]);
  const preferenceStatus = { textContent: '' }, resetButton = { disabled: false };
  const context = vm.createContext({
    currentPlaybackContext: { anime: { provider: 'reanime', id: 'one' } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    $: selector => ({ '#seriesSubtitleSourceStatus': preferenceStatus, '#resetSeriesSubtitleSource': resetButton }[selector])
  });
  vm.runInContext(appSection('const SERIES_SUBTITLE_SOURCES=', 'const engineSide='), context);

  assert.equal(context.preferredSubtitleSource(), 'csora');
  context.renderSeriesSubtitlePreference();
  assert.equal(preferenceStatus.textContent, '이 작품 출처: Csora');
  assert.equal(resetButton.disabled, false);
  assert.equal(context.preferredSubtitleSource({ provider: 'reanime', id: 'two' }), 'linkkf');
  assert.equal(context.rememberSeriesSubtitleSource('anissia'), true);
  assert.equal(context.preferredSubtitleSource(), 'anissia');
  assert.equal(context.preferredSubtitleSource({ provider: 'reanime', id: 'two' }), 'linkkf');
  assert.equal(context.rememberSeriesSubtitleSource('jimaku'), false);
  assert.equal(context.resetSeriesSubtitleSource(), true);
  assert.equal(context.preferredSubtitleSource(), 'kairan');
  context.renderSeriesSubtitlePreference();
  assert.equal(preferenceStatus.textContent, '설정 기본값: Kairan');
  assert.equal(resetButton.disabled, true);

  const picks = JSON.parse(storage.get('seriesSubtitlePick'));
  assert.deepEqual(picks['reanime:one'].jimaku, { release: 'kept' });
  assert.equal(picks['reanime:one'].ai, 'local');
  assert.equal(picks['reanime:one'].source, undefined);
  assert.deepEqual(picks['reanime:two'], { source: 'linkkf', jimaku: { release: 'other' }, at: 2 });
});

test('automatic subtitle search tries the selected series source first', async () => {
  const searched = [];
  const context = vm.createContext({
    playbackRequestId: 7,
    subtitleStoreKey: () => 'episode-one',
    seriesKey: anime => `${anime.provider}:${anime.id}`,
    preferredSubtitleSource: () => 'csora',
    $$: () => [],
    window: { lilac: { findSubtitle: async source => { searched.push(source); return source === 'csora' ? { id: 'csora-result' } : null; } } }
  });
  vm.runInContext(appSection('const ONLINE_SUBTITLE_SOURCES=', 'function attachOnlineSubtitle('), context);

  const found = await context.onlineSubtitleFor('테스트 애니', 1, { provider: 'reanime', id: 'one' });
  assert.equal(found.source, 'csora');
  assert.deepEqual(searched, ['csora', 'kairan', 'anissia']);
});

test('manually choosing a Re:Anime subtitle track does not change the settings default', async () => {
  const storage = new Map([['subtitleSource', 'kairan']]);
  let selectedSource = null, context;
  context = vm.createContext({
    playbackRequestId: 4,
    subtitleSelectionRequestId: 0,
    currentPlaybackContext: { anime: { provider: 'reanime', id: 'one' }, subtitleTracks: [] },
    localStorage: { getItem: key => storage.get(key) ?? null },
    beginSubtitleSelection() { return ++context.subtitleSelectionRequestId; },
    trackFile: async track => ({ url: track.url, path: '/subtitle.vtt' }),
    isKoreanTrack: () => true,
    preferAiSubtitle() {},
    rememberSeriesSubtitleSource(source) { selectedSource = source; },
    renderSeriesSubtitlePreference() {},
    renderSubtitleTracks() {},
    trackSourceLabel: () => 'Re:Anime',
    attachSubtitle() {},
    $: () => ({ textContent: '' })
  });
  vm.runInContext(appSection('async function selectSubtitleTrack(', '\nfunction formatTime('), context);

  assert.equal(await context.selectSubtitleTrack({ label: '한국어', url: 'subtitle://korean' }), true);
  assert.equal(selectedSource, 'reanime');
  assert.equal(storage.get('subtitleSource'), 'kairan');
});

test('a late saved-subtitle lookup cannot replace the most recently selected source', async () => {
  const h = subtitleSourceHarness();
  const first = h.context.selectSubtitleSource('kairan');
  const second = h.context.selectSubtitleSource('csora');
  assert.deepEqual(h.savedRequests.map(request => request.key), ['reanime:one', 'reanime:one']);

  h.savedRequests[0].resolve([{ source: 'kairan', path: 'old.vtt', url: 'subtitle://old' }]);
  await first;
  assert.deepEqual(h.searched, []);
  assert.deepEqual(h.attached, []);

  h.savedRequests[1].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.findRequests.map(request => request.source), ['csora']);
  h.findRequests[0].resolve({ path: 'csora.vtt', url: 'subtitle://csora' });
  await second;
  assert.deepEqual(h.searched, ['csora']);
  assert.deepEqual(h.attached, ['csora']);
});

test('choosing a subtitle source saves it for the series without changing the settings default', async () => {
  const h = subtitleSourceHarness();
  h.storage.set('subtitleSource', 'anissia');
  const pending = h.context.selectSubtitleSource('csora');

  assert.deepEqual(h.sourcePicks, ['csora']);
  assert.equal(h.storage.get('subtitleSource'), 'anissia');
  h.savedRequests[0].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  h.findRequests[0].resolve({ path: 'csora.vtt', url: 'subtitle://csora' });
  await pending;
  assert.equal(h.storage.get('subtitleSource'), 'anissia');
});

test('a late Anissia maker result cannot replace the maker selected afterwards', async () => {
  const controls = new Map([['#skipTitle', { value: '테스트 애니' }], ['#skipEpisode', { value: '1' }], ['#subtitleState', { textContent: '' }]]);
  const pending = [], attached = [];
  const context = vm.createContext({
    playbackRequestId: 1, subtitleSelectionRequestId: 0, currentSubtitlePath: null,
    $: selector => controls.get(selector),
    beginSubtitleSelection() { return ++context.subtitleSelectionRequestId; },
    subtitleSearchAnime: () => ({ provider: 'reanime', id: 'one' }),
    communityLabel: (_source, result) => `Anissia · ${result.maker} 자막`,
    renderAnissiaMakers() {},
    attachSubtitle(url, label, options) { attached.push({ url, label, source: options.source }); },
    window: { lilac: { findSubtitle: (_source, _title, _episode, _anime, options) => new Promise((resolve, reject) => pending.push({ maker: options.maker, resolve, reject })) } }
  });
  vm.runInContext(section('async function selectAnissiaMaker(', '// Writes one subtitle setting'), context);

  const first = context.selectAnissiaMaker('A');
  const second = context.selectAnissiaMaker('B');
  pending[1].resolve({ maker: 'B', path: 'b.vtt', url: 'subtitle://b' });
  await second;
  pending[0].reject(new Error('earlier maker failed late'));
  await first;

  assert.deepEqual(attached, [{ url: 'subtitle://b', label: 'Anissia · B 자막', source: 'anissia' }]);
  assert.equal(context.currentSubtitlePath, 'b.vtt');
});

test('a saved-subtitle lookup started on the previous episode cannot apply to the new episode', async () => {
  const h = subtitleSourceHarness();
  const pending = h.context.selectSubtitleSource('kairan');
  h.context.playbackRequestId++;
  h.context.currentPlaybackContext = { episodeKey: 'reanime:two', anime: { provider: 'reanime', id: 'one' } };
  h.savedRequests[0].resolve([{ source: 'kairan', path: 'episode-one.vtt', url: 'subtitle://episode-one' }]);

  await pending;
  assert.deepEqual(h.searched, []);
  assert.deepEqual(h.attached, []);
});

test('automatic subtitle lookup yields when the user changes the subtitle source', async () => {
  let resolveSaved;
  const context = vm.createContext({
    playbackRequestId: 1,
    subtitleSelectionRequestId: 0,
    currentPlaybackContext: {},
    ONLINE_SUBTITLE_SOURCES: [],
    localStorage: { getItem: () => null },
    preferredSubtitleSource: () => 'reanime',
    subtitleStoreKey: () => 'reanime:one',
    window: { lilac: { savedSubtitles: () => new Promise(resolve => { resolveSaved = resolve; }) } },
    $: () => ({ classList: { add() {} } })
  });
  vm.runInContext(appSection('async function ensureSubtitle(', '// 설정 > 자막 자동 번역 translates from the best source'), context);
  const pending = context.ensureSubtitle(null, '테스트 애니', 1);
  context.subtitleSelectionRequestId++;
  resolveSaved([]);
  assert.equal(await pending, false);
});

function koreanSubtitleOfferHarness() {
  let resolveSearch;
  const currentSubtitle = { source: 'provider', url: 'provider-subtitle.vtt' };
  const box = { classList: classList('hidden') }, offerText = { textContent: '' }, applyButton = { textContent: '', onclick: null }, dismissButton = { onclick: null }, syncButton = { textContent: '', onclick: null }, syncCheck = { checked: true }, prepareNext = [{}, {}, {}], arrowVolume = {}, attached = [];
  const context = vm.createContext({
    playbackRequestId: 3, subtitleSelectionRequestId: 6, currentSubtitle,
    window: { lilac: { onSubtitleSyncStatus() {} } },
    localStorage: { getItem: () => null },
    onlineSubtitleFor: () => new Promise(resolve => { resolveSearch = resolve; }),
    subtitleSearchAnime: () => ({ provider: 'reanime', id: 'test' }),
    communityLabel: () => 'Kairan 자막',
    clearTimeout() {}, setTimeout: () => 1,
    $: selector => ({ '#subtitleOffer': box, '#subtitleOfferText': offerText, '#subtitleOfferApply': applyButton, '#subtitleOfferDismiss': dismissButton, '#autoSyncSubtitle': syncButton, '#subtitleSyncCheck': syncCheck, '#subtitleState': { textContent: '' }, '#prepareNextVideo': prepareNext[0], '#prepareNextSubtitle': prepareNext[1], '#prepareNextTranslation': prepareNext[2], '#arrowVolume': arrowVolume }[selector]),
    preferAiSubtitle() {}, attachOnlineSubtitle: result => attached.push(result)
  });
  vm.runInContext(appSection('async function offerKoreanSubtitle(', 'async function ensureSubtitle('), context);
  return { context, box, offerText, applyButton, currentSubtitle, attached, resolveSearch: result => resolveSearch(result) };
}

test('a late Korean subtitle offer is suppressed after the user starts a new source selection', async () => {
  const h = koreanSubtitleOfferHarness();
  const pending = h.context.offerKoreanSubtitle('테스트 애니', 1, 3, 6, h.currentSubtitle);
  h.context.subtitleSelectionRequestId++;
  h.resolveSearch({ source: 'kairan', result: {} });
  await pending;

  assert.equal(h.box.classList.contains('hidden'), true);
  assert.equal(h.offerText.textContent, '');
  assert.equal(h.applyButton.onclick, null);
  assert.deepEqual(h.attached, []);
});

test('a visible Korean subtitle offer cannot replace a source selected after it appeared', async () => {
  const h = koreanSubtitleOfferHarness();
  const pending = h.context.offerKoreanSubtitle('테스트 애니', 1, 3, 6, h.currentSubtitle);
  h.resolveSearch({ source: 'kairan', result: {} });
  await pending;
  assert.equal(h.box.classList.contains('hidden'), false);

  h.context.subtitleSelectionRequestId++;
  h.applyButton.onclick();
  assert.equal(h.box.classList.contains('hidden'), true);
  assert.deepEqual(h.attached, []);
});

test('an explicit subtitle choice invalidates and cancels pending translations', () => {
  const offer = { classList: classList() }, cloud = { dataset: { run: '2' } }, local = { dataset: { run: '3' } }, cancelled = [];
  const context = vm.createContext({
    subtitleSelectionRequestId: 4,
    translationRun: 9,
    $: selector => ({ '#subtitleOffer': offer, '#translateNow': cloud, '#translateNowLocal': local }[selector]),
    cancelButtonRun: button => cancelled.push(button),
  });
  vm.runInContext(appSection('function beginSubtitleSelection()', '\nfunction cancelOtherEpisodeTranslations'), context);

  assert.equal(context.beginSubtitleSelection(), 5);
  assert.equal(context.translationRun, 10);
  assert.equal(offer.classList.contains('hidden'), true);
  assert.deepEqual(cancelled, [cloud, local]);
});

test('a late subtitle search result cannot override a newer source choice', async () => {
  const h = subtitleSourceHarness();
  const first = h.context.selectSubtitleSource('kairan');
  h.savedRequests[0].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.searched.join(','), 'kairan');

  const second = h.context.selectSubtitleSource('csora');
  h.savedRequests[1].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.searched.join(','), 'kairan,csora');
  h.findRequests[1].resolve({ path: 'csora.vtt', url: 'subtitle://csora' });
  await second;
  h.findRequests[0].resolve({ path: 'kairan.vtt', url: 'subtitle://kairan' });
  await first;

  assert.deepEqual(h.attached, ['csora']);
});
