(function installLilacPatch0102(root) {
  'use strict';
  const api = root?.lilac, core = root?.LilacPatchStage2Core, schedule = root?.LilacWeekdaySchedule;
  const integrated = root?.LilacIntegratedSearch, manual = root?.LilacManualSubtitle;
  if (!api || !core || !schedule || !integrated || !manual || typeof renderCards !== 'function') return;

  const $ = selector => document.querySelector(selector);
  const LABELS = Object.freeze({ reanime: 'Re:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkkf: 'Linkkf' });
  const QUARTER_PROVIDERS = ['reanime', 'miruro', 'animenosub'];
  const DAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];
  const QUARTER_KEY = 'lilacPatch0102.quarter.v1';
  const QUARTER_CACHE_PREFIX = 'lilacPatch0102.catalog.v1:';
  const WEEK_CACHE_PREFIX = 'lilacPatch0102.week.v1:';
  const WEEKDAY_NAMES = Object.freeze({ checking: '확인 중', playable: '재생 가능', provided: '제공 확인', missing: '미제공', failed: '확인 실패' });
  const state = {
    selection: core.readQuarterSelection(localStorage.getItem(QUARTER_KEY)),
    quarterLists: Object.create(null), quarterItems: [], catalogReady: false, days: Array.from({ length: 7 }, () => []),
    selectedDay: (new Date().getDay() + 6) % 7, catalogRequest: 0, scheduleRequest: 0,
    detailRequest: 0, selectedAnime: null, activePicker: null, renderOwned: false,
    cardItems: new WeakMap(), sourceCache: new Map(), sourceFlight: new Map(), linkkfFlight: null,
    sourceFailures: [], lastCalendar: '', lastLocalDate: ''
  };
  const nativeRenderCards = renderCards;
  const nativeOpenDetail = openDetail;
  const nativeAnimeById = animeById;

  function quarterLabel(year, quarter) { return `${year}년 ${quarter}분기`; }
  function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function selectionCalendarKey(date = new Date()) {
    const current = core.currentQuarter(date);
    return `${current.year}:${current.quarter}`;
  }
  function saveSelection() {
    state.selection = core.saveQuarterSelection(state.selection.year, state.selection.quarter);
    try { localStorage.setItem(QUARTER_KEY, JSON.stringify(state.selection)); } catch {}
  }
  function setText(node, text) { if (node) node.textContent = String(text || ''); }
  function localStorageGet(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
  function localStorageSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function quarterCacheKey(year, quarter) { return `${QUARTER_CACHE_PREFIX}${year}:${quarter}`; }

  function mountQuarterControls() {
    const title = $('#seasonTitle'), rail = $('#seasonRail');
    if (!title || !rail || $('#patch0102QuarterControls')) return;
    const section = rail.closest('.content-section');
    const controls = document.createElement('div');
    controls.id = 'patch0102QuarterControls';
    controls.className = 'patch0102-quarter-controls';
    controls.innerHTML = '<label>분기 <input id="patch0102QuarterYear" type="number" min="1960" inputmode="numeric" aria-label="연도"></label><select id="patch0102QuarterNumber" aria-label="분기"><option value="1">1분기</option><option value="2">2분기</option><option value="3">3분기</option><option value="4">4분기</option></select><button id="patch0102QuarterRetry" type="button" class="text-btn">새로고침</button><p id="patch0102QuarterStatus" role="status"></p>';
    section.querySelector('.section-title').after(controls);
    const year = $('#patch0102QuarterYear'), quarter = $('#patch0102QuarterNumber');
    year.max = String(new Date().getFullYear());
    year.value = String(state.selection.year); quarter.value = String(state.selection.quarter);
    const change = () => {
      const next = core.saveQuarterSelection(year.value, quarter.value);
      state.selection = next; saveSelection(); renderQuarterHeading(); void loadQuarterCatalog(true);
    };
    year.addEventListener('change', change); quarter.addEventListener('change', change);
    $('#patch0102QuarterRetry').addEventListener('click', () => { void loadQuarterCatalog(true); void loadWeekdaySchedule(true); });
    renderQuarterHeading();
  }

  function renderQuarterHeading() {
    const title = $('#seasonTitle'), year = $('#patch0102QuarterYear'), quarter = $('#patch0102QuarterNumber');
    if (title) title.textContent = `${quarterLabel(state.selection.year, state.selection.quarter)} 신작`;
    if (year && Number(year.value) !== state.selection.year) year.value = String(state.selection.year);
    if (quarter && Number(quarter.value) !== state.selection.quarter) quarter.value = String(state.selection.quarter);
  }

  function providerStatusText(failures, resultCount) {
    if (!resultCount) return failures.length ? `목록 조회 실패: ${failures.join(', ')}` : '목록에 표시할 작품이 없습니다.';
    return failures.length ? `${failures.join(', ')} 목록 조회 실패 · 나머지 출처는 표시 중` : `${resultCount}개 작품 · 3개 출처 통합`;
  }

  function attachCardItems(rail, items) {
    const cards = rail?.querySelectorAll('.anime-card') || [];
    cards.forEach((card, index) => {
      const item = items[index];
      if (!item) return;
      state.cardItems.set(card, item);
      if (item.patchSources?.length > 1) {
        const line = card.querySelector('p');
        if (line && !line.querySelector('.patch0102-source-count')) {
          const note = document.createElement('small');
          note.className = 'patch0102-source-count';
          note.textContent = `${item.patchSources.length}개 출처`;
          line.append(' · ', note);
        }
      }
    });
  }

  function renderQuarterCards() {
    const rail = $('#seasonRail');
    if (!rail || !state.catalogReady) return;
    if (!state.quarterItems.length) {
      state.renderOwned = true;
      try { rail.innerHTML = '<p class="rail-empty">선택한 분기에서 확인된 작품이 없습니다.</p>'; }
      finally { state.renderOwned = false; }
      return;
    }
    state.renderOwned = true;
    try { nativeRenderCards('#seasonRail', state.quarterItems.slice(0, 40)); }
    finally { state.renderOwned = false; }
    attachCardItems(rail, state.quarterItems.slice(0, 40));
  }

  function setQuarterStatus(text, failed = false) {
    const status = $('#patch0102QuarterStatus');
    if (!status) return;
    status.textContent = text;
    status.dataset.state = failed ? 'failed' : 'ok';
  }

  function mergeCatalogs(catalogs) {
    return core.mergeQuarterCatalogs(catalogs, schedule.matchesScheduledWork);
  }

  async function loadQuarterCatalog(force = false) {
    const { year, quarter } = state.selection, request = ++state.catalogRequest;
    renderQuarterHeading();
    const cacheKey = quarterCacheKey(year, quarter), cached = localStorageGet(cacheKey);
    if (!force && cached?.catalogs && Date.now() - Number(cached.savedAt || 0) < 30 * 60 * 1000) {
      state.quarterLists = cached.catalogs; state.quarterItems = mergeCatalogs(cached.catalogs);
      state.catalogReady = true;
      renderQuarterCards(); setQuarterStatus(providerStatusText(cached.failures || [], state.quarterItems.length));
      void loadWeekdaySchedule(false);
      return state.quarterItems;
    }
    if (cached?.catalogs) {
      state.quarterLists = cached.catalogs; state.quarterItems = mergeCatalogs(cached.catalogs); state.catalogReady = true; renderQuarterCards();
      setQuarterStatus('저장한 목록을 표시하고 최신 정보를 확인하는 중…');
    } else {
      setQuarterStatus(`${quarterLabel(year, quarter)} 목록을 불러오는 중…`);
    }
    const settled = await Promise.all(QUARTER_PROVIDERS.map(async provider => {
      try {
        const result = await api.patchQuarter(provider, year, quarter);
        return { provider, data: Array.isArray(result?.data) ? result.data : [], error: '' };
      } catch (error) { return { provider, data: [], error: `${LABELS[provider]} (${error?.message || '조회 실패'})` }; }
    }));
    if (request !== state.catalogRequest || year !== state.selection.year || quarter !== state.selection.quarter) return state.quarterItems;
    const catalogs = Object.fromEntries(settled.map(entry => [entry.provider, entry.data]));
    const failures = settled.filter(entry => entry.error).map(entry => entry.error);
    const fresh = mergeCatalogs(catalogs);
    if (fresh.length || !cached?.catalogs) {
      state.quarterLists = catalogs; state.quarterItems = fresh;
      localStorageSet(cacheKey, { savedAt: Date.now(), catalogs, failures });
      state.catalogReady = true; renderQuarterCards();
    }
    setQuarterStatus(providerStatusText(failures, state.quarterItems.length), failures.length > 0);
    void loadWeekdaySchedule(false);
    return state.quarterItems;
  }

  function quarterCatalogFromCache(year, quarter) {
    const cached = localStorageGet(quarterCacheKey(year, quarter));
    return cached?.catalogs ? cached.catalogs : null;
  }

  async function catalogForSchedule(year, quarter) {
    if (year === state.selection.year && quarter === state.selection.quarter && Object.keys(state.quarterLists).length) return state.quarterLists;
    const cached = quarterCatalogFromCache(year, quarter);
    if (cached) return cached;
    const rows = await Promise.all(QUARTER_PROVIDERS.map(async provider => {
      try { return [provider, (await api.patchQuarter(provider, year, quarter))?.data || []]; }
      catch { return [provider, []]; }
    }));
    const catalogs = Object.fromEntries(rows);
    localStorageSet(quarterCacheKey(year, quarter), { savedAt: Date.now(), catalogs, failures: [] });
    return catalogs;
  }

  function mountScheduleTabs() {
    const section = $('#scheduleSection'), tabs = $('#scheduleTabs');
    if (!section || !tabs) return;
    section.classList.remove('hidden');
    tabs.replaceChildren(...DAY_LABELS.map((label, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.setAttribute('role', 'tab'); button.textContent = label;
      button.addEventListener('click', () => { state.selectedDay = index; renderWeekdayTab(); });
      return button;
    }));
    let status = $('#patch0102WeekStatus');
    if (!status) { status = document.createElement('p'); status.id = 'patch0102WeekStatus'; status.className = 'patch0102-week-status'; status.setAttribute('role', 'status'); tabs.after(status); }
  }

  function renderWeekdayTab() {
    const tabs = $('#scheduleTabs'), rail = $('#scheduleRail'), status = $('#patch0102WeekStatus');
    if (!tabs || !rail) return;
    [...tabs.querySelectorAll('button')].forEach((button, index) => {
      const selected = index === state.selectedDay;
      button.classList.toggle('selected', selected); button.setAttribute('aria-selected', String(selected));
      if (index === (new Date().getDay() + 6) % 7) button.dataset.today = 'true'; else delete button.dataset.today;
    });
    const items = state.days[state.selectedDay] || [];
    if (items.length) {
      state.renderOwned = true;
      try { nativeRenderCards('#scheduleRail', items.slice(0, 30)); }
      finally { state.renderOwned = false; }
      attachCardItems(rail, items.slice(0, 30));
    } else {
      rail.classList.remove('loading-cards');
      rail.innerHTML = '<p class="rail-empty">이 요일에 확인된 방영 작품이 없습니다.</p>';
    }
    if (status) status.textContent = state.sourceFailures.length
      ? `확인 실패: ${state.sourceFailures.join(', ')} · 저장 정보가 있으면 함께 표시합니다.`
      : 'Linkkf 등록 일정과 Re:Anime·Miruro의 AniList 방영 일정을 합쳤습니다. 다른 출처의 방영일은 임의로 추가하지 않습니다.';
  }

  function weekCacheKey(date) { return `${WEEK_CACHE_PREFIX}${localDateKey(date)}`; }

  async function getLinkkfSchedule() {
    if (state.linkkfFlight) return state.linkkfFlight;
    state.linkkfFlight = api.linkkfSchedule().finally(() => { state.linkkfFlight = null; });
    return state.linkkfFlight;
  }

  async function loadWeekdaySchedule(force = false) {
    const date = new Date(), request = ++state.scheduleRequest, cached = localStorageGet(weekCacheKey(date));
    if (!force && cached?.days && Date.now() - Number(cached.savedAt || 0) < 30 * 60 * 1000) {
      state.days = cached.days; state.sourceFailures = cached.failures || []; renderWeekdayTab(); return state.days;
    }
    if (cached?.days) { state.days = cached.days; state.sourceFailures = cached.failures || []; renderWeekdayTab(); }
    else { state.days = Array.from({ length: 7 }, () => []); renderWeekdayTab(); }
    const current = core.currentQuarter(date);
    const [linkkfResult, catalogs, reAiring, mirAiring] = await Promise.allSettled([
      getLinkkfSchedule(), catalogForSchedule(current.year, current.quarter),
      api.providerAiring('reanime'), api.providerAiring('miruro')
    ]);
    if (request !== state.scheduleRequest) return state.days;
    const failures = [];
    const linkkfDays = linkkfResult.status === 'fulfilled' && Array.isArray(linkkfResult.value) ? linkkfResult.value : [];
    if (linkkfResult.status === 'rejected') failures.push('Linkkf');
    if (catalogs.status === 'rejected') failures.push('분기 목록');
    if (reAiring.status === 'rejected') failures.push('Re:Anime 방영 일정');
    if (mirAiring.status === 'rejected') failures.push('Miruro 방영 일정');
    const candidates = [
      ...(catalogs.status === 'fulfilled' ? QUARTER_PROVIDERS.flatMap(provider => catalogs.value?.[provider] || []) : []),
      ...(reAiring.status === 'fulfilled' ? reAiring.value?.data || [] : []),
      ...(mirAiring.status === 'fulfilled' ? mirAiring.value?.data || [] : [])
    ];
    const upcoming = [];
    for (const provider of ['reanime', 'miruro']) {
      const result = await api.patchWeekdayEpisodes(provider, candidates.filter(item => item.provider === provider)).catch(error => {
        failures.push(`${LABELS[provider]} AniList`); return { data: [], error };
      });
      upcoming.push(...(Array.isArray(result?.data) ? result.data : []));
    }
    if (request !== state.scheduleRequest) return state.days;
    const days = schedule.mergeWeekdaySchedules(linkkfDays, upcoming);
    if (days.some(day => day.length) || !cached?.days) {
      state.days = days; state.sourceFailures = failures;
      localStorageSet(weekCacheKey(date), { savedAt: Date.now(), days, failures });
    } else if (failures.length) state.sourceFailures = failures;
    renderWeekdayTab();
    return state.days;
  }

  function sourceSearchKey(anime, episode) {
    return `${anime?.anilistId || ''}|${anime?.title || ''}|${anime?.year || ''}|${anime?.type || ''}|${Number(episode) || 0}`;
  }

  function normalizedLinkkfEpisodes(servers) {
    return (Array.isArray(servers) ? servers : []).flatMap(server => server.episodes || []).map(episode => {
      const label = String(episode.name || episode.title || ''), match = label.match(/(?:^|\D)(\d+(?:\.\d+)?)(?:\s*화|\D|$)/);
      return { ...episode, number: Number(episode.number ?? episode.episode ?? match?.[1]) || 0 };
    }).filter(episode => episode.number > 0);
  }

  async function querySourceCandidates(anime) {
    const terms = [anime.title_japanese, anime.title_english, anime.romaji].filter(value => value && value !== anime.title).slice(0, 2);
    return integrated.searchProviders({
      providers: schedule.PROVIDERS, query: anime.title || anime.title_english || anime.title_japanese || '', terms, concurrency: 3,
      search: (provider, text) => provider === 'linkkf' ? api.linkkfSearch(text) : api.providerCatalog(provider, text),
      localSearch: (provider, text) => /[가-힣]/.test(text) && ['reanime', 'animenosub'].includes(provider)
        ? api.catalogKoreanSearch(provider, text) : null
    });
  }

  async function inspectEpisodeForProvider(provider, item, targetEpisode) {
    let episodes;
    if (provider === 'linkkf') episodes = normalizedLinkkfEpisodes(await api.linkkfEpisodes(item.id));
    else {
      const detail = await api.providerDetail(item);
      if (detail?.unavailable) return 'missing';
      if (!Array.isArray(detail?.episodes)) throw new Error('회차 목록을 받지 못했습니다.');
      episodes = detail.episodes;
    }
    return schedule.episodeAvailability(episodes, targetEpisode);
  }

  function initialAvailability(searchStatus, hasMatch) {
    return schedule.providerFallbackState(searchStatus, hasMatch);
  }

  function renderSourcePicker(pickerState) {
    const detail = $('#detailContent'), episodeBlock = $('#episodeBlock');
    if (!detail || !episodeBlock || state.activePicker !== pickerState) return;
    detail.querySelector('#patch0102SourcePicker')?.remove();
    const section = document.createElement('section');
    section.id = 'patch0102SourcePicker'; section.className = 'patch0102-source-picker';
    section.setAttribute('aria-label', '공급원별 회차 확인');
    const heading = document.createElement('b');
    heading.textContent = pickerState.episode ? `출처 · ${pickerState.episode}화 기준` : '출처 · 같은 시즌 작품 확인';
    section.append(heading);
    const note = document.createElement('small');
    note.textContent = pickerState.episode ? '회차 목록 확인 결과입니다. 실제 영상 주소 검증은 아직 하지 않았습니다.' : '회차 번호를 확인할 수 없어 작품·시즌 일치만 표시합니다.';
    section.append(note);
    const rows = document.createElement('div'); rows.className = 'patch0102-source-rows';
    for (const provider of schedule.PROVIDERS) {
      const candidate = pickerState.items.find(item => item.provider === provider);
      const stateName = pickerState.values[provider] || 'checking';
      if (candidate) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.provider = provider;
        button.setAttribute('aria-pressed', String(candidate.mal_id === pickerState.activeId));
        const name = document.createElement('span'); name.textContent = LABELS[provider];
        const status = document.createElement('small'); status.textContent = WEEKDAY_NAMES[stateName] || '확인 중';
        button.append(name, status);
        button.addEventListener('click', async () => {
          state.selectedAnime = candidate;
          const id = String(candidate.mal_id);
          if (id) knownAnime.set(id, candidate);
          pickerState.anime = candidate;
          pickerState.activeId = candidate.mal_id;
          state.activePicker = pickerState;
          await nativeOpenDetail(candidate.mal_id);
          renderSourcePicker(pickerState);
        });
        rows.append(button);
      } else {
        const row = document.createElement('div'); row.className = 'patch0102-source-row';
        const name = document.createElement('span'); name.textContent = LABELS[provider];
        const status = document.createElement('small'); status.textContent = WEEKDAY_NAMES[stateName] || '확인 중';
        row.append(name, status); rows.append(row);
      }
    }
    section.append(rows);
    episodeBlock.before(section);
  }

  async function checkSourceAvailability(anime, pickerState, cacheKey, request) {
    const searchPromise = querySourceCandidates(anime);
    const statusRows = schedule.PROVIDERS.map(provider => ({ provider, state: 'checking', resultCount: 0 }));
    pickerState.values = Object.fromEntries(statusRows.map(row => [row.provider, row.state]));
    renderSourcePicker(pickerState);
    let result;
    try { result = await searchPromise; }
    catch {
      if (request !== state.detailRequest) return;
      pickerState.values = Object.fromEntries(schedule.PROVIDERS.map(provider => [provider, 'failed']));
      renderSourcePicker(pickerState); return;
    }
    if (request !== state.detailRequest) return;
    const items = schedule.combineScheduledSources(anime, result.items || []);
    if (!items.some(item => item.provider === anime.provider)) items.unshift(anime);
    const statuses = new Map((result.statuses || []).map(row => [row.provider, row]));
    pickerState.items = items;
    pickerState.values = Object.fromEntries(schedule.PROVIDERS.map(provider => {
      const candidate = items.find(item => item.provider === provider);
      return [provider, candidate ? (pickerState.episode ? 'checking' : 'provided') : initialAvailability(statuses.get(provider), false)];
    }));
    pickerState.activeId = anime.mal_id;
    renderSourcePicker(pickerState);
    if (!pickerState.episode) { state.sourceCache.set(cacheKey, { savedAt: Date.now(), pickerState }); return; }

    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++], provider = item.provider;
        try { pickerState.values[provider] = await inspectEpisodeForProvider(provider, item, pickerState.episode); }
        catch { pickerState.values[provider] = 'failed'; }
        if (request !== state.detailRequest) return;
        renderSourcePicker(pickerState);
      }
    }));
    state.sourceCache.set(cacheKey, { savedAt: Date.now(), pickerState });
    while (state.sourceCache.size > 100) state.sourceCache.delete(state.sourceCache.keys().next().value);
  }

  async function openPatchedDetail(anime) {
    if (!anime?.mal_id) return;
    state.selectedAnime = anime;
    knownAnime.set(String(anime.mal_id), anime);
    const request = ++state.detailRequest;
    await nativeOpenDetail(anime.mal_id);
    if (request !== state.detailRequest || !$('#detailDialog')?.open) return;
    const episode = Number(anime.weekdayEpisodeNumber) || 0;
    const cacheKey = sourceSearchKey(anime, episode), cached = state.sourceCache.get(cacheKey);
    const pickerState = { anime, episode, items: anime.patchSourceItems || [anime], values: {}, activeId: anime.mal_id };
    state.activePicker = pickerState;
    if (cached && Date.now() - cached.savedAt < 30 * 60 * 1000) {
      Object.assign(pickerState, cached.pickerState); state.activePicker = pickerState; renderSourcePicker(pickerState); return;
    }
    const running = state.sourceFlight.get(cacheKey);
    if (running) { await running; return; }
    const promise = checkSourceAvailability(anime, pickerState, cacheKey, request);
    state.sourceFlight.set(cacheKey, promise);
    try { await promise; } finally { if (state.sourceFlight.get(cacheKey) === promise) state.sourceFlight.delete(cacheKey); }
  }

  function installCardHandlers(rail) {
    if (!rail || rail.dataset.patch0102Bound === 'true') return;
    rail.dataset.patch0102Bound = 'true';
    rail.addEventListener('click', event => {
      const card = event.target.closest('.anime-card');
      if (!card || event.target.closest('.heart')) return;
      const anime = state.cardItems.get(card);
      if (!anime || (!anime.patchQuarter && !anime.weekdaySchedule)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      void openPatchedDetail(anime);
    }, true);
    rail.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return;
      const card = event.target.closest('.anime-card'), anime = card && state.cardItems.get(card);
      if (!anime || (!anime.patchQuarter && !anime.weekdaySchedule)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      void openPatchedDetail(anime);
    }, true);
  }

  function manualAvailable() { return Boolean(currentSubtitle?.path && currentSubtitle?.src); }
  function addManualTranslationUi() {
    const target = $('#subtitleTranslateRow');
    if (!target || $('#patch0102ManualRow')) return;
    const row = document.createElement('div'); row.id = 'patch0102ManualRow'; row.className = 'sheet-button-row';
    const button = document.createElement('button'); button.id = 'patch0102ManualStart'; button.type = 'button'; button.className = 'sheet-button'; button.textContent = 'ChatGPT 수동 번역';
    row.append(button);
    const panel = document.createElement('div'); panel.id = 'patch0102ManualPanel'; panel.className = 'patch0102-manual-panel hidden';
    panel.innerHTML = '<p id="patch0102ManualStatus" role="status">선택한 자막의 번역을 준비합니다.</p><div class="patch0102-manual-actions"><button id="patch0102ManualCopy" type="button">요청 복사 · ChatGPT 열기</button><button id="patch0102ManualApply" type="button">결과 확인</button><button id="patch0102ManualCancel" type="button">취소</button></div><textarea id="patch0102ManualAnswer" rows="6" spellcheck="false" placeholder="ChatGPT의 JSON 번역 결과를 붙여넣으세요"></textarea>';
    target.after(row, panel);
    const setStatus = text => setText($('#patch0102ManualStatus'), text);
    let translation = null, open = false, sequence = 0;
    const current = value => Boolean(value && value === translation && value.playbackId === playbackRequestId &&
      value.subtitle === currentSubtitle && value.episodeKey === subtitleStoreKey());
    const render = () => {
      row.classList.toggle('hidden', !manualAvailable() && !translation);
      panel.classList.toggle('hidden', !open || !translation);
      $('#patch0102ManualStart').textContent = translation ? 'ChatGPT 번역 계속' : 'ChatGPT 수동 번역';
      if (!translation) return;
      const saving = translation.index >= translation.batches.length;
      setText($('#patch0102ManualStatus'), translation.message || (saving ? '번역 결과를 저장할 수 있습니다.' : `묶음 ${translation.index + 1}/${translation.batches.length}`));
      $('#patch0102ManualCopy').disabled = translation.busy || saving;
      $('#patch0102ManualApply').disabled = translation.busy;
      $('#patch0102ManualApply').textContent = saving ? '번역 자막 저장' : '결과 확인';
      $('#patch0102ManualAnswer').disabled = translation.busy || saving;
    };
    const start = async () => {
      if (translation && current(translation)) { open = true; render(); return; }
      const subtitle = currentSubtitle;
      if (!manualAvailable()) { setStatus('번역할 자막 파일이 없습니다. 먼저 영어 또는 일본어 자막을 선택해 주세요.'); open = true; row.classList.remove('hidden'); panel.classList.remove('hidden'); return; }
      const id = ++sequence, playbackId = playbackRequestId;
      button.disabled = true; button.textContent = '자막을 준비하는 중…'; row.classList.remove('hidden');
      try {
        const response = await fetch(subtitle.src);
        if (!response.ok) throw new Error(`자막 파일을 읽지 못했습니다 (HTTP ${response.status}).`);
        const parsed = manual.parseWebVtt(await response.text());
        const text = parsed.cues.map(cue => cue.text).join('\n');
        if (/[가-힣]/.test(text) && !/[ぁ-ヿA-Za-z]/.test(text)) throw new Error('이미 한국어인 자막은 ChatGPT 번역 대상에서 제외했습니다.');
        const batches = manual.makeBatches(parsed.cues);
        if (!batches.length) throw new Error('번역할 문장을 찾지 못했습니다.');
        if (id !== sequence || subtitle !== currentSubtitle || playbackId !== playbackRequestId) return;
        translation = { id, subtitle, sourcePath: subtitle.path, sourceLabel: subtitle.label || '원본 자막', episodeKey: subtitleStoreKey(), playbackId,
          title: currentPlaybackContext.subtitleTitle || $('#skipTitle')?.value.trim() || $('#playerTitle')?.textContent || '',
          episode: Number($('#skipEpisode')?.value) || Number(currentPlaybackContext.episode?.number) || 1,
          parsed, batches, index: 0, translations: {}, busy: false, message: '요청을 복사해 ChatGPT에 직접 붙여넣으세요.' };
        open = true; $('#patch0102ManualAnswer').value = ''; render();
      } catch (error) {
        open = true; row.classList.remove('hidden'); panel.classList.remove('hidden'); setStatus(error.message);
      } finally { button.disabled = false; if (!translation) button.textContent = 'ChatGPT 수동 번역'; }
    };
    const copyPrompt = async () => {
      const value = translation; if (!current(value)) return;
      const batch = value.batches[value.index]; if (!batch) return;
      const language = manual.detectSourceLanguage(value.parsed.cues);
      let instructions;
      try { instructions = await api.patchTranslationPrompt(language); }
      catch (error) { setStatus(`번역 지침을 불러오지 못했습니다: ${error.message}`); return; }
      if (!current(value)) return;
      const indexes = batch.map(item => value.parsed.cues.findIndex(cue => cue.id === item.id)).filter(index => index >= 0);
      const first = Math.min(...indexes), last = Math.max(...indexes);
      const prompt = manual.makePrompt({
        title: value.title, episode: value.episode, items: batch,
        contextBefore: value.parsed.cues.slice(Math.max(0, first - 2), first).map(cue => ({ id: cue.id, text: cue.text })),
        contextAfter: value.parsed.cues.slice(last + 1, last + 3).map(cue => ({ id: cue.id, text: cue.text })),
        translationInstructions: instructions, sourceLanguage: language
      });
      try {
        await api.patchCopyText(prompt);
        try { await api.openExternal('https://chatgpt.com/'); value.message = '요청을 복사하고 ChatGPT를 열었습니다. 브라우저에서 붙여넣어 직접 보내세요.'; }
        catch { value.message = '요청을 복사했습니다. ChatGPT를 열어 직접 붙여넣으세요.'; }
      } catch (error) { value.message = `복사하지 못했습니다: ${error.message}`; }
      render();
    };
    const save = async value => {
      if (!current(value) || value.busy) return;
      value.busy = true; value.message = '번역 자막을 저장하고 적용하는 중…'; render();
      try {
        const text = manual.renderWebVtt(value.parsed, value.translations);
        const result = await api.patchSaveManualSubtitle({ key: value.episodeKey, text, from: value.sourcePath, fromName: value.sourceLabel });
        if (!current(value)) return;
        translation = null; open = false; currentSubtitlePath = result.path;
        attachSubtitle(result.url, 'ChatGPT 수동 번역', { path: result.path, source: 'chatgpt', from: value.sourcePath, fromName: value.sourceLabel, saved: true });
        $('#subtitleState').textContent = 'ChatGPT 수동 번역을 적용했습니다.'; render();
      } catch (error) { value.busy = false; value.message = `저장하지 못했습니다: ${error.message}`; render(); }
    };
    const apply = async () => {
      const value = translation; if (!current(value) || value.busy) return;
      if (value.index >= value.batches.length) return save(value);
      const batch = value.batches[value.index];
      let translated;
      try { translated = manual.parseResponse($('#patch0102ManualAnswer').value, batch.map(item => item.id)); }
      catch (error) { setStatus(error.message); return; }
      Object.assign(value.translations, translated); value.index++; $('#patch0102ManualAnswer').value = '';
      value.message = value.index < value.batches.length ? `확인 완료. 다음 묶음 ${value.index + 1}/${value.batches.length} 요청을 복사해 주세요.` : '번역 결과를 저장할 수 있습니다.';
      render(); if (value.index >= value.batches.length) await save(value);
    };
    button.addEventListener('click', start);
    $('#patch0102ManualCopy').addEventListener('click', copyPrompt);
    $('#patch0102ManualApply').addEventListener('click', apply);
    $('#patch0102ManualCancel').addEventListener('click', () => { sequence++; translation = null; open = false; $('#patch0102ManualAnswer').value = ''; render(); });
    render();

    const originalAttach = attachSubtitle;
    if (typeof originalAttach === 'function') {
      window.attachSubtitle = function (...args) { const result = originalAttach(...args); queueMicrotask(render); return result; };
    }
    const originalClear = clearSubtitle;
    if (typeof originalClear === 'function') {
      window.clearSubtitle = function (...args) { const result = originalClear(...args); translation = null; open = false; sequence++; queueMicrotask(render); return result; };
    }
    window.addEventListener('lilac-subtitle-changed', render);
  }

  function addStyles() {
    if ($('#patch0102Styles')) return;
    const style = document.createElement('style'); style.id = 'patch0102Styles';
    style.textContent = `
      #patch0102QuarterControls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 14px;color:var(--muted);font-size:13px}
      #patch0102QuarterControls label{display:flex;align-items:center;gap:6px}
      #patch0102QuarterYear,#patch0102QuarterNumber{min-height:34px;max-width:110px;padding:5px 9px;border:1px solid var(--line);border-radius:var(--ott-radius,10px);background:var(--panel);color:var(--text);font:inherit}
      #patch0102QuarterStatus{flex-basis:100%;margin:0;font-size:12px;color:var(--muted)}
      #patch0102QuarterStatus[data-state="failed"],#patch0102WeekStatus[data-state="failed"]{color:var(--muted)}
      #patch0102WeekStatus{margin:6px 0 12px;color:var(--muted);font-size:12px}
      #scheduleTabs button[data-today="true"]{box-shadow:inset 0 0 0 1px var(--lilac)}
      .patch0102-source-count{font-size:11px;color:var(--muted)}
      .patch0102-source-picker{display:grid;gap:8px;margin:14px 0;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--text)}
      .patch0102-source-picker>small{color:var(--muted);line-height:1.45}
      .patch0102-source-rows{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:7px}
      .patch0102-source-rows button,.patch0102-source-row{display:flex;justify-content:space-between;align-items:center;gap:6px;min-width:0;padding:8px;border:1px solid var(--line);border-radius:var(--ott-radius,10px);background:var(--panel);color:var(--text);font:inherit;text-align:left}
      .patch0102-source-rows button{cursor:pointer}.patch0102-source-rows button[aria-pressed="true"]{border-color:var(--lilac)}
      .patch0102-source-rows small{color:var(--muted);font-size:11px;white-space:nowrap}
      #patch0102ManualRow{margin-top:6px}
      #patch0102ManualPanel{display:grid;gap:8px;padding:10px 0;color:var(--text)}
      #patch0102ManualPanel p{margin:0;color:var(--muted);font-size:12px;line-height:1.45}
      #patch0102ManualAnswer{width:100%;min-height:110px;resize:vertical;padding:9px;border:1px solid var(--line);border-radius:var(--ott-radius,10px);background:var(--panel);color:var(--text);font:inherit}
      .patch0102-manual-actions{display:flex;gap:6px;flex-wrap:wrap}.patch0102-manual-actions button{min-height:32px;padding:6px 9px;border:1px solid var(--line);border-radius:var(--ott-radius,10px);background:var(--panel);color:var(--text);font:inherit;cursor:pointer}
      @media(max-width:560px){#patch0102QuarterControls{gap:6px}.patch0102-source-rows{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.append(style);
  }

  function watchCalendar() {
    const now = new Date(), calendar = selectionCalendarKey(now), day = localDateKey(now);
    if (state.lastCalendar && state.lastCalendar !== calendar) {
      state.selection = core.readQuarterSelection(null, now); saveSelection();
      $('#patch0102QuarterYear').max = String(now.getFullYear());
      renderQuarterHeading(); void loadQuarterCatalog(true); void loadWeekdaySchedule(true);
    } else if (state.lastLocalDate && state.lastLocalDate !== day) {
      state.selectedDay = (now.getDay() + 6) % 7; renderWeekdayTab(); void loadWeekdaySchedule(true);
    }
    state.lastCalendar = calendar; state.lastLocalDate = day;
  }

  function install() {
    if ($('#patch0102QuarterControls')) return;
    // v0.5.14 defaults next-episode autoplay to on. Keep an explicit user choice,
    // while making a fresh patched profile follow the established off-by-default rule.
    try { if (localStorage.getItem('playerAutoPlay') === null) localStorage.setItem('playerAutoPlay', 'false'); } catch {}
    mountQuarterControls(); mountScheduleTabs(); addStyles(); addManualTranslationUi();
    installCardHandlers($('#seasonRail')); installCardHandlers($('#scheduleRail'));
    window.renderCards = function (target, items) {
      const result = nativeRenderCards(target, items);
      if (state.renderOwned) return result;
      if (target === '#seasonRail' && state.catalogReady) renderQuarterCards();
      return result;
    };
    window.animeById = function (id) {
      if (state.selectedAnime && String(state.selectedAnime.mal_id) === String(id)) return state.selectedAnime;
      return nativeAnimeById(id);
    };
    state.lastCalendar = selectionCalendarKey(); state.lastLocalDate = localDateKey();
    saveSelection();
    void loadQuarterCatalog(false); void loadWeekdaySchedule(false);
    window.addEventListener('focus', watchCalendar);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) watchCalendar(); });
    window.setInterval(watchCalendar, 5 * 60 * 1000);
  }

  root.LilacPersistentPatch0102 = Object.freeze({ version: '0.5.14', install, refreshQuarter: () => loadQuarterCatalog(true), refreshWeekday: () => loadWeekdaySchedule(true) });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
})(window);
