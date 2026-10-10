(function (root) {
  const PROVIDERS = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkkf'];

  function stableId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  function yearOf(item) {
    const value = String(item?.year || item?.seasonYear || item?.aired || item?.startDate?.year || '');
    const match = value.match(/(?:19|20)\d{2}/);
    return match ? Number(match[0]) : 0;
  }

  function aliases(item) {
    return [item?.title, item?.title_english, item?.title_japanese, item?.romaji, item?.english, item?.native,
      ...(Array.isArray(item?.synonyms) ? item.synonyms : String(item?.synonyms || '').split(/[,|]/))]
      .map(value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s:：'’"“”!！?？.,·・\-–—~〜()（）]/g, ''))
      .filter(Boolean);
  }

  function seasonMarker(item) {
    const text = [item?.title, item?.title_english, item?.title_japanese, item?.romaji, item?.type].filter(Boolean).join(' ');
    const match = text.match(/(?:\bseason\s*|\bs\s*)(\d{1,2})\b|\bpart\s*(\d{1,2})\b|(\d{1,2})\s*(?:기|期)/i);
    return match ? Number(match[1] || match[2] || match[3]) : 0;
  }

  function typeFamily(item) {
    const type = String(item?.type || item?.format || '').toLocaleLowerCase();
    if (/movie|film|극장판/.test(type)) return 'movie';
    if (/tv|series|ova|ona|special|tv\s*short/.test(type)) return 'series';
    return '';
  }

  // Cross-source matching is deliberately conservative. An AniList ID is authoritative;
  // without one, require a shared exact title and matching year so a sequel is not guessed.
  function matchesScheduledWork(anchor, candidate) {
    if (!anchor || !candidate || !PROVIDERS.includes(candidate.provider)) return false;
    const leftId = stableId(anchor.anilistId), rightId = stableId(candidate.anilistId);
    if (leftId && rightId) return leftId === rightId;

    const leftYear = yearOf(anchor), rightYear = yearOf(candidate);
    if (!leftYear || !rightYear || leftYear !== rightYear) return false;
    const leftType = typeFamily(anchor), rightType = typeFamily(candidate);
    if (leftType && rightType && leftType !== rightType) return false;
    const leftSeason = seasonMarker(anchor), rightSeason = seasonMarker(candidate);
    if (leftSeason !== rightSeason) return false;
    const rightAliases = new Set(aliases(candidate));
    return aliases(anchor).some(value => rightAliases.has(value));
  }

  function matchScheduledSources(anchor, candidates) {
    const found = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!matchesScheduledWork(anchor, candidate)) continue;
      if (!found.has(candidate.provider)) found.set(candidate.provider, candidate);
    }
    return [...found.values()];
  }

  function combineScheduledSources(anchor, candidates) {
    if (!anchor || !PROVIDERS.includes(anchor.provider)) return [];
    const seen = new Set(), combined = [];
    for (const item of [anchor, ...matchScheduledSources(anchor, candidates)]) {
      if (!item || seen.has(item.provider)) continue;
      seen.add(item.provider);
      combined.push(item);
    }
    return combined;
  }

  function localWeekday(airingAt) {
    let value = Number(airingAt);
    if (!Number.isFinite(value) || value <= 0) return -1;
    if (value < 10_000_000_000) value *= 1000;
    const day = new Date(value).getDay();
    return (day + 6) % 7;
  }

  function scheduleCacheKey(source, date = new Date()) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('유효한 날짜가 필요합니다.');
    const year = date.getFullYear(), quarter = Math.floor(date.getMonth() / 3) + 1;
    return `weekdaySchedule:v3:${year}:${quarter}:${String(source || '')}`;
  }

  function mergeWeekdaySchedules(linkkfDays, upcomingItems) {
    const days = Array.from({ length: 7 }, () => []);
    for (let day = 0; day < 7; day++) {
      const seen = new Set();
      for (const item of Array.isArray(linkkfDays?.[day]) ? linkkfDays[day] : []) {
        if (!item || item.provider !== 'linkkf') continue;
        const key = String(item.id || item.mal_id || aliases(item)[0] || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        days[day].push({ ...item, weekdaySchedule: true, weekdayIndex: day, weekdaySources: ['linkkf'] });
      }
    }
    const sorted = (Array.isArray(upcomingItems) ? upcomingItems : []).slice().sort((a, b) => Number(a?.airingAt) - Number(b?.airingAt));
    for (const entry of sorted) {
      const anime = entry?.anime, provider = anime?.provider, episode = Number(entry?.episode), day = localWeekday(entry?.airingAt);
      if (!anime || !PROVIDERS.includes(provider) || provider === 'linkkf' || day < 0 || !Number.isSafeInteger(episode) || episode <= 0) continue;
      const existing = days[day].find(item => matchesScheduledWork(item, anime));
      if (existing) {
        existing.weekdayEpisodeNumber ||= episode;
        existing.weekdayAiringAt ||= Number(entry.airingAt);
        if (!existing.anilistId && anime.anilistId) existing.anilistId = anime.anilistId;
        for (const key of ['title_english', 'title_japanese', 'romaji', 'season', 'type', 'year']) {
          if (!existing[key] && anime[key]) existing[key] = anime[key];
        }
        if (!existing.weekdaySources.includes(provider)) existing.weekdaySources.push(provider);
      } else {
        days[day].push({ ...anime, weekdaySchedule: true, weekdayIndex: day, weekdayEpisodeNumber: episode,
          weekdayAiringAt: Number(entry.airingAt), weekdaySources: [provider] });
      }
    }
    return days;
  }

  function episodeAvailability(episodes, episodeNumber) {
    const target = Number(episodeNumber);
    if (!Number.isSafeInteger(target) || target <= 0 || !Array.isArray(episodes)) return 'failed';
    const exact = episodes.filter(item => Number(item?.number) === target);
    if (!exact.length) return 'missing';
    return exact.some(item => item?.playable === true) ? 'playable' : 'provided';
  }

  function providerFallbackState(searchStatus, hasExactMatch) {
    if (hasExactMatch) return 'checking';
    if (['failed', 'skipped', 'partial'].includes(searchStatus?.state)) return 'failed';
    return 'missing';
  }

  const api = { PROVIDERS, matchesScheduledWork, matchScheduledSources, combineScheduledSources, localWeekday, scheduleCacheKey, mergeWeekdaySchedules, episodeAvailability, providerFallbackState };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LilacWeekdaySchedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
