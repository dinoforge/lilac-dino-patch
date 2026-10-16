'use strict';

const path = require('node:path');

const HTTP_METHODS = ['request', 'get'];
const DNS_METHODS = [
  'lookup', 'lookupService', 'resolve', 'resolveAny', 'resolve4', 'resolve6', 'resolveCaa',
  'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolveSoa', 'resolveSrv',
  'resolveTxt', 'reverse'
];
const CHILD_PROCESS_METHODS = ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

function createFixtureAgentSpawnAllowlist({ nodeExecutable, agentScript, workingDirectory, environment, platform = process.platform }) {
  const paths = platform === 'win32' ? path.win32 : path;
  const normalize = value => {
    if (typeof value !== 'string' || !paths.isAbsolute(value)) return '';
    const resolved = paths.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const expectedNode = normalize(nodeExecutable);
  const expectedAgent = normalize(agentScript);
  const expectedCwd = normalize(workingDirectory);
  let used = false;

  return (command, args, options = {}) => {
    if (used || !expectedNode || !expectedAgent || !expectedCwd) return false;
    if (normalize(command) !== expectedNode || !Array.isArray(args) || args.length !== 1 || normalize(args[0]) !== expectedAgent) return false;
    if (normalize(options.cwd) !== expectedCwd || options.env !== environment || options.shell === true || options.detached === true) return false;
    if (!Array.isArray(options.stdio) || options.stdio.length !== 3 || options.stdio[0] !== 'pipe' || options.stdio[1] !== 'pipe' || options.stdio[2] !== 'pipe') return false;
    used = true;
    return true;
  };
}

function blockMethods(target, methods, blocked, prefix, asyncMethods = []) {
  if (!target) return;
  for (const method of methods) {
    if (typeof target[method] !== 'function') continue;
    target[method] = (...args) => {
      const error = blocked(prefix + '.' + method);
      return asyncMethods.includes(method) ? Promise.reject(error) : (() => { throw error; })();
    };
  }
}

function installNetworkGuard({ globalObject, electronNet, modules, childProcess, allowFixtureSpawn, onBlocked, onAllowedSpawn = () => {} }) {
  if (!globalObject || !modules || !childProcess || typeof onBlocked !== 'function') {
    throw new TypeError('The runtime attach network guard is missing required modules or callbacks.');
  }
  const blocked = api => onBlocked(api);
  if (typeof globalObject.fetch === 'function') {
    globalObject.fetch = (...args) => Promise.reject(blocked('global.fetch'));
  }
  if (electronNet) {
    if (typeof electronNet.fetch === 'function') electronNet.fetch = (...args) => Promise.reject(blocked('electron.net.fetch'));
    if (typeof electronNet.request === 'function') electronNet.request = (...args) => { throw blocked('electron.net.request'); };
  }

  for (const [moduleName, client] of [['node:http', modules.http], ['node:https', modules.https]]) {
    blockMethods(client, HTTP_METHODS, blocked, moduleName);
  }
  blockMethods(modules.net, ['connect', 'createConnection', 'createServer'], blocked, 'node:net');
  if (modules.net && modules.net.Socket && modules.net.Socket.prototype) {
    blockMethods(modules.net.Socket.prototype, ['connect'], blocked, 'node:net.Socket');
  }
  blockMethods(modules.tls, ['connect'], blocked, 'node:tls');
  blockMethods(modules.dgram, ['createSocket'], blocked, 'node:dgram');
  if (modules.dgram && modules.dgram.Socket && modules.dgram.Socket.prototype) {
    blockMethods(modules.dgram.Socket.prototype, ['connect', 'send'], blocked, 'node:dgram.Socket');
  }
  blockMethods(modules.dns, DNS_METHODS, blocked, 'node:dns');
  blockMethods(modules.dnsPromises, DNS_METHODS, blocked, 'node:dns/promises', DNS_METHODS);
  for (const resolver of [modules.dns && modules.dns.Resolver, modules.dnsPromises && modules.dnsPromises.Resolver]) {
    if (resolver && resolver.prototype) blockMethods(resolver.prototype, DNS_METHODS, blocked, 'node:dns.Resolver');
  }

  if (typeof childProcess.spawn === 'function') {
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function guardedSpawn(command, args, options) {
      if (typeof allowFixtureSpawn !== 'function' || !allowFixtureSpawn(command, args, options)) {
        throw blocked('node:child_process.spawn');
      }
      onAllowedSpawn({ executable: path.basename(String(command)), fixtureOnly: true });
      return originalSpawn.apply(this, arguments);
    };
  }
  blockMethods(childProcess, CHILD_PROCESS_METHODS, blocked, 'node:child_process');

  return {
    blockedNodeApis: [
      'global.fetch', 'electron.net.fetch', 'electron.net.request', 'node:http', 'node:https',
      'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:dns/promises', 'node:child_process'
    ],
    fixtureSpawnAllowlisted: true
  };
}

module.exports = { createFixtureAgentSpawnAllowlist, installNetworkGuard };
