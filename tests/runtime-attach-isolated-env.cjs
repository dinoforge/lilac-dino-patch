'use strict';

const path = require('node:path');

function readEnvironmentValue(environment, name) {
  const key = Object.keys(environment || {}).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

function createIsolatedEnvironment(options) {
  const {
    sourceEnv = process.env,
    platform = process.platform,
    electronExecutable,
    nodeExecutable,
    tempRoot,
    profileRoot,
    sourceRoot,
    repoRoot,
    hookPath,
    agentPath,
    catalogPath,
    logPath,
    screenshotPath,
    screenshotRelative
  } = options || {};
  const paths = platform === 'win32' ? path.win32 : path;
  const requiredPaths = {
    electronExecutable,
    nodeExecutable,
    tempRoot,
    profileRoot,
    sourceRoot,
    repoRoot,
    hookPath,
    agentPath,
    catalogPath,
    logPath,
    screenshotPath
  };
  for (const [name, value] of Object.entries(requiredPaths)) {
    if (typeof value !== 'string' || !value || !paths.isAbsolute(value)) {
      throw new TypeError('The isolated environment requires an absolute ' + name + ' path.');
    }
  }
  if (typeof screenshotRelative !== 'string' || !screenshotRelative) {
    throw new TypeError('The isolated environment requires a repository-relative screenshot path.');
  }

  const systemRoot = readEnvironmentValue(sourceEnv, 'SystemRoot') || readEnvironmentValue(sourceEnv, 'WINDIR');
  if (platform === 'win32' && (!systemRoot || !paths.isAbsolute(systemRoot))) {
    throw new Error('A valid SystemRoot is required to launch the isolated Windows app.');
  }

  const pathEntries = platform === 'win32'
    ? [paths.join(systemRoot, 'System32'), systemRoot, paths.dirname(electronExecutable), paths.dirname(nodeExecutable)]
    : [paths.dirname(electronExecutable), paths.dirname(nodeExecutable), '/usr/bin', '/bin'];
  const uniquePathEntries = [...new Map(pathEntries.map(entry => [entry.toLowerCase(), paths.resolve(entry)])).values()];
  const profile = paths.resolve(profileRoot);
  const temp = paths.resolve(tempRoot);
  const repo = paths.resolve(repoRoot);

  const environment = {
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: paths.join(profile, 'appdata', 'roaming'),
    LOCALAPPDATA: paths.join(profile, 'appdata', 'local'),
    TEMP: paths.join(temp, 'runtime-temp'),
    TMP: paths.join(temp, 'runtime-temp'),
    NODE_PATH: paths.join(repo, 'node_modules'),
    PATH: uniquePathEntries.join(paths.delimiter),
    LILAC_RUNTIME_ATTACH_TEMP: temp,
    LILAC_RUNTIME_ATTACH_PROFILE: profile,
    LILAC_RUNTIME_ATTACH_SOURCE: paths.resolve(sourceRoot),
    LILAC_RUNTIME_ATTACH_REPO: repo,
    LILAC_RUNTIME_ATTACH_NODE: paths.resolve(nodeExecutable),
    LILAC_RUNTIME_ATTACH_ELECTRON: paths.resolve(electronExecutable),
    LILAC_RUNTIME_ATTACH_HOOK: paths.resolve(hookPath),
    LILAC_RUNTIME_ATTACH_AGENT: paths.resolve(agentPath),
    LILAC_RUNTIME_ATTACH_CATALOG: paths.resolve(catalogPath),
    LILAC_RUNTIME_ATTACH_LOG: paths.resolve(logPath),
    LILAC_RUNTIME_ATTACH_SCREENSHOT: paths.resolve(screenshotPath),
    LILAC_RUNTIME_ATTACH_SCREENSHOT_RELATIVE: screenshotRelative
  };

  if (platform === 'win32') {
    environment.SYSTEMROOT = paths.resolve(systemRoot);
    environment.WINDIR = paths.resolve(systemRoot);
    environment.OS = 'Windows_NT';
  }
  return environment;
}

module.exports = { createIsolatedEnvironment, readEnvironmentValue };
