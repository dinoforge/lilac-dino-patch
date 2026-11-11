"""Small, allow-listed JSON bridge from the Electron UI to manager_core."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

import manager_core as core
import installed_asar


MAX_REQUEST_BYTES = 1024 * 1024
MAX_DIAGNOSTICS_BYTES = 512 * 1024


def configure_utf8_stdio() -> None:
    """Keep the line-delimited JSON bridge UTF-8 regardless of Windows locale."""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if not callable(reconfigure):
            raise RuntimeError(f"관리자 {stream_name} 스트림의 UTF-8 설정을 지원하지 않습니다.")
        reconfigure(encoding="utf-8", errors="strict")


def dispatch(
    request: dict[str, Any],
    *,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Dispatch one fixed manager action without exposing arbitrary Python APIs."""
    if not isinstance(request, dict):
        raise core.ManagerError("관리자 요청 형식이 올바르지 않습니다.")

    operation = request.get("operation")
    root_value = request.get("root")
    if root_value is not None and not isinstance(root_value, str):
        raise core.ManagerError("원본 폴더 경로 형식이 올바르지 않습니다.")

    if operation == "info":
        _, manifest = core.load_manifest(core.patch_source_root())
        return {
            "managerVersion": core.MANAGER_VERSION,
            "patchVersion": str(manifest.get("patchVersion", core.PATCH_VERSION)),
            "officialVersion": str(manifest["officialVersion"]),
            "officialCommit": str(manifest["officialCommit"]),
        }

    if operation == "discover":
        start = request.get("start")
        if start is not None and not isinstance(start, str):
            raise core.ManagerError("자동 검색 시작 경로 형식이 올바르지 않습니다.")
        found = core.find_original_root(start)
        if found is None and start:
            anchor = core.canonical_path(start)
            if anchor.is_file():
                anchor = anchor.parent
            for candidate in (anchor, *list(anchor.parents)[:8]):
                if installed_asar.is_installed_target(candidate):
                    found = candidate
                    break
        return {"status": "SOURCE_FOUND" if found else "NO_SOURCE", "path": str(found) if found else None}

    if operation in {"startup", "inspect", "apply", "uninstall", "backups", "history", "theme", "restore"}:
        if not root_value:
            raise core.ManagerError("LilacAnime 원본 폴더를 먼저 확인하세요.")
        root = core.canonical_path(root_value, strict=True)
        if installed_asar.is_installed_target(root):
            if operation == "startup":
                return installed_asar.startup(root)
            if operation == "inspect":
                return installed_asar.inspect(root)
            if operation == "apply":
                return installed_asar.startup(root)
            if operation == "uninstall":
                return installed_asar.uninstall(root)
            if operation == "backups":
                return installed_asar.backups(root)
            if operation == "history":
                return installed_asar.history(root)
            if operation == "theme":
                theme, source = core._system_theme()
                return {"status": "FALLBACK", "theme": theme, "source": source,
                        "reason": "설치본 테마는 안전한 원본 설정 읽기 대상이 아닙니다.", "readOnly": True}
            if operation == "restore":
                backup_id = request.get("backupId")
                state = installed_asar._state(root)
                if not isinstance(backup_id, str) or state is None or backup_id != state.get("backupId"):
                    raise core.ManagerError("복원 대상이 기록된 설치본 백업과 일치하지 않습니다.")
                return installed_asar.uninstall(root)

        if operation == "startup":
            return core.automatic_startup_check(root, progress=progress)
        if operation == "inspect":
            return core.inspect_managed_target(root)
        if operation == "apply":
            return core.apply_patch_in_place(root, progress=progress)
        if operation == "uninstall":
            return core.uninstall_patch(root)
        if operation == "backups":
            return {"items": core.list_backups(root)}
        if operation == "history":
            return {"items": core.read_history(root)}
        if operation == "theme":
            return core.read_official_theme(root)
        if operation == "restore":
            backup_id = request.get("backupId")
            if not isinstance(backup_id, str):
                raise core.ManagerError("복원할 백업을 선택하세요.")
            return core.restore_backup(root, backup_id)

    if operation == "themeFallback":
        theme, source = core._system_theme()
        return {
            "status": "FALLBACK",
            "theme": theme,
            "source": source,
            "reason": "LilacAnime 원본 폴더를 찾지 못해 공식 테마를 읽을 수 없습니다.",
            "readOnly": True,
        }

    if operation == "updateCheck":
        current_version = request.get("currentVersion")
        if not isinstance(current_version, str) or len(current_version) > 40:
            raise core.ManagerError("공식 버전 정보가 올바르지 않습니다.")
        if root_value is not None:
            if not root_value or len(root_value) > 32768:
                raise core.ManagerError("공식 소스 업데이트 사전검사 경로가 올바르지 않습니다.")
            return core.preflight_official_source_update(current_version=current_version, root_value=root_value)
        return core.preflight_official_source_update(current_version=current_version)

    if operation == "updateApprove":
        update_info = request.get("updateInfo")
        if not isinstance(update_info, dict):
            raise core.ManagerError("공식 업데이트 조회 결과가 올바르지 않습니다.")
        return core.approve_official_update(update_info)

    if operation == "diagnostics":
        path = core.manager_home() / "manager.log"
        try:
            if not path.is_file():
                return {"items": [], "path": str(path)}
            size = path.stat().st_size
            if size > MAX_DIAGNOSTICS_BYTES:
                with path.open("rb") as stream:
                    stream.seek(-MAX_DIAGNOSTICS_BYTES, 2)
                    raw = stream.read(MAX_DIAGNOSTICS_BYTES)
            else:
                raw = path.read_bytes()
            items = [line for line in raw.decode("utf-8", "replace").splitlines() if line.strip()][-400:]
            return {"items": items, "path": str(path)}
        except OSError as exc:
            raise core.ManagerError(f"관리자 진단 기록을 읽지 못했습니다 ({type(exc).__name__}).") from exc

    raise core.ManagerError("지원하지 않는 관리자 작업입니다.")


def main() -> int:
    configure_utf8_stdio()
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        print(json.dumps({"type": "error", "errorType": "ManagerError", "error": "요청 데이터가 허용 크기를 넘었습니다."}, ensure_ascii=False))
        return 2
    try:
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            raise core.ManagerError("관리자 요청 형식이 올바르지 않습니다.")

        def emit_progress(message: str) -> None:
            print(json.dumps({"type": "progress", "message": str(message)[:1000]}, ensure_ascii=False), flush=True)

        result = dispatch(request, progress=emit_progress)
        print(json.dumps({"type": "result", "result": result}, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        message = str(exc) or type(exc).__name__
        print(json.dumps({"type": "error", "errorType": type(exc).__name__, "error": message[:4000]}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
