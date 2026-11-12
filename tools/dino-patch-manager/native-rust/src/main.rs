//! DinoPatch native Rust manager. The official LilacAnime application remains
//! an external installation; only its verified app.asar is patched.

mod asar;
mod transaction;
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
        "targetKind":"INSTALLED_ASAR",
        "patchVersion":"1.0.0",
        "recoveryAvailable":value.recovery_available,
        "manualUninstall":value.manually_uninstalled
    })
}

fn execute(args: &[String]) -> Result<Value> {
    if args.is_empty() {
        return Err(fail("Usage: dino-native-manager <info|inspect|startup|apply|uninstall|review|recover|backups|restore|discover|diagnostics> [installed-root] [backup-id]"));
    }
    let command=args[0].as_str();
    if command=="info" {
        return Ok(json!({"managerVersion":"0.2.0","patchVersion":"1.0.0",
            "engine":"RUST_NATIVE","originalIsBundled":false,
            "testedOfficialVersions":["0.5.54","0.5.55","0.5.63","0.5.64"]}));
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
            let file=std::env::current_exe()?.parent().ok_or_else(||fail("관리자 폴더 오류"))?.join("manager.log");
            let raw=std::fs::read_to_string(file).unwrap_or_default();
            let lines:Vec<&str>=raw.lines().rev().take(400).collect();
            Ok(json!({"items":lines.into_iter().rev().collect::<Vec<_>>() }))
        },
        "history" => Ok(json!({"items":[]})),
        _ => Err(fail("알 수 없는 Rust 관리자 명령입니다.")),
    }
}

fn main() {
    let args:Vec<String>=std::env::args().skip(1).collect();
    #[cfg(feature="gui")]
    if args.is_empty() || args.first().map(String::as_str)==Some("--gui"){
        if let Err(err)=gui::start(){
            eprintln!("Native GUI failed: {err}");
            std::process::exit(1);
        }
        return;
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
