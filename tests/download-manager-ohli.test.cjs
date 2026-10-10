const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DownloadManager } = require('../electron/download-manager.cjs');

function subtitleManager(job) {
  const calls = { find: 0, save: [], jimaku: 0 };
  const manager = Object.assign(Object.create(DownloadManager.prototype), {
    jobs: [job],
    findSubtitle: async () => { calls.find++; return null; },
    saveSubtitle: async (_job, url) => calls.save.push(url),
    saveAssSubtitle() {},
    attachJimaku: async () => { calls.jimaku++; }
  });
  return { manager, calls };
}

test('애니24 원본 영상의 별도 자막을 다운로드 자막으로 보존한다', async () => {
  const job = { episode: { provider: 'ohli24' } }, { manager, calls } = subtitleManager(job);
  const subtitleUrl = 'file:///isolated-test/ohli24.vtt';

  await manager.attachSubtitle(job, { burnedKorean: false, subtitleUrl, subtitleLabel: '애니24 한국어 자막' });

  assert.equal(job.subtitleChecked, true);
  assert.equal(job.siteKorean, true);
  assert.deepEqual(calls.save, [subtitleUrl]);
  assert.equal(calls.jimaku, 0, 'a site-provided Korean subtitle does not trigger a second subtitle lookup');
});

test('애니24 자막이 영상에 박힌 회차는 외부 자막 검색을 건너뛴다', async () => {
  const job = { episode: { provider: 'ohli24' } }, { manager, calls } = subtitleManager(job);

  await manager.attachSubtitle(job, { burnedKorean: true });

  assert.equal(job.subtitleChecked, true);
  assert.equal(calls.find, 0);
  assert.deepEqual(calls.save, []);
  assert.equal(calls.jimaku, 0);
});
