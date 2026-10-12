'use strict';

// Real Chromium frame decoding test with a GENERATED animated fixture.
// This is NOT a live anime-provider episode test. No external site, account,
// browser cookie, installed LilacAnime profile or user media is accessed.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = process.env.DINO_ANIMATION_PLAYBACK_ROOT || '';
const resolved = path.resolve(root);
const base = fs.realpathSync(os.tmpdir());
if (!root || path.dirname(resolved) !== base ||
    !/^dino-anime-playback-fixture-[a-zA-Z0-9_-]+$/.test(path.basename(resolved)) ||
    !fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink()) {
  throw new Error('Refusing unsafe synthetic animation workspace');
}
const videoFile = path.join(resolved, 'moving-animation.webm');
if (!fs.statSync(videoFile).isFile() || fs.lstatSync(videoFile).isSymbolicLink()) {
  throw new Error('Missing generated synthetic WebM');
}
for (const folder of ['profile', 'session']) fs.mkdirSync(path.join(resolved, folder), { recursive: true });
app.setPath('userData', path.join(resolved, 'profile'));
app.setPath('sessionData', path.join(resolved, 'session'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration();

const htmlPath = path.join(resolved, 'player.html');
fs.writeFileSync(htmlPath, [
  '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  '<video id="video" muted playsinline preload="auto" width="320" height="180"></video>',
  '<canvas id="probe" width="64" height="36"></canvas>',
  '</body></html>'
].join(''), 'utf8');

app.whenReady().then(async () => {
  let win;
  let code = 1;
  try {
    win = new BrowserWindow({
      show: false, width: 480, height: 320,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    });
    await win.loadFile(htmlPath);
    const uri = pathToFileURL(videoFile).href;
    const script = "new Promise(resolve => {\n  const video = document.getElementById('video');\n  const canvas = document.getElementById('probe');\n  const context = canvas.getContext('2d', { willReadFrequently: true });\n  let first = null, frames = 0, playing = false, completed = false;\n  const started = performance.now();\n  const checksum = () => {\n    context.drawImage(video, 0, 0, 64, 36);\n    const data = context.getImageData(0, 0, 64, 36).data;\n    let hash = 2166136261;\n    for (let n = 0; n < data.length; n += 4) {\n      hash ^= (data[n] ^ (data[n + 1] << 8) ^ (data[n + 2] << 16));\n      hash = Math.imul(hash, 16777619);\n    }\n    return hash >>> 0;\n  };\n  const finish = value => {\n    if (completed) return;\n    completed = true; clearInterval(interval);\n    resolve({ ...value, playing, width: video.videoWidth, height: video.videoHeight,\n      duration: video.duration, time: video.currentTime, readyState: video.readyState,\n      decodedFrameChecks: frames });\n  };\n  video.addEventListener('playing', () => { playing = true; });\n  video.addEventListener('error', () => finish({ ok: false, reason: 'video-error-' + (video.error?.code || '?') }));\n  const interval = setInterval(() => {\n    if (performance.now() - started > 12000) return finish({ ok: false, reason: 'timeout' });\n    if (video.error) return finish({ ok: false, reason: 'video-error-' + video.error.code });\n    if (video.readyState >= 2 && video.currentTime >= 0.25 && video.videoWidth > 0) {\n      try {\n        const hash = checksum();\n        frames++;\n        if (first === null) first = hash;\n        if (video.currentTime >= 1.35 && hash !== first) return finish({ ok: true, changedFrames: true });\n      } catch (error) { return finish({ ok: false, reason: 'frame-read-' + error.message }); }\n    }\n  }, 130);\n  video.src = __URI__;\n  video.play().catch(error => finish({ ok: false, reason: 'play-rejected-' + error.message }));\n})".replace('__URI__', JSON.stringify(uri));
    const metrics = await win.webContents.executeJavaScript(script, true);
    assert.equal(metrics.ok, true, JSON.stringify(metrics));
    assert.equal(metrics.playing, true, 'playing event was emitted');
    assert.equal(metrics.changedFrames, true, 'actual decoded animation frames changed');
    assert.equal(metrics.width, 320);
    assert.equal(metrics.height, 180);
    assert.ok(metrics.duration >= 3.5);
    assert.ok(metrics.time >= 1.35);
    assert.ok(metrics.readyState >= 2);
    console.log('synthetic_animation_video_playback=ok');
    console.log('synthetic_animation_metrics=' + JSON.stringify(metrics));
    console.log('real_anime_provider_episode_tested=false');
    code = 0;
  } catch (error) {
    console.error('synthetic_animation_video_playback=failed: ' + (error.stack || error));
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(code);
  }
}).catch(error => {
  console.error('synthetic_animation_video_playback=failed: ' + (error.stack || error));
  app.exit(1);
});
