'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFixtureAgentSpawnAllowlist, installNetworkGuard } = require('./runtime-attach-fixture/network-guard.cjs');

function stubMethods(names) {
  return Object.fromEntries(names.map(name => [name, () => 'original:' + name]));
}

test('blocks standard Node and Electron egress APIs while allowing one exact fixture-agent spawn', async () => {
  const blocked = [];
  const allowed = [];
  const environment = {};
  const globalObject = { fetch: async () => 'original fetch' };
  const electronNet = { fetch: async () => 'original net fetch', request: () => 'original net request' };
  const http = stubMethods(['request', 'get']);
  const https = stubMethods(['request', 'get']);
  const socketPrototype = stubMethods(['connect']);
  const nodeNet = { ...stubMethods(['connect', 'createConnection', 'createServer']), Socket: function Socket() {} };
  nodeNet.Socket.prototype = socketPrototype;
  const tls = stubMethods(['connect']);
  const dgramSocket = stubMethods(['connect', 'send']);
  const dgram = { ...stubMethods(['createSocket']), Socket: function Socket() {} };
  dgram.Socket.prototype = dgramSocket;
  const dnsMethods = ['lookup', 'lookupService', 'resolve', 'resolveAny', 'resolve4', 'resolve6', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
  const dnsResolver = function Resolver() {};
  dnsResolver.prototype = stubMethods(dnsMethods);
  const dns = { ...stubMethods(dnsMethods), Resolver: dnsResolver };
  const dnsPromisesResolver = function Resolver() {};
  dnsPromisesResolver.prototype = stubMethods(dnsMethods);
  const dnsPromises = { ...stubMethods(dnsMethods), Resolver: dnsPromisesResolver };
  for (const method of dnsMethods) {
    dnsPromises[method] = async () => 'original:' + method;
    dnsPromisesResolver.prototype[method] = async () => 'original:' + method;
  }
  const childProcess = {
    spawn: (...args) => ({ allowed: args }),
    ...stubMethods(['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  };
  const allowFixtureSpawn = createFixtureAgentSpawnAllowlist({
    platform: 'win32',
    nodeExecutable: 'C:\\node\\node.exe',
    agentScript: 'C:\\repo\\agent.cjs',
    workingDirectory: 'C:\\repo',
    environment
  });
  const result = installNetworkGuard({
    globalObject,
    electronNet,
    modules: { http, https, net: nodeNet, tls, dgram, dns, dnsPromises },
    childProcess,
    allowFixtureSpawn,
    onBlocked(api) {
      blocked.push(api);
      return new Error('blocked:' + api);
    },
    onAllowedSpawn(details) { allowed.push(details); }
  });

  await assert.rejects(globalObject.fetch('https://example.invalid'), /blocked:global.fetch/);
  await assert.rejects(electronNet.fetch('https://example.invalid'), /blocked:electron.net.fetch/);
  assert.throws(() => electronNet.request({}), /blocked:electron.net.request/);
  for (const client of [http, https]) {
    for (const method of ['request', 'get']) assert.throws(() => client[method]('https://example.invalid'), /blocked:/);
  }
  for (const method of ['connect', 'createConnection', 'createServer']) assert.throws(() => nodeNet[method](), /blocked:/);
  assert.throws(() => new nodeNet.Socket().connect(), /blocked:/);
  assert.throws(() => tls.connect(), /blocked:/);
  assert.throws(() => dgram.createSocket(), /blocked:/);
  assert.throws(() => new dgram.Socket().send(), /blocked:/);
  for (const method of dnsMethods) assert.throws(() => dns[method]('example.invalid'), /blocked:/);
  for (const method of dnsMethods) await assert.rejects(dnsPromises[method]('example.invalid'), /blocked:/);
  for (const method of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    assert.throws(() => childProcess[method]('command'), /blocked:/);
  }

  const child = childProcess.spawn('C:\\node\\node.exe', ['C:\\repo\\agent.cjs'], {
    cwd: 'C:\\repo', env: environment, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe']
  });
  assert.ok(child.allowed);
  assert.throws(() => childProcess.spawn('C:\\node\\node.exe', ['C:\\repo\\other.cjs'], {
    cwd: 'C:\\repo', env: environment, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe']
  }), /blocked:node:child_process\.spawn/);
  assert.equal(allowed.length, 1);
  assert.equal(result.fixtureSpawnAllowlisted, true);
  assert.ok(result.blockedNodeApis.includes('node:tls'));
  assert.ok(blocked.includes('node:dns/promises.resolve4'));
  assert.ok(blocked.includes('node:child_process.spawn'));
});

test('fixture-agent spawn allowlist requires exact executable, script, cwd, environment, stdio, and one use', () => {
  const environment = {};
  const allow = createFixtureAgentSpawnAllowlist({
    platform: 'win32',
    nodeExecutable: 'C:\\node\\node.exe',
    agentScript: 'C:\\repo\\agent.cjs',
    workingDirectory: 'C:\\repo',
    environment
  });
  const options = { cwd: 'C:\\repo', env: environment, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'] };
  assert.equal(allow('C:\\node\\node.exe', ['C:\\repo\\agent.cjs'], { ...options, env: {} }), false);
  assert.equal(allow('C:\\node\\node.exe', ['C:\\repo\\agent.cjs'], { ...options, shell: true }), false);
  assert.equal(allow('C:\\node\\node.exe', ['C:\\repo\\agent.cjs'], options), true);
  assert.equal(allow('C:\\node\\node.exe', ['C:\\repo\\agent.cjs'], options), false);
});
