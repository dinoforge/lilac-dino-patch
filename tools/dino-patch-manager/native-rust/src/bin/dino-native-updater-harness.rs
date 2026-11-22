//! Development-only Windows updater transaction harness.
//! The Cargo feature gates this binary out of normal product builds.

#![cfg_attr(windows, windows_subsystem = "console")]

#[path = "../release_update.rs"]
mod release_update;
#[path = "../updater_engine.rs"]
mod updater_engine;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--self-test"] {
        match updater_engine::run_local_self_tests() {
            Ok(summary) => println!("{summary}"),
            Err(error) => {
                eprintln!("SELF-TEST FAILED: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if let Some(result) = updater_engine::dispatch_test_harness(&args) {
        if let Err(error) = result {
            eprintln!("TEST PROBE FAILED: {error}");
            std::process::exit(1);
        }
        return;
    }
    eprintln!("Usage: dino-native-updater-harness --self-test");
    std::process::exit(2);
}
