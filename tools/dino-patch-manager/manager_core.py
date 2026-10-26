"""Safe, manifest-driven file engine for the Dino patch manager."""

from __future__ import annotations

import difflib
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
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable


PROJECT_ROOT = Path(__file__).resolve().parents[2]
EXPECTED_PROJECT_ROOT = Path(r"D:\Codex-Coding-Folder\LilacAnime-Player")
MANIFEST_RELATIVE = Path("patches") / "patch03" / "manifest.json"
VALIDATOR_RELATIVE = Path("scripts") / "validate-patch03-clean-source.cjs"
CONTRACT_TEST_RELATIVE = Path("tests") / "patch03-clean-source.contract.test.cjs"
OFFICIAL_SOURCE_NAME = "LilacAnime-desktop-{}"
MAX_ARCHIVE_FILES = 20_000
MAX_ARCHIVE_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024
EXPECTED_MODULES = {
    "src/integrated-search.js",
    "src/integrated-search.css",
    "src/patch03-bridge.js",
}
EXPECTED_CONNECTION_FILES = {"src/app.js", "src/index.html"}
EXPECTED_PROVIDERS = ["reanime", "miruro", "animenosub", "ohli24", "linkani"]


class ManagerError(RuntimeError):
    """A safe, user-displayable validation or application failure."""


def _norm(path: Path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def canonical_path(value: str | os.PathLike[str], *, strict: bool = False) -> Path:
    raw = Path(value).expanduser()
    try:
        return raw.resolve(strict=strict)
    except (OSError, RuntimeError) as exc:
        raise ManagerError(f"경로를 실제 위치로 확인할 수 없습니다: {value} ({exc})") from exc


def same_or_within(candidate: Path, parent: Path) -> bool:
    child = canonical_path(candidate)
    base = canonical_path(parent)
    try:
        child.relative_to(base)
        return True
    except ValueError:
        return False


def paths_overlap(left: Path, right: Path) -> bool:
    return same_or_within(left, right) or same_or_within(right, left)


def assert_project_root(root: Path = PROJECT_ROOT) -> Path:
    actual = canonical_path(root, strict=True)
    expected = canonical_path(EXPECTED_PROJECT_ROOT)
    if _norm(actual) != _norm(expected):
        raise ManagerError(f"이 도구는 지정된 개발 프로젝트에서만 실행할 수 있습니다: {actual}")
    return actual


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
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def _module_path(root: Path, relative: str) -> Path:
    rel = _safe_relative(relative)
    target = canonical_path(root / Path(*rel.split("/")))
    if not same_or_within(target, root):
        raise ManagerError(f"manifest 경로가 선택한 폴더 밖으로 나갑니다: {relative}")
    return target


def load_manifest(patch_root: str | os.PathLike[str]) -> tuple[Path, dict[str, Any]]:
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
    for module in manifest["runtimeModules"]:
        source = _module_path(root, module["source"])
        if not source.is_file():
            raise ManagerError(f"필수 패치 파일이 없습니다: {module['source']}")
        actual = _sha256_file(source)
        if actual != module["sha256"].upper():
            raise ManagerError(f"패치 파일 SHA-256이 manifest와 다릅니다: {module['source']}")
    return root, manifest


def validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, dict):
        raise ManagerError("manifest 최상위 값은 JSON 객체여야 합니다.")
    required_text = ("officialVersion", "officialCommit", "officialArchiveSha256", "officialTreeSha256")
    if any(not isinstance(manifest.get(key), str) or not manifest[key] for key in required_text):
        raise ManagerError("manifest에 공식 버전·커밋·원본 SHA 정보가 빠졌습니다.")
    if not re.fullmatch(r"[0-9a-f]{40}", manifest["officialCommit"], re.I):
        raise ManagerError("manifest 공식 커밋 SHA 형식이 잘못됐습니다.")
    for key in ("officialArchiveSha256", "officialTreeSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", manifest[key], re.I):
            raise ManagerError(f"manifest {key} 형식이 잘못됐습니다.")
    if not isinstance(manifest.get("officialTreeFileCount"), int) or manifest["officialTreeFileCount"] <= 0:
        raise ManagerError("manifest 공식 파일 개수가 잘못됐습니다.")
    if manifest.get("officialTreeHashFormat") != "SHA256(sorted(relative path UTF-8 + NUL + raw file SHA256 digest + LF))":
        raise ManagerError("알 수 없는 공식 원본 트리 해시 형식입니다.")

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
            if entry.is_symlink():
                raise ManagerError(f"원본 트리에 심볼릭 링크/정션이 있습니다: {entry.relative_to(root)}")
            kept.append(name)
        dirs[:] = kept
        for name in files:
            entry = current_path / name
            relative = entry.relative_to(root).as_posix()
            if relative == ".git" or relative.startswith(".git/") or relative == "node_modules" or relative.startswith("node_modules/"):
                continue
            if entry.is_symlink():
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
    if "window.lilac.providerCatalog(provider, text)" not in bridge or "officialOpenDetail.call(this, id)" not in bridge:
        raise ManagerError("Patch 브리지가 공식 검색/상세 진입 함수를 우회합니다.")
    if "savedContentSource === 'integrated'" not in app:
        raise ManagerError("통합 모드에서 마지막 개별 공급원 상태 연결이 없습니다.")
    for provider in EXPECTED_PROVIDERS:
        if provider not in search_module:
            raise ManagerError(f"통합 검색 공급원 목록에서 {provider}를 찾지 못했습니다.")
    if re.search(r"['\"]linkkf['\"]", search_module):
        raise ManagerError("Linkkf가 Patch 03 통합 공급원 목록에 포함되어 있습니다.")


def _node_executable() -> str | None:
    return shutil.which("node")


def run_node_contracts(source_root: Path, project_root: Path = PROJECT_ROOT, *, timeout: int = 120) -> dict[str, Any]:
    node = _node_executable()
    if not node:
        return {"status": "NOT RUN", "reason": "Node.js를 찾지 못해 계약 테스트와 구문 검사를 실행하지 못했습니다."}
    targets = [
        source_root / "src" / "app.js",
        source_root / "src" / "integrated-search.js",
        source_root / "src" / "patch03-bridge.js",
    ]
    for target in targets:
        result = subprocess.run(
            [node, "--check", str(target)], cwd=project_root, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=timeout,
        )
        if result.returncode:
            raise ManagerError(f"JavaScript 구문 검사 실패: {target.name}\n{_redact(result.stderr or result.stdout)}")
    contract = project_root / CONTRACT_TEST_RELATIVE
    if not contract.is_file():
        raise ManagerError("공식 원본용 계약 테스트 파일이 없습니다.")
    env = os.environ.copy()
    env["PATCH03_SOURCE_ROOT"] = str(source_root)
    result = subprocess.run(
        [node, "--test", str(contract)], cwd=project_root, env=env, capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=timeout,
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
        node_result = run_node_contracts(copied)
        report = {
            "result": "PASS" if node_result["status"] == "PASS" else "ADDITIONAL_CHECK_REQUIRED",
            "sourceKind": "folder",
            "sourceVersion": manifest["officialVersion"],
            "officialCommit": manifest["officialCommit"],
            "officialTreeSha256": manifest["officialTreeSha256"],
            "patchResult": patch_result,
            "contracts": node_result,
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
    result = subprocess.run(args, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
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
    patch_root, manifest = load_manifest(patch_root_value)
    source, kind = assert_safe_source(source_value, project_root)
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
    try:
        result = inspect_source(source, manifest, project_root)
    except ManagerError as exc:
        message = str(exc)
        if "지원 기준 버전은" in message or "공식 원본 파일 수가 다릅니다" in message or "공식 원본 파일 트리 SHA-256 불일치" in message:
            return inspect_unpinned_folder(source, manifest)
        raise
    if progress:
        progress("공식 파일 트리와 연결 계약을 확인하고, OS Temp 복사본에 패치를 미리 적용합니다.")
    test_result = _check_folder_compatibility(source, patch_root, manifest, progress)
    return {**result, **test_result, "status": test_result["result"]}


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
    patch_root, manifest = load_manifest(patch_root_value)
    source, kind = assert_safe_source(source_value, project_root)
    if kind == "folder":
        _verify_original_root(source, manifest)
        return _preview(source, manifest)
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
    patch_root, manifest = load_manifest(patch_root_value)
    source, kind = assert_safe_source(source_value, root)
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
