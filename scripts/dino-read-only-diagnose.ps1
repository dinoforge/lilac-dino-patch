# DinoPatch Beta 8: read-only state/ASAR diagnostic.
# Does not edit, rename, delete, restore, or patch any files.
param(
  [Parameter(Mandatory=$true)]
  [ValidateNotNullOrEmpty()]
  [string]$InstalledRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Normalize-Root([string]$value) {
  $v = $value.Trim()
  if ($v.StartsWith('\\?\')) { $v = $v.Substring(4) }
  return $v.Replace('/','\').TrimEnd([char]92,[char]47).ToLowerInvariant()
}
function Same-Hash([string]$one,[string]$two) {
  return $one.Length -eq 64 -and $two.Length -eq 64 -and
    [string]::Equals($one,$two,[System.StringComparison]::OrdinalIgnoreCase)
}
function Inspect-Hash([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return '' }
  $meta = Get-Item -LiteralPath $file -ErrorAction Stop
  if (($meta.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to hash a reparse-point file: $file"
  }
  return [string](Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
}

function Record-String($record, [string]$key) {
  if ($null -eq $record) { return '' }
  $property = $record.PSObject.Properties[$key]
  if ($null -eq $property -or $null -eq $property.Value) { return '' }
  return [string]$property.Value
}
function Version-Slot([string]$version) {
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $raw = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($version))
    return ([BitConverter]::ToString($raw)).Replace('-','').ToLowerInvariant().Substring(0,24)
  } finally { $hasher.Dispose() }
}

$root = (Resolve-Path -LiteralPath $InstalledRoot -ErrorAction Stop).ProviderPath
$asar = Join-Path $root 'resources\app.asar'
if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) {
  throw 'Selected installation does not contain a regular resources\app.asar file.'
}
$currentSha = Inspect-Hash $asar
$storeRoot = Join-Path $env:APPDATA 'DinoPatchManager\installed-asar'
if (-not (Test-Path -LiteralPath $storeRoot -PathType Container)) {
  [pscustomobject]@{result='NO_MANAGER_STATE'; note='No DinoPatchManager installed-asar state directory found. No files changed.'} |
    ConvertTo-Json -Depth 3
  return
}

$matched = @()
$invalidForTarget = 0
$pendingForTarget = 0
# Rust stores the legacy state.json alongside version-specific state-<hash>.json
# records. Scan only direct installation folders; never follow reparse points.
$storeInfo = Get-Item -LiteralPath $storeRoot -ErrorAction Stop
if (($storeInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to traverse redirected installed-ASAR state directory.'
}
foreach ($folder in @(Get-ChildItem -LiteralPath $storeRoot -Directory -ErrorAction Stop)) {
  if (($folder.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
  $pendingCandidate = Join-Path $folder.FullName 'pending.json'
  if (Test-Path -LiteralPath $pendingCandidate -PathType Leaf) {
    try {
      $pendingInfo = Get-Item -LiteralPath $pendingCandidate -ErrorAction Stop
      if (($pendingInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
          $pendingInfo.Length -le 1MB) {
        $pendingRecord = Get-Content -LiteralPath $pendingCandidate -Raw -ErrorAction Stop |
          ConvertFrom-Json -ErrorAction Stop
        if ((Normalize-Root (Record-String $pendingRecord 'target')) -eq (Normalize-Root $root)) {
          $pendingForTarget++
        }
      }
    } catch {
      # Unreadable pending records are never repaired, reset, or followed.
    }
  }
  foreach ($file in @(Get-ChildItem -LiteralPath $folder.FullName -File -ErrorAction Stop)) {
    if ($file.Name -cne 'state.json' -and $file.Name -cnotmatch '^state-[0-9a-f]{24}\.json$') { continue }
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 1MB) { continue }
    try {
      $record = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop |
        ConvertFrom-Json -ErrorAction Stop
    } catch { continue }
    if ((Normalize-Root (Record-String $record 'target')) -ne (Normalize-Root $root)) { continue }
    $version = Record-String $record 'version'
    if ((Record-String $record 'schemaVersion') -ne '1' -or [string]::IsNullOrWhiteSpace($version)) {
      $invalidForTarget++
      continue
    }
    if ($file.Name -cne 'state.json' -and
        $file.Name -cne ('state-' + (Version-Slot $version) + '.json')) {
      $invalidForTarget++
      continue
    }
    $matched += [pscustomobject]@{file=$file;state=$record}
  }
}
if ($invalidForTarget -gt 0) {
  [pscustomobject]@{
    result='INVALID_STATE_RECORD'
    invalidMatchingStateFiles=$invalidForTarget
    note='A matching state record has an invalid schema, version, or versioned file name. Keep all files unchanged.'
  } | ConvertTo-Json -Depth 3
  return
}
$byHash = @($matched | Where-Object {
  (Same-Hash $currentSha (Record-String $_.state 'originalSha256')) -or
  (Same-Hash $currentSha (Record-String $_.state 'patchedSha256'))
})
$selected = $null
$selection = ''
if ($byHash.Count -eq 1) {
  $selected = $byHash[0]
  $selection = 'UNIQUE_CURRENT_ASAR_HASH'
} elseif ($byHash.Count -eq 0 -and $matched.Count -eq 1) {
  $selected = $matched[0]
  $selection = 'ONLY_RECORDED_STATE_CURRENT_ASAR_DIFFERS'
}
if ($null -eq $selected) {
  [pscustomobject]@{
    result='STATE_NOT_UNIQUE'
    matchingStateFiles=$matched.Count
    matchingCurrentAsarHash=$byHash.Count
    matchingPendingRecords=$pendingForTarget
    note='Cannot identify one safe generation; an update may have replaced app.asar. Do not delete or restore old backups.'
  } | ConvertTo-Json -Depth 3
  return
}
$state = $selected.state
$folder = $selected.file.DirectoryName
$version = Record-String $state 'version'
$backupName = Record-String $state 'backupFile'
if ($backupName.Length -eq 0) {
  $backupName = 'original-app.asar'
} elseif ($backupName -cne ('original-' + (Version-Slot $version) + '.asar')) {
  [pscustomobject]@{
    result='INVALID_STATE_RECORD'
    recordedStateFile=$selected.file.Name
    note='Backup filename does not match the version-specific Rust backup naming scheme.'
  } | ConvertTo-Json -Depth 3
  return
}
$backup = Join-Path $folder $backupName
$pending = Join-Path $folder 'pending.json'
$original = Record-String $state 'originalSha256'
$patched = Record-String $state 'patchedSha256'
$backupSha = Inspect-Hash $backup
$match = if (Same-Hash $currentSha $patched) { 'RECORDED_PATCHED_ASAR' }
  elseif (Same-Hash $currentSha $original) { 'RECORDED_ORIGINAL_ASAR' }
  else { 'DIFFERENT_FROM_BOTH_RECORDED_HASHES' }
$backupValid = Same-Hash $backupSha $original
$recommendation = if (Test-Path -LiteralPath $pending -PathType Leaf) {
  'Pending recovery marker found: keep it and review recovery with the original manager.'
} elseif (-not $backupValid) {
  'Original backup hash is missing or different: stop all patch/restore actions and preserve the files.'
} elseif ($match -eq 'RECORDED_PATCHED_ASAR') {
  'Existing patched ASAR is intact: inspect the recorded patch version before a verified uninstall/upgrade.'
} elseif ($match -eq 'RECORDED_ORIGINAL_ASAR') {
  'Recorded official original is intact: preserve the state and obtain a version-matched migration path.'
} else {
  'Current ASAR is not the recorded original or patched file: possibly updated/replaced. Preserve old backup and state.'
}

[pscustomobject]@{
  result = 'READ_ONLY_AUDIT'
  recordedStateFile = $selected.file.Name
  recordedBackupFile = $backupName
  stateGenerationsForTarget = $matched.Count
  selectionReason = $selection
  recordedAppVersion = $version
  recordedPatchVersion = Record-String $state 'patchVersion'
  recordedStatus = Record-String $state 'status'
  currentAsarMatch = $match
  originalBackupHashMatchesRecord = $backupValid
  pendingRecoveryRecordPresent = (Test-Path -LiteralPath $pending -PathType Leaf)
  recommendation = $recommendation
  notice = 'No files were modified. This does not replace Rust structural compatibility or recovery verification.'
} | ConvertTo-Json -Depth 3
