// Detailed filters browse each provider's full catalog independently of home rails.
const catalogBrowser = (() => {
  // This script loads before app.js, so keep its DOM helpers local instead of
  // relying on app.js's later top-level `$` bindings during initialization.
  const $ = selector => typeof globalThis.$ === 'function' ? globalThis.$(selector) : document.querySelector(selector);
  const $$ = selector => typeof globalThis.$$ === 'function' ? globalThis.$$(selector) : [...document.querySelectorAll(selector)];
  let taxonomy = null, taxonomyProvider = null, initializing = null, failed = false, filters = {}, page = null, generation = 0;
  const savedFilters = new Map();
  const blankFilters = () => ({ genre: '', format: '', year: '', season: '' });
  function syncProvider() {
    if (taxonomyProvider === state.source) return;
    taxonomyProvider = state.source; taxonomy = null; initializing = null; failed = false; page = null; generation++;
    filters = { ...blankFilters(), ...(savedFilters.get(taxonomyProvider) || {}) };
  }
  const active = () => { syncProvider(); return Object.values(filters).some(Boolean); };
  const key = () => JSON.stringify([state.source, allSort(), filters]);
  const currentPage = () => { syncProvider(); if (!page || page.key !== key()) page = { key: key(), items: [], offset: 0, done: false, loading: false, total: null }; return page; };
  const setOptions = (select, options, label, selected = '') => {
    const value = options.some(item => item.value === selected) ? selected : '';
    select.replaceChildren(new Option(label, ''), ...options.map(item => new Option(item.name, item.value)));
    select.value = value;
  };
  function setYearField(current, selected) {
    let field = $('#catalogYear');
    if (current.yearOptions.length) {
      if (field.tagName?.toLowerCase() !== 'select') {
        const select = document.createElement('select'); select.id = 'catalogYear'; select.setAttribute('aria-label', '방영 연도'); field.replaceWith(select); field = select;
      }
      setOptions(field, current.yearOptions, '전체 연도', selected);
    } else {
      if (field.tagName?.toLowerCase() === 'select') {
        const input = document.createElement('input'); input.id = 'catalogYear'; input.type = 'number'; input.step = '1'; input.placeholder = '전체 연도'; input.setAttribute('aria-label', '방영 연도'); field.replaceWith(input); field = input;
      }
      field.value = selected || '';
    }
  }
  async function initialize(retry = false) {
    syncProvider();
    if (taxonomy || (failed && !retry)) return;
    if (initializing) return initializing;
    const provider = state.source, requestGeneration = generation;
    $('#catalogFilterNote').textContent = '분류를 불러오는 중…';
    $$('#catalogFilters input, #catalogFilters select, #catalogFilters button').forEach(el => { el.disabled = true; });
    const pending = (async () => {
      try {
        const loaded = await window.lilac.catalogFacets(provider);
        if (requestGeneration !== generation || provider !== state.source) return;
        taxonomy = loaded; failed = false;
        if (!taxonomy.genres.some(item => item.value === filters.genre)) filters.genre = '';
        if (!taxonomy.formats.some(item => item.value === filters.format)) filters.format = '';
        if (!taxonomy.yearOptions.some(item => item.value === filters.year) && taxonomy.yearOptions.length) filters.year = '';
        if (!taxonomy.year) filters.year = '';
        if (!taxonomy.season) filters.season = '';
        savedFilters.set(provider, { ...filters });
        setOptions($('#catalogGenre'), taxonomy.genres, '전체 장르', filters.genre);
        setOptions($('#catalogFormat'), taxonomy.formats, '전체 형태', filters.format);
        setYearField(taxonomy, filters.year);
        setOptions($('#catalogSeason'), [
          { value: 'WINTER', name: '1분기 · 겨울' }, { value: 'SPRING', name: '2분기 · 봄' },
          { value: 'SUMMER', name: '3분기 · 여름' }, { value: 'FALL', name: '4분기 · 가을' }
        ], '전체 분기', filters.season);
        for (const [name, supported] of [['Genre', taxonomy.genres.length], ['Format', taxonomy.formats.length], ['Year', taxonomy.year], ['Season', taxonomy.season]]) $(`#catalog${name}Field`).classList.toggle('hidden', !supported);
        $('#catalogFilterNote').textContent = taxonomy.note || '지원하는 장르·작품 형태·연도·분기를 조합할 수 있습니다.';
        if (typeof renderAllSort === 'function') renderAllSort();
      } catch (error) {
        if (requestGeneration !== generation || provider !== state.source) return;
        failed = true; $('#catalogFilterNote').textContent = `분류를 불러오지 못했습니다. 필터 적용으로 다시 시도해 주세요. (${error.message})`;
      } finally {
        if (requestGeneration === generation && provider === state.source) $$('#catalogFilters input, #catalogFilters select, #catalogFilters button').forEach(el => { el.disabled = false; });
      }
    })();
    initializing = pending;
    try { await pending; }
    finally { if (requestGeneration === generation && initializing === pending) initializing = null; }
  }
  function render() {
    const current = currentPage(), grid = $('#allGrid'), shown = [...grid.children].map(el => el.dataset.id);
    if (shown.length && shown.length <= current.items.length && shown.every((id, index) => id === String(current.items[index].mal_id))) grid.append(...current.items.slice(shown.length).map(card));
    else renderCards('#allGrid', current.items);
    $('#catalogEmpty').classList.toggle('hidden', current.loading || !current.done || Boolean(current.items.length));
    $('#catalogMore').classList.toggle('hidden', current.done); $('#catalogMore').disabled = current.loading;
  }
  async function load() {
    if (!active()) return;
    const current = currentPage(); if (current.loading || current.done) return;
    current.loading = true; render(); $('#allStatus').textContent = '선택한 조건의 작품을 불러오는 중…';
    try {
      const result = await window.lilac.catalogBrowse(state.source, { ...filters, offset: current.offset, sort: allSort() });
      if (current !== currentPage() || !active()) return;
      const data = Array.isArray(result.data) ? result.data : [], before = current.items.length;
      current.items = [...new Map([...current.items, ...data].map(item => [String(item.mal_id), item])).values()];
      current.total = result.total ?? null;
      current.done = Boolean(result.done) || result.nextOffset === current.offset || result.nextOffset == null || (data.length > 0 && current.items.length === before);
      current.offset = result.nextOffset;
      const genre = taxonomy.genres.find(item => item.value === filters.genre)?.name, format = taxonomy.formats.find(item => item.value === filters.format)?.name;
      const year = taxonomy.yearOptions.find(item => item.value === filters.year)?.name || (filters.year ? `${filters.year}년` : '');
      const season = filters.season ? `${['WINTER', 'SPRING', 'SUMMER', 'FALL'].indexOf(filters.season) + 1}분기` : '';
      $('#allStatus').textContent = `${[genre, format, year, season].filter(Boolean).join(' · ')} · ${current.items.length}${current.total != null ? ` / ${current.total}` : ''}개 작품${result.note ? ` · ${result.note}` : ''}`;
    } catch (error) {
      if (current === currentPage() && active()) $('#allStatus').textContent = `작품을 불러오지 못했습니다: ${error.message}`;
    } finally {
      current.loading = false;
      if (current === currentPage() && active()) render();
    }
  }
  async function apply() {
    await initialize(true); if (!taxonomy || taxonomyProvider !== state.source) return;
    const next = {
      genre: $('#catalogGenre').value,
      format: $('#catalogFormat').value,
      year: taxonomy.year ? String($('#catalogYear').value || '').trim() : '',
      season: taxonomy.season ? $('#catalogSeason').value : ''
    };
    if (next.season && !next.year) {
      const currentYear = String(new Date().getFullYear());
      if (taxonomy.yearOptions.length && !taxonomy.yearOptions.some(item => item.value === currentYear)) {
        $('#catalogFilterNote').textContent = '분기별로 찾으려면 제공 목록에 있는 연도를 먼저 선택해 주세요.'; return;
      }
      next.year = currentYear; $('#catalogYear').value = next.year;
    }
    if (next.year && !/^\d+$/.test(next.year)) { $('#catalogYear').reportValidity(); return; }
    filters = next; savedFilters.set(state.source, { ...filters }); page = null;
    $('#allGrid').replaceChildren(); $('#catalogEmpty').classList.add('hidden'); $('#catalogMore').classList.add('hidden');
    document.querySelector('main').scrollTo({ top: 0 }); await loadFullCatalog();
  }
  $('#catalogFilters').onsubmit = event => { event.preventDefault(); apply(); };
  $('#catalogFilterReset').onclick = () => {
    syncProvider(); filters = blankFilters(); savedFilters.delete(state.source); page = null; $('#catalogFilters').reset();
    $('#catalogEmpty').classList.add('hidden'); $('#catalogMore').classList.add('hidden'); $('#allGrid').replaceChildren(); loadFullCatalog();
  };
  $('#catalogMore').onclick = load;
  $('#catalogFilters').addEventListener('keydown', event => { if (event.target.matches('input, select') && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.stopPropagation(); });
  return { initialize, active, render, load, sortOptions: () => { syncProvider(); return taxonomy?.sorts || null; } };
})();
