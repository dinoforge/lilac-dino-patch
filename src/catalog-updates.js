// Update order uses each provider's own recent-episode feed. Saved library data is never reordered in storage.
const catalogUpdateUI = (() => {
  const supported = ['reanime', 'miruro', 'animenosub', 'ohli24'];
  const cache = new Map();
  let homeOrder = 'season', libraryOrder = 'saved', homeRequest = 0, libraryRequest = 0;
  const baselineStorageKey = 'libraryUpdateBaselines';

  function select(container, value) {
    $$(container + ' button').forEach(button => {
      const selected = button.dataset.order === value;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', String(selected));
    });
  }

  function note(selector, text) {
    $(selector).textContent = text;
    $(selector).classList.toggle('hidden', !text);
  }

  function availableEpisodes(item) {
    const values = item?.provider === 'reanime' ? [item.availableEpisodes, item.subbed, item.dubbed]
      : item?.provider === 'miruro' ? [item.availableEpisodes ?? (Number(item.availableEpisodeCount) > 0 ? item.availableEpisodeCount : null)]
        : ['animenosub', 'ohli24'].includes(item?.provider) ? [item.availableEpisodes] : [];
    const numbers = values.filter(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0).map(Number);
    return numbers.length ? Math.max(...numbers) : null;
  }

  function episodeNumber(episode) {
    const direct = Number(episode?.number);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const match = String(episode?.name || '').match(/(?:EP\.?\s*)?(\d+(?:\.\d+)?)(?:\s*화)?/i);
    return match ? Number(match[1]) : 0;
  }

  function readBaselines() {
    try {
      const value = JSON.parse(localStorage.getItem(baselineStorageKey) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function baselineKey(anime) { return `${anime?.provider || ''}:${anime?.mal_id ?? anime?.id ?? ''}`; }

  function saveBaseline(anime, number) {
    if (!anime || !Number.isFinite(number) || number < 0) return;
    try {
      const values = readBaselines(), key = baselineKey(anime);
      values[key] = Math.max(Number(values[key]) || 0, number);
      localStorage.setItem(baselineStorageKey, JSON.stringify(values));
    } catch {}
  }

  function forgetBaseline(anime) {
    if (!anime) return;
    try {
      const values = readBaselines();
      delete values[baselineKey(anime)];
      localStorage.setItem(baselineStorageKey, JSON.stringify(values));
    } catch {}
  }

  function reconcileLibraryUpdates(entries) {
    const byId = new Map(entries.map(entry => [String(entry.item.mal_id), entry]));
    const baselines = readBaselines(); let changed = false;
    const rows = state.library.map((saved, index) => {
      const freshEntry = byId.get(String(saved.mal_id)), fresh = freshEntry?.item;
      if (!fresh) return { item: saved, index, fresh: null, isNew: false };
      const latest = availableEpisodes(fresh), savedCount = availableEpisodes(saved), key = baselineKey(saved);
      let baseline = Number(baselines[key]);
      if (!Number.isFinite(baseline) || baseline < 0) baseline = null;
      if (savedCount !== null) baseline = Math.max(baseline ?? 0, savedCount);
      else if (baseline === null && latest !== null) {
        baseline = latest;
        baselines[key] = latest;
        changed = true;
      }
      if (baseline !== null && savedCount !== null && Number(baselines[key]) !== baseline) {
        baselines[key] = baseline;
        changed = true;
      }
      const watched = (state.history || []).reduce((max, record) => {
        const watchedAnime = record.anime;
        if (!watchedAnime || String(watchedAnime.mal_id ?? watchedAnime.id) !== String(saved.mal_id ?? saved.id)) return max;
        if (watchedAnime.provider && saved.provider && watchedAnime.provider !== saved.provider) return max;
        if (!(Number(record.progress) > 0)) return max;
        return Math.max(max, episodeNumber(record.episode));
      }, 0);
      const item = { ...saved, ...fresh };
      return { item, index, fresh: freshEntry, isNew: latest !== null && baseline !== null && latest > baseline && latest > watched };
    });
    if (changed) {
      try { localStorage.setItem(baselineStorageKey, JSON.stringify(baselines)); } catch {}
    }
    return rows;
  }

  async function recent(provider, pages = 1) {
    const key = provider + ':' + pages, previous = cache.get(key);
    if (previous && Date.now() - previous.time < 5 * 60 * 1000) return previous.promise;
    const promise = (async () => {
      const items = new Map(); let offset = 0, message = '';
      for (let page = 0; page < pages; page++) {
        const result = await window.lilac.catalogUpdates(provider, offset);
        message = result.note || '';
        const before = items.size;
        for (const item of result.data || []) if (!items.has(String(item.mal_id))) items.set(String(item.mal_id), item);
        if (result.done || result.nextOffset == null || result.nextOffset === offset || items.size === before) break;
        offset = result.nextOffset;
      }
      return { items: [...items.values()], note: message };
    })();
    const entry = { time: Date.now(), promise }; cache.set(key, entry);
    try { return await promise; }
    catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
  }

  function homeItems() {
    return QUARTER_PROVIDERS.includes(state.source) ? (state.quarterShows || []) : (state.current || state.season || []);
  }

  function renderHome() {
    const request = ++homeRequest, quarterSource = QUARTER_PROVIDERS.includes(state.source);
    const seasonButton = $('#homeOrder [data-order="season"]');
    seasonButton.textContent = quarterSource ? '선택한 분기' : '이번 시즌';
    $('#homeOrder').classList.toggle('hidden', !supported.includes(state.source));
    select('#homeOrder', homeOrder);
    if (homeOrder === 'season') {
      $('#seasonTitle').textContent = quarterSource
        ? (state.quarterSelection?.label || state.currentLabel || '선택한 분기')
        : '이번 시즌 신작';
      note('#homeOrderNote', '');
      const items = homeItems();
      $('#seasonRail').closest('.content-section').classList.toggle('hidden', !quarterSource && !items.length);
      renderCards('#seasonRail', items.slice(0, 30));
      return;
    }

    $('#seasonTitle').textContent = '최근 업데이트';
    note('#homeOrderNote', '새 회차 목록을 불러오는 중…');
    $('#seasonRail').closest('.content-section').classList.remove('hidden');
    $('#seasonRail').replaceChildren();
    return recent(state.source).then(result => {
      if (request !== homeRequest || homeOrder !== 'updated') return;
      renderCards('#seasonRail', result.items.slice(0, 30));
      note('#homeOrderNote', result.items.length ? result.note : '최근 업데이트된 회차가 없습니다.');
    }).catch(error => {
      if (request === homeRequest) note('#homeOrderNote', '목록을 불러오지 못했습니다: ' + error.message);
    });
  }

  let libraryItems = new Map();
  function drawLibrary() {
    const list = reconcileLibraryUpdates([...libraryItems.values()]);
    list.forEach(entry => { if (entry.isNew) entry.item.libraryUpdateNew = true; });
    if (libraryOrder === 'updated') list.sort((a, b) => {
      if (Boolean(a.fresh) !== Boolean(b.fresh)) return a.fresh ? -1 : 1;
      if (!a.fresh) return a.index - b.index;
      const timeA = Date.parse(a.item.updatedAt), timeB = Date.parse(b.item.updatedAt);
      if (Number.isFinite(timeA) !== Number.isFinite(timeB)) return Number.isFinite(timeA) ? -1 : 1;
      if (Number.isFinite(timeA)) return timeB - timeA || a.index - b.index;
      if (a.item.provider !== b.item.provider) return String(a.item.provider || '').localeCompare(String(b.item.provider || ''));
      return a.fresh.rank - b.fresh.rank || a.index - b.index;
    });
    renderCards('#libraryGrid', list.map(entry => entry.item));
  }

  async function renderLibrary() {
    const request = ++libraryRequest;
    select('#libraryOrder', libraryOrder);
    drawLibrary();
    if (!$('#libraryView').classList.contains('active')) { note('#libraryOrderNote', ''); return; }
    const providers = [...new Set(state.library.map(item => item.provider))];
    const available = providers.filter(provider => supported.includes(provider));
    if (!state.library.length || !available.length) { note('#libraryOrderNote', ''); return; }
    if (libraryOrder === 'updated') note('#libraryOrderNote', '저장한 작품의 최근 회차 목록을 확인하는 중…');
    const results = await Promise.allSettled(available.map(async provider => ({ provider, ...(await recent(provider, 8)) })));
    if (request !== libraryRequest) return;
    libraryItems = new Map(); const failures = [];
    results.forEach((result, at) => {
      if (result.status === 'rejected') failures.push(SOURCE_LABELS[available[at]] || available[at]);
      else result.value.items.forEach((item, rank) => libraryItems.set(String(item.mal_id), { item, rank }));
    });
    drawLibrary();
    if (libraryOrder !== 'updated') { note('#libraryOrderNote', ''); return; }
    const unsupported = providers.filter(provider => !supported.includes(provider)).map(provider => SOURCE_LABELS[provider] || '기타 소스');
    note('#libraryOrderNote', '소스별 최근 회차 목록에 있는 작품을 먼저 표시합니다. 목록 밖 작품은 저장순을 유지합니다.'
      + (unsupported.length ? ' ' + unsupported.join('·') + ': 업데이트순 미지원.' : '')
      + (failures.length ? ' ' + failures.join('·') + ': 목록을 불러오지 못했습니다.' : ''));
  }

  $$('#homeOrder button').forEach(button => button.onclick = () => {
    homeOrder = button.dataset.order;
    return renderHome();
  });
  $$('#libraryOrder button').forEach(button => button.onclick = () => {
    libraryOrder = button.dataset.order;
    return renderLibrary();
  });

  $('#seeAllSeason').onclick = () => {
    if (homeOrder === 'season') {
      const quarter = QUARTER_PROVIDERS.includes(state.source);
      showHomeList(homeItems(), quarter ? (state.quarterSelection?.label || '분기별 작품') : '이번 시즌 신작');
      return;
    }
    try { localStorage.setItem('allSort:' + state.source, 'updated'); } catch {}
    $('#catalogFilterReset').click();
    switchView('all');
  };

  function markEpisodeSeen(anime, episode) {
    if (!anime || !state.library.some(item => String(item.mal_id) === String(anime.mal_id) && item.provider === anime.provider)) return;
    saveBaseline(anime, episodeNumber(episode));
  }

  function forgetAnime(anime) { forgetBaseline(anime); }

  return { renderHome, renderLibrary, markEpisodeSeen, forgetAnime };
})();
