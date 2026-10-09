const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_CANDIDATE_TTL_MS = 30 * DAY_MS;
const DISPLAY_TITLE_TTL_MS = 7 * DAY_MS;
const CATALOG_TITLE_TTL_MS = 30 * DAY_MS;
const DOWNLOAD_TITLE_TTL_MS = 30 * DAY_MS;

function isFreshTimestamp(value, ttlMs, now = Date.now()) {
  const timestamp = Number(value), ttl = Number(ttlMs);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now &&
    Number.isFinite(ttl) && ttl > 0 && now - timestamp < ttl;
}

function pruneTimestampedRecords(records, ttlFor, now = Date.now()) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) return {};
  const fresh = {};
  for (const [key, record] of Object.entries(records)) {
    const ttl = typeof ttlFor === 'function' ? ttlFor(record, key) : ttlFor;
    if (record && typeof record === 'object' && !Array.isArray(record) && isFreshTimestamp(record.time, ttl, now)) fresh[key] = record;
  }
  return fresh;
}

function pruneKoreanTitleRecords(records, now = Date.now()) {
  return pruneTimestampedRecords(records, record =>
    Array.isArray(record?.titles) && record.titles.length ? TITLE_CANDIDATE_TTL_MS : 0, now);
}

function hasFreshDownloadTitleMetadata(job, now = Date.now()) {
  return Boolean((job?.displayTitles?.ko || job?.displayTitles?.en) &&
    isFreshTimestamp(job.displayTitlesAt, DOWNLOAD_TITLE_TTL_MS, now));
}

function hasCompleteDownloadTitleMetadata(job, now = Date.now()) {
  return Boolean(job?.displayTitles?.ko && job.displayTitles?.en &&
    isFreshTimestamp(job.displayTitlesAt, DOWNLOAD_TITLE_TTL_MS, now));
}

function expireDownloadTitleMetadata(jobs, now = Date.now()) {
  let changed = false;
  if (!Array.isArray(jobs)) return changed;
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    if (hasFreshDownloadTitleMetadata(job, now)) continue;
    if (Object.prototype.hasOwnProperty.call(job, 'displayTitles') ||
        Object.prototype.hasOwnProperty.call(job, 'displayTitlesAt')) {
      delete job.displayTitles;
      delete job.displayTitlesAt;
      changed = true;
    }
  }
  return changed;
}

module.exports = {
  DAY_MS,
  TITLE_CANDIDATE_TTL_MS,
  DISPLAY_TITLE_TTL_MS,
  CATALOG_TITLE_TTL_MS,
  DOWNLOAD_TITLE_TTL_MS,
  isFreshTimestamp,
  pruneTimestampedRecords,
  pruneKoreanTitleRecords,
  hasFreshDownloadTitleMetadata,
  hasCompleteDownloadTitleMetadata,
  expireDownloadTitleMetadata
};
