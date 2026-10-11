(function installLilacPatch0102(root) {
  'use strict';
  const configured = root?.DinoLilacPatchFeatures;
  const patch01Enabled = configured ? configured['patch-01'] === true : true;
  const patch02Enabled = configured ? configured['patch-02'] === true : true;
  if (!patch01Enabled && !patch02Enabled) return;
  const api = root?.lilac, core = root?.LilacPatchStage2Core, schedule = root?.LilacWeekdaySchedule;
  const integrated = root?.LilacIntegratedSearch, manual = root?.LilacManualSubtitle;
  if (!api ||
      (patch01Enabled && (!core || !schedule || !integrated || typeof root.renderCards !== 'function' ||
        typeof root.openDetail !== 'function' || typeof root.animeById !== 'function')) ||
      (patch02Enabled && !manual)) return;

  const $ = selector => document.querySelector(selector);
  const LABELS = Object.freeze({ reanime: 'Re:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkkf: 'Linkkf' });
  const QUARTER_PROVIDERS = ['reanime', 'miruro', 'animenosub'];
  const DAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];
  const QUARTER_KEY = 'lilacPatch0102.quarter.v1';
  const QUARTER_CACHE_PREFIX = 'lilacPatch0102.catalog.v1:';
  const WEEK_CACHE_PREFIX = 'lilacPatch0102.week.v1:';
  const WEEKDAY_NAMES = Object.freeze({ checking: '확인 중', playable: '재생 가능', provided: '제공 확인', missing: '미제공', failed: '확인 실패' });
  const state = {
    selection: patch01Enabled ? core.readQuarterSelection(localStorage.getItem(QUARTER_KEY)) : null,
    quarterLists: Object.create(null), quarterItems: [], catalogReady: false, days: Array.from({ length: 7 }, () => []),
    selectedDay: (new Date().getDay() + 6) % 7, catalogRequest: 0, scheduleRequest: 0,
    detailRequest: 0, selectedAnime: null, activePicker: null, renderOwned: false,
    cardItems: new WeakMap(), sourceCache: new Map(), sourceFlight: new Map(), linkkfFlight: null,
    sourceFailures: [], lastCalendar: '', lastLocalDate: ''
  };
  const nativeRenderCards = root.renderCards;
  const nativeOpenDetail = root.openDetail;
  const nativeAnimeById = root.animeById;

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
  function addManualTranslationSettings() {
    const pane = $('[data-settings-pane="translate"]');
    if (!pane || $('#patch0102ChatGPTSettings')) return;
    const box = document.createElement('div'); box.id = 'patch0102ChatGPTSettings'; box.className = 'setting-block patch0102-chatgpt-settings';
    box.innerHTML = `<b>ChatGPT 웹 번역</b>
      <p id="patch0102ChatGPTAccountState" role="status">디노 라일락 전용 내장 창에서 ChatGPT를 엽니다. 브라우저 로그인은 사용자가 직접 합니다.</p>
      <div class="setting-block">
        <b>ChatGPT 웹 자동 번역</b>
        <p id="patch0102ChatGPTAutoReason" role="status">실험 기능입니다. 버튼을 누르면 내장 창에서 요청 전송 및 응답 수집을 시도합니다. 로그인은 직접 하며 화면이 바뀌거나 제한이 발생하면 멈춥니다. 실계정 동작은 미검증입니다.</p>
      </div>
      <div class="setting-block">
        <b>번역 완료 후 ChatGPT 대화 삭제</b>
        <p id="patch0102ChatGPTDeleteReason" role="status">이 앱은 ChatGPT 대화 목록을 읽거나 대화를 삭제할 수 없습니다. 번역 자막 저장 후 해당 대화는 ChatGPT에서 직접 정리해 주세요.</p>
        <button id="patch0102ChatGPTDeleteUnavailable" type="button" disabled aria-describedby="patch0102ChatGPTDeleteReason">대화 자동 삭제 · 사용할 수 없음</button>
      </div>
      <div class="patch0102-manual-actions"><button id="patch0102ChatGPTOpen" type="button">내장 ChatGPT 열기</button><button id="patch0102ChatGPTManual" type="button">수동 번역 준비</button><button id="patch0102ChatGPTAutoStart" type="button">웹 자동 번역 (실험)</button></div>
      <label class="setting-switch"><span><b>번역 완료 후 앱 내부 임시 데이터 정리</b><small>이 설정은 번역 작업 임시 데이터만 정리합니다. 저장된 한국어 자막과 ChatGPT 웹 대화에는 영향을 주지 않습니다.</small></span><input id="patch0102ChatGPTCleanupEnabled" type="checkbox" checked></label>
      <label>정리 시점 <select id="patch0102ChatGPTCleanupTiming"><option value="immediate">즉시</option><option value="five-minutes">5분 뒤</option><option value="on-close">앱을 닫을 때</option></select></label>`;
    pane.append(box);
    const autoChoices = $('#jimakuTranslateChoices');
    if (autoChoices && !$('#patch0102ChatGPTAutoUnavailable')) {
      const choice = document.createElement('button'); choice.id = 'patch0102ChatGPTAutoUnavailable'; choice.type = 'button';
      choice.textContent = 'ChatGPT 웹 자동 번역 (실험)';
      choice.setAttribute('aria-describedby', 'patch0102ChatGPTAutoReason');
      choice.addEventListener('click', () => $('#patch0102WebAutoStart')?.click());
      autoChoices.append(choice);
    }
    Promise.resolve(api.patchManualTranslationSettings?.() || { autoCleanup: true, cleanupTiming: 'immediate' }).then(value => {
      $('#patch0102ChatGPTCleanupEnabled').checked = value?.autoCleanup !== false;
      $('#patch0102ChatGPTCleanupTiming').value = ['immediate', 'five-minutes', 'on-close'].includes(value?.cleanupTiming) ? value.cleanupTiming : 'immediate';
    }).catch(() => {});
    $('#patch0102ChatGPTManual').addEventListener('click', () => $('#patch0102ManualStart')?.click());
    $('#patch0102ChatGPTAutoStart').addEventListener('click', () => $('#patch0102WebAutoStart')?.click());
    $('#patch0102ChatGPTOpen').addEventListener('click', () =>
      api.patchOpenChatGPTEmbedded().catch(error =>
        setText($('#patch0102ChatGPTAccountState'), '내장 화면을 열지 못했습니다: ' + error.message)));
    const save = () => api.patchSaveManualTranslationSettings?.({ autoCleanup: $('#patch0102ChatGPTCleanupEnabled').checked, cleanupTiming: $('#patch0102ChatGPTCleanupTiming').value }).catch(() => {});
    $('#patch0102ChatGPTCleanupEnabled').addEventListener('change', save); $('#patch0102ChatGPTCleanupTiming').addEventListener('change', save);
  }
  function addManualTranslationUi() {
    const target = $('#subtitleTranslateRow');
    if (!target || $('#patch0102ManualRow')) return;
    const row = document.createElement('div'); row.id = 'patch0102ManualRow'; row.className = 'sheet-button-row';
    const button = document.createElement('button'); button.id = 'patch0102ManualStart'; button.type = 'button'; button.className = 'sheet-button'; button.textContent = 'ChatGPT 수동 번역';
    const autoButton = document.createElement('button'); autoButton.id = 'patch0102WebAutoStart'; autoButton.type = 'button'; autoButton.className = 'sheet-button'; autoButton.textContent = 'ChatGPT 웹 자동 번역 (실험)';
    row.append(button, autoButton);
    const panel = document.createElement('div'); panel.id = 'patch0102ManualPanel'; panel.className = 'patch0102-manual-panel hidden';
    panel.innerHTML = '<div class="patch0102-manual-head"><b>ChatGPT 한국어 자막 번역</b><span id="patch0102ManualProgress"></span></div><p id="patch0102ManualStatus" role="status">선택한 자막의 번역을 준비합니다.</p><div class="patch0102-manual-actions"><button id="patch0102ManualCopy" type="button">요청 복사 · 내장 ChatGPT 열기</button><button id="patch0102ManualRetry" type="button">현재 묶음 다시 복사</button><button id="patch0102ManualImport" type="button">복사한 번역 가져와 바로 적용</button><button id="patch0102ManualApply" type="button">입력한 결과 확인</button><button id="patch0102ManualStop" type="button">중단 · 저장</button><button id="patch0102ManualDiscard" type="button">작업 삭제</button></div><textarea id="patch0102ManualAnswer" rows="6" spellcheck="false" placeholder="ChatGPT의 JSON 번역 결과를 붙여넣으세요"></textarea><div class="patch0102-manual-actions patch0102-manual-saved-tools"><button id="patch0102ManualRestore" type="button" class="hidden">원본 자막으로 되돌리기</button><button id="patch0102ManualReveal" type="button" class="hidden">저장 위치 열기</button></div>';
    target.after(row, panel);
    const setStatus = text => setText($('#patch0102ManualStatus'), text);
    let translation = null, open = false, sequence = 0, prefs = { autoCleanup: true, cleanupTiming: 'immediate' }, cleanupTimer = null, sourceBeforeTranslation = null, canResume = false;
    const current = value => Boolean(value && value === translation && value.playbackId === playbackRequestId &&
      value.subtitle === currentSubtitle && value.episodeKey === subtitleStoreKey());
    const saveSession = async (value, status = value.status) => {
      if (!value?.sourceFingerprint) return;
      value.answer = $('#patch0102ManualAnswer').value; value.status = status;
      const payload = { sourcePath: value.sourcePath, sourceLabel: value.sourceLabel, title: value.title, episode: value.episode, language: value.language, mode: value.mode || 'manual', inflightBatch: value.inflightBatch ?? null,
        index: value.index, batchCount: value.batches.length, totalCueCount: value.batches.reduce((sum, batch) => sum + batch.length, 0),
        translations: value.translations, answer: value.answer, status: value.status, message: value.message, cleanupAt: value.cleanupAt || null };
      try { await api.patchSaveManualTranslationSession(value.episodeKey, value.sourceFingerprint, payload); value.persisted = true; }
      catch (error) { value.persisted = false; value.message = `임시 작업 저장 실패: ${error.message}`; }
    };
    const sourceTools = () => {
      const active = currentSubtitle?.source === 'chatgpt';
      $('#patch0102ManualReveal').classList.toggle('hidden', !(active && currentSubtitle.path));
      $('#patch0102ManualRestore').classList.toggle('hidden', !(active && currentSubtitle.from));
    };
    const render = () => {
      row.classList.toggle('hidden', !manualAvailable() && !translation);
      panel.classList.toggle('hidden', !open || !translation);
      $('#patch0102ManualStart').textContent = translation || canResume ? 'ChatGPT 번역 계속' : 'ChatGPT 수동 번역';
      autoButton.disabled = Boolean(translation?.autoRunning || translation?.busy);
      sourceTools();
      if (!translation) return;
      const saving = translation.status === 'saving' || translation.index >= translation.batches.length, progress = manual.progress(translation.parsed.cues, translation.translations);
      $('#patch0102ManualProgress').textContent = `${progress.completed}/${progress.total}문장 (${progress.percent}%) · 묶음 ${Math.min(translation.index + 1, translation.batches.length)}/${translation.batches.length} · ${translation.language === 'english' ? '영어' : '일본어'} · ${({ ready: '준비', 'awaiting-response': 'ChatGPT 응답 대기', validating: '결과 검사', error: '오류 · 보존', cancelled: '중단 · 이어하기 가능', saving: '저장 중', completed: '완료' })[translation.status] || '준비 중'}`;
      setText($('#patch0102ManualStatus'), translation.message || '요청을 복사해 ChatGPT에 직접 붙여넣으세요.');
      $('#patch0102ManualCopy').disabled = translation.busy || translation.autoRunning || saving; $('#patch0102ManualRetry').disabled = translation.busy || translation.autoRunning || saving;
      $('#patch0102ManualImport').disabled = translation.busy || translation.autoRunning || translation.importing || saving;
      $('#patch0102ManualApply').disabled = translation.busy || translation.autoRunning || translation.importing;
      $('#patch0102ManualApply').textContent = saving ? '번역 자막 저장 재시도' : '결과 확인';
      $('#patch0102ManualStop').disabled = translation.busy; $('#patch0102ManualDiscard').disabled = translation.busy || translation.autoRunning;
      $('#patch0102ManualAnswer').disabled = translation.busy || translation.autoRunning || saving;
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
        const sourceText = await response.text(), parsed = manual.parseWebVtt(sourceText), sourceFingerprint = await manual.fingerprintWebVtt(sourceText), language = manual.detectSourceLanguage(parsed.cues), key = subtitleStoreKey();
        if (!key) throw new Error('회차 정보를 확인할 수 없어 번역 작업을 시작할 수 없습니다.');
        const text = parsed.cues.map(cue => cue.text).join('\n');
        if (/[가-힣]/.test(text) && !/[ぁ-ヿA-Za-z]/.test(text)) throw new Error('이미 한국어인 자막은 ChatGPT 번역 대상에서 제외했습니다.');
        const batches = manual.makeBatches(parsed.cues);
        if (!batches.length) throw new Error('번역할 문장을 찾지 못했습니다.');
        if (id !== sequence || subtitle !== currentSubtitle || playbackId !== playbackRequestId) return;
        prefs = await api.patchManualTranslationSettings().catch(() => prefs);
        let saved = await api.patchManualTranslationSession(key, sourceFingerprint);
        const hasSavedTranslation = await api.patchHasManualTranslationForSource(key, subtitle.path);
        if (id !== sequence || subtitle !== currentSubtitle || playbackId !== playbackRequestId) return;
        if (saved?.status === 'completed' || hasSavedTranslation) { if (!confirm('이 자막은 이미 번역되어 저장됐습니다. 새 번역 작업을 시작할까요? 저장된 한국어 자막은 유지됩니다.')) { setStatus('저장된 번역은 유지했습니다. 새 작업을 시작하지 않았습니다.'); return; } if (saved?.status === 'completed') await api.patchRemoveManualTranslationSession(key, sourceFingerprint); saved = null; }
        const translations = Object.create(null), knownIds = new Set(parsed.cues.map(cue => cue.id));
        if (saved) {
          if (saved.batchCount !== batches.length || saved.totalCueCount !== batches.reduce((sum, batch) => sum + batch.length, 0) || saved.language !== language || saved.sourcePath !== subtitle.path) throw new Error('저장된 원본 자막과 현재 선택이 달라 이어하기를 중단했습니다. 기존 작업은 보존했습니다.');
          for (const [cueId, translated] of Object.entries(saved.translations || {})) { if (!knownIds.has(Number(cueId)) || typeof translated !== 'string') throw new Error('저장된 번역 ID가 원본과 달라 이어하기를 중단했습니다. 기존 작업은 보존했습니다.'); translations[cueId] = translated; }
          for (const batch of batches.slice(0, saved.index || 0)) for (const cue of batch) if (!Object.hasOwn(translations, cue.id)) throw new Error('완료된 묶음의 응답이 없어 이어하기를 중단했습니다. 기존 작업은 보존했습니다.');
        }
        sourceBeforeTranslation = { path: subtitle.path, url: subtitle.src, label: subtitle.label || '원본 자막', source: subtitle.source || 'reanime' }; canResume = false;
        translation = { id, subtitle, mode: saved?.mode || 'manual', inflightBatch: saved?.inflightBatch ?? null, autoRunning: false, sourcePath: subtitle.path, sourceLabel: subtitle.label || '원본 자막', sourceUrl: subtitle.src, sourceKind: subtitle.source || 'reanime', sourceFingerprint, episodeKey: key, playbackId,
          title: currentPlaybackContext.subtitleTitle || $('#skipTitle')?.value.trim() || $('#playerTitle')?.textContent || '',
          episode: Number($('#skipEpisode')?.value) || Number(currentPlaybackContext.episode?.number) || 1,
          parsed, batches, index: saved?.index || 0, translations, busy: false, answer: saved?.answer || '', language, status: saved?.status === 'cancelled' ? 'cancelled' : 'ready', message: saved?.message || (saved ? '저장된 작업을 이어갑니다.' : '요청을 복사해 ChatGPT에 직접 붙여넣으세요.') };
        open = true; $('#patch0102ManualAnswer').value = translation.answer; render();
      } catch (error) {
        open = true; row.classList.remove('hidden'); panel.classList.remove('hidden'); setStatus(error.message);
      } finally { button.disabled = false; if (!translation) button.textContent = 'ChatGPT 수동 번역'; }
    };
    const copyPrompt = async () => {
      const value = translation; if (!current(value) || value.importing || value.autoRunning) return;
      const batch = value.batches[value.index]; if (!batch) return;
      const language = value.language; value.status = 'ready'; value.message = '현재 묶음 요청을 준비하고 있습니다.'; render();
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
        value.status = 'awaiting-response'; value.message = '요청을 복사했습니다. 내장 ChatGPT 창에 직접 붙여넣고 전송한 뒤 결과를 가져오세요.';
        try { await api.patchOpenChatGPTEmbedded(); value.message = '요청을 복사하고 내장 ChatGPT 창을 열었습니다. 직접 붙여넣고 전송한 뒤 결과를 가져오세요.'; }
        catch (error) { value.message = '요청은 복사됐지만 내장 ChatGPT 창을 열지 못했습니다: ' + error.message; }
        await saveSession(value, 'awaiting-response');
      } catch (error) { value.status = 'error'; value.message = `복사하지 못했습니다: ${error.message}`; await saveSession(value, 'error'); }
      render();
    };
    const save = async value => {
      if (!current(value) || value.busy) return;
      clearTimeout(value.answerTimer);
      value.busy = true; value.status = 'saving'; value.message = '번역 자막을 저장하고 적용하는 중…'; render(); await saveSession(value, 'saving');
      try {
        const text = manual.renderWebVtt(value.parsed, value.translations);
        const result = await api.patchSaveManualSubtitle({ key: value.episodeKey, text, from: value.sourcePath, fromName: value.sourceLabel, mode: value.mode });
        if (!current(value)) return;
        value.status = 'completed'; value.answer = ''; if (prefs.autoCleanup) { if (prefs.cleanupTiming === 'five-minutes') value.cleanupAt = Date.now() + 300000; await saveSession(value, 'completed'); if (prefs.cleanupTiming === 'immediate') await api.patchRemoveManualTranslationSession(value.episodeKey, value.sourceFingerprint); else if (prefs.cleanupTiming === 'five-minutes') { clearTimeout(cleanupTimer); cleanupTimer = setTimeout(() => api.patchRemoveManualTranslationSession(value.episodeKey, value.sourceFingerprint).catch(() => {}), 300000); } } else await saveSession(value, 'completed');
        sourceBeforeTranslation = { path: value.sourcePath, url: value.sourceUrl, label: value.sourceLabel, source: value.sourceKind }; translation = null; open = false; currentSubtitlePath = result.path;
        const label = value.mode === 'web-auto' ? 'ChatGPT 웹 자동 번역 (실험)' : 'ChatGPT 수동 번역';
        attachSubtitle(result.url, label, { path: result.path, source: 'chatgpt', from: value.sourcePath, fromName: value.sourceLabel, saved: true });
        $('#subtitleState').textContent = `${label} 자막을 적용했습니다. ChatGPT 대화는 앱에서 삭제하지 않았습니다.`; render();
      } catch (error) { value.busy = false; value.status = 'error'; value.message = `저장하지 못했습니다: ${error.message} 작업을 보존했습니다.`; await saveSession(value, 'error'); render(); }
    };
    const apply = async () => {
      const value = translation; if (!current(value) || value.busy || value.importing || value.autoRunning) return;
      clearTimeout(value.answerTimer);
      if (value.index >= value.batches.length) return save(value);
      value.status = 'validating'; value.message = '응답의 자막 ID를 검사하고 있습니다.'; render();
      const batch = value.batches[value.index];
      let translated;
      try { translated = manual.parseResponse($('#patch0102ManualAnswer').value, batch.map(item => item.id)); }
      catch (error) { value.status = 'error'; value.message = error.message; await saveSession(value, 'error'); render(); return; }
      Object.assign(value.translations, translated); value.index++; value.answer = ''; $('#patch0102ManualAnswer').value = '';
      value.status = value.index < value.batches.length ? 'ready' : 'saving'; value.message = value.index < value.batches.length ? `확인 완료. 다음 묶음 ${value.index + 1}/${value.batches.length} 요청을 복사해 주세요.` : '번역 자막을 저장하고 영상에 적용합니다.';
      await saveSession(value, value.status); render(); if (value.index >= value.batches.length) await save(value);
    };
    // User-initiated import only: no session scraping or background clipboard monitoring.
    const importClipboard = async () => {
      const value = translation;
      if (!current(value) || value.busy || value.importing || value.index >= value.batches.length) return;
      const answer = $('#patch0102ManualAnswer');
      if (answer.value.trim() && !confirm('입력창에 작성 중인 내용이 있습니다. 복사한 번역으로 바꿀까요?')) return;
      value.importing = true; value.message = '클립보드에서 번역 결과를 확인하는 중…'; render();
      let response;
      try {
        response = await api.patchReadText();
        if (!current(value)) return;
        manual.parseResponse(response, value.batches[value.index].map(item => item.id));
      } catch (error) {
        if (current(value)) {
          value.status = 'error';
          value.message = `클립보드 결과를 적용하지 않았습니다: ${error.message} ChatGPT에서 해당 묶음의 JSON 결과를 복사해 주세요.`;
        }
        return;
      } finally {
        value.importing = false;
        if (current(value)) render();
      }
      if (!current(value)) return;
      answer.value = response;
      await apply();
    };
    const runAuto = async () => {
      if (typeof api.patchChatGPTWebTranslate !== 'function') {
        setStatus('ChatGPT 웹 자동 번역 연결을 사용할 수 없습니다. 패치 구성을 확인하세요.'); return;
      }
      // The existing cue batching, resume validation and subtitle writer are reused.
      await start();
      const value = translation;
      if (!current(value) || value.autoRunning || value.busy) return;
      if (value.inflightBatch === value.index) {
        // The last request may already have reached ChatGPT. Never retry silently.
        if (!confirm('이전에 전송한 묶음의 응답 확인이 끝나지 않았습니다. 내장 ChatGPT 대화를 확인했나요? 새 요청으로 다시 전송하면 중복 번역이 발생할 수 있습니다. 계속할까요?')) {
          value.message = '자동 재전송을 보류했습니다. 번역 결과를 수동으로 가져오거나 다시 시작할 수 있습니다.'; render(); return;
        }
        value.inflightBatch = null;
      }
      value.mode = 'web-auto'; value.autoRunning = true; render();
      try {
        const instructions = await api.patchTranslationPrompt(value.language);
        while (current(value) && value.index < value.batches.length) {
          const batch = value.batches[value.index], all = value.parsed.cues;
          const indexes = batch.map(item => all.findIndex(cue => cue.id === item.id)).filter(index => index >= 0);
          const first = Math.min(...indexes), last = Math.max(...indexes);
          const prompt = manual.makePrompt({
            title: value.title, episode: value.episode, items: batch,
            contextBefore: all.slice(Math.max(0, first - 2), first).map(cue => ({ id: cue.id, text: cue.text })),
            contextAfter: all.slice(last + 1, last + 3).map(cue => ({ id: cue.id, text: cue.text })),
            translationInstructions: instructions, sourceLanguage: value.language
          });
          value.inflightBatch = value.index; value.status = 'awaiting-response';
          value.message = `ChatGPT 웹으로 묶음 ${value.index + 1}/${value.batches.length} 전송 및 번역 응답 대기 중…`;
          await saveSession(value, 'awaiting-response');
          if (!value.persisted) throw new Error('진행 상태를 저장하지 못해 요청을 전송하지 않았습니다.');
          if (!current(value)) return;
          const response = await api.patchChatGPTWebTranslate({ jobKey: value.sourceFingerprint.slice(0, 32), prompt });
          if (!current(value)) return;
          const translated = manual.parseResponse(response?.text, batch.map(cue => cue.id));
          Object.assign(value.translations, translated);
          value.index++; value.inflightBatch = null; value.status = 'ready';
          value.message = `묶음 ${value.index}/${value.batches.length} 번역 확인 완료`;
          await saveSession(value, 'ready');
          if (!value.persisted) throw new Error('진행 상태 저장에 실패했습니다. 이어하기 전 완료된 묶음을 확인하세요.');
          render();
        }
        if (current(value) && value.index === value.batches.length) {
          value.autoRunning = false;
          await save(value);
        }
      } catch (error) {
        if (current(value)) {
          value.status = 'error';
          value.message = `ChatGPT 웹 자동 번역 중단: ${error.message} 완료 묶음은 보존했습니다. 이미 전송된 요청은 자동 재전송하지 않습니다.`;
          await saveSession(value, 'error');
        }
      } finally {
        value.autoRunning = false;
        if (current(value)) render();
      }
    };
    button.addEventListener('click', start);
    autoButton.addEventListener('click', runAuto);
    $('#patch0102ManualCopy').addEventListener('click', copyPrompt);
    $('#patch0102ManualRetry').addEventListener('click', copyPrompt);
    $('#patch0102ManualImport').addEventListener('click', importClipboard);
    $('#patch0102ManualApply').addEventListener('click', apply);
    $('#patch0102ManualStop').addEventListener('click', async () => { const value = translation; if (value) { clearTimeout(value.answerTimer); translation = null; sequence++; if (value.autoRunning) await api.patchChatGPTWebCancel?.().catch(() => {}); value.answer = $('#patch0102ManualAnswer').value; value.status = 'cancelled'; value.message = '작업을 중단했습니다. 전송된 요청은 ChatGPT에 남아 있을 수 있습니다. 완료 묶음은 보존했습니다.'; await saveSession(value, 'cancelled'); canResume = true; } open = false; render(); });
    $('#patch0102ManualDiscard').addEventListener('click', async () => { const value = translation; if (!value || value.busy || value.autoRunning || !confirm('미완료 번역 작업과 임시 응답을 삭제할까요? 저장된 한국어 자막은 유지됩니다.')) return; clearTimeout(value.answerTimer); await api.patchRemoveManualTranslationSession(value.episodeKey, value.sourceFingerprint); translation = null; open = false; $('#patch0102ManualAnswer').value = ''; render(); });
    $('#patch0102ManualAnswer').addEventListener('input', () => { const value = translation; if (!current(value)) return; value.answer = $('#patch0102ManualAnswer').value; clearTimeout(value.answerTimer); value.answerTimer = setTimeout(() => void saveSession(value, value.status), 250); });
    $('#patch0102ManualReveal').addEventListener('click', () => { if (currentSubtitle?.source === 'chatgpt' && currentSubtitle.path) api.patchRevealManualSubtitle(currentSubtitle.path).catch(error => setStatus(`저장 위치를 열지 못했습니다: ${error.message}`)); });
    $('#patch0102ManualRestore').addEventListener('click', async () => { const translated = currentSubtitle; if (translated?.source !== 'chatgpt' || !translated.from) return; const original = sourceBeforeTranslation?.path === translated.from ? sourceBeforeTranslation : await api.patchManualTranslationSource?.(subtitleStoreKey(), translated.from); if (translated !== currentSubtitle || !original?.url) { setStatus('원본 자막을 찾지 못했습니다. 원본 출처에서 다시 선택해 주세요.'); return; } attachSubtitle(original.url, original.label || '원본 자막', { ...original, saved: true }); });
    render();

    const originalAttach = attachSubtitle;
    if (typeof originalAttach === 'function') {
      window.attachSubtitle = function (...args) { const result = originalAttach(...args); queueMicrotask(render); return result; };
    }
    const originalClear = clearSubtitle;
    if (typeof originalClear === 'function') {
      window.clearSubtitle = function (...args) { const result = originalClear(...args); if (translation) { void saveSession(translation, translation.status); canResume = true; translation = null; open = false; sequence++; } queueMicrotask(render); return result; };
    }
    window.addEventListener('beforeunload', () => { if (translation) void saveSession(translation, translation.status); });
    window.addEventListener('lilac-subtitle-changed', render);
  }

  function addStyles() {
    if ($('#patch0102Styles')) return;
    const style = document.createElement('style'); style.id = 'patch0102Styles';
    const scheduleStyles = `
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
      @media(max-width:560px){#patch0102QuarterControls{gap:6px}.patch0102-source-rows{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    const subtitleStyles = `
      #patch0102ManualRow{margin-top:6px}
      #patch0102ManualPanel{display:grid;gap:8px;padding:10px 0;color:var(--text)}
      #patch0102ManualPanel p{margin:0;color:var(--muted);font-size:12px;line-height:1.45}
      #patch0102ManualAnswer{width:100%;min-height:110px;resize:vertical;padding:9px;border:1px solid var(--line);border-radius:var(--ott-radius,10px);background:var(--panel);color:var(--text);font:inherit}
      .patch0102-manual-actions{display:flex;gap:6px;flex-wrap:wrap}.patch0102-manual-actions button{min-height:32px;padding:6px 9px;border:1px solid var(--line);border-radius:var(--ott-radius,10px);background:var(--panel);color:var(--text);font:inherit;cursor:pointer}
      .patch0102-manual-head{display:flex;justify-content:space-between;gap:8px;align-items:center}.patch0102-manual-head span{color:var(--muted);font-size:11px;text-align:right}
      .patch0102-chatgpt-settings{display:grid;gap:10px}.patch0102-chatgpt-settings p{margin:0;color:var(--muted);font-size:12px;line-height:1.5}.patch0102-chatgpt-settings select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:7px;padding:6px}
    `;
    style.textContent = [patch01Enabled ? scheduleStyles : '', patch02Enabled ? subtitleStyles : ''].filter(Boolean).join('\n');
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
    addStyles();
    if (patch01Enabled && !state.patch01Installed) {
      // v0.5.14 defaults next-episode autoplay to on. Keep an explicit user choice,
      // while making a fresh patched profile follow the established off-by-default rule.
      try { if (localStorage.getItem('playerAutoPlay') === null) localStorage.setItem('playerAutoPlay', 'false'); } catch {}
      mountQuarterControls(); mountScheduleTabs();
      installCardHandlers($('#seasonRail')); installCardHandlers($('#scheduleRail'));
      root.renderCards = function (target, items) {
        const result = nativeRenderCards(target, items);
        if (state.renderOwned) return result;
        if (target === '#seasonRail' && state.catalogReady) renderQuarterCards();
        return result;
      };
      root.animeById = function (id) {
        if (state.selectedAnime && String(state.selectedAnime.mal_id) === String(id)) return state.selectedAnime;
        return nativeAnimeById(id);
      };
      state.lastCalendar = selectionCalendarKey(); state.lastLocalDate = localDateKey();
      saveSelection();
      void loadQuarterCatalog(false); void loadWeekdaySchedule(false);
      root.addEventListener('focus', watchCalendar);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) watchCalendar(); });
      root.setInterval(watchCalendar, 5 * 60 * 1000);
      state.patch01Installed = true;
    }
    if (patch02Enabled && !state.patch02Installed) {
      addManualTranslationSettings();
      addManualTranslationUi();
      state.patch02Installed = true;
    }
  }

  root.LilacPersistentPatch0102 = Object.freeze({
    version: '0.5.14',
    enabled: Object.freeze({ 'patch-01': patch01Enabled, 'patch-02': patch02Enabled }),
    install,
    refreshQuarter: () => patch01Enabled ? loadQuarterCatalog(true) : Promise.resolve(null),
    refreshWeekday: () => patch01Enabled ? loadWeekdaySchedule(true) : Promise.resolve(null)
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
})(window);
