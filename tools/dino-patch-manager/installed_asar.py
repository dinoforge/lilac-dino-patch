"""Local-only installed LilacAnime ASAR patch target, with structural compatibility checks.

Only the user's installed resources/app.asar is changed. No upstream application
files are bundled or downloaded. The complete original ASAR is backed up first.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
from pathlib import Path
import shutil
import struct
import tempfile
from datetime import datetime, timezone

import manager_core as core

SUPPORTED = {
    "0.5.54": {
        "package.json": "2bbbe987355c4368fb2ebc5dfb68179ebfcbdd4e",
        "src/app.js": "8e5585248546c97c7ca6361f87fcb27eeee4dd59",
        "src/index.html": "bffd50cba743cce1526dce3192c8f9e1757ce4d8",
        "electron/main.cjs": "2e63685580eaa3ed443169da7a0013acb7b91426",
    },
    "0.5.55": {
        "package.json": "398617a206c4a6f5464b5967b8cfa393b2231067",
        "src/app.js": "11ee62df7319fb0a27f0fb6b94a2987d70c401cf",
        "src/index.html": "8cc992ac8a62aaa80d88501df90c8fb50693c2b4",
        "electron/main.cjs": "4f5a6324011a8cfbfce7650b8feb3ada602d6905",
    },
}
MODIFIED = ("src/app.js", "src/index.html")
MAX_HEADER = 32 * 1024 * 1024
MAX_ENTRIES = 50000
MAX_ASAR_BYTES = 1024 * 1024 * 1024


def is_installed_target(root_value) -> bool:
    root = Path(root_value)
    return (root / "LilacAnime.exe").is_file() and (root / "resources" / "app.asar").is_file()


def _root(root_value) -> Path:
    root = core.canonical_path(root_value, strict=True)
    if not root.is_dir() or not is_installed_target(root):
        raise core.ManagerError("공식 LilacAnime 설치 폴더가 아닙니다. LilacAnime.exe와 resources/app.asar가 있는 폴더를 선택하세요.")
    for path in (root, root / "LilacAnime.exe", root / "resources", root / "resources" / "app.asar"):
        if core._is_link_or_junction(path):
            raise core.ManagerError("설치 폴더 경로에 심볼릭 링크 또는 junction이 있어 적용하지 않습니다.")
    if os.name == "nt" and (not root.drive or str(root).startswith("\\\\")):
        raise core.ManagerError("원본은 로컬 드라이브의 실제 설치 폴더여야 합니다.")
    archive = root / "resources" / "app.asar"
    if archive.stat().st_size > MAX_ASAR_BYTES:
        raise core.ManagerError("설치본 ASAR가 허용 크기를 초과했습니다.")
    return root


def _state_root(root: Path) -> Path:
    base = os.environ.get("APPDATA") or os.environ.get("DINO_MANAGER_TEST_PROFILE_ROOT")
    if not base:
        raise core.ManagerError("사용자 APPDATA 경로가 없어 백업 위치를 확인하지 못했습니다.")
    appdata = core.canonical_path(base, strict=True)
    if core._is_link_or_junction(appdata):
        raise core.ManagerError("사용자 백업 경로가 링크여서 안전하게 사용하지 못합니다.")
    name = hashlib.sha256(os.path.normcase(str(root)).encode("utf-8")).hexdigest()[:24]
    return appdata / "DinoPatchManager" / "installed-asar" / name


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def _node(header: dict, relative: str):
    current = header
    parts = relative.split("/")
    for part in parts:
        if not isinstance(current.get("files"), dict) or part not in current["files"]:
            raise core.CompatibilityBlocked(f"설치본 ASAR의 필수 파일이 없습니다: {relative}", "UNSUPPORTED")
        current = current["files"][part]
    if not isinstance(current, dict):
        raise core.CompatibilityBlocked(f"설치본 ASAR 항목 형식이 잘못됐습니다: {relative}", "UNSUPPORTED")
    return current


class Archive:
    def __init__(self, path: Path):
        self.path = path
        self.size = path.stat().st_size
        if self.size > MAX_ASAR_BYTES:
            raise core.ManagerError("ASAR 크기가 허용 범위를 넘습니다.")
        with path.open("rb") as f:
            size_pickle = f.read(8)
            if len(size_pickle) != 8 or struct.unpack_from("<I", size_pickle, 0)[0] != 4:
                raise core.CompatibilityBlocked("Electron ASAR 크기 헤더가 올바르지 않습니다.", "UNSUPPORTED")
            size = struct.unpack_from("<I", size_pickle, 4)[0]
            if size < 12 or size > MAX_HEADER or 8 + size > self.size:
                raise core.CompatibilityBlocked("Electron ASAR 메타데이터 크기가 잘못됐습니다.", "UNSUPPORTED")
            buf = f.read(size)
        if len(buf) != size:
            raise core.CompatibilityBlocked("Electron ASAR 메타데이터가 잘렸습니다.", "UNSUPPORTED")
        string_length = struct.unpack_from("<I", buf, 4)[0]
        if string_length > size - 8 or struct.unpack_from("<I", buf, 0)[0] < string_length + 4:
            raise core.CompatibilityBlocked("Electron ASAR Pickle 문자열 길이가 잘못됐습니다.", "UNSUPPORTED")
        try:
            self.header = json.loads(buf[8:8 + string_length].decode("utf-8"))
        except (UnicodeError, ValueError) as exc:
            raise core.CompatibilityBlocked("ASAR 파일 목록을 읽을 수 없습니다.", "UNSUPPORTED") from exc
        if not isinstance(self.header, dict) or not isinstance(self.header.get("files"), dict):
            raise core.CompatibilityBlocked("ASAR 파일 목록 구조가 올바르지 않습니다.", "UNSUPPORTED")
        self.data_offset = 8 + size
        self.files = {}
        def visit(directory: dict, prefix: str = ""):
            if len(self.files) > MAX_ENTRIES:
                raise core.CompatibilityBlocked("ASAR 파일 수가 안전 제한을 초과했습니다.", "UNSUPPORTED")
            for name, entry in directory["files"].items():
                if not isinstance(name, str) or not name or name in (".", "..") or "/" in name or "\\" in name:
                    raise core.CompatibilityBlocked("ASAR 파일명에 유효하지 않은 경로가 포함됩니다.", "UNSUPPORTED")
                relative = f"{prefix}{name}"
                if isinstance(entry, dict) and isinstance(entry.get("files"), dict):
                    visit(entry, relative + "/")
                elif isinstance(entry, dict):
                    if entry.get("link"):
                        continue
                    if not isinstance(entry.get("size"), int) or entry["size"] < 0:
                        raise core.CompatibilityBlocked(f"ASAR 크기 정보 오류: {relative}", "UNSUPPORTED")
                    if entry.get("unpacked"):
                        continue  # Keep .asar.unpacked files exactly where the installer placed them.
                    try:
                        offset = int(entry["offset"])
                    except (ValueError, TypeError, KeyError) as exc:
                        raise core.CompatibilityBlocked(f"ASAR 오프셋 오류: {relative}", "UNSUPPORTED") from exc
                    if offset < 0 or self.data_offset + offset + entry["size"] > self.size:
                        raise core.CompatibilityBlocked(f"ASAR 파일 범위 오류: {relative}", "UNSUPPORTED")
                    self.files[relative] = (offset, entry["size"])
                else:
                    raise core.CompatibilityBlocked("ASAR 파일 구조가 올바르지 않습니다.", "UNSUPPORTED")
        visit(self.header)

    def read(self, relative: str) -> bytes:
        if relative not in self.files:
            raise core.CompatibilityBlocked(f"ASAR 필수 파일을 읽을 수 없습니다: {relative}", "UNSUPPORTED")
        offset, size = self.files[relative]
        with self.path.open("rb") as f:
            f.seek(self.data_offset + offset)
            data = f.read(size)
        if len(data) != size:
            raise core.CompatibilityBlocked("설치본 ASAR 파일을 완전히 읽지 못했습니다.", "UNSUPPORTED")
        return data

    def write_modified(self, output: Path, replacements: dict[str, bytes]) -> None:
        header = copy.deepcopy(self.header)
        for relative in replacements:
            if relative in self.files and _node(header, relative).get("unpacked"):
                raise core.ManagerError("ASAR의 외부 언팩 파일은 수정할 수 없습니다.")
        for relative in replacements:
            parts = relative.split("/")
            entry = header
            for part in parts[:-1]:
                entry = entry.setdefault("files", {}).setdefault(part, {"files": {}})
            if relative not in self.files and parts[-1] in entry["files"]:
                raise core.CompatibilityBlocked(f"기존 ASAR 항목과 패치 파일이 충돌합니다: {relative}", "CONFLICT")
            entry["files"][parts[-1]] = dict(entry["files"].get(parts[-1], {}))
            if relative in self.files:
                if "integrity" in entry["files"][parts[-1]]:
                    data = replacements[relative]
                    block_size = 4 * 1024 * 1024
                    entry["files"][parts[-1]]["integrity"] = {
                        "algorithm": "SHA256", "hash": hashlib.sha256(data).hexdigest(),
                        "blockSize": block_size,
                        "blocks": [hashlib.sha256(data[i:i + block_size]).hexdigest() for i in range(0, len(data), block_size)] or [hashlib.sha256(b"").hexdigest()],
                    }
        ordered = []
        offset = 0
        def assign(directory, prefix=""):
            nonlocal offset
            for name, entry in directory["files"].items():
                relative = prefix + name
                if "files" in entry:
                    assign(entry, relative + "/")
                elif entry.get("link") or entry.get("unpacked"):
                    continue
                else:
                    size = len(replacements[relative]) if relative in replacements else self.files[relative][1]
                    entry["offset"] = str(offset)
                    entry["size"] = size
                    ordered.append(relative)
                    offset += size
        assign(header)
        serial = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # The Pickle payload includes alignment padding after its string value.
        # Electron rejects non-aligned JSON headers if this length omits padding.
        padding = (-len(serial)) % 4
        payload_size = 4 + len(serial) + padding
        pickle = struct.pack("<II", payload_size, len(serial)) + serial + (b"\0" * padding)
        size_pickle = struct.pack("<II", 4, len(pickle))
        with output.open("xb") as out, self.path.open("rb") as original:
            out.write(size_pickle)
            out.write(pickle)
            for relative in ordered:
                if relative in replacements:
                    out.write(replacements[relative])
                else:
                    start, length = self.files[relative]
                    original.seek(self.data_offset + start)
                    while length:
                        data = original.read(min(1024 * 1024, length))
                        if not data:
                            raise core.ManagerError("원본 ASAR 복사 중 파일이 잘렸습니다.")
                        out.write(data)
                        length -= len(data)
            out.flush()
            os.fsync(out.fileno())
        verify = Archive(output)
        for relative, data in replacements.items():
            if verify.read(relative) != data:
                raise core.ManagerError(f"ASAR 패치 결과 재검증 실패: {relative}")
        if set(verify.files) != set(self.files) | (set(replacements) - set(self.files)):
            raise core.ManagerError("ASAR 재패키징에서 예상하지 못한 파일 변경이 있습니다.")


def _version(asar: Archive) -> str:
    try:
        package = json.loads(asar.read("package.json").decode("utf-8"))
    except (UnicodeError, ValueError) as exc:
        raise core.CompatibilityBlocked("설치본 package.json 내부를 확인할 수 없습니다.", "UNSUPPORTED") from exc
    if not isinstance(package, dict):
        raise core.CompatibilityBlocked("설치본 앱 정보 형식이 올바르지 않습니다.", "UNSUPPORTED")
    build = package.get("build") if isinstance(package.get("build"), dict) else {}
    if package.get("name") != "lilacanime-desktop" and build.get("appId") != "com.lilac.anime.desktop":
        raise core.CompatibilityBlocked("설치본 앱 식별 정보가 공식 LilacAnime와 다릅니다.", "UNSUPPORTED")
    return str(package.get("version", ""))


def _identity(asar: Archive, version: str) -> None:
    expected = SUPPORTED.get(version)
    if not expected:
        raise core.CompatibilityBlocked(f"설치본 v{version}은 아직 검증된 패치 대상이 아닙니다.", "UNSUPPORTED")
    for relative, sha in expected.items():
        if relative == "package.json":
            # electron-builder can sanitize package.json when packaging.
            # The real code files below remain pinned to the official tag.
            continue
        data = asar.read(relative)
        crlf = data.count(bytes([13, 10]))
        lf = data.count(bytes([10]))
        if crlf not in (0, lf):
            raise core.CompatibilityBlocked(
                f"설치본 {relative}에 혼합 줄바꿈이 있어 변경을 중단했습니다.", "CONFLICT"
            )
        normalized = data.replace(bytes([13, 10]), bytes([10]))
        if core._git_blob_sha1(normalized) != sha:
            raise core.CompatibilityBlocked(
                f"설치본 {relative}이 공식 v{version} 지문과 달라 변경하지 않았습니다.", "CONFLICT"
            )


def _manifest(asar: Archive, version: str):
    """Resolve an installed target by code contracts, not a fixed version allowlist.

    Known releases retain their exact identity pin. Other versions must pass all
    connection anchors plus the official IPC/search/detail/playback structural
    contracts before any installed ASAR is changed.
    """
    patch_root, manifest = core.load_manifest(core.patch_source_root(), version)
    if manifest.get("_profilePinned"):
        _identity(asar, version)
        manifest["compatibilityMode"] = "PINNED"
        manifest["sourceIdentityVerified"] = True
        return patch_root, manifest

    if not __import__("re").fullmatch(r"\d+\.\d+\.\d+", version):
        raise core.CompatibilityBlocked("공식 앱 버전 형식이 올바르지 않습니다.", "UNSUPPORTED")

    required = (
        "src/app.js", "src/index.html", "src/player.js",
        "electron/main.cjs", "electron/preload.cjs",
    )
    content = {}
    for relative in required:
        data = asar.read(relative)
        if len(data) > 12 * 1024 * 1024 or b"\x00" in data:
            raise core.CompatibilityBlocked(f"설치본 필수 코드 파일이 검증 범위를 벗어납니다: {relative}", "UNSUPPORTED")
        crlf, lf = data.count(b"\r\n"), data.count(b"\n")
        if crlf not in (0, lf):
            raise core.CompatibilityBlocked(f"설치본 {relative}의 줄바꿈이 혼합되어 있습니다.", "CONFLICT")
        content[relative] = data.replace(b"\r\n", b"\n")

    try:
        connections = core._select_structural_connections(manifest, content)
        with tempfile.TemporaryDirectory(prefix="dino-installed-contract-") as folder:
            root = Path(folder)
            for relative, data in content.items():
                output = root / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(data)
            evidence = core._verify_structural_official_contracts(root, manifest)
    except core.CompatibilityBlocked:
        raise
    except (core.ManagerError, UnicodeError, ValueError) as exc:
        raise core.CompatibilityBlocked(
            f"설치본 v{version}의 필수 검색·상세·재생 호출 계약을 검증하지 못했습니다: {exc}",
            "UNSUPPORTED",
        ) from exc

    manifest["connections"] = connections
    manifest["compatibilityMode"] = "STRUCTURAL"
    manifest["sourceIdentityVerified"] = False  # Contract match is not proof of source provenance.
    manifest["runtimePlaybackVerified"] = False
    manifest["_sourceContractEvidence"] = evidence
    return patch_root, manifest


def _state(root: Path):
    location = _state_root(root) / "state.json"
    if not location.is_file():
        return None
    try:
        state = json.loads(location.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise core.CompatibilityBlocked("설치본 패치 상태 기록을 읽지 못했습니다.", "PARTIAL_OR_UNKNOWN") from exc
    if not isinstance(state, dict) or state.get("target") != str(root):
        raise core.CompatibilityBlocked("설치본 패치 상태 기록이 선택한 폴더와 다릅니다.", "PARTIAL_OR_UNKNOWN")
    return state


def inspect(root_value):
    root = _root(root_value)
    archive_path = root / "resources" / "app.asar"
    asar = Archive(archive_path)
    version = _version(asar)
    result = {"path": str(root), "version": version, "patchVersion": core.PATCH_VERSION, "targetKind": "INSTALLED_ASAR"}
    state = _state(root)
    if (_state_root(root) / "pending.json").is_file():
        return {**result, "status": "PARTIAL_OR_UNKNOWN",
                "reason": "이전 설치본 패치 작업의 복구 기록이 있습니다. 백업 확인 전 파일을 변경하지 않습니다."}
    actual_sha = _sha(archive_path)
    if state:
        if state.get("version") != version or state.get("patchVersion") != core.PATCH_VERSION:
            return {**result, "status": "PARTIAL_OR_UNKNOWN", "reason": "설치본 버전 또는 패치 상태 기록이 현재 프로그램과 다릅니다."}
        if state.get("status") == "APPLIED":
            if state.get("patchedSha256") != actual_sha:
                return {**result, "status": "CONFLICT", "reason": "패치된 app.asar 지문이 기록과 달라 변경을 중단했습니다."}
            backup = _state_root(root) / "original-app.asar"
            if not backup.is_file() or _sha(backup) != state.get("originalSha256"):
                return {**result, "status": "PARTIAL_OR_UNKNOWN", "reason": "원본 app.asar 백업을 검증할 수 없습니다."}
            return {**result, "status": "APPLIED", "backupId": state.get("backupId"), "runtimePlaybackVerified": False}
        if state.get("status") == "UNPATCHED":
            if actual_sha != state.get("originalSha256"):
                return {**result, "status": "CONFLICT", "reason": "패치 해제 후 설치본이 변경되었습니다."}
    if any(relative in asar.files for relative in core.EXPECTED_MODULES):
        return {**result, "status": "PARTIAL_OR_UNKNOWN", "reason": "이미 설치된 패치 모듈이 있지만 검증된 상태 기록은 없습니다."}
    try:
        _patch_root, matched_manifest = _manifest(asar, version)
    except core.CompatibilityBlocked as exc:
        return {**result, "status": exc.status, "reason": str(exc), "sourceIdentityVerified": False}
    return {
        **result, "status": "UNPATCHED",
        "compatibilityMode": matched_manifest.get("compatibilityMode", "PINNED"),
        "sourceIdentityVerified": bool(matched_manifest.get("sourceIdentityVerified", False)),
        "runtimePlaybackVerified": False,
    }


def _replacement_bytes(asar: Archive, manifest: dict, patch_root: Path):
    replacements = {}
    for relative in MODIFIED:
        replacements[relative] = asar.read(relative)
    for connection in manifest["connections"]:
        relative = connection["file"]
        data = replacements[relative]
        windows_eol = data.count(bytes([13, 10])) > 0 and data.count(bytes([13, 10])) == data.count(bytes([10]))
        before = connection["before"]
        after = connection["after"]
        if windows_eol:
            before = before.replace(chr(10), chr(13) + chr(10))
            after = after.replace(chr(10), chr(13) + chr(10))
        replacements[relative] = core._replace_exactly(
            data, before, after, connection["description"]
        )
    for module in manifest["runtimeModules"]:
        relative = module["destination"]
        if relative in asar.files:
            raise core.CompatibilityBlocked(f"설치본에 패치 모듈이 이미 있습니다: {relative}", "CONFLICT")
        source = core._module_path(patch_root, module["source"])
        if core._sha256_file(source) != module["sha256"].upper():
            raise core.ManagerError(f"패치 모듈 검증 실패: {module['source']}")
        replacements[relative] = source.read_bytes()
    for relative in MODIFIED:
        if replacements[relative] == asar.read(relative):
            raise core.ManagerError(f"설치본 연결 변경이 누락됐습니다: {relative}")
    return replacements


def _atomic_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".writing")
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def _ensure_installed_app_stopped(root: Path) -> None:
    if os.name != "nt":
        return
    powershell = (
        "$ErrorActionPreference='Stop';"
        "$exe=[IO.Path]::GetFullPath($env:DINO_INSTALLED_EXE);"
        "$hits=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {"
        "($_.Name -ieq 'LilacAnime.exe') -or "
        "($_.Name -ieq 'electron.exe' -and $_.CommandLine -and "
        "$_.CommandLine.Contains($env:DINO_INSTALLED_ROOT))"
        "});"
        "if($hits.Count -gt 0){$hits | ForEach-Object { '{0}:{1}' -f $_.Name,$_.ProcessId }}"
    )
    env = os.environ.copy()
    env["DINO_INSTALLED_EXE"] = str(root / "LilacAnime.exe")
    env["DINO_INSTALLED_ROOT"] = str(root)
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", powershell],
            env=env, text=True, encoding="utf-8", capture_output=True, timeout=10,
            **core._hidden_subprocess_options(),
        )
    except Exception as exc:
        raise core.ManagerError("LilacAnime 실행 여부를 확인할 수 없어 설치본 변경을 중단했습니다.") from exc
    if result.returncode:
        raise core.ManagerError("Windows 프로세스 조회가 실패해 설치본 변경을 중단했습니다.")
    if result.stdout.strip():
        raise core.ManagerError("LilacAnime가 실행 중입니다. 앱을 완전히 종료한 뒤 다시 검사하세요.")


def _preflight_patch(replacements: dict[str, bytes], manifest: dict):
    with tempfile.TemporaryDirectory(prefix="dino-installed-preflight-") as folder:
        source = Path(folder)
        for relative, data in replacements.items():
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        core._verify_patched_contracts(source, manifest)
        node = core._node_executable()
        if not node:
            raise core.ManagerError("내장 JavaScript 검사기가 없어 설치본 자동 패치를 중단했습니다.")
        for relative in ("src/app.js", "src/integrated-search.js", "src/patch03-bridge.js"):
            command = [node, "--check", relative]
            result = subprocess.run(
                command, cwd=source, env=core._node_subprocess_environment(),
                capture_output=True, text=True, encoding="utf-8", timeout=60,
                **core._hidden_subprocess_options(),
            )
            if result.returncode:
                raise core.ManagerError(f"설치본 {relative} 사전 구문 검사 실패: {result.stderr[-300:]}")


def _apply(root: Path, *, process_check):
    result = inspect(root)
    if result["status"] == "APPLIED":
        return {**result, "status": "ALREADY_APPLIED"}
    if result["status"] != "UNPATCHED":
        return result
    if process_check is core.assert_app_not_running:
        _ensure_installed_app_stopped(root)
    else:
        process_check(root)
    archive_path = root / "resources" / "app.asar"
    original_sha = _sha(archive_path)
    asar = Archive(archive_path)
    version = _version(asar)
    patch_root, manifest = _manifest(asar, version)
    replacements = _replacement_bytes(asar, manifest, patch_root)
    _preflight_patch(replacements, manifest)
    data_root = _state_root(root)
    if data_root.exists() and core._is_link_or_junction(data_root):
        raise core.ManagerError("설치본 백업 폴더에 링크가 있어 변경하지 않았습니다.")
    data_root.mkdir(parents=True, exist_ok=True)
    backup = data_root / "original-app.asar"
    if backup.exists():
        if _sha(backup) != original_sha:
            raise core.ManagerError("기존 백업이 현재 설치본과 달라 자동 덮어쓰기를 중단했습니다.")
    else:
        with backup.open("xb") as out, archive_path.open("rb") as src:
            shutil.copyfileobj(src, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        if _sha(backup) != original_sha:
            raise core.ManagerError("설치본 원본 백업 검증이 실패했습니다.")
    temp_path = archive_path.with_name("app.asar.dino-writing")
    if temp_path.exists():
        raise core.ManagerError("이전 임시 패치 파일이 있어 안전하게 중단했습니다.")
    try:
        asar.write_modified(temp_path, replacements)
        if _sha(archive_path) != original_sha:
            raise core.ManagerError("패치 준비 중 공식 app.asar가 바뀌었습니다.")
        new_sha = _sha(temp_path)
        backup_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        state = {
            "schemaVersion": 1, "target": str(root), "version": version,
            "patchVersion": core.PATCH_VERSION, "status": "APPLIED",
            "originalSha256": original_sha, "patchedSha256": new_sha,
            "backupId": backup_id, "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        # Keep recovery evidence even if the replace succeeds but final metadata fails.
        _atomic_json(data_root / "pending.json", state)
        os.replace(temp_path, archive_path)
        _atomic_json(data_root / "state.json", state)
        (data_root / "pending.json").unlink()
        return {**inspect(root), "backupId": backup_id}
    finally:
        if temp_path.exists():
            temp_path.unlink()


def startup(root_value, *, process_check=core.assert_app_not_running):
    root = _root(root_value)
    try:
        return _apply(root, process_check=process_check)
    except PermissionError as exc:
        raise core.ManagerError("설치 폴더 쓰기 권한이 없습니다. 설치 경로 권한을 확인해 주세요. 원본 백업은 보존했습니다.") from exc


def uninstall(root_value, *, process_check=core.assert_app_not_running):
    root = _root(root_value)
    inspected = inspect(root)
    if inspected["status"] == "UNPATCHED":
        return {**inspected, "status": "ALREADY_UNPATCHED"}
    if inspected["status"] != "APPLIED":
        raise core.ManagerError(inspected.get("reason") or "설치본 패치 상태가 안전하지 않아 복원하지 않았습니다.")
    if process_check is core.assert_app_not_running:
        _ensure_installed_app_stopped(root)
    else:
        process_check(root)
    data_root = _state_root(root)
    state = _state(root)
    source = data_root / "original-app.asar"
    archive = root / "resources" / "app.asar"
    if not state or _sha(archive) != state["patchedSha256"] or _sha(source) != state["originalSha256"]:
        raise core.ManagerError("설치본 ASAR 백업/패치 지문 검증 실패: 원본을 변경하지 않았습니다.")
    temp = archive.with_name("app.asar.dino-restore")
    if temp.exists():
        raise core.ManagerError("이전 복원 임시 파일이 존재해 안전하게 중단했습니다.")
    try:
        with temp.open("xb") as out, source.open("rb") as src:
            shutil.copyfileobj(src, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        if _sha(temp) != state["originalSha256"]:
            raise core.ManagerError("복원본 ASAR 지문이 맞지 않습니다.")
        os.replace(temp, archive)
        _atomic_json(data_root / "state.json", {**state, "status": "UNPATCHED"})
        return {"status": "UNPATCHED", "path": str(root), "version": state["version"], "manualUninstall": True}
    finally:
        if temp.exists():
            temp.unlink()


def backups(root_value):
    root = _root(root_value)
    state = _state(root)
    if state and (_state_root(root) / "original-app.asar").is_file():
        return {"items": [{
            "id": state.get("backupId", ""), "restorable": state.get("status") == "APPLIED",
            "createdAt": state.get("createdAt", ""), "version": state.get("version", "")
        }]}
    return {"items": []}


def history(root_value):
    _root(root_value)
    return {"items": []}
