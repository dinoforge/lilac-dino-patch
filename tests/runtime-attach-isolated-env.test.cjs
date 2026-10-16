'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createIsolatedEnvironment } = require('./runtime-attach-isolated-env.cjs');

const root = 'C:\\runtime-attach-test';

test('creates an explicit isolated environment without inheriting parent secrets or startup hooks', () => {
  const environment = createIsolatedEnvironment({
    platform: 'win32',
    sourceEnv: {
      Path: 'C:\\Users\\Example\\malicious-bin',
      SystemRoot: 'C:\\Windows',
      NODE_OPTIONS: '--require=C:\\secret\\hook.js',
      ELECTRON_RUN_AS_NODE: '1',
      OPENAI_API_KEY: 'secret-value',
      GITHUB_TOKEN: 'another-secret',
      APPDATA: 'C:\\Users\\Example\\AppData\\Roaming',
      TEMP: 'C:\\Users\\Example\\AppData\\Local\\Temp'
    },
    electronExecutable: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
    nodeExecutable: 'C:\\node\\node.exe',
    tempRoot: root,
    profileRoot: path.win32.join(root, 'profile'),
    sourceRoot: path.win32.join(root, 'source'),
    repoRoot: 'C:\\repo',
    hookPath: 'C:\\repo\\tests\\runtime-attach-fixture\\host-hook.cjs',
    agentPath: 'C:\\repo\\tests\\runtime-attach-fixture\\agent.cjs',
    catalogPath: 'C:\\repo\\companion\\core\\catalog.cjs',
    logPath: 'C:\\repo\\docs\\verification\\evidence.jsonl',
    screenshotPath: 'C:\\repo\\docs\\verification\\assets\\evidence.png',
    screenshotRelative: 'docs/verification/assets/evidence.png'
  });

  assert.equal(environment.SYSTEMROOT, 'C:\\Windows');
  assert.equal(environment.USERPROFILE, path.win32.join(root, 'profile'));
  assert.equal(environment.HOME, environment.USERPROFILE);
  assert.equal(environment.APPDATA, path.win32.join(root, 'profile', 'appdata', 'roaming'));
  assert.equal(environment.LOCALAPPDATA, path.win32.join(root, 'profile', 'appdata', 'local'));
  assert.equal(environment.TEMP, path.win32.join(root, 'runtime-temp'));
  assert.equal(environment.TMP, environment.TEMP);
  assert.equal(environment.NODE_PATH, 'C:\\repo\\node_modules');
  assert.equal(environment.PATH.includes('malicious-bin'), false);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.deepEqual(Object.keys(environment).sort(), [
    'APPDATA', 'HOME', 'LILAC_RUNTIME_ATTACH_AGENT', 'LILAC_RUNTIME_ATTACH_CATALOG',
    'LILAC_RUNTIME_ATTACH_ELECTRON', 'LILAC_RUNTIME_ATTACH_HOOK', 'LILAC_RUNTIME_ATTACH_LOG',
    'LILAC_RUNTIME_ATTACH_NODE', 'LILAC_RUNTIME_ATTACH_PROFILE', 'LILAC_RUNTIME_ATTACH_REPO',
    'LILAC_RUNTIME_ATTACH_SCREENSHOT', 'LILAC_RUNTIME_ATTACH_SCREENSHOT_RELATIVE',
    'LILAC_RUNTIME_ATTACH_SOURCE', 'LILAC_RUNTIME_ATTACH_TEMP', 'LOCALAPPDATA', 'NODE_PATH',
    'OS', 'PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'
  ].sort());
});

test('rejects missing Windows system root and non-absolute execution paths', () => {
  const base = {
    platform: 'win32',
    sourceEnv: {},
    electronExecutable: 'C:\\repo\\electron.exe',
    nodeExecutable: 'C:\\node\\node.exe',
    tempRoot: root,
    profileRoot: path.win32.join(root, 'profile'),
    sourceRoot: path.win32.join(root, 'source'),
    repoRoot: 'C:\\repo',
    hookPath: 'C:\\repo\\hook.cjs',
    agentPath: 'C:\\repo\\agent.cjs',
    catalogPath: 'C:\\repo\\catalog.cjs',
    logPath: 'C:\\repo\\log.jsonl',
    screenshotPath: 'C:\\repo\\screen.png',
    screenshotRelative: 'screen.png'
  };
  assert.throws(() => createIsolatedEnvironment(base), /SystemRoot/);
  assert.throws(() => createIsolatedEnvironment({ ...base, sourceEnv: { WINDIR: 'C:\\Windows' }, agentPath: 'agent.cjs' }), /absolute agentPath/);
});
