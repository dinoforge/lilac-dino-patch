'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProviderDetailHandler } = require('../electron/provider-detail-cache.cjs');

test('provider detail requests share an in-flight result and cache it for five minutes', async () => {
  let now = 1_000;
  let calls = 0;
  const pending = [];
  const handler = createProviderDetailHandler(anime => {
    calls++;
    return new Promise((resolve, reject) => pending.push({ anime, resolve, reject }));
  }, { now: () => now });
  const anime = { provider: 'ohli24', id: 'freiren-s1', url: 'https://ani.ohli24.com/c/freiren-s1' };

  const first = handler({}, anime);
  const overlapping = handler({}, { ...anime });
  assert.strictEqual(overlapping, first);
  await Promise.resolve();
  assert.equal(calls, 1);

  const result = { data: anime, episodes: [{ number: 1 }] };
  pending[0].resolve(result);
  assert.strictEqual(await first, result);
  assert.strictEqual(await handler({}, anime), result);
  assert.equal(calls, 1);

  now += 5 * 60 * 1000;
  const refreshed = handler({}, anime);
  await Promise.resolve();
  assert.equal(calls, 2);
  pending[1].resolve({ data: anime, episodes: [{ number: 1 }, { number: 2 }] });
  assert.equal((await refreshed).episodes.length, 2);
});

test('provider detail cache keys include the provider and failed loads are retried', async () => {
  const calls = [];
  const handler = createProviderDetailHandler(async anime => {
    calls.push(anime.provider);
    if (calls.length === 1) throw new Error('temporary provider failure');
    return { provider: anime.provider };
  });
  const anime = { url: 'https://example.invalid/anime/1' };

  await assert.rejects(handler({}, { ...anime, provider: 'ohli24' }), /temporary provider failure/);
  assert.deepEqual(await handler({}, { ...anime, provider: 'ohli24' }), { provider: 'ohli24' });
  assert.deepEqual(await handler({}, { ...anime, provider: 'miruro' }), { provider: 'miruro' });
  assert.deepEqual(calls, ['ohli24', 'ohli24', 'miruro']);
});
