'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('DinoLilacPatch portable packaging is Windows-only.');

const repoRoot = path.resolve(__dirname, '..');
const tempParent = fs.realpathSync(os.tmpdir());
const stageRoot = path.join(tempParent, `dino-lilac-patch-build-${crypto.randomUUID()}`);
const outputRoot = path.join(repoRoot, 'dist', 'dino-lilac-patch-issue5');
const electronBuilderCli = path.join(repoRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const electronPackage = require(path.join(repoRoot, 'node_modules', 'electron', 'package.json'));
const electronDist = path.join(repoRoot, 'node_modules', 'electron', 'dist');

const packagedFiles = [
  'dino-lilac-patch/compatibility.cjs',
  'dino-lilac-patch/isolated-target.cjs',
  'dino-lilac-patch/manager-core.cjs',
  'dino-lilac-patch/settings.cjs',
  'dino-lilac-patch/manager/index.html',
  'dino-lilac-patch/manager/main.cjs',
  'dino-lilac-patch/manager/manager.css',
  'dino-lilac-patch/manager/preload.cjs',
  'dino-lilac-patch/manager/renderer.js',
  'patch-manager/adapters/lilacanime-independent.cjs',
  'patch-manager/adapters/lilacanime-v0.5.14.cjs',
  'patch-manager/core.cjs',
  'patch-manager/persistent.cjs',
  'patch-manager/staging.cjs',
  'src/patch-manager-feature-flags.js',
  'src/patch-manager-stage2.js',
  'src/patch-manager-stage2-core.js',
  'src/weekday-schedule.js',
  'src/integrated-search.js',
  'src/manual-subtitle-translation.js',
  'src/unified-catalog.js',
  'src/unified-catalog.css',
  'electron/patch-manager-stage2.cjs',
  'electron/quarter-catalog.cjs',
  'electron/anilist-client.cjs',
  'electron/weekday-episodes.cjs',
  'electron/embedded-chatgpt-web.cjs',
  'electron/chatgpt-web-ui-driver.cjs',
  'electron/manual-translation-session.cjs',
  'electron/patch-manager-stage2-prompts.cjs',
  'docs/prompts/영어 번역 프롬프트.txt',
  'docs/prompts/일본어 번역 프롬프트.txt',
  'docs/prompts/Reazon_작품용_단어사전_예시.txt'
];

function copyRegularFile(relative) {
  const source = path.join(repoRoot, ...relative.split('/'));
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular package input: ${relative}`);
  const destination = path.join(stageRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function assertOwnedTempRoot(candidate) {
  const real = fs.realpathSync(candidate);
  const relative = path.relative(tempParent, real);
  const stat = fs.lstatSync(real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || stat.isSymbolicLink() ||
      !path.basename(real).startsWith('dino-lilac-patch-build-')) {
    throw new Error('Refusing to clean an unexpected DinoLilacPatch build staging path.');
  }
  return real;
}

if (!fs.existsSync(electronBuilderCli)) throw new Error('The repository electron-builder runtime is not installed.');
if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) throw new Error('The installed Windows Electron runtime is missing.');
if (fs.existsSync(outputRoot)) throw new Error('The DinoLilacPatch issue-5 output folder already exists; preserving the existing artifact.');

fs.mkdirSync(stageRoot, { recursive: false });
try {
  for (const relative of packagedFiles) copyRegularFile(relative);

  const appPackage = {
    name: 'dino-lilac-patch',
    version: '0.1.0',
    productName: 'DinoLilacPatch',
    description: 'Standalone isolated-copy patch manager for LilacAnime',
    main: 'dino-lilac-patch/manager/main.cjs',
    license: 'MIT'
  };
  fs.writeFileSync(path.join(stageRoot, 'package.json'), `${JSON.stringify(appPackage, null, 2)}\n`, { flag: 'wx' });

  const configPath = path.join(stageRoot, 'electron-builder.config.json');
  const config = {
    appId: 'com.dinolilac.patch.manager',
    productName: 'DinoLilacPatch',
    electronVersion: electronPackage.version,
    electronDist,
    asar: true,
    npmRebuild: false,
    forceCodeSigning: false,
    directories: { output: outputRoot },
    files: ['**/*', '!electron-builder.config.json', '!package-lock.json'],
    win: {
      target: [{ target: 'portable', arch: ['x64'] }],
      executableName: 'DinoLilacPatch',
      artifactName: 'DinoLilacPatch.${ext}'
    },
    portable: { requestExecutionLevel: 'user', useZip: true }
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });

  const result = spawnSync(process.execPath, [electronBuilderCli, '--win', 'portable', '--x64', '--publish', 'never', '--projectDir', stageRoot, '--config', configPath], {
    cwd: stageRoot,
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`electron-builder exited with status ${result.status ?? 'unknown'}.`);

  const executable = path.join(outputRoot, 'DinoLilacPatch.exe');
  const stat = fs.statSync(executable);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  process.stdout.write(`${JSON.stringify({ executable, bytes: stat.size, sha256, electronVersion: electronPackage.version, target: 'windows-x64-portable', adminRequired: false }, null, 2)}\n`);
} finally {
  if (fs.existsSync(stageRoot)) fs.rmSync(assertOwnedTempRoot(stageRoot), { recursive: true, force: true });
}
