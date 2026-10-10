(function (root) {
  'use strict';

  const SEASONS = Object.freeze(['WINTER', 'SPRING', 'SUMMER', 'FALL']);

  function quarterForDate(date = new Date()) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('유효한 날짜가 필요합니다.');
    const year = date.getFullYear(), quarter = Math.floor(date.getMonth() / 3) + 1;
    return { year, quarter, season: SEASONS[quarter - 1], label: `${year}년 ${quarter}분기` };
  }

  function validSelection(year, quarter, current) {
    return Number.isInteger(year) && year >= 1960 && year <= current.year && Number.isInteger(quarter) && quarter >= 1 && quarter <= 4;
  }

  function selectionRecord(year, quarter, date = new Date()) {
    const current = quarterForDate(date), selectedYear = Number(year), selectedQuarter = Number(quarter);
    if (!validSelection(selectedYear, selectedQuarter, current)) throw new RangeError('분기 선택이 올바르지 않습니다.');
    return { version: 2, year: selectedYear, quarter: selectedQuarter, calendarYear: current.year, calendarQuarter: current.quarter };
  }

  function resolveSelection(saved, date = new Date()) {
    const current = quarterForDate(date), year = Number(saved?.year), quarter = Number(saved?.quarter);
    const valid = validSelection(year, quarter, current);
    if (saved?.version === 2 && valid) {
      const calendarYear = Number(saved.calendarYear), calendarQuarter = Number(saved.calendarQuarter);
      if (calendarYear === current.year && calendarQuarter === current.quarter) {
        const record = selectionRecord(year, quarter, date);
        return { selection: { year, quarter, label: `${year}년 ${quarter}분기` }, record, migrated: false };
      }
    } else if (saved?.version == null && valid && year === current.year && quarter === current.quarter) {
      // The legacy format has no date for the user's choice. Preserve it only when it matches today.
      const record = selectionRecord(year, quarter, date);
      return { selection: { year, quarter, label: `${year}년 ${quarter}분기` }, record, migrated: true };
    }

    const record = selectionRecord(current.year, current.quarter, date);
    return { selection: current, record, migrated: true };
  }

  function dateKey(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('유효한 날짜가 필요합니다.');
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  function createCalendarWatcher(initialDate = new Date()) {
    let previousDate = dateKey(initialDate), previousQuarter = quarterForDate(initialDate);
    return {
      check(date = new Date()) {
        const currentDate = dateKey(date), currentQuarter = quarterForDate(date);
        if (currentDate === previousDate) return null;
        const change = {
          dateChanged: true,
          quarterChanged: currentQuarter.year !== previousQuarter.year || currentQuarter.quarter !== previousQuarter.quarter,
          previous: previousQuarter,
          current: currentQuarter
        };
        previousDate = currentDate;
        previousQuarter = currentQuarter;
        return change;
      }
    };
  }

  const api = { quarterForDate, selectionRecord, resolveSelection, createCalendarWatcher };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LilacQuarterSelection = api;
})(typeof window !== 'undefined' ? window : globalThis);
