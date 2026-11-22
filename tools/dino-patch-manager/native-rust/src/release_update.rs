//! Fixed-repository GitHub release discovery and digest-checked manager download.
//! GitHub's API digest is compared with HTTPS-downloaded bytes; it is not a
//! release attestation or a signature.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

// The public source repository also hosts DinoPatch releases.
pub const REPOSITORY: &str = "dinoforge/lilac-dino-patch";
pub const RELEASES_BASE: &str = "https://github.com/dinoforge/lilac-dino-patch";
pub const RELEASES_API_URL: &str = "https://api.github.com/repos/dinoforge/lilac-dino-patch/releases?per_page=100";
/// The updater replaces one fixed PE file, so the release asset must be that
/// raw executable. The legacy ZIP remains a manual download and is never
/// written over the running manager.
pub const WINDOWS_X64_ASSET: &str = "dino-native-manager.exe";
pub const MAX_MANAGER_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;
const MAX_RELEASES_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    WindowsX64,
    Unsupported,
}

pub const fn current_target() -> Target {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Target::WindowsX64
    } else {
        Target::Unsupported
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BetaVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub beta: Option<u64>,
}

impl BetaVersion {
    pub fn parse_installed(raw: &str) -> Result<Self, String> {
        let (core, beta) = match raw.split_once("-beta.") {
            Some((core, beta)) => (core, Some(parse_component(beta)?)),
            None => (raw, None),
        };
        let mut parts = core.split('.');
        let major = parts
            .next()
            .ok_or_else(|| "버전 형식이 올바르지 않습니다.".to_owned())?;
        let minor = parts
            .next()
            .ok_or_else(|| "버전 형식이 올바르지 않습니다.".to_owned())?;
        let patch = parts
            .next()
            .ok_or_else(|| "버전 형식이 올바르지 않습니다.".to_owned())?;
        if parts.next().is_some() {
            return Err("버전은 major.minor.patch 형식이어야 합니다.".into());
        }
        Ok(Self {
            major: parse_component(major)?,
            minor: parse_component(minor)?,
            patch: parse_component(patch)?,
            beta,
        })
    }

    pub fn parse_release_tag(tag: &str) -> Result<Self, String> {
        let version = tag
            .strip_prefix("dino-v")
            .ok_or_else(|| "릴리스 태그 접두사가 올바르지 않습니다.".to_owned())?;
        let parsed = Self::parse_installed(version)?;
        if parsed.beta.is_none() {
            return Err("베타 업데이트 태그가 아닙니다.".into());
        }
        Ok(parsed)
    }

    pub fn is_newer_than(&self, current: &Self) -> bool {
        match (self.major, self.minor, self.patch).cmp(&(
            current.major,
            current.minor,
            current.patch,
        )) {
            Ordering::Greater => true,
            Ordering::Less => false,
            Ordering::Equal => match (self.beta, current.beta) {
                (Some(candidate), Some(installed)) => candidate > installed,
                (Some(_), None) => false,
                (None, Some(_)) => true,
                (None, None) => false,
            },
        }
    }
}

fn parse_component(raw: &str) -> Result<u64, String> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("버전 구성 요소는 0 이상의 정수여야 합니다.".into());
    }
    if raw.len() > 1 && raw.starts_with('0') {
        return Err("버전 구성 요소에 앞자리 0을 사용할 수 없습니다.".into());
    }
    raw.parse::<u64>()
        .map_err(|_| "버전 구성 요소가 허용 범위를 벗어났습니다.".into())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseCandidate {
    pub tag: String,
    pub version: BetaVersion,
    pub title: String,
    pub changelog: String,
    pub published_at: String,
    pub asset_name: String,
    pub download_url: String,
    pub sha256: String,
}

pub fn inspect_release(
    release: &Value,
    installed_version: &str,
    target: Target,
) -> Result<ReleaseCandidate, String> {
    let candidate = parse_release(release, target)?;
    let installed = BetaVersion::parse_installed(installed_version)?;
    if !candidate.version.is_newer_than(&installed) {
        return Err("설치된 관리자보다 새로운 베타 릴리스가 아닙니다.".into());
    }
    Ok(candidate)
}

fn release_metadata(release: &Value) -> Result<(String, BetaVersion), String> {
    if release.get("draft").and_then(Value::as_bool) != Some(false) {
        return Err("초안이거나 draft 상태를 확인할 수 없는 릴리스입니다.".into());
    }
    if release.get("prerelease").and_then(Value::as_bool) != Some(true) {
        return Err("베타 사전 릴리스가 아닙니다.".into());
    }
    let tag = required_text(release, "tag_name")?;
    let expected_page = format!("{RELEASES_BASE}/releases/tag/{tag}");
    if required_text(release, "html_url")? != expected_page {
        return Err("릴리스 페이지가 고정된 저장소와 일치하지 않습니다.".into());
    }
    let version = BetaVersion::parse_release_tag(&tag)?;
    Ok((tag, version))
}

pub fn parse_release(release: &Value, target: Target) -> Result<ReleaseCandidate, String> {
    if target != Target::WindowsX64 {
        return Err("이 업데이트는 Windows x64에서만 지원됩니다.".into());
    }
    let (tag, version) = release_metadata(release)?;

    let assets = release
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| "릴리스 자산 목록을 확인할 수 없습니다.".to_owned())?;
    let matching: Vec<&Value> = assets
        .iter()
        .filter(|asset| asset.get("name").and_then(Value::as_str) == Some(WINDOWS_X64_ASSET))
        .collect();
    if matching.len() != 1 {
        return Err("고정된 Windows x64 배포 자산이 정확히 하나가 아닙니다.".into());
    }
    let asset = matching[0];
    let expected_download = format!("{RELEASES_BASE}/releases/download/{tag}/{WINDOWS_X64_ASSET}");
    let download_url = required_text(asset, "browser_download_url")?;
    if download_url != expected_download {
        return Err("다운로드 URL이 고정된 저장소·태그·자산 경로와 일치하지 않습니다.".into());
    }
    let sha256 = parse_digest(required_text(asset, "digest")?)?;

    Ok(ReleaseCandidate {
        tag,
        version,
        title: release
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("DinoPatch 베타 업데이트")
            .chars()
            .take(160)
            .collect(),
        changelog: release
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("변경 내역이 제공되지 않았습니다.")
            .chars()
            .take(12_000)
            .collect(),
        published_at: release
            .get("published_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(64)
            .collect(),
        asset_name: WINDOWS_X64_ASSET.into(),
        download_url,
        sha256,
    })
}

pub fn select_newest_release(
    releases: &Value,
    installed_version: &str,
    target: Target,
) -> Result<ReleaseCandidate, String> {
    let releases = releases
        .as_array()
        .ok_or_else(|| "GitHub 릴리스 목록이 배열이 아닙니다.".to_owned())?;
    releases
        .iter()
        .filter_map(|release| inspect_release(release, installed_version, target).ok())
        .max_by(|left, right| compare_versions(&left.version, &right.version))
        .ok_or_else(|| "설치 가능한 Windows x64 DinoPatch 베타 릴리스가 없습니다.".into())
}

/// Returns `Ok(None)` when the accessible release list contains supported
/// releases but none newer than the installed version.
pub fn newest_update(
    releases: &Value,
    installed_version: &str,
    target: Target,
) -> Result<Option<ReleaseCandidate>, String> {
    let releases = releases
        .as_array()
        .ok_or_else(|| "GitHub 릴리스 목록이 배열이 아닙니다.".to_owned())?;
    if target != Target::WindowsX64 {
        return Err("이 업데이트는 Windows x64에서만 지원됩니다.".into());
    }
    let installed = BetaVersion::parse_installed(installed_version)?;
    let mut recognized_beta = false;
    let mut newer_release_without_asset = false;
    let mut supported_newer = Vec::new();
    for release in releases {
        let Ok((_, version)) = release_metadata(release) else {
            continue;
        };
        recognized_beta = true;
        if !version.is_newer_than(&installed) {
            continue;
        }
        match parse_release(release, target) {
            Ok(candidate) => supported_newer.push(candidate),
            Err(_) => newer_release_without_asset = true,
        }
    }
    if newer_release_without_asset {
        return Err("새 베타 릴리스는 있지만 고정된 Windows x64 관리자 자산을 확인할 수 없습니다.".into());
    }
    if !recognized_beta {
        return Err("지원되는 Windows x64 DinoPatch 베타 실행 파일 자산이 없습니다.".into());
    }
    Ok(supported_newer
        .into_iter()
        .max_by(|left, right| compare_versions(&left.version, &right.version)))
}

fn compare_versions(left: &BetaVersion, right: &BetaVersion) -> Ordering {
    (left.major, left.minor, left.patch, left.beta).cmp(&(
        right.major,
        right.minor,
        right.patch,
        right.beta,
    ))
}

fn required_text(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("릴리스 필드 {key}가 없거나 비어 있습니다."))
}

fn parse_digest(raw: String) -> Result<String, String> {
    let digest = raw
        .strip_prefix("sha256:")
        .ok_or_else(|| "GitHub 자산 digest가 sha256 형식이 아닙니다.".to_owned())?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("GitHub 자산 SHA-256 형식이 올바르지 않습니다.".into());
    }
    Ok(digest.to_ascii_lowercase())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("업데이트 파일 열기 실패: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("업데이트 파일 읽기 실패: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn downloaded_asset_matches(candidate: &ReleaseCandidate, path: &Path) -> Result<bool, String> {
    Ok(sha256_file(path)? == candidate.sha256)
}

/// Revalidates the fixed asset contract at each trust boundary. Candidates are
/// public data structures and must not be assumed to have come from parse_release.
pub fn validate_update_candidate(candidate: &ReleaseCandidate) -> Result<(), String> {
    if candidate.asset_name != WINDOWS_X64_ASSET {
        return Err("고정된 DinoPatch Windows x64 관리자 자산이 아닙니다.".into());
    }
    let parsed = BetaVersion::parse_release_tag(&candidate.tag)?;
    if parsed != candidate.version {
        return Err("업데이트 태그와 버전 정보가 일치하지 않습니다.".into());
    }
    let expected_url = format!(
        "{RELEASES_BASE}/releases/download/{}/{WINDOWS_X64_ASSET}",
        candidate.tag
    );
    if candidate.download_url != expected_url {
        return Err("업데이트 자산 URL이 고정 GitHub 저장소와 일치하지 않습니다.".into());
    }
    validate_digest(&candidate.sha256)
}

pub fn check_latest_release(installed_version: &str) -> Result<Option<ReleaseCandidate>, String> {
    #[cfg(windows)]
    {
        let mut response = winhttp_transport::get(RELEASES_API_URL, true)?;
        let bytes = read_limited(&mut response, MAX_RELEASES_RESPONSE_BYTES)?;
        let releases: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "GitHub 릴리스 응답 JSON을 읽을 수 없습니다.".to_owned())?;
        newest_update(&releases, installed_version, current_target())
    }
    #[cfg(not(windows))]
    {
        let _ = installed_version;
        Err("자동 업데이트 확인은 Windows x64에서만 지원됩니다.".into())
    }
}

/// Downloads the fixed raw manager asset to a new staging path and only
/// publishes the file after its exact GitHub API SHA-256 has been verified.
pub fn download_asset_to<F>(
    candidate: &ReleaseCandidate,
    destination: &Path,
    mut progress: F,
) -> Result<String, String>
where
    F: FnMut(u64, Option<u64>),
{
    validate_update_candidate(candidate)?;
    #[cfg(windows)]
    {
        let mut response = winhttp_transport::get(&candidate.download_url, false)?;
        let content_length = response.content_length;
        verified_download(candidate, &mut response, content_length, destination, &mut progress)
    }
    #[cfg(not(windows))]
    {
        let _ = (destination, &mut progress);
        Err("Windows 다운로드 전송 계층을 사용할 수 없습니다.".into())
    }
}

fn verified_download<R, F>(
    candidate: &ReleaseCandidate,
    reader: &mut R,
    content_length: Option<u64>,
    destination: &Path,
    progress: &mut F,
) -> Result<String, String>
where
    R: Read,
    F: FnMut(u64, Option<u64>),
{
    if content_length.is_some_and(|length| length == 0 || length > MAX_MANAGER_DOWNLOAD_BYTES) {
        return Err("다운로드 크기가 비어 있거나 허용 한도를 초과했습니다.".into());
    }
    if destination.exists() {
        return Err("업데이트 준비 파일이 이미 존재합니다. 기존 파일을 덮어쓰지 않았습니다.".into());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "업데이트 준비 경로에 상위 폴더가 없습니다.".to_owned())?;
    if !parent.is_dir() {
        return Err("업데이트 준비 폴더를 확인할 수 없습니다.".into());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".dino-download-{}-{stamp:032x}.part",
        std::process::id()
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("업데이트 임시 파일 생성 실패: {error}"))?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut received = 0_u64;
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("업데이트 다운로드 읽기 실패: {error}"))?;
            if read == 0 {
                break;
            }
            received = received.saturating_add(read as u64);
            if received > MAX_MANAGER_DOWNLOAD_BYTES
                || content_length.is_some_and(|length| received > length)
            {
                return Err("다운로드가 허용된 크기를 초과했습니다.".into());
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("업데이트 임시 파일 쓰기 실패: {error}"))?;
            digest.update(&buffer[..read]);
            progress(received, content_length);
        }
        if received == 0 || content_length.is_some_and(|length| length != received) {
            return Err("다운로드 크기가 GitHub 응답과 일치하지 않습니다.".into());
        }
        output
            .sync_all()
            .map_err(|error| format!("업데이트 임시 파일 동기화 실패: {error}"))?;
        let actual = format!("{:x}", digest.finalize());
        if actual != candidate.sha256 {
            return Err("다운로드 파일과 GitHub API SHA-256 digest가 일치하지 않습니다.".into());
        }
        drop(output);
        if destination.exists() {
            return Err("업데이트 준비 파일이 이미 존재합니다. 기존 파일을 덮어쓰지 않았습니다.".into());
        }
        fs::rename(&temporary, destination)
            .map_err(|error| format!("검증된 업데이트 파일 배치 실패: {error}"))?;
        Ok(actual)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_digest(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("GitHub API SHA-256 digest 형식이 올바르지 않습니다.".into())
    }
}

fn read_limited<R: Read>(reader: &mut R, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("GitHub 응답 읽기 실패: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err("GitHub API 응답이 허용 크기를 초과했습니다.".into());
    }
    Ok(bytes)
}

#[cfg(windows)]
mod winhttp_transport {
    use super::*;
    use std::ffi::c_void;
    use std::io;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
        WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
        WinHttpSetOption, WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_FLAG_SECURE, WINHTTP_OPTION_REDIRECT_POLICY,
        WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_CONTENT_LENGTH,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_FLAG_NUMBER64, WINHTTP_QUERY_LOCATION,
        WINHTTP_QUERY_STATUS_CODE,
    };

    const MAX_REDIRECTS: usize = 5;
    const API_ALLOWED_HOSTS: &[&str] = &["api.github.com"];
    const DOWNLOAD_ALLOWED_HOSTS: &[&str] = &[
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
    ];

    struct Handle(*mut c_void);

    impl Handle {
        fn new(raw: *mut c_void, what: &str) -> Result<Self, String> {
            if raw.is_null() {
                Err(format!("{what}: {}", io::Error::last_os_error()))
            } else {
                Ok(Self(raw))
            }
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }

    pub(super) struct Response {
        request: Handle,
        _connection: Handle,
        _session: Handle,
        pub content_length: Option<u64>,
    }

    impl Read for Response {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            let request_length = buffer.len().min(u32::MAX as usize) as u32;
            let mut received = 0_u32;
            let ok = unsafe {
                WinHttpReadData(
                    self.request.0,
                    buffer.as_mut_ptr().cast(),
                    request_length,
                    &mut received,
                )
            };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(received as usize)
            }
        }
    }

    pub(super) fn get(url: &str, json: bool) -> Result<Response, String> {
        let allowed = if json { API_ALLOWED_HOSTS } else { DOWNLOAD_ALLOWED_HOSTS };
        let mut current = url.to_owned();
        for redirect_count in 0..=MAX_REDIRECTS {
            let (host, port, path) = parse_https_url(&current, allowed)?;
            let user_agent = wide(&format!("DinoPatchManager/{}", env!("CARGO_PKG_VERSION")));
            let session = Handle::new(
                unsafe {
                    WinHttpOpen(
                        user_agent.as_ptr(),
                        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                        null(),
                        null(),
                        0,
                    )
                },
                "HTTPS 세션 초기화 실패",
            )?;
            if unsafe { WinHttpSetTimeouts(session.0, 10_000, 15_000, 20_000, 45_000) } == 0 {
                return Err(format!("HTTPS 시간 제한 설정 실패: {}", io::Error::last_os_error()));
            }
            let wide_host = wide(&host);
            let connection = Handle::new(
                unsafe { WinHttpConnect(session.0, wide_host.as_ptr(), port, 0) },
                "GitHub HTTPS 연결 실패",
            )?;
            let verb = wide("GET");
            let path = wide(&path);
            let protocol = wide("HTTP/1.1");
            let request = Handle::new(
                unsafe {
                    WinHttpOpenRequest(
                        connection.0,
                        verb.as_ptr(),
                        path.as_ptr(),
                        protocol.as_ptr(),
                        null(),
                        null(),
                        WINHTTP_FLAG_SECURE,
                    )
                },
                "GitHub HTTPS 요청 생성 실패",
            )?;
            let redirect_policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
            if unsafe {
                WinHttpSetOption(
                    request.0,
                    WINHTTP_OPTION_REDIRECT_POLICY,
                    (&redirect_policy as *const u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                )
            } == 0
            {
                return Err(format!("HTTPS 리디렉션 정책 설정 실패: {}", io::Error::last_os_error()));
            }
            let headers = if json {
                "Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2022-11-28\r\n"
            } else {
                "Accept: application/octet-stream\r\n"
            };
            let headers_wide = wide(headers);
            let sent = unsafe {
                WinHttpSendRequest(
                    request.0,
                    headers_wide.as_ptr(),
                    headers.encode_utf16().count() as u32,
                    null(),
                    0,
                    0,
                    0,
                )
            };
            if sent == 0 || unsafe { WinHttpReceiveResponse(request.0, null_mut()) } == 0 {
                return Err(format!("GitHub HTTPS 응답 대기 실패: {}", io::Error::last_os_error()));
            }
            let status = query_number(request.0, WINHTTP_QUERY_STATUS_CODE)?;
            if (300..400).contains(&status) {
                if redirect_count == MAX_REDIRECTS {
                    return Err("GitHub 다운로드 리디렉션 횟수가 제한을 초과했습니다.".into());
                }
                let location = query_text(request.0, WINHTTP_QUERY_LOCATION)?;
                current = resolve_redirect(&current, &location)?;
                continue;
            }
            if !(200..300).contains(&status) {
                let reason = match status {
                    401 | 404 => "GitHub 저장소에 접근할 수 없습니다. 저장소가 비공개이거나 인증이 필요할 수 있습니다. 앱에는 토큰을 포함하지 않습니다.",
                    403 => "GitHub API가 요청을 제한했습니다. 잠시 후 다시 확인하세요.",
                    429 => "GitHub 요청 한도에 도달했습니다. 잠시 후 다시 확인하세요.",
                    _ => "GitHub 서버가 요청을 거부했습니다.",
                };
                return Err(format!("{reason} (HTTP {status})"));
            }
            let content_length = query_u64(request.0, WINHTTP_QUERY_CONTENT_LENGTH);
            return Ok(Response {
                request,
                _connection: connection,
                _session: session,
                content_length,
            });
        }
        Err("GitHub HTTPS 요청을 완료하지 못했습니다.".into())
    }

    fn parse_https_url(url: &str, allowed_hosts: &[&str]) -> Result<(String, u16, String), String> {
        let rest = url
            .strip_prefix("https://")
            .ok_or_else(|| "HTTPS가 아닌 GitHub URL을 거부했습니다.".to_owned())?;
        let (authority, path) = rest
            .split_once('/')
            .map(|(host, path)| (host, format!("/{path}")))
            .unwrap_or((rest, "/".to_owned()));
        if authority.contains('@') || authority.contains('#') || authority.contains('?') {
            return Err("GitHub URL authority 형식이 올바르지 않습니다.".into());
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, raw_port)) if raw_port.bytes().all(|byte| byte.is_ascii_digit()) => {
                (host.to_ascii_lowercase(), raw_port.parse::<u16>().unwrap_or(0))
            }
            _ => (authority.to_ascii_lowercase(), 443),
        };
        if port != 443 || !allowed_hosts.contains(&host.as_str()) || path.contains('#') {
            return Err("GitHub URL이 HTTPS 허용 호스트 목록과 일치하지 않습니다.".into());
        }
        Ok((host, port, path))
    }

    fn resolve_redirect(current: &str, location: &str) -> Result<String, String> {
        if location.starts_with("https://") {
            return Ok(location.to_owned());
        }
        if location.starts_with('/') {
            let (host, _, _) = parse_https_url(current, DOWNLOAD_ALLOWED_HOSTS)?;
            return Ok(format!("https://{host}{location}"));
        }
        Err("GitHub가 허용되지 않는 상대 리디렉션을 반환했습니다.".into())
    }

    fn query_number(request: *mut c_void, kind: u32) -> Result<u32, String> {
        let mut value = 0_u32;
        let mut length = std::mem::size_of::<u32>() as u32;
        let ok = unsafe {
            WinHttpQueryHeaders(
                request,
                kind | WINHTTP_QUERY_FLAG_NUMBER,
                null(),
                (&mut value as *mut u32).cast(),
                &mut length,
                null_mut(),
            )
        };
        if ok == 0 {
            Err(format!("GitHub HTTP 상태 확인 실패: {}", std::io::Error::last_os_error()))
        } else {
            Ok(value)
        }
    }

    fn query_u64(request: *mut c_void, kind: u32) -> Option<u64> {
        let mut value = 0_u64;
        let mut length = std::mem::size_of::<u64>() as u32;
        let ok = unsafe {
            WinHttpQueryHeaders(
                request,
                kind | WINHTTP_QUERY_FLAG_NUMBER64,
                null(),
                (&mut value as *mut u64).cast(),
                &mut length,
                null_mut(),
            )
        };
        (ok != 0).then_some(value)
    }

    fn query_text(request: *mut c_void, kind: u32) -> Result<String, String> {
        let mut length = 0_u32;
        unsafe {
            WinHttpQueryHeaders(request, kind, null(), null_mut(), &mut length, null_mut());
        }
        if length == 0 || length > 64 * 1024 {
            return Err("GitHub 리디렉션 위치가 없거나 너무 큽니다.".into());
        }
        let mut buffer = vec![0_u16; length as usize / 2 + 1];
        let ok = unsafe {
            WinHttpQueryHeaders(
                request,
                kind,
                null(),
                buffer.as_mut_ptr().cast(),
                &mut length,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!("GitHub 리디렉션 위치 읽기 실패: {}", std::io::Error::last_os_error()));
        }
        let used = length as usize / 2;
        Ok(String::from_utf16_lossy(&buffer[..used]).trim_end_matches('\0').to_owned())
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// Installation requirements for the deliberately smaller update policy.
/// These checks do not claim that an API digest is a signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallEvidence {
    fixed_https_source: bool,
    api_digest_matches_file: Option<bool>,
    user_approved: bool,
    rollback_ready: bool,
}

impl InstallEvidence {
    pub fn new(
        fixed_https_source: bool,
        api_digest_matches_file: Option<bool>,
        user_approved: bool,
        rollback_ready: bool,
    ) -> Self {
        Self {
            fixed_https_source,
            api_digest_matches_file,
            user_approved,
            rollback_ready,
        }
    }

    pub fn may_install(&self) -> bool {
        self.fixed_https_source
            && self.api_digest_matches_file == Some(true)
            && self.user_approved
            && self.rollback_ready
    }

    pub fn blockers(&self) -> Vec<&'static str> {
        let mut blockers = Vec::new();
        if !self.fixed_https_source {
            blockers.push("고정된 HTTPS GitHub 저장소의 릴리스가 아닙니다.");
        }
        match self.api_digest_matches_file {
            Some(true) => {}
            Some(false) => {
                blockers.push("다운로드 파일과 GitHub SHA-256 digest가 일치하지 않습니다.")
            }
            None => blockers.push("다운로드 파일의 GitHub SHA-256 대조를 수행하지 않았습니다."),
        }
        if !self.user_approved {
            blockers.push("사용자 설치 승인이 없습니다.");
        }
        if !self.rollback_ready {
            blockers.push("기존 실행 파일의 복구 준비가 확인되지 않았습니다.");
        }
        blockers
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DIGEST: &str = "bf233f66f83ff34cc6322ed3a2a59e39022dc9169b6259cab995d1a828dfa892";

    #[test]
    fn release_feed_is_pinned_to_the_public_source_repository() {
        assert_eq!(REPOSITORY, "dinoforge/lilac-dino-patch");
        assert_eq!(
            RELEASES_BASE,
            "https://github.com/dinoforge/lilac-dino-patch"
        );
        assert_eq!(
            RELEASES_API_URL,
            "https://api.github.com/repos/dinoforge/lilac-dino-patch/releases?per_page=100"
        );
    }

    fn release(tag: &str, immutable: bool) -> Value {
        json!({
            "tag_name": tag,
            "draft": false,
            "prerelease": true,
            "immutable": immutable,
            "name": format!("DinoPatch {tag}"),
            "body": "- 안정성 수정\n- 업데이트 흐름",
            "published_at": "2026-11-20T00:00:00Z",
            "html_url": format!("{RELEASES_BASE}/releases/tag/{tag}"),
            "assets": [{
                "name": WINDOWS_X64_ASSET,
                "browser_download_url": format!("{RELEASES_BASE}/releases/download/{tag}/{WINDOWS_X64_ASSET}"),
                "digest": format!("sha256:{DIGEST}")
            }]
        })
    }

    #[test]
    fn accepts_newer_beta_with_exact_windows_asset_and_digest_even_without_immutability() {
        let candidate = inspect_release(
            &release("dino-v0.2.0-beta.8", false),
            "0.2.0-beta.7",
            Target::WindowsX64,
        )
        .unwrap();
        assert_eq!(candidate.tag, "dino-v0.2.0-beta.8");
        assert_eq!(candidate.sha256, DIGEST);
        assert_eq!(candidate.asset_name, WINDOWS_X64_ASSET);
        assert_eq!(candidate.changelog, "- 안정성 수정\n- 업데이트 흐름");
    }

    #[test]
    fn recognizes_the_existing_beta7_zip_as_older_than_beta9() {
        let releases = json!([{
            "tag_name": "dino-v0.1.0-beta.7",
            "draft": false,
            "prerelease": true,
            "name": "LilacAnime DinoPatch 0.1.0 Beta 7",
            "html_url": format!("{RELEASES_BASE}/releases/tag/dino-v0.1.0-beta.7"),
            "assets": [
                {
                    "name": "LilacAnime-DinoPatch-Windows-x64.zip",
                    "digest": "sha256:bf233f66f83ff34cc6322ed3a2a59e39022dc9169b6259cab995d1a828dfa892"
                },
                {
                    "name": "SHA256SUMS.txt",
                    "digest": "sha256:7088e593627653d8c1612d976ed861fc4f0d863bcc6fb1bbf38c6358ff1111cb"
                }
            ]
        }]);
        assert!(newest_update(&releases, "0.2.0-beta.9", Target::WindowsX64)
            .unwrap()
            .is_none());
    }

    #[test]
    fn newer_beta_without_the_fixed_manager_asset_is_blocked() {
        let releases = json!([{
            "tag_name": "dino-v0.2.0-beta.10",
            "draft": false,
            "prerelease": true,
            "html_url": format!("{RELEASES_BASE}/releases/tag/dino-v0.2.0-beta.10"),
            "assets": [{
                "name": "LilacAnime-DinoPatch-Windows-x64.zip",
                "digest": format!("sha256:{DIGEST}")
            }]
        }]);
        assert!(newest_update(&releases, "0.2.0-beta.9", Target::WindowsX64).is_err());
    }

    #[test]
    fn rejects_draft_non_beta_but_does_not_require_immutability_field() {
        let mut value = release("dino-v0.2.0-beta.8", true);
        value["draft"] = json!(true);
        assert!(inspect_release(&value, "0.2.0-beta.7", Target::WindowsX64).is_err());
        let mut value = release("dino-v0.2.0-beta.8", true);
        value["prerelease"] = json!(false);
        assert!(inspect_release(&value, "0.2.0-beta.7", Target::WindowsX64).is_err());
        let mut value = release("dino-v0.2.0-beta.8", true);
        value.as_object_mut().unwrap().remove("immutable");
        assert!(inspect_release(&value, "0.2.0-beta.7", Target::WindowsX64).is_ok());
    }

    #[test]
    fn rejects_wrong_repository_urls_and_malformed_version_or_digest() {
        let mut value = release("dino-v0.2.0-beta.8", true);
        value["html_url"] = json!("https://github.com/other/repo/releases/tag/dino-v0.2.0-beta.8");
        assert!(inspect_release(&value, "0.2.0-beta.7", Target::WindowsX64).is_err());
        let mut value = release("dino-v0.2.0-beta.8", true);
        value["tag_name"] = json!("v0.2.0-beta.8");
        assert!(inspect_release(&value, "0.2.0-beta.7", Target::WindowsX64).is_err());
        let mut value = release("dino-v0.2.0-beta.8", true);
        value["assets"][0]["digest"] = json!(format!("sha256:{}", "z".repeat(64)));
        assert!(inspect_release(&value, "0.2.0-beta.7", Target::WindowsX64).is_err());
    }

    #[test]
    fn revalidates_candidate_asset_contract_before_download_or_install() {
        let release = release("dino-v0.2.0-beta.8", false);
        let candidate = parse_release(&release, Target::WindowsX64).unwrap();
        assert!(validate_update_candidate(&candidate).is_ok());

        let mut wrong_asset = candidate.clone();
        wrong_asset.asset_name = "DinoPatch.zip".into();
        assert!(validate_update_candidate(&wrong_asset).is_err());

        let mut wrong_tag = candidate.clone();
        wrong_tag.tag = "dino-v0.2.0-beta.9".into();
        assert!(validate_update_candidate(&wrong_tag).is_err());

        let mut wrong_url = candidate;
        wrong_url.download_url = "https://attacker.invalid/manager.exe".into();
        assert!(validate_update_candidate(&wrong_url).is_err());
    }

    #[test]
    fn rejects_duplicate_or_wrong_architecture_assets() {
        let mut value = release("dino-v0.2.0-beta.8", true);
        let duplicate = value["assets"][0].clone();
        value["assets"].as_array_mut().unwrap().push(duplicate);
        assert!(inspect_release(&value, "0.2.0-beta.7", Target::WindowsX64).is_err());
        assert!(inspect_release(
            &release("dino-v0.2.0-beta.8", true),
            "0.2.0-beta.7",
            Target::Unsupported
        )
        .is_err());
    }

    #[test]
    fn newest_selection_skips_untrusted_and_older_release_metadata() {
        let releases = json!([
            release("dino-v0.2.0-beta.7", true),
            release("dino-v0.2.0-beta.8", false),
            release("dino-v0.2.0-beta.9", true)
        ]);
        let selected =
            select_newest_release(&releases, "0.2.0-beta.7", Target::WindowsX64).unwrap();
        assert_eq!(selected.tag, "dino-v0.2.0-beta.9");
        assert!(select_newest_release(&releases, "0.2.0-beta.9", Target::WindowsX64).is_err());
    }

    #[test]
    fn digest_alone_does_not_authorize_install_without_user_approval_and_rollback() {
        let evidence = InstallEvidence::new(true, Some(true), false, false);
        assert!(!evidence.may_install());
        assert!(evidence
            .blockers()
            .iter()
            .any(|item| item.contains("사용자 설치 승인")));
        assert!(evidence
            .blockers()
            .iter()
            .any(|item| item.contains("복구 준비")));
        assert!(!evidence
            .blockers()
            .iter()
            .any(|item| item.contains("일치하지 않습니다")));
    }

    #[test]
    fn install_gate_requires_fixed_https_digest_consent_and_rollback() {
        assert!(InstallEvidence::new(true, Some(true), true, true).may_install());
        let no_https = InstallEvidence::new(false, Some(true), true, true);
        assert!(!no_https.may_install());
        let no_digest = InstallEvidence::new(true, None, true, true);
        assert!(!no_digest.may_install());
        assert!(no_digest
            .blockers()
            .iter()
            .any(|item| item.contains("수행하지 않았습니다")));
        let bad_digest = InstallEvidence::new(true, Some(false), true, true);
        assert!(!bad_digest.may_install());
        assert!(bad_digest
            .blockers()
            .iter()
            .any(|item| item.contains("일치하지 않습니다")));
        let no_consent = InstallEvidence::new(true, Some(true), false, true);
        assert!(!no_consent.may_install());
        let no_rollback = InstallEvidence::new(true, Some(true), true, false);
        assert!(!no_rollback.may_install());
    }

    #[test]
    fn file_sha256_is_streamed_and_compared_with_release_api_digest() {
        let file = tempfile_path();
        std::fs::write(file.path(), b"abc").unwrap();
        let digest = sha256_file(file.path()).unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let candidate = ReleaseCandidate {
            tag: "dino-v0.2.0-beta.8".into(),
            version: BetaVersion::parse_release_tag("dino-v0.2.0-beta.8").unwrap(),
            title: "DinoPatch beta".into(),
            changelog: String::new(),
            published_at: String::new(),
            asset_name: WINDOWS_X64_ASSET.into(),
            download_url: format!("{RELEASES_BASE}/releases/download/dino-v0.2.0-beta.8/{WINDOWS_X64_ASSET}"),
            sha256: digest,
        };
        assert!(downloaded_asset_matches(&candidate, file.path()).unwrap());
    }

    #[test]
    fn verified_download_reports_progress_and_never_publishes_bad_digest() {
        let root = tempfile_dir();
        let destination = root.path().join(WINDOWS_X64_ASSET);
        let candidate = ReleaseCandidate {
            tag: "dino-v0.2.0-beta.8".into(),
            version: BetaVersion::parse_release_tag("dino-v0.2.0-beta.8").unwrap(),
            title: "DinoPatch beta".into(),
            changelog: String::new(),
            published_at: String::new(),
            asset_name: WINDOWS_X64_ASSET.into(),
            download_url: format!("{RELEASES_BASE}/releases/download/dino-v0.2.0-beta.8/{WINDOWS_X64_ASSET}"),
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
        };
        let mut bytes = &b"abc"[..];
        let mut progress = Vec::new();
        let digest = verified_download(&candidate, &mut bytes, Some(3), &destination, &mut |done, total| {
            progress.push((done, total));
        }).unwrap();
        assert_eq!(digest, candidate.sha256);
        assert_eq!(fs::read(&destination).unwrap(), b"abc");
        assert_eq!(progress.last(), Some(&(3, Some(3))));

        let bad_destination = root.path().join("bad.exe");
        let mut bytes = &b"bad"[..];
        assert!(verified_download(&candidate, &mut bytes, Some(3), &bad_destination, &mut |_, _| {}).is_err());
        assert!(!bad_destination.exists());
    }

    struct TempFile(std::path::PathBuf);
    impl TempFile {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn tempfile_path() -> TempFile {
        let path = std::env::temp_dir().join(format!(
            "dino-release-digest-{}-{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        TempFile(path)
    }

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempfile_dir() -> TempDir {
        let path = std::env::temp_dir().join(format!(
            "dino-update-download-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        TempDir(path)
    }
}
