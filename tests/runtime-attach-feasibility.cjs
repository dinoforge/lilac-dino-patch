'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { findUnexpectedWorkingTreePaths } = require('./runtime-attach-working-tree.cjs');
const { createIsolatedEnvironment } = require('./runtime-attach-isolated-env.cjs');

const REPO = path.resolve(__dirname, '..');
const BASE_BRANCH = 'codex/runtime-companion-prototype';
const BASE_COMMIT = 'dcd6b9818c0f13fd9970cc3c94e4539fd33aeb64';
const UPSTREAM_TAG_COMMIT = 'f095fc3d775451e144ed780e1fa081f739927652';
const TEMP_PREFIX = 'lilac-runtime-attach-';

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: REPO, encoding: options.encoding || 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + String(result.stderr || '').trim());
  return result.stdout;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

function collectFiles(root) {
  const found = {};
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const absolute = path.join(folder, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        found[relative] = 'symlink';
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        found[relative] = hashFile(absolute);
      }
    }
  }
  visit(root);
  return found;
}

function snapshotDirectory(root) {
  if (!fs.existsSync(root)) return { files: 0, entries: [] };
  const files = collectFiles(root);
  return {
    files: Object.keys(files).length,
    entries: Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([file, hash]) => ({ file, sha256: hash }))
  };
}

function appendLog(target, event, details = {}) {
  fs.appendFileSync(target, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n', 'utf8');
}

function assertOwnedTempRoot(tempRoot, osTempReal) {
  const resolved = fs.realpathSync(tempRoot);
  if (path.dirname(resolved).toLowerCase() !== osTempReal.toLowerCase() || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error('Refusing to operate outside the unique experiment-owned system temp directory.');
  }
  return resolved;
}

function removeProjectDependencyJunction(sourceRoot) {
  const junction = path.join(sourceRoot, 'node_modules');
  let stat;
  try {
    stat = fs.lstatSync(junction);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isSymbolicLink()) throw new Error('Refusing cleanup because source/node_modules is not the expected junction.');
  const linkTarget = path.resolve(path.dirname(junction), fs.readlinkSync(junction));
  const expectedTarget = path.resolve(REPO, 'node_modules');
  if (linkTarget.toLowerCase() !== expectedTarget.toLowerCase()) {
    throw new Error('Refusing cleanup because the dependency junction target differs from this project node_modules.');
  }
  if (process.platform === 'win32' && stat.isDirectory()) fs.rmdirSync(junction);
  else fs.unlinkSync(junction);
  try {
    fs.lstatSync(junction);
    throw new Error('The temporary dependency junction still exists after removal.');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return true;
}

function cleanupOwnedTempTree(tempRoot, sourceRoot, osTempReal) {
  const resolved = assertOwnedTempRoot(tempRoot, osTempReal);
  const relativeSource = path.relative(resolved, path.resolve(sourceRoot));
  if (!relativeSource || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
    throw new Error('Refusing cleanup because the source copy is outside the experiment temp directory.');
  }
  const dependencyJunctionRemoved = removeProjectDependencyJunction(sourceRoot);
  fs.rmSync(resolved, { recursive: true, force: false });
  if (fs.existsSync(resolved)) throw new Error('The experiment-owned temporary directory remains after cleanup.');
  return { removedOnlyCreatedTempTree: true, dependencyJunctionRemoved, cleanupComplete: true };
}

function waitForExit(child, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let escalationTimer;
    let finalTimer;
    const finish = (code, signal, stillRunning = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      clearTimeout(finalTimer);
      resolve({ code, signal, timedOut, stillRunning });
    };
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      let terminationRequested = false;
      try { terminationRequested = child.kill(); } catch {}
      onTimeout({ pid: child.pid || null, terminationRequested, target: 'harness-spawned-electron-child-only' });
      escalationTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        let secondTerminationRequested = false;
        try { secondTerminationRequested = child.kill(); } catch {}
        onTimeout({ pid: child.pid || null, terminationRequested: secondTerminationRequested, target: 'harness-spawned-electron-child-only', retry: true });
        finalTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) finish(null, null, true);
        }, 3000);
      }, 5000);
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      clearTimeout(finalTimer);
      reject(error);
    });
    child.once('exit', (code, signal) => finish(code, signal));
  });
}

function extractGitArchive(destination) {
  return new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', UPSTREAM_TAG_COMMIT], { cwd: REPO, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('tar.exe', ['-xf', '-', '-C', destination], { cwd: REPO, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let archiveError = '';
    let extractError = '';
    archive.stderr.setEncoding('utf8');
    extract.stderr.setEncoding('utf8');
    archive.stderr.on('data', chunk => { archiveError += chunk; });
    extract.stderr.on('data', chunk => { extractError += chunk; });
    archive.stdout.pipe(extract.stdin);
    archive.once('error', reject);
    extract.once('error', reject);
    Promise.all([
      new Promise((done, fail) => archive.once('exit', code => code === 0 ? done() : fail(new Error('git archive failed: ' + archiveError)))),
      new Promise((done, fail) => extract.once('exit', code => code === 0 ? done() : fail(new Error('tar extraction failed: ' + extractError))))
    ]).then(resolve, reject);
  });
}

function chooseArtifact(basePath) {
  let candidate = basePath;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    const extension = path.extname(basePath);
    const withoutExtension = basePath.slice(0, -extension.length);
    candidate = withoutExtension + '-' + suffix++ + extension;
  }
  return candidate;
}

function validateExpectedCheckout() {
  if (process.platform !== 'win32') throw new Error('This experiment is constrained to the requested Windows test environment.');
  const branch = git(['branch', '--show-current']).trim();
  const head = git(['rev-parse', 'HEAD']).trim();
  if (branch !== 'codex/runtime-attach-feasibility') throw new Error('Refusing to run outside the requested experiment branch.');
  if (git(['merge-base', BASE_COMMIT, 'HEAD']).trim() !== BASE_COMMIT) throw new Error('Refusing to run because HEAD is not descended from the requested base commit.');
  if (git(['rev-parse', BASE_BRANCH]).trim() !== BASE_COMMIT) throw new Error('The referenced prototype branch no longer resolves to the requested commit.');
  const upstreamPackage = JSON.parse(git(['show', UPSTREAM_TAG_COMMIT + ':package.json']));
  if (upstreamPackage.version !== '0.5.14' || upstreamPackage.main !== 'electron/main.cjs') {
    throw new Error('The official v0.5.14 source reference did not match the expected package contract.');
  }
  const gitStatus = git(['status', '--porcelain', '--untracked-files=all']);
  const isExperimentEvidence = file => /^docs\/verification\/runtime-attach-evidence-\d{8}T\d{6}Z(?:-\d+)?\.jsonl$/.test(file)
    || /^docs\/verification\/assets\/runtime-attach-v0\.5\.14-\d{8}T\d{6}Z(?:-\d+)?\.png$/.test(file);
  const unexpected = findUnexpectedWorkingTreePaths(gitStatus, isExperimentEvidence);
  if (unexpected.length) throw new Error('Unexpected user changes are present; refusing to include or rely on them: ' + unexpected.join(', '));
}

async function run() {
  validateExpectedCheckout();
  const electronExe = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  const hlsPackage = path.join(REPO, 'node_modules', 'hls.js');
  if (!fs.existsSync(electronExe) || !fs.existsSync(hlsPackage)) throw new Error('Existing local Electron/hls.js dependencies are missing; no installation will be performed.');
  const electronPackage = JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', 'electron', 'package.json'), 'utf8'));
  if (!/^38\./.test(electronPackage.version)) throw new Error('The existing Electron runtime is outside the v0.5.14 major version.');
  const sharedHlsFiles = ['dist/hls.min.js', 'package.json'];
  const sharedHlsHashesBefore = Object.fromEntries(sharedHlsFiles.map(file => [file, hashFile(path.join(hlsPackage, file))]));

  const verificationDirectory = path.join(REPO, 'docs', 'verification');
  const assetDirectory = path.join(verificationDirectory, 'assets');
  fs.mkdirSync(assetDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const logPath = chooseArtifact(path.join(verificationDirectory, 'runtime-attach-evidence-' + stamp + '.jsonl'));
  const screenshotPath = chooseArtifact(path.join(assetDirectory, 'runtime-attach-v0.5.14-' + stamp + '.png'));
  appendLog(logPath, 'preflight', {
    branch: 'codex/runtime-attach-feasibility',
    baseCommit: BASE_COMMIT,
    upstreamSource: 'dinoforge/anime-player v0.5.14',
    upstreamCommit: UPSTREAM_TAG_COMMIT,
    electronRuntime: electronPackage.version,
    npmInstallPerformed: false,
    installerUsed: false,
    computerUseUsed: false,
    remoteDebuggingPort: false
  });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const sourceRoot = path.join(tempRoot, 'source');
  const profileRoot = path.join(tempRoot, 'profile');
  const runtimeTemp = path.join(tempRoot, 'runtime-temp');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(profileRoot, { recursive: true });
  fs.mkdirSync(path.join(profileRoot, 'appdata', 'roaming'), { recursive: true });
  fs.mkdirSync(path.join(profileRoot, 'appdata', 'local'), { recursive: true });
  fs.mkdirSync(runtimeTemp, { recursive: true });
  const tempReal = fs.realpathSync(tempRoot);
  const osTempReal = fs.realpathSync(os.tmpdir());
  if (path.dirname(tempReal).toLowerCase() !== osTempReal.toLowerCase() || !path.basename(tempReal).startsWith(TEMP_PREFIX)) {
    throw new Error('The unique temporary root did not resolve inside the system temp directory.');
  }

  let electronChild;
  let exited = false;
  let result = null;
  let cleanupComplete = false;
  try {
    await extractGitArchive(sourceRoot);
    const originalManifest = collectFiles(sourceRoot);
    const originalMainPath = path.join(sourceRoot, 'electron', 'main.cjs');
    const originalMainHash = hashFile(originalMainPath);
    const originalIndexHash = hashFile(path.join(sourceRoot, 'src', 'index.html'));
    const originalPreloadHash = hashFile(path.join(sourceRoot, 'electron', 'preload.cjs'));
    const appAsarPresent = fs.existsSync(path.join(sourceRoot, 'resources', 'app.asar')) || fs.existsSync(path.join(sourceRoot, 'app.asar'));

    const mainSource = fs.readFileSync(originalMainPath, 'utf8');
    const electronImport = "const { app, BrowserWindow, ipcMain, dialog, shell, session, net, Tray, Menu, screen, nativeImage } = require('electron');";
    const modelId = "app.setAppUserModelId('com.lilac.anime.desktop');";
    const loadHtml = "  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));";
    if ([electronImport, modelId, loadHtml].some(pattern => mainSource.split(pattern).length !== 2)) {
      throw new Error('The v0.5.14 source no longer matches the isolated test-hook insertion points.');
    }
    let instrumented = mainSource.replace(electronImport, electronImport + "\nconst runtimeAttachProbe = require(process.env.LILAC_RUNTIME_ATTACH_HOOK);\nruntimeAttachProbe.configure({ app, session, net });");
    instrumented = instrumented.replace(modelId, "app.setAppUserModelId('com.lilac.anime.runtime-attach-test');");
    instrumented = instrumented.replace(loadHtml, "  runtimeAttachProbe.attachWindow(win);\n" + loadHtml);
    fs.writeFileSync(originalMainPath, instrumented, 'utf8');
    const patchedMainHash = hashFile(originalMainPath);

    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(sourceRoot, 'node_modules'), 'junction');
    const initialProfile = snapshotDirectory(profileRoot);
    if (initialProfile.files !== 0) throw new Error('The isolated test profile was not empty before launch.');

    appendLog(logPath, 'isolated-copy-ready', {
      source: 'git archive of official v0.5.14 commit',
      sourceFiles: Object.keys(originalManifest).length,
      originalMainSha256: originalMainHash,
      instrumentedMainSha256: patchedMainHash,
      indexHtmlSha256BeforeAfter: originalIndexHash,
      preloadSha256BeforeAfter: originalPreloadHash,
      appAsarPresentInSourceArchive: appAsarPresent,
      profileInitiallyEmpty: true,
      pathsConfinedToUniqueSystemTempDirectory: true,
      sourceInstrumentation: ['electron/main.cjs only; temporary copy only'],
      localDependencies: 'temporary node_modules junction to existing project dependencies; no installation',
      testHookOutsideSourceArchive: true
    });

    const environment = createIsolatedEnvironment({
      electronExecutable: electronExe,
      nodeExecutable: process.execPath,
      tempRoot,
      profileRoot,
      sourceRoot,
      repoRoot: REPO,
      hookPath: path.join(__dirname, 'runtime-attach-fixture', 'host-hook.cjs'),
      agentPath: path.join(__dirname, 'runtime-attach-fixture', 'agent.cjs'),
      catalogPath: path.join(REPO, 'companion', 'core', 'catalog.cjs'),
      logPath,
      screenshotPath,
      screenshotRelative: path.relative(REPO, screenshotPath).split(path.sep).join('/')
    });
    appendLog(logPath, 'child-environment-isolated', {
      parentEnvironmentCopied: false,
      allowlistedKeys: Object.keys(environment).sort(),
      startupInjectionVariablesPresent: false,
      apiKeysAndUnrelatedSecretsInherited: false,
      appDataAndTemporaryPathsConfinedToTestRoot: true,
      runtimeTempPath: runtimeTemp
    });

    electronChild = spawn(electronExe, [sourceRoot], {
      cwd: sourceRoot,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    appendLog(logPath, 'isolated-electron-child-started', { pid: electronChild.pid || null, executable: electronExe, temporaryAppOnly: true });
    let recentOutput = '';
    electronChild.stdout.setEncoding('utf8');
    electronChild.stderr.setEncoding('utf8');
    electronChild.stdout.on('data', chunk => { recentOutput = (recentOutput + chunk).slice(-5000); });
    electronChild.stderr.on('data', chunk => { recentOutput = (recentOutput + chunk).slice(-5000); });
    result = await waitForExit(electronChild, 120000, details => appendLog(logPath, 'electron-test-timeout', {
      temporaryAppOnly: true,
      ...details
    }));
    exited = !result.stillRunning;
    if (result.stillRunning) {
      appendLog(logPath, 'electron-process-still-running', { pid: electronChild.pid || null, temporarySourceRetained: true });
      throw new Error('The isolated Electron process did not exit after bounded termination requests; its temporary tree was retained.');
    }
    const executionLog = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const probeResult = executionLog.findLast(entry => entry.event === 'result');
    if (result.timedOut || result.code !== 0 || !probeResult || probeResult.status !== 'passed') {
      appendLog(logPath, 'electron-process-exit', { code: result.code, signal: result.signal, timedOut: result.timedOut, result: probeResult || null });
      throw new Error('Runtime attach experiment did not pass. Electron exit=' + result.code + ', details=' + (probeResult && probeResult.message || recentOutput.slice(-1000)));
    }

    const afterManifest = collectFiles(sourceRoot);
    const allNames = [...new Set([...Object.keys(originalManifest), ...Object.keys(afterManifest)])].sort();
    const sourceChanges = allNames.filter(file => originalManifest[file] !== afterManifest[file]);
    const unexpectedSourceChanges = sourceChanges.filter(file => file !== 'electron/main.cjs');
    const finalMainHash = hashFile(originalMainPath);
    const finalIndexHash = hashFile(path.join(sourceRoot, 'src', 'index.html'));
    const finalPreloadHash = hashFile(path.join(sourceRoot, 'electron', 'preload.cjs'));
    const sharedHlsHashesAfter = Object.fromEntries(sharedHlsFiles.map(file => [file, hashFile(path.join(hlsPackage, file))]));
    const finalProfile = snapshotDirectory(profileRoot);
    if (unexpectedSourceChanges.length || sourceChanges.length !== 1 || finalMainHash !== patchedMainHash || finalIndexHash !== originalIndexHash || finalPreloadHash !== originalPreloadHash) {
      throw new Error('The v0.5.14 temporary source copy changed outside the single disclosed test-hook insertion.');
    }
    if (JSON.stringify(sharedHlsHashesAfter) !== JSON.stringify(sharedHlsHashesBefore)) throw new Error('The shared hls.js dependency changed during the experiment.');
    if (!fs.existsSync(screenshotPath)) throw new Error('The renderer evidence screenshot was not written.');

    appendLog(logPath, 'isolation-integrity', {
      sourceFilesBefore: Object.keys(originalManifest).length,
      sourceFilesAfter: Object.keys(afterManifest).length,
      changedSourcePaths: sourceChanges,
      unexpectedSourceChanges,
      testCopyMainOriginalSha256: originalMainHash,
      testCopyMainAfterSha256: finalMainHash,
      testCopyIndexSha256Unchanged: finalIndexHash === originalIndexHash,
      testCopyPreloadSha256Unchanged: finalPreloadHash === originalPreloadHash,
      sharedHlsDependencyHashesUnchanged: sharedHlsHashesAfter,
      appAsarPresentInSourceArchive: appAsarPresent,
      installedDDriveCopyTouched: false,
      existingUserProfileAccessed: false,
      temporaryProfileOnly: true,
      temporaryProfileFilesCreated: finalProfile.files,
      profileFileNamesAndSha256: finalProfile.entries
    });

    const cleanup = cleanupOwnedTempTree(tempRoot, sourceRoot, osTempReal);
    cleanupComplete = true;
    appendLog(logPath, 'temporary-test-copy-cleanup', cleanup);
    console.log(JSON.stringify({ passed: true, log: path.relative(REPO, logPath), screenshot: path.relative(REPO, screenshotPath), cleanupComplete }));
  } catch (error) {
    if (electronChild && !exited && electronChild.pid && electronChild.exitCode === null && electronChild.signalCode === null) {
      appendLog(logPath, 'cleanup-deferred', {
        reason: 'Electron process remains active after bounded termination requests; temporary files are retained to avoid racing a live process.',
        pid: electronChild.pid,
        terminationAttemptsMade: Boolean(result && result.timedOut),
        target: 'harness-spawned-electron-child-only'
      });
    } else if (fs.existsSync(tempRoot)) {
      try {
        const cleanup = cleanupOwnedTempTree(tempRoot, sourceRoot, osTempReal);
        cleanupComplete = true;
        appendLog(logPath, 'temporary-test-copy-cleanup', { ...cleanup, afterFailure: true });
      } catch (cleanupError) {
        appendLog(logPath, 'temporary-test-copy-cleanup-refused', { message: String(cleanupError && cleanupError.message || cleanupError).slice(0, 500) });
      }
    }
    if (fs.existsSync(logPath)) appendLog(logPath, 'runner-error', { message: String(error && error.message || error).slice(0, 1000), cleanupComplete });
    throw error;
  }
}

if (!process.argv.includes('--run')) {
  console.log('No app was launched. Run the pinned isolated experiment with: node tests/runtime-attach-feasibility.cjs --run');
} else {
  run().catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}
