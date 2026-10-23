(function () {
  const section = document.querySelector('#scheduleSection');
  if (!section) return;
  const tabs = section.querySelector('#scheduleTabs'), rail = section.querySelector('#scheduleRail');
  const status = section.querySelector('#scheduleStatus'), more = section.querySelector('#scheduleMore');
  const weekLabel = section.querySelector('#scheduleWeek'), credit = section.querySelector('.schedule-credit');
  const names = ['월', '화', '수', '목', '금', '토', '일'];
  const providers = { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkani: '링크애니', linkkf: 'Linkkf' };
  const dateKey = date => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
  const todayKey = dateKey(new Date());
  // Keep the parsed Seoul calendar day on the same day when it is formatted
  // back through Asia/Seoul; UTC noon would roll the tab labels into tomorrow.
  const today = new Date(`${todayKey}T00:00:00Z`);
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday); date.setUTCDate(monday.getUTCDate() + index); return date;
  });
  const label = date => `${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
  let selected = (today.getUTCDay() + 6) % 7, request = 0, expanded = false, items = [], timed = false;
  const selectedProvider = String(state.source || '');
  if (!tabs || !rail || !status || !more || !weekLabel || !credit) return;
  section.classList.remove('hidden');
  weekLabel.textContent = `${label(dates[0])} – ${label(dates[6])}`;

  function match(item) {
    const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    const wanted = [item.title, item.originalTitle].map(normalize).filter(Boolean);
    if (!wanted.length) return null;
    return [...(state.current || []), ...(state.airing || []), ...(state.season || []), ...(state.library || [])].find(anime =>
      anime?.provider === state.source && [anime.title, anime.title_japanese, anime.title_english].some(value => {
        const key = normalize(value); return key && wanted.includes(key);
      })) || null;
  }

  function openScheduleItem(item) {
    const anime = item?.anime?.mal_id != null ? item.anime : match(item);
    if (anime?.mal_id != null) { rememberAnime(anime); void openDetail(anime.mal_id); }
    else if (item?.title) void doSearch(item.title);
  }

  function render() {
    const date = dates[selected].toISOString().slice(0, 10);
    rail.replaceChildren(...(expanded ? items : items.slice(0, 6)).map(item => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'schedule-show';
      const cancelled = item.cancelled === true;
      const startDate = String(item.startDate || '');
      const badge = cancelled ? '결방' : startDate > date ? `${startDate.slice(5).replace('-', '.')} 첫 방송` : startDate === date ? '첫 방송' : '';
      const episode = Number(item.episode ?? item.episode_number);
      const track = item.track === 'dub' ? '더빙' : item.track === 'sub' ? '자막' : '';
      const meta = [Number.isFinite(episode) && episode > 0 ? `${episode}화` : '', track, item.sourceNote,
        ...(Array.isArray(item.genres) ? item.genres.slice(0, 2) : [])].filter(Boolean).join(' · ');
      const airingLabel = cancelled ? '결방' : !timed ? '공급원 목록' : item.airingStatus === 'aired' ? '공개됨' : item.airingStatus === 'delayed' ? '공개 지연' : '공개 예정';
      const time = /^\d{2}:\d{2}$/.test(String(item.time || '')) ? item.time : timed ? '시간 미정' : '';
      const title = item.anime ? titleOf(item.anime) : String(item.title || '');
      button.innerHTML = `<span class="schedule-time${cancelled ? ' cancelled' : ''}">${escapeHtml(time)}<small>${escapeHtml(airingLabel)}</small></span><span class="schedule-show-copy"><b>${escapeHtml(title)}</b><small>${escapeHtml(meta || '애니메이션')}${badge ? ` <em>${escapeHtml(badge)}</em>` : ''}</small></span><span class="schedule-arrow" aria-hidden="true">↗</span>`;
      button.setAttribute('aria-label', [time, title, cancelled ? '결방' : ''].filter(Boolean).join(' '));
      const cover = imageOf(item.anime || match(item) || {});
      if (cover) {
        const image = document.createElement('img'); image.className = 'schedule-cover'; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
        image.onerror = () => image.remove();
        button.insertBefore(image, button.querySelector('.schedule-show-copy'));
        setImageSource(image, cover);
      }
      if (item.anime?.mal_id != null) {
        titleAnime.set(animeTitleKey(item.anime), item.anime);
        button.querySelector('b').setAttribute('data-title-for', animeTitleKey(item.anime));
      }
      button.onclick = () => openScheduleItem(item);
      return button;
    }));
    more.classList.toggle('hidden', items.length <= 6);
    more.textContent = expanded ? '접기' : `${items.length}개 일정 모두 보기`;
  }

  async function select(index) {
    selected = index; expanded = false; items = []; const token = ++request;
    [...tabs.children].forEach((button, i) => {
      button.classList.toggle('selected', i === index);
      button.setAttribute('aria-selected', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    });
    rail.replaceChildren(); more.classList.add('hidden'); rail.setAttribute('aria-busy', 'true');
    status.textContent = `${names[index]}요일 일정을 불러오는 중…`; credit.textContent = providers[state.source] || state.source || '';
    try {
      const result = await window.lilac.providerSchedule(state.source, dates[index].getUTCDay());
      if (token !== request || state.source !== selectedProvider) return;
      items = Array.isArray(result?.items) ? result.items : [];
      timed = result?.timed === true;
      const provider = providers[result?.provider || selectedProvider] || selectedProvider;
      const native = result?.native === true;
      section.querySelector('h2').textContent = native && !timed && result?.provider === 'linkani' ? '요일별 애니 목록' : '이번 주 방영표';
      weekLabel.classList.toggle('hidden', native && result?.provider === 'linkani');
      credit.textContent = String(result?.note || provider);
      if (result?.failed) status.textContent = `${names[index]}요일 일정을 공급원과 대체 출처에서 확인하지 못했습니다.`;
      else if (!native && result?.sourceError) status.textContent = `${names[index]}요일 · 대체 일정 ${items.length}개 · ${provider} 응답 실패`;
      else status.textContent = items.length ? `${names[index]}요일 · ${items.length}개 ${timed ? '일정' : '작품'}${timed ? ' · 시간순' : ''}` : `${names[index]}요일에 등록된 일정이 없습니다.`;
      render();
    } catch (error) {
      if (token !== request) return;
      status.textContent = `${names[index]}요일 일정을 불러오지 못했습니다.`;
      credit.textContent = String(error?.message || error);
    } finally {
      if (token === request) rail.setAttribute('aria-busy', 'false');
    }
  }

  tabs.replaceChildren(...dates.map((date, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
    const isToday = dateKey(date) === todayKey; button.className = isToday ? 'schedule-day today' : 'schedule-day';
    button.innerHTML = `<span>${names[index]}${isToday ? '<i>오늘</i>' : ''}</span><b>${label(date)}</b>`;
    button.onclick = () => { void select(index); };
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 6 : (selected + (event.key === 'ArrowRight' ? 1 : 6)) % 7;
      tabs.children[next].focus(); void select(next);
    };
    return button;
  }));
  section.querySelector('#scheduleToday').onclick = () => { void select((today.getUTCDay() + 6) % 7); };
  section.querySelector('#scheduleRetry').onclick = () => { void select(selected); };
  more.onclick = () => { expanded = !expanded; render(); };
  window.LilacWeeklySchedule = { refresh: () => select(selected), select: index => select(index), today: () => select((today.getUTCDay() + 6) % 7) };
  void select(selected);
})();
