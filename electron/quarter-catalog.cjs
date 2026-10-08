const QUARTER_SEASONS = Object.freeze(['WINTER', 'SPRING', 'SUMMER', 'FALL']);
const QUARTER_PROVIDERS = Object.freeze(['reanime', 'miruro', 'animenosub']);

function quarterForDate(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('유효한 날짜가 필요합니다.');
  const year = date.getFullYear(), quarter = Math.floor(date.getMonth() / 3) + 1;
  return { year, quarter, season: QUARTER_SEASONS[quarter - 1], label: `${year}년 ${quarter}분기` };
}

function quarterPeriod(year, quarter, now = new Date()) {
  const selectedYear = Number(year), selectedQuarter = Number(quarter);
  if (!Number.isInteger(selectedYear) || selectedYear < 1960 || selectedYear > now.getFullYear()) throw new RangeError('분기 연도는 1960년부터 올해까지 선택할 수 있습니다.');
  if (!Number.isInteger(selectedQuarter) || selectedQuarter < 1 || selectedQuarter > 4) throw new RangeError('분기는 1부터 4까지 선택할 수 있습니다.');
  return { year: selectedYear, quarter: selectedQuarter, season: QUARTER_SEASONS[selectedQuarter - 1], label: `${selectedYear}년 ${selectedQuarter}분기` };
}

function quarterQuery(provider, period) {
  if (!QUARTER_PROVIDERS.includes(provider)) return null;
  if (!period || !QUARTER_SEASONS.includes(period.season) || !Number.isInteger(period.year)) throw new TypeError('유효한 분기 정보가 필요합니다.');
  if (provider === 'reanime') return { season: period.season, year: period.year };
  if (provider === 'miruro') return { season: period.season, season_year: period.year };
  return { season: `${period.season.toLowerCase()}-${period.year}` };
}

module.exports = { QUARTER_PROVIDERS, QUARTER_SEASONS, quarterForDate, quarterPeriod, quarterQuery };
