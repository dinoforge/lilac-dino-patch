const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const start = appSource.indexOf('function subtitleAvailabilityLabel');
const end = appSource.indexOf('\nfunction currentSubtitleAvailability', start);
assert.ok(start >= 0 && end > start, 'Missing subtitle availability status helpers');
const context = vm.createContext({});
vm.runInContext(`${appSource.slice(start, end)}\nthis.subtitleHelpers = { subtitleAvailabilityLabel, subtitleAvailabilityStatusFromError };`, context);
const helpers = context.subtitleHelpers;

test('subtitle provider status distinguishes found, missing, checking, and failed checks', () => {
  assert.equal(helpers.subtitleAvailabilityLabel('available'), '있음');
  assert.equal(helpers.subtitleAvailabilityLabel('unavailable'), '없음');
  assert.equal(helpers.subtitleAvailabilityLabel('checking'), '확인 중');
  assert.equal(helpers.subtitleAvailabilityLabel('error'), '확인 실패');
  assert.equal(helpers.subtitleAvailabilityLabel('unknown'), '미확인');
  assert.equal(helpers.subtitleAvailabilityStatusFromError(new Error('Kairan 자막 게시물을 찾지 못했습니다.')), 'unavailable');
  assert.equal(helpers.subtitleAvailabilityStatusFromError(new Error('사용 가능한 자막 파일을 추출하지 못했습니다.')), 'unavailable');
  assert.equal(helpers.subtitleAvailabilityStatusFromError(new Error('Csora HTTP 503')), 'error');
});

test('per-episode source chips are connected to online checks and retain the selected provider', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const player = fs.readFileSync(path.join(root, 'src/player.js'), 'utf8');
  assert.match(html, /data-source="kairan"><b>Kairan<\/b><small data-source-status aria-live="polite">미확인<\/small>/);
  assert.match(html, /data-source="csora"><b>Csora<\/b><small data-source-status aria-live="polite">미확인<\/small>/);
  assert.match(html, /data-source="anissia"><b>Anissia<\/b><small data-source-status aria-live="polite">미확인<\/small>/);
  assert.match(player, /setSubtitleAvailability\(source, 'checking', requestId\)/);
  assert.match(player, /setSubtitleAvailability\(source, 'available', requestId\)/);
});
