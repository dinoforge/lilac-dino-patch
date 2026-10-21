'use strict';

const BASE_URL = 'https://api.jikan.moe/v4';
const PAGE_SIZE = 25;
const MAX_PAGES = 10;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MIN_INTERVAL_MS = 1100;
const DEFAULT_REQUEST_TIMEOUT_MS = 6000;
const DEFAULT_TOTAL_TIMEOUT_MS = 16000;
const cache = new Map();
const inFlight = new Map();
let nextRequestAt = 0;
let requestQueue = Promise.resolve();

const SEASONS = new Set(['winter', 'spring', 'summer', 'fall']);
const DAY_INDEX = new Map([
  ['monday', 0], ['tuesday', 1], ['wednesday', 2], ['thursday', 3], ['friday', 4], ['saturday', 5], ['sunday', 6]
]);

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeSeason(value) {
  const season = String(value || '').trim().toLowerCase();
  return SEASONS.has(season) ? season : '';
}

function seasonName(value) {
  const name = String(value || '').trim().toLowerCase();
  return ({ winter: 'WINTER', spring: 'SPRING', summer: 'SUMMER', fall: 'FALL' })[name] || '';
}

function normalizeDay(value) {
  const day = String(value || '').trim().toLowerCase().replace(/s$/, '');
  const index = DAY_INDEX.get(day);
  return index == null ? null : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][index];
}

function validBroadcastTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return false;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour <= 29 && minute <= 59;
}

function catalogSeason(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  return text.match(/winter|spring|summer|fall/)?.[0] || '';
}

function titleKey(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function candidateAliases(candidate) {
  return [...new Set((Array.isArray(candidate?.aliases) ? candidate.aliases : []).map(titleKey).filter(Boolean))];
}

function rowAliases(row) {
  return [...new Set([row?.title, row?.title_english, row?.title_japanese, ...(Array.isArray(row?.title_synonyms) ? row.title_synonyms : [])]
    .map(titleKey).filter(Boolean))];
}

function isExcludedFormat(value) {
  return /movie|film|ova|oad|ona|web.?anime|special|극장판|스페셜/i.test(String(value || ''));
}

function candidateMetadataMatches(candidate, year, season, requireKnownSeason = false) {
  const candidateYear = Number(candidate.year) || null;
  const candidateSeason = catalogSeason(candidate.season);
  if ((candidateYear && candidateYear !== year) || (candidateSeason && candidateSeason !== season) || isExcludedFormat(candidate.format)) return false;
  return !requireKnownSeason || (candidateYear === year && candidateSeason === season);
}

function matchCandidate(row, candidates, year, season) {
  const malId = positiveId(row?.mal_id);
  const compatible = candidates.filter(candidate => candidateMetadataMatches(candidate, year, season));
  if (malId) {
    const byId = compatible.filter(candidate => candidate.malId === malId);
    if (byId.length === 1) return { candidate: byId[0], matchType: 'mal-id' };
    if (byId.length > 1) return { ambiguous: true };
  }
  const rowTitles = new Set(rowAliases(row));
  const byTitle = compatible.filter(candidate => !candidate.malId && String(candidate.format || '').trim()
    && candidateMetadataMatches(candidate, year, season, true)
    && candidateAliases(candidate).some(alias => rowTitles.has(alias)));
  if (byTitle.length === 1) return { candidate: byTitle[0], matchType: 'exact-title-season' };
  if (byTitle.length > 1) return { ambiguous: true };
  return null;
}

function sanitizeErrorCode(error) {
  const cause = error?.cause;
  const code = String(cause?.code || error?.code || '').toUpperCase();
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `dns-${code.toLowerCase()}`;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'connect-timeout';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return `connection-${code.toLowerCase()}`;
  if (/^(CERT_|ERR_TLS|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code)) return 'tls-error';
  if (error?.name === 'TimeoutError') return 'request-timeout';
  if (error?.name === 'AbortError') return 'request-aborted';
  return 'network-error';
}

function safeNetworkErrorCode(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  return /^[A-Z0-9_:-]{1,48}$/.test(code) ? code : '';
}

function requestUrl(year, season, page) {
  const url = new URL(`${BASE_URL}/seasons/${year}/${season}`);
  url.searchParams.set('filter', 'tv');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url;
}

async function waitForSlot(minIntervalMs, now = Date.now) {
  const previous = requestQueue;
  let release;
  requestQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const delay = Math.max(0, nextRequestAt - now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    nextRequestAt = now() + minIntervalMs;
  } finally { release(); }
}

async function readJson(url, { fetchImpl, minIntervalMs, requestTimeoutMs, now, onRequestStart }) {
  await waitForSlot(minIntervalMs, now);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error('Jikan request timed out'), { name: 'TimeoutError' })), requestTimeoutMs);
  try {
    onRequestStart?.();
    const response = await fetchImpl(url.href, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'LilacAnime Desktop' },
      signal: controller.signal
    });
    if (!response?.ok) {
      const error = new Error(`Jikan HTTP ${Number(response?.status) || 0}`);
      error.status = Number(response?.status) || 0;
      throw error;
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw Object.assign(new Error('Jikan returned invalid JSON'), { code: 'INVALID_JSON' }); }
    return payload;
  } finally { clearTimeout(timeout); }
}

function buildRows(rows, candidates, year, season) {
  const items = [];
  let unmatchedCount = 0, metadataMismatchCount = 0, missingBroadcastCount = 0, ambiguousCount = 0, matchedIdentityCount = 0;
  const seen = new Set();
  for (const row of rows) {
    const malId = positiveId(row?.mal_id);
    if (!malId) continue;
    const rawSeason = normalizeSeason(row?.season) || season;
    const rawYear = Number(row?.year) || year;
    const idCandidates = candidates.filter(candidate => candidate.malId === malId);
    if (rawSeason !== season || rawYear !== year || String(row?.type || '').toUpperCase() !== 'TV') {
      if (idCandidates.length) metadataMismatchCount += idCandidates.length;
      continue;
    }
    const match = matchCandidate(row, candidates, rawYear, rawSeason);
    if (!match && idCandidates.length) { metadataMismatchCount += idCandidates.length; continue; }
    if (!match) continue;
    if (match.ambiguous) { ambiguousCount++; continue; }
    const candidate = match.candidate;
    matchedIdentityCount++;
    const broadcast = row?.broadcast || {};
    const day = normalizeDay(broadcast.day);
    if (String(broadcast.timezone || '').trim() !== 'Asia/Tokyo' || !day || !validBroadcastTime(broadcast.time)) {
      missingBroadcastCount++;
      continue;
    }
    const eventKey = `${candidate.catalogId}:${rawYear}:${rawSeason}:${day}:${broadcast.time}`;
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    items.push({
      source: 'Jikan',
      malId,
      catalogId: candidate.catalogId,
      anilistId: candidate.anilistId || null,
      identityMatch: match.matchType,
      episode: null,
      broadcastDay: day,
      broadcastTime: String(broadcast.time).trim(),
      timeZone: 'Asia/Tokyo',
      verifiedJapaneseBroadcast: true,
      scheduleKind: 'weekly-slot',
      countryOfOrigin: 'JP',
      format: 'TV',
      season: seasonName(rawSeason),
      seasonYear: rawYear
    });
  }
  return { items, unmatchedCount, metadataMismatchCount, missingBroadcastCount, ambiguousCount, matchedIdentityCount };
}

async function fetchJikanJapaneseSeasonSchedule(values, {
  year,
  season,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  maxPages = MAX_PAGES
} = {}) {
  const clock = typeof now === 'function' ? now : () => Number(now) || Date.now();
  const targetYear = Number(year), targetSeason = normalizeSeason(season);
  const candidates = (Array.isArray(values) ? values : []).map(candidate => ({
    malId: positiveId(candidate?.malId),
    anilistId: positiveId(candidate?.anilistId),
    catalogId: String(candidate?.catalogId || ''),
    year: Number(candidate?.year) || null,
    season: String(candidate?.season || ''),
    format: String(candidate?.format || candidate?.type || ''),
    aliases: Array.isArray(candidate?.aliases) ? candidate.aliases.map(value => String(value || '').trim()).filter(Boolean) : []
  })).filter(candidate => candidate.catalogId && (candidate.malId
    || (candidate.year && catalogSeason(candidate.season) && candidateAliases(candidate).length)));
  if (!candidates.length) return { state: 'not-requested', source: 'Jikan', items: [], pageCount: 0, matchedCatalogCount: 0, requestedCandidateCount: 0 };
  if (!Number.isSafeInteger(targetYear) || targetYear < 1900 || targetYear > 2200 || !targetSeason) {
    return { state: 'failed', source: 'Jikan', errorCode: 'invalid-season', failureStage: 'input', items: [], pageCount: 0 };
  }
  const cacheKey = `${targetYear}:${targetSeason}:${candidates.map(candidate => `${candidate.catalogId}:${candidate.malId || ''}:${candidate.year || ''}:${catalogSeason(candidate.season)}:${candidateAliases(candidate).sort().join('|')}`).sort().join(';')}`;
  const current = clock();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > current) return { ...cached.value, fromCache: true };
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const work = (async () => {
    const startedAt = clock();
    const deadline = startedAt + Math.max(1, Number(totalTimeoutMs) || DEFAULT_TOTAL_TIMEOUT_MS);
    const rows = [], foundTargetIds = new Set();
    const targetCatalogIds = new Set(candidates.map(candidate => candidate.catalogId));
    let pageCount = 0, requestCount = 0, hasNextPage = false, failureStage = '', errorCode = '', httpStatus = 0;
    let requestStartedAt = null, networkErrorCode = '';
    const requestedPageLimit = Math.max(1, Math.min(MAX_PAGES, Number(maxPages) || MAX_PAGES));
    for (let page = 1; page <= requestedPageLimit; page++) {
      const remaining = deadline - clock();
      if (remaining <= 0) { failureStage = pageCount ? 'pagination' : 'request'; errorCode = 'total-timeout'; break; }
      try {
        const payload = await readJson(requestUrl(targetYear, targetSeason, page), {
          fetchImpl, minIntervalMs, requestTimeoutMs: Math.min(Number(requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS, remaining), now: clock,
          onRequestStart: () => { requestCount++; requestStartedAt = clock(); }
        });
        pageCount++;
        if (!Array.isArray(payload?.data) || typeof payload?.pagination?.has_next_page !== 'boolean') {
          failureStage = 'response-shape'; errorCode = 'invalid-response'; break;
        }
        rows.push(...payload.data);
        for (const row of payload.data) {
          const rawSeason = normalizeSeason(row?.season) || targetSeason;
          const rawYear = Number(row?.year) || targetYear;
          if (rawSeason !== targetSeason || rawYear !== targetYear || String(row?.type || '').toUpperCase() !== 'TV') continue;
          const matched = matchCandidate(row, candidates, rawYear, rawSeason);
          if (matched?.candidate) foundTargetIds.add(matched.candidate.catalogId);
        }
        hasNextPage = payload.pagination.has_next_page;
        if (!hasNextPage || foundTargetIds.size === targetCatalogIds.size) break;
        if (page === requestedPageLimit) { failureStage = 'pagination'; errorCode = 'page-limit'; }
      } catch (error) {
        httpStatus = Number(error?.status) || 0;
        networkErrorCode = safeNetworkErrorCode(error);
        failureStage = httpStatus ? 'http' : error?.code === 'INVALID_JSON' ? 'response-json' : 'network';
        errorCode = httpStatus === 429 ? 'rate-limited' : httpStatus ? `http-${httpStatus}` : error?.code === 'INVALID_JSON' ? 'invalid-json' : sanitizeErrorCode(error);
        break;
      }
    }
    const matched = buildRows(rows, candidates, targetYear, targetSeason);
    if (hasNextPage && pageCount >= requestedPageLimit && !errorCode) { failureStage = 'pagination'; errorCode = 'page-limit'; }
    const state = errorCode ? (matched.items.length ? 'partial' : 'failed') : 'complete';
    const result = {
      state, source: 'Jikan', seasonYear: targetYear, season: seasonName(targetSeason),
      items: matched.items, pageCount, hasNextPage, requestedMalIdCount: candidates.filter(candidate => candidate.malId).length,
      matchedCatalogCount: new Set(matched.items.map(item => item.catalogId)).size,
      matchedIdentityCount: matched.matchedIdentityCount,
      unmatchedCount: matched.unmatchedCount, metadataMismatchCount: matched.metadataMismatchCount,
      missingBroadcastCount: matched.missingBroadcastCount, ambiguousCount: matched.ambiguousCount,
      ...(errorCode ? { errorCode, failureStage } : {}),
      httpStatus: httpStatus || null, requestCount, requestStarted: requestCount > 0, requestStartedAt, networkErrorCode,
      requestedCandidateCount: candidates.length, unmatchedCatalogCount: Math.max(0, targetCatalogIds.size - foundTargetIds.size),
      elapsedMs: Math.max(0, clock() - startedAt), timeZone: 'Asia/Tokyo'
    };
    if (state === 'complete') {
      cache.set(cacheKey, { expiresAt: clock() + CACHE_TTL_MS, value: result });
      while (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    return result;
  })();

  inFlight.set(cacheKey, work);
  try { return await work; }
  finally { if (inFlight.get(cacheKey) === work) inFlight.delete(cacheKey); }
}

function clearJikanJapaneseSeasonScheduleCache() {
  cache.clear();
  inFlight.clear();
  nextRequestAt = 0;
  requestQueue = Promise.resolve();
}

module.exports = {
  BASE_URL,
  PAGE_SIZE,
  MAX_PAGES,
  normalizeDay,
  validBroadcastTime,
  fetchJikanJapaneseSeasonSchedule,
  clearJikanJapaneseSeasonScheduleCache
};
