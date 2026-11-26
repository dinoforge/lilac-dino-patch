[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Tag,

    [Parameter(Mandatory = $true)]
    [string]$AssetPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repository = 'dinoforge/lilac-dino-patch'
$assetName = 'LilacAnime-DinoPatch-Windows-x64.zip'
$releaseBase = 'https://github.com/dinoforge/lilac-dino-patch'
$tagPattern = '^dino-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-beta\.(?:0|[1-9][0-9]*)$'

if ($Tag -cnotmatch $tagPattern) {
    throw '릴리스 태그 형식이 허용된 DinoPatch 베타 형식과 다릅니다.'
}

$ghPath = $env:DINO_GH_PATH
if ([string]::IsNullOrWhiteSpace($ghPath)) {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue
    if ($gh) {
        $ghPath = $gh.Source
    }
}
if ([string]::IsNullOrWhiteSpace($ghPath) -or -not (Test-Path -LiteralPath $ghPath -PathType Leaf)) {
    throw 'GitHub CLI(gh)가 없습니다. 자동 설치하지 않습니다.'
}

$releaseOutput = & $ghPath api "repos/$repository/releases/tags/$Tag" 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "고정 저장소의 릴리스 메타데이터 조회에 실패했습니다 (gh 종료 코드 $LASTEXITCODE)."
}
$release = ($releaseOutput -join [Environment]::NewLine) | ConvertFrom-Json

if ($release.tag_name -cne $Tag -or $release.html_url -cne "$releaseBase/releases/tag/$Tag") {
    throw '응답한 릴리스가 요청한 저장소 또는 태그와 일치하지 않습니다.'
}
if ($release.draft -ne $false -or $release.prerelease -ne $true) {
    throw '초안이 아니고 베타 사전 릴리스인 항목만 검증할 수 있습니다.'
}
if ($release.immutable -ne $true) {
    throw 'GitHub immutable 상태가 확인되지 않아 검증을 중단했습니다.'
}

$matchingAssets = @($release.assets | Where-Object { $_.name -ceq $assetName })
if ($matchingAssets.Count -ne 1) {
    throw '고정된 Windows x64 ZIP 자산이 정확히 하나가 아닙니다.'
}
$asset = $matchingAssets[0]
$expectedUrl = "$releaseBase/releases/download/$Tag/$assetName"
if ($asset.browser_download_url -cne $expectedUrl) {
    throw '배포 자산 URL이 고정된 저장소·태그·파일명과 일치하지 않습니다.'
}
if ($asset.digest -cnotmatch '^sha256:[0-9a-fA-F]{64}$') {
    throw 'GitHub API의 SHA-256 digest가 없거나 형식이 올바르지 않습니다.'
}

$resolvedAsset = Resolve-Path -LiteralPath $AssetPath -ErrorAction Stop
if ([IO.Path]::GetFileName($resolvedAsset.Path) -cne $assetName) {
    throw "검증 대상 파일명은 $assetName 이어야 합니다."
}
$actualDigest = (Get-FileHash -LiteralPath $resolvedAsset.Path -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedDigest = $asset.digest.Substring('sha256:'.Length).ToLowerInvariant()
if ($actualDigest -cne $expectedDigest) {
    throw '로컬 파일 SHA-256이 GitHub Release asset.digest와 일치하지 않습니다.'
}

& $ghPath release verify $Tag --repo $repository
if ($LASTEXITCODE -ne 0) {
    throw "GitHub release attestation 검증 실패 (gh 종료 코드 $LASTEXITCODE)."
}

& $ghPath release verify-asset $Tag $resolvedAsset.Path --repo $repository
if ($LASTEXITCODE -ne 0) {
    throw "GitHub release asset attestation 검증 실패 (gh 종료 코드 $LASTEXITCODE)."
}

Write-Output "검증 통과: $Tag / $assetName / sha256:$actualDigest"
Write-Output '이 스크립트는 확인만 수행하며 다운로드·설치·파일 교체는 하지 않았습니다.'
