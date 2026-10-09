const ANILIST_API = 'https://graphql.anilist.co';
const RATE_LIMIT_FALLBACK_MS = 60 * 1000;

let cooldownUntil = 0;

class AniListRateLimitError extends Error {
  constructor(retryAfterAt) {
    super('AniList 요청 제한 중입니다.');
    this.name = 'AniListRateLimitError';
    this.code = 'ANILIST_RATE_LIMITED';
    this.retryAfterAt = retryAfterAt;
  }
}

function retryAfterAt(response, now) {
  const value = String(response?.headers?.get?.('Retry-After') || '').trim();
  const seconds = Number(value);
  if (value && Number.isFinite(seconds) && seconds >= 0) return now + Math.max(1000, seconds * 1000);
  const date = Date.parse(value);
  if (value && Number.isFinite(date) && date > now) return date;
  return now + RATE_LIMIT_FALLBACK_MS;
}

function getAniListCooldownUntil(now = Date.now()) {
  if (cooldownUntil <= now) {
    cooldownUntil = 0;
    return 0;
  }
  return cooldownUntil;
}

function clearAniListCooldown() { cooldownUntil = 0; }

async function requestAniListGraphQL(query, variables = {}, {
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = 25000,
  userAgent = 'LilacAnime Desktop'
} = {}) {
  const blockedUntil = getAniListCooldownUntil(now);
  if (blockedUntil > now) throw new AniListRateLimitError(blockedUntil);

  const response = await fetchImpl(ANILIST_API, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 429) {
    cooldownUntil = Math.max(cooldownUntil, retryAfterAt(response, now));
    try { await response.body?.cancel(); } catch {}
    throw new AniListRateLimitError(cooldownUntil);
  }
  return response;
}

module.exports = {
  AniListRateLimitError,
  requestAniListGraphQL,
  getAniListCooldownUntil,
  clearAniListCooldown
};
