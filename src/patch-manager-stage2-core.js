(function attachPatchManagerStage2Core(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LilacPatchStage2Core = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const QUARTERS = Object.freeze([1, 2, 3, 4]);

  function currentQuarter(date = new Date()) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('유효한 날짜가 필요합니다.');
    return { year: date.getFullYear(), quarter: Math.floor(date.getMonth() / 3) + 1 };
  }

  function readQuarterSelection(value, date = new Date()) {
    const current = currentQuarter(date);
    let stored = value;
    if (typeof stored === 'string') {
      try { stored = JSON.parse(stored); } catch { stored = null; }
    }
    if (!stored || typeof stored !== 'object') return { ...current, calendarYear: current.year, calendarQuarter: current.quarter };

    const year = Number(stored.selectedYear ?? stored.year), quarter = Number(stored.selectedQuarter ?? stored.quarter);
    if (!Number.isInteger(year) || year < 1960 || year > current.year || !QUARTERS.includes(quarter)) {
      return { ...current, calendarYear: current.year, calendarQuarter: current.quarter };
    }
    const calendarYear = Number(stored.calendarYear), calendarQuarter = Number(stored.calendarQuarter);
    // Old settings without the calendar marker are kept only when they already name the current quarter.
    const markerMatches = Number.isInteger(calendarYear) && QUARTERS.includes(calendarQuarter)
      ? calendarYear === current.year && calendarQuarter === current.quarter
      : year === current.year && quarter === current.quarter;
    if (!markerMatches) return { ...current, calendarYear: current.year, calendarQuarter: current.quarter };
    return { year, quarter, calendarYear: current.year, calendarQuarter: current.quarter };
  }

  function saveQuarterSelection(year, quarter, date = new Date()) {
    const current = currentQuarter(date), selectedYear = Number(year), selectedQuarter = Number(quarter);
    if (!Number.isInteger(selectedYear) || selectedYear < 1960 || selectedYear > current.year || !QUARTERS.includes(selectedQuarter)) {
      throw new RangeError('분기 선택이 올바르지 않습니다.');
    }
    return { year: selectedYear, quarter: selectedQuarter, calendarYear: current.year, calendarQuarter: current.quarter };
  }

  function mergeQuarterCatalogs(catalogs, matchesScheduledWork) {
    if (typeof matchesScheduledWork !== 'function') throw new TypeError('작품 일치 함수가 필요합니다.');
    const order = ['reanime', 'miruro', 'animenosub'], groups = [];
    for (const provider of order) {
      for (const item of Array.isArray(catalogs?.[provider]) ? catalogs[provider] : []) {
        if (!item || item.provider !== provider) continue;
        const group = groups.find(candidate => matchesScheduledWork(candidate.items[0], item));
        if (group) {
          if (!group.items.some(existing => existing.provider === provider)) group.items.push(item);
          continue;
        }
        groups.push({ items: [item] });
      }
    }
    return groups.map(group => ({
      ...group.items[0],
      patchQuarter: true,
      patchSourceItems: group.items,
      patchSources: group.items.map(item => item.provider)
    }));
  }

  return { currentQuarter, readQuarterSelection, saveQuarterSelection, mergeQuarterCatalogs };
});
