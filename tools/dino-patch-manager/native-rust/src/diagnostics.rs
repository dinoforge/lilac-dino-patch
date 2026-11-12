//! Persistent native diagnostics. Never mutates the installed original, its
//! ASAR backups, journal or recovery records.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

pub fn log_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA").or_else(|| std::env::var_os("TEMP"))?;
    Some(PathBuf::from(appdata).join("DinoPatchManager").join("native-manager.log"))
}

pub fn write(event: &str) {
    let Some(path) = log_path() else { return; };
    let Ok(_guard) = LOG_LOCK.get_or_init(|| Mutex::new(())).lock() else { return; };
    let Some(parent) = path.parent() else { return; };
    if let Ok(info) = fs::symlink_metadata(parent) {
        if !info.is_dir() || info.file_type().is_symlink() { return; }
    } else if fs::create_dir_all(parent).is_err() {
        return;
    }
    if let Ok(info) = fs::symlink_metadata(&path) {
        if !info.is_file() || info.file_type().is_symlink() { return; }
        if info.len() > MAX_LOG_BYTES {
            // Never truncate or delete evidence; stop writing at the cap.
            return;
        }
    }
    let stamp = chrono::Local::now().to_rfc3339();
    let line = event.replace(['\r', '\n'], " ");
    if let Ok(mut log) = OpenOptions::new().append(true).create(true).open(&path) {
        let _ = writeln!(log, "{stamp} {line}");
        let _ = log.flush();
    }
}

pub fn install_panic_hook() {
    let old = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        let location = panic.location().map(|loc| format!("{}:{}",loc.file(),loc.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let message = panic.payload().downcast_ref::<String>().map(String::as_str)
            .or_else(|| panic.payload().downcast_ref::<&str>().copied())
            .unwrap_or("non-string panic");
        write(&format!("RUST PANIC at {location}: {message}"));
        old(panic);
    }));
}

#[cfg(windows)]
pub fn show_fatal_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let body: Vec<u16> = format!(
        "DinoPatch Rust 관리자에서 오류가 발생했습니다.\n{message}\n\n진단 로그: {}",
        log_path().map(|p|p.display().to_string()).unwrap_or_else(||"확인 불가".into())
    ).encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = "DinoPatch 실행 오류".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { MessageBoxW(std::ptr::null_mut(),body.as_ptr(),title.as_ptr(),0x10); }
}

#[cfg(not(windows))]
pub fn show_fatal_error(message:&str) { eprintln!("{message}"); }
