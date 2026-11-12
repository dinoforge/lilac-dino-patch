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
  const sourceKey = item => String(item?.mal_id ?? item?.id ?? '');
  const isDinoProvider = item => !!item && providers.includes(item.provider) && !!sourceKey(item);
  const localKoreanCatalog = async (provider, query) => {
    if (!/[가-힣]/.test(String(query)) || !['reanime', 'animenosub'].includes(provider)
      || typeof window.lilac.catalogKoreanSearch !== 'function') return null;
    const result = await window.lilac.catalogKoreanSearch(provider, query);
    return Array.isArray(result) ? result : [];
  };
  function keepDetailGroup(group) {
    if (!Array.isArray(group?.sourceItems)) return;
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
    return groups.find(group => group.sourceItems.some(item => item.provider === anchor.provider
      && sourceKey(item) === sourceKey(anchor))) || api.groupResults([anchor], selectedProvider())[0];
  }
  async function discoverSources(anchor, knownGroup) {
    const key = anchor.provider + ':' + sourceKey(anchor);
    const cached = detailDiscoveryCache.get(key);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.promise;
    const promise = (async () => {
      const seeds = Array.isArray(knownGroup?.sourceItems) ? knownGroup.sourceItems : [];
      const nativeTitles = [anchor.displayTitle, anchor.title, anchor.title_english,
        anchor.title_japanese, anchor.title_native, anchor.title_romaji, anchor.romaji,
        ...(Array.isArray(anchor.synonyms) ? anchor.synonyms : [])]
        .filter(value => typeof value === 'string' && value.trim().length > 1);
      const query = String((typeof window.titleOf === 'function' && window.titleOf(anchor))
        || anchor.title || nativeTitles[0] || '').trim();
      if (!query) return verifiedGroupFor(anchor, seeds);
      let variants = [];
      if (typeof window.lilac.titleVariants === 'function') {
        try {
          const received = await window.lilac.titleVariants(query);
          variants = Array.isArray(received) ? received : [];
        } catch { /* Original aliases remain usable. */ }
      }
      const terms = api.titleVariantTerms({
        query, displayTitles: nativeTitles, variants, limit: 5
      });
      // Official title variants are candidate aliases, not sufficient alone
      // to join anime. The existing identity matcher still demands matching
      // release years, compatible season/format and non-conflicting IDs.
      const verifiedAliases = [...new Set([...nativeTitles, ...variants])]
        .filter(value => typeof value === 'string' && value.trim().length > 1)
        .slice(0, 16);
      const reference = {
        ...anchor,
        synonyms: [...(Array.isArray(anchor.synonyms) ? anchor.synonyms : []), ...verifiedAliases]
      };
      const options = {
        search: (provider, text) => window.lilac.providerCatalog(provider, text),
        localSearch: localKoreanCatalog, concurrency: 5
      };
      const first = await api.searchProviders({ ...options, providers, query });
      let group = verifiedGroupFor(reference, [...seeds, ...first.items]);
      // A successful nonempty catalog response can contain unrelated anime.
      // Only an identity match proves that the requested work was found.
      const matched = new Set(group.sourceItems.map(item => item.provider));
      const missing = providers.filter(provider => !matched.has(provider));
      if (missing.length && terms.length) {
        const extra = await api.searchProviders({
          ...options, providers: missing, query: '', terms,
          localSearch: async () => null
        });
        group = verifiedGroupFor(reference, [...seeds, ...first.items, ...extra.items]);
      }
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
      return officialShowHomeList.apply(this, args);
    };
  }

  const integratedMode = () => api.readSourceSettings(localStorage).mode === 'integrated';
  function selectedProvider() {
    const stored = api.readSourceSettings(localStorage).provider;
    return singleSources.includes(stored) ? stored : initialSourceSettings.provider;
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
    const failureText = failures.length
      ? ` · 확인 필요: ${failures.map(item => labels[item.provider] || item.provider).join(', ')}`
      : '';
    document.querySelector('#searchStatus').textContent = `“${currentQuery}” 검색 결과 ${summary}${failureText}`;
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
      const suffix = state === 'failed' ? ' · 실패' : state === 'partial' ? ' · 일부 실패' : ` · ${count}`;
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

    const options = {
      providers,
      concurrency: 6,
      search: (provider, text) => window.lilac.providerCatalog(provider, text),
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
        const terms = api.titleVariantTerms({ query, variants, limit: 3 });
        if (terms.length) {
          const extra = await api.searchProviders({ ...options, providers: missing, query: '', terms });
          if (sequence !== searchSequence) return;
          result = api.mergeSearchResults(result, extra);
        }
      }
      if (sequence === searchSequence) applyResults(result);
    } catch (error) {
      if (sequence === searchSequence) {
        document.querySelector('#searchStatus').textContent = `통합 검색을 완료하지 못했습니다: ${String(error?.message || error)}`;
      }
    }
  };

  function renderSourcePicker(group, activeId, searching = false) {
    if (!integratedMode() || !Array.isArray(group?.sourceItems) || !group.sourceItems.length) return;
    const content = document.querySelector('#detailContent');
    const dialog = document.querySelector('#detailDialog');
    if (!dialog?.open || !content?.querySelector('.detail-actions')) return;
    content.querySelector('.detail-source-picker')?.remove();
    const section = document.createElement('section');
    section.className = 'detail-source-picker';
    section.setAttribute('aria-label', '통합 공급원 선택');
    const title = document.createElement('b');
    title.textContent = '재생 공급원';
    const choices = document.createElement('div');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', '재생 공급원 선택');
    for (const item of group.sourceItems) {
      const id = sourceKey(item);
      const info = detailFacts.get(id);
      const quality = verifiedVideoQuality.get(item.provider);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dino-source-option';
      button.dataset.providerSource = id;
      button.setAttribute('aria-pressed', String(id === String(activeId)));
      // The search catalog's episode count is only an estimate. Use only the
      // actual fetched episode list, and only measured video resolutions.
      const count = info?.unavailable ? '재생 불가'
        : info?.noEpisodes ? '회차 없음'
        : Number.isInteger(info?.episodes) ? String(info.episodes) + '화' : '회차 확인 중';
      const resolution = quality ? '최근 재생 ' + quality : '화질 재생 시 확인';
      button.textContent = (labels[item.provider] || item.provider) + ' · ' + count + ' · ' + resolution;
      button.title = button.textContent;
      button.addEventListener('click', () => window.openDetail(id, { sourceSelection: true }));
      choices.append(button);
    }
    section.append(title, choices);
    if (group.sourceItems.length === 1) {
      const note = document.createElement('small');
      note.className = 'source-search-note';
      note.textContent = searching ? '다른 공급원에서 같은 작품을 확인하는 중...' : '다른 공급원에서 같은 작품을 확인하지 못했습니다. 다른 시즌은 자동으로 합치지 않습니다.';
      section.append(note);
    }
    if (!searching && group.sourceItems.length < providers.length) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'dino-source-retry';
      retry.textContent = '다른 공급원 다시 찾기';
      retry.addEventListener('click', async () => {
        const current = group.sourceItems.find(item => sourceKey(item) === String(activeId)) || group.sourceItems[0];
        if (!isDinoProvider(current)) return;
        const seq = detailSequence;
        detailDiscoveryCache.delete(current.provider + ':' + sourceKey(current));
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
            detailFacts.set(id, {
              episodes: response.episodes.filter(ep => ep?.playable !== false).length,
              noEpisodes: response.episodes.length === 0,
              unavailable: Boolean(response?.unavailable)
            });
          } else if (response?.unavailable) {
            detailFacts.set(id, { unavailable: true });
          }
        } catch { /* Do not claim a count on failed provider detail. */ }
        if (sequence === detailSequence) renderSourcePicker(group, activeId);
      }
    }));
    if (detailFacts.size > 500) detailFacts.delete(detailFacts.keys().next().value);
  }

  window.openDetail = async function (id, options = {}) {
    const isIntegrated = integratedMode();
    const inIntegratedSearch = isIntegrated && document.querySelector('#searchView')?.classList.contains('active');
    const group = isIntegrated ? (detailGroupsBySourceId.get(String(id))
      || (inIntegratedSearch ? groupBySourceId.get(String(id)) : null)) : null;
    const anchor = initialKnownSource(id, group);
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
      verifiedVideoQuality.set(provider, String(height) + 'p');
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

  window.__dinoPatch03Bridge = {
    active: true,
    providers: providers.slice(),
    apiContracts: ['providerCatalog', 'providerDetail', 'providerResolve'],
    getMode: () => integratedMode() ? 'integrated' : 'provider',
    getSelectedProvider: selectedProvider,
    getSearchSnapshot: () => resultGroups.map(group => ({
      title: String(group.displayTitle || group.title || ''),
      sourceItems: (group.sourceItems || []).map(item => ({ provider: item.provider, sourceId: String(item.mal_id) }))
    })),
    getDetailSnapshot: id => (detailGroupsBySourceId.get(String(id))?.sourceItems || [])
      .map(item => ({ provider: item.provider, sourceId: sourceKey(item) }))
  };
})();
