# Build a reproducible PREVIEW archive locally. No GitHub Actions minutes.
# Does not patch or modify any installed LilacAnime files.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
  throw 'This script must run in Windows PowerShell or PowerShell 7 on Windows.'
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $root
try {
  $head = (& git rev-parse --short=12 HEAD)
  if ($LASTEXITCODE -ne 0 -or -not $head) { throw 'Git checkout is required for a traceable build.' }
  $head = $head.Trim()
  $dirty = (& git status --porcelain --untracked-files=normal)
  if ($LASTEXITCODE -ne 0 -or $dirty) {
    throw 'Checkout contains uncommitted changes. Commit or stash before packaging.'
  }

  Write-Host '[1/4] Node regression checks and Rust CLI tests'
  & node (Join-Path $root 'scripts/dino-release-preflight.cjs') --rust
  if ($LASTEXITCODE -ne 0) { throw 'DinoPatch preflight failed. No EXE was packaged.' }

  Write-Host '[2/4] Compile native Windows GUI (no console)'
  $crate = Join-Path $root 'tools/dino-patch-manager/native-rust'
  Push-Location $crate
  try {
    & cargo build --release --features gui
    if ($LASTEXITCODE -ne 0) { throw 'Native Windows GUI compile failed.' }
  } finally {
    Pop-Location
  }
  $binary = Join-Path $crate 'target/release/dino-native-manager.exe'
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Windows EXE was not produced.' }

  Write-Host '[3/4] Inspect PE subsystem for hidden CMD window'
  $bytes = [System.IO.File]::ReadAllBytes($binary)
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    throw 'Not a valid MZ/PE executable.'
  }
  $peOffset = [BitConverter]::ToInt32($bytes,0x3c)
  if ($peOffset -lt 64 -or $peOffset + 96 -ge $bytes.Length) {
    throw 'Invalid Windows PE header.'
  }
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset+1] -ne 0x45) {
    throw 'Invalid PE signature.'
  }
  $subsystem = [BitConverter]::ToUInt16($bytes,$peOffset+24+68)
  if ($subsystem -ne 2) { throw "The executable uses Windows subsystem $subsystem, not GUI = 2." }

  Write-Host '[4/4] Package Beta 8 PREVIEW candidate (never an official release)'
  $output = Join-Path $root 'dist-dino-beta8-preview'
  New-Item -ItemType Directory -Force -Path $output | Out-Null
  $zip = Join-Path $output ("DinoPatch-Beta8-PREVIEW-Windows-x64-" + $head + ".zip")
  if (Test-Path -LiteralPath $zip) { throw 'Refusing to overwrite an existing preview ZIP.' }
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('dino-beta8-preview-' + [Guid]::NewGuid().ToString('N'))
  $stage = Join-Path $temp 'DinoPatchManager'
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  try {
    $exe = Join-Path $stage 'LilacAnime-DinoPatch-Rust.exe'
    Copy-Item -LiteralPath $binary -Destination $exe
    Copy-Item -LiteralPath (Join-Path $root 'docs/releases/DINO_BETA8_PREVIEW.md') -Destination (Join-Path $stage 'README.md')
    $exeSha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
    $manifestSha = (Get-FileHash -LiteralPath (Join-Path $root 'patches/patch03/manifest.json') -Algorithm SHA256).Hash
    $receipt = [ordered]@{
      release = 'Beta 8 PREVIEW - unverified'
      gitCommit = $head
      originalAppBundled = $false
      executableSha256 = $exeSha
      embeddedManifestSha256 = $manifestSha
      windowsGuiSubsystem = 2
    }
    $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'package-info.json') -Encoding utf8
    "$exeSha  LilacAnime-DinoPatch-Rust.exe" | Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Encoding utf8
    Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
    Write-Host ("PREVIEW ZIP: " + $zip)
    Write-Host ("ZIP SHA-256: " + (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash)
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
  }
} finally {
  Pop-Location
}
