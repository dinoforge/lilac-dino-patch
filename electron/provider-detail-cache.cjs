'use strict';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;

function createProviderDetailHandler(loadProviderDetail, {
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  if (typeof loadProviderDetail !== 'function') throw new TypeError('A provider detail loader is required.');
  const details = new Map();

  return (_event, anime) => {
    const key = `${anime?.provider}|${anime?.url || anime?.id || anime?.mal_id}`;
    const kept = details.get(key);
    const startedAt = now();
    if (kept && startedAt - kept.startedAt < ttlMs) return kept.promise;

    const promise = Promise.resolve().then(() => loadProviderDetail(anime));
    details.set(key, { startedAt, promise });
    promise.catch(() => {
      if (details.get(key)?.promise === promise) details.delete(key);
    });
    if (details.size > maxEntries) details.delete(details.keys().next().value);
    return promise;
  };
}

module.exports = { createProviderDetailHandler };
