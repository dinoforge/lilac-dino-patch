const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/player.js'), 'utf8');

test('the auto-skip clock pauses with the video and resumes without counting paused time', () => {
  const start = source.indexOf('function resetAutoSkipState()');
  const end = source.indexOf('function setPlayerLocked(', start);
  assert.ok(start >= 0 && end > start, 'auto-skip clock implementation exists');

  let now = 0;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    autoSkipState: { enteredKey: null, enteredAt: 0, pausedAt: null, skippedKey: null, manualSeekTime: null },
    activeSkip: { startTime: 10, endTime: 20 },
    activeSkipKey: 'opening',
    playerFlag: () => true,
    $: () => ({ classList: { toggle() {} } })
  });
  vm.runInContext(source.slice(start, end), context);

  const video = { paused: false, currentTime: 10 };
  context.updateSkipState(video);
  now = 1_000;
  context.pauseAutoSkipClock();
  video.paused = true;
  now = 10_000;
  context.updateSkipState(video);
  context.resumeAutoSkipClock();
  video.paused = false;
  context.updateSkipState(video);
  assert.equal(video.currentTime, 10, 'the paused interval does not trigger auto-skip on resume');

  now = 11_500;
  context.updateSkipState(video);
  assert.equal(video.currentTime, 20, 'auto-skip still occurs after 2.5 seconds of unpaused viewing');
});

test('video pause and play events control the auto-skip clock', () => {
  assert.ok(source.includes("$('#video').addEventListener('pause', pauseAutoSkipClock);"), 'pause freezes the skip timer');
  assert.ok(source.includes("$('#video').addEventListener('play', resumeAutoSkipClock);"), 'play resumes the skip timer');
});
