//! Structural ASAR parser and deterministic writer for an existing official install.
//! No archive is touched until the caller has separately verified identity,
//! compatibility, process status, backup and a transaction state directory.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::{fail, Result};
pub const MAX_ASAR_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_HEADER: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 50_000;
const MAX_DEPTH: usize = 128;
const MAX_EDIT_BYTES: usize = 24 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Archive {
    pub path: PathBuf,
    header: Value,
    positions: BTreeMap<String, (u64, u64)>,
    data_offset: u64,
}

fn little4(data: &[u8], start: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(data.get(start..start + 4)
        .ok_or_else(|| fail("ASAR 헤더가 잘렸습니다."))?
        .try_into().map_err(|_| fail("ASAR 크기 검사 실패"))?))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".."
        && !name.contains(['/', '\\', '\0', ':'])
}

pub fn file_only(path: &Path) -> Result<std::fs::Metadata> {
    let stat = fs::symlink_metadata(path).map_err(|e| fail(format!("경로 확인 실패 {}: {e}", path.display())))?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        (stat.file_attributes() & 0x400) != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if !stat.is_file() || stat.file_type().is_symlink() || reparse {
        return Err(fail(format!("일반 파일이 아니거나 링크입니다: {}", path.display())));
    }
    Ok(stat)
}

pub fn dir_only(path: &Path) -> Result<()> {
    let stat = fs::symlink_metadata(path).map_err(|e| fail(format!("폴더 확인 실패 {}: {e}", path.display())))?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        stat.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if !stat.is_dir() || stat.file_type().is_symlink() || reparse {
        return Err(fail(format!("폴더가 아니거나 링크입니다: {}", path.display())));
    }
    Ok(())
}

fn collect(
    node: &Map<String, Value>,
    prefix: &str,
    level: usize,
    data_offset: u64,
    total: u64,
    positions: &mut BTreeMap<String, (u64, u64)>,
    entries: &mut usize,
) -> Result<()> {
    if level > MAX_DEPTH { return Err(fail("ASAR 폴더 깊이가 안전 제한을 넘었습니다.")); }
    for (name, value) in node {
        if !valid_name(name) { return Err(fail("ASAR 경로에 안전하지 않은 이름이 있습니다.")); }
        *entries += 1;
        if *entries > MAX_FILES { return Err(fail("ASAR 파일 수가 안전 제한을 넘었습니다.")); }
        let relative = format!("{prefix}{name}");
        let object = value.as_object().ok_or_else(|| fail("ASAR 항목 형식이 잘못됐습니다."))?;
        if let Some(children) = object.get("files") {
            collect(children.as_object().ok_or_else(|| fail("ASAR 폴더 목록 형식 오류"))?,
                &format!("{relative}/"), level + 1, data_offset, total, positions, entries)?;
        } else if object.get("link").is_some()
            || object.get("unpacked").and_then(Value::as_bool) == Some(true) {
            continue;
        } else {
            let size = object.get("size").and_then(Value::as_u64)
                .ok_or_else(|| fail("ASAR 파일 크기가 올바르지 않습니다."))?;
            let offset = object.get("offset")
                .and_then(|x| x.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| x.as_u64()))
                .ok_or_else(|| fail("ASAR 파일 오프셋이 올바르지 않습니다."))?;
            let end = data_offset.checked_add(offset).and_then(|x| x.checked_add(size))
                .ok_or_else(|| fail("ASAR 파일 범위 오버플로"))?;
            if end > total { return Err(fail(format!("ASAR 파일이 범위를 벗어납니다: {relative}"))); }
            positions.insert(relative, (offset, size));
        }
    }
    Ok(())
}

impl Archive {
    pub fn open(path: &Path) -> Result<Self> {
        let total = file_only(path)?.len();
        if total < 20 || total > MAX_ASAR_BYTES { return Err(fail("ASAR 파일 크기가 허용 범위를 벗어납니다.")); }
        let mut input = File::open(path)?;
        let mut leading = [0u8; 8];
        input.read_exact(&mut leading)?;
        if little4(&leading, 0)? != 4 { return Err(fail("Electron ASAR Pickle 헤더가 잘못됐습니다.")); }
        let header_size = little4(&leading, 4)? as usize;
        if !(12..=MAX_HEADER).contains(&header_size) || (header_size as u64) + 8 > total {
            return Err(fail("ASAR JSON 헤더 크기가 잘못됐습니다."));
        }
        let mut raw = vec![0u8; header_size];
        input.read_exact(&mut raw)?;
        let payload_size = little4(&raw, 0)? as usize;
        let json_size = little4(&raw, 4)? as usize;
        if json_size > header_size - 8 || payload_size < 4 + json_size
            || payload_size + 4 != header_size {
            return Err(fail("ASAR 헤더 Pickle 길이가 잘못됐습니다."));
        }
        let header: Value = serde_json::from_slice(&raw[8..8 + json_size])
            .map_err(|_| fail("ASAR 파일 구조 JSON 해석 실패"))?;
        let root = header.get("files").and_then(Value::as_object)
            .ok_or_else(|| fail("ASAR 파일 목록이 없습니다."))?;
        let mut positions = BTreeMap::new();
        let mut entries = 0;
        collect(root, "", 0, 8 + header_size as u64, total, &mut positions, &mut entries)?;
        Ok(Self { path: path.to_owned(), header, positions, data_offset: 8 + header_size as u64 })
    }

    pub fn contains(&self, path: &str) -> bool { self.positions.contains_key(path) }

    pub fn read(&self, path: &str) -> Result<Vec<u8>> {
        let &(offset, length) = self.positions.get(path)
            .ok_or_else(|| fail(format!("ASAR 내부 필수 파일이 없습니다: {path}")))?;
        if length > MAX_EDIT_BYTES as u64 { return Err(fail("필수 JS 파일이 검사 크기를 초과했습니다.")); }
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.data_offset + offset))?;
        let mut bytes = vec![0u8; length as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    pub fn files(&self) -> BTreeSet<&str> { self.positions.keys().map(String::as_str).collect() }

    pub fn version(&self) -> Result<String> {
        let package: Value = serde_json::from_slice(&self.read("package.json")?)
            .map_err(|_| fail("ASAR의 package.json을 읽지 못했습니다."))?;
        let identity = package.get("name").and_then(Value::as_str) == Some("lilacanime-desktop")
            || package.pointer("/build/appId").and_then(Value::as_str) == Some("com.lilac.anime.desktop");
        if !identity { return Err(fail("공식 LilacAnime 앱 식별자가 아닙니다.")); }
        let v = package.get("version").and_then(Value::as_str).ok_or_else(|| fail("원본 버전이 없습니다."))?;
        if v.len() > 48 || v.is_empty() { return Err(fail("원본 버전이 올바르지 않습니다.")); }
        Ok(v.to_string())
    }

    pub fn write_modified(&self, output: &Path, replacements: &BTreeMap<String, Vec<u8>>) -> Result<()> {
        if output.exists() { return Err(fail("이전 임시 ASAR가 존재합니다. 덮어쓰지 않습니다.")); }
        if replacements.is_empty() { return Err(fail("빈 패치를 적용하지 않습니다.")); }
        let mut header = self.header.clone();
        for (path, bytes) in replacements {
            if bytes.len() > MAX_EDIT_BYTES || path.split('/').any(|part| !valid_name(part)) {
                return Err(fail("패치 파일 크기 또는 경로가 허용 범위를 벗어납니다."));
            }
            let mut directory = header.as_object_mut().ok_or_else(|| fail("ASAR 루트 형식 오류"))?;
            let parts: Vec<&str> = path.split('/').collect();
            for segment in &parts[..parts.len() - 1] {
                let files = directory.get_mut("files").and_then(Value::as_object_mut)
                    .ok_or_else(|| fail("ASAR 폴더 목록이 없습니다."))?;
                let child = files.entry((*segment).to_owned()).or_insert_with(|| json!({"files":{}}));
                directory = child.as_object_mut().ok_or_else(|| fail("패치 폴더가 객체가 아닙니다."))?;
            }
            let files = directory.get_mut("files").and_then(Value::as_object_mut)
                .ok_or_else(|| fail("패치 대상 목록이 올바르지 않습니다."))?;
            if !self.contains(path) && files.contains_key(parts[parts.len()-1]) {
                return Err(fail("기존 ASAR 특수 항목을 덮어쓸 수 없습니다."));
            }
            let entry = files.entry(parts[parts.len()-1].to_owned())
                .or_insert_with(|| json!({"size":0,"offset":"0"}));
            let object = entry.as_object_mut().ok_or_else(|| fail("패치 항목이 일반 파일이 아닙니다."))?;
            if object.contains_key("files") || object.contains_key("link") ||
                object.get("unpacked").and_then(Value::as_bool) == Some(true) {
                return Err(fail("ASAR 폴더·링크·언팩 파일은 수정하지 않습니다."));
            }
            object.insert("size".to_owned(), json!(bytes.len()));
            if let Some(integrity) = object.get_mut("integrity") {
                let block = 4 * 1024 * 1024usize;
                let blocks: Vec<String> = bytes.chunks(block)
                    .map(|chunk| format!("{:x}", Sha256::digest(chunk))).collect();
                let blocks = if blocks.is_empty() { vec![format!("{:x}", Sha256::digest(b""))] } else { blocks };
                *integrity = json!({
                    "algorithm":"SHA256", "hash":format!("{:x}",Sha256::digest(bytes)),
                    "blockSize": block, "blocks":blocks
                });
            }
        }
        let mut ordered = Vec::new();
        let mut offset = 0u64;
        assign_offsets(header.get_mut("files").and_then(Value::as_object_mut)
            .ok_or_else(|| fail("ASAR 루트 파일 구조 오류"))?, "", replacements, &self.positions, &mut offset, &mut ordered, 0)?;
        if ordered.len() != self.positions.len() + replacements.keys().filter(|p| !self.contains(p)).count() {
            return Err(fail("패치 중 파일 목록 개수가 달라졌습니다."));
        }
        let serial = serde_json::to_vec(&header)?;
        if serial.len() > MAX_HEADER - 16 { return Err(fail("패치 ASAR 헤더 크기를 초과했습니다.")); }
        let padding = (4 - serial.len() % 4) % 4;
        let payload_size = 4 + serial.len() + padding;
        let pickle_size = 8 + serial.len() + padding;
        let total_size = pickle_size as u64 + 8 + offset;
        if total_size > MAX_ASAR_BYTES { return Err(fail("패치 파일 크기가 허용 범위를 벗어납니다.")); }

        let mut out = OpenOptions::new().write(true).create_new(true).open(output)?;
        let result = (|| -> Result<()> {
            out.write_all(&4u32.to_le_bytes())?;
            out.write_all(&(pickle_size as u32).to_le_bytes())?;
            out.write_all(&(payload_size as u32).to_le_bytes())?;
            out.write_all(&(serial.len() as u32).to_le_bytes())?;
            out.write_all(&serial)?;
            out.write_all(&vec![0u8; padding])?;
            let mut source = File::open(&self.path)?;
            for path in &ordered {
                if let Some(data) = replacements.get(path) {
                    out.write_all(data)?;
                } else {
                    let (start, length) = self.positions[path];
                    source.seek(SeekFrom::Start(self.data_offset + start))?;
                    let copied = std::io::copy(&mut (&mut source).take(length), &mut out)?;
                    if copied != length { return Err(fail("기존 ASAR 파일 복사 중 일부가 누락됐습니다.")); }
                }
            }
            out.sync_all()?;
            let verification = Self::open(output)?;
            let expected: BTreeSet<&str> = self.positions.keys().chain(replacements.keys())
                .map(String::as_str).collect();
            if verification.files() != expected {
                return Err(fail("ASAR 파일 목록 검증에 실패했습니다."));
            }
            for (path, data) in replacements {
                if verification.read(path)? != *data { return Err(fail(format!("ASAR 패치 내용 검증 실패: {path}"))); }
            }
            Ok(())
        })();
        if result.is_err() { let _ = fs::remove_file(output); }
        result
    }
}

fn assign_offsets(
    files: &mut Map<String, Value>,
    prefix: &str,
    replacements: &BTreeMap<String,Vec<u8>>,
    originals: &BTreeMap<String,(u64,u64)>,
    offset: &mut u64,
    ordered: &mut Vec<String>,
    depth: usize,
) -> Result<()> {
    if depth > MAX_DEPTH { return Err(fail("ASAR 폴더 깊이가 안전 제한을 넘었습니다.")); }
    for (name, node) in files {
        if !valid_name(name) { return Err(fail("ASAR 내부 항목 이름 오류")); }
        let path = format!("{prefix}{name}");
        let object = node.as_object_mut().ok_or_else(|| fail("ASAR 파일 정보 형식 오류"))?;
        if let Some(children) = object.get_mut("files") {
            assign_offsets(children.as_object_mut().ok_or_else(|| fail("ASAR 폴더 정보 오류"))?,
                &format!("{path}/"), replacements, originals, offset, ordered, depth + 1)?;
        } else if object.contains_key("link") || object.get("unpacked").and_then(Value::as_bool) == Some(true) {
            continue;
        } else {
            let length = if let Some(v)=replacements.get(&path) { v.len() as u64 } else {
                originals.get(&path).ok_or_else(|| fail("ASAR 원본 파일 목록이 변경됐습니다."))?.1
            };
            object.insert("offset".into(), json!(offset.to_string()));
            object.insert("size".into(), json!(length));
            *offset = offset.checked_add(length).ok_or_else(|| fail("ASAR 오프셋 오버플로"))?;
            ordered.push(path);
            if ordered.len() > MAX_FILES { return Err(fail("ASAR 파일 개수가 안전 제한을 넘었습니다.")); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn synthetic(path: &Path) -> Result<()> {
        let content = b"{\"name\":\"lilacanime-desktop\",\"version\":\"0.5.64\"}";
        let header = json!({"files":{"package.json":{"offset":"0","size":content.len()},"src":{"files":{"app.js":{"offset":content.len().to_string(),"size":3}}}}});
        let serial = serde_json::to_vec(&header)?;
        let padding = (4 - serial.len() % 4) % 4;
        let pickle = 8 + serial.len() + padding;
        let mut out = File::create(path)?;
        out.write_all(&4u32.to_le_bytes())?;
        out.write_all(&(pickle as u32).to_le_bytes())?;
        out.write_all(&((pickle - 4) as u32).to_le_bytes())?;
        out.write_all(&(serial.len() as u32).to_le_bytes())?;
        out.write_all(&serial)?;
        out.write_all(&vec![0u8; padding])?;
        out.write_all(content)?;
        out.write_all(b"abc")?;
        Ok(())
    }
    #[test]
    fn create_and_modify_preserves_unrelated_data() -> Result<()> {
        let base = std::env::temp_dir().join(format!("dino-native-asar-test-{}", std::process::id()));
        fs::create_dir_all(&base)?;
        let source = base.join("app.asar");
        let copy = base.join("patched.asar");
        let result = (|| -> Result<()> {
            synthetic(&source)?;
            let before = Archive::open(&source)?;
            assert_eq!(before.version()?, "0.5.64");
            let mut replacements = BTreeMap::new();
            replacements.insert("src/app.js".into(), b"patched".to_vec());
            replacements.insert("src/module.js".into(), b"new-module".to_vec());
            before.write_modified(&copy, &replacements)?;
            let after = Archive::open(&copy)?;
            assert_eq!(after.version()?, "0.5.64");
            assert_eq!(after.read("src/app.js")?, b"patched");
            assert_eq!(after.read("src/module.js")?, b"new-module");
            assert_eq!(before.read("package.json")?, after.read("package.json")?);
            Ok(())
        })();
        let _ = fs::remove_dir_all(&base);
        result
    }
}
