const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProviderSchedule, weekDate } = require('../electron/provider-schedule.cjs');

const now = Date.parse('2026-10-17T15:00:00.000Z');
const anime = (id, title) => ({ provider: 'reanime', id, mal_id: `reanime:${id}`, title, title_japanese: `${title} JP`, year: '2026', type: 'TV', images: { webp: { large_image_url: '' } }, genres: [] });
function deps(overrides = {}) {
  return {
    now: () => now,
    reanimeBase: 'https://reanime.example',
    reanimeFetch: async () => ({ schedule: [] }),
    reanimeItems: rows => rows.map(row => anime(row.anime_id, row.title || row.anime_id)),
    fallback: async () => [],
    ...overrides
  };
}

test('weekDate uses the selected Korean week across UTC midnight', () => {
  assert.equal(weekDate(1, now), '2026-10-12');
  assert.equal(weekDate(0, now), '2026-10-18');
});

test('parallel day requests share one native weekly fetch and keep verified episode times', async () => {
  let requests = 0;
  const schedule = createProviderSchedule(deps({
    reanimeFetch: async () => {
      requests++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { schedule: [
        { date: '2026-10-12', episodes: [{ anime_id: 'a', title: 'A', episode_number: 3, episode_date: '2026-10-12T20:30:00+09:00', air_type: 'sub' }] },
        { date: '2026-10-13', episodes: [{ anime_id: 'b', title: 'B', episode_number: 1, episode_date: '2026-10-13T21:00:00+09:00', air_type: 'sub' }] }
      ] };
    }
  }));
  const [monday, tuesday] = await Promise.all([schedule('reanime', 1), schedule('reanime', 2)]);
  assert.equal(requests, 1);
  assert.equal(monday.native, true);
  assert.equal(monday.items[0].episode, 3);
  assert.equal(monday.items[0].time, '20:30');
  assert.equal(tuesday.items[0].title, 'B');
  assert.equal(tuesday.items[0].time, '21:00');
});

test('source failure returns a labeled Anissia fallback and does not cache the outage', async () => {
  let sourceCalls = 0, fallbackCalls = 0;
  const schedule = createProviderSchedule(deps({
    reanimeFetch: async () => { sourceCalls++; throw new Error('connection reset'); },
    fallback: async day => { fallbackCalls++; return [{ id: `anissia-${day}`, title: 'Fallback' }]; }
  }));
  const first = await schedule('reanime', 1);
  const second = await schedule('reanime', 1);
  assert.equal(first.native, false);
  assert.equal(first.sourceError, 'failed');
  assert.equal(first.note, 'Anissia · 한국 시간');
  assert.equal(second.sourceError, 'failed');
  assert.equal(sourceCalls, 2);
  assert.equal(fallbackCalls, 2);
});

test('a stalled source times out independently and returns the fallback result', async () => {
  const schedule = createProviderSchedule(deps({
    nativeTimeoutMs: 5,
    fallback: async day => [{ id: `fallback-${day}`, title: 'Fallback' }],
    reanimeFetch: () => new Promise(() => {})
  }));
  const result = await schedule('reanime', 1);
  assert.equal(result.native, false);
  assert.equal(result.sourceError, 'timeout');
  assert.equal(result.items[0].id, 'fallback-1');
});

test('a failed fallback ends with explicit failure state instead of leaving a pending request', async () => {
  const schedule = createProviderSchedule(deps({
    nativeTimeoutMs: 5,
    fallbackTimeoutMs: 5,
    reanimeFetch: () => new Promise(() => {}),
    fallback: () => new Promise(() => {})
  }));
  const result = await schedule('reanime', 1);
  assert.equal(result.failed, true);
  assert.equal(result.sourceError, 'timeout');
  assert.equal(result.fallbackError, 'timeout');
  assert.deepEqual(result.items, []);
});
