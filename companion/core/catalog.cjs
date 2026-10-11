'use strict';

const quarter = require('../../src/quarter-selection.js');
const schedule = require('../../src/weekday-schedule.js');

const PROVIDERS = Object.freeze([
  { id: 'reanime', name: 'Re:Anime' },
  { id: 'miruro', name: 'Miruro' },
  { id: 'animenosub', name: 'Animenosub' },
  { id: 'ohli24', name: '애니24' },
  { id: 'linkkf', name: 'Linkkf' }
]);

const SEASONS = Object.freeze(['겨울', '봄', '여름', '가을']);
const DEMO_WORKS = Object.freeze([
  { key: 'moon-station', title: '달빛 정류장', english: 'Moonlit Station', day: 0, time: '21:00', episode: 4, anilistId: 910001, states: { reanime: 'playable', miruro: 'provided', animenosub: 'missing', ohli24: 'failed', linkkf: 'playable' } },
  { key: 'glass-garden', title: '유리 정원의 편지', english: 'Letters from the Glass Garden', day: 1, time: '22:30', episode: 3, anilistId: 910002, states: { reanime: 'provided', miruro: 'playable', animenosub: 'checking', ohli24: 'missing', linkkf: 'provided' } },
  { key: 'quiet-planet', title: '고요한 행성의 노래', english: 'Song of a Quiet Planet', day: 2, time: '23:15', episode: 6, anilistId: 910003, states: { reanime: 'missing', miruro: 'failed', animenosub: 'provided', ohli24: 'playable', linkkf: 'playable' } },
  { key: 'paper-moon', title: '종이달 우체국', english: 'The Paper Moon Post Office', day: 3, time: '20:45', episode: 2, anilistId: 910004, states: { reanime: 'checking', miruro: 'missing', animenosub: 'playable', ohli24: 'provided', linkkf: 'provided' } },
  { key: 'blue-library', title: '푸른 별 도서관', english: 'The Blue Star Library', day: 4, time: '22:00', episode: 8, anilistId: 910005, states: { reanime: 'playable', miruro: 'missing', animenosub: 'failed', ohli24: 'provided', linkkf: 'playable' } },
  { key: 'snow-orbit', title: '눈꽃 궤도의 기록', english: 'Snowflower Orbit', day: 5, time: '19:30', episode: 5, anilistId: 910006, states: { reanime: 'provided', miruro: 'checking', animenosub: 'missing', ohli24: 'failed', linkkf: 'playable' } },
  { key: 'dawn-telescope', title: '새벽의 망원경', english: 'The Dawn Telescope', day: 6, time: '20:00', episode: 1, anilistId: 910007, states: { reanime: 'missing', miruro: 'provided', animenosub: 'playable', ohli24: 'checking', linkkf: 'provided' } }
]);

function dateForWeekday(now, weekdayIndex, hour, minute) {
  const currentIndex = (now.getDay() + 6) % 7;
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  date.setDate(date.getDate() + ((weekdayIndex - currentIndex + 7) % 7));
  return date.getTime();
}

function sourceStatus(state, sourceEpisodes, episodeNumber) {
  const searchStatus = state === 'failed' ? { state: 'failed' } : state === 'checking' ? { state: 'searching' } : { state: 'done' };
  const exact = sourceEpisodes.filter(item => Number(item.number) === Number(episodeNumber)).length > 0;
  if (exact) return schedule.episodeAvailability(sourceEpisodes, episodeNumber);
  if (state === 'checking') return schedule.providerFallbackState(searchStatus, true);
  return schedule.providerFallbackState(searchStatus, false);
}

function sourceRows(work, episodeNumber = work.episode) {
  return PROVIDERS.map(provider => {
    const state = work.states[provider.id] || 'missing';
    const episodes = ['playable', 'provided'].includes(state)
      ? [{ number: work.episode, playable: state === 'playable' }]
      : [];
    return {
      provider: provider.id,
      name: provider.name,
      status: sourceStatus(state, episodes, episodeNumber),
      episodeNumber: Number(episodeNumber),
      synthetic: true
    };
  });
}

function buildDemoWeek(selection, now = new Date()) {
  const year = Number(selection?.year), quarterNumber = Number(selection?.quarter);
  if (!Number.isInteger(year) || !Number.isInteger(quarterNumber) || quarterNumber < 1 || quarterNumber > 4) {
    throw new RangeError('분기 선택이 올바르지 않습니다.');
  }
  const season = SEASONS[quarterNumber - 1];
  const linkkfDays = Array.from({ length: 7 }, () => []);
  const upcomingItems = [];

  for (const work of DEMO_WORKS) {
    const anchor = {
      provider: 'linkkf',
      id: `demo-linkkf-${work.key}`,
      demoKey: work.key,
      anilistId: work.anilistId,
      title: work.title,
      title_english: work.english,
      title_japanese: `${work.title} (가상 예시)`,
      type: 'TV',
      season: `${season} ${quarterNumber}분기`,
      year,
      weekdayEpisodeNumber: work.episode,
      weekdayAiringAt: dateForWeekday(now, work.day, Number(work.time.slice(0, 2)), Number(work.time.slice(3, 5)))
    };
    linkkfDays[work.day].push(anchor);

    // Patch 01 uses Re:Anime/Miruro AniList schedule entries with the Linkkf weekday list.
    // Keep this prototype's schedule inputs equally narrow; the other providers are episode checks only.
    for (const provider of ['reanime', 'miruro']) {
      upcomingItems.push({
        anime: { ...anchor, provider, id: `demo-${provider}-${work.key}` },
        episode: work.episode,
        airingAt: anchor.weekdayAiringAt
      });
    }
  }

  return schedule.mergeWeekdaySchedules(linkkfDays, upcomingItems).map((day, weekdayIndex) => day.map(item => {
    const work = DEMO_WORKS.find(entry => entry.key === item.demoKey);
    return {
      ...item,
      weekdayIndex,
      airingTime: work.time,
      weekdaySources: [...item.weekdaySources],
      sources: sourceRows(work),
      synthetic: true
    };
  }));
}

function matchDemoSources(anchor, candidates) {
  return schedule.combineScheduledSources(anchor, candidates);
}

module.exports = {
  DEMO_WORKS,
  PROVIDERS,
  SEASONS,
  buildDemoWeek,
  matchDemoSources,
  sourceRows,
  sourceStatus
};
