const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function validateBuildPaths({ managerRoot, projectRoot, stageRoot, engineRoot, nodeExe, outputRoot, electronDist, tempRoot }) {
  const manager = fs.realpathSync(managerRoot);
  const project = fs.realpathSync(projectRoot);
  const temp = fs.realpathSync(tempRoot);
  const stage = fs.realpathSync(stageRoot);
  const engine = fs.realpathSync(engineRoot);
  const nodePath = fs.realpathSync(nodeExe);
  const electron = fs.realpathSync(electronDist);
  const output = path.resolve(outputRoot);
  if (!isWithin(manager, project) || manager === project) throw new Error('관리자 소스 경로가 지정 프로젝트 내부가 아닙니다.');
  if (stage === temp || !isWithin(stage, temp) || engine === temp || !isWithin(engine, temp)) throw new Error('빌드 입력은 이번 실행에서 만든 OS Temp 하위 폴더여야 합니다.');
  if (!fs.statSync(stage).isDirectory() || !fs.statSync(engine).isDirectory() || !fs.statSync(nodePath).isFile()) throw new Error('빌드 스테이징 입력이 올바르지 않습니다.');
  if (!fs.existsSync(path.join(stage, 'main.cjs')) || !fs.existsSync(path.join(stage, 'package.json'))) throw new Error('Electron 관리자 소스가 불완전합니다.');
  if (!fs.existsSync(path.join(engine, 'DinoPatchManagerEngine.exe')) || !fs.existsSync(path.join(engine, '_internal'))) throw new Error('PyInstaller 엔진 배포 파일이 불완전합니다.');
  if (!fs.existsSync(path.join(electron, 'electron.exe'))) throw new Error('지정한 Electron 배포 폴더에 electron.exe가 없습니다.');
  const releaseRoot = path.resolve(manager, 'release');
  if (!isWithin(output, releaseRoot) || output === releaseRoot) throw new Error('관리자 산출물은 기존 release 폴더 아래의 신규 경로에만 만들 수 있습니다.');
  if (fs.existsSync(output)) throw new Error(`기존 릴리스 경로를 덮어쓰지 않습니다: ${output}`);
  return { manager, project, stage, engine, nodePath, electron, output };
}

async function build(argv) {
  const [managerRootArg, projectRootArg, stageRootArg, engineRootArg, nodeExeArg, outputRootArg, electronDistArg, tempRootArg] = argv;
  if (argv.length !== 8) throw new Error('빌드 인자가 올바르지 않습니다.');
  const paths = validateBuildPaths({
    managerRoot: managerRootArg,
    projectRoot: projectRootArg,
    stageRoot: stageRootArg,
    engineRoot: engineRootArg,
    nodeExe: nodeExeArg,
    outputRoot: outputRootArg,
    electronDist: electronDistArg,
    tempRoot: tempRootArg,
  });
  const stagedNodeModules = path.join(paths.stage, 'node_modules');
  const electronBuilderPath = path.join(stagedNodeModules, 'electron-builder');
  const electronPackagePath = path.join(stagedNodeModules, 'electron', 'package.json');
  const builderPackagePath = path.join(electronBuilderPath, 'package.json');
  if (!fs.existsSync(electronPackagePath) || !fs.existsSync(builderPackagePath)) {
    throw new Error('격리된 관리자 staging에 Electron/electron-builder가 없어 빌드를 중단했습니다.');
  }
  const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'));
  const builderPackage = JSON.parse(fs.readFileSync(builderPackagePath, 'utf8'));
  const appPackage = JSON.parse(fs.readFileSync(path.join(paths.stage, 'package.json'), 'utf8'));
  if (electronPackage.version !== appPackage.devDependencies.electron) throw new Error('관리자 staging의 Electron 버전이 package.json과 일치하지 않습니다.');
  if (builderPackage.version !== appPackage.devDependencies['electron-builder']) throw new Error('관리자 staging의 electron-builder 버전이 package.json과 일치하지 않습니다.');
  if (path.resolve(paths.electron) !== path.resolve(path.join(stagedNodeModules, 'electron', 'dist'))) throw new Error('Electron runtime은 격리 staging에서 가져와야 합니다.');
  const levelModuleRoot = stagedNodeModules;
  if (!fs.existsSync(path.join(levelModuleRoot, 'classic-level', 'package.json'))) throw new Error('격리 스테이징에 classic-level이 없습니다. 프로젝트 node_modules는 사용하지 않습니다.');
  const nativeFiles = [];
  const collectNativeFiles = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) collectNativeFiles(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.node')) nativeFiles.push(candidate);
    }
  };
  collectNativeFiles(path.join(levelModuleRoot, 'classic-level'));
  if (!nativeFiles.length) throw new Error('classic-level Windows native prebuild가 없어 패키징을 중단했습니다.');
  const { build: buildElectron, Platform, Arch } = require(electronBuilderPath);
  await buildElectron({
    projectDir: paths.stage,
    targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64),
    config: {
      appId: 'com.dino.lilac.patchmanager',
      productName: 'LilacAnime DinoPatch',
      electronVersion: electronPackage.version,
      electronDist: paths.electron,
      directories: { output: paths.output },
      files: ['main.cjs', 'preload.cjs', 'index.html', 'renderer.js', 'manager.css', 'theme-leveldb.cjs', 'windows-path.cjs', 'package.json'],
      extraResources: [
        { from: paths.engine, to: 'manager-engine' },
        { from: paths.nodePath, to: 'manager-node/node.exe' },
        { from: levelModuleRoot, to: 'manager-node/node_modules' },
      ],
      asar: true,
      npmRebuild: false,
      win: { target: ['dir'], executableName: 'LilacAnime-DinoPatch' },
    },
  });
  const appOut = path.join(paths.output, 'win-unpacked');
  const executable = path.join(appOut, 'LilacAnime-DinoPatch.exe');
  for (const required of [executable, path.join(appOut, 'resources', 'manager-engine', 'DinoPatchManagerEngine.exe'), path.join(appOut, 'resources', 'manager-engine', '_internal', 'patches', 'patch03', 'manifest.json'), path.join(appOut, 'resources', 'manager-node', 'node.exe'), path.join(appOut, 'resources', 'manager-node', 'node_modules', 'classic-level', 'package.json'), path.join(appOut, 'resources', 'app.asar')]) {
    if (!fs.existsSync(required)) throw new Error(`빌드 산출물 검증 실패: ${required}`);
  }
  process.stdout.write(`${JSON.stringify({ status: 'PASS', executable, output: appOut })}\n`);
}

if (require.main === module) {
  build(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { isWithin, validateBuildPaths };
