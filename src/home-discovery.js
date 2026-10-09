(function (root) {
  const UPDATE_PROVIDERS = new Set(['animenosub', 'ohli24']);

  function latestUpdatedEpisodes(provider, items, limit = 30) {
    if (!UPDATE_PROVIDERS.has(provider) || !Array.isArray(items)) return [];
    const latest = new Map();
    for (const item of items) {
      if (!item || item.provider !== provider || item.mal_id == null || typeof item.url !== 'string' || !item.url) continue;
      const number = Number(item.availableEpisodes ?? item.availableEpisodeCount ?? item.episodes);
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      const key = String(item.mal_id), previous = latest.get(key);
      if (!previous || number > previous.latestEpisodeNumber) {
        latest.set(key, { ...item, latestEpisodeNumber: number, latestEpisodeKind: 'updated' });
      }
    }
    return [...latest.values()].slice(0, Math.max(0, Number(limit) || 0));
  }

  const api = { latestUpdatedEpisodes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LilacHomeDiscovery = api;
})(typeof globalThis === 'object' ? globalThis : this);
