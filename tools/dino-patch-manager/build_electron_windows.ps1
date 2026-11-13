param(
    [ValidatePattern('^A\d+-final$')]
    [string]$ReleaseName = "A27-final"
)

$ErrorActionPreference = "Stop"

$managerSource = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $managerSource "..\..")).Path
$expectedRoot = "D:\Codex-Coding-Folder\LilacAnime-Player"
if (-not [string]::Equals($projectRoot.TrimEnd("\"), $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unexpected project root. No install or build was started: $projectRoot"
}

$electronSource = Join-Path $managerSource "electron-app"
$bridgeSource = Join-Path $managerSource "manager_bridge.py"
$coreSource = Join-Path $managerSource "manager_core.py"
$manifestSource = Join-Path $projectRoot "patches\patch03\manifest.json"
$nodeModules = Join-Path $projectRoot "node_modules"
$electronDist = Join-Path $nodeModules "electron\dist"
$builder = Join-Path $nodeModules "electron-builder"
if (-not (Test-Path -LiteralPath $electronSource -PathType Container) -or -not (Test-Path -LiteralPath $bridgeSource -PathType Leaf) -or -not (Test-Path -LiteralPath $coreSource -PathType Leaf) -or -not (Test-Path -LiteralPath $manifestSource -PathType Leaf)) {
    throw "Required Electron UI, engine bridge, manager core or Patch 03 manifest is missing."
}
if (-not (Test-Path -LiteralPath $electronDist -PathType Container) -or -not (Test-Path -LiteralPath $builder -PathType Container)) {
    throw "Existing Electron 38.8.6 and electron-builder packages are required."
}

$electronPackage = Get-Content -LiteralPath (Join-Path $nodeModules "electron\package.json") -Raw | ConvertFrom-Json
$appPackage = Get-Content -LiteralPath (Join-Path $electronSource "package.json") -Raw | ConvertFrom-Json
if ($electronPackage.version -ne $appPackage.devDependencies.electron) { throw "Electron version mismatch: app=$($appPackage.devDependencies.electron), installed=$($electronPackage.version)" }

$pythonExe = "D:\Codex-Coding-Folder\tools\python314-build\Scripts\python.exe"
$pyInstaller = "D:\Codex-Coding-Folder\tools\python314-build\Scripts\pyinstaller.exe"
$nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
$npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf) -or -not (Test-Path -LiteralPath $pyInstaller -PathType Leaf)) {
    throw "The existing portable Python and PyInstaller tools are required. No dependencies were installed."
}
if (-not $nodeCommand -or -not (Test-Path -LiteralPath $nodeCommand.Source -PathType Leaf)) { throw "The existing Node.js runtime was not found." }
if (-not $npmCommand -or -not (Test-Path -LiteralPath $npmCommand.Source -PathType Leaf)) { throw "The existing npm command was not found. No package installation was started." }

$releaseRoot = Join-Path $managerSource "release"
$outputRoot = Join-Path $releaseRoot "DinoPatchManager-Electron-v1.2.4-$ReleaseName"
if (Test-Path -LiteralPath $outputRoot) { throw "Output already exists; refusing to overwrite: $outputRoot" }
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("DinoPatchManager-Electron-Build-" + [Guid]::NewGuid().ToString("N"))
$tempRoot = [System.IO.Path]::GetFullPath($tempRoot)
$osTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $tempRoot.StartsWith($osTemp.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) { throw "Build staging did not resolve beneath OS Temp." }
New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop | Out-Null
$success = $false
$previousNpmCache = $env:npm_config_cache
$previousNpmLogs = $env:npm_config_logs_dir
$previousNpmUserConfig = $env:npm_config_userconfig
$previousNpmGlobalConfig = $env:npm_config_globalconfig
$previousPyInstallerConfig = $env:PYINSTALLER_CONFIG_DIR
try {
    $appStage = Join-Path $tempRoot "app"
    $pyDist = Join-Path $tempRoot "engine-dist"
    $pyWork = Join-Path $tempRoot "pyinstaller-work"
    $pySpec = Join-Path $tempRoot "pyinstaller-spec"
    New-Item -ItemType Directory -Path $appStage,$pyDist,$pyWork,$pySpec -ErrorAction Stop | Out-Null
    Get-ChildItem -LiteralPath $electronSource -Force | Copy-Item -Destination $appStage -Recurse -Force -ErrorAction Stop

    $resolvedStage = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $appStage).Path)
    if (-not $resolvedStage.StartsWith($osTemp.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase) -or $resolvedStage -eq $projectRoot -or $resolvedStage.StartsWith($projectRoot.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "npm installation target is not an isolated OS Temp child: $resolvedStage"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedStage "package-lock.json") -PathType Leaf)) { throw "A locked Electron manager dependency set is required before building." }
    $dependencyLockCheck = @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const lockedRoot = lock.packages && lock.packages[''];
if (!lockedRoot || lockedRoot.name !== pkg.name || lockedRoot.version !== pkg.version
  || !lockedRoot.dependencies || lockedRoot.dependencies['classic-level'] !== '3.0.0'
  || !pkg.dependencies || pkg.dependencies['classic-level'] !== '3.0.0') process.exit(1);
'@
    & $nodeCommand.Source -e $dependencyLockCheck $resolvedStage
    if ($LASTEXITCODE -ne 0) { throw "The staged package manifest and pinned classic-level lock do not match." }
    $npmCache = Join-Path $tempRoot "npm-cache"
    $npmLogs = Join-Path $tempRoot "npm-logs"
    $npmConfig = Join-Path $tempRoot "npmrc"
    $npmGlobalConfig = Join-Path $tempRoot "npm-globalrc"
    New-Item -ItemType Directory -Path $npmCache,$npmLogs -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath $npmConfig,$npmGlobalConfig -Value "" -Encoding ASCII
    $env:npm_config_cache = $npmCache
    $env:npm_config_logs_dir = $npmLogs
    $env:npm_config_userconfig = $npmConfig
    $env:npm_config_globalconfig = $npmGlobalConfig
    Push-Location -LiteralPath $resolvedStage
    try {
        $actualInstallCwd = [System.IO.Path]::GetFullPath((Get-Location).Path)
        if (-not [string]::Equals($actualInstallCwd, $resolvedStage, [StringComparison]::OrdinalIgnoreCase) -or -not $actualInstallCwd.StartsWith($osTemp.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) {
            throw "npm ci refused because the active directory failed its OS Temp guard: $actualInstallCwd"
        }
        & $npmCommand.Source ci --omit=dev --no-audit --no-fund --cache $npmCache --logs-dir $npmLogs --userconfig $npmConfig --globalconfig $npmGlobalConfig
        if ($LASTEXITCODE -ne 0) { throw "Isolated npm ci failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }

    $themeFixtureRoot = Join-Path $managerSource "test-artifacts"
    New-Item -ItemType Directory -Path $themeFixtureRoot -Force -ErrorAction Stop | Out-Null
    & $nodeCommand.Source (Join-Path $managerSource "tests\theme-leveldb-electron.integration.cjs") (Join-Path $resolvedStage "node_modules") $themeFixtureRoot
    if ($LASTEXITCODE -ne 0) { throw "Isolated Chromium LevelDB theme verification failed with exit code $LASTEXITCODE." }

    $env:PYINSTALLER_CONFIG_DIR = Join-Path $tempRoot "pyinstaller-config"
    New-Item -ItemType Directory -Path $env:PYINSTALLER_CONFIG_DIR -ErrorAction Stop | Out-Null
    $pyArgs = @(
        "--noconfirm", "--clean", "--onedir", "--console",
        "--name", "DinoPatchManagerEngine",
        "--distpath", $pyDist,
        "--workpath", $pyWork,
        "--specpath", $pySpec,
        "--paths", $managerSource,
        "--add-data", ($manifestSource + ";patches\patch03"),
        "--add-data", ((Join-Path $projectRoot "src\integrated-search.js") + ";src"),
        "--add-data", ((Join-Path $projectRoot "src\integrated-search.css") + ";src"),
        "--add-data", ((Join-Path $projectRoot "patches\patch03\patch03-bridge.js") + ";patches\patch03"),
        "--add-data", ((Join-Path $projectRoot "scripts\validate-patch03-clean-source.cjs") + ";scripts"),
        "--add-data", ((Join-Path $projectRoot "tests\patch03-clean-source.contract.test.cjs") + ";tests"),
        (Join-Path $managerSource "manager_bridge.py")
    )
    & $pyInstaller @pyArgs
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE. Build staging retained at $tempRoot" }

    $engineDir = Join-Path $pyDist "DinoPatchManagerEngine"
    if (-not (Test-Path -LiteralPath (Join-Path $engineDir "DinoPatchManagerEngine.exe") -PathType Leaf)) { throw "PyInstaller did not produce the manager engine executable." }
    $buildArgs = @(
        (Join-Path $managerSource "build-electron.cjs"),
        $managerSource, $projectRoot, $appStage, $engineDir, $nodeCommand.Source, $outputRoot, $electronDist, $tempRoot
    )
    & $nodeCommand.Source @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "Electron packaging failed with exit code $LASTEXITCODE. Build staging retained at $tempRoot" }
    $success = $true
    Write-Output "Manager EXE: $(Join-Path $outputRoot 'win-unpacked\디노패치관리자.exe')"
    Write-Output "Support files: $(Join-Path $outputRoot 'win-unpacked\resources')"
} finally {
    if ($null -eq $previousPyInstallerConfig) { Remove-Item Env:\PYINSTALLER_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:PYINSTALLER_CONFIG_DIR = $previousPyInstallerConfig }
    if ($null -eq $previousNpmCache) { Remove-Item Env:\npm_config_cache -ErrorAction SilentlyContinue } else { $env:npm_config_cache = $previousNpmCache }
    if ($null -eq $previousNpmLogs) { Remove-Item Env:\npm_config_logs_dir -ErrorAction SilentlyContinue } else { $env:npm_config_logs_dir = $previousNpmLogs }
    if ($null -eq $previousNpmUserConfig) { Remove-Item Env:\npm_config_userconfig -ErrorAction SilentlyContinue } else { $env:npm_config_userconfig = $previousNpmUserConfig }
    if ($null -eq $previousNpmGlobalConfig) { Remove-Item Env:\npm_config_globalconfig -ErrorAction SilentlyContinue } else { $env:npm_config_globalconfig = $previousNpmGlobalConfig }
    if ($success) {
        $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
        if ($resolvedTemp.StartsWith($osTemp.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp -PathType Container)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
