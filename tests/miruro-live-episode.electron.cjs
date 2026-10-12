'use strict';
// Real Miruro episode smoke through the application's own provider IPC and Hls.js.
// Audio codec presence is not audible audio output. VTT cues are not proof the
// production subtitle overlay was displayed. No full-episode playback is attempted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = process.env.DINO_MIRURO_LIVE_ROOT || '';
const base = fs.realpathSync(os.tmpdir());
if (process.env.DINO_MIRURO_LIVE_OPT_IN !== '1' || !root ||
    path.dirname(path.resolve(root)) !== base ||
    !/^dino-miruro-live-fixture-[a-zA-Z0-9_-]+$/.test(path.basename(root)) ||
    !fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) {
  throw new Error('Refusing live provider test without isolated opt-in workspace');
}
for (const folder of ['userData', 'sessionData']) fs.mkdirSync(path.join(root, folder), { recursive: true });
app.setPath('userData', path.join(root, 'userData'));
app.setPath('sessionData', path.join(root, 'sessionData'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
require('../electron/main.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function getAppWindow() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (win && !win.webContents.isLoadingMainFrame()) {
      const ready = await win.webContents.executeJavaScript(
        "Boolean(window.lilac?.providerResolve && window.lilac?.providerCatalog && window.Hls && document.getElementById('video'))"
      ).catch(() => false);
      if (ready) return win;
    }
    await sleep(250);
  }
  throw new Error('Real application renderer/preload did not become ready');
}

async function selectEpisode() {
  const response = await window.lilac.providerCatalog('miruro', 'Frieren');
  const anime = (response.data || []).find(x =>
    Number(x.anilistId) === 154587 || Number(x.malId) === 52991);
  if (!anime || String(anime.year) !== '2023')
    throw new Error('Frieren season 1 (AniList 154587 / MAL 52991; 2023) not found');
  const detail = await window.lilac.providerDetail(anime);
  const episode = (detail.episodes || []).find(x => Number(x.number) === 1);
  if (!episode) throw new Error('Frieren season 1 episode 1 not listed as playable');
  const first = await window.lilac.providerResolve({ ...episode, prefer: 'sub' });
  const options = (first.servers || []).filter(x => x.kind === 'soft');
  if (!options.length) throw new Error('No Miruro SOFT server reported for episode 1');
  let stream = null; let lastError = '';
  for (const option of options.slice(0, 5)) {
    try {
      const found = await window.lilac.providerResolve({ ...episode,
        server: option.label, serverOnly: true });
      if (found.server === option.label) { stream = found; break; }
    } catch (error) { lastError = error.message; }
  }
  if (!stream) throw new Error('SOFT playlist unavailable: ' + lastError);
  return { title: anime.title, episode: episode.number, server: stream.server,
    url: stream.url, referer: stream.referer,
    subtitleTracks: stream.subtitleTracks || [] };
}

function probePlayback(url) {
  return new Promise(resolve => {
    const video = document.getElementById('video');
    const hls = new Hls({ enableWorker: false });
    let finished = false, playbackStarted = false, codecVideo = false, codecAudio = false;
    let decodedFrames = 0, frameCallbacks = 0;
    const stop = (reason = '') => {
      if (finished) return;
      finished = true; clearInterval(interval); clearTimeout(timeout);
      const output = { ok: !reason, reason, playbackStarted,
        frameCount: Math.max(decodedFrames, frameCallbacks),
        currentTime: video.currentTime, duration: video.duration,
        width: video.videoWidth, height: video.videoHeight,
        videoCodecObserved: codecVideo, audioCodecObserved: codecAudio,
        audioOutputHeard: 'not_tested', fullEpisodeCompleted: false };
      video.pause(); hls.destroy(); resolve(output);
    };
    const onFrame = () => {
      if (finished) return;
      frameCallbacks++;
      video.requestVideoFrameCallback?.(onFrame);
    };
    video.muted = true;
    video.style.display = 'block';
    video.preload = 'auto';
    video.addEventListener('playing', () => { playbackStarted = true; }, { once: true });
    video.addEventListener('error', () => stop('video_error_' + video.error?.code), { once: true });
    hls.on(Hls.Events.BUFFER_CODECS, (_, data) => {
      codecVideo ||= Boolean(data?.video || data?.audiovideo);
      codecAudio ||= Boolean(data?.audio || data?.audiovideo);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      codecAudio ||= hls.levels.some(x => Boolean(x.audioCodec)) || hls.audioTracks.length > 0;
      video.play().catch(error => stop('play_rejected_' + error.message));
      video.requestVideoFrameCallback?.(onFrame);
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) stop('hls_' + String(data.details || data.type || 'unknown'));
    });
    const interval = setInterval(() => {
      decodedFrames = Math.max(decodedFrames, video.getVideoPlaybackQuality?.().totalVideoFrames || 0);
      if (playbackStarted && video.currentTime >= 1.4 && decodedFrames >= 2 && video.videoWidth > 0)
        stop();
    }, 150);
    const timeout = setTimeout(() => stop('timeout'), 90000);
    if (!Hls.isSupported()) return stop('hls_not_supported');
    hls.loadSource(url);
    hls.attachMedia(video);
  });
}

async function runTest() {
  const win = await getAppWindow();
  const script = fn => '(' + fn.toString() + ')()';
  const selected = await win.webContents.executeJavaScript(script(selectEpisode), true);
  assert.match(selected.url, /^https:\/\//);
  console.log('miruro_live_catalog=ok');
  console.log('miruro_live_episode=1');
  console.log('miruro_live_hls_url_resolved=true'); // Never print stream URLs or tokens.
  console.log('miruro_live_soft_server=' + JSON.stringify(selected.server));
  console.log('miruro_live_subtitle_track_count=' + selected.subtitleTracks.length);
  const track = selected.subtitleTracks.find(x => /^ko(?:[-_]|$)/i.test(x.language || '')) ||
    selected.subtitleTracks.find(x => /^en(?:[-_]|$)/i.test(x.language || '')) ||
    selected.subtitleTracks.find(x => /^ja(?:[-_]|$)/i.test(x.language || '')) ||
    selected.subtitleTracks[0];
  let subtitle = { available: false, validVtt: false, cueCount: 0 };
  if (track) {
    try {
      const code = 'window.lilac.remoteSubtitle(' + JSON.stringify(track.url) + ',' +
        JSON.stringify(selected.referer || '') + ')';
      const saved = await win.webContents.executeJavaScript(code, true);
      const data = fs.readFileSync(saved.path, 'utf8');
      subtitle = { available: true, language: track.language,
        validVtt: /^WEBVTT/i.test(data.trimStart()), cueCount: (data.match(/\s-->\s/g) || []).length };
    } catch (error) {
      console.log('miruro_live_subtitle_fetch_error=' + JSON.stringify(error.message).slice(0, 300));
    }
  }
  console.log('miruro_live_subtitle=' + JSON.stringify(subtitle));
  const playbackScript = '(' + probePlayback.toString() + ')(' + JSON.stringify(selected.url) + ')';
  const metrics = await win.webContents.executeJavaScript(playbackScript, true);
  console.log('miruro_live_frame_metrics=' + JSON.stringify(metrics));
  assert.equal(metrics.ok, true, 'Real video decoding did not pass');
  assert.equal(metrics.playbackStarted, true);
  assert.ok(metrics.frameCount >= 2 && metrics.currentTime >= 1.4 && metrics.width > 0);
  console.log('miruro_live_video_frames=pass');
  console.log('miruro_live_audio_codec=' + (metrics.audioCodecObserved ? 'observed' : 'unverified'));
  console.log('miruro_live_subtitles=' + (subtitle.validVtt && subtitle.cueCount > 0 ? 'file_cues_verified' : 'unverified'));
  console.log('miruro_live_audible_sound=not_tested');
  console.log('miruro_live_subtitle_on_screen=not_tested');
  console.log('miruro_live_full_episode=not_tested');
}
app.whenReady().then(async () => {
  let code = 1;
  try { await runTest(); code = 0; }
  catch (error) { console.error('miruro_live_test=failed: ' + String(error.stack || error).slice(0, 1500)); }
  finally {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    app.exit(code);
  }
}).catch(error => { console.error('miruro_live_test=failed: ' + error.message); app.exit(1); });
