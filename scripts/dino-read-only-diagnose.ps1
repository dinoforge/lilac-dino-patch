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
foreach ($file in (Get-ChildItem -LiteralPath $storeRoot -Filter 'state.json' -File -Recurse -ErrorAction Stop)) {
  try {
    $record = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($null -ne $record.target -and (Normalize-Root ([string]$record.target)) -eq (Normalize-Root $root)) {
      $matched += [pscustomobject]@{file=$file;state=$record}
    }
  } catch {
    # Invalid or unrelated JSON is not edited or interpreted as this installation.
    continue
  }
}
if ($matched.Count -ne 1) {
  [pscustomobject]@{
    result='STATE_NOT_UNIQUE'; matchingStateFiles=$matched.Count
    note='Could not find exactly one state.json for the selected installation. Do not delete or reset anything.'
  } | ConvertTo-Json -Depth 3
  return
}

$state = $matched[0].state
$folder = $matched[0].file.DirectoryName
$backup = Join-Path $folder 'original-app.asar'
$pending = Join-Path $folder 'pending.json'
$original = [string]$state.originalSha256
$patched = [string]$state.patchedSha256
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
  recordedAppVersion = [string]$state.version
  recordedPatchVersion = [string]$state.patchVersion
  recordedStatus = [string]$state.status
  currentAsarMatch = $match
  originalBackupHashMatchesRecord = $backupValid
  pendingRecoveryRecordPresent = (Test-Path -LiteralPath $pending -PathType Leaf)
  recommendation = $recommendation
  notice = 'No files were modified. Current internal ASAR app version must be read separately by the manager.'
} | ConvertTo-Json -Depth 3
