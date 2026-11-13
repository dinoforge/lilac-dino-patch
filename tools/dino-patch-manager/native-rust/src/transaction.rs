//! Native Rust installed-ASAR patch transaction.
//! This module is deliberately fail-closed. All changes target only an
//! explicitly selected local LilacAnime installation and its manager backup.

use crate::asar::{self, Archive};
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
    pub recovery_available: bool,
    pub manually_uninstalled: bool,
}

impl Status {
    pub fn new(status: &str, version: &str, reason: impl Into<String>) -> Self {
        Self { status:status.into(), version:version.into(), reason:reason.into(), recovery_available:false, manually_uninstalled:false }
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

pub fn inspect(root:&Path)->Status {
    let result=(||->Result<Status>{
        let root=installed_root(root)?;
        let archive=Archive::open(&archive_path(&root))?;
        let version=archive.version()?;
        if check_pending(&root)? {
            return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,
                "이전 패치 작업 기록 pending.json이 남아 있습니다. 수동 복구 검증 전에는 원본을 변경하지 않습니다."));
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
            if state["status"]=="APPLIED"{
                if actual!=patched {return Ok(Status::new("CONFLICT",&version,"현재 ASAR가 패치 상태 기록의 SHA-256과 다릅니다."));}
                let backup=backup_for_state(&root,&state)?;
                if sha(&backup)?!=original {return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,"원본 ASAR 백업을 검증할 수 없습니다."));}
                // A user's older verified patch is still safe to uninstall.
                // Never silently replace it, but make the newly embedded
                // integrated/quality runtime available as an explicit choice.
                let bridge_current=archive.read("src/patch03-bridge.js").ok()
                    .as_deref()==Some(PATCH_BRIDGE);
                let css_current=archive.read("src/integrated-search.css").ok()
                    .as_deref()==Some(INTEGRATED_CSS);
                if !bridge_current || !css_current {
                    return Ok(Status::new("APPLIED",&version,
                        "검증된 기존 디노 패치가 적용돼 있습니다. 새 전역 통합 기능을 사용하려면 [디노 패치 해제] 후 [디노 패치 수동 적용]을 누르세요."));
                }
                return Ok(Status::new("APPLIED",&version,"최신 디노 패치 및 원본 백업 무결성 확인 완료"));
            }
            if state["status"]=="UNPATCHED" {
                if actual!=original {return Ok(Status::new("CONFLICT",&version,"수동 해제 후 공식 ASAR가 변경되었습니다."));}
                let mut item=Status::new("UNPATCHED",&version,"수동 해제 상태를 보존합니다.");
                item.manually_uninstalled=true;
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
    asar::file_only(source)?;
    let mut src=File::open(source)?;
    let mut out=OpenOptions::new().create_new(true).write(true).open(destination)?;
    std::io::copy(&mut src,&mut out)?;
    out.sync_all()?;
    Ok(())
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

pub fn uninstall(root:&Path)->Result<Status>{
    let root=installed_root(root)?;
    let checked=inspect(&root);
    if checked.status=="UNPATCHED" {return Ok(Status::new("ALREADY_UNPATCHED",&checked.version,"이미 패치 해제 상태입니다."));}
    if checked.status!="APPLIED" {return Err(fail(format!("원복 전 상태 확인 실패: {}",checked.reason)));}
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
    for name in ["app.asar.dino-writing","app.asar.dino-restore"] {
        if root.join("resources").join(name).exists() {return Err(fail("미완료 ASAR 임시 파일이 남아 있어 복구 기록을 보존합니다."));}
    }
    let original=pending["originalSha256"].as_str().ok_or_else(||fail("원본 SHA-256 기록 없음"))?;
    let patched=pending["patchedSha256"].as_str().ok_or_else(||fail("패치 SHA-256 기록 없음"))?;
    let valid_sha=|x:&str| x.len()==64 && x.bytes().all(|b|b.is_ascii_hexdigit() && !b.is_ascii_lowercase());
    if !valid_sha(original)||!valid_sha(patched)||original==patched {return Err(fail("복구 SHA-256 형식이 올바르지 않습니다."));}
    let backup=backup_for_state(&root,&pending)?;
    if sha(&backup)?!=original {return Err(fail("백업 SHA-256이 복구 기록과 다릅니다."));}
    let current_sha=sha(&archive_path(&root))?;
    let mode=if current_sha==patched {"APPLIED"} else if current_sha==original {"UNPATCHED"} else {
        return Err(fail("현재 ASAR가 복구 기록의 원본·패치본과 다릅니다."));
    };
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
        reason:format!("검증된 복구 기록입니다. 현재 ASAR는 {mode} 상태입니다. 명시적 복구 명령으로 기록을 정리할 수 있습니다."),
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
    let target_mode=if sha(&archive_path(&root))?==state["patchedSha256"].as_str().unwrap_or("") {"APPLIED"} else {"UNPATCHED"};
    if sha(&marker)?!=original_sha || sha(&backup_for_state(&root,&state)?)?!=state["originalSha256"].as_str().unwrap_or("") {
        return Err(fail("복구 검증 직후 기록 또는 원본 백업이 바뀌었습니다."));
    }
    state["status"]=json!(target_mode);
    let archived=data.join(format!("pending.reconciled-{}.json",Utc::now().format("%Y%m%dT%H%M%S%6fZ")));
    if archived.exists() {return Err(fail("복구 기록 보관 파일이 이미 존재합니다."));}
    write_state(&root,&state)?;
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

#[cfg(test)]
mod versionless_tests {
    use super::*;

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
    #[cfg(windows)]
    #[test]
    fn official_updates_keep_historical_backups_and_uninstall_current_version() -> Result<()> {
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

}
