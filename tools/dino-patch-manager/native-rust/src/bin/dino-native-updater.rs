//! Shipping companion updater. It accepts only recovery or a nonce-bound
//! user-approved request located under its own fixed installation directory.

#[path = "../release_update.rs"]
mod release_update;
#[path = "../updater_engine.rs"]
mod updater_engine;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match updater_engine::run_production(&args) {
        Ok(message) => {
            println!("{message}");
        }
        Err(error) => {
            eprintln!("BLOCKED: {error}");
            show_error(&error);
            std::process::exit(2);
        }
    }
}

#[cfg(windows)]
fn show_error(message: &str) {
    use std::iter;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let body: Vec<u16> = message.encode_utf16().chain(iter::once(0)).collect();
    let title: Vec<u16> = "DinoPatch 업데이트".encode_utf16().chain(iter::once(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_error(_message: &str) {}
