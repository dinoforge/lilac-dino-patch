[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$BuildName = "independent-repro",
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PythonExe,
    [string]$NodeExe = "",
    [string]$NpmExe = "",
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

function Resolve-ExecutablePath([string]$Value, [string]$CommandName) {
    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw "실행 파일을 찾을 수 없습니다: $Value" }
        return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Value).Path)
    }
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command -or -not (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
        throw "필요한 도구를 찾을 수 없습니다: $CommandName"
    }
    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $command.Source).Path)
}

function Get-RelativePathCompat([string]$Parent, [string]$Candidate) {
    $parentFull = [System.IO.Path]::GetFullPath($Parent)
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    $separators = [char[]]@([char]92, [char]47)
    if ([string]::Equals($parentFull.TrimEnd($separators), $candidateFull.TrimEnd($separators), [StringComparison]::OrdinalIgnoreCase)) {
        return "."
    }
    $parentRoot = [System.IO.Path]::GetPathRoot($parentFull)
    $parentBase = $parentFull.TrimEnd($separators)
    if ($parentBase.Length -lt $parentRoot.TrimEnd($separators).Length) { $parentBase = $parentRoot.TrimEnd($separators) }
    $parentUriText = $parentBase + [System.IO.Path]::DirectorySeparatorChar
    $parentUri = New-Object System.Uri($parentUriText)
    $candidateUri = New-Object System.Uri($candidateFull)
    if ($parentUri.Scheme -ne $candidateUri.Scheme -or $parentUri.Host -ne $candidateUri.Host) {
        return $candidateFull
    }
    $relative = [System.Uri]::UnescapeDataString($parentUri.MakeRelativeUri($candidateUri).ToString())
    return $relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Test-StrictChildPath([string]$Candidate, [string]$Parent) {
    $relative = Get-RelativePathCompat $Parent $Candidate
    return -not [System.IO.Path]::IsPathRooted($relative) -and $relative -ne "." -and $relative -ne ".." -and -not $relative.StartsWith(".." + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function New-ShortBuildStagingRoot {
    $candidates = @([System.IO.Path]::GetTempPath())
    if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
        $candidates += Join-Path $env:SystemRoot "Temp"
    }
    foreach ($candidateRoot in ($candidates | Select-Object -Unique | Sort-Object { $_.Length })) {
        if (-not (Test-Path -LiteralPath $candidateRoot -PathType Container)) { continue }
        try {
            $resolvedParent = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $candidateRoot).Path)
            if (-not [System.IO.Path]::IsPathRooted($resolvedParent) -or $resolvedParent -match '^\\\\') { continue }
            $parentItem = Get-Item -LiteralPath $resolvedParent -Force -ErrorAction Stop
            if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            $candidate = Join-Path $resolvedParent ("DPM-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
            if (Test-Path -LiteralPath $candidate) { continue }
            New-Item -ItemType Directory -Path $candidate -ErrorAction Stop | Out-Null
            $resolved = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $candidate).Path)
            if (-not (Test-StrictChildPath $resolved $resolvedParent)) { throw "빌드 staging 경로가 선택된 임시 폴더 밖으로 나왔습니다." }
            $stagingItem = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
            if (($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "새 빌드 staging이 재분석 지점으로 바뀌었습니다." }
            return [pscustomobject]@{ Path = $resolved; Parent = $resolvedParent }
        } catch {
            continue
        }
    }
    throw "쓰기 가능한 짧은 OS 임시 경로를 만들 수 없습니다. 빌드를 시작하지 않았습니다."
}

function Set-EnvironmentValue([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) {
        Remove-Item -LiteralPath ("Env:" + $Name) -ErrorAction SilentlyContinue
    } else {
        Set-Item -LiteralPath ("Env:" + $Name) -Value $Value
    }
}

function Invoke-PythonJsonProbe([string]$PythonPath, [string]$Code, [string]$Arguments) {
    $tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $probePath = Join-Path $tempParent ("dpm-build-python-" + [Guid]::NewGuid().ToString("N") + ".py")
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
        [System.IO.File]::WriteAllText($probePath, $Code, $encoding)
        $ErrorActionPreference = "Continue"
        $output = @(& $PythonPath $probePath $Arguments 2>&1)
        $exitCode = $LASTEXITCODE
        return [pscustomobject]@{ ExitCode = [int]$exitCode; Text = ($output | Out-String).Trim() }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if (Test-Path -LiteralPath $probePath -PathType Leaf) {
            $resolvedProbe = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $probePath).Path)
            if (-not (Test-StrictChildPath $resolvedProbe $tempParent)) { throw "임시 Python 검사 파일 경로를 확인할 수 없어 삭제를 거부했습니다: $resolvedProbe" }
            Remove-Item -LiteralPath $resolvedProbe -Force -ErrorAction Stop
        }
    }
}

function Invoke-EngineInfo([string]$Executable, [string]$WorkingDirectory, [string]$NodePath) {
    $probe = @'
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.argv[1], [], {
  cwd: process.argv[2],
  input: JSON.stringify({ operation: 'info' }),
  encoding: 'utf8',
  timeout: 20000,
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`engine exited ${result.status}: ${(result.stdout || '') + (result.stderr || '')}`);
const lines = (result.stdout || '').trim().split(/\r?\n/);
const message = JSON.parse(lines.at(-1));
if (message.type !== 'result' || !message.result || !message.result.managerVersion || !message.result.officialCommit) {
  throw new Error(`invalid info response: ${result.stdout || ''}`);
}
process.stdout.write(JSON.stringify(message.result) + '\n');
'@
    $result = & $NodePath -e $probe $Executable $WorkingDirectory 2>&1
    if ($LASTEXITCODE -ne 0) { throw "번들 엔진 info 검사에 실패했습니다: $($result | Out-String)" }
    return (($result | Out-String).Trim() | ConvertFrom-Json)
}

$managerSource = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $PSScriptRoot).Path)
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $managerSource "..\.."))
$managerRelative = Get-RelativePathCompat $projectRoot $managerSource
if ([System.IO.Path]::IsPathRooted($managerRelative) -or $managerRelative -eq ".." -or $managerRelative.StartsWith(".." + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "관리자 원본이 프로젝트 루트 아래에 있지 않습니다. 빌드를 시작하지 않았습니다."
}

$toolchainPath = Join-Path $managerSource "build-toolchain.json"
$requirementsPath = Join-Path $managerSource "requirements-build.txt"
$electronSource = Join-Path $managerSource "electron-app"
$bridgeSource = Join-Path $managerSource "manager_bridge.py"
$coreSource = Join-Path $managerSource "manager_core.py"
$manifestSource = Join-Path $projectRoot "patches\patch03\manifest.json"
$managerPackagePath = Join-Path $electronSource "package.json"
$managerLockPath = Join-Path $electronSource "package-lock.json"
foreach ($required in @($toolchainPath, $requirementsPath, $managerPackagePath, $managerLockPath, $bridgeSource, $coreSource, $manifestSource)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "필수 빌드 입력이 없습니다: $required" }
}

$toolchain = Get-Content -LiteralPath $toolchainPath -Raw | ConvertFrom-Json
$appPackage = Get-Content -LiteralPath $managerPackagePath -Raw | ConvertFrom-Json
if ($appPackage.packageManager -ne "npm@$($toolchain.npm)" -or $appPackage.engines.node -ne $toolchain.node) { throw "manager package.json과 build-toolchain.json의 Node/npm 버전이 일치하지 않습니다." }
if ($appPackage.dependencies.'classic-level' -ne $toolchain.classicLevel -or $appPackage.devDependencies.electron -ne $toolchain.electron -or $appPackage.devDependencies.'electron-builder' -ne $toolchain.electronBuilder) {
    throw "manager package.json의 빌드 의존성은 고정 도구 체인과 일치해야 합니다."
}

$pythonPath = Resolve-ExecutablePath $PythonExe "python.exe"
$nodePath = Resolve-ExecutablePath $NodeExe "node.exe"
$npmPath = Resolve-ExecutablePath $NpmExe "npm.cmd"
$pythonVersion = (& $pythonPath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $pythonVersion -ne "Python $($toolchain.python)") { throw "Python 버전이 잠금값과 다릅니다. expected=$($toolchain.python), actual=$pythonVersion" }
$nodeVersion = (& $nodePath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v$($toolchain.node)") { throw "Node.js 버전이 잠금값과 다릅니다. expected=$($toolchain.node), actual=$nodeVersion" }
$npmVersion = (& $npmPath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $npmVersion -ne $toolchain.npm) { throw "npm 버전이 잠금값과 다릅니다. expected=$($toolchain.npm), actual=$npmVersion" }

$pythonPackageNames = @($toolchain.pythonPackages.PSObject.Properties.Name)
$pythonProbe = @'
import importlib.metadata as metadata
import json
import sys

names = sys.argv[1].split(",")
print(json.dumps({"venv": sys.prefix != sys.base_prefix, "versions": {name: metadata.version(name) for name in names}}))
'@
$pythonProbeResult = Invoke-PythonJsonProbe $pythonPath $pythonProbe ($pythonPackageNames -join ",")
if ($pythonProbeResult.ExitCode -ne 0) { throw "Python 빌드 venv를 읽지 못했습니다. requirements-build.txt에 고정된 환경을 지정하세요: $($pythonProbeResult.Text)" }
$pythonEnvironment = ($pythonProbeResult.Text | ConvertFrom-Json)
if (-not $pythonEnvironment.venv) { throw "Python 빌드는 전용 venv에서만 허용됩니다. 시스템 Python을 사용하지 마세요." }
foreach ($packageName in $pythonPackageNames) {
    $expected = [string]$toolchain.pythonPackages.$packageName
    $actual = [string]$pythonEnvironment.versions.$packageName
    if ($actual -ne $expected) { throw "Python 빌드 의존성 버전이 잠금값과 다릅니다: $packageName expected=$expected actual=$actual" }
}

$releaseRoot = Join-Path $managerSource "release"
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $outputRoot = Join-Path $releaseRoot ("DinoPatchManager-Electron-v$($appPackage.version)-$BuildName")
} elseif ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    $outputRoot = [System.IO.Path]::GetFullPath((Join-Path $managerSource $OutputDirectory))
}
if (-not (Test-StrictChildPath $outputRoot $releaseRoot)) { throw "빌드 출력은 이번 checkout의 신규 release 하위 폴더여야 합니다: $outputRoot" }
if (Test-Path -LiteralPath $outputRoot) { throw "기존 산출물 덮어쓰기를 거부했습니다: $outputRoot" }
New-Item -ItemType Directory -Path $releaseRoot -Force -ErrorAction Stop | Out-Null

$buildStaging = New-ShortBuildStagingRoot
$tempRoot = $buildStaging.Path
$tempParent = $buildStaging.Parent
$success = $false
$envNames = @("TEMP", "TMP", "PYINSTALLER_CONFIG_DIR", "ELECTRON_CACHE", "ELECTRON_BUILDER_CACHE", "PYTHONNOUSERSITE", "PYTHONUTF8", "PYTHONIOENCODING", "npm_config_cache", "npm_config_logs_dir", "npm_config_userconfig", "npm_config_globalconfig")
$previousEnvironment = @{}
foreach ($name in $envNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }

try {
    $env:TEMP = $tempRoot
    $env:TMP = $tempRoot
    $env:PYINSTALLER_CONFIG_DIR = Join-Path $tempRoot "cfg"
    $env:ELECTRON_CACHE = Join-Path $tempRoot "electron-cache"
    $env:ELECTRON_BUILDER_CACHE = Join-Path $tempRoot "builder-cache"
    $env:PYTHONNOUSERSITE = "1"
    $env:PYTHONUTF8 = "1"
    $env:PYTHONIOENCODING = "utf-8"
    $npmCache = Join-Path $tempRoot "npm-cache"
    $npmLogs = Join-Path $tempRoot "npm-logs"
    $npmConfig = Join-Path $tempRoot "npmrc"
    $npmGlobalConfig = Join-Path $tempRoot "npm-globalrc"
    New-Item -ItemType Directory -Path $env:PYINSTALLER_CONFIG_DIR,$env:ELECTRON_CACHE,$env:ELECTRON_BUILDER_CACHE,$npmCache,$npmLogs -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath $npmConfig,$npmGlobalConfig -Value "" -Encoding Ascii

    $stageRoot = Join-Path $tempRoot "app"
    $engineDist = Join-Path $tempRoot "dist"
    $engineWork = Join-Path $tempRoot "work"
    $engineSpec = Join-Path $tempRoot "spec"
    New-Item -ItemType Directory -Path $stageRoot,$engineDist,$engineWork,$engineSpec -ErrorAction Stop | Out-Null
    Get-ChildItem -LiteralPath $electronSource -Force | Copy-Item -Destination $stageRoot -Recurse -ErrorAction Stop

    $lockCheck = @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const locked = lock.packages && lock.packages[''];
const expected = { 'classic-level': '3.0.0', electron: '38.8.6', 'electron-builder': '26.15.3' };
if (!locked || lock.lockfileVersion !== 3 || pkg.packageManager !== 'npm@11.11.0' || pkg.engines?.node !== '24.14.1') process.exit(1);
for (const [name, version] of Object.entries(expected)) {
  const wanted = name === 'classic-level' ? pkg.dependencies?.[name] : pkg.devDependencies?.[name];
  const lockedWanted = name === 'classic-level' ? locked.dependencies?.[name] : locked.devDependencies?.[name];
  const installed = lock.packages[`node_modules/${name}`]?.version;
  if (wanted !== version || lockedWanted !== version || installed !== version) process.exit(1);
}
'@
    & $nodePath -e $lockCheck $stageRoot
    if ($LASTEXITCODE -ne 0) { throw "관리자 package.json/package-lock.json이 고정 의존성 목록과 일치하지 않습니다." }

    Push-Location -LiteralPath $stageRoot
    try {
        $installCwd = [System.IO.Path]::GetFullPath((Get-Location).Path)
        if (-not (Test-StrictChildPath $installCwd $tempRoot)) { throw "npm ci 대상이 이번 실행의 Temp staging 밖입니다: $installCwd" }
        & $npmPath ci --include=dev --no-audit --no-fund --cache $npmCache --logs-dir $npmLogs --userconfig $npmConfig --globalconfig $npmGlobalConfig
        if ($LASTEXITCODE -ne 0) { throw "격리 staging의 npm ci가 실패했습니다 (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }

    $electronDist = Join-Path $stageRoot "node_modules\electron\dist"
    foreach ($required in @((Join-Path $electronDist "electron.exe"), (Join-Path $stageRoot "node_modules\electron-builder\package.json"), (Join-Path $stageRoot "node_modules\classic-level\package.json"))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "격리 npm ci 산출물이 불완전합니다: $required" }
    }
    $installedElectron = Get-Content -LiteralPath (Join-Path $stageRoot "node_modules\electron\package.json") -Raw | ConvertFrom-Json
    $installedBuilder = Get-Content -LiteralPath (Join-Path $stageRoot "node_modules\electron-builder\package.json") -Raw | ConvertFrom-Json
    if ($installedElectron.version -ne $toolchain.electron -or $installedBuilder.version -ne $toolchain.electronBuilder) { throw "설치된 Electron/electron-builder 버전이 잠금과 다릅니다." }

    $themeFixtureBase = Join-Path $managerSource "test-artifacts"
    if (-not (Test-Path -LiteralPath $themeFixtureBase -PathType Container)) {
        New-Item -ItemType Directory -Path $themeFixtureBase -ErrorAction Stop | Out-Null
    }
    $themeFixtureBase = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $themeFixtureBase).Path)
    if (-not (Test-StrictChildPath $themeFixtureBase $managerSource)) { throw "테마 검증 fixture 경로가 관리자 소스 밖을 가리킵니다: $themeFixtureBase" }
    $themeFixtureBaseItem = Get-Item -LiteralPath $themeFixtureBase -Force -ErrorAction Stop
    if (($themeFixtureBaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "테마 검증 fixture 경로가 재분석 지점입니다: $themeFixtureBase" }
    $themeFixtureRoot = Join-Path $themeFixtureBase ("independent-build-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $themeFixtureRoot -ErrorAction Stop | Out-Null
    & $nodePath (Join-Path $managerSource "tests\theme-leveldb-electron.integration.cjs") (Join-Path $stageRoot "node_modules") $themeFixtureRoot
    if ($LASTEXITCODE -ne 0) { throw "격리 Chromium LevelDB 테마 검증이 실패했습니다 (exit $LASTEXITCODE)." }

    $pyArgs = @(
        "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--console",
        "--name", "DinoPatchManagerEngine",
        "--distpath", $engineDist,
        "--workpath", $engineWork,
        "--specpath", $engineSpec,
        "--paths", $managerSource,
        "--add-data", ((Join-Path $projectRoot "patches\patch03\manifest.json") + ";patches\patch03"),
        "--add-data", ((Join-Path $projectRoot "src\integrated-search.js") + ";src"),
        "--add-data", ((Join-Path $projectRoot "src\integrated-search.css") + ";src"),
        "--add-data", ((Join-Path $projectRoot "patches\patch03\patch03-bridge.js") + ";patches\patch03"),
        "--add-data", ((Join-Path $projectRoot "scripts\validate-patch03-clean-source.cjs") + ";scripts"),
        "--add-data", ((Join-Path $projectRoot "tests\patch03-clean-source.contract.test.cjs") + ";tests"),
        $bridgeSource
    )
    & $pythonPath @pyArgs
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE). Build staging retained at $tempRoot" }

    $engineRoot = Join-Path $engineDist "DinoPatchManagerEngine"
    $engineExe = Join-Path $engineRoot "DinoPatchManagerEngine.exe"
    $engineInternal = Join-Path $engineRoot "_internal"
    foreach ($required in @($engineExe, (Join-Path $engineInternal "patches\patch03\manifest.json"), (Join-Path $engineInternal "src\integrated-search.js"), (Join-Path $engineInternal "src\integrated-search.css"), (Join-Path $engineInternal "patches\patch03\patch03-bridge.js"), (Join-Path $engineInternal "scripts\validate-patch03-clean-source.cjs"), (Join-Path $engineInternal "tests\patch03-clean-source.contract.test.cjs"))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "PyInstaller 결과에서 필수 번들 파일이 없습니다: $required" }
    }
    $prePackageInfo = Invoke-EngineInfo $engineExe $engineRoot $nodePath
    if ($prePackageInfo.managerVersion -ne (Select-String -LiteralPath $coreSource -Pattern '(?m)^MANAGER_VERSION\s*=\s*"([0-9.]+)"' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1)) {
        throw "PyInstaller 엔진 info 결과의 관리자 버전이 소스와 다릅니다."
    }
    Write-Output ("Bundled engine info: " + ($prePackageInfo | ConvertTo-Json -Compress))

    $buildScript = Join-Path $managerSource "build-electron.cjs"
    $buildArgs = @($buildScript, $managerSource, $projectRoot, $stageRoot, $engineRoot, $nodePath, $outputRoot, $electronDist, $tempRoot)
    & $nodePath @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "Electron-builder packaging failed (exit $LASTEXITCODE). Build staging retained at $tempRoot" }

    $appRoot = Join-Path $outputRoot "win-unpacked"
    $appEngineRoot = Join-Path $appRoot "resources\manager-engine"
    $appEngineExe = Join-Path $appEngineRoot "DinoPatchManagerEngine.exe"
    $appManifest = Join-Path $appEngineRoot "_internal\patches\patch03\manifest.json"
    foreach ($required in @((Join-Path $appRoot "디노패치관리자.exe"), (Join-Path $appRoot "resources\app.asar"), $appEngineExe, $appManifest)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Electron 패키지에서 필수 파일이 없습니다: $required" }
    }
    $packagedInfo = Invoke-EngineInfo $appEngineExe $appEngineRoot $nodePath
    if ($packagedInfo.managerVersion -ne $prePackageInfo.managerVersion -or $packagedInfo.officialCommit -ne $prePackageInfo.officialCommit) {
        throw "Electron에 복사된 번들 엔진 info 결과가 PyInstaller 엔진과 다릅니다."
    }
    Write-Output ("Packaged engine info: " + ($packagedInfo | ConvertTo-Json -Compress))
    Write-Output ("Manager package: " + $appRoot)
    $success = $true
} finally {
    foreach ($name in $envNames) { Set-EnvironmentValue $name $previousEnvironment[$name] }
    if ($success) {
        $resolvedTemp = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $tempRoot).Path)
        $resolvedParent = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $tempParent).Path)
        $parentItem = Get-Item -LiteralPath $resolvedParent -Force -ErrorAction Stop
        $stagingItem = Get-Item -LiteralPath $resolvedTemp -Force -ErrorAction Stop
        if ((-not [string]::Equals($resolvedParent, $tempParent, [StringComparison]::OrdinalIgnoreCase)) -or
            (-not (Test-StrictChildPath $resolvedTemp $resolvedParent)) -or
            (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
            (($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "임시 staging 정리 경로 검증에 실패해 자동 삭제를 중단했습니다: $resolvedTemp"
        }
        try {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Warning "패키지는 검증됐지만 임시 staging 정리에 실패했습니다. 진단용으로 보존합니다: $resolvedTemp ($($_.Exception.Message))"
        }
    } else {
        Write-Warning "실패 산출물과 진단 자료를 보존했습니다: $tempRoot"
    }
}
