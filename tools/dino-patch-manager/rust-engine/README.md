# DinoPatch Rust ASAR inspector (migration stage 1)

This directory contains a read-only Rust verifier for an **already installed** official LilacAnime application.

It inspects the local installed root passed as the only argument, requiring a regular `LilacAnime.exe`, `resources` directory, and `resources/app.asar` file. It validates the ASAR header and file bounds, required application files, product identity, version and SHA-256. It does not download, copy, rewrite, patch, restore, delete or move any original application file. It reports `ARCHIVE_VALID` only as a structural inspection result, not as permission to apply a patch.

Build and test from this directory using `cargo test --all-targets` and `cargo build --release`. Run `dino-asar-inspect.exe "D:\\LilacAnime"` on Windows. The result is a single JSON object; an invalid archive or unsupported layout exits non-zero with a `BLOCKED` result.

**Not a replacement for the released engine yet.** Beta 7 continues to use the established Python transactional patcher for compatibility verification, backups, pending recovery, safe write and byte-exact restore. The Rust verifier does not override those checks, never forces a manual apply and is not included in the Beta 7 Windows ZIP. Production integration and write operations must wait for parity tests on official Windows installers and on interrupted recovery states.

The GitHub Actions verifier uses a temporary copy of the official v0.5.64 Linux package's ASAR to validate parsing of genuine upstream bytes. That is *not* a full Windows installation test; no original LilacAnime executable or source archive is redistributed with the DinoPatch release.

Existing user data, `DinoPatchManager/runtime`, and `%APPDATA%\DinoPatchManager\installed-asar` backups and pending records must remain untouched during upgrades.
