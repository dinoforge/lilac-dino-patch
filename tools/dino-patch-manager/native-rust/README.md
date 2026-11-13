# DinoPatch native Rust migration (experimental)

A standalone Rust manager for an **existing** official LilacAnime installation. This replaces the manager's Python, Node.js and Electron runtimes. The original LilacAnime desktop app is not redistributed. The integration payload remains JavaScript only because the upstream Electron app loads JavaScript.

Native modules:
- src/asar.rs: strict ASAR parsing, controlled repacking and payload verification
- src/transaction.rs: original identity, backup, pending transactions, apply/uninstall, recovery
- src/gui.rs: Rust egui desktop window, manual control, source monitoring, diagnostics
- src/main.rs: portable JSON CLI and native GUI entrypoint

Windows GUI build (no CMD/console window): cargo build --release --features gui
CLI-only build (JSON stdout, console): cargo build --release --no-default-features
Test: cargo test --no-default-features

On Windows, launch the GUI-enabled `dino-native-manager.exe` directly. It uses
the Windows GUI subsystem, so a black console window is not allocated. The
GUI runs file validation and patch transactions in Rust worker threads rather
than launching cmd.exe/PowerShell. For a true command-line executable, build
without the `gui` feature as shown above. GUI startup failures are reported
through a Windows dialog and the persistent `native-manager.log` diagnostics.

The Windows release workflow checks the built PE header's subsystem field:
`2` (Windows GUI) is required; `3` (Console) is rejected.
A source-only test is not a substitute for a real Windows startup check.
CLI inspection: dino-native-manager.exe inspect "D:\LilacAnime"
Manual patch: dino-native-manager.exe apply "D:\LilacAnime"
Uninstall: dino-native-manager.exe uninstall "D:\LilacAnime"
Pending review: dino-native-manager.exe review "D:\LilacAnime"

Only reviewed official 0.5.54, 0.5.55, 0.5.63 and 0.5.64 source fingerprints permit writes. A damaged or missing ASAR, mismatch, pending work, or invalid backup blocks modifications. Manual patch does not bypass safety checks. An existing APPDATA backup and runtime folder must not be removed. The official LilacAnime executable and original ASAR are never included in DinoPatch's distribution.

This is an experimental branch, NOT an official Beta 8 release. Old source-checkout patching, native LevelDB theme handling, advanced update metadata and some legacy history functions still need parity work. Do not replace a working Beta 7 until all native Windows safety and GUI tests pass.