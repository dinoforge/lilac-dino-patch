'use strict';
(() => {
  const features = window.DinoLilacPatchFeatures || {};
  if (features['patch-04'] !== true) return;
  const unknown = '확인 불가';
  const video = document.querySelector('#video');
  const stage = document.querySelector('#videoStage');
  const settings = document.querySelector('#playerSettings');
  if (!video || !stage || !settings) return;

  if (!document.querySelector('#patch04PlaybackStatsStyle')) {
    const link = document.createElement('link');
    link.id = 'patch04PlaybackStatsStyle';
    link.rel = 'stylesheet';
    link.href = 'patch04-playback-stats.css';
    document.head.append(link);
  }

  const overlay = document.createElement('section');
  overlay.id = 'patch04PlaybackStatsOverlay';
  overlay.className = 'patch04-playback-stats hidden';
  overlay.setAttribute('aria-label', '실시간 영상 재생 정보');
  overlay.setAttribute('aria-live', 'off');
  stage.append(overlay);

  const group = document.createElement('section');
  group.className = 'ps-section patch04-playback-stats-setting';
  group.innerHTML = '<p class="ps-group">재생 정보</p><label class="ps-switch"><span><b>실시간 재생 정보 오버레이</b><small>실제로 확인된 재생 통계만 표시합니다</small></span><input id="patch04PlaybackStatsToggle" type="checkbox"></label>';
  const quality = settings.querySelector('#psQuality');
  (quality?.parentElement || settings).append(group);
  const toggle = group.querySelector('#patch04PlaybackStatsToggle');
  const storageKey = 'playerPlaybackStats';
  const enabled = () => {
    try { return localStorage.getItem(storageKey) === 'true'; } catch { return false; }
  };
  let timer = null, frameRequest = null, startedAt = 0, frameCount = 0;
  let lastPresented = null, measuredFps = null, measuredAt = 0;
  const fmtTime = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const value = Math.floor(seconds), h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const value = (item, suffix = '') => item == null || item === '' ? unknown : `${item}${suffix}`;
  const currentLevel = () => {
    try {
      if (typeof hlsPlayer === 'undefined' || !hlsPlayer?.levels?.length) return null;
      const index = hlsPlayer.manualLevel >= 0 ? hlsPlayer.manualLevel : hlsPlayer.currentLevel;
      return Number.isInteger(index) && index >= 0 ? hlsPlayer.levels[index] || null : null;
    } catch { return null; }
  };
  const playbackContext = () => {
    try { return typeof currentPlaybackContext === 'undefined' ? {} : currentPlaybackContext || {}; }
    catch { return {}; }
  };
  const serverDomain = () => {
    try {
      const context = playbackContext();
      return new URL(context.currentUrl || video.currentSrc || video.src).hostname || unknown;
    } catch { return unknown; }
  };
  const format = () => {
    const level = currentLevel();
    const resolution = video.videoWidth > 0 && video.videoHeight > 0 ? `${video.videoWidth}×${video.videoHeight}` : null;
    const liveFps = !video.paused && measuredFps != null && performance.now() - measuredAt < 1600 ? measuredFps.toFixed(1) : null;
    let dropped = null;
    try {
      const quality = video.getVideoPlaybackQuality?.();
      if (quality && Number.isFinite(quality.droppedVideoFrames)) dropped = String(quality.droppedVideoFrames);
    } catch { /* API not exposed */ }
    const codecs = [level?.videoCodec, level?.audioCodec].filter(item => typeof item === 'string' && item.trim()).join(' / ') || null;
    const bitrate = Number(level?.averageBitrate || level?.bitrate);
    const bitrateLabel = Number.isFinite(bitrate) && bitrate > 0 ? `${(bitrate / 1_000_000).toFixed(2)} Mbps` : null;
    const hls = level ? `${level.width || '?'}×${level.height || '?'}${bitrateLabel ? ` · ${bitrateLabel}` : ''}` : null;
    let ahead = null;
    try {
      for (let index = video.buffered.length - 1; index >= 0; index--) {
        if (video.currentTime >= video.buffered.start(index) && video.currentTime <= video.buffered.end(index)) {
          ahead = Math.max(0, video.buffered.end(index) - video.currentTime); break;
        }
      }
    } catch { /* buffered ranges not exposed */ }
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    const context = playbackContext();
    const provider = context.videoServer || context.episode?.provider || context.resolveKind || null;
    return [
      `해상도 ${value(resolution)}`,
      `FPS ${value(liveFps)} · 드롭 프레임 ${value(dropped)}`,
      `영상·오디오 코덱 ${value(codecs)}`,
      `HLS 화질·비트레이트 ${value(hls)}`,
      `재생 ${value(fmtTime(video.currentTime))} / ${value(fmtTime(duration))} · 속도 ${value(Number.isFinite(video.playbackRate) ? video.playbackRate.toFixed(2) : null, 'x')}`,
      `버퍼 ${value(ahead == null ? null : ahead.toFixed(1), ahead == null ? '' : '초')}`,
      `공급원 ${value(provider)} · 서버 ${serverDomain()}`
    ].join('\n');
  };
  const update = () => { if (enabled()) overlay.textContent = format(); };
  const stopFrames = () => {
    if (frameRequest != null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameRequest);
    frameRequest = null; startedAt = 0; frameCount = 0; lastPresented = null;
  };
  const watchFrames = (_now, metadata) => {
    frameRequest = null;
    if (!enabled()) return;
    const now = performance.now(), presented = Number(metadata?.presentedFrames);
    if (!startedAt) { startedAt = now; frameCount = 0; lastPresented = Number.isFinite(presented) ? presented : null; }
    else {
      frameCount += Number.isFinite(presented) && lastPresented != null ? Math.max(0, presented - lastPresented) : 1;
      if (Number.isFinite(presented)) lastPresented = presented;
      const elapsed = now - startedAt;
      if (elapsed >= 1000) { measuredFps = frameCount * 1000 / elapsed; measuredAt = now; startedAt = now; frameCount = 0; update(); }
    }
    if (enabled() && typeof video.requestVideoFrameCallback === 'function') frameRequest = video.requestVideoFrameCallback(watchFrames);
  };
  const startFrames = () => {
    if (!enabled() || video.paused || typeof video.requestVideoFrameCallback !== 'function' || frameRequest != null) return;
    startedAt = 0; frameCount = 0; lastPresented = null; frameRequest = video.requestVideoFrameCallback(watchFrames);
  };
  const setEnabled = state => {
    try { localStorage.setItem(storageKey, String(Boolean(state))); } catch { /* preference storage unavailable */ }
    toggle.checked = Boolean(state); overlay.classList.toggle('hidden', !state);
    if (state) { update(); if (!timer) timer = setInterval(update, 500); startFrames(); }
    else { if (timer) clearInterval(timer); timer = null; stopFrames(); }
  };
  toggle.addEventListener('change', () => setEnabled(toggle.checked));
  for (const name of ['loadedmetadata', 'timeupdate', 'progress', 'ratechange', 'playing', 'pause', 'waiting', 'seeked', 'emptied']) {
    video.addEventListener(name, () => { if (name === 'playing') startFrames(); if (name === 'pause') stopFrames(); update(); });
  }
  setEnabled(enabled());
})();
