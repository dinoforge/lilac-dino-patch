'use strict';

(function attachDetailPlaybackInfo(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LilacDetailPlaybackInfo = api;
})(typeof globalThis === 'object' ? globalThis : this, function createDetailPlaybackInfo() {
  function value(value) {
    return value == null ? '' : String(value).trim();
  }

  function numberOf(episode) {
    const direct = Number(episode?.number);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const match = String(episode?.name || '').match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }

  function sameWork(anime, item) {
    const saved = item?.anime;
    if (!anime?.provider || anime.provider !== (saved?.provider || item?.episode?.provider)) return false;
    if (anime.id == null || saved?.id == null || String(anime.id) !== String(saved.id)) return false;
    for (const field of ['year', 'season', 'type']) {
      const current = value(anime[field]), prior = value(saved[field]);
      if (current && prior && current.toLocaleLowerCase() !== prior.toLocaleLowerCase()) return false;
    }
    return true;
  }

  function sameEpisode(episode, savedEpisode) {
    if (!episode || !savedEpisode) return false;
    const currentProvider = value(episode.provider), savedProvider = value(savedEpisode.provider);
    if (!currentProvider || !savedProvider || currentProvider !== savedProvider) return false;
    const currentNumber = numberOf(episode), savedNumber = numberOf(savedEpisode);
    if (currentNumber && savedNumber) return currentNumber === savedNumber && Boolean(episode.dub) === Boolean(savedEpisode.dub);
    const currentRef = value(episode.url || episode.token || episode.id);
    const savedRef = value(savedEpisode.url || savedEpisode.token || savedEpisode.id);
    return Boolean(currentRef && savedRef && currentRef === savedRef);
  }

  function summarize(anime, episodes, history) {
    if (!anime || !Array.isArray(episodes)) return null;
    const result = { episodeCount: episodes.length, resolution: '', format: '', resume: null };
    const records = (Array.isArray(history) ? history : [])
      .filter(item => sameWork(anime, item))
      .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));

    for (const item of records) {
      const episode = episodes.find(candidate => candidate.playable !== false && sameEpisode(candidate, item.episode));
      if (!episode) continue;

      const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
      const episodeNumber = numberOf(episode);
      if (episodeNumber > 0 && progress > 0 && progress < 100) {
        const positionSeconds = Number(item.positionSeconds);
        result.resume = {
          episode: episodeNumber,
          positionSeconds: Number.isFinite(positionSeconds) && positionSeconds > 0 ? Math.floor(positionSeconds) : null,
          progress
        };
      }

      const info = item.playbackInfo;
      if (info && info.provider === anime.provider && String(info.sourceId || '') === String(anime.id)) {
        const width = Number(info.width), height = Number(info.height);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) result.resolution = `${height}p`;
        if (info.format === 'HLS' || info.format === 'MP4') result.format = info.format;
      }
      break;
    }
    return result;
  }

  function formatPosition(seconds) {
    if (seconds == null || seconds === '') return '';
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '';
    const total = Math.floor(value), minutes = Math.floor(total / 60), remainder = total % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  return { formatPosition, numberOf, sameEpisode, sameWork, summarize };
});
