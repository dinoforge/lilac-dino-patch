'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dockOverlay } = require('../overlay/geometry.cjs');
const display = { x: 0, y: 0, width: 1920, height: 1080 };

test('dock to the right of LilacAnime when the space is free', () => {
  assert.deepEqual(dockOverlay({ x: 100, y: 100, width: 1100, height: 760 }, display, { width: 338, height: 510, gap: 12 }), {
    mode: 'docked', side: 'right', bounds: { x: 1212, y: 100, width: 338, height: 510 }
  });
});
test('dock to the left when the right is full', () => {
  const d = dockOverlay({ x: 440, y: 20, width: 1200, height: 900 }, display);
  assert.equal(d.mode, 'docked');
  assert.equal(d.side, 'left');
  assert.equal(d.bounds.x + d.bounds.width < 440, true);
});
test('do not overlap the original if the screen has no side room', () => {
  assert.deepEqual(dockOverlay({ x: 0, y: 0, width: 1920, height: 1080 }, display), { mode: 'manual', bounds: null });
});
test('clamp vertically to work area, including non-zero display origins', () => {
  const d = dockOverlay({ x: -1150, y: 600, width: 600, height: 900 }, { x: -1600, y: 100, width: 1600, height: 900 }, { width: 340, height: 500, gap: 10 });
  assert.equal(d.mode, 'docked');
  assert.equal(d.bounds.y, 500);
});
test('reject mixed invalid input instead of guessing', () => {
  assert.equal(dockOverlay({ x: NaN, y: 0, width: 200, height: 300 }, display).mode, 'unavailable');
  assert.equal(dockOverlay({ x: 10, y: 10, width: 900, height: 700 }, display, { width: 0 }).mode, 'unavailable');
  assert.equal(dockOverlay({ x: 10, y: 10, width: 900, height: 700 }, display, { gap: -1 }).mode, 'unavailable');
});
