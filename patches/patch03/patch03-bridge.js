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
      localSearch: async () => null
    };
    try {
      let result = await api.searchProviders({ ...options, query });
      if (sequence !== searchSequence) return;
      const missing = api.providersNeedingTitleVariants(result, providers);
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

  function renderSourcePicker(group, activeId) {
    if (!group || (group.sourceItems || []).length < 2) return;
    const content = document.querySelector('#detailContent');
    const dialog = document.querySelector('#detailDialog');
    if (!dialog?.open || !content?.querySelector('.detail-actions')) return;
    content.querySelector('.detail-source-picker')?.remove();
    const section = document.createElement('section');
    section.className = 'detail-source-picker';
    section.setAttribute('aria-label', '작품 공급원 선택');
    const title = document.createElement('b');
    title.textContent = '공급원 · 회차 목록';
    const choices = document.createElement('div');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', '공급원 선택');
    for (const item of group.sourceItems) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.providerSource = String(item.mal_id);
      button.setAttribute('aria-pressed', String(String(item.mal_id) === String(activeId)));
      button.textContent = labels[item.provider] || item.provider;
      button.addEventListener('click', () => window.openDetail(String(item.mal_id), { sourceSelection: true }));
      choices.append(button);
    }
    section.append(title, choices);
    const anchor = content.querySelector('.detail-meta') || content.querySelector('.detail-actions');
    anchor?.before(section);
  }

  window.openDetail = async function (id, options = {}) {
    const inIntegratedSearch = integratedMode() && document.querySelector('#searchView')?.classList.contains('active');
    const group = inIntegratedSearch ? groupBySourceId.get(String(id)) : null;
    const sequence = ++detailSequence;
    const selected = group ? api.chooseSource(group, {
      provider: currentFilter,
      preferredProvider: selectedProvider(),
      sourceId: (options?.sourceSelection || currentFilter === 'all') ? id : ''
    }) : null;
    const selectedId = String(selected?.mal_id ?? id);
    const result = await officialOpenDetail.call(this, selectedId);
    if (sequence === detailSequence && group) renderSourcePicker(group, selectedId);
    return result;
  };

  window.__dinoPatch03Bridge = {
    active: true,
    providers: providers.slice(),
    apiContracts: ['providerCatalog', 'providerDetail', 'providerResolve'],
    getMode: () => integratedMode() ? 'integrated' : 'provider',
    getSelectedProvider: selectedProvider,
    getSearchSnapshot: () => resultGroups.map(group => ({
      title: String(group.displayTitle || group.title || ''),
      sourceItems: (group.sourceItems || []).map(item => ({ provider: item.provider, sourceId: String(item.mal_id) }))
    }))
  };
})();
