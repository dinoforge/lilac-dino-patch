const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');
const {
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
} = require('../electron/metadata-cache.cjs');

test('timestamped metadata rejects expired, missing, and future cache dates', () => {
  const now = 2_000_000_000_000;
  assert.equal(isFreshTimestamp(now - DAY_MS, 2 * DAY_MS, now), true);
  assert.equal(isFreshTimestamp(now - 2 * DAY_MS, 2 * DAY_MS, now), false);
  assert.equal(isFreshTimestamp(undefined, 2 * DAY_MS, now), false);
  assert.equal(isFreshTimestamp(now + 1, 2 * DAY_MS, now), false);
});

test('Korean title cache drops legacy arrays and entries older than its 30-day TTL', () => {
  const now = 2_000_000_000_000;
  const cache = pruneKoreanTitleRecords({
    legacy: ['한국어 제목'],
    fresh: { titles: ['한국어 제목'], time: now - 1 },
    old: { titles: ['오래된 제목'], time: now - TITLE_CANDIDATE_TTL_MS },
    malformed: { titles: [], time: now - 1 }
  }, now);
  assert.deepEqual(cache, { fresh: { titles: ['한국어 제목'], time: now - 1 } });
});

test('title cache records can use different bounded lifetimes', () => {
  const now = 2_000_000_000_000;
  const cache = pruneTimestampedRecords({
    detail: { ko: '제목', src: 'lookup', time: now - DISPLAY_TITLE_TTL_MS + 1 },
    catalog: { ko: '목록 제목', src: 'tmdb', time: now - CATALOG_TITLE_TTL_MS + 1 },
    stale: { ko: '오래된 제목', src: 'tmdb', time: now - CATALOG_TITLE_TTL_MS }
  }, record => record.src === 'tmdb' ? CATALOG_TITLE_TTL_MS : DISPLAY_TITLE_TTL_MS, now);
  assert.deepEqual(Object.keys(cache).sort(), ['catalog', 'detail']);
});

test('download metadata expires without changing the saved episode or user files', () => {
  const now = 2_000_000_000_000;
  const jobs = [
    { id: 'legacy', status: 'completed', filePath: 'episode.mp4', subtitlePath: 'episode.vtt', displayTitles: { ko: '옛 제목', en: 'Old title' } },
    { id: 'fresh', status: 'completed', filePath: 'another.mp4', displayTitles: { ko: '새 제목', en: 'New title' }, displayTitlesAt: now - DOWNLOAD_TITLE_TTL_MS + 1 }
  ];
  assert.equal(expireDownloadTitleMetadata(jobs, now), true);
  assert.equal('displayTitles' in jobs[0], false);
  assert.equal('displayTitlesAt' in jobs[0], false);
  assert.equal(jobs[0].filePath, 'episode.mp4');
  assert.equal(jobs[0].subtitlePath, 'episode.vtt');
  assert.equal(hasFreshDownloadTitleMetadata(jobs[1], now), true);
  assert.equal(hasCompleteDownloadTitleMetadata(jobs[1], now), true);
  assert.deepEqual(jobs[1].displayTitles, { ko: '새 제목', en: 'New title' });
  assert.equal(expireDownloadTitleMetadata(jobs, now), false);
});

test('DownloadManager migrates old title cache fields while preserving download records', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-title-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'profile'), videos = path.join(root, 'videos');
  fs.mkdirSync(userData, { recursive: true });
  const stateFile = path.join(userData, 'downloads.json');
  const saved = [{
    id: 'existing-download', status: 'failed', title: '작품', episodeNumber: 4,
    anime: { id: 'series-1', title: 'Original title' }, filePath: 'episode.mp4',
    subtitlePath: 'episode.vtt', displayTitles: { ko: '오래된 제목', en: 'Old title' }
  }];
  fs.writeFileSync(stateFile, JSON.stringify(saved), 'utf8');
  const { DownloadManager } = require('../electron/download-manager.cjs');
  const manager = new DownloadManager({
    app: { getPath: name => name === 'userData' ? userData : videos },
    broadcast() {}
  });
  const migrated = JSON.parse(fs.readFileSync(stateFile, 'utf8'))[0];
  assert.equal(migrated.id, 'existing-download');
  assert.equal(migrated.status, 'failed');
  assert.equal(migrated.filePath, 'episode.mp4');
  assert.equal(migrated.subtitlePath, 'episode.vtt');
  assert.equal('displayTitles' in migrated, false);
  assert.equal('displayTitlesAt' in migrated, false);

  manager.resolveTitles = async () => ({ ko: '최신 제목', en: 'Current title' });
  await manager.attachTitles(manager.jobs[0]);
  const refreshed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))[0];
  assert.deepEqual(refreshed.displayTitles, { ko: '최신 제목', en: 'Current title' });
  assert.equal(isFreshTimestamp(refreshed.displayTitlesAt, DOWNLOAD_TITLE_TTL_MS), true);
  manager.jobs[0].displayTitles = { ko: '부분 제목', en: '' };
  manager.jobs[0].displayTitlesAt = Date.now();
  manager.save();
  assert.equal(hasFreshDownloadTitleMetadata(manager.jobs[0]), true);
  assert.equal(hasCompleteDownloadTitleMetadata(manager.jobs[0]), false);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8'))[0].displayTitles.ko, '부분 제목');
  manager.jobs[0].displayTitlesAt = Date.now() - 31 * DAY_MS;
  manager.save();
  assert.equal('displayTitles' in JSON.parse(fs.readFileSync(stateFile, 'utf8'))[0], false);
});

test('TMDB attribution in About uses the official logo asset and current API terms wording', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  const $ = cheerio.load(html), about = $('[data-settings-pane="about"]'), credit = about.find('.tmdb-attribution');
  assert.equal(credit.length, 1);
  assert.equal(credit.find('img').attr('src'), 'assets/tmdb-logo-primary-blue.svg');
  assert.match(credit.text(), /This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB\./);
  assert.doesNotMatch(html, /This product uses the TMDB API but is not endorsed or certified by TMDB\./);
  const logo = fs.readFileSync(path.join(__dirname, '../src/assets/tmdb-logo-primary-blue.svg'), 'utf8');
  assert.match(logo, /<svg[^>]+viewBox=/);
});
