// Windows GUI builds must not allocate a console window (the black CMD
// window users see behind the patch manager). Native CLI-only builds keep
// the console subsystem for JSON output and automation.
#![cfg_attr(all(windows, feature = "gui"), windows_subsystem = "windows")]

//! DinoPatch native Rust manager. The official LilacAnime application remains
//! an external installation; only its verified app.asar is patched.

mod asar;
mod bundle_preview;
mod diagnostics;
mod patch_set;
mod release_update;
mod transaction;
mod updater_engine;
#[cfg(feature = "gui")]
mod gui;

use serde_json::{json, Value};
use std::error::Error;
use std::io;
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

pub fn fail(message: impl Into<String>) -> Box<dyn Error + Send + Sync> {
    io::Error::other(message.into()).into()
}

fn status_json(value: transaction::Status) -> Value {
    json!({
        "status":value.status,
        "version":value.version,
        "reason":value.reason,
        "compositionId":value.composition_id,
        "revisionId":value.revision_id,
        "targetKind":"INSTALLED_ASAR",
        "patchVersion":"1.0.0",
        "recoveryAvailable":value.recovery_available,
        "manualUninstall":value.manually_uninstalled
    })
}

fn execute(args: &[String]) -> Result<Value> {
    if args.is_empty() {
        return Err(fail("Usage: dino-native-manager <info|inspect|startup|apply|uninstall|review|recover|backups|restore|discover|diagnostics|inspect-update-metadata|export-combined-preview|verify-combined-preview|export-selection-preview> ..."));
    }
    let command=args[0].as_str();
    if command == "verify-combined-preview" {
        if args.len() != 2 {
            return Err(fail("Usage: verify-combined-preview <preview-dir>"));
        }
        return bundle_preview::verify_export(std::path::Path::new(&args[1]));
    }
    if command == "export-combined-preview" {
        if args.len() != 3 {
            return Err(fail("Usage: export-combined-preview <official-app.asar> <new-preview-dir>"));
        }
        return bundle_preview::export(
            std::path::Path::new(&args[1]),
            std::path::Path::new(&args[2]),
        );
    }
    if command == "export-selection-preview" {
        if args.len() != 4 {
            return Err(fail("Usage: export-selection-preview <official-app.asar> <patch-set-id> <new-preview-dir>"));
        }
        let set = patch_set::PatchSet::parse_id(&args[2]).map_err(fail)?;
        return bundle_preview::export_selection(
            std::path::Path::new(&args[1]),
            set,
            std::path::Path::new(&args[3]),
        );
    }
    if command == "inspect-update-metadata" {
        if !(2..=3).contains(&args.len()) {
            return Err(fail("Usage: dino-native-manager inspect-update-metadata <github-release-list.json> [downloaded-asset]"));
        }
        let release_text = std::fs::read_to_string(&args[1])?;
        let releases: Value = serde_json::from_str(&release_text)?;
        let installed_version = env!("CARGO_PKG_VERSION");
        let candidate = release_update::select_newest_release(
            &releases,
            installed_version,
            release_update::current_target(),
        ).map_err(fail)?;
        let downloaded_digest_matches = if let Some(asset_path) = args.get(2) {
            let path = std::path::Path::new(asset_path);
            let name_matches = path.file_name().and_then(|name| name.to_str())
                == Some(candidate.asset_name.as_str());
            Some(name_matches && release_update::downloaded_asset_matches(&candidate, path).map_err(fail)?)
        } else {
            None
        };
        let evidence = release_update::InstallEvidence::new(
            true,
            downloaded_digest_matches,
            false,
            false,
        );
        return Ok(json!({
            "status":"METADATA_ONLY",
            "repository":release_update::REPOSITORY,
            "installedManagerVersion":installed_version,
            "tag":candidate.tag,
            "asset":candidate.asset_name,
            "downloadUrl":candidate.download_url,
            "apiSha256":candidate.sha256,
            "downloadedDigestMatches":downloaded_digest_matches,
            "releaseAttestation":"NOT_USED",
            "assetAttestation":"NOT_USED",
            "automaticInstall":false,
            "installBlockers":evidence.blockers()
        }));
    }
    if command=="info" {
        return Ok(json!({"managerVersion":env!("CARGO_PKG_VERSION"),"patchVersion":"1.0.0",
            "engine":"RUST_NATIVE","originalIsBundled":false,
            "compatibility":"structural-anchor-validation",
            "registeredVersionsRequired":false,
            "testedOfficialVersions":["0.5.54","0.5.55","0.5.63","0.5.64","0.5.65"]}));
    }
    if command=="discover" {
        let roots:Vec<PathBuf>= [
            std::env::var_os("DINO_ORIGINAL_ROOT").map(PathBuf::from),
            std::env::var_os("ProgramFiles").map(|p|PathBuf::from(p).join("LilacAnime")),
            std::env::var_os("LOCALAPPDATA").map(|p|PathBuf::from(p).join("Programs").join("LilacAnime")),
            Some(PathBuf::from(r"D:\LilacAnime")),
        ].into_iter().flatten().collect();
        for root in roots {
            if let Ok(found)=transaction::installed_root(&root) {
                return Ok(json!({"status":"SOURCE_FOUND","path":found}));
            }
        }
        return Ok(json!({"status":"NO_SOURCE","path":null}));
    }
    let root=args.get(1).ok_or_else(||fail("원본 LilacAnime 설치 폴더 경로를 지정하세요."))?;
    let path=PathBuf::from(root);
    match command {
        "inspect" => Ok(status_json(transaction::inspect(&path))),
        "startup" => Ok(status_json(transaction::apply(&path,false)?)),
        "apply" => Ok(status_json(transaction::apply(&path,true)?)),
        "uninstall" => Ok(status_json(transaction::uninstall(&path)?)),
        "review" => Ok(status_json(transaction::review_recovery(&path)?)),
        "recover" => Ok(status_json(transaction::recover(&path)?)),
        "backups" => transaction::backups(&path),
        "restore" => {
            let id=args.get(2).ok_or_else(||fail("복원할 백업 ID가 필요합니다."))?;
            Ok(status_json(transaction::restore(&path,id)?))
        },
        "diagnostics" => {
            let file = diagnostics::log_path().ok_or_else(||fail("진단 로그 폴더를 알 수 없습니다."))?;
            let raw=std::fs::read_to_string(file).unwrap_or_default();
            let lines:Vec<&str>=raw.lines().rev().take(400).collect();
            Ok(json!({"items":lines.into_iter().rev().collect::<Vec<_>>() }))
        },
        "history" => Ok(json!({"items":[]})),
        _ => Err(fail("알 수 없는 Rust 관리자 명령입니다.")),
    }
}

fn main() {
    diagnostics::install_panic_hook();
    let args:Vec<String>=std::env::args().skip(1).collect();
    #[cfg(feature="gui")]
    if let Some(result) = updater_engine::dispatch_manager_probe(&args, |path| {
        let root = transaction::installed_root(path).map_err(|error| error.to_string())?;
        let status = transaction::inspect(&root);
        if status.status.is_empty() || status.status == "PARTIAL_OR_UNKNOWN" {
            return Err(format!(
                "기존 패치 상태를 읽을 수 없습니다: {}",
                status.reason
            ));
        }
        Ok(status.status)
    }) {
        if let Err(error) = result {
            diagnostics::write(&format!("update probe failed: {error}"));
            std::process::exit(1);
        }
        return;
    }
    #[cfg(feature="gui")]
    if args.is_empty() || args.first().map(String::as_str)==Some("--gui"){
        match updater_engine::handoff_pending_recovery() {
            Ok(true) => {
                diagnostics::write("Interrupted manager update detected; handing off recovery before GUI startup");
                return;
            }
            Ok(false) => {}
            Err(error) => diagnostics::write(&format!("manager update recovery handoff unavailable: {error}")),
        }
        let _manager_session = match updater_engine::acquire_manager_session() {
            Ok(lock) => lock,
            Err(error) => {
                diagnostics::write(&format!("manager session blocked: {error}"));
                diagnostics::show_fatal_error(&error);
                std::process::exit(1);
            }
        };
        if let Err(error) = updater_engine::initialize_manager_install_marker() {
            diagnostics::write(&format!("online updater is unavailable: {error}"));
        }
        diagnostics::write("DinoPatch Rust GUI starting");
        let outcome=std::panic::catch_unwind(gui::start);
        let failure=match outcome {
            Ok(Ok(())) => {
                diagnostics::write("DinoPatch Rust GUI closed normally");
                return;
            },
            Ok(Err(err)) => err.to_string(),
            Err(_) => "관리자 GUI 내부 오류가 발생해 작업이 중단됐습니다.".to_string(),
        };
        diagnostics::write(&format!("GUI FAILED: {failure}"));
        diagnostics::show_fatal_error(&failure);
        std::process::exit(1);
    }
    // The real official ASAR has a large nested header. Give the Rust JSON
    // validation a bounded worker stack, including Windows native CLI mode.
    let task = std::thread::Builder::new().name("dino-native-asar".into())
        .stack_size(16 * 1024 * 1024).spawn(move || execute(&args));
    let outcome = match task {
        Ok(worker) => worker.join().unwrap_or_else(|_|Err(fail("Rust ASAR 검사 작업이 비정상 종료됐습니다."))),
        Err(error) => Err(fail(format!("Rust 검사 작업 생성 실패: {error}"))),
    };
    let output=match outcome {
        Ok(result)=>result,
        Err(error)=>json!({"status":"BLOCKED","readOnly":true,"reason":error.to_string()}),
    };
    println!("{output}");
    if output["status"]=="BLOCKED" {std::process::exit(1);}
}
