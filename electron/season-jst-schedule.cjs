const { requestAniListGraphQL } = require('./anilist-client.cjs');
const { fetchJikanJapaneseSeasonSchedule, clearJikanJapaneseSeasonScheduleCache } = require('./jikan-japanese-season.cjs');

const PAGE_SIZE = 50;
const MAX_PAGES = 8;
const MAX_MEDIA_IDS = 120;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const inFlight = new Map();

const QUERY = `query ($ids: [Int], $from: Int!, $until: Int!, $page: Int!, $perPage: Int!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    airingSchedules(
      airingAt_greater: $from
      airingAt_lesser: $until
      mediaId_in: $ids
      sort: [TIME]
    ) {
      episode
      airingAt
      media { id countryOfOrigin format season seasonYear }
    }
  }
}`;

function cleanIds(values) {
  const ids = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function cleanCandidates(values) {
  const candidates = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const candidate = value && typeof value === 'object'
      ? {
          anilistId: Number.isSafeInteger(Number(value.anilistId)) && Number(value.anilistId) > 0 ? Number(value.anilistId) : null,
          malId: Number.isSafeInteger(Number(value.malId)) && Number(value.malId) > 0 ? Number(value.malId) : null,
          catalogId: value.catalogId == null ? '' : String(value.catalogId),
          year: Number(value.year) || null,
          season: String(value.season || ''),
          format: String(value.format || value.type || ''),
          aliases: [...new Set((Array.isArray(value.aliases) ? value.aliases : [value.title, value.titleEnglish, value.titleJapanese, value.romaji, value.synonyms])
            .flatMap(alias => Array.isArray(alias) ? alias : String(alias || '').split(/[,|/]/))
            .map(alias => String(alias || '').trim()).filter(Boolean))]
        }
      : { anilistId: Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
          malId: null, catalogId: '', year: null, season: '', format: '', aliases: [] };
    if (!candidate.anilistId && !candidate.malId && !candidate.catalogId) continue;
    const key = `${candidate.catalogId || ''}:${candidate.anilistId || ''}:${candidate.malId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

function validRange(from, until) {
  return Number.isSafeInteger(from) && Number.isSafeInteger(until)
    && until > from && until - from <= 8 * 24 * 60 * 60;
}

function cacheKey(ids, from, until) {
  return `${from}:${until}:${ids.slice().sort((a, b) => a - b).join(',')}`;
}

function mediaIsJapaneseTv(media) {
  return media?.countryOfOrigin === 'JP' && ['TV', 'TV_SHORT'].includes(String(media?.format || '').toUpperCase());
}

function normalizeRow(row) {
  const mediaId = Number(row?.media?.id);
  const episode = Number(row?.episode);
  const airingAt = Number(row?.airingAt);
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0
      || !Number.isSafeInteger(episode) || episode <= 0
      || !Number.isSafeInteger(airingAt) || airingAt <= 0) return null;
  return {
    anilistId: mediaId,
    source: 'AniList',
    episode,
    airingAt,
    countryOfOrigin: String(row.media.countryOfOrigin || ''),
    format: String(row.media.format || ''),
    season: String(row.media.season || ''),
    seasonYear: Number(row.media.seasonYear) || null
  };
}

function transportErrorCode(error) {
  if (error?.code === 'ANILIST_RATE_LIMITED') return 'rate-limited';
  const cause = error?.cause;
  const code = String(cause?.code || error?.code || '').toUpperCase();
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `dns-${code.toLowerCase()}`;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'connect-timeout';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return `connection-${code.toLowerCase()}`;
  if (/^(CERT_|ERR_TLS|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code)) return 'tls-error';
  if (error?.name === 'TimeoutError') return 'fetch-timeout';
  if (error?.name === 'AbortError') return 'fetch-aborted';
  return 'network-error';
}

function safeNetworkCode(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  return /^[A-Z0-9_:-]{1,48}$/.test(code) ? code : '';
}

async function fetchAniListJapaneseSchedule(ids, {
  from, until, fetchImpl = globalThis.fetch, now = Date.now, minIntervalMs,
  timeoutMs = 15000, requestTimeoutMs = 20000, priority = 0
} = {}) {
  if (!ids.length) return { state: 'not-requested', source: 'AniList', items: [], pageCount: 0 };
  const currentTime = typeof now === 'function' ? now() : Number(now);
  const key = cacheKey(ids, from, until);
  const saved = cache.get(key);
  if (saved && saved.expiresAt > currentTime) return { ...saved.value, fromCache: true };
  if (inFlight.has(key)) return inFlight.get(key);

  const items = [], seen = new Set();
  let pageCount = 0, requestCount = 0, duplicateRows = 0, rejectedCountryCount = 0, rejectedFormatCount = 0, unmatchedCount = 0;
  let errorCode = '', failureStage = '', httpStatus = 0, requestStarted = false, requestBodyBytes = 0, networkErrorCode = '';
  let responseStatus = null, graphqlErrorMessages = [], graphqlErrorCodes = [], hasNextPage = false, timedOut = false;
  const queueAbort = new AbortController();
  let stage = 'queue', requestStartedAt = null;
  const startedAt = typeof now === 'function' ? now() : currentTime;
  const makeResult = forcedError => {
    const finalError = forcedError || errorCode;
    const state = finalError ? (items.length ? 'partial' : 'failed') : 'complete';
    return {
      state, source: 'AniList', timeZone: 'Asia/Tokyo',
      items: items.slice().sort((a, b) => a.airingAt - b.airingAt), pageCount, requestCount,
      duplicateRows, rejectedCountryCount, rejectedFormatCount, unmatchedCount,
      hasNextPage, httpStatus: httpStatus || responseStatus || null,
      requestDiagnostics: {
        stage, requestStarted, requestBodyBytes, requestStartedAt,
        elapsedMs: Math.max(0, (typeof now === 'function' ? now() : currentTime) - startedAt),
        ...(graphqlErrorCodes.length ? { graphqlErrorCodes } : {}),
        ...(graphqlErrorMessages.length ? { graphqlErrorMessages } : {}),
        ...(networkErrorCode ? { networkErrorCode } : {})
      },
      ...(finalError ? { errorCode: finalError, failureStage: failureStage || stage } : {})
    };
  };
  const currentFailureStage = () => !requestStarted ? 'queue'
    : stage === 'http-request' ? 'network'
      : stage === 'http-response' || stage === 'response-json' ? 'response-body' : stage;

  const work = (async () => {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const variables = { ids, from: from - 1, until, page, perPage: PAGE_SIZE };
      requestBodyBytes = Math.max(requestBodyBytes, Buffer.byteLength(JSON.stringify({ query: QUERY, variables }), 'utf8'));
      let response;
      try {
        response = await requestAniListGraphQL(QUERY, variables, {
          fetchImpl: (...args) => {
            requestCount++;
            requestStarted = true;
            requestStartedAt = typeof now === 'function' ? now() : currentTime;
            stage = 'http-request';
            return Promise.resolve(fetchImpl(...args)).then(value => {
              responseStatus = Number(value?.status) || null;
              stage = 'http-response';
              return value;
            });
          },
          now: typeof now === 'function' ? now : () => currentTime,
          timeoutMs,
          priority,
          signal: queueAbort.signal,
          ...(minIntervalMs === undefined ? {} : { minIntervalMs })
        });
      } catch (error) {
        errorCode = transportErrorCode(error);
        networkErrorCode = safeNetworkCode(error);
        httpStatus = Number(error?.status) || responseStatus || 0;
        failureStage = httpStatus ? 'http' : requestStarted ? stage === 'response-json' ? 'response-json' : 'network' : 'queue';
        if (error?.code === 'ANILIST_RATE_LIMITED') failureStage = requestStarted ? 'http' : 'rate-limit-queue';
        break;
      }
      pageCount++;
      if (!response?.ok) {
        httpStatus = Number(response?.status) || 0;
        errorCode = httpStatus === 429 ? 'rate-limited' : `http-${httpStatus || 'error'}`;
        failureStage = 'http';
        break;
      }

      stage = 'response-json';
      let payload;
      try { payload = await response.json(); }
      catch { errorCode = 'invalid-json'; failureStage = 'response-json'; break; }
      if (payload?.errors?.length) {
        errorCode = 'graphql-error'; failureStage = 'graphql';
        graphqlErrorMessages = payload.errors.slice(0, 3).map(error => String(error?.message || 'GraphQL 오류').replace(/[\r\n\t]+/g, ' ').slice(0, 180));
        graphqlErrorCodes = payload.errors.slice(0, 3).map(error => String(error?.extensions?.code || '').replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 40)).filter(Boolean);
        break;
      }
      const pageData = payload?.data?.Page;
      if (!Array.isArray(pageData?.airingSchedules) || typeof pageData?.pageInfo?.hasNextPage !== 'boolean') {
        errorCode = 'invalid-response'; failureStage = 'response-shape'; break;
      }
      for (const raw of pageData.airingSchedules) {
        const row = normalizeRow(raw);
        if (!row) continue;
        if (!ids.includes(row.anilistId)) { unmatchedCount++; continue; }
        if (row.countryOfOrigin !== 'JP') { rejectedCountryCount++; continue; }
        if (!mediaIsJapaneseTv(row)) { rejectedFormatCount++; continue; }
        const eventKey = `${row.anilistId}:${row.episode}:${row.airingAt}`;
        if (seen.has(eventKey)) { duplicateRows++; continue; }
        seen.add(eventKey);
        items.push(row);
      }
      hasNextPage = pageData.pageInfo.hasNextPage;
      stage = 'complete';
      if (!hasNextPage) break;
      if (page === MAX_PAGES) { errorCode = 'page-limit'; failureStage = 'pagination'; }
    }
    const result = makeResult(timedOut ? (requestStarted ? 'request-timeout' : 'queue-timeout') : undefined);
    if (result.state === 'complete' && !timedOut) {
      cache.set(key, { expiresAt: currentTime + CACHE_TTL_MS, value: result });
      while (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    return result;
  })();
  let timeout;
  const operation = Promise.race([
    work,
    new Promise(resolve => {
      timeout = setTimeout(() => {
        timedOut = true;
        failureStage = currentFailureStage();
        queueAbort.abort(Object.assign(new Error('AniList schedule deadline exceeded'), { name: 'TimeoutError' }));
        resolve(makeResult(requestStarted ? 'request-timeout' : 'queue-timeout'));
      }, Math.max(1, Number(requestTimeoutMs) || 20000));
    })
  ]).finally(() => clearTimeout(timeout));

  inFlight.set(key, operation);
  try { return await operation; }
  finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
}

async function fetchJapaneseSeasonSchedule(values, {
  from, until, fetchImpl = globalThis.fetch, now = Date.now, minIntervalMs,
  timeoutMs = 15000, requestTimeoutMs = 20000, seasonYear, season,
  jikanFetchImpl = fetchImpl, jikanMinIntervalMs, jikanRequestTimeoutMs, jikanTotalTimeoutMs
} = {}) {
  if (!validRange(from, until)) return { state: 'failed', errorCode: 'invalid-range', source: 'AniList', items: [], pageCount: 0 };
  const candidates = cleanCandidates(values);
  const anilistCandidates = candidates.filter(candidate => candidate.anilistId);
  const uniqueIds = [...new Set(anilistCandidates.map(candidate => candidate.anilistId))];
  const truncatedCandidates = uniqueIds.length > MAX_MEDIA_IDS;
  const ids = uniqueIds.slice(0, MAX_MEDIA_IDS);
  const timeNow = typeof now === 'function' ? now() : Number(now);
  const aniPromise = fetchAniListJapaneseSchedule(ids, {
    from, until, fetchImpl, now, minIntervalMs, timeoutMs, requestTimeoutMs, priority: 100
  }).then(result => truncatedCandidates ? { ...result, state: result.state === 'complete' ? 'partial' : result.state,
    errorCode: result.errorCode || 'candidate-limit', truncatedCandidates: true } : result);

  const jikanCandidates = candidates;
  const jikanPromise = jikanCandidates.length && Number.isSafeInteger(Number(seasonYear)) && season
    ? fetchJikanJapaneseSeasonSchedule(jikanCandidates, {
        year: Number(seasonYear), season, fetchImpl: jikanFetchImpl, now,
        ...(jikanMinIntervalMs === undefined ? {} : { minIntervalMs: jikanMinIntervalMs }),
        ...(jikanRequestTimeoutMs === undefined ? {} : { requestTimeoutMs: jikanRequestTimeoutMs }),
        ...(jikanTotalTimeoutMs === undefined ? {} : { totalTimeoutMs: jikanTotalTimeoutMs })
      })
    : Promise.resolve({ state: 'not-requested', source: 'Jikan', items: [], pageCount: 0, requestedMalIdCount: 0 });

  let [anilist, jikan] = await Promise.all([aniPromise, jikanPromise]);
  if (truncatedCandidates) anilist = { ...anilist, truncatedCandidates: true };
  const sources = { AniList: anilist, Jikan: jikan };
  const requestedSources = Object.values(sources).filter(source => source.state !== 'not-requested');
  const allComplete = requestedSources.length > 0 && requestedSources.every(source => source.state === 'complete');
  const anyUsable = requestedSources.some(source => ['complete', 'partial'].includes(source.state));
  const state = allComplete ? 'complete' : anyUsable ? 'partial' : 'failed';
  const items = [...(Array.isArray(anilist.items) ? anilist.items : []), ...(Array.isArray(jikan.items) ? jikan.items : [])];
  const errors = requestedSources.filter(source => source.errorCode).map(source => `${source.source}:${source.errorCode}`);
  return {
    state,
    fromCache: Boolean(anilist.fromCache || jikan.fromCache),
    source: jikan.state === 'not-requested' ? 'AniList' : 'AniList+Jikan',
    timeZone: 'Asia/Tokyo',
    items,
    pageCount: Number(anilist.pageCount) || 0,
    duplicateRows: Number(anilist.duplicateRows) || 0,
    rejectedCountryCount: Number(anilist.rejectedCountryCount) || 0,
    rejectedFormatCount: Number(anilist.rejectedFormatCount) || 0,
    unmatchedCount: Number(anilist.unmatchedCount) || 0,
    truncatedCandidates,
    sources,
    ...(errors.length ? { errorCode: errors.join(',') } : state === 'failed' ? { errorCode: 'no-schedule-source' } : {}),
    requestDiagnostics: {
      catalogCandidateCount: candidates.length,
      catalogAniListIdCount: uniqueIds.length,
      catalogMalIdCount: new Set(candidates.map(candidate => candidate.malId).filter(Boolean)).size,
      unverifiedIdentityCount: candidates.filter(candidate => !candidate.anilistId && !candidate.malId).length,
      elapsedMs: Math.max(0, (typeof now === 'function' ? now() : timeNow) - timeNow)
    }
  };
}

function clearJapaneseSeasonScheduleCache() {
  cache.clear();
  inFlight.clear();
  clearJikanJapaneseSeasonScheduleCache();
}

module.exports = {
  QUERY,
  cleanIds,
  cleanCandidates,
  validRange,
  mediaIsJapaneseTv,
  fetchJapaneseSeasonSchedule,
  clearJapaneseSeasonScheduleCache
};
