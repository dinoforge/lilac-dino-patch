'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const base = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(base, 'dino-anime-playback-fixture-'));
if (path.dirname(path.resolve(root)) !== base ||
    !/^dino-anime-playback-fixture-[a-zA-Z0-9_-]+$/.test(path.basename(root)) ||
    fs.lstatSync(root).isSymbolicLink()) {
  throw new Error('Refusing unexpected animation test workspace');
}

let code = 1;
try {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('Bundled test encoder is unavailable');
  const output = path.join(root, 'moving-animation.webm');
  const encode = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=12:duration=4',
    '-an', '-c:v', 'libvpx', '-pix_fmt', 'yuv420p',
    '-deadline', 'realtime', '-cpu-used', '6', '-b:v', '350k',
    '-y', output
  ], { stdio: 'pipe', encoding: 'utf8', timeout: 30000 });
  if (encode.error || encode.status !== 0) {
    throw new Error('Synthetic test animation encoding failed: ' + (encode.error?.message || encode.stderr || encode.status));
  }
  if (fs.statSync(output).size < 2000) throw new Error('Encoded test animation is empty');
  console.log('synthetic_animation_file_generated=true');
  const electron = spawnSync(process.execPath, [
    path.join(repo, 'node_modules', 'electron', 'cli.js'),
    path.join(repo, 'tests', 'isolated-animation-playback.electron.cjs')
  ], {
    cwd: repo, stdio: 'inherit', timeout: 30000,
    env: { ...process.env, DINO_ANIMATION_PLAYBACK_ROOT: root }
  });
  if (electron.error) throw electron.error;
  code = Number.isInteger(electron.status) ? electron.status : 1;
  if (code !== 0) throw new Error('Chromium decoded-frame playback failed (exit ' + code + ')');
} catch (error) {
  console.error('synthetic_animation_playback_test_error=' + error.message);
  code = 1;
} finally {
  try {
    const current = fs.realpathSync(root);
    if (path.dirname(current) !== base ||
        !/^dino-anime-playback-fixture-[a-zA-Z0-9_-]+$/.test(path.basename(current)) ||
        fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Refusing unsafe animation cleanup');
    }
    fs.rmSync(current, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch (error) {
    console.warn('Synthetic-only test workspace cleanup failed: ' + error.message);
    code = 1;
  }
}
process.exitCode = code;
