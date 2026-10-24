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
    const currentRef = value(episode.url || episode.token || episode.id);
    const savedRef = value(savedEpisode.url || savedEpisode.token || savedEpisode.id);
    if (currentRef && savedRef) return currentRef === savedRef;
    const currentNumber = numberOf(episode), savedNumber = numberOf(savedEpisode);
    return Boolean(currentNumber && savedNumber && currentNumber === savedNumber && Boolean(episode.dub) === Boolean(savedEpisode.dub));
  }

  function episodeLabel(episode) {
    const number = numberOf(episode);
    return number > 0 ? `${number}화` : value(episode?.name);
  }

  function summarize(anime, detail, history, attempts = []) {
    if (!anime) return null;
    const response = Array.isArray(detail) ? { episodes: detail } : (detail || {});
    const episodes = Array.isArray(response.episodes) ? response.episodes : null;
    const result = {
      lookupStatus: response.error ? 'failed' : episodes ? 'loaded' : 'unqueried',
      episodeCount: episodes?.length ?? null,
      latestEpisodeNumber: null,
      resolution: '',
      format: '',
      qualityEpisode: null,
      resume: null,
      playbackStatus: episodes?.length ? 'unchecked' : 'none',
      playbackEpisode: null
    };
    if (!episodes) return result;
    result.latestEpisodeNumber = episodes.reduce((latest, episode) => Math.max(latest, numberOf(episode)), 0) || null;
    if (!episodes.length) return result;

    const records = (Array.isArray(history) ? history : [])
      .filter(item => sameWork(anime, item))
      .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));

    for (const item of records) {
      const episode = episodes.find(candidate => candidate.playable !== false && sameEpisode(candidate, item.episode));
      if (!episode) continue;

      const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
      const episodeNumber = numberOf(episode);
      if (!result.resume && episodeNumber > 0 && progress > 0 && progress < 100) {
        const positionSeconds = Number(item.positionSeconds);
        result.resume = {
          episode: episodeNumber,
          positionSeconds: Number.isFinite(positionSeconds) && positionSeconds > 0 ? Math.floor(positionSeconds) : null,
          progress
        };
      }

      const info = item.playbackInfo;
      if (!result.qualityEpisode && info && info.provider === anime.provider && String(info.sourceId || '') === String(anime.id)) {
        const width = Number(info.width), height = Number(info.height);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) result.resolution = `${height}p`;
        if (info.format === 'HLS' || info.format === 'MP4') result.format = info.format;
        if (result.resolution || result.format) result.qualityEpisode = { number: episodeNumber || null, name: value(episode.name) };
      }
    }

    const statusEntries = [
      ...records.map(item => ({ anime: item.anime, episode: item.episode, status: item.playbackStatus, updated: item.updated })),
      ...(Array.isArray(attempts) ? attempts : [])
    ].filter(item => ['checking', 'confirmed', 'failed', 'restricted', 'unverified'].includes(item.status))
      .filter(item => sameWork(anime, { anime: item.anime, episode: item.episode })
        && episodes.some(candidate => candidate.playable !== false && sameEpisode(candidate, item.episode)))
      .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
    if (statusEntries.length) {
      const current = statusEntries[0];
      result.playbackStatus = current.status === 'unverified' ? 'unchecked' : current.status;
      result.playbackEpisode = episodeLabel(current.episode);
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

  return { episodeLabel, formatPosition, numberOf, sameEpisode, sameWork, summarize };
});
