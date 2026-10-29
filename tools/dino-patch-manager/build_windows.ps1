$ErrorActionPreference = "Stop"

$managerSource = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $managerSource "..\..")).Path
$expectedRoot = "D:\Codex-Coding-Folder\LilacAnime-Player"
if (-not [string]::Equals($projectRoot.TrimEnd("\"), $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unexpected project root. No build was started: $projectRoot"
}

$specPath = Join-Path $managerSource "DinoPatchManager.spec"
$managerCorePath = Join-Path $managerSource "manager_core.py"
$manifestPath = Join-Path $projectRoot "patches\patch03\manifest.json"
if (-not (Test-Path -LiteralPath $specPath -PathType Leaf) -or -not (Test-Path -LiteralPath $managerCorePath -PathType Leaf) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Required manager core, spec, or Patch 03 manifest is missing."
}
$versionMatches = [regex]::Matches((Get-Content -LiteralPath $managerCorePath -Raw), '(?m)^\s*MANAGER_VERSION\s*=\s*["''](?<version>\d+\.\d+\.\d+)["'']\s*$')
if ($versionMatches.Count -ne 1) {
    throw "Expected exactly one semantic MANAGER_VERSION in manager_core.py."
}
$managerVersion = $versionMatches[0].Groups['version'].Value

$releaseRoot = Join-Path $managerSource "release"
$outputPath = Join-Path $releaseRoot "DinoPatchManager-v$managerVersion"
if (Test-Path -LiteralPath $outputPath) {
    throw "Output already exists; refusing to overwrite: $outputPath"
}

$pyInstallerCommand = Get-Command "pyinstaller.exe" -ErrorAction SilentlyContinue
if (-not $pyInstallerCommand) {
    $knownTool = "D:\Codex-Coding-Folder\tools\python314-build\Scripts\pyinstaller.exe"
    if (Test-Path -LiteralPath $knownTool -PathType Leaf) {
        $pyInstallerPath = $knownTool
    } else {
        throw "PyInstaller is not installed or not on PATH. This script does not install dependencies."
    }
} else {
    $pyInstallerPath = $pyInstallerCommand.Source
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dino-manager-build-" + [Guid]::NewGuid().ToString("N"))
$workPath = Join-Path $tempRoot "work"
New-Item -ItemType Directory -Path $workPath -Force | Out-Null
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$previousBuildTemp = $env:DINO_MANAGER_BUILD_TEMP
$env:DINO_MANAGER_BUILD_TEMP = $tempRoot

try {
    $arguments = @(
        "--noconfirm", "--distpath", $outputPath, "--workpath", $workPath, $specPath
    )
    & $pyInstallerPath @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE. Build intermediates were kept at $tempRoot"
    }

    $assetRoot = Join-Path $outputPath "DinoPatchManager"
    $executables = @(Get-ChildItem -LiteralPath $assetRoot -File -Filter "*.exe" -ErrorAction SilentlyContinue)
    if ($executables.Count -ne 1) {
        throw "Expected one GUI executable, found $($executables.Count). Build files remain at $outputPath"
    }
    $exePath = $executables[0].FullName
    $manifestFound = Get-ChildItem -LiteralPath $assetRoot -Recurse -File -Filter "manifest.json" |
        Where-Object { $_.FullName -match "patch03[\\/]manifest\.json$" } |
        Select-Object -First 1
    if (-not $manifestFound) {
        throw "The executable is missing its bundled Patch 03 manifest: $assetRoot"
    }
    Write-Output "Manager EXE: $exePath"
    Write-Output "Bundled patch manifest: $($manifestFound.FullName)"
    Write-Output "Build intermediates: $tempRoot"
} catch {
    Write-Error $_
    throw
} finally {
    if ($null -eq $previousBuildTemp) {
        Remove-Item Env:\DINO_MANAGER_BUILD_TEMP -ErrorAction SilentlyContinue
    } else {
        $env:DINO_MANAGER_BUILD_TEMP = $previousBuildTemp
    }
}
