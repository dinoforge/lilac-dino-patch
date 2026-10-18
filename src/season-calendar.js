(function (root) {
  const PROVIDER_LABELS = { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkkf: 'Linkkf' };
  const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
  const key = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  function aliases(item = {}) {
    const values = [item.title, item.title_english, item.title_japanese, item.title_native, item.title_original, item.romaji, item.originalTitle, item.original_title];
    const synonyms = item.synonyms;
    if (Array.isArray(synonyms)) values.push(...synonyms);
    else if (typeof synonyms === 'string') values.push(...synonyms.split(/[,|/]/));
    return [...new Set(values.map(key).filter(Boolean))];
  }
  function year(item = {}) {
    const value = item.year || item.season_year || item.startDate?.year || item.aired || item.started_on || '';
    const found = String(value).match(/(?:19|20)\d{2}/);
    return found ? Number(found[0]) : null;
  }
  function part(item = {}) {
    const title = [item.title, item.title_english, item.title_japanese, item.title_native, item.originalTitle].filter(Boolean).join(' ');
    const value = String(item.season || item.part || '').normalize('NFKC').toLowerCase();
    const titleMarker = title.match(/(?:part|season|cour|시즌|파트)\s*[-:]?\s*(\d+)|(?:^|\s)(\d+)\s*기\b/i);
    if (titleMarker) return `part:${titleMarker[1] || titleMarker[2]}`;
    if (/movie|film|극장판/i.test(`${value} ${title}`)) return 'movie';
    if (/ova|oad/i.test(`${value} ${title}`)) return 'ova';
    if (/special|\bsp\b|스페셜/i.test(`${value} ${title}`)) return 'special';
    return value ? `season:${value}` : '';
  }
  function format(item = {}) {
    const value = String(item.type || item.format || item.category || '').toLowerCase();
    if (/movie|film|극장판/.test(value)) return 'movie';
    if (/ova|oad/.test(value)) return 'ova';
    if (/special|\bsp\b|스페셜/.test(value)) return 'special';
    if (/tv|series|anime/.test(value)) return 'series';
    return '';
  }
  function compatible(a, b) {
    const ay = year(a), by = year(b); if (ay != null && by != null && ay !== by) return false;
    const ap = part(a), bp = part(b); if (ap && bp && ap !== bp) return false;
    const af = format(a), bf = format(b); if (af && bf && af !== bf) return false;
    return true;
  }
  function resolve(scheduleEntry, candidates = [], provider = '') {
    const source = scheduleEntry?.anime || scheduleEntry || {};
    const matches = candidates.filter(candidate => {
      if (!candidate || candidate.mal_id == null || !compatible(source, candidate)) return false;
      if (provider && source.provider && source.provider !== provider && !positiveId(source.anilistId) && !positiveId(source.malId)) return false;
      if (source.provider && source.provider === candidate.provider && source.id != null && candidate.id != null && String(source.id) === String(candidate.id)) return true;
      if (positiveId(source.anilistId) && positiveId(source.anilistId) === positiveId(candidate.anilistId)) return true;
      if (positiveId(source.malId) && positiveId(source.malId) === positiveId(candidate.malId)) return true;
      const sourceYear = year(source), candidateYear = year(candidate);
      if (sourceYear == null || candidateYear == null || sourceYear !== candidateYear) return false;
      const sourceAliases = aliases(source), candidateAliases = new Set(aliases(candidate));
      return sourceAliases.some(alias => candidateAliases.has(alias));
    });
    return matches.length === 1 ? matches[0] : null;
  }
  const TOKYO = 'Asia/Tokyo';
  const DAY_INDEX = new Map([
    ['monday', 0], ['mon', 0], ['월', 0], ['월요일', 0],
    ['tuesday', 1], ['tue', 1], ['화', 1], ['화요일', 1],
    ['wednesday', 2], ['wed', 2], ['수', 2], ['수요일', 2],
    ['thursday', 3], ['thu', 3], ['목', 3], ['목요일', 3],
    ['friday', 4], ['fri', 4], ['금', 4], ['금요일', 4],
    ['saturday', 5], ['sat', 5], ['토', 5], ['토요일', 5],
    ['sunday', 6], ['sun', 6], ['일', 6], ['일요일', 6]
  ]);
  function zonedParts(epochMs, timeZone) {
    if (!Number.isFinite(epochMs)) return null;
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone, calendar: 'gregory', numberingSystem: 'latn',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date(epochMs)).map(part => [part.type, part.value]));
      const date = parts.year + '-' + parts.month + '-' + parts.day;
      const utcDate = new Date(date + 'T00:00:00Z');
      return { date, weekdayIndex: (utcDate.getUTCDay() + 6) % 7, time: parts.hour + ':' + parts.minute };
    } catch { return null; }
  }
  function localDateTime(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0'] = match;
    const parts = { year: Number(yearText), month: Number(monthText), day: Number(dayText), hour: Number(hourText), minute: Number(minuteText), second: Number(secondText) };
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    if (date.getUTCFullYear() !== parts.year || date.getUTCMonth() + 1 !== parts.month || date.getUTCDate() !== parts.day
        || parts.hour > 23 || parts.minute > 59 || parts.second > 59) return null;
    return parts;
  }
  function localInstant(parts, timeZone) {
    let instant = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    for (let attempt = 0; attempt < 5; attempt++) {
      const seen = zonedParts(instant, timeZone);
      if (!seen) return null;
      const seenDateTime = localDateTime(seen.date + 'T' + seen.time + ':00');
      if (!seenDateTime) return null;
      const difference = target - Date.UTC(seenDateTime.year, seenDateTime.month - 1, seenDateTime.day,
        seenDateTime.hour, seenDateTime.minute, seenDateTime.second);
      if (!difference) return instant;
      instant += difference;
    }
    const verified = zonedParts(instant, timeZone);
    const candidate = verified && localDateTime(verified.date + 'T' + verified.time + ':00');
    return candidate && candidate.year === parts.year && candidate.month === parts.month && candidate.day === parts.day
      && candidate.hour === parts.hour && candidate.minute === parts.minute && candidate.second === parts.second ? instant : null;
  }
  function normalizeJapaneseAiring(value = {}) {
    if (value.basis !== 'japanese-broadcast' && value.verifiedJapaneseBroadcast !== true) return null;
    const sourceTimeZone = String(value.timeZone || value.sourceTimeZone || '').trim();
    if (!sourceTimeZone) return null;

    const declaredDay = Number.isInteger(value.broadcastWeekdayIndex) && value.broadcastWeekdayIndex >= 0 && value.broadcastWeekdayIndex <= 6
      ? value.broadcastWeekdayIndex
      : DAY_INDEX.get(String(value.broadcastDay || value.weekday || '').trim().toLocaleLowerCase());
    const declaredTime = String(value.broadcastTime || value.time || '').trim();
    const timeMatch = declaredTime.match(/^(\d{1,2}):(\d{2})$/);
    if (declaredDay != null && timeMatch && sourceTimeZone === TOKYO) {
      const hour = Number(timeMatch[1]), minute = Number(timeMatch[2]);
      if (minute > 59 || hour > 29) return null;
      const extended = hour >= 24;
      const dateOffset = extended ? 1 : 0;
      const actualHour = extended ? hour - 24 : hour;
      return {
        weekdayIndex: declaredDay,
        weekday: DAYS[declaredDay],
        time: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'),
        actualWeekdayIndex: (declaredDay + dateOffset) % 7,
        actualTime: String(actualHour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'),
        dateOffset,
        timeZone: TOKYO,
        representation: extended ? 'japanese-extended-hour' : 'japanese-local-time'
      };
    }

    if (value.airingAt != null) {
      let instant = Number(value.airingAt);
      if (!Number.isFinite(instant) || instant <= 0) return null;
      if (instant < 10_000_000_000) instant *= 1000;
      const parts = zonedParts(instant, TOKYO);
      return parts ? { ...parts, weekday: DAYS[parts.weekdayIndex], actualWeekdayIndex: parts.weekdayIndex,
        actualTime: parts.time, dateOffset: 0, timeZone: TOKYO, representation: 'absolute-instant' } : null;
    }

    const local = localDateTime(value.localDateTime);
    if (!local) return null;
    const instant = localInstant(local, sourceTimeZone);
    if (instant == null) return null;
    const parts = zonedParts(instant, TOKYO);
    return parts ? { ...parts, weekday: DAYS[parts.weekdayIndex], actualWeekdayIndex: parts.weekdayIndex,
      actualTime: parts.time, dateOffset: 0, timeZone: TOKYO, sourceTimeZone, representation: 'zoned-local-time' } : null;
  }
  const PROVIDER_NAMES = { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24' };
  const SCHEDULE_PROVIDERS = Object.keys(PROVIDER_NAMES);
  const externalId = (item, camel, snake) => positiveId(item?.[camel] ?? item?.[snake]);
  function strictProviderScheduleMatch(scheduleItem, candidates = [], provider = '') {
    const source = scheduleItem?.anime || scheduleItem || {};
    const sourceAni = externalId(source, 'anilistId', 'anilist_id');
    const sourceMal = externalId(source, 'malId', 'mal_id');
    const sourceAliases = new Set(aliases(source));
    let hadMetadataMismatch = false, hadIdentifierConflict = false, hadMissingYear = false;
    const matches = [];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const candidateAni = externalId(candidate, 'anilistId', 'anilist_id');
      const candidateMal = externalId(candidate, 'malId', 'mal_id');
      const candidateAliases = new Set(aliases(candidate));
      const exactAlias = [...sourceAliases].some(alias => candidateAliases.has(alias));
      const sameProviderId = provider && source.provider === provider && candidate.provider === provider
        && source.id != null && candidate.id != null && String(source.id) === String(candidate.id);
      const sharedExternalId = Boolean((sourceAni && candidateAni && sourceAni === candidateAni)
        || (sourceMal && candidateMal && sourceMal === candidateMal));
      const plausibleIdentity = sameProviderId || sharedExternalId || exactAlias;
      if (!plausibleIdentity) continue;
      if ((sourceAni && candidateAni && sourceAni !== candidateAni) || (sourceMal && candidateMal && sourceMal !== candidateMal)) {
        hadIdentifierConflict = true;
        continue;
      }
      if (!compatible(source, candidate)) { hadMetadataMismatch = true; continue; }
      if (sameProviderId || sharedExternalId) { matches.push(candidate); continue; }

      const sourceYear = year(source), candidateYear = year(candidate);
      if (!sourceYear || !candidateYear) { hadMissingYear = true; continue; }
      if (sourceYear !== candidateYear) { hadMetadataMismatch = true; continue; }
      if (exactAlias) matches.push(candidate);
    }
    if (matches.length === 1) return { anime: matches[0], method: sourceAni || sourceMal ? 'stable-id' : 'source-id-or-exact-alias' };
    if (matches.length > 1) return { anime: null, reason: 'ambiguous-match' };
    return { anime: null, reason: hadIdentifierConflict ? 'identifier-conflict'
      : hadMetadataMismatch ? 'season-year-format-mismatch'
        : hadMissingYear ? 'year-unverified' : 'no-exact-identity' };
  }

  function reconcileProviderScheduleEvidence(evidence = [], candidates = []) {
    const byWork = new Map(), unmatched = [], seen = new Set();
    let duplicateRows = 0;
    for (const row of evidence) {
      const provider = String(row?.provider || ''), day = Number(row?.day);
      if (!SCHEDULE_PROVIDERS.includes(provider) || !Number.isInteger(day) || day < 0 || day > 6) continue;
      const match = strictProviderScheduleMatch(row, candidates, provider);
      if (!match.anime) {
        const source = row?.anime || row || {};
        unmatched.push({ provider, day, title: source.title || '', sourceId: String(source.id ?? row?.id ?? ''),
          anilistId: externalId(source, 'anilistId', 'anilist_id'), malId: externalId(source, 'malId', 'mal_id'),
          year: year(source), type: source.type || source.format || '', reason: match.reason || 'no-exact-identity' });
        continue;
      }
      const anime = match.anime, workKey = String(anime.mal_id ?? anime.id ?? '');
      const episode = Number(row.episode) > 0 ? Number(row.episode) : 0;
      const time = String(row.time || ''), track = String(row.track || '');
      const key = `${provider}|${workKey}|${day}|${episode}|${time}|${track}`;
      if (seen.has(key)) { duplicateRows++; continue; }
      seen.add(key);
      if (!byWork.has(workKey)) byWork.set(workKey, { anime, events: [], days: new Set() });
      const work = byWork.get(workKey);
      work.days.add(day);
      work.events.push({ provider, day, episode, time, track, timed: row.timed === true,
        reportedTime: String(row.reportedTime || row.time || ''), timeBasis: row.timeBasis || '', sourceNote: row.sourceNote || '', sourceId: String(row?.anime?.id ?? row?.id ?? ''),
        sourceTitle: String(row?.anime?.title || row?.title || ''), sourceAniListId: externalId(row?.anime, 'anilistId', 'anilist_id'),
        sourceMalId: externalId(row?.anime, 'malId', 'mal_id'), catalogId: workKey,
        catalogTitle: String(anime.title || ''), catalogYear: year(anime), catalogSeason: String(anime.season || ''),
        matchMethod: match.method });
    }

    const assigned = Array.from({ length: 7 }, () => []), conflicts = [], multiDayUnresolved = [];
    for (const work of byWork.values()) {
      work.events.sort((a, b) => SCHEDULE_PROVIDERS.indexOf(a.provider) - SCHEDULE_PROVIDERS.indexOf(b.provider)
        || a.episode - b.episode || a.time.localeCompare(b.time));
      const days = [...work.days].sort((a, b) => a - b);
      if (days.length === 1) assigned[days[0]].push({ anime: work.anime, item: { events: work.events } });
      else {
        const eventKeys = new Map();
        for (const event of work.events) {
          if (!event.episode) continue;
          const eventKey = `ep:${event.episode}:${event.track || '*'}`;
          if (!eventKeys.has(eventKey)) eventKeys.set(eventKey, new Set());
          eventKeys.get(eventKey).add(event.day);
        }
        const verifiedConflict = [...eventKeys.values()].some(eventDays => eventDays.size > 1);
        (verifiedConflict ? conflicts : multiDayUnresolved).push({ anime: work.anime, days, events: work.events,
          kind: verifiedConflict ? 'same-episode-different-day' : 'multiple-days-unresolved' });
      }
    }
    const matchedIds = new Set(byWork.keys());
    const unknown = candidates.filter(anime => !matchedIds.has(String(anime?.mal_id ?? anime?.id ?? '')));
    const matchedCount = byWork.size;
    const scheduleEvidence = [...byWork.values()].flatMap(work => work.events);
    return { assigned, conflicts, multiDayUnresolved, unknown, matchedCount, scheduleEvidence,
      assignedCount: assigned.reduce((sum, day) => sum + day.length, 0),
      conflictCount: conflicts.length, multiDayUnresolvedCount: multiDayUnresolved.length,
      unmatched, unmatchedCount: unmatched.length, identifierConflictCount: unmatched.filter(row => row.reason === 'identifier-conflict').length,
      metadataMismatchCount: unmatched.filter(row => row.reason === 'season-year-format-mismatch').length,
      duplicateRows };
  }
  root.LilacSeasonCalendarModel = { aliases, compatible, resolve, year, part, format, normalizeJapaneseAiring,
    SCHEDULE_PROVIDERS, PROVIDER_NAMES, strictProviderScheduleMatch, reconcileProviderScheduleEvidence };

  const rootView = document.querySelector('#searchView'), container = document.querySelector('#seasonCalendarView');
  const grid = document.querySelector('#seasonCalendarGrid'), unknownGrid = document.querySelector('#seasonCalendarUnknown');
  const conflictGrid = document.querySelector('#seasonCalendarConflicts');
  if (!rootView || !container || !grid || !unknownGrid || !conflictGrid) return;
  let request = 0, diagnostics = null;
  const currentQuarter = () => typeof currentQuarterSelection === 'function' ? currentQuarterSelection() : (() => { const d = new Date(); return { year: d.getFullYear(), quarter: Math.floor(d.getMonth() / 3) + 1 }; })();
  const providerDateKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const dayDates = () => {
    const today = new Date(providerDateKey(new Date()) + 'T12:00:00Z');
    const monday = new Date(today); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    return Array.from({ length: 7 }, (_, index) => { const date = new Date(monday); date.setUTCDate(monday.getUTCDate() + index); return date; });
  };
  const dateLabel = date => `${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
  const dedupe = items => [...new Map((items || []).filter(item => item?.mal_id != null).map(item => [String(item.mal_id), item])).values()];

  function makeCard(anime, meta = '', badge = '', clickable = true) {
    const card = document.createElement(clickable && anime?.mal_id != null ? 'button' : 'div');
    if (card.tagName === 'BUTTON') card.type = 'button';
    card.className = 'anime-card season-calendar-card';
    const poster = document.createElement('div'); poster.className = 'poster season-calendar-poster';
    const imageUrl = imageOf(anime || {});
    if (imageUrl) setBackgroundImage(poster, imageUrl);
    if (badge) { const label = document.createElement('span'); label.className = 'latest-episode-badge season-calendar-badge'; label.textContent = badge; poster.append(label); }
    const title = document.createElement('h3'); title.textContent = anime?.mal_id != null ? titleOf(anime) : anime?.title || '제목 확인 불가';
    const native = typeof originalTitleOf === 'function' ? originalTitleOf(anime) : '';
    if (native) { const original = document.createElement('span'); original.className = 'anime-card-native'; original.textContent = native; card.append(poster, title, original); }
    else card.append(poster, title);
    const description = document.createElement('p'); description.className = 'season-calendar-meta';
    description.textContent = meta || [anime?.year, anime?.type, anime?.episodes ? `${anime.episodes}화` : ''].filter(Boolean).join(' · ');
    card.append(description);
    if (card.tagName === 'BUTTON') {
      card.dataset.id = String(anime.mal_id);
      card.addEventListener('click', () => { rememberAnime(anime); openDetail(anime.mal_id, anime.groupKey ? { groupKey: anime.groupKey } : {}); });
    }
    return card;
  }
  function showDays(dates, assignments, errors) {
    const today = providerDateKey(new Date());
    grid.replaceChildren(...dates.map((date, index) => {
      const column = document.createElement('section'); column.className = 'season-calendar-day' + (providerDateKey(date) === today ? ' today' : ''); column.dataset.day = String(index);
      const head = document.createElement('header'); head.className = 'season-calendar-day-head';
      const title = document.createElement('h2'); title.textContent = DAYS[index];
      const count = document.createElement('span'); count.textContent = assignments[index].length + '개 · ' + dateLabel(date);
      head.append(title, count); const body = document.createElement('div'); body.className = 'season-calendar-day-items';
      if (assignments[index].length) {
        for (const row of assignments[index]) {
          const meta = row.item.events.map(event => [PROVIDER_NAMES[event.provider] || event.provider,
            event.episode ? event.episode + '화' : '', event.timed && event.time && event.timeBasis ? `${event.time} · ${event.timeBasis}` : '',
            event.track && event.track !== 'sub' ? event.track : ''].filter(Boolean).join(' · ')).join(' / ');
          body.append(makeCard(row.anime, meta, ''));
        }
      } else {
        const empty = document.createElement('p'); empty.className = 'season-calendar-day-empty';
        const dayState = errors[index]?.state;
        empty.textContent = dayState === 'loading' ? '확인 중' : ['failed', 'timeout'].includes(dayState) ? '일정 확인 불가'
          : dayState === 'partial' ? '일정 일부 확인 불가' : dayState === 'unsupported' ? '현재 주 일정만 제공' : '확인된 일정 없음'; body.append(empty);
      }
      column.append(head, body); return column;
    }));
  }
  function showUnmatched(items, scheduleState) {
    const heading = document.querySelector('#seasonCalendarUnknownTitle'), note = document.querySelector('#seasonCalendarUnknownNote');
    heading.textContent = scheduleState === 'failed' ? '일정 확인 불가 작품' : '요일 미확인 작품';
    document.querySelector('#seasonCalendarUnknownCount').textContent = `${items.length}개`;
    if (scheduleState === 'failed') note.textContent = '공급 사이트 일정 조회에 실패해 작품에 요일을 배정하지 않았습니다.';
    else if (scheduleState === 'partial') note.textContent = '일정 출처 일부에 응답이 없어 확인되지 않은 작품은 요일을 배정하지 않았습니다.';
    else if (scheduleState === 'historical-not-supported') note.textContent = '공식 공급 사이트 일정 API는 현재 주간 일정만 제공해 이 분기의 요일을 확인하지 않았습니다.';
    else note.textContent = '선택한 공급 사이트 일정에서 확인되지 않은 작품입니다. 제공 사이트의 업로드 일정은 일본 TV 방송 요일을 뜻하지 않습니다.';
    const badge = scheduleState === 'failed' ? '일정 확인 불가' : '요일 확인 안 됨';
    unknownGrid.replaceChildren(...items.map(anime => makeCard(anime, [anime.year, anime.type].filter(Boolean).join(' · '), badge)));
    document.querySelector('#seasonCalendarUnknownSection').classList.toggle('hidden', items.length === 0);
  }
  function showConflicts(items, unresolved = []) {
    const section = document.querySelector('#seasonCalendarConflictSection');
    const rows = [...items.map(item => ({ ...item, badge: '회차 요일 충돌' })), ...unresolved.map(item => ({ ...item, badge: '복수 요일 · 회차 확인 불가' }))];
    document.querySelector('#seasonCalendarConflictCount').textContent = `${rows.length}개`;
    conflictGrid.replaceChildren(...rows.map(({ anime, events, badge }) => {
      const detail = events.map(event => [PROVIDER_NAMES[event.provider] || event.provider, DAYS[event.day], event.episode ? `${event.episode}화` : '',
        event.timed && event.time && event.timeBasis ? `${event.time} · ${event.timeBasis}` : ''].filter(Boolean).join(' ')).join(' / ');
      const card = makeCard(anime, detail, badge); card.title = detail; return card;
    }));
    section.classList.toggle('hidden', rows.length === 0);
  }
  async function load(items, selection, label) {
    const token = ++request, catalogProvider = state.source, shows = dedupe(items), dates = dayDates();
    const current = currentQuarter(), selectedYear = Number(selection?.year || current.year), selectedQuarter = Number(selection?.quarter || current.quarter);
    const isCurrentQuarter = selectedYear === current.year && selectedQuarter === current.quarter;
    const emptyAssignments = Array.from({ length: 7 }, () => []);
    diagnostics = { provider: 'providerSchedule', preferredProvider: 'rean ime'.replace(' ', ''), catalogProvider,
      scheduleBasis: 'provider-site', weekTimeZone: 'Asia/Seoul', selectedYear, selectedQuarter, isCurrentQuarter,
      catalogCount: shows.length, scheduleRowCount: 0, matchedCatalogCount: 0, assignedCount: 0, unknownCount: shows.length,
      conflictCount: 0, multiDayUnresolvedCount: 0, duplicateRows: 0, unmatchedScheduleCount: 0,
      identifierConflictCount: 0, metadataMismatchCount: 0, sources: {}, dayResults: [] };
    document.querySelector('#seasonCalendarTitle').textContent = (label || '이번 시즌') + ' 주간 편성표';
    document.querySelector('#seasonCalendarSubtitle').textContent = shows.length + '개 작품 · 공급 사이트 일정 기준';
    document.querySelector('#seasonCalendarUnknownSection').classList.remove('hidden');
    document.querySelector('#seasonCalendarConflictSection').classList.add('hidden');
    if (!isCurrentQuarter) {
      document.querySelector('#seasonCalendarStatus').textContent = '공식 공급 사이트 일정 API는 현재 주간 일정만 제공해 선택한 분기의 요일을 배정하지 않았습니다.';
      showDays(dates, emptyAssignments, Array.from({ length: 7 }, () => ({ state: 'unsupported' })));
      showUnmatched(shows, 'historical-not-supported');
      diagnostics.state = 'historical-not-supported'; window.LilacSeasonCalendarDiagnostics = diagnostics; return;
    }

    const model = window.LilacSeasonCalendarModel;
    const providers = model.SCHEDULE_PROVIDERS;
    const evidence = [], providerResults = [];
    diagnostics.state = 'loading'; window.LilacSeasonCalendarDiagnostics = diagnostics;
    document.querySelector('#seasonCalendarStatus').textContent = `${model.PROVIDER_NAMES.reanime} 일정 확인 중…`;
    showDays(dates, emptyAssignments, Array.from({ length: 7 }, () => ({ state: 'loading' })));
    showUnmatched([], 'loading');

    async function requestDay(provider, calendarDay) {
      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('요청 시간 초과'), { code: 'ETIMEDOUT' })), 24000);
      });
      try {
        const providerDay = (calendarDay + 1) % 7; // providerSchedule uses Sunday=0; the calendar starts Monday.
        const result = await Promise.race([window.lilac.providerSchedule(provider, providerDay), timedOut]);
        if (!result || !Array.isArray(result.items)) return { state: 'failed', errorCode: 'invalid-response', items: [] };
        if (result.native !== true) return { state: result.sourceError === 'timeout' ? 'timeout' : 'failed',
          errorCode: result.sourceError || (result.failed ? 'provider-failed' : 'fallback-only'), fallbackRows: result.items.length, items: [] };
        return { state: 'success', timed: result.timed === true, note: String(result.note || ''), items: result.items };
      } catch (error) {
        return { state: error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed', errorCode: error?.code || 'ipc-error', items: [] };
      } finally { clearTimeout(timer); }
    }

    for (const provider of providers) {
      if (token !== request || catalogProvider !== state.source) return;
      document.querySelector('#seasonCalendarStatus').textContent = `${model.PROVIDER_NAMES[provider] || provider} 공급 사이트 일정 확인 중…`;
      const dayResults = await Promise.all(dates.map((_, day) => requestDay(provider, day)));
      if (token !== request || catalogProvider !== state.source) return;
      const successfulDays = dayResults.filter(result => result.state === 'success').length;
      const providerItems = dayResults.flatMap((result, day) => result.state === 'success'
        ? result.items.map(item => ({ provider, day, anime: item?.anime || item, episode: item?.episode,
          reportedTime: String(item?.time || ''),
          time: result.timed && result.note.includes('한국 시간') && /^\d{2}:\d{2}$/.test(String(item?.time || '')) ? String(item.time) : '',
          timed: result.timed === true && result.note.includes('한국 시간'),
          timeBasis: result.timed && result.note.includes('한국 시간') ? '한국 시간' : '', track: item?.track,
          sourceNote: result.note, sourceId: item?.id })) : []);
      evidence.push(...providerItems);
      const sourceMatchedCount = providerItems.reduce((count, row) => count + (model.strictProviderScheduleMatch(row, shows, provider).anime ? 1 : 0), 0);
      providerResults.push({ provider, dayResults, items: providerItems, successfulDays, sourceMatchedCount });
      diagnostics.sources[provider] = {
        state: successfulDays === 7 ? 'complete' : successfulDays > 0 ? 'partial' : 'failed',
        requests: dayResults.length, successfulDays, failedDays: dayResults.length - successfulDays,
        responseRows: providerItems.length, matchedRows: sourceMatchedCount,
        fallbackRowsIgnored: dayResults.reduce((sum, result) => sum + (Number(result.fallbackRows) || 0), 0),
        errors: dayResults.map((result, day) => result.state === 'success' ? null : { day, state: result.state, code: result.errorCode }).filter(Boolean)
      };
      diagnostics.scheduleRowCount += providerItems.length;
    }

    if (token !== request || catalogProvider !== state.source) return;
    const reconciled = model.reconcileProviderScheduleEvidence(evidence, shows);
    const sourceFailures = providerResults.reduce((sum, result) => sum + result.dayResults.filter(day => day.state !== 'success').length, 0);
    const sourceSuccesses = providerResults.reduce((sum, result) => sum + result.successfulDays, 0);
    const overallState = sourceSuccesses === 0 ? 'failed' : sourceFailures ? 'partial' : 'complete';
    const dayStates = Array.from({ length: 7 }, (_, day) => {
      const states = providerResults.map(result => result.dayResults[day]?.state);
      const succeeded = states.filter(value => value === 'success').length, failed = states.length - succeeded;
      return { day, state: succeeded === 0 ? 'failed' : failed ? 'partial' : 'success', count: reconciled.assigned[day].length,
        successfulSources: succeeded, failedSources: failed };
    });
    diagnostics.sources = Object.fromEntries(Object.entries(diagnostics.sources).map(([provider, result]) => {
      const rows = reconciled.unmatched.filter(row => row.provider === provider), reasons = {};
      for (const row of rows) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
      return [provider, { ...result, unmatchedRows: rows.length, unmatchedReasons: reasons,
        identifierConflicts: reasons['identifier-conflict'] || 0 }];
    }));
    diagnostics.matchedCatalogCount = reconciled.matchedCount;
    diagnostics.assignedCount = reconciled.assignedCount;
    diagnostics.unknownCount = reconciled.unknown.length;
    diagnostics.conflictCount = reconciled.conflictCount;
    diagnostics.multiDayUnresolvedCount = reconciled.multiDayUnresolvedCount;
    diagnostics.duplicateRows = reconciled.duplicateRows;
    diagnostics.unmatchedScheduleCount = reconciled.unmatchedCount;
    diagnostics.identifierConflictCount = reconciled.identifierConflictCount;
    diagnostics.metadataMismatchCount = reconciled.metadataMismatchCount;
    diagnostics.scheduleEvidence = reconciled.scheduleEvidence;
    diagnostics.unmatchedScheduleRows = reconciled.unmatched;
    diagnostics.dayResults = dayStates;
    diagnostics.providerErrors = Object.fromEntries(providerResults.map(result => [result.provider,
      result.dayResults.map((day, index) => day.state === 'success' ? null : { day: index, state: day.state, code: day.errorCode }).filter(Boolean)]));
    showDays(dates, reconciled.assigned, dayStates);
    showUnmatched(reconciled.unknown, overallState);
    showConflicts(reconciled.conflicts, reconciled.multiDayUnresolved);
    const sourceNote = providerResults.map(result => `${model.PROVIDER_NAMES[result.provider]} ${result.successfulDays}/7${result.sourceMatchedCount ? ` · ${result.sourceMatchedCount}행 연결` : ''}`)
      .join(' · ');
    document.querySelector('#seasonCalendarStatus').textContent = `${overallState === 'complete' ? '공급 사이트 일정 응답 완료' : overallState === 'partial' ? '공급 사이트 일정 일부 확인 불가' : '공급 사이트 일정 확인 불가'} · ${sourceNote} · 요일 배정 ${diagnostics.assignedCount}개 · 미확인 ${diagnostics.unknownCount}개 · 회차 요일 충돌 ${diagnostics.conflictCount}개 · 복수 요일 확인 필요 ${diagnostics.multiDayUnresolvedCount}개 · 중복 ${diagnostics.duplicateRows}건 · 미매칭 ${diagnostics.unmatchedScheduleCount}행`;
    diagnostics.state = overallState;
    window.LilacSeasonCalendarDiagnostics = diagnostics;
  }
  function open(items, label = '이번 시즌', selection = state.quarterSelection || currentQuarter()) {
    switchView('search'); rootView.classList.add('season-calendar-mode'); container.classList.remove('hidden');
    void load(items, selection, label);
  }
  document.querySelector('#seasonCalendarBack').onclick = () => switchView('home');
  window.LilacSeasonCalendar = { open, diagnostics: () => diagnostics };
})(window);
