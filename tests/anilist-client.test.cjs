const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { requestAniListGraphQL, getAniListCooldownUntil, resetAniListClientState, MIN_REQUEST_INTERVAL_MS } = require('../electron/anilist-client.cjs');

test('concurrent AniList callers share a conservative global request interval', async t => {
  const start = 1_800_000_000_000;
  let now = start;
  const starts = [];
  t.after(resetAniListClientState);
  const request = () => requestAniListGraphQL('query { Viewer { id } }', {}, {
    now: () => now,
    minIntervalMs: MIN_REQUEST_INTERVAL_MS,
    waitImpl: async milliseconds => { now += milliseconds; },
    fetchImpl: async () => { starts.push(now); return { status: 200, ok: true }; }
  });

  await Promise.all([request(), request(), request()]);
  assert.deepEqual(starts, [start, start + MIN_REQUEST_INTERVAL_MS, start + MIN_REQUEST_INTERVAL_MS * 2]);
  assert.ok(Math.floor(60_000 / MIN_REQUEST_INTERVAL_MS) < 30, 'The configured interval must stay below the documented degraded limit');
});

test('high-priority season schedule requests move ahead of queued title lookups without bypassing the interval', async t => {
  let now = 1_800_000_100_000;
  const starts = [];
  const fetchImpl = async (_url, options) => {
    starts.push(JSON.parse(options.body).query);
    return { status: 200, ok: true };
  };
  const waitImpl = async milliseconds => {
    now += milliseconds;
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  t.after(resetAniListClientState);
  const request = (query, priority = 0) => requestAniListGraphQL(`query ${query} { Viewer { id } }`, {}, {
    fetchImpl, now: () => now, waitImpl, minIntervalMs: 100, priority
  });

  const first = request('First');
  await Promise.resolve();
  const queued = request('Queued');
  const normal = request('Normal');
  const schedule = request('Schedule', 100);
  await Promise.all([first, queued, normal, schedule]);
  assert.deepEqual(starts, ['query First { Viewer { id } }', 'query Queued { Viewer { id } }',
    'query Schedule { Viewer { id } }', 'query Normal { Viewer { id } }']);
});

test('a timed-out queued AniList request is removed before a later slot can send it', async t => {
  let now = 1_800_000_200_000;
  const starts = [];
  let releaseSlot;
  const controller = new AbortController();
  t.after(resetAniListClientState);
  const first = requestAniListGraphQL('query First { Viewer { id } }', {}, {
    now: () => now, minIntervalMs: 1000,
    fetchImpl: async () => { starts.push('first'); return { status: 200, ok: true }; }
  });
  await first;
  const pending = requestAniListGraphQL('query Cancelled { Viewer { id } }', {}, {
    now: () => now, minIntervalMs: 1000, signal: controller.signal,
    waitImpl: milliseconds => new Promise(resolve => { now += milliseconds; releaseSlot = resolve; }),
    fetchImpl: async () => { starts.push('cancelled'); return { status: 200, ok: true }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(Object.assign(new Error('deadline'), { name: 'TimeoutError' }));
  await assert.rejects(pending, /deadline/);
  releaseSlot?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, ['first']);
});

test('AniList sends GraphQL requests and shares Retry-After cooldown across callers', async t => {
  const now = 1_800_000_000_000;
  let requests = 0;
  const limitedFetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://graphql.anilist.co');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { query: 'query Test { Viewer { id } }', variables: { page: 1 } });
    return { status: 429, ok: false, headers: { get: name => name === 'Retry-After' ? '20' : null } };
  };
  t.after(resetAniListClientState);

  await assert.rejects(
    requestAniListGraphQL('query Test { Viewer { id } }', { page: 1 }, { fetchImpl: limitedFetch, now, minIntervalMs: 0 }),
    error => error.code === 'ANILIST_RATE_LIMITED' && error.retryAfterAt === now + 20_000
  );
  assert.equal(getAniListCooldownUntil(now + 1000), now + 20_000);
  await assert.rejects(
    requestAniListGraphQL('query Test { Viewer { id } }', { page: 1 }, { fetchImpl: limitedFetch, now: now + 1000, minIntervalMs: 0 }),
    error => error.code === 'ANILIST_RATE_LIMITED' && error.retryAfterAt === now + 20_000
  );
  assert.equal(requests, 1);

  const response = await requestAniListGraphQL('query Test { Viewer { id } }', { page: 1 }, {
    fetchImpl: async () => { requests++; return { status: 200, ok: true }; }, now: now + 20_000, minIntervalMs: 0
  });
  assert.equal(response.status, 200);
  assert.equal(requests, 2);
});

test('AniList uses HTTP-date Retry-After and a one-minute fallback', async t => {
  const now = 1_800_000_000_000;
  t.after(resetAniListClientState);
  const date = new Date(now + 45_000).toUTCString();
  await assert.rejects(
    requestAniListGraphQL('query { Viewer { id } }', {}, { now, minIntervalMs: 0, fetchImpl: async () => ({ status: 429, headers: { get: () => date } }) }),
    error => error.retryAfterAt === Date.parse(date)
  );
  assert.equal(getAniListCooldownUntil(now + 1000), Date.parse(date));

  resetAniListClientState();
  await assert.rejects(
    requestAniListGraphQL('query { Viewer { id } }', {}, { now, minIntervalMs: 0, fetchImpl: async () => ({ status: 429, headers: { get: () => null } }) }),
    error => error.retryAfterAt === now + 60_000
  );
});

test('Electron AniList title, story, and prequel lookups all use the shared client', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.equal((main.match(/requestAniListGraphQL\(/g) || []).length, 5);
  assert.equal(main.includes("fetch('https://graphql.anilist.co'"), false);
});
