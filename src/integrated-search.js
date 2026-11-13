(function (root) {
  // Linkkf remains an original standalone source; Dino aggregation uses the other five sources.
  const PROVIDERS = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'];
  const OFFICIAL_SOURCES = Object.freeze(['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani', 'linkkf']);
  const SOURCE_MODE_KEY = 'lilacDinoPatch.searchMode';
  const SOURCE_MIGRATION_KEY = 'lilacDinoPatch.contentSourceMigration';
  const LEGACY_INTEGRATED_SOURCE = 'integrated';

  function storageSnapshot(storage) {
    return {
      contentSource: storage.getItem('contentSource'),
      contentSourceProvider: storage.getItem('contentSourceProvider'),
      mode: storage.getItem(SOURCE_MODE_KEY)
    };
  }

  function restoreStorageSnapshot(storage, snapshot) {
    try {
      for (const [key, value] of [
        ['contentSource', snapshot.contentSource],
        ['contentSourceProvider', snapshot.contentSourceProvider],
        [SOURCE_MODE_KEY, snapshot.mode]
      ]) {
        if (value == null) storage.removeItem(key);
        else storage.setItem(key, value);
      }
      return true;
    } catch {
      return false;
    }
  }

  function readSourceMigrationJournal(storage) {
    const raw = storage.getItem(SOURCE_MIGRATION_KEY);
    if (raw == null) return { version: 1, entries: [] };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
    for (const entry of parsed.entries) {
      if (!entry || !['prepared', 'complete', 'rolled-back', 'recovery-required'].includes(entry.status)
        || entry.before?.contentSource !== LEGACY_INTEGRATED_SOURCE
        || !OFFICIAL_SOURCES.includes(entry.before?.contentSourceProvider)
        || !(entry.before?.mode == null || typeof entry.before.mode === 'string')
        || entry.after?.contentSource !== entry.before.contentSourceProvider
        || entry.after?.mode !== LEGACY_INTEGRATED_SOURCE) return null;
    }
    return parsed;
  }

  function finishLegacySourceMigration(storage, journal, entry) {
    const current = storageSnapshot(storage);
    const before = entry.before, after = entry.after;
    const recognizedPartialState = current.contentSourceProvider === before.contentSourceProvider
      && [before.contentSource, after.contentSource].includes(current.contentSource)
      && [before.mode, after.mode].includes(current.mode);
    if (!recognizedPartialState) {
      return { ok: false, mode: 'provider', provider: null, needsRecovery: true, reason: 'legacy-source-migration-state-changed' };
    }

    try {
      storage.setItem('contentSource', after.contentSource);
      storage.setItem(SOURCE_MODE_KEY, after.mode);
      entry.status = 'complete';
      storage.setItem(SOURCE_MIGRATION_KEY, JSON.stringify(journal));
      return { ok: true, mode: 'integrated', provider: after.contentSource, migratedLegacySource: true, migrationBackupKey: SOURCE_MIGRATION_KEY };
    } catch (error) {
      const restored = restoreStorageSnapshot(storage, entry.before);
      entry.status = restored ? 'rolled-back' : 'recovery-required';
      try { storage.setItem(SOURCE_MIGRATION_KEY, JSON.stringify(journal)); } catch { /* preserve the prepared journal for diagnosis */ }
      return {
        ok: false, mode: 'provider', provider: null, needsRecovery: !restored,
        reason: restored ? 'legacy-source-migration-rolled-back' : 'legacy-source-migration-rollback-failed',
        error: String(error?.message || error)
      };
    }
  }

  function readSourceSettings(storage) {
    if (!storage || typeof storage.getItem !== 'function') {
      return { ok: false, mode: 'provider', provider: null, reason: 'storage-unavailable' };
    }
    try {
      const source = storage.getItem('contentSource');
      const mode = storage.getItem(SOURCE_MODE_KEY);
      if (mode != null && mode !== LEGACY_INTEGRATED_SOURCE) {
        return { ok: false, mode: 'provider', provider: null, needsRecovery: true, reason: 'unsupported-dino-source-mode' };
      }
      if (source === LEGACY_INTEGRATED_SOURCE) {
        const previousProvider = storage.getItem('contentSourceProvider');
        if (!OFFICIAL_SOURCES.includes(previousProvider)) {
          return { ok: false, mode: 'provider', provider: null, needsRecovery: true, reason: 'legacy-provider-unavailable' };
        }
        return { ok: true, mode: 'integrated', provider: previousProvider, needsMigration: true };
      }
      if (source != null && source !== '' && !OFFICIAL_SOURCES.includes(source)) {
        return { ok: false, mode: 'provider', provider: null, reason: 'unsupported-official-provider' };
      }
      return {
        ok: true,
        mode: mode === LEGACY_INTEGRATED_SOURCE ? 'integrated' : 'provider',
        provider: source || 'reanime',
        needsMigration: false
      };
    } catch (error) {
      return { ok: false, mode: 'provider', provider: null, reason: 'storage-read-failed', error: String(error?.message || error) };
    }
  }

  function officialSourceForState(settings, savedSource) {
    if (settings?.ok && OFFICIAL_SOURCES.includes(settings.provider)) return settings.provider;
    return OFFICIAL_SOURCES.includes(savedSource) ? savedSource : 'reanime';
  }

  function initializeSourceSettings(storage) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function') {
      return { ok: false, mode: 'provider', provider: null, reason: 'storage-unavailable' };
    }
    try {
      const journal = readSourceMigrationJournal(storage);
      if (!journal) return { ok: false, mode: 'provider', provider: null, needsRecovery: true, reason: 'legacy-migration-journal-invalid' };
      if (journal.entries.some(entry => entry.status === 'recovery-required')) {
        return { ok: false, mode: 'provider', provider: null, needsRecovery: true, reason: 'legacy-migration-recovery-required' };
      }
      const pending = [...journal.entries].reverse().find(entry => entry.status === 'prepared');
      if (pending) return finishLegacySourceMigration(storage, journal, pending);

      const current = readSourceSettings(storage);
      if (!current.ok || !current.needsMigration) return current;
      if (journal.entries.length >= 16) {
        return { ok: false, mode: 'provider', provider: null, needsRecovery: true, reason: 'legacy-migration-history-full' };
      }
      const before = storageSnapshot(storage);
      const entry = {
        status: 'prepared',
        before,
        after: { contentSource: current.provider, mode: LEGACY_INTEGRATED_SOURCE }
      };
      journal.entries.push(entry);
      storage.setItem(SOURCE_MIGRATION_KEY, JSON.stringify(journal));
      return finishLegacySourceMigration(storage, journal, entry);
    } catch (error) {
      return { ok: false, mode: 'provider', provider: null, reason: 'storage-write-failed', error: String(error?.message || error) };
    }
  }

  function saveSourceSelection(storage, selected) {
    if (!OFFICIAL_SOURCES.includes(selected) && selected !== LEGACY_INTEGRATED_SOURCE) {
      return { ok: false, mode: 'provider', provider: null, reason: 'unsupported-source-selection' };
    }
    const initialized = initializeSourceSettings(storage);
    if (!initialized.ok) return initialized;
    const before = storageSnapshot(storage);
    try {
      if (selected === LEGACY_INTEGRATED_SOURCE) {
        storage.setItem(SOURCE_MODE_KEY, LEGACY_INTEGRATED_SOURCE);
      } else {
        storage.setItem('contentSource', selected);
        storage.setItem('contentSourceProvider', selected);
        storage.removeItem(SOURCE_MODE_KEY);
      }
    } catch (error) {
      const restored = restoreStorageSnapshot(storage, before);
      return {
        ok: false, mode: initialized.mode, provider: initialized.provider,
        needsRecovery: !restored, reason: restored ? 'source-selection-rolled-back' : 'source-selection-rollback-failed',
        error: String(error?.message || error)
      };
    }
    return readSourceSettings(storage);
  }

  function stableId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
  }

  const titleKey = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  function aliases(item = {}) {
    const values = [item.displayTitle, item.title, item.title_english, item.title_japanese, item.title_native, item.title_original,
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
    const title = [item.displayTitle, item.title, item.title_english, item.title_japanese, item.title_native, item.title_original,
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
    if (!aYear || !bYear || aYear !== bYear) return false;
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

    // Join only unique compatible identities. A shared external ID wins. Without
    // one, require an exact alias, matching years, and compatible season/format.
    // A title and season marker alone are not enough when a provider omits its year.
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

  async function searchProviders({ providers = PROVIDERS, query = '', terms = [], search, localSearch = async () => null, concurrency = 6, maxPages = 1 } = {}) {
    if (typeof search !== 'function') throw new TypeError('search must be a function');
    const selectedProviders = [...new Set(providers)].filter(provider => PROVIDERS.includes(provider));
    const seenTerms = new Set(), searchTerms = [];
    for (const value of [...(query ? [query] : []), ...terms]) {
      const term = String(value || '').trim(), key = term.normalize('NFKC').toLocaleLowerCase();
      if (!term || seenTerms.has(key)) continue;
      seenTerms.add(key); searchTerms.push(term);
    }
    const pageLimit = Math.max(1, Math.min(3, Number.isInteger(maxPages) ? maxPages : 1));
    const records = new Map(selectedProviders.map(provider => [provider, { items: [], attempts: 0, successes: 0, failures: 0, pages: 0, limited: false }]));
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
          let cursor = null;
          const seenCursors = new Set();
          for (let page = 0; page < pageLimit; page++) {
            if (page > 0) record.attempts++;
            try {
              const result = await search(task.provider, task.term, cursor);
              const items = Array.isArray(result) ? result : result?.data;
              record.successes++;
              record.pages++;
              if (Array.isArray(items)) record.items.push(...items.map(item => item?.provider ? item : { ...item, provider: task.provider }));
              // Only follow cursors actually returned by the official provider
              // API. Re:Anime uses an offset/limit/total response instead.
              let nextCursor = result?.nextOffset ?? null;
              if (task.provider === 'reanime' && nextCursor == null && Number.isFinite(Number(result?.total))
                && Number.isFinite(Number(result?.offset)) && Number.isFinite(Number(result?.limit))
                && Number(result.limit) > 0 && Number(result.offset) + Number(result.limit) < Number(result.total)) {
                nextCursor = Number(result.offset) + Number(result.limit);
              }
              if (result?.done || !Array.isArray(items) || !items.length || nextCursor == null || nextCursor === '') break;
              const signature = String(nextCursor);
              if (signature === String(cursor) || seenCursors.has(signature) || signature.length > 128) break;
              seenCursors.add(signature);
              if (page + 1 >= pageLimit) { record.limited = true; break; }
              cursor = nextCursor;
            } catch { record.failures++; break; }
          }
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
        pages: record.pages,
        pageLimitReached: record.limited,
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
    const records = new Map(providers.map(provider => [provider, { items: new Map(), attempts: 0, successes: 0, failures: 0, pages: 0, limited: false }]));
    for (const run of runs) {
      for (const status of run?.statuses || []) {
        const record = records.get(status.provider);
        if (!record) continue;
        record.attempts += Number(status.attempts) || 0;
        record.successes += Number(status.successes) || 0;
        record.failures += Number(status.failures) || 0;
        record.pages += Number(status.pages) || 0;
        record.limited ||= Boolean(status.pageLimitReached);
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
        pages: record.pages,
        pageLimitReached: record.limited,
        resultCount: record.items.size
      };
    });
    return { items: providers.flatMap(provider => [...records.get(provider).items.values()]), statuses };
  }

  function providersNeedingTitleVariants(result, providers = PROVIDERS) {
    const statuses = new Map((result?.statuses || []).map(status => [status.provider, status]));
    return [...new Set(providers)].filter(provider => {
      const status = statuses.get(provider);
      return ['ready', 'skipped'].includes(status?.state) && Number(status.resultCount) === 0;
    });
  }

  // Reserve bounded searches for scripts beyond the original query. Many
  // provider catalogs do not support Korean queries, but do index Latin/Japanese.
  function titleVariantTerms({ query = '', displayTitles = [], variants = [], limit = 3 } = {}) {
    const max = Number.isInteger(Number(limit)) ? Math.max(0, Math.min(5, Number(limit))) : 3;
    if (!max) return [];
    const queryKey = titleKey(query), seen = new Set(), buckets = { latin: [], japanese: [], korean: [], other: [] };
    for (const value of [...displayTitles, ...variants]) {
      const term = String(value || '').trim().slice(0, 240), key = titleKey(term);
      if (key.length < 2 || key === queryKey || seen.has(key)) continue;
      seen.add(key);
      const language = /[\u3040-\u30ff\u3400-\u9fff]/u.test(term) ? 'japanese'
        : /[가-힣]/.test(term) ? 'korean'
        : /[a-z]/i.test(term) ? 'latin' : 'other';
      buckets[language].push(term);
    }
    const queryScript = /[가-힣]/.test(query) ? 'korean'
      : /[\u3040-\u30ff\u3400-\u9fff]/u.test(query) ? 'japanese' : 'latin';
    const priority = queryScript === 'korean' ? ['latin', 'japanese', 'korean', 'other']
      : queryScript === 'japanese' ? ['latin', 'korean', 'japanese', 'other']
        : ['japanese', 'korean', 'latin', 'other'];
    const result = [];
    while (result.length < max && priority.some(lang => buckets[lang].length)) {
      for (const lang of priority) {
        if (result.length >= max) break;
        if (buckets[lang].length) result.push(buckets[lang].shift());
      }
    }
    return result;
  }

  // Duplicate matching numbers (e.g. multiple editions of episode 3)
  // cannot be selected automatically, nor may an episode belong to a
  // different supplier.
  function uniqueSameEpisode(episodes, reference, provider) {
    const number = playableEpisodeNumber(reference);
    if (!number || !PROVIDERS.includes(provider) || !Array.isArray(episodes)) return null;
    const matches = episodes.filter(item => item && item.playable !== false && !item.special
      && playableEpisodeNumber(item) === number
      && Boolean(item.dub) === Boolean(reference.dub)
      && (!item.provider || item.provider === provider));
    return matches.length === 1 ? { ...matches[0], provider } : null;
  }


  // Provider detail endpoints may list both dubs/subs, specials and repeats.
  // Compare only distinct playable episode numbers for the latest count.
  function playableEpisodeNumber(episode) {
    if(!episode || episode.special || episode.playable === false)return null;
    const numeric=Number(episode.number);
    if(Number.isInteger(numeric) && numeric>0 && numeric<10000)return numeric;
    const label=String(episode.name || episode.title || '').trim();
    const match=label.match(/^(?:제\s*|第\s*)?(?:ep(?:isode)?\.?\s*#?\s*)?(\d{1,4})(?=\s*(?:화|회|話|$|[-:]))/i);
    return match ? Number(match[1]) : null;
  }
  function episodeMetrics(response) {
    if(!Array.isArray(response?.episodes) || response.unavailable)return null;
    const numbered=new Set();
    let unnumbered=0,latest=0;
    for(const episode of response.episodes.slice(0,5000)){
      if(!episode || episode.special || episode.playable === false)continue;
      const number=playableEpisodeNumber(episode);
      if(number){
        numbered.add(number);
        if(number>latest)latest=number;
      }else unnumbered++;
    }
    return {count:numbered.size+unnumbered,latest};
  }

  // Like the original Korean title index: timestamped, batched local writes,
  // bounded profile storage and conservative verified provider identities.
  const WORK_INDEX_KEY = 'lilacDinoPatch.workIndex.v1';
  function createWorkIndex(storage, { clock = () => Date.now(), maxWorks = 1800 } = {}) {
    // Allow 1,000 pre-indexed Re:Anime works while leaving capacity for
    // discoveries and cards from the other four content providers.
    // Work identities are retained until the bounded LRU evicts them.
    // The TTLs only determine when a new provider scan is permitted:
    // all matched = 30 days, searched but missing a provider = 7 days,
    // incomplete/failed scan = 3 days. Interactive query results use
    // shorter TTLs so users can still find newly added anime promptly.
    const DAY = 86400000;
    const verifiedTtl = DAY * 30, missingTtl = DAY * 7, errorTtl = DAY * 3;
    const searchTtl = 21600000, failedSearchTtl = 600000;
    const sourceKey = a => String(a?.mal_id ?? (a?.provider && a.id != null ? a.provider + ':' + a.id : ''));
    // Provider-specific IDs can overlap; never overwrite another source.
    const scopedKey = a => a.provider + ':' + sourceKey(a);
    const clean = a => typeof a === 'string' ? a.trim().slice(0, 240) : '';
    const namesOf = xs => [...new Set(xs.map(clean).filter(x => x.length > 1))].slice(0, 24);
    const korean = value => /[가-힣]/.test(String(value || '')) ? clean(value) : '';
    // Canonical titles belong to the WORK, never to one of its providers.
    // Source rows retain their original title fields for provider-specific APIs.
    const titleFields = saved => ({
      ko: korean(saved?.ko), en: clean(saved?.en), ja: clean(saved?.ja),
      koSource: ['official', 'provider', 'manual'].includes(saved?.koSource)
        && korean(saved?.ko) ? saved.koSource : '',
      koCheckedAt: Number(saved?.koCheckedAt) || 0,
      manual: saved?.manual === true && !!korean(saved?.ko)
    });
    const episodeFields = raw => {
      if (!raw || typeof raw !== 'object') return null;
      const safe = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0
        ? Math.min(10000000000000, Number(value)) : 0;
      const state = ['ready','empty','error'].includes(raw.state) ? raw.state : '';
      if (!state) return null;
      return {
        state, count: Math.min(10000, safe(raw.count)),
        latest: Math.min(9999, safe(raw.latest)),
        checkedAt: safe(raw.checkedAt), attemptedAt: safe(raw.attemptedAt),
        newEpisodes: Math.min(9999, safe(raw.newEpisodes))
      };
    };
    const providerTitles = item => ({
      ko: korean(item?.displayTitle) || korean(item?.title),
      en: !korean(item?.title_english) && clean(item?.title_english)
        || (!korean(item?.title) && clean(item?.title)) || '',
      ja: clean(item?.title_japanese) || clean(item?.title_native) || ''
    });
    const compact = a => {
      if (!a || !PROVIDERS.includes(a.provider) || !sourceKey(a)) return null;
      const o = {};
      for (const k of ['provider', 'id', 'mal_id', 'title', 'title_english', 'title_japanese',
        'title_native', 'title_romaji', 'romaji', 'displayTitle', 'url',
        'year', 'type', 'anilistId', 'malId', 'status']) {
        const v = a[k];
        if (typeof v === 'string' && v.length < 700 || typeof v === 'number' && Number.isFinite(v)) o[k] = v;
      }
      if (Array.isArray(a.synonyms)) o.synonyms = namesOf(a.synonyms);
      if (a.images && typeof a.images === 'object') {
        try { if (JSON.stringify(a.images).length < 1200) o.images = a.images; } catch {}
      }
      if (a.dinoEpisode) {
        const episode = episodeFields(a.dinoEpisode);
        if (episode) o.dinoEpisode = episode;
      }
      o.provider = a.provider;
      o.mal_id = sourceKey(a);
      return o;
    };
    let data = { version: 1, works: [], searches: [] };
    try {
      const raw = storage?.getItem(WORK_INDEX_KEY);
      if (raw && raw.length < 4000000) {
        const saved = JSON.parse(raw);
        if (saved?.version === 1 && Array.isArray(saved.works) && Array.isArray(saved.searches)) {
          data.works = saved.works.slice(0, maxWorks).filter(w => w && Array.isArray(w.sources))
            .map(w => ({ id: String(w.id || '').slice(0, 160), sources: w.sources.map(compact).filter(Boolean).slice(0, 8),
              names: namesOf(Array.isArray(w.names) ? w.names : []),
              titles: titleFields(w.titles),
              checkedAt: Number(w.checkedAt) || 0, attemptedAt: Number(w.attemptedAt) || 0,
              outcome: ['verified', 'missing', 'error'].includes(w.outcome) ? w.outcome : '',
              updatedAt: Number(w.updatedAt) || 0 }))
            .filter(w => w.sources.length);
          // Old v1 work caches stored titles only in provider rows + names.
          // Backfill a conservative Korean representative in memory; no
          // original display-title profile file is modified during migration.
          for (const row of data.works) {
            if (!row.titles.ko) {
              const provider = row.sources.map(providerTitles).find(t => t.ko);
              if (provider) row.titles = { ...row.titles, ko: provider.ko,
                koSource: 'provider', koCheckedAt: 0 };
            }
            if (!row.titles.en) row.titles.en = row.sources.map(providerTitles).find(t => t.en)?.en || '';
            if (!row.titles.ja) row.titles.ja = row.sources.map(providerTitles).find(t => t.ja)?.ja || '';
            row.names = namesOf([row.titles.ko, row.titles.en, row.titles.ja, ...row.names]);
          }
          data.searches = saved.searches.slice(-65).filter(s => s && typeof s.query === 'string'
            && Array.isArray(s.sourceIds) && Array.isArray(s.statuses));
        }
      }
    } catch { /* broken or unavailable cache never changes original user data */ }
    let dirty = false, timer = null, persistenceHook = null;
    const cloned = value => JSON.parse(JSON.stringify(value));
    const notify = (row, { manualReset = false } = {}) => {
      if (row && typeof persistenceHook === 'function') {
        try { persistenceHook({ ...cloned(row), dinoResetManual: manualReset }); }
        catch { /* optional SQLite is never required */ }
      }
    };
    const setPersistenceHook = hook => { persistenceHook = typeof hook === 'function' ? hook : null; };
    // Complete v1 snapshots are always kept in localStorage for fallback.
    // SQLite is an additive durable store for rows older than this hot cache.
    const exportRows = () => data.works.map(cloned);
    const flush = () => {
      if (!dirty) return true;
      data.works.sort((a, b) => b.updatedAt - a.updatedAt);
      data.works.length = Math.min(data.works.length, maxWorks);
      data.searches = data.searches.slice(-65);
      try {
        let encoded = JSON.stringify(data);
        // Keep UTF-16 profile storage well below Electron's usual quota;
        // LRU eviction is bounded and never touches original LilacAnime data.
        while (encoded.length > 1900000 && data.works.length > 1) {
          data.works.pop();
          encoded = JSON.stringify(data);
        }
        if (typeof storage?.setItem !== 'function') return false;
        storage.setItem(WORK_INDEX_KEY, encoded);
        dirty = false;
        return true;
      } catch {
        // A failed write must not advance the catalog cursor: otherwise the
        // next start would silently skip works that only lived in RAM.
        return false;
      }
    };
    const touch = () => {
      dirty = true;
      if (timer == null && typeof setTimeout === 'function')
        timer = setTimeout(() => { timer = null; flush(); }, 800);
    };
    const rowFor = anchor => {
      if (!anchor || !PROVIDERS.includes(anchor.provider)) return null;
      const key = sourceKey(anchor);
      // Stored provider ID takes precedence over fuzzy title matching.
      // Essential after a user separates two look-alike seasons.
      return data.works.find(w => w.sources.some(s => s.provider === anchor.provider
        && sourceKey(s) === key)) ||
        data.works.find(w => w.sources.some(s => identityMatch(s, anchor))) || null;
    };
    const find = anchor => {
      const w = rowFor(anchor);
      if (!w) return null;
      const ref = { ...anchor, synonyms: [...(Array.isArray(anchor.synonyms) ? anchor.synonyms : []), ...w.names] };
      // Old v1 rows did not record scan outcome; recheck those after
      // seven days, while keeping their validated provider links.
      const ttl = w.outcome === 'verified' ? verifiedTtl
        : w.outcome === 'missing' ? missingTtl
        : w.outcome === 'error' ? errorTtl : missingTtl;
      const verifiedOrMissing = w.outcome === 'verified' || w.outcome === 'missing';
      const at = verifiedOrMissing ? w.checkedAt : (w.attemptedAt || w.checkedAt);
      return { sources: w.sources.filter(s => identityMatch(ref, s)), names: w.names.slice(),
        titles: { ...w.titles },
        checkedAt: w.checkedAt, attemptedAt: w.attemptedAt || 0,
        outcome: w.outcome || 'legacy',
        fresh: at > 0 && clock() - at < ttl };
    };
    const remember = (group, { checked = false, attempted = false, names = [], outcome = '' } = {}) => {
      const items = (group?.sourceItems || []).map(compact).filter(Boolean);
      if (!items.length) return;
      let row = rowFor(items[0]);
      if (!row) {
        row = { id: sourceKey(items[0]), sources: [], names: [],
          titles: titleFields(), checkedAt: 0, attemptedAt: 0,
          outcome: '', updatedAt: 0 };
        data.works.push(row);
      }
      row.names = namesOf([...row.names, ...names,
        ...items.flatMap(s => [s.title, s.title_english, s.title_japanese, s.displayTitle, ...(s.synonyms || [])])]);
      // Passive provider cards may seed missing common titles, but they
      // cannot override a title verified by Lilac's original resolver or
      // explicitly edited by the user.
      for (const item of items) {
        const candidate = providerTitles(item);
        if (!row.titles.ko && candidate.ko) {
          row.titles.ko = candidate.ko;
          row.titles.koSource = 'provider';
          row.titles.koCheckedAt = clock();
        }
        if (!row.titles.en && candidate.en) row.titles.en = candidate.en;
        if (!row.titles.ja && candidate.ja) row.titles.ja = candidate.ja;
      }
      if (row.titles.ko) row.names = namesOf([row.titles.ko, ...row.names]);
      const ref = { ...items[0], synonyms: [...(items[0].synonyms || []), ...row.names] };
      const merged = new Map(row.sources.filter(s => identityMatch(ref, s)).map(s => [scopedKey(s), s]));
      for (const s of items) if (identityMatch(ref, s)
        && !data.works.some(other => other !== row && other.sources.some(existing =>
          scopedKey(existing) === scopedKey(s))))
        merged.set(scopedKey(s), { ...merged.get(scopedKey(s)), ...s });
      row.sources = [...merged.values()];
      row.updatedAt = clock();
      const validatedOutcome = ['verified', 'missing', 'error'].includes(outcome)
        ? outcome : checked ? 'verified' : attempted ? 'error' : '';
      if (validatedOutcome) row.outcome = validatedOutcome;
      if (checked || validatedOutcome === 'verified' || validatedOutcome === 'missing') row.checkedAt = clock();
      if (attempted || checked || validatedOutcome) row.attemptedAt = clock();
      if (data.works.length > maxWorks) {
        data.works.sort((a, b) => b.updatedAt - a.updatedAt);
        data.works.length = maxWorks;
      }
      touch();
      notify(row);
    };

    const rememberTitles = (anchor, titles, { source = 'official' } = {}) => {
      if (!['official', 'provider', 'manual'].includes(source)) return false;
      let row = rowFor(anchor);
      // An original title result may arrive before its card is in the DB.
      if (!row && compact(anchor)) {
        remember({ sourceItems: [anchor] });
        row = rowFor(anchor);
      }
      if (!row) return false;
      const candidate = titleFields(titles);
      const ko = candidate.ko;
      let changed = false;
      if (source === 'manual') {
        // Empty titles are not a deletion command; don't lose the only
        // Korean title accidentally through an empty edit form.
        if (!ko) return false;
        if (row.titles.ko !== ko || !row.titles.manual) {
          row.titles.ko = ko;
          row.titles.koSource = 'manual';
          row.titles.manual = true;
          // Monotonic edits avoid equal-millisecond timestamps reviving a stale title.
          row.titles.koCheckedAt = Math.max(clock(), row.titles.koCheckedAt + 1);
          changed = true;
        }
      } else if (ko && !row.titles.manual
        && (source === 'official' || !row.titles.ko)) {
        if (row.titles.ko !== ko || row.titles.koSource !== source) {
          row.titles.ko = ko;
          row.titles.koSource = source;
          row.titles.koCheckedAt = clock();
          changed = true;
        }
      }
      for (const lang of ['en', 'ja']) {
        if (candidate[lang] && (source === 'official' || !row.titles[lang])
          && candidate[lang] !== row.titles[lang]) {
          row.titles[lang] = candidate[lang];
          changed = true;
        }
      }
      const combined = namesOf([row.titles.ko, row.titles.en, row.titles.ja, ...row.names]);
      if (combined.length !== row.names.length || combined.some((name, at) => name !== row.names[at])) {
        row.names = combined; changed = true;
      }
      if (changed) { row.updatedAt = clock(); touch(); notify(row); }
      return changed;
    };
    const resetManualKoreanTitle = anchor => {
      const row = rowFor(anchor);
      if (!row?.titles.manual) return false;
      // Reset to the most reliable observed Korean provider title; a later
      // original resolver pass may supersede this fallback.
      const fallback = row.sources.map(providerTitles).find(title => title.ko)?.ko || '';
      row.titles = { ...row.titles, ko: fallback,
        koSource: fallback ? 'provider' : '',
        koCheckedAt: Math.max(clock(), row.titles.koCheckedAt + 1), manual: false };
      if (fallback) row.names = namesOf([fallback, ...row.names]);
      row.updatedAt = clock(); touch(); notify(row, { manualReset: true });
      return true;
    };

    // Supplier-specific episode snapshots never affect canonical Korean titles,
    // provider matching freshness, or another supplier's episode count.
    const episodeState = item => {
      const row = rowFor(item);
      const source = row?.sources.find(entry => entry.provider === item?.provider
        && sourceKey(entry) === sourceKey(item));
      const value = episodeFields(source?.dinoEpisode);
      return value ? { ...value } : null;
    };
    const rememberEpisode = (item, facts = null) => {
      if (!compact(item)) return false;
      let row = rowFor(item);
      if (!row) {
        remember({sourceItems:[item]});
        row = rowFor(item);
      }
      const source = row?.sources.find(entry => entry.provider === item.provider
        && sourceKey(entry) === sourceKey(item));
      if (!source) return false;
      const old = episodeFields(source.dinoEpisode);
      const successful = facts && Number.isSafeInteger(facts.count) && facts.count >= 0
        && Number.isSafeInteger(facts.latest) && facts.latest >= 0;
      const time = clock();
      if (!successful && old?.attemptedAt && time < old.attemptedAt) return false;
      if (successful && old?.checkedAt && time < old.checkedAt) return false;
      const snapshot = successful ? {
        state: facts.count ? 'ready' : 'empty',
        count: Math.min(10000, facts.count),
        latest: Math.min(9999, facts.latest),
        checkedAt: time, attemptedAt: time,
        newEpisodes: old?.latest > 0 && facts.latest > old.latest
          ? Math.min(9999, facts.latest - old.latest) : 0
      } : {
        state: 'error', count: old?.count || 0, latest: old?.latest || 0,
        checkedAt: old?.checkedAt || 0, attemptedAt: time,
        newEpisodes: old?.newEpisodes || 0
      };
      source.dinoEpisode = snapshot;
      row.updatedAt = time;
      touch(); notify(row);
      return true;
    };

    // Opportunistically reuse entries already delivered to the original
    // renderer (season, airing, library, search or a catalog card). This
    // creates no IPC/network request and never marks an observed card as a
    // completed five-provider verification. Existing checksums, outcomes and
    // checkedAt timestamps survive re-rendering.
    const observe = (items, { limit = 24 } = {}) => {
      const max = Math.max(0, Math.min(36, Number(limit) || 0));
      const seen = new Set();
      let added = 0, updated = 0;
      for (const raw of Array.isArray(items) ? items : []) {
        if (added + updated >= max) break;
        const item = compact(raw);
        if (!item) continue;
        const key = item.provider + ':' + sourceKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        const row = rowFor(item);
        const old = row?.sources.find(source => source.provider === item.provider
          && sourceKey(source) === sourceKey(item));
        if (old) {
          // Title aliases discovered by the original display-title system may
          // arrive after the first card has already been rendered.
          const itemNames = namesOf([item.title, item.title_english,
            item.title_japanese, item.displayTitle, ...(item.synonyms || [])]);
          const statusChanged = typeof item.status === 'string'
            && item.status.trim() && item.status !== old.status;
          if (!itemNames.some(name => !row.names.includes(name)) && !statusChanged) continue;
          updated++;
        } else added++;
        remember({ sourceItems: [item] });
      }
      return { added, updated };
    };
    const rememberSearch = (query, result) => {
      const key = titleKey(query);
      if (!key || !Array.isArray(result?.items) || !Array.isArray(result?.statuses)) return;
      data.searches = data.searches.filter(s => s.query !== key);
      data.searches.push({ query: key, time: clock(), sourceIds: [...new Set(result.items.filter(item => item && PROVIDERS.includes(item.provider))
          .map(scopedKey))].slice(0, 450),
        statuses: result.statuses.map(s => ({ provider: s.provider, state: s.state,
          attempts: s.attempts || 0, successes: s.successes || 0, failures: s.failures || 0,
          pages: s.pages || 0, pageLimitReached: !!s.pageLimitReached, resultCount: s.resultCount || 0 })) });
      touch();
    };
    const readSearch = query => {
      const row = data.searches.find(s => s.query === titleKey(query));
      if (!row || clock() - row.time > (row.statuses.every(s => s.state === 'ready') ? searchTtl : failedSearchTtl)) return null;
      const sources = data.works.flatMap(w => w.sources);
      const lookup = new Map(sources.map(s => [scopedKey(s), s]));
      // Existing v1 snapshots used unscoped IDs. Keep unambiguous legacy
      // entries readable, but re-search collisions instead of guessing.
      const legacy = new Map(), ambiguous = new Set();
      for (const item of sources) {
        const id = sourceKey(item);
        if (legacy.has(id) && scopedKey(legacy.get(id)) !== scopedKey(item)) ambiguous.add(id);
        else legacy.set(id, item);
      }
      const items = row.sourceIds.map(id => lookup.get(id)
        || (ambiguous.has(id) ? null : legacy.get(id)));
      return items.some(s => !s) ? null : { items, statuses: row.statuses, fromCache: true };
    };
    const invalidate = anchor => {
      const row = rowFor(anchor);
      if (!row) return;
      row.checkedAt = 0;
      row.attemptedAt = 0;
      row.outcome = '';
      data.searches = data.searches.filter(s => !s.sourceIds.some(id => row.sources.some(item =>
        scopedKey(item) === id || sourceKey(item) === id)));
      touch();
      notify(row);
    };
    // Recover older work rows from SQLite on a cache miss. Canonical titles
    // are merged conservatively; manual edits are never downgraded.
    const importRows = rows => {
      let added = 0, merged = 0;
      for (const raw of Array.isArray(rows) ? rows.slice(0, 300) : []) {
        if (!raw || !Array.isArray(raw.sources) || !raw.sources.length) continue;
        const sources = raw.sources.map(compact).filter(Boolean);
        if (!sources.length) continue;
        // SQLite's exact ownership wins over heuristic alias matching.
        let row = data.works.find(w => w.sources.some(s =>
          sources.some(next => scopedKey(s) === scopedKey(next)))) || null;
        if (!row) {
          row = {
            id: String(raw.id || sourceKey(sources[0])).slice(0,360),
            sources: [], names: [], titles: titleFields(),
            checkedAt: 0, attemptedAt: 0, outcome: '', updatedAt: 0
          };
          data.works.push(row);
          added++;
        } else merged++;
        const incomingTitle = titleFields(raw.titles);
        const localTitle = row.titles;
        const incomingManualNewer = incomingTitle.manual &&
          (!localTitle.manual || incomingTitle.koCheckedAt > localTitle.koCheckedAt);
        if (incomingManualNewer ||
          (!localTitle.manual && !incomingTitle.manual &&
            (incomingTitle.koSource === 'official' && localTitle.koSource !== 'official'
              || !localTitle.ko && !!incomingTitle.ko))) {
          row.titles.ko = incomingTitle.ko;
          row.titles.koSource = incomingTitle.koSource;
          row.titles.koCheckedAt = incomingTitle.koCheckedAt;
          row.titles.manual = incomingTitle.manual;
        }
        if (!row.titles.en) row.titles.en = incomingTitle.en;
        if (!row.titles.ja) row.titles.ja = incomingTitle.ja;
        row.names = namesOf([row.titles.ko, row.titles.en, row.titles.ja,
          ...row.names, ...(Array.isArray(raw.names) ? raw.names : [])]);
        const reference = { ...sources[0], synonyms: row.names };
        const known = new Map(row.sources.map(s => [scopedKey(s), s]));
        for (const source of sources) {
          if (!identityMatch(reference, source)) continue;
          const existing = known.get(scopedKey(source));
          if (!existing) known.set(scopedKey(source), source);
          else {
            const incoming = episodeFields(source.dinoEpisode);
            const previous = episodeFields(existing.dinoEpisode);
            if (incoming && (!previous || incoming.attemptedAt > previous.attemptedAt
              || incoming.attemptedAt === previous.attemptedAt && incoming.checkedAt > previous.checkedAt))
              existing.dinoEpisode = incoming;
          }
        }
        row.sources = [...known.values()].slice(0,8);
        const storedCheck = Number(raw.checkedAt) || 0;
        if (storedCheck > row.checkedAt) {
          row.checkedAt = storedCheck;
          row.outcome = ['verified','missing','error'].includes(raw.outcome) ? raw.outcome : '';
        }
        row.attemptedAt = Math.max(row.attemptedAt, Number(raw.attemptedAt)||0);
        row.updatedAt = Math.max(row.updatedAt, Number(raw.updatedAt)||0);
      }
      if (added || merged) {
        data.works.sort((a,b)=>b.updatedAt-a.updatedAt);
        data.works.length = Math.min(data.works.length,maxWorks);
        touch();
      }
      return {added,merged};
    };
    // A stored source in another work is never silently merged into this one.
    const separateWorks = (anchor, candidate) => {
      const owned = item => data.works.find(w => w.sources.some(s =>
        s.provider === item?.provider && sourceKey(s) === sourceKey(item)));
      const a=owned(anchor),b=owned(candidate);
      return !!a && !!b && a!==b;
    };
    // Database repairs return full affected works. Replace, don't heuristically
    // merge: the owner chosen by the user is authoritative.
    const replaceRows = (rows, affected = [], { persist = true } = {}) => {
      if (!Array.isArray(rows) || !rows.length) return false;
      const incoming=rows.filter(row=>row&&Array.isArray(row.sources)&&row.sources.length);
      const keys=new Set([...affected,...incoming.flatMap(row=>row.sources)].filter(Boolean)
        .map(source=>source.provider+':'+sourceKey(source)));
      // A legacy row can include two now-separated works. Keep any suppliers
      // absent from the authoritative SQLite response as independent entries.
      data.works=data.works.flatMap(row=>{
        const remaining=row.sources.filter(source=>!keys.has(scopedKey(source)));
        if(remaining.length===row.sources.length)return [row];
        if(!remaining.length)return [];
        const guessed=remaining.map(providerTitles).find(title=>title.ko);
        const titles=titleFields({ko:guessed?.ko,en:remaining.map(providerTitles).find(t=>t.en)?.en,
          ja:remaining.map(providerTitles).find(t=>t.ja)?.ja,koSource:guessed?'provider':''});
        return [{...row,id:sourceKey(remaining[0]),sources:remaining,
          titles,names:namesOf(remaining.flatMap(s=>[s.title,s.title_english,s.displayTitle])),
          checkedAt:0,attemptedAt:0,outcome:'',updatedAt:clock()}];
      });
      for (const raw of incoming) {
        const sources=raw.sources.map(compact).filter(Boolean);
        if (!sources.length)continue;
        data.works.push({
          id:String(raw.id||sourceKey(sources[0])).slice(0,360),
          sources,names:namesOf(Array.isArray(raw.names)?raw.names:[]),
          titles:titleFields(raw.titles),checkedAt:Number(raw.checkedAt)||0,
          attemptedAt:Number(raw.attemptedAt)||0,
          outcome:['verified','missing','error'].includes(raw.outcome)?raw.outcome:'',
          updatedAt:Number(raw.updatedAt)||clock()
        });
      }
      data.works.sort((a,b)=>b.updatedAt-a.updatedAt);
      data.works.length=Math.min(data.works.length,maxWorks);
      data.searches=[];touch();
      // Startup hydration must not immediately rewrite the original v1
      // snapshot. The ordinary delayed flush keeps the cache consistent.
      return persist?flush():true;
    };
    return { find, remember, rememberTitles, resetManualKoreanTitle, observe,
      separateWorks, replaceRows,
      episodeState, rememberEpisode,
      rememberSearch, readSearch, invalidate, flush, exportRows, importRows,
      setPersistenceHook,
      stats: () => ({
        works: data.works.length, searches: data.searches.length,
        providers: Object.fromEntries(PROVIDERS.map(provider => [
          provider, data.works.reduce((sum, work) =>
            sum + Number(work.sources.some(item => item.provider === provider)), 0)
        ]))
      }) };
  }

  const api = {
    PROVIDERS,
    playableEpisodeNumber,
    episodeMetrics,
    WORK_INDEX_KEY,
    createWorkIndex,
    OFFICIAL_SOURCES,
    SOURCE_MODE_KEY,
    SOURCE_MIGRATION_KEY,
    initializeSourceSettings,
    readSourceSettings,
    saveSourceSelection,
    officialSourceForState,
    groupResults,
    filterGroups,
    chooseSource,
    searchProviders,
    mergeSearchResults,
    aliases,
    year,
    part,
    format,
    metadataCompatible,
    identityMatch,
    providersNeedingTitleVariants,
    titleVariantTerms,
    uniqueSameEpisode
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LilacIntegratedSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
