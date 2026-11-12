//! Native Rust installed-ASAR patch transaction.
//! This module is deliberately fail-closed. All changes target only an
//! explicitly selected local LilacAnime installation and its manager backup.

use crate::asar::{self, Archive};
use crate::{fail, Result};
use chrono::Utc;
use serde_json::{json, Value};
use sha1::Sha1;
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

// Git object SHA-1 of exact upstream source. ASAR-packaged source uses LF or
// uniform CRLF, and is normalized before hashing. No unknown versions are
// permitted for a write until their full set of hashes is explicitly reviewed.
fn official_hashes(version: &str) -> Option<[(&'static str, &'static str); 5]> {
    let digests = match version {
        "0.5.54" => ["8e5585248546c97c7ca6361f87fcb27eeee4dd59","bffd50cba743cce1526dce3192c8f9e1757ce4d8","2e63685580eaa3ed443169da7a0013acb7b91426","76b250ae52d9f7044563d88c03da1278156cd52e","28c23d85840e8312058d721404fc20633fef3605"],
        "0.5.55" => ["11ee62df7319fb0a27f0fb6b94a2987d70c401cf","8cc992ac8a62aaa80d88501df90c8fb50693c2b4","4f5a6324011a8cfbfce7650b8feb3ada602d6905","b2eeea595d147b76c64af1647a0316c15c32aa09","c6aa7214d4e5e72fa798d61998645312a0cd7c26"],
        "0.5.63" => ["ae104cce648d3a26d094530ebae695eb59d77561","ee3248635fc198f20076d67aabd004bdede22bc7","656def6f3475e5c43f920b2a43ef51e135d8ebab","2cec16375f388bb68f9d47c00c5e98347da99756","489c7483c53cd20ea901dcfe7f982407a055f6c1"],
        "0.5.64" => ["79b254380b8191ca75eedff62296313f13e88300","9711aa371c1c26fde6e6b91c07b7841de4d03a23","47fd7de898dd1d58d213cdfede8828e299c6271b","da65fb5460dbf349333e2d69ac2500cb1dd2a541","489c7483c53cd20ea901dcfe7f982407a055f6c1"],
        _ => return None,
    };
    let names=["src/app.js","src/index.html","electron/main.cjs","electron/preload.cjs","src/player.js"];
    Some(std::array::from_fn(|index| (names[index], digests[index])))
}

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

fn git_blob_sha(data:&[u8])->String {
    let mut normalized = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        if data[index] == b'\r' && data.get(index + 1) == Some(&b'\n') {
            normalized.push(b'\n');
            index += 2;
        } else {
            normalized.push(data[index]);
            index += 1;
        }
    }
    let mut hash=Sha1::new();
    hash.update(format!("blob {}\0",normalized.len()).as_bytes());
    hash.update(&normalized);
    format!("{:x}",hash.finalize())
}

pub fn verify_identity(archive:&Archive,version:&str)->Result<()> {
    let hashes=official_hashes(version).ok_or_else(||fail(format!("공식 v{version}은 아직 Rust 패치 호환성이 검증되지 않았습니다.")))?;
    for (path,expected) in hashes {
        let content=archive.read(path)?;
        let crlf=content.windows(2).filter(|w| *w==b"\r\n").count();
        let lf=content.iter().filter(|&&b| b==b'\n').count();
        if crlf!=0 && crlf!=lf {return Err(fail(format!("공식 {path} 파일에 혼합된 줄바꿈이 있습니다.")));}
        let actual=git_blob_sha(&content);
        if actual!=expected {return Err(fail(format!("공식 파일 지문이 다릅니다: {path} (v{version})")));}
    }
    Ok(())
}

fn base_manifest(version:&str)->Result<Value> {
    let mut manifest:Value=serde_json::from_str(MANIFEST)?;
    if manifest.get("patchVersion").and_then(Value::as_str)!=Some(PATCH_VERSION){
        return Err(fail("패치 manifest 버전이 Rust 엔진과 다릅니다."));
    }
    if version=="0.5.54" {return Ok(manifest);}
    // 0.5.55 connection anchors still match the exact pinned official
    // v0.5.63 and v0.5.64 source, verified in upstream CI.
    if !matches!(version,"0.5.55"|"0.5.63"|"0.5.64") {
        return Err(fail("검증하지 않은 공식 버전입니다."));
    }
    let profile=manifest["additionalOfficialSources"].as_array()
        .ok_or_else(||fail("manifest에 공식 연결 프로필이 없습니다."))?
        .iter().find(|p| p["officialVersion"]=="0.5.55")
        .ok_or_else(||fail("v0.5.55 연결 프로필을 찾지 못했습니다."))?;
    let connections=profile["connections"].clone();
    manifest["connections"]=connections;
    Ok(manifest)
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
    let manifest=base_manifest(version)?;
    let connections=manifest["connections"].as_array()
        .ok_or_else(||fail("manifest 연결 목록이 없습니다."))?;
    if connections.len()!=5 { return Err(fail("manifest 연결 수가 5개가 아닙니다.")); }
    let mut changes=BTreeMap::new();
    changes.insert("src/app.js".into(),archive.read("src/app.js")?);
    changes.insert("src/index.html".into(),archive.read("src/index.html")?);
    let mut connection_count=BTreeMap::new();
    for item in connections {
        let path=item["file"].as_str().ok_or_else(||fail("manifest 연결 경로가 없습니다."))?;
        if !matches!(path,"src/app.js"|"src/index.html") {return Err(fail("허가되지 않은 원본 파일 변경입니다."));}
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
    if connection_count.get("src/app.js")!=Some(&1) || connection_count.get("src/index.html")!=Some(&4) {
        return Err(fail("manifest의 공식 연결 대상 개수가 잘못됐습니다."));
    }
    for (path,data) in [
        ("src/integrated-search.js",INTEGRATED_JS),
        ("src/integrated-search.css",INTEGRATED_CSS),
        ("src/patch03-bridge.js",PATCH_BRIDGE),
    ] {
        if archive.contains(path) {return Err(fail(format!("이미 ASAR에 패치 파일이 있습니다: {path}")));}
        let entry=manifest["runtimeModules"].as_array().ok_or_else(||fail("패치 파일 목록이 없습니다."))?
            .iter().find(|x|x["destination"]==path).ok_or_else(||fail(format!("패치 모듈 manifest 누락: {path}")))?;
        let expected=entry["sha256"].as_str().ok_or_else(||fail("패치 모듈 SHA-256이 없습니다."))?;
        let got=format!("{:X}",Sha256::digest(data));
        if got!=expected.to_uppercase(){return Err(fail(format!("패치 모듈 SHA-256 불일치: {path}")));}
        changes.insert(path.into(),data.to_vec());
    }
    for p in ["src/app.js","src/index.html"] {
        if changes[p]==archive.read(p)? { return Err(fail("원본 연결 파일이 수정되지 않았습니다.")); }
    }
    Ok(changes)
}

fn read_state(root:&Path)->Result<Option<Value>> {
    let path=state_root(root)?.join("state.json");
    if !path.exists(){return Ok(None);}
    asar::file_only(&path)?;
    let metadata=fs::metadata(&path)?;
    if metadata.len()>1024*1024 {return Err(fail("상태 기록이 너무 큽니다."));}
    let state:Value=serde_json::from_slice(&fs::read(&path)?)?;
    if state["target"]!=root.to_string_lossy().as_ref() {return Err(fail("상태 기록이 다른 설치 폴더를 가리킵니다."));}
    Ok(Some(state))
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
            if state["version"]!=version || state["patchVersion"]!=PATCH_VERSION{
                return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,"이전 패치 버전 또는 설치본 버전 기록이 현재와 다릅니다."));
            }
            let original=state["originalSha256"].as_str().unwrap_or("");
            let patched=state["patchedSha256"].as_str().unwrap_or("");
            if state["status"]=="APPLIED"{
                if actual!=patched {return Ok(Status::new("CONFLICT",&version,"현재 ASAR가 패치 상태 기록의 SHA-256과 다릅니다."));}
                let backup=state_root(&root)?.join("original-app.asar");
                if sha(&backup)?!=original {return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,"원본 ASAR 백업을 검증할 수 없습니다."));}
                return Ok(Status::new("APPLIED",&version,"패치 적용 및 원본 백업 무결성 확인 완료"));
            }
            if state["status"]=="UNPATCHED" {
                if actual!=original {return Ok(Status::new("CONFLICT",&version,"수동 해제 후 공식 ASAR가 변경되었습니다."));}
                let mut item=Status::new("UNPATCHED",&version,"수동 해제 상태를 보존합니다.");
                item.manually_uninstalled=true;
                return Ok(item);
            }
            return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,"패치 기록 상태 값이 올바르지 않습니다."));
        }
        if ["src/integrated-search.js","src/integrated-search.css","src/patch03-bridge.js"]
            .iter().any(|x|archive.contains(x)) {
            return Ok(Status::new("PARTIAL_OR_UNKNOWN",&version,"기존 패치 모듈은 있으나 검증된 패치 기록이 없습니다."));
        }
        match verify_identity(&archive,&version) {
            Ok(())=>Ok(Status::new("UNPATCHED",&version,"공식 원본의 필수 파일 SHA-1 확인 완료")),
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
    let backup=data_root.join("original-app.asar");
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
        "createdAt":at.to_rfc3339()
    });
    write_json_atomic(&pending,&state)?;
    // From this point, never delete pending.json on failure.
    fs::rename(&temp,archive_path(&root))?;
    write_json_atomic(&data_root.join("state.json"),&state)?;
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
    let source=state_root(&root)?.join("original-app.asar");
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
    // Preserve the previous state until the file swap succeeds.
    fs::rename(&temp,&archive)?;
    let mut new=state.clone();
    new["status"]=json!("UNPATCHED");
    write_json_atomic(&state_root(&root)?.join("state.json"),&new)?;
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
        || pending["version"]!=version || pending["patchVersion"]!=PATCH_VERSION || pending["status"]!="APPLIED" {
        return Err(fail("복구 기록의 설치 대상·버전·상태가 현재와 다릅니다."));
    }
    for name in ["app.asar.dino-writing","app.asar.dino-restore"] {
        if root.join("resources").join(name).exists() {return Err(fail("미완료 ASAR 임시 파일이 남아 있어 복구 기록을 보존합니다."));}
    }
    let original=pending["originalSha256"].as_str().ok_or_else(||fail("원본 SHA-256 기록 없음"))?;
    let patched=pending["patchedSha256"].as_str().ok_or_else(||fail("패치 SHA-256 기록 없음"))?;
    let valid_sha=|x:&str| x.len()==64 && x.bytes().all(|b|b.is_ascii_hexdigit() && !b.is_ascii_lowercase());
    if !valid_sha(original)||!valid_sha(patched)||original==patched {return Err(fail("복구 SHA-256 형식이 올바르지 않습니다."));}
    let backup=data_root.join("original-app.asar");
    if sha(&backup)?!=original {return Err(fail("백업 SHA-256이 복구 기록과 다릅니다."));}
    let current_sha=sha(&archive_path(&root))?;
    let mode=if current_sha==patched {"APPLIED"} else if current_sha==original {"UNPATCHED"} else {
        return Err(fail("현재 ASAR가 복구 기록의 원본·패치본과 다릅니다."));
    };
    if let Some(state)=read_state(&root)?{
        if state["version"]!=version || state["patchVersion"]!=PATCH_VERSION || state["originalSha256"]!=original {
            return Err(fail("기존 상태 기록이 pending과 충돌합니다."));
        }
        if state["status"]=="APPLIED" && state["patchedSha256"]!=current_sha {
            return Err(fail("기록된 적용 파일 SHA-256과 실제 파일이 다릅니다."));
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
    if sha(&marker)?!=original_sha || sha(&data.join("original-app.asar"))?!=state["originalSha256"].as_str().unwrap_or("") {
        return Err(fail("복구 검증 직후 기록 또는 원본 백업이 바뀌었습니다."));
    }
    state["status"]=json!(target_mode);
    let archived=data.join(format!("pending.reconciled-{}.json",Utc::now().format("%Y%m%dT%H%M%S%6fZ")));
    if archived.exists() {return Err(fail("복구 기록 보관 파일이 이미 존재합니다."));}
    write_json_atomic(&data.join("state.json"),&state)?;
    fs::rename(&marker,archived)?;
    Ok(inspect(&root))
}

pub fn backups(root:&Path)->Result<Value>{
    let root=installed_root(root)?;
    let state=read_state(&root)?;
    if let Some(state)=state {
        let backup=state_root(&root)?.join("original-app.asar");
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
    if state["backupId"].as_str()!=Some(backup_id){
        return Err(fail("선택한 백업 ID가 기록과 다릅니다."));
    }
    uninstall(&root)
}
