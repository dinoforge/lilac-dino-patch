(function (root) {
  const PROVIDERS = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkkf'];

  function stableId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
  }

  function groupResults(results, preferredProvider = '') {
    const unique = [], seen = new Set();
    for (const result of Array.isArray(results) ? results : []) {
      if (!result || !PROVIDERS.includes(result.provider)) continue;
      const sourceId = String(result.mal_id ?? result.id ?? '').trim();
      if (!sourceId) continue;
      const sourceKey = `${result.provider}:${sourceId}`;
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      unique.push({ ...result, mal_id: String(result.mal_id ?? `${result.provider}:${sourceId}`) });
    }

    // A MAL ID can bridge an item with and without an AniList ID only while that
    // bridge points to one AniList work. If it points to multiple works, keep the
    // MAL-only candidate separate instead of guessing which season it belongs to.
    const anilistByMal = new Map();
    for (const item of unique) {
      const malId = stableId(item.malId), anilistId = stableId(item.anilistId);
      if (!malId || !anilistId) continue;
      if (!anilistByMal.has(malId)) anilistByMal.set(malId, new Set());
      anilistByMal.get(malId).add(anilistId);
    }

    const groups = new Map();
    unique.forEach((item, index) => {
      const anilistId = stableId(item.anilistId), malId = stableId(item.malId);
      const linkedAni = malId ? anilistByMal.get(malId) : null;
      const key = anilistId
        ? `anilist:${anilistId}`
        : linkedAni?.size === 1
          ? `anilist:${[...linkedAni][0]}`
          : malId && (!linkedAni || linkedAni.size === 0)
            ? `mal:${malId}`
            : `source:${item.provider}:${String(item.mal_id)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ item, index });
    });

    const providerRank = new Map(PROVIDERS.map((provider, index) => [provider, index]));
    return [...groups].map(([groupKey, entries]) => {
      const sourceItems = entries.map(entry => entry.item);
      sourceItems.sort((a, b) => {
        if (a.provider === preferredProvider && b.provider !== preferredProvider) return -1;
        if (b.provider === preferredProvider && a.provider !== preferredProvider) return 1;
        return (providerRank.get(a.provider) ?? PROVIDERS.length) - (providerRank.get(b.provider) ?? PROVIDERS.length);
      });
      const primary = sourceItems[0];
      return {
        ...primary,
        sourceItems,
        sourceCount: new Set(sourceItems.map(item => item.provider)).size,
        groupKey,
        _resultOrder: Math.min(...entries.map(entry => entry.index))
      };
    }).sort((a, b) => a._resultOrder - b._resultOrder).map(({ _resultOrder, ...group }) => group);
  }

  function catalogIdentity(item) {
    const anilistId = stableId(item?.anilistId ?? item?.anilist_id ?? item?.anilist);
    const malId = stableId(item?.malId ?? item?.myanimelistId ?? item?.myanimelist_id);
    return { anilistId, malId };
  }

  function catalogTitle(item) {
    return String(item?.title || item?.title_english || item?.title_japanese || item?.title_native || item?.romaji || item?.name || '')
      .normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  }

  function catalogFallbackKey(item) {
    const title = catalogTitle(item);
    const year = String(item?.year || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
    const type = String(item?.type || item?.format || '').normalize('NFKC').toLocaleLowerCase().trim();
    const season = String(item?.season || item?.seasonNumber || item?.season_number || item?.cour || '').normalize('NFKC').toLocaleLowerCase().trim();
    return title && year && type ? `title:${title}|year:${year}|type:${type}|season:${season}` : '';
  }

  // The full catalogue uses external AniList/MAL IDs when available. Without IDs,
  // merge only an exact normalized title, year, format, and season match.
  function groupCatalogResults(results, preferredProvider = '') {
    const unique = [], seen = new Set();
    for (const result of Array.isArray(results) ? results : []) {
      if (!result || !PROVIDERS.includes(result.provider)) continue;
      const sourceId = String(result.mal_id ?? result.id ?? '').trim();
      if (!sourceId) continue;
      const sourceKey = `${result.provider}:${sourceId}`;
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      unique.push({ ...result, mal_id: String(result.mal_id ?? `${result.provider}:${sourceId}`) });
    }

    const anilistByMal = new Map();
    for (const item of unique) {
      const { anilistId, malId } = catalogIdentity(item);
      if (!anilistId || !malId) continue;
      if (!anilistByMal.has(malId)) anilistByMal.set(malId, new Set());
      anilistByMal.get(malId).add(anilistId);
    }

    const groups = new Map();
    unique.forEach((item, index) => {
      const { anilistId, malId } = catalogIdentity(item);
      const linkedAni = malId ? anilistByMal.get(malId) : null;
      const identityKey = anilistId
        ? `anilist:${anilistId}`
        : linkedAni?.size === 1
          ? `anilist:${[...linkedAni][0]}`
          : malId && (!linkedAni || linkedAni.size === 0)
            ? `mal:${malId}`
            : '';
      const key = identityKey || catalogFallbackKey(item) || `source:${item.provider}:${String(item.mal_id)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ item, index });
    });

    const providerRank = new Map(PROVIDERS.map((provider, index) => [provider, index]));
    return [...groups].map(([groupKey, entries]) => {
      const sourceItems = entries.map(entry => entry.item);
      sourceItems.sort((a, b) => {
        if (a.provider === preferredProvider && b.provider !== preferredProvider) return -1;
        if (b.provider === preferredProvider && a.provider !== preferredProvider) return 1;
        return (providerRank.get(a.provider) ?? PROVIDERS.length) - (providerRank.get(b.provider) ?? PROVIDERS.length);
      });
      const primary = sourceItems[0];
      return {
        ...primary,
        sourceItems,
        sourceCount: new Set(sourceItems.map(item => item.provider)).size,
        groupKey: `catalog:${groupKey}`,
        _resultOrder: Math.min(...entries.map(entry => entry.index))
      };
    }).sort((a, b) => a._resultOrder - b._resultOrder).map(({ _resultOrder, ...group }) => group);
  }

  function filterGroups(groups, provider = 'all') {
    if (provider === 'all') return Array.isArray(groups) ? groups.slice() : [];
    return (Array.isArray(groups) ? groups : []).filter(group => group.sourceItems?.some(item => item.provider === provider));
  }

  function chooseSource(group, { provider = 'all', preferredProvider = '', sourceId = '' } = {}) {
    const items = Array.isArray(group?.sourceItems) ? group.sourceItems : [];
    if (sourceId) {
      const exact = items.find(item => String(item.mal_id) === String(sourceId));
      if (exact) return exact;
    }
    if (provider !== 'all') {
      const filtered = items.find(item => item.provider === provider);
      if (filtered) return filtered;
    }
    return items.find(item => item.provider === preferredProvider) || items[0] || null;
  }

  async function searchProviders({ providers = PROVIDERS, query = '', terms = [], search, localSearch = async () => null, concurrency = 6 } = {}) {
    if (typeof search !== 'function') throw new TypeError('search must be a function');
    const selectedProviders = [...new Set(providers)].filter(provider => PROVIDERS.includes(provider));
    const seenTerms = new Set(), searchTerms = [];
    for (const value of [...(query ? [query] : []), ...terms]) {
      const term = String(value || '').trim(), key = term.normalize('NFKC').toLocaleLowerCase();
      if (!term || seenTerms.has(key)) continue;
      seenTerms.add(key); searchTerms.push(term);
    }
    const records = new Map(selectedProviders.map(provider => [provider, { items: [], attempts: 0, successes: 0, failures: 0 }]));
    const tasks = [];
    for (const provider of selectedProviders) {
      const record = records.get(provider);
      const localAttempt = Promise.resolve().then(() => localSearch(provider, query)).then(items => {
        if (!Array.isArray(items)) return;
        record.attempts++;
        record.successes++;
        record.items.push(...items.map(item => item?.provider ? item : { ...item, provider }));
      }).catch(() => { record.attempts++; record.failures++; });
      tasks.push({ provider, localAttempt });
      for (const term of searchTerms) {
        if (/[가-힣]/.test(term) && ['animenosub', 'miruro'].includes(provider)) continue;
        record.attempts++;
        tasks.push({ provider, term });
      }
    }

    const work = tasks.filter(task => 'term' in task);
    let next = 0;
    await Promise.all([
      ...tasks.filter(task => task.localAttempt).map(task => task.localAttempt),
      ...Array.from({ length: Math.max(1, Math.min(12, Number(concurrency) || 6, work.length || 1)) }, async () => {
        while (next < work.length) {
          const task = work[next++], record = records.get(task.provider);
          try {
            const result = await search(task.provider, task.term);
            const items = Array.isArray(result) ? result : result?.data;
            record.successes++;
            if (Array.isArray(items)) record.items.push(...items.map(item => item?.provider ? item : { ...item, provider: task.provider }));
          } catch { record.failures++; }
        }
      })
    ]);

    const statuses = selectedProviders.map(provider => {
      const record = records.get(provider);
      const uniqueItems = new Map();
      for (const item of record.items) {
        const id = String(item?.mal_id ?? item?.id ?? '').trim();
        if (id && !uniqueItems.has(id)) uniqueItems.set(id, item);
      }
      return {
        provider,
        state: record.successes === 0 ? record.failures ? 'failed' : 'skipped' : record.failures ? 'partial' : 'ready',
        attempts: record.attempts,
        successes: record.successes,
        failures: record.failures,
        resultCount: uniqueItems.size
      };
    });
    return { items: statuses.flatMap(status => {
      const record = records.get(status.provider), uniqueItems = new Map();
      for (const item of record.items) {
        const id = String(item?.mal_id ?? item?.id ?? '').trim();
        if (id && !uniqueItems.has(id)) uniqueItems.set(id, item);
      }
      return [...uniqueItems.values()];
    }), statuses };
  }

  function mergeSearchResults(...runs) {
    const providers = [...new Set(runs.flatMap(run => (run?.statuses || []).map(status => status.provider)))];
    const records = new Map(providers.map(provider => [provider, { items: new Map(), attempts: 0, successes: 0, failures: 0 }]));
    for (const run of runs) {
      for (const status of run?.statuses || []) {
        const record = records.get(status.provider);
        if (!record) continue;
        record.attempts += Number(status.attempts) || 0;
        record.successes += Number(status.successes) || 0;
        record.failures += Number(status.failures) || 0;
      }
      for (const item of run?.items || []) {
        const record = records.get(item?.provider), id = String(item?.mal_id ?? item?.id ?? '').trim();
        if (record && id && !record.items.has(id)) record.items.set(id, item);
      }
    }
    const statuses = providers.map(provider => {
      const record = records.get(provider);
      return {
        provider,
        state: record.successes === 0 ? record.failures ? 'failed' : 'skipped' : record.failures ? 'partial' : 'ready',
        attempts: record.attempts,
        successes: record.successes,
        failures: record.failures,
        resultCount: record.items.size
      };
    });
    return { items: providers.flatMap(provider => [...records.get(provider).items.values()]), statuses };
  }

  const api = { PROVIDERS, groupResults, groupCatalogResults, filterGroups, chooseSource, searchProviders, mergeSearchResults };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LilacIntegratedSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
