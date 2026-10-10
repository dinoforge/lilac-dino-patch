'use strict';

// Screen rectangles must be in the same coordinate space (Electron DIP), not mixed
// Win32 physical pixels and device-independent pixels. No process/app access here.
function isRect(value) {
  return value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) &&
    value.width > 0 && value.height > 0;
}

function dockOverlay(target, workArea, options = {}) {
  if (!isRect(target) || !isRect(workArea)) return { mode: 'unavailable', bounds: null };
  const width = Number(options.width ?? 338);
  const height = Number(options.height ?? 510);
  const gap = Number(options.gap ?? 12);
  if (![width, height, gap].every(Number.isFinite) || width <= 0 || height <= 0 || gap < 0)
    return { mode: 'unavailable', bounds: null };
  // Never cover the target window. If no side has room, stay separate/manual.
  if (width > workArea.width || height > workArea.height) return { mode: 'manual', bounds: null };
  const right = target.x + target.width + gap;
  const left = target.x - gap - width;
  const rightFits = right + width <= workArea.x + workArea.width;
  const leftFits = left >= workArea.x;
  let x, side;
  if (rightFits) { x = right; side = 'right'; }
  else if (leftFits) { x = left; side = 'left'; }
  else return { mode: 'manual', bounds: null };
  const y = Math.max(workArea.y, Math.min(target.y, workArea.y + workArea.height - height));
  return { mode: 'docked', side, bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } };
}

module.exports = { isRect, dockOverlay };
