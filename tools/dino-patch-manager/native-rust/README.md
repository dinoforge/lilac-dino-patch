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

Official app release numbers are **not an allowlist**. Any new LilacAnime version whose ASAR identity, required modules, seven exact single-occurrence connection anchors and runtime payload manifest checks pass can be patched. An incompatible or already-patched ASAR still blocks writes. After the official updater replaces an older version, the previous generation's state and backup are retained unchanged; a new version receives an independent SHA-256-verified backup. A previous user-initiated uninstall still requires manual application. An existing APPDATA backup and runtime folder must not be removed. The original LilacAnime executable and ASAR are never bundled.

This is an experimental branch, NOT an official Beta 8 release. Old source-checkout patching, native LevelDB theme handling, advanced update metadata and some legacy history functions still need parity work. Do not replace a working Beta 7 until all native Windows safety and GUI tests pass.