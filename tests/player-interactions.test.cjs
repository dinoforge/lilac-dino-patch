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
  const h = setup(); vm.runInContext(section('function vttLines(', '// VTT cues drawn'), h.context);
  const ctx = { measureText: value => ({ width: [...value].length * 10 }) };
  for (const text of ['아주 긴 대사가 창 너비를 넘어도 잘리지 않습니다', '空白のないとても長い字幕も折り返します', '<i>첫째 줄</i>\n둘째 줄 &amp; 마지막']) {
    const lines = h.context.vttLines(ctx, text, 80);
    assert.ok(lines.length > 1); assert.ok(lines.every(line => ctx.measureText(line).width <= 80));
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

function scheduleHarness(linkkfSchedule) {
  const buttons = Array.from({ length: 8 }, () => ({ classList: classList(), attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } }));
  const rail = { classList: classList(), innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
  const retry = { classList: classList('hidden'), onclick: null };
  const context = vm.createContext({
    state: { season: [{ id: 'latest' }] }, window: { lilac: { linkkfSchedule } },
    $: selector => selector === '#scheduleRail' ? rail : selector === '#scheduleRetry' ? retry : null,
    $$: selector => selector === '#scheduleTabs button' ? buttons : [],
    renderCards: (_, items) => { rail.innerHTML = `cards:${items.map(item => item.id).join(',')}`; }
  });
  vm.runInContext(appSection('const SCHEDULE_TABS=', '\nasync function loadLinkkfHome()'), context);
  return { context, rail, retry, buttons };
}

test('weekday schedule distinguishes an empty day from a failed day and offers retry', async () => {
  const empty = scheduleHarness(async () => ({ days: Array.from({ length: 7 }, () => []), unavailableDays: [] }));
  await empty.context.loadLinkkfSchedule(1);
  assert.match(empty.rail.innerHTML, /등록된 작품이 없습니다/);
  assert.equal(empty.retry.classList.contains('hidden'), true);

  const failed = scheduleHarness(async () => ({ days: Array.from({ length: 7 }, () => []), unavailableDays: [0] }));
  await failed.context.loadLinkkfSchedule(1);
  assert.match(failed.rail.innerHTML, /일정 정보를 불러오지 못했습니다/);
  assert.equal(failed.retry.classList.contains('hidden'), false);
});

test('weekday schedule marks all days unavailable when the schedule request fails', async () => {
  const h = scheduleHarness(async () => { throw new Error('offline'); });
  await h.context.loadLinkkfSchedule(7);
  assert.match(h.rail.innerHTML, /일정 정보를 불러오지 못했습니다/);
  assert.equal(h.retry.classList.contains('hidden'), false);
  assert.equal(h.buttons[7].attrs['aria-selected'], 'true');
});

test('removing LinkAni migrates only the saved content source and preserves user data', () => {
  const storage = new Map([['contentSource', 'linkani'], ['history', '["keep"]'], ['library', '["keep"]']]);
  const context = vm.createContext({ localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value))
  } });
  vm.runInContext(appSection('function migrateContentSource(', '\nconst state ='), context);
  assert.equal(context.migrateContentSource('linkani'), 'reanime');
  assert.equal(storage.get('contentSource'), 'reanime');
  assert.equal(storage.get('history'), '["keep"]');
  assert.equal(storage.get('library'), '["keep"]');
  assert.equal(context.migrateContentSource('miruro'), 'miruro');
});

test('LinkAni is absent from source choices and online provider adapters', () => {
  const providerList = appSource.match(/const PROVIDER_SOURCES=\[([^\]]+)\]/)?.[1] || '';
  assert.ok(providerList);
  assert.doesNotMatch(providerList, /linkani/i);
  assert.doesNotMatch(indexHtml, /(?:data-value|option value)="linkani"/i);
  assert.doesNotMatch(mainSource, /LINKANI_WEB|linkaniFetch|linkaniItems|linkaniDetail|resolveLinkaniEpisode|provider\s*===\s*['"]linkani['"]/i);
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
  const box = { classList: classList('hidden') }, offerText = { textContent: '' }, applyButton = { textContent: '', onclick: null }, dismissButton = { onclick: null }, attached = [];
  const context = vm.createContext({
    playbackRequestId: 3, subtitleSelectionRequestId: 6, currentSubtitle,
    onlineSubtitleFor: () => new Promise(resolve => { resolveSearch = resolve; }),
    subtitleSearchAnime: () => ({ provider: 'reanime', id: 'test' }),
    communityLabel: () => 'Kairan 자막',
    clearTimeout() {}, setTimeout: () => 1,
    $: selector => ({ '#subtitleOffer': box, '#subtitleOfferText': offerText, '#subtitleOfferApply': applyButton, '#subtitleOfferDismiss': dismissButton }[selector]),
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
    renderManualChatgptPanel() {}
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
