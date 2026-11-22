# DinoPatch Rust ASAR inspection and recovery review (migration stage 2)

This directory contains a read-only Rust verifier for an **already installed** official LilacAnime application.

It inspects the local installed root passed as the only argument, requiring a regular `LilacAnime.exe`, `resources` directory, and `resources/app.asar` file. It validates the ASAR header and file bounds, required application files, product identity, version and SHA-256. It does not download, copy, rewrite, patch, restore, delete or move any original application file. It reports `ARCHIVE_VALID` only as a structural inspection result, not as permission to apply a patch.

Build and test from this directory using `cargo test --all-targets` and `cargo build --release`. Run `dino-asar-inspect.exe "D:\\LilacAnime"` on Windows to inspect the original. The result is one JSON object; an invalid archive or unsupported layout exits non-zero with a `BLOCKED` result.

### Read-only interrupted transaction verification

The additional option `dino-asar-inspect.exe --review-recovery "D:\\LilacAnime" "<existing installed-asar state folder>" "1.0.0"` checks the existing `pending.json`, optional `state.json`, and `original-app.asar` backup. The state folder is the *existing*, installation-specific directory under `%APPDATA%\DinoPatchManager\installed-asar\<id>`; do not create or move it. The patch version must match the existing pending record and manifest. A `RECOVERY_VERIFIED` result means that archive and backup hashes match the record and no dangling transaction file was found. It is **not** permission to alter or remove a recovery record or bypass the Python patch engine's process, backup or contract checks.

If there is no pending record, a mismatched target/version/hash, a corrupted backup or an unfinished `app.asar.dino-writing` or `app.asar.dino-restore` file, the inspection fails closed and **does not touch anything**. Tests cover both applied and original states, corrupted SHA and backup, mismatched state, and leftover files.

**Not a replacement for the released engine yet.** Beta 7 continues to use the established Python transactional patcher for compatibility verification, backups, pending recovery, safe write and byte-exact restore. The Rust verifier does not override those checks, never forces a manual apply and is not included in the Beta 7 Windows ZIP. Production integration and write operations must wait for parity tests on official Windows installers and on interrupted recovery states.

The GitHub Actions verifier uses a temporary copy of the official v0.5.64 Linux package's ASAR to validate parsing of genuine upstream bytes. That is *not* a full Windows installation test; no original LilacAnime executable or source archive is redistributed with the DinoPatch release.

Existing user data, `DinoPatchManager/runtime`, and `%APPDATA%\DinoPatchManager\installed-asar` backups and pending records must remain untouched during upgrades.
