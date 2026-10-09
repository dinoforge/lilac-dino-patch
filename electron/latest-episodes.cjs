const { requestAniListGraphQL, getAniListCooldownUntil } = require('./anilist-client.cjs');
const SUPPORTED_PROVIDERS = new Set(['reanime', 'miruro']);
const CACHE_TTL = 15 * 60 * 1000;
const MAX_CANDIDATES = 120;
const MAX_RESULTS = 30;
const AIRING_WINDOW_SECONDS = 14 * 24 * 60 * 60;
const QUERY = `query ($ids: [Int], $after: Int!, $now: Int!) {
  Page(perPage: 50) {
    airingSchedules(
      notYetAired: false
      airingAt_greater: $after
      airingAt_lesser: $now
      mediaId_in: $ids
      sort: [TIME_DESC]
    ) {
      episode
      airingAt
      media { id }
    }
  }
}`;

const cache = new Map();

function availableEpisodeCount(provider, anime) {
  const values = provider === 'reanime'
    ? [anime?.subbed, anime?.dubbed]
    : [anime?.availableEpisodeCount];
  return Math.max(0, ...values.map(value => Number(value) || 0));
}

function validCandidates(provider, candidates) {
  if (!SUPPORTED_PROVIDERS.has(provider) || !Array.isArray(candidates)) return new Map();
  const byId = new Map();
  for (const anime of candidates.slice(0, MAX_CANDIDATES)) {
    if (!anime || anime.provider !== provider) continue;
    const id = Number(anime.anilistId), available = availableEpisodeCount(provider, anime);
    if (!Number.isSafeInteger(id) || id <= 0 || available <= 0) continue;
    const previous = byId.get(id);
    if (!previous || available > previous.available) byId.set(id, { anime, available });
  }
  return byId;
}

function mapLatestEpisodes(provider, byId, schedules, nowSeconds = Math.floor(Date.now() / 1000)) {
  const after = nowSeconds - AIRING_WINDOW_SECONDS, latest = new Map();
  const sorted = Array.isArray(schedules) ? schedules.slice().sort((a, b) => Number(b?.airingAt) - Number(a?.airingAt)) : [];
  for (const schedule of sorted) {
    const mediaId = Number(schedule?.media?.id), episode = Number(schedule?.episode), airingAt = Number(schedule?.airingAt);
    const entry = byId.get(mediaId);
    if (!entry || !Number.isInteger(episode) || episode <= 0 || episode > entry.available) continue;
    if (!Number.isSafeInteger(airingAt) || airingAt < after || airingAt > nowSeconds || latest.has(mediaId)) continue;
    latest.set(mediaId, { anime: entry.anime, episode, airingAt });
  }
  return [...latest.values()].sort((a, b) => b.airingAt - a.airingAt).slice(0, MAX_RESULTS);
}

function cacheKey(provider, byId) {
  return `${provider}:${[...byId].map(([id, entry]) => `${id}-${entry.available}`).sort().join(',')}`;
}

async function fetchLatestEpisodes(provider, candidates, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) return { supported: false, data: [] };
  const byId = validCandidates(provider, candidates);
  if (!byId.size) return { supported: true, data: [] };

  const key = cacheKey(provider, byId), current = cache.get(key);
  if (current && current.expiresAt > now) return { supported: true, data: current.data, fromCache: true };
  const retryAfterAt = Math.max(current?.retryAfterAt || 0, getAniListCooldownUntil(now));
  if (retryAfterAt > now) return rateLimitedResult(key, current, retryAfterAt);

  const nowSeconds = Math.floor(now / 1000), after = nowSeconds - AIRING_WINDOW_SECONDS;
  let response;
  try { response = await requestAniListGraphQL(QUERY, { ids: [...byId.keys()], after, now: nowSeconds }, { fetchImpl, now, timeoutMs: 15000 }); }
  catch (error) {
    if (error?.code === 'ANILIST_RATE_LIMITED') return rateLimitedResult(key, current, error.retryAfterAt);
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);
  if (payload.errors?.length) throw new Error(String(payload.errors[0]?.message || 'AniList 조회 실패'));

  const data = mapLatestEpisodes(provider, byId, payload.data?.Page?.airingSchedules, nowSeconds);
  cache.set(key, { data, expiresAt: now + CACHE_TTL });
  while (cache.size > 8) cache.delete(cache.keys().next().value);
  return { supported: true, data, fromCache: false };
}

function rateLimitedResult(key, current, retryAfterAt) {
  const data = current?.data || [];
  cache.set(key, { data, expiresAt: current?.expiresAt || 0, retryAfterAt });
  while (cache.size > 8) cache.delete(cache.keys().next().value);
  return { supported: true, data, fromCache: Boolean(current), rateLimited: true, retryAfterAt };
}

function clearLatestEpisodeCache() { cache.clear(); }

module.exports = { fetchLatestEpisodes, mapLatestEpisodes, validCandidates, clearLatestEpisodeCache };
