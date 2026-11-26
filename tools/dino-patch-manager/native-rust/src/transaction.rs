//! Native Rust installed-ASAR patch transaction.
//! This module is deliberately fail-closed. All changes target only an
//! explicitly selected local LilacAnime installation and its manager backup.

use crate::asar::{self, Archive};
use crate::patch_set::{
    self, CandidateCheck, CandidateManifest, ManagerInstallSupport, PatchRevision, PatchSet,
};
use crate::{fail, Result};
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MANIFEST: &str = include_str!("../../../../patches/patch03/manifest.json");
const INTEGRATED_JS: &[u8] = include_bytes!("../../../../src/integrated-search.js");
const INTEGRATED_CSS: &[u8] = include_bytes!("../../../../src/integrated-search.css");
const PATCH_BRIDGE: &[u8] = include_bytes!("../../../../patches/patch03/patch03-bridge.js");
const SQLITE_SYNC: &[u8] = include_bytes!("../../../../src/dino-sqlite-sync.js");
const SQLITE_MAIN: &[u8] = include_bytes!("../../../../patches/patch03/dino-work-db.cjs");
const PATCH_VERSION: &str = "1.0.0";

#[derive(Clone, Debug)]
pub struct Status {
    pub status: String,
    pub version: String,
    pub reason: String,
    pub composition_id: Option<String>,
    pub revision_id: Option<String>,
    pub recovery_available: bool,
    pub manually_uninstalled: bool,
}

impl Status {
    pub fn new(status: &str, version: &str, reason: impl Into<String>) -> Self {
        Self {
            status: status.into(),
            version: version.into(),
            reason: reason.into(),
            composition_id: None,
            revision_id: None,
            recovery_available: false,
            manually_uninstalled: false,
        }
    }

    fn with_composition(mut self, set: PatchSet) -> Self {
        self.composition_id = Some(set.id());
        self
    }

    fn with_revision(mut self, revision: PatchRevision) -> Self {
        self.revision_id = Some(revision.id.to_owned());
        self
    }
}

// Compatibility is evaluated from the actual ASAR structure and exact,
// unique insertion anchors. No registration of a release version is needed.
// The package identity and every original required module must be readable.
pub fn installed_root(input: &Path) -> Result<PathBuf> {
    asar::dir_only(input)?;
    let root = fs::canonicalize(input)?;
    asar::dir_only(&root)?;
    asar::file_only(&root.join("LilacAnime.exe"))?;
    asar::dir_only(&root.join("resources"))?;
    asar::file_only(&root.join("resources").join("app.asar"))?;
    #[cfg(windows)]
    {
        // No UNC/network-path or redirected installations.
        let normalized=root.to_string_lossy();
        if normalized.starts_with(r"\\?\UNC\") ||
            (normalized.starts_with(r"\\") && !normalized.starts_with(r"\\?\")) {
            return Err(fail("네트워크 설치 경로는 지원하지 않습니다."));
        }
    }
    Ok(root)
}

fn appdata() -> Result<PathBuf> {
    let base = env::var_os("APPDATA").ok_or_else(||fail("APPDATA 사용자 데이터 경로가 없습니다."))?;
    let p=PathBuf::from(base);
    asar::dir_only(&p)?;
    Ok(fs::canonicalize(p)?)
}

pub fn state_root(root: &Path) -> Result<PathBuf> {
    let mut normalized = root.to_string_lossy().into_owned();
    #[cfg(windows)]
    { normalized=normalized.to_lowercase().replace('/', "\\"); }
    #[cfg(not(windows))]
    { let _=&mut normalized; }
    let hash=format!("{:x}", Sha256::digest(normalized.as_bytes()));
    Ok(appdata()?.join("DinoPatchManager").join("installed-asar").join(&hash[..24]))
}

pub fn sha(path: &Path) -> Result<String> {
    let meta=asar::file_only(path)?;
    if meta.len()>asar::MAX_ASAR_BYTES { return Err(fail("SHA-256 검사 파일이 제한 크기를 초과했습니다.")); }
    let mut input=File::open(path)?;
    let mut hash=Sha256::new();
    let mut buffer=[0u8;1024*1024];
    let mut count=0u64;
    loop {
        let n=input.read(&mut buffer)?;
        if n==0 { break; }
        count+=n as u64;
        if count>asar::MAX_ASAR_BYTES {return Err(fail("SHA 검증 중 파일 크기가 초과됐습니다."));}
        hash.update(&buffer[..n]);
    }
    let after=asar::file_only(path)?;
    if count!=meta.len() || count!=after.len() || meta.modified().ok()!=after.modified().ok() {
        return Err(fail("검사 중 파일이 변경되었습니다."));
    }
    Ok(format!("{:X}",hash.finalize()))
}

pub fn verify_identity(archive:&Archive,version:&str)->Result<()> {
    if archive.version()?!=version { return Err(fail("검사 중 설치본 버전이 바뀌었습니다.")); }
    for filename in ["src/app.js","src/index.html","electron/main.cjs",
                     "electron/preload.cjs","src/player.js"] {
        let content=archive.read(filename)?;
        if content.is_empty() || content.len()>24*1024*1024 {
            return Err(fail(format!("필수 원본 파일 크기가 비정상적입니다: {filename}")));
        }
        // Refuse mixed newline source. Exact anchors are separately checked
        // before writing, even when the upstream version is not registered.
        let crlf=content.windows(2).filter(|w|*w==b"\r\n").count();
        let lf=content.iter().filter(|&&b|b==b'\n').count();
        if crlf!=0 && crlf!=lf {
            return Err(fail(format!("원본 파일에 혼합된 줄바꿈이 있습니다: {filename}")));
        }
    }
    Ok(())
}

fn base_manifest()->Result<Value>{
    let manifest:Value=serde_json::from_str(MANIFEST)?;
    if manifest.get("patchVersion").and_then(Value::as_str)!=Some(PATCH_VERSION){
        return Err(fail("패치 manifest 버전이 Rust 엔진과 다릅니다."));
    }
    Ok(manifest)
}

fn profile_compatible(archive:&Archive,entries:&[Value])->Result<bool>{
    for item in entries {
        let filename=item["file"].as_str().ok_or_else(||fail("연결 프로필 파일명 누락"))?;
        if !matches!(filename,"src/app.js"|"src/index.html") {
            return Err(fail("허가되지 않은 연결 프로필 파일명입니다."));
        }
        let before=item["before"].as_str().ok_or_else(||fail("연결 프로필 기준 누락"))?;
        if before.is_empty(){return Ok(false);}
        let original=archive.read(filename)?;
        let crlf=original.windows(2).filter(|w|*w==b"\r\n").count();
        let lf=original.iter().filter(|&&v|v==b'\n').count();
        let pattern=if crlf!=0 && crlf==lf {before.replace('\n',"\r\n")}else{before.to_string()};
        if original.windows(pattern.len()).filter(|v|*v==pattern.as_bytes()).count()!=1 {
            return Ok(false);
        }
    }
    Ok(true)
}

fn select_manifest(archive:&Archive)->Result<Value>{
    let mut manifest=base_manifest()?;
    let base=manifest["connections"].as_array()
        .ok_or_else(||fail("기본 연결 프로필을 찾지 못했습니다."))?;
    if base.len()!=5 {return Err(fail("기본 연결 프로필 수가 잘못됐습니다."));}
    if profile_compatible(archive,base)? {return Ok(manifest);}
    let candidates=manifest["additionalOfficialSources"].as_array()
        .ok_or_else(||fail("추가 연결 프로필을 찾지 못했습니다."))?.clone();
    for item in candidates {
        let Some(entries)=item["connections"].as_array() else {continue;};
        if entries.len()==5 && profile_compatible(archive,entries)?{
            manifest["connections"]=Value::Array(entries.clone());
            return Ok(manifest);
        }
    }
    Err(fail("현재 설치본에 맞는 패치 연결 지점이 없습니다. 버전 번호와 무관하게 원본 구조를 확인해 주세요."))
}

fn replace_one(input:Vec<u8>,before:&[u8],after:&[u8],name:&str)->Result<Vec<u8>> {
    if before.is_empty() {return Err(fail("빈 패치 연결 기준은 허용하지 않습니다."));}
    let hits=input.windows(before.len()).filter(|window| *window==before).count();
    if hits!=1 {return Err(fail(format!("공식 연결 지점이 정확히 하나가 아닙니다 ({name}, {hits}개).")));}
    let at=input.windows(before.len()).position(|window| window==before).unwrap();
    let mut out=Vec::with_capacity(input.len()-before.len()+after.len());
    out.extend_from_slice(&input[..at]);
    out.extend_from_slice(after);
    out.extend_from_slice(&input[at+before.len()..]);
    Ok(out)
}

pub fn replacements(archive:&Archive, version:&str)->Result<BTreeMap<String,Vec<u8>>> {
    verify_identity(archive,version)?;
    let manifest=select_manifest(archive)?;
    let connections=manifest["connections"].as_array()
        .ok_or_else(||fail("manifest 연결 목록이 없습니다."))?;
    if connections.len()!=5 { return Err(fail("manifest의 기존 연결 수가 5개가 아닙니다.")); }
    // Both extra bridges are additive, pinned to reviewed official versions.
    // If either anchor is absent the transaction aborts BEFORE any ASAR write.
    let optional=manifest["optionalConnections"].as_array()
        .ok_or_else(||fail("SQLite 연결 목록이 없습니다."))?;
    if optional.len()!=2{return Err(fail("SQLite 연결 수가 2개가 아닙니다."));}
    let mut changes=BTreeMap::new();
    for path in ["src/app.js","src/index.html","electron/main.cjs","electron/preload.cjs"] {
        changes.insert(path.into(),archive.read(path)?);
    }
    let mut connection_count=BTreeMap::new();
    for item in connections.iter().chain(optional.iter()) {
        let path=item["file"].as_str().ok_or_else(||fail("manifest 연결 경로가 없습니다."))?;
        if !matches!(path,"src/app.js"|"src/index.html"|"electron/main.cjs"|"electron/preload.cjs") {
            return Err(fail("허가되지 않은 원본 파일 변경입니다."));
        }
        *connection_count.entry(path).or_insert(0usize)+=1;
        let before=item["before"].as_str().ok_or_else(||fail("manifest before 정보가 없습니다."))?;
        let after=item["after"].as_str().ok_or_else(||fail("manifest after 정보가 없습니다."))?;
        let current=changes.remove(path).ok_or_else(||fail("원본 연결 대상이 없습니다."))?;
        let crlf=current.windows(2).filter(|w|*w==b"\r\n").count();
        let lf=current.iter().filter(|&&x|x==b'\n').count();
        let (before,after) = if crlf>0 && crlf==lf {
            (before.replace('\n',"\r\n"),after.replace('\n',"\r\n"))
        } else {(before.to_owned(),after.to_owned())};
        let modified=replace_one(current,before.as_bytes(),after.as_bytes(),
            item["description"].as_str().unwrap_or("connection"))?;
        changes.insert(path.into(),modified);
    }
    if connection_count.get("src/app.js")!=Some(&1)
        || connection_count.get("src/index.html")!=Some(&4)
        || connection_count.get("electron/main.cjs")!=Some(&1)
        || connection_count.get("electron/preload.cjs")!=Some(&1)
        || connection_count.len()!=4 {
        return Err(fail("manifest의 공식 연결 대상 개수가 잘못됐습니다."));
    }
    for (path,data) in [
        ("src/integrated-search.js",INTEGRATED_JS),
        ("src/integrated-search.css",INTEGRATED_CSS),
        ("src/patch03-bridge.js",PATCH_BRIDGE),
        ("src/dino-sqlite-sync.js",SQLITE_SYNC),
        ("electron/dino-work-db.cjs",SQLITE_MAIN),
    ] {
        if archive.contains(path) {return Err(fail(format!("이미 ASAR에 패치 파일이 있습니다: {path}")));}
        let entry=manifest["runtimeModules"].as_array().ok_or_else(||fail("패치 파일 목록이 없습니다."))?
            .iter().find(|x|x["destination"]==path).ok_or_else(||fail(format!("패치 모듈 manifest 누락: {path}")))?;
        let expected=entry["sha256"].as_str().ok_or_else(||fail("패치 모듈 SHA-256이 없습니다."))?;
        let got=format!("{:X}",Sha256::digest(data));
        if got!=expected.to_uppercase(){return Err(fail(format!("패치 모듈 SHA-256 불일치: {path}")));}
        changes.insert(path.into(),data.to_vec());
    }
    for p in ["src/app.js","src/index.html","electron/main.cjs","electron/preload.cjs"] {
        if changes[p]==archive.read(p)? { return Err(fail("원본 연결 파일이 수정되지 않았습니다.")); }
    }
    Ok(changes)
}

fn version_slot(version:&str)->String{
    format!("{:x}",Sha256::digest(version.as_bytes()))[..24].to_owned()
}
fn state_filename(version:&str)->String{
    format!("state-{}.json",version_slot(version))
}
fn backup_filename(version:&str)->String{
    format!("original-{}.asar",version_slot(version))
}

fn recorded_composition(state: &Value) -> Result<Option<PatchSet>> {
    let Some(value) = state.get("compositionId") else {
        if state.get("revisionId").is_some() || state.get("revisionNumber").is_some() {
            return Err(fail("개정판 기록에 패치 조합 ID가 없습니다."));
        }
        return Ok(None);
    };
    let id = value.as_str().ok_or_else(|| fail("패치 조합 ID 형식이 올바르지 않습니다."))?;
    let set = PatchSet::parse_id(id).map_err(fail)?;
    if state["patchVersion"] != PATCH_VERSION {
        return Err(fail("기록된 패치 조합의 패치 버전이 현재 관리자와 다릅니다."));
    }
    recorded_revision(state, set)?;
    Ok(Some(set))
}

fn recorded_revision(state: &Value, set: PatchSet) -> Result<PatchRevision> {
    let revision_id = match state.get("revisionId") {
        Some(Value::String(id)) => Some(id.as_str()),
        None => None,
        Some(_) => return Err(fail("패치 개정판 ID 형식이 올바르지 않습니다.")),
    };
    let app_version = state["version"]
        .as_str()
        .ok_or_else(|| fail("패치 기록의 LilacAnime 버전이 없습니다."))?;
    let original_sha = state["originalSha256"]
        .as_str()
        .ok_or_else(|| fail("패치 기록의 원본 지문이 없습니다."))?;
    let result_sha = state["patchedSha256"]
        .as_str()
        .ok_or_else(|| fail("패치 기록의 결과 지문이 없습니다."))?;
    let revision = patch_set::resolve_registered_revision(
        set,
        revision_id,
        app_version,
        original_sha,
        result_sha,
    )
    .ok_or_else(|| fail("패치 기록의 개정판 또는 결과 지문이 등록된 결과와 일치하지 않습니다."))?;
    match state.get("revisionNumber") {
        Some(Value::Number(number))
            if revision_id.is_some()
                && number.as_u64() == Some(u64::from(revision.number)) => {}
        Some(_) => return Err(fail("패치 기록의 개정판 번호와 ID가 일치하지 않습니다.")),
        None if revision_id.is_some() => {
            return Err(fail("새 개정판 기록에 개정판 번호가 없습니다."))
        }
        None => {}
    }
    Ok(revision)
}

fn state_composition(state: &Value) -> Result<PatchSet> {
    Ok(recorded_composition(state)?.unwrap_or(PatchSet::parse_id("01").map_err(fail)?))
}

fn compose_verified_selection(
    archive: &Archive,
    archive_path: &Path,
    set: PatchSet,
) -> Result<(BTreeMap<String, Vec<u8>>, PatchRevision)> {
    let capability = patch_set::combination_capability(set);
    if capability.manager_install != ManagerInstallSupport::Supported {
        return Err(fail("선택한 패치 조합은 관리자 설치가 지원되지 않습니다."));
    }
    let revision = patch_set::latest_installable_revision(set)
        .ok_or_else(|| fail("선택한 패치 조합의 설치 가능한 개정판이 없습니다."))?;
    let fingerprint = revision.fingerprint;
    let version = archive.version()?;
    if version != fingerprint.app_version || sha(archive_path)? != fingerprint.original_sha256 {
        return Err(fail("선택 조합은 검증된 공식 LilacAnime v0.5.65 원본에서만 설치할 수 있습니다."));
    }

    let changes = crate::bundle_preview::compose_selection(archive, set)?;
    let id = set.id();
    let changed_files = changes.keys().map(String::as_str).collect::<Vec<_>>();
    let candidate = CandidateManifest {
        combination_id: &id,
        revision_id: Some(revision.id),
        app_version: version.as_str(),
        original_sha256: fingerprint.original_sha256,
        result_sha256: fingerprint.result_sha256,
        changed_files: &changed_files,
    };
    if patch_set::verify_candidate(candidate) != CandidateCheck::VerifiedKnownOutput
        || !patch_set::candidate_manager_install_supported(candidate)
    {
        return Err(fail("선택 조합의 생성 파일·변경 목록이 검증된 결과 지문과 일치하지 않습니다."));
    }
    Ok((changes, revision))
}

fn composition_state(
    root: &Path,
    set: PatchSet,
    revision: PatchRevision,
    original_sha: &str,
    patched_sha: &str,
    backup_file: Option<&str>,
) -> Value {
    let now = Utc::now();
    json!({
        "schemaVersion": 1,
        "target": root.to_string_lossy(),
        "version": patch_set::VERIFIED_APP_VERSION,
        "patchVersion": PATCH_VERSION,
        "status": "APPLIED",
        "compositionId": set.id(),
        "revisionId": revision.id,
        "revisionNumber": revision.number,
        "originalSha256": original_sha,
        "patchedSha256": patched_sha,
        "backupId": now.format("%Y%m%dT%H%M%SZ").to_string(),
        "createdAt": now.to_rfc3339(),
        "backupFile": backup_file.map(Value::from).unwrap_or(Value::Null)
    })
}

fn validate_transition_source_revision(root: &Path, state: &Value) -> Result<(PatchSet, PatchRevision)> {
    if state["schemaVersion"] != 1
        || state["target"] != root.to_string_lossy().as_ref()
        || state["version"] != patch_set::VERIFIED_APP_VERSION
        || state["patchVersion"] != PATCH_VERSION
        || state["status"] != "APPLIED"
    {
        return Err(fail("조합 전환의 기존 적용 기록을 검증할 수 없습니다."));
    }
    let set = state_composition(state)?;
    let revision = recorded_revision(state, set)?;
    let fingerprint = revision.fingerprint;
    let backup = backup_for_state(root, state)?;
    if sha(&backup)? != fingerprint.original_sha256 {
        return Err(fail("기존 조합의 원본 백업이 검증되지 않았습니다."));
    }
    Ok((set, revision))
}

fn validate_transition_source(root: &Path, state: &Value) -> Result<PatchSet> {
    validate_transition_source_revision(root, state).map(|(set, _)| set)
}

fn clean_transition_record(mut state: Value) -> Value {
    if let Some(object) = state.as_object_mut() {
        object.remove("transactionType");
        object.remove("previousState");
        object.remove("previousPatchedSha256");
    }
    state
}

fn composition_transition_record(
    root: &Path,
    previous: &Value,
    set: PatchSet,
    revision: PatchRevision,
    original_sha: &str,
    patched_sha: &str,
    backup_file: Option<&str>,
) -> Result<Value> {
    let (_, old_revision) = validate_transition_source_revision(root, previous)?;
    let old_fingerprint = old_revision.fingerprint;
    let mut next = composition_state(root, set, revision, original_sha, patched_sha, backup_file);
    next["transactionType"] = json!("COMPOSITION_TRANSITION");
    next["previousState"] = previous.clone();
    next["previousPatchedSha256"] = json!(old_fingerprint.result_sha256);
    Ok(next)
}

fn install_verified_selection(root: &Path, set: PatchSet, manual: bool) -> Result<Status> {
    let current = inspect(root);
    if matches!(current.status.as_str(), "APPLIED" | "REVISION_UPDATE_AVAILABLE")
        && current.composition_id.as_deref() == Some(set.id().as_str())
    {
        let state = read_state(root)?.ok_or_else(|| fail("기존 적용 기록이 없습니다."))?;
        let installed_revision = recorded_revision(&state, set)?;
        let latest = patch_set::latest_installable_revision(set)
            .ok_or_else(|| fail("선택한 조합에 설치 가능한 개정판이 없습니다."))?;
        if installed_revision.id == latest.id {
            return Ok(Status::new("ALREADY_APPLIED", &current.version, "선택한 조합과 개정판이 이미 적용돼 있습니다.")
                .with_composition(set));
        }
        if !manual {
            return Ok(Status::new(
                "REVISION_UPDATE_AVAILABLE",
                &current.version,
                format!("{} 조합의 {} 개정판이 적용돼 있습니다. 검증된 {} 개정판으로 바꾸려면 수동 적용을 선택하세요.", set.id(), installed_revision.id, latest.id),
            ).with_composition(set));
        }
    } else if !matches!(current.status.as_str(), "UNPATCHED" | "APPLIED" | "REVISION_UPDATE_AVAILABLE") {
        return Ok(current);
    }
    if current.manually_uninstalled && !manual {
        return Ok(current);
    }

    assert_not_running()?;
    let root = installed_root(root)?;
    let archive_file = archive_path(&root);
    let installed_sha = sha(&archive_file)?;
    let previous = read_state(&root)?;
    let transitioning = matches!(current.status.as_str(), "APPLIED" | "REVISION_UPDATE_AVAILABLE");
    let (source_file, previous_set) = if transitioning {
        let previous = previous.as_ref().ok_or_else(|| fail("기존 적용 기록이 없습니다."))?;
        let (old_set, _) = validate_transition_source_revision(&root, previous)?;
        if installed_sha != previous["patchedSha256"].as_str().unwrap_or("") {
            return Err(fail("조합 전환 직전에 현재 ASAR가 기존 적용 기록과 달라졌습니다."));
        }
        (backup_for_state(&root, previous)?, Some(old_set))
    } else {
        if let Some(previous) = previous.as_ref() {
            if previous["version"] != patch_set::VERIFIED_APP_VERSION
                || previous["status"] != "UNPATCHED"
            {
                return Err(fail("이전 상태 기록이 현재 원본과 일치하지 않아 선택 조합 설치를 중단했습니다."));
            }
        }
        (archive_file.clone(), None)
    };

    let (changes, revision) = compose_verified_selection(
        &Archive::open(&source_file)?,
        &source_file,
        set,
    )?;
    let fingerprint = revision.fingerprint;
    let expected_sha = fingerprint.result_sha256;
    if !revision.installable {
        return Err(fail("선택 조합의 개정판은 설치 허용 상태가 아닙니다."));
    }

    let data_root = ensure_state_dir(&root)?;
    let original_sha = fingerprint.original_sha256;
    let (backup, backup_file) = if let Some(previous) = previous.as_ref() {
        if previous["version"] != patch_set::VERIFIED_APP_VERSION {
            return Err(fail("기존 백업의 LilacAnime 버전이 선택 조합과 다릅니다."));
        }
        let path = backup_for_state(&root, previous)?;
        if sha(&path)? != original_sha {
            return Err(fail("기존 원본 백업이 선택 조합의 공식 원본 지문과 다릅니다."));
        }
        let filename = previous["backupFile"].as_str().map(str::to_owned);
        (path, filename)
    } else {
        let path = data_root.join("original-app.asar");
        if entry_exists(&path)? {
            if sha(&path)? != original_sha {
                return Err(fail("기존 원본 백업이 현재 공식 원본과 다릅니다. 덮어쓰지 않습니다."));
            }
        } else {
            copy_new(&source_file, &path)?;
        }
        (path, None)
    };
    if sha(&backup)? != original_sha {
        return Err(fail("선택 조합 설치 전 원본 백업 SHA-256 검증에 실패했습니다."));
    }

    let temp = root.join("resources").join("app.asar.dino-writing");
    if entry_exists(&temp)? {
        return Err(fail("이전 패치 임시 파일이 있어 중단합니다."));
    }
    Archive::open(&source_file)?.write_modified(&temp, &changes)?;
    if sha(&temp)? != expected_sha || sha(&source_file)? != original_sha {
        return Err(fail("선택 조합 생성 결과 또는 원본 SHA-256이 검증되지 않았습니다."));
    }
    if sha(&archive_file)? != installed_sha {
        return Err(fail("조합 준비 중 설치된 ASAR가 변경됐습니다."));
    }

    let pending_path = data_root.join("pending.json");
    if entry_exists(&pending_path)? {
        return Err(fail("이전 패치 복구 기록이 남아 있습니다."));
    }
    if let Some(previous) = previous.as_ref() {
        archive_transition_state(&root, previous)?;
    }
    let next = if transitioning {
        let previous = previous.as_ref().ok_or_else(|| fail("조합 전환의 기존 상태가 없습니다."))?;
        if previous_set.is_none() {
            return Err(fail("조합 전환의 기존 조합이 없습니다."));
        }
        composition_transition_record(
            &root, previous, set, revision, original_sha, expected_sha, backup_file.as_deref()
        )?
    } else {
        composition_state(&root, set, revision, original_sha, expected_sha, backup_file.as_deref())
    };
    write_json_atomic(&pending_path, &next)?;
    fs::rename(&temp, &archive_file)?;
    if sha(&archive_file)? != expected_sha {
        return Err(fail("조합 전환 후 결과 SHA-256 검증에 실패했습니다. 복구 기록을 보존합니다."));
    }
    let committed = clean_transition_record(next);
    write_state(&root, &committed)?;
    fs::remove_file(&pending_path)?;
    let after = inspect(&root);
    if after.status != "APPLIED" || after.composition_id.as_deref() != Some(set.id().as_str()) {
        return Err(fail(format!("선택 조합 적용 후 상태 재검사 실패: {}", after.reason)));
    }
    Ok(after)
}

fn read_state_file(root:&Path,path:&Path)->Result<Value>{
    asar::file_only(path)?;
    let metadata=fs::metadata(path)?;
    if metadata.len()>1024*1024 {return Err(fail("상태 기록이 너무 큽니다."));}
    let state:Value=serde_json::from_slice(&fs::read(path)?)?;
    if state["target"]!=root.to_string_lossy().as_ref(){
        return Err(fail("상태 기록이 다른 설치 폴더를 가리킵니다."));
    }
    if state["schemaVersion"]!=1 {return Err(fail("지원하지 않는 상태 기록 버전입니다."));}
    Ok(state)
}
fn backup_for_state(root:&Path,state:&Value)->Result<PathBuf>{
    let base=state_root(root)?;
    if let Some(filename)=state["backupFile"].as_str(){
        let version=state["version"].as_str().ok_or_else(||fail("백업 버전 기록이 없습니다."))?;
        if filename!=backup_filename(version){
            return Err(fail("백업 파일명이 상태 기록과 일치하지 않습니다."));
        }
        Ok(base.join(filename))
    }else{
        Ok(base.join("original-app.asar"))
    }
}
fn write_state(root:&Path,state:&Value)->Result<()>{
    let version=state["version"].as_str().ok_or_else(||fail("상태 버전 기록이 없습니다."))?;
    let filename=if state["backupFile"].is_string(){
        state_filename(version)
    }else {"state.json".into()};
    write_json_atomic(&state_root(root)?.join(filename),state)
}

fn archive_transition_state(root: &Path, state: &Value) -> Result<PathBuf> {
    let data = state_root(root)?;
    asar::dir_only(&data)?;
    let serialized = serde_json::to_vec_pretty(state)?;
    let digest = format!("{:X}", Sha256::digest(&serialized));
    let archived = data.join(format!("state-history-{}.json", &digest[..32]));
    if entry_exists(&archived)? {
        asar::file_only(&archived)?;
        if fs::read(&archived)? != serialized {
            return Err(fail("조합 전환 이력 파일이 기존 기록과 충돌합니다."));
        }
        return Ok(archived);
    }
    write_json_atomic(&archived, state)?;
    if fs::read(&archived)? != serialized {
        return Err(fail("조합 전환 이력 기록 검증에 실패했습니다."));
    }
    Ok(archived)
}
fn read_state(root:&Path)->Result<Option<Value>>{
    let directory=state_root(root)?;
    if !directory.exists(){return Ok(None);}
    asar::dir_only(&directory)?;
    // A new official update has a fresh state + original backup, while every
    // older version's state/backup remains untouched for forensics or rollback.
    let version=Archive::open(&archive_path(root))?.version()?;
    let preferred=directory.join(state_filename(&version));
    if preferred.exists(){return read_state_file(root,&preferred).map(Some);}
    let legacy=directory.join("state.json");
    if legacy.exists(){
        let value=read_state_file(root,&legacy)?;
        if value["version"]==version {return Ok(Some(value));}
    }
    let mut latest:Option<(String,Value)>=None;
    let mut slots=0;
    for entry in fs::read_dir(&directory)?{
        let entry=entry?;
        let name=entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("state-") && name.ends_with(".json")
            && name.len()==35) {continue;}
        slots+=1;
        if slots>128{return Err(fail("상태 기록이 너무 많아 자동 판별을 중단했습니다."));}
        let candidate=read_state_file(root,&entry.path())?;
        let version=candidate["version"].as_str().ok_or_else(||fail("상태 버전이 없습니다."))?;
        if name!=state_filename(version){return Err(fail("상태 기록 파일명 충돌입니다."));}
        let created=candidate["createdAt"].as_str().unwrap_or("").to_owned();
        if latest.as_ref().is_none_or(|(previous,_)| created>*previous){
            latest=Some((created,candidate));
        }
    }
    if legacy.exists(){
        let previous=read_state_file(root,&legacy)?;
        let created=previous["createdAt"].as_str().unwrap_or("").to_owned();
        if latest.as_ref().is_none_or(|(current,_)| created>*current){
            return Ok(Some(previous));
        }
    }
    Ok(latest.map(|(_,value)|value))
}

fn check_pending(root:&Path)->Result<bool>{
    let marker=state_root(root)?.join("pending.json");
    if !marker.exists(){return Ok(false);}
    asar::file_only(&marker)?;
    Ok(true)
}

fn archive_path(root:&Path)->PathBuf{root.join("resources").join("app.asar")}

fn entry_exists(path:&Path)->Result<bool>{
    match fs::symlink_metadata(path){
        Ok(_)=>Ok(true),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(false),
        Err(error)=>Err(error.into()),
    }
}

fn copying_stage_path(destination:&Path)->Result<PathBuf>{
    let name=destination.file_name().and_then(|value|value.to_str())
        .ok_or_else(||fail("임시 복사 파일명을 확인할 수 없습니다."))?;
    Ok(destination.with_file_name(format!(".{name}.dino-copying")))
}

fn orphan_transaction_stage(root:&Path)->Result<Option<String>>{
    let resources=root.join("resources");
    for name in [
        "app.asar.dino-writing",
        "app.asar.dino-restore",
        ".app.asar.dino-restore.dino-copying",
    ]{
        let path=resources.join(name);
        if entry_exists(&path)?{
            asar::file_only(&path)?;
            return Ok(Some(name.to_owned()));
        }
    }

    let data=state_root(root)?;
    if !entry_exists(&data)?{return Ok(None);}
    asar::dir_only(&data)?;
    for entry in fs::read_dir(&data)?{
        let entry=entry?;
        let name=entry.file_name().to_string_lossy().into_owned();
        let backup_copy=name.starts_with(".original-") && name.ends_with(".asar.dino-copying");
        let json_copy=name=="pending.json.writing" || name=="state.json.writing"
            || (name.starts_with("state-") && name.ends_with(".json.writing"));
        if backup_copy || json_copy{
            asar::file_only(&entry.path())?;
            return Ok(Some(name));
        }
    }
    Ok(None)
}

fn recovery_stage(
    root:&Path,
    pending:&Value,
    current_sha:&str,
    original_sha:&str,
    patched_sha:&str,
)->Result<Option<PathBuf>>{
    let resources=root.join("resources");
    let writing=resources.join("app.asar.dino-writing");
    let restoring=resources.join("app.asar.dino-restore");
    let restore_copying=copying_stage_path(&restoring)?;
    if entry_exists(&restore_copying)?{
        asar::file_only(&restore_copying)?;
        return Err(fail("복원 임시 파일을 만드는 중단 흔적이 있어 복구 기록을 보존합니다."));
    }

    let data=state_root(root)?;
    if entry_exists(&data)?{
        asar::dir_only(&data)?;
        for entry in fs::read_dir(&data)?{
            let entry=entry?;
            let name=entry.file_name().to_string_lossy().into_owned();
            let backup_copy=name.starts_with(".original-") && name.ends_with(".asar.dino-copying");
            let json_copy=name=="pending.json.writing" || name=="state.json.writing"
                || (name.starts_with("state-") && name.ends_with(".json.writing"));
            if backup_copy || json_copy{
                asar::file_only(&entry.path())?;
                return Err(fail(format!("상태 임시 파일 {name}이 남아 있어 복구 기록을 보존합니다.")));
            }
        }
    }

    let writing_exists=entry_exists(&writing)?;
    let restoring_exists=entry_exists(&restoring)?;
    if writing_exists{asar::file_only(&writing)?;}
    if restoring_exists{asar::file_only(&restoring)?;}
    match (pending["status"].as_str(),current_sha){
        (Some("APPLIED"),current) if current==original_sha=>{
            if restoring_exists{return Err(fail("적용 전 복구 상태와 원본 복원 임시 파일이 충돌합니다."));}
            if writing_exists{
                if sha(&writing)?!=patched_sha{return Err(fail("패치 적용 임시 파일이 복구 기록과 다릅니다."));}
                Ok(Some(writing))
            }else{Ok(None)}
        }
        (Some("APPLIED"),current) if current==patched_sha=>{
            if writing_exists || restoring_exists{return Err(fail("적용 후 예상하지 않은 ASAR 임시 파일이 남아 있습니다."));}
            Ok(None)
        }
        (Some("UNPATCHED"),current) if current==patched_sha=>{
            if writing_exists{return Err(fail("해제 전 복구 상태와 패치 적용 임시 파일이 충돌합니다."));}
            if restoring_exists{
                if sha(&restoring)?!=original_sha{return Err(fail("원본 복원 임시 파일이 백업과 다릅니다."));}
                Ok(Some(restoring))
            }else{Ok(None)}
        }
        (Some("UNPATCHED"),current) if current==original_sha=>{
            if writing_exists || restoring_exists{return Err(fail("복원 후 예상하지 않은 ASAR 임시 파일이 남아 있습니다."));}
            Ok(None)
        }
        _=>Err(fail("복구 상태와 현재 원본 파일이 일치하지 않습니다.")),
    }
}

pub fn inspect(root:&Path)->Status {
    let result=(||->Result<Status>{
        let root=installed_root(root)?;
        let archive=Archive::open(&archive_path(&root))?;
        let version=archive.version()?;
        if check_pending(&root)? {
            return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,
                "이전 패치 작업 기록 pending.json이 남아 있습니다. 수동 복구 검증 전에는 원본을 변경하지 않습니다."));
        }
        if let Some(name)=orphan_transaction_stage(&root)?{
            return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,format!(
                "미완료 임시 파일 {name}이 남아 있습니다. 원본을 변경하지 않고 임시 파일과 실제 상태를 확인해야 합니다.")));
        }
        let actual=sha(&archive_path(&root))?;
        if let Some(state)=read_state(&root)? {
            if state["version"]!=version || state["patchVersion"]!=PATCH_VERSION {
                // Official updates need no new allowlist entry: a verified
                // UNPATCHED old generation can coexist with a new generation.
                // A different patch version or a stale APPLIED record is never
                // silently adopted.
                if state["version"]!=version
                    && state["patchVersion"]==PATCH_VERSION
                    && matches!(state["status"].as_str(),Some("UNPATCHED"|"APPLIED")) {
                    let previous_backup=backup_for_state(&root,&state)?;
                    let expected=state["originalSha256"].as_str().unwrap_or("");
                    if expected.len()==64 && sha(&previous_backup)?==expected
                        && actual!=expected && replacements(&archive,&version).is_ok() {
                        let mut updated=Status::new("UNPATCHED",&version,
                            "업데이트된 LilacAnime의 패치 연결 구조가 호환됩니다. 이전 원본 백업을 보존하며 새 버전용 백업으로 수동 적용할 수 있습니다.");
                        updated.manually_uninstalled=state["status"]=="UNPATCHED";
                        return Ok(updated);
                    }
                }
                let recorded_app=state["version"].as_str().unwrap_or("없음")
                    .chars().take(32).collect::<String>();
                let recorded_patch=state["patchVersion"].as_str().unwrap_or("없음")
                    .chars().take(32).collect::<String>();
                return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,format!(
                    "버전/구조 검증 실패: LilacAnime 기록 v{recorded_app}, 현재 v{version}; DinoPatch 기록 v{recorded_patch}, 현재 v{PATCH_VERSION}. 기존 상태와 백업은 보존합니다."
                )));
            }
            let original=state["originalSha256"].as_str().unwrap_or("");
            let patched=state["patchedSha256"].as_str().unwrap_or("");
            let composition = match state_composition(&state) {
                Ok(set) => set,
                Err(error) => {
                    return Ok(Status::new(
                        "PARTIAL_OR_UNKNOWN",
                        &version,
                        format!("패치 조합 기록을 검증할 수 없습니다: {error}"),
                    ));
                }
            };
            if state["status"]=="APPLIED"{
                if actual!=patched {return Ok(Status::new("CONFLICT",&version,"현재 ASAR가 패치 상태 기록의 SHA-256과 다릅니다."));}
                let backup=backup_for_state(&root,&state)?;
                if sha(&backup)?!=original {return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,"원본 ASAR 백업을 검증할 수 없습니다."));}
                if state["compositionId"].is_string() {
                    let revision = recorded_revision(&state, composition)?;
                    let latest = patch_set::latest_installable_revision(composition);
                    let update_available = patch_set::new_install_allowed(composition)
                        && latest.is_some_and(|item| item.number > revision.number);
                    let status = if update_available {
                        "REVISION_UPDATE_AVAILABLE"
                    } else {
                        "APPLIED"
                    };
                    let reason = if update_available {
                        let latest = latest.expect("checked as present");
                        format!("선택 조합 {}의 {} 개정판과 원본 백업을 확인했습니다. 검증된 {} 개정판으로 전환할 수 있습니다.", composition.id(), revision.id, latest.id)
                    } else {
                        format!("선택 조합 {} {} 적용 및 원본 백업 무결성 확인 완료", composition.id(), revision.id)
                    };
                    return Ok(Status::new(status, &version, reason)
                        .with_composition(composition)
                        .with_revision(revision));
                }
                // A user's older verified patch is still safe to uninstall.
                // Never silently replace it, but make the newly embedded
                // integrated/quality runtime available as an explicit choice.
                let bridge_current=archive.read("src/patch03-bridge.js").ok()
                    .as_deref()==Some(PATCH_BRIDGE);
                let css_current=archive.read("src/integrated-search.css").ok()
                    .as_deref()==Some(INTEGRATED_CSS);
                if !bridge_current || !css_current {
                    return Ok(Status::new("APPLIED",&version,
                        "검증된 기존 디노 패치가 적용돼 있습니다. 새 전역 통합 기능을 사용하려면 [디노 패치 해제] 후 [디노 패치 수동 적용]을 누르세요.")
                        .with_composition(composition));
                }
                return Ok(Status::new("APPLIED",&version,"최신 디노 패치 및 원본 백업 무결성 확인 완료")
                    .with_composition(composition));
            }
            if state["status"]=="UNPATCHED" {
                if actual!=original {return Ok(Status::new("CONFLICT",&version,"수동 해제 후 공식 ASAR가 변경되었습니다."));}
                if state["compositionId"].is_string() {
                    let backup = backup_for_state(&root, &state)?;
                    if sha(&backup)? != original {
                        return Ok(Status::new(
                            "PARTIAL_OR_UNKNOWN",
                            &version,
                            "선택 조합의 원본 백업을 검증할 수 없습니다.",
                        ));
                    }
                }
                let mut item=Status::new("UNPATCHED",&version,"수동 해제 상태를 보존합니다.");
                item.manually_uninstalled=true;
                item.composition_id = Some(composition.id());
                if state["revisionId"].is_string() {
                    item.revision_id = state["revisionId"].as_str().map(str::to_owned);
                }
                return Ok(item);
            }
            return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,"패치 기록 상태 값이 올바르지 않습니다."));
        }
        if ["src/integrated-search.js","src/integrated-search.css","src/patch03-bridge.js",
            "src/dino-sqlite-sync.js","electron/dino-work-db.cjs"]
            .iter().any(|x|archive.contains(x)) {
            return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,"기존 패치 모듈은 있으나 검증된 패치 기록이 없습니다."));
        }
        match replacements(&archive,&version) {
            Ok(_)=>Ok(Status::new("UNPATCHED",&version,
                "버전 번호 제한 없이 패치 연결 구조와 원본 앱 식별을 확인했습니다.")),
            Err(err)=>Ok(Status::new("UNSUPPORTED",&version,err.to_string())),
        }
    })();
    match result {
        Ok(value)=>value,
        Err(err)=>Status::new("PARTIAL_OR_UNKNOWN","",err.to_string()),
    }
}

fn ensure_state_dir(root:&Path)->Result<PathBuf>{
    let data=state_root(root)?;
    let appdata=appdata()?;
    let parent=appdata.join("DinoPatchManager");
    let installed=parent.join("installed-asar");
    for folder in [&parent,&installed,&data] {
        if folder.exists(){asar::dir_only(folder)?;}
        else {fs::create_dir(folder)?; asar::dir_only(folder)?;}
    }
    Ok(data)
}

fn write_json_atomic(path:&Path, data:&Value)->Result<()> {
    if path.exists(){asar::file_only(path)?;}
    let stage=path.with_extension("json.writing");
    let mut out=OpenOptions::new().write(true).create_new(true).open(&stage)?;
    let bytes=serde_json::to_vec_pretty(data)?;
    let outcome=(||->Result<()>{
        out.write_all(&bytes)?;
        out.sync_all()?;
        drop(out);
        fs::rename(&stage,path)?;
        Ok(())
    })();
    if outcome.is_err(){let _=fs::remove_file(stage);}
    outcome
}

fn copy_new(source:&Path,destination:&Path)->Result<()> {
    copy_new_with(source,destination,|input,output|std::io::copy(input,output))
}

fn copy_new_with(
    source:&Path,
    destination:&Path,
    copy:impl FnOnce(&mut File,&mut File)->std::io::Result<u64>,
)->Result<()> {
    asar::file_only(source)?;
    let expected=sha(source)?;
    if entry_exists(destination)?{
        return Err(fail("복사 대상 파일이 이미 있어 덮어쓰지 않습니다."));
    }
    let stage=copying_stage_path(destination)?;
    let stage_file=OpenOptions::new().write(true).create_new(true).open(&stage)?;
    let stage_for_copy=stage.clone();
    let result=(move ||->Result<()>{
        let mut input=File::open(source)?;
        let mut output=stage_file;
        copy(&mut input,&mut output)?;
        output.sync_all()?;
        drop(output);
        if sha(&stage_for_copy)?!=expected || sha(source)?!=expected{
            return Err(fail("복사 중 원본 또는 임시 파일의 SHA-256이 달라졌습니다."));
        }
        // A same-directory hard link publishes the fully written file without
        // replacing a destination that appeared after the initial check.
        fs::hard_link(&stage_for_copy,destination)?;
        fs::remove_file(&stage_for_copy)?;
        Ok(())
    })();
    if result.is_err(){let _=fs::remove_file(&stage);}
    result
}

#[cfg(windows)]
fn assert_not_running() -> Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    unsafe{
        let handle=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);
        if handle==INVALID_HANDLE_VALUE{return Err(fail("Windows 앱 실행 상태를 검사할 수 없습니다."));}
        let mut process=std::mem::zeroed::<PROCESSENTRY32W>();
        process.dwSize=std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut result=Process32FirstW(handle,&mut process);
        if result==0{
            CloseHandle(handle);
            return Err(fail("Windows 프로세스 조회가 실패했습니다."));
        }
        while result!=0{
            let length=process.szExeFile.iter().position(|&x|x==0).unwrap_or(process.szExeFile.len());
            let name=String::from_utf16_lossy(&process.szExeFile[..length]);
            if name.eq_ignore_ascii_case("LilacAnime.exe") || name.eq_ignore_ascii_case("electron.exe"){
                CloseHandle(handle);
                return Err(fail("LilacAnime 또는 Electron이 실행 중입니다. 원본을 종료한 뒤 다시 시도하세요."));
            }
            result=Process32NextW(handle,&mut process);
        }
        CloseHandle(handle);
    }
    Ok(())
}
#[cfg(not(windows))]
fn assert_not_running()->Result<()>{
    Err(fail("실제 설치본 패치 쓰기는 Windows 빌드에서만 지원합니다."))
}

pub fn apply(root:&Path,manual:bool)->Result<Status>{
    let root=installed_root(root)?;
    let current=inspect(&root);
    if current.status=="APPLIED" {return Ok(Status::new("ALREADY_APPLIED",&current.version,"이미 패치되어 있습니다."));}
    if current.status!="UNPATCHED" {return Ok(current);}
    if current.manually_uninstalled && !manual {return Ok(current);}
    assert_not_running()?;
    // Repeat all identity and filesystem checks inside the write action.
    let archive=Archive::open(&archive_path(&root))?;
    let version=archive.version()?;
    let changes=replacements(&archive,&version)?;
    let original_sha=sha(&archive_path(&root))?;
    let data_root=ensure_state_dir(&root)?;
    let previous=read_state(&root)?;
    let updated=previous.as_ref().is_some_and(|state|state["version"]!=version);
    if updated {
        let state=previous.as_ref().ok_or_else(||fail("이전 상태 기록이 없습니다."))?;
        if !matches!(state["status"].as_str(),Some("UNPATCHED"|"APPLIED"))
            || state["patchVersion"]!=PATCH_VERSION {
            return Err(fail("이전 패치 상태가 검증되지 않아 버전 전환을 중단했습니다."));
        }
        let old_backup=backup_for_state(&root,state)?;
        let old_sha=state["originalSha256"].as_str().unwrap_or("");
        if old_sha.len()!=64 || sha(&old_backup)?!=old_sha {
            return Err(fail("이전 원본 백업이 상태 기록과 다릅니다. 버전 전환을 중단했습니다."));
        }
        if original_sha==old_sha {
            return Err(fail("앱 버전은 바뀌었지만 원본 해시가 동일합니다. 상태 기록을 확인해 주세요."));
        }
    }
    let new_filename=if updated || previous.as_ref().is_some_and(|x|x["backupFile"].is_string()){
        backup_filename(&version)
    }else{"original-app.asar".into()};
    let backup=data_root.join(&new_filename);
    if backup.exists() {
        if sha(&backup)?!=original_sha {return Err(fail("기존 백업이 현재 원본과 다릅니다. 덮어쓰지 않습니다."));}
    }else {
        copy_new(&archive_path(&root),&backup)?;
        if sha(&backup)?!=original_sha {return Err(fail("새 원본 백업의 SHA-256 검증 실패"));}
    }
    let temp=root.join("resources").join("app.asar.dino-writing");
    if temp.exists(){return Err(fail("이전 패치 임시 파일이 있어 중단합니다."));}
    archive.write_modified(&temp,&changes)?;
    // Pending record MUST exist before the first modification to app.asar.
    let pending=data_root.join("pending.json");
    if pending.exists() {return Err(fail("이전 패치 복구 기록이 남아 있습니다."));}
    if sha(&archive_path(&root))?!=original_sha {return Err(fail("패치 준비 중 원본이 바뀌었습니다."));}
    let new_sha=sha(&temp)?;
    let at=Utc::now();
    let state=json!({
        "schemaVersion":1,
        "target":root.to_string_lossy(),
        "version":version,
        "patchVersion":PATCH_VERSION,
        "status":"APPLIED",
        "originalSha256":original_sha,
        "patchedSha256":new_sha,
        "backupId":at.format("%Y%m%dT%H%M%SZ").to_string(),
        "createdAt":at.to_rfc3339(),
        "backupFile":if new_filename=="original-app.asar"{Value::Null}else{json!(new_filename)}
    });
    write_json_atomic(&pending,&state)?;
    // From this point, never delete pending.json on failure.
    fs::rename(&temp,archive_path(&root))?;
    // Keep the pending recovery record intact on disk corruption or a
    // partially completed replacement. Never acknowledge an unverified ASAR.
    if sha(&archive_path(&root))?!=new_sha {
        return Err(fail("패치 파일 교체 후 SHA-256 검증 실패. 복구 기록을 보존합니다."));
    }
    write_state(&root,&state)?;
    fs::remove_file(&pending)?;
    let after=inspect(&root);
    if after.status!="APPLIED" {return Err(fail(format!("패치 후 상태 재검사 실패: {}",after.reason)));}
    Ok(after)
}

pub fn apply_selection(root: &Path, set: PatchSet, manual: bool) -> Result<Status> {
    let root = installed_root(root)?;
    if !patch_set::new_install_allowed(set) {
        return Err(fail(
            "03 포함 조합의 신규 적용은 보류 중입니다. 기존 적용본은 해제하거나 01·02 지원 조합으로 변경할 수 있습니다.",
        ));
    }
    let capability = patch_set::combination_capability(set);
    if capability.manager_install != ManagerInstallSupport::Supported {
        return Err(fail("선택한 패치 조합은 관리자 설치가 지원되지 않습니다."));
    }
    let current = inspect(&root);
    if !matches!(current.status.as_str(), "UNPATCHED" | "APPLIED" | "REVISION_UPDATE_AVAILABLE") {
        return Ok(current);
    }
    let legacy_single = set.id() == "01";
    if legacy_single && current.version != patch_set::VERIFIED_APP_VERSION {
        if current.status == "UNPATCHED" {
            return apply(&root, manual);
        }
        // Preserve the established structural 01 route for supported app
        // generations whose original SHA is not part of the fixed v0.5.65
        // composition catalog. Preflight the exact legacy replacement before
        // restoring anything, then keep both transaction steps journaled.
        let state = read_state(&root)?.ok_or_else(|| fail("기존 01 적용 기록이 없습니다."))?;
        let backup = backup_for_state(&root, &state)?;
        let backup_archive = Archive::open(&backup)?;
        if sha(&backup)? != state["originalSha256"].as_str().unwrap_or("")
            || replacements(&backup_archive, &current.version).is_err()
        {
            return Err(fail("기존 01 패치를 안전하게 재구성할 수 없어 조합 전환을 중단했습니다."));
        }
        archive_transition_state(&root, &state)?;
        let removed = uninstall(&root)?;
        if removed.status != "UNPATCHED" {
            return Err(fail(format!("기존 조합을 안전하게 해제하지 못했습니다: {}", removed.reason)));
        }
        return apply(&root, true);
    }
    install_verified_selection(&root, set, manual)
}

pub fn uninstall(root:&Path)->Result<Status>{
    let root=installed_root(root)?;
    let checked=inspect(&root);
    if checked.status=="UNPATCHED" {return Ok(Status::new("ALREADY_UNPATCHED",&checked.version,"이미 패치 해제 상태입니다."));}
    if !matches!(checked.status.as_str(), "APPLIED" | "REVISION_UPDATE_AVAILABLE") {
        return Err(fail(format!("원복 전 상태 확인 실패: {}",checked.reason)));
    }
    assert_not_running()?;
    let state=read_state(&root)?.ok_or_else(||fail("설치본 패치 상태 기록이 없습니다."))?;
    let source=backup_for_state(&root,&state)?;
    let archive=archive_path(&root);
    if sha(&source)?!=state["originalSha256"].as_str().unwrap_or("")
        || sha(&archive)?!=state["patchedSha256"].as_str().unwrap_or("") {
        return Err(fail("원본 백업 또는 패치 상태 해시가 달라 복원을 차단했습니다."));
    }
    let temp=root.join("resources").join("app.asar.dino-restore");
    if temp.exists(){return Err(fail("이전 복원 임시 파일이 남아 있습니다."));}
    copy_new(&source,&temp)?;
    if sha(&temp)?!=state["originalSha256"].as_str().unwrap_or("") {
        return Err(fail("임시 복원 ASAR 검증 실패"));
    }
    // Record the intended uninstall BEFORE mutating app.asar. A power loss
    // between the atomic swap and state write is now recoverable through the
    // same verified pending record used for patch application.
    let data=state_root(&root)?;
    let pending=data.join("pending.json");
    if pending.exists(){return Err(fail("이전 미완료 패치 기록이 있습니다. 복구 검증이 필요합니다."));}
    let mut new=state.clone();
    new["status"]=json!("UNPATCHED");
    write_json_atomic(&pending,&new)?;
    fs::rename(&temp,&archive)?;
    if sha(&archive)?!=state["originalSha256"].as_str().unwrap_or("") {
        return Err(fail("복원 파일 교체 후 SHA-256 검증 실패. 복구 기록을 보존합니다."));
    }
    write_state(&root,&new)?;
    fs::remove_file(&pending)?;
    let done=inspect(&root);
    if done.status!="UNPATCHED" {return Err(fail("패치 해제 후 검사 실패"));}
    Ok(done)
}

pub fn review_recovery(root:&Path)->Result<Status>{
    let root=installed_root(root)?;
    let version=Archive::open(&archive_path(&root))?.version()?;
    let data_root=state_root(&root)?;
    asar::dir_only(&data_root)?;
    let marker=data_root.join("pending.json");
    asar::file_only(&marker)?;
    let pending:Value=serde_json::from_slice(&fs::read(&marker)?)?;
    if pending["schemaVersion"]!=1 || pending["target"]!=root.to_string_lossy().as_ref()
        || pending["version"]!=version || pending["patchVersion"]!=PATCH_VERSION
        || !matches!(pending["status"].as_str(), Some("APPLIED"|"UNPATCHED")) {
        return Err(fail("복구 기록의 설치 대상·버전·상태가 현재와 다릅니다."));
    }
    let original=pending["originalSha256"].as_str().ok_or_else(||fail("원본 SHA-256 기록 없음"))?;
    let patched=pending["patchedSha256"].as_str().ok_or_else(||fail("패치 SHA-256 기록 없음"))?;
    let valid_sha=|x:&str| x.len()==64 && x.bytes().all(|b|b.is_ascii_hexdigit() && !b.is_ascii_lowercase());
    if !valid_sha(original)||!valid_sha(patched)||original==patched {return Err(fail("복구 SHA-256 형식이 올바르지 않습니다."));}
    if pending["transactionType"] != "COMPOSITION_TRANSITION" {
        if pending["compositionId"].is_string() {
            recorded_composition(&pending)?;
        } else if pending.get("revisionId").is_some() || pending.get("revisionNumber").is_some() {
            return Err(fail("복구 기록에 조합 ID가 없는 개정판 정보가 있습니다."));
        }
    }
    let backup=backup_for_state(&root,&pending)?;
    if sha(&backup)?!=original {return Err(fail("백업 SHA-256이 복구 기록과 다릅니다."));}
    let current_sha=sha(&archive_path(&root))?;
    if pending["transactionType"] == "COMPOSITION_TRANSITION" {
        let (source_set, target_set) = review_composition_transition(&root, &pending, &current_sha)?;
        let active_set = if current_sha == pending["patchedSha256"].as_str().unwrap_or("") {
            target_set
        } else {
            source_set
        };
        return Ok(Status {
            status: "PARTIAL_OR_UNKNOWN".into(),
            version,
            reason: format!(
                "패치 조합 전환 복구 기록이 검증됐습니다. 현재 확인된 조합은 {}입니다.",
                active_set.id()
            ),
            composition_id: Some(active_set.id()),
            revision_id: None,
            recovery_available: true,
            manually_uninstalled: false,
        });
    }
    let mode=if current_sha==patched {"APPLIED"} else if current_sha==original {"UNPATCHED"} else {
        return Err(fail("현재 ASAR가 복구 기록의 원본·패치본과 다릅니다."));
    };
    recovery_stage(&root,&pending,&current_sha,original,patched)?;
    if let Some(state)=read_state(&root)?{
        if state["version"]!=version {
            // The pending record is a new official generation. The previous
            // UNPATCHED state and its backup must remain valid and untouched.
            let old_backup=backup_for_state(&root,&state)?;
            if !matches!(state["status"].as_str(),Some("UNPATCHED"|"APPLIED"))
                || state["patchVersion"]!=PATCH_VERSION
                || sha(&old_backup)?!=state["originalSha256"].as_str().unwrap_or("") {
                return Err(fail("새 버전 복구 기록과 이전 상태가 충돌합니다."));
            }
        }else{
            if state["patchVersion"]!=PATCH_VERSION || state["originalSha256"]!=original {
                return Err(fail("기존 상태 기록이 pending과 충돌합니다."));
            }
            if state["status"]=="APPLIED" && state["patchedSha256"]!=current_sha
                && !(pending["status"]=="UNPATCHED" && current_sha==original) {
                return Err(fail("기록된 적용 파일 SHA-256과 실제 파일이 다릅니다."));
            }
        }
    }
    Ok(Status { status:"PARTIAL_OR_UNKNOWN".into(), version,
        reason:format!("검증된 복구 기록입니다. 현재 ASAR는 {mode} 상태입니다. 확인된 임시 파일이 있으면 해당 작업의 해시 검증 후에만 정리합니다."),
        composition_id: recorded_composition(&pending)?.map(|set| set.id()),
        revision_id: None,
        recovery_available:true, manually_uninstalled:mode=="UNPATCHED" })
}

pub fn recover(root:&Path)->Result<Status>{
    let root=installed_root(root)?;
    assert_not_running()?;
    let verified=review_recovery(&root)?;
    if !verified.recovery_available {return Err(fail("복구 가능성이 검증되지 않았습니다."));}
    let data=state_root(&root)?;
    let marker=data.join("pending.json");
    let original_sha=sha(&marker)?;
    let mut state:Value=serde_json::from_slice(&fs::read(&marker)?)?;
    if state["transactionType"] == "COMPOSITION_TRANSITION" {
        let current_sha = sha(&archive_path(&root))?;
        let (source_set, target_set) = review_composition_transition(&root, &state, &current_sha)?;
        let source_sha = state["previousPatchedSha256"]
            .as_str()
            .ok_or_else(|| fail("전환 이전 결과 지문이 없습니다."))?
            .to_owned();
        let target_sha = state["patchedSha256"]
            .as_str()
            .ok_or_else(|| fail("전환 대상 결과 지문이 없습니다."))?
            .to_owned();
        let stage = root.join("resources").join("app.asar.dino-writing");
        if current_sha == target_sha {
            state = clean_transition_record(state);
        } else {
            state = state["previousState"].clone();
            if entry_exists(&stage)? {
                if sha(&stage)? != target_sha || sha(&archive_path(&root))? != source_sha {
                    return Err(fail("전환 임시 파일 또는 기존 조합이 복구 직전에 변경됐습니다."));
                }
                fs::remove_file(&stage)?;
            }
        }
        if sha(&marker)? != original_sha
            || sha(&archive_path(&root))? != current_sha
            || sha(&backup_for_state(&root, &state)?)?
                != state["originalSha256"].as_str().unwrap_or("")
        {
            return Err(fail("조합 전환 복구 중 저널·설치 파일·백업이 변경됐습니다."));
        }
        if current_sha == target_sha
            && (state_composition(&state)? != target_set || state["patchedSha256"] != target_sha)
        {
            return Err(fail("전환 대상 상태 기록을 검증할 수 없습니다."));
        }
        if current_sha == source_sha
            && (state_composition(&state)? != source_set || state["patchedSha256"] != source_sha)
        {
            return Err(fail("전환 이전 상태 기록을 복원할 수 없습니다."));
        }
        let archived = data.join(format!(
            "pending.reconciled-{}.json",
            Utc::now().format("%Y%m%dT%H%M%S%6fZ")
        ));
        if entry_exists(&archived)? {
            return Err(fail("복구 기록 보관 파일이 이미 존재합니다."));
        }
        write_state(&root, &state)?;
        fs::rename(&marker, archived)?;
        return Ok(inspect(&root));
    }
    let pending_record=state.clone();
    let current_sha=sha(&archive_path(&root))?;
    let original=state["originalSha256"].as_str().ok_or_else(||fail("원본 SHA-256 기록 없음"))?.to_owned();
    let patched=state["patchedSha256"].as_str().ok_or_else(||fail("패치 SHA-256 기록 없음"))?.to_owned();
    let target_mode=if current_sha==patched {"APPLIED"} else if current_sha==original {"UNPATCHED"} else {
        return Err(fail("복구 중 원본 파일이 기록된 해시와 달라졌습니다."));
    };
    let staged=recovery_stage(&root,&state,&current_sha,&original,&patched)?;
    if sha(&marker)?!=original_sha || sha(&backup_for_state(&root,&state)?)?!=original {
        return Err(fail("복구 검증 직후 기록 또는 원본 백업이 바뀌었습니다."));
    }
    state["status"]=json!(target_mode);
    let archived=data.join(format!("pending.reconciled-{}.json",Utc::now().format("%Y%m%dT%H%M%S%6fZ")));
    if archived.exists() {return Err(fail("복구 기록 보관 파일이 이미 존재합니다."));}
    write_state(&root,&state)?;
    if let Some(stage)=staged{
        if sha(&marker)?!=original_sha || sha(&archive_path(&root))?!=current_sha
            || sha(&backup_for_state(&root,&state)?)?!=original {
            return Err(fail("복구 정리 중 원본 또는 기록이 바뀌어 임시 파일을 보존했습니다."));
        }
        let rechecked=recovery_stage(&root,&pending_record,&current_sha,&original,&patched)?;
        if rechecked.as_deref()!=Some(stage.as_path()){
            return Err(fail("복구 임시 파일이 재검사 중 달라져 보존했습니다."));
        }
        fs::remove_file(&stage)?;
    }
    fs::rename(&marker,archived)?;
    Ok(inspect(&root))
}

pub fn backups(root:&Path)->Result<Value>{
    let root=installed_root(root)?;
    let state=read_state(&root)?;
    if let Some(state)=state {
        if state["version"]!=Archive::open(&archive_path(&root))?.version()? {
            return Ok(json!({"items":[]}));
        }
        let backup=backup_for_state(&root,&state)?;
        if backup.exists() {
            let verified=sha(&backup).ok().as_deref()==state["originalSha256"].as_str();
            return Ok(json!({"items":[{
                "id":state["backupId"],"version":state["version"],"createdAt":state["createdAt"],
                "restorable":state["status"]=="APPLIED" && verified
            }]}));
        }
    }
    Ok(json!({"items":[]}))
}

pub fn restore(root:&Path,backup_id:&str)->Result<Status>{
    let root=installed_root(root)?;
    let state=read_state(&root)?.ok_or_else(||fail("기록된 백업이 없습니다."))?;
    if state["version"]!=Archive::open(&archive_path(&root))?.version()? {
        return Err(fail("백업은 이전 공식 앱 버전에 해당합니다. 현재 버전에 복원하지 않습니다."));
    }
    if state["backupId"].as_str()!=Some(backup_id){
        return Err(fail("선택한 백업 ID가 기록과 다릅니다."));
    }
    uninstall(&root)
}

fn review_composition_transition(
    root: &Path,
    pending: &Value,
    current_sha: &str,
) -> Result<(PatchSet, PatchSet)> {
    if pending["transactionType"] != "COMPOSITION_TRANSITION"
        || pending["status"] != "APPLIED"
        || pending["version"] != patch_set::VERIFIED_APP_VERSION
    {
        return Err(fail("패치 조합 전환 저널의 형식이 올바르지 않습니다."));
    }
    let target_set = recorded_composition(pending)?
        .ok_or_else(|| fail("전환 대상 패치 조합이 기록되지 않았습니다."))?;
    let target_revision = recorded_revision(pending, target_set)?;
    let target_fingerprint = target_revision.fingerprint;
    let previous = pending["previousState"]
        .as_object()
        .map(|_| &pending["previousState"])
        .ok_or_else(|| fail("전환 저널에 기존 적용 기록이 없습니다."))?;
    let (source_set, source_revision) = validate_transition_source_revision(root, previous)?;
    let source_sha = previous["patchedSha256"]
        .as_str()
        .ok_or_else(|| fail("전환 이전 결과 지문이 없습니다."))?;
    let source_fingerprint = source_revision.fingerprint;
    if source_sha != source_fingerprint.result_sha256
        || pending["previousPatchedSha256"] != source_sha
        || pending["originalSha256"] != previous["originalSha256"]
        || pending["backupFile"] != previous["backupFile"]
        || target_fingerprint.original_sha256 != source_fingerprint.original_sha256
        || target_fingerprint.result_sha256 == source_sha
    {
        return Err(fail("전환 저널의 원본·이전·대상 지문이 서로 일치하지 않습니다."));
    }
    let target_sha = target_fingerprint.result_sha256;
    if current_sha != source_sha && current_sha != target_sha {
        return Err(fail("현재 ASAR가 전환 저널의 기존·대상 SHA-256과 다릅니다."));
    }
    let backup = backup_for_state(root, pending)?;
    if sha(&backup)? != target_fingerprint.original_sha256 {
        return Err(fail("전환 저널의 원본 백업이 검증되지 않았습니다."));
    }

    let resources = root.join("resources");
    let stage = resources.join("app.asar.dino-writing");
    let restore_stage = resources.join("app.asar.dino-restore");
    let restore_copy = copying_stage_path(&restore_stage)?;
    if entry_exists(&restore_stage)? || entry_exists(&restore_copy)? {
        return Err(fail("전환 저널과 별도의 복원 임시 파일이 충돌합니다."));
    }
    if entry_exists(&stage)? {
        asar::file_only(&stage)?;
        if current_sha != source_sha || sha(&stage)? != target_sha {
            return Err(fail("전환 임시 ASAR가 현재 상태 또는 대상 지문과 다릅니다."));
        }
    } else if current_sha == source_sha {
        // A durable pending record may precede stage publication.
    }

    let data = state_root(root)?;
    asar::dir_only(&data)?;
    for entry in fs::read_dir(&data)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let backup_copy = name.starts_with(".original-") && name.ends_with(".asar.dino-copying");
        let json_copy = name == "pending.json.writing"
            || name == "state.json.writing"
            || (name.starts_with("state-") && name.ends_with(".json.writing"));
        if backup_copy || json_copy {
            asar::file_only(&entry.path())?;
            return Err(fail(format!("상태 임시 파일 {name}이 남아 있어 전환 복구를 보류합니다.")));
        }
    }

    let active = read_state(root)?
        .ok_or_else(|| fail("전환 중 활성 패치 상태 기록이 없습니다."))?;
    let active_set = validate_transition_source(root, &active)?;
    let is_source = active_set == source_set && active["patchedSha256"] == source_sha;
    let is_target = active_set == target_set && active["patchedSha256"] == target_sha;
    if !is_source && !(current_sha == target_sha && is_target) {
        return Err(fail("활성 상태 기록이 전환 저널의 기존·대상 조합과 일치하지 않습니다."));
    }
    Ok((source_set, target_set))
}

#[cfg(test)]
mod versionless_tests {
    use super::*;
    use std::sync::Mutex;

    static APPDATA_LOCK: Mutex<()> = Mutex::new(());

    // A minimal official-layout ASAR lets us validate new version numbers
    // without bundling a real LilacAnime installation or user content.
    fn fixture(path:&Path, version:&str, broken:bool)->Result<()>{
        let manifest:Value=serde_json::from_str(MANIFEST)?;
        let mut anchors=BTreeMap::<String,Vec<String>>::new();
        for item in manifest["connections"].as_array().unwrap().iter()
            .chain(manifest["optionalConnections"].as_array().unwrap().iter()){
            let filename=item["file"].as_str().unwrap().to_owned();
            let before=item["before"].as_str().unwrap().to_owned();
            anchors.entry(filename).or_default().push(before);
        }
        let pkg=serde_json::to_vec(&json!({"name":"lilacanime-desktop","version":version}))?;
        let app=anchors["src/app.js"].join("\n\n").into_bytes();
        let mut html=anchors["src/index.html"].join("\n\n");
        if broken {html=html.replace("<script src=\"app.js\"></script>","<script src=\"new-app.js\"></script>");}
        let html=html.into_bytes();
        let player=b"// official player entry\n".to_vec();
        let main=anchors["electron/main.cjs"].join("\n\n").into_bytes();
        let preload=anchors["electron/preload.cjs"].join("\n\n").into_bytes();
        let payloads=[&pkg,&app,&html,&player,&main,&preload];
        let mut offset=0usize;
        let mut positions=Vec::new();
        for bytes in payloads {
            positions.push(json!({"offset":offset.to_string(),"size":bytes.len()}));
            offset+=bytes.len();
        }
        let header=json!({"files":{
            "package.json":positions[0],
            "src":{"files":{
                "app.js":positions[1],"index.html":positions[2],"player.js":positions[3]
            }},
            "electron":{"files":{"main.cjs":positions[4],"preload.cjs":positions[5]}}
        }});
        let serial=serde_json::to_vec(&header)?;
        let padding=(4-serial.len()%4)%4;
        let pickle=8+serial.len()+padding;
        let mut out=File::create(path)?;
        out.write_all(&4u32.to_le_bytes())?;
        out.write_all(&(pickle as u32).to_le_bytes())?;
        out.write_all(&((pickle-4) as u32).to_le_bytes())?;
        out.write_all(&(serial.len() as u32).to_le_bytes())?;
        out.write_all(&serial)?;
        out.write_all(&vec![0u8;padding])?;
        for bytes in payloads {out.write_all(bytes)?;}
        out.sync_all()?;
        Ok(())
    }

    fn transaction_record(root:&Path,version:&str,status:&str,original:&str,patched:&str)->Value{
        let at=Utc::now();
        json!({
            "schemaVersion":1,
            "target":root.to_string_lossy(),
            "version":version,
            "patchVersion":PATCH_VERSION,
            "status":status,
            "originalSha256":original,
            "patchedSha256":patched,
            "backupId":at.format("%Y%m%dT%H%M%SZ").to_string(),
            "createdAt":at.to_rfc3339(),
            "backupFile":Value::Null
        })
    }

    #[test]
    fn failed_copy_does_not_publish_or_overwrite_a_backup() -> Result<()> {
        let base=std::env::temp_dir().join(format!(
            "dino-copy-stage-test-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir_all(&base)?;
        let source=base.join("source.asar");
        let destination=base.join("backup.asar");
        fs::write(&source,b"original backup bytes")?;
        let stage=copying_stage_path(&destination)?;
        let failed=copy_new_with(&source,&destination,|input,output|{
            let mut bytes=[0u8;8];
            let length=input.read(&mut bytes)?;
            output.write_all(&bytes[..length])?;
            Err(std::io::Error::other("injected mid-copy failure"))
        });
        assert!(failed.is_err());
        assert!(!destination.exists());
        assert!(!stage.exists());
        assert_eq!(fs::read(&source)?,b"original backup bytes");

        fs::write(&destination,b"pre-existing verified backup")?;
        let before=fs::read(&destination)?;
        let refused=copy_new(&source,&destination);
        assert!(refused.is_err());
        assert_eq!(fs::read(&destination)?,before);
        assert!(!stage.exists());
        let _=fs::remove_dir_all(&base);
        Ok(())
    }

    #[test]
    fn orphaned_transaction_staging_files_fail_closed_without_touching_asar() -> Result<()> {
        let _guard=APPDATA_LOCK.lock().map_err(|_|fail("APPDATA test lock poisoned"))?;
        let base=std::env::temp_dir().join(format!(
            "dino-orphaned-stage-test-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir_all(&base)?;
        let previous=env::var_os("APPDATA");
        let profile=base.join("isolated-appdata");
        fs::create_dir_all(&profile)?;
        env::set_var("APPDATA",&profile);
        let result=(|| ->Result<()> {
            for (index,name) in [
                "app.asar.dino-writing",
                "app.asar.dino-restore",
                ".original-app.asar.dino-copying",
            ].into_iter().enumerate() {
                let root=base.join(format!("install-{index}"));
                let resources=root.join("resources");
                fs::create_dir_all(&resources)?;
                fs::write(root.join("LilacAnime.exe"),b"DinoPatch test fixture only")?;
                let archive=resources.join("app.asar");
                fixture(&archive,"0.5.65",false)?;
                let canonical_root=installed_root(&root)?;
                let original_sha=sha(&archive)?;
                let temporary=if name.starts_with('.') {
                    let data=state_root(&canonical_root)?;
                    fs::create_dir_all(&data)?;
                    data.join(name)
                } else {resources.join(name)};
                fs::write(&temporary,b"partial transaction data")?;
                let expected_stage=fs::read(&temporary)?;

                let status=inspect(&root);
                assert_eq!(status.status,"PARTIAL_OR_UNKNOWN","{name}: {}",status.reason);
                assert!(status.reason.contains(name),"{name}: {}",status.reason);
                let apply_status=apply(&root,true)?;
                assert_eq!(apply_status.status,"PARTIAL_OR_UNKNOWN","{name}: {}",apply_status.reason);
                assert_eq!(sha(&archive)?,original_sha);
                assert_eq!(fs::read(&temporary)?,expected_stage);
                assert!(!state_root(&canonical_root)?.join("pending.json").exists());
            }
            Ok(())
        })();
        if let Some(value)=previous {env::set_var("APPDATA",value);}
        else {env::remove_var("APPDATA");}
        let _=fs::remove_dir_all(&base);
        result
    }

    #[cfg(windows)]
    #[test]
    fn pending_pre_swap_transactions_reconcile_without_changing_the_known_asar() -> Result<()> {
        let _guard=APPDATA_LOCK.lock().map_err(|_|fail("APPDATA test lock poisoned"))?;
        let base=std::env::temp_dir().join(format!(
            "dino-pre-swap-recovery-test-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir_all(&base)?;
        let previous=env::var_os("APPDATA");
        let profile=base.join("isolated-appdata");
        fs::create_dir_all(&profile)?;
        env::set_var("APPDATA",&profile);
        let result=(|| ->Result<()> {
            // Apply crash window: journal is durable, patched ASAR is staged,
            // but the atomic replacement has not yet happened.
            let apply_root=base.join("apply-install");
            let apply_resources=apply_root.join("resources");
            fs::create_dir_all(&apply_resources)?;
            fs::write(apply_root.join("LilacAnime.exe"),b"DinoPatch test fixture only")?;
            let apply_asar=apply_resources.join("app.asar");
            fixture(&apply_asar,"0.5.65",false)?;
            let apply_root=installed_root(&apply_root)?;
            let original_sha=sha(&apply_asar)?;
            let apply_archive=Archive::open(&apply_asar)?;
            let apply_changes=replacements(&apply_archive,"0.5.65")?;
            let apply_stage=apply_resources.join("app.asar.dino-writing");
            apply_archive.write_modified(&apply_stage,&apply_changes)?;
            let patched_sha=sha(&apply_stage)?;
            let apply_data=state_root(&apply_root)?;
            fs::create_dir_all(&apply_data)?;
            fs::copy(&apply_asar,apply_data.join("original-app.asar"))?;
            let apply_pending=transaction_record(&apply_root,"0.5.65","APPLIED",&original_sha,&patched_sha);
            write_json_atomic(&apply_data.join("pending.json"),&apply_pending)?;

            let before_recovery=review_recovery(&apply_root)?;
            assert!(before_recovery.recovery_available,"{}",before_recovery.reason);
            let recovered= recover(&apply_root)?;
            assert_eq!(recovered.status,"UNPATCHED","{}",recovered.reason);
            assert_eq!(sha(&apply_asar)?,original_sha);
            assert!(!apply_stage.exists());
            assert!(!apply_data.join("pending.json").exists());
            assert!(read_state(&apply_root)?.is_some());

            // Apply post-swap crash window: the new ASAR is installed, while
            // the pending journal still needs to be reconciled into state.
            let post_swap_patch=apply_resources.join("post-swap-patched.asar");
            Archive::open(&apply_asar)?.write_modified(&post_swap_patch,&apply_changes)?;
            let post_swap_sha=sha(&post_swap_patch)?;
            fs::rename(&post_swap_patch,&apply_asar)?;
            let applied_pending=transaction_record(&apply_root,"0.5.65","APPLIED",&original_sha,&post_swap_sha);
            write_json_atomic(&apply_data.join("pending.json"),&applied_pending)?;
            let recovered=recover(&apply_root)?;
            assert_eq!(recovered.status,"APPLIED","{}",recovered.reason);
            assert_eq!(sha(&apply_asar)?,post_swap_sha);
            assert!(!apply_data.join("pending.json").exists());

            // Uninstall post-swap crash window: original ASAR is already
            // restored, so recovery records UNPATCHED without another copy.
            let post_swap_restore=apply_resources.join("post-swap-restored.asar");
            fs::copy(apply_data.join("original-app.asar"),&post_swap_restore)?;
            fs::rename(&post_swap_restore,&apply_asar)?;
            let unpatched_pending=transaction_record(&apply_root,"0.5.65","UNPATCHED",&original_sha,&post_swap_sha);
            write_json_atomic(&apply_data.join("pending.json"),&unpatched_pending)?;
            let recovered=recover(&apply_root)?;
            assert_eq!(recovered.status,"UNPATCHED","{}",recovered.reason);
            assert_eq!(sha(&apply_asar)?,original_sha);
            assert!(!apply_data.join("pending.json").exists());

            // Uninstall crash window: journal is durable, verified original
            // ASAR is staged, while the patched archive remains installed.
            let uninstall_root=base.join("uninstall-install");
            let uninstall_resources=uninstall_root.join("resources");
            fs::create_dir_all(&uninstall_resources)?;
            fs::write(uninstall_root.join("LilacAnime.exe"),b"DinoPatch test fixture only")?;
            let uninstall_asar=uninstall_resources.join("app.asar");
            fixture(&uninstall_asar,"0.5.65",false)?;
            let uninstall_root=installed_root(&uninstall_root)?;
            let uninstall_original_sha=sha(&uninstall_asar)?;
            let uninstall_data=state_root(&uninstall_root)?;
            fs::create_dir_all(&uninstall_data)?;
            fs::copy(&uninstall_asar,uninstall_data.join("original-app.asar"))?;
            let uninstall_archive=Archive::open(&uninstall_asar)?;
            let uninstall_changes=replacements(&uninstall_archive,"0.5.65")?;
            let patched_stage=uninstall_resources.join("patched.asar");
            uninstall_archive.write_modified(&patched_stage,&uninstall_changes)?;
            let uninstall_patched_sha=sha(&patched_stage)?;
            fs::rename(&patched_stage,&uninstall_asar)?;
            assert_eq!(sha(&uninstall_data.join("original-app.asar"))?,uninstall_original_sha);
            let applied=transaction_record(&uninstall_root,"0.5.65","APPLIED",&uninstall_original_sha,&uninstall_patched_sha);
            write_json_atomic(&uninstall_data.join("state.json"),&applied)?;
            let restore_stage=uninstall_resources.join("app.asar.dino-restore");
            fs::copy(&uninstall_data.join("original-app.asar"),&restore_stage)?;
            let pending=transaction_record(&uninstall_root,"0.5.65","UNPATCHED",&uninstall_original_sha,&uninstall_patched_sha);
            write_json_atomic(&uninstall_data.join("pending.json"),&pending)?;

            let before_uninstall_recovery=review_recovery(&uninstall_root)?;
            assert!(before_uninstall_recovery.recovery_available,"{}",before_uninstall_recovery.reason);
            let recovered= recover(&uninstall_root)?;
            assert_eq!(recovered.status,"APPLIED","{}",recovered.reason);
            assert_eq!(sha(&uninstall_asar)?,uninstall_patched_sha);
            assert!(!restore_stage.exists());
            assert!(!uninstall_data.join("pending.json").exists());
            assert_eq!(sha(&uninstall_data.join("original-app.asar"))?,uninstall_original_sha);
            Ok(())
        })();
        if let Some(value)=previous {env::set_var("APPDATA",value);}
        else {env::remove_var("APPDATA");}
        let _=fs::remove_dir_all(&base);
        result
    }

    #[cfg(windows)]
    #[test]
    fn corrupt_pre_swap_stage_keeps_pending_backup_and_official_asar() -> Result<()> {
        let _guard=APPDATA_LOCK.lock().map_err(|_|fail("APPDATA test lock poisoned"))?;
        let base=std::env::temp_dir().join(format!(
            "dino-corrupt-stage-recovery-test-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir_all(&base)?;
        let previous=env::var_os("APPDATA");
        let profile=base.join("isolated-appdata");
        fs::create_dir_all(&profile)?;
        env::set_var("APPDATA",&profile);
        let result=(|| ->Result<()> {
            let raw_root=base.join("install");
            let resources=raw_root.join("resources");
            fs::create_dir_all(&resources)?;
            fs::write(raw_root.join("LilacAnime.exe"),b"DinoPatch test fixture only")?;
            let archive=resources.join("app.asar");
            fixture(&archive,"0.5.65",false)?;
            let root=installed_root(&raw_root)?;
            let original_sha=sha(&archive)?;
            let original=Archive::open(&archive)?;
            let changes=replacements(&original,"0.5.65")?;
            let expected=resources.join("expected-patched.asar");
            original.write_modified(&expected,&changes)?;
            let patched_sha=sha(&expected)?;
            let data=state_root(&root)?;
            fs::create_dir_all(&data)?;
            fs::copy(&archive,data.join("original-app.asar"))?;
            let stage=resources.join("app.asar.dino-writing");
            fs::write(&stage,b"corrupt partial ASAR")?;
            let pending=transaction_record(&root,"0.5.65","APPLIED",&original_sha,&patched_sha);
            let marker=data.join("pending.json");
            write_json_atomic(&marker,&pending)?;
            let marker_before=fs::read(&marker)?;
            let backup_before=sha(&data.join("original-app.asar"))?;
            let stage_before=fs::read(&stage)?;

            assert!(review_recovery(&root).is_err());
            assert_eq!(fs::read(&marker)?,marker_before);
            assert_eq!(sha(&data.join("original-app.asar"))?,backup_before);
            assert_eq!(fs::read(&stage)?,stage_before);
            assert_eq!(sha(&archive)?,original_sha);

            // A valid staged ASAR cannot compensate for a missing or corrupt
            // original backup; both cases must keep the pending journal.
            fs::copy(&expected,&stage)?;
            fs::write(data.join("original-app.asar"),b"corrupt backup")?;
            assert!(review_recovery(&root).is_err());
            assert!(marker.exists());
            assert_eq!(sha(&archive)?,original_sha);
            fs::remove_file(data.join("original-app.asar"))?;
            assert!(review_recovery(&root).is_err());
            assert!(marker.exists());
            assert_eq!(sha(&archive)?,original_sha);
            Ok(())
        })();
        if let Some(value)=previous {env::set_var("APPDATA",value);}
        else {env::remove_var("APPDATA");}
        let _=fs::remove_dir_all(&base);
        result
    }

    #[test]
    fn apply_selection_rejects_new_patch03_before_any_file_or_profile_write() -> Result<()> {
        let base = std::env::temp_dir().join(format!(
            "dino-paused-patch03-apply-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let resources = base.join("resources");
        fs::create_dir_all(&resources)?;
        fs::write(base.join("LilacAnime.exe"), b"test fixture only")?;
        let archive = resources.join("app.asar");
        fs::write(&archive, b"unchanged source marker")?;
        let archive_before = fs::read(&archive)?;

        let unsupported = ["03", "01+03", "02+03", "01+02+03"];
        for id in unsupported {
            let set = PatchSet::parse_id(id).map_err(fail)?;
            let error = apply_selection(&base, set, true).expect_err("new Patch 03 install must be blocked");
            assert!(error.to_string().contains("03 포함 조합의 신규 적용은 보류"), "{id}: {error}");
            assert_eq!(fs::read(&archive)?, archive_before, "{id} must not change app.asar");
            assert_eq!(
                fs::read_dir(&resources)?.count(),
                1,
                "{id} must not create transaction staging files"
            );
        }

        let _ = fs::remove_dir_all(&base);
        Ok(())
    }

    #[test]
    fn unknown_official_version_uses_unique_structural_anchors() -> Result<()> {
        let base=std::env::temp_dir().join(format!(
            "dino-versionless-test-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir(&base)?;
        let valid=base.join("valid.asar");
        let invalid=base.join("incompatible.asar");
        let result=(|| ->Result<()>{
            fixture(&valid,"0.5.999",false)?;
            fixture(&invalid,"0.6.1",true)?;
            let accepted=Archive::open(&valid)?;
            let changes=replacements(&accepted,"0.5.999")?;
            assert_eq!(changes.len(),9);
            assert_eq!(accepted.version()?,"0.5.999");
            let rejected=Archive::open(&invalid)?;
            assert!(replacements(&rejected,"0.6.1").is_err());
            assert_ne!(version_slot("0.5.64"),version_slot("0.5.65"));
            Ok(())
        })();
        let _=fs::remove_dir_all(base);
        result
    }

    #[test]
    fn composition_state_reads_legacy_r1_and_requires_exact_revision_identity() -> Result<()> {
        let set = PatchSet::parse_id("01+02+03").map_err(fail)?;
        let revision = patch_set::registered_revisions(set)
            .into_iter()
            .find(|revision| revision.id == "r1")
            .ok_or_else(|| fail("registered r1 revision is missing"))?;
        let fingerprint = revision.fingerprint;
        let legacy = json!({
            "schemaVersion": 1,
            "patchVersion": PATCH_VERSION,
            "version": fingerprint.app_version,
            "compositionId": set.id(),
            "originalSha256": fingerprint.original_sha256,
            "patchedSha256": fingerprint.result_sha256
        });
        assert_eq!(recorded_composition(&legacy)?, Some(set));
        assert_eq!(recorded_revision(&legacy, set)?.id, "r1");

        let current = composition_state(
            Path::new("isolated-fixture"),
            set,
            revision,
            fingerprint.original_sha256,
            fingerprint.result_sha256,
            None,
        );
        assert_eq!(current["revisionId"], "r1");
        assert_eq!(current["revisionNumber"], 1);
        assert_eq!(recorded_composition(&current)?, Some(set));

        let mut unknown = current.clone();
        unknown["revisionId"] = json!("r2");
        assert!(recorded_composition(&unknown).is_err());

        let mut mismatched_hash = current.clone();
        mismatched_hash["patchedSha256"] = json!("1111111111111111111111111111111111111111111111111111111111111111");
        assert!(recorded_composition(&mismatched_hash).is_err());

        let mut mismatched_number = current.clone();
        mismatched_number["revisionNumber"] = json!(2);
        assert!(recorded_composition(&mismatched_number).is_err());

        let mut missing_number = current;
        missing_number.as_object_mut().unwrap().remove("revisionNumber");
        assert!(recorded_composition(&missing_number).is_err());
        Ok(())
    }
    #[cfg(windows)]
    #[test]
    fn official_updates_keep_historical_backups_and_uninstall_current_version() -> Result<()> {
        let _guard=APPDATA_LOCK.lock().map_err(|_|fail("APPDATA test lock poisoned"))?;
        let dir=std::env::temp_dir().join(format!(
            "dino-version-upgrade-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir(&dir)?;
        let profile=dir.join("AppData");
        let root=dir.join("LilacAnime");
        fs::create_dir(&profile)?;
        fs::create_dir(&root)?;
        fs::create_dir(root.join("resources"))?;
        fs::write(root.join("LilacAnime.exe"),b"DinoPatch test fixture only")?;
        let previous=std::env::var_os("APPDATA");
        std::env::set_var("APPDATA",&profile);
        let result=(||->Result<()>{
            let asar_path=root.join("resources").join("app.asar");
            fixture(&asar_path,"0.5.64",false)?;
            let canonical_root=installed_root(&root)?;
            let ready=inspect(&root);
            assert_eq!(ready.status,"UNPATCHED","{}",ready.reason);
            let first=apply(&root,true)?;
            assert_eq!(first.status,"APPLIED","{}",first.reason);
            assert_eq!(uninstall(&root)?.status,"UNPATCHED");
            let data=state_root(&canonical_root)?;
            let archived_backup=data.join("original-app.asar");
            let original_hash=sha(&archived_backup)?;
            let original_state=fs::read(data.join("state.json"))?;

            // Simulate a newer official installer replacing app.asar with
            // a compatible but previously unregistered release.
            fixture(&asar_path,"0.5.65",false)?;
            let review=inspect(&root);
            assert_eq!(review.status,"UNPATCHED", "{}",review.reason);
            assert!(review.manually_uninstalled);
            let result=apply(&root,true)?;
            assert_eq!(result.status,"APPLIED","{}",result.reason);
            let active=read_state(&canonical_root)?.unwrap();
            assert_eq!(active["version"],"0.5.65");
            assert_eq!(active["backupFile"],backup_filename("0.5.65"));
            assert_eq!(sha(&archived_backup)?,original_hash);
            assert_eq!(fs::read(data.join("state.json"))?,original_state);
            assert_eq!(sha(&backup_for_state(&canonical_root,&active)?)?,
                active["originalSha256"].as_str().unwrap());
            assert_eq!(uninstall(&root)?.status,"UNPATCHED");
            assert_eq!(sha(&asar_path)?,active["originalSha256"].as_str().unwrap());
            assert!(!data.join("pending.json").exists());
            assert_eq!(sha(&archived_backup)?,original_hash);

            // A third official version must inherit the latest generation,
            // rather than mistakenly trying to restore the 0.5.64 original.
            fixture(&asar_path,"0.5.66",false)?;
            let future=inspect(&root);
            assert_eq!(future.status,"UNPATCHED", "{}",future.reason);
            let result=apply(&root,true)?;
            assert_eq!(result.status,"APPLIED","{}",result.reason);
            let latest=read_state(&canonical_root)?.unwrap();
            assert_eq!(latest["version"],"0.5.66");
            assert_eq!(uninstall(&root)?.status,"UNPATCHED");
            assert_eq!(sha(&archived_backup)?,original_hash);
            assert_eq!(fs::read(data.join("state.json"))?,original_state);
            Ok(())
        })();
        if let Some(value)=previous {std::env::set_var("APPDATA",value);}
        else {std::env::remove_var("APPDATA");}
        let _=fs::remove_dir_all(dir);
        result
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "isolated real-ASAR install, transition, recovery, and restore verification"]
    fn isolated_legacy_patch03_records_transition_to_supported_sets_and_restore_official_source() -> Result<()> {
        use std::ffi::OsString;

        struct RestoreEnv(Option<OsString>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                if let Some(value) = self.0.take() {
                    env::set_var("APPDATA", value);
                } else {
                    env::remove_var("APPDATA");
                }
            }
        }

        let _guard = APPDATA_LOCK.lock().map_err(|_| fail("APPDATA test lock poisoned"))?;
        let evidence_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../validation-evidence")
            .canonicalize()?;
        let run_root = env::var_os("DINO_COMBO_INSTALL_E2E_ROOT")
            .map(PathBuf::from)
            .ok_or_else(|| fail("isolated E2E evidence directory was not provided"))?;
        let run_parent = run_root
            .parent()
            .ok_or_else(|| fail("isolated E2E root must be directly under validation-evidence"))?
            .canonicalize()?;
        if run_parent != evidence_root || run_root.file_name().is_none() || entry_exists(&run_root)? {
            return Err(fail("isolated E2E root must be a new direct child of validation-evidence"));
        }
        fs::create_dir(&run_root)?;
        let run_root = run_root.canonicalize()?;
        if !run_root.starts_with(&evidence_root) {
            return Err(fail("isolated E2E root escaped the repository evidence directory"));
        }

        let fixtures = [
            ("03", "r1", "02", "beta9-composition-preview-20261122/sets/03/combined.asar"),
            ("01+03", "r1", "01", "beta9-patch-revision-20261124/previews/01+03/combined.asar"),
            ("02+03", "r1", "02", "beta9-composition-preview-20261122/sets/02+03/combined.asar"),
            ("01+02+03", "r1", "01+02", "beta9-patch-revision-20261124/previews/01+02+03/combined.asar"),
            ("01+02+03", "r2", "01+02", "beta9-adult-catalog-r2-20261124/previews/01-02-03-r2/combined.asar"),
        ];
        let official = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../../validation-evidence/beta8-integration-final-20261118/combined-preview-r2/original.asar",
        );
        asar::file_only(&official)?;
        let official_sha = sha(&official)?;
        if official_sha != patch_set::OFFICIAL_V065_SHA256 {
            return Err(fail("provided official v0.5.65 ASAR does not match its recorded SHA-256"));
        }
        let appdata_root = run_root.join("isolated-appdata");
        fs::create_dir(&appdata_root)?;
        let restore_env = RestoreEnv(env::var_os("APPDATA"));
        env::set_var("APPDATA", &appdata_root);
        let mut results = Vec::new();

        let result = (|| -> Result<()> {
            for (index, (source_id, revision_id, target_id, artifact)) in fixtures.into_iter().enumerate() {
                let source_set = PatchSet::parse_id(source_id).map_err(fail)?;
                let target_set = PatchSet::parse_id(target_id).map_err(fail)?;
                if patch_set::new_install_allowed(source_set) || !patch_set::new_install_allowed(target_set) {
                    return Err(fail(format!("invalid legacy transition fixture {source_id} -> {target_id}")));
                }
                let revision = patch_set::registered_revisions(source_set)
                    .into_iter()
                    .find(|item| item.id == revision_id)
                    .ok_or_else(|| fail(format!("registered {source_id} {revision_id} fingerprint is missing")))?;
                let source_archive = evidence_root.join(artifact);
                asar::file_only(&source_archive)?;
                let expected_source_sha = revision.fingerprint.result_sha256;
                if sha(&source_archive)? != expected_source_sha {
                    return Err(fail(format!("legacy {source_id} {revision_id} artifact SHA-256 mismatch")));
                }

                let raw_root = run_root.join(format!("legacy-install-{index}"));
                let resources = raw_root.join("resources");
                fs::create_dir_all(&resources)?;
                fs::write(raw_root.join("LilacAnime.exe"), b"isolated legacy transaction fixture only")?;
                let archive_file = resources.join("app.asar");
                fs::copy(&source_archive, &archive_file)?;
                let root = installed_root(&raw_root)?;
                let data = ensure_state_dir(&root)?;
                let backup_file = backup_filename(patch_set::VERIFIED_APP_VERSION);
                let backup_path = data.join(&backup_file);
                copy_new(&official, &backup_path)?;
                let seeded = composition_state(
                    &root,
                    source_set,
                    revision,
                    &official_sha,
                    expected_source_sha,
                    Some(&backup_file),
                );
                write_state(&root, &seeded)?;

                let before = inspect(&root);
                assert_eq!(before.status, "APPLIED", "{} {}: {}", source_id, revision_id, before.reason);
                assert_eq!(before.composition_id.as_deref(), Some(source_id));
                assert_eq!(before.revision_id.as_deref(), Some(revision_id));
                assert_eq!(sha(&backup_path)?, official_sha);

                let transitioned = apply_selection(&root, target_set, true)?;
                assert_eq!(transitioned.status, "APPLIED", "{} -> {}: {}", source_id, target_id, transitioned.reason);
                assert_eq!(transitioned.composition_id.as_deref(), Some(target_id));
                let target_revision = patch_set::latest_installable_revision(target_set)
                    .ok_or_else(|| fail(format!("target {target_id} has no installable revision")))?;
                assert_eq!(sha(&archive_file)?, target_revision.fingerprint.result_sha256);
                assert_eq!(sha(&backup_path)?, official_sha);

                let active = read_state(&root)?.ok_or_else(|| fail("transition target state is missing"))?;
                assert_eq!(active["compositionId"], target_id);
                assert_eq!(active["backupFile"], backup_file);
                let mut preserved_legacy_record = false;
                for entry in fs::read_dir(&data)? {
                    let entry = entry?;
                    let filename = entry.file_name().to_string_lossy().into_owned();
                    if filename.starts_with("state-history-") && filename.ends_with(".json") {
                        let history = read_state_file(&root, &entry.path())?;
                        if history["compositionId"] == source_id
                            && history["revisionId"] == revision_id
                            && history["patchedSha256"] == expected_source_sha
                        {
                            preserved_legacy_record = true;
                        }
                    }
                }
                assert!(preserved_legacy_record, "legacy state history was not preserved: {source_id} {revision_id}");

                let restored = uninstall(&root)?;
                assert_eq!(restored.status, "UNPATCHED", "{} -> {} restore: {}", source_id, target_id, restored.reason);
                assert_eq!(sha(&archive_file)?, official_sha);
                assert_eq!(sha(&backup_path)?, official_sha);
                results.push(json!({
                    "sourceComposition": source_id,
                    "sourceRevision": revision_id,
                    "sourceSha256": expected_source_sha,
                    "targetComposition": target_id,
                    "targetSha256": target_revision.fingerprint.result_sha256,
                    "restoredOfficialSha256": sha(&archive_file)?,
                    "legacyRecordPreserved": preserved_legacy_record,
                }));
            }

            fs::write(
                run_root.join("legacy-patch03-transition-results.json"),
                serde_json::to_vec_pretty(&json!({
                    "officialOriginalSha256": official_sha,
                    "cases": results,
                }))?,
            )?;
            Ok(())
        })();
        drop(restore_env);
        result
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "isolated real-ASAR install, transition, recovery, and restore verification"]
    fn isolated_official_archive_installs_only_01_02_compositions_and_recovers_transitions() -> Result<()> {
        use std::ffi::OsString;

        struct RestoreEnv(Option<OsString>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                if let Some(value) = self.0.take() {
                    env::set_var("APPDATA", value);
                } else {
                    env::remove_var("APPDATA");
                }
            }
        }

        let _guard = APPDATA_LOCK.lock().map_err(|_| fail("APPDATA test lock poisoned"))?;
        let evidence_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../validation-evidence")
            .canonicalize()?;
        let run_root = env::var_os("DINO_COMBO_INSTALL_E2E_ROOT")
            .map(PathBuf::from)
            .ok_or_else(|| fail("isolated E2E evidence directory was not provided"))?;
        let run_parent = run_root
            .parent()
            .ok_or_else(|| fail("isolated E2E root must be directly under validation-evidence"))?
            .canonicalize()?;
        if run_parent != evidence_root || run_root.file_name().is_none() || entry_exists(&run_root)? {
            return Err(fail("isolated E2E root must be a new direct child of validation-evidence"));
        }
        fs::create_dir(&run_root)?;
        let run_root = run_root.canonicalize()?;
        if !run_root.starts_with(&evidence_root) {
            return Err(fail("isolated E2E root escaped the repository evidence directory"));
        }
        let original = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../../validation-evidence/beta8-integration-final-20261118/combined-preview-r2/original.asar",
        );
        asar::file_only(&original)?;
        if sha(&original)? != patch_set::OFFICIAL_V065_SHA256 {
            return Err(fail("provided official v0.5.65 ASAR does not match its recorded SHA-256"));
        }
        let install = run_root.join("install-copy");
        let resources = install.join("resources");
        fs::create_dir_all(&resources)?;
        fs::write(install.join("LilacAnime.exe"), b"DinoPatch isolated transaction test fixture only")?;
        let installed_archive = resources.join("app.asar");
        fs::copy(&original, &installed_archive)?;
        let appdata_root = run_root.join("isolated-appdata");
        fs::create_dir(&appdata_root)?;
        let unrelated_data = appdata_root.join("unrelated-settings-sentinel.json");
        fs::write(&unrelated_data, br#"{"testOnly":"must remain unchanged"}"#)?;
        let unrelated_data_sha = sha(&unrelated_data)?;
        let restore_env = RestoreEnv(env::var_os("APPDATA"));
        env::set_var("APPDATA", &appdata_root);
        eprintln!("isolated selected-composition E2E evidence: {}", run_root.display());

        let result = (|| -> Result<()> {
            let root = installed_root(&install)?;
            let original_sha = sha(&installed_archive)?;
            assert_eq!(original_sha, patch_set::OFFICIAL_V065_SHA256);
            let mut checked = Vec::new();
            let installable_sets = PatchSet::logical_combinations()
                .into_iter()
                .filter(|set| patch_set::new_install_allowed(*set))
                .collect::<Vec<_>>();
            assert_eq!(
                installable_sets.iter().map(|set| set.id()).collect::<Vec<_>>(),
                ["01", "02", "01+02"]
            );
            for set in installable_sets.iter().copied() {
                let fingerprint = patch_set::combination_capability(set)
                    .fingerprint
                    .ok_or_else(|| fail("a logical composition is missing its registered output fingerprint"))?;
                assert_eq!(fingerprint.original_sha256, original_sha);
                // Exercise explicit installation for the initial configuration,
                // then the exact automatic transaction path for every change.
                let manual = set.id() == "01";
                let installed = apply_selection(&root, set, manual)?;
                assert_eq!(installed.status, "APPLIED", "{}: {}", set.id(), installed.reason);
                assert_eq!(installed.composition_id.as_deref(), Some(set.id().as_str()));
                assert_eq!(sha(&installed_archive)?, fingerprint.result_sha256, "{}", set.id());
                let active = read_state(&root)?.ok_or_else(|| fail("active composition state was not recorded"))?;
                assert_eq!(active["compositionId"], set.id());
                assert_eq!(sha(&backup_for_state(&root, &active)?)?, original_sha);
                assert_eq!(sha(&installed_archive)?, active["patchedSha256"].as_str().unwrap());
                let same = apply_selection(&root, set, true)?;
                assert_eq!(same.status, "ALREADY_APPLIED");
                assert_eq!(same.composition_id.as_deref(), Some(set.id().as_str()));
                checked.push(json!({"compositionId":set.id(),"resultSha256":fingerprint.result_sha256}));
            }

            let before = read_state(&root)?.ok_or_else(|| fail("final composition state was not recorded"))?;
            let target_set = PatchSet::parse_id("01").map_err(fail)?;
            let target_fingerprint = patch_set::combination_capability(target_set)
                .fingerprint
                .ok_or_else(|| fail("transition target fingerprint is missing"))?;
            let backup = backup_for_state(&root, &before)?;
            let (changes, target_revision) = compose_verified_selection(
                &Archive::open(&backup)?,
                &backup,
                target_set,
            )?;
            assert_eq!(target_revision.fingerprint.result_sha256, target_fingerprint.result_sha256);
            let expected_sha = target_revision.fingerprint.result_sha256;

            // Crash after the transition journal is durable, before the atomic swap.
            let stage = resources.join("app.asar.dino-writing");
            Archive::open(&backup)?.write_modified(&stage, &changes)?;
            let pending = composition_transition_record(
                &root,
                &before,
                target_set,
                target_revision,
                original_sha.as_str(),
                expected_sha,
                before["backupFile"].as_str(),
            )?;
            let data = state_root(&root)?;
            archive_transition_state(&root, &before)?;
            write_json_atomic(&data.join("pending.json"), &pending)?;
            assert!(review_recovery(&root)?.recovery_available);
            let recovered = recover(&root)?;
            assert_eq!(recovered.status, "APPLIED", "{}", recovered.reason);
            assert_eq!(recovered.composition_id.as_deref(), Some("01+02"));
            assert!(!stage.exists());
            assert_eq!(sha(&installed_archive)?, before["patchedSha256"].as_str().unwrap());

            // Crash after the atomic swap, before publishing the new state record.
            let before = read_state(&root)?.ok_or_else(|| fail("source composition state is missing"))?;
            Archive::open(&backup)?.write_modified(&stage, &changes)?;
            let pending = composition_transition_record(
                &root,
                &before,
                target_set,
                target_revision,
                original_sha.as_str(),
                expected_sha,
                before["backupFile"].as_str(),
            )?;
            archive_transition_state(&root, &before)?;
            write_json_atomic(&data.join("pending.json"), &pending)?;
            fs::rename(&stage, &installed_archive)?;
            assert_eq!(sha(&installed_archive)?, expected_sha);
            assert!(review_recovery(&root)?.recovery_available);
            let recovered = recover(&root)?;
            assert_eq!(recovered.status, "APPLIED", "{}", recovered.reason);
            assert_eq!(recovered.composition_id.as_deref(), Some("01"));
            assert_eq!(sha(&installed_archive)?, target_fingerprint.result_sha256);
            let target_state = read_state(&root)?.ok_or_else(|| fail("recovered target state is missing"))?;
            assert_eq!(sha(&backup_for_state(&root, &target_state)?)?, original_sha);

            let backup_id = target_state["backupId"].as_str().ok_or_else(|| fail("backup id missing"))?;
            let restored = restore(&root, backup_id)?;
            assert_eq!(restored.status, "UNPATCHED", "{}", restored.reason);
            assert_eq!(sha(&installed_archive)?, original_sha);
            let final_state = read_state(&root)?.ok_or_else(|| fail("restored state is missing"))?;
            let retained_backup_sha = sha(&backup_for_state(&root, &final_state)?)?;
            assert_eq!(retained_backup_sha, original_sha);
            let automatic_after_manual_restore = apply_selection(&root, target_set, false)?;
            assert_eq!(automatic_after_manual_restore.status, "UNPATCHED");
            assert!(automatic_after_manual_restore.manually_uninstalled);
            assert_eq!(sha(&installed_archive)?, original_sha);
            assert!(!data.join("pending.json").exists());
            let mut retained_compositions = fs::read_dir(&data)?
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    name.starts_with("state-history-") && name.ends_with(".json")
                })
                .map(|entry| {
                    let record = read_state_file(&root, &entry.path())?;
                    validate_transition_source(&root, &record)?;
                    Ok(recorded_composition(&record)?.ok_or_else(|| {
                        fail("composition history record is missing its composition id")
                    })?.id())
                })
                .collect::<Result<Vec<_>>>()?;
            retained_compositions.sort();
            retained_compositions.dedup();
            let mut expected_compositions = installable_sets
                .into_iter()
                .map(|set| set.id())
                .collect::<Vec<_>>();
            expected_compositions.sort();
            assert_eq!(retained_compositions, expected_compositions);
            assert_eq!(sha(&unrelated_data)?, unrelated_data_sha);
            fs::write(
                run_root.join("transaction-results.json"),
                serde_json::to_vec_pretty(&json!({
                    "originalSha256": original_sha,
                    "checkedCompositions": checked,
                    "transitionPreSwapRecovery": "source composition retained",
                    "transitionPostSwapRecovery": "target composition committed",
                    "automaticTransitions": "newly installable 01/02 combinations changed through the automatic transaction path",
                    "automaticReapplyAfterManualRestore": "blocked; original remains intact",
                    "restoreSha256": sha(&installed_archive)?,
                    "originalBackupSha256AfterRestore": retained_backup_sha,
                    "transitionHistoryCompositionsRetained": retained_compositions,
                    "unrelatedIsolatedDataSha256AfterRestore": unrelated_data_sha,
                }))?,
            )?;
            Ok(())
        })();
        drop(restore_env);
        result
    }

}
