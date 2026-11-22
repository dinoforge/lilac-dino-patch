//! Separate, fail-closed Windows updater transaction engine.
//!
//! The shipping updater recovers interrupted transactions and installs only a
//! fixed GitHub manager EXE whose API SHA-256 was checked before the user
//! approved the request. The API digest is not a release signature.

use crate::release_update::{self, BetaVersion};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PRODUCT_ID: &str = "com.dinoforge.lilac-dino-patch-manager";
pub const TEST_PRODUCT_ID: &str = "com.dinoforge.lilac-dino-patch-manager.test";
pub const MANAGER_FILE: &str = "dino-native-manager.exe";
pub const UPDATER_FILE: &str = "dino-native-updater.exe";
pub const INSTALL_MARKER_FILE: &str = ".dino-manager-install.json";
pub const UPDATE_DIRECTORY: &str = ".dino-update";
const JOURNAL_FILE: &str = "journal.jsonl";
const UPDATE_REQUEST_FILE: &str = "install-request.json";
const UPDATE_RESULT_FILE: &str = "result.json";
const UPDATE_REQUEST_SCHEMA: u64 = 1;
const SCHEMA_VERSION: u64 = 1;
const MANAGER_WAIT: Duration = Duration::from_secs(30);
const HEALTH_WAIT: Duration = Duration::from_secs(15);
const RESERVE_BYTES: u64 = 1024 * 1024;
#[cfg(feature = "updater-test-harness")]
const TEST_CANDIDATE_VERSION: &str = "0.2.0-beta.8";

pub fn compiled_product_id() -> &'static str {
    if cfg!(feature = "updater-test-harness") {
        TEST_PRODUCT_ID
    } else {
        PRODUCT_ID
    }
}

pub fn compiled_manager_version() -> String {
    #[cfg(feature = "updater-test-harness")]
    if let Some(version) = std::env::var_os("DINO_UPDATER_TEST_VERSION") {
        if let Some(version) = version.to_str() {
            return version.to_owned();
        }
    }
    env!("CARGO_PKG_VERSION").to_owned()
}

#[derive(Clone, Debug)]
pub struct UpdateLayout {
    pub root: PathBuf,
    pub manager: PathBuf,
    marker: PathBuf,
    update_dir: PathBuf,
    staging_dir: PathBuf,
    staged_manager: PathBuf,
    update_request: PathBuf,
    update_result: PathBuf,
    backups_dir: PathBuf,
    journal: PathBuf,
    health_dir: PathBuf,
}

impl UpdateLayout {
    fn from_root(root: &Path) -> Result<Self, String> {
        reject_reparse_components(root)?;
        let root = fs::canonicalize(root).map_err(io_error("설치 폴더 확인 실패"))?;
        if !root.is_dir() {
            return Err("관리자 설치 경로가 폴더가 아닙니다.".into());
        }
        let update_dir = root.join(UPDATE_DIRECTORY);
        let staging_dir = update_dir.join("staging");
        let backups_dir = update_dir.join("backups");
        let health_dir = update_dir.join("health");
        Ok(Self {
            manager: root.join(MANAGER_FILE),
            marker: root.join(INSTALL_MARKER_FILE),
            journal: update_dir.join(JOURNAL_FILE),
            root,
            update_dir: update_dir.clone(),
            staging_dir: staging_dir.clone(),
            staged_manager: staging_dir.join("dino-native-manager.new.exe"),
            update_request: staging_dir.join(UPDATE_REQUEST_FILE),
            update_result: update_dir.join(UPDATE_RESULT_FILE),
            backups_dir,
            health_dir,
        })
    }

    fn from_running_updater() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(io_error("업데이터 실행 경로 확인 실패"))?;
        reject_reparse_components(&exe)?;
        if exe.file_name().and_then(|name| name.to_str()) != Some(UPDATER_FILE) {
            return Err("업데이터는 고정된 DinoPatch 설치 경로에서 실행해야 합니다.".into());
        }
        let parent = exe
            .parent()
            .ok_or_else(|| "업데이터 설치 폴더를 확인할 수 없습니다.".to_owned())?;
        Self::from_root(parent)
    }

    fn from_running_manager() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(io_error("관리자 실행 경로 확인 실패"))?;
        reject_reparse_components(&exe)?;
        if exe.file_name().and_then(|name| name.to_str()) != Some(MANAGER_FILE) {
            return Err("관리자는 고정된 DinoPatch 설치 파일 이름으로 실행해야 합니다.".into());
        }
        let parent = exe.parent().ok_or("관리자 설치 폴더를 확인할 수 없습니다.")?;
        Self::from_root(parent)
    }

    fn ensure_update_dirs(&self) -> Result<(), String> {
        for directory in [
            &self.update_dir,
            &self.staging_dir,
            &self.backups_dir,
            &self.health_dir,
        ] {
            if directory.exists() {
                reject_reparse_components(directory)?;
                if !directory.is_dir() {
                    return Err(format!(
                        "업데이트 폴더가 디렉터리가 아닙니다: {}",
                        directory.display()
                    ));
                }
            } else {
                fs::create_dir(directory).map_err(io_error("업데이트 폴더 생성 실패"))?;
                reject_reparse_components(directory)?;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct InstallMarker {
    product_id: String,
    version: String,
    manager_sha256: String,
}

impl InstallMarker {
    fn read(path: &Path) -> Result<Self, String> {
        ensure_regular_file(path)?;
        let value: Value = serde_json::from_slice(
            &fs::read(path).map_err(io_error("관리자 설치 기록 읽기 실패"))?,
        )
        .map_err(|_| "관리자 설치 기록 JSON이 손상됐습니다.".to_owned())?;
        if value.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            return Err("지원하지 않는 관리자 설치 기록 버전입니다.".into());
        }
        let product_id = text_field(&value, "productId")?;
        let version = text_field(&value, "managerVersion")?;
        let manager_sha256 = text_field(&value, "managerSha256")?.to_ascii_lowercase();
        validate_sha256(&manager_sha256)?;
        BetaVersion::parse_installed(&version)?;
        Ok(Self {
            product_id,
            version,
            manager_sha256,
        })
    }

    fn json(&self) -> Value {
        json!({
            "schemaVersion": SCHEMA_VERSION,
            "productId": self.product_id,
            "managerVersion": self.version,
            "managerSha256": self.manager_sha256
        })
    }
}

/// Not deserializable. Production creation is limited to the explicit
/// user-approved request validated by the companion updater.
#[derive(Clone, Debug)]
pub struct VerifiedUpdateAuthorization {
    product_id: String,
    release_tag: String,
    old_version: String,
    new_version: String,
    old_sha256: String,
    asset_sha256: String,
    staged_sha256: String,
    fixed_https_source: bool,
    api_digest_matches_file: bool,
    user_approved: bool,
    rollback_ready: bool,
    patch_root: Option<PathBuf>,
}

impl VerifiedUpdateAuthorization {
    #[cfg(feature = "updater-test-harness")]
    fn local_test(
        old_version: &str,
        new_version: &str,
        old_sha256: &str,
        staged_sha256: &str,
        product_id: &str,
    ) -> Self {
        let release_tag = format!("dino-v{new_version}");
        Self {
            product_id: product_id.to_owned(),
            release_tag,
            old_version: old_version.to_owned(),
            new_version: new_version.to_owned(),
            old_sha256: old_sha256.to_ascii_lowercase(),
            asset_sha256: staged_sha256.to_ascii_lowercase(),
            staged_sha256: staged_sha256.to_ascii_lowercase(),
            fixed_https_source: true,
            api_digest_matches_file: true,
            user_approved: true,
            rollback_ready: true,
            patch_root: None,
        }
    }

    fn from_request(value: &Value, nonce: &str) -> Result<Self, String> {
        Self::from_request_for_product(value, nonce, PRODUCT_ID)
    }

    fn from_request_for_product(
        value: &Value,
        nonce: &str,
        expected_product_id: &str,
    ) -> Result<Self, String> {
        if value.get("schemaVersion").and_then(Value::as_u64) != Some(UPDATE_REQUEST_SCHEMA)
            || text_field(value, "nonce")? != nonce
            || value.get("userApproved").and_then(Value::as_bool) != Some(true)
            || value.get("rollbackReady").and_then(Value::as_bool) != Some(true)
            || value.get("apiDigestMatchesFile").and_then(Value::as_bool) != Some(true)
        {
            return Err("업데이트 요청의 승인·digest·복구 준비 조건을 확인할 수 없습니다.".into());
        }
        if text_field(value, "productId")? != expected_product_id
            || text_field(value, "assetName")? != release_update::WINDOWS_X64_ASSET
        {
            return Err("고정 DinoPatch 관리자 자산 또는 제품 ID가 아닙니다.".into());
        }
        let release_tag = text_field(value, "releaseTag")?;
        let new_version = text_field(value, "newVersion")?;
        if BetaVersion::parse_release_tag(&release_tag)? != BetaVersion::parse_installed(&new_version)? {
            return Err("업데이트 태그와 관리자 버전이 일치하지 않습니다.".into());
        }
        let expected_url = format!(
            "{}/releases/download/{release_tag}/{}",
            release_update::RELEASES_BASE,
            release_update::WINDOWS_X64_ASSET
        );
        if text_field(value, "downloadUrl")? != expected_url {
            return Err("업데이트 다운로드 URL이 고정된 HTTPS 저장소와 일치하지 않습니다.".into());
        }
        let old_sha256 = text_field(value, "oldSha256")?.to_ascii_lowercase();
        let asset_sha256 = text_field(value, "apiSha256")?.to_ascii_lowercase();
        let staged_sha256 = text_field(value, "stagedSha256")?.to_ascii_lowercase();
        validate_sha256(&old_sha256)?;
        validate_sha256(&asset_sha256)?;
        validate_sha256(&staged_sha256)?;
        if asset_sha256 != staged_sha256 {
            return Err("GitHub API SHA-256과 준비된 관리자 파일이 일치하지 않습니다.".into());
        }
        Ok(Self {
            product_id: expected_product_id.into(),
            release_tag,
            old_version: text_field(value, "oldVersion")?,
            new_version,
            old_sha256,
            asset_sha256,
            staged_sha256,
            fixed_https_source: true,
            api_digest_matches_file: true,
            user_approved: true,
            rollback_ready: true,
            patch_root: None,
        })
    }

    fn validate(&self) -> Result<(), String> {
        if self.product_id != compiled_product_id() {
            return Err("업데이트 제품 식별자가 현재 관리자와 일치하지 않습니다.".into());
        }
        let tag_version = BetaVersion::parse_release_tag(&self.release_tag)?;
        let old = BetaVersion::parse_installed(&self.old_version)?;
        let new = BetaVersion::parse_installed(&self.new_version)?;
        if tag_version != new {
            return Err("업데이트 태그와 관리자 버전이 일치하지 않습니다.".into());
        }
        if !new.is_newer_than(&old) {
            return Err("동일 버전 또는 다운그레이드는 허용되지 않습니다.".into());
        }
        validate_sha256(&self.old_sha256)?;
        validate_sha256(&self.asset_sha256)?;
        validate_sha256(&self.staged_sha256)?;
        if self.asset_sha256 != self.staged_sha256 {
            return Err(
                "검증된 GitHub asset digest와 준비 파일 SHA-256이 일치하지 않습니다.".into(),
            );
        }
        let evidence = release_update::InstallEvidence::new(
            self.fixed_https_source,
            Some(self.api_digest_matches_file),
            self.user_approved,
            self.rollback_ready,
        );
        if !evidence.may_install() {
            return Err(format!("업데이트 설치 조건이 충족되지 않았습니다: {}", evidence.blockers().join(" ")));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Faults {
    manager_shutdown: bool,
    backup: bool,
    replacement: bool,
    start_check: bool,
    rollback: bool,
    interrupt_after_replace: bool,
}

#[derive(Clone, Debug)]
struct JournalRecord {
    seq: u64,
    transaction_id: String,
    state: String,
    product_id: String,
    old_version: String,
    new_version: String,
    old_sha256: String,
    new_sha256: String,
    old_marker_sha256: String,
    backup_name: String,
    marker_backup_name: String,
}

impl JournalRecord {
    fn parse(value: &Value) -> Result<Self, String> {
        if value.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            return Err("업데이트 복구 저널 schema가 올바르지 않습니다.".into());
        }
        Ok(Self {
            seq: value
                .get("seq")
                .and_then(Value::as_u64)
                .ok_or("저널 순번이 없습니다.")?,
            transaction_id: text_field(value, "transactionId")?,
            state: text_field(value, "state")?,
            product_id: text_field(value, "productId")?,
            old_version: text_field(value, "oldVersion")?,
            new_version: text_field(value, "newVersion")?,
            old_sha256: text_field(value, "oldSha256")?.to_ascii_lowercase(),
            new_sha256: text_field(value, "newSha256")?.to_ascii_lowercase(),
            old_marker_sha256: text_field(value, "oldMarkerSha256")?.to_ascii_lowercase(),
            backup_name: text_field(value, "backupName")?,
            marker_backup_name: text_field(value, "markerBackupName")?,
        })
    }

    fn to_value(&self, previous_hash: &str) -> Result<Value, String> {
        let mut value = json!({
            "schemaVersion": SCHEMA_VERSION,
            "seq": self.seq,
            "transactionId": self.transaction_id,
            "state": self.state,
            "productId": self.product_id,
            "oldVersion": self.old_version,
            "newVersion": self.new_version,
            "oldSha256": self.old_sha256,
            "newSha256": self.new_sha256,
            "oldMarkerSha256": self.old_marker_sha256,
            "backupName": self.backup_name,
            "markerBackupName": self.marker_backup_name,
            "previousRecordHash": previous_hash
        });
        let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        let digest = sha256_bytes(&bytes);
        value["recordHash"] = json!(digest);
        Ok(value)
    }
}

#[derive(Clone, Debug)]
pub struct UpdateOutcome {
    pub state: String,
    pub message: String,
    pub old_sha256: String,
    pub current_sha256: Option<String>,
    pub backup_path: Option<PathBuf>,
}

impl UpdateOutcome {
    fn from_record(layout: &UpdateLayout, record: &JournalRecord, message: String) -> Self {
        Self {
            state: record.state.clone(),
            message,
            old_sha256: record.old_sha256.clone(),
            current_sha256: sha256_file(&layout.manager).ok(),
            backup_path: Some(layout.backups_dir.join(&record.backup_name)),
        }
    }
}

/// Shipping updater entry point. It accepts only recovery or a nonce-bound,
/// user-approved request in its own fixed installation folder.
pub fn run_production(args: &[String]) -> Result<String, String> {
    let layout = UpdateLayout::from_running_updater()?;
    match args {
        [] => recover_production(&layout),
        [command] if command == "--recover-and-restart-manager" => {
            let message = recover_production(&layout)?;
            spawn_manager(&layout.manager)?;
            Ok(message)
        }
        [command, nonce] if command == "--apply-approved-update" => {
            run_production_apply(&layout, nonce)
        }
        _ => Err("업데이터는 복구 또는 승인된 업데이트 nonce만 허용합니다.".into()),
    }
}

fn recover_production(layout: &UpdateLayout) -> Result<String, String> {
    reject_reparse_components(&layout.root)?;
    let _update_lock = UpdateLock::acquire(&layout.root, Duration::from_millis(0))?;
    let mut manager_gate = None;
    let mut recovered_message = None;
    let pending = if layout.journal.exists() {
        latest_record(&layout.journal)?
    } else {
        None
    };
    if pending.as_ref().is_some_and(|record| !is_terminal(&record.state)) {
        if pending.as_ref().is_some_and(|record| record.product_id != PRODUCT_ID) {
            return Err("복구 저널의 제품 식별자가 다릅니다. 복구 자료를 보존했습니다.".into());
        }
        manager_gate = Some(wait_for_manager_exit(&layout.root, MANAGER_WAIT)?);
        ensure_manager_process_not_running(&layout.root)?;
        if let Some(outcome) = recover_pending_locked(layout, PRODUCT_ID, false)? {
            match outcome.state.as_str() {
                "ROLLED_BACK" => {
                    recovered_message = Some(format!(
                    "중단된 업데이트를 이전 버전으로 복구했습니다. SHA-256: {}",
                    outcome.old_sha256
                    ));
                }
                "RECOVERY_FAILED" => return Err("관리자 업데이트 복구가 완료되지 않았습니다. 백업과 복구 기록을 보존했습니다.".into()),
                state => return Err(format!("예상하지 못한 업데이트 복구 상태 {state}입니다.")),
            }
        }
    }
    // A completed or new installation must match its marker. A pending
    // transaction is recovered first because a power loss can leave the new
    // EXE and old marker (or a missing target/marker) in place.
    let marker = InstallMarker::read(&layout.marker)?;
    if marker.product_id != PRODUCT_ID {
        return Err("관리자 설치 기록의 제품 식별자가 다릅니다. 복구 자료를 보존했습니다.".into());
    }
    ensure_regular_file(&layout.manager)?;
    let current_manager_sha256 = sha256_file(&layout.manager)?;
    if marker.manager_sha256 != current_manager_sha256 {
        return Err("관리자 설치 기록과 실행 파일이 일치하지 않습니다. 복구 자료를 보존했습니다.".into());
    }
    let latest = latest_record(&layout.journal)?;
    let mut cleaned_staging = false;
    let mut cleanup_warning = None;
    if let Some(record) = latest.filter(|record| is_terminal(&record.state)) {
        let artifacts = terminal_artifact_presence(layout)?;
        if artifacts.any() {
            let _cleanup_manager_gate = if manager_gate.is_none() {
                Some(wait_for_manager_exit(&layout.root, MANAGER_WAIT)?)
            } else {
                None
            };
            ensure_manager_process_not_running(&layout.root)?;
            let cleanup_result = read_terminal_request_authorization(layout, &record, PRODUCT_ID)
                .and_then(|authorization| {
                    cleanup_terminal_artifacts(
                        layout,
                        &record,
                        &marker,
                        &current_manager_sha256,
                        PRODUCT_ID,
                        authorization.as_ref(),
                    )
                });
            match cleanup_result {
                Ok(_) => cleaned_staging = true,
                Err(error) if recovered_message.is_some() => cleanup_warning = Some(error),
                Err(error) => return Err(error),
            }
        }
    }
    if let Some(message) = recovered_message {
        if cleaned_staging {
            Ok(format!("{message} 남은 업데이트 준비 파일도 확인 후 정리했습니다."))
        } else if let Some(warning) = cleanup_warning {
            Ok(format!("{message} 남은 업데이트 요청은 검증되지 않아 보존했습니다: {warning}"))
        } else {
            Ok(message)
        }
    } else if cleaned_staging {
        Ok("완료된 업데이트 저널과 일치하는 남은 준비 파일을 정리했습니다.".into())
    } else {
        Ok("복구할 중단 업데이트가 없습니다.".into())
    }
}

fn run_production_apply(layout: &UpdateLayout, nonce: &str) -> Result<String, String> {
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("업데이트 승인 nonce 형식이 올바르지 않습니다.".into());
    }
    let outcome = {
        // Own the updater mutex before reading the request, and keep it through
        // transaction validation and commit. A duplicate process must not
        // mistake another process's live journal for a failed install.
        let _update_lock = UpdateLock::acquire(&layout.root, Duration::from_millis(0))?;
        (|| {
            reject_reparse_components(&layout.root)?;
            ensure_regular_file(&layout.manager)?;
            ensure_regular_file(&layout.staged_manager)?;
            ensure_regular_file(&layout.marker)?;
            ensure_regular_file(&layout.update_request)?;
            let value: Value = serde_json::from_slice(
                &fs::read(&layout.update_request)
                    .map_err(io_error("업데이트 승인 요청 읽기 실패"))?,
            )
            .map_err(|_| "업데이트 승인 요청 JSON이 손상됐습니다.".to_owned())?;
            let authorization = VerifiedUpdateAuthorization::from_request(&value, nonce)?;
            let marker = InstallMarker::read(&layout.marker)?;
            if marker.product_id != PRODUCT_ID
                || marker.version != authorization.old_version
                || marker.manager_sha256 != authorization.old_sha256
                || sha256_file(&layout.manager)? != marker.manager_sha256
            {
                return Err("현재 관리자 버전·SHA-256이 승인 요청과 다릅니다. 파일을 변경하지 않았습니다.".into());
            }
            if sha256_file(&layout.staged_manager)? != authorization.staged_sha256 {
                return Err("교체 직전 다운로드 EXE의 SHA-256이 승인 digest와 다릅니다.".into());
            }
            validate_manager_pe(&layout.staged_manager)?;
            authorization.validate()?;
            let applied = apply_authorized_under_lock(layout, &authorization, Faults::default())?;
            match applied.state.as_str() {
                "COMMITTED" => Ok((true, applied.message)),
                "ROLLED_BACK" => Ok((false, applied.message)),
                "RECOVERY_FAILED" => Err("업데이트 실패 후 원본 복구를 완료하지 못했습니다. 백업과 복구 기록을 보존했습니다.".into()),
                state => Err(format!("예상하지 못한 업데이트 결과 상태 {state}입니다.")),
            }
        })()
    };

    match outcome {
        Ok((true, message)) => {
            let (message, cleanup_complete) = cleanup_after_terminal_update(layout, message);
            let result_write = write_update_result(layout, "COMMITTED", &message);
            if cleanup_complete {
                remove_matching_request(layout, nonce);
            }
            let restart = restart_verified_manager(layout);
            combine_result_and_restart(result_write, restart)?;
            Ok(message)
        }
        Ok((false, message)) => {
            let (message, cleanup_complete) = cleanup_after_terminal_update(layout, message);
            let result_write = write_update_result(layout, "ROLLED_BACK", &message);
            if cleanup_complete {
                remove_matching_request(layout, nonce);
            }
            let restart = restart_verified_manager(layout);
            combine_result_and_restart(result_write, restart)?;
            Err(message)
        }
        Err(error) => {
            let state = latest_record(&layout.journal)
                .ok()
                .flatten()
                .map(|record| record.state)
                .unwrap_or_else(|| "NOT_REPLACED".into());
            let recovery = if state == "NOT_REPLACED" {
                Ok("적용 전에 중단되어 승인 요청과 준비 파일을 보존했습니다.".to_owned())
            } else {
                recover_production(layout)
            };
            match recovery {
                Ok(recovery_message) => {
                    let final_state = latest_record(&layout.journal)
                        .ok()
                        .flatten()
                        .map(|record| record.state)
                        .unwrap_or_else(|| state.clone());
                    let final_message = format!("{error} {recovery_message}");
                    let result_write = write_update_result(layout, &final_state, &final_message);
                    let restart = restart_verified_manager(layout);
                    combine_result_and_restart(result_write, restart)?;
                    Err(final_message)
                }
                Err(recovery_error) => {
                    let message = format!(
                        "{error} 자동 복구를 완료하지 못했습니다: {recovery_error}. EXE 백업과 복구 기록을 보존했습니다."
                    );
                    let _ = write_update_result(layout, "RECOVERY_FAILED", &message);
                    Err(message)
                }
            }
        }
    }
}

fn cleanup_after_terminal_update(layout: &UpdateLayout, message: String) -> (String, bool) {
    match recover_production(layout) {
        Ok(_) => (message, true),
        Err(error) => (
            format!(
                "{message} 완료 상태는 기록했지만 남은 업데이트 준비 파일 검증·정리는 실패해 자료를 보존했습니다: {error}"
            ),
            false,
        ),
    }
}

fn combine_result_and_restart(
    result_write: Result<(), String>,
    restart: Result<(), String>,
) -> Result<(), String> {
    match (result_write, restart) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(result_error), Ok(())) => Err(format!(
            "업데이트 결과 기록은 저장하지 못했지만 관리자를 다시 시작했습니다: {result_error}"
        )),
        (Ok(()), Err(restart_error)) => Err(restart_error),
        (Err(result_error), Err(restart_error)) => Err(format!(
            "업데이트 결과 기록 실패: {result_error}; 관리자 재시작 실패: {restart_error}"
        )),
    }
}

fn restart_verified_manager(layout: &UpdateLayout) -> Result<(), String> {
    reject_reparse_components(&layout.root)?;
    ensure_regular_file(&layout.manager)?;
    validate_manager_pe(&layout.manager)?;
    let marker = InstallMarker::read(&layout.marker)?;
    if marker.product_id != PRODUCT_ID || marker.manager_sha256 != sha256_file(&layout.manager)? {
        return Err("관리자 EXE와 설치 표식이 일치하지 않아 다시 시작하지 않았습니다. 백업과 복구 기록을 확인하세요.".into());
    }
    spawn_manager(&layout.manager)
}

fn write_update_result(layout: &UpdateLayout, state: &str, message: &str) -> Result<(), String> {
    layout.ensure_update_dirs()?;
    let nonce = new_transaction_id();
    let temp = layout.update_dir.join(format!(".result-{nonce}.tmp"));
    let value = json!({
        "schemaVersion": UPDATE_REQUEST_SCHEMA,
        "state": state,
        "message": message.chars().take(2000).collect::<String>(),
        "recordedAt": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
    });
    let bytes = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    write_new_synced(&temp, &bytes)?;
    atomic_replace(&temp, &layout.update_result)?;
    Ok(())
}

fn remove_matching_request(layout: &UpdateLayout, nonce: &str) {
    let Ok(bytes) = fs::read(&layout.update_request) else { return };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return };
    if value.get("nonce").and_then(Value::as_str) == Some(nonce) {
        let _ = fs::remove_file(&layout.update_request);
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct TerminalArtifacts {
    request: bool,
    staged_manager: bool,
}

impl TerminalArtifacts {
    fn any(self) -> bool {
        self.request || self.staged_manager
    }
}

fn terminal_artifact_presence(layout: &UpdateLayout) -> Result<TerminalArtifacts, String> {
    Ok(TerminalArtifacts {
        request: path_entry_exists(&layout.update_request)?,
        staged_manager: path_entry_exists(&layout.staged_manager)?,
    })
}

fn path_entry_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("업데이트 준비 파일 상태 조회 실패: {error}")),
    }
}

fn read_terminal_request_authorization(
    layout: &UpdateLayout,
    record: &JournalRecord,
    expected_product_id: &str,
) -> Result<Option<VerifiedUpdateAuthorization>, String> {
    if !path_entry_exists(&layout.update_request)? {
        return Ok(None);
    }
    ensure_regular_file(&layout.update_request)?;
    let value: Value = serde_json::from_slice(
        &fs::read(&layout.update_request).map_err(io_error("남은 업데이트 승인 요청 읽기 실패"))?,
    )
    .map_err(|_| "남은 업데이트 승인 요청 JSON이 손상됐습니다. 파일과 복구 기록을 보존했습니다.".to_owned())?;
    let nonce = text_field(&value, "nonce")?;
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("남은 업데이트 승인 요청 nonce가 올바르지 않습니다. 파일과 복구 기록을 보존했습니다.".into());
    }
    let authorization = VerifiedUpdateAuthorization::from_request_for_product(
        &value,
        &nonce,
        expected_product_id,
    )?;
    authorization.validate()?;
    validate_terminal_request_binding(record, &authorization)?;
    Ok(Some(authorization))
}

fn validate_terminal_request_binding(
    record: &JournalRecord,
    authorization: &VerifiedUpdateAuthorization,
) -> Result<(), String> {
    if !is_terminal(&record.state)
        || authorization.product_id != record.product_id
        || authorization.old_version != record.old_version
        || authorization.new_version != record.new_version
        || authorization.old_sha256 != record.old_sha256
        || authorization.asset_sha256 != record.new_sha256
        || authorization.staged_sha256 != record.new_sha256
    {
        return Err("남은 승인 요청이 완료된 업데이트 저널과 일치하지 않습니다. 파일과 복구 기록을 보존했습니다.".into());
    }
    Ok(())
}

fn validate_terminal_artifacts(
    layout: &UpdateLayout,
    record: &JournalRecord,
    marker: &InstallMarker,
    current_manager_sha256: &str,
    expected_product_id: &str,
    authorization: Option<&VerifiedUpdateAuthorization>,
) -> Result<TerminalArtifacts, String> {
    if !is_terminal(&record.state) || record.product_id != expected_product_id {
        return Err("완료 상태가 아닌 업데이트 저널은 준비 파일 정리 근거로 사용할 수 없습니다.".into());
    }
    validate_sha256(&record.old_sha256)?;
    validate_sha256(&record.new_sha256)?;
    BetaVersion::parse_installed(&record.old_version)?;
    BetaVersion::parse_installed(&record.new_version)?;

    let artifacts = terminal_artifact_presence(layout)?;
    if !artifacts.any() {
        return Ok(artifacts);
    }
    let (expected_version, expected_sha256) = match record.state.as_str() {
        "COMMITTED" => (&record.new_version, &record.new_sha256),
        "ROLLED_BACK" => (&record.old_version, &record.old_sha256),
        _ => unreachable!("terminal state is checked above"),
    };
    if marker.product_id != expected_product_id
        || marker.version != *expected_version
        || marker.manager_sha256 != *expected_sha256
        || current_manager_sha256 != expected_sha256
    {
        return Err("현재 EXE·설치 표식이 완료된 업데이트 저널과 일치하지 않습니다. 준비 파일을 보존했습니다.".into());
    }

    if artifacts.request {
        let authorization = authorization.ok_or_else(|| {
            "남은 업데이트 승인 요청을 검증하지 못했습니다. 파일과 복구 기록을 보존했습니다.".to_owned()
        })?;
        authorization.validate()?;
        validate_terminal_request_binding(record, authorization)?;
    }
    if artifacts.staged_manager {
        ensure_regular_file(&layout.staged_manager)?;
        if sha256_file(&layout.staged_manager)? != record.new_sha256 {
            return Err("남은 준비 EXE가 완료된 업데이트 저널의 SHA-256과 다릅니다. 파일을 보존했습니다.".into());
        }
    }
    Ok(artifacts)
}

fn cleanup_terminal_artifacts(
    layout: &UpdateLayout,
    record: &JournalRecord,
    marker: &InstallMarker,
    current_manager_sha256: &str,
    expected_product_id: &str,
    authorization: Option<&VerifiedUpdateAuthorization>,
) -> Result<TerminalArtifacts, String> {
    let artifacts = validate_terminal_artifacts(
        layout,
        record,
        marker,
        current_manager_sha256,
        expected_product_id,
        authorization,
    )?;

    // All existing artifacts are validated before either path is removed. If
    // cleanup is interrupted, the next manager startup can safely retry from
    // the terminal journal and whichever matching artifact remains.
    if artifacts.request {
        ensure_regular_file(&layout.update_request)?;
        let current_authorization = read_terminal_request_authorization(
            layout,
            record,
            expected_product_id,
        )?;
        validate_terminal_request_binding(
            record,
            current_authorization
                .as_ref()
                .ok_or("승인 요청이 정리 직전에 사라졌습니다. 준비 파일을 보존했습니다.")?,
        )?;
        fs::remove_file(&layout.update_request)
            .map_err(io_error("완료된 업데이트 승인 요청 정리 실패"))?;
    }
    if artifacts.staged_manager {
        ensure_regular_file(&layout.staged_manager)?;
        if sha256_file(&layout.staged_manager)? != record.new_sha256 {
            return Err("정리 직전 준비 EXE SHA-256이 바뀌어 파일을 보존했습니다.".into());
        }
        fs::remove_file(&layout.staged_manager)
            .map_err(io_error("완료된 업데이트 준비 EXE 정리 실패"))?;
    }
    Ok(artifacts)
}

fn spawn_manager(manager: &Path) -> Result<(), String> {
    let mut command = Command::new(manager);
    command.current_dir(manager.parent().ok_or("관리자 설치 폴더가 없습니다.")?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command.spawn().map(|_| ()).map_err(io_error("업데이트 후 관리자 다시 시작 실패"))
}

/// Called after the manager owns its session mutex. This creates an updater
/// marker only for a colocated, validated manager/updater package and never
/// overwrites an existing or damaged marker.
pub fn initialize_manager_install_marker() -> Result<(), String> {
    let layout = UpdateLayout::from_running_manager()?;
    reject_reparse_components(&layout.root)?;
    ensure_regular_file(&layout.manager)?;
    validate_manager_pe(&layout.manager)?;
    let updater = layout.root.join(UPDATER_FILE);
    ensure_regular_file(&updater)?;
    validate_updater_pe(&updater)?;
    let manager_hash = sha256_file(&layout.manager)?;
    if layout.marker.exists() {
        let marker = InstallMarker::read(&layout.marker)?;
        if marker.product_id == PRODUCT_ID
            && marker.version == compiled_manager_version()
            && marker.manager_sha256 == manager_hash
        {
            return Ok(());
        }
        return Err("기존 관리자 설치 기록이 현재 파일과 다릅니다. 자동으로 덮어쓰지 않았습니다.".into());
    }
    if layout.journal.exists() {
        return Err("설치 기록 없이 업데이트 저널이 있어 새 설치 표식을 만들지 않았습니다.".into());
    }
    let marker = InstallMarker {
        product_id: PRODUCT_ID.into(),
        version: compiled_manager_version(),
        manager_sha256: manager_hash,
    };
    let bytes = serde_json::to_vec_pretty(&marker.json()).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&layout.marker)
        .map_err(io_error("관리자 설치 표식 생성 실패"))?;
    file.write_all(&bytes).map_err(io_error("관리자 설치 표식 쓰기 실패"))?;
    file.sync_all().map_err(io_error("관리자 설치 표식 동기화 실패"))?;
    if sha256_file(&layout.marker)? != sha256_bytes(&bytes) {
        return Err("초기 관리자 설치 표식 SHA-256 검증 실패".into());
    }
    Ok(())
}

pub fn stage_path_for_current_manager() -> Result<PathBuf, String> {
    let layout = UpdateLayout::from_running_manager()?;
    validate_current_install(&layout)?;
    validate_updater_pe(&layout.root.join(UPDATER_FILE))?;
    layout.ensure_update_dirs()?;
    if layout.staged_manager.exists() || layout.update_request.exists() {
        return Err("이전 업데이트 준비 파일이 있어 덮어쓰지 않았습니다. 진단을 확인하세요.".into());
    }
    if latest_record(&layout.journal)?.is_some_and(|record| !is_terminal(&record.state)) {
        return Err("미완료 업데이트 복구 기록이 있어 새 다운로드를 막았습니다.".into());
    }
    Ok(layout.staged_manager)
}

/// Prevents the UI from offering a download that cannot be installed because
/// the companion updater package or this install's marker is unavailable.
pub fn validate_online_update_installation() -> Result<(), String> {
    let layout = UpdateLayout::from_running_manager()?;
    validate_current_install(&layout)?;
    validate_updater_pe(&layout.root.join(UPDATER_FILE))?;
    if latest_record(&layout.journal)?.is_some_and(|record| !is_terminal(&record.state)) {
        return Err("미완료 업데이트 복구 기록이 있습니다. 복구가 끝나기 전에는 새 업데이트를 시작할 수 없습니다.".into());
    }
    Ok(())
}

/// If an interrupted transaction or validated terminal staging files remain,
/// hand recovery/cleanup to the companion updater before this manager takes
/// its lifetime mutex. The caller must exit after `Ok(true)` so the updater
/// can acquire the install gate and then relaunch it.
pub fn handoff_pending_recovery() -> Result<bool, String> {
    let layout = UpdateLayout::from_running_manager()?;
    if !layout.journal.exists() {
        return Ok(false);
    }
    let Some(record) = latest_record(&layout.journal)? else {
        return Ok(false);
    };
    if record.product_id != PRODUCT_ID {
        return Err("업데이트 저널의 제품 식별자가 달라 자동 복구를 시작하지 않았습니다.".into());
    }
    let needs_recovery = !is_terminal(&record.state);
    let needs_staging_cleanup = if needs_recovery {
        false
    } else {
        let artifacts = terminal_artifact_presence(&layout)?;
        if artifacts.any() {
            ensure_regular_file(&layout.manager)?;
            ensure_regular_file(&layout.marker)?;
            let marker = InstallMarker::read(&layout.marker)?;
            let current_manager_sha256 = sha256_file(&layout.manager)?;
            let authorization =
                read_terminal_request_authorization(&layout, &record, PRODUCT_ID)?;
            validate_terminal_artifacts(
                &layout,
                &record,
                &marker,
                &current_manager_sha256,
                PRODUCT_ID,
                authorization.as_ref(),
            )?;
            true
        } else {
            false
        }
    };
    if !needs_recovery && !needs_staging_cleanup {
        return Ok(false);
    }
    let updater = layout.root.join(UPDATER_FILE);
    ensure_regular_file(&updater)?;
    validate_updater_pe(&updater)?;
    let mut command = Command::new(&updater);
    command
        .arg("--recover-and-restart-manager")
        .current_dir(&layout.root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map_err(io_error("중단된 관리자 업데이트 복구 프로세스 시작 실패"))?;
    Ok(true)
}

pub fn approve_and_launch_update(
    candidate: &release_update::ReleaseCandidate,
    downloaded_sha256: &str,
    user_approved: bool,
) -> Result<(), String> {
    if !user_approved {
        return Err("사용자가 업데이트 설치를 승인하지 않았습니다.".into());
    }
    release_update::validate_update_candidate(candidate)?;
    let layout = UpdateLayout::from_running_manager()?;
    validate_current_install(&layout)?;
    let updater = layout.root.join(UPDATER_FILE);
    ensure_regular_file(&updater)?;
    validate_updater_pe(&updater)?;
    ensure_regular_file(&layout.staged_manager)?;
    validate_manager_pe(&layout.staged_manager)?;
    let marker = InstallMarker::read(&layout.marker)?;
    let staged_sha = sha256_file(&layout.staged_manager)?;
    let digest_match = staged_sha == candidate.sha256 && staged_sha == downloaded_sha256;
    let evidence = release_update::InstallEvidence::new(true, Some(digest_match), user_approved, true);
    if !evidence.may_install() {
        return Err(format!("업데이트 설치 조건이 충족되지 않았습니다: {}", evidence.blockers().join(" ")));
    }
    if layout.update_request.exists() {
        return Err("기존 업데이트 승인 요청이 있어 새 요청을 만들지 않았습니다.".into());
    }
    let authorization = VerifiedUpdateAuthorization {
        product_id: PRODUCT_ID.into(),
        release_tag: candidate.tag.clone(),
        old_version: marker.version.clone(),
        new_version: format_version(&candidate.version),
        old_sha256: marker.manager_sha256.clone(),
        asset_sha256: candidate.sha256.clone(),
        staged_sha256: staged_sha.clone(),
        fixed_https_source: true,
        api_digest_matches_file: true,
        user_approved: true,
        rollback_ready: true,
        patch_root: None,
    };
    authorization.validate()?;
    let nonce = new_transaction_id();
    let request = json!({
        "schemaVersion": UPDATE_REQUEST_SCHEMA,
        "nonce": nonce,
        "productId": PRODUCT_ID,
        "releaseTag": candidate.tag,
        "oldVersion": marker.version,
        "newVersion": format_version(&candidate.version),
        "oldSha256": marker.manager_sha256,
        "assetName": candidate.asset_name,
        "downloadUrl": candidate.download_url,
        "apiSha256": candidate.sha256,
        "stagedSha256": staged_sha,
        "apiDigestMatchesFile": true,
        "userApproved": true,
        "rollbackReady": true
    });
    let request_bytes = serde_json::to_vec_pretty(&request).map_err(|error| error.to_string())?;
    write_new_synced(&layout.update_request, &request_bytes)?;
    let mut command = Command::new(&updater);
    command
        .arg("--apply-approved-update")
        .arg(&nonce)
        .current_dir(&layout.root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if let Err(error) = command.spawn() {
        remove_matching_request(&layout, &nonce);
        return Err(format!("기존 Rust updater 실행 실패: {error}"));
    }
    Ok(())
}

pub fn read_update_result_for_manager() -> Option<String> {
    let layout = UpdateLayout::from_running_manager().ok()?;
    if !layout.update_result.exists() || ensure_regular_file(&layout.update_result).is_err() {
        return None;
    }
    let value: Value = serde_json::from_slice(&fs::read(layout.update_result).ok()?).ok()?;
    let state = value.get("state").and_then(Value::as_str)?;
    let message = value.get("message").and_then(Value::as_str)?;
    Some(format!("업데이트 결과 {state}: {message}"))
}

fn format_version(version: &BetaVersion) -> String {
    let base = format!("{}.{}.{}", version.major, version.minor, version.patch);
    version.beta.map_or(base.clone(), |beta| format!("{base}-beta.{beta}"))
}

fn validate_current_install(layout: &UpdateLayout) -> Result<(), String> {
    reject_reparse_components(&layout.root)?;
    ensure_regular_file(&layout.manager)?;
    ensure_regular_file(&layout.marker)?;
    let marker = InstallMarker::read(&layout.marker)?;
    if marker.product_id != PRODUCT_ID
        || marker.version != compiled_manager_version()
        || marker.manager_sha256 != sha256_file(&layout.manager)?
    {
        return Err("현재 관리자 설치 기록과 EXE가 일치하지 않아 업데이트를 막았습니다.".into());
    }
    Ok(())
}

#[cfg(feature = "updater-test-harness")]
pub fn run_local_self_tests() -> Result<Value, String> {
    test_harness::run_all()
}

/// Manager startup takes this per-installation session lock for its lifetime.
/// It prevents the updater and a newly launched manager from racing the replace.
pub struct ManagerSessionLock(UpdateLock);

pub fn acquire_manager_session() -> Result<ManagerSessionLock, String> {
    let exe = std::env::current_exe().map_err(io_error("관리자 실행 경로 확인 실패"))?;
    let root = exe
        .parent()
        .ok_or("관리자 설치 폴더를 확인할 수 없습니다.")?;
    reject_reparse_components(&exe)?;
    let canonical_root = fs::canonicalize(root).map_err(io_error("관리자 설치 폴더 확인 실패"))?;
    if exe.file_name().and_then(|name| name.to_str()) != Some(MANAGER_FILE) {
        return Err("관리자 실행 파일 이름이 설치 계약과 다릅니다.".into());
    }
    let updater_probe = UpdateLock::try_acquire_named(&canonical_root, MutexKind::Updater)?;
    if updater_probe.is_none() {
        return Err("관리자 업데이트 중입니다. 완료 후 다시 실행하세요.".into());
    }
    drop(updater_probe);
    let manager = UpdateLock::try_acquire_named(&canonical_root, MutexKind::Manager)?
        .ok_or_else(|| "DinoPatch 관리자가 이미 실행 중입니다.".to_owned())?;
    let updater_probe = UpdateLock::try_acquire_named(&canonical_root, MutexKind::Updater)?;
    if updater_probe.is_none() {
        drop(manager);
        return Err("관리자 업데이트가 시작되어 실행을 중단했습니다.".into());
    }
    drop(updater_probe);
    Ok(ManagerSessionLock(manager))
}

#[cfg(feature = "updater-test-harness")]
fn test_layout(root: &Path) -> Result<UpdateLayout, String> {
    validate_test_root(root)?;
    UpdateLayout::from_root(root)
}

fn validate_test_root(root: &Path) -> Result<(), String> {
    let temp = std::env::temp_dir();
    let canonical_temp = fs::canonicalize(&temp).map_err(io_error("격리 TEMP 경로 확인 실패"))?;
    let canonical_root = fs::canonicalize(root).map_err(io_error("테스트 루트 경로 확인 실패"))?;
    if !is_same_or_child(&canonical_temp, &canonical_root) || canonical_root == canonical_temp {
        return Err("테스트 업데이트는 TEMP 내부의 전용 하위 폴더에서만 허용됩니다.".into());
    }
    reject_reparse_components(&canonical_root)?;
    let marker = canonical_root.join(".dino-updater-self-test-root");
    ensure_regular_file(&marker)?;
    let contents = fs::read_to_string(marker).map_err(io_error("테스트 루트 표식 읽기 실패"))?;
    if contents.trim() != "DinoPatch isolated updater test root v1" {
        return Err("테스트 루트 표식이 일치하지 않습니다.".into());
    }
    Ok(())
}

fn apply_authorized(
    layout: &UpdateLayout,
    authorization: &VerifiedUpdateAuthorization,
    faults: Faults,
) -> Result<UpdateOutcome, String> {
    let _update_lock = UpdateLock::acquire(&layout.root, Duration::from_millis(0))?;
    apply_authorized_under_lock(layout, authorization, faults)
}

fn apply_authorized_under_lock(
    layout: &UpdateLayout,
    authorization: &VerifiedUpdateAuthorization,
    faults: Faults,
) -> Result<UpdateOutcome, String> {
    #[cfg(feature = "updater-test-harness")]
    validate_test_root(layout.root.parent().ok_or("테스트 설치 경로가 없습니다.")?)?;
    layout.ensure_update_dirs()?;
    ensure_regular_file(&layout.manager)?;
    ensure_regular_file(&layout.staged_manager)?;
    ensure_regular_file(&layout.marker)?;
    let marker = InstallMarker::read(&layout.marker)?;
    if marker.product_id != authorization.product_id
        || marker.product_id != compiled_product_id()
        || marker.version != authorization.old_version
    {
        return Err("현재 설치 기록의 제품·버전이 승인된 업데이트 요청과 다릅니다.".into());
    }
    authorization.validate()?;
    let actual_old_sha = sha256_file(&layout.manager)?;
    if actual_old_sha != authorization.old_sha256 || marker.manager_sha256 != actual_old_sha {
        return Err("현재 관리자 SHA-256이 설치 기록과 다릅니다.".into());
    }
    let actual_staged_sha = sha256_file(&layout.staged_manager)?;
    if actual_staged_sha != authorization.staged_sha256 {
        return Err("교체 직전 준비된 EXE의 SHA-256이 바뀌었습니다.".into());
    }
    validate_manager_pe(&layout.manager)?;
    validate_manager_pe(&layout.staged_manager)?;
    if faults.manager_shutdown {
        return Err("관리자 종료 확인 실패: 원본 파일을 변경하지 않았습니다.".into());
    }
    let _manager_gate = wait_for_manager_exit(&layout.root, MANAGER_WAIT)?;
    ensure_manager_process_not_running(&layout.root)?;
    check_available_space(
        &layout.root,
        file_len(&layout.manager)? + file_len(&layout.staged_manager)?,
    )?;
    let previous = read_journal(&layout.journal)?;
    if let Some(last) = previous.last() {
        if !is_terminal(&last.record.state) {
            return Err(
                "미완료 업데이트 저널이 있습니다. 복구 확인 전 새 교체를 시작하지 않습니다.".into(),
            );
        }
    }
    let transaction_id = new_transaction_id();
    let backup_name = format!("manager-{transaction_id}.exe");
    let marker_backup_name = format!("install-marker-{transaction_id}.json");
    let old_marker_sha = sha256_file(&layout.marker)?;
    let record = JournalRecord {
        seq: 0,
        transaction_id,
        state: "PREPARED".into(),
        product_id: marker.product_id.clone(),
        old_version: marker.version.clone(),
        new_version: authorization.new_version.clone(),
        old_sha256: actual_old_sha,
        new_sha256: actual_staged_sha,
        old_marker_sha256: old_marker_sha,
        backup_name,
        marker_backup_name,
    };
    run_manager_probe(
        layout,
        "INFO",
        &record,
        &record.old_version,
        authorization.patch_root.as_deref(),
        None,
    )?;
    append_transition(&layout.journal, &record)?;
    if faults.backup {
        return rollback_result(
            layout,
            &record,
            "백업 생성 실패를 재현했습니다.".into(),
            faults.rollback,
        );
    }
    let backup = layout.backups_dir.join(&record.backup_name);
    let marker_backup = layout.backups_dir.join(&record.marker_backup_name);
    if let Err(error) = copy_new_verified(&layout.manager, &backup, &record.old_sha256)
        .and_then(|_| copy_new_verified(&layout.marker, &marker_backup, &record.old_marker_sha256))
    {
        return rollback_result(
            layout,
            &record,
            format!("백업 생성 실패: {error}"),
            faults.rollback,
        );
    }
    let mut record = transition(layout, &record, "BACKED_UP")?;
    if faults.replacement {
        return rollback_result(
            layout,
            &record,
            "EXE 교체 실패를 재현했습니다.".into(),
            faults.rollback,
        );
    }
    if let Err(error) = replace_from_staged(layout, &record) {
        return rollback_result(
            layout,
            &record,
            format!("새 관리자 EXE 교체 실패: {error}"),
            faults.rollback,
        );
    }
    if faults.interrupt_after_replace {
        return Ok(UpdateOutcome::from_record(
            layout,
            &record,
            "교체 직후 중단 상태를 재현했습니다. 다음 updater 실행에서 원본 복구를 수행해야 합니다.".into(),
        ));
    }
    record = transition(layout, &record, "REPLACED")?;
    let start_check = run_manager_probe(
        layout,
        "START",
        &record,
        &record.new_version,
        authorization.patch_root.as_deref(),
        Some(faults.start_check),
    );
    if let Err(error) = start_check {
        return rollback_result(
            layout,
            &record,
            format!("새 관리자 시작 확인 실패: {error}"),
            faults.rollback,
        );
    }
    record = transition(layout, &record, "START_VERIFIED")?;
    let updated_marker = InstallMarker {
        product_id: record.product_id.clone(),
        version: record.new_version.clone(),
        manager_sha256: record.new_sha256.clone(),
    };
    if let Err(error) = write_marker_atomically(layout, &record, &updated_marker) {
        return rollback_result(
            layout,
            &record,
            format!("새 관리자 설치 기록 저장 실패: {error}"),
            faults.rollback,
        );
    }
    record = transition(layout, &record, "COMMITTED")?;
    Ok(UpdateOutcome::from_record(
        layout,
        &record,
        "새 관리자 시작 확인까지 완료했습니다.".into(),
    ))
}

fn rollback_result(
    layout: &UpdateLayout,
    record: &JournalRecord,
    reason: String,
    fail_rollback: bool,
) -> Result<UpdateOutcome, String> {
    let latest = latest_record(&layout.journal)?.unwrap_or_else(|| record.clone());
    let rollback_required =
        if latest.state == "ROLLBACK_REQUIRED" || latest.state == "RECOVERY_FAILED" {
            latest
        } else {
            transition(layout, &latest, "ROLLBACK_REQUIRED")?
        };
    if fail_rollback {
        let failed = transition(layout, &rollback_required, "RECOVERY_FAILED")?;
        return Ok(UpdateOutcome::from_record(
            layout,
            &failed,
            format!("{reason} 이전 EXE 복구도 실패했습니다. 백업과 저널을 보존했습니다."),
        ));
    }
    match restore_transaction(layout, &rollback_required) {
        Ok(()) => {
            let rolled = transition(layout, &rollback_required, "ROLLED_BACK")?;
            Ok(UpdateOutcome::from_record(
                layout,
                &rolled,
                format!("{reason} 이전 EXE와 설치 기록을 복구했습니다."),
            ))
        }
        Err(error) => {
            let failed = transition(layout, &rollback_required, "RECOVERY_FAILED")?;
            Ok(UpdateOutcome::from_record(
                layout,
                &failed,
                format!("{reason} 복구 실패: {error}. 백업과 저널을 보존했습니다."),
            ))
        }
    }
}

fn replace_from_staged(layout: &UpdateLayout, record: &JournalRecord) -> Result<(), String> {
    reject_reparse_components(&layout.staged_manager)?;
    reject_reparse_components(&layout.root)?;
    ensure_regular_file(&layout.staged_manager)?;
    if sha256_file(&layout.staged_manager)? != record.new_sha256 {
        return Err("준비 파일 digest가 바뀌었습니다.".into());
    }
    let temp = layout.root.join(format!(
        ".dino-manager-replace-{}.tmp",
        record.transaction_id
    ));
    copy_new_verified(&layout.staged_manager, &temp, &record.new_sha256)?;
    ensure_regular_file(&layout.manager)?;
    if sha256_file(&layout.manager)? != record.old_sha256 {
        return Err("교체 대상이 사전 검사 후 변경됐습니다.".into());
    }
    atomic_replace(&temp, &layout.manager)
}

fn restore_transaction(layout: &UpdateLayout, record: &JournalRecord) -> Result<(), String> {
    reject_reparse_components(&layout.root)?;
    let backup = layout.backups_dir.join(&record.backup_name);
    let marker_backup = layout.backups_dir.join(&record.marker_backup_name);
    if !backup.exists() || !marker_backup.exists() {
        let target_is_original = layout.manager.exists()
            && sha256_file(&layout.manager).ok().as_deref() == Some(&record.old_sha256);
        let marker_is_original = layout.marker.exists()
            && sha256_file(&layout.marker).ok().as_deref() == Some(&record.old_marker_sha256);
        if target_is_original && marker_is_original {
            return Ok(());
        }
        return Err("검증된 원본 EXE 또는 설치 기록 백업이 없습니다.".into());
    }
    ensure_regular_file(&backup)?;
    ensure_regular_file(&marker_backup)?;
    if sha256_file(&backup)? != record.old_sha256
        || sha256_file(&marker_backup)? != record.old_marker_sha256
    {
        return Err("원본 EXE 또는 설치 기록 백업의 SHA-256이 일치하지 않습니다.".into());
    }
    let current = if layout.manager.exists() {
        Some(sha256_file(&layout.manager)?)
    } else {
        None
    };
    match current.as_deref() {
        Some(hash) if hash == record.old_sha256 => {}
        Some(hash) if hash == record.new_sha256 => {
            let temp = layout.root.join(format!(
                ".dino-manager-rollback-{}.tmp",
                record.transaction_id
            ));
            copy_new_verified(&backup, &temp, &record.old_sha256)?;
            atomic_replace(&temp, &layout.manager)?;
        }
        None => {
            let temp = layout.root.join(format!(
                ".dino-manager-rollback-{}.tmp",
                record.transaction_id
            ));
            copy_new_verified(&backup, &temp, &record.old_sha256)?;
            atomic_replace(&temp, &layout.manager)?;
        }
        _ => {
            return Err(
                "현재 관리자 EXE가 기록된 원본·새 버전 어느 쪽과도 일치하지 않습니다.".into(),
            )
        }
    }
    let marker_hash = sha256_file(&layout.marker).ok();
    if marker_hash.as_deref() != Some(&record.old_marker_sha256) {
        let marker_temp = layout.root.join(format!(
            ".dino-marker-rollback-{}.tmp",
            record.transaction_id
        ));
        copy_new_verified(&marker_backup, &marker_temp, &record.old_marker_sha256)?;
        atomic_replace(&marker_temp, &layout.marker)?;
    }
    if sha256_file(&layout.manager)? != record.old_sha256
        || sha256_file(&layout.marker)? != record.old_marker_sha256
    {
        return Err("복구 후 원본 EXE 또는 설치 기록 SHA-256 검증이 실패했습니다.".into());
    }
    Ok(())
}

fn write_marker_atomically(
    layout: &UpdateLayout,
    record: &JournalRecord,
    marker: &InstallMarker,
) -> Result<(), String> {
    let temp = layout
        .root
        .join(format!(".dino-marker-update-{}.tmp", record.transaction_id));
    let bytes = serde_json::to_vec_pretty(&marker.json()).map_err(|error| error.to_string())?;
    write_new_synced(&temp, &bytes)?;
    atomic_replace(&temp, &layout.marker)?;
    if sha256_file(&layout.marker)? != sha256_bytes(&bytes) {
        return Err("새 설치 기록의 SHA-256을 확인할 수 없습니다.".into());
    }
    Ok(())
}

fn copy_new_verified(
    source: &Path,
    destination: &Path,
    expected_sha256: &str,
) -> Result<(), String> {
    ensure_regular_file(source)?;
    reject_reparse_components(destination.parent().ok_or("대상 폴더가 없습니다.")?)?;
    if destination.exists() {
        return Err("동일한 백업 또는 임시 파일이 이미 있습니다. 덮어쓰지 않습니다.".into());
    }
    let mut input = File::open(source).map_err(io_error("복사 원본 열기 실패"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(io_error("복사 대상 생성 실패"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(io_error("복사 원본 읽기 실패"))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(io_error("복사 대상 쓰기 실패"))?;
        digest.update(&buffer[..count]);
    }
    output
        .sync_all()
        .map_err(io_error("복사 대상 디스크 동기화 실패"))?;
    drop(output);
    if format!("{:x}", digest.finalize()) != expected_sha256 {
        return Err("복사한 파일의 SHA-256이 예상값과 일치하지 않습니다.".into());
    }
    Ok(())
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error("임시 파일 생성 실패"))?;
    file.write_all(bytes)
        .map_err(io_error("임시 파일 쓰기 실패"))?;
    file.sync_all().map_err(io_error("임시 파일 동기화 실패"))
}

fn append_transition(journal: &Path, record: &JournalRecord) -> Result<JournalRecord, String> {
    let entries = read_journal(journal)?;
    let previous = entries
        .last()
        .map(|entry| entry.hash.as_str())
        .unwrap_or("");
    let same_transaction = entries
        .last()
        .is_some_and(|entry| entry.record.transaction_id == record.transaction_id);
    let mut next = record.clone();
    next.seq = if same_transaction {
        entries.last().unwrap().record.seq + 1
    } else {
        0
    };
    if same_transaction && !valid_transition(&entries.last().unwrap().record.state, &next.state) {
        return Err(format!(
            "잘못된 업데이트 저널 상태 전환: {} -> {}",
            entries.last().unwrap().record.state,
            next.state
        ));
    }
    if !same_transaction && next.state != "PREPARED" {
        return Err("새 복구 저널은 PREPARED 상태에서만 시작할 수 있습니다.".into());
    }
    let value = next.to_value(previous)?;
    if let Some(parent) = journal.parent() {
        reject_reparse_components(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal)
        .map_err(io_error("복구 저널 열기 실패"))?;
    serde_json::to_writer(&mut file, &value).map_err(|error| error.to_string())?;
    file.write_all(b"\n")
        .map_err(io_error("복구 저널 쓰기 실패"))?;
    file.sync_all().map_err(io_error("복구 저널 동기화 실패"))?;
    Ok(next)
}

#[derive(Clone, Debug)]
struct JournalEntry {
    record: JournalRecord,
    hash: String,
}

fn read_journal(path: &Path) -> Result<Vec<JournalEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    ensure_regular_file(path)?;
    let bytes = fs::read(path).map_err(io_error("업데이트 복구 저널 읽기 실패"))?;
    if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
        return Err(
            "업데이트 복구 저널의 마지막 레코드가 잘렸습니다. 자동 설치·복구를 중지하고 저널과 백업을 보존했습니다."
                .into(),
        );
    }
    let complete_len = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut entries: Vec<JournalEntry> = Vec::new();
    let mut previous_hash = String::new();
    for line in bytes[..complete_len]
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let mut value: Value = serde_json::from_slice(line)
            .map_err(|_| "완료된 업데이트 저널 줄이 손상됐습니다.".to_owned())?;
        let stored_hash = text_field(&value, "recordHash")?.to_ascii_lowercase();
        validate_sha256(&stored_hash)?;
        let recorded_previous = value
            .get("previousRecordHash")
            .and_then(Value::as_str)
            .ok_or("업데이트 저널 previousRecordHash가 없습니다.")?;
        if recorded_previous != previous_hash {
            return Err("업데이트 저널 hash-chain이 일치하지 않습니다.".into());
        }
        value
            .as_object_mut()
            .ok_or("업데이트 저널 항목이 객체가 아닙니다.")?
            .remove("recordHash");
        let actual_hash =
            sha256_bytes(&serde_json::to_vec(&value).map_err(|error| error.to_string())?);
        if actual_hash != stored_hash {
            return Err("업데이트 저널 레코드 hash가 일치하지 않습니다.".into());
        }
        let record = JournalRecord::parse(&value)?;
        if let Some(last) = entries.last() {
            if last.record.transaction_id == record.transaction_id {
                if record.seq != last.record.seq + 1
                    || !valid_transition(&last.record.state, &record.state)
                {
                    return Err("업데이트 저널 순번 또는 상태 전환이 올바르지 않습니다.".into());
                }
                if !same_transaction_data(&last.record, &record) {
                    return Err("업데이트 저널의 트랜잭션 데이터가 중간에 변경됐습니다.".into());
                }
            } else if !is_terminal(&last.record.state)
                || record.seq != 0
                || record.state != "PREPARED"
            {
                return Err("이전 업데이트 복구가 끝나기 전에 새 저널이 시작됐습니다.".into());
            }
        } else if record.seq != 0 || record.state != "PREPARED" {
            return Err("업데이트 저널의 첫 레코드가 PREPARED가 아닙니다.".into());
        }
        previous_hash = stored_hash.clone();
        entries.push(JournalEntry {
            record,
            hash: stored_hash,
        });
    }
    Ok(entries)
}

fn transition(
    layout: &UpdateLayout,
    record: &JournalRecord,
    state: &str,
) -> Result<JournalRecord, String> {
    let mut next = record.clone();
    next.state = state.to_owned();
    append_transition(&layout.journal, &next)
}

fn valid_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        (
            "PREPARED",
            "BACKED_UP" | "ROLLBACK_REQUIRED" | "ROLLED_BACK"
        ) | (
            "BACKED_UP",
            "REPLACED" | "ROLLBACK_REQUIRED" | "ROLLED_BACK"
        ) | ("REPLACED", "START_VERIFIED" | "ROLLBACK_REQUIRED")
            | ("START_VERIFIED", "COMMITTED" | "ROLLBACK_REQUIRED")
            | ("ROLLBACK_REQUIRED", "ROLLED_BACK" | "RECOVERY_FAILED")
            | ("RECOVERY_FAILED", "ROLLED_BACK" | "RECOVERY_FAILED")
    )
}

fn is_terminal(state: &str) -> bool {
    matches!(state, "COMMITTED" | "ROLLED_BACK")
}

fn same_transaction_data(left: &JournalRecord, right: &JournalRecord) -> bool {
    left.product_id == right.product_id
        && left.old_version == right.old_version
        && left.new_version == right.new_version
        && left.old_sha256 == right.old_sha256
        && left.new_sha256 == right.new_sha256
        && left.old_marker_sha256 == right.old_marker_sha256
        && left.backup_name == right.backup_name
        && left.marker_backup_name == right.marker_backup_name
}

fn latest_record(path: &Path) -> Result<Option<JournalRecord>, String> {
    Ok(read_journal(path)?.last().map(|entry| entry.record.clone()))
}

fn recover_pending_locked(
    layout: &UpdateLayout,
    product_id: &str,
    fail_recovery: bool,
) -> Result<Option<UpdateOutcome>, String> {
    let Some(mut record) = latest_record(&layout.journal)? else {
        return Ok(None);
    };
    if is_terminal(&record.state) {
        return Ok(None);
    }
    if record.product_id != product_id
        || record.backup_name != format!("manager-{}.exe", record.transaction_id)
        || record.marker_backup_name != format!("install-marker-{}.json", record.transaction_id)
        || record.transaction_id.len() != 32
        || !record
            .transaction_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("복구 저널의 제품·백업 이름·트랜잭션 ID가 고정 규칙과 다릅니다.".into());
    }
    if record.state != "ROLLBACK_REQUIRED" && record.state != "RECOVERY_FAILED" {
        record = transition(layout, &record, "ROLLBACK_REQUIRED")?;
    }
    if fail_recovery {
        let failed = transition(layout, &record, "RECOVERY_FAILED")?;
        return Ok(Some(UpdateOutcome::from_record(
            layout,
            &failed,
            "복구 실패를 재현했습니다. 기존 EXE 백업과 복구 저널을 보존했습니다.".into(),
        )));
    }
    match restore_transaction(layout, &record) {
        Ok(()) => {
            let rolled = transition(layout, &record, "ROLLED_BACK")?;
            Ok(Some(UpdateOutcome::from_record(
                layout,
                &rolled,
                "중단된 업데이트를 이전 EXE로 복구했습니다.".into(),
            )))
        }
        Err(error) => {
            let failed = transition(layout, &record, "RECOVERY_FAILED")?;
            Ok(Some(UpdateOutcome::from_record(
                layout,
                &failed,
                format!("복구 실패: {error}. 백업과 저널을 보존했습니다."),
            )))
        }
    }
}

#[cfg(feature = "updater-test-harness")]
fn recover_pending_test(
    layout: &UpdateLayout,
    fail_recovery: bool,
) -> Result<Option<UpdateOutcome>, String> {
    validate_test_root(layout.root.parent().ok_or("테스트 설치 경로가 없습니다.")?)?;
    let _update_lock = UpdateLock::acquire(&layout.root, Duration::from_millis(0))?;
    recover_pending_locked(layout, compiled_product_id(), fail_recovery)
}

fn new_transaction_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:032x}", nanos ^ ((std::process::id() as u128) << 64))
}

fn text_field(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("필수 업데이트 필드 {field}가 없습니다."))
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("SHA-256은 64자리 16진수여야 합니다.".into());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    ensure_regular_file(path)?;
    release_update::sha256_file(path)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_len(path: &Path) -> Result<u64, String> {
    ensure_regular_file(path)?;
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(io_error("파일 크기 확인 실패"))
}

fn validate_manager_pe(path: &Path) -> Result<(), String> {
    #[cfg(feature = "updater-test-harness")]
    let allowed_subsystems: &[u16] = &[2, 3];
    #[cfg(not(feature = "updater-test-harness"))]
    let allowed_subsystems: &[u16] = &[2];
    validate_pe(path, allowed_subsystems, "관리자")
}

fn validate_updater_pe(path: &Path) -> Result<(), String> {
    validate_pe(path, &[3], "업데이터")
}

fn validate_pe(path: &Path, allowed_subsystems: &[u16], label: &str) -> Result<(), String> {
    ensure_regular_file(path)?;
    let mut file = File::open(path).map_err(io_error("Windows EXE 검사 실패"))?;
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos)
        .map_err(|_| format!("{label} EXE의 DOS 헤더가 잘렸습니다."))?;
    if &dos[..2] != b"MZ" {
        return Err(format!("{label} 파일이 Windows PE 실행 파일이 아닙니다."));
    }
    let pe_offset = u32::from_le_bytes(dos[0x3c..0x40].try_into().unwrap()) as u64;
    if pe_offset > 16 * 1024 * 1024 {
        return Err(format!("{label} PE 헤더 위치가 비정상적입니다."));
    }
    file.seek(SeekFrom::Start(pe_offset))
        .map_err(io_error("PE 헤더 이동 실패"))?;
    let mut header = [0u8; 24];
    file.read_exact(&mut header)
        .map_err(|_| format!("{label} PE 헤더가 잘렸습니다."))?;
    if &header[..4] != b"PE\0\0" || u16::from_le_bytes([header[4], header[5]]) != 0x8664 {
        return Err(format!("{label} 파일이 Windows x64 실행 파일이 아닙니다."));
    }
    let optional_size = u16::from_le_bytes([header[20], header[21]]) as usize;
    if optional_size < 70 {
        return Err(format!("{label} PE 선택 헤더가 너무 짧습니다."));
    }
    let mut optional = vec![0u8; optional_size];
    file.read_exact(&mut optional)
        .map_err(|_| format!("{label} PE 선택 헤더가 잘렸습니다."))?;
    let magic = u16::from_le_bytes([optional[0], optional[1]]);
    let subsystem = u16::from_le_bytes([optional[68], optional[69]]);
    if !matches!(magic, 0x10b | 0x20b) || !allowed_subsystems.contains(&subsystem) {
        let expected = if allowed_subsystems == [3] { "console" } else { "GUI" };
        return Err(format!("DinoPatch {label}는 Windows x64 {expected} subsystem 실행 파일이어야 합니다."));
    }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> Result<(), String> {
    reject_reparse_components(path)?;
    let metadata = fs::symlink_metadata(path).map_err(io_error("파일 확인 실패"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "일반 파일이 아닌 경로는 허용하지 않습니다: {}",
            path.display()
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum MutexKind {
    Updater,
    Manager,
}

#[cfg(windows)]
struct NamedMutex {
    handle: windows_sys::Win32::Foundation::HANDLE,
    owned: bool,
}

#[cfg(windows)]
impl Drop for NamedMutex {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        unsafe {
            if self.owned {
                let _ = ReleaseMutex(self.handle);
            }
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
struct UpdateLock(NamedMutex);

#[cfg(windows)]
impl UpdateLock {
    fn acquire(root: &Path, timeout: Duration) -> Result<Self, String> {
        Self::acquire_kind(root, MutexKind::Updater, timeout)
    }

    fn acquire_kind(root: &Path, kind: MutexKind, timeout: Duration) -> Result<Self, String> {
        Self::try_acquire_named(root, kind)?
            .ok_or_else(|| {
                if matches!(kind, MutexKind::Updater) {
                    "다른 DinoPatch 업데이트 작업이 진행 중입니다.".to_owned()
                } else {
                    "DinoPatch 관리자가 아직 실행 중입니다.".to_owned()
                }
            })
            .or_else(|_| {
                if timeout.is_zero() {
                    return Err(if matches!(kind, MutexKind::Updater) {
                        "다른 DinoPatch 업데이트 작업이 진행 중입니다.".to_owned()
                    } else {
                        "DinoPatch 관리자가 아직 실행 중입니다.".to_owned()
                    });
                }
                let name = mutex_name(root, kind)?;
                let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
                use windows_sys::Win32::Foundation::HANDLE;
                use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
                let handle: HANDLE = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
                if handle.is_null() {
                    return Err("Windows 업데이트 잠금을 만들지 못했습니다.".into());
                }
                let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
                let wait = unsafe { WaitForSingleObject(handle, millis) };
                if wait == 0 || wait == 0x80 {
                    Ok(Self(NamedMutex {
                        handle,
                        owned: true,
                    }))
                } else {
                    use windows_sys::Win32::Foundation::CloseHandle;
                    unsafe {
                        let _ = CloseHandle(handle);
                    }
                    Err(if wait == 0x102 {
                        "관리자 종료 대기 시간이 초과됐습니다. 파일은 변경하지 않았습니다.".into()
                    } else {
                        format!(
                            "Windows 업데이트 잠금 대기 실패: {}",
                            std::io::Error::last_os_error()
                        )
                    })
                }
            })
    }

    fn try_acquire_named(root: &Path, kind: MutexKind) -> Result<Option<Self>, String> {
        let name = mutex_name(root, kind)?;
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
        let handle: HANDLE = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
        if handle.is_null() {
            return Err("Windows 업데이트 잠금을 만들지 못했습니다.".into());
        }
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == 0 || wait == 0x80 {
            Ok(Some(Self(NamedMutex {
                handle,
                owned: true,
            })))
        } else if wait == 0x102 {
            unsafe {
                let _ = CloseHandle(handle);
            }
            Ok(None)
        } else {
            unsafe {
                let _ = CloseHandle(handle);
            }
            Err(format!(
                "Windows 업데이트 잠금 확인 실패: {}",
                std::io::Error::last_os_error()
            ))
        }
    }
}

#[cfg(not(windows))]
struct UpdateLock;

#[cfg(not(windows))]
impl UpdateLock {
    fn acquire(_root: &Path, _timeout: Duration) -> Result<Self, String> {
        Err("업데이트 프로세스 잠금은 Windows에서만 지원됩니다.".into())
    }
    fn try_acquire_named(_root: &Path, _kind: MutexKind) -> Result<Option<Self>, String> {
        Err("업데이트 프로세스 잠금은 Windows에서만 지원됩니다.".into())
    }
}

fn mutex_name(root: &Path, kind: MutexKind) -> Result<String, String> {
    let canonical = fs::canonicalize(root).map_err(io_error("잠금 설치 경로 확인 실패"))?;
    let digest = sha256_bytes(path_key(&canonical).as_bytes());
    let role = match kind {
        MutexKind::Updater => "Update",
        MutexKind::Manager => "Manager",
    };
    Ok(format!("Local\\DinoPatch{role}_{}", &digest[..32]))
}

fn wait_for_manager_exit(root: &Path, timeout: Duration) -> Result<UpdateLock, String> {
    let gate = UpdateLock::acquire_kind(root, MutexKind::Manager, timeout)?;
    let started = Instant::now();
    loop {
        if !manager_process_is_running(root)? {
            return Ok(gate);
        }
        if started.elapsed() >= timeout {
            return Err(
                "DinoPatch 관리자 프로세스가 종료되지 않았습니다. 파일은 변경하지 않았습니다."
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn ensure_manager_process_not_running(root: &Path) -> Result<(), String> {
    if manager_process_is_running(root)? {
        Err("파일 교체 직전 관리자 프로세스가 다시 실행됐습니다. 업데이트를 중단했습니다.".into())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn manager_process_is_running(root: &Path) -> Result<bool, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "관리자 프로세스 목록을 읽지 못했습니다: {}",
            std::io::Error::last_os_error()
        ));
    }
    let expected = fs::canonicalize(root.join(MANAGER_FILE))
        .map_err(io_error("관리자 대상 경로 확인 실패"))?;
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = false;
    let first = unsafe { Process32FirstW(snapshot, &mut entry) };
    if first != 0 {
        loop {
            let end = entry
                .szExeFile
                .iter()
                .position(|word| *word == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
            if name.eq_ignore_ascii_case(MANAGER_FILE) && entry.th32ProcessID != std::process::id()
            {
                let process = unsafe {
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID)
                };
                if process.is_null() {
                    found = true; // Cannot prove it is a different executable: fail closed.
                    break;
                }
                let mut buffer = vec![0u16; 32768];
                let mut size = buffer.len() as u32;
                let ok = unsafe {
                    QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_WIN32,
                        buffer.as_mut_ptr(),
                        &mut size,
                    )
                };
                unsafe {
                    let _ = CloseHandle(process);
                }
                if ok == 0 {
                    found = true;
                    break;
                }
                let process_path =
                    PathBuf::from(std::ffi::OsString::from_wide(&buffer[..size as usize]));
                if fs::canonicalize(process_path).ok().as_deref() == Some(expected.as_path()) {
                    found = true;
                    break;
                }
            }
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    Ok(found)
}

#[cfg(not(windows))]
fn manager_process_is_running(_root: &Path) -> Result<bool, String> {
    Err("관리자 프로세스 확인은 Windows에서만 지원됩니다.".into())
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    reject_reparse_components(source)?;
    reject_reparse_components(destination.parent().ok_or("교체 폴더가 없습니다.")?)?;
    let src: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let dst: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows 원자 교체 실패: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(_source: &Path, _destination: &Path) -> Result<(), String> {
    Err("관리자 EXE 교체는 Windows에서만 지원됩니다.".into())
}

#[derive(Clone, Debug)]
struct ProbeRequest {
    nonce: String,
    action: String,
    product_id: String,
    expected_version: String,
    transaction_id: Option<String>,
    expected_sha256: String,
    patch_root: Option<PathBuf>,
}

fn probe_path(layout: &UpdateLayout, nonce: &str, suffix: &str) -> Result<PathBuf, String> {
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("관리자 시작 확인 nonce 형식이 올바르지 않습니다.".into());
    }
    Ok(layout.health_dir.join(format!("{nonce}.{suffix}.json")))
}

fn run_manager_probe(
    layout: &UpdateLayout,
    action: &str,
    record: &JournalRecord,
    expected_version: &str,
    patch_root: Option<&Path>,
    test_health_failure: Option<bool>,
) -> Result<(), String> {
    #[cfg(not(feature = "updater-test-harness"))]
    let _ = test_health_failure;
    let nonce = new_transaction_id();
    let request = json!({
        "schemaVersion": SCHEMA_VERSION,
        "nonce": nonce,
        "action": action,
        "productId": record.product_id,
        "expectedVersion": expected_version,
        "transactionId": if action == "START" { Some(record.transaction_id.as_str()) } else { None },
        "expectedSha256": if action == "START" { record.new_sha256.as_str() } else { record.old_sha256.as_str() },
        "patchRoot": patch_root.map(|path| path.to_string_lossy().into_owned())
    });
    let request_path = probe_path(layout, &nonce, "request")?;
    write_new_synced(
        &request_path,
        &serde_json::to_vec_pretty(&request).map_err(|error| error.to_string())?,
    )?;
    let mut command = Command::new(&layout.manager);
    command
        .arg("--dino-update-probe")
        .arg(&nonce)
        .current_dir(&layout.root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(feature = "updater-test-harness")]
    command.env("DINO_UPDATER_TEST_VERSION", expected_version);
    #[cfg(feature = "updater-test-harness")]
    if test_health_failure == Some(true) {
        command.env("DINO_UPDATER_TEST_FAIL_HEALTH", "1");
    }
    let mut child = command
        .spawn()
        .map_err(io_error("새 관리자 시작 검사 실행 실패"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(io_error("관리자 시작 검사 대기 실패"))?
        {
            break status;
        }
        if started.elapsed() >= HEALTH_WAIT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("관리자 시작 확인 제한 시간이 초과됐습니다.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if !status.success() {
        return Err(format!(
            "관리자 시작 확인 프로세스가 종료 코드 {}를 반환했습니다.",
            status.code().unwrap_or(-1)
        ));
    }
    let response_path = probe_path(layout, &nonce, "response")?;
    ensure_regular_file(&response_path)?;
    let response: Value = serde_json::from_slice(
        &fs::read(response_path).map_err(io_error("시작 확인 응답 읽기 실패"))?,
    )
    .map_err(|_| "관리자 시작 확인 응답이 손상됐습니다.".to_owned())?;
    if response.get("nonce").and_then(Value::as_str) != Some(nonce.as_str())
        || response.get("productId").and_then(Value::as_str) != Some(record.product_id.as_str())
        || response.get("managerVersion").and_then(Value::as_str) != Some(expected_version)
        || response.get("managerSha256").and_then(Value::as_str)
            != Some(record_expected_probe_sha(record, action))
    {
        return Err("관리자 시작 확인 응답의 nonce·제품·버전·SHA-256이 일치하지 않습니다.".into());
    }
    if patch_root.is_some()
        && response
            .get("patchRecordsStatus")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err("기존 패치 기록 접근 상태를 응답에서 확인하지 못했습니다.".into());
    }
    Ok(())
}

fn record_expected_probe_sha<'a>(record: &'a JournalRecord, action: &str) -> &'a str {
    if action == "START" {
        &record.new_sha256
    } else {
        &record.old_sha256
    }
}

/// Called by manager and the test-only manager image; it never opens the GUI
/// and writes only a nonce-named response inside the adjacent update directory.
pub fn manager_probe_entry<F>(
    product_id: &str,
    manager_version: &str,
    nonce: &str,
    patch_probe: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<String, String>,
{
    let exe = std::env::current_exe().map_err(io_error("관리자 실행 파일 확인 실패"))?;
    if exe.file_name().and_then(|name| name.to_str()) != Some(MANAGER_FILE) {
        return Err("시작 확인 프로세스 파일명이 올바르지 않습니다.".into());
    }
    let root = exe
        .parent()
        .ok_or("관리자 설치 폴더를 확인할 수 없습니다.")?;
    let layout = UpdateLayout::from_root(root)?;
    ensure_regular_file(&layout.manager)?;
    let request_path = probe_path(&layout, nonce, "request")?;
    ensure_regular_file(&request_path)?;
    let value: Value = serde_json::from_slice(
        &fs::read(request_path).map_err(io_error("시작 확인 요청 읽기 실패"))?,
    )
    .map_err(|_| "시작 확인 요청 JSON이 손상됐습니다.".to_owned())?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION)
        || value.get("nonce").and_then(Value::as_str) != Some(nonce)
        || value.get("productId").and_then(Value::as_str) != Some(product_id)
        || value.get("expectedVersion").and_then(Value::as_str) != Some(manager_version)
    {
        return Err("시작 확인 요청의 제품·버전·nonce가 일치하지 않습니다.".into());
    }
    let action = text_field(&value, "action")?;
    let expected_sha = text_field(&value, "expectedSha256")?.to_ascii_lowercase();
    let actual_sha = sha256_file(&layout.manager)?;
    if actual_sha != expected_sha {
        return Err("실행된 관리자 EXE SHA-256이 시작 확인 요청과 다릅니다.".into());
    }
    match action.as_str() {
        "INFO" => {
            let marker = InstallMarker::read(&layout.marker)?;
            if marker.product_id != product_id
                || marker.version != manager_version
                || marker.manager_sha256 != actual_sha
            {
                return Err("기존 관리자 제품·버전·설치 기록이 일치하지 않습니다.".into());
            }
        }
        "START" => {
            let transaction_id = text_field(&value, "transactionId")?;
            let latest = latest_record(&layout.journal)?.ok_or("시작 확인 저널이 없습니다.")?;
            if latest.state != "REPLACED"
                || latest.transaction_id != transaction_id
                || latest.product_id != product_id
                || latest.new_version != manager_version
                || latest.new_sha256 != actual_sha
            {
                return Err("교체 저널과 새 관리자 시작 상태가 일치하지 않습니다.".into());
            }
        }
        _ => return Err("지원하지 않는 관리자 시작 확인 작업입니다.".into()),
    }
    let patch_status = if let Some(path) = value.get("patchRoot").and_then(Value::as_str) {
        let path = PathBuf::from(path);
        Some(patch_probe(&path)?)
    } else {
        None
    };
    let response = json!({
        "schemaVersion": SCHEMA_VERSION,
        "nonce": nonce,
        "productId": product_id,
        "managerVersion": manager_version,
        "managerSha256": actual_sha,
        "patchRecordsStatus": patch_status
    });
    let response_path = probe_path(&layout, nonce, "response")?;
    write_new_synced(
        &response_path,
        &serde_json::to_vec_pretty(&response).map_err(|error| error.to_string())?,
    )
}

#[cfg(feature = "updater-test-harness")]
fn test_probe_dispatch(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) != Some("--dino-update-probe") || args.len() != 2 {
        return Err("테스트 관리자 프로브 명령이 올바르지 않습니다.".into());
    }
    if std::env::var_os("DINO_UPDATER_TEST_FAIL_HEALTH").is_some() {
        return Err("테스트용 관리자 시작 실패를 재현했습니다.".into());
    }
    manager_probe_entry(
        TEST_PRODUCT_ID,
        &compiled_manager_version(),
        &args[1],
        |_| Ok("TEST_FIXTURE_READ_ONLY".into()),
    )
}

#[cfg(not(feature = "updater-test-harness"))]
fn test_probe_dispatch(_args: &[String]) -> Result<(), String> {
    Err("테스트 프로브는 테스트 하네스에서만 허용됩니다.".into())
}

/// Read-only manager probe entry used by the shipping manager before GUI startup.
#[cfg(feature = "gui")]
pub fn dispatch_manager_probe<F>(
    args: &[String],
    patch_probe: F,
) -> Option<Result<(), String>>
where
    F: FnOnce(&Path) -> Result<String, String>,
{
    if args.first().map(String::as_str) != Some("--dino-update-probe") {
        return None;
    }
    if args.len() != 2 {
        return Some(Err("관리자 업데이트 프로브 nonce 인자가 필요합니다.".into()));
    }
    let product_id = compiled_product_id();
    let version = compiled_manager_version();
    Some(manager_probe_entry(
        product_id,
        &version,
        &args[1],
        patch_probe,
    ))
}

#[cfg(feature = "updater-test-harness")]
pub fn dispatch_test_harness(args: &[String]) -> Option<Result<(), String>> {
    if args.first().map(String::as_str) == Some("--dino-update-probe") {
        Some(test_probe_dispatch(args))
    } else {
        None
    }
}

#[cfg(feature = "updater-test-harness")]
mod test_harness {
    use super::*;
    use std::collections::BTreeMap;

    fn prepare_root() -> Result<PathBuf, String> {
        let root = std::env::var_os("DINO_UPDATER_TEST_ROOT")
            .map(PathBuf::from)
            .ok_or("DINO_UPDATER_TEST_ROOT를 격리 TEMP 하위로 지정해야 합니다.")?;
        fs::create_dir_all(&root).map_err(io_error("격리 테스트 루트 생성 실패"))?;
        let temp =
            fs::canonicalize(std::env::temp_dir()).map_err(io_error("TEMP 경로 확인 실패"))?;
        let canonical = fs::canonicalize(&root).map_err(io_error("테스트 루트 확인 실패"))?;
        if !is_same_or_child(&temp, &canonical) || temp == canonical {
            return Err("테스트 루트가 현재 프로세스 TEMP의 하위 폴더가 아닙니다.".into());
        }
        if fs::read_dir(&canonical)
            .map_err(io_error("테스트 루트 목록 조회 실패"))?
            .next()
            .is_some()
        {
            return Err("테스트 루트가 비어 있지 않습니다. 기존 자료를 사용하지 않습니다.".into());
        }
        let marker = canonical.join(".dino-updater-self-test-root");
        write_new_synced(&marker, b"DinoPatch isolated updater test root v1\n")?;
        validate_test_root(&canonical)?;
        Ok(canonical)
    }

    fn setup_case(
        root: &Path,
        case: &str,
        old_manager: &Path,
        new_manager: &Path,
    ) -> Result<(UpdateLayout, VerifiedUpdateAuthorization, String, String), String> {
        let case_root = root.join(case);
        fs::create_dir_all(&case_root).map_err(io_error("테스트 케이스 폴더 생성 실패"))?;
        write_new_synced(
            &case_root.join(".dino-updater-self-test-root"),
            b"DinoPatch isolated updater test root v1\n",
        )?;
        let install = case_root.join("install");
        fs::create_dir(&install).map_err(io_error("테스트 설치 폴더 생성 실패"))?;
        let layout = UpdateLayout::from_root(&install)?;
        layout.ensure_update_dirs()?;
        copy_new_verified(old_manager, &layout.manager, &sha256_file(old_manager)?)?;
        copy_new_verified(
            new_manager,
            &layout.staged_manager,
            &sha256_file(new_manager)?,
        )?;
        let old_sha = sha256_file(&layout.manager)?;
        let new_sha = sha256_file(&layout.staged_manager)?;
        let marker = InstallMarker {
            product_id: compiled_product_id().into(),
            version: "0.1.0-beta.7".into(),
            manager_sha256: old_sha.clone(),
        };
        write_new_synced(
            &layout.marker,
            &serde_json::to_vec_pretty(&marker.json()).map_err(|error| error.to_string())?,
        )?;
        let authorization = VerifiedUpdateAuthorization::local_test(
            &marker.version,
            TEST_CANDIDATE_VERSION,
            &old_sha,
            &new_sha,
            compiled_product_id(),
        );
        Ok((layout, authorization, old_sha, new_sha))
    }

    fn require(condition: bool, label: &str) -> Result<(), String> {
        if condition {
            Ok(())
        } else {
            Err(format!("테스트 실패: {label}"))
        }
    }

    fn request_for(
        authorization: &VerifiedUpdateAuthorization,
        nonce: &str,
    ) -> Value {
        json!({
            "schemaVersion": UPDATE_REQUEST_SCHEMA,
            "nonce": nonce,
            "productId": authorization.product_id,
            "releaseTag": authorization.release_tag,
            "oldVersion": authorization.old_version,
            "newVersion": authorization.new_version,
            "oldSha256": authorization.old_sha256,
            "assetName": release_update::WINDOWS_X64_ASSET,
            "downloadUrl": format!(
                "{}/releases/download/{}/{}",
                release_update::RELEASES_BASE,
                authorization.release_tag,
                release_update::WINDOWS_X64_ASSET
            ),
            "apiSha256": authorization.asset_sha256,
            "stagedSha256": authorization.staged_sha256,
            "apiDigestMatchesFile": true,
            "userApproved": true,
            "rollbackReady": true
        })
    }

    pub(super) fn run_all() -> Result<Value, String> {
        let root = prepare_root()?;
        let self_exe = std::env::current_exe().map_err(io_error("테스트 하네스 경로 확인 실패"))?;
        let manager_exe = self_exe
            .parent()
            .ok_or("테스트 하네스 폴더가 없습니다.")?
            .join(MANAGER_FILE);
        ensure_regular_file(&manager_exe)?;
        validate_manager_pe(&manager_exe)?;
        validate_manager_pe(&self_exe)?;
        let mut report = BTreeMap::<String, bool>::new();

        // The fixture manager and candidate are both real PE executables. The
        // test candidate only handles the read-only nonce probe; no GUI starts.
        {
            let (layout, auth, _old_sha, new_sha) =
                setup_case(&root, "success", &manager_exe, &self_exe)?;
            let setting = layout.root.join("synthetic-user-settings.json");
            let patch_backup = layout.root.join("synthetic-patch-backup.asar");
            write_new_synced(&setting, br#"{"autoWatch":false,"zoom":1}"#)?;
            write_new_synced(&patch_backup, b"test-only preserved patch backup bytes")?;
            let setting_sha = sha256_file(&setting)?;
            let patch_sha = sha256_file(&patch_backup)?;
            let outcome = apply_authorized(&layout, &auth, Faults::default())?;
            require(outcome.state == "COMMITTED", "정상 EXE 교체와 시작 확인")?;
            require(
                sha256_file(&layout.manager)? == new_sha,
                "교체된 관리자 SHA",
            )?;
            require(
                sha256_file(
                    &layout.backups_dir.join(
                        outcome
                            .backup_path
                            .as_ref()
                            .and_then(|path| path.file_name())
                            .and_then(|n| n.to_str())
                            .unwrap_or(""),
                    ),
                )
                .is_ok(),
                "교체 백업 보존",
            )?;
            require(
                sha256_file(&setting)? == setting_sha && sha256_file(&patch_backup)? == patch_sha,
                "설정과 패치 백업 보존",
            )?;
            report.insert("actual_pe_replace_and_start_probe".into(), true);
        }

        {
            let (layout, auth, old_sha, new_sha) =
                setup_case(&root, "terminal_request_cleanup", &manager_exe, &self_exe)?;
            let outcome = apply_authorized(&layout, &auth, Faults::default())?;
            require(outcome.state == "COMMITTED", "완료 저널 준비 파일 정리 fixture")?;
            let nonce = "0123456789abcdef0123456789abcdef";
            write_new_synced(
                &layout.update_request,
                &serde_json::to_vec_pretty(&request_for(&auth, nonce))
                    .map_err(|error| error.to_string())?,
            )?;
            let record = latest_record(&layout.journal)?.ok_or("완료 저널이 없습니다.")?;
            let authorization = read_terminal_request_authorization(
                &layout,
                &record,
                compiled_product_id(),
            )?
            .ok_or("검증된 요청이 없습니다.")?;
            let marker = InstallMarker::read(&layout.marker)?;
            let current_sha = sha256_file(&layout.manager)?;
            let artifacts = cleanup_terminal_artifacts(
                &layout,
                &record,
                &marker,
                &current_sha,
                compiled_product_id(),
                Some(&authorization),
            )?;
            require(
                artifacts.request
                    && artifacts.staged_manager
                    && !path_entry_exists(&layout.update_request)?
                    && !path_entry_exists(&layout.staged_manager)?,
                "저널·요청과 SHA가 일치할 때만 승인 요청 및 준비 EXE 정리",
            )?;
            require(
                current_sha == new_sha
                    && marker.manager_sha256 == new_sha
                    && sha256_file(&layout.manager)? == new_sha
                    && sha256_file(&layout.backups_dir.join(
                        latest_record(&layout.journal)?
                            .ok_or("정리 후 저널이 없습니다.")?
                            .backup_name,
                    ))? == old_sha,
                "정리 후 관리자와 원본 백업 무결성",
            )?;
            report.insert("terminal_request_and_staging_cleanup_bound_to_journal".into(), true);
        }

        {
            let (layout, auth, old_sha, _new_sha) =
                setup_case(&root, "interrupted_recovery_cleanup", &manager_exe, &self_exe)?;
            let interrupted = apply_authorized(
                &layout,
                &auth,
                Faults {
                    interrupt_after_replace: true,
                    ..Faults::default()
                },
            )?;
            require(interrupted.state == "BACKED_UP", "중단 복구 정리 fixture")?;
            let nonce = "fedcba9876543210fedcba9876543210";
            write_new_synced(
                &layout.update_request,
                &serde_json::to_vec_pretty(&request_for(&auth, nonce))
                    .map_err(|error| error.to_string())?,
            )?;
            let recovered = recover_pending_test(&layout, false)?
                .ok_or("중단 transaction 복구가 실행되지 않았습니다.")?;
            require(
                recovered.state == "ROLLED_BACK" && sha256_file(&layout.manager)? == old_sha,
                "중단 transaction 원본 복구",
            )?;
            let record = latest_record(&layout.journal)?.ok_or("rollback 저널이 없습니다.")?;
            let authorization = read_terminal_request_authorization(
                &layout,
                &record,
                compiled_product_id(),
            )?
            .ok_or("rollback 요청 검증이 없습니다.")?;
            let marker = InstallMarker::read(&layout.marker)?;
            let current_sha = sha256_file(&layout.manager)?;
            let artifacts = cleanup_terminal_artifacts(
                &layout,
                &record,
                &marker,
                &current_sha,
                compiled_product_id(),
                Some(&authorization),
            )?;
            let backup = layout.backups_dir.join(&record.backup_name);
            require(
                artifacts.request
                    && artifacts.staged_manager
                    && !path_entry_exists(&layout.update_request)?
                    && !path_entry_exists(&layout.staged_manager)?
                    && sha256_file(&layout.manager)? == old_sha
                    && sha256_file(&backup)? == old_sha,
                "rollback 이후 요청·준비 EXE만 정리하고 원본 백업 보존",
            )?;
            report.insert("interrupted_rollback_cleans_matching_staging".into(), true);
        }

        {
            let (layout, auth, old_sha, new_sha) =
                setup_case(&root, "terminal_request_mismatch", &manager_exe, &self_exe)?;
            let interrupted = apply_authorized(
                &layout,
                &auth,
                Faults {
                    interrupt_after_replace: true,
                    ..Faults::default()
                },
            )?;
            require(interrupted.state == "BACKED_UP", "요청 불일치 rollback fixture")?;
            let _ = recover_pending_test(&layout, false)?;
            let mut request = request_for(&auth, "0123456789abcdef0123456789abcdef");
            request["oldVersion"] = json!("0.1.0-beta.6");
            write_new_synced(
                &layout.update_request,
                &serde_json::to_vec_pretty(&request).map_err(|error| error.to_string())?,
            )?;
            let record = latest_record(&layout.journal)?.ok_or("복구 완료 저널이 없습니다.")?;
            let marker = InstallMarker::read(&layout.marker)?;
            let current_sha = sha256_file(&layout.manager)?;
            let authorization = read_terminal_request_authorization(
                &layout,
                &record,
                compiled_product_id(),
            );
            require(
                authorization.is_err()
                    && path_entry_exists(&layout.update_request)?
                    && path_entry_exists(&layout.staged_manager)?
                    && marker.manager_sha256 == old_sha
                    && current_sha == old_sha
                    && sha256_file(&layout.staged_manager)? == new_sha,
                "저널과 다른 승인 요청은 정리하지 않고 모든 파일 보존",
            )?;
            report.insert("mismatched_terminal_request_preserved".into(), true);
        }

        for (name, old, new) in [
            ("same_version_rejected", "0.2.0", "0.2.0"),
            ("downgrade_rejected", "0.2.0", "0.1.0-beta.7"),
        ] {
            let (layout, mut auth, old_sha, _) = setup_case(&root, name, &manager_exe, &self_exe)?;
            auth.old_version = old.into();
            auth.new_version = new.into();
            auth.release_tag = format!("dino-v{new}");
            require(auth.validate().is_err(), name)?;
            let result = apply_authorized(&layout, &auth, Faults::default());
            require(
                result.is_err() && sha256_file(&layout.manager)? == old_sha,
                name,
            )?;
            report.insert(name.into(), true);
        }

        for (name, wrong_product, wrong_sha) in [
            ("wrong_product_rejected", true, false),
            ("wrong_digest_rejected", false, true),
            ("staged_file_swap_rejected", false, true),
        ] {
            let (layout, mut auth, old_sha, _) = setup_case(&root, name, &manager_exe, &self_exe)?;
            if wrong_product {
                auth.product_id = "other.product".into();
            }
            if wrong_sha {
                auth.staged_sha256 = "00".repeat(32);
                if name == "wrong_digest_rejected" {
                    auth.asset_sha256 = auth.staged_sha256.clone();
                }
            }
            let result = apply_authorized(&layout, &auth, Faults::default());
            require(
                result.is_err() && sha256_file(&layout.manager)? == old_sha,
                name,
            )?;
            report.insert(name.into(), true);
        }

        for (name, faults, expected_state) in [
            (
                "manager_shutdown_failure",
                Faults {
                    manager_shutdown: true,
                    ..Faults::default()
                },
                "",
            ),
            (
                "backup_creation_failure",
                Faults {
                    backup: true,
                    ..Faults::default()
                },
                "ROLLED_BACK",
            ),
            (
                "replace_failure",
                Faults {
                    replacement: true,
                    ..Faults::default()
                },
                "ROLLED_BACK",
            ),
            (
                "restart_failure_rolls_back",
                Faults {
                    start_check: true,
                    ..Faults::default()
                },
                "ROLLED_BACK",
            ),
        ] {
            let (layout, auth, old_sha, _) = setup_case(&root, name, &manager_exe, &self_exe)?;
            let result = apply_authorized(&layout, &auth, faults);
            if expected_state.is_empty() {
                require(result.is_err(), name)?;
            } else {
                let outcome = result?;
                require(outcome.state == expected_state, name)?;
            }
            require(
                sha256_file(&layout.manager)? == old_sha,
                "실패 후 원본 EXE 보존",
            )?;
            report.insert(name.into(), true);
        }

        {
            let (layout, auth, old_sha, _) =
                setup_case(&root, "interrupted_recovery", &manager_exe, &self_exe)?;
            let interrupted = apply_authorized(
                &layout,
                &auth,
                Faults {
                    interrupt_after_replace: true,
                    ..Faults::default()
                },
            )?;
            require(interrupted.state == "BACKED_UP", "교체 직후 중단 저널 상태")?;
            let recovered = recover_pending_test(&layout, false)?
                .ok_or("중단 트랜잭션을 복구하지 않았습니다.")?;
            require(
                recovered.state == "ROLLED_BACK" && sha256_file(&layout.manager)? == old_sha,
                "다음 실행에서 원본 복구",
            )?;
            report.insert("interrupted_transaction_recovers".into(), true);
        }

        {
            let (layout, auth, old_sha, new_sha) = setup_case(
                &root,
                "recovery_failed_then_retried",
                &manager_exe,
                &self_exe,
            )?;
            let failed = apply_authorized(
                &layout,
                &auth,
                Faults {
                    start_check: true,
                    rollback: true,
                    ..Faults::default()
                },
            )?;
            require(
                failed.state == "RECOVERY_FAILED" && sha256_file(&layout.manager)? == new_sha,
                "복구 실패 기록과 백업 보존",
            )?;
            require(
                layout
                    .backups_dir
                    .join(format!(
                        "manager-{}.exe",
                        latest_record(&layout.journal)?.unwrap().transaction_id
                    ))
                    .exists(),
                "복구 실패 시 백업 보존",
            )?;
            let recovered = recover_pending_test(&layout, false)?
                .ok_or("복구 실패 재시도를 실행하지 않았습니다.")?;
            require(
                recovered.state == "ROLLED_BACK" && sha256_file(&layout.manager)? == old_sha,
                "복구 재시도",
            )?;
            report.insert("recovery_failed_state_then_recovery".into(), true);
        }

        {
            let (layout, _auth, _, _) =
                setup_case(&root, "concurrent_lock", &manager_exe, &self_exe)?;
            let held = UpdateLock::acquire(&layout.root, Duration::from_millis(0))?;
            let root = layout.root.clone();
            let contender = std::thread::spawn(move || {
                UpdateLock::acquire(&root, Duration::from_millis(0)).is_err()
            });
            require(contender.join().unwrap_or(false), "중복 updater 실행 잠금")?;
            drop(held);
            report.insert("duplicate_execution_blocked".into(), true);
        }

        {
            let outside =
                PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_default()).join("System32");
            require(
                validate_test_root(&outside).is_err(),
                "테스트 경로 이탈 차단",
            )?;
            report.insert("test_root_escape_blocked".into(), true);
        }

        {
            let (layout, _auth, old_sha, _) =
                setup_case(&root, "truncated_journal_fails_closed", &manager_exe, &self_exe)?;
            fs::write(&layout.journal, b"{\"schemaVersion\":1,\"seq\":0")
                .map_err(io_error("잘린 저널 테스트 데이터 작성 실패"))?;
            require(
                latest_record(&layout.journal).is_err()
                    && sha256_file(&layout.manager)? == old_sha,
                "잘린 저널 거부 및 관리자 보존",
            )?;
            report.insert("truncated_journal_fails_closed".into(), true);
        }

        let test_count = report.len();
        let output = json!({
            "status": "LOCAL_TESTS_PASSED",
            "testProductId": TEST_PRODUCT_ID,
            "tests": report,
            "testCount": test_count,
            "productionOnlineInstall": "BLOCKED",
            "root": "isolated TEMP test root"
        });
        let summary_path = root.join("summary.json");
        write_new_synced(
            &summary_path,
            &serde_json::to_vec_pretty(&output).map_err(|error| error.to_string())?,
        )?;
        Ok(output)
    }
}

fn reject_reparse_components(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        let mut current = PathBuf::new();
        for component in path.components() {
            match component {
                std::path::Component::Prefix(prefix) => {
                    if matches!(
                        prefix.kind(),
                        std::path::Prefix::UNC(_, _)
                            | std::path::Prefix::VerbatimUNC(_, _)
                            | std::path::Prefix::DeviceNS(_)
                    ) {
                        return Err(
                            "UNC 및 장치 네임스페이스 경로는 업데이트에서 지원하지 않습니다."
                                .into(),
                        );
                    }
                    current.push(prefix.as_os_str());
                }
                std::path::Component::RootDir => current.push(component.as_os_str()),
                std::path::Component::CurDir => continue,
                std::path::Component::ParentDir => {
                    return Err("상위 경로 이동 표기는 허용하지 않습니다.".into())
                }
                std::path::Component::Normal(part) => current.push(part),
            }
            if current.exists() {
                let wide: Vec<u16> = current
                    .as_os_str()
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
                if attributes != u32::MAX && attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(format!(
                        "심볼릭 링크 또는 재분석 지점은 업데이트 경로로 허용하지 않습니다: {}",
                        current.display()
                    ));
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        for ancestor in path.ancestors().filter(|item| item.exists()) {
            let metadata =
                fs::symlink_metadata(ancestor).map_err(io_error("경로 구성요소 검사 실패"))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "심볼릭 링크 경로는 허용하지 않습니다: {}",
                    ancestor.display()
                ));
            }
        }
    }
    Ok(())
}

fn is_same_or_child(parent: &Path, candidate: &Path) -> bool {
    let parent = path_key(parent);
    let candidate = path_key(candidate);
    candidate == parent || candidate.strip_prefix(&(parent + "\\")).is_some()
}

fn path_key(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\").to_lowercase();
    while value.ends_with('\\') {
        value.pop();
    }
    value
}

fn check_available_space(root: &Path, required: u64) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = root
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut available = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err("업데이트 디스크 여유 공간을 확인할 수 없습니다.".into());
        }
        if available < required.saturating_add(RESERVE_BYTES) {
            return Err("백업과 교체 임시 파일을 만들 디스크 공간이 부족합니다.".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (root, required);
        Err("Windows 업데이트 공간 검사는 Windows에서만 지원됩니다.".into())
    }
}

fn io_error(context: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{context}: {error}")
}

#[cfg(test)]
mod production_authorization_tests {
    use super::*;

    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const DIGEST: &str = "bf233f66f83ff34cc6322ed3a2a59e39022dc9169b6259cab995d1a828dfa892";

    fn request() -> Value {
        json!({
            "schemaVersion": UPDATE_REQUEST_SCHEMA,
            "nonce": NONCE,
            "productId": PRODUCT_ID,
            "releaseTag": "dino-v0.2.0-beta.8",
            "oldVersion": "0.2.0-beta.7",
            "newVersion": "0.2.0-beta.8",
            "oldSha256": DIGEST,
            "assetName": release_update::WINDOWS_X64_ASSET,
            "downloadUrl": format!("{}/releases/download/dino-v0.2.0-beta.8/{}", release_update::RELEASES_BASE, release_update::WINDOWS_X64_ASSET),
            "apiSha256": DIGEST,
            "stagedSha256": DIGEST,
            "apiDigestMatchesFile": true,
            "userApproved": true,
            "rollbackReady": true
        })
    }

    #[test]
    fn approved_request_is_bound_to_nonce_fixed_asset_digest_and_newer_version() {
        let value = request();
        let authorization = VerifiedUpdateAuthorization::from_request(&value, NONCE).unwrap();
        if cfg!(feature = "updater-test-harness") {
            // A harness binary has its own product identity. A valid request
            // for the production product must not authorize replacing it.
            assert_eq!(authorization.product_id, PRODUCT_ID);
            assert!(authorization.validate().is_err());
        } else {
            assert!(authorization.validate().is_ok());
        }
        assert!(VerifiedUpdateAuthorization::from_request(
            &value,
            "ffffffffffffffffffffffffffffffff"
        )
        .is_err());

        let mut tampered = request();
        tampered["downloadUrl"] = json!("https://attacker.invalid/manager.exe");
        assert!(VerifiedUpdateAuthorization::from_request(&tampered, NONCE).is_err());

        let mut tampered = request();
        tampered["userApproved"] = json!(false);
        assert!(VerifiedUpdateAuthorization::from_request(&tampered, NONCE).is_err());

        let mut tampered = request();
        tampered["stagedSha256"] = json!("00".repeat(32));
        assert!(VerifiedUpdateAuthorization::from_request(&tampered, NONCE).is_err());
    }
}

// Windows process and mutex coordination follows below; non-Windows builds are
// compileable for metadata inspection but cannot execute a file replacement.
