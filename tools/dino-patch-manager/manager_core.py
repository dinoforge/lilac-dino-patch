"""Safe, manifest-driven file engine for the Dino patch manager."""

from __future__ import annotations

import difflib
import copy
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.parse import urlparse


PROJECT_ROOT = Path(__file__).resolve().parents[2]
EXPECTED_PROJECT_ROOT = PROJECT_ROOT
IS_FROZEN = bool(getattr(sys, "frozen", False))
_LAST_THEME_DIAGNOSTIC: tuple[str, str] | None = None
MANAGER_VERSION = "1.2.4"
PATCH_VERSION = "1.0.0"
MANAGER_FOLDER_NAME = "DinoPatchManager"
PATCH_STATE_RELATIVE = Path("state") / "patch-state.json"
PATCH_HISTORY_RELATIVE = Path("state") / "operations.jsonl"
MANIFEST_RELATIVE = Path("patches") / "patch03" / "manifest.json"
VALIDATOR_RELATIVE = Path("scripts") / "validate-patch03-clean-source.cjs"
CONTRACT_TEST_RELATIVE = Path("tests") / "patch03-clean-source.contract.test.cjs"
OFFICIAL_SOURCE_NAME = "LilacAnime-desktop-{}"
MAX_ARCHIVE_FILES = 20_000
MAX_ARCHIVE_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024
MAX_GITHUB_METADATA_BYTES = 8 * 1024 * 1024
GITHUB_REPOSITORY = "whispelyn-byte/LilacAnime-desktop"
GITHUB_API_ROOT = f"https://api.github.com/repos/{GITHUB_REPOSITORY}"
EXPECTED_MODULES = {
    "src/integrated-search.js",
    "src/integrated-search.css",
    "src/patch03-bridge.js",
}
EXPECTED_CONNECTION_FILES = {"src/app.js", "src/index.html"}
EXPECTED_PROVIDERS = ["reanime", "miruro", "animenosub", "ohli24", "linkani"]


class ManagerError(RuntimeError):
    """A safe, user-displayable validation or application failure."""


class CompatibilityBlocked(ManagerError):
    """Compatibility failure with a fail-closed UI state."""

    def __init__(self, message: str, status: str = "COMPATIBILITY_UNKNOWN") -> None:
        super().__init__(message)
        self.status = status


def _hidden_subprocess_options() -> dict[str, int]:
    """Keep helper processes from flashing a console over the Windows GUI."""
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _windows_extended_path(value: str | os.PathLike[str], *, force: bool = False) -> Path:
    """Use the Win32 extended-length namespace for long absolute filesystem paths."""
    path = Path(value)
    if os.name != "nt":
        return path
    raw = os.fspath(path)
    if raw.startswith("\\\\?\\"):
        return path
    absolute = os.path.abspath(raw)
    if len(absolute) < 240 and not force:
        return path
    if absolute.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + absolute[2:])
    drive, tail = os.path.splitdrive(absolute)
    if drive and tail.startswith("\\"):
        return Path("\\\\?\\" + absolute)
    return path


def _without_windows_extended_prefix(path: str | os.PathLike[str]) -> str:
    value = os.fspath(path)
    if os.name != "nt":
        return value
    if value.startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[8:]
    if value.startswith("\\\\?\\"):
        return value[4:]
    return value


def _norm(path: Path) -> str:
    value = _without_windows_extended_prefix(path)
    return os.path.normcase(os.path.normpath(value))


def canonical_path(value: str | os.PathLike[str], *, strict: bool = False) -> Path:
    raw = _windows_extended_path(Path(value).expanduser())
    try:
        return raw.resolve(strict=strict)
    except (OSError, RuntimeError) as exc:
        raise ManagerError(f"경로를 실제 위치로 확인할 수 없습니다: {value} ({exc})") from exc


def same_or_within(candidate: Path, parent: Path) -> bool:
    child = canonical_path(candidate)
    base = canonical_path(parent)
    try:
        Path(_without_windows_extended_prefix(child)).relative_to(
            Path(_without_windows_extended_prefix(base))
        )
        return True
    except ValueError:
        return False


def _is_link_or_junction(path: Path) -> bool:
    path = _windows_extended_path(path)
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    try:
        return bool(is_junction and is_junction())
    except OSError:
        return True


def paths_overlap(left: Path, right: Path) -> bool:
    return same_or_within(left, right) or same_or_within(right, left)


def assert_project_root(root: Path = PROJECT_ROOT) -> Path:
    actual = canonical_path(root, strict=True)
    if IS_FROZEN:
        executable_dir = canonical_path(Path(sys.executable).resolve().parent, strict=True)
        deployment_root = canonical_path(executable_dir.parent, strict=True)
        accepted = {_norm(executable_dir), _norm(deployment_root)}
        if _norm(actual) not in accepted:
            raise ManagerError(f"패키지 관리자 경로가 실행 파일 위치와 일치하지 않습니다: {actual}")
    else:
        expected = canonical_path(EXPECTED_PROJECT_ROOT)
        if _norm(actual) != _norm(expected):
            raise ManagerError(f"이 도구는 지정된 개발 프로젝트에서만 실행할 수 있습니다: {actual}")
    return actual


def manager_home() -> Path:
    """Return the directory containing the manager executable or source GUI."""
    if IS_FROZEN:
        return canonical_path(Path(sys.executable).resolve().parent)
    return canonical_path(Path(__file__).resolve().parent)


def patch_source_root() -> Path:
    """Return the root containing patches/patch03 and bundled validation assets."""
    if IS_FROZEN:
        executable_assets = manager_home()
        frozen_assets = getattr(sys, "_MEIPASS", None)
        candidates = [executable_assets, executable_assets / "_internal"]
        if frozen_assets:
            frozen_root = Path(frozen_assets)
            if frozen_root.is_dir():
                frozen_root = canonical_path(frozen_root, strict=True)
                candidates.extend((frozen_root, frozen_root / "_internal"))
        for candidate in candidates:
            if (candidate / MANIFEST_RELATIVE).is_file():
                return canonical_path(candidate, strict=True)
        raise ManagerError("관리자 패키지에 Patch 03 manifest가 없어 읽기 전용 상태 확인을 중단했습니다.")
    return PROJECT_ROOT


def protected_roots(project_root: Path = PROJECT_ROOT) -> list[Path]:
    values = [
        project_root,
        Path(r"D:\LilacAnime"),  # 현재 사용 중인 설치 위치는 읽기/쓰기 대상에서 제외.
    ]
    for key in (
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "WINDIR",
    ):
        value = os.environ.get(key)
        if value:
            values.append(Path(value))
    result: list[Path] = []
    for value in values:
        try:
            resolved = canonical_path(value)
        except ManagerError:
            continue
        if all(_norm(resolved) != _norm(item) for item in result):
            result.append(resolved)
    return result


def _is_unc(path: Path) -> bool:
    return str(path).startswith("\\\\")


def assert_safe_source(path: str | os.PathLike[str], project_root: Path = PROJECT_ROOT) -> tuple[Path, str]:
    source = canonical_path(path, strict=True)
    if paths_overlap(source, project_root):
        raise ManagerError("개발 프로젝트와 겹치는 경로는 원본으로 사용할 수 없습니다.")
    install = canonical_path(Path(r"D:\LilacAnime"))
    if paths_overlap(source, install):
        raise ManagerError("실제 설치 앱과 겹치는 경로는 원본 입력으로 사용할 수 없습니다.")
    if source.is_dir():
        return source, "folder"
    if source.is_file() and source.suffix.lower() in {".zip", ".tar", ".tgz", ".gz"}:
        return source, "archive"
    raise ManagerError("공식 원본은 압축 해제 폴더 또는 ZIP/TAR 아카이브여야 합니다.")


def assert_safe_output(
    output_value: str | os.PathLike[str],
    source: Path,
    source_kind: str,
    project_root: Path = PROJECT_ROOT,
) -> Path:
    output_text = os.fspath(output_value).strip()
    if not output_text:
        raise ManagerError("새 출력 폴더 경로를 입력하세요.")
    raw = Path(output_text).expanduser()
    if raw.is_symlink():
        raise ManagerError("출력 경로 자체가 심볼릭 링크입니다. 실제 새 폴더 경로를 선택하세요.")
    output = canonical_path(raw)
    if not output.is_absolute() or not output.drive or _is_unc(output):
        raise ManagerError("출력은 드라이브가 지정된 로컬 경로여야 합니다. 네트워크 공유는 사용할 수 없습니다.")
    if output.exists():
        raise ManagerError("출력 경로가 이미 있습니다. 기존 파일을 보호하기 위해 덮어쓰지 않습니다.")
    parent = output.parent
    if not parent.exists() or not parent.is_dir():
        raise ManagerError("출력 경로의 상위 폴더가 존재해야 합니다.")
    if paths_overlap(output, project_root):
        raise ManagerError("기존 개발 프로젝트와 같거나 겹치는 출력 경로는 허용되지 않습니다.")
    for protected in protected_roots(project_root):
        if _norm(protected) == _norm(canonical_path(project_root)):
            continue
        if paths_overlap(output, protected):
            raise ManagerError(f"보호 경로와 같거나 겹치는 출력 경로는 허용되지 않습니다: {protected}")
    if source_kind == "folder" and paths_overlap(output, source):
        raise ManagerError("출력 경로가 원본 폴더와 같거나 상위·하위 관계입니다.")
    if source_kind == "archive" and _norm(output) == _norm(source):
        raise ManagerError("출력 경로가 원본 아카이브와 같습니다.")
    return output


def _safe_relative(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ManagerError("manifest에 비어 있거나 잘못된 상대 경로가 있습니다.")
    normalized = value.replace("\\", "/")
    posix = PurePosixPath(normalized)
    if posix.is_absolute() or any(part in {"", ".", ".."} for part in posix.parts) or ":" in posix.parts[0]:
        raise ManagerError(f"manifest 경로가 루트 밖을 가리킵니다: {value}")
    return posix.as_posix()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with _windows_extended_path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def _module_path(root: Path, relative: str) -> Path:
    rel = _safe_relative(relative)
    target = canonical_path(root / Path(*rel.split("/")))
    if not same_or_within(target, root):
        raise ManagerError(f"manifest 경로가 선택한 폴더 밖으로 나갑니다: {relative}")
    return target


def _select_official_source_profile(manifest: dict[str, Any], target_version: str | None) -> dict[str, Any]:
    base = {key: value for key, value in manifest.items() if key != "additionalOfficialSources"}
    if not target_version or str(target_version) == str(base.get("officialVersion")):
        return base
    for profile in manifest.get("additionalOfficialSources", []):
        if isinstance(profile, dict) and str(profile.get("officialVersion")) == str(target_version):
            selected = dict(base)
            selected.update(profile)
            return selected
    # Preserve the existing fail-closed version diagnostic. The base profile
    # will reject an unknown target before any patch file is changed.
    return base


def load_manifest(
    patch_root: str | os.PathLike[str],
    target_version: str | None = None,
) -> tuple[Path, dict[str, Any]]:
    root = canonical_path(patch_root, strict=True)
    if not root.is_dir():
        raise ManagerError("패치 구성 경로는 폴더여야 합니다.")
    manifest_path = root / MANIFEST_RELATIVE
    if not manifest_path.is_file():
        raise ManagerError(f"패치 manifest를 찾을 수 없습니다: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagerError(f"manifest를 읽을 수 없습니다: {exc}") from exc
    validate_manifest(manifest)
    manifest = _select_official_source_profile(manifest, target_version)
    validate_manifest(manifest)
    for module in manifest["runtimeModules"]:
        source = _module_path(root, module["source"])
        if not source.is_file():
            raise ManagerError(f"필수 패치 파일이 없습니다: {module['source']}")
        actual = _sha256_file(source)
        if actual != module["sha256"].upper():
            raise ManagerError(f"패치 파일 SHA-256이 manifest와 다릅니다: {module['source']}")
    known_versions = {str(manifest["officialVersion"])}
    profiles = [{"officialVersion": str(manifest["officialVersion"]), "connections": copy.deepcopy(manifest["connections"])}]
    try:
        raw_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagerError(f"manifest를 다시 확인할 수 없습니다: {exc}") from exc
    if isinstance(raw_manifest, dict):
        for profile in raw_manifest.get("additionalOfficialSources", []):
            if isinstance(profile, dict) and isinstance(profile.get("officialVersion"), str):
                known_versions.add(profile["officialVersion"])
                profiles.append({
                    "officialVersion": profile["officialVersion"],
                    "connections": copy.deepcopy(profile.get("connections", [])),
                })
    manifest["_profilePinned"] = target_version is None or str(target_version) in known_versions
    manifest["_requestedVersion"] = target_version
    manifest["_connectionProfiles"] = profiles
    return root, manifest


def validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, dict):
        raise ManagerError("manifest 최상위 값은 JSON 객체여야 합니다.")
    required_text = ("officialVersion", "officialCommit", "officialArchiveSha256", "officialTreeSha256")
    if any(not isinstance(manifest.get(key), str) or not manifest[key] for key in required_text):
        raise ManagerError("manifest에 공식 버전·커밋·원본 SHA 정보가 빠졌습니다.")
    if "patchVersion" in manifest and not re.fullmatch(r"\d+\.\d+\.\d+", str(manifest["patchVersion"])):
        raise ManagerError("디노 패치 버전 형식이 잘못됐습니다.")
    if not re.fullmatch(r"[0-9a-f]{40}", manifest["officialCommit"], re.I):
        raise ManagerError("manifest 공식 커밋 SHA 형식이 잘못됐습니다.")
    for key in ("officialArchiveSha256", "officialTreeSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", manifest[key], re.I):
            raise ManagerError(f"manifest {key} 형식이 잘못됐습니다.")
    if not isinstance(manifest.get("officialTreeFileCount"), int) or manifest["officialTreeFileCount"] <= 0:
        raise ManagerError("manifest 공식 파일 개수가 잘못됐습니다.")
    if manifest.get("officialTreeHashFormat") != "SHA256(sorted(relative path UTF-8 + NUL + raw file SHA256 digest + LF))":
        raise ManagerError("알 수 없는 공식 원본 트리 해시 형식입니다.")

    additional_sources = manifest.get("additionalOfficialSources", [])
    if not isinstance(additional_sources, list):
        raise ManagerError("추가 공식 원본 프로필 목록 형식이 잘못됐습니다.")
    seen_versions = {manifest["officialVersion"]}
    base_profile = {key: value for key, value in manifest.items() if key != "additionalOfficialSources"}
    allowed_profile_keys = {
        "officialVersion",
        "officialCommit",
        "officialArchiveSha256",
        "officialTreeSha256",
        "officialTreeFileCount",
        "connections",
    }
    required_profile_keys = allowed_profile_keys
    for profile in additional_sources:
        if not isinstance(profile, dict) or set(profile) - allowed_profile_keys:
            raise ManagerError("추가 공식 원본 프로필에 허용되지 않은 항목이 있습니다.")
        if not required_profile_keys.issubset(profile):
            raise ManagerError("추가 공식 원본 프로필에 버전·커밋·트리 또는 연결 기준이 빠졌습니다.")
        version = profile.get("officialVersion")
        if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version) or version in seen_versions:
            raise ManagerError("추가 공식 원본 프로필의 버전이 잘못됐거나 중복됐습니다.")
        seen_versions.add(version)
        merged_profile = dict(base_profile)
        merged_profile.update(profile)
        validate_manifest(merged_profile)

    connection_files = manifest.get("officialConnectionFiles")
    allowed = manifest.get("officialRuntimeModifiedAllowlist")
    connections = manifest.get("connections")
    if not isinstance(connection_files, list) or not isinstance(allowed, list) or set(connection_files) != set(allowed):
        raise ManagerError("공식 연결 파일 허용 목록이 일치하지 않습니다.")
    if set(connection_files) != EXPECTED_CONNECTION_FILES:
        raise ManagerError("검토된 두 공식 연결 파일 범위와 manifest가 다릅니다.")
    if not isinstance(connections, list) or len(connections) != 5:
        raise ManagerError("공식 연결 코드 변경 목록이 없습니다.")
    touched = set()
    connection_counts: dict[str, int] = {}
    for item in connections:
        if not isinstance(item, dict):
            raise ManagerError("manifest 연결 변경 항목 형식이 잘못됐습니다.")
        relative = _safe_relative(item.get("file"))
        if relative not in EXPECTED_CONNECTION_FILES:
            raise ManagerError(f"허용되지 않은 공식 파일 연결 변경입니다: {relative}")
        if not all(isinstance(item.get(key), str) and item[key] for key in ("description", "before", "after")):
            raise ManagerError(f"연결 변경 설명이나 anchor가 빠졌습니다: {relative}")
        if item["before"] == item["after"]:
            raise ManagerError(f"변경 전후가 같은 연결 변경입니다: {relative}")
        touched.add(relative)
        connection_counts[relative] = connection_counts.get(relative, 0) + 1
    if touched != EXPECTED_CONNECTION_FILES or connection_counts != {"src/app.js": 1, "src/index.html": 4}:
        raise ManagerError("manifest가 두 공식 연결 파일을 모두 다루지 않습니다.")

    modules = manifest.get("runtimeModules")
    if not isinstance(modules, list) or len(modules) != len(EXPECTED_MODULES) or {item.get("destination") for item in modules if isinstance(item, dict)} != EXPECTED_MODULES:
        raise ManagerError("필수 디노 패치 모듈 3개가 manifest와 일치하지 않습니다.")
    for item in modules:
        _safe_relative(item.get("source"))
        _safe_relative(item.get("destination"))
        if not re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256", "")), re.I):
            raise ManagerError(f"패치 파일 SHA-256 형식이 잘못됐습니다: {item.get('source')}")
        if item["destination"] in EXPECTED_CONNECTION_FILES:
            raise ManagerError("패치 모듈이 공식 연결 파일을 덮어쓰도록 설정되어 있습니다.")

    apis = manifest.get("officialApis")
    expected_apis = {("providerCatalog", "provider:catalog"), ("providerDetail", "provider:detail"), ("providerResolve", "provider:resolve")}
    if not isinstance(apis, list) or len(apis) != len(expected_apis) or {(item.get("name"), item.get("channel")) for item in apis if isinstance(item, dict)} != expected_apis:
        raise ManagerError("공식 providerCatalog/providerDetail/providerResolve 계약 목록이 잘못됐습니다.")


def _inventory(root: Path) -> dict[str, str]:
    root = canonical_path(root, strict=True)
    result: dict[str, str] = {}
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        kept: list[str] = []
        for name in dirs:
            if name in {".git", "node_modules"}:
                continue
            entry = current_path / name
            if _is_link_or_junction(entry):
                raise ManagerError(f"원본 트리에 심볼릭 링크/정션이 있습니다: {entry.relative_to(root)}")
            if current_path == root and name == MANAGER_FOLDER_NAME:
                # The manager, its backups and its operation journal live beside
                # the source tree and are not LilacAnime runtime files.
                continue
            kept.append(name)
        dirs[:] = kept
        for name in files:
            entry = current_path / name
            relative = entry.relative_to(root).as_posix()
            if relative == ".git" or relative.startswith(".git/") or relative == "node_modules" or relative.startswith("node_modules/"):
                continue
            if _is_link_or_junction(entry):
                raise ManagerError(f"원본 트리에 심볼릭 링크가 있습니다: {relative}")
            if not entry.is_file():
                raise ManagerError(f"일반 파일이 아닌 항목이 있습니다: {relative}")
            result[relative] = _sha256_file(entry)
    return result


def tree_sha256(file_hashes: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for relative in sorted(file_hashes):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(bytes.fromhex(file_hashes[relative]))
        digest.update(b"\n")
    return digest.hexdigest().upper()


def _verify_original_root(root: Path, manifest: dict[str, Any]) -> dict[str, str]:
    root = canonical_path(root, strict=True)
    package_file = root / "package.json"
    lock_file = root / "package-lock.json"
    if not package_file.is_file() or not lock_file.is_file():
        raise ManagerError("원본에 package.json 또는 package-lock.json이 없습니다.")
    try:
        package = json.loads(package_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagerError(f"원본 package.json을 읽을 수 없습니다: {exc}") from exc
    if package.get("version") != manifest["officialVersion"]:
        raise ManagerError(
            f"지원 기준 버전은 {manifest['officialVersion']}이며, 선택한 원본은 {package.get('version', '버전 미확인')}입니다. "
            "다른 버전을 자동 호환 처리하지 않습니다."
        )
    files = _inventory(root)
    if len(files) != manifest["officialTreeFileCount"]:
        raise ManagerError(f"공식 원본 파일 수가 다릅니다: 기대 {manifest['officialTreeFileCount']}, 확인 {len(files)}")
    actual_tree = tree_sha256(files)
    if actual_tree != manifest["officialTreeSha256"]:
        raise ManagerError(f"공식 원본 파일 트리 SHA-256 불일치: {actual_tree}")
    for connection in manifest["connections"]:
        path = _module_path(root, connection["file"])
        data = path.read_bytes()
        before = connection["before"].encode("utf-8")
        if data.count(before) != 1:
            raise ManagerError(f"공식 연결 지점을 정확히 한 곳에서 찾지 못했습니다: {connection['file']} ({connection['description']})")
    if manifest.get("_compatibilityMode") == "STRUCTURAL":
        manifest["_contractEvidence"] = _verify_structural_official_contracts(root, manifest)
    else:
        _verify_official_contracts(root, manifest)
    return files


def _verify_official_contracts(root: Path, manifest: dict[str, Any]) -> None:
    preload = (root / "electron" / "preload.cjs").read_text(encoding="utf-8")
    main = (root / "electron" / "main.cjs").read_text(encoding="utf-8")
    app = (root / "src" / "app.js").read_text(encoding="utf-8")
    html = (root / "src" / "index.html").read_text(encoding="utf-8")
    if html.count('id="detailDialog"') != 1:
        raise ManagerError("공식 #detailDialog가 하나가 아니므로 안전하게 연결할 수 없습니다.")
    for api in manifest["officialApis"]:
        name = re.escape(api["name"])
        channel = re.escape(api["channel"])
        if not re.search(rf"{name}:[\s\S]{{0,240}}?ipcRenderer\.invoke\('{channel}'", preload):
            raise ManagerError(f"공식 preload IPC 계약이 다릅니다: {api['name']} / {api['channel']}")
        if f"ipcMain.handle('{api['channel']}'" not in main:
            raise ManagerError(f"공식 main IPC 계약이 다릅니다: {api['channel']}")
    if not re.search(r"function\s+doSearch\s*\(", app) or not re.search(r"function\s+openDetail\s*\(", app):
        raise ManagerError("공식 검색 또는 상세 진입 함수 계약을 찾지 못했습니다.")
    if not any(channel == "provider:resolve" for _, channel in ((x["name"], x["channel"]) for x in manifest["officialApis"])):
        raise ManagerError("공식 providerResolve 계약이 manifest에 없습니다.")


def _split_js_items(value: str) -> list[str]:
    """Split a simple JS parameter/argument list without splitting nested values."""
    parts: list[str] = []
    start = 0
    quote: str | None = None
    escaped = False
    stack: list[str] = []
    pairs = {")": "(", "]": "[", "}": "{"}
    for index, char in enumerate(value):
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {"'", '"', "`"}:
            quote = char
        elif char in "([{" :
            stack.append(char)
        elif char in ")]}":
            if stack and stack[-1] == pairs[char]:
                stack.pop()
        elif char == "," and not stack:
            parts.append(value[start:index].strip())
            start = index + 1
    tail = value[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def _js_parameter_contract(raw: str) -> list[tuple[str, str | None]]:
    result = []
    for part in _split_js_items(raw):
        name, separator, default = part.partition("=")
        normalized_default = None
        if separator:
            value = re.sub(r"\s+", "", default)
            if value in {"''", '""'}:
                value = "empty-string"
            normalized_default = value
        result.append((name.strip(), normalized_default))
    return result


def _extract_js_braced_body(source: str, opening_brace: int, description: str) -> str:
    if opening_brace >= len(source) or source[opening_brace] != "{":
        raise ManagerError(f"공식 {description} 코드 블록을 확인할 수 없습니다.")
    depth = 0
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    index = opening_brace
    while index < len(source):
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if line_comment:
            if char in "\r\n":
                line_comment = False
        elif block_comment:
            if char == "*" and next_char == "/":
                block_comment = False
                index += 1
        elif quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char == "/" and next_char == "/":
            line_comment = True
            index += 1
        elif char == "/" and next_char == "*":
            block_comment = True
            index += 1
        elif char in {"'", '"', "`"}:
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[opening_brace + 1:index]
        index += 1
    raise ManagerError(f"공식 {description} 코드 블록의 끝을 확인할 수 없습니다.")


def _named_js_function_body(source: str, name: str, description: str) -> str:
    match = re.search(rf"\b(?:async\s+)?function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{", source)
    if not match:
        raise ManagerError(f"공식 {description} 함수 구조를 확인할 수 없습니다: {name}")
    return _extract_js_braced_body(source, match.end() - 1, description)


def _ipc_handler_contract(main: str, channel: str) -> tuple[list[tuple[str, str | None]], str]:
    pattern = re.compile(
        rf"ipcMain\.handle\(\s*['\"]{re.escape(channel)}['\"]\s*,\s*(?:async\s*)?"
        r"\((?P<params>[^)]*)\)\s*=>\s*\{"
    )
    matches = list(pattern.finditer(main))
    if len(matches) != 1:
        raise ManagerError(f"공식 main IPC 계약이 없거나 중복됐습니다: {channel}")
    match = matches[0]
    body = _extract_js_braced_body(main, match.end() - 1, f"{channel} IPC")
    return _js_parameter_contract(match.group("params")), body


def _verify_structural_official_contracts(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    required = (
        "src/app.js", "src/index.html", "src/player.js",
        "electron/main.cjs", "electron/preload.cjs",
    )
    missing = [relative for relative in required if not _module_path(root, relative).is_file()]
    if missing:
        raise ManagerError("공식 런타임 연결 파일이 없습니다: " + ", ".join(missing))

    preload = (root / "electron" / "preload.cjs").read_text(encoding="utf-8")
    main = (root / "electron" / "main.cjs").read_text(encoding="utf-8")
    app = (root / "src" / "app.js").read_text(encoding="utf-8")
    html = (root / "src" / "index.html").read_text(encoding="utf-8")
    if len(re.findall(r"\bid\s*=\s*['\"]detailDialog['\"]", html, re.I)) != 1:
        raise ManagerError("공식 상세 화면 #detailDialog가 정확히 하나가 아니므로 연결을 중단했습니다.")

    expected = {
        "providerCatalog": {
            "channel": "provider:catalog",
            "preload": [("provider", None), ("query", "empty-string"), ("offset", "0"), ("sort", "empty-string")],
            "invoke": ["provider", "query", "offset", "sort"],
            "main": [("_", None), ("provider", None), ("query", "empty-string"), ("offset", "0"), ("sort", "empty-string")],
        },
        "providerDetail": {
            "channel": "provider:detail",
            "preload": [("anime", None)], "invoke": ["anime"],
            "main": [("_", None), ("anime", None)],
        },
        "providerResolve": {
            "channel": "provider:resolve",
            "preload": [("episode", None)], "invoke": ["episode"],
            "main": [("_", None), ("episode", None)],
        },
    }
    evidence: dict[str, Any] = {"mode": "STRUCTURAL", "runtimePlaybackVerified": False, "apis": {}}
    for name, contract in expected.items():
        channel = contract["channel"]
        preload_pattern = re.compile(
            rf"\b{re.escape(name)}\s*:\s*(?:\((?P<params>[^)]*)\)|(?P<single>[A-Za-z_$][\w$]*))\s*=>\s*"
            rf"ipcRenderer\.invoke\(\s*['\"]{re.escape(channel)}['\"](?P<args>[^)]*)\)"
        )
        preload_matches = list(preload_pattern.finditer(preload))
        if len(preload_matches) != 1:
            raise ManagerError(f"공식 preload 메서드 또는 IPC 채널이 없거나 중복됐습니다: {name}")
        exposed = preload_matches[0]
        raw_params = exposed.group("params") if exposed.group("params") is not None else exposed.group("single")
        params = _js_parameter_contract(raw_params)
        invoke_args = [item.strip() for item in _split_js_items(exposed.group("args").lstrip().removeprefix(","))]
        if params != contract["preload"] or invoke_args != contract["invoke"]:
            raise ManagerError(f"공식 preload 인자 순서·기본값 계약이 바뀌었습니다: {name}")
        main_params, handler_body = _ipc_handler_contract(main, channel)
        if main_params != contract["main"]:
            raise ManagerError(f"공식 main IPC 인자 계약이 바뀌었습니다: {channel}")
        evidence["apis"][name] = {"channel": channel, "preloadArgs": invoke_args, "mainParams": [item[0] for item in main_params]}

        if name == "providerCatalog":
            for provider in EXPECTED_PROVIDERS:
                branch_pattern = re.compile(
                    rf"if\s*\(\s*provider\s*===\s*['\"]{re.escape(provider)}['\"]\s*\)\s*\{{"
                )
                branches = list(branch_pattern.finditer(handler_body))
                if len(branches) != 1:
                    raise ManagerError(f"공식 provider:catalog에서 공급원 처리 계약을 찾지 못했습니다: {provider}")
                branch_body = _extract_js_braced_body(handler_body, branches[0].end() - 1, f"{provider} catalog")
                if not re.search(r"return\s*\{\s*data\s*:", branch_body) and not re.search(
                    r"return\s*\{\s*data\s*,", branch_body
                ):
                    raise ManagerError(f"공식 provider:catalog의 {provider} 응답에 data 목록이 없습니다.")
                data_shape = {
                    "reanime": r"data\s*:\s*reanimeItems\s*\(",
                    "animenosub": r"const\s+data\s*=\s*animenosubList\s*\([\s\S]*?return\s*\{\s*data\s*,",
                    "ohli24": r"\bresult\s*=\s*await\s+ohliBrowse\s*\([\s\S]*?return\s*\{\s*data\s*:\s*result\.data\b",
                    "linkani": r"const\s+data\s*=\s*linkaniItems\s*\([\s\S]*?return\s*\{\s*data\s*,",
                    "miruro": r"data\s*:\s*\(\s*root\.data\s*\|\|\s*\[\]\s*\)\.map\s*\(\s*miruroItem\s*\)",
                }[provider]
                if not re.search(data_shape, branch_body):
                    raise ManagerError(f"공식 provider:catalog의 {provider} 검색 결과가 목록 data 형식으로 변환되지 않습니다.")
                query_shape = {
                    "reanime": r"if\s*\(\s*query\s*\)\s*url\.searchParams\.set\(\s*['\"]q['\"]\s*,\s*query\s*\)",
                    "animenosub": r"encodeURIComponent\s*\(\s*query\s*\)",
                    "ohli24": r"if\s*\(\s*query\s*\)\s*return\s*\{\s*data\s*:\s*await\s+ohliSearch\s*\(\s*query\s*\)",
                    "linkani": r"query\s*\?\s*searchUrl\s*\(\s*query\s*,",
                    "miruro": r"query\s*\?\s*\{\s*q\s*:\s*query\b",
                }[provider]
                if not re.search(query_shape, branch_body):
                    raise ManagerError(f"공식 provider:catalog의 {provider} 검색어 연결이 바뀌었습니다.")
        elif name == "providerDetail":
            if not re.search(r"loadProviderDetail\s*\(\s*anime\s*\)", handler_body) or not re.search(r"return\s+promise\b", handler_body):
                raise ManagerError("공식 provider:detail이 anime 입력을 상세 조회에 전달하는 계약이 바뀌었습니다.")
        else:
            if not re.search(r"await\s+resolveProviderEpisode\s*\(\s*episode\s*\)", handler_body) or not re.search(r"return\s+stream\b", handler_body):
                raise ManagerError("공식 provider:resolve가 선택 회차를 원본 resolve 함수에 전달하는 계약이 바뀌었습니다.")

    detail_helper = re.search(r"const\s+loadProviderDetail\s*=\s*async\s+anime\s*=>\s*\{", main)
    if not detail_helper:
        raise ManagerError("공식 상세 조회 helper 구조를 확인할 수 없습니다.")
    detail_body = _extract_js_braced_body(main, detail_helper.end() - 1, "provider detail")
    for provider in ("reanime", "miruro", "ohli24", "linkani"):
        if not re.search(rf"anime\.provider\s*===\s*['\"]{provider}['\"]", detail_body):
            raise ManagerError(f"공식 상세 조회 공급원 분기가 바뀌었습니다: {provider}")
    reanime_branch = re.search(r"if\s*\(\s*anime\.provider\s*===\s*['\"]reanime['\"]\s*\)\s*\{", detail_body)
    if not reanime_branch:
        raise ManagerError("공식 RE:Anime 상세 조회 분기를 확인할 수 없습니다.")
    reanime_body = _extract_js_braced_body(detail_body, reanime_branch.end() - 1, "Re:Anime 상세")
    if not re.search(
        r"return\s*\{\s*data\s*:\s*detail\s*,\s*episodes\s*:\s*await\s+reanimeEpisodes\s*\(\s*detail\b",
        reanime_body,
    ):
        raise ManagerError("공식 RE:Anime 상세 응답이 작품 data와 회차 목록을 함께 반환하지 않습니다.")
    for provider, helper in (("miruro", "miruroDetail"), ("ohli24", "ohliDetail"), ("linkani", "linkaniDetail")):
        helper_body = _named_js_function_body(main, helper, f"{provider} 상세")
        if not re.search(r"return\s*\{\s*data\s*,\s*episodes\s*(?:,|:)", helper_body):
            raise ManagerError(f"공식 {provider} 상세 응답에 data와 episodes 목록이 없습니다.")
    if not re.search(
        r"const\s+detail\s*=\s*anime\.provider\s*===\s*['\"]animenosub['\"]\s*\?\s*animenosubDetail\s*\(",
        detail_body,
    ):
        raise ManagerError("공식 Animenosub 작품 상세 변환 경로를 확인할 수 없습니다.")
    if not re.search(
        r"const\s+episodes\s*=\s*providerEpisodes\s*\(\s*html\s*,\s*anime\.provider\s*,\s*detail\s*\)\s*;"
        r"[\s\S]{0,160}?return\s*\{\s*data\s*:\s*detail\s*,\s*episodes\s*(?:,|:)",
        detail_body,
    ):
        raise ManagerError("공식 Animenosub 상세 응답에 작품 data와 회차 목록이 없습니다.")

    search_body = _named_js_function_body(app, "doSearch", "검색")
    if not re.search(r"window\.lilac\.providerCatalog\s*\(\s*state\.source\s*,\s*[A-Za-z_$][\w$]*\s*\)", search_body):
        raise ManagerError("공식 검색이 현재 공급원과 검색어를 providerCatalog에 전달하지 않습니다.")
    if not re.search(r"\.data\s*\|\|\s*\[\]", search_body):
        raise ManagerError("공식 검색이 providerCatalog의 data 목록 반환값을 처리하지 않습니다.")

    detail_body_app = _named_js_function_body(app, "openDetail", "상세")
    expected_detail_flow = (
        re.search(r"const\s+\{\s*data\s*:\s*a\s*\}\s*=", detail_body_app)
        and re.search(r"window\.lilac\.providerDetail\s*\(\s*known\s*\)", detail_body_app)
        and re.search(r"mountEpisodeList\s*\([\s\S]{0,180}?episodes\s*:\s*providerResult\??\.episodes", detail_body_app)
        and re.search(r"window\.lilac\.providerResolve\s*\(\s*ep\s*\)", detail_body_app)
        and re.search(r"resolveIntoPlayer\s*\(", detail_body_app)
    )
    if not expected_detail_flow:
        raise ManagerError("공식 상세·회차·providerResolve·플레이어 연결 계약이 바뀌었습니다.")

    evidence["detail"] = {
        "dialogCount": 1,
        "providerDetailDataAndEpisodes": True,
        "episodeSelectionUsesProviderResolve": True,
        "officialPlayerReused": True,
    }
    evidence["catalogProviders"] = list(EXPECTED_PROVIDERS)
    return evidence


def _git_blob_sha1(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode("ascii")
    return hashlib.sha1(header + data).hexdigest()


def _select_structural_connections(manifest: dict[str, Any], source_bytes: dict[str, bytes]) -> list[dict[str, str]]:
    matched: dict[tuple[tuple[str, str, str], ...], list[dict[str, str]]] = {}
    profiles = manifest.get("_connectionProfiles", [])
    if not isinstance(profiles, list):
        raise CompatibilityBlocked("검토된 연결점 프로필을 읽을 수 없어 원본을 변경하지 않았습니다.")
    for profile in profiles:
        connections = profile.get("connections") if isinstance(profile, dict) else None
        if not isinstance(connections, list) or len(connections) != 5:
            continue
        okay = True
        key: list[tuple[str, str, str]] = []
        for item in connections:
            if not isinstance(item, dict):
                okay = False
                break
            relative = item.get("file")
            if relative not in EXPECTED_CONNECTION_FILES or relative not in source_bytes:
                okay = False
                break
            data = source_bytes[relative]
            before = str(item.get("before", "")).encode("utf-8")
            after = str(item.get("after", "")).encode("utf-8")
            if not before or data.count(before) != 1 or data.count(after) != 0:
                okay = False
                break
            key.append((relative, item["before"], item["after"]))
        if okay:
            matched[tuple(key)] = connections
    if len(matched) != 1:
        raise CompatibilityBlocked(
            "공식 소스에서 디노 패치 연결 위치를 하나의 검토된 구조로 확정하지 못했습니다. "
            "중복·수정·새로운 연결 형식이 감지되어 적용을 중단했습니다.",
            "UNSUPPORTED",
        )
    return copy.deepcopy(next(iter(matched.values())))


def _verify_local_git_tree(
    root: Path,
    file_hashes: dict[str, str],
    source_identity: dict[str, Any],
    *,
    original_bytes: dict[str, bytes] | None = None,
) -> None:
    upstream = source_identity.get("files")
    if not isinstance(upstream, dict):
        raise CompatibilityBlocked("공식 GitHub 파일 목록을 완전하게 읽지 못했습니다.")
    for relative in upstream:
        first = str(relative).split("/", 1)[0].casefold()
        if first == MANAGER_FOLDER_NAME.casefold():
            raise CompatibilityBlocked("공식 소스가 관리자 전용 폴더와 충돌하여 자동 호환 검사를 중단했습니다.", "CONFLICT")
    local_paths, upstream_paths = set(file_hashes), set(upstream)
    if local_paths != upstream_paths:
        missing = sorted(upstream_paths - local_paths)
        extra = sorted(local_paths - upstream_paths)
        detail = []
        if missing:
            detail.append("누락: " + ", ".join(missing[:5]))
        if extra:
            detail.append("추가/사용자 파일: " + ", ".join(extra[:5]))
        raise CompatibilityBlocked(
            "선택한 폴더가 공식 GitHub 태그의 전체 파일 목록과 다릅니다. 사용자 수정이나 부분 원본을 보호하기 위해 적용하지 않았습니다. "
            + " / ".join(detail),
            "CONFLICT",
        )
    if len(local_paths) > MAX_ARCHIVE_FILES:
        raise CompatibilityBlocked("공식 원본 파일 수가 안전 검사 한도를 넘었습니다.", "UNSUPPORTED")
    for relative in sorted(local_paths):
        expected_sha = upstream[relative]
        if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", expected_sha, re.I):
            raise CompatibilityBlocked(f"공식 GitHub 파일 지문 형식이 잘못됐습니다: {relative}")
        try:
            data = original_bytes[relative] if original_bytes is not None and relative in original_bytes else _module_path(root, relative).read_bytes()
        except OSError as exc:
            raise CompatibilityBlocked(f"공식 파일을 읽지 못해 지문을 확인할 수 없습니다: {relative}", "CONFLICT") from exc
        if hashlib.sha256(data).hexdigest().upper() != str(file_hashes[relative]).upper():
            raise CompatibilityBlocked(f"현재 원본 또는 복원 백업의 파일 지문이 기록과 다릅니다: {relative}", "CONFLICT")
        if _git_blob_sha1(data) != expected_sha.lower():
            raise CompatibilityBlocked(
                f"공식 GitHub 원본과 다른 파일이 감지됐습니다: {relative}. 사용자 변경을 덮어쓰지 않도록 적용을 중단했습니다.",
                "CONFLICT",
            )


def _backup_original_snapshot(root: Path, backup: dict[str, Any]) -> tuple[dict[str, str], dict[str, bytes]]:
    before_hashes = backup.get("beforeFileHashes")
    entries = backup.get("files")
    if not isinstance(before_hashes, dict) or not isinstance(entries, list):
        raise CompatibilityBlocked("패치 상태의 원본 백업 기록이 불완전하여 출처를 확인할 수 없습니다.", "PARTIAL_OR_UNKNOWN")
    source_bytes: dict[str, bytes] = {}
    entry_by_path: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise CompatibilityBlocked("원본 백업 항목 형식이 잘못됐습니다.", "PARTIAL_OR_UNKNOWN")
        path = _safe_relative(entry["path"])
        if path in entry_by_path:
            raise CompatibilityBlocked("원본 백업에 중복 파일 항목이 있습니다.", "PARTIAL_OR_UNKNOWN")
        entry_by_path[path] = entry
    for relative, digest in before_hashes.items():
        rel = _safe_relative(relative)
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9A-F]{64}", digest, re.I):
            raise CompatibilityBlocked("원본 백업의 파일 해시 형식이 잘못됐습니다.", "PARTIAL_OR_UNKNOWN")
        entry = entry_by_path.get(rel)
        try:
            if entry is not None:
                if entry.get("existedBefore") is not True or entry.get("beforeSha256") != digest:
                    raise CompatibilityBlocked(f"백업의 원본 파일 기록이 일치하지 않습니다: {rel}", "PARTIAL_OR_UNKNOWN")
                backup_relative = _safe_relative(entry.get("backupPath"))
                backup_path = _manager_data_path(root, Path("backups") / str(backup["id"]) / Path(*backup_relative.split("/")))
                if not backup_path.is_file() or not same_or_within(canonical_path(backup_path, strict=True), _manager_data_path(root, Path("backups") / str(backup["id"]))):
                    raise CompatibilityBlocked(f"원본 파일 백업이 없거나 백업 폴더 밖을 가리킵니다: {rel}", "PARTIAL_OR_UNKNOWN")
                data = backup_path.read_bytes()
            else:
                data = _module_path(root, rel).read_bytes()
        except OSError as exc:
            raise CompatibilityBlocked(f"원본 스냅샷 파일을 읽을 수 없습니다: {rel}", "PARTIAL_OR_UNKNOWN") from exc
        if hashlib.sha256(data).hexdigest().upper() != digest.upper():
            raise CompatibilityBlocked(f"원본 스냅샷과 기록된 파일 해시가 다릅니다: {rel}", "PARTIAL_OR_UNKNOWN")
        source_bytes[rel] = data
    return before_hashes, source_bytes


def _resolve_structural_source_manifest(
    root: Path,
    patch_root: Path,
    manifest: dict[str, Any],
    version: str,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise CompatibilityBlocked("공식 package.json 버전이 지원하는 정식 버전 형식이 아닙니다.")
    state_path = _state_path(root)
    state = _read_json_file(state_path, "패치 상태 기록") if state_path.is_file() else None
    original_bytes: dict[str, bytes] | None = None
    if state and state.get("status") == "APPLIED":
        if state.get("officialVersion") != version or not state.get("backupId"):
            raise CompatibilityBlocked("미등록 버전에서 패치 상태 기록의 버전 또는 백업 연결을 확인할 수 없습니다.", "PARTIAL_OR_UNKNOWN")
        backup_id = str(state["backupId"])
        if not re.fullmatch(r"[A-Za-z0-9T._-]{8,80}", backup_id):
            raise CompatibilityBlocked("패치 상태의 백업 ID가 잘못됐습니다.", "PARTIAL_OR_UNKNOWN")
        backup_path = _manager_data_path(root, Path("backups") / backup_id / "backup.json")
        backup = _read_json_file(backup_path, "패치 원본 백업")
        if backup.get("id") != backup_id or backup.get("restorable") is not True:
            raise CompatibilityBlocked("미등록 버전의 패치 원본 백업이 복원 가능한 상태가 아닙니다.", "PARTIAL_OR_UNKNOWN")
        if backup.get("officialVersion") != version or backup.get("officialCommit") != state.get("officialCommit"):
            raise CompatibilityBlocked("패치 기록과 백업의 공식 원본 식별 정보가 다릅니다.", "PARTIAL_OR_UNKNOWN")
        before_hashes, original_bytes = _backup_original_snapshot(root, backup)
        if tree_sha256(before_hashes) != backup.get("beforeTreeSha256") or tree_sha256(before_hashes) != state.get("beforeTreeSha256"):
            raise CompatibilityBlocked("패치 기록의 원본 트리 지문과 백업이 일치하지 않습니다.", "PARTIAL_OR_UNKNOWN")
        file_hashes = before_hashes
    else:
        if state and state.get("status") not in {"UNPATCHED"}:
            raise CompatibilityBlocked("미등록 버전의 패치 상태가 불명확하여 파일 변경을 잠갔습니다.", "PARTIAL_OR_UNKNOWN")
        file_hashes = _inventory(root)
        destinations = {item["destination"] for item in manifest["runtimeModules"]}
        anchor_profiles = manifest.get("_connectionProfiles", [])
        patch_traces = [relative for relative in destinations if _module_path(root, relative).exists()]
        if not patch_traces:
            for profile in anchor_profiles:
                for connection in profile.get("connections", []) if isinstance(profile, dict) else []:
                    target = _module_path(root, connection["file"])
                    if target.is_file() and connection["after"].encode("utf-8") in target.read_bytes():
                        patch_traces.append(connection["file"])
        if patch_traces:
            raise CompatibilityBlocked(
                "미등록 버전 원본에서 관리자 기록이 없는 디노 패치 흔적이 발견됐습니다. 상태를 추측하지 않고 적용을 중단했습니다.",
                "PARTIAL_OR_UNKNOWN",
            )

    try:
        identity = _fetch_official_source_identity(version, opener=opener)
    except CompatibilityBlocked:
        raise
    except Exception as exc:
        raise CompatibilityBlocked(
            f"공식 v{version} 태그·릴리스·전체 파일 트리를 확인하지 못했습니다 ({type(exc).__name__}). 원본은 변경하지 않았습니다."
        ) from exc

    if state and state.get("status") == "APPLIED":
        if state.get("officialCommit") != identity["commit"] or state.get("officialGitTreeSha") != identity["treeSha"]:
            raise CompatibilityBlocked("이미 적용된 패치 기록의 공식 태그·트리 지문이 현재 공식 릴리스와 다릅니다.", "PARTIAL_OR_UNKNOWN")
        if backup.get("officialGitTreeSha") != identity["treeSha"]:
            raise CompatibilityBlocked("패치 백업의 공식 Git 트리 지문이 현재 공식 릴리스와 다릅니다.", "PARTIAL_OR_UNKNOWN")
    elif state:
        if state.get("officialVersion") != version or state.get("officialCommit") != identity["commit"] or state.get("officialGitTreeSha") != identity["treeSha"]:
            raise CompatibilityBlocked("이전 미등록 버전 기록이 현재 공식 태그·트리와 다릅니다. 기록을 확인하기 전까지 적용하지 않습니다.", "PARTIAL_OR_UNKNOWN")

    _verify_local_git_tree(root, file_hashes, identity, original_bytes=original_bytes)
    for relative in EXPECTED_CONNECTION_FILES:
        if relative not in (original_bytes or {}):
            original_bytes = original_bytes or {}
            original_bytes[relative] = _module_path(root, relative).read_bytes()
    connections = _select_structural_connections(manifest, original_bytes or {})
    package = _package_info(root)
    if package.get("version") != version:
        raise CompatibilityBlocked("공식 package.json 버전이 변경되어 출처를 확인할 수 없습니다.", "CONFLICT")
    lock_path = root / "package-lock.json"
    if not lock_path.is_file():
        raise CompatibilityBlocked("공식 package-lock.json이 없어 버전 일관성을 확인할 수 없습니다.", "UNSUPPORTED")
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CompatibilityBlocked("공식 package-lock.json을 읽을 수 없습니다.", "UNSUPPORTED") from exc
    root_lock = lock.get("packages", {}).get("") if isinstance(lock, dict) and isinstance(lock.get("packages"), dict) else None
    lock_version = root_lock.get("version") if isinstance(root_lock, dict) else lock.get("version") if isinstance(lock, dict) else None
    if lock_version is not None and str(lock_version) != version:
        raise CompatibilityBlocked("package.json과 package-lock.json의 공식 버전이 다릅니다.", "CONFLICT")

    resolved = dict(manifest)
    resolved.update({
        "officialVersion": version,
        "officialCommit": identity["commit"],
        "officialTreeSha256": tree_sha256(file_hashes).upper(),
        "officialTreeFileCount": len(file_hashes),
        "connections": connections,
        "compatibilityMode": "STRUCTURAL",
        "officialGitTreeSha": identity["treeSha"],
        "sourceIdentityVerified": True,
        "runtimePlaybackVerified": False,
    })
    try:
        validate_manifest(resolved)
    except ManagerError as exc:
        raise CompatibilityBlocked(f"구조 기반 패치 계획이 기존 manifest 계약을 만족하지 않습니다: {exc}", "UNSUPPORTED") from exc
    try:
        resolved["_sourceContractEvidence"] = _verify_structural_official_contracts(root, resolved)
    except ManagerError as exc:
        raise CompatibilityBlocked(f"공식 소스 호출 계약이 바뀌었습니다: {exc}", "UNSUPPORTED") from exc
    return resolved


def _load_manifest_for_target(
    root: Path,
    patch_root_value: str | os.PathLike[str] | None = None,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> tuple[Path, dict[str, Any]]:
    package = _package_info(root)
    version = str(package.get("version", ""))
    patch_root, manifest = load_manifest(patch_root_value or patch_source_root(), version)
    if manifest.get("_profilePinned"):
        manifest["compatibilityMode"] = "PINNED"
        manifest["runtimePlaybackVerified"] = version in {"0.5.54", "0.5.55"}
        return patch_root, manifest
    try:
        return patch_root, _resolve_structural_source_manifest(root, patch_root, manifest, version, opener=opener)
    except CompatibilityBlocked:
        raise
    except Exception as exc:
        raise CompatibilityBlocked(
            f"v{version} 구조 호환성을 확인하지 못했습니다 ({type(exc).__name__}). 원본은 변경하지 않았습니다."
        ) from exc


def inspect_source(source_value: str | os.PathLike[str], manifest: dict[str, Any], project_root: Path = PROJECT_ROOT) -> dict[str, Any]:
    source, kind = assert_safe_source(source_value, project_root)
    if kind == "archive":
        archive_sha = _sha256_file(source)
        if archive_sha != manifest["officialArchiveSha256"].upper():
            raise ManagerError(f"공식 아카이브 SHA-256 불일치: {archive_sha}")
        return {
            "kind": kind,
            "path": str(source),
            "archiveSha256": archive_sha,
            "version": manifest["officialVersion"],
            "commit": manifest["officialCommit"],
            "integrity": "공식 아카이브 SHA-256 일치",
        }
    files = _verify_original_root(source, manifest)
    return {
        "kind": kind,
        "path": str(source),
        "version": manifest["officialVersion"],
        "commit": manifest["officialCommit"],
        "fileCount": len(files),
        "treeSha256": tree_sha256(files),
        "integrity": "공식 원본 파일 트리 SHA-256 일치",
        "compatibilityMode": manifest.get("compatibilityMode", "PINNED"),
        "sourceIdentityVerified": bool(manifest.get("sourceIdentityVerified", True)),
        "runtimePlaybackVerified": bool(manifest.get("runtimePlaybackVerified", False)),
        "contractEvidence": manifest.get("_contractEvidence"),
    }


def inspect_unpinned_folder(source: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """Inspect an official-looking update without authorizing patch application."""
    package_file = source / "package.json"
    if not package_file.is_file():
        raise ManagerError("선택한 폴더에 package.json이 없습니다.")
    try:
        package = json.loads(package_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagerError(f"선택한 원본의 package.json을 읽을 수 없습니다: {exc}") from exc
    if not isinstance(package, dict) or not isinstance(package.get("version"), str):
        raise ManagerError("선택한 원본 package.json에 버전 문자열이 없습니다.")
    files = _inventory(source)
    actual_tree = tree_sha256(files)
    findings = []
    if package["version"] != manifest["officialVersion"]:
        findings.append(f"버전 {package['version']}은 고정 기준 {manifest['officialVersion']}과 다릅니다.")
    if len(files) != manifest["officialTreeFileCount"] or actual_tree != manifest["officialTreeSha256"].upper():
        findings.append("공식 파일 트리가 고정 기준과 다릅니다.")
    try:
        _verify_official_contracts(source, manifest)
        contract_status = "PRESENT"
    except (OSError, UnicodeError, ManagerError) as exc:
        contract_status = "CHANGED_OR_MISSING"
        findings.append(f"공식 호출 또는 상세 화면 계약의 추가 검토가 필요합니다: {exc}")
    if not findings:
        findings.append("현재 manifest 기준의 연결 anchor와 공식 계약을 추가 대조해야 합니다.")
    return {
        "status": "ADDITIONAL_CHECK_REQUIRED",
        "result": "ADDITIONAL_CHECK_REQUIRED",
        "kind": "folder",
        "path": str(source),
        "version": package["version"],
        "fileCount": len(files),
        "treeSha256": actual_tree,
        "contractStatus": contract_status,
        "findings": findings,
        "applyAuthorized": False,
    }


def _safe_member_name(name: str) -> str:
    normalized = name.replace("\\", "/")
    if not normalized or "\x00" in normalized or normalized.startswith("/"):
        raise ManagerError(f"아카이브 경로가 안전하지 않습니다: {name!r}")
    parts = normalized.rstrip("/").split("/")
    if not parts or any(part in {"", ".", ".."} for part in parts) or ":" in parts[0]:
        raise ManagerError(f"아카이브 경로가 입력 폴더 밖을 가리킵니다: {name!r}")
    return "/".join(parts)


def _archive_top_root(paths: list[str], manifest: dict[str, Any]) -> str:
    expected = OFFICIAL_SOURCE_NAME.format(manifest["officialCommit"])
    roots = {path.split("/", 1)[0] for path in paths if path}
    if roots != {expected}:
        raise ManagerError(f"아카이브 최상위 폴더가 고정된 공식 커밋과 다릅니다: {', '.join(sorted(roots)) or '(없음)'}")
    return expected


def _extract_zip(archive: Path, destination: Path, manifest: dict[str, Any]) -> Path:
    try:
        with zipfile.ZipFile(archive) as zf:
            infos = zf.infolist()
            if not infos or len(infos) > MAX_ARCHIVE_FILES:
                raise ManagerError("아카이브 파일 수가 허용 범위를 벗어났습니다.")
            names: list[str] = []
            total = 0
            checked: list[tuple[zipfile.ZipInfo, str, bool]] = []
            seen: set[str] = set()
            for info in infos:
                relative = _safe_member_name(info.filename)
                is_dir = info.is_dir() or info.filename.endswith(("/", "\\"))
                key = relative.lower()
                if key in seen:
                    raise ManagerError(f"아카이브에 중복 경로가 있습니다: {relative}")
                seen.add(key)
                mode = (info.external_attr >> 16) & 0xFFFF
                file_type = stat.S_IFMT(mode)
                if file_type not in (0, stat.S_IFDIR if is_dir else stat.S_IFREG):
                    raise ManagerError(f"심볼릭 링크 또는 특수 파일은 허용하지 않습니다: {relative}")
                total += 0 if is_dir else info.file_size
                if total > MAX_ARCHIVE_UNPACKED_BYTES:
                    raise ManagerError("아카이브의 압축 해제 용량이 허용 범위를 초과합니다.")
                names.append(relative)
                checked.append((info, relative, is_dir))
            root_name = _archive_top_root(names, manifest)
            destination.mkdir(parents=True, exist_ok=False)
            dest_real = canonical_path(destination, strict=True)
            for info, relative, is_dir in checked:
                out = dest_real.joinpath(*relative.split("/"))
                if not same_or_within(out, dest_real):
                    raise ManagerError(f"압축 해제 경로가 격리 폴더를 벗어납니다: {relative}")
                if is_dir:
                    out.mkdir(parents=True, exist_ok=True)
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as source_stream, out.open("xb") as output_stream:
                    shutil.copyfileobj(source_stream, output_stream, length=1024 * 1024)
            return destination / root_name
    except zipfile.BadZipFile as exc:
        raise ManagerError(f"ZIP 아카이브가 손상됐습니다: {exc}") from exc
    except OSError as exc:
        raise ManagerError(f"ZIP을 안전하게 풀지 못했습니다: {exc}") from exc


def _extract_tar(archive: Path, destination: Path, manifest: dict[str, Any]) -> Path:
    try:
        with tarfile.open(archive, mode="r:*") as tf:
            members = tf.getmembers()
            if not members or len(members) > MAX_ARCHIVE_FILES:
                raise ManagerError("아카이브 파일 수가 허용 범위를 벗어났습니다.")
            names: list[str] = []
            total = 0
            checked: list[tuple[tarfile.TarInfo, str]] = []
            seen: set[str] = set()
            for member in members:
                relative = _safe_member_name(member.name)
                key = relative.lower()
                if key in seen:
                    raise ManagerError(f"아카이브에 중복 경로가 있습니다: {relative}")
                seen.add(key)
                if not (member.isdir() or member.isfile()) or member.issym() or member.islnk():
                    raise ManagerError(f"심볼릭 링크 또는 특수 파일은 허용하지 않습니다: {relative}")
                total += member.size if member.isfile() else 0
                if total > MAX_ARCHIVE_UNPACKED_BYTES:
                    raise ManagerError("아카이브의 압축 해제 용량이 허용 범위를 초과합니다.")
                names.append(relative)
                checked.append((member, relative))
            root_name = _archive_top_root(names, manifest)
            destination.mkdir(parents=True, exist_ok=False)
            dest_real = canonical_path(destination, strict=True)
            for member, relative in checked:
                out = dest_real.joinpath(*relative.split("/"))
                if not same_or_within(out, dest_real):
                    raise ManagerError(f"압축 해제 경로가 격리 폴더를 벗어납니다: {relative}")
                if member.isdir():
                    out.mkdir(parents=True, exist_ok=True)
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                input_stream = tf.extractfile(member)
                if input_stream is None:
                    raise ManagerError(f"아카이브 파일을 읽을 수 없습니다: {relative}")
                with input_stream, out.open("xb") as output_stream:
                    shutil.copyfileobj(input_stream, output_stream, length=1024 * 1024)
            return destination / root_name
    except (tarfile.TarError, OSError) as exc:
        if isinstance(exc, ManagerError):
            raise
        raise ManagerError(f"TAR 아카이브를 안전하게 풀지 못했습니다: {exc}") from exc


def _extract_archive(archive: Path, destination: Path, manifest: dict[str, Any]) -> Path:
    if archive.suffix.lower() == ".zip":
        return _extract_zip(archive, destination, manifest)
    return _extract_tar(archive, destination, manifest)


def _copy_original_folder(source: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=False)
    source_files = _inventory(source)
    for relative in sorted(source_files):
        original = source.joinpath(*relative.split("/"))
        output = destination.joinpath(*relative.split("/"))
        if not same_or_within(output, destination):
            raise ManagerError(f"복사 경로가 임시 폴더를 벗어납니다: {relative}")
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, output)
    return destination


def _replace_exactly(data: bytes, before: str, after: str, label: str) -> bytes:
    encoded_before = before.encode("utf-8")
    count = data.count(encoded_before)
    if count != 1:
        raise ManagerError(f"{label}: 공식 연결 지점을 정확히 한 번 찾아야 하지만 {count}개입니다.")
    return data.replace(encoded_before, after.encode("utf-8"), 1)


def _apply_connections(source_root: Path, manifest: dict[str, Any]) -> None:
    for connection in manifest["connections"]:
        target = _module_path(source_root, connection["file"])
        content = target.read_bytes()
        updated = _replace_exactly(content, connection["before"], connection["after"], connection["description"])
        target.write_bytes(updated)


def _copy_modules(patch_root: Path, source_root: Path, manifest: dict[str, Any]) -> None:
    for module in manifest["runtimeModules"]:
        source = _module_path(patch_root, module["source"])
        if not source.is_file() or _sha256_file(source) != module["sha256"].upper():
            raise ManagerError(f"패치 모듈이 manifest와 다릅니다: {module['source']}")
        destination = _module_path(source_root, module["destination"])
        if destination.exists():
            raise ManagerError(f"원본에 같은 이름의 패치 모듈이 이미 있습니다: {module['destination']}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)


def _verify_patched_tree(source_root: Path, original: dict[str, str], manifest: dict[str, Any]) -> dict[str, Any]:
    after = _inventory(source_root)
    modified = sorted(path for path in original if path in after and original[path] != after[path])
    removed = sorted(path for path in original if path not in after)
    added = sorted(path for path in after if path not in original)
    allowed_modified = sorted(manifest["officialRuntimeModifiedAllowlist"])
    expected_added = sorted(item["destination"] for item in manifest["runtimeModules"])
    if modified != allowed_modified:
        raise ManagerError(f"허용되지 않은 공식 파일 변경입니다: {', '.join(modified) or '(없음)'}")
    if removed:
        raise ManagerError(f"공식 원본 파일이 사라졌습니다: {', '.join(removed)}")
    if added != expected_added:
        raise ManagerError(f"허용되지 않은 런타임 파일 추가입니다: {', '.join(added) or '(없음)'}")
    _verify_patched_contracts(source_root, manifest)
    return {
        "modifiedOfficialFiles": modified,
        "addedPatchFiles": added,
        "removedFiles": removed,
        "officialTreeFileCount": len(original),
        "patchedTreeFileCount": len(after),
        "patchedTreeSha256": tree_sha256(after),
        "fileHashes": after,
    }


def _verify_patched_contracts(source_root: Path, manifest: dict[str, Any]) -> None:
    html = (source_root / "src" / "index.html").read_text(encoding="utf-8")
    app = (source_root / "src" / "app.js").read_text(encoding="utf-8")
    bridge = (source_root / "src" / "patch03-bridge.js").read_text(encoding="utf-8")
    search_module_path = source_root / "src" / "integrated-search.js"
    search_module = search_module_path.read_text(encoding="utf-8")
    if html.count('id="detailDialog"') != 1:
        raise ManagerError("적용 후 공식 #detailDialog가 정확히 하나가 아닙니다.")
    if html.count('option value="integrated"') != 1 or html.count('button data-value="integrated"') != 1:
        raise ManagerError("기존 설정에 통합 항목이 중복되거나 누락됐습니다.")
    if not re.search(r"integrated-search\.js[\s\S]*app\.js[\s\S]*patch03-bridge\.js", html):
        raise ManagerError("통합 검색·공식 앱·브리지 스크립트 순서가 맞지 않습니다.")
    if "providerCatalog" not in bridge or "providerDetail" not in bridge or "providerResolve" not in bridge:
        raise ManagerError("Patch 브리지가 공식 검색·상세·resolve 계약을 재사용하지 않습니다.")
    if "window.lilac.providerCatalog(provider, text)" not in bridge or not any(
        call in bridge for call in ("officialOpenDetail.call(this, id)", "officialOpenDetail.call(this, selectedId)")
    ):
        raise ManagerError("Patch 브리지가 공식 검색/상세 진입 함수를 우회합니다.")
    if "initializeSourceSettings(localStorage)" not in app or "officialSourceForState?.(dinoSourceSettings, savedContentSource)" not in app:
        raise ManagerError("디노 검색 모드 초기화 또는 공식 공급원 안전 대체 연결이 없습니다.")
    if "lilacDinoPatch.searchMode" not in search_module or "saveSourceSelection" not in bridge:
        raise ManagerError("디노 전용 검색 모드 저장 계약이 없습니다.")
    if "localStorage.setItem('contentSource', 'integrated')" in bridge:
        raise ManagerError("디노 통합 모드가 공식 contentSource 키에 저장됩니다.")
    provider_match = re.search(r"const\s+PROVIDERS\s*=\s*\[([^\]]*)\]", search_module)
    declared_providers = re.findall(r"['\"]([^'\"]+)['\"]", provider_match.group(1)) if provider_match else []
    if declared_providers != EXPECTED_PROVIDERS:
        raise ManagerError("통합 검색 공급원 목록이 검증된 다섯 공급원과 일치하지 않습니다.")
    if "linkkf" in declared_providers:
        raise ManagerError("Linkkf가 Patch 03 통합 공급원 목록에 포함되어 있습니다.")


def _node_executable() -> str | None:
    return shutil.which("node")


def run_node_contracts(source_root: Path, project_root: Path = PROJECT_ROOT, *, timeout: int = 120) -> dict[str, Any]:
    node = _node_executable()
    if not node:
        return {"status": "NOT RUN", "reason": "Node.js를 찾지 못해 계약 테스트와 구문 검사를 실행하지 못했습니다."}
    source_cwd = _without_windows_extended_prefix(source_root)
    project_cwd = _without_windows_extended_prefix(project_root)
    for label, cwd in (("원본", source_cwd), ("검증 자산", project_cwd)):
        if os.name == "nt" and len(cwd) >= 260:
            raise ManagerError(f"Node.js {label} 검사 경로가 Windows 프로세스 경로 한계를 넘어 안전하게 실행할 수 없습니다.")
    targets = [
        source_root / "src" / "app.js",
        source_root / "src" / "integrated-search.js",
        source_root / "src" / "patch03-bridge.js",
    ]
    for target in targets:
        relative_target = target.relative_to(source_root).as_posix()
        result = subprocess.run(
            [node, "--check", relative_target], cwd=source_cwd, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=timeout,
            **_hidden_subprocess_options(),
        )
        if result.returncode:
            raise ManagerError(f"JavaScript 구문 검사 실패: {target.name}\n{_redact(result.stderr or result.stdout)}")
    contract = project_root / CONTRACT_TEST_RELATIVE
    if not contract.is_file():
        raise ManagerError("공식 원본용 계약 테스트 파일이 없습니다.")
    env = os.environ.copy()
    env["PATCH03_SOURCE_ROOT"] = source_cwd
    result = subprocess.run(
        [node, "--test", CONTRACT_TEST_RELATIVE.as_posix()], cwd=project_cwd, env=env, capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=timeout,
        **_hidden_subprocess_options(),
    )
    output = _redact((result.stdout or "") + (result.stderr or ""))
    if result.returncode:
        raise ManagerError(f"공식 원본 계약 테스트 실패입니다.\n{output[-6000:]}")
    tests_match = re.search(r"(?:ℹ\s+|#\s*)tests\s+(\d+)", output)
    pass_match = re.search(r"(?:ℹ\s+|#\s*)pass\s+(\d+)", output)
    fail_match = re.search(r"(?:ℹ\s+|#\s*)fail\s+(\d+)", output)
    if not (tests_match and pass_match and fail_match):
        raise ManagerError("계약 테스트가 종료 요약을 만들지 않아 통과 여부를 확정할 수 없습니다.")
    test_count, pass_count, fail_count = (int(tests_match.group(1)), int(pass_match.group(1)), int(fail_match.group(1)))
    if test_count != pass_count + fail_count or fail_count != 0:
        raise ManagerError(f"계약 테스트 요약이 통과 기준과 다릅니다: {pass_count}/{test_count}, 실패 {fail_count}")
    return {
        "status": "PASS",
        "testCount": test_count,
        "passCount": pass_count,
        "failCount": fail_count,
        "output": output,
    }


def _redact(text: str) -> str:
    return re.sub(r"https?://[^\s\"'<>]+", "[URL redacted]", str(text))


def _check_folder_compatibility(source: Path, patch_root: Path, manifest: dict[str, Any], progress: Callable[[str], None] | None) -> dict[str, Any]:
    original = _verify_original_root(source, manifest)
    temp_parent = canonical_path(Path(tempfile.gettempdir()), strict=True)
    if paths_overlap(temp_parent, PROJECT_ROOT):
        raise ManagerError("OS Temp와 개발 프로젝트가 겹쳐 격리 검증을 중단했습니다.")
    validation_root = Path(tempfile.mkdtemp(prefix="dino-patch-compat-", dir=temp_parent))
    try:
        copied = validation_root / "source"
        if progress:
            progress("공식 입력을 OS Temp의 격리 복사본으로 준비합니다.")
        _copy_original_folder(source, copied)
        copied_original = _verify_original_root(copied, manifest)
        if copied_original != original:
            raise ManagerError("격리 복사본이 선택 원본과 달라졌습니다.")
        _apply_connections(copied, manifest)
        _copy_modules(patch_root, copied, manifest)
        patch_result = _verify_patched_tree(copied, original, manifest)
        contract_root = patch_root if IS_FROZEN else PROJECT_ROOT
        node_result = run_node_contracts(copied, contract_root)
        report = {
            "result": "PASS" if node_result["status"] == "PASS" else "ADDITIONAL_CHECK_REQUIRED",
            "sourceKind": "folder",
            "sourceVersion": manifest["officialVersion"],
            "officialCommit": manifest["officialCommit"],
            "officialTreeSha256": manifest["officialTreeSha256"],
            "patchResult": patch_result,
            "contracts": node_result,
            "compatibilityMode": manifest.get("compatibilityMode", "PINNED"),
            "sourceIdentityVerified": bool(manifest.get("sourceIdentityVerified", True)),
            "runtimePlaybackVerified": False,
            "validationRoot": str(validation_root),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        report_file = validation_root / "compatibility-report.json"
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return {**report, "reportPath": str(report_file)}
    except Exception:
        # 검증용 복사본은 이 도구가 만든 OS Temp 경로에만 남긴다. 사용자 원본은 건드리지 않는다.
        raise


def _run_existing_validator(archive: Path, project_root: Path = PROJECT_ROOT, *, electron: bool = False, dependencies_from: str = "") -> dict[str, Any]:
    root = assert_project_root(project_root)
    node = _node_executable()
    if not node:
        raise ManagerError("기존 검증기를 재사용하려면 Node.js가 필요합니다.")
    validator = root / VALIDATOR_RELATIVE
    if not validator.is_file():
        raise ManagerError("기존 공식 원본 검증 스크립트를 찾을 수 없습니다.")
    args = [node, str(validator), "--archive", str(archive)]
    if electron:
        if not dependencies_from:
            raise ManagerError("Electron 외부 검증에는 OS Temp에 준비된 의존성 폴더를 직접 선택해야 합니다.")
        args.extend(["--dependencies-from", dependencies_from, "--run-electron"])
    result = subprocess.run(
        args, cwd=root, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=600, **_hidden_subprocess_options(),
    )
    output = _redact((result.stdout or "") + (result.stderr or ""))
    if result.returncode:
        raise ManagerError(f"기존 원본 검증기가 실패했습니다.\n{output[-8000:]}")
    try:
        info = json.loads(result.stdout)
    except json.JSONDecodeError:
        info = {"output": output}
    return {"status": "PASS", **info, "output": output}


def check_compatibility(
    source_value: str | os.PathLike[str],
    patch_root_value: str | os.PathLike[str],
    *,
    project_root: Path = PROJECT_ROOT,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    assert_project_root(project_root)
    source, kind = assert_safe_source(source_value, project_root)
    target_version = _folder_version_hint(source) if kind == "folder" else None
    patch_root, manifest = load_manifest(patch_root_value, target_version)
    if kind == "archive":
        archive_sha = _sha256_file(source)
        if archive_sha != manifest["officialArchiveSha256"].upper():
            return {
                "status": "ADDITIONAL_CHECK_REQUIRED",
                "result": "ADDITIONAL_CHECK_REQUIRED",
                "kind": kind,
                "path": str(source),
                "archiveSha256": archive_sha,
                "version": None,
                "commit": None,
                "findings": ["아카이브 해시가 고정 기준과 다릅니다. 버전·파일 트리·공식 IPC를 확인하기 전까지 적용할 수 없습니다."],
                "applyAuthorized": False,
            }
        # 기존 검증기는 개발 프로젝트 manifest의 연결 절차, 반복 적용, 계약 테스트를 그대로 실행한다.
        if _norm(patch_root) == _norm(assert_project_root(project_root)):
            if progress:
                progress("기존 깨끗한 원본 검증기를 실행합니다. 설치 명령과 Electron 실행은 포함하지 않습니다.")
            return _run_existing_validator(source, project_root)
        raise ManagerError("선택한 패치 구성은 고정 검증기와 다른 위치입니다. 압축 해제 폴더를 선택하면 그 manifest 기준으로 검사할 수 있습니다.")
    compatibility_mode = "PINNED" if manifest.get("_profilePinned") else "STRUCTURAL"
    try:
        if compatibility_mode == "STRUCTURAL":
            manifest = _resolve_structural_source_manifest(source, patch_root, manifest, str(target_version or ""))
        result = inspect_source(source, manifest, project_root)
    except CompatibilityBlocked as exc:
        return {
            "status": exc.status,
            "result": exc.status,
            "kind": kind,
            "path": str(source),
            "version": target_version,
            "findings": [str(exc)],
            "applyAuthorized": False,
            "compatibilityMode": compatibility_mode,
            "sourceIdentityVerified": False,
            "runtimePlaybackVerified": False,
        }
    except ManagerError as exc:
        message = str(exc)
        if compatibility_mode == "PINNED" and ("지원 기준 버전은" in message or "공식 원본 파일 수가 다릅니다" in message or "공식 원본 파일 트리 SHA-256 불일치" in message):
            return inspect_unpinned_folder(source, manifest)
        if compatibility_mode == "STRUCTURAL":
            return {
                "status": "UNSUPPORTED",
                "result": "UNSUPPORTED",
                "kind": kind,
                "path": str(source),
                "version": target_version,
                "findings": [message],
                "applyAuthorized": False,
                "compatibilityMode": compatibility_mode,
                "sourceIdentityVerified": False,
                "runtimePlaybackVerified": False,
            }
        raise
    if progress:
        progress("공식 파일 트리와 연결 계약을 확인하고, OS Temp 복사본에 패치를 미리 적용합니다.")
    test_result = _check_folder_compatibility(source, patch_root, manifest, progress)
    authorized = test_result["result"] == "PASS"
    return {
        **result,
        **test_result,
        "status": test_result["result"],
        "applyAuthorized": authorized,
        "compatibilityMode": manifest.get("compatibilityMode", "PINNED"),
        "sourceIdentityVerified": bool(manifest.get("sourceIdentityVerified", True)),
        "runtimePlaybackVerified": bool(manifest.get("runtimePlaybackVerified", False)),
    }


def _preview(source_root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    changes = []
    for connection in manifest["connections"]:
        path = _module_path(source_root, connection["file"])
        original = path.read_bytes().decode("utf-8")
        updated = _replace_exactly(path.read_bytes(), connection["before"], connection["after"], connection["description"]).decode("utf-8")
        diff = "".join(difflib.unified_diff(
            original.splitlines(keepends=True), updated.splitlines(keepends=True),
            fromfile=f"공식/{connection['file']}", tofile=f"패치 적용/{connection['file']}",
        ))
        changes.append({"file": connection["file"], "description": connection["description"], "diff": diff})
    return {
        "modified": sorted(manifest["officialRuntimeModifiedAllowlist"]),
        "added": sorted(item["destination"] for item in manifest["runtimeModules"]),
        "otherOfficialRuntimeFiles": [],
        "connections": changes,
    }


def preview_changes(source_value: str | os.PathLike[str], patch_root_value: str | os.PathLike[str], *, project_root: Path = PROJECT_ROOT) -> dict[str, Any]:
    assert_project_root(project_root)
    source, kind = assert_safe_source(source_value, project_root)
    target_version = _folder_version_hint(source) if kind == "folder" else None
    patch_root, manifest = load_manifest(patch_root_value, target_version)
    if kind == "folder":
        if not manifest.get("_profilePinned"):
            manifest = _resolve_structural_source_manifest(source, patch_root, manifest, str(target_version or ""))
        _verify_original_root(source, manifest)
        return {**_preview(source, manifest), "compatibilityMode": manifest.get("compatibilityMode", "PINNED"), "sourceIdentityVerified": bool(manifest.get("sourceIdentityVerified", True))}
    if _sha256_file(source) != manifest["officialArchiveSha256"].upper():
        raise ManagerError("공식 아카이브 SHA-256이 일치하지 않아 변경 미리보기를 만들 수 없습니다.")
    temp_parent = canonical_path(Path(tempfile.gettempdir()), strict=True)
    if paths_overlap(temp_parent, project_root):
        raise ManagerError("OS Temp와 개발 프로젝트가 겹쳐 미리보기를 중단했습니다.")
    root = Path(tempfile.mkdtemp(prefix="dino-patch-preview-", dir=temp_parent))
    extracted = _extract_archive(source, root / "extract", manifest)
    _verify_original_root(extracted, manifest)
    result = _preview(extracted, manifest)
    result["previewRoot"] = str(root)
    return result


def apply_patch(
    source_value: str | os.PathLike[str],
    patch_root_value: str | os.PathLike[str],
    output_value: str | os.PathLike[str],
    *,
    project_root: Path = PROJECT_ROOT,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    root = assert_project_root(project_root)
    source, kind = assert_safe_source(source_value, root)
    target_version = _folder_version_hint(source) if kind == "folder" else None
    patch_root, manifest = load_manifest(patch_root_value, target_version)
    if kind == "folder" and not manifest.get("_profilePinned"):
        manifest = _resolve_structural_source_manifest(source, patch_root, manifest, str(target_version or ""))
    output = assert_safe_output(output_value, source, kind, root)
    source_info = inspect_source(source, manifest, root)
    if progress:
        progress("입력, manifest, SHA-256, 출력 보호 경로를 통과했습니다.")

    # 같은 볼륨의 새 형제 임시 폴더에서 복사·검증 후에만 최종 이름으로 확정한다.
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.dino-stage-", dir=output.parent))
    work_source = stage / "content"
    try:
        if progress:
            progress(f"임시 검증본 준비: {stage}")
        if kind == "archive":
            archive_sha = _sha256_file(source)
            if archive_sha != manifest["officialArchiveSha256"].upper():
                raise ManagerError("적용 직전 공식 아카이브 SHA-256이 바뀌었습니다.")
            extracted = _extract_archive(source, stage / "extracted", manifest)
            if not work_source.exists():
                work_source.parent.mkdir(parents=True, exist_ok=True)
                os.rename(extracted, work_source)
                try:
                    (stage / "extracted").rmdir()
                except OSError:
                    pass
        else:
            work_source = _copy_original_folder(source, work_source)
        original = _verify_original_root(work_source, manifest)
        if progress:
            progress("공식 원본 144개 파일 지문과 공식 IPC 계약을 확인했습니다.")
        _apply_connections(work_source, manifest)
        _copy_modules(patch_root, work_source, manifest)
        verification = _verify_patched_tree(work_source, original, manifest)
        if progress:
            progress("변경 파일 allowlist와 Patch 03 공식 호출 경계 검사를 통과했습니다.")
        contract_result = run_node_contracts(work_source, root)
        if contract_result["status"] != "PASS":
            raise ManagerError(contract_result["reason"])
        if progress:
            progress(f"공식 원본 계약 테스트 {contract_result['passCount']}/{contract_result['testCount']} 통과했습니다.")
        if output.exists():
            raise ManagerError("검증 중 출력 경로가 생성되어 적용을 중단했습니다. 기존 경로는 건드리지 않았습니다.")

        report = {
            "result": "PASS",
            "officialRepository": manifest["officialRepository"],
            "officialVersion": manifest["officialVersion"],
            "officialCommit": manifest["officialCommit"],
            "source": source_info,
            "patchRoot": str(patch_root),
            "modifiedOfficialFiles": verification["modifiedOfficialFiles"],
            "addedPatchFiles": verification["addedPatchFiles"],
            "removedFiles": verification["removedFiles"],
            "originalFilesUnchanged": True,
            "sha256": {
                "officialTree": manifest["officialTreeSha256"],
                "patchedTree": verification["patchedTreeSha256"],
                "patchModules": {item["destination"]: item["sha256"] for item in manifest["runtimeModules"]},
            },
            "contracts": {
                "status": contract_result["status"],
                "passCount": contract_result["passCount"],
                "failCount": contract_result["failCount"],
            },
            "output": str(output),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        # Report JSON is a sidecar; it is never added to the LilacAnime runtime tree.
        report_path = _unique_report_path(output)
        if progress:
            progress("검증을 마친 출력 폴더를 새 경로로 확정합니다.")
        os.rename(work_source, output)
        report["outputPostMoveSha256"] = tree_sha256(_inventory(output))
        try:
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            report["reportPath"] = str(report_path)
        except OSError as exc:
            # 최종 폴더는 이미 검증 후 확정됐다. 보고서 쓰기 실패 때문에 결과를 실패로 오인시키지 않는다.
            report["reportPath"] = None
            report["reportWarning"] = f"적용은 완료됐지만 별도 보고서 저장에 실패했습니다: {exc}"
        try:
            stage.rmdir()
        except OSError:
            pass
        return report
    except Exception as exc:
        # 부분 복사본은 명시된 임시 경로에 남긴다. 사용자 자료를 자동 삭제하지 않는다.
        if isinstance(exc, ManagerError):
            exc.add_note(f"임시 검증본 보존 위치: {stage}")
            raise
        wrapped = ManagerError(f"적용에 실패했습니다: {exc}\n임시 검증본은 보존했습니다: {stage}")
        raise wrapped from exc


def _unique_report_path(output: Path) -> Path:
    base = output.parent / f"{output.name}.dino-patch-report.json"
    if not base.exists():
        return base
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for suffix in range(1, 1000):
        candidate = output.parent / f"{output.name}.dino-patch-report-{stamp}-{suffix}.json"
        if not candidate.exists():
            return candidate
    raise ManagerError("결과 보고서용 고유 경로를 만들 수 없습니다.")


def existing_validator(
    archive_value: str | os.PathLike[str],
    *,
    project_root: Path = PROJECT_ROOT,
    electron: bool = False,
    dependencies_from: str = "",
) -> dict[str, Any]:
    archive = canonical_path(archive_value, strict=True)
    if not archive.is_file():
        raise ManagerError("검증 입력은 공식 원본 아카이브 파일이어야 합니다.")
    return _run_existing_validator(archive, project_root, electron=electron, dependencies_from=dependencies_from)


def _package_info(root: Path) -> dict[str, Any]:
    package_path = root / "package.json"
    if not package_path.is_file():
        raise ManagerError("선택한 폴더에 공식 package.json이 없습니다.")
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagerError(f"package.json을 읽을 수 없습니다: {exc}") from exc
    if not isinstance(package, dict):
        raise ManagerError("package.json 최상위 값이 JSON 객체가 아닙니다.")
    if not (root / "src" / "app.js").is_file() or not (root / "electron" / "main.cjs").is_file():
        raise ManagerError("이 폴더는 지원되는 LilacAnime 소스 구조가 아닙니다. 패키지 설치본이나 app.asar 구조는 지원하지 않습니다.")
    build = package.get("build") if isinstance(package.get("build"), dict) else {}
    app_id = str(build.get("appId") or package.get("appId") or "")
    product = str(build.get("productName") or package.get("productName") or "")
    if app_id != "com.lilac.anime.desktop" and product.casefold() != "lilacanime":
        raise ManagerError("package.json의 앱 식별 정보가 공식 LilacAnime와 일치하지 않습니다.")
    return package


def _folder_version_hint(root: Path) -> str | None:
    """Read only the version string to select a profile; full identity and tree checks follow."""
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(package, dict) or not isinstance(package.get("version"), str):
        return None
    return package["version"]


def find_original_root(start: str | os.PathLike[str] | None = None, *, max_levels: int = 8) -> Path | None:
    """Search parents of this program for an unpacked LilacAnime source tree."""
    anchor = canonical_path(start or manager_home())
    if anchor.is_file():
        anchor = anchor.parent
    current = anchor
    for _ in range(max_levels + 1):
        try:
            _package_info(current)
            return current
        except ManagerError:
            pass
        if current.parent == current:
            break
        current = current.parent
    return None


def _manager_data_root(root: Path) -> Path:
    manager_dir = root / MANAGER_FOLDER_NAME
    if _is_link_or_junction(manager_dir):
        raise ManagerError("DinoPatchManager 경로가 심볼릭 링크/정션입니다. 안전을 위해 중단했습니다.")
    if not same_or_within(canonical_path(manager_dir), root):
        raise ManagerError("관리자 데이터 경로가 원본 폴더 밖을 가리킵니다.")
    return _windows_extended_path(manager_dir)


def _manager_data_path(root: Path, relative: Path) -> Path:
    base = _manager_data_root(root)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise ManagerError("관리자 상태/백업 경로가 잘못됐습니다.")
    target = base / relative
    current = base
    for part in relative.parts:
        current = current / part
        if _is_link_or_junction(current):
            raise ManagerError(f"관리자 상태/백업 경로에 심볼릭 링크가 있습니다: {current}")
    resolved = canonical_path(target)
    if not same_or_within(resolved, base):
        raise ManagerError("관리자 상태/백업 경로가 보호 폴더 밖을 가리킵니다.")
    return _windows_extended_path(target)


def _state_path(root: Path) -> Path:
    return _manager_data_path(root, PATCH_STATE_RELATIVE)


def _source_update_journal_path(root: Path) -> Path:
    return _manager_data_path(root, Path("state") / "source-update-pending.json")


def _history_path(root: Path) -> Path:
    return _manager_data_path(root, PATCH_HISTORY_RELATIVE)


def _read_json_file(path: Path, description: str) -> dict[str, Any]:
    try:
        data = json.loads(_windows_extended_path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagerError(f"{description}을 읽을 수 없습니다: {exc}") from exc
    if not isinstance(data, dict):
        raise ManagerError(f"{description} 형식이 올바르지 않습니다.")
    return data


def _atomic_write(path: Path, data: bytes) -> None:
    path = Path(path)
    temporary = path.with_name(f".{path.name}.dino-{os.getpid()}-{time.time_ns()}.tmp")
    force_extended = os.name == "nt" and len(os.path.abspath(os.fspath(temporary))) >= 240
    path = _windows_extended_path(path, force=force_extended)
    temporary = _windows_extended_path(temporary, force=force_extended)
    try:
        temporary.parent.mkdir(parents=True, exist_ok=True)
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    encoded = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _atomic_write(path, encoded)


def _append_history(root: Path, record: dict[str, Any]) -> None:
    path = _windows_extended_path(_history_path(root))
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(descriptor, "ab") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())


def read_history(root_value: str | os.PathLike[str], *, limit: int = 100) -> list[dict[str, Any]]:
    root = canonical_path(root_value, strict=True)
    path = _history_path(root)
    if not path.is_file():
        return []
    records: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines()[-max(1, min(limit, 500)):]:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                records.append(record)
    except OSError as exc:
        raise ManagerError(f"작업 기록을 읽을 수 없습니다: {exc}") from exc
    return records


def _assert_managed_target(root: Path, *, package_mode: bool = IS_FROZEN) -> dict[str, Any]:
    root = canonical_path(root, strict=True)
    if not root.is_dir() or _is_unc(root) or not root.drive:
        raise ManagerError("원본은 로컬 드라이브의 실제 폴더여야 합니다. 네트워크 경로는 지원하지 않습니다.")
    package = _package_info(root)
    if not IS_FROZEN:
        expected_development = canonical_path(EXPECTED_PROJECT_ROOT)
        if paths_overlap(root, expected_development):
            raise ManagerError("개발 프로젝트는 자동 적용 대상이 아닙니다. 공식 원본 폴더를 선택하세요.")
    if not package_mode and paths_overlap(root, Path(r"D:\LilacAnime")):
        raise ManagerError("현재 설치된 LilacAnime 경로는 이 개발 실행에서 보호됩니다. 배포 관리자를 원본 폴더 안에서 실행하세요.")
    if package_mode:
        expected_manager = canonical_path(root / MANAGER_FOLDER_NAME)
        if not same_or_within(manager_home(), expected_manager):
            raise ManagerError("패키지 관리자는 선택한 원본의 DinoPatchManager 폴더 안에서 실행해야 합니다.")
    protected_names = ("APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "WINDIR")
    for key in protected_names:
        value = os.environ.get(key)
        if value:
            protected = canonical_path(value)
            if paths_overlap(root, protected):
                raise ManagerError(f"시스템·앱 데이터 보호 경로에는 직접 적용할 수 없습니다: {key}")
    return package


def _target_state(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    if _source_update_journal_path(root).is_file():
        return {
            "status": "PARTIAL_OR_UNKNOWN",
            "reason": "공식 소스 변경 후 자동 재적용 작업이 이어지는 중입니다. 자동 복구 확인 전에는 파일 변경을 허용하지 않습니다.",
        }
    state_path = _state_path(root)
    if state_path.is_file():
        state = _read_json_file(state_path, "패치 상태 기록")
        if state.get("patchVersion") != manifest.get("patchVersion", PATCH_VERSION):
            return {"status": "UNSUPPORTED_STATE", "reason": "현재 관리자와 기록된 패치 버전이 다릅니다.", "state": state}
        if state.get("officialCommit") != manifest["officialCommit"]:
            return {"status": "UNSUPPORTED_STATE", "reason": "패치 상태 기록의 공식 기준 커밋이 다릅니다.", "state": state}
        if manifest.get("compatibilityMode") == "STRUCTURAL" and state.get("officialGitTreeSha") != manifest.get("officialGitTreeSha"):
            return {"status": "UNSUPPORTED_STATE", "reason": "패치 상태 기록의 공식 Git 트리 지문이 다릅니다.", "state": state}
        if state.get("status") == "APPLIED":
            actual = _inventory(root)
            if actual == state.get("afterFileHashes"):
                return {"status": "APPLIED", "state": state, "treeSha256": tree_sha256(actual)}
            return {"status": "CONFLICT", "state": state, "reason": "패치 적용 후 원본 파일이 바뀌었거나 예상하지 못한 파일이 있습니다."}
        if state.get("status") == "UNPATCHED":
            files = _verify_original_root(root, manifest)
            return {"status": "UNPATCHED", "state": state, "treeSha256": tree_sha256(files), "sourceFileCount": len(files)}
        return {"status": "UNSUPPORTED_STATE", "reason": "기록된 패치 상태를 안전하게 인식할 수 없습니다.", "state": state}

    destinations = {item["destination"] for item in manifest["runtimeModules"]}
    installed = sorted(path for path in destinations if (root / Path(*path.split("/"))).exists())
    applied_anchors = []
    for item in manifest["connections"]:
        target = _module_path(root, item["file"])
        if item["after"].encode("utf-8") in target.read_bytes():
            applied_anchors.append(item["file"])
    if installed or applied_anchors:
        return {"status": "PARTIAL_OR_UNKNOWN", "reason": "패치 상태 기록 없이 패치 연결 또는 모듈 일부가 발견됐습니다. 자동 적용을 중단했습니다."}
    files = _verify_original_root(root, manifest)
    return {"status": "UNPATCHED", "state": None, "treeSha256": tree_sha256(files), "sourceFileCount": len(files)}


def inspect_managed_target(root_value: str | os.PathLike[str], patch_root_value: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    root = canonical_path(root_value, strict=True)
    package = _assert_managed_target(root)
    try:
        patch_root, manifest = _load_manifest_for_target(root, patch_root_value)
    except CompatibilityBlocked as exc:
        return {
            "status": exc.status,
            "path": str(root),
            "version": str(package.get("version", "unknown")),
            "patchVersion": PATCH_VERSION,
            "reason": str(exc),
            "compatibilityMode": "STRUCTURAL",
            "sourceIdentityVerified": False,
            "runtimePlaybackVerified": False,
        }
    target = _target_state(root, manifest)
    return {
        **target,
        "path": str(root),
        "version": str(package.get("version", "unknown")),
        "patchVersion": manifest.get("patchVersion", PATCH_VERSION),
        "officialCommit": manifest["officialCommit"],
        "patchRoot": str(patch_root),
        "compatibilityMode": manifest.get("compatibilityMode", "PINNED"),
        "officialGitTreeSha": manifest.get("officialGitTreeSha"),
        "sourceIdentityVerified": bool(manifest.get("sourceIdentityVerified", True)),
        "runtimePlaybackVerified": bool(manifest.get("runtimePlaybackVerified", False)),
        "manualUninstall": bool(target.get("state", {}).get("manualUninstall")) if isinstance(target.get("state"), dict) else False,
        "contractEvidence": manifest.get("_contractEvidence"),
    }


def assert_app_not_running(root: Path, *, runner: Callable[..., Any] = subprocess.run) -> None:
    if os.name != "nt":
        return
    try:
        package = _package_info(root)
        build = package.get("build") if isinstance(package.get("build"), dict) else {}
        app_name = str(build.get("productName") or package.get("productName") or "LilacAnime")
        script = (
            "$root=[IO.Path]::GetFullPath($env:DINO_TARGET_ROOT).TrimEnd('\\');"
            "$app=$env:DINO_APP_NAME+'.exe';"
            "$hits=Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {"
            "($_.Name -ieq $app -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or "
            "($_.Name -ieq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0)"
            "}; if($hits){$hits | ForEach-Object { '{0}:{1}' -f $_.Name,$_.ProcessId }}"
        )
        env = os.environ.copy()
        env["DINO_TARGET_ROOT"] = str(root)
        env["DINO_APP_NAME"] = app_name
        completed = runner(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8, env=env,
            **_hidden_subprocess_options(),
        )
    except Exception as exc:
        raise ManagerError(f"LilacAnime 실행 상태를 확인하지 못해 파일 변경을 중단했습니다: {type(exc).__name__}") from exc
    if completed.returncode != 0:
        raise ManagerError("Windows 프로세스 조회가 실패해 LilacAnime 실행 여부를 확인하지 못했습니다. 앱을 닫은 뒤 다시 시도하세요.")
    active = str(completed.stdout or "").strip()
    if active:
        raise ManagerError(f"LilacAnime가 실행 중입니다 ({active}). 앱을 완전히 종료한 뒤 관리자에서 다시 확인하세요.")


def _acquire_operation_lock(root: Path) -> tuple[Path, int]:
    state_dir = _manager_data_path(root, Path("state"))
    state_dir.mkdir(parents=True, exist_ok=True)
    lock = _manager_data_path(root, Path("state") / "operation.lock")
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise ManagerError("이미 패치 작업이 진행 중입니다. 중복 작업을 시작하지 않았습니다.") from exc
    os.write(descriptor, json.dumps({"pid": os.getpid(), "createdAt": datetime.now(timezone.utc).isoformat()}).encode("utf-8"))
    os.fsync(descriptor)
    return lock, descriptor


def _release_operation_lock(lock: Path, descriptor: int) -> None:
    try:
        os.close(descriptor)
    except OSError:
        pass
    try:
        lock.unlink()
    except FileNotFoundError:
        pass


def _make_backup(
    root: Path,
    backup_id: str,
    before_hashes: dict[str, str],
    after_hashes: dict[str, str],
    manifest: dict[str, Any],
    touched_paths: list[str],
) -> dict[str, Any]:
    backup_root = _manager_data_path(root, Path("backups") / backup_id)
    backup_root.mkdir(parents=True, exist_ok=False)
    backup_root = _manager_data_path(root, Path("backups") / backup_id)
    files: list[dict[str, Any]] = []
    for relative in sorted(set(touched_paths)):
        _safe_relative(relative)
        before = _module_path(root, relative)
        existed = relative in before_hashes
        backup_relative = f"original/{relative}" if existed else None
        if existed:
            backup_path = _manager_data_path(root, Path("backups") / backup_id / backup_relative)
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(before, backup_path)
            if _sha256_file(backup_path) != before_hashes[relative]:
                raise ManagerError(f"백업 사본 SHA-256 검증 실패: {relative}")
        files.append({
            "path": relative,
            "existedBefore": existed,
            "backupPath": backup_relative,
            "beforeSha256": before_hashes.get(relative),
            "afterSha256": after_hashes.get(relative),
        })
    backup = {
        "schemaVersion": 1,
        "id": backup_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "officialVersion": manifest["officialVersion"],
        "officialCommit": manifest["officialCommit"],
        "officialGitTreeSha": manifest.get("officialGitTreeSha"),
        "compatibilityMode": manifest.get("compatibilityMode", "PINNED"),
        "patchVersion": manifest.get("patchVersion", PATCH_VERSION),
        "beforeTreeSha256": tree_sha256(before_hashes),
        "afterTreeSha256": tree_sha256(after_hashes),
        "beforeFileHashes": before_hashes,
        "afterFileHashes": after_hashes,
        "files": files,
        "restorable": True,
    }
    _atomic_write_json(_manager_data_path(root, Path("backups") / backup_id / "backup.json"), backup)
    return backup


def list_backups(root_value: str | os.PathLike[str]) -> list[dict[str, Any]]:
    root = canonical_path(root_value, strict=True)
    backup_dir = _manager_data_path(root, Path("backups"))
    extended_backup_dir = _windows_extended_path(backup_dir, force=True)
    try:
        backup_dir_stat = extended_backup_dir.stat()
    except FileNotFoundError:
        return []
    except OSError as exc:
        error_code = getattr(exc, "winerror", None)
        detail = f"WinError {error_code}" if error_code else type(exc).__name__
        raise ManagerError(f"백업 폴더를 확인할 수 없어 목록 조회를 중단했습니다 ({detail}).") from exc
    if not stat.S_ISDIR(backup_dir_stat.st_mode):
        raise ManagerError("백업 경로가 폴더가 아니어서 목록을 확인할 수 없습니다.")

    try:
        with os.scandir(extended_backup_dir) as entries:
            children = sorted(entries, key=lambda entry: entry.name, reverse=True)
    except OSError as exc:
        error_code = getattr(exc, "winerror", None)
        detail = f"WinError {error_code}" if error_code else type(exc).__name__
        raise ManagerError(f"백업 폴더 내용을 읽을 수 없어 목록 조회를 중단했습니다 ({detail}).") from exc

    result: list[dict[str, Any]] = []
    for entry in children:
        child = _windows_extended_path(backup_dir / entry.name, force=True)
        if _is_link_or_junction(child):
            continue
        try:
            child_stat = child.stat()
        except OSError as exc:
            error_code = getattr(exc, "winerror", None)
            detail = f"WinError {error_code}" if error_code else type(exc).__name__
            raise ManagerError(f"백업 폴더 항목을 확인할 수 없어 목록 조회를 중단했습니다 ({detail}).") from exc
        if not stat.S_ISDIR(child_stat.st_mode):
            continue

        if not re.fullmatch(r"[A-Za-z0-9T._-]{8,80}", entry.name):
            raise ManagerError("백업 폴더에 올바르지 않은 백업 ID가 있어 목록을 확인할 수 없습니다.")
        metadata = _manager_data_path(root, Path("backups") / entry.name / "backup.json")
        try:
            metadata_stat = metadata.stat()
        except OSError as exc:
            error_code = getattr(exc, "winerror", None)
            detail = f"WinError {error_code}" if error_code else type(exc).__name__
            raise ManagerError(f"백업 {entry.name}의 메타데이터를 확인할 수 없어 전체 목록 조회를 중단했습니다 ({detail}).") from exc
        if not stat.S_ISREG(metadata_stat.st_mode):
            raise ManagerError(f"백업 {entry.name}의 메타데이터 파일 형식이 올바르지 않습니다.")
        try:
            value = _read_json_file(metadata, "백업 정보")
        except (ManagerError, UnicodeError) as exc:
            raise ManagerError(f"백업 {entry.name} 정보를 읽을 수 없어 전체 목록 조회를 중단했습니다.") from exc
        if value.get("id") != entry.name:
            raise ManagerError(f"백업 폴더와 메타데이터 ID가 일치하지 않아 목록을 확인할 수 없습니다: {entry.name}")
        result.append(value)
    return result


def _restore_backup_files(root: Path, backup: dict[str, Any], manifest: dict[str, Any], *, operation: str) -> dict[str, Any]:
    backup_id = str(backup.get("id", ""))
    if not re.fullmatch(r"[A-Za-z0-9T._-]{8,80}", backup_id):
        raise ManagerError("백업 ID 형식이 잘못됐습니다.")
    backup_root = _manager_data_path(root, Path("backups") / backup_id)
    if not same_or_within(backup_root, _manager_data_path(root, Path("backups"))):
        raise ManagerError("백업 경로가 관리자 백업 폴더 밖을 가리킵니다.")
    if backup.get("officialCommit") != manifest.get("officialCommit") or backup.get("patchVersion") != manifest.get("patchVersion", PATCH_VERSION):
        raise ManagerError("백업의 공식 커밋 또는 패치 버전이 현재 관리자와 다릅니다.")
    if backup.get("officialVersion") != manifest.get("officialVersion"):
        raise ManagerError("백업의 공식 버전이 현재 지원 기준과 다릅니다.")
    if manifest.get("compatibilityMode") == "STRUCTURAL" and backup.get("officialGitTreeSha") != manifest.get("officialGitTreeSha"):
        raise ManagerError("백업의 공식 Git 트리 지문이 현재 구조 검증 결과와 다릅니다.")
    before_hashes = backup.get("beforeFileHashes")
    after_hashes = backup.get("afterFileHashes")
    entries = backup.get("files")
    if not isinstance(before_hashes, dict) or not isinstance(after_hashes, dict) or not isinstance(entries, list):
        raise ManagerError("백업 파일 목록이나 해시 정보가 없습니다.")
    if any(not isinstance(item, dict) for item in entries):
        raise ManagerError("백업의 파일 항목 형식이 올바르지 않습니다.")
    expected_files = sorted(set(manifest["officialRuntimeModifiedAllowlist"]) | {item["destination"] for item in manifest["runtimeModules"]})
    if sorted(_safe_relative(item.get("path")) for item in entries) != expected_files:
        raise ManagerError("백업 대상 파일 목록이 현재 manifest의 허용 범위와 다릅니다.")
    for hashes, label in ((before_hashes, "복원 전"), (after_hashes, "적용 후")):
        if any(not isinstance(path, str) or not re.fullmatch(r"[0-9A-F]{64}", str(digest), re.I) for path, digest in hashes.items()):
            raise ManagerError(f"백업의 {label} 파일 지문 형식이 잘못됐습니다.")
    if tree_sha256(before_hashes) != manifest["officialTreeSha256"].upper():
        raise ManagerError("백업의 복원 전 트리가 고정 공식 원본과 일치하지 않습니다.")
    before_paths = set(before_hashes)
    after_paths = set(after_hashes)
    added = {item["destination"] for item in manifest["runtimeModules"]}
    allowed_modified = set(manifest["officialRuntimeModifiedAllowlist"])
    modified = {path for path in before_paths & after_paths if before_hashes[path] != after_hashes[path]}
    if after_paths - before_paths != added or before_paths - after_paths or modified != allowed_modified:
        raise ManagerError("백업의 변경 파일 집합이 manifest 허용 범위와 다릅니다.")
    if tree_sha256(after_hashes) != backup.get("afterTreeSha256"):
        raise ManagerError("백업의 적용 후 트리 지문이 metadata와 일치하지 않습니다.")
    if set(after_hashes) != after_paths or any(
        not isinstance(value, str) or not re.fullmatch(r"[0-9A-F]{64}", value, re.I)
        for value in after_hashes.values()
    ):
        raise ManagerError("백업의 적용 후 파일 지문 형식이 잘못됐습니다.")
    backup_meta_path = _manager_data_path(root, Path("backups") / backup_id / "backup.json")
    state_path = _state_path(root)
    old_backup_meta = backup_meta_path.read_bytes()
    old_state = state_path.read_bytes() if state_path.is_file() else None
    current = _inventory(root)
    if current != after_hashes:
        raise ManagerError("현재 파일이 백업 생성 시점의 패치 적용 결과와 다릅니다. 사용자 변경을 덮어쓰지 않도록 복원을 중단했습니다.")
    restore_data: dict[str, bytes | None] = {}
    for entry in entries:
        relative = _safe_relative(entry.get("path"))
        current_path = _module_path(root, relative)
        if entry.get("existedBefore"):
            backup_relative = _safe_relative(entry.get("backupPath"))
            backup_path = _manager_data_path(root, Path("backups") / backup_id / backup_relative)
            if not same_or_within(backup_path, backup_root) or not backup_path.is_file():
                raise ManagerError(f"복원 원본 파일이 없거나 백업 밖을 가리킵니다: {relative}")
            content = backup_path.read_bytes()
            if _sha256_file(backup_path) != entry.get("beforeSha256"):
                raise ManagerError(f"백업 파일 SHA-256이 기록과 다릅니다: {relative}")
            restore_data[relative] = content
        else:
            if current_path.exists() and _sha256_file(current_path) != entry.get("afterSha256"):
                raise ManagerError(f"관리자가 추가한 파일이 바뀌었습니다. 삭제하지 않습니다: {relative}")
            restore_data[relative] = None

    snapshot = {relative: (root.joinpath(*relative.split("/")).read_bytes() if root.joinpath(*relative.split("/")).is_file() else None) for relative in restore_data}
    changed: list[str] = []
    try:
        for relative, content in restore_data.items():
            destination = _module_path(root, relative)
            if content is None:
                if destination.exists():
                    destination.unlink()
            else:
                _atomic_write(destination, content)
            changed.append(relative)
        if _inventory(root) != before_hashes:
            raise ManagerError("복원 후 원본 파일 트리가 백업된 기준과 일치하지 않습니다.")
    except Exception as exc:
        rollback_errors = []
        for relative in reversed(changed):
            destination = _module_path(root, relative)
            try:
                old = snapshot[relative]
                if old is None:
                    if destination.exists():
                        destination.unlink()
                else:
                    _atomic_write(destination, old)
            except Exception as rollback_exc:
                rollback_errors.append(f"{relative}: {type(rollback_exc).__name__}")
        detail = f"원상 복원 중 오류: {exc}"
        if rollback_errors:
            detail += "\n자동 되돌리기 일부 실패: " + ", ".join(rollback_errors)
        detail += f"\n보존된 백업: {backup_root}"
        raise ManagerError(detail) from exc

    backup["restorable"] = False
    backup["restoredAt"] = datetime.now(timezone.utc).isoformat()
    previous_state: dict[str, Any] = {}
    if old_state is not None:
        try:
            previous_state = json.loads(old_state.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            previous_state = {}
    new_state = {
        "schemaVersion": 1,
        "status": "UNPATCHED",
        "officialVersion": backup["officialVersion"],
        "officialCommit": backup["officialCommit"],
        "officialGitTreeSha": backup.get("officialGitTreeSha"),
        "compatibilityMode": backup.get("compatibilityMode", "PINNED"),
        "patchVersion": backup["patchVersion"],
        "lastBackupId": backup_id,
        "sourceTreeSha256": backup["beforeTreeSha256"],
        "sourceFileCount": len(before_hashes),
        "restoredAt": datetime.now(timezone.utc).isoformat(),
        "previousState": previous_state.get("status"),
        "manualUninstall": operation == "PATCH_UNINSTALL",
    }
    try:
        _atomic_write_json(state_path, new_state)
        _atomic_write_json(backup_root / "backup.json", backup)
    except Exception as exc:
        rollback_errors = []
        for relative in reversed(list(restore_data)):
            destination = _module_path(root, relative)
            try:
                old = snapshot[relative]
                if old is None:
                    if destination.exists():
                        destination.unlink()
                else:
                    _atomic_write(destination, old)
            except Exception as rollback_exc:
                rollback_errors.append(f"{relative}: {type(rollback_exc).__name__}")
        try:
            _atomic_write(backup_meta_path, old_backup_meta)
            if old_state is None:
                state_path.unlink(missing_ok=True)
            else:
                _atomic_write(state_path, old_state)
        except Exception as rollback_exc:
            rollback_errors.append(f"manager state: {type(rollback_exc).__name__}")
        detail = f"복원 상태를 기록하지 못해 파일 변경을 되돌렸습니다: {type(exc).__name__}"
        if rollback_errors:
            detail += "\n되돌리기 일부 실패: " + ", ".join(rollback_errors)
        raise ManagerError(detail) from exc
    record = {
        "action": operation,
        "result": "PASS",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "backupId": backup_id,
        "files": [entry["path"] for entry in entries],
    }
    try:
        _append_history(root, record)
    except OSError:
        record["historyWarning"] = "작업 기록 파일을 갱신하지 못했습니다. 백업 및 상태 기록은 유지됩니다."
    return {"status": "RESTORED", **record}


def apply_patch_in_place(
    root_value: str | os.PathLike[str],
    patch_root_value: str | os.PathLike[str] | None = None,
    *,
    progress: Callable[[str], None] | None = None,
    process_check: Callable[[Path], None] = assert_app_not_running,
) -> dict[str, Any]:
    """Back up and transactionally apply Patch 03 to a verified source folder."""
    root = canonical_path(root_value, strict=True)
    package = _assert_managed_target(root)
    patch_root, manifest = _load_manifest_for_target(root, patch_root_value)
    state = _target_state(root, manifest)
    if state["status"] == "APPLIED":
        return {"status": "ALREADY_APPLIED", "path": str(root), "treeSha256": state.get("treeSha256"), "version": package.get("version"), "patchVersion": manifest.get("patchVersion", PATCH_VERSION)}
    if state["status"] != "UNPATCHED":
        raise ManagerError(str(state.get("reason") or f"현재 패치 상태는 {state['status']}이며 자동 변경을 허용하지 않습니다."))

    lock, descriptor = _acquire_operation_lock(root)
    try:
        process_check(root)
        # Re-check after acquiring the lock in case another manager instance changed the tree.
        state = _target_state(root, manifest)
        if state["status"] != "UNPATCHED":
            if state["status"] == "APPLIED":
                return {"status": "ALREADY_APPLIED", "path": str(root), "treeSha256": state.get("treeSha256")}
            raise ManagerError(str(state.get("reason") or "호환성 상태가 작업 중 바뀌어 중단했습니다."))
        original_hashes = _verify_original_root(root, manifest)
        touched_paths = sorted(set(manifest["officialRuntimeModifiedAllowlist"]) | {item["destination"] for item in manifest["runtimeModules"]})
        if progress:
            progress("공식 원본 버전, 파일 트리, 연결 지점과 IPC 계약을 확인했습니다.")

        validation_parent = canonical_path(Path(tempfile.gettempdir()), strict=True)
        if paths_overlap(validation_parent, EXPECTED_PROJECT_ROOT):
            raise ManagerError("OS 임시 경로가 개발 프로젝트와 겹쳐 사전 검증을 중단했습니다.")
        validation_dir = Path(tempfile.mkdtemp(prefix="dino-inplace-preflight-", dir=validation_parent))
        staged = validation_dir / "source"
        try:
            _copy_original_folder(root, staged)
            copied = _verify_original_root(staged, manifest)
            if copied != original_hashes:
                raise ManagerError("임시 사전 검증본이 원본과 일치하지 않습니다.")
            _apply_connections(staged, manifest)
            _copy_modules(patch_root, staged, manifest)
            staged_result = _verify_patched_tree(staged, original_hashes, manifest)
            contract_root = patch_root if IS_FROZEN else PROJECT_ROOT
            contracts = run_node_contracts(staged, contract_root)
            allowed_contract_statuses = {"PASS"} if manifest.get("compatibilityMode") == "STRUCTURAL" else {"PASS", "NOT RUN"}
            if contracts["status"] not in allowed_contract_statuses:
                raise ManagerError("임시 사전 검증에서 공식 Patch 03 계약 검사가 통과하지 않았습니다.")
            staged_hashes = staged_result["fileHashes"]
            staged_contents = {
                relative: _module_path(staged, relative).read_bytes()
                for relative in touched_paths
            }
        finally:
            shutil.rmtree(validation_dir, ignore_errors=False)

        before_hashes = _inventory(root)
        if before_hashes != original_hashes:
            raise ManagerError("원본 파일이 사전 검사 중 변경되어 적용하지 않았습니다.")
        backup_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + os.urandom(4).hex()
        backup = _make_backup(root, backup_id, before_hashes, staged_hashes, manifest, touched_paths)
        if progress:
            progress(f"복원 가능한 백업을 만들었습니다: {backup_id}")

        modified_paths = touched_paths
        applied: list[str] = []
        try:
            for relative in modified_paths:
                target = _module_path(root, relative)
                _atomic_write(target, staged_contents[relative])
                applied.append(relative)
            after_hashes = _inventory(root)
            if after_hashes != staged_hashes:
                raise ManagerError("실제 원본에 기록한 파일이 검증된 임시 적용 결과와 다릅니다.")
            new_state = {
                "schemaVersion": 1,
                "status": "APPLIED",
                "officialVersion": manifest["officialVersion"],
                "officialCommit": manifest["officialCommit"],
                "officialGitTreeSha": manifest.get("officialGitTreeSha"),
                "compatibilityMode": manifest.get("compatibilityMode", "PINNED"),
                "sourceIdentityVerified": bool(manifest.get("sourceIdentityVerified", True)),
                "runtimePlaybackVerified": False,
                "patchVersion": manifest.get("patchVersion", PATCH_VERSION),
                "backupId": backup_id,
                "appliedAt": datetime.now(timezone.utc).isoformat(),
                "beforeTreeSha256": backup["beforeTreeSha256"],
                "afterTreeSha256": tree_sha256(after_hashes),
                "afterFileHashes": after_hashes,
                "modifiedOfficialFiles": sorted(manifest["officialRuntimeModifiedAllowlist"]),
                "addedPatchFiles": sorted(item["destination"] for item in manifest["runtimeModules"]),
                "contracts": contracts,
            }
            _atomic_write_json(_state_path(root), new_state)
        except Exception as exc:
            rollback_errors = []
            for relative in reversed(applied):
                target = _module_path(root, relative)
                backup_entry = next(item for item in backup["files"] if item["path"] == relative)
                try:
                    if backup_entry["existedBefore"]:
                        original_path = _manager_data_path(
                            root,
                            Path("backups") / backup_id / "original" / Path(*relative.split("/")),
                        )
                        _atomic_write(target, original_path.read_bytes())
                    elif target.exists():
                        expected = backup_entry.get("afterSha256")
                        if _sha256_file(target) == expected:
                            target.unlink()
                except Exception as rollback_exc:
                    rollback_errors.append(f"{relative}: {type(rollback_exc).__name__}")
            detail = f"패치 적용 중 실패해 이번 작업 변경을 되돌렸습니다: {exc}\n백업 보존: {_manager_data_root(root) / 'backups' / backup_id}"
            if rollback_errors:
                detail += "\n되돌리지 못한 파일: " + ", ".join(rollback_errors)
            raise ManagerError(detail) from exc

        record = {
            "action": "PATCH_APPLY",
            "result": "PASS",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "backupId": backup_id,
            "officialVersion": manifest["officialVersion"],
            "patchVersion": manifest.get("patchVersion", PATCH_VERSION),
            "files": modified_paths,
            "treeSha256": tree_sha256(after_hashes),
        }
        try:
            _append_history(root, record)
        except OSError:
            record["historyWarning"] = "작업 기록 파일을 기록하지 못했습니다. 패치 상태와 백업은 보존됐습니다."
        if progress:
            progress("패치를 적용하고 원본 파일 지문을 다시 확인했습니다.")
        return {
            "status": "APPLIED",
            "path": str(root),
            "backupId": backup_id,
            "version": manifest["officialVersion"],
            "patchVersion": manifest.get("patchVersion", PATCH_VERSION),
            "modifiedOfficialFiles": record["files"][:2],
            "addedPatchFiles": [x for x in modified_paths if x not in original_hashes],
            "treeSha256": record["treeSha256"],
            "contracts": contracts,
            "compatibilityMode": manifest.get("compatibilityMode", "PINNED"),
            "officialGitTreeSha": manifest.get("officialGitTreeSha"),
            "sourceIdentityVerified": bool(manifest.get("sourceIdentityVerified", True)),
            "runtimePlaybackVerified": False,
            "historyWarning": record.get("historyWarning"),
        }
    finally:
        _release_operation_lock(lock, descriptor)


def restore_backup(
    root_value: str | os.PathLike[str],
    backup_id: str,
    *,
    patch_root_value: str | os.PathLike[str] | None = None,
    operation: str = "BACKUP_RESTORE",
    process_check: Callable[[Path], None] = assert_app_not_running,
) -> dict[str, Any]:
    root = canonical_path(root_value, strict=True)
    package = _assert_managed_target(root)
    if not re.fullmatch(r"[A-Za-z0-9T._-]{8,80}", str(backup_id)):
        raise ManagerError("선택한 백업 ID가 잘못됐습니다.")
    lock, descriptor = _acquire_operation_lock(root)
    try:
        process_check(root)
        _, manifest = _load_manifest_for_target(root, patch_root_value)
        backup_path = _manager_data_path(root, Path("backups") / backup_id / "backup.json")
        backup = _read_json_file(backup_path, "백업 정보")
        if backup.get("id") != backup_id or not backup.get("restorable"):
            raise ManagerError("이 백업은 복원할 수 있는 상태가 아닙니다.")
        result = _restore_backup_files(root, backup, manifest, operation=operation)
        return {"path": str(root), **result}
    finally:
        _release_operation_lock(lock, descriptor)


def uninstall_patch(
    root_value: str | os.PathLike[str],
    *,
    patch_root_value: str | os.PathLike[str] | None = None,
    process_check: Callable[[Path], None] = assert_app_not_running,
) -> dict[str, Any]:
    root = canonical_path(root_value, strict=True)
    _assert_managed_target(root)
    state_path = _state_path(root)
    if not state_path.is_file():
        raise ManagerError("복원 가능한 패치 상태 기록이 없습니다. 원본 파일을 임의 추정해 해제하지 않습니다.")
    state = _read_json_file(state_path, "패치 상태 기록")
    if state.get("status") == "UNPATCHED":
        return {"status": "ALREADY_UNPATCHED", "path": str(root), "message": "패치가 이미 해제되어 있습니다."}
    if state.get("status") != "APPLIED" or not state.get("backupId"):
        raise ManagerError("현재 패치 상태에서 안전한 해제를 확인하지 못했습니다.")
    return restore_backup(root, state["backupId"], patch_root_value=patch_root_value, operation="PATCH_UNINSTALL", process_check=process_check)


def _validate_previous_patch_record(root: Path, state: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    """Verify the old patch record and the exact files that it claims to own."""
    old_version = str(state.get("officialVersion", ""))
    backup_id = str(state.get("backupId", ""))
    if not re.fullmatch(r"\d+\.\d+\.\d+", old_version):
        raise CompatibilityBlocked("이전 패치 기록의 공식 버전이 올바르지 않습니다. 원본은 변경하지 않았습니다.", "PARTIAL_OR_UNKNOWN")
    if state.get("patchVersion") != manifest.get("patchVersion", PATCH_VERSION):
        raise CompatibilityBlocked("이전 패치 기록의 디노 패치 버전이 현재 관리자와 다릅니다.", "PARTIAL_OR_UNKNOWN")
    if not re.fullmatch(r"[A-Za-z0-9T._-]{8,80}", backup_id):
        raise CompatibilityBlocked("이전 패치와 연결된 백업 ID를 확인할 수 없습니다.", "PARTIAL_OR_UNKNOWN")

    backup_path = _manager_data_path(root, Path("backups") / backup_id / "backup.json")
    backup = _read_json_file(backup_path, "이전 패치 백업")
    after_hashes = state.get("afterFileHashes")
    if not isinstance(after_hashes, dict) or tree_sha256(after_hashes) != state.get("afterTreeSha256"):
        raise CompatibilityBlocked("이전 패치의 파일 지문 기록이 불완전합니다.", "PARTIAL_OR_UNKNOWN")
    if (
        backup.get("id") != backup_id
        or backup.get("restorable") is not True
        or backup.get("officialVersion") != old_version
        or backup.get("officialCommit") != state.get("officialCommit")
        or backup.get("officialGitTreeSha") != state.get("officialGitTreeSha")
        or backup.get("patchVersion") != state.get("patchVersion")
        or backup.get("beforeTreeSha256") != state.get("beforeTreeSha256")
        or backup.get("afterTreeSha256") != state.get("afterTreeSha256")
        or backup.get("afterFileHashes") != after_hashes
    ):
        raise CompatibilityBlocked("이전 패치 기록과 백업 메타데이터가 일치하지 않습니다.", "PARTIAL_OR_UNKNOWN")

    expected_modified = sorted(manifest.get("officialRuntimeModifiedAllowlist", []))
    expected_modules = sorted(item["destination"] for item in manifest.get("runtimeModules", []))
    if sorted(state.get("modifiedOfficialFiles", [])) != expected_modified or sorted(state.get("addedPatchFiles", [])) != expected_modules:
        raise CompatibilityBlocked("이전 패치가 관리한 파일 목록이 현재 디노 패치 범위와 다릅니다.", "PARTIAL_OR_UNKNOWN")

    entries = {entry.get("path"): entry for entry in backup.get("files", []) if isinstance(entry, dict)}
    before_hashes = backup.get("beforeFileHashes")
    if not isinstance(before_hashes, dict):
        raise CompatibilityBlocked("이전 패치 백업의 원본 파일 지문을 확인할 수 없습니다.", "PARTIAL_OR_UNKNOWN")
    for relative in expected_modified:
        entry = entries.get(relative)
        digest = before_hashes.get(relative)
        if not isinstance(entry, dict) or entry.get("existedBefore") is not True or not isinstance(digest, str):
            raise CompatibilityBlocked(f"이전 패치 백업 항목이 불완전합니다: {relative}", "PARTIAL_OR_UNKNOWN")
        if entry.get("beforeSha256") != digest:
            raise CompatibilityBlocked(f"이전 패치 백업 지문이 일치하지 않습니다: {relative}", "PARTIAL_OR_UNKNOWN")
        backup_relative = _safe_relative(entry.get("backupPath"))
        original = _manager_data_path(root, Path("backups") / backup_id / Path(*backup_relative.split("/")))
        try:
            if not original.is_file() or _sha256_file(original).upper() != digest.upper():
                raise CompatibilityBlocked(f"이전 패치의 복원 파일 지문을 확인할 수 없습니다: {relative}", "PARTIAL_OR_UNKNOWN")
        except OSError as exc:
            raise CompatibilityBlocked(f"이전 패치의 복원 파일을 읽을 수 없습니다: {relative}", "PARTIAL_OR_UNKNOWN") from exc
    for relative in expected_modules:
        entry = entries.get(relative)
        if not isinstance(entry, dict) or entry.get("existedBefore") is not False or entry.get("afterSha256") != after_hashes.get(relative):
            raise CompatibilityBlocked(f"이전 패치 모듈의 소유 기록이 일치하지 않습니다: {relative}", "PARTIAL_OR_UNKNOWN")
    return backup


def _updated_source_candidate(
    root: Path,
    patch_root: Path,
    version: str,
    module_entries: list[dict[str, str]],
    previous_state: dict[str, Any] | None,
    previous_backup: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, str], dict[str, str]]:
    """Verify an isolated clean copy against a pinned profile or exact official GitHub tree."""
    temp_parent = canonical_path(Path(tempfile.gettempdir()), strict=True)
    if paths_overlap(temp_parent, PROJECT_ROOT):
        raise ManagerError("OS Temp와 개발 프로젝트가 겹쳐 공식 원본 변경 검증을 중단했습니다.")
    stage_root = Path(tempfile.mkdtemp(prefix="dino-source-recheck-", dir=temp_parent))
    candidate = stage_root / "source"
    try:
        source_snapshot = _inventory(root)
        _copy_original_folder(root, candidate)
        if _inventory(root) != source_snapshot:
            raise ManagerError("공식 원본이 임시 사본 생성 중 변경되어 자동 재적용을 보류했습니다.")
        for module in module_entries:
            relative = module.get("path")
            if not isinstance(relative, str):
                raise ManagerError("이전 패치 모듈 기록이 올바르지 않습니다.")
            module_file = _module_path(candidate, relative)
            try:
                if _sha256_file(module_file).upper() != str(module.get("sha256", "")).upper():
                    raise CompatibilityBlocked(f"이전 패치 모듈의 현재 지문이 기록과 다릅니다: {relative}", "PARTIAL_OR_UNKNOWN")
                _windows_extended_path(module_file, force=os.name == "nt").unlink()
            except FileNotFoundError:
                pass

        # If the updater left an old patched connection file in place, restore
        # its recorded original bytes in this disposable candidate. The exact
        # new official Git tree check decides whether those bytes are valid.
        if previous_state and previous_state.get("status") == "APPLIED" and previous_backup:
            backup_files = {
                entry.get("path"): entry
                for entry in previous_backup.get("files", [])
                if isinstance(entry, dict)
            }
            after_hashes = previous_state.get("afterFileHashes", {})
            before_hashes = previous_backup.get("beforeFileHashes", {})
            for relative in sorted(EXPECTED_CONNECTION_FILES):
                candidate_file = _module_path(candidate, relative)
                if not candidate_file.is_file() or _sha256_file(candidate_file).upper() != str(after_hashes.get(relative, "")).upper():
                    continue
                entry = backup_files.get(relative)
                digest = before_hashes.get(relative)
                if not isinstance(entry, dict) or entry.get("existedBefore") is not True or not isinstance(digest, str):
                    raise CompatibilityBlocked(f"이전 패치 연결 파일의 원본 백업을 확인할 수 없습니다: {relative}", "PARTIAL_OR_UNKNOWN")
                backup_relative = _safe_relative(entry.get("backupPath"))
                backup_file = _manager_data_path(root, Path("backups") / str(previous_backup["id"]) / Path(*backup_relative.split("/")))
                if not backup_file.is_file() or _sha256_file(backup_file).upper() != digest.upper():
                    raise CompatibilityBlocked(f"이전 패치 연결 파일의 백업 지문이 다릅니다: {relative}", "PARTIAL_OR_UNKNOWN")
                _atomic_write(candidate_file, _windows_extended_path(backup_file, force=os.name == "nt").read_bytes())

        _, base_manifest = load_manifest(patch_root, version)
        if base_manifest.get("_profilePinned"):
            source_manifest = dict(base_manifest)
            source_manifest["compatibilityMode"] = "PINNED"
            source_manifest["runtimePlaybackVerified"] = version in {"0.5.54", "0.5.55"}
        else:
            source_manifest = _resolve_structural_source_manifest(candidate, patch_root, base_manifest, version)
        source_hashes = _verify_original_root(candidate, source_manifest)
        checked = _check_folder_compatibility(candidate, patch_root, source_manifest, progress=None)
        if checked.get("result") != "PASS":
            raise CompatibilityBlocked(
                "업데이트된 공식 소스에 대한 디노 패치 사전검사가 통과하지 않았습니다. 원본은 변경하지 않았습니다.",
                "UNSUPPORTED",
            )
        return source_manifest, source_hashes, source_snapshot
    finally:
        shutil.rmtree(stage_root, ignore_errors=False)


def _project_reconciled_source(
    root: Path,
    before_inventory: dict[str, str],
    source_hashes: dict[str, str],
    module_entries: list[dict[str, str]],
    previous_state: dict[str, Any] | None,
    previous_backup: dict[str, Any] | None,
) -> dict[str, bytes]:
    """Return owned official files to restore, rejecting all other source deltas."""
    projected = dict(before_inventory)
    for module in module_entries:
        relative = str(module.get("path", ""))
        current_hash = projected.get(relative)
        if current_hash is None:
            continue
        if current_hash.upper() != str(module.get("sha256", "")).upper():
            raise CompatibilityBlocked(f"기존 디노 패치 모듈이 기록과 달라 자동 재적용을 중단했습니다: {relative}", "PARTIAL_OR_UNKNOWN")
        projected.pop(relative)

    restore_files: dict[str, bytes] = {}
    if previous_state and previous_state.get("status") == "APPLIED":
        if not previous_backup:
            raise CompatibilityBlocked("이전 디노 패치의 원본 백업을 확인할 수 없어 자동 재적용을 중단했습니다.", "PARTIAL_OR_UNKNOWN")
        after_hashes = previous_state.get("afterFileHashes", {})
        before_hashes = previous_backup.get("beforeFileHashes", {})
        backup_files = {
            entry.get("path"): entry
            for entry in previous_backup.get("files", [])
            if isinstance(entry, dict)
        }
        for relative in sorted(EXPECTED_CONNECTION_FILES):
            current_hash = projected.get(relative)
            target_hash = source_hashes.get(relative)
            if target_hash is None or current_hash is None:
                raise CompatibilityBlocked(f"새 공식 소스의 연결 파일을 확인할 수 없습니다: {relative}", "CONFLICT")
            if current_hash.upper() == str(after_hashes.get(relative, "")).upper():
                entry = backup_files.get(relative)
                original_hash = before_hashes.get(relative)
                if not isinstance(entry, dict) or entry.get("existedBefore") is not True or not isinstance(original_hash, str):
                    raise CompatibilityBlocked(f"이전 패치 연결 파일의 백업 정보를 확인할 수 없습니다: {relative}", "PARTIAL_OR_UNKNOWN")
                if original_hash.upper() != target_hash.upper():
                    raise CompatibilityBlocked(
                        f"새 공식 버전에서 {relative}이 갱신됐지만 이전 패치 코드가 남아 있어 안전하게 복원할 수 없습니다.",
                        "CONFLICT",
                    )
                backup_relative = _safe_relative(entry.get("backupPath"))
                backup_file = _manager_data_path(root, Path("backups") / str(previous_backup["id"]) / Path(*backup_relative.split("/")))
                if not backup_file.is_file() or _sha256_file(backup_file).upper() != original_hash.upper():
                    raise CompatibilityBlocked(f"이전 패치 연결 파일의 원본 백업 지문이 다릅니다: {relative}", "PARTIAL_OR_UNKNOWN")
                restore_files[relative] = _windows_extended_path(backup_file, force=os.name == "nt").read_bytes()
                projected[relative] = original_hash.upper()
            elif current_hash.upper() != target_hash.upper():
                raise CompatibilityBlocked(f"공식 업데이트 파일이 검증된 트리와 다르거나 사용자가 수정했습니다: {relative}", "CONFLICT")

    if projected != source_hashes:
        extra = sorted(set(projected) - set(source_hashes))[:3]
        missing = sorted(set(source_hashes) - set(projected))[:3]
        changed = sorted(path for path in set(projected) & set(source_hashes) if projected[path].upper() != source_hashes[path].upper())[:3]
        detail = ", ".join([*(f"추가 {item}" for item in extra), *(f"누락 {item}" for item in missing), *(f"변경 {item}" for item in changed)])
        raise CompatibilityBlocked(f"현재 소스가 새 공식 파일 트리와 일치하지 않아 자동 재적용을 중단했습니다: {detail or '파일 지문 불일치'}", "CONFLICT")
    return restore_files


def _write_unpatched_update_state(
    root: Path,
    previous_state: dict[str, Any] | None,
    source_manifest: dict[str, Any],
    source_hashes: dict[str, str],
) -> None:
    _atomic_write_json(_state_path(root), {
        "schemaVersion": 1,
        "status": "UNPATCHED",
        "officialVersion": source_manifest["officialVersion"],
        "officialCommit": source_manifest["officialCommit"],
        "officialGitTreeSha": source_manifest.get("officialGitTreeSha"),
        "compatibilityMode": source_manifest.get("compatibilityMode", "PINNED"),
        "sourceIdentityVerified": bool(source_manifest.get("sourceIdentityVerified", True)),
        "runtimePlaybackVerified": bool(source_manifest.get("runtimePlaybackVerified", False)),
        "patchVersion": source_manifest.get("patchVersion", PATCH_VERSION),
        "sourceTreeSha256": tree_sha256(source_hashes),
        "sourceFileCount": len(source_hashes),
        "supersededVersion": previous_state.get("officialVersion") if previous_state else None,
        "supersededBackupId": previous_state.get("backupId") if previous_state else None,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    })


def _retire_superseded_backup(root: Path, backup_id: str | None, target_version: str) -> None:
    if not backup_id:
        return
    backup_path = _manager_data_path(root, Path("backups") / backup_id / "backup.json")
    if not backup_path.is_file():
        return
    backup = _read_json_file(backup_path, "이전 패치 백업")
    if backup.get("id") != backup_id:
        raise ManagerError("이전 패치 백업 ID가 경로와 일치하지 않습니다.")
    backup["restorable"] = False
    backup["supersededByOfficialVersion"] = target_version
    backup["supersededAt"] = datetime.now(timezone.utc).isoformat()
    _atomic_write_json(backup_path, backup)


def _pending_source_update(root: Path) -> dict[str, Any] | None:
    path = _source_update_journal_path(root)
    if not path.is_file():
        return None
    journal = _read_json_file(path, "공식 소스 변경 작업 기록")
    if journal.get("schemaVersion") != 1 or journal.get("status") != "RECONCILE_PENDING":
        raise ManagerError("공식 소스 변경 작업 기록이 손상되어 파일 변경을 잠갔습니다.")
    return journal


def _recover_or_prepare_source_update(
    root_value: str | os.PathLike[str],
    patch_root_value: str | os.PathLike[str] | None,
    *,
    process_check: Callable[[Path], None],
    progress: Callable[[str], None] | None,
) -> dict[str, Any] | None:
    root = canonical_path(root_value, strict=True)
    package = _assert_managed_target(root)
    current_version = str(package.get("version", "unknown"))
    journal_path = _source_update_journal_path(root)
    journal = _pending_source_update(root)
    state_path = _state_path(root)
    state = _read_json_file(state_path, "패치 상태 기록") if state_path.is_file() else None
    patch_root, manifest = load_manifest(patch_root_value or patch_source_root(), current_version)
    recovering = journal is not None
    previous: dict[str, Any] | None = None
    migration_state: dict[str, Any] | None = None
    previous_backup: dict[str, Any] | None = None
    expected_modules = sorted(item["destination"] for item in manifest.get("runtimeModules", []))

    if recovering:
        target = journal.get("target")
        previous = journal.get("previousState")
        if not isinstance(target, dict) or target.get("officialVersion") != current_version:
            raise ManagerError("공식 소스가 자동 재적용 준비 중 다시 변경됐습니다. 파일 변경을 중단했습니다.")
        if previous is not None and not isinstance(previous, dict):
            raise ManagerError("공식 소스 변경 기록의 이전 상태가 손상됐습니다.")
        module_paths = journal.get("modulePaths")
        module_entries = journal.get("modules")
        if module_paths != expected_modules or not isinstance(module_entries, list):
            raise ManagerError("공식 소스 변경 기록의 디노 패치 파일 범위가 현재 관리자와 다릅니다.")
        for entry in module_entries:
            if not isinstance(entry, dict) or entry.get("path") not in expected_modules or not re.fullmatch(r"[0-9A-F]{64}", str(entry.get("sha256", "")), re.I):
                raise ManagerError("공식 소스 변경 기록의 패치 모듈 항목이 올바르지 않습니다.")
        if previous and previous.get("status") == "APPLIED":
            if sorted(entry["path"] for entry in module_entries) != expected_modules:
                raise ManagerError("공식 소스 변경 기록의 패치 모듈 수가 이전 상태와 일치하지 않습니다.")
        elif module_entries:
            raise ManagerError("미적용 상태의 공식 소스 변경 기록에 패치 모듈 항목이 들어 있습니다.")
        resumed_state = (
            isinstance(state, dict)
            and state.get("status") == "UNPATCHED"
            and state.get("officialVersion") == current_version
        )
        if state == previous:
            migration_state = previous
        elif resumed_state:
            # A prior run finished source reconciliation and updated state, but
            # stopped before retiring metadata or clearing the journal.
            migration_state = None
        else:
            raise ManagerError("공식 소스 변경 기록과 현재 패치 상태가 달라 복구를 중단했습니다.")
        if migration_state and migration_state.get("status") == "APPLIED":
            previous_backup = _validate_previous_patch_record(root, migration_state, manifest)
    else:
        if not isinstance(state, dict) or state.get("status") not in {"APPLIED", "UNPATCHED"}:
            return None
        if state.get("officialVersion") == current_version:
            return None
        if state.get("patchVersion") != manifest.get("patchVersion", PATCH_VERSION):
            raise CompatibilityBlocked("이전 원본에 기록된 디노 패치 버전이 현재 관리자와 달라 자동 재적용을 중단했습니다.", "PARTIAL_OR_UNKNOWN")
        previous = state
        migration_state = state
        expected_modules = sorted(item["destination"] for item in manifest.get("runtimeModules", []))
        if state.get("status") == "APPLIED":
            previous_backup = _validate_previous_patch_record(root, state, manifest)
            module_entries = [{"path": relative, "sha256": str(state["afterFileHashes"][relative]).upper()} for relative in expected_modules]
        else:
            module_entries = []
            traces = [relative for relative in expected_modules if _module_path(root, relative).exists()]
            if traces:
                raise CompatibilityBlocked("패치 상태는 미적용으로 기록됐지만 패치 모듈이 남아 있습니다. 안전을 위해 자동 재적용을 중단했습니다.", "PARTIAL_OR_UNKNOWN")
        module_paths = expected_modules

    process_check(root)
    lock, descriptor = _acquire_operation_lock(root)
    try:
        if str(_package_info(root).get("version", "unknown")) != current_version:
            raise ManagerError("공식 원본 버전이 검사 도중 바뀌어 자동 재적용을 보류했습니다.")
        current_state = _read_json_file(state_path, "패치 상태 기록") if state_path.is_file() else None
        if not recovering and current_state != state:
            raise ManagerError("패치 상태가 검사 도중 변경되어 자동 재적용을 보류했습니다.")
        if recovering:
            resumed_state = (
                isinstance(current_state, dict)
                and current_state.get("status") == "UNPATCHED"
                and current_state.get("officialVersion") == current_version
            )
            if (migration_state is not None and current_state != previous) or (migration_state is None and not resumed_state):
                raise ManagerError("공식 소스 변경 기록과 현재 패치 상태가 달라 복구를 중단했습니다.")

        if progress:
            progress("새 공식 소스의 전체 지문과 디노 패치 사전검사를 확인합니다.")
        source_manifest, source_hashes, source_snapshot = _updated_source_candidate(
            root,
            patch_root,
            current_version,
            module_entries,
            migration_state,
            previous_backup,
        )
        identity = {
            "officialVersion": source_manifest.get("officialVersion"),
            "officialCommit": source_manifest.get("officialCommit"),
            "officialGitTreeSha": source_manifest.get("officialGitTreeSha"),
            "compatibilityMode": source_manifest.get("compatibilityMode", "PINNED"),
            "sourceIdentityVerified": bool(source_manifest.get("sourceIdentityVerified", True)),
            "sourceTreeSha256": tree_sha256(source_hashes),
            "sourceFileCount": len(source_hashes),
        }
        if recovering and identity != journal["target"]:
            raise ManagerError("공식 소스 변경 검증 결과가 작업 기록과 달라 파일 변경을 잠갔습니다.")

        before_inventory = _inventory(root)
        if before_inventory != source_snapshot:
            raise ManagerError("공식 원본이 호환성 검사 뒤 변경되어 자동 재적용을 보류했습니다.")
        restore_files = _project_reconciled_source(
            root,
            before_inventory,
            source_hashes,
            module_entries,
            migration_state,
            previous_backup,
        )
        if not recovering:
            journal = {
                "schemaVersion": 1,
                "status": "RECONCILE_PENDING",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "previousState": previous,
                "previousBackupId": previous.get("backupId") if previous else None,
                "modulePaths": expected_modules,
                "modules": module_entries,
                "target": identity,
            }
            _atomic_write_json(journal_path, journal)

        # Keep the live source unchanged until the candidate, official Git tree,
        # previous patch record, and exact projected post-cleanup tree all pass.
        for entry in journal["modules"]:
            relative = entry["path"]
            current_module = _module_path(root, relative)
            if current_module.exists() and _sha256_file(current_module).upper() != entry["sha256"].upper():
                raise ManagerError(f"정리할 패치 모듈이 기록과 달라 작업을 중단했습니다: {relative}")
        if _inventory(root) != before_inventory:
            raise ManagerError("공식 원본 파일이 검사 중 변경되어 자동 재적용을 보류했습니다.")
        for entry in journal["modules"]:
            current_module = _module_path(root, entry["path"])
            if current_module.exists():
                _windows_extended_path(current_module, force=os.name == "nt").unlink()

        for relative, data in restore_files.items():
            current_file = _module_path(root, relative)
            current_hash = _sha256_file(current_file).upper()
            target_hash = source_hashes[relative].upper()
            if current_hash != target_hash:
                expected_patch_hash = str(migration_state["afterFileHashes"][relative]).upper()
                if current_hash != expected_patch_hash or hashlib.sha256(data).hexdigest().upper() != target_hash:
                    raise ManagerError(f"기존 디노 패치 파일을 새 공식 원본으로 안전하게 복원할 수 없습니다: {relative}")
                _atomic_write(current_file, data)

        actual_source_hashes = _verify_original_root(root, source_manifest)
        if actual_source_hashes != source_hashes:
            raise ManagerError("패치 모듈 정리 후 공식 원본 지문이 달라져 파일 변경을 잠갔습니다.")
        _write_unpatched_update_state(root, previous, source_manifest, source_hashes)
        _retire_superseded_backup(root, journal.get("previousBackupId"), current_version)
        _append_history(root, {
            "action": "OFFICIAL_SOURCE_CHANGE_DETECTED",
            "result": "PASS",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "previousOfficialVersion": previous.get("officialVersion") if previous else None,
            "officialVersion": current_version,
            "officialCommit": source_manifest["officialCommit"],
            "patchCompatibility": "PASS",
            "removedOwnedModules": [entry["path"] for entry in journal["modules"]],
        })
        _windows_extended_path(journal_path, force=os.name == "nt").unlink()
        return {
            "status": "SOURCE_UPDATE_VERIFIED",
            "previousOfficialVersion": previous.get("officialVersion") if previous else None,
            "officialVersion": current_version,
            "progress": f"공식 v{current_version} 변경과 호환성을 확인했습니다. 디노 패치를 자동 적용합니다.",
        }
    finally:
        _release_operation_lock(lock, descriptor)


def automatic_startup_check(
    root_value: str | os.PathLike[str] | None = None,
    *,
    progress: Callable[[str], None] | None = None,
    process_check: Callable[[Path], None] = assert_app_not_running,
    patch_root_value: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    root = canonical_path(root_value) if root_value else find_original_root()
    if root is None:
        return {"status": "NO_SOURCE", "reason": "관리자 실행 위치의 상위 경로에서 지원되는 LilacAnime 소스 폴더를 찾지 못했습니다."}
    source_update = _recover_or_prepare_source_update(
        root,
        patch_root_value,
        process_check=process_check,
        progress=progress,
    )
    info = inspect_managed_target(root, patch_root_value)
    update_metadata = {}
    if source_update:
        update_metadata = {
            "sourceUpdateDetected": True,
            "previousOfficialVersion": source_update.get("previousOfficialVersion"),
            "sourceUpdateVerified": True,
        }
    if info["status"] == "APPLIED":
        return {**info, **update_metadata}
    if info["status"] == "UNPATCHED":
        state = info.get("state")
        if isinstance(state, dict) and state.get("manualUninstall") is True and source_update is None:
            same_source = (
                state.get("officialVersion") == info.get("version")
                and state.get("officialCommit") == info.get("officialCommit")
                and state.get("officialGitTreeSha") == info.get("officialGitTreeSha")
                and state.get("patchVersion") == info.get("patchVersion")
                and state.get("sourceTreeSha256") == info.get("treeSha256")
                and state.get("sourceFileCount") == info.get("sourceFileCount")
            )
            if same_source:
                return {
                    **info,
                    **update_metadata,
                    "manualUninstall": True,
                    "reason": "사용자가 디노 패치를 직접 해제했습니다. 현재 공식 소스가 변경될 때까지 자동으로 다시 적용하지 않습니다.",
                }
            return {
                **info,
                "status": "PARTIAL_OR_UNKNOWN",
                "manualUninstall": True,
                "reason": "수동 해제 기록과 현재 공식 소스 지문이 일치하지 않아 자동 적용을 중단했습니다.",
            }
        result = apply_patch_in_place(root, patch_root_value, progress=progress, process_check=process_check)
        return {**info, **result, **update_metadata}
    return {**info, **update_metadata}


def _parse_semver(value: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", value.strip(), re.I)
    return tuple(int(part) for part in match.groups()) if match else None


def _github_json(url: str, *, timeout: float, opener: Callable[..., Any]) -> dict[str, Any]:
    parsed = urlparse(url)
    expected_prefix = f"/repos/{GITHUB_REPOSITORY}/"
    if parsed.scheme != "https" or parsed.netloc != "api.github.com" or not parsed.path.startswith(expected_prefix):
        raise ManagerError("공식 GitHub 메타데이터 주소가 허용된 저장소와 일치하지 않습니다.")
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "DinoPatchManager"})
    with opener(request, timeout=timeout) as response:
        raw = response.read(MAX_GITHUB_METADATA_BYTES + 1)
    if len(raw) > MAX_GITHUB_METADATA_BYTES:
        raise ManagerError("GitHub 메타데이터가 허용 크기를 초과했습니다.")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ManagerError("GitHub 메타데이터 JSON을 읽을 수 없습니다.") from exc
    if not isinstance(payload, dict):
        raise ManagerError("GitHub 메타데이터의 최상위 형식이 올바르지 않습니다.")
    return payload


def _classify_official_release(current_version: str, payload: dict[str, Any]) -> dict[str, Any]:
    latest = str(payload.get("tag_name", ""))
    current = _parse_semver(current_version)
    newest = _parse_semver(latest)
    if not newest:
        return {"status": "CHECK_FAILED", "reason": "GitHub 응답에 읽을 수 있는 공식 버전 태그가 없습니다."}
    if current and newest <= current:
        return {"status": "UP_TO_DATE", "currentVersion": current_version, "latestVersion": latest}
    return {
        "status": "UPDATE_AVAILABLE_UNSUPPORTED",
        "currentVersion": current_version,
        "latestVersion": latest,
        "releaseUrl": str(payload.get("html_url", "")),
        "reason": "이 관리자는 공식 소스 폴더를 패치합니다. 공식 Windows 릴리스의 NSIS 설치 파일은 설치된 앱을 갱신하며 이 소스 폴더를 갱신하지 않습니다. 새 버전의 공식 파일별 무결성 기준, 패치 연결 계약, 원자적 복원 절차도 검증되지 않아 승인 후 다운로드와 자동 설치를 지원하지 않습니다.",
    }


def check_official_update(*, current_version: str, timeout: float = 6.0, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    url = f"{GITHUB_API_ROOT}/releases/latest"
    try:
        payload = _github_json(url, timeout=timeout, opener=opener)
        return _classify_official_release(current_version, payload)
    except (OSError, urllib.error.URLError, TimeoutError, UnicodeError, json.JSONDecodeError, ManagerError) as exc:
        return {"status": "CHECK_FAILED", "reason": f"GitHub 최신 버전 조회에 실패했습니다 ({type(exc).__name__}). 패치 상태에는 영향을 주지 않았습니다."}


def _github_object_sha(value: Any, description: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value, re.I):
        raise ManagerError(f"공식 {description} SHA 형식이 올바르지 않습니다.")
    return value.lower()


def _fetch_official_source_identity(
    version: str,
    *,
    timeout: float = 8.0,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """Verify an official release tag and its complete Git tree without downloading source."""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise CompatibilityBlocked("공식 버전 형식이 올바르지 않아 GitHub 출처를 확인할 수 없습니다.")
    tag = f"v{version}"
    release = _github_json(f"{GITHUB_API_ROOT}/releases/tags/{tag}", timeout=timeout, opener=opener)
    expected_url = f"https://github.com/{GITHUB_REPOSITORY}/releases/tag/{tag}"
    if release.get("tag_name") != tag or release.get("html_url") != expected_url or release.get("draft") is True:
        raise CompatibilityBlocked("GitHub 릴리스 메타데이터가 공식 저장소의 요청한 버전 태그와 일치하지 않습니다.")
    commit_sha, tree_sha = _resolve_official_tag(tag, timeout=timeout, opener=opener)
    files, total_bytes = _github_tree_files(tree_sha, timeout=timeout, opener=opener)
    if not files:
        raise CompatibilityBlocked("공식 GitHub 태그의 전체 파일 목록이 비어 있습니다.", "UNSUPPORTED")
    return {
        "repository": f"https://github.com/{GITHUB_REPOSITORY}",
        "tag": tag,
        "commit": commit_sha,
        "treeSha": tree_sha,
        "files": files,
        "fileCount": len(files),
        "totalBytes": total_bytes,
    }


def _resolve_official_tag(tag: str, *, timeout: float, opener: Callable[..., Any]) -> tuple[str, str]:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ManagerError("공식 릴리스 태그가 지원하는 숫자 버전 형식이 아닙니다.")
    ref = _github_json(f"{GITHUB_API_ROOT}/git/ref/tags/{tag}", timeout=timeout, opener=opener)
    if ref.get("ref") != f"refs/tags/{tag}" or not isinstance(ref.get("object"), dict):
        raise ManagerError("공식 Git 태그 참조가 릴리스 태그와 일치하지 않습니다.")
    obj = ref["object"]
    sha = _github_object_sha(obj.get("sha"), "태그")
    kind = obj.get("type")
    for _ in range(4):
        if kind == "commit":
            commit = _github_json(f"{GITHUB_API_ROOT}/git/commits/{sha}", timeout=timeout, opener=opener)
            commit_sha = _github_object_sha(commit.get("sha"), "커밋")
            tree_data = commit.get("tree")
            if commit_sha != sha or not isinstance(tree_data, dict):
                raise ManagerError("공식 태그 커밋 응답이 참조 SHA와 일치하지 않습니다.")
            return commit_sha, _github_object_sha(tree_data.get("sha"), "트리")
        if kind != "tag":
            raise ManagerError("공식 태그가 커밋 또는 주석 태그를 가리키지 않습니다.")
        annotated = _github_json(f"{GITHUB_API_ROOT}/git/tags/{sha}", timeout=timeout, opener=opener)
        if annotated.get("tag") != tag or not isinstance(annotated.get("object"), dict):
            raise ManagerError("공식 주석 태그의 이름 또는 대상이 릴리스와 일치하지 않습니다.")
        sha = _github_object_sha(annotated["object"].get("sha"), "태그 대상")
        kind = annotated["object"].get("type")
    raise ManagerError("공식 태그 참조의 연결 단계가 허용 한도를 넘었습니다.")


def _github_tree_files(tree_sha: str, *, timeout: float, opener: Callable[..., Any]) -> tuple[dict[str, str], int]:
    payload = _github_json(f"{GITHUB_API_ROOT}/git/trees/{tree_sha}?recursive=1", timeout=timeout, opener=opener)
    if _github_object_sha(payload.get("sha"), "트리 응답") != tree_sha:
        raise ManagerError("공식 파일 트리 응답이 확인한 트리 SHA와 일치하지 않습니다.")
    if payload.get("truncated") is not False:
        raise ManagerError("공식 파일 트리가 잘렸거나 완전성을 확인할 수 없습니다.")
    entries = payload.get("tree")
    if not isinstance(entries, list) or len(entries) > MAX_ARCHIVE_FILES:
        raise ManagerError("공식 파일 트리의 항목 수가 없거나 허용 한도를 넘었습니다.")
    files: dict[str, str] = {}
    folded: set[str] = set()
    total_bytes = 0
    for entry in entries:
        if not isinstance(entry, dict):
            raise ManagerError("공식 파일 트리에 잘못된 항목이 있습니다.")
        if entry.get("type") == "tree" and entry.get("mode") == "040000":
            continue
        path = entry.get("path")
        if not isinstance(path, str) or not path or "\\" in path or "\x00" in path or ":" in path:
            raise ManagerError("공식 파일 트리에 Windows에서 안전하지 않은 경로가 있습니다.")
        parts = path.split("/")
        reserved = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$", re.I)
        if any(part in {"", ".", ".."} or part.endswith((".", " ")) or reserved.fullmatch(part) for part in parts):
            raise ManagerError("공식 파일 트리에 경로 이탈 또는 Windows 예약 이름이 있습니다.")
        path_key = "/".join(parts).casefold()
        if path_key in folded:
            raise ManagerError("공식 파일 트리에 Windows 대소문자 충돌 경로가 있습니다.")
        folded.add(path_key)
        if entry.get("type") != "blob" or entry.get("mode") not in {"100644", "100755"}:
            raise ManagerError("공식 파일 트리에 검증되지 않은 심볼릭 링크 또는 하위 저장소가 있습니다.")
        blob_sha = _github_object_sha(entry.get("sha"), "파일")
        size = entry.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ManagerError("공식 파일 크기 메타데이터가 올바르지 않습니다.")
        total_bytes += size
        if len(files) >= MAX_ARCHIVE_FILES or total_bytes > MAX_ARCHIVE_UNPACKED_BYTES:
            raise ManagerError("공식 파일 트리의 파일 수 또는 총 크기가 허용 한도를 넘었습니다.")
        files[path] = blob_sha
    return files, total_bytes


def _source_change_summary(old_files: dict[str, str], new_files: dict[str, str]) -> dict[str, Any]:
    old_paths, new_paths = set(old_files), set(new_files)
    added = sorted(new_paths - old_paths)
    deleted = sorted(old_paths - new_paths)
    modified = sorted(path for path in old_paths & new_paths if old_files[path] != new_files[path])
    return {
        "addedCount": len(added),
        "modifiedCount": len(modified),
        "deletedCount": len(deleted),
        "changedCount": len(added) + len(modified) + len(deleted),
        "addedSamples": added[:20],
        "modifiedSamples": modified[:20],
        "deletedSamples": deleted[:20],
    }


def _source_archive_release_assets(release: dict[str, Any]) -> tuple[int, bool, bool | None]:
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ManagerError("공식 릴리스의 자산 목록을 확인할 수 없습니다.")
    archive_assets = []
    checksum_assets = []
    for asset in assets:
        if not isinstance(asset, dict):
            raise ManagerError("공식 릴리스 자산 메타데이터 형식이 올바르지 않습니다.")
        name = asset.get("name")
        if not isinstance(name, str):
            raise ManagerError("공식 릴리스 자산 이름이 없습니다.")
        normalized = name.casefold()
        if "checksum" in normalized or "sha256" in normalized or normalized in {"sha256sums", "checksums.txt"}:
            checksum_assets.append(asset)
        if "source" in normalized and normalized.endswith((".zip", ".tar", ".tar.gz", ".tgz")):
            archive_assets.append(asset)
    if archive_assets:
        has_published_digest = any(
            isinstance(asset.get("digest"), str)
            and re.fullmatch(r"sha256:[0-9a-f]{64}", asset["digest"], re.I)
            for asset in archive_assets
        )
        return len(assets), True, has_published_digest
    if checksum_assets:
        return len(assets), False, None
    return len(assets), False, False


def preflight_official_source_update(
    *,
    current_version: str,
    root_value: str | os.PathLike[str] | None = None,
    patch_root_value: str | os.PathLike[str] | None = None,
    timeout: float = 8.0,
    opener: Callable[..., Any] = urllib.request.urlopen,
    process_check: Callable[[Path], None] = assert_app_not_running,
) -> dict[str, Any]:
    """Read-only GitHub/source-state preflight. Never downloads or replaces source files."""
    try:
        release = _github_json(f"{GITHUB_API_ROOT}/releases/latest", timeout=timeout, opener=opener)
        classified = _classify_official_release(current_version, release)
        if classified["status"] != "UPDATE_AVAILABLE_UNSUPPORTED":
            return classified
        tag = str(classified["latestVersion"])
        expected_release_url = f"https://github.com/{GITHUB_REPOSITORY}/releases/tag/{tag}"
        if release.get("html_url") != expected_release_url:
            raise ManagerError("공식 릴리스 페이지가 고정된 공식 저장소·태그 경로와 일치하지 않습니다.")

        latest_commit, latest_tree_sha = _resolve_official_tag(tag, timeout=timeout, opener=opener)
        latest_files, total_bytes = _github_tree_files(latest_tree_sha, timeout=timeout, opener=opener)
        release_asset_count, source_archive_asset_present, source_archive_checksum_published = _source_archive_release_assets(release)
        patch_root, manifest = load_manifest(patch_root_value or patch_source_root(), current_version)
        base_commit, base_tree_sha = _resolve_official_tag(f"v{manifest['officialVersion']}", timeout=timeout, opener=opener)
        if base_commit != manifest["officialCommit"].lower():
            raise ManagerError("고정 기준 원본 커밋이 현재 patch manifest와 다릅니다.")
        base_files, _ = _github_tree_files(base_tree_sha, timeout=timeout, opener=opener)
        change_summary = _source_change_summary(base_files, latest_files)

        source_state = "NOT_CHECKED"
        source_reason = "원본 경로가 없어 현재 파일·패치 상태를 검사하지 않았습니다."
        if root_value is not None:
            root = canonical_path(root_value, strict=True)
            inspected = inspect_managed_target(root, patch_root)
            if str(inspected.get("version")) != current_version:
                raise ManagerError("표시한 현재 버전과 검사한 공식 원본의 package.json 버전이 다릅니다.")
            if inspected.get("status") not in {"APPLIED", "UNPATCHED"}:
                raise ManagerError(f"현재 패치 상태가 안전하지 않아 업데이트를 준비할 수 없습니다: {inspected.get('status')}")
            process_check(root)
            source_state = str(inspected["status"])
            source_reason = f"현재 공식 v{manifest['officialVersion']} 파일 트리와 패치 상태를 읽기 전용으로 확인했습니다."

        archive_url = release.get("tarball_url") or release.get("zipball_url")
        if not isinstance(archive_url, str):
            archive_url = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/tarball/{latest_commit}"
        archive_parts = urlparse(archive_url)
        if archive_parts.scheme != "https" or archive_parts.netloc != "api.github.com" or not archive_parts.path.startswith(f"/repos/{GITHUB_REPOSITORY}/"):
            raise ManagerError("공식 소스 아카이브 주소가 고정된 GitHub 저장소 경로와 일치하지 않습니다.")

        return {
            **classified,
            "sourcePreflightStatus": "READ_ONLY_COMPLETE",
            "repository": f"https://github.com/{GITHUB_REPOSITORY}",
            "releaseTag": tag,
            "releaseCommit": latest_commit,
            "releaseTreeSha": latest_tree_sha,
            "sourceArchiveUrl": archive_url,
            "sourceArchiveDownloaded": False,
            "officialReleaseAssetCount": release_asset_count,
            "sourceArchiveAssetPresent": source_archive_asset_present,
            "officialArchiveChecksumPublished": source_archive_checksum_published,
            "sourceFileCount": len(latest_files),
            "sourceUnpackedBytes": total_bytes,
            "sourceChangeSummary": change_summary,
            "currentSourceState": source_state,
            "currentSourceReason": source_reason,
            "patchCompatibility": "NOT_VERIFIED",
            "rollbackCapability": "NOT_PROVEN",
            "sourceInstallEnabled": False,
            "approvalRequired": True,
            "reason": f"GitHub 태그·커밋·파일 트리와 v{manifest['officialVersion']} 대비 변경량을 읽기 전용으로 확인했습니다. 이 릴리스의 Patch 03 연결 호환성, 공식 아카이브 내부 파일과 전체 소스 복원 트랜잭션은 검증되지 않았으므로 설치는 비활성 상태입니다. " + source_reason,
        }
    except (OSError, urllib.error.URLError, TimeoutError, UnicodeError, json.JSONDecodeError, ManagerError, KeyError, TypeError) as exc:
        safe_detail = str(exc)[:500] if isinstance(exc, ManagerError) else type(exc).__name__
        return {
            "status": "UPDATE_PREFLIGHT_BLOCKED",
            "currentVersion": current_version,
            "latestVersion": str(release.get("tag_name", "")) if "release" in locals() and isinstance(release, dict) else "",
            "sourcePreflightStatus": "BLOCKED",
            "sourceArchiveDownloaded": False,
            "sourceInstallEnabled": False,
            "patchCompatibility": "NOT_VERIFIED",
            "rollbackCapability": "NOT_PROVEN",
            "reason": f"공식 소스 업데이트 사전검사를 완료하지 못했습니다: {safe_detail}. 원본 파일은 변경하지 않았습니다.",
        }


def approve_official_update(update_info: dict[str, Any]) -> dict[str, Any]:
    if update_info.get("status") == "UP_TO_DATE":
        return {"status": "NO_UPDATE", "reason": "공식 최신 버전이 이미 적용돼 있습니다."}
    if update_info.get("status") == "CHECK_FAILED":
        return {"status": "NOT_AVAILABLE", "reason": str(update_info.get("reason", "공식 업데이트 정보를 확인할 수 없습니다."))}
    return {
        "status": "UNSUPPORTED",
        "reason": "공식 업데이트는 사용자가 승인해도 적용할 수 없습니다. 이 버전의 서명/해시·파일별 마이그레이션·복원 절차가 준비되지 않았기 때문에 원본 파일을 변경하지 않았습니다.",
    }


def _append_manager_diagnostic(action: str, result: str, reason: str) -> None:
    try:
        path = manager_home() / "manager.log"
        record = {
            "action": action,
            "result": result,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "reason": str(reason)[:800],
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "ab") as stream:
            stream.write((json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
            stream.flush()
    except OSError:
        pass


def _read_legacy_theme_sqlite(path: Path) -> str | None:
    import sqlite3

    uri = path.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=0.2)
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in ("ItemTable", "itemTable"):
            if table not in tables:
                continue
            row = connection.execute(f'SELECT value FROM "{table}" WHERE key=? LIMIT 1', ("theme",)).fetchone()
            if row:
                value = row[0].decode("utf-8", "replace") if isinstance(row[0], bytes) else str(row[0])
                if value in {"dark", "light", "system"}:
                    return value
    finally:
        connection.close()
    return None


def _system_theme() -> tuple[str, str]:
    if os.name == "nt":
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", 0, winreg.KEY_READ)
            try:
                value, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
            finally:
                winreg.CloseKey(key)
            return ("light" if int(value) else "dark", "Windows AppsUseLightTheme")
        except (OSError, ImportError, ValueError):
            pass
    return "dark", "안전한 기본값"


def read_official_theme(root_value: str | os.PathLike[str]) -> dict[str, Any]:
    """Read the official localStorage theme from its Electron userData path; never writes user data."""
    import sqlite3

    root = canonical_path(root_value, strict=True)
    try:
        package = _package_info(root)
        # Electron's default userData directory follows its runtime app name:
        # top-level productName, then package.json name. electron-builder's
        # nested build.productName controls the packaged product label, not this
        # source-run profile path. The official source has name=lilacanime-desktop
        # and only a nested build.productName=LilacAnime.
        app_name = str(package.get("productName") or package.get("name") or "LilacAnime").strip()
        if not app_name or Path(app_name).name != app_name or app_name in {".", ".."}:
            raise OSError("공식 Electron 앱 이름이 올바르지 않습니다")
        app_data_value = os.environ.get("APPDATA", "").strip()
        if not app_data_value:
            raise OSError("APPDATA is unavailable")
        app_data = Path(app_data_value)
        local_storage = app_data / app_name / "Local Storage"
        leveldb = local_storage / "leveldb"
        if leveldb.is_dir():
            reason = "공식 테마는 Chromium LevelDB에 저장되어 있지만, 안전한 읽기 전용 해석기를 사용할 수 없습니다."
        else:
            candidate = local_storage / "file__0.localstorage"
            if candidate.is_file():
                try:
                    theme = _read_legacy_theme_sqlite(candidate)
                except sqlite3.Error as exc:
                    reason = f"공식 테마 SQLite 저장소를 읽지 못했습니다 ({type(exc).__name__})."
                else:
                    if theme in {"dark", "light", "system"}:
                        resolved = _system_theme()[0] if theme == "system" else theme
                        return {"status": "READ", "theme": resolved, "setting": theme, "source": str(candidate), "readOnly": True}
                    reason = "공식 테마 저장소에서 지원되는 값을 찾지 못했습니다."
            else:
                reason = "공식 테마 저장소를 찾지 못했습니다."
    except (OSError, ManagerError) as exc:
        reason = f"공식 테마 설정을 읽지 못했습니다: {type(exc).__name__}"
    fallback, source = _system_theme()
    global _LAST_THEME_DIAGNOSTIC
    diagnostic = (reason, fallback)
    if diagnostic != _LAST_THEME_DIAGNOSTIC:
        _append_manager_diagnostic("THEME_READ", "FALLBACK", reason)
        _LAST_THEME_DIAGNOSTIC = diagnostic
    return {"status": "FALLBACK", "theme": fallback, "source": source, "reason": reason, "readOnly": True}
