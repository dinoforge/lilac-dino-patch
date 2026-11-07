'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const safety = require('./patch03-validation-safety.cjs');

const PROJECT_ROOT_EXPECTED = 'D:\\Codex-Coding-Folder\\LilacAnime-Player';
const PROJECT_ROOT = fs.realpathSync.native(path.resolve(__dirname, '..'));
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'patches', 'patch03', 'manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const CONTRACT_TEST = path.join(PROJECT_ROOT, 'tests', 'patch03-clean-source.contract.test.cjs');
const ELECTRON_HARNESS = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'patch03-clean-source.electron.cjs');

function parseArgs(args) {
  const result = { archive: '', dependenciesFrom: '', installDependencies: false, runElectron: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--archive') result.archive = args[++index] || '';
    else if (arg === '--dependencies-from') result.dependenciesFrom = args[++index] || '';
    else if (arg === '--install-dependencies') result.installDependencies = true;
    else if (arg === '--run-electron') result.runElectron = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (result.installDependencies && result.dependenciesFrom) throw new Error('Choose either --install-dependencies or --dependencies-from, not both.');
  if (result.runElectron && !result.installDependencies && !result.dependenciesFrom) {
    throw new Error('--run-electron needs an explicit --dependencies-from or --install-dependencies option.');
  }
  return result;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function relativeSafe(root, relative) {
  const absolute = path.resolve(root, relative);
  if (!safety.isSameOrWithin(absolute, root)) throw new Error(`Path escapes its root: ${relative}`);
  return absolute;
}

function replaceExactly(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one source anchor, found ${count}.`);
  return text.replace(before, after);
}

function listFiles(root, current = root, output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) listFiles(root, absolute, output);
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in official source: ${path.relative(root, absolute)}`);
  }
  return output.sort();
}

function inventory(root) {
  return new Map(listFiles(root).map(relative => [relative, sha256(path.join(root, ...relative.split('/')))]));
}

function treeSha256(files) {
  const hash = crypto.createHash('sha256');
  const sorted = [...files.entries()].sort(([left], [right]) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  for (const [relative, fileSha] of sorted) {
    hash.update(relative, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(fileSha, 'hex'));
    hash.update(Buffer.from([10]));
  }
  return hash.digest('hex').toUpperCase();
}

function verifyOfficialTree(files) {
  if (files.size !== MANIFEST.officialTreeFileCount) {
    throw new Error(`Official source file count mismatch: expected ${MANIFEST.officialTreeFileCount}, received ${files.size}.`);
  }
  const actual = treeSha256(files);
  if (actual !== MANIFEST.officialTreeSha256) throw new Error(`Official source tree SHA-256 mismatch: ${actual}`);
  return actual;
}

function ensureOfficialIdentity(sourceRoot, archiveSha) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== MANIFEST.officialVersion) throw new Error(`Expected official package ${MANIFEST.officialVersion}, received ${packageJson.version}.`);
  if (!fs.existsSync(path.join(sourceRoot, 'package-lock.json'))) throw new Error('The pinned official source must include package-lock.json.');
  if (fs.existsSync(path.join(sourceRoot, '.git'))) throw new Error('Expected a source archive, not a working Git checkout.');
  if (archiveSha !== MANIFEST.officialArchiveSha256) throw new Error('The archive hash does not match the pinned official v0.5.54 archive.');
  const expectedTop = `LilacAnime-desktop-${MANIFEST.officialCommit}`;
  if (path.basename(sourceRoot) !== expectedTop) throw new Error(`The archive root name does not identify the pinned commit: ${path.basename(sourceRoot)}`);
  return packageJson;
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar.exe';
  const result = spawnSync(tar, ['-xf', archive, '-C', destination], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Official archive extraction failed (${result.status}): ${(result.stderr || result.stdout || '').slice(0, 1200)}`);
  const expected = `LilacAnime-desktop-${MANIFEST.officialCommit}`;
  const roots = fs.readdirSync(destination, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name);
  if (roots.length !== 1 || roots[0] !== expected) throw new Error(`Expected only ${expected} in the archive, found: ${roots.join(', ') || '(none)'}`);
  return path.join(destination, expected);
}

function applyPatch(sourceRoot) {
  const original = inventory(sourceRoot);
  const forbiddenExisting = [
    ...MANIFEST.runtimeModules.map(item => item.destination),
    'tests/patch03-clean-source.electron.cjs'
  ].filter(relative => original.has(relative));
  if (forbiddenExisting.length) throw new Error(`Patch files already exist in the official archive: ${forbiddenExisting.join(', ')}`);

  for (const connection of MANIFEST.connections) {
    const target = relativeSafe(sourceRoot, connection.file);
    const content = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, replaceExactly(content, connection.before, connection.after, connection.description), 'utf8');
  }

  for (const module of MANIFEST.runtimeModules) {
    const input = relativeSafe(PROJECT_ROOT, module.source);
    if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`Required Patch 03 module is missing: ${module.source}`);
    const actualHash = sha256(input);
    if (actualHash !== module.sha256) throw new Error(`Patch module changed since its manifest was reviewed: ${module.source} (${actualHash})`);
    const output = relativeSafe(sourceRoot, module.destination);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
  }

  return original;
}

function verifyChangedFiles(sourceRoot, before) {
  const after = inventory(sourceRoot);
  const modified = [...before.keys()].filter(file => after.has(file) && before.get(file) !== after.get(file)).sort();
  const removed = [...before.keys()].filter(file => !after.has(file)).sort();
  const added = [...after.keys()].filter(file => !before.has(file)).sort();
  const expectedModified = [...MANIFEST.officialRuntimeModifiedAllowlist].sort();
  const expectedAdded = MANIFEST.runtimeModules.map(item => item.destination).sort();
  if (JSON.stringify(modified) !== JSON.stringify(expectedModified)) throw new Error(`Unexpected official files modified: ${modified.join(', ') || '(none)'}`);
  if (removed.length) throw new Error(`Official source files were removed: ${removed.join(', ')}`);
  if (JSON.stringify(added) !== JSON.stringify(expectedAdded)) throw new Error(`Unexpected files added to the app runtime: ${added.join(', ') || '(none)'}`);

  const app = fs.readFileSync(path.join(sourceRoot, 'src', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(sourceRoot, 'src', 'index.html'), 'utf8');
  const bridge = fs.readFileSync(path.join(sourceRoot, 'src', 'patch03-bridge.js'), 'utf8');
  if ((html.match(/id="detailDialog"/g) || []).length !== 1) throw new Error('Patch 03 must reuse the one official #detailDialog.');
  if (!/savedContentSource === 'integrated' \? \(localStorage\.getItem\('contentSourceProvider'\) \|\| 'reanime'\)/.test(app)) throw new Error('The integrated-mode state bootstrap was not applied.');
  if (!/integrated-search\.js[\s\S]*app\.js[\s\S]*patch03-bridge\.js/.test(html)) throw new Error('Patch script load order is incorrect.');
  if (!bridge.includes('window.lilac.providerCatalog(provider, text)')
    || (!bridge.includes('officialOpenDetail.call(this, id)') && !bridge.includes('officialOpenDetail.call(this, selectedId)'))) {
    throw new Error('Patch bridge no longer uses the official catalog/detail functions.');
  }
  const patchApi = require(path.join(sourceRoot, 'src', 'integrated-search.js'));
  if (JSON.stringify(patchApi.PROVIDERS) !== JSON.stringify(['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'])) throw new Error('Patch provider allowlist drifted or includes Linkkf.');
  return { modified, removed, added, hashes: Object.fromEntries([...after.entries()]) };
}

function verifyOfficialContracts(sourceRoot) {
  const preload = fs.readFileSync(path.join(sourceRoot, 'electron', 'preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(sourceRoot, 'electron', 'main.cjs'), 'utf8');
  const app = fs.readFileSync(path.join(sourceRoot, 'src', 'app.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(sourceRoot, 'src', 'patch03-bridge.js'), 'utf8');
  const checks = [];
  for (const { name, channel } of MANIFEST.officialApis) {
    const preloadOk = new RegExp(`${name}:[\\s\\S]{0,180}?ipcRenderer\\.invoke\\('${channel}'`).test(preload);
    const mainOk = main.includes(`ipcMain.handle('${channel}'`);
    const patchOk = bridge.includes(name);
    if (!preloadOk || !mainOk || !patchOk) throw new Error(`Official IPC contract is incomplete: ${name}/${channel}.`);
    checks.push({ name, channel, preload: preloadOk, main: mainOk, patch: patchOk });
  }
  if (!/function doSearch\(/.test(app) || !/function openDetail\(/.test(app)) throw new Error('Official search/detail renderer entry points are unavailable.');
  if (!/providerResolve/.test(preload) || !/provider:resolve/.test(main)) throw new Error('Official providerResolve path is unavailable.');
  return checks;
}

function runNodeCheck(file, cwd) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`node --check failed for ${file}: ${(result.stderr || result.stdout || '').slice(0, 1200)}`);
}

function runContractTests(sourceRoot) {
  const result = spawnSync(process.execPath, ['--test', CONTRACT_TEST], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, PATCH03_SOURCE_ROOT: sourceRoot }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Clean-source contract tests failed for ${sourceRoot}:\n${(result.stdout || '') + (result.stderr || '')}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function assertDependencySource(sourceRoot, dependencyRoot, tempRoot) {
  const isolated = safety.assertIsolatedTempTarget({ projectRoot: PROJECT_ROOT, targetRoot: dependencyRoot, tempRoot });
  const expectedLock = sha256(path.join(sourceRoot, 'package-lock.json'));
  const actualLock = sha256(path.join(isolated.targetRoot, 'package-lock.json'));
  if (actualLock !== expectedLock) throw new Error('Temporary dependency source has a different official package-lock.json.');
  const electronPackage = JSON.parse(fs.readFileSync(path.join(isolated.targetRoot, 'node_modules', 'electron', 'package.json'), 'utf8'));
  if (electronPackage.version !== '38.8.6') throw new Error(`Expected Electron 38.8.6 in temporary dependency source, got ${electronPackage.version}.`);
  return isolated.targetRoot;
}

function attachDependencies(sourceRoot, dependencyRoot) {
  const target = path.join(sourceRoot, 'node_modules');
  if (fs.existsSync(target)) throw new Error('Refusing to replace an existing node_modules path in the validation source.');
  fs.symlinkSync(path.join(dependencyRoot, 'node_modules'), target, 'junction');
}

function installDependencies(sourceRoot, identityPath, sessionRoot) {
  safety.assertInstallIdentity({
    projectRoot: PROJECT_ROOT,
    targetRoot: sourceRoot,
    tempRoot: os.tmpdir(),
    identityFile: identityPath,
    expectedVersion: MANIFEST.officialVersion,
    expectedCommit: MANIFEST.officialCommit
  });
  const cache = path.join(sessionRoot, 'npm-cache');
  const logs = path.join(sessionRoot, 'npm-logs');
  const userConfig = path.join(sessionRoot, 'npmrc');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(userConfig, 'update-notifier=false\nfund=false\naudit=false\n', 'utf8');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['ci', '--no-audit', '--no-fund'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_cache: cache,
      npm_config_logs_dir: logs,
      npm_config_userconfig: userConfig,
      npm_config_update_notifier: 'false'
    }
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(path.join(sessionRoot, 'npm-ci.log'), output, 'utf8');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Explicit isolated npm ci failed with exit ${result.status}. See ${path.join(sessionRoot, 'npm-ci.log')}`);
  return sourceRoot;
}

function redact(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/g, '[url redacted]')
    .replace(/(cookie|authorization|token|api[_-]?key)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[redacted]');
}

function runElectron(sourceRoot, sessionRoot, label) {
  const harnessSource = ELECTRON_HARNESS;
  if (!fs.existsSync(harnessSource)) throw new Error(`Electron harness is missing: ${harnessSource}`);
  const harnessTarget = path.join(sourceRoot, 'tests', 'patch03-clean-source.electron.cjs');
  fs.copyFileSync(harnessSource, harnessTarget, fs.constants.COPYFILE_EXCL);
  const electronExe = path.join(sourceRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) throw new Error('Electron binary is missing from the explicitly validated temporary dependency tree.');
  const profileRoot = path.join(os.tmpdir(), `lilac-clean-patch03-${crypto.randomUUID()}`);
  safety.assertIsolatedTempTarget({ projectRoot: PROJECT_ROOT, targetRoot: profileRoot, tempRoot: os.tmpdir() });
  const runProcess = (processLabel, args) => {
    const result = spawnSync(electronExe, [harnessTarget, ...args], {
      cwd: sourceRoot,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PATCH03_TEST_ROOT: profileRoot }
    });
    const output = redact(`${result.stdout || ''}${result.stderr || ''}`);
    const logPath = path.join(sessionRoot, `${label}-${processLabel}-electron.log`);
    fs.writeFileSync(logPath, output, 'utf8');
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Isolated Electron ${label}/${processLabel} run failed with exit ${result.status}. See ${logPath}`);
    const stages = output.split(/\r?\n/)
      .filter(line => line.includes('PATCH03_CLEAN '))
      .map(line => {
        const payload = line.slice(line.indexOf('PATCH03_CLEAN ') + 'PATCH03_CLEAN '.length);
        try { return JSON.parse(payload); } catch { return null; }
      }).filter(Boolean);
    if (stages.some(stage => stage.stage === 'test-failed') || !stages.some(stage => stage.stage === 'test-completed')) {
      throw new Error(`Isolated Electron ${label}/${processLabel} did not report a clean harness completion. See ${logPath}`);
    }
    const pathStage = stages.find(stage => stage.stage === 'isolated-paths-verified');
    for (const key of ['appData', 'userData', 'sessionData']) {
      const expected = safety.canonicalPath(path.join(profileRoot, key));
      const reported = pathStage?.paths?.[key];
      if (!reported || safety.canonicalPath(reported) !== expected) throw new Error(`Electron app.getPath('${key}') did not match the isolated path. See ${logPath}`);
    }
    return {
      exitCode: result.status,
      logPath,
      stages
    };
  };
  const firstProcess = runProcess('first-process', []);
  const restart = runProcess('restart', ['--verify-integrated']);
  return { profileRoot, firstProcess, restart };
}

function prepareOne({ archive, archiveSha, sessionRoot, label }) {
  const extraction = path.join(sessionRoot, `${label}-extracted`);
  const sourceRoot = extractArchive(archive, extraction);
  const packageJson = ensureOfficialIdentity(sourceRoot, archiveSha);
  const officialTree = verifyOfficialTree(inventory(sourceRoot));
  const before = applyPatch(sourceRoot);
  const checked = verifyChangedFiles(sourceRoot, before);
  const officialContracts = verifyOfficialContracts(sourceRoot);
  const syntaxFiles = [
    path.join(sourceRoot, 'src', 'app.js'),
    path.join(sourceRoot, 'src', 'integrated-search.js'),
    path.join(sourceRoot, 'src', 'patch03-bridge.js')
  ];
  for (const file of syntaxFiles) runNodeCheck(file, sourceRoot);
  const contractOutput = runContractTests(sourceRoot);
  const identityPath = path.join(sessionRoot, `${label}-official-source-identity.json`);
  fs.writeFileSync(identityPath, JSON.stringify({
    targetRoot: sourceRoot,
    officialVersion: MANIFEST.officialVersion,
    officialCommit: MANIFEST.officialCommit,
    archiveSha256: archiveSha,
    packageVersion: packageJson.version,
    officialTreeSha256: officialTree,
    packageLockSha256: sha256(path.join(sourceRoot, 'package-lock.json')),
    createdAt: new Date().toISOString()
  }, null, 2), 'utf8');
  return {
    label,
    sourceRoot,
    identityPath,
    packageVersion: packageJson.version,
    packageLockSha256: sha256(path.join(sourceRoot, 'package-lock.json')),
    changedOfficialFiles: checked.modified,
    addedRuntimeFiles: checked.added,
    removedOfficialFiles: checked.removed,
    runtimeHashes: checked.hashes,
    officialContracts,
    syntaxFiles: syntaxFiles.map(file => path.relative(sourceRoot, file).split(path.sep).join('/')),
    contractOutput
  };
}

function compareRuns(first, second) {
  const firstHashes = first.runtimeHashes;
  const secondHashes = second.runtimeHashes;
  const keys = [...new Set([...Object.keys(firstHashes), ...Object.keys(secondHashes)])].sort();
  const mismatches = keys.filter(key => firstHashes[key] !== secondHashes[key]);
  if (mismatches.length) throw new Error(`Repeated application produced different file hashes: ${mismatches.join(', ')}`);
  return { comparedFiles: keys.length, mismatches: [], identical: true };
}

async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('This validator is Windows-only because it uses the pinned OS Temp and Windows tar.exe archive extraction.');
  const project = safety.assertProjectWorkingDirectory(PROJECT_ROOT_EXPECTED, process.cwd());
  if (!safety.isSameOrWithin(PROJECT_ROOT, project) || !safety.isSameOrWithin(project, PROJECT_ROOT)) throw new Error('Validator script root does not match the required development project.');
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: node scripts/validate-patch03-clean-source.cjs --archive <pinned-v0.5.54.zip> [--dependencies-from <OS-Temp-source>] [--run-electron] [--install-dependencies]');
    console.log('No dependency installation occurs unless --install-dependencies is explicitly supplied.');
    return;
  }
  if (!options.archive) throw new Error('--archive is required; the validator never downloads official source implicitly.');
  if (options.runElectron && !fs.existsSync(ELECTRON_HARNESS)) throw new Error(`Electron harness is missing: ${ELECTRON_HARNESS}`);
  if (!fs.existsSync(CONTRACT_TEST)) throw new Error(`Clean-source contract test is missing: ${CONTRACT_TEST}`);
  const archivePath = safety.canonicalPath(options.archive);
  if (!fs.statSync(archivePath).isFile()) throw new Error('--archive must point to a file.');
  const archiveSha = sha256(archivePath);
  if (archiveSha !== MANIFEST.officialArchiveSha256) throw new Error(`Official archive SHA-256 mismatch: ${archiveSha}`);
  const tempRoot = safety.canonicalPath(os.tmpdir());
  const sessionRoot = fs.mkdtempSync(path.join(tempRoot, 'lilac-patch03-verify-'));
  safety.assertIsolatedTempTarget({ projectRoot: project, targetRoot: sessionRoot, tempRoot });
  const first = prepareOne({ archive: archivePath, archiveSha, sessionRoot, label: 'source-a' });
  const second = prepareOne({ archive: archivePath, archiveSha, sessionRoot, label: 'source-b' });
  const reproducibility = compareRuns(first, second);

  let electronResult = { status: 'NOT RUN', reason: 'Pass --run-electron with an explicit temporary dependency source or --install-dependencies.' };
  if (options.installDependencies) {
    installDependencies(first.sourceRoot, first.identityPath, sessionRoot);
    attachDependencies(second.sourceRoot, first.sourceRoot);
  } else if (options.dependenciesFrom) {
    const dependencyRoot = assertDependencySource(first.sourceRoot, options.dependenciesFrom, tempRoot);
    attachDependencies(first.sourceRoot, dependencyRoot);
    attachDependencies(second.sourceRoot, dependencyRoot);
  }
  if (options.runElectron) {
    if (options.installDependencies) assertDependencySource(first.sourceRoot, first.sourceRoot, tempRoot);
    else assertDependencySource(first.sourceRoot, options.dependenciesFrom, tempRoot);
    electronResult = { status: 'PASS', ...runElectron(first.sourceRoot, sessionRoot, 'source-a') };
  }

  const report = {
    officialVersion: MANIFEST.officialVersion,
    officialCommit: MANIFEST.officialCommit,
    archiveSha256: archiveSha,
    officialTreeSha256: first.officialTreeSha256,
    appRuntimeModifiedFiles: first.changedOfficialFiles,
    appRuntimeAddedFiles: first.addedRuntimeFiles,
    appRuntimeRemovedFiles: first.removedOfficialFiles,
    patchTestHarnessCopiedAfterAllowlistCheck: options.runElectron,
    repeatedApplication: reproducibility,
    contractTests: { sourceA: first.contractOutput, sourceB: second.contractOutput },
    electron: electronResult,
    npmInstallPerformed: Boolean(options.installDependencies),
    sessionRoot,
    sourceRoots: [first.sourceRoot, second.sourceRoot],
    completedAt: new Date().toISOString()
  };
  const reportPath = path.join(sessionRoot, 'validation-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    officialVersion: report.officialVersion,
    officialCommit: report.officialCommit,
    archiveSha256: report.archiveSha256,
    appRuntimeModifiedFiles: report.appRuntimeModifiedFiles,
    appRuntimeAddedFiles: report.appRuntimeAddedFiles,
    repeat: report.repeatedApplication,
    electron: report.electron.status,
    npmInstallPerformed: report.npmInstallPerformed,
    reportPath
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`PATCH03_VALIDATION_FAILED: ${String(error?.stack || error).replace(/https?:\/\/[^\s"'<>]+/g, '[url redacted]')}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, replaceExactly, listFiles, inventory, treeSha256, verifyOfficialTree, applyPatch, verifyChangedFiles, verifyOfficialContracts };
