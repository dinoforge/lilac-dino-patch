const { requestAniListGraphQL, getAniListCooldownUntil } = require('./anilist-client.cjs');

const SUPPORTED_PROVIDERS = new Set(['reanime', 'miruro']);
const CACHE_TTL = 15 * 60 * 1000;
const MAX_CANDIDATES = 120;
const MAX_RESULTS = 50;
const WINDOW_SECONDS = 7 * 24 * 60 * 60;
const QUERY = `query ($ids: [Int], $after: Int!, $until: Int!) {
  Page(perPage: 50) {
    airingSchedules(
      notYetAired: true
      airingAt_greater: $after
      airingAt_lesser: $until
      mediaId_in: $ids
      sort: [TIME]
    ) {
      episode
      airingAt
      media { id }
    }
  }
}`;

const cache = new Map();
const inFlight = new Map();

function validCandidates(provider, candidates) {
  if (!SUPPORTED_PROVIDERS.has(provider) || !Array.isArray(candidates)) return new Map();
  const byId = new Map();
  for (const anime of candidates.slice(0, MAX_CANDIDATES)) {
    if (!anime || anime.provider !== provider) continue;
    const id = Number(anime.anilistId), available = provider === 'reanime'
      ? Math.max(Number(anime.subbed) || 0, Number(anime.dubbed) || 0)
      : Number(anime.availableEpisodeCount) || 0;
    if (!Number.isSafeInteger(id) || id <= 0 || available <= 0) continue;
    const previous = byId.get(id);
    if (!previous || available > previous.available) byId.set(id, { anime, available });
  }
  return byId;
}

function mapWeekdayEpisodes(provider, byId, schedules, nowSeconds, untilSeconds = nowSeconds + WINDOW_SECONDS) {
  const result = [], seen = new Set();
  for (const schedule of Array.isArray(schedules) ? schedules : []) {
    const mediaId = Number(schedule?.media?.id), episode = Number(schedule?.episode), airingAt = Number(schedule?.airingAt);
    const entry = byId.get(mediaId);
    if (!entry || !Number.isSafeInteger(episode) || episode <= 0 || !Number.isSafeInteger(airingAt) || airingAt <= nowSeconds || airingAt > untilSeconds) continue;
    const key = `${mediaId}:${episode}:${airingAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ provider, anime: entry.anime, episode, airingAt });
    if (result.length >= MAX_RESULTS) break;
  }
  return result.sort((a, b) => a.airingAt - b.airingAt);
}

function cacheKey(provider, byId) {
  return `${provider}:${[...byId.keys()].sort((a, b) => a - b).join(',')}`;
}

async function fetchWeekdayEpisodes(provider, candidates, { fetchImpl = globalThis.fetch, now = Date.now, minIntervalMs, refresh = false } = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) return { supported: false, data: [] };
  const currentTime = typeof now === 'function' ? now() : now;
  const byId = validCandidates(provider, candidates);
  if (!byId.size) return { supported: true, data: [] };

  const key = cacheKey(provider, byId), current = cache.get(key);
  if (current && current.expiresAt > currentTime && !refresh) return { supported: true, data: current.data, fromCache: true };
  const requestKey = refresh ? `${key}:refresh` : key;
  if (inFlight.has(requestKey)) return inFlight.get(requestKey);
  const retryAfterAt = Math.max(current?.retryAfterAt || 0, getAniListCooldownUntil(currentTime));
  if (retryAfterAt > currentTime) return rateLimitedResult(key, current, retryAfterAt);

  const nowSeconds = Math.floor(currentTime / 1000), untilSeconds = nowSeconds + WINDOW_SECONDS;
  const pending = (async () => {
    let response;
    try {
      response = await requestAniListGraphQL(QUERY, { ids: [...byId.keys()], after: nowSeconds, until: untilSeconds }, {
        fetchImpl,
        now: typeof now === 'function' ? now : () => now,
        timeoutMs: 15000,
        ...(minIntervalMs === undefined ? {} : { minIntervalMs })
      });
    } catch (error) {
      if (error?.code === 'ANILIST_RATE_LIMITED') return rateLimitedResult(key, current, error.retryAfterAt);
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);
    if (payload.errors?.length) throw new Error(String(payload.errors[0]?.message || 'AniList 조회 실패'));

    const data = mapWeekdayEpisodes(provider, byId, payload.data?.Page?.airingSchedules, nowSeconds, untilSeconds);
    const latest = cache.get(key);
    if (!latest || Number(latest.fetchedAt) <= currentTime) cache.set(key, { data, fetchedAt: currentTime, expiresAt: currentTime + CACHE_TTL });
    while (cache.size > 8) cache.delete(cache.keys().next().value);
    return { supported: true, data, fromCache: false };
  })();
  inFlight.set(requestKey, pending);
  try { return await pending; }
  finally { if (inFlight.get(requestKey) === pending) inFlight.delete(requestKey); }
}

function rateLimitedResult(key, current, retryAfterAt) {
  const data = current?.data || [];
  cache.set(key, { data, fetchedAt: current?.fetchedAt || 0, expiresAt: current?.expiresAt || 0, retryAfterAt });
  while (cache.size > 8) cache.delete(cache.keys().next().value);
  return { supported: true, data, fromCache: Boolean(current), rateLimited: true, retryAfterAt };
}

function clearWeekdayEpisodeCache() { cache.clear(); inFlight.clear(); }

module.exports = { fetchWeekdayEpisodes, mapWeekdayEpisodes, validCandidates, clearWeekdayEpisodeCache };
