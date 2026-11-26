#![allow(dead_code)]

#[path = "../src/asar.rs"]
mod asar;
#[path = "../src/bundle_preview.rs"]
mod bundle_preview;
#[path = "../src/patch_set.rs"]
mod patch_set;
#[path = "../src/transaction.rs"]
mod transaction;

use patch_set::{ManagerInstallSupport, PatchId, PatchSet};
use serde_json::{json, Value};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

fn fail(message: impl Into<String>) -> Box<dyn Error + Send + Sync> {
    std::io::Error::other(message.into()).into()
}

fn read_state(root: &Path) -> Result<Value> {
    let path = transaction::state_root(root)?.join("state.json");
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn backup_for(root: &Path, state: &Value) -> Result<PathBuf> {
    let name = state["backupFile"].as_str().unwrap_or("original-app.asar");
    if Path::new(name).file_name().and_then(|value| value.to_str()) != Some(name) {
        return Err(fail("backup record is not a single safe filename"));
    }
    Ok(transaction::state_root(root)?.join(name))
}

fn prepare_install(root: &Path, original: &Path, original_sha: &str) -> Result<PathBuf> {
    if root.exists() {
        return Err(fail(format!("refusing to overwrite test install {}", root.display())));
    }
    fs::create_dir_all(root.join("resources"))?;
    fs::write(
        root.join("LilacAnime.exe"),
        b"DinoPatch test-only executable placeholder; never launched",
    )?;
    fs::copy(original, root.join("resources/app.asar"))?;
    let install = transaction::installed_root(root)?;
    if transaction::sha(&install.join("resources/app.asar"))? != original_sha {
        return Err(fail("isolated install did not receive the official source ASAR"));
    }
    Ok(install)
}

fn seed_legacy_r1_record(
    install: &Path,
    composition: &str,
    original: &Path,
    r1_archive: &Path,
    original_sha: &str,
    r1_sha: &str,
) -> Result<()> {
    if transaction::sha(original)? != original_sha || transaction::sha(r1_archive)? != r1_sha {
        return Err(fail("legacy r1 fixture does not match the registered source/output hashes"));
    }
    let installed = install.join("resources/app.asar");
    fs::copy(r1_archive, &installed)?;
    let root = transaction::installed_root(install)?;
    let data = transaction::state_root(&root)?;
    fs::create_dir_all(&data)?;
    fs::copy(original, data.join("original-app.asar"))?;
    let record = json!({
        "schemaVersion": 1,
        "target": root.to_string_lossy(),
        "version": "0.5.65",
        "patchVersion": "1.0.0",
        "status": "APPLIED",
        "compositionId": composition,
        "originalSha256": original_sha,
        "patchedSha256": r1_sha,
        "backupId": "legacy-r1-fixture-backup",
        "createdAt": "2026-11-22T00:00:00Z",
        "backupFile": null
    });
    fs::write(data.join("state.json"), serde_json::to_vec_pretty(&record)?)?;
    Ok(())
}

fn inspect_feature_selection(archive_path: &Path, set: PatchSet) -> Result<Value> {
    let archive = asar::Archive::open(archive_path)?;
    let app = String::from_utf8(archive.read("src/app.js")?)?;
    let html = String::from_utf8(archive.read("src/index.html")?)?;
    let integrated_files = [
        "electron/dino-work-db.cjs",
        "src/dino-sqlite-sync.js",
        "src/integrated-search.css",
        "src/integrated-search.js",
        "src/patch03-bridge.js",
    ];
    let integrated_file_presence: Vec<bool> = integrated_files
        .iter()
        .map(|path| archive.read(path).is_ok())
        .collect();
    let integrated_selected = set.contains(PatchId::IntegratedSearchProviderSwitch);
    if integrated_file_presence
        .iter()
        .any(|present| *present != integrated_selected)
    {
        return Err(fail(format!(
            "01 files are incomplete or leaked into composition {}",
            set.id()
        )));
    }
    let adult_css = archive.read("src/adult-catalog.css").is_ok();
    let adult_nav = html.contains("data-view=\"adultCatalog\"");
    let adult_stylesheet = html.contains("adult-catalog.css");
    let adult_app = app.contains("adultCatalog");
    let fast = app.contains("updateFastHlsBuffer");
    let adult_selected = set.contains(PatchId::AdultOnlyTab);
    if adult_css != adult_selected
        || adult_nav != adult_selected
        || adult_stylesheet != adult_selected
        || adult_app != adult_selected
        || fast != set.contains(PatchId::DoubleSpeedBuffering)
    {
        return Err(fail(format!("ASAR feature content does not match {}", set.id())));
    }
    Ok(json!({
        "01IntegratedSearch": integrated_selected,
        "01Files": integrated_files.iter().zip(integrated_file_presence).collect::<std::collections::BTreeMap<_, _>>(),
        "02AdultOnlyTab": adult_selected,
        "02AdultCss": adult_css,
        "02AdultNav": adult_nav,
        "02AdultStylesheet": adult_stylesheet,
        "02AdultApp": adult_app,
        "03FastBuffer": fast
    }))
}

fn verify_applied(root: &Path, set: PatchSet, expected_original: &str) -> Result<Value> {
    let id = set.id();
    let fingerprint = patch_set::combination_capability(set)
        .fingerprint
        .ok_or_else(|| fail(format!("missing registered fingerprint for {id}")))?;
    if patch_set::combination_capability(set).manager_install != ManagerInstallSupport::Supported {
        return Err(fail(format!("{} is not manager-installable", id)));
    }
    let archive_path = root.join("resources/app.asar");
    let actual_sha = transaction::sha(&archive_path)?;
    if actual_sha != fingerprint.result_sha256 {
        return Err(fail(format!("{} result SHA-256 mismatch: {actual_sha}", id)));
    }
    let status = transaction::inspect(root);
    if status.status != "APPLIED" || status.composition_id.as_deref() != Some(id.as_str()) {
        return Err(fail(format!("{} status record mismatch: {}", id, status.reason)));
    }
    let state = read_state(root)?;
    if state["compositionId"] != id
        || state["originalSha256"] != expected_original
        || state["patchedSha256"] != fingerprint.result_sha256
    {
        return Err(fail(format!("{} applied state does not match the ASAR", id)));
    }
    let backup_path = backup_for(root, &state)?;
    let backup_sha = transaction::sha(&backup_path)?;
    if backup_sha != expected_original {
        return Err(fail(format!("{} original backup SHA-256 mismatch", id)));
    }
    let contents = inspect_feature_selection(&archive_path, set)?;
    Ok(json!({
        "compositionId": id,
        "status": status.status,
        "installedSha256": actual_sha,
        "backupSha256": backup_sha,
        "featureContent": contents
    }))
}

fn restore_and_verify(root: &Path, original_sha: &str) -> Result<Value> {
    let state = read_state(root)?;
    let backup_id = state["backupId"]
        .as_str()
        .ok_or_else(|| fail("applied state has no backup ID"))?;
    let backup_path = backup_for(root, &state)?;
    if transaction::sha(&backup_path)? != original_sha {
        return Err(fail("refusing restore because the original backup is not verified"));
    }
    let restored = transaction::restore(root, backup_id)?;
    let archive_sha = transaction::sha(&root.join("resources/app.asar"))?;
    let backup_sha = transaction::sha(&backup_path)?;
    if restored.status != "UNPATCHED" || archive_sha != original_sha || backup_sha != original_sha {
        return Err(fail(format!("restore verification failed: {}", restored.reason)));
    }
    if transaction::state_root(root)?.join("pending.json").exists()
        || root.join("resources/app.asar.dino-writing").exists()
        || root.join("resources/app.asar.dino-restore").exists()
    {
        return Err(fail("transaction left pending or staging files after restore"));
    }
    Ok(json!({
        "status": restored.status,
        "restoredSha256": archive_sha,
        "retainedBackupSha256": backup_sha
    }))
}

#[test]
#[ignore = "requires preserved official-source composition preview ASAR evidence"]
fn preserved_preview_asars_contain_only_the_selected_features() -> Result<()> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sets_root = repo.join(
        "../../../validation-evidence/beta9-composition-preview-20261122/sets",
    );
    for set in PatchSet::logical_combinations() {
        let id = set.id();
        let archive_path = sets_root.join(&id).join("combined.asar");
        let fingerprint = patch_set::combination_capability(set)
            .fingerprint
            .ok_or_else(|| fail(format!("missing registered fingerprint for {id}")))?;
        let actual_sha = transaction::sha(&archive_path)?;
        if actual_sha != fingerprint.result_sha256 {
            return Err(fail(format!("{id} preview SHA-256 does not match its fingerprint")));
        }
        inspect_feature_selection(&archive_path, set)?;
    }
    Ok(())
}

#[test]
#[ignore = "requires official v0.5.65 app.asar and isolated environment variables"]
fn seven_compositions_install_independently_and_follow_requested_transitions() -> Result<()> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
    let evidence_root = repo.join("../../../validation-evidence").canonicalize()?;
    let run_root = std::env::var_os("DINO_COMPOSITION_MATRIX_E2E_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| fail("DINO_COMPOSITION_MATRIX_E2E_ROOT is required"))?;
    let parent = run_root
        .parent()
        .ok_or_else(|| fail("test root must be a direct child of validation-evidence"))?
        .canonicalize()?;
    if parent != evidence_root || run_root.exists() {
        return Err(fail("test root must be new and directly under validation-evidence"));
    }
    fs::create_dir(&run_root)?;
    let run_root = run_root.canonicalize()?;
    if !run_root.starts_with(&evidence_root) {
        return Err(fail("test root escaped validation-evidence"));
    }

    let original = repo.join(
        "../../../validation-evidence/beta8-integration-final-20261118/combined-preview-r2/original.asar",
    );
    asar::file_only(&original)?;
    let original_sha = transaction::sha(&original)?;
    if original_sha != patch_set::OFFICIAL_V065_SHA256 {
        return Err(fail("official v0.5.65 source SHA-256 mismatch"));
    }
    let appdata = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| fail("isolated APPDATA is required"))?
        .canonicalize()?;
    if !appdata.starts_with(&evidence_root) {
        return Err(fail("APPDATA must remain under validation-evidence"));
    }
    let sentinel = appdata.join("unrelated-settings-sentinel.json");
    fs::write(&sentinel, br#"{"isolated":"must remain unchanged"}"#)?;
    let sentinel_sha = transaction::sha(&sentinel)?;

    let mut independent_installs = Vec::new();
    for set in PatchSet::logical_combinations() {
        let id = set.id();
        let install_name = format!("independent-{}", id.replace('+', "-"));
        let install = prepare_install(&run_root.join(install_name), &original, &original_sha)?;
        let applied = transaction::apply_selection(&install, set, true)?;
        if applied.status != "APPLIED" || applied.composition_id.as_deref() != Some(id.as_str()) {
            return Err(fail(format!("independent {} install failed: {}", id, applied.reason)));
        }
        let applied_evidence = verify_applied(&install, set, &original_sha)?;
        let repeated = transaction::apply_selection(&install, set, true)?;
        if repeated.status != "ALREADY_APPLIED" {
            return Err(fail(format!("{} same-composition reapply was not idempotent", id)));
        }
        let restore_evidence = restore_and_verify(&install, &original_sha)?;
        independent_installs.push(json!({
            "compositionId": id,
            "install": applied_evidence,
            "sameSelection": repeated.status,
            "restore": restore_evidence
        }));
    }

    let transition_root = prepare_install(&run_root.join("transition-install"), &original, &original_sha)?;
    let first = PatchSet::parse_id("01").map_err(fail)?;
    let first_status = transaction::apply_selection(&transition_root, first, true)?;
    if first_status.status != "APPLIED" {
        return Err(fail(format!("transition baseline 01 install failed: {}", first_status.reason)));
    }
    verify_applied(&transition_root, first, &original_sha)?;

    let transition_targets = ["01+02", "01", "01+03", "02+03", "02", "01+02+03", "03"];
    let mut transitions = Vec::new();
    let mut current = "01".to_owned();
    for target_id in transition_targets {
        let target = PatchSet::parse_id(target_id).map_err(fail)?;
        let status = transaction::apply_selection(&transition_root, target, false)?;
        if status.status != "APPLIED" || status.composition_id.as_deref() != Some(target_id) {
            return Err(fail(format!("{} -> {} transition failed: {}", current, target_id, status.reason)));
        }
        let installed = verify_applied(&transition_root, target, &original_sha)?;
        transitions.push(json!({
            "from": current,
            "to": target_id,
            "status": status.status,
            "install": installed
        }));
        current = target_id.to_owned();
    }
    let final_restore = restore_and_verify(&transition_root, &original_sha)?;
    transitions.push(json!({
        "from": current,
        "to": "NONE",
        "status": final_restore["status"],
        "restore": final_restore
    }));

    let final_sentinel_sha = transaction::sha(&sentinel)?;
    if final_sentinel_sha != sentinel_sha {
        return Err(fail("isolated unrelated-data sentinel changed"));
    }
    let output = json!({
        "officialOriginalSha256": original_sha,
        "independentInstallFolders": independent_installs,
        "requestedTransitionSequence": transitions,
        "unrelatedIsolatedDataBeforeAndAfterSha256": sentinel_sha,
        "actualApplicationGuiLaunched": false,
        "applicationExecutableFixtureLaunched": false
    });
    fs::write(
        run_root.join("independent-composition-results.json"),
        serde_json::to_vec_pretty(&output)?,
    )?;
    Ok(())
}

#[test]
#[ignore = "requires preserved official/r1 ASARs and a new isolated APPDATA/evidence root"]
fn legacy_r1_records_transition_to_verified_r2_and_restore_the_official_source() -> Result<()> {
    use std::ffi::OsString;

    struct RestoreEnv(Option<OsString>);
    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            if let Some(value) = self.0.take() {
                std::env::set_var("APPDATA", value);
            } else {
                std::env::remove_var("APPDATA");
            }
        }
    }

    let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
    let evidence_root = repo.join("../../../validation-evidence").canonicalize()?;
    let run_root = std::env::var_os("DINO_R1_R2_E2E_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| fail("DINO_R1_R2_E2E_ROOT is required"))?;
    let parent = run_root
        .parent()
        .ok_or_else(|| fail("test root must be a direct child of validation-evidence"))?
        .canonicalize()?;
    if parent != evidence_root || run_root.exists() {
        return Err(fail("r1/r2 E2E root must be new and directly under validation-evidence"));
    }
    fs::create_dir(&run_root)?;
    let run_root = run_root.canonicalize()?;
    if !run_root.starts_with(&evidence_root) {
        return Err(fail("r1/r2 E2E root escaped validation-evidence"));
    }

    let original = repo.join(
        "../../../validation-evidence/beta8-integration-final-20261118/combined-preview-r2/original.asar",
    );
    let r1_archive = repo.join(
        "../../../validation-evidence/beta9-composition-preview-20261122/sets/01+02+03/combined.asar",
    );
    let original_sha = patch_set::OFFICIAL_V065_SHA256;
    let r1_sha = patch_set::PATCH_01_02_03_V065_R1_SHA256;
    let r2_sha = patch_set::PATCH_01_02_03_V065_R2_SHA256;
    if transaction::sha(&original)? != original_sha || transaction::sha(&r1_archive)? != r1_sha {
        return Err(fail("preserved official/r1 archive does not match the pinned fingerprints"));
    }

    let appdata = run_root.join("isolated-appdata");
    fs::create_dir(&appdata)?;
    let sentinel = appdata.join("unrelated-settings-sentinel.json");
    fs::write(&sentinel, br#"{"mustRemain":"unchanged"}"#)?;
    let sentinel_sha = transaction::sha(&sentinel)?;
    let _restore_env = RestoreEnv(std::env::var_os("APPDATA"));
    std::env::set_var("APPDATA", &appdata);

    let install = prepare_install(&run_root.join("legacy-r1-install"), &original, original_sha)?;
    seed_legacy_r1_record(
        &install,
        "01+02+03",
        &original,
        &r1_archive,
        original_sha,
        r1_sha,
    )?;

    let old = transaction::inspect(&install);
    if old.status != "REVISION_UPDATE_AVAILABLE"
        || old.composition_id.as_deref() != Some("01+02+03")
        || old.revision_id.as_deref() != Some("r1")
    {
        return Err(fail(format!("legacy r1 state was not recognized: {}", old.reason)));
    }
    let deferred = transaction::apply_selection(
        &install,
        PatchSet::parse_id("01+02+03").map_err(fail)?,
        false,
    )?;
    if deferred.status != "REVISION_UPDATE_AVAILABLE"
        || transaction::sha(&install.join("resources/app.asar"))? != r1_sha
    {
        return Err(fail("automatic path replaced an r1 file instead of waiting for explicit confirmation"));
    }

    let same = PatchSet::parse_id("01+02+03").map_err(fail)?;
    let upgraded = transaction::apply_selection(&install, same, true)?;
    if upgraded.status != "APPLIED" || transaction::sha(&install.join("resources/app.asar"))? != r2_sha {
        return Err(fail(format!("legacy r1 -> same-set r2 transition failed: {}", upgraded.reason)));
    }
    let state = read_state(&install)?;
    if state["revisionId"] != "r2" || state["revisionNumber"] != 2
        || transaction::sha(&backup_for(&install, &state)?)? != original_sha
    {
        return Err(fail("same-set r2 state or retained original backup does not match"));
    }
    let same_again = transaction::apply_selection(&install, same, true)?;
    if same_again.status != "ALREADY_APPLIED" {
        return Err(fail("same r2 selection was not idempotent"));
    }

    let mut transitions = vec![json!({"from":"01+02+03:r1","to":"01+02+03:r2","status":"APPLIED","sha256":r2_sha})];
    for target_id in ["01+02", "02+03", "02"] {
        let target = PatchSet::parse_id(target_id).map_err(fail)?;
        let result = transaction::apply_selection(&install, target, true)?;
        let expected = patch_set::combination_capability(target)
            .fingerprint
            .ok_or_else(|| fail(format!("no registered r2 output for {target_id}")))?;
        if result.status != "APPLIED"
            || transaction::sha(&install.join("resources/app.asar"))? != expected.result_sha256
        {
            return Err(fail(format!("r2 composition transition to {target_id} failed: {}", result.reason)));
        }
        let state = read_state(&install)?;
        if state["revisionId"] != "r2" || transaction::sha(&backup_for(&install, &state)?)? != original_sha {
            return Err(fail(format!("r2 state or original backup did not survive transition to {target_id}")));
        }
        verify_applied(&install, target, original_sha)?;
        transitions.push(json!({"from":"previous-r2","to":target_id,"status":result.status,"sha256":expected.result_sha256}));
    }

    let final_state = read_state(&install)?;
    let backup_id = final_state["backupId"].as_str().ok_or_else(|| fail("r2 backup id missing"))?;
    let restored = transaction::restore(&install, backup_id)?;
    if restored.status != "UNPATCHED"
        || transaction::sha(&install.join("resources/app.asar"))? != original_sha
        || transaction::sha(&backup_for(&install, &final_state)?)? != original_sha
    {
        return Err(fail(format!("r2 uninstall did not restore the official source: {}", restored.reason)));
    }
    let history_count = fs::read_dir(transaction::state_root(&install)?)?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("state-history-"))
        .count();
    if history_count < 1 || transaction::sha(&sentinel)? != sentinel_sha {
        return Err(fail("r1 history or unrelated isolated settings were not preserved"));
    }

    let report = json!({
        "scenario":"legacy r1 -> r2 revision update, r2 cross-composition transitions, official restore",
        "sourceSha256":original_sha,
        "legacyR1Sha256":r1_sha,
        "r2Sha256":r2_sha,
        "legacyStatus":old.status,
        "automaticUpdate":"DEFERRED",
        "sameCompositionR2":upgraded.status,
        "sameRevisionReapply":same_again.status,
        "transitions":transitions,
        "restoredSha256":original_sha,
        "stateHistoryCount":history_count,
        "isolatedSentinelSha256":sentinel_sha,
        "applicationExecutableFixtureLaunched":false
    });
    fs::write(
        run_root.join("r1-r2-transition-results.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}

#[test]
#[ignore = "requires the official v0.5.65 ASAR and a new isolated APPDATA/evidence root"]
fn fresh_r2_compositions_install_idempotently_and_restore_the_official_source() -> Result<()> {
    use std::ffi::OsString;

    struct RestoreEnv(Option<OsString>);
    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            if let Some(value) = self.0.take() {
                std::env::set_var("APPDATA", value);
            } else {
                std::env::remove_var("APPDATA");
            }
        }
    }

    let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
    let evidence_root = repo.join("../../../validation-evidence").canonicalize()?;
    let run_root = std::env::var_os("DINO_R2_FRESH_INSTALL_E2E_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| fail("DINO_R2_FRESH_INSTALL_E2E_ROOT is required"))?;
    let parent = run_root
        .parent()
        .ok_or_else(|| fail("test root must be a direct child of validation-evidence"))?
        .canonicalize()?;
    if parent != evidence_root || run_root.exists() {
        return Err(fail("fresh r2 E2E root must be new and directly under validation-evidence"));
    }
    fs::create_dir(&run_root)?;
    let run_root = run_root.canonicalize()?;
    if !run_root.starts_with(&evidence_root) {
        return Err(fail("fresh r2 E2E root escaped validation-evidence"));
    }

    let original = repo.join(
        "../../../validation-evidence/beta8-integration-final-20261118/combined-preview-r2/original.asar",
    );
    asar::file_only(&original)?;
    let original_sha = transaction::sha(&original)?;
    if original_sha != patch_set::OFFICIAL_V065_SHA256 {
        return Err(fail("official v0.5.65 source SHA-256 mismatch"));
    }

    let appdata = run_root.join("isolated-appdata");
    fs::create_dir(&appdata)?;
    let sentinel = appdata.join("unrelated-settings-sentinel.json");
    fs::write(&sentinel, br#"{"mustRemain":"unchanged"}"#)?;
    let sentinel_sha = transaction::sha(&sentinel)?;
    let _restore_env = RestoreEnv(std::env::var_os("APPDATA"));
    std::env::set_var("APPDATA", &appdata);

    let mut results = Vec::new();
    for set in ["02", "01+02", "02+03", "01+02+03"] {
        let composition = PatchSet::parse_id(set).map_err(fail)?;
        let fingerprint = patch_set::combination_capability(composition)
            .fingerprint
            .ok_or_else(|| fail(format!("missing registered r2 fingerprint for {set}")))?;
        let install = prepare_install(&run_root.join(format!("fresh-{}", set.replace('+', "-"))), &original, &original_sha)?;
        let applied = transaction::apply_selection(&install, composition, true)?;
        if applied.status != "APPLIED"
            || transaction::sha(&install.join("resources/app.asar"))? != fingerprint.result_sha256
        {
            return Err(fail(format!("fresh r2 install failed for {set}: {}", applied.reason)));
        }
        let state = read_state(&install)?;
        if state["revisionId"] != "r2" || state["revisionNumber"] != 2
            || transaction::sha(&backup_for(&install, &state)?)? != original_sha
        {
            return Err(fail(format!("fresh r2 state or backup did not validate for {set}")));
        }
        let verified = verify_applied(&install, composition, &original_sha)?;
        let repeated = transaction::apply_selection(&install, composition, true)?;
        if repeated.status != "ALREADY_APPLIED" {
            return Err(fail(format!("fresh r2 same-set apply was not idempotent for {set}")));
        }
        let restored = restore_and_verify(&install, &original_sha)?;
        results.push(json!({
            "compositionId": set,
            "installed": verified,
            "revisionId": state["revisionId"],
            "sameSelection": repeated.status,
            "restore": restored
        }));
    }

    if transaction::sha(&sentinel)? != sentinel_sha {
        return Err(fail("isolated unrelated data changed during r2 installs"));
    }
    let report = json!({
        "officialOriginalSha256": original_sha,
        "freshR2Compositions": results,
        "isolatedSentinelSha256": sentinel_sha,
        "applicationExecutableFixtureLaunched": false
    });
    fs::write(
        run_root.join("fresh-r2-install-results.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}
