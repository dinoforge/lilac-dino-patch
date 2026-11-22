const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const start = source.indexOf('function firstAnswering('), end = source.indexOf('async function resolveProviderEpisode(', start);
assert.ok(start >= 0 && end > start, 'Missing firstAnswering');
const context = vm.createContext({ AbortController, setTimeout, clearTimeout, Promise, Error });
vm.runInContext(source.slice(start, end), context);
const firstAnswering = (...args) => context.firstAnswering(...args);
const reanimeStart = source.indexOf('async function reanimeServers('), reanimeEnd = source.indexOf('// Subtitle track list only', reanimeStart);
assert.ok(reanimeStart >= 0 && reanimeEnd > reanimeStart, 'Missing reanimeServers');
const later = (ms, value, fail) => new Promise((resolve, reject) => setTimeout(() => fail ? reject(new Error(value)) : resolve(value), ms));

test('a server that does not answer no longer holds the next one for its whole time limit', async () => {
  const started = [], aborted = [], begin = Date.now();
  const result = await firstAnswering(['HD-2', 'HD-1', 'HD-3'], (server, signal) => {
    started.push([server, Date.now() - begin]); signal.addEventListener('abort', () => aborted.push(server));
    return server === 'HD-2' ? new Promise(() => {}) : later(20, server);
  }, 60);
  assert.equal(result, 'HD-1');
  assert.deepEqual(started.map(([server]) => server), ['HD-2', 'HD-1'], 'the third is not opened once one answers');
  assert.ok(started[1][1] >= 55, 'the next one waits its turn');
  assert.deepEqual(aborted.sort(), ['HD-1', 'HD-2'], 'the pages still trying are closed');
});

test('a server that fails is followed at once; the first answer wins even from an earlier server', async () => {
  const begin = Date.now(), started = [];
  assert.equal(await firstAnswering(['a', 'b'], server => { started.push([server, Date.now() - begin]); return server === 'a' ? later(5, 'down', true) : later(5, server); }, 5000), 'b');
  assert.ok(started[1][1] < 1000, 'not after the stagger');
  assert.equal(await firstAnswering(['slow', 'fast'], server => server === 'slow' ? later(80, server) : new Promise(() => {}), 20), 'slow');
});

test('when every server fails, the last error is given', async () => {
  await assert.rejects(firstAnswering(['a', 'b', 'c'], server => later(5, `${server} down`, true), 10), /c down/);
  await assert.rejects(firstAnswering(['a'], () => later(1, 'only one', true), 10), /only one/);
});

test('Re:Anime filters requested SUB or DUB audio before deduplicating shared URLs', async () => {
  const shared = 'https://flixcloud.cc/e/shared';
  const links = [
    { serverName: 'HD-1 DUB', dataType: 'dub', dataLink: shared },
    { serverName: 'HD-1', dataType: 'sub', dataLink: shared },
    { serverName: 'HD-2', dataType: 'sub', dataLink: 'https://flixcloud.cc/e/sub-hd2' }
  ];
  const resolverContext = vm.createContext({
    URL,
    REANIME_WEB: 'https://reanime.to',
    providerFetch: async () => ({ episode_links: links })
  });
  vm.runInContext(source.slice(reanimeStart, reanimeEnd), resolverContext);
  const resolve = resolverContext.reanimeServers;
  const episode = { url: 'https://reanime.to/watch/fixture?ep=1', number: 1 };

  assert.deepEqual(JSON.parse(JSON.stringify(await resolve({ ...episode, dub: false }))), [
    { name: 'HD-2', url: 'https://flixcloud.cc/e/sub-hd2', dub: false },
    { name: 'HD-1', url: shared, dub: false }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(await resolve({ ...episode, dub: true }))), [
    { name: 'HD-1 DUB', url: shared, dub: true }
  ]);
});

test('Re:Anime does not fall through to a DUB server when the requested SUB is unavailable', async () => {
  const resolverContext = vm.createContext({
    URL,
    REANIME_WEB: 'https://reanime.to',
    providerFetch: async () => ({ episode_links: [
      { serverName: 'HD-2 DUB', dataType: 'dub', dataLink: 'https://flixcloud.cc/e/dub-only' }
    ] })
  });
  vm.runInContext(source.slice(reanimeStart, reanimeEnd), resolverContext);
  const servers = await resolverContext.reanimeServers({ url: 'https://reanime.to/watch/fixture?ep=1', number: 1, dub: false });
  assert.equal(servers.length, 0);
});
