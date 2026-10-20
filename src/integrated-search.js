(function (root) {
  // Linkkf remains an original standalone source; Dino aggregation uses the other five sources.
  const PROVIDERS = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'];

  function stableId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
  }

  const titleKey = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  function aliases(item = {}) {
    const values = [item.title, item.title_english, item.title_japanese, item.title_native, item.title_original,
      item.title_romaji, item.romaji, item.originalTitle, item.original_title];
    const synonyms = item.synonyms;
    if (Array.isArray(synonyms)) values.push(...synonyms);
    else if (typeof synonyms === 'string') values.push(...synonyms.split(/[,|/]/));
    return [...new Set(values.map(titleKey).filter(Boolean))];
  }

  function year(item = {}) {
    const value = item.year || item.season_year || item.seasonYear || item.startDate?.year || item.aired || item.started_on || '';
    const found = String(value).match(/(?:19|20)\d{2}/);
    return found ? Number(found[0]) : null;
  }

  function part(item = {}) {
    const title = [item.title, item.title_english, item.title_japanese, item.title_native, item.title_original,
      item.title_romaji, item.romaji].filter(Boolean).join(' ').normalize('NFKC');
    const value = String(item.season || item.part || item.seasonNumber || '').normalize('NFKC').toLowerCase();
    const titleMarker = title.match(/(?:part|season|cour|시즌|파트|第)\s*[-:]?\s*(\d+)|(\d+)\s*(?:기|期)(?=$|[^\p{L}\p{N}])|\bs(\d{1,2})\b/i);
    if (titleMarker) return `part:${titleMarker[1] || titleMarker[2] || titleMarker[3]}`;
    if (/movie|film|극장판/i.test(`${value} ${title}`)) return 'movie';
    if (/ova|oad/i.test(`${value} ${title}`)) return 'ova';
    if (/special|\bsp\b|스페셜/i.test(`${value} ${title}`)) return 'special';
    const numericSeason = value.match(/^(?:season\s*)?(\d+)$/i);
    return numericSeason ? `part:${numericSeason[1]}` : '';
  }

  function format(item = {}) {
    const value = String(item.type || item.format || item.category || '').toLowerCase();
    if (/movie|film|극장판/.test(value)) return 'movie';
    if (/ova|oad/.test(value)) return 'ova';
    if (/special|\bsp\b|스페셜/.test(value)) return 'special';
    if (/tv|series|anime|ona|tv_short/.test(value)) return 'series';
    return '';
  }

  function externalIdsCompatible(a, b) {
    const aAni = stableId(a?.anilistId ?? a?.anilist_id), bAni = stableId(b?.anilistId ?? b?.anilist_id);
    const aMal = stableId(a?.malId ?? a?.mal_id_external), bMal = stableId(b?.malId ?? b?.mal_id_external);
    return !(aAni && bAni && aAni !== bAni) && !(aMal && bMal && aMal !== bMal);
  }

  function metadataCompatible(a, b, { aliasMatch = false } = {}) {
    const aYear = year(a), bYear = year(b);
    if (aYear != null && bYear != null && aYear !== bYear) return false;
    const aPart = part(a), bPart = part(b);
    if (aPart && bPart && aPart !== bPart) return false;
    if (aliasMatch && (aPart || bPart) && aPart !== bPart) return false;
    const aFormat = format(a), bFormat = format(b);
    if (aFormat && bFormat && aFormat !== bFormat) return false;
    if (aliasMatch && ['movie', 'ova', 'special'].includes(aFormat || bFormat) && aFormat !== bFormat) return false;
    return true;
  }

  function exactAliasMatch(a, b) {
    const aYear = year(a), bYear = year(b);
    if (aYear && bYear && aYear !== bYear) return false;
    const sameExplicitInstallment = Boolean(part(a) && part(a) === part(b)
      && format(a) === 'series' && format(b) === 'series');
    if ((!aYear || !bYear) && !sameExplicitInstallment) return false;
    if (!metadataCompatible(a, b, { aliasMatch: true })) return false;
    const right = new Set(aliases(b));
    return aliases(a).some(alias => right.has(alias));
  }

  function identityMatch(a, b) {
    if (!externalIdsCompatible(a, b) || !metadataCompatible(a, b)) return false;
    const aAni = stableId(a?.anilistId ?? a?.anilist_id), bAni = stableId(b?.anilistId ?? b?.anilist_id);
    const aMal = stableId(a?.malId ?? a?.mal_id_external), bMal = stableId(b?.malId ?? b?.mal_id_external);
    const sameProviderId = a?.provider && a.provider === b?.provider && a.id != null && b.id != null && String(a.id) === String(b.id);
    if (sameProviderId || aAni && bAni && aAni === bAni || aMal && bMal && aMal === bMal) return true;
    return exactAliasMatch(a, b);
  }

  function sharesExternalId(a, b) {
    const aAni = stableId(a?.anilistId ?? a?.anilist_id), bAni = stableId(b?.anilistId ?? b?.anilist_id);
    const aMal = stableId(a?.malId ?? a?.mal_id_external), bMal = stableId(b?.malId ?? b?.mal_id_external);
    return Boolean(aAni && bAni && aAni === bAni || aMal && bMal && aMal === bMal);
  }

  function preferenceKeys(items, groupKey) {
    const keys = [groupKey];
    const anilistIds = new Set(items.map(item => stableId(item.anilistId ?? item.anilist_id)).filter(Boolean));
    const malIds = new Set(items.map(item => stableId(item.malId ?? item.mal_id_external)).filter(Boolean));
    if (anilistIds.size === 1) keys.unshift(`anilist:${[...anilistIds][0]}`);
    if (malIds.size === 1) keys.unshift(`mal:${[...malIds][0]}`);
    return [...new Set(keys.filter(Boolean))];
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

    // Join only unique compatible identities. A shared ID wins. Otherwise require
    // an exact alias and matching years, or a matching explicit season/part on two
    // series when a provider omits its year. Ambiguous matches stay separate.
    const grouped = [];
    unique.forEach((item, index) => {
      const matches = grouped.filter(group => group.items.every(member => externalIdsCompatible(member, item)
        && metadataCompatible(member, item)) && group.items.some(member => (member.provider !== item.provider || sharesExternalId(member, item)) && identityMatch(member, item)));
      if (matches.length === 1) matches[0].items.push(item);
      else grouped.push({ items: [item], firstIndex: index });
    });

    const providerRank = new Map(PROVIDERS.map((provider, index) => [provider, index]));
    return grouped.map(({ items, firstIndex }) => {
      const sourceItems = items.slice();
      sourceItems.sort((a, b) => {
        if (a.provider === preferredProvider && b.provider !== preferredProvider) return -1;
        if (b.provider === preferredProvider && a.provider !== preferredProvider) return 1;
        return (providerRank.get(a.provider) ?? PROVIDERS.length) - (providerRank.get(b.provider) ?? PROVIDERS.length);
      });
      const primary = sourceItems[0];
      const anilistIds = new Set(items.map(item => stableId(item.anilistId ?? item.anilist_id)).filter(Boolean));
      const malIds = new Set(items.map(item => stableId(item.malId ?? item.mal_id_external)).filter(Boolean));
      let groupKey = anilistIds.size === 1 ? `anilist:${[...anilistIds][0]}`
        : malIds.size === 1 ? `mal:${[...malIds][0]}` : '';
      if (!groupKey && items.length > 1) {
        const common = aliases(items[0]).filter(alias => items.slice(1).every(item => aliases(item).includes(alias))).sort()[0];
        const commonYear = year(items[0]);
        if (common && commonYear) groupKey = `title:${commonYear}:${common}`;
      }
      if (!groupKey) groupKey = `source:${primary.provider}:${String(primary.mal_id)}`;
      return {
        ...primary,
        sourceItems,
        sourceCount: new Set(sourceItems.map(item => item.provider)).size,
        groupKey,
        preferenceKeys: preferenceKeys(items, groupKey),
        _resultOrder: firstIndex
      };
    }).sort((a, b) => a._resultOrder - b._resultOrder).map(({ _resultOrder, ...group }) => group);
  }

  function filterGroups(groups, provider = 'all') {
    if (provider === 'all') return Array.isArray(groups) ? groups.slice() : [];
    return (Array.isArray(groups) ? groups : []).filter(group => group.sourceItems?.some(item => item.provider === provider));
  }

  function chooseSource(group, { provider = 'all', preferredProvider = '', sourceId = '', preferredSourceProvider = '' } = {}) {
    const items = Array.isArray(group?.sourceItems) ? group.sourceItems : [];
    if (sourceId) {
      const exact = items.find(item => String(item.mal_id) === String(sourceId));
      if (exact) return exact;
    }
    if (preferredSourceProvider) {
      const preferred = items.find(item => item.provider === preferredSourceProvider);
      if (preferred) return preferred;
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

  const api = { PROVIDERS, groupResults, filterGroups, chooseSource, searchProviders, mergeSearchResults,
    aliases, year, part, format, metadataCompatible, identityMatch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LilacIntegratedSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
