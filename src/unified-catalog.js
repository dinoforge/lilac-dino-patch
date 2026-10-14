(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LilacUnifiedCatalog = api;
  if (root?.document) {
    const start = () => api.mount(root.document);
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const PROVIDERS = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkkf'];
  const LABELS = Object.freeze({ reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkkf: 'Linkkf' });

  function normalize(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }

  function episodeNumber(episode) {
    const value = Number(episode?.number);
    if (Number.isInteger(value) && value > 0) return value;
    const label = String(episode?.name || episode?.title || '');
    const seasonEpisode = label.match(/\bS\d+\s*E(\d+)\b/i);
    if (seasonEpisode) return Number(seasonEpisode[1]);
    const explicitEpisode = label.match(/\b(?:episode|ep|제)\s*(\d+)\b/i);
    if (explicitEpisode) return Number(explicitEpisode[1]);
    const match = label.match(/(?:^|\D)(\d{1,4})(?:\D|$)/);
    return match ? Number(match[1]) : 0;
  }

  function episodeTitle(episode) {
    const value = normalize(episode?.title || episode?.name || episode?.episodeTitle || '');
    if (!value) return '';
    if (/^(?:(?:episode|ep|제)\s*)?\d{1,4}\s*(?:화|회|편|話)?$/.test(value)) return 'generic-episode';
    return value;
  }

  function episodeSeriesKey(entry) {
    return String(entry?.seriesKey || '').trim();
  }

  function isSpecialEpisode(episode) {
    if (episode?.special === true || episode?.isSpecial === true || episode?.is_special === true) return true;
    const type = normalize(episode?.type || episode?.format || '');
    if (/^(?:special|ova|oad|movie|film)$/.test(type)) return true;
    return /(?:^|\s)(?:ova|oad|special|movie|film)(?:\s|\d|$)|특별편|극장판/i.test(String(episode?.title || episode?.name || ''));
  }

  function groupEpisodes(entries) {
    const groups = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const episode = entry?.episode;
      if (!episode || !PROVIDERS.includes(entry.provider)) continue;
      const number = episodeNumber(episode), title = episodeTitle(episode);
      const id = String(episode.id ?? episode.token ?? episode.slug ?? episode.name ?? 'unknown');
      const series = episodeSeriesKey(entry), special = isSpecialEpisode(episode);
      const dub = episode.dub === true || /dub|더빙/i.test(normalize(episode.language || '')) ? 'dub' : 'sub';
      const part = normalize(episode.part ?? episode.partNumber ?? episode.part_number ?? '');
      // A group identity comes from the shared anime matcher (stable MAL/AniList ID,
      // or exact title/year/type/season fallback). Episode titles vary by source;
      // only ordinary numbered episodes with that series identity are merged.
      // Specials stay source-specific because episode numbers alone are ambiguous.
      const key = series && number > 0 && !special
        ? `series:${series}|episode:${number}|dub:${dub}|part:${part}`
        : `source:${entry.provider}:${id}:${entry.serverName || ''}`;
      if (!groups.has(key)) groups.set(key, { key, number, title, name: String(episode.title || episode.name || `${number || '?'}화`), choices: [] });
      const group = groups.get(key);
      group.choices.push({ provider: entry.provider, serverName: entry.serverName || '', episode, anime: entry.anime, seriesEpisodes: entry.seriesEpisodes || [], seriesKey: series });
    }
    const rank = new Map(PROVIDERS.map((provider, index) => [provider, index]));
    return [...groups.values()].map(group => ({
      ...group,
      choices: group.choices.sort((a, b) => (rank.get(a.provider) ?? PROVIDERS.length) - (rank.get(b.provider) ?? PROVIDERS.length) || a.serverName.localeCompare(b.serverName))
    })).sort((a, b) => (a.number || Number.MAX_SAFE_INTEGER) - (b.number || Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
  }

  function withTimeout(value, timeoutMs, label = '공급원 응답 시간 초과') {
    let timer;
    return Promise.race([
      Promise.resolve(value),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), Math.max(1, Number(timeoutMs) || 1)); })
    ]).finally(() => clearTimeout(timer));
  }

  async function mapLimit(items, limit, task) {
    const output = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
      while (next < items.length) {
        const index = next++;
        try { output[index] = { status: 'fulfilled', value: await task(items[index], index) }; }
        catch (reason) { output[index] = { status: 'rejected', reason }; }
      }
    }));
    return output;
  }

  function sourceId(anime) {
    return String(anime?.id ?? anime?.mal_id ?? '').replace(/^linkkf:/, '').trim();
  }

  function createCatalogService({ lilac, integratedSearch, timeoutMs = 12000 } = {}) {
    if (!lilac || !integratedSearch) throw new TypeError('Lilac provider APIs and integrated search are required');
    const timed = (promise, provider, action) => withTimeout(promise, timeoutMs, `${LABELS[provider] || provider}: ${action} 응답 시간 초과`);

    async function browse() {
      const providers = PROVIDERS.map(provider => ({ provider }));
      const settled = await mapLimit(providers, 5, async ({ provider }) => {
        if (provider === 'linkkf') {
          const response = await timed(lilac.linkkfHome(1, 24), provider, '목록');
          return Array.isArray(response) ? response : response?.data || [];
        }
        const response = await timed(lilac.providerCatalog(provider, '', 0), provider, '목록');
        return Array.isArray(response) ? response : response?.data || [];
      });
      const items = [], statuses = [];
      settled.forEach((result, index) => {
        const provider = providers[index].provider;
        if (result.status === 'fulfilled') {
          const records = result.value.filter(item => item && (item.mal_id || item.id)).map(item => item.provider ? item : { ...item, provider });
          items.push(...records);
          statuses.push({ provider, state: 'ready', resultCount: records.length });
        } else statuses.push({ provider, state: 'failed', resultCount: 0, error: String(result.reason?.message || result.reason || '') });
      });
      return { items, statuses };
    }

    async function search(query) {
      return integratedSearch.searchProviders({
        providers: PROVIDERS, query: String(query || '').trim(), concurrency: 5,
        search: async (provider, term) => provider === 'linkkf'
          ? timed(lilac.linkkfSearch(term), provider, '검색')
          : timed(lilac.providerCatalog(provider, term, 0), provider, '검색'),
        localSearch: async (provider, term) => /[가-힣]/.test(term) && ['reanime', 'animenosub'].includes(provider)
          ? timed(lilac.catalogKoreanSearch(provider, term), provider, '한국어 색인 검색')
          : null
      });
    }

    async function details(group) {
      const sources = Array.isArray(group?.sourceItems) ? group.sourceItems : [];
      const settled = await mapLimit(sources, 3, async source => {
        const id = sourceId(source);
        if (!id) throw new Error('공급원 작품 ID가 없습니다.');
        if (source.provider === 'linkkf') {
          const [detailResult, servers] = await Promise.all([
            timed(lilac.linkkfDetail(id), source.provider, '작품 상세'),
            timed(lilac.linkkfEpisodes(id), source.provider, '회차 목록')
          ]);
          const anime = detailResult?.data || detailResult || source;
          const episodes = (Array.isArray(servers) ? servers : []).flatMap(server => (server.episodes || []).map(episode => ({
            ...episode, provider: 'linkkf', serverName: String(server.name || ''), anime
          })));
          return { provider: source.provider, anime, episodes, unavailable: false };
        }
        const result = await timed(lilac.providerDetail(source), source.provider, '작품 상세');
        const anime = result?.data || source;
        const episodes = (Array.isArray(result?.episodes) ? result.episodes : []).map(episode => ({ ...episode, provider: source.provider, anime }));
        if (!episodes.length && result?.unavailable) return { provider: source.provider, anime, episodes, unavailable: true };
        return { provider: source.provider, anime, episodes, unavailable: false };
      });
      const results = settled.map((result, index) => result.status === 'fulfilled'
        ? result.value
        : { provider: sources[index].provider, anime: sources[index], episodes: [], unavailable: true, error: String(result.reason?.message || result.reason || '') });
      const episodes = results.flatMap(result => result.episodes.map(episode => ({
        provider: result.provider,
        serverName: episode.serverName || '',
        episode,
        anime: result.anime,
        seriesKey: group.groupKey || '',
        seriesEpisodes: result.episodes.filter(item => item.serverName === (episode.serverName || ''))
      })));
      return { results, episodes, groupedEpisodes: groupEpisodes(episodes) };
    }

    return { browse, search, details };
  }

  function mount(document) {
    if (!document || root?.DinoLilacPatchFeatures?.['patch-03'] !== true || !root?.lilac || !root?.LilacIntegratedSearch || document.getElementById('unifiedCatalogView')) return;
    if (!document.getElementById('unifiedCatalogStyles')) {
      const stylesheet = document.createElement('link');
      stylesheet.id = 'unifiedCatalogStyles'; stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('unified-catalog.css', document.baseURI).href;
      document.head.append(stylesheet);
    }
    const home = document.getElementById('homeView');
    if (!home) return;
    const panel = document.createElement('section');
    panel.id = 'unifiedCatalogView'; panel.className = 'content-section unified-catalog-view';
    panel.setAttribute('aria-labelledby', 'unifiedCatalogTitle');
    panel.innerHTML = '<header class="unified-catalog-header"><div><h2 id="unifiedCatalogTitle">통합 애니메이션</h2><p>다섯 영상 공급원의 작품과 회차를 한곳에서 찾아보세요.</p></div><button type="button" class="unified-catalog-original">기존 공급원별 목록</button><button type="button" class="unified-catalog-back" hidden>← 검색 결과</button></header><form class="unified-catalog-search"><label for="unifiedCatalogQuery">다섯 공급원 통합 검색</label><div><input id="unifiedCatalogQuery" type="search" maxlength="120" placeholder="작품 제목 입력"><button type="submit">검색</button></div></form><p class="unified-catalog-status" role="status" aria-live="polite"></p><section class="unified-catalog-providers" aria-label="공급원 상태"></section><div class="unified-catalog-results"></div>';
    home.insertBefore(panel, home.firstElementChild);
    const status = panel.querySelector('.unified-catalog-status');
    const providers = panel.querySelector('.unified-catalog-providers');
    const results = panel.querySelector('.unified-catalog-results');
    const back = panel.querySelector('.unified-catalog-back');
    const service = createCatalogService({ lilac: root.lilac, integratedSearch: root.LilacIntegratedSearch });
    let request = 0, previousView = { type: 'browse', query: '' };

    const setProviderStatus = values => {
      providers.replaceChildren(...values.map(value => {
        const item = document.createElement('span'); item.dataset.state = value.state;
        const stateLabel = value.state === 'ready' ? value.resultCount
          : value.state === 'partial' ? '일부 응답'
            : value.state === 'skipped' ? '검색 생략'
              : value.state === 'unavailable' ? '현재 제공 안 됨'
                : value.state === 'empty' ? '회차 없음' : '확인 실패';
        item.textContent = `${LABELS[value.provider] || value.provider} · ${stateLabel}`;
        return item;
      }));
    };
    const applyDisplayTitle = (element, anime, fallback = '') => {
      element.textContent = typeof root.titleOf === 'function'
        ? root.titleOf(anime)
        : anime?.title || anime?.title_english || anime?.title_japanese || anime?.name || fallback || '제목 없음';
      if (typeof root.animeTitleKey === 'function') element.dataset.titleFor = root.animeTitleKey(anime);
    };
    const loadCover = (image, anime) => {
      const url = anime?.images?.webp?.large_image_url || anime?.images?.jpg?.large_image_url || '';
      if (!url) return;
      const cover = typeof root.lilac.coverData === 'function' ? root.lilac.coverData(url).catch(() => url) : Promise.resolve(url);
      cover.then(value => { if (image.isConnected && value) image.src = value; });
    };
    const renderGroups = (groups, emptyMessage = '검색 결과가 없습니다.') => {
      results.className = 'unified-catalog-results'; results.replaceChildren();
      if (!groups.length) { const empty = document.createElement('p'); empty.className = 'unified-catalog-empty'; empty.textContent = emptyMessage; results.append(empty); return; }
      const grid = document.createElement('div'); grid.className = 'unified-catalog-grid';
      for (const group of groups) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'unified-catalog-card';
        const image = document.createElement('img'); image.loading = 'lazy'; image.alt = '';
        loadCover(image, group);
        const title = document.createElement('strong'); applyDisplayTitle(title, group);
        const info = document.createElement('span'); info.textContent = `${group.year || '연도 정보 없음'} · ${group.type || group.format || '작품'} · ${group.sourceCount || 1}개 공급원`;
        button.append(image, title, info); button.addEventListener('click', () => openDetails(group)); grid.append(button);
      }
      results.append(grid);
    };
    const returnToResults = () => { back.hidden = true; results.className = 'unified-catalog-results'; };
    async function openDetails(group) {
      const token = ++request;
      back.hidden = false;
      status.textContent = '공급원별 작품 상세와 회차를 불러오는 중입니다. 응답이 없는 공급원은 건너뜁니다.';
      setProviderStatus(group.sourceItems.map(source => ({ provider: source.provider, state: 'pending' })));
      results.className = 'unified-catalog-results is-detail'; results.replaceChildren();
      const title = document.createElement('h3'); applyDisplayTitle(title, group); results.append(title);
      const detail = await service.details(group);
      if (token !== request || !panel.isConnected) return;
      const ready = detail.results.filter(result => result.episodes.length);
      setProviderStatus(detail.results.map(result => ({
        provider: result.provider,
        state: result.error ? 'failed' : result.episodes.length ? 'ready' : result.unavailable ? 'unavailable' : 'empty',
        resultCount: result.episodes.length
      })));
      const failed = detail.results.filter(result => result.error).map(result => LABELS[result.provider] || result.provider);
      const unavailable = detail.results.filter(result => result.unavailable && !result.error).map(result => LABELS[result.provider] || result.provider);
      status.textContent = failed.length
        ? `${failed.join(', ')} 공급원 응답에 실패했습니다. 나머지 공급원은 계속 사용할 수 있습니다.`
        : unavailable.length ? `${unavailable.join(', ')}에는 현재 재생 가능한 회차가 없습니다.` : '공급원별 회차를 불러왔습니다.';
      const summary = document.createElement('p'); summary.className = 'unified-catalog-detail-summary';
      summary.textContent = `${ready.length}/${detail.results.length}개 공급원에서 재생 회차를 확인했습니다.`; results.append(summary);
      if (!detail.groupedEpisodes.length) { const empty = document.createElement('p'); empty.className = 'unified-catalog-empty'; empty.textContent = '현재 확인된 재생 회차가 없습니다.'; results.append(empty); return; }
      const list = document.createElement('ol'); list.className = 'unified-catalog-episodes';
      for (const episodeGroup of detail.groupedEpisodes) {
        const row = document.createElement('li'); const name = document.createElement('strong'); name.textContent = episodeGroup.name; row.append(name);
        const choices = document.createElement('div'); choices.className = 'unified-catalog-choices';
        for (const choice of episodeGroup.choices) {
          root.DinoPatch05?.mountChoice?.(choices, choice.episode);
          const play = document.createElement('button'); play.type = 'button'; play.className = 'unified-catalog-play';
          play.textContent = `${LABELS[choice.provider] || choice.provider}${choice.serverName ? ` · ${choice.serverName}` : ''}에서 재생`;
          play.addEventListener('click', () => {
            const episode = root.DinoPatch05?.preparePlayback?.(choice.episode) || choice.episode, anime = choice.anime;
            const resolver = choice.provider === 'linkkf' ? () => root.lilac.linkkfResolve(episode) : () => root.lilac.providerResolve(episode);
            if (typeof root.resolveIntoPlayer !== 'function') { status.textContent = '현재 플레이어 연결을 찾지 못했습니다. 앱을 다시 열고 시도해 주세요.'; return; }
            const subtitleTitle = typeof root.titleOf === 'function'
              ? root.titleOf(anime)
              : anime.title || anime.title_english || anime.title_japanese || group.title || '';
            const number = episodeNumber(episode) || 1;
            root.resolveIntoPlayer(resolver, `${subtitleTitle} · ${episode.name || `${number}화`}`, {
              episode, subtitleTitle, image: anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url || '',
              seriesEpisodes: choice.seriesEpisodes, resolveKind: choice.provider === 'linkkf' ? 'linkkf' : 'provider', anime
            }, subtitleTitle, number);
          });
          choices.append(play);
        }
        row.append(choices); list.append(row);
      }
      results.append(list);
    }

    async function loadBrowse() {
      previousView = { type: 'browse', query: '' };
      const token = ++request; returnToResults(); status.textContent = '다섯 공급원의 최신 작품 목록을 확인하고 있습니다.';
      providers.replaceChildren(); results.replaceChildren();
      const response = await service.browse();
      if (token !== request || !panel.isConnected) return;
      const groups = root.LilacIntegratedSearch.groupCatalogResults(response.items, '');
      setProviderStatus(response.statuses); status.textContent = `통합 목록 ${groups.length}개 작품 · 공급원별 첫 목록`;
      renderGroups(groups);
    }
    async function loadSearch(query) {
      previousView = { type: 'search', query };
      const token = ++request; returnToResults(); status.textContent = `“${query}” 검색 중입니다.`;
      providers.replaceChildren(); results.replaceChildren();
      const response = await service.search(query);
      if (token !== request || !panel.isConnected) return;
      const groups = root.LilacIntegratedSearch.groupCatalogResults(response.items, '');
      setProviderStatus(response.statuses);
      const failed = response.statuses.filter(value => value.state === 'failed').length;
      status.textContent = `통합 검색 ${groups.length}개 작품${failed ? ` · ${failed}개 공급원 확인 실패` : ''}`;
      renderGroups(groups);
    }

    panel.querySelector('.unified-catalog-original').addEventListener('click', () => {
      const originalCatalog = document.querySelector('.nav[data-view="all"]') || document.getElementById('seeAllSeason');
      if (originalCatalog) originalCatalog.click();
      else status.textContent = '기존 공급원별 목록을 여는 버튼을 찾지 못했습니다.';
    });
    back.addEventListener('click', () => {
      request++;
      const previous = previousView;
      const restore = previous.type === 'search' ? loadSearch(previous.query) : loadBrowse();
      restore.catch(error => { status.textContent = error.message; });
    });
    panel.querySelector('.unified-catalog-search').addEventListener('submit', event => {
      event.preventDefault(); const query = panel.querySelector('#unifiedCatalogQuery').value.trim();
      if (!query) { loadBrowse().catch(error => { status.textContent = error.message; }); return; }
      loadSearch(query).catch(error => { status.textContent = `통합 검색을 완료하지 못했습니다: ${error.message}`; });
    });
    loadBrowse().catch(error => { status.textContent = `통합 목록을 불러오지 못했습니다: ${error.message}`; });
  }

  return { PROVIDERS, LABELS, normalize, episodeNumber, episodeSeriesKey, isSpecialEpisode, groupEpisodes, withTimeout, mapLimit, createCatalogService, mount };
});
