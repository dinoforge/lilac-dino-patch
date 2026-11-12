//! Read-only ASAR file inspection. This binary never writes to the installed app.
//! A valid result means only that the archive is structurally readable; it is
//! NOT permission to patch. Python's existing contract, backup and process
//! checks remain authoritative until the Rust engine reaches full parity.

mod recovery;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_HEADER_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILES: usize = 50_000;
const MAX_DEPTH: usize = 128;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
struct Failure {
    code: &'static str,
    reason: String,
}

impl Failure {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_ARCHIVE",
            reason: message.into(),
        }
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "UNSUPPORTED",
            reason: message.into(),
        }
    }
}

type Checked<T> = Result<T, Failure>;

fn read_error(path: &Path, error: std::io::Error) -> Failure {
    Failure::invalid(format!(
        "파일을 읽을 수 없습니다 ({}): {error}",
        path.display()
    ))
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn regular(path: &Path, directory: bool) -> Checked<Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|error| read_error(path, error))?;
    if is_link(&metadata) {
        return Err(Failure::invalid(format!(
            "링크 또는 junction 경로는 검사하지 않습니다: {}",
            path.display()
        )));
    }
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(Failure::invalid(format!(
            "예상한 {}이(가) 아닙니다: {}",
            if directory { "폴더" } else { "일반 파일" },
            path.display()
        )));
    }
    Ok(metadata)
}

fn u32_at(data: &[u8], start: usize) -> Checked<u32> {
    let bytes = data
        .get(start..start + 4)
        .ok_or_else(|| Failure::invalid("ASAR 헤더가 잘렸습니다."))?;
    Ok(u32::from_le_bytes(
        bytes.try_into().expect("four bytes checked"),
    ))
}

fn checked_file(node: &Value, data_offset: u64, total_size: u64) -> Checked<Option<(u64, u64)>> {
    let object = node
        .as_object()
        .ok_or_else(|| Failure::invalid("ASAR 파일 정보가 객체가 아닙니다."))?;
    if object.get("link").is_some() {
        return Ok(None);
    }
    let size = object
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(|| Failure::invalid("ASAR 파일 크기가 올바르지 않습니다."))?;
    if object.get("unpacked").and_then(Value::as_bool) == Some(true) {
        return Ok(None); // External unpacked files are not inside app.asar.
    }
    let raw = object
        .get("offset")
        .ok_or_else(|| Failure::invalid("ASAR 파일 오프셋이 없습니다."))?;
    let offset = match raw {
        Value::String(text) => text.parse::<u64>().ok(),
        Value::Number(value) => value.as_u64(),
        _ => None,
    }
    .ok_or_else(|| Failure::invalid("ASAR 파일 오프셋이 잘못됐습니다."))?;
    let end = data_offset
        .checked_add(offset)
        .and_then(|x| x.checked_add(size))
        .ok_or_else(|| Failure::invalid("ASAR 파일 범위가 넘쳤습니다."))?;
    if end > total_size {
        return Err(Failure::invalid(
            "ASAR 파일 범위가 압축 파일 크기를 벗어납니다.",
        ));
    }
    Ok(Some((data_offset + offset, size)))
}

fn validate_entries(
    files: &Map<String, Value>,
    data_offset: u64,
    total_size: u64,
    depth: usize,
    entries: &mut usize,
) -> Checked<()> {
    if depth >= MAX_DEPTH {
        return Err(Failure::invalid("ASAR 폴더 깊이가 허용 범위를 넘었습니다."));
    }
    for (name, entry) in files {
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
            return Err(Failure::invalid(format!(
                "안전하지 않은 ASAR 항목 이름: {name}"
            )));
        }
        *entries += 1;
        if *entries > MAX_FILES {
            return Err(Failure::invalid("ASAR 파일 수가 허용 범위를 넘었습니다."));
        }
        if let Some(children) = entry.get("files").and_then(Value::as_object) {
            validate_entries(children, data_offset, total_size, depth + 1, entries)?;
        } else {
            checked_file(entry, data_offset, total_size)?;
        }
    }
    Ok(())
}

fn required_entry<'a>(root: &'a Map<String, Value>, relative: &str) -> Checked<&'a Value> {
    let mut files = root;
    let parts: Vec<&str> = relative.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        let entry = files.get(*part).ok_or_else(|| {
            Failure::unsupported(format!("공식 앱의 필수 ASAR 파일이 없습니다: {relative}"))
        })?;
        if index == parts.len() - 1 {
            return Ok(entry);
        }
        files = entry
            .get("files")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                Failure::unsupported(format!("필수 ASAR 경로 구조가 다릅니다: {relative}"))
            })?;
    }
    Err(Failure::unsupported("잘못된 검사 경로"))
}

fn verify_installed(root: &Path) -> Checked<Value> {
    regular(root, true)?;
    regular(&root.join("LilacAnime.exe"), false)?;
    let resources = root.join("resources");
    regular(&resources, true)?;
    let archive = resources.join("app.asar");
    let initial = regular(&archive, false)?;
    let total = initial.len();
    if !(20..=MAX_ARCHIVE_BYTES).contains(&total) {
        return Err(Failure::invalid(
            "ASAR 파일 크기가 정상 검사 범위를 벗어납니다.",
        ));
    }

    let mut input = File::open(&archive).map_err(|error| read_error(&archive, error))?;
    let mut leading = [0u8; 8];
    input
        .read_exact(&mut leading)
        .map_err(|error| read_error(&archive, error))?;
    if u32_at(&leading, 0)? != 4 {
        return Err(Failure::invalid(
            "Electron ASAR Pickle 크기 헤더가 올바르지 않습니다.",
        ));
    }
    let header_bytes = u32_at(&leading, 4)? as u64;
    if !(12..=MAX_HEADER_BYTES).contains(&header_bytes) || 8 + header_bytes > total {
        return Err(Failure::invalid(
            "ASAR 메타데이터 길이가 올바르지 않습니다.",
        ));
    }
    let mut header_raw = vec![0u8; header_bytes as usize];
    input
        .read_exact(&mut header_raw)
        .map_err(|error| read_error(&archive, error))?;
    let pickle_size = u32_at(&header_raw, 0)? as u64;
    let json_size = u32_at(&header_raw, 4)? as u64;
    if pickle_size < json_size + 4 || json_size > header_bytes - 8 {
        return Err(Failure::invalid("ASAR JSON 헤더 길이가 올바르지 않습니다."));
    }
    let header: Value = serde_json::from_slice(&header_raw[8..8 + json_size as usize])
        .map_err(|_| Failure::invalid("ASAR 헤더의 JSON을 읽을 수 없습니다."))?;
    let files = header
        .get("files")
        .and_then(Value::as_object)
        .ok_or_else(|| Failure::invalid("ASAR 파일 목록이 올바르지 않습니다."))?;
    let data_offset = 8 + header_bytes;
    let mut entries = 0;
    validate_entries(files, data_offset, total, 0, &mut entries)?;

    // Check the same required code filenames as the existing installed
    // patch engine. This is not a replacement for JavaScript IPC checks.
    for relative in [
        "src/app.js",
        "src/index.html",
        "src/player.js",
        "electron/main.cjs",
        "electron/preload.cjs",
    ] {
        let item = required_entry(files, relative)?;
        if checked_file(item, data_offset, total)?.is_none() {
            return Err(Failure::unsupported(format!(
                "필수 파일을 ASAR 내부에서 읽을 수 없습니다: {relative}"
            )));
        }
    }

    let package_item = required_entry(files, "package.json")?;
    let (offset, package_size) = checked_file(package_item, data_offset, total)?
        .ok_or_else(|| Failure::unsupported("원본 package.json이 ASAR 내부에 없습니다."))?;
    if package_size > MAX_PACKAGE_BYTES {
        return Err(Failure::unsupported(
            "원본 package.json 크기가 허용 범위를 벗어납니다.",
        ));
    }
    input
        .seek(SeekFrom::Start(offset))
        .map_err(|error| read_error(&archive, error))?;
    let mut package_raw = vec![0u8; package_size as usize];
    input
        .read_exact(&mut package_raw)
        .map_err(|error| read_error(&archive, error))?;
    let package: Value = serde_json::from_slice(&package_raw)
        .map_err(|_| Failure::unsupported("원본 package.json 형식을 확인할 수 없습니다."))?;
    let product_id = package.pointer("/build/appId").and_then(Value::as_str);
    if package.get("name").and_then(Value::as_str) != Some("lilacanime-desktop")
        && product_id != Some("com.lilac.anime.desktop")
    {
        return Err(Failure::unsupported(
            "공식 LilacAnime 설치본으로 식별할 수 없습니다.",
        ));
    }
    let version = package
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 48)
        .ok_or_else(|| Failure::unsupported("공식 원본 버전을 확인할 수 없습니다."))?;

    input
        .seek(SeekFrom::Start(0))
        .map_err(|error| read_error(&archive, error))?;
    let mut digest = Sha256::new();
    let mut chunk = [0u8; 1024 * 1024];
    loop {
        let n = input
            .read(&mut chunk)
            .map_err(|error| read_error(&archive, error))?;
        if n == 0 {
            break;
        }
        digest.update(&chunk[..n]);
    }
    let current = regular(&archive, false)?;
    let handle_metadata = input
        .metadata()
        .map_err(|error| read_error(&archive, error))?;
    if current.len() != total
        || handle_metadata.len() != total
        || current.modified().ok() != initial.modified().ok()
    {
        return Err(Failure::invalid(
            "검사 중 app.asar가 변경됐습니다. 원본 파일이 안정된 뒤 다시 검사하세요.",
        ));
    }
    let hex = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    Ok(json!({
        "status": "ARCHIVE_VALID",
        "targetKind": "INSTALLED_ASAR",
        "readOnly": true,
        "path": root.to_string_lossy(),
        "archivePath": archive.to_string_lossy(),
        "version": version,
        "sha256": hex,
        "entryCount": entries
    }))
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(first) = args.next() else {
        eprintln!("Usage: dino-asar-inspect <installed-root> | --review-recovery <installed-root> <existing-state-dir> <patch-version>");
        std::process::exit(2);
    };
    let result = if first == "--review-recovery" {
        let Some(root) = args.next() else {
            eprintln!("Missing installed root");
            std::process::exit(2);
        };
        let Some(state_root) = args.next() else {
            eprintln!("Missing existing manager state directory");
            std::process::exit(2);
        };
        let Some(patch_version) = args.next() else {
            eprintln!("Missing patch version");
            std::process::exit(2);
        };
        if args.next().is_some() {
            eprintln!("Too many arguments");
            std::process::exit(2);
        }
        let patch_version = patch_version.to_string_lossy();
        recovery::review_recovery(&PathBuf::from(root), &PathBuf::from(state_root), &patch_version)
    } else {
        if args.next().is_some() {
            eprintln!("Only one installed root argument is allowed.");
            std::process::exit(2);
        }
        verify_installed(&PathBuf::from(first))
    };
    let output = match result {
        Ok(value) => value,
        Err(failure) => json!({
            "status": "BLOCKED",
            "code": failure.code,
            "readOnly": true,
            "reason": failure.reason
        }),
    };
    println!("{output}");
    if output["status"] == "BLOCKED" {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root =
                std::env::temp_dir().join(format!("dino-rust-asar-{}-{nanos}", std::process::id()));
            fs::create_dir_all(root.join("resources")).unwrap();
            File::create(root.join("LilacAnime.exe")).unwrap();
            Fixture(root)
        }
        fn archive(&self) -> PathBuf {
            self.0.join("resources").join("app.asar")
        }
        fn build(&self) {
            let mut files = Map::new();
            let mut packed = Vec::new();
            let blobs = [
                ("package.json", br#"{"name":"lilacanime-desktop","version":"0.5.64","build":{"appId":"com.lilac.anime.desktop"}}"#.as_slice()),
                ("src/app.js", b"const state = {};".as_slice()),
                ("src/index.html", b"<html></html>".as_slice()),
                ("src/player.js", b"const player = 1;".as_slice()),
                ("electron/main.cjs", b"const main = 1;".as_slice()),
                ("electron/preload.cjs", b"const preload = 1;".as_slice()),
            ];
            for (relative, blob) in blobs {
                let parts: Vec<&str> = relative.split('/').collect();
                if parts.len() == 1 {
                    files.insert(
                        relative.into(),
                        json!({"size":blob.len(),"offset":packed.len().to_string()}),
                    );
                } else {
                    let folder = files
                        .entry(parts[0].to_string())
                        .or_insert_with(|| json!({"files":{}}));
                    folder["files"].as_object_mut().unwrap().insert(
                        parts[1].into(),
                        json!({"size":blob.len(),"offset":packed.len().to_string()}),
                    );
                }
                packed.extend_from_slice(blob);
            }
            let header = serde_json::to_vec(&json!({"files":files})).unwrap();
            let pad = (4 - header.len() % 4) % 4;
            let header_size = 8 + header.len() + pad;
            let mut out = File::create(self.archive()).unwrap();
            out.write_all(&4u32.to_le_bytes()).unwrap();
            out.write_all(&(header_size as u32).to_le_bytes()).unwrap();
            out.write_all(&((4 + header.len() + pad) as u32).to_le_bytes())
                .unwrap();
            out.write_all(&(header.len() as u32).to_le_bytes()).unwrap();
            out.write_all(&header).unwrap();
            out.write_all(&vec![0u8; pad]).unwrap();
            out.write_all(&packed).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_valid_original_without_modifying_a_byte() {
        let fixture = Fixture::new();
        fixture.build();
        let before = fs::read(fixture.archive()).unwrap();
        let report = verify_installed(&fixture.0).unwrap();
        assert_eq!(report["status"], "ARCHIVE_VALID");
        assert_eq!(report["version"], "0.5.64");
        assert_eq!(report["readOnly"], true);
        assert_eq!(report["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(fs::read(fixture.archive()).unwrap(), before);
    }

    #[test]
    fn blocks_an_app_asar_directory_and_preserves_it() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.archive()).unwrap();
        let error = verify_installed(&fixture.0).unwrap_err();
        assert_eq!(error.code, "INVALID_ARCHIVE");
        assert!(fixture.archive().is_dir());
    }

    #[test]
    fn blocks_missing_or_truncated_archive() {
        let fixture = Fixture::new();
        assert_eq!(
            verify_installed(&fixture.0).unwrap_err().code,
            "INVALID_ARCHIVE"
        );
        fs::write(fixture.archive(), b"not an asar").unwrap();
        assert_eq!(
            verify_installed(&fixture.0).unwrap_err().code,
            "INVALID_ARCHIVE"
        );
    }

    #[test]
    fn blocks_wrong_product_without_tampering_with_archive() {
        let fixture = Fixture::new();
        fixture.build();
        let archive = fixture.archive();
        let mut bytes = fs::read(&archive).unwrap();
        // The official identifier is accepted by name OR appId. To test an
        // unrelated product, both identity fields must be changed.
        for text in [
            b"lilacanime-desktop".as_slice(),
            b"com.lilac.anime.desktop".as_slice(),
        ] {
            let at = bytes
                .windows(text.len())
                .position(|item| item == text)
                .unwrap();
            bytes[at..at + text.len()].fill(b'x');
        }
        fs::write(&archive, &bytes).unwrap();
        assert_eq!(
            verify_installed(&fixture.0).unwrap_err().code,
            "UNSUPPORTED"
        );
        assert_eq!(fs::read(&archive).unwrap(), bytes);
    }
    fn setup_pending(fixture: &Fixture, patched: bool) -> (PathBuf, Vec<u8>, Vec<u8>) {
        fixture.build();
        let original = fs::read(fixture.archive()).unwrap();
        let mut patched_bytes = original.clone();
        patched_bytes.extend_from_slice(b"patch-transaction-fixture");
        if patched {
            fs::write(fixture.archive(), &patched_bytes).unwrap();
        }
        let state_root = fixture.0.join("profile").join("installed-asar").join("target-id");
        fs::create_dir_all(&state_root).unwrap();
        fs::write(state_root.join("original-app.asar"), &original).unwrap();
        let hex = |bytes: &[u8]| -> String {
            let mut sha = Sha256::new();
            sha.update(bytes);
            sha.finalize().iter().map(|byte| format!("{byte:02X}")).collect()
        };
        fs::write(state_root.join("pending.json"), serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "target": fixture.0.to_string_lossy(),
            "version": "0.5.64",
            "patchVersion": "1.0.0",
            "status": "APPLIED",
            "originalSha256": hex(&original),
            "patchedSha256": hex(&patched_bytes),
            "backupId": "test-backup"
        })).unwrap()).unwrap();
        (state_root, original, patched_bytes)
    }

    #[test]
    fn recovery_review_verifies_pending_patched_without_writes() {
        let fixture = Fixture::new();
        let (state_root, backup_before, current_before) = setup_pending(&fixture, true);
        let pending_before = fs::read(state_root.join("pending.json")).unwrap();
        let result = recovery::review_recovery(&fixture.0, &state_root, "1.0.0").unwrap();
        assert_eq!(result["status"], "RECOVERY_VERIFIED");
        assert_eq!(result["mode"], "APPLIED");
        assert_eq!(result["readOnly"], true);
        assert_eq!(fs::read(fixture.archive()).unwrap(), current_before);
        assert_eq!(fs::read(state_root.join("original-app.asar")).unwrap(), backup_before);
        assert_eq!(fs::read(state_root.join("pending.json")).unwrap(), pending_before);
    }

    #[test]
    fn recovery_review_recognizes_original_without_reapplying() {
        let fixture = Fixture::new();
        let (state_root, original, _) = setup_pending(&fixture, false);
        let result = recovery::review_recovery(&fixture.0, &state_root, "1.0.0").unwrap();
        assert_eq!(result["mode"], "UNPATCHED");
        assert_eq!(fs::read(fixture.archive()).unwrap(), original);
    }

    #[test]
    fn recovery_review_blocks_backup_tampering() {
        let fixture = Fixture::new();
        let (state_root, _, current_before) = setup_pending(&fixture, true);
        fs::write(state_root.join("original-app.asar"), b"broken backup").unwrap();
        let result = recovery::review_recovery(&fixture.0, &state_root, "1.0.0").unwrap_err();
        assert_eq!(result.code, "RECOVERY_BLOCKED");
        assert_eq!(fs::read(fixture.archive()).unwrap(), current_before);
        assert!(state_root.join("pending.json").exists());
    }

    #[test]
    fn recovery_review_blocks_leftover_writing_and_restore_temp() {
        let fixture = Fixture::new();
        let (state_root, _, _) = setup_pending(&fixture, true);
        for name in ["app.asar.dino-writing", "app.asar.dino-restore"] {
            let temp = fixture.0.join("resources").join(name);
            fs::write(&temp, b"partial").unwrap();
            assert_eq!(
                recovery::review_recovery(&fixture.0, &state_root, "1.0.0").unwrap_err().code,
                "RECOVERY_BLOCKED"
            );
            fs::remove_file(temp).unwrap();
        }
        assert!(state_root.join("pending.json").exists());
    }

    #[test]
    fn recovery_review_blocks_mismatched_target_and_pending_schema() {
        let fixture = Fixture::new();
        let (state_root, _, _) = setup_pending(&fixture, true);
        let marker = state_root.join("pending.json");
        let original = fs::read(&marker).unwrap();
        let mut document: Value = serde_json::from_slice(&original).unwrap();
        document["target"] = json!("another-installation");
        fs::write(&marker, serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(
            recovery::review_recovery(&fixture.0, &state_root, "1.0.0").unwrap_err().code,
            "RECOVERY_BLOCKED"
        );
        document["target"] = json!(fixture.0.to_string_lossy().to_string());
        document["schemaVersion"] = json!(2);
        fs::write(&marker, serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(
            recovery::review_recovery(&fixture.0, &state_root, "1.0.0").unwrap_err().code,
            "RECOVERY_BLOCKED"
        );
    }

    #[test]
    fn recovery_review_blocks_conflicting_state_and_wrong_sha() {
        let fixture = Fixture::new();
        let (state_root, _, current_before) = setup_pending(&fixture, true);
        let marker: Value = serde_json::from_slice(&fs::read(state_root.join("pending.json")).unwrap()).unwrap();
        let mut state = marker.clone();
        state["status"] = json!("APPLIED");
        state["patchedSha256"] = json!("B".repeat(64));
        fs::write(state_root.join("state.json"), serde_json::to_vec(&state).unwrap()).unwrap();
        assert_eq!(
            recovery::review_recovery(&fixture.0, &state_root, "1.0.0").unwrap_err().code,
            "RECOVERY_BLOCKED"
        );
        fs::remove_file(state_root.join("state.json")).unwrap();
        let mut bad = marker.clone();
        bad["originalSha256"] = json!("invalid");
        fs::write(state_root.join("pending.json"), serde_json::to_vec(&bad).unwrap()).unwrap();
        assert_eq!(
            recovery::review_recovery(&fixture.0, &state_root, "1.0.0").unwrap_err().code,
            "RECOVERY_BLOCKED"
        );
        assert_eq!(fs::read(fixture.archive()).unwrap(), current_before);
    }

}
