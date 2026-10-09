const ANILIST_API = 'https://graphql.anilist.co';
const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const MIN_REQUEST_INTERVAL_MS = 2100;

let cooldownUntil = 0;
let nextRequestAt = 0;
let requestQueue = Promise.resolve();

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

function resetAniListClientState() {
  cooldownUntil = 0;
  nextRequestAt = 0;
  requestQueue = Promise.resolve();
}

function currentTime(now) {
  if (typeof now === 'function') return now();
  return Number.isFinite(now) ? now : Date.now();
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function requestInSlot(startRequest, { now, waitImpl, minIntervalMs }) {
  const previous = requestQueue;
  let release;
  requestQueue = new Promise(resolve => { release = resolve; });
  await previous;

  try {
    let current = currentTime(now);
    let blockedUntil = getAniListCooldownUntil(current);
    if (blockedUntil > current) throw new AniListRateLimitError(blockedUntil);

    const delayMs = Math.max(0, nextRequestAt - current);
    if (delayMs > 0) await waitImpl(delayMs);

    current = currentTime(now);
    blockedUntil = getAniListCooldownUntil(current);
    if (blockedUntil > current) throw new AniListRateLimitError(blockedUntil);
    nextRequestAt = Math.max(nextRequestAt, current) + minIntervalMs;
    return startRequest();
  } finally {
    release();
  }
}

async function requestAniListGraphQL(query, variables = {}, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 25000,
  userAgent = 'LilacAnime Desktop',
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  waitImpl = wait
} = {}) {
  const initialTime = currentTime(now);
  const blockedUntil = getAniListCooldownUntil(initialTime);
  if (blockedUntil > initialTime) throw new AniListRateLimitError(blockedUntil);

  const interval = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : MIN_REQUEST_INTERVAL_MS;
  const response = await requestInSlot(() => fetchImpl(ANILIST_API, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs)
  }), {
    now,
    waitImpl,
    minIntervalMs: interval
  });
  if (response.status === 429) {
    cooldownUntil = Math.max(cooldownUntil, retryAfterAt(response, currentTime(now)));
    try { await response.body?.cancel(); } catch {}
    throw new AniListRateLimitError(cooldownUntil);
  }
  return response;
}

module.exports = {
  AniListRateLimitError,
  requestAniListGraphQL,
  getAniListCooldownUntil,
  resetAniListClientState,
  MIN_REQUEST_INTERVAL_MS
};
