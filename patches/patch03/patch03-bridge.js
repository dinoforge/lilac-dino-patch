(function () {
  'use strict';

  const api = window.LilacIntegratedSearch;
  const providers = Array.isArray(api?.PROVIDERS) ? api.PROVIDERS.slice() : [];
  const labels = { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkani: '링크애니' };
  const singleSources = ['linkkf', ...providers];
  const sourceSelect = document.querySelector('#contentSource');
  const sourceChoices = document.querySelector('#sourceChoices');
  const officialSearch = window.doSearch;
  const officialOpenDetail = window.openDetail;
  const officialSyncChoices = window.syncSettingChoices;
  const officialSwitchView = window.switchView;
  const officialShowHomeList = window.showHomeList;
  const officialRenderCards = window.renderCards;
  const officialRememberAnime = window.rememberAnime;

  function disablePatch(reason) {
    sourceSelect?.querySelector('option[value="integrated"]')?.remove();
    sourceChoices?.querySelector('[data-value="integrated"]')?.remove();
    window.__dinoPatch03Bridge = { active: false, reason };
  }

  if (!api || typeof officialSearch !== 'function' || typeof officialOpenDetail !== 'function'
    || typeof officialSwitchView !== 'function'
    || typeof window.lilac?.providerCatalog !== 'function' || typeof window.lilac?.providerDetail !== 'function'
    || typeof window.lilac?.providerResolve !== 'function' || !sourceSelect || !sourceChoices) {
    disablePatch('required official renderer or IPC contract is missing');
    return;
  }

  const initialSourceSettings = typeof api.initializeSourceSettings === 'function'
    ? api.initializeSourceSettings(localStorage)
    : { ok: false, reason: 'source-settings-migration-contract-is-missing' };
  if (!initialSourceSettings.ok || typeof api.readSourceSettings !== 'function'
    || typeof api.saveSourceSelection !== 'function') {
    disablePatch(initialSourceSettings.reason || 'source settings could not be migrated safely');
    return;
  }

  const workIndex = api.createWorkIndex(localStorage);
  // IPC is additive. If an older supported LilacAnime build lacks the
  // SQLite preload method, keep the v1 work cache and original titles.
  const sqlite = window.DinoSqliteSync?.connect(
    workIndex, window.lilac?.dinoWorkIndex,
    { delay: (fn,ms) => setTimeout(fn,ms) }
  ) || { start:async()=>false,ensure:async anchor=>workIndex.find(anchor),
    flush:async()=>false,backup:async()=>({ok:false,reason:'SQLite 사용 불가'}),isReady:()=>false,
    report:()=>({active:false,phase:'legacy'}),stats:async()=>({available:false}),
    diagnostic:async method=>['search','titleHistory','linkHistory'].includes(method)?[]:{ok:false,available:false} };
  // The integrated work index is additive. Do not even initialize its
  // SQLite connection while LilacAnime is in an individual supplier mode.
  // Changing mode reloads the original renderer and starts this on next boot.
  if (api.readSourceSettings(localStorage).mode === 'integrated')
    sqlite.start().then(ready => {
      if (ready) scheduleOriginalCatalogSeed();
    }).catch(()=>{});
  const groupBySourceId = new Map();
  let resultGroups = [];
  let resultStatuses = [];
  let currentFilter = 'all';
  let searchSequence = 0;
  let detailSequence = 0;
  let currentQuery = '';
  let filterRoot = document.querySelector('#searchProviderFilters');

  // Integrated mode applies to every detail entry point, not only search.
  // Discoveries are read-only and require a verified anime identity.
  const detailGroupsBySourceId = new Map();
  const detailFacts = new Map();
  const verifiedVideoQuality = new Map();
  const detailDiscoveryCache = new Map();
  const DISCOVERY_TTL_MS = 5 * 60 * 1000;
  const catalogRequestCache = new Map();
  const detailSearchDiagnostics = new Map();
  const detailUnverifiedCandidates = new Map();
  const detailRejectionReasons = new Map();
  const detailedIdentityCache = new Map();
  const SEARCH_CACHE_TTL_MS = 90 * 1000;
  function cachedCatalog(provider, query, offset = undefined) {
    const key = JSON.stringify([provider, String(query || ''), offset ?? null]);
    const cached = catalogRequestCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.promise;
    const promise = Promise.resolve().then(() => window.lilac.providerCatalog(provider, query, offset));
    catalogRequestCache.set(key, { at: Date.now(), promise });
    if (catalogRequestCache.size > 260) catalogRequestCache.delete(catalogRequestCache.keys().next().value);
    promise.catch(() => {
      if (catalogRequestCache.get(key)?.promise === promise) catalogRequestCache.delete(key);
    });
    return promise;
  }
  const sourceKey = item => String(item?.mal_id ?? item?.id ?? '');
  // One canonical title per work, regardless of the provider being viewed.
  function canonicalTitleFor(item) {
    return item && isDinoProvider(item) ? workIndex.find(item)?.titles || null : null;
  }
  const isDinoProvider = item => !!item && providers.includes(item.provider) && !!sourceKey(item);
  const localKoreanCatalog = async (provider, query) => {
    if (!/[가-힣]/.test(String(query)) || !['reanime', 'animenosub'].includes(provider)
      || typeof window.lilac.catalogKoreanSearch !== 'function') return null;
    const result = await window.lilac.catalogKoreanSearch(provider, query);
    return Array.isArray(result) ? result : [];
  };
  function keepDetailGroup(group) {
    if (!Array.isArray(group?.sourceItems)) return;
    workIndex.remember(group);
    for (const item of group.sourceItems) {
      if (isDinoProvider(item)) {
        detailGroupsBySourceId.set(sourceKey(item), group);
        if (typeof window.rememberAnime === 'function') window.rememberAnime(item);
      }
    }
    if (detailGroupsBySourceId.size > 600) {
      for (const key of [...detailGroupsBySourceId.keys()].slice(0, 100)) detailGroupsBySourceId.delete(key);
    }
  }
  function initialKnownSource(id, group) {
    const known = group?.sourceItems?.find(item => sourceKey(item) === String(id));
    return known || (typeof window.animeById === 'function' ? window.animeById(id) : null);
  }
  function commonTitleGroup(group) {
    if (!Array.isArray(group?.sourceItems)) return group;
    const ko = group.sourceItems.map(canonicalTitleFor).find(t => t?.ko)?.ko;
    return ko ? { ...group, displayTitle: ko } : group;
  }
  function verifiedGroupFor(anchor, candidates) {
    const accepted = [anchor], seen = new Set([anchor.provider + ':' + sourceKey(anchor)]);
    for (const item of candidates) {
      if (!isDinoProvider(item) || !api.identityMatch(anchor, item)
        || workIndex.separateWorks(anchor, item)) continue;
      const key = item.provider + ':' + sourceKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push(item);
    }
    const groups = api.groupResults(accepted, selectedProvider());
    return commonTitleGroup(groups.find(group => group.sourceItems.some(item => item.provider === anchor.provider
      && sourceKey(item) === sourceKey(anchor))) || api.groupResults([anchor], selectedProvider())[0]);
  }
  // Some upstream catalogs (especially Animenosub) return year: ''.
  // Their detail endpoint can supply the actual release year. Only fetch a
  // bounded number of exact-title candidates, then let the STRICT year/season
  // and external-ID matcher decide; never merge on title alone.
  const strongTitleCandidate = (reference, candidate) => {
    if (!isDinoProvider(candidate) || candidate.provider === reference.provider
      || !api.metadataCompatible(reference, candidate, { aliasMatch: true })) return false;
    const left = new Set(api.aliases(reference).filter(key => key.length >= 5));
    return api.aliases(candidate).some(key => key.length >= 5 && left.has(key));
  };
  function detailedIdentity(item) {
    const key = item.provider + ':' + sourceKey(item);
    const cached = detailedIdentityCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.promise;
    const promise = Promise.resolve().then(() => window.lilac.providerDetail(item))
      .then(result => {
        const data = result?.data;
        // Only accept metadata for the SAME underlying provider item.
        if (!data || data.provider !== item.provider || sourceKey(data) !== sourceKey(item)) return item;
        const enriched = { ...item };
        for (const field of ['year', 'season', 'part', 'aired', 'type', 'format',
          'title_english', 'title_japanese', 'anilistId', 'malId']) {
          if ((enriched[field] == null || enriched[field] === '') && data[field] != null && data[field] !== '')
            enriched[field] = data[field];
        }
        if ((!Array.isArray(item.synonyms) || !item.synonyms.length) && Array.isArray(data.synonyms))
          enriched.synonyms = data.synonyms;
        return enriched;
      }).catch(() => item);
    detailedIdentityCache.set(key, { at: Date.now(), promise });
    if (detailedIdentityCache.size > 120) detailedIdentityCache.delete(detailedIdentityCache.keys().next().value);
    return promise;
  }
  async function enrichMissingIdentityYears(reference, items, { background = false } = {}) {
    if (typeof window.lilac?.providerDetail !== 'function') return { reference, items };
    const matches = items.filter(item => strongTitleCandidate(reference, item));
    if (!matches.length) return { reference, items };
    let enrichedReference = reference;
    if (!api.year(reference) && matches.length) enrichedReference = await detailedIdentity(reference);
    const eligible = matches.filter(item => !api.year(item)
      && strongTitleCandidate(enrichedReference, item))
      .slice(0, background ? 1 : 4);
    if (!eligible.length) return { reference: enrichedReference, items };
    const updated = await Promise.all(eligible.map(detailedIdentity));
    const enriched = new Map(updated.map(item => [item.provider + ':' + sourceKey(item), item]));
    return { reference: enrichedReference,
      items: items.map(item => enriched.get(item.provider + ':' + sourceKey(item)) || item) };
  }

  async function discoverSources(anchor, knownGroup, { background = false, force = false, onlyProviders = null } = {}) {
    const identityKey = anchor.provider + ':' + sourceKey(anchor);
    const key = identityKey + (background ? ':background' : ':foreground');
    const cached = detailDiscoveryCache.get(key);
    if (!force && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.promise;
    const promise = (async () => {
      const stored = await sqlite.ensure(anchor);
      const seeds = [...(Array.isArray(knownGroup?.sourceItems) ? knownGroup.sourceItems : []),
        ...(stored?.sources || [])];
      // Foreground requests may bypass a background attempt that failed or
      // only checked a limited number of aliases/pages.
      if (!force && stored?.fresh && (background || stored.outcome !== 'error')) {
        const reference = { ...anchor,
          synonyms: [...(Array.isArray(anchor.synonyms) ? anchor.synonyms : []), ...stored.names] };
        return verifiedGroupFor(reference, seeds);
      }
      const knownGroupNow = verifiedGroupFor(anchor, seeds);
      // Expired positive/missing mappings get a full recheck. Otherwise use
      // the provider IDs already observed in Lilac's own cards and only ask
      // for suppliers not yet represented in this work.
      const expiredVerified = stored && !stored.fresh
        && ['verified', 'missing', 'error'].includes(stored.outcome);
      const toCheck = Array.isArray(onlyProviders)
        ? [...new Set(onlyProviders)].filter(provider => providers.includes(provider)
          && !knownGroupNow.sourceItems.some(item => item.provider === provider))
        : expiredVerified ? providers.slice()
        : providers.filter(provider => !knownGroupNow.sourceItems.some(item => item.provider === provider));
      if (!toCheck.length) {
        workIndex.remember(knownGroupNow, { checked: true, attempted: true, outcome: 'verified' });
        return knownGroupNow;
      }
      const nativeTitles = [anchor.displayTitle, anchor.title, anchor.title_english,
        anchor.title_japanese, anchor.title_native, anchor.title_romaji, anchor.romaji,
        ...(Array.isArray(anchor.synonyms) ? anchor.synonyms : [])]
        .filter(value => typeof value === 'string' && value.trim().length > 1);
      const query = String((typeof window.titleOf === 'function' && window.titleOf(anchor))
        || anchor.title || nativeTitles[0] || '').trim();
      if (!query) return verifiedGroupFor(anchor, seeds);
      // Reuse the original app's disk-backed Korean/English display-title
      // resolver (TMDB, Anissia, AniList, Wikidata), rather than translating
      // or fetching the same name independently in Dino.
      let resolvedTitles = [stored?.titles?.ko, stored?.titles?.en, stored?.titles?.ja]
        .filter(value => typeof value === 'string' && value.trim());
      // LilacAnime owns the actual Korean-title resolution and its disk
      // cache. Once the result is saved at WORK level, reuse it for every
      // provider instead of re-invoking the resolver for each source.
      const hasOfficialTitle = stored?.titles?.koSource === 'official'
        || stored?.titles?.manual === true;
      if (!hasOfficialTitle && typeof window.lilac.resolveTitles === 'function') {
        try {
          const resolved = await window.lilac.resolveTitles([anchor]);
          if (Array.isArray(resolved)) {
            const primary = resolved.find(item => item?.ko || item?.en) || {};
            workIndex.rememberTitles(anchor, { ko: primary.ko, en: primary.en },
              { source: 'official' });
            resolvedTitles = [...new Set([...resolvedTitles, primary.ko, primary.en])]
              .filter(value => typeof value === 'string' && value.trim());
          }
        } catch { /* original title cache remains optional */ }
      }
      let variants = [];
      if (typeof window.lilac.titleVariants === 'function') {
        try {
          const received = await window.lilac.titleVariants(query);
          variants = Array.isArray(received) ? received : [];
        } catch { /* Original aliases remain usable. */ }
      }
      const terms = api.titleVariantTerms({
        query, displayTitles: [...nativeTitles, ...resolvedTitles, ...(stored?.names || [])],
        variants, limit: background ? 2 : 5
      });
      // Official title variants are candidate aliases, not sufficient alone
      // to join anime. The existing identity matcher still demands matching
      // release years, compatible season/format and non-conflicting IDs.
      const verifiedAliases = [...new Set([...nativeTitles, ...resolvedTitles,
        ...(workIndex.find(anchor)?.names || stored?.names || []), ...variants])]
        .filter(value => typeof value === 'string' && value.trim().length > 1)
        .slice(0, 16);
      const reference = {
        ...anchor,
        synonyms: [...(Array.isArray(anchor.synonyms) ? anchor.synonyms : []), ...verifiedAliases]
      };
      const options = {
        search: cachedCatalog,
        localSearch: localKoreanCatalog,
        concurrency: background ? 3 : 5, maxPages: background ? 1 : 2,
        timeoutMs: background ? 9000 : 12000
      };
      const first = await api.searchProviders({ ...options, providers: toCheck, query });
      let diagnostics = first;
      let identity = await enrichMissingIdentityYears(reference, [...seeds, ...first.items], { background });
      let group = verifiedGroupFor(identity.reference, identity.items);
      // A successful nonempty catalog response can contain unrelated anime.
      // Only an identity match proves that the requested work was found.
      const matched = new Set(group.sourceItems.map(item => item.provider));
      const missing = toCheck.filter(provider => !matched.has(provider));
      if (missing.length && terms.length) {
        const extra = await api.searchProviders({
          ...options, providers: missing, query: '', terms,
          localSearch: async () => null
        });
        identity = await enrichMissingIdentityYears(identity.reference,
          [...identity.items, ...extra.items], { background });
        group = verifiedGroupFor(identity.reference, identity.items);
        diagnostics = api.mergeSearchResults(first, extra);
      }
      // Mark a mapping fresh only when every attempted supplier answered.
      // Failed or skipped lookups never turn into permanent "not found".
      const complete = !Array.isArray(onlyProviders)
        && (diagnostics.statuses || []).length === toCheck.length
        && diagnostics.statuses.every(status => status.state === 'ready' && !status.pageLimitReached);
      // All five verified sources can be reused for 30 days. A successful
      // scan that did not find some sources is rechecked after 7 days.
      // Partial/failed scans are retried after 3 days; known links survive.
      const allMatched = providers.every(provider =>
        group.sourceItems.some(item => item.provider === provider));
      // Limited background matching is deliberately not a verified "missing"
      // result. It cools down for 3 days; an explicit foreground visit can
      // still search thoroughly without being blocked by the cache.
      const outcome = !complete || (background && !allMatched) ? 'error'
        : allMatched ? 'verified' : 'missing';
      workIndex.remember(group, { checked: complete,
        attempted: !Array.isArray(onlyProviders),
        outcome: Array.isArray(onlyProviders) ? '' : outcome, names: verifiedAliases });
      // Diagnostic matches are observations, never instructions to link works.
      const unverified = [...new Set(identity.items.filter(item =>
        strongTitleCandidate(identity.reference, item)
        && !api.identityMatch(identity.reference, item)
      ).map(item => item.provider))];
      const rejectionDetails = new Map();
      const reasonPriority = ['id-conflict', 'season-different', 'year-different',
        'format-different', 'year-unconfirmed', 'identity-unconfirmed'];
      for (const item of identity.items) {
        if (!isDinoProvider(item) || item.provider === anchor.provider
          || group.sourceItems.some(linked => linked.provider === item.provider)) continue;
        const reason = api.identityDifference(identity.reference, item);
        if (reason === 'title-different' || reason === 'matched') continue;
        const previous = rejectionDetails.get(item.provider);
        if (!previous || reasonPriority.indexOf(reason) < reasonPriority.indexOf(previous))
          rejectionDetails.set(item.provider, reason);
      }
      for (const item of [anchor, ...group.sourceItems]) {
        const scanKey = item.provider + ':' + sourceKey(item);
        const previous = Array.isArray(onlyProviders) ? (detailSearchDiagnostics.get(scanKey) || []) : [];
        const remaining = previous.filter(row => !toCheck.includes(row.provider));
        detailSearchDiagnostics.set(scanKey, [...remaining, ...(diagnostics.statuses || [])]);
        const candidates = Array.isArray(onlyProviders)
          ? (detailUnverifiedCandidates.get(scanKey) || []).filter(p => !toCheck.includes(p)) : [];
        detailUnverifiedCandidates.set(scanKey, [...new Set([...candidates, ...unverified])]);
        const prior = Array.isArray(onlyProviders)
          ? new Map(detailRejectionReasons.get(scanKey) || []) : new Map();
        for (const provider of toCheck) prior.delete(provider);
        for (const [provider, reason] of rejectionDetails) prior.set(provider, reason);
        detailRejectionReasons.set(scanKey, prior);
      }
      for (const cache of [detailSearchDiagnostics, detailUnverifiedCandidates, detailRejectionReasons])
        while (cache.size > 120) cache.delete(cache.keys().next().value);
      return group;
    })();
    detailDiscoveryCache.set(key, { at: Date.now(), promise });
    if (detailDiscoveryCache.size > 120) detailDiscoveryCache.delete(detailDiscoveryCache.keys().next().value);
    promise.catch(() => {
      if (detailDiscoveryCache.get(key)?.promise === promise) detailDiscoveryCache.delete(key);
    });
    return promise;
  }


  window.switchView = function (view, ...args) {
    if (view !== 'search') searchSequence++;
    return officialSwitchView.call(this, view, ...args);
  };
  if (typeof officialShowHomeList === 'function') {
    window.showHomeList = function (...args) {
      searchSequence++;
      // Original lists may include more entries than the first visible rail.
      // Import only the bounded first slice, without querying any supplier.
      if (integratedMode() && Array.isArray(args[0]))
        workIndex.observe(args[0], { limit: 24 });
      return officialShowHomeList.apply(this, args);
    };
  }

  const integratedMode = () => api.readSourceSettings(localStorage).mode === 'integrated';
  function selectedProvider() {
    const stored = api.readSourceSettings(localStorage).provider;
    return singleSources.includes(stored) ? stored : initialSourceSettings.provider;
  }

  // As with LilacAnime's Korean title index, discover mappings in the
  // background as home/season/catalog cards become available. Do not bulk-
  // scrape all five sites on every launch: persist a daily work budget, run
  // one work at a time and reuse the same verified index as detail/search.
  const PREFETCH_BUDGET_KEY = 'lilacDinoPatch.workIndex.prefetchBudget.v1';
  const PREFETCH_SESSION_LIMIT = 8;
  const PREFETCH_DAILY_LIMIT = 18;
  const PREFETCH_RETRY_MS = 3 * 24 * 60 * 60 * 1000;
  const PREFETCH_LIST_TARGETS = new Set(['#seasonRail', '#airingRail', '#topRail',
    '#allGrid', '#catalogGrid']);
  // Search has already queried every supplier and must not re-enqueue
  // its results for a costly duplicate background scan.
  const prefetchQueue = [];
  const prefetchSeen = new Set();
  let prefetchTimer = null;
  let prefetchBusy = false;
  let prefetchStarted = 0;
  let prefetchFailed = 0;
  // Apply both background budgets at the computer's local midnight.
  // Previous numeric UTC-day records naturally expire after this upgrade.
  const budgetDay = () => {
    const day=new Date();
    return [day.getFullYear(),String(day.getMonth()+1).padStart(2,'0'),
      String(day.getDate()).padStart(2,'0')].join('-');
  };
  function dailyPrefetchCount() {
    try {
      const budget = JSON.parse(localStorage.getItem(PREFETCH_BUDGET_KEY) || 'null');
      return budget?.day === budgetDay() && Number.isInteger(budget?.count)
        ? Math.max(0, Math.min(PREFETCH_DAILY_LIMIT, budget.count)) : 0;
    } catch { return 0; }
  }
  function recordPrefetchAttempt() {
    const count = dailyPrefetchCount() + 1;
    try {
      localStorage.setItem(PREFETCH_BUDGET_KEY, JSON.stringify({ day: budgetDay(), count }));
    } catch { /* session budget still protects against repeated requests */ }
  }
  function prefetchedRecently(item) {
    const cached = workIndex.find(item);
    return cached?.fresh || (cached?.attemptedAt > 0
      && Date.now() - cached.attemptedAt < PREFETCH_RETRY_MS);
  }
  function schedulePrefetch(delay = 2300) {
    if (prefetchTimer !== null || prefetchBusy || !prefetchQueue.length || !integratedMode()
      || prefetchStarted >= PREFETCH_SESSION_LIMIT || dailyPrefetchCount() >= PREFETCH_DAILY_LIMIT) return;
    if (typeof setTimeout !== 'function') return;
    prefetchTimer = setTimeout(() => {
      prefetchTimer = null;
      runNextPrefetch().catch(() => { prefetchFailed++; });
    }, delay);
  }
  async function runNextPrefetch() {
    if (prefetchBusy || !integratedMode() || !prefetchQueue.length
      || prefetchStarted >= PREFETCH_SESSION_LIMIT || dailyPrefetchCount() >= PREFETCH_DAILY_LIMIT) return;
    // Foreground playback and detail always take priority over indexing.
    if (document.hidden === true || document.querySelector('#detailDialog')?.open
      || document.querySelector('#playerView')?.classList?.contains('active')) {
      schedulePrefetch(15000);
      return;
    }
    const next = prefetchQueue.shift();
    if (!next || prefetchedRecently(next)) {
      schedulePrefetch(900);
      return;
    }
    prefetchBusy = true;
    prefetchStarted++;
    recordPrefetchAttempt();
    try {
      await discoverSources(next, null, { background: true });
    } catch {
      // Do not turn an outage into a long-lived "not found" result.
      // Remember only that this item was attempted for the cooldown.
      workIndex.remember({ sourceItems: [next] }, { attempted: true, outcome: 'error' });
      prefetchFailed++;
    } finally {
      prefetchBusy = false;
      schedulePrefetch(3600);
    }
  }
  function queueVisibleWorks(target, items) {
    if (!PREFETCH_LIST_TARGETS.has(target) || !integratedMode() || !Array.isArray(items)
      || prefetchStarted >= PREFETCH_SESSION_LIMIT || dailyPrefetchCount() >= PREFETCH_DAILY_LIMIT) return;
    for (const item of items.slice(0, 32)) {
      if (!isDinoProvider(item) || !String(item.title || item.title_english || item.displayTitle || '').trim()) continue;
      const key = item.provider + ':' + sourceKey(item);
      if (prefetchSeen.has(key) || prefetchedRecently(item)) continue;
      prefetchSeen.add(key);
      prefetchQueue.push(item);
      if (prefetchQueue.length >= 60) break;
    }
    schedulePrefetch();
  }
  // Every original source uses renderCards for its main rails. Copy already
  // downloaded cards (including Korean-title aliases) into the shared local
  // index. No new providerCatalog, title resolver or remote request is made.
  // Only ongoing titles are checked automatically. A provider's own detail
  // endpoint supplies actual playable episodes; catalog estimates never
  // overwrite the verified per-supplier episode snapshot.
  const EPISODE_REFRESH_BUDGET_KEY = 'lilacDinoPatch.episodeRefreshBudget.v1';
  const EPISODE_REFRESH_SESSION_LIMIT = 8;
  const EPISODE_REFRESH_DAILY_LIMIT = 18;
  const EPISODE_REFRESH_TTL_MS = 12 * 60 * 60 * 1000;
  const EPISODE_FAILURE_TTL_MS = 6 * 60 * 60 * 1000;
  const EPISODE_DETAIL_TTL_MS = 6 * 60 * 60 * 1000;
  const EPISODE_REFRESH_DELAY_MS = 20000;
  const episodeQueue = [];
  const episodeQueued = new Set();
  let episodeTimer = null, episodeBusy = false, episodePaused = false;
  let episodeAttempted = 0, episodeSucceeded = 0, episodeFoundNew = 0, episodeFailed = 0;
  function airingStatus(item, fromAiringRail = false) {
    const status = String(item?.status || '').toLowerCase().trim().replace(/[_-]/g, ' ');
    if (/(finished|completed|complete|ended|cancelled|canceled|not yet|upcoming|미방영|완결|종영|방영\s*종료)/.test(status))
      return false;
    return /(^|[\s,])(airing|ongoing|releasing|broadcasting|on air)([\s,]|$)|방영\s*중|연재\s*중/.test(status)
      || fromAiringRail && !status;
  }
  function episodeBudgetCount() {
    try {
      const saved = JSON.parse(localStorage.getItem(EPISODE_REFRESH_BUDGET_KEY) || 'null');
      return saved?.day === budgetDay() && Number.isInteger(saved?.count)
        ? Math.max(0, Math.min(saved.count, EPISODE_REFRESH_DAILY_LIMIT)) : 0;
    } catch { return 0; }
  }
  function recordEpisodeAttempt() {
    try {
      localStorage.setItem(EPISODE_REFRESH_BUDGET_KEY,JSON.stringify({
        day:budgetDay(),count:episodeBudgetCount()+1
      }));
    } catch { /* the per-session limit still guards against repeated requests */ }
  }
  function episodeCheckDue(item) {
    const saved = workIndex.episodeState(item);
    if (!saved) return true;
    const at = saved.state === 'error' ? saved.attemptedAt : saved.checkedAt;
    const ttl = saved.state === 'error' ? EPISODE_FAILURE_TTL_MS : EPISODE_REFRESH_TTL_MS;
    return !at || Date.now() - at >= ttl;
  }
  function scheduleEpisodeRefresh(delay = EPISODE_REFRESH_DELAY_MS) {
    if (episodePaused || !integratedMode() || episodeTimer !== null || episodeBusy || !episodeQueue.length
      || episodeAttempted >= EPISODE_REFRESH_SESSION_LIMIT
      || episodeBudgetCount() >= EPISODE_REFRESH_DAILY_LIMIT) return;
    episodeTimer = setTimeout(() => {
      episodeTimer = null;
      runNextEpisodeRefresh().catch(() => { episodeFailed++; });
    }, delay);
  }
  const episodeMetrics = api.episodeMetrics;
  async function runNextEpisodeRefresh() {
    if (episodePaused || episodeBusy || !integratedMode() || !episodeQueue.length
      || episodeAttempted >= EPISODE_REFRESH_SESSION_LIMIT
      || episodeBudgetCount() >= EPISODE_REFRESH_DAILY_LIMIT) return;
    if (window.navigator?.onLine === false) {
      scheduleEpisodeRefresh(30000);
      return;
    }
    if (document.hidden === true || document.querySelector('#detailDialog')?.open
      || document.querySelector('#playerView')?.classList?.contains('active')) {
      scheduleEpisodeRefresh(15000);
      return;
    }
    const next = episodeQueue.shift();
    if (next) episodeQueued.delete(next.provider + ':' + sourceKey(next));
    const current = next && workIndex.find(next)?.sources.find(source =>
      source.provider === next.provider && sourceKey(source) === sourceKey(next));
    // A card can change from airing to completed while sitting in the queue.
    // An explicit completed status always cancels the pending supplier call.
    if (current?.status && !airingStatus(current)
      || !next || !next.__dinoForce && !episodeCheckDue(next)) {
      scheduleEpisodeRefresh(1800);
      return;
    }
    episodeBusy = true;
    episodeAttempted++;
    recordEpisodeAttempt();
    try {
      const before = workIndex.episodeState(next);
      const response = await window.lilac.providerDetail(next);
      const metrics = episodeMetrics(response);
      if (!metrics) {
        workIndex.rememberEpisode(next,null);
        episodeFailed++;
      } else {
        workIndex.rememberEpisode(next,metrics);
        episodeSucceeded++;
        if (before?.latest > 0 && metrics.latest > before.latest) episodeFoundNew++;
      }
    } catch {
      workIndex.rememberEpisode(next,null);
      episodeFailed++;
    } finally {
      episodeBusy = false;
      scheduleEpisodeRefresh(14000);
    }
  }
  function queueAiringEpisodes(target,items,{force=false}={}) {
    if (!integratedMode() || !Array.isArray(items)
      || episodeAttempted >= EPISODE_REFRESH_SESSION_LIMIT
      || episodeBudgetCount() >= EPISODE_REFRESH_DAILY_LIMIT) return;
    const fromAiringRail = target === '#airingRail';
    for (const item of items.slice(0,24)) {
      if (!isDinoProvider(item) || !airingStatus(item,fromAiringRail)) continue;
      const known = workIndex.find(item)?.sources || [item];
      for (const source of known) {
        if (!isDinoProvider(source) || !airingStatus(source,fromAiringRail)
          || !force && !episodeCheckDue(source)) continue;
        const key = source.provider + ':' + sourceKey(source);
        if (episodeQueued.has(key)) continue;
        episodeQueued.add(key);
        episodeQueue.push(force?{...source,__dinoForce:true}:source);
        if (episodeQueue.length >= 40) break;
      }
      if (episodeQueue.length >= 40) break;
    }
    scheduleEpisodeRefresh(force?250:EPISODE_REFRESH_DELAY_MS);
  }
  const episodeSchedulerControl = {
    pause(){episodePaused=true;if(episodeTimer!==null){if(typeof clearTimeout==='function')clearTimeout(episodeTimer);episodeTimer=null;}},
    resume(){episodePaused=false;scheduleEpisodeRefresh(400);},
    refresh(items){queueAiringEpisodes('#airingRail',items,{force:true});return episodeQueue.length;}
  };
  document.addEventListener?.('visibilitychange',()=>{
    if(document.hidden!==true)scheduleEpisodeRefresh(400);
  });

  const OBSERVED_CARD_TARGETS = new Set(['#seasonRail', '#airingRail', '#topRail',
    '#allGrid', '#catalogGrid', '#libraryGrid', '#searchGrid',
    '#pvRail', '#movieRail', '#adultRail']);
  // Original card() calls rememberAnime() even when sorted/catalog pages
  // append cards directly instead of using renderCards(). Keep that path
  // observable too, while preserving the original in-memory lookup contract.
  if (typeof officialRememberAnime === 'function') {
    window.rememberAnime = function (item, ...args) {
      const result = officialRememberAnime.call(this, item, ...args);
      if (integratedMode() && isDinoProvider(item))
        workIndex.observe([item], { limit: 1 });
      return result;
    };
  }
  function observeOriginalCards(target, items) {
    if (!integratedMode() || !OBSERVED_CARD_TARGETS.has(target) || !Array.isArray(items)) return;
    const flattened = [];
    for (const item of items.slice(0, 36)) {
      if (Array.isArray(item?.sourceItems)) flattened.push(...item.sourceItems);
      else flattened.push(item);
    }
    workIndex.observe(flattened, { limit: 24 });
    queueAiringEpisodes(target,flattened);
  }
  if (typeof officialRenderCards === 'function') {
    window.renderCards = function (target, items, ...args) {
      const rendered = officialRenderCards.call(this, target, items, ...args);
      observeOriginalCards(target, items);
      queueVisibleWorks(target, items);
      return rendered;
    };
  }


  // Only use the official Re:Anime index already persisted by LilacAnime.
  // Its "popular" providerCatalog paging is fulfilled from the MAIN PROCESS
  // local sorted index. A 36-item page is a batch size, NOT a daily quota.
  // Read one idle batch at a time until 1,000 works are indexed or the
  // original catalog ends. The other four suppliers retain DB headroom.
  const CATALOG_SEED_KEY = 'lilacDinoPatch.workIndex.originalCatalogSeed.v1';
  const CATALOG_SEED_PAGE_SIZE = 36;
  const CATALOG_SEED_TARGET = 1000;
  const CATALOG_SEED_MAX_WORKS = 1600;
  const CATALOG_SEED_MAX_LOCAL_PAGES = 4;
  const CATALOG_SEED_BATCH_DELAY_MS = 1400;
  const CATALOG_SEED_PAUSE_DELAY_MS = 15000;
  const CATALOG_SEED_EXHAUSTED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
  let catalogSeedBusy = false;
  let catalogSeedTimer = null;
  let catalogSeedImported = 0;
  let catalogSeedChecks = 0;
  let catalogSeedStatus = 'idle';
  function catalogSeedCheckpoint() {
    try {
      const saved = JSON.parse(localStorage.getItem(CATALOG_SEED_KEY) || 'null');
      return saved && Number.isInteger(saved.offset) && saved.offset >= 0
        ? saved : { offset: 0 };
    } catch { return { offset: 0 }; }
  }
  function catalogSeedReachedTarget() {
    // SQLite persists an unbounded catalog: 1000 is only the legacy
    // localStorage safety ceiling, never a global works-table limit.
    return !sqlite.isReady() &&
      (workIndex.stats().providers.reanime || 0) >= CATALOG_SEED_TARGET;
  }
  function catalogSeedAtCapacity() {
    return !sqlite.isReady() && workIndex.stats().works >= CATALOG_SEED_MAX_WORKS;
  }
  function catalogSeedExhausted(source, checkpoint = catalogSeedCheckpoint()) {
    return Number(checkpoint.exhaustedTotal) === Number(source?.total)
      && Number(source?.total) > 0
      && Date.now() - (Number(checkpoint.exhaustedAt) || 0)
        < CATALOG_SEED_EXHAUSTED_RECHECK_MS;
  }
  function catalogSeedForegroundBusy() {
    // A minimized window is ideal for LOCAL index work. Pause only when
    // interacting with a detail modal or playing video, never for visibility.
    return Boolean(document.querySelector('#detailDialog')?.open
      || document.querySelector('#playerView')?.classList?.contains('active'));
  }
  async function seedFromOriginalCatalog(indexState) {
    if (!integratedMode() || catalogSeedBusy
      || typeof window.lilac?.providerCatalog !== 'function') return;
    const source = indexState?.sources?.find(entry =>
      entry.provider === 'reanime' && Number(entry.total) > 0);
    // Never call activateCatalog(), which may start an upstream full-catalog
    // download. If no local Re:Anime list is ready, simply do nothing.
    if (!source) { catalogSeedStatus = 'no-local-index'; return; }
    if (catalogSeedReachedTarget()) { catalogSeedStatus = 'target-reached'; return; }
    if (catalogSeedAtCapacity()) {
      catalogSeedStatus = 'db-capacity-reserved';
      return;
    }
    const checkpoint = catalogSeedCheckpoint();
    if (catalogSeedExhausted(source, checkpoint)) {
      catalogSeedStatus = 'catalog-end-reached';
      return;
    }
    if (catalogSeedForegroundBusy()) {
      catalogSeedStatus = 'paused-for-playback';
      scheduleOriginalCatalogSeed(indexState, CATALOG_SEED_PAUSE_DELAY_MS);
      return;
    }

    catalogSeedBusy = true;
    catalogSeedStatus = 'reading-local-index';
    let continueLater = false;
    try {
      const total = Math.max(1, Number(source.total));
      let offset = checkpoint.offset < total ? checkpoint.offset : 0;
      let count = 0, pages = 0, reachedEnd = false;
      let reanimeCount = workIndex.stats().providers.reanime || 0;
      // Skip duplicates already seen in any original source card; visit at
      // most four LOCAL catalog pages per batch so the UI stays responsive.
      while (pages < CATALOG_SEED_MAX_LOCAL_PAGES
        && count < CATALOG_SEED_PAGE_SIZE
        && (sqlite.isReady() || reanimeCount < CATALOG_SEED_TARGET)
        && (sqlite.isReady() || workIndex.stats().works < CATALOG_SEED_MAX_WORKS)) {
        catalogSeedChecks++;
        const page = await window.lilac.providerCatalog('reanime', '', offset, 'popular');
        if (page?.pending || !Array.isArray(page?.data) || !page.data.length) {
          catalogSeedStatus = pages ? 'partially-imported' : 'index-not-ready';
          break;
        }
        pages++;
        const items = page.data.slice(0, CATALOG_SEED_PAGE_SIZE);
        let scanned = 0;
        for (const item of items) {
          if (count >= CATALOG_SEED_PAGE_SIZE ||
            (!sqlite.isReady() && reanimeCount >= CATALOG_SEED_TARGET)
            || catalogSeedAtCapacity()) break;
          scanned++;
          if (!isDinoProvider(item) || item.provider !== 'reanime'
            || !String(item.title || item.title_english || '').trim()) continue;
          const already = workIndex.find(item)?.sources?.some(existing =>
            existing.provider === 'reanime' && sourceKey(existing) === sourceKey(item));
          if (already) continue;
          // A list entry is an observation, not proof of playback
          // availability or a completed five-provider search.
          workIndex.remember({ sourceItems: [item] });
          count++;
          reanimeCount++;
        }
        offset += scanned;
        if (offset >= total || scanned === 0 || page.done
          || items.length < CATALOG_SEED_PAGE_SIZE) {
          offset = 0;
          reachedEnd = true;
          break;
        }
        if (scanned < items.length) break;
      }
      if (!pages) return;
      // Commit the work cache first, then the cursor. Never skip unsaved
      // entries if localStorage is full or the user exits mid-write.
      if (!workIndex.flush()) {
        catalogSeedStatus = 'write-failed';
        return;
      }
      if (!sqlite.isReady() && (workIndex.stats().providers.reanime || 0) < reanimeCount) {
        catalogSeedStatus = 'db-capacity-reserved';
        return;
      }
      // The cursor moves ONLY after SQLite acknowledges the batch (when
      // available), avoiding skipped titles if localStorage evicts hot rows.
      if (sqlite.isReady() && !(await sqlite.flush())) {
        catalogSeedStatus = 'sqlite-write-failed';
        return;
      }
      const completedAt = reachedEnd ? Date.now() : 0;
      try {
        localStorage.setItem(CATALOG_SEED_KEY, JSON.stringify({
          offset, time: Date.now(), exhaustedAt: completedAt,
          exhaustedTotal: reachedEnd ? total : 0
        }));
      } catch {
        catalogSeedStatus = 'checkpoint-write-failed';
        return;
      }
      catalogSeedImported += count;
      catalogSeedStatus = catalogSeedReachedTarget() ? 'target-reached'
        : reachedEnd ? 'catalog-end-reached'
        : catalogSeedAtCapacity()
          ? 'db-capacity-reserved' : 'imported';
      continueLater = !reachedEnd && !catalogSeedReachedTarget()
        && (sqlite.isReady() || workIndex.stats().works < CATALOG_SEED_MAX_WORKS);
    } catch {
      catalogSeedStatus = 'read-failed';
    } finally {
      catalogSeedBusy = false;
      if (continueLater) scheduleOriginalCatalogSeed(indexState, CATALOG_SEED_BATCH_DELAY_MS);
    }
  }
  function scheduleOriginalCatalogSeed(state = null, delay = 5000) {
    if (!integratedMode() || catalogSeedBusy || catalogSeedTimer !== null
      || typeof window.lilac?.catalogIndexState !== 'function') return;
    if (catalogSeedReachedTarget()) { catalogSeedStatus = 'target-reached'; return; }
    if (catalogSeedAtCapacity()) {
      catalogSeedStatus = 'db-capacity-reserved';
      return;
    }
    if (state) {
      const local = state.sources?.find(source => source.provider === 'reanime'
        && Number(source.total) > 0);
      if (!local) return;
      if (catalogSeedExhausted(local)) {
        catalogSeedStatus = 'catalog-end-reached';
        return;
      }
    }
    catalogSeedTimer = setTimeout(() => {
      catalogSeedTimer = null;
      (state ? Promise.resolve(state) : window.lilac.catalogIndexState())
        .then(seedFromOriginalCatalog).catch(() => { catalogSeedStatus = 'read-failed'; });
    }, delay);
  }
  if (typeof window.lilac?.catalogIndexState === 'function') {
    scheduleOriginalCatalogSeed();
    if (typeof window.lilac.onCatalogIndexState === 'function')
      window.lilac.onCatalogIndexState(state => scheduleOriginalCatalogSeed(state));
  }

  function syncSourceSelection() {
    sourceSelect.value = integratedMode() ? 'integrated' : selectedProvider();
    officialSyncChoices?.();
    sourceSelect.value = integratedMode() ? 'integrated' : selectedProvider();
  }

  window.syncSettingChoices = function (...args) {
    const result = officialSyncChoices?.apply(this, args);
    syncSourceSelection();
    return result;
  };

  sourceSelect.onchange = event => {
    const selected = event.target.value;
    if (selected !== 'integrated' && !singleSources.includes(selected)) return;
    const saved = api.saveSourceSelection(localStorage, selected);
    if (!saved.ok) {
      syncSourceSelection();
      window.toast?.('공급원 설정을 안전하게 저장하지 못했습니다. 기존 설정을 유지했습니다.');
      return;
    }
    syncSourceSelection();
    window.toast?.(selected === 'integrated' ? '통합 공급원 검색을 사용합니다.' : '콘텐츠 소스를 바꿨어요. 목록을 다시 불러옵니다.');
    setTimeout(() => window.location.reload(), 600);
  };
  syncSourceSelection();

  function ensureFilterRoot() {
    if (filterRoot?.isConnected) return filterRoot;
    const status = document.querySelector('#searchStatus');
    if (!status) return null;
    filterRoot = document.createElement('div');
    filterRoot.id = 'searchProviderFilters';
    filterRoot.className = 'search-provider-filters hidden';
    filterRoot.setAttribute('aria-label', '검색 결과 공급원 필터');
    status.insertAdjacentElement('afterend', filterRoot);
    return filterRoot;
  }

  function renderFilteredGroups() {
    window.renderCards('#searchGrid', api.filterGroups(resultGroups, currentFilter));
  }

  function updateSearchStatus() {
    const visible = api.filterGroups(resultGroups, currentFilter);
    const checked = resultStatuses.filter(item => item.state === 'ready' || item.state === 'partial').length;
    const failures = resultStatuses.filter(item => item.state === 'failed' || item.state === 'partial');
    const summary = currentFilter === 'all'
      ? `${visible.length}개 작품 · ${checked}/${resultStatuses.length}개 공급원 응답`
      : `${labels[currentFilter] || currentFilter} 결과 ${visible.length}개`;
    const notFound = resultStatuses.filter(item => item.state === 'ready' && item.resultCount === 0);
    const limited = resultStatuses.filter(item => item.pageLimitReached);
    const failureText = failures.length
      ? ` · 응답 오류: ${failures.map(item => labels[item.provider] || item.provider).join(', ')}` : '';
    const missingText = notFound.length
      ? ` · 미발견: ${notFound.map(item => labels[item.provider] || item.provider).join(', ')}` : '';
    const limitedText = limited.length ? ' · 일부 공급원은 다음 페이지가 더 있을 수 있음' : '';
    document.querySelector('#searchStatus').textContent = `“${currentQuery}” 검색 결과 ${summary}${failureText}${missingText}${limitedText}`;
  }

  function renderFilters() {
    const container = ensureFilterRoot();
    if (!container) return;
    container.replaceChildren();
    container.classList.remove('hidden');
    const add = (provider, label, count, state = 'ready') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-provider-chip';
      button.dataset.provider = provider;
      button.dataset.state = state;
      button.setAttribute('aria-pressed', String(currentFilter === provider));
      const suffix = state === 'failed' ? ' · 실패'
        : state === 'partial' ? ' · 일부 실패'
        : count === 0 ? ' · 미발견' : ` · ${count}`;
      button.textContent = `${label}${suffix}`;
      button.addEventListener('click', () => {
        currentFilter = provider;
        container.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        renderFilteredGroups();
        updateSearchStatus();
      });
      container.append(button);
    };
    add('all', '전체', resultGroups.length);
    for (const status of resultStatuses) {
      add(status.provider, labels[status.provider] || status.provider,
        api.filterGroups(resultGroups, status.provider).length, status.state);
    }
  }

  function applyResults(result) {
    const items = Array.isArray(result?.items) ? result.items : [];
    resultStatuses = Array.isArray(result?.statuses) ? result.statuses : [];
    for (const item of items) {
      if (typeof window.rememberAnime === 'function') window.rememberAnime(item);
    }
    const localized = items.map(item => ({
      ...item,
      displayTitle: typeof window.titleOf === 'function' ? window.titleOf(item) : item.displayTitle || item.title
    }));
    resultGroups = api.groupResults(localized, selectedProvider());
    groupBySourceId.clear();
    for (const group of resultGroups) {
      keepDetailGroup(group);
      const canonical = commonTitleGroup(group);
      if (canonical !== group) group.displayTitle = canonical.displayTitle;
      for (const item of group.sourceItems || []) groupBySourceId.set(String(item.mal_id), group);
    }
    renderFilters();
    renderFilteredGroups();
    updateSearchStatus();
  }

  window.doSearch = async function (query) {
    if (!integratedMode()) return officialSearch.call(this, query);
    query = String(query || '').trim();
    if (!query) return;
    const sequence = ++searchSequence;
    currentQuery = query;
    currentFilter = 'all';
    resultGroups = [];
    resultStatuses = [];
    groupBySourceId.clear();
    if (typeof window.cancelPendingPlaybackLookups === 'function') window.cancelPendingPlaybackLookups();
    if (typeof window.saveRecentSearch === 'function') window.saveRecentSearch(query);
    window.switchView('search');
    document.querySelector('#pageSearch').value = query;
    document.querySelector('#globalSearch').value = query;
    document.querySelector('#searchStatus').textContent = '통합 공급원에서 검색 중...';
    document.querySelector('#searchGrid').replaceChildren();
    document.querySelector('#filterMore')?.classList.add('hidden');
    document.querySelector('#filterBar')?.classList.add('hidden');
    document.querySelector('#filterPanel')?.classList.add('hidden');
    const container = ensureFilterRoot();
    container?.replaceChildren();
    container?.classList.add('hidden');

    // A repeated exact search reads the verified local snapshot, like the
    // original Korean title index. Errors expire quickly, healthy results
    // expire after six hours; explicit supplier refresh bypasses this path.
    const saved = workIndex.readSearch(query);
    if (saved) {
      if (sequence === searchSequence) {
        applyResults(saved);
        const status = document.querySelector('#searchStatus');
        if (status) status.textContent += ' · 로컬 DB 결과';
      }
      return;
    }

    const options = {
      providers,
      concurrency: 6,
      maxPages: 2,
      timeoutMs: 12000,
      search: cachedCatalog,
      localSearch: localKoreanCatalog
    };
    try {
      let result = await api.searchProviders({ ...options, query });
      if (sequence !== searchSequence) return;
      const missing = api.providersNeedingTitleVariants(result, providers);
      const groups = api.groupResults(result.items, selectedProvider());
      const reference = groups.find(group => group.sourceItems.some(item => item.provider === selectedProvider())) || groups[0];
      if (reference) {
        for (const status of result.statuses || []) {
          if ((status.state === 'ready' || status.state === 'partial')
            && !reference.sourceItems.some(item => item.provider === status.provider)
            && !missing.includes(status.provider)) missing.push(status.provider);
        }
      }
      if (missing.length && typeof window.lilac.titleVariants === 'function') {
        const variants = await window.lilac.titleVariants(query).then(value => Array.isArray(value) ? value : []).catch(() => []);
        if (sequence !== searchSequence) return;
        const nativeTitles = reference?.sourceItems?.flatMap(item => {
          const stored = workIndex.find(item);
          return [item.title, item.title_english, item.title_japanese, item.title_native,
            item.title_romaji, item.romaji, ...(Array.isArray(item.synonyms) ? item.synonyms : []),
            stored?.titles?.ko, stored?.titles?.en, stored?.titles?.ja,
            ...(stored?.names || [])];
        }) || [];
        const terms = api.titleVariantTerms({ query, displayTitles: nativeTitles, variants, limit: 3 });
        if (terms.length) {
          const extra = await api.searchProviders({ ...options, providers: missing, query: '', terms });
          if (sequence !== searchSequence) return;
          result = api.mergeSearchResults(result, extra);
        }
      }
      if (sequence === searchSequence) {
        applyResults(result);
        workIndex.rememberSearch(query, result);
      }
    } catch (error) {
      if (sequence === searchSequence) {
        document.querySelector('#searchStatus').textContent = `통합 검색을 완료하지 못했습니다: ${String(error?.message || error)}`;
      }
    }
  };

  const playableEpisodeNumber = api.playableEpisodeNumber;
  function providerReportedQuality(response) {
    // Some providers publish a quality label with their detail/episode data.
    // This is advertised metadata, not a decoded or verified video resolution.
    const candidates = [response?.data?.quality, response?.data?.resolution,
      ...(Array.isArray(response?.episodes) ? response.episodes.slice(0, 40).flatMap(ep => [
        ep?.quality, ep?.resolution, ...(Array.isArray(ep?.qualities) ? ep.qualities : [])
      ]) : [])];
    const heights = candidates.flatMap(value => {
      const match = typeof value === 'string' ? value.match(/\b(240|360|480|540|720|1080|1440|2160|4320)p\b/i) : null;
      const height = match ? Number(match[1]) : null;
      return height ? [height] : [];
    });
    return heights.length ? Math.max(...heights) + 'p' : '';
  }
  // Privacy-safe diagnostics: never include local file paths, work titles,
  // stream URLs, query strings, external IDs or user preferences in export.
  function diagnosticReport(group, anchor, dbCheck = null) {
    if (!integratedMode()) return null;
    const key = anchor?.provider + ':' + sourceKey(anchor);
    const scan = detailSearchDiagnostics.get(key) || [];
    const verified = api.providerConnectionDiagnostics({
      linked: group?.sourceItems || [],
      statuses: scan,
      unverified: detailUnverifiedCandidates.get(key) || [],
      providers
    });
    const rejected = detailRejectionReasons.get(key) || new Map();
    const dbState = sqlite.report();
    return {
      kind: 'DinoPatch-integrated-diagnostic',version: 1,
      generatedAt: new Date().toISOString(), mode: 'integrated',
      suppliers: verified.map(row => ({
        provider: row.provider, reason: row.reason,
        candidates: row.resultCount,
        rejection: rejected.get(row.provider) || null,
        attempts: Number(scan.find(x => x.provider === row.provider)?.attempts) || 0,
        errors: Number(scan.find(x => x.provider === row.provider)?.failures) || 0
      })),
      sqlite: {
        phase: dbState.phase || 'unknown',active: !!dbState.active,
        pending: Number(dbState.pending) || 0,
        healthy: dbCheck ? dbCheck.healthy === true : null,
        integrity: dbCheck?.integrity || 'not-checked',
        foreignKeyErrors: Number(dbCheck?.foreignKeyErrors) || 0,
        // Only aggregate counters. Never export user titles or work keys.
        works: Number(dbCheck?.works) || 0,
        sources: Number(dbCheck?.sources) || 0
      },
      episodeRefresh: {
        attempted: episodeAttempted, updated: episodeSucceeded,
        failed: episodeFailed, daily: episodeBudgetCount()
      }
    };
  }
  function downloadDiagnosticReport(report) {
    const json = JSON.stringify(report, null, 2);
    if (typeof Blob === 'undefined' || typeof URL === 'undefined'
      || typeof URL.createObjectURL !== 'function') {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText)
        return navigator.clipboard.writeText(json).then(() => true, () => false);
      return Promise.resolve(false);
    }
    const uri = URL.createObjectURL(new Blob([json],{type:'application/json;charset=utf-8'}));
    try {
      const link = document.createElement('a');
      link.href = uri;
      link.download = 'DinoPatch-integrated-diagnostics.json';
      document.body?.append(link);
      link.click();
      link.remove();
      return Promise.resolve(true);
    }catch {
      return Promise.resolve(false);
    }finally {
      setTimeout(() => URL.revokeObjectURL(uri), 2000);
    }
  }

  function renderSourcePicker(group, activeId, searching = false) {
    if (!integratedMode() || !Array.isArray(group?.sourceItems) || !group.sourceItems.length) return;
    const content = document.querySelector('#detailContent');
    const dialog = document.querySelector('#detailDialog');
    if (!dialog?.open || !content?.querySelector('.detail-actions')) return;
    const oldPicker = content.querySelector('.detail-source-picker');
    const previousScroll = oldPicker?.querySelector('.dino-source-track')?.scrollLeft || 0;
    // Episode counts arrive asynchronously. Preserve an unsaved title draft
    // and keyboard caret when the five-source rail is re-rendered.
    const oldInput = oldPicker?.querySelector('.dino-work-title-input');
    const editingDraft = oldInput ? String(oldInput.value || '') : null;
    const editHadFocus = oldInput && document.activeElement === oldInput;
    const caret = editHadFocus && Number.isInteger(oldInput.selectionStart)
      ? oldInput.selectionStart : null;
    oldPicker?.remove();
    const section = document.createElement('section');
    section.className = 'detail-source-picker dino-integrated-picker';
    section.setAttribute('aria-label', '통합 공급원 선택');
    const header = document.createElement('div');
    header.className = 'dino-source-header';
    const headingCopy = document.createElement('div');
    headingCopy.className = 'dino-source-heading';
    const title = document.createElement('b');
    title.className = 'dino-source-heading-label';
    title.textContent = '재생 공급원';
    const representative = group.sourceItems.map(canonicalTitleFor).find(value => value?.ko);
    const headingName = document.createElement('div');
    headingName.className = 'dino-source-heading-name';
    headingName.textContent = representative?.ko
      || String(group.displayTitle || group.title || group.sourceItems[0].title || '');
    headingCopy.append(title, headingName);
    const headingActions = document.createElement('div');
    headingActions.className = 'dino-source-heading-actions';
    const linkedCount = document.createElement('span');
    linkedCount.className = 'dino-source-linked-count';
    linkedCount.textContent = group.sourceItems.length + '/' + providers.length + '개 연결';
    const editTitle = document.createElement('button');
    editTitle.type = 'button';
    editTitle.className = 'dino-work-title-edit';
    editTitle.textContent = '한국어 제목 수정';
    editTitle.setAttribute('aria-label', '이 작품의 공통 한국어 제목 수정');
    function toggleTitleEditor(initialDraft = null) {
      const old = section.querySelector('.dino-work-title-form');
      if (old) { old.remove(); return; }
      const reference = group.sourceItems.find(item => sourceKey(item) === String(activeId))
        || group.sourceItems[0];
      const form = document.createElement('div');
      form.className = 'dino-work-title-form';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'dino-work-title-input';
      input.value = initialDraft === null
        ? canonicalTitleFor(reference)?.ko || '' : initialDraft;
      input.setAttribute('aria-label', '이 작품의 대표 한국어 제목');
      input.setAttribute('maxlength', '240');
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'dino-work-title-save';
      save.textContent = '저장';
      const saveTitle = () => {
        const value = String(input.value || '').trim();
        if (!/[가-힣]/.test(value)) {
          window.toast?.('한국어가 포함된 제목을 입력해 주세요.');
          return;
        }
        if (!workIndex.rememberTitles(reference, { ko: value }, { source: 'manual' })
          && canonicalTitleFor(reference)?.ko !== value) return;
        if (!workIndex.flush()) {
          window.toast?.('제목을 로컬 캐시에 저장하지 못했습니다. 저장 공간을 확인해 주세요.');
          return;
        }
        // Commit the edit immediately; a queued debounce can be lost on exit.
        if (sqlite.isReady()) sqlite.flush().then(ok => {
          if (!ok) window.toast?.('SQLite 제목 저장 실패 · 로컬 기록은 유지됩니다.');
        }).catch(() => window.toast?.('SQLite 제목 저장 오류 · 로컬 기록은 유지됩니다.'));
        form.remove();
        renderSourcePicker(group, activeId, searching);
      };
      save.addEventListener('click', saveTitle);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault?.(); saveTitle(); }
        else if (event.key === 'Escape') { event.preventDefault?.(); form.remove(); }
      });
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'dino-work-title-reset';
      reset.textContent = '자동 제목 사용';
      reset.addEventListener('click', () => {
        if (!workIndex.resetManualKoreanTitle(reference)) return;
        if (!workIndex.flush()) {
          window.toast?.('자동 제목 전환을 로컬 캐시에 저장하지 못했습니다.');
          return;
        }
        if (sqlite.isReady()) sqlite.flush().then(ok => {
          if (!ok) window.toast?.('SQLite 자동 제목 전환 저장 실패 · 로컬 기록은 유지됩니다.');
        }).catch(() => window.toast?.('SQLite 자동 제목 전환 저장 오류'));
        form.remove();
        renderSourcePicker(group, activeId, searching);
      });
      form.append(input, save, reset);
      if(sqlite.isReady()){
        const previous=document.createElement('button');
        previous.type='button';previous.className='dino-work-title-reset';
        previous.textContent='이전 제목';
        previous.addEventListener('click',async()=>{
          const history=await sqlite.diagnostic('titleHistory',reference);
          if(!Array.isArray(history)||!history.length){
            window.toast?.('저장된 제목 변경 이력이 없습니다.');return;
          }
          if(history[0].old_title){
            input.value=history[0].old_title;
            window.toast?.('이전 제목을 불러왔습니다. 저장을 누르면 적용됩니다.');
          }
        });
        form.append(previous);
      }
      choices.before(form);
      return input;
    }
    editTitle.addEventListener('click', () => {
      const input = toggleTitleEditor();
      input?.focus?.();
    });
    const editLinks = document.createElement('button');
    editLinks.type = 'button';
    editLinks.className = 'dino-work-title-edit dino-link-repair-toggle';
    editLinks.textContent = '공급원 연결 수정';
    editLinks.hidden = !sqlite.isReady();
    editLinks.addEventListener('click', () => {
      const existing = section.querySelector('.dino-link-repair');
      if (existing) { existing.remove(); return; }
      const reference=group.sourceItems.find(item=>sourceKey(item)===String(activeId))
        ||group.sourceItems[0];
      const panel=document.createElement('div');
      panel.className='dino-link-repair';
      const explanation=document.createElement('p');
      explanation.textContent='잘못 묶인 공급원은 분리하고, 이미 작품 DB에 저장된 공급원 ID는 직접 연결할 수 있습니다. 다른 시즌·극장판 등 충돌하는 ID는 연결을 차단합니다.';
      panel.append(explanation);
      async function submitRepair(method,item){
        const verb=method==='detach'?'분리':'연결';
        let summary=(labels[item.provider]||item.provider)+' ('+sourceKey(item)+') 공급원을 '+verb+'할까요?';
        if(method==='attach'){
          const preview=await sqlite.diagnostic('preview',{anchor:reference,source:item});
          if(!preview?.ok){window.toast?.('연결 대상 확인 실패: '+String(preview?.reason||'저장된 공급원이 없습니다.'));return;}
          if(!preview.compatible){window.toast?.('연도·형식·외부 ID가 다른 공급원이라 연결하지 않았습니다.');return;}
          if(preview.sameWork){window.toast?.('이미 연결된 공급원입니다.');return;}
          summary+='\n연결 대상: '+preview.target.title+'\n이동할 작품: '+preview.candidate.title
            +'\n메타데이터: '+(preview.candidate.year||'연도 미상')+' / '+(preview.candidate.type||'형식 미상');
        }
        if(typeof window.confirm==='function'&&!window.confirm(summary))return;
        editLinks.disabled=true;
        try{
          const result=await sqlite.repair(method,reference,item);
          if(!result?.ok){
            window.toast?.('연결 수정 실패: '+String(result?.reason||'알 수 없는 오류'));
            return;
          }
          window.toast?.('공급원 '+verb+' 정보를 저장했습니다. 목록을 다시 불러옵니다.');
          window.location.reload();
        }finally{editLinks.disabled=false;}
      }
      if(group.sourceItems.length>1){
        const label=document.createElement('b');
        label.textContent='현재 연결된 공급원';
        panel.append(label);
        for(const item of group.sourceItems){
          const line=document.createElement('div');
          line.className='dino-link-repair-row';
          const name=document.createElement('span');
          name.textContent=(labels[item.provider]||item.provider)+' · ID '+sourceKey(item);
          line.append(name);
          if(sourceKey(item)!==sourceKey(reference)||item.provider!==reference.provider){
            const detach=document.createElement('button');
            detach.type='button';
            detach.textContent='이 작품에서 분리';
            detach.addEventListener('click',()=>submitRepair('detach',item).catch(error=>
              window.toast?.('연결 수정 실패: '+String(error?.message||error))));
            line.append(detach);
          }
          panel.append(line);
        }
      }
      const label=document.createElement('b');
      label.textContent='다른 작품에 저장된 공급원 연결';
      const row=document.createElement('div');
      row.className='dino-link-repair-row';
      const select=document.createElement('select');
      select.setAttribute('aria-label','연결할 공급원');
      for(const provider of providers){
        const option=document.createElement('option');
        option.value=provider;
        option.textContent=labels[provider]||provider;
        select.append(option);
      }
      const input=document.createElement('input');
      input.type='text';
      input.maxLength=300;
      input.placeholder='검색 결과 공급원 ID (mal_id)';
      input.setAttribute('aria-label','연결할 공급원 ID');
      const attach=document.createElement('button');
      attach.type='button';
      attach.textContent='선택한 작품에 연결';
      attach.addEventListener('click',()=>{
        const id=String(input.value||'').trim();
        if(!id){window.toast?.('공급원 ID를 입력해 주세요.');return;}
        submitRepair('attach',{provider:select.value,mal_id:id}).catch(error=>
          window.toast?.('연결 수정 실패: '+String(error?.message||error)));
      });
      row.append(select,input,attach);
      panel.append(label,row);
      const note=document.createElement('small');
      note.textContent='대상 작품을 먼저 공급원 검색으로 DB에 등록해야 합니다. 재생 공급원 탭이 아닌 검색 결과의 원본 ID를 사용하세요.';
      panel.append(note);
      const searchRow=document.createElement('div');
      searchRow.className='dino-link-repair-row';
      const searchInput=document.createElement('input');
      searchInput.type='search';searchInput.placeholder='DB에 저장된 작품 검색';
      searchInput.setAttribute('aria-label','연결 후보 작품 검색');
      const searchButton=document.createElement('button');
      searchButton.type='button';searchButton.textContent='DB 검색';
      const results=document.createElement('div');
      results.className='dino-link-search-results';
      searchButton.addEventListener('click',async()=>{
        const query=String(searchInput.value||'').trim();
        if(query.length<2){window.toast?.('2자 이상 입력해 주세요.');return;}
        searchButton.disabled=true;
        try{
          const works=await sqlite.diagnostic('search',{query,limit:10});
          results.replaceChildren();
          for(const found of Array.isArray(works)?works:[])
            for(const candidate of found.sources||[]){
              if(candidate.provider===reference.provider)continue;
              const button=document.createElement('button');
              button.type='button';button.className='dino-link-result';
              button.textContent=(found.titles?.ko||found.titles?.en||found.names?.[0]||'작품')
                +' · '+(labels[candidate.provider]||candidate.provider)+' · '+sourceKey(candidate);
              button.addEventListener('click',()=>{
                select.value=candidate.provider;input.value=sourceKey(candidate);
                window.toast?.('연결 대상을 선택했습니다. 연결 버튼에서 확인해 주세요.');
              });
              results.append(button);
            }
          if(!results.children.length){
            const noResult=document.createElement('small');
            noResult.textContent='저장된 후보 작품이 없습니다.';
            results.append(noResult);
          }
        }catch(error){window.toast?.('DB 검색 실패: '+String(error?.message||error));}
        finally{searchButton.disabled=false;}
      });
      searchRow.append(searchInput,searchButton);
      panel.append(searchRow,results);
      const history=document.createElement('button');
      history.type='button';history.textContent='최근 연결 변경 내역';
      history.addEventListener('click',async()=>{
        const rows=await sqlite.diagnostic('linkHistory');
        const details=document.createElement('small');
        details.textContent=Array.isArray(rows)&&rows.length
          ?rows.slice(0,5).map(x=>x.action+' · '+x.source_provider+' / '+x.source_id).join(' | ')
          :'연결 변경 기록이 없습니다.';
        panel.append(details);history.disabled=true;
      });
      panel.append(history);
      choices.before(panel);
    });
    const showDashboard=document.createElement('button');
    showDashboard.type='button';showDashboard.className='dino-work-title-edit';
    showDashboard.textContent='공급원·DB 상태';
    showDashboard.addEventListener('click',async()=>{
      const old=section.querySelector('.dino-diagnostics-panel');
      if(old){old.remove();return;}
      const panel=document.createElement('div');panel.className='dino-diagnostics-panel';
      const [stats,dbCheck]=await Promise.all([sqlite.stats(),sqlite.diagnostic('diagnostics')]);
      const list=Array.isArray(stats?.sources)?stats.sources:[];
      const counts=providers.map(p=>(labels[p]||p)+': '+
        (list.find(x=>x.provider===p)?.count||0)).join(' · ');
      const info=document.createElement('p');
      const dbState=sqlite.report();
      const dbHealthy=sqlite.isReady() && dbCheck?.healthy===true;
      info.textContent=dbHealthy
        ? 'DB 작품 '+(stats?.works??'확인 불가')+'개 · '+counts+' · 무결성: 정상'
        : 'SQLite 상태 확인 필요 · 기존 로컬 기록 사용';
      const recovery=document.createElement('p');
      recovery.className='dino-sqlite-recovery-notice';
      recovery.setAttribute('role','status');
      recovery.textContent=dbHealthy
        ? 'DB가 정상입니다. 안전 백업을 만든 뒤 변경 기록을 관리할 수 있습니다.'
        : 'SQLite 연결 또는 무결성 검사에 문제가 있습니다. 기존 DB·백업은 삭제하거나 덮어쓰지 마세요. '
          +'자동 원본 복원은 하지 않습니다. 진단 JSON을 보관하고 DB 및 WAL/SHM 파일을 함께 복사한 뒤 '
          +'검증된 별도 백업으로만 수동 복구하세요.'
          +(dbState?.phase ? ' · 현재 상태: '+dbState.phase : '');
      const refresh=document.createElement('button');
      refresh.type='button';refresh.textContent='방영작 회차 새로 확인';
      refresh.addEventListener('click',()=>{
        const count=episodeSchedulerControl.refresh(group.sourceItems);
        window.toast?.('회차 확인 대기: '+count+'개 (일일 요청 제한 적용)');
      });
      const pause=document.createElement('button');
      pause.type='button';pause.textContent=episodePaused?'자동 갱신 재개':'자동 갱신 일시 중지';
      pause.addEventListener('click',()=>{
        if(episodePaused)episodeSchedulerControl.resume();
        else episodeSchedulerControl.pause();
        pause.textContent=episodePaused?'자동 갱신 재개':'자동 갱신 일시 중지';
      });
      const backup=document.createElement('button');
      backup.type='button';backup.className='dino-diagnostics-backup';
      backup.textContent=sqlite.isReady()?'SQLite 안전 백업':'SQLite 사용 불가';
      backup.disabled=!sqlite.isReady();
      backup.addEventListener('click',async()=>{
        if(!integratedMode()||backup.disabled)return;
        backup.disabled=true;backup.textContent='DB 백업 및 검증 중...';
        const result=await sqlite.backup();
        backup.textContent=result?.ok?'DB 백업 완료':'DB 백업 실패 · 다시 시도';
        window.toast?.(result?.ok
          ?'백업 생성 완료: '+result.filename+' (원본 DB 보존)'
          :'백업 실패: '+String(result?.reason||'확인 필요'));
        backup.disabled=false;
      });
      const exportLog=document.createElement('button');
      exportLog.type='button';exportLog.className='dino-diagnostics-export';
      exportLog.textContent='진단 JSON 저장';
      exportLog.addEventListener('click',async()=>{
        if(!integratedMode())return;
        const reference=group.sourceItems.find(item=>sourceKey(item)===String(activeId))||group.sourceItems[0];
        const currentCheck=await sqlite.diagnostic('diagnostics');
        const ok=await downloadDiagnosticReport(diagnosticReport(group,reference,currentCheck));
        window.toast?.(ok?'민감한 작품 이름을 제외한 진단 보고서를 저장했습니다.'
          :'진단 보고서를 저장하지 못했습니다.');
      });
      panel.append(info,recovery,refresh,pause,backup,exportLog);
      choices.before(panel);
    });
    headingActions.append(linkedCount, editTitle, editLinks, showDashboard);
    header.append(headingCopy, headingActions);
    const choices = document.createElement('div');
    choices.className = 'dino-source-track';
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', '재생 공급원 선택');
    const latestAvailable = Math.max(0, ...group.sourceItems.map(item =>
      (detailFacts.get(sourceKey(item))?.latest || workIndex.episodeState(item)?.latest || 0)));
    for (const item of group.sourceItems) {
      const id = sourceKey(item);
      const info = detailFacts.get(id) || (() => {
        const saved = workIndex.episodeState(item);
        return saved?.checkedAt ? {
          episodes:saved.count,latest:saved.latest,checkedAt:saved.checkedAt,
          newEpisodes:saved.newEpisodes,noEpisodes:saved.state==='empty'
        } : null;
      })();
      const quality = verifiedVideoQuality.get(id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dino-source-option';
      button.dataset.providerSource = id;
      button.setAttribute('aria-pressed', String(id === String(activeId)));
      // The search catalog's episode count is only an estimate. Use only the
      // actual fetched episode list, and only measured video resolutions.
      const count = info?.unavailable ? '재생 불가'
        : info?.error ? '회차 확인 실패'
        : info?.noEpisodes ? '회차 없음'
        : Number.isInteger(info?.episodes) ? String(info.episodes) + '화' : '회차 확인 중';
      const latest = info?.latest || 0;
      const comparison = latest && latestAvailable
        ? latest < latestAvailable ? ' · ' + (latestAvailable - latest) + '화 차이' : ' · 최신화'
        : '';
      const update = info?.newEpisodes > 0 ? ' · 새 회차 +' + info.newEpisodes : '';
      const resolution = quality ? '재생 ' + quality : info?.reportedQuality
        ? '표기 ' + info.reportedQuality : '화질 미확인';
      const availability = info?.unavailable ? 'unavailable'
        : info?.error ? 'error' : info?.noEpisodes ? 'empty'
        : Number.isInteger(info?.episodes) ? 'ready' : 'checking';
      button.dataset.availability = availability;
      button.dataset.quality = quality ? 'measured' : info?.reportedQuality ? 'reported' : 'unknown';
      button.dataset.latest = latest && latestAvailable && latest === latestAvailable ? 'true' : 'false';
      button.dataset.newEpisodes = String(info?.newEpisodes || 0);
      const displayName = labels[item.provider] || item.provider;
      // One compact two-line tab; the track itself stays on a single
      // horizontal row even when five providers are available.
      button.textContent = displayName + '\n' + count + comparison + update + ' · ' + resolution;
      button.title = displayName + ' · ' + count + comparison + update + ' · ' + resolution;
      button.setAttribute('aria-label', button.title + (id === String(activeId) ? ' · 선택됨' : ''));
      button.addEventListener('click', () => window.openDetail(id, { sourceSelection: true }));
      choices.append(button);
    }
    section.append(header, choices);
    if (editingDraft !== null) {
      const input = toggleTitleEditor(editingDraft);
      if (input && editHadFocus) {
        input.focus?.();
        if (caret !== null) input.setSelectionRange?.(caret, caret);
      }
    }
    const helper = document.createElement('small');
    helper.className = 'dino-source-hint';
    helper.textContent = '회차는 공급원 목록 기준 · 방영 중인 작품만 제한적으로 자동 확인 · 화질은 확인된 정보만 표시';
    section.append(helper);
    if (group.sourceItems.length === 1) {
      const note = document.createElement('small');
      note.className = 'source-search-note';
      note.textContent = searching ? '다른 공급원에서 같은 작품을 확인하는 중...'
        : '다른 공급원 연결은 아직 확인되지 않았습니다. 검색 성공과 작품 일치 확인은 다릅니다.';
      section.append(note);
    }
    if (!searching && group.sourceItems.length < providers.length) {
      const reference = group.sourceItems.find(item => sourceKey(item) === String(activeId)) || group.sourceItems[0];
      const scanKey = reference.provider + ':' + sourceKey(reference);
      const scan = detailSearchDiagnostics.get(scanKey) || [];
      const potential = detailUnverifiedCandidates.get(scanKey) || [];
      const rejected = detailRejectionReasons.get(scanKey) || new Map();
      const reasons = {
        linked: '연결 완료',
        'needs-identity-check': '작품 확인 필요',
        'not-found': '검색 결과 없음',
        'unrelated-results': '다른 작품만 검색됨',
        'page-limited': '검색 페이지 제한 · 재검사 필요',
        partial: '일부 응답 오류 · 재검사 필요',
        error: '응답 오류',
        'not-checked': '아직 검사하지 않음'
      };
      const conflictLabels = {
        'id-conflict': '외부 작품 ID 다름',
        'season-different': '시즌·파트 다름',
        'year-different': '방영 연도 다름',
        'format-different': 'TV·극장판 등 형식 다름',
        'year-unconfirmed': '방영 연도 확인 불가',
        'identity-unconfirmed': '동일 작품 근거 부족'
      };
      const summary = document.createElement('div');
      summary.className = 'dino-provider-connection-diagnostics';
      summary.setAttribute('aria-label', '공급원별 작품 연결 진단');
      const current = reference;
      const seq = detailSequence;
      for (const item of api.providerConnectionDiagnostics({
        linked: group.sourceItems, statuses: scan, unverified: potential, providers
      })) {
        const entry = document.createElement('div');
        entry.className = 'dino-provider-diagnostic';
        entry.dataset.provider = item.provider;
        entry.dataset.reason = item.reason;
        const title = document.createElement('strong');
        title.textContent = labels[item.provider] || item.provider;
        const status = document.createElement('small');
        status.className = 'source-search-note';
        const rejection = rejected.get(item.provider);
        status.textContent = reasons[item.reason]
          + (rejection && item.reason !== 'linked' ? ' · ' + (conflictLabels[rejection] || rejection) : '');
        entry.append(title, status);
        const scanInfo = scan.find(row => row.provider === item.provider);
        if (scanInfo) {
          const detail = document.createElement('small');
          detail.className = 'dino-provider-diagnostic-meta';
          const queries = Array.isArray(scanInfo.queries) ? scanInfo.queries : [];
          detail.textContent = '검색 ' + (scanInfo.attempts || 0) + '회 · 후보 '
            + (scanInfo.resultCount || 0) + '개'
            + (queries.length ? ' · 검색어: ' + queries.join(', ') : '');
          entry.append(detail);
        }
        if (item.reason !== 'linked') {
          const retryOne = document.createElement('button');
          retryOne.type = 'button';
          retryOne.className = 'dino-provider-retry';
          retryOne.dataset.provider = item.provider;
          retryOne.textContent = '이 공급원 재검색';
          retryOne.setAttribute('aria-label', (labels[item.provider] || item.provider) + '만 다시 검색');
          retryOne.addEventListener('click', async () => {
            if (!integratedMode() || seq !== detailSequence) return;
            retryOne.disabled = true;
            retryOne.textContent = '확인 중...';
            try {
              for (const key of [...catalogRequestCache.keys()])
                if (key.startsWith('["' + item.provider + '",')) catalogRequestCache.delete(key);
              const discovered = await discoverSources(current, group,
                { force: true, onlyProviders: [item.provider] });
              if (!integratedMode() || seq !== detailSequence) return;
              keepDetailGroup(discovered);
              renderSourcePicker(discovered, activeId);
              loadVerifiedEpisodeCounts(discovered, activeId, seq).catch(() => {});
            } catch {
              retryOne.disabled = false;
              retryOne.textContent = '오류 · 다시 시도';
            }
          });
          entry.append(retryOne);
        }
        summary.append(entry);
      }
      section.append(summary);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'dino-source-retry';
      retry.textContent = '다른 공급원 다시 찾기';
      retry.addEventListener('click', async () => {
        const current = group.sourceItems.find(item => sourceKey(item) === String(activeId)) || group.sourceItems[0];
        if (!isDinoProvider(current)) return;
        const seq = detailSequence;
        // Manual retry must clear both foreground and bounded-background
        // promises; otherwise the cached result could hide the new scan.
        detailDiscoveryCache.delete(current.provider + ':' + sourceKey(current) + ':foreground');
        detailDiscoveryCache.delete(current.provider + ':' + sourceKey(current) + ':background');
        catalogRequestCache.clear();
        workIndex.invalidate(current);
        retry.disabled = true;
        retry.textContent = '다른 공급원 다시 확인 중...';
        try {
          const discovered = await discoverSources(current, group, { force: true });
          if (seq !== detailSequence || !integratedMode()) return;
          keepDetailGroup(discovered);
          renderSourcePicker(discovered, activeId);
          loadVerifiedEpisodeCounts(discovered, activeId, seq).catch(() => {});
        } catch {
          if (seq !== detailSequence) return;
          retry.disabled = false;
          retry.textContent = '확인 실패 · 다시 시도';
        }
      });
      section.append(retry);
    }
    const anchor = content.querySelector('.detail-meta') || content.querySelector('.detail-actions');
    anchor?.before(section);
    // Each verified count refresh recreates the picker. Keep the user's
    // horizontal position rather than jumping back to the first supplier.
    choices.scrollLeft = previousScroll;
  }

  async function loadVerifiedEpisodeCounts(group, activeId, sequence) {
    if (!Array.isArray(group?.sourceItems)) return;
    const items = group.sourceItems.slice();
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++], id = sourceKey(item);
        const existing = detailFacts.get(id);
        if (existing && (!existing.checkedAt || Date.now() - existing.checkedAt < EPISODE_DETAIL_TTL_MS))
          continue;
        detailFacts.delete(id);
        const saved = workIndex.episodeState(item);
        if (saved?.checkedAt && Date.now() - saved.checkedAt < EPISODE_DETAIL_TTL_MS
          && saved.state !== 'error') {
          detailFacts.set(id, { episodes:saved.count, latest:saved.latest,
            checkedAt:saved.checkedAt, newEpisodes:saved.newEpisodes,
            noEpisodes:saved.state==='empty' });
          continue;
        }
        try {
          const response = await window.lilac.providerDetail(item);
          const metrics = episodeMetrics(response);
          if (metrics) {
            workIndex.rememberEpisode(item,metrics);
            const updated = workIndex.episodeState(item);
            detailFacts.set(id, {
              episodes: metrics.count, latest: metrics.latest,
              checkedAt:Date.now(),newEpisodes:updated?.newEpisodes || 0,
              reportedQuality: providerReportedQuality(response),
              noEpisodes: metrics.count === 0
            });
          } else if (response?.unavailable) {
            workIndex.rememberEpisode(item,null);
            detailFacts.set(id, { unavailable: true });
          } else {
            workIndex.rememberEpisode(item,null);
            detailFacts.set(id, { error: true });
          }
        } catch {
          // An error is not proof that this provider has no episodes.
          workIndex.rememberEpisode(item,null);
          detailFacts.set(id, { error: true });
        }
        if (sequence === detailSequence) renderSourcePicker(group, activeId);
      }
    }));
    if (detailFacts.size > 500) detailFacts.delete(detailFacts.keys().next().value);
  }

  window.openDetail = async function (id, options = {}) {
    const isIntegrated = integratedMode();
    const inIntegratedSearch = isIntegrated && document.querySelector('#searchView')?.classList.contains('active');
    const initialGroup = isIntegrated ? (detailGroupsBySourceId.get(String(id))
      || (inIntegratedSearch ? groupBySourceId.get(String(id)) : null)) : null;
    const anchor = initialKnownSource(id, initialGroup);
    const stored = isIntegrated && isDinoProvider(anchor) ? await sqlite.ensure(anchor) : null;
    const reference = stored ? { ...anchor, synonyms: [
      ...(Array.isArray(anchor.synonyms) ? anchor.synonyms : []), ...stored.names
    ] } : anchor;
    const group = stored?.sources?.length
      ? verifiedGroupFor(reference, [...(initialGroup?.sourceItems || []), ...stored.sources])
      : initialGroup;
    const sequence = ++detailSequence;
    const selected = group ? api.chooseSource(group, {
      provider: inIntegratedSearch ? currentFilter : 'all',
      preferredProvider: selectedProvider(),
      sourceId: (options?.sourceSelection || !inIntegratedSearch || currentFilter === 'all') ? id : ''
    }) : null;
    const selectedId = String(selected?.mal_id ?? id);
    const known = initialKnownSource(selectedId, group) || anchor;
    const result = await officialOpenDetail.call(this, selectedId);
    if (sequence !== detailSequence || !isIntegrated) return result;

    if (group) {
      keepDetailGroup(group);
      renderSourcePicker(group, selectedId);
      loadVerifiedEpisodeCounts(group, selectedId, sequence).catch(() => {});
    }
    // Explicit source switching preserves the already verified group instead
    // of narrowing it again to whatever metadata the newly chosen site omits.
    if (options?.sourceSelection && group) return result;
    if (!isDinoProvider(known)) return result;
    if (!group) renderSourcePicker(verifiedGroupFor(known, []), selectedId, true);
    try {
      const discovered = await discoverSources(known, group);
      if (sequence !== detailSequence || !integratedMode()) return result;
      keepDetailGroup(discovered);
      renderSourcePicker(discovered, selectedId);
      loadVerifiedEpisodeCounts(discovered, selectedId, sequence).catch(() => {});
    } catch {
      // Keep the official detail playable even if a remote provider fails.
      if (sequence === detailSequence && !group) {
        const single = verifiedGroupFor(known, []);
        keepDetailGroup(single);
        renderSourcePicker(single, selectedId);
      }
    }
    return result;
  };

  function connectRealPlaybackQuality() {
    const video = document.querySelector('#video');
    if (!video || typeof video.addEventListener !== 'function') return;
    const refresh = () => {
      const height = Number(video.videoHeight), width = Number(video.videoWidth);
      const context = typeof currentPlaybackContext !== 'undefined' ? currentPlaybackContext : null;
      const provider = context?.episode?.provider || context?.anime?.provider;
      if (!providers.includes(provider) || !Number.isFinite(height) || !Number.isFinite(width)
        || height < 144 || width < 200 || height > 4320 || width > 7680) return;
      const workId = String(context?.anime?.mal_id ?? '');
      if (workId) verifiedVideoQuality.set(workId, String(height) + 'p');
      // The official player hides the entire quality section when no
      // selectable variants exist. Show the actual decoded fixed resolution.
      const panel = document.querySelector('#psQuality');
      const list = document.querySelector('#psQualityList');
      if (panel?.classList.contains('hidden') && list) {
        const info = document.createElement('small');
        info.className = 'ps-note dino-fixed-quality';
        info.textContent = '현재 재생 영상 · ' + width + '×' + height + ' (' + height + 'p) · 단일 화질';
        list.replaceChildren(info);
        panel.classList.remove('hidden');
      }
    };
    for (const name of ['loadedmetadata', 'resize', 'playing']) video.addEventListener(name, refresh);
    const originalRender = window.renderQualityChoices;
    if (typeof originalRender === 'function') {
      window.renderQualityChoices = function (...args) {
        const result = originalRender.apply(this, args);
        refresh();
        return result;
      };
    }
  }
  document.addEventListener?.('DOMContentLoaded', connectRealPlaybackQuality, { once: true });

  // Only offer cross-provider fallback after a terminal player error.
  // The user explicitly chooses whether to switch; official HLS recovery
  // and server retries remain in control until they report failure.
  function connectPlaybackFallback() {
    const video = document.querySelector('#video');
    const status = document.querySelector('#downloadStatus');
    if (!video || !status || typeof video.addEventListener !== 'function') return;
    const positions = new Map();
    let offerSequence = 0;
    let switching = false;
    const contextNow = () => typeof currentPlaybackContext !== 'undefined' ? currentPlaybackContext : null;
    const contextKey = context => {
      const episode = context?.episode;
      return episode ? String(context?.anime?.provider || '') + ':' +
        sourceKey(context.anime) + ':' + String(episode.provider || '') + ':' +
        String(episode.url || episode.token || episode.id || episode.number || '') + ':' +
        api.episodeSegment(episode) : '';
    };
    const clearOffer = () => {
      offerSequence++;
      document.querySelector('#dinoPlaybackAlternate')?.remove();
    };
    video.addEventListener('timeupdate', () => {
      const context = contextNow(), key = contextKey(context);
      const seconds = Number(video.currentTime);
      if (!key || !Number.isFinite(seconds) || seconds <= 0) return;
      positions.set(key, seconds);
      if (positions.size > 100) positions.delete(positions.keys().next().value);
    });
    video.addEventListener('playing', clearOffer);
    async function offerAlternative() {
      if (!integratedMode() || switching) return;
      const context = contextNow(), anime = context?.anime, episode = context?.episode;
      if (!isDinoProvider(anime) || !episode || !playableEpisodeNumber(episode)) return;
      const originKey = contextKey(context), sequence = ++offerSequence;
      let group = detailGroupsBySourceId.get(sourceKey(anime));
      if (!group) {
        try { group = await discoverSources(anime, null); keepDetailGroup(group); }
        catch { return; }
      }
      if (sequence !== offerSequence || contextKey(contextNow()) !== originKey
        || !group?.sourceItems?.some(item => item.provider !== episode.provider
          && api.identityMatch(anime,item))) return;
      const prior = document.querySelector('#dinoPlaybackAlternate');
      prior?.remove();
      const button = document.createElement('button');
      button.id = 'dinoPlaybackAlternate';
      button.className = 'dino-playback-alternate';
      button.type = 'button';
      button.textContent = '다른 공급원에서 이 회차 재생';
      button.title = '같은 작품과 화수를 확인한 다른 공급원으로 전환합니다';
      button.addEventListener('click', async () => {
        if (switching || !integratedMode() || contextKey(contextNow()) !== originKey) return;
        switching = true;
        button.disabled = true;
        button.textContent = '동일 회차 확인 중...';
        try {
          const reference = contextNow(), number = playableEpisodeNumber(reference.episode);
          if (!number) return;
          for (const item of group.sourceItems) {
            if (item.provider === reference.episode.provider
              || !api.identityMatch(reference.anime,item)) continue;
            let response;
            try { response = await window.lilac.providerDetail(item); }
            catch { continue; }
            const detailed = response?.data;
            if (detailed && (detailed.provider !== item.provider
              || sourceKey(detailed) !== sourceKey(item)
              || !api.identityMatch(reference.anime, detailed))) continue;
            const candidate = api.uniqueSameEpisode(response?.episodes, reference.episode, item.provider);
            if (!candidate || sequence !== offerSequence || contextKey(contextNow()) !== originKey) continue;
            if (typeof resolveIntoPlayer !== 'function') {
              window.toast?.('재생 전환 기능을 사용할 수 없습니다.');
              return;
            }
            const rawSeconds = Number(video.currentTime) > 0
              ? Number(video.currentTime)
              : (positions.get(originKey) || Number(reference.resumeSeconds) || 0);
            const seconds = Math.max(0,Math.min(24*60*60,
              Number.isFinite(rawSeconds)?rawSeconds:0));
            const duration = Number(video.duration);
            const progress = Number.isFinite(duration) && duration > 0 ? Math.min(94, seconds / duration * 100) : 0;
            const nextAnime = { ...item, ...(detailed || {}), provider: item.provider, mal_id: sourceKey(item) };
            const nextEpisode = candidate;
            // Pre-resolve without disturbing the old playback context.
            let prepared;
            try { prepared = await window.lilac.providerResolve(nextEpisode); }
            catch { continue; }
            if (typeof prepared?.url !== 'string' || !prepared.url
              || sequence !== offerSequence || contextKey(contextNow()) !== originKey) continue;
            const name = String(reference.subtitleTitle || nextAnime.title || item.title || '');
            const { currentUrl, offline, videoServers, videoServer, streamHeaders, resolving, ...rest } = reference;
            await resolveIntoPlayer(
              () => Promise.resolve(prepared),
              name + ' · ' + number + '화',
              { ...rest, episode: nextEpisode, anime: nextAnime, seriesEpisodes: response.episodes,
                resolveKind: 'provider', resumeSeconds: seconds, resumeProgress: progress,
                subtitleTitle: name, comparisonEpisodes: [] },
              name, number
            );
            clearOffer();
            return;
          }
          window.toast?.('다른 공급원에서 동일한 회차를 확인하지 못했습니다.');
          button.textContent = '동일 회차 없음 · 다시 확인';
        } catch(error) {
          // Keep the original playback context available for another attempt.
          button.textContent='전환 실패 · 다시 시도';
          window.toast?.('공급원 전환 실패: '+String(error?.message||error).slice(0,150));
        } finally {
          switching = false;
          button.disabled = false;
        }
      });
      status.insertAdjacentElement('afterend', button);
    }
    video.addEventListener('error', () => {
      // Removing a source while loading a new episode can emit a transient
      // native error. Do not suggest switching during that normal transition.
      const context = contextNow();
      const errorText = String(status.textContent || '');
      if (context?.resolving && !/오류|실패|불러오지 못했/.test(errorText)) return;
      offerAlternative().catch(() => {});
    });
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(() => {
        const text = String(status.textContent || '');
        const emptyText = String(document.querySelector('#playerEmpty p')?.textContent || '');
        if (/^HLS 오류[:：]|^재생 실패[:：]/.test(text)
          || emptyText === '영상을 불러오지 못했어요') offerAlternative().catch(() => {});
      });
      observer.observe(status, { childList: true, subtree: true, characterData: true });
    }
  }
  document.addEventListener?.('DOMContentLoaded', connectPlaybackFallback, { once: true });



  window.__dinoPatch03Bridge = {
    active: true,
    providers: providers.slice(),
    apiContracts: ['providerCatalog', 'providerDetail', 'providerResolve'],
    getMode: () => integratedMode() ? 'integrated' : 'provider',
    getSelectedProvider: selectedProvider,
    getWorkIndexStats: () => workIndex.stats(),
    getEpisodeRefreshStatus: () => ({ paused:episodePaused,busy:episodeBusy,queued:episodeQueue.length,
      attempted:episodeAttempted,updated:episodeSucceeded,newEpisodes:episodeFoundNew,
      failed:episodeFailed,daily:episodeBudgetCount(),
      sessionLimit:EPISODE_REFRESH_SESSION_LIMIT,dailyLimit:EPISODE_REFRESH_DAILY_LIMIT }),
    getEpisodeState: id => {
      const item = typeof window.animeById === 'function' ? window.animeById(id) : null;
      return workIndex.episodeState(item);
    },
    getSqliteStatus: () => sqlite.report(),
    getSqliteStats: () => sqlite.stats(),
    getDiagnostics: () => sqlite.diagnostic('diagnostics'),
    getLinkHistory: () => sqlite.diagnostic('linkHistory'),
    pauseEpisodeRefresh: () => episodeSchedulerControl.pause(),
    resumeEpisodeRefresh: () => episodeSchedulerControl.resume(),
    getWorkTitles: id => {
      const anime = typeof window.animeById === 'function' ? window.animeById(id) : null;
      return canonicalTitleFor(anime);
    },
    getOriginalCatalogSeedStatus: () => ({
      status: catalogSeedStatus,
      importedThisSession: catalogSeedImported, localPageReads: catalogSeedChecks,
      nextOffset: catalogSeedCheckpoint().offset,
      source: 'reanime', batchSize: CATALOG_SEED_PAGE_SIZE,
      target: sqlite.isReady() ? null : CATALOG_SEED_TARGET,
      storage: sqlite.isReady() ? 'sqlite' : 'legacy-localStorage',
      indexed: workIndex.stats().providers.reanime || 0,
      maxLocalPages: CATALOG_SEED_MAX_LOCAL_PAGES
    }),
    getPrefetchStatus: () => ({
      queued: prefetchQueue.length, running: prefetchBusy,
      startedThisSession: prefetchStarted, failed: prefetchFailed,
      usedToday: dailyPrefetchCount(), dailyLimit: PREFETCH_DAILY_LIMIT
    }),
    flushWorkIndex: () => workIndex.flush(),
    getDiagnosticReport: id => {
      const group = detailGroupsBySourceId.get(String(id));
      const anchor = group?.sourceItems?.find(item=>sourceKey(item)===String(id));
      return anchor ? diagnosticReport(group,anchor) : null;
    },
    getDetailRejectionReasons: id => {
      if (!integratedMode()) return [];
      const group = detailGroupsBySourceId.get(String(id));
      const anchor = group?.sourceItems?.find(item => sourceKey(item) === String(id));
      return anchor ? [...(detailRejectionReasons.get(anchor.provider + ':' + sourceKey(anchor)) || new Map())] : [];
    },
    getDetailConnectionDiagnostics: id => {
      if (!integratedMode()) return [];
      const group = detailGroupsBySourceId.get(String(id));
      if (!group?.sourceItems?.length) return [];
      const anchor = group.sourceItems.find(item => sourceKey(item) === String(id)) || group.sourceItems[0];
      const key = anchor.provider + ':' + sourceKey(anchor);
      return api.providerConnectionDiagnostics({
        linked: group.sourceItems,
        statuses: detailSearchDiagnostics.get(key) || [],
        unverified: detailUnverifiedCandidates.get(key) || [], providers
      });
    },
    getSearchDiagnostics: () => resultStatuses.map(item => ({
      provider: item.provider, state: item.state, results: item.resultCount,
      pages: item.pages || 0, pageLimitReached: !!item.pageLimitReached
    })),
    getSearchSnapshot: () => resultGroups.map(group => ({
      title: String(group.displayTitle || group.title || ''),
      sourceItems: (group.sourceItems || []).map(item => ({ provider: item.provider, sourceId: String(item.mal_id) }))
    })),
    getDetailSnapshot: id => (detailGroupsBySourceId.get(String(id))?.sourceItems || [])
      .map(item => ({ provider: item.provider, sourceId: sourceKey(item) }))
  };
})();
