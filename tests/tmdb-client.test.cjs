const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTmdbClient } = require('../electron/tmdb-client.cjs');

function response(status, body = { results: [] }, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body, body: { cancel: async () => {} } };
}

test('V3 keys stay in the query and V4 tokens use the authorization header', async () => {
  const calls = [];
  const request = createTmdbClient({ fetch: async (url, options) => { calls.push([String(url), options]); return response(200); }, interval: 0 });
  await request('/search/tv', { query: 'A' }, 'v3-secret');
  await request('/search/tv', { query: 'B' }, 'v4.secret.token');
  assert.match(calls[0][0], /api_key=v3-secret/);
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.doesNotMatch(calls[1][0], /api_key/);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer v4.secret.token');
});

test('concurrent requests share the minimum start interval', async () => {
  let now = 0; const starts = [];
  const request = createTmdbClient({
    now: () => now,
    sleep: async ms => { now += ms; },
    fetch: async () => { starts.push(now); return response(200); },
    interval: 150
  });
  await Promise.all([request('/one', {}, 'key'), request('/two', {}, 'key'), request('/three', {}, 'key')]);
  assert.deepEqual(starts, [0, 150, 300]);
});

test('transient server errors retry twice and permanent errors do not retry', async () => {
  let calls = 0, now = 0; const sleeps = [];
  const request = createTmdbClient({
    now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, interval: 0,
    fetch: async () => ++calls < 3 ? response(503) : response(200, { results: ['ok'] })
  });
  assert.deepEqual(await request('/search/tv', {}, 'secret'), { results: ['ok'] });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);

  calls = 0;
  const permanent = createTmdbClient({ fetch: async () => { calls++; return response(404); }, interval: 0 });
  await assert.rejects(permanent('/missing', {}, 'secret'), error => error.code === 'http' && error.status === 404);
  assert.equal(calls, 1);
});

test('transport and JSON failures are bounded and do not leak the API key', async () => {
  let calls = 0, now = 0;
  const request = createTmdbClient({
    now: () => now, sleep: async ms => { now += ms; }, interval: 0,
    fetch: async () => { calls++; return { ok: true, status: 200, json: async () => { throw new Error('Invalid JSON'); } }; }
  });
  await assert.rejects(request('/search/tv', {}, 'sensitive-key'), error => error.code === 'response' && !error.message.includes('sensitive-key'));
  assert.equal(calls, 3);

  calls = 0;
  const unavailable = createTmdbClient({
    now: () => now, sleep: async ms => { now += ms; }, interval: 0,
    fetch: async () => { calls++; throw Object.assign(new Error('failed https://api.themoviedb.org/?api_key=sensitive-key'), { name: 'TypeError' }); }
  });
  await assert.rejects(unavailable('/search/tv', {}, 'sensitive-key'), error => error.code === 'network' && !error.message.includes('sensitive-key'));
  assert.equal(calls, 3);
});

test('429 Retry-After delays retries and long shared cooldowns return to the scheduler', async () => {
  let now = 0, calls = 0; const sleeps = [];
  const request = createTmdbClient({
    now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, interval: 0,
    fetch: async () => ++calls === 1 ? response(429, {}, { 'retry-after': '2' }) : response(200)
  });
  await request('/search/tv', {}, 'key');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);

  let blockedCalls = 0;
  const blocked = createTmdbClient({
    now: () => now, sleep: async ms => { now += ms; }, interval: 0,
    fetch: async () => { blockedCalls++; return response(429, {}, { 'retry-after': '120' }); }
  });
  await assert.rejects(blocked('/search/tv', {}, 'key'), error => error.code === 'rate-limit' && error.retryAfterMs > 30000);
  await assert.rejects(blocked('/search/movie', {}, 'key'), error => error.code === 'rate-limit' && error.retryAfterMs > 30000);
  assert.equal(blockedCalls, 1);
});
