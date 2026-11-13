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
      if (!isDinoProvider(item) || !api.identityMatch(anchor, item)) continue;
      const key = item.provider + ':' + sourceKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push(item);
    }
    const groups = api.groupResults(accepted, selectedProvider());
    return commonTitleGroup(groups.find(group => group.sourceItems.some(item => item.provider === anchor.provider
      && sourceKey(item) === sourceKey(anchor))) || api.groupResults([anchor], selectedProvider())[0]);
  }
  async function discoverSources(anchor, knownGroup, { background = false } = {}) {
    const identityKey = anchor.provider + ':' + sourceKey(anchor);
    const key = identityKey + (background ? ':background' : ':foreground');
    const cached = detailDiscoveryCache.get(key);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.promise;
    const promise = (async () => {
      const stored = workIndex.find(anchor);
      const seeds = [...(Array.isArray(knownGroup?.sourceItems) ? knownGroup.sourceItems : []),
        ...(stored?.sources || [])];
      // Foreground requests may bypass a background attempt that failed or
      // only checked a limited number of aliases/pages.
      if (stored?.fresh && (background || stored.outcome !== 'error')) {
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
      const toCheck = expiredVerified ? providers.slice()
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
        concurrency: background ? 3 : 5, maxPages: background ? 1 : 2
      };
      const first = await api.searchProviders({ ...options, providers: toCheck, query });
      let diagnostics = first;
      let group = verifiedGroupFor(reference, [...seeds, ...first.items]);
      // A successful nonempty catalog response can contain unrelated anime.
      // Only an identity match proves that the requested work was found.
      const matched = new Set(group.sourceItems.map(item => item.provider));
      const missing = toCheck.filter(provider => !matched.has(provider));
      if (missing.length && terms.length) {
        const extra = await api.searchProviders({
          ...options, providers: missing, query: '', terms,
          localSearch: async () => null
        });
        group = verifiedGroupFor(reference, [...seeds, ...first.items, ...extra.items]);
        diagnostics = api.mergeSearchResults(first, extra);
      }
      // Mark a mapping fresh only when every attempted supplier answered.
      // Failed or skipped lookups never turn into permanent "not found".
      const complete = (diagnostics.statuses || []).length === toCheck.length
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
      workIndex.remember(group, { checked: complete, attempted: true,
        outcome, names: verifiedAliases });
      detailSearchDiagnostics.set(identityKey, diagnostics.statuses || []);
      if (detailSearchDiagnostics.size > 120) detailSearchDiagnostics.delete(detailSearchDiagnostics.keys().next().value);
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
  const budgetDay = () => Math.floor(Date.now() / 86400000);
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
    return (workIndex.stats().providers.reanime || 0) >= CATALOG_SEED_TARGET;
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
    if (workIndex.stats().works >= CATALOG_SEED_MAX_WORKS) {
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
        && reanimeCount < CATALOG_SEED_TARGET
        && workIndex.stats().works < CATALOG_SEED_MAX_WORKS) {
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
          if (count >= CATALOG_SEED_PAGE_SIZE || reanimeCount >= CATALOG_SEED_TARGET
            || workIndex.stats().works >= CATALOG_SEED_MAX_WORKS) break;
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
      if ((workIndex.stats().providers.reanime || 0) < reanimeCount) {
        catalogSeedStatus = 'db-capacity-reserved';
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
        : workIndex.stats().works >= CATALOG_SEED_MAX_WORKS
          ? 'db-capacity-reserved' : 'imported';
      continueLater = !reachedEnd && !catalogSeedReachedTarget()
        && workIndex.stats().works < CATALOG_SEED_MAX_WORKS;
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
    if (workIndex.stats().works >= CATALOG_SEED_MAX_WORKS) {
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
        const nativeTitles = reference?.sourceItems?.flatMap(item => [item.title, item.title_english, item.title_japanese, item.romaji]) || [];
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

  const playableEpisodeNumber = episode => {
    if (!episode || episode.special || episode.playable === false) return null;
    const numeric = Number(episode.number);
    if (Number.isInteger(numeric) && numeric > 0 && numeric < 10000) return numeric;
    const match = String(episode.name || '').match(/^(?:제?\s*)?(\d{1,4})(?:화|\s*$)/);
    return match ? Number(match[1]) : null;
  };
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
    section.className = 'detail-source-picker';
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
        workIndex.flush();
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
        workIndex.resetManualKoreanTitle(reference);
        workIndex.flush();
        renderSourcePicker(group, activeId, searching);
      });
      form.append(input, save, reset);
      choices.before(form);
      return input;
    }
    editTitle.addEventListener('click', () => {
      const input = toggleTitleEditor();
      input?.focus?.();
    });
    headingActions.append(linkedCount, editTitle);
    header.append(headingCopy, headingActions);
    const choices = document.createElement('div');
    choices.className = 'dino-source-track';
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', '재생 공급원 선택');
    const latestAvailable = Math.max(0, ...group.sourceItems.map(item => detailFacts.get(sourceKey(item))?.latest || 0));
    for (const item of group.sourceItems) {
      const id = sourceKey(item);
      const info = detailFacts.get(id);
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
      const resolution = quality ? '재생 ' + quality : info?.reportedQuality
        ? '표기 ' + info.reportedQuality : '화질 미확인';
      const availability = info?.unavailable ? 'unavailable'
        : info?.error ? 'error' : info?.noEpisodes ? 'empty'
        : Number.isInteger(info?.episodes) ? 'ready' : 'checking';
      button.dataset.availability = availability;
      button.dataset.quality = quality ? 'measured' : info?.reportedQuality ? 'reported' : 'unknown';
      button.dataset.latest = latest && latestAvailable && latest === latestAvailable ? 'true' : 'false';
      const displayName = labels[item.provider] || item.provider;
      // One compact two-line tab; the track itself stays on a single
      // horizontal row even when five providers are available.
      button.textContent = displayName + '\n' + count + comparison + ' · ' + resolution;
      button.title = displayName + ' · ' + count + comparison + ' · ' + resolution;
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
    helper.textContent = '회차는 공급원 목록 기준 · 화질은 확인된 정보만 표시';
    section.append(helper);
    if (group.sourceItems.length === 1) {
      const note = document.createElement('small');
      note.className = 'source-search-note';
      note.textContent = searching ? '다른 공급원에서 같은 작품을 확인하는 중...' : '다른 공급원에서 같은 작품을 확인하지 못했습니다. 다른 시즌은 자동으로 합치지 않습니다.';
      section.append(note);
    }
    if (!searching && group.sourceItems.length < providers.length) {
      const reference = group.sourceItems.find(item => sourceKey(item) === String(activeId)) || group.sourceItems[0];
      const scan = detailSearchDiagnostics.get(reference.provider + ':' + sourceKey(reference)) || [];
      const missing = scan.filter(item => item.state === 'ready' && item.resultCount === 0);
      const failed = scan.filter(item => item.state === 'failed' || item.state === 'partial');
      if (missing.length || failed.length) {
        const diagnostic = document.createElement('small');
        diagnostic.className = 'source-search-note';
        diagnostic.textContent = [
          missing.length ? '미발견: ' + missing.map(item => labels[item.provider] || item.provider).join(', ') : '',
          failed.length ? '응답 오류: ' + failed.map(item => labels[item.provider] || item.provider).join(', ') : ''
        ].filter(Boolean).join(' · ');
        section.append(diagnostic);
      }
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
          const discovered = await discoverSources(current, group);
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
        if (detailFacts.has(id)) continue;
        try {
          const response = await window.lilac.providerDetail(item);
          if (Array.isArray(response?.episodes)) {
            const playable = response.episodes.filter(ep => ep?.playable !== false);
            detailFacts.set(id, {
              episodes: playable.length,
              latest: Math.max(0, ...playable.map(playableEpisodeNumber).filter(Boolean)),
              reportedQuality: providerReportedQuality(response),
              noEpisodes: response.episodes.length === 0,
              unavailable: Boolean(response?.unavailable)
            });
          } else if (response?.unavailable) {
            detailFacts.set(id, { unavailable: true });
          }
        } catch {
          // An error is not proof that this provider has no episodes.
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
    const stored = isIntegrated && isDinoProvider(anchor) ? workIndex.find(anchor) : null;
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
      return episode ? String(episode.provider || '') + ':' +
        String(episode.url || episode.token || episode.id || episode.number || '') : '';
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
        || !group?.sourceItems?.some(item => item.provider !== episode.provider)) return;
      const prior = document.querySelector('#dinoPlaybackAlternate');
      prior?.remove();
      const button = document.createElement('button');
      button.id = 'dinoPlaybackAlternate';
      button.className = 'dino-playback-alternate';
      button.type = 'button';
      button.textContent = '다른 공급원에서 이 회차 재생';
      button.title = '같은 작품과 화수를 확인한 다른 공급원으로 전환합니다';
      button.addEventListener('click', async () => {
        if (switching || contextKey(contextNow()) !== originKey) return;
        switching = true;
        button.disabled = true;
        button.textContent = '동일 회차 확인 중...';
        try {
          const reference = contextNow(), number = playableEpisodeNumber(reference.episode);
          const sameKind = candidate => candidate?.playable !== false && !candidate?.special
            && playableEpisodeNumber(candidate) === number
            && Boolean(candidate.dub) === Boolean(reference.episode.dub);
          for (const item of group.sourceItems) {
            if (item.provider === reference.episode.provider) continue;
            let response;
            try { response = await window.lilac.providerDetail(item); }
            catch { continue; }
            const candidate = Array.isArray(response?.episodes) ? response.episodes.find(sameKind) : null;
            if (!candidate || contextKey(contextNow()) !== originKey) continue;
            if (typeof resolveIntoPlayer !== 'function') {
              window.toast?.('재생 전환 기능을 사용할 수 없습니다.');
              return;
            }
            const seconds = Number(video.currentTime) > 0
              ? Number(video.currentTime)
              : (positions.get(originKey) || Number(reference.resumeSeconds) || 0);
            const duration = Number(video.duration);
            const progress = Number.isFinite(duration) && duration > 0 ? Math.min(94, seconds / duration * 100) : 0;
            const nextAnime = { ...item, ...(response?.data || {}), provider: item.provider, mal_id: sourceKey(item) };
            const nextEpisode = candidate.provider ? candidate : { ...candidate, provider: item.provider };
            const name = String(reference.subtitleTitle || nextAnime.title || item.title || '');
            const { currentUrl, offline, videoServers, videoServer, streamHeaders, resolving, ...rest } = reference;
            clearOffer();
            await resolveIntoPlayer(
              () => window.lilac.providerResolve(nextEpisode),
              name + ' · ' + number + '화',
              { ...rest, episode: nextEpisode, anime: nextAnime, seriesEpisodes: response.episodes,
                resolveKind: 'provider', resumeSeconds: seconds, resumeProgress: progress,
                subtitleTitle: name, comparisonEpisodes: [] },
              name, number
            );
            return;
          }
          window.toast?.('다른 공급원에서 동일한 회차를 확인하지 못했습니다.');
          button.textContent = '동일 회차 없음 · 다시 확인';
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
    getWorkTitles: id => {
      const anime = typeof window.animeById === 'function' ? window.animeById(id) : null;
      return canonicalTitleFor(anime);
    },
    getOriginalCatalogSeedStatus: () => ({
      status: catalogSeedStatus,
      importedThisSession: catalogSeedImported, localPageReads: catalogSeedChecks,
      nextOffset: catalogSeedCheckpoint().offset,
      source: 'reanime', batchSize: CATALOG_SEED_PAGE_SIZE,
      target: CATALOG_SEED_TARGET,
      indexed: workIndex.stats().providers.reanime || 0,
      maxLocalPages: CATALOG_SEED_MAX_LOCAL_PAGES
    }),
    getPrefetchStatus: () => ({
      queued: prefetchQueue.length, running: prefetchBusy,
      startedThisSession: prefetchStarted, failed: prefetchFailed,
      usedToday: dailyPrefetchCount(), dailyLimit: PREFETCH_DAILY_LIMIT
    }),
    flushWorkIndex: () => workIndex.flush(),
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
