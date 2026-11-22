const ANILIST_API = 'https://graphql.anilist.co';
const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const MIN_REQUEST_INTERVAL_MS = 2100;

let cooldownUntil = 0;
let nextRequestAt = 0;
let requestQueue = [];
let queueRunning = false;
let requestSequence = 0;

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
  requestQueue = [];
  requestSequence = 0;
}

function currentTime(now) {
  if (typeof now === 'function') return now();
  return Number.isFinite(now) ? now : Date.now();
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

function waitForSlot(waitImpl, milliseconds, signal) {
  if (!signal) return waitImpl(milliseconds);
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('요청이 취소되었습니다.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason || new DOMException('요청이 취소되었습니다.', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => waitImpl(milliseconds)).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function pumpRequestQueue() {
  if (queueRunning) return;
  queueRunning = true;
  void (async () => {
    try {
      while (requestQueue.length) {
        requestQueue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
        const entry = requestQueue.shift();
        if (entry.signal?.aborted) {
          entry.reject(entry.signal.reason || new DOMException('요청이 취소되었습니다.', 'AbortError'));
          continue;
        }
        try {
          let current = currentTime(entry.now);
          let blockedUntil = getAniListCooldownUntil(current);
          if (blockedUntil > current) throw new AniListRateLimitError(blockedUntil);

          const delayMs = Math.max(0, nextRequestAt - current);
          if (delayMs > 0) await waitForSlot(entry.waitImpl, delayMs, entry.signal);

          current = currentTime(entry.now);
          blockedUntil = getAniListCooldownUntil(current);
          if (blockedUntil > current) throw new AniListRateLimitError(blockedUntil);
          if (entry.signal?.aborted) {
            entry.reject(entry.signal.reason || new DOMException('요청이 취소되었습니다.', 'AbortError'));
            continue;
          }
          nextRequestAt = Math.max(nextRequestAt, current) + entry.minIntervalMs;
          let started;
          try { entry.started = true; started = entry.startRequest(); }
          catch (error) { entry.reject(error); continue; }
          Promise.resolve(started).then(entry.resolve, entry.reject);
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      queueRunning = false;
      if (requestQueue.length) pumpRequestQueue();
    }
  })();
}

function requestInSlot(startRequest, { now, waitImpl, minIntervalMs, priority, signal }) {
  return new Promise((resolve, reject) => {
    const entry = { startRequest, now, waitImpl, minIntervalMs, priority, signal, resolve, reject, sequence: requestSequence++ };
    const removeAborted = () => {
      const index = requestQueue.indexOf(entry);
      if (index >= 0) requestQueue.splice(index, 1);
      if (!entry.started) entry.reject(signal.reason || new DOMException('요청이 취소되었습니다.', 'AbortError'));
    };
    if (signal?.aborted) { reject(signal.reason || new DOMException('요청이 취소되었습니다.', 'AbortError')); return; }
    if (signal) signal.addEventListener('abort', removeAborted, { once: true });
    const settle = callback => value => {
      signal?.removeEventListener('abort', removeAborted);
      callback(value);
    };
    entry.resolve = settle(resolve);
    entry.reject = settle(reject);
    requestQueue.push(entry);
    pumpRequestQueue();
  });
}

async function requestAniListGraphQL(query, variables = {}, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 25000,
  userAgent = 'LilacAnime Desktop',
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  waitImpl = wait,
  priority = 0,
  signal
} = {}) {
  const initialTime = currentTime(now);
  const blockedUntil = getAniListCooldownUntil(initialTime);
  if (blockedUntil > initialTime) throw new AniListRateLimitError(blockedUntil);

  const interval = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : MIN_REQUEST_INTERVAL_MS;
  const response = await requestInSlot(() => fetchImpl(ANILIST_API, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({ query, variables }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  }), {
    now,
    waitImpl,
    minIntervalMs: interval,
    priority: Number.isFinite(priority) ? priority : 0,
    signal
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
