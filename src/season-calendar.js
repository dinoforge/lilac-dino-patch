(function (root) {
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
  const PROVIDER_NAMES = { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkani: '링크애니' };
  const PROVIDER_LABELS = { ...PROVIDER_NAMES, AniList: 'AniList 일정', Jikan: 'Jikan 일정', 'official-tv': '일본 방송', linkkf: 'Linkkf', anissia: 'Anissia' };
  const OFFICIAL_JAPANESE_BROADCASTS = Object.freeze([
    { catalogId: 'reanime:reincarnated-as-a-sword-season-2-qf47ug', anilistId: 159042, titleJapanese: '転生したら剣でした 第2期',
      year: 2026, season: 'FALL', weekday: 'Wednesday', time: '24:00', station: 'TOKYO MX',
      sourceUrl: 'https://tenken-anime.com/onair.html', evidence: '10月7日より 毎週水曜日 24:00～',
      otherStationSchedules: ['ABCテレビ 수 26:15', 'BS朝日 금 23:00', 'AT-X 금 21:00'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:overgeared-vc4j78', anilistId: 212888, titleJapanese: 'テムパル～アイテムの力～',
      year: 2026, season: 'FALL', weekday: 'Friday', time: '23:30', station: 'TOKYO MX',
      sourceUrl: 'https://tempal-anime.net/onair/index.html', evidence: '2026年10月2日より 毎週金曜日23時30分から TOKYO MX、BS11にて放送開始',
      checkedAt: '2026-10-20' },
    { catalogId: 'reanime:hello-i-am-a-witch-and-my-crush-wants-me-to-make-a-love-potion-45tppp', anilistId: null,
      titleJapanese: 'どうも、好きな人に惚れ薬を依頼された魔女です。', year: 2026, season: 'FALL', weekday: 'Monday', time: '22:30', station: 'TOKYO MX',
      sourceUrl: 'https://horemajo-anime.com/onair/index.html', evidence: '10月5日（月）より 毎週月曜 22:30～',
      otherStationSchedules: ['AT-X 월 21:30', 'BS日テレ 월 23:00', 'RKB 월 27:00', 'MBS 화 26:30'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:i-m-dating-a-dark-summoner-zxn3gz', anilistId: 208025, titleJapanese: 'ダークサモナーとデキている',
      year: 2026, season: 'FALL', weekday: 'Sunday', time: '25:20', station: 'TOKYO MX',
      sourceUrl: 'https://darksummoner.deregula.com/onair/', evidence: '2026年10月4日 毎週日曜 25:20～',
      otherStationSchedules: ['BS11 수 25:15', 'AT-X 토 24:00'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:a-wild-last-boss-appeared-season-2-f6x3rc', anilistId: 204389, titleJapanese: '野生のラスボスが現れた！ 第2期',
      year: 2026, season: 'FALL', weekday: 'Saturday', time: '22:30', station: 'TOKYO MX',
      sourceUrl: 'https://lastboss-anime.com/onair/', evidence: '10月3日より毎週土曜 22:30～',
      otherStationSchedules: ['BS朝日 일 23:00', '関西テレビ 일 26:24', '長崎文化放送 수 25:20', '北海道テレビ 월 26:40'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:magical-explorer-fajd9a', anilistId: 169581,
      titleJapanese: 'マジカル★エクスプローラー　エロゲの友人キャラに転生したけど、ゲーム知識使って自由に生きる',
      year: 2026, season: 'FALL', weekday: 'Saturday', time: '24:00', station: 'TOKYO MX',
      sourceUrl: 'https://majieku.com/', evidence: '10月3日より 毎週土曜 24:00～',
      otherStationSchedules: ['とちぎテレビ·群馬テレビ·BS11 토 24:00', '東北放送 토 25:48', 'TVA 토 26:25', '読売テレビ 월 25:59', 'AT-X 월 23:00'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:psyren-9qpamm', anilistId: null, titleJapanese: 'PSYREN -サイレン-',
      year: 2026, season: 'FALL', weekday: 'Monday', time: '23:00', station: 'TOKYO MX',
      sourceUrl: 'https://psyren-anime.com/on-air', evidence: '10月5日より 毎週月曜23:00～',
      otherStationSchedules: ['BS11 월 23:00', 'サンテレビ 월 24:00', '三重テレビ 수 24:20'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:so-what-s-wrong-with-getting-reborn-as-a-goblin-5ykheh', anilistId: null,
      titleJapanese: '転生ゴブリンだけど質問ある？', year: 2026, season: 'FALL', weekday: 'Monday', time: '22:00', station: 'TOKYO MX',
      sourceUrl: 'https://tengobu-anime.com/onair/', evidence: '10月5日より毎週月曜日22:00～',
      otherStationSchedules: ['BS11 월 24:00', 'サンテレビ 월 24:30', 'AT-X 수 20:00'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:a-tale-of-the-secret-saint-88bpe5', anilistId: 187402,
      titleJapanese: '転生した大聖女は、聖女であることをひた隠す', year: 2026, season: 'FALL', weekday: 'Saturday', time: '22:00', station: 'TOKYO MX',
      sourceUrl: 'https://daiseijo-anime.com/onair/', evidence: '10月3日より毎週土曜日22:00～',
      otherStationSchedules: ['BS11 토 22:00', 'サンテレビ 토 22:30', 'AT-X 월 22:00'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:romelia-war-chronicle-ujgdre', anilistId: 180894,
      titleJapanese: 'ロメリア戦記 〜魔王を倒した後も人類やばそうだから軍隊組織した〜',
      year: 2026, season: 'FALL', weekday: 'Monday', time: '23:30', station: 'TOKYO MX',
      sourceUrl: 'https://romelia-senki.com/onair/', evidence: '10月5日（月） 毎週月曜23:30〜',
      otherStationSchedules: ['BS11·サンテレビ 월 23:30', 'KBS 월 24:00', 'CBC 토 26:43'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:my-girlfriend-s-friend-ew6fk3', anilistId: 211877, titleJapanese: '彼女の友達',
      year: 2026, season: 'FALL', weekday: 'Sunday', time: '25:05', station: 'TOKYO MX',
      sourceUrl: 'https://kanojo-no-tomodachi.deregula.com/', evidence: '2026年10月4日より毎週日曜25:05~',
      otherStationSchedules: ['BS11 수 25:00', 'AT-X 토 24:30'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:now-that-i-can-control-reality-with-a-mouse-cursor-i-m-gonna-click-away-on-the-girls-9g699f', anilistId: 206774,
      titleJapanese: 'マウスカーソルで現実を操作できるようになったので、女の子をいっぱいクリックしまーす',
      year: 2026, season: 'FALL', weekday: 'Sunday', time: '25:00', station: 'TOKYO MX',
      sourceUrl: 'https://maukuri.af-original.com/onair/', evidence: '2026年10月4日より 毎週日曜 25:00～',
      otherStationSchedules: ['BS11 일 25:00'], checkedAt: '2026-10-20' },
    { catalogId: 'reanime:from-far-away-2zcgzs', anilistId: 209463, titleJapanese: '彼方から',
      year: 2026, season: 'FALL', weekday: 'Sunday', time: '24:00', station: 'TOKYO MX',
      sourceUrl: 'https://www.hakusensha.co.jp/news/80388/', evidence: 'TOKYO MX 2026年10月4日（日）毎週日曜24:00～',
      otherStationSchedules: ['AT-X 수 23:30', 'ABCテレビ 토 26:30', 'WOWOW 화 24:00'], checkedAt: '2026-10-20' }
  ].map(record => Object.freeze({ ...record, basis: 'japanese-broadcast', timeZone: 'Asia/Tokyo', format: 'TV' })));
  const SCHEDULE_PROVIDERS = Object.keys(PROVIDER_NAMES);
  const WEEKLY_SERIES_FORMATS = new Set(['TV', 'TV SERIES', 'TV SHORT', 'ONA', 'WEB SERIES', 'SERIES']);
  const normalizeStatus = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[ _-]+/g, ' ').trim();
  const statusIsInactive = value => /\bnot yet released\b|\bupcoming\b|\bfinished\b|\bcomplete(?:d)?\b|\bended\b|\bcancelled\b|\bcanceled\b|\bhiatus\b|방영예정|종영|완결|결방/.test(normalizeStatus(value));
  const statusIsActive = value => /\breleasing\b|\bongoing\b|\bairing\b|\bbroadcast(?:ing)?\b|\bcurrently airing\b|\bon air\b|방영중|放送中/.test(normalizeStatus(value));
  function weeklyFormatDecision(items = []) {
    const values = items.flatMap(item => [item?.type, item?.format, item?.category]).map(value => String(value || '').normalize('NFKC').toLocaleUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const excluded = values.find(value => /MOVIE|FILM|극장판/.test(value));
    if (excluded) return { eligible: false, reason: 'format-movie' };
    if (values.some(value => /OVA|OAD/.test(value))) return { eligible: false, reason: 'format-ova' };
    if (values.some(value => /SPECIAL|\bSP\b|스페셜/.test(value))) return { eligible: false, reason: 'format-special' };
    const knownSeries = values.find(value => WEEKLY_SERIES_FORMATS.has(value));
    return knownSeries ? { eligible: true, format: knownSeries } : { eligible: false, reason: 'format-unverified' };
  }
  function weeklyReleaseEligibility(row = {}, candidate = row?.anime || row) {
    const source = row?.anime || row || {};
    if (row?.cancelled === true || /\bcancel(?:led|ed)\b|결방/.test(normalizeStatus(row?.airingStatus))) {
      return { eligible: false, reason: 'cancelled' };
    }
    const type = weeklyFormatDecision([source, candidate]);
    if (!type.eligible) return type;
    const statuses = [row?.airingStatus, source.status, candidate?.status].map(normalizeStatus).filter(Boolean);
    if (statuses.some(statusIsInactive)) return { eligible: false, reason: 'not-currently-releasing', format: type.format };
    if (!statuses.some(statusIsActive)) return { eligible: false, reason: 'release-status-unverified', format: type.format };
    const episode = Number(row?.episode);
    if (!Number.isSafeInteger(episode) || episode <= 0) return { eligible: false, reason: 'new-episode-unverified', format: type.format };
    const eventKind = normalizeStatus(row?.episodeType || row?.kind || row?.episodeKind);
    if (/special|recap|movie|ova|스페셜|극장판|총집편/.test(eventKind)) return { eligible: false, reason: 'non-regular-episode', format: type.format };
    return { eligible: true, reason: 'current-week-numbered-release', format: type.format, episode };
  }
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
    const byWork = new Map(), unmatched = [], excludedScheduleRows = [], seen = new Set(), matchedCatalogIds = new Set();
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
      matchedCatalogIds.add(workKey);
      const eligibility = weeklyReleaseEligibility(row, anime);
      if (!eligibility.eligible) {
        const source = row?.anime || row || {};
        const exclusionKey = `${provider}|${workKey}|${day}|${Number(row.episode) || 0}|${eligibility.reason}`;
        if (!seen.has(exclusionKey)) {
          seen.add(exclusionKey);
          excludedScheduleRows.push({ provider, day, catalogId: workKey, catalogTitle: anime.title || '', episode: Number(row.episode) || null,
            sourceId: String(source.id ?? row?.id ?? ''), sourceType: source.type || source.format || source.category || '',
            sourceStatus: source.status || '', airingStatus: row.airingStatus || '', reason: eligibility.reason });
        }
        continue;
      }
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
        sourceType: String(row?.anime?.type || row?.anime?.format || row?.anime?.category || ''), sourceStatus: String(row?.anime?.status || ''),
        airingStatus: String(row?.airingStatus || ''), scheduleDate: String(row?.scheduleDate || ''), eligibility: eligibility.reason,
        matchMethod: match.method });
    }

    const excludedBatchRows = [], filteredByWork = new Map();
    for (const [workKey, work] of byWork) {
      const byProvider = new Map();
      for (const event of work.events) {
        if (!byProvider.has(event.provider)) byProvider.set(event.provider, []);
        byProvider.get(event.provider).push(event);
      }
      const kept = [];
      for (const [provider, events] of byProvider) {
        const episodes = [...new Set(events.map(event => event.episode))];
        if (episodes.length > 1) {
          for (const event of events) excludedBatchRows.push({ ...event, reason: 'multiple-new-episodes-in-week' });
        } else kept.push(...events);
      }
      if (kept.length) filteredByWork.set(workKey, { anime: work.anime, events: kept });
    }

    const assigned = Array.from({ length: 7 }, () => []), conflicts = [], multiDayUnresolved = [], assignedWorks = new Set(), conflictWorks = new Set();
    for (const work of filteredByWork.values()) {
      work.events.sort((a, b) => SCHEDULE_PROVIDERS.indexOf(a.provider) - SCHEDULE_PROVIDERS.indexOf(b.provider)
        || a.episode - b.episode || a.time.localeCompare(b.time));
      const episodeNumbers = [...new Set(work.events.map(event => event.episode))];
      if (episodeNumbers.length > 1) {
        const days = [...new Set(work.events.map(event => event.day))].sort((a, b) => a - b);
        conflicts.push({ anime: work.anime, days, events: work.events, kind: 'providers-disagree-on-episode', episodes: episodeNumbers });
        conflictWorks.add(String(work.anime.mal_id ?? work.anime.id ?? ''));
        continue;
      }
      const eventsByDay = new Map();
      const keepOnDay = (day, events) => {
        if (!eventsByDay.has(day)) eventsByDay.set(day, []);
        eventsByDay.get(day).push(...events);
      };
      const episodeGroups = new Map();
      const unknownEpisodeEvents = [];
      for (const event of work.events) {
        if (!event.episode) { unknownEpisodeEvents.push(event); continue; }
        const eventKey = `ep:${event.episode}`;
        if (!episodeGroups.has(eventKey)) episodeGroups.set(eventKey, []);
        episodeGroups.get(eventKey).push(event);
      }
      for (const [eventKey, events] of episodeGroups) {
        const days = [...new Set(events.map(event => event.day))].sort((a, b) => a - b);
        if (days.length > 1) {
          conflicts.push({ anime: work.anime, days, events, kind: 'same-episode-different-day', episode: Number(eventKey.slice(3)) });
          conflictWorks.add(String(work.anime.mal_id ?? work.anime.id ?? ''));
          continue;
        }
        keepOnDay(days[0], events);
        assignedWorks.add(String(work.anime.mal_id ?? work.anime.id ?? ''));
      }
      if (unknownEpisodeEvents.length) {
        const days = [...new Set(unknownEpisodeEvents.map(event => event.day))].sort((a, b) => a - b);
        if (days.length > 1) {
          multiDayUnresolved.push({ anime: work.anime, days, events: unknownEpisodeEvents, kind: 'multiple-days-unresolved' });
          conflictWorks.add(String(work.anime.mal_id ?? work.anime.id ?? ''));
        } else {
          keepOnDay(days[0], unknownEpisodeEvents);
          assignedWorks.add(String(work.anime.mal_id ?? work.anime.id ?? ''));
        }
      }
      for (const [day, events] of eventsByDay) {
        events.sort((a, b) => SCHEDULE_PROVIDERS.indexOf(a.provider) - SCHEDULE_PROVIDERS.indexOf(b.provider)
          || a.episode - b.episode || a.time.localeCompare(b.time));
        assigned[day].push({ anime: work.anime, item: { events } });
      }
    }
    const excludedCatalog = [], unverifiedCatalog = [];
    for (const anime of candidates) {
      const workKey = String(anime?.mal_id ?? anime?.id ?? '');
      if (!workKey || assignedWorks.has(workKey) || conflictWorks.has(workKey) || filteredByWork.has(workKey)) continue;
      const type = weeklyFormatDecision([anime]);
      if (!type.eligible) excludedCatalog.push({ catalogId: workKey, title: anime?.title || '', reason: type.reason });
      else if ([anime?.status].filter(Boolean).some(statusIsInactive)) excludedCatalog.push({ catalogId: workKey, title: anime?.title || '', reason: 'not-currently-releasing' });
      else unverifiedCatalog.push({ ...anime, weeklyStatusReason: matchedCatalogIds.has(workKey) ? 'schedule-evidence-insufficient' : 'no-current-week-release' });
    }
    const unknown = unverifiedCatalog;
    const matchedCount = byWork.size;
    const scheduleEvidence = [...filteredByWork.values()].flatMap(work => work.events);
    const exclusionCounts = {};
    for (const item of excludedCatalog) exclusionCounts[item.reason] = (exclusionCounts[item.reason] || 0) + 1;
    for (const item of excludedScheduleRows) exclusionCounts[item.reason] = (exclusionCounts[item.reason] || 0) + 1;
    for (const item of excludedBatchRows) exclusionCounts[item.reason] = (exclusionCounts[item.reason] || 0) + 1;
    return { assigned, conflicts, multiDayUnresolved, unknown, matchedCount, scheduleEvidence, excludedScheduleRows, excludedBatchRows, excludedCatalog,
      weeklyReleaseCount: filteredByWork.size, unverifiedWeeklyCount: unknown.length, excludedCatalogCount: excludedCatalog.length, exclusionCounts,
      assignedCount: assignedWorks.size, assignedCardCount: assigned.reduce((sum, day) => sum + day.length, 0),
      conflictCount: conflicts.length, multiDayUnresolvedCount: multiDayUnresolved.length,
      unmatched, unmatchedCount: unmatched.length, identifierConflictCount: unmatched.filter(row => row.reason === 'identifier-conflict').length,
      metadataMismatchCount: unmatched.filter(row => row.reason === 'season-year-format-mismatch').length,
      duplicateRows };
  }
  const QUARTER_SEASONS = { 1: 'WINTER', 2: 'SPRING', 3: 'SUMMER', 4: 'FALL' };
  function japaneseScheduleCandidates(items = [], selectedYear, selectedQuarter) {
    const selectedSeason = QUARTER_SEASONS[Number(selectedQuarter)] || '';
    return items.map(anime => {
      const catalogId = String(anime?.mal_id ?? anime?.id ?? '').trim();
      if (!catalogId) return null;
      const values = [anime?.title, anime?.title_english, anime?.title_japanese, anime?.title_native,
        anime?.title_original, anime?.romaji, anime?.originalTitle, anime?.original_title];
      if (Array.isArray(anime?.synonyms)) values.push(...anime.synonyms);
      else if (typeof anime?.synonyms === 'string') values.push(...anime.synonyms.split(/[,|/]/));
      return {
        anime, catalogId,
        anilistId: externalId(anime, 'anilistId', 'anilist_id'),
        malId: positiveId(anime?.malId ?? anime?.mal_id),
        title: String(anime?.title || ''), titleEnglish: String(anime?.title_english || anime?.titleEnglish || ''),
        titleJapanese: String(anime?.title_japanese || anime?.titleJapanese || anime?.title_native || ''),
        romaji: String(anime?.romaji || anime?.title_romaji || ''),
        aliases: [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))],
        year: year(anime) || Number(selectedYear) || null,
        season: String(anime?.season || selectedSeason),
        format: String(anime?.type || anime?.format || anime?.category || '')
      };
    }).filter(Boolean);
  }
  function reconcileJapaneseBroadcastSchedule(response = {}, candidates = [], selectedYear, selectedQuarter) {
    const targetYear = Number(selectedYear), targetSeason = QUARTER_SEASONS[Number(selectedQuarter)] || '';
    const sourceResults = response?.sources && typeof response.sources === 'object' ? response.sources : {};
    const byAnilistId = new Map(), byCatalogId = new Map();
    for (const candidate of candidates) {
      const catalogId = String(candidate?.catalogId || '');
      if (!catalogId) continue;
      byCatalogId.set(catalogId, candidate);
      const id = positiveId(candidate?.anilistId);
      if (id) {
        if (!byAnilistId.has(id)) byAnilistId.set(id, []);
        byAnilistId.get(id).push(candidate);
      }
    }
    const works = new Map(), unmatched = [], seen = new Set();
    let rejectedMetadataCount = 0, rejectedIdentityCount = 0, duplicateRows = 0;
    const workFor = candidate => {
      const catalogId = String(candidate.catalogId);
      if (!works.has(catalogId)) works.set(catalogId, { anime: candidate.anime || candidate, anilist: [], jikan: [] });
      return works.get(catalogId);
    };
    const candidateEligible = candidate => {
      if (!candidate || !targetYear || !targetSeason) return false;
      const candidateYear = year(candidate.anime || candidate);
      if (candidateYear != null && candidateYear !== targetYear) return false;
      const candidateSeason = String(candidate.season || '').match(/winter|spring|summer|fall/i)?.[0]?.toUpperCase() || '';
      if (candidateSeason && candidateSeason !== targetSeason) return false;
      const kind = format(candidate.anime || candidate);
      if (kind && kind !== 'series') return false;
      return !['movie', 'ova', 'special'].includes(part(candidate.anime || candidate));
    };
    const addEvent = (source, candidate, row, normalized) => {
      const episode = positiveId(row?.episode);
      const eventKey = source === 'AniList'
        ? `${source}|${candidate.catalogId}|${episode || ''}|${row?.airingAt || ''}`
        : `${source}|${candidate.catalogId}|${row?.broadcastDay || ''}|${row?.broadcastTime || ''}`;
      if (seen.has(eventKey)) { duplicateRows++; return; }
      seen.add(eventKey);
      const event = {
        provider: source, source, day: normalized.weekdayIndex,
        episode: source === 'AniList' ? episode : positiveId(row?.episode),
        time: source === 'Jikan' ? String(row.broadcastTime || '') : normalized.time,
        timed: true, timeBasis: 'JST', timeZone: 'Asia/Tokyo',
        actualWeekdayIndex: normalized.actualWeekdayIndex, actualTime: normalized.actualTime,
        representation: normalized.representation, catalogId: String(candidate.catalogId),
        sourceId: source === 'AniList' ? `${row.anilistId}:${row.episode}:${row.airingAt}` : `${row.malId}:${row.broadcastDay}:${row.broadcastTime}`,
        identityMatch: row.identityMatch || (source === 'AniList' ? 'anilist-id' : ''),
        voteEligible: source === 'AniList' || positiveId(row?.episode) != null,
        voteGroup: 'anilist-jikan-upstream-relationship-unverified',
        scheduleKind: source === 'AniList' ? 'anilist-airing' : 'jikan-weekly-slot'
      };
      workFor(candidate)[source === 'AniList' ? 'anilist' : 'jikan'].push(event);
    };
    const aniRows = Array.isArray(sourceResults.AniList?.items) ? sourceResults.AniList.items : [];
    for (const row of aniRows) {
      const id = positiveId(row?.anilistId), matches = id ? byAnilistId.get(id) || [] : [];
      if (matches.length !== 1 || !candidateEligible(matches[0])) {
        rejectedIdentityCount++;
        unmatched.push({ source: 'AniList', anilistId: id, reason: matches.length > 1 ? 'ambiguous-catalog-id' : 'no-exact-catalog-id' });
        continue;
      }
      const candidate = matches[0], rowSeason = String(row?.season || '').toUpperCase();
      if (row?.countryOfOrigin !== 'JP' || !['TV', 'TV_SHORT'].includes(String(row?.format || '').toUpperCase())
          || Number(row?.seasonYear) !== targetYear || rowSeason !== targetSeason) {
        rejectedMetadataCount++;
        unmatched.push({ source: 'AniList', anilistId: id, reason: 'japanese-tv-season-mismatch' });
        continue;
      }
      const normalized = normalizeJapaneseAiring({ ...row, verifiedJapaneseBroadcast: true, timeZone: 'Asia/Tokyo' });
      if (!normalized) {
        rejectedMetadataCount++;
        unmatched.push({ source: 'AniList', anilistId: id, reason: 'airing-time-unverified' });
        continue;
      }
      addEvent('AniList', candidate, row, normalized);
    }
    const jikanRows = Array.isArray(sourceResults.Jikan?.items) ? sourceResults.Jikan.items : [];
    for (const row of jikanRows) {
      const candidate = byCatalogId.get(String(row?.catalogId || ''));
      if (!candidate || !candidateEligible(candidate)
          || !['mal-id', 'exact-title-season'].includes(String(row?.identityMatch || ''))) {
        rejectedIdentityCount++;
        unmatched.push({ source: 'Jikan', catalogId: String(row?.catalogId || ''), malId: positiveId(row?.malId), reason: 'unverified-catalog-match' });
        continue;
      }
      const rowSeason = String(row?.season || '').toUpperCase();
      const candidateMalId = positiveId(candidate?.malId);
      if (row?.verifiedJapaneseBroadcast !== true || row?.countryOfOrigin !== 'JP' || String(row?.format || '').toUpperCase() !== 'TV'
          || row?.timeZone !== 'Asia/Tokyo' || Number(row?.seasonYear) !== targetYear || rowSeason !== targetSeason
          || (candidateMalId && candidateMalId !== positiveId(row?.malId))) {
        rejectedMetadataCount++;
        unmatched.push({ source: 'Jikan', catalogId: String(row?.catalogId || ''), malId: positiveId(row?.malId), reason: 'japanese-tv-season-mismatch' });
        continue;
      }
      const normalized = normalizeJapaneseAiring(row);
      if (!normalized) {
        rejectedMetadataCount++;
        unmatched.push({ source: 'Jikan', catalogId: String(row?.catalogId || ''), malId: positiveId(row?.malId), reason: 'broadcast-time-unverified' });
        continue;
      }
      addEvent('Jikan', candidate, row, normalized);
    }

    const assigned = Array.from({ length: 7 }, () => []), conflicts = [], assignedWorks = new Set(), conflictWorks = new Set();
    for (const [catalogId, work] of works) {
      const { anime, anilist } = work;
      // Jikan's seasonal broadcast field is a recurring time slot, not an episode
      // identity. Keep it as supplemental evidence; only exact numbered episodes
      // from AniList or a provider release schedule can enter the vote.
      if (!anilist.length) continue;
      const byDay = new Map();
      const addToDay = (day, events) => {
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(...events);
      };
      const byEpisode = new Map();
      for (const event of anilist) {
        if (!Number.isSafeInteger(Number(event.episode)) || Number(event.episode) <= 0) continue;
        const episode = Number(event.episode);
        if (!byEpisode.has(episode)) byEpisode.set(episode, []);
        byEpisode.get(episode).push(event);
      }
      for (const [episode, events] of byEpisode) {
        const slots = new Set(events.map(event => `${event.actualWeekdayIndex}:${event.actualTime}`));
        if (slots.size > 1) {
          conflicts.push({ anime, days: [...new Set(events.map(event => event.day))].sort((a, b) => a - b),
            events, kind: 'anilist-episode-slot-disagrees', episode });
          conflictWorks.add(catalogId);
          continue;
        }
        for (const event of events) addToDay(event.day, [event]);
      }
      for (const [day, events] of byDay) {
        assigned[day].push({ anime, item: { events } });
        assignedWorks.add(catalogId);
      }
    }
    const excludedCatalog = [], unknown = [];
    for (const candidate of candidates) {
      const catalogId = String(candidate?.catalogId || '');
      if (!catalogId || assignedWorks.has(catalogId) || conflictWorks.has(catalogId)) continue;
      const anime = candidate.anime || candidate;
      const type = weeklyFormatDecision([anime]);
      if (!type.eligible) excludedCatalog.push({ catalogId, title: anime?.title || '', reason: type.reason });
      else unknown.push(anime);
    }
    const requestedSources = Object.values(sourceResults).filter(source => source?.state && source.state !== 'not-requested');
    const successfulSources = requestedSources.filter(source => ['complete', 'partial'].includes(source.state));
    const hasSourceFailure = requestedSources.some(source => !['complete', 'partial'].includes(source.state));
    const state = successfulSources.length === 0 ? 'failed' : hasSourceFailure ? 'partial' : 'complete';
    return {
      assigned, conflicts, unknown, excludedCatalog, state,
      assignedCount: assignedWorks.size, assignedCardCount: assigned.reduce((sum, day) => sum + day.length, 0),
      conflictCount: conflicts.length, unknownCount: unknown.length, excludedCatalogCount: excludedCatalog.length,
      duplicateRows, rejectedMetadataCount, rejectedIdentityCount, unmatched,
      matchedScheduleCount: works.size,
      scheduleEvidence: [...works.entries()].flatMap(([catalogId, work]) => [...work.anilist, ...work.jikan].map(event => ({ ...event, catalogId }))),
      sourceRelationships: [{ sources: ['AniList', 'Jikan'], relationship: 'upstream-independence-unverified',
        votePolicy: 'one shared evidence group; exact episode number required' }],
      sources: sourceResults, requestDiagnostics: response?.requestDiagnostics || {}
    };
  }
  function reconcileScheduleVotes(reconciled = {}, providerEvidence = [], candidates = [], selectedYear, selectedQuarter) {
    const targetYear = Number(selectedYear), targetSeason = QUARTER_SEASONS[Number(selectedQuarter)] || '';
    const assigned = Array.from({ length: 7 }, (_, day) => (reconciled.assigned?.[day] || []).map(row => ({
      ...row, item: { ...(row.item || {}), events: [...(row.item?.events || [])] }
    })));
    const conflicts = (reconciled.conflicts || []).map(row => ({ ...row, events: [...(row.events || [])], days: [...(row.days || [])] }));
    const candidatesById = new Map(candidates.map(candidate => [String(candidate?.catalogId || ''), candidate]).filter(([id]) => id));
    const exactVotes = [], supplementalEvidence = [], unmatchedProviderRows = [], sourceScheduleConflicts = [];
    const relationship = { AniList: 'schedule-index', Jikan: 'schedule-index' };
    const providerKeys = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'];
    const providerEvidenceCounts = Object.fromEntries(providerKeys.map(provider => [provider, {
      rows: 0, matchedRows: 0, exactEpisodeRows: 0, eligibleVoteRows: 0, supplementalRows: 0, unmatchedRows: 0
    }]));
    const catalogIdOf = anime => String(anime?.catalogId ?? anime?.mal_id ?? anime?.id ?? '');
    const targetCompatible = anime => {
      const animeYear = year(anime), animeSeason = String(anime?.season || '').match(/winter|spring|summer|fall/i)?.[0]?.toUpperCase() || '';
      return (!animeYear || animeYear === targetYear) && (!animeSeason || animeSeason === targetSeason);
    };
    const addExactVote = (value, candidate, provider, matchMethod) => {
      const episode = Number(value?.episode), day = Number(value?.day);
      if (!Number.isSafeInteger(episode) || episode <= 0 || !Number.isInteger(day) || day < 0 || day > 6) return false;
      const anime = candidate.anime || candidate;
      if (!targetCompatible(anime) || !weeklyFormatDecision([anime]).eligible) return false;
      const group = relationship[provider] || `provider:${provider}`;
      exactVotes.push({
        provider, voteGroup: group, day, episode,
        time: String(value.time || ''), timed: value.timed === true,
        timeBasis: String(value.timeBasis || ''), timeZone: String(value.timeZone || ''),
        track: String(value.track || ''), catalogId: String(candidate.catalogId),
        anime, sourceId: String(value.sourceId || value.id || ''),
        matchMethod: String(matchMethod || value.matchMethod || ''),
        sourceType: provider === 'AniList' || provider === 'Jikan' ? 'airing-index' : 'provider-release',
        relationship: provider === 'AniList' || provider === 'Jikan' ? 'AniList/Jikan upstream independence unverified' : 'provider-specific'
      });
      return true;
    };

    for (const event of reconciled.scheduleEvidence || []) {
      const provider = String(event?.source || event?.provider || ''), candidate = candidatesById.get(String(event?.catalogId || ''));
      if (!candidate) continue;
      if (Number.isSafeInteger(Number(event.episode)) && Number(event.episode) > 0) {
        addExactVote(event, candidate, provider, event.identityMatch);
      } else {
        supplementalEvidence.push({ ...event, catalogId: String(candidate.catalogId), voteEligible: false,
          reason: 'episode-number-unavailable' });
      }
    }

    for (const row of providerEvidence) {
      const provider = String(row?.provider || ''), day = Number(row?.day);
      if (!providerKeys.includes(provider) || !Number.isInteger(day) || day < 0 || day > 6) continue;
      const counts = providerEvidenceCounts[provider];
      counts.rows++;
      const sourceAnime = row?.anime || row;
      const match = strictProviderScheduleMatch(row, candidates, provider);
      if (!match.anime) {
        counts.unmatchedRows++;
        unmatchedProviderRows.push({ provider, day, title: sourceAnime?.title || '',
          sourceId: String(sourceAnime?.id ?? row?.id ?? ''), year: year(sourceAnime),
          type: sourceAnime?.type || sourceAnime?.format || '', reason: match.reason || 'no-exact-identity' });
        continue;
      }
      counts.matchedRows++;
      const candidate = match.anime, id = String(candidate.catalogId);
      const eligibility = weeklyReleaseEligibility(row, candidate.anime || candidate);
      const episode = Number(row?.episode);
      if (Number.isSafeInteger(episode) && episode > 0) counts.exactEpisodeRows++;
      if (!Number.isSafeInteger(episode) || episode <= 0) {
        counts.supplementalRows++;
        supplementalEvidence.push({ provider, day, catalogId: id, title: (candidate.anime || candidate).title || '',
          sourceId: String(sourceAnime?.id ?? row?.id ?? ''), episode: null, track: String(row.track || ''),
          sourceNote: String(row.sourceNote || ''), voteEligible: false, reason: 'episode-number-unavailable',
          matchMethod: match.method });
        continue;
      }
      if (!eligibility.eligible) {
        counts.supplementalRows++;
        supplementalEvidence.push({ provider, day, catalogId: id, title: (candidate.anime || candidate).title || '',
          sourceId: String(sourceAnime?.id ?? row?.id ?? ''), episode, track: String(row.track || ''),
          voteEligible: false, reason: eligibility.reason, matchMethod: match.method });
        continue;
      }
      if (addExactVote({ ...row, day, sourceId: sourceAnime?.id ?? row?.id, matchMethod: match.method }, candidate, provider, match.method)) {
        counts.eligibleVoteRows++;
      } else {
        counts.supplementalRows++;
        supplementalEvidence.push({ provider, day, catalogId: id, title: (candidate.anime || candidate).title || '',
          sourceId: String(sourceAnime?.id ?? row?.id ?? ''), episode, track: String(row.track || ''),
          sourceNote: String(row.sourceNote || ''), voteEligible: false, reason: 'selected-season-or-series-type-mismatch',
          matchMethod: match.method });
      }
    }

    const buckets = new Map();
    for (const vote of exactVotes) {
      const key = `${vote.catalogId}|${targetYear}:${targetSeason}|${vote.episode}`;
      if (!buckets.has(key)) buckets.set(key, { catalogId: vote.catalogId, anime: vote.anime,
        episode: vote.episode, sources: new Map(), events: [] });
      const bucket = buckets.get(key);
      bucket.events.push(vote);
      if (!bucket.sources.has(vote.voteGroup)) bucket.sources.set(vote.voteGroup, new Map());
      const byDay = bucket.sources.get(vote.voteGroup);
      if (!byDay.has(vote.day)) byDay.set(vote.day, []);
      byDay.get(vote.day).push(vote);
    }

    let duplicateTrackRows = 0;
    const voteResults = [], voteConflicts = [];
    const removeEpisodeFromAssigned = (catalogId, episode) => {
      for (let day = 0; day < assigned.length; day++) {
        for (let index = assigned[day].length - 1; index >= 0; index--) {
          const row = assigned[day][index];
          if (catalogIdOf(row.anime) !== catalogId) continue;
          const remaining = (row.item?.events || []).filter(event => Number(event.episode) !== episode);
          if (remaining.length === (row.item?.events || []).length) continue;
          if (!remaining.length) assigned[day].splice(index, 1);
          else row.item.events = remaining;
        }
      }
      for (let index = conflicts.length - 1; index >= 0; index--) {
        const conflict = conflicts[index];
        if (catalogIdOf(conflict.anime) !== catalogId) continue;
        const matchingEpisode = Number(conflict.episode) === episode
          || (conflict.events || []).some(event => Number(event.episode) === episode);
        if (matchingEpisode) conflicts.splice(index, 1);
      }
    };
    const addAssignment = (day, bucket, events, counts) => {
      const existing = assigned[day].find(row => catalogIdOf(row.anime) === bucket.catalogId);
      const seenEvidence = new Set(), evidence = [];
      for (const event of events) {
        const key = `${event.provider}|${event.episode}|${event.day}|${event.time}|${event.sourceId}|${event.track}`;
        if (seenEvidence.has(key)) continue;
        seenEvidence.add(key);
        evidence.push({ ...event, provider: event.provider, source: event.provider,
          catalogId: bucket.catalogId, episode: bucket.episode, voteCountByDay: counts });
      }
      if (existing) {
        const seen = new Set((existing.item?.events || []).map(event => `${event.provider}|${event.episode}|${event.day}|${event.sourceId}|${event.track}`));
        existing.item.events.push(...evidence.filter(event => !seen.has(`${event.provider}|${event.episode}|${event.day}|${event.sourceId}|${event.track}`)));
      } else assigned[day].push({ anime: bucket.anime, item: { events: evidence, voteCountByDay: counts } });
    };

    for (const bucket of buckets.values()) {
      const dayVotes = new Map(), sourceRows = [], internalConflicts = [];
      for (const [voteGroup, days] of bucket.sources) {
        const dayKeys = [...days.keys()].sort((a, b) => a - b);
        const sourceNames = [...new Set([...days.values()].flat().map(event => event.provider))].sort();
        if (dayKeys.length !== 1) {
          internalConflicts.push({ voteGroup, providers: sourceNames, days: dayKeys,
            events: [...days.values()].flat(), reason: 'one-source-disagrees-across-days' });
          continue;
        }
        const day = dayKeys[0], rows = days.get(day);
        duplicateTrackRows += Math.max(0, rows.length - 1);
        dayVotes.set(day, (dayVotes.get(day) || 0) + 1);
        sourceRows.push({ voteGroup, providers: sourceNames, day, rowCount: rows.length,
          tracks: [...new Set(rows.map(event => event.track).filter(Boolean))],
          independence: voteGroup === 'schedule-index' ? 'AniList/Jikan upstream relationship unverified; counted once' : 'provider source counted once' });
      }
      if (internalConflicts.length) sourceScheduleConflicts.push({ catalogId: bucket.catalogId,
        title: bucket.anime.title || '', episode: bucket.episode, conflicts: internalConflicts });
      if (!dayVotes.size) {
        if (internalConflicts.length) {
          removeEpisodeFromAssigned(bucket.catalogId, bucket.episode);
          const events = internalConflicts.flatMap(conflict => conflict.events);
          const conflict = { anime: bucket.anime,
            days: [...new Set(internalConflicts.flatMap(item => item.days))].sort((a, b) => a - b),
            events, kind: 'source-schedule-conflict', episode: bucket.episode, sourceConflicts: internalConflicts };
          conflicts.push(conflict);
        }
        continue;
      }
      const maxVotes = Math.max(...dayVotes.values());
      const winners = [...dayVotes.entries()].filter(([, count]) => count === maxVotes).map(([day]) => day).sort((a, b) => a - b);
      const counts = Object.fromEntries([...dayVotes.entries()].sort(([a], [b]) => a - b).map(([day, count]) => [DAYS[day], count]));
      const episodeEvents = bucket.events;
      removeEpisodeFromAssigned(bucket.catalogId, bucket.episode);
      const result = { catalogId: bucket.catalogId, title: bucket.anime.title || '', year: targetYear,
        season: targetSeason, episode: bucket.episode, dayVotes: counts, sourceVotes: sourceRows,
        sourceConflicts: internalConflicts, tie: winners.length > 1,
        winnerDay: winners.length === 1 ? winners[0] : null,
        providers: [...new Set(episodeEvents.map(event => event.provider))].sort() };
      voteResults.push(result);
      if (winners.length !== 1) {
        const eventDays = [...new Set(episodeEvents.map(event => event.day))].sort((a, b) => a - b);
        const conflict = { anime: bucket.anime, days: eventDays, events: episodeEvents,
          kind: 'schedule-vote-tie', episode: bucket.episode, dayVotes: counts, sourceVotes: sourceRows };
        conflicts.push(conflict); voteConflicts.push(conflict);
        continue;
      }
      const winningDay = winners[0], winningEvents = episodeEvents.filter(event => event.day === winningDay);
      addAssignment(winningDay, bucket, winningEvents, counts);
    }

    const assignedIds = new Set(assigned.flatMap(day => day.map(row => catalogIdOf(row.anime))).filter(Boolean));
    const conflictIds = new Set(conflicts.map(row => catalogIdOf(row.anime)).filter(Boolean));
    const unknown = (reconciled.unknown || []).filter(anime => !assignedIds.has(catalogIdOf(anime)) && !conflictIds.has(catalogIdOf(anime)));
    const unmatched = [...(reconciled.unmatched || []), ...unmatchedProviderRows];
    const sourceVoteSummary = {};
    for (const result of voteResults) for (const source of result.sourceVotes) {
      const group = source.voteGroup;
      if (!sourceVoteSummary[group]) sourceVoteSummary[group] = { voteGroup: group, providers: [], votes: 0, weekdays: {} };
      const summary = sourceVoteSummary[group];
      summary.providers = [...new Set([...summary.providers, ...source.providers])].sort();
      summary.votes++;
      const dayName = DAYS[source.day];
      summary.weekdays[dayName] = (summary.weekdays[dayName] || 0) + 1;
    }
    return {
      ...reconciled, assigned, conflicts, unknown, unmatched,
      scheduleEvidence: [...(reconciled.scheduleEvidence || []), ...exactVotes.filter(vote => providerKeys.includes(vote.provider))],
      supplementalEvidence: [...(reconciled.supplementalEvidence || []), ...supplementalEvidence],
      voteResults, sourceVoteSummary, sourceScheduleConflicts, voteConflicts, duplicateTrackRows, providerEvidenceCounts,
      assignedCount: assignedIds.size, assignedCardCount: assigned.reduce((sum, day) => sum + day.length, 0),
      conflictCount: new Set(conflicts.map(row => catalogIdOf(row.anime))).size,
      unknownCount: unknown.length, weeklyReleaseCount: new Set([...assignedIds, ...conflictIds]).size,
      unverifiedWeeklyCount: unknown.length, unmatchedCount: unmatched.length,
      sourceRelationships: [{ sources: ['AniList', 'Jikan'], relationship: 'upstream-independence-unverified',
        votePolicy: 'counted as one shared source group only when exact episode number is present' }]
    };
  }
  function applyOfficialJapaneseBroadcasts(reconciled = {}, candidates = [], selectedYear, selectedQuarter) {
    const targetYear = Number(selectedYear), targetSeason = QUARTER_SEASONS[Number(selectedQuarter)] || '';
    const assigned = Array.from({ length: 7 }, (_, day) => (reconciled.assigned?.[day] || []).map(row => ({
      ...row, item: { ...(row.item || {}), events: [...(row.item?.events || [])] }
    })));
    const conflicts = (reconciled.conflicts || []).map(row => ({ ...row, events: [...(row.events || [])], days: [...(row.days || [])] }));
    const unknown = [...(reconciled.unknown || [])], officialScheduleEvidence = [], rejectedOfficialSchedules = [];
    const workId = anime => String(anime?.catalogId ?? anime?.mal_id ?? anime?.id ?? '');
    const normalizedTitle = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const seasonOf = item => String(item?.season || '').normalize('NFKC').toUpperCase();
    const reject = (record, reason) => rejectedOfficialSchedules.push({ catalogId: record.catalogId, sourceUrl: record.sourceUrl, reason });

    for (const record of OFFICIAL_JAPANESE_BROADCASTS) {
      if (record.year !== targetYear || record.season !== targetSeason) continue;
      const matchingCandidates = candidates.filter(candidate => String(candidate?.catalogId || '') === record.catalogId);
      if (matchingCandidates.length !== 1) { reject(record, matchingCandidates.length ? 'ambiguous-catalog-id' : 'catalog-id-not-found'); continue; }
      const candidate = matchingCandidates[0], anime = candidate.anime || candidate;
      const candidateAniListId = externalId(candidate, 'anilistId', 'anilist_id') || externalId(anime, 'anilistId', 'anilist_id');
      const candidateYear = year(anime), candidateSeason = seasonOf(candidate.season ? candidate : anime);
      if (candidateYear !== record.year || candidateSeason !== record.season) { reject(record, 'catalog-season-year-mismatch'); continue; }
      if (record.anilistId != null && candidateAniListId !== record.anilistId) { reject(record, 'anilist-id-mismatch'); continue; }
      if (record.anilistId == null && normalizedTitle(anime.title_japanese || anime.titleJapanese || anime.title_native || '') !== normalizedTitle(record.titleJapanese)) {
        reject(record, 'exact-japanese-title-mismatch'); continue;
      }
      const type = weeklyFormatDecision([anime]);
      if (!type.eligible || ['movie', 'ova', 'special'].includes(part(anime))) { reject(record, type.reason || 'catalog-format-mismatch'); continue; }
      if (statusIsInactive(anime.status) || !statusIsActive(anime.status)) { reject(record, 'catalog-not-currently-releasing'); continue; }
      const conflictingIdentity = record.anilistId != null && (reconciled.unmatched || []).some(row =>
        row.source === 'AniList' && Number(row.anilistId) === record.anilistId && row.reason === 'japanese-tv-season-mismatch');
      if (conflictingIdentity) { reject(record, 'anilist-season-or-format-conflict'); continue; }

      const normalized = normalizeJapaneseAiring({
        basis: record.basis, verifiedJapaneseBroadcast: true, broadcastDay: record.weekday,
        broadcastTime: record.time, timeZone: record.timeZone
      });
      if (!normalized) { reject(record, 'invalid-official-weekday-time'); continue; }
      const event = {
        provider: 'official-tv', source: 'official-tv', day: normalized.weekdayIndex, episode: null,
        time: record.time, timed: true, timeBasis: 'JST', timeZone: record.timeZone,
        actualWeekdayIndex: normalized.actualWeekdayIndex, actualTime: normalized.actualTime,
        representation: normalized.representation, catalogId: record.catalogId,
        sourceId: `official-tv:${record.catalogId}:${record.year}-${record.season}:${normalized.weekdayIndex}:${record.time}`,
        identityMatch: record.anilistId == null ? 'exact-catalog-title-season' : 'anilist-id-and-catalog-id',
        station: record.station, sourceUrl: record.sourceUrl, sourceEvidence: record.evidence, checkedAt: record.checkedAt
      };
      const existingConflict = conflicts.find(row => workId(row.anime) === record.catalogId);
      const existingLocations = [];
      for (let day = 0; day < assigned.length; day++) {
        for (let index = 0; index < assigned[day].length; index++) {
          if (workId(assigned[day][index].anime) === record.catalogId) existingLocations.push({ day, index, row: assigned[day][index] });
        }
      }
      let outcome = 'assigned';
      if (existingConflict) {
        existingConflict.supplementalEvidence = [...(existingConflict.supplementalEvidence || []), event];
        outcome = 'supplemental-conflict-preserved';
      } else if (existingLocations.length) {
        const sameDay = existingLocations.some(location => location.day === event.day);
        for (const location of existingLocations) {
          location.row.item.supplementalEvidence = [...(location.row.item.supplementalEvidence || []), event];
        }
        outcome = sameDay ? 'supplemental-same-day' : 'supplemental-different-schedule-basis';
      } else {
        assigned[event.day].push({ anime, item: { events: [event] } });
        outcome = 'verified-fallback-assignment';
      }
      for (let index = unknown.length - 1; index >= 0; index--) if (workId(unknown[index]) === record.catalogId) unknown.splice(index, 1);
      officialScheduleEvidence.push({
        catalogId: record.catalogId, anilistId: record.anilistId, malId: candidate.malId || null,
        title: record.titleJapanese, year: record.year, season: record.season,
        weekday: normalized.weekday, weekdayIndex: normalized.weekdayIndex, time: record.time,
        timeZone: record.timeZone, basis: record.basis, station: record.station,
        otherStationSchedules: record.otherStationSchedules || [], sourceUrl: record.sourceUrl,
        evidence: record.evidence, checkedAt: record.checkedAt, outcome,
        voteEligible: false, evidenceRole: outcome === 'verified-fallback-assignment' ? 'fallback' : 'supplemental'
      });
    }

    const assignedIds = new Set(assigned.flatMap(day => day.map(row => workId(row.anime))).filter(Boolean));
    const conflictIds = new Set(conflicts.map(row => workId(row.anime)).filter(Boolean));
    const scheduledIds = new Set([...assignedIds, ...conflictIds]);
    const hasOfficialEvidence = officialScheduleEvidence.length > 0;
    return {
      ...reconciled, assigned, conflicts, unknown, officialScheduleEvidence, rejectedOfficialSchedules,
      state: reconciled.state === 'failed' && hasOfficialEvidence ? 'partial' : reconciled.state,
      assignedCount: assignedIds.size, assignedCardCount: assigned.reduce((sum, day) => sum + day.length, 0),
      conflictCount: conflicts.length, unknownCount: unknown.length,
      matchedScheduleCount: scheduledIds.size, weeklyReleaseCount: scheduledIds.size,
      unverifiedWeeklyCount: unknown.length,
      scheduleEvidence: [...(reconciled.scheduleEvidence || []), ...officialScheduleEvidence.map(record => ({ ...record, source: 'official-tv' }))]
    };
  }
  root.LilacSeasonCalendarModel = { aliases, compatible, resolve, year, part, format, normalizeJapaneseAiring,
    SCHEDULE_PROVIDERS, PROVIDER_NAMES, strictProviderScheduleMatch, weeklyFormatDecision, weeklyReleaseEligibility, reconcileProviderScheduleEvidence,
    japaneseScheduleCandidates, reconcileJapaneseBroadcastSchedule, reconcileScheduleVotes, applyOfficialJapaneseBroadcasts,
    OFFICIAL_JAPANESE_BROADCASTS };

  const providerScheduleCache = new Map(), providerSchedulePending = new Map();
  const providerScheduleTtlMs = 5 * 60 * 1000;
  const providerScheduleCounts = { requests: 0, cacheHits: 0, inFlightJoins: 0 };
  function requestProviderSchedule(provider, day, dateKey, options = {}) {
    const key = `${provider}|${dateKey}`;
    const cached = providerScheduleCache.get(key);
    if (!options.refresh && cached && Date.now() - cached.at < providerScheduleTtlMs) {
      providerScheduleCounts.cacheHits++;
      return Promise.resolve(cached.value);
    }
    if (providerSchedulePending.has(key)) {
      providerScheduleCounts.inFlightJoins++;
      return providerSchedulePending.get(key);
    }
    providerScheduleCounts.requests++;
    const work = Promise.resolve().then(() => root.lilac.providerSchedule(provider, day)).then(value => {
      if (value && Array.isArray(value.items)) providerScheduleCache.set(key, { at: Date.now(), value });
      return value;
    }).finally(() => providerSchedulePending.delete(key));
    providerSchedulePending.set(key, work);
    return work;
  }
  root.LilacProviderScheduleClient = {
    get: requestProviderSchedule,
    diagnostics: () => ({ ...providerScheduleCounts, cachedDays: providerScheduleCache.size, pendingDays: providerSchedulePending.size })
  };
  const PROVIDER_VOTE_KEYS = Object.keys(PROVIDER_NAMES);
  async function collectProviderScheduleEvidence(dates, includeCurrentWeek) {
    const sources = Object.fromEntries(PROVIDER_VOTE_KEYS.map(provider => [provider, {
      provider, label: PROVIDER_NAMES[provider], state: includeCurrentWeek ? 'loading' : 'not-requested',
      reason: includeCurrentWeek ? '' : 'selected-quarter-is-not-current-week', dayResults: [], responseRows: 0,
      nativeRows: 0, exactEpisodeRows: 0, rowsWithoutEpisode: 0, fallbackRows: 0
    }]));
    if (!includeCurrentWeek) return { sources, evidence: [] };
    const tasks = PROVIDER_VOTE_KEYS.flatMap(provider => dates.map((date, calendarDay) => ({ provider, date, calendarDay })));
    const evidence = [], failures = new Map();
    const boundedGet = (provider, day, dateKey) => {
      let timer;
      return Promise.race([
        requestProviderSchedule(provider, day, dateKey),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('공급원 일정 요청 시간 초과'), { code: 'SCHEDULE_IPC_TIMEOUT' })), 26000); })
      ]).finally(() => clearTimeout(timer));
    };
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++], providerDay = (task.calendarDay + 1) % 7;
        const dateKey = providerDateKey(task.date), source = sources[task.provider];
        let result;
        try {
          result = await boundedGet(task.provider, providerDay, dateKey);
          const rows = Array.isArray(result?.items) ? result.items : [];
          source.responseRows += rows.length;
          const native = result?.native === true;
          const dayResult = { calendarDay: task.calendarDay, providerDay, date: dateKey,
            state: native ? 'complete' : result?.failed ? (result?.sourceError || 'failed') : 'fallback',
            native, responseRows: rows.length, errorCode: result?.sourceError || '',
            nativeFailure: result?.nativeFailure || null, fallbackFailure: result?.fallbackFailure || null,
            fallbackSource: native ? '' : (result?.note || '대체 일정') };
          source.dayResults.push(dayResult);
          if (!native) {
            source.fallbackRows += rows.length;
            failures.set(task.provider, (failures.get(task.provider) || 0) + 1);
            continue;
          }
          source.nativeRows += rows.length;
          for (const item of rows) {
            const row = { ...item, provider: task.provider, day: task.calendarDay,
              anime: item?.anime || item, timed: result.timed === true,
              timeBasis: result.timed === true ? 'KST' : '', timeZone: result.timed === true ? 'Asia/Seoul' : '',
              scheduleDate: dateKey };
            if (Number.isSafeInteger(Number(row.episode)) && Number(row.episode) > 0) source.exactEpisodeRows++;
            else source.rowsWithoutEpisode++;
            evidence.push(row);
          }
        } catch (error) {
          source.dayResults.push({ calendarDay: task.calendarDay, providerDay, date: dateKey,
            state: error?.code === 'SCHEDULE_IPC_TIMEOUT' ? 'timeout' : 'failed',
            errorCode: String(error?.code || 'schedule-error') });
          failures.set(task.provider, (failures.get(task.provider) || 0) + 1);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, () => worker()));
    for (const source of Object.values(sources)) {
      const failuresForSource = failures.get(source.provider) || 0;
      source.state = failuresForSource === 0 ? 'complete' : source.dayResults.some(row => row.state === 'complete') ? 'partial' : 'failed';
      source.failedDays = failuresForSource;
      source.exactEpisodeRows = Number(source.exactEpisodeRows) || 0;
      source.rowsWithoutEpisode = Number(source.rowsWithoutEpisode) || 0;
      source.note = source.rowsWithoutEpisode ? '회차 번호가 없는 일정 행은 투표하지 않음' : '';
    }
    return { sources, evidence };
  }
  root.LilacSeasonCalendarModel.collectProviderScheduleEvidence = collectProviderScheduleEvidence;

  const rootView = document.querySelector('#searchView'), container = document.querySelector('#seasonCalendarView');
  const grid = document.querySelector('#seasonCalendarGrid'), unknownGrid = document.querySelector('#seasonCalendarUnknown');
  const conflictGrid = document.querySelector('#seasonCalendarConflicts');
  if (!rootView || !container || !grid || !unknownGrid || !conflictGrid) return;
  if (typeof MutationObserver === 'function') {
    const titleTooltipObserver = new MutationObserver(records => {
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const title = target?.closest?.('.season-calendar-card [data-title-for]');
        if (title) title.title = title.textContent.trim();
      }
    });
    titleTooltipObserver.observe(container, { subtree: true, childList: true, characterData: true });
  }
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

  function makeCard(anime, meta = '', badge = '', clickable = true, activate) {
    const card = document.createElement(clickable ? 'button' : 'div');
    if (card.tagName === 'BUTTON') card.type = 'button';
    card.className = 'anime-card season-calendar-card';
    const poster = document.createElement('div'); poster.className = 'poster season-calendar-poster';
    const imageUrl = imageOf(anime || {});
    if (imageUrl) setBackgroundImage(poster, imageUrl);
    if (badge) { const label = document.createElement('span'); label.className = 'latest-episode-badge season-calendar-badge'; label.textContent = badge; poster.append(label); }
    const title = document.createElement('h3'); title.textContent = anime?.mal_id != null ? titleOf(anime) : anime?.title || '제목 확인 불가';
    title.title = title.textContent;
    if (anime?.mal_id != null && typeof animeTitleKey === 'function') title.dataset.titleFor = animeTitleKey(anime);
    const native = typeof originalTitleOf === 'function' ? originalTitleOf(anime) : '';
    const original = document.createElement('span'); original.className = 'anime-card-native'; original.textContent = native;
    if (!native) original.setAttribute('aria-hidden', 'true');
    card.append(poster, title, original);
    const description = document.createElement('p'); description.className = 'season-calendar-meta';
    description.textContent = meta || [anime?.year, anime?.type, anime?.episodes ? `${anime.episodes}화` : ''].filter(Boolean).join(' · ');
    if (description.textContent) description.title = description.textContent;
    card.append(description);
    if (card.tagName === 'BUTTON') {
      if (anime?.mal_id != null) card.dataset.id = String(anime.mal_id);
      card.addEventListener('click', () => {
        if (typeof activate === 'function') { activate(anime); return; }
        if (anime?.mal_id == null) return;
        rememberAnime(anime); openDetail(anime.mal_id, anime.groupKey ? { groupKey: anime.groupKey } : {});
      });
    }
    return card;
  }
  function eventMeta(events = []) {
    const grouped = new Map();
    for (const event of events) {
      const provider = String(event.provider || ''), episode = Number(event.episode) || 0;
      const time = event.timed && event.time && event.timeBasis ? String(event.time) : '';
      const timeBasis = time ? String(event.timeBasis) : '';
      const key = `${provider}|${episode}|${time}|${timeBasis}`;
      if (!grouped.has(key)) grouped.set(key, { provider, episode, time, timeBasis, cancelled: false, tracks: new Set() });
      if (event.cancelled) grouped.get(key).cancelled = true;
      if (event.track) grouped.get(key).tracks.add(String(event.track));
    }
    return [...grouped.values()].map(event => {
      const parts = [PROVIDER_LABELS[event.provider] || event.provider, event.episode ? `${event.episode}화` : '',
        event.time ? `${event.time} · ${event.timeBasis}` : '', event.cancelled ? '결방' : ''];
      const tracks = event.tracks;
      if (tracks.has('sub') && tracks.has('dub')) parts.push('자막·더빙');
      else if (tracks.has('dub')) parts.push('더빙');
      else if (tracks.has('raw')) parts.push('원어');
      return parts.filter(Boolean).join(' · ');
    }).join(' / ');
  }
  function showDays(dates, assignments, errors, targetGrid = grid) {
    const today = providerDateKey(new Date());
    const scrollLeft = targetGrid.scrollLeft;
    targetGrid.setAttribute('aria-busy', String(errors.some(error => error?.state === 'loading')));
    targetGrid.replaceChildren(...dates.map((date, index) => {
      const column = document.createElement('section'); column.className = 'season-calendar-day' + (providerDateKey(date) === today ? ' today' : ''); column.dataset.day = String(index);
      column.dataset.date = date.toISOString().slice(0, 10);
      const head = document.createElement('header'); head.className = 'season-calendar-day-head';
      const title = document.createElement('h2'); title.textContent = DAYS[index];
      const count = document.createElement('span'); count.textContent = assignments[index].length + '개 · ' + dateLabel(date);
      head.append(title, count); const body = document.createElement('div'); body.className = 'season-calendar-day-items';
      if (assignments[index].length) {
        for (const row of assignments[index]) {
          const meta = eventMeta(row.item?.events || []);
          body.append(typeof row.render === 'function' ? row.render(row.anime, meta) : makeCard(row.anime, meta, ''));
        }
      } else {
        const empty = document.createElement('p'); empty.className = 'season-calendar-day-empty';
        const dayState = errors[index]?.state;
        empty.textContent = dayState === 'loading' ? '확인 중' : ['failed', 'timeout'].includes(dayState) ? '일정 확인 불가'
          : dayState === 'partial' ? '일정 일부 확인 불가' : dayState === 'unsupported' ? '선택 공급원 일정 미지원' : '확인된 일정 없음'; body.append(empty);
      }
      column.append(head, body); return column;
    }));
    targetGrid.scrollLeft = scrollLeft;
  }
  function showUnmatched(items, scheduleState) {
    const heading = document.querySelector('#seasonCalendarUnknownTitle'), note = document.querySelector('#seasonCalendarUnknownNote');
    heading.textContent = '일정 확인 불가 작품';
    document.querySelector('#seasonCalendarUnknownCount').textContent = `${items.length}개`;
    if (scheduleState === 'failed') note.textContent = '공급 사이트 일정 조회에 실패해 요일을 배정하지 않았습니다.';
    else if (scheduleState === 'partial') note.textContent = '일부 일정 출처에 응답이 없어 확인된 공개 일정만 표시했습니다.';
    else note.textContent = '정상 응답에서 확인된 공개 일정이 없습니다. AniList·Jikan 및 공식 방송 정보는 보조 근거로만 보존합니다.';
    const badge = '일정 확인 불가';
    unknownGrid.replaceChildren(...items.map(anime => makeCard(anime, [anime.year, anime.type].filter(Boolean).join(' · '), badge)));
    document.querySelector('#seasonCalendarUnknownSection').classList.toggle('hidden', items.length === 0);
  }
  function showConflicts(items, unresolved = []) {
    const section = document.querySelector('#seasonCalendarConflictSection');
    const rows = [...items.map(item => ({ ...item, badge: '일정 충돌' })),
      ...unresolved.map(item => ({ ...item, badge: '일정 충돌' }))];
    document.querySelector('#seasonCalendarConflictCount').textContent = `${rows.length}개`;
    conflictGrid.replaceChildren(...rows.map(({ anime, events, badge }) => {
      const trackLabels = { raw: '원어', sub: '자막', dub: '더빙' };
      const detail = events.map(event => [PROVIDER_LABELS[event.provider] || PROVIDER_NAMES[event.provider] || event.provider, DAYS[event.day], event.episode ? `${event.episode}화` : '',
        trackLabels[event.track] || '', event.timed && event.time && event.timeBasis ? `${event.time} · ${event.timeBasis}` : ''].filter(Boolean).join(' ')).join(' / ');
      const card = makeCard(anime, detail, badge); card.title = detail; return card;
    }));
    section.classList.toggle('hidden', rows.length === 0);
  }
  async function load(items, selection, label) {
    const token = ++request, shows = dedupe(items), dates = dayDates(), model = window.LilacSeasonCalendarModel;
    const current = currentQuarter(), selectedYear = Number(selection?.year || current.year), selectedQuarter = Number(selection?.quarter || current.quarter);
    const selectedSeason = ({ 1: 'WINTER', 2: 'SPRING', 3: 'SUMMER', 4: 'FALL' })[selectedQuarter] || '';
    const candidates = model.japaneseScheduleCandidates(shows, selectedYear, selectedQuarter);
    const apiCandidates = candidates.map(({ anime, ...candidate }) => candidate);
    const emptyAssignments = Array.from({ length: 7 }, () => []);
    const dateStart = Date.parse(`${providerDateKey(dates[0])}T00:00:00+09:00`);
    const dateEnd = dateStart + 7 * 24 * 60 * 60 * 1000;
    const from = Math.floor(Math.max(Date.now(), dateStart) / 1000), until = Math.floor(dateEnd / 1000);
    diagnostics = { provider: 'providerSchedule+japaneseSeasonSchedule', configuredProvider: state.source,
      scheduleBasis: 'provider-release-vote', weekTimeZone: 'Asia/Seoul', selectedYear, selectedQuarter, selectedSeason,
      catalogCount: shows.length, catalogCandidateCount: apiCandidates.length,
      catalogAniListIdCount: new Set(apiCandidates.map(candidate => candidate.anilistId).filter(Boolean)).size,
      catalogMalIdCount: new Set(apiCandidates.map(candidate => candidate.malId).filter(Boolean)).size,
      catalogWithoutAniListIdCount: apiCandidates.filter(candidate => !candidate.anilistId).length,
      jikanFallbackCandidateCount: apiCandidates.filter(candidate => !candidate.malId
        && candidate.year && candidate.season && candidate.aliases.length).length,
      unverifiedIdentityCount: apiCandidates.filter(candidate => !candidate.anilistId && !candidate.malId).length,
      from, until, assignedCount: 0, assignedCardCount: 0, unknownCount: shows.length, conflictCount: 0, duplicateRows: 0,
      excludedCatalogCount: 0, sources: {}, providerSchedules: {}, scheduleEvidence: [], unmatchedScheduleRows: [], dayResults: [],
      requestClient: root.LilacProviderScheduleClient?.diagnostics?.() || null, state: 'loading' };
    document.querySelector('#seasonCalendarTitle').textContent = (label || '이번 시즌') + ' 주간 편성표';
    document.querySelector('#seasonCalendarSubtitle').textContent = `${shows.length}개 작품 · 공급 사이트 공개 일정 기준 · AniList/Jikan 별도 근거`;
    document.querySelector('#seasonCalendarUnknownSection').classList.remove('hidden');
    document.querySelector('#seasonCalendarConflictSection').classList.add('hidden');
    window.LilacSeasonCalendarDiagnostics = diagnostics;
    document.querySelector('#seasonCalendarStatus').textContent = '공급 사이트 공개 일정 확인 중…';
    showDays(dates, emptyAssignments, Array.from({ length: 7 }, () => ({ state: 'loading' })));
    showUnmatched([], 'loading');

    const includeCurrentWeek = selectedYear === current.year && selectedQuarter === current.quarter;
    const providerTask = model.collectProviderScheduleEvidence(dates, includeCurrentWeek);
    const airingTask = (async () => {
      let timer;
      try {
        const ipcTimeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('AniList/Jikan 일정 IPC 시간 초과'), { code: 'IPC_TIMEOUT' })), 23000);
        });
        return await Promise.race([
          root.lilac.japaneseSeasonSchedule(apiCandidates, from, until, selectedYear, selectedSeason), ipcTimeout
        ]);
      } catch (error) {
        return { state: 'failed', errorCode: error?.code || 'ipc-error',
          sources: {
            AniList: { state: 'failed', errorCode: error?.code || 'ipc-error', failureStage: 'ipc', items: [] },
            Jikan: { state: 'failed', errorCode: error?.code || 'ipc-error', failureStage: 'ipc', items: [] }
          } };
      } finally { clearTimeout(timer); }
    })();
    let response, providerCollection;
    try {
      [response, providerCollection] = await Promise.all([airingTask, providerTask]);
    } catch (error) {
      response = await airingTask;
      providerCollection = { sources: Object.fromEntries(PROVIDER_VOTE_KEYS.map(provider => [provider, {
        provider, label: PROVIDER_NAMES[provider], state: 'failed', reason: String(error?.code || 'collection-error'),
        dayResults: [], responseRows: 0, nativeRows: 0, exactEpisodeRows: 0, rowsWithoutEpisode: 0, fallbackRows: 0
      }])), evidence: [] };
    }
    if (token !== request) return;

    const reconciled = model.applyOfficialJapaneseBroadcasts(
      model.reconcileScheduleVotes(
        model.reconcileJapaneseBroadcastSchedule(response, candidates, selectedYear, selectedQuarter),
        providerCollection.evidence, candidates, selectedYear, selectedQuarter
      ),
      candidates, selectedYear, selectedQuarter
    );
    const sourceResults = reconciled.sources || {};
    diagnostics.sources = Object.fromEntries(['AniList', 'Jikan'].map(name => {
      const source = sourceResults[name] || { state: 'not-requested', items: [] };
      const details = {
        state: source.state || 'not-requested', responseRows: Array.isArray(source.items) ? source.items.length : 0,
        pageCount: Number(source.pageCount) || 0, requestCount: Number(source.requestCount) || 0,
        requestStarted: source.requestStarted === true || source.requestDiagnostics?.requestStarted === true,
        requestBodyBytes: Number(source.requestBodyBytes) || Number(source.requestDiagnostics?.requestBodyBytes) || 0,
        stage: String(source.requestDiagnostics?.stage || source.stage || ''),
        elapsedMs: Number(source.elapsedMs) || Number(source.requestDiagnostics?.elapsedMs) || 0,
        errorCode: source.errorCode || '', failureStage: source.failureStage || '', httpStatus: Number(source.httpStatus) || null,
        networkErrorCode: source.networkErrorCode || source.requestDiagnostics?.networkErrorCode || '',
        fromCache: source.fromCache === true, matchedCatalogCount: Number(source.matchedCatalogCount) || 0,
        unmatchedCatalogCount: Number(source.unmatchedCatalogCount) || 0,
        requestedCandidateCount: Number(source.requestedCandidateCount) || 0,
        requestedMalIdCount: Number(source.requestedMalIdCount) || 0,
        matchedIdentityCount: Number(source.matchedIdentityCount) || 0,
        metadataMismatchCount: Number(source.metadataMismatchCount) || 0,
        missingBroadcastCount: Number(source.missingBroadcastCount) || 0,
        ambiguousCount: Number(source.ambiguousCount) || 0,
        rejectedCountryCount: Number(source.rejectedCountryCount) || 0,
        rejectedFormatCount: Number(source.rejectedFormatCount) || 0,
        unmatchedRowCount: Number(source.unmatchedCount) || 0,
        truncatedCandidates: source.truncatedCandidates === true,
        requestDiagnostics: source.requestDiagnostics || null
      };
      details.requestCount = Number(source.requestCount) || Number(source.requestDiagnostics?.requestCount)
        || (source.requestDiagnostics?.requestStarted === true ? 1 : 0);
      return [name, details];
    }));
    const dayState = reconciled.state === 'failed' ? 'failed' : reconciled.state === 'partial' ? 'partial' : 'success';
    const dayStates = Array.from({ length: 7 }, (_, day) => ({ day, state: dayState, count: reconciled.assigned[day].length }));
    const requestedSources = [
      ...Object.values(sourceResults),
      ...Object.values(providerCollection.sources || {})
    ].filter(source => source?.state && source.state !== 'not-requested');
    const successfulSources = requestedSources.filter(source => ['complete', 'partial'].includes(source.state));
    const hasIncompleteSource = requestedSources.some(source => source.state !== 'complete');
    const hasVerifiedOfficialFallback = (reconciled.officialScheduleEvidence || []).length > 0;
    const overallState = successfulSources.length === 0 ? (hasVerifiedOfficialFallback ? 'partial' : 'failed')
      : hasIncompleteSource ? 'partial' : 'complete';
    reconciled.state = overallState;
    diagnostics.state = overallState;
    diagnostics.scheduleRowCount = Object.values(sourceResults).reduce((sum, source) => sum + (Array.isArray(source?.items) ? source.items.length : 0), 0)
      + Object.values(providerCollection.sources || {}).reduce((sum, source) => sum + (Number(source?.nativeRows) || 0), 0);
    diagnostics.providerSchedules = providerCollection.sources;
    diagnostics.providerScheduleRows = providerCollection.evidence.length;
    diagnostics.providerEvidenceCounts = reconciled.providerEvidenceCounts || {};
    diagnostics.sourceRelationships = reconciled.sourceRelationships || [];
    diagnostics.supplementalEvidence = reconciled.supplementalEvidence || [];
    diagnostics.sourceScheduleConflicts = reconciled.sourceScheduleConflicts || [];
    diagnostics.voteConflicts = reconciled.voteConflicts || [];
    diagnostics.voteResults = reconciled.voteResults || [];
    diagnostics.sourceVoteSummary = reconciled.sourceVoteSummary || {};
    diagnostics.tieCount = (reconciled.voteConflicts || []).length;
    diagnostics.finalDayCounts = reconciled.assigned.map(day => day.length);
    diagnostics.matchedCatalogCount = reconciled.matchedScheduleCount;
    diagnostics.weeklyReleaseCount = reconciled.matchedScheduleCount;
    diagnostics.unverifiedWeeklyCount = reconciled.unknownCount;
    diagnostics.assignedCount = reconciled.assignedCount;
    diagnostics.assignedCardCount = reconciled.assignedCardCount;
    diagnostics.unknownCount = reconciled.unknownCount;
    diagnostics.conflictCount = reconciled.conflictCount;
    diagnostics.duplicateRows = reconciled.duplicateRows;
    diagnostics.duplicateTrackRows = reconciled.duplicateTrackRows;
    diagnostics.excludedCatalogCount = reconciled.excludedCatalogCount;
    diagnostics.rejectedMetadataCount = reconciled.rejectedMetadataCount;
    diagnostics.rejectedIdentityCount = reconciled.rejectedIdentityCount;
    diagnostics.unmatchedScheduleCount = reconciled.unmatched.length;
    diagnostics.scheduleEvidence = reconciled.scheduleEvidence;
    diagnostics.unmatchedScheduleRows = reconciled.unmatched;
    diagnostics.officialScheduleEvidence = reconciled.officialScheduleEvidence;
    diagnostics.rejectedOfficialSchedules = reconciled.rejectedOfficialSchedules;
    diagnostics.officialScheduleCount = reconciled.officialScheduleEvidence.length;
    diagnostics.dayResults = dayStates;
    diagnostics.sourceRequestDiagnostics = response?.requestDiagnostics || {};
    diagnostics.requestClient = root.LilacProviderScheduleClient?.diagnostics?.() || null;
    showDays(dates, reconciled.assigned, dayStates);
    showUnmatched(reconciled.unknown, reconciled.state);
    showConflicts(reconciled.conflicts);
    const providerNote = PROVIDER_VOTE_KEYS.map(name => {
      const source = diagnostics.providerSchedules[name];
      if (!source || source.state === 'not-requested') return `${PROVIDER_NAMES[name]} 미요청`;
      const rows = source.nativeRows ? ` ${source.nativeRows}행` : '';
      const exact = source.exactEpisodeRows ? ` · 회차 확인 ${source.exactEpisodeRows}` : '';
      const failure = source.failedDays ? ` · 실패 ${source.failedDays}일` : '';
      const fallback = source.fallbackRows ? ` · 대체응답 ${source.fallbackRows}행` : '';
      return `${PROVIDER_NAMES[name]} ${source.state}${rows}${exact}${failure}${fallback}`;
    }).join(' · ');
    const airingNote = ['AniList', 'Jikan'].map(name => {
      const source = diagnostics.sources[name];
      if (source.state === 'not-requested') return `${name} 미요청`;
      const pages = source.pageCount ? ` ${source.pageCount}페이지` : '';
      const rows = source.responseRows ? ` ${source.responseRows}건` : '';
      const error = source.errorCode ? ` · ${source.errorCode}` : '';
      return `${name} ${source.state}${pages}${rows}${error}`;
    }).join(' · ') + (diagnostics.officialScheduleCount ? ` · 공식 방송 보조근거 ${diagnostics.officialScheduleCount}건` : '');
    const stateLabel = overallState === 'complete' ? '공급 사이트 일정 응답 완료'
      : overallState === 'partial' ? '일정 출처 일부 확인 불가' : '일정 확인 불가';
    document.querySelector('#seasonCalendarStatus').textContent = `${stateLabel} · ${providerNote} · ${airingNote} · 요일 배정 ${diagnostics.assignedCount}개 · 미확인 ${diagnostics.unknownCount}개 · 일정 충돌 ${diagnostics.conflictCount}개`;
    window.LilacSeasonCalendarDiagnostics = diagnostics;
  }
  function open(items, label = '이번 시즌', selection = state.quarterSelection || currentQuarter()) {
    switchView('search'); rootView.classList.add('season-calendar-mode'); container.classList.remove('hidden');
    void load(items, selection, label);
  }
  document.querySelector('#seasonCalendarBack').onclick = () => switchView('home');
  window.LilacSeasonCalendar = { open, diagnostics: () => diagnostics, renderDays: (target, dates, assignments, errors) => showDays(dates, assignments, errors, target),
    makeCard, providerSchedule: requestProviderSchedule };
})(window);
