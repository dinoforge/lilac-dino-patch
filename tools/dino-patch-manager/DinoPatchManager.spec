# -*- mode: python ; coding: utf-8 -*-
import os
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

manager_dir = Path(SPECPATH).resolve()
project_root = manager_dir.parents[1]


def collect_python_tk_library(zip_name: str, archive_root: str, bundle_root: str) -> list[tuple[str, str]]:
    """Stage Tcl/Tk 9 library scripts from Python's zipfs archives for PyInstaller."""
    build_temp_raw = os.environ.get("DINO_MANAGER_BUILD_TEMP")
    if not build_temp_raw:
        raise RuntimeError("DINO_MANAGER_BUILD_TEMP must point to this build's OS Temp directory.")

    build_temp = Path(build_temp_raw).resolve(strict=True)
    os_temp = Path(tempfile.gettempdir()).resolve(strict=True)
    if build_temp == os_temp or not build_temp.is_relative_to(os_temp):
        raise RuntimeError(f"Unsafe Tcl/Tk staging root; expected a child of OS Temp: {build_temp}")
    if build_temp.is_symlink() or not build_temp.is_dir():
        raise RuntimeError(f"Tcl/Tk staging root is not a regular directory: {build_temp}")

    python_tcl_root = Path(sys.base_prefix).resolve(strict=True) / "tcl"
    archives = list(python_tcl_root.glob(zip_name))
    if len(archives) != 1 or not archives[0].is_file():
        raise RuntimeError(f"Expected exactly one Python Tcl/Tk archive matching {zip_name!r} under {python_tcl_root}")

    stage_root = build_temp / "tk-runtime" / bundle_root
    if stage_root.exists():
        raise RuntimeError(f"Refusing to reuse existing Tcl/Tk staging directory: {stage_root}")
    stage_root.mkdir(parents=True, exist_ok=False)

    with zipfile.ZipFile(archives[0]) as archive:
        for item in archive.infolist():
            member = PurePosixPath(item.filename)
            if member.is_absolute() or ".." in member.parts or not member.parts or member.parts[0] != archive_root:
                raise RuntimeError(f"Unexpected path in Python Tcl/Tk archive {archives[0].name}: {item.filename!r}")
            if item.is_dir():
                continue
            if stat.S_ISLNK(item.external_attr >> 16):
                raise RuntimeError(f"Symbolic link is not allowed in Python Tcl/Tk archive: {item.filename!r}")
            relative = Path(*member.parts[1:])
            if not relative.parts:
                raise RuntimeError(f"Unexpected root file in Python Tcl/Tk archive: {item.filename!r}")
            destination = stage_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            resolved_destination = destination.resolve()
            if not resolved_destination.is_relative_to(stage_root.resolve()):
                raise RuntimeError(f"Tcl/Tk archive member escaped its staging root: {item.filename!r}")
            destination.write_bytes(archive.read(item))

    if not any(stage_root.rglob("*.tcl")):
        raise RuntimeError(f"The Python archive did not provide Tcl scripts for {bundle_root}.")
    return [
        (str(file_path), (Path(bundle_root) / file_path.relative_to(stage_root).parent).as_posix())
        for file_path in stage_root.rglob("*")
        if file_path.is_file()
    ]

datas = [
    (str(project_root / "patches" / "patch03" / "manifest.json"), "patches/patch03"),
    (str(project_root / "src" / "integrated-search.js"), "src"),
    (str(project_root / "src" / "integrated-search.css"), "src"),
    (str(project_root / "patches" / "patch03" / "patch03-bridge.js"), "patches/patch03"),
    (str(project_root / "scripts" / "validate-patch03-clean-source.cjs"), "scripts"),
    (str(project_root / "tests" / "patch03-clean-source.contract.test.cjs"), "tests"),
    (str(manager_dir / "README.md"), "."),
]
datas += collect_python_tk_library("libtcl*.zip", "tcl_library", "_tcl_data")
datas += collect_python_tk_library("libtk*.zip", "tk_library", "_tk_data")

a = Analysis(
    [str(manager_dir / "manager_gui.py")],
    pathex=[str(manager_dir)],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="디노패치관리자",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="DinoPatchManager",
)
