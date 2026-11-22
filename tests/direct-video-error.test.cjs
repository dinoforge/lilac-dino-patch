const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const failureStart = appSource.indexOf('function showPlayerFailure(');
const failureEnd = appSource.indexOf('\nasync function resolveIntoPlayer(', failureStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart, 'Missing shared player failure UI');
const failureUiSource = appSource.slice(failureStart, failureEnd);
const start = appSource.indexOf('function handleDirectVideoError(');
const end = appSource.indexOf("\n$('#video').addEventListener('error',handleDirectVideoError);", start);
assert.ok(start >= 0 && end > start, 'Missing direct video error handler');
const handlerSource = appSource.slice(start, end);
const resolverStart = appSource.indexOf('async function resolveIntoPlayer(');
const resolverEnd = appSource.indexOf('\nfunction bindHlsPlayerEvents(', resolverStart);
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart, 'Missing stream resolver');
const resolverSource = appSource.slice(resolverStart, resolverEnd);

function element(...initialClasses) {
  const classes = new Set(initialClasses);
  return { classList: {
    contains: value => classes.has(value),
    add: value => classes.add(value),
    remove: value => classes.delete(value)
  }, textContent: '' };
}

function setup({ error, currentUrl = 'https://media.test/episode.mp4', hlsPlayer = null } = {}) {
  const video = { error }, playerEmpty = element('hidden'), playerMessage = { textContent: '' }, spinner = element(), status = { textContent: '' }, diagnostics = element('hidden'), diagnosticStatus = { textContent: '' }, calls = [], failures = [];
  const elements = { '#video': video, '#playerBack': { addEventListener() {} }, '#playerEmpty': playerEmpty, '#playerEmpty p': playerMessage, '.player-spinner': spinner, '#downloadStatus': status, '#playerDiagnosticActions': diagnostics, '#playerDiagnosticStatus': diagnosticStatus, '#copyPlayerDiagnostics': { addEventListener() {} } };
  const context = vm.createContext({
    $: selector => elements[selector],
    currentPlaybackContext: { currentUrl },
    markUnfinishedProviderPlayback() {},
    playbackHttpStatus: () => 0,
    trackProviderPlaybackAttempt() {},
    hlsPlayer,
    showPlayerControls: () => calls.push('controls'),
    recordPlayerFailure: failure => failures.push(failure)
  });
  vm.runInContext(`${failureUiSource}\n${handlerSource}`, context);
  return { context, video, playerEmpty, playerMessage, spinner, status, diagnostics, diagnosticStatus, calls, failures };
}

test('native video errors stop the loading spinner and explain common playback failures', () => {
  const cases = [
    [2, '영상 서버와 연결이 끊겼습니다.'],
    [3, '영상 데이터를 재생할 수 없습니다.'],
    [4, '지원하지 않는 영상 형식입니다.'],
    [9, '영상을 재생하지 못했습니다.']
  ];
  for (const [code, expected] of cases) {
    const h = setup({ error: { code } });
    h.context.handleDirectVideoError();
    assert.equal(h.playerEmpty.classList.contains('hidden'), false, `error ${code}`);
    assert.equal(h.spinner.classList.contains('hidden'), true, `error ${code}`);
    assert.equal(h.playerMessage.textContent, expected, `error ${code}`);
    assert.equal(h.diagnostics.classList.contains('hidden'), false);
    assert.equal(h.status.textContent, expected, `error ${code}`);
    assert.deepEqual(h.calls, ['controls'], `error ${code}`);
    assert.equal(h.failures[0].stage, 'direct-playback');
    assert.equal(h.failures[0].videoErrorCode, code);
  }
});

test('native error reporting ignores HLS, missing sources, absent errors, and expected aborts', () => {
  for (const options of [
    { error: { code: 4 }, hlsPlayer: {} },
    { error: { code: 4 }, currentUrl: '' },
    { error: null },
    { error: { code: 1 } }
  ]) {
    const h = setup(options);
    h.context.handleDirectVideoError();
    assert.equal(h.playerEmpty.classList.contains('hidden'), true);
    assert.equal(h.spinner.classList.contains('hidden'), false);
    assert.equal(h.status.textContent, '');
    assert.deepEqual(h.calls, []);
  }
});

test('the video element forwards its native error event to the handler', () => {
  assert.match(appSource, /\$\('#video'\)\.addEventListener\('error',handleDirectVideoError\)/);
});

test('stream resolution failures share the stopped-spinner failure surface', () => {
  assert.match(resolverSource, /showPlayerFailure\('영상을 불러오지 못했어요',\{stage:'stream-resolution'/);
  const h = setup();
  h.context.showPlayerFailure('영상을 불러오지 못했어요');
  assert.equal(h.playerEmpty.classList.contains('hidden'), false);
  assert.equal(h.spinner.classList.contains('hidden'), true);
  assert.equal(h.playerMessage.textContent, '영상을 불러오지 못했어요');
  assert.equal(h.diagnostics.classList.contains('hidden'), false);
  assert.deepEqual(h.calls, ['controls']);
});
