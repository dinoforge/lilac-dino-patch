const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { requestAniListGraphQL, getAniListCooldownUntil, clearAniListCooldown } = require('../electron/anilist-client.cjs');

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
  t.after(clearAniListCooldown);

  await assert.rejects(
    requestAniListGraphQL('query Test { Viewer { id } }', { page: 1 }, { fetchImpl: limitedFetch, now }),
    error => error.code === 'ANILIST_RATE_LIMITED' && error.retryAfterAt === now + 20_000
  );
  assert.equal(getAniListCooldownUntil(now + 1000), now + 20_000);
  await assert.rejects(
    requestAniListGraphQL('query Test { Viewer { id } }', { page: 1 }, { fetchImpl: limitedFetch, now: now + 1000 }),
    error => error.code === 'ANILIST_RATE_LIMITED' && error.retryAfterAt === now + 20_000
  );
  assert.equal(requests, 1);

  const response = await requestAniListGraphQL('query Test { Viewer { id } }', { page: 1 }, {
    fetchImpl: async () => { requests++; return { status: 200, ok: true }; }, now: now + 20_000
  });
  assert.equal(response.status, 200);
  assert.equal(requests, 2);
});

test('AniList uses HTTP-date Retry-After and a one-minute fallback', async t => {
  const now = 1_800_000_000_000;
  t.after(clearAniListCooldown);
  const date = new Date(now + 45_000).toUTCString();
  await assert.rejects(
    requestAniListGraphQL('query { Viewer { id } }', {}, { now, fetchImpl: async () => ({ status: 429, headers: { get: () => date } }) }),
    error => error.retryAfterAt === Date.parse(date)
  );
  assert.equal(getAniListCooldownUntil(now + 1000), Date.parse(date));

  clearAniListCooldown();
  await assert.rejects(
    requestAniListGraphQL('query { Viewer { id } }', {}, { now, fetchImpl: async () => ({ status: 429, headers: { get: () => null } }) }),
    error => error.retryAfterAt === now + 60_000
  );
});

test('Electron AniList title, story, and prequel lookups all use the shared client', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.equal((main.match(/requestAniListGraphQL\(/g) || []).length, 5);
  assert.equal(main.includes("fetch('https://graphql.anilist.co'"), false);
});
