//! Read-only review of a pending installed-ASAR patch transaction.
//! This diagnostic does not create, delete, rename, or update any user files.

use crate::{regular, verify_installed, Checked, Failure};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

const MAX_JSON_BYTES: u64 = 1024 * 1024;
const MAX_ASAR_BYTES: u64 = 1024 * 1024 * 1024;

fn blocked(reason: &str) -> Failure {
    Failure {
        code: "RECOVERY_BLOCKED",
        reason: reason.to_owned(),
    }
}

fn optional_regular(path: &Path) -> Checked<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            regular(path, false)
                .map_err(|_| blocked("상태 기록이 일반 파일이 아니거나 링크입니다."))?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(blocked("상태 기록 경로를 검사할 수 없습니다.")),
    }
}

fn read_json(path: &Path) -> Checked<Value> {
    let metadata =
        regular(path, false).map_err(|_| blocked("복구 기록이 없거나 일반 파일이 아닙니다."))?;
    if metadata.len() > MAX_JSON_BYTES {
        return Err(blocked("복구 기록 JSON이 너무 큽니다."));
    }
    let bytes = fs::read(path).map_err(|_| blocked("복구 기록 JSON을 읽지 못했습니다."))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(blocked("복구 기록이 검사 중 변경됐습니다."));
    }
    serde_json::from_slice(&bytes).map_err(|_| blocked("복구 JSON 형식이 올바르지 않습니다."))
}

fn file_sha(path: &Path, max_size: u64) -> Checked<String> {
    let before =
        regular(path, false).map_err(|_| blocked("검사 파일이 없거나 일반 파일이 아닙니다."))?;
    if before.len() > max_size {
        return Err(blocked("검사 파일이 허용 크기를 초과했습니다."));
    }
    let mut file = File::open(path).map_err(|_| blocked("검사 파일을 열지 못했습니다."))?;
    let mut digest = Sha256::new();
    let mut count = 0u64;
    let mut chunk = [0u8; 1024 * 1024];
    loop {
        let size = file
            .read(&mut chunk)
            .map_err(|_| blocked("파일을 끝까지 읽지 못했습니다."))?;
        if size == 0 {
            break;
        }
        count = count
            .checked_add(size as u64)
            .ok_or_else(|| blocked("파일 크기 초과"))?;
        if count > max_size {
            return Err(blocked("검사 중 파일 크기가 허용 범위를 넘었습니다."));
        }
        digest.update(&chunk[..size]);
    }
    let after = regular(path, false).map_err(|_| blocked("검사 중 파일 경로가 바뀌었습니다."))?;
    let opened = file
        .metadata()
        .map_err(|_| blocked("파일 상태 확인 실패"))?;
    if count != before.len()
        || count != after.len()
        || count != opened.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(blocked("검사 중 파일이 변경됐습니다."));
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect())
}

fn sha_field<'a>(record: &'a Value, key: &str) -> Checked<&'a str> {
    let value = record
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| blocked("복구 기록의 SHA-256 값이 없습니다."))?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())
    {
        return Err(blocked("복구 기록의 SHA-256 형식이 잘못됐습니다."));
    }
    Ok(value)
}

fn field_is(record: &Value, key: &str, expected: &str) -> bool {
    record.get(key).and_then(Value::as_str) == Some(expected)
}

pub(crate) fn review_recovery(
    root: &Path,
    state_root: &Path,
    patch_version: &str,
) -> Checked<Value> {
    let report = verify_installed(root)?;
    let version = report["version"]
        .as_str()
        .ok_or_else(|| blocked("공식 원본 버전이 없습니다."))?;
    let current_sha = report["sha256"]
        .as_str()
        .ok_or_else(|| blocked("ASAR 해시가 없습니다."))?;
    regular(state_root, true)
        .map_err(|_| blocked("복구 기록 폴더가 없거나 일반 폴더가 아닙니다."))?;
    if patch_version.is_empty() || patch_version.len() > 48 {
        return Err(blocked("패치 버전이 올바르지 않습니다."));
    }
    let target = root.to_string_lossy();

    for name in ["app.asar.dino-writing", "app.asar.dino-restore"] {
        // A dangling symlink is also treated as a leftover transaction.
        match fs::symlink_metadata(root.join("resources").join(name)) {
            Ok(_) => {
                return Err(blocked(
                    "이전 ASAR 임시 파일이 남아 있어 복구를 차단합니다.",
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(blocked("ASAR 임시 파일 상태를 확인하지 못했습니다.")),
        }
    }

    let marker = state_root.join("pending.json");
    let pending = read_json(&marker)?;
    if pending.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !field_is(&pending, "target", &target)
        || !field_is(&pending, "version", version)
        || !field_is(&pending, "patchVersion", patch_version)
        || !field_is(&pending, "status", "APPLIED")
    {
        return Err(blocked(
            "복구 기록의 설치 위치·버전·상태가 원본과 다릅니다.",
        ));
    }
    let original = sha_field(&pending, "originalSha256")?;
    let patched = sha_field(&pending, "patchedSha256")?;
    if original == patched {
        return Err(blocked(
            "원본과 패치 SHA-256이 동일해 복구를 판정할 수 없습니다.",
        ));
    }
    let backup = state_root.join("original-app.asar");
    let backup_sha = file_sha(&backup, MAX_ASAR_BYTES)?;
    if backup_sha != original {
        return Err(blocked(
            "원본 백업의 SHA-256이 복구 기록과 일치하지 않습니다.",
        ));
    }
    let mode = if current_sha == patched {
        "APPLIED"
    } else if current_sha == original {
        "UNPATCHED"
    } else {
        return Err(blocked(
            "현재 app.asar가 기록의 원본·패치본과 모두 다릅니다.",
        ));
    };
    let state = state_root.join("state.json");
    if optional_regular(&state)? {
        let existing = read_json(&state)?;
        if !field_is(&existing, "target", &target)
            || !field_is(&existing, "version", version)
            || !field_is(&existing, "patchVersion", patch_version)
            || !field_is(&existing, "originalSha256", original)
            || !matches!(
                existing.get("status").and_then(Value::as_str),
                Some("APPLIED" | "UNPATCHED")
            )
        {
            return Err(blocked("기존 상태 기록이 복구 기록과 충돌합니다."));
        }
        if field_is(&existing, "status", "APPLIED")
            && !field_is(&existing, "patchedSha256", current_sha)
        {
            return Err(blocked(
                "적용된 것으로 기록된 패치의 해시가 현재 파일과 다릅니다.",
            ));
        }
    }

    let marker_sha = file_sha(&marker, MAX_JSON_BYTES)?;
    if file_sha(&root.join("resources").join("app.asar"), MAX_ASAR_BYTES)? != current_sha
        || file_sha(&backup, MAX_ASAR_BYTES)? != original
        || file_sha(&marker, MAX_JSON_BYTES)? != marker_sha
    {
        return Err(blocked("복구 검증 중 원본·백업·복구 기록이 변경됐습니다."));
    }
    Ok(json!({
        "status": "RECOVERY_VERIFIED",
        "targetKind": "INSTALLED_ASAR",
        "readOnly": true,
        "recoveryAvailable": true,
        "mode": mode,
        "version": version,
        "archiveSha256": current_sha,
        "backupSha256": backup_sha,
        "markerSha256": marker_sha,
        "reason": "원본과 백업·복구 기록을 대조했습니다. 실제 복구는 기존 관리자에서만 수행합니다."
    }))
}
