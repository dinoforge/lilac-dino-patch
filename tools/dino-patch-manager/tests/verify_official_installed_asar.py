"""Verify exact official installed ASAR, patch and byte-identical restore.

Usage: python verify_official_installed_asar.py path/to/app.asar 0.5.54
Copies only into a disposable private temp folder; never edits the download.
"""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import installed_asar

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit("asar path, version and optional patched-output path required")
    original = Path(sys.argv[1]).resolve(strict=True)
    version = sys.argv[2]
    import re
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("Official semantic version is required")
    with tempfile.TemporaryDirectory(prefix="dino-genuine-asar-") as td:
        base = Path(td)
        install = base / "LilacAnime"
        (install / "resources").mkdir(parents=True)
        (install / "LilacAnime.exe").write_bytes(b"isolated test marker")
        copied = install / "resources" / "app.asar"
        shutil.copyfile(original, copied)
        (base / "AppData").mkdir()
        os.environ["APPDATA"] = str(base / "AppData")
        before = digest(copied)
        detected = installed_asar.inspect(install)
        if detected["status"] != "UNPATCHED" or detected["version"] != version:
            if version in installed_asar.SUPPORTED:
                import manager_core as core
                archive = installed_asar.Archive(copied)
                for name, expected in installed_asar.SUPPORTED[version].items():
                    data = archive.read(name)
                    normalized = data.replace(bytes([13, 10]), bytes([10]))
                    print(f"File {name}: raw={core._git_blob_sha1(data)} normalized={core._git_blob_sha1(normalized)} expected={expected}", flush=True)
            raise AssertionError(f"v{version} official ASAR failed compatibility: {detected}")
        result = installed_asar.startup(install, process_check=lambda _root: None)
        if result["status"] != "APPLIED":
            raise AssertionError(f"v{version} patch failed: {result}")
        after = digest(copied)
        if len(sys.argv) == 4:
            shutil.copyfile(copied, Path(sys.argv[3]))
        if before == after:
            raise AssertionError("ASAR patch made no changes")
        archive = installed_asar.Archive(copied)
        for filename in ("src/integrated-search.js", "src/integrated-search.css", "src/patch03-bridge.js"):
            if filename not in archive.files or not archive.read(filename):
                raise AssertionError(f"missing patched runtime {filename}")
        restored = installed_asar.uninstall(install, process_check=lambda _root: None)
        if restored["status"] != "UNPATCHED" or digest(copied) != before:
            raise AssertionError(f"v{version} ASAR backup did not restore exactly")
        print(f"PASS official v{version}: structural or pinned compatibility, preflight, ASAR repack, backup, restore")

if __name__ == "__main__":
    main()
