from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import re
import queue
import sqlite3
import shutil
import sys
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest import mock


HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("manager_core", HERE / "manager_core.py")
manager_core = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = manager_core
SPEC.loader.exec_module(manager_core)
GUI_SPEC = importlib.util.spec_from_file_location("manager_gui", HERE / "manager_gui.py")
manager_gui = importlib.util.module_from_spec(GUI_SPEC)
assert GUI_SPEC and GUI_SPEC.loader
sys.modules[GUI_SPEC.name] = manager_gui
GUI_SPEC.loader.exec_module(manager_gui)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


class PatchManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="dino-manager-test-")
        self.root = Path(self.temp.name)
        self.official = self.root / "official"
        self.official.mkdir()
        self.patch = self.root / "patch"
        self.patch.mkdir()
        self.source = self.official
        self._make_original()
        self.manifest = self._make_manifest()
        (self.patch / "patches" / "patch03").mkdir(parents=True)
        for item in self.manifest["runtimeModules"]:
            source = manager_core.PROJECT_ROOT / item["source"]
            target = self.patch / item["source"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        self._write_manifest()
        # Test outputs live inside this test-owned Temp root. Production protection
        # roots stay active in normal application use.
        self.protected_patch = mock.patch.object(
            manager_core,
            "protected_roots",
            return_value=[manager_core.PROJECT_ROOT, Path(r"D:\LilacAnime")],
        )
        self.protected_patch.start()
        self.addCleanup(self.protected_patch.stop)
        isolated_protected = self.root.parent / f"protected-profile-{self.root.name}"
        self.environment_patch = mock.patch.dict(
            manager_core.os.environ,
            {
                "APPDATA": str(isolated_protected / "Roaming"),
                "LOCALAPPDATA": str(isolated_protected / "Local"),
                "ProgramData": str(isolated_protected / "ProgramData"),
                "ProgramFiles": str(isolated_protected / "ProgramFiles"),
                "ProgramFiles(x86)": str(isolated_protected / "ProgramFiles86"),
                "WINDIR": str(isolated_protected / "Windows"),
            },
        )
        self.environment_patch.start()
        self.addCleanup(self.environment_patch.stop)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write(self, relative: str, value: str) -> None:
        target = self.official / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value, encoding="utf-8", newline="")

    def _make_original(self) -> None:
        package = {
            "name": "lilac-fixture",
            "version": "0.5.54",
            "build": {"productName": "LilacAnime", "appId": "com.lilac.anime.desktop"},
        }
        self._write("package.json", json.dumps(package))
        self._write("package-lock.json", json.dumps({"lockfileVersion": 3}))
        state_anchor = (
            "const state = { season: [], top: [], library: store.get('library'), history: store.get('history'), "
            "downloads:[], source: localStorage.getItem('contentSource') || 'reanime',"
        )
        self._write("src/app.js", f"{state_anchor}\nfunction doSearch() {{}}\nfunction openDetail() {{}}\n")
        self._write(
            "src/index.html",
            '<link rel="stylesheet" href="styles.css" />\n'
            '<div id="detailDialog"></div>\n'
            '<div><button data-value="miruro">Miruro</button></div>'
            '<p>선택한 사이트의 애니 목록·제목·회차·영상 소스를 함께 사용합니다.</p>\n'
            '<select><option value="miruro">Miruro</option></select>\n'
            '<script src="app.js"></script>\n',
        )
        self._write("src/styles.css", "/* fixture stylesheet */\n")
        self._write(
            "electron/preload.cjs",
            "const api = {\n"
            "  providerCatalog: (provider, query) => ipcRenderer.invoke('provider:catalog', provider, query),\n"
            "  providerDetail: (provider, id) => ipcRenderer.invoke('provider:detail', provider, id),\n"
            "  providerResolve: (provider, episode) => ipcRenderer.invoke('provider:resolve', provider, episode),\n"
            "};\n",
        )
        self._write(
            "electron/main.cjs",
            "ipcMain.handle('provider:catalog', () => {});\n"
            "ipcMain.handle('provider:detail', () => {});\n"
            "ipcMain.handle('provider:resolve', () => {});\n",
        )

    def _make_manifest(self) -> dict:
        actual = json.loads((manager_core.PROJECT_ROOT / manager_core.MANIFEST_RELATIVE).read_text(encoding="utf-8"))
        manifest = copy.deepcopy(actual)
        manifest["officialArchiveSha256"] = "A" * 64
        manifest["officialTreeFileCount"] = len(manager_core._inventory(self.official))
        manifest["officialTreeSha256"] = manager_core.tree_sha256(manager_core._inventory(self.official))
        return manifest

    def _write_manifest(self) -> None:
        (self.patch / "patches" / "patch03" / "manifest.json").write_text(
            json.dumps(self.manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def test_manifest_module_hashes_match_real_patch_files(self) -> None:
        _, loaded = manager_core.load_manifest(self.patch)
        self.assertEqual(len(loaded["runtimeModules"]), 3)
        self.assertEqual(
            {module["destination"] for module in loaded["runtimeModules"]},
            manager_core.EXPECTED_MODULES,
        )

    def test_missing_or_modified_module_is_rejected(self) -> None:
        item = self.manifest["runtimeModules"][0]
        module_path = self.patch / item["source"]
        data = module_path.read_bytes()
        module_path.write_bytes(data + b"\n// modified in test\n")
        with self.assertRaisesRegex(manager_core.ManagerError, "SHA-256"):
            manager_core.load_manifest(self.patch)
        module_path.unlink()
        with self.assertRaisesRegex(manager_core.ManagerError, "필수 패치 파일"):
            manager_core.load_manifest(self.patch)

    def test_manifest_rejects_repeated_or_missing_patch_contract_entries(self) -> None:
        duplicate = copy.deepcopy(self.manifest)
        duplicate["connections"].append(copy.deepcopy(duplicate["connections"][0]))
        with self.assertRaises(manager_core.ManagerError):
            manager_core.validate_manifest(duplicate)
        missing = copy.deepcopy(self.manifest)
        missing["officialApis"].pop()
        with self.assertRaises(manager_core.ManagerError):
            manager_core.validate_manifest(missing)

    def test_node_contract_summary_is_decoded_as_utf8_and_required(self) -> None:
        completed = __import__("subprocess").CompletedProcess(
            args=[], returncode=0, stdout="ℹ tests 10\nℹ pass 10\nℹ fail 0\n", stderr=""
        )
        with mock.patch.object(manager_core.subprocess, "run", return_value=completed) as runner:
            result = manager_core.run_node_contracts(self.official, manager_core.PROJECT_ROOT)
        self.assertEqual((result["testCount"], result["passCount"], result["failCount"]), (10, 10, 0))
        if manager_core.os.name == "nt":
            self.assertEqual(len(runner.call_args_list), 4)
            self.assertTrue(all(
                call.kwargs.get("creationflags") == manager_core.subprocess.CREATE_NO_WINDOW
                for call in runner.call_args_list
            ))

        missing_summary = __import__("subprocess").CompletedProcess(args=[], returncode=0, stdout="done\n", stderr="")
        with mock.patch.object(manager_core.subprocess, "run", side_effect=[completed, completed, completed, missing_summary]):
            with self.assertRaisesRegex(manager_core.ManagerError, "종료 요약"):
                manager_core.run_node_contracts(self.official, manager_core.PROJECT_ROOT)

    def test_apply_changes_only_allowlisted_files_and_preserves_source(self) -> None:
        source_before = manager_core._inventory(self.official)
        output = self.root / "parent" / "patched"
        output.parent.mkdir()
        fake_contracts = {
            "status": "PASS",
            "testCount": 1,
            "passCount": 1,
            "failCount": 0,
            "output": "synthetic contract result",
        }
        with mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts):
            result = manager_core.apply_patch(self.official, self.patch, output)

        self.assertEqual(source_before, manager_core._inventory(self.official))
        self.assertEqual(result["modifiedOfficialFiles"], ["src/app.js", "src/index.html"])
        self.assertEqual(result["addedPatchFiles"], sorted(manager_core.EXPECTED_MODULES))
        self.assertEqual(result["removedFiles"], [])
        self.assertEqual(result["outputPostMoveSha256"], manager_core.tree_sha256(manager_core._inventory(output)))
        self.assertTrue(Path(result["reportPath"]).is_file())
        self.assertIn("savedContentSource === 'integrated'", (output / "src/app.js").read_text(encoding="utf-8"))
        duplicate = self.root / "parent" / "second-application"
        with self.assertRaises(manager_core.ManagerError):
            manager_core.apply_patch(output, self.patch, duplicate)
        self.assertFalse(duplicate.exists())

    def test_existing_output_is_rejected_without_touching_it(self) -> None:
        output = self.root / "existing"
        output.mkdir()
        marker = output / "keep.txt"
        marker.write_text("owned before", encoding="utf-8")
        with self.assertRaises(manager_core.ManagerError):
            manager_core.apply_patch(self.official, self.patch, output)
        self.assertEqual(marker.read_text(encoding="utf-8"), "owned before")

    def test_mutated_official_tree_is_rejected(self) -> None:
        (self.official / "src" / "styles.css").write_text("modified\n", encoding="utf-8")
        with self.assertRaisesRegex(manager_core.ManagerError, "파일 수|트리 SHA"):
            manager_core.inspect_source(self.official, self.manifest)

    def test_updated_source_with_changed_ipc_contract_is_rejected(self) -> None:
        main = self.official / "electron" / "main.cjs"
        main.write_text("ipcMain.handle('provider:catalog-v2', () => {});\n", encoding="utf-8")
        files = manager_core._inventory(self.official)
        self.manifest["officialTreeFileCount"] = len(files)
        self.manifest["officialTreeSha256"] = manager_core.tree_sha256(files)
        with self.assertRaisesRegex(manager_core.ManagerError, "IPC 계약"):
            manager_core.inspect_source(self.official, self.manifest)

    def test_missing_or_duplicate_anchor_is_rejected(self) -> None:
        app = self.official / "src" / "app.js"
        app.write_text("no reviewed source anchor\n", encoding="utf-8")
        with self.assertRaises(manager_core.ManagerError):
            manager_core._apply_connections(self.official, self.manifest)

    def test_failed_module_copy_does_not_publish_output_and_keeps_stage(self) -> None:
        output = self.root / "parent" / "failed-output"
        output.parent.mkdir()
        with mock.patch.object(manager_core, "_copy_modules", side_effect=manager_core.ManagerError("synthetic copy failure")):
            with self.assertRaises(manager_core.ManagerError) as caught:
                manager_core.apply_patch(self.official, self.patch, output)
        self.assertFalse(output.exists())
        notes = "\n".join(getattr(caught.exception, "__notes__", []))
        stage = Path(notes.split(": ", 1)[-1])
        self.assertTrue(stage.is_dir())

    def test_zip_path_traversal_is_rejected_before_extract(self) -> None:
        archive = self.root / "bad.zip"
        destination = self.root / "extract"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("LilacAnime-desktop-e4ac62214f5c4863eebae5052633e7f9f33dcbaa/package.json", "{}")
            zf.writestr("../outside.txt", "must not escape")
        with self.assertRaises(manager_core.ManagerError):
            manager_core._extract_zip(archive, destination, self.manifest)
        self.assertFalse((self.root / "outside.txt").exists())
        self.assertFalse(destination.exists())

    def test_output_cannot_overlap_development_project(self) -> None:
        with self.assertRaises(manager_core.ManagerError):
            manager_core.assert_safe_output(manager_core.PROJECT_ROOT / "new-output", self.official, "folder")

    def test_source_and_output_cannot_overlap(self) -> None:
        with self.assertRaises(manager_core.ManagerError):
            manager_core.assert_safe_source(manager_core.PROJECT_ROOT)
        with self.assertRaises(manager_core.ManagerError):
            manager_core.assert_safe_output(self.official / "out", self.official, "folder")

    def test_new_official_version_is_marked_additional_not_applyable(self) -> None:
        package_file = self.official / "package.json"
        package_file.write_text(json.dumps({"name": "lilac-fixture", "version": "0.5.55"}), encoding="utf-8")
        result = manager_core.check_compatibility(self.official, self.patch, project_root=manager_core.PROJECT_ROOT)
        self.assertEqual(result["status"], "ADDITIONAL_CHECK_REQUIRED")
        self.assertFalse(result["applyAuthorized"])
        self.assertEqual(result["version"], "0.5.55")

    def test_unpinned_archive_is_marked_additional_without_extract_or_install(self) -> None:
        archive = self.root / "another-source.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("source/package.json", '{"version":"0.5.55"}')
        result = manager_core.check_compatibility(archive, self.patch, project_root=manager_core.PROJECT_ROOT)
        self.assertEqual(result["status"], "ADDITIONAL_CHECK_REQUIRED")
        self.assertFalse(result["applyAuthorized"])
        self.assertIn("해시", result["findings"][0])

    def _apply_in_place(self) -> dict:
        fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
        with mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts):
            return manager_core.apply_patch_in_place(
                self.official,
                self.patch,
                process_check=lambda _root: None,
            )

    def test_in_place_apply_is_backed_up_exactly_and_second_run_is_idempotent(self) -> None:
        before = manager_core._inventory(self.official)
        result = self._apply_in_place()
        self.assertEqual(result["status"], "APPLIED")
        self.assertEqual(result["modifiedOfficialFiles"], ["src/app.js", "src/index.html"])
        self.assertEqual(result["addedPatchFiles"], sorted(manager_core.EXPECTED_MODULES))
        self.assertEqual(set(manager_core._inventory(self.official)) - set(before), manager_core.EXPECTED_MODULES)
        backups = manager_core.list_backups(self.official)
        self.assertEqual(len(backups), 1)
        self.assertEqual({item["path"] for item in backups[0]["files"]}, manager_core.EXPECTED_CONNECTION_FILES | manager_core.EXPECTED_MODULES)
        self.assertTrue((self.official / "DinoPatchManager" / "state" / "patch-state.json").is_file())

        second = manager_core.apply_patch_in_place(
            self.official,
            self.patch,
            process_check=lambda _root: self.fail("멱등 적용 확인에서 앱 실행 검사까지 다시 할 필요가 없습니다."),
        )
        self.assertEqual(second["status"], "ALREADY_APPLIED")
        self.assertEqual(len(manager_core.list_backups(self.official)), 1)

    def test_uninstall_and_backup_restore_reinstate_the_exact_source_tree(self) -> None:
        before = manager_core._inventory(self.official)
        applied = self._apply_in_place()
        result = manager_core.uninstall_patch(
            self.official,
            patch_root_value=self.patch,
            process_check=lambda _root: None,
        )
        self.assertEqual(result["status"], "RESTORED")
        self.assertEqual(manager_core._inventory(self.official), before)
        state = manager_core._read_json_file(self.official / "DinoPatchManager" / "state" / "patch-state.json", "state")
        self.assertEqual(state["status"], "UNPATCHED")
        backup = manager_core.list_backups(self.official)[0]
        self.assertFalse(backup["restorable"])
        with self.assertRaises(manager_core.ManagerError):
            manager_core.restore_backup(self.official, applied["backupId"], patch_root_value=self.patch, process_check=lambda _root: None)

    def test_conflicting_user_change_blocks_restore_without_overwriting_it(self) -> None:
        applied = self._apply_in_place()
        target = self.official / "src" / "app.js"
        target.write_text(target.read_text(encoding="utf-8") + "\n// user edit\n", encoding="utf-8")
        changed = target.read_bytes()
        with self.assertRaisesRegex(manager_core.ManagerError, "사용자 변경"):
            manager_core.restore_backup(self.official, applied["backupId"], patch_root_value=self.patch, process_check=lambda _root: None)
        self.assertEqual(target.read_bytes(), changed)

    def test_restore_metadata_failure_rolls_back_files_and_keeps_backup_restorable(self) -> None:
        applied = self._apply_in_place()
        after_patch = manager_core._inventory(self.official)
        backup_file = self.official / "DinoPatchManager" / "backups" / applied["backupId"] / "backup.json"
        state_file = self.official / "DinoPatchManager" / "state" / "patch-state.json"
        old_backup = backup_file.read_bytes()
        old_state = state_file.read_bytes()
        original_write = manager_core._atomic_write_json

        def fail_backup_metadata(path, data):
            if Path(path).name == "backup.json":
                raise OSError("synthetic metadata failure")
            return original_write(path, data)

        with mock.patch.object(manager_core, "_atomic_write_json", side_effect=fail_backup_metadata):
            with self.assertRaisesRegex(manager_core.ManagerError, "되돌렸습니다"):
                manager_core.restore_backup(self.official, applied["backupId"], patch_root_value=self.patch, process_check=lambda _root: None)
        self.assertEqual(manager_core._inventory(self.official), after_patch)
        self.assertEqual(backup_file.read_bytes(), old_backup)
        self.assertEqual(state_file.read_bytes(), old_state)
        self.assertTrue(manager_core._read_json_file(backup_file, "backup")["restorable"])

    def test_running_app_detection_fails_closed(self) -> None:
        completed = __import__("subprocess").CompletedProcess(args=[], returncode=0, stdout="LilacAnime.exe:1234", stderr="")
        with mock.patch.object(manager_core.os, "name", "nt"):
            with self.assertRaisesRegex(manager_core.ManagerError, "실행 중"):
                manager_core.assert_app_not_running(self.official, runner=lambda *_args, **_kwargs: completed)

    def test_process_check_hides_console_window_on_windows(self) -> None:
        completed = __import__("subprocess").CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        call = {}

        def runner(*_args, **kwargs):
            call.update(kwargs)
            return completed

        with mock.patch.object(manager_core.os, "name", "nt"):
            manager_core.assert_app_not_running(self.official, runner=runner)
        self.assertEqual(call.get("creationflags"), manager_core.subprocess.CREATE_NO_WINDOW)

    def test_automatic_startup_detects_and_patches_source_once(self) -> None:
        self.assertEqual(manager_core.find_original_root(self.official), self.official)
        fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
        with mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts):
            first = manager_core.automatic_startup_check(
                self.official,
                patch_root_value=self.patch,
                process_check=lambda _root: None,
            )
            second = manager_core.automatic_startup_check(
                self.official,
                patch_root_value=self.patch,
                process_check=lambda _root: self.fail("이미 적용된 원본은 다시 패치하면 안 됩니다."),
            )
        self.assertEqual(first["status"], "APPLIED")
        self.assertEqual(second["status"], "APPLIED")

    def test_unknown_version_is_rejected_before_manager_state_or_runtime_writes(self) -> None:
        package_path = self.official / "package.json"
        package = json.loads(package_path.read_text(encoding="utf-8"))
        package["version"] = "0.5.99"
        package_path.write_text(json.dumps(package), encoding="utf-8")
        before = manager_core._inventory(self.official)
        with self.assertRaisesRegex(manager_core.ManagerError, "지원 기준 버전"):
            manager_core.inspect_managed_target(self.official, self.patch)
        self.assertFalse((self.official / "DinoPatchManager").exists())
        self.assertEqual(manager_core._inventory(self.official), before)

    def test_manager_state_path_rejects_a_reparse_component(self) -> None:
        protected = self.official / "DinoPatchManager" / "state"
        with mock.patch.object(manager_core, "_is_link_or_junction", side_effect=lambda path: Path(path) == protected):
            with self.assertRaisesRegex(manager_core.ManagerError, "심볼릭 링크"):
                manager_core._state_path(self.official)

    def test_official_update_check_and_approval_fail_closed(self) -> None:
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        newer = Response(json.dumps({"tag_name": "v0.5.55", "html_url": "https://github.com/release"}).encode())
        info = manager_core.check_official_update(current_version="0.5.54", opener=lambda *_args, **_kwargs: newer)
        self.assertEqual(info["status"], "UPDATE_AVAILABLE_UNSUPPORTED")
        self.assertEqual(manager_core.approve_official_update(info)["status"], "UNSUPPORTED")
        old = Response(json.dumps({"tag_name": "v0.5.54"}).encode())
        current = manager_core.check_official_update(current_version="0.5.54", opener=lambda *_args, **_kwargs: old)
        self.assertEqual(current["status"], "UP_TO_DATE")
        failed = manager_core.check_official_update(current_version="0.5.54", opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.URLError("offline")))
        self.assertEqual(failed["status"], "CHECK_FAILED")

    def test_theme_reads_legacy_storage_read_only_and_leveldb_falls_back(self) -> None:
        app_data = self.root / "profile"
        storage = app_data / "LilacAnime" / "Local Storage"
        storage.mkdir(parents=True)
        db = sqlite3.connect(storage / "file__0.localstorage")
        db.execute("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)")
        db.execute("INSERT INTO ItemTable(key, value) VALUES (?, ?)", ("theme", b"light"))
        db.commit()
        db.close()
        with mock.patch.dict(manager_core.os.environ, {"APPDATA": str(app_data)}):
            result = manager_core.read_official_theme(self.official)
        self.assertEqual((result["status"], result["theme"], result["readOnly"]), ("READ", "light", True))
        db = sqlite3.connect(storage / "file__0.localstorage")
        try:
            self.assertEqual(db.execute("SELECT value FROM ItemTable WHERE key='theme'").fetchone()[0], b"light")
        finally:
            db.close()

        (storage / "file__0.localstorage").unlink()
        (storage / "leveldb").mkdir()
        (storage / "leveldb" / "000001.log").write_bytes(b"synthetic-leveldb")
        with mock.patch.dict(manager_core.os.environ, {"APPDATA": str(app_data)}), mock.patch.object(manager_core, "manager_home", return_value=self.root / "manager-home"):
            result = manager_core.read_official_theme(self.official)
        self.assertEqual(result["status"], "FALLBACK")
        self.assertIn("LevelDB", result["reason"])
        self.assertEqual(result["readOnly"], True)
        self.assertTrue((self.root / "manager-home" / "manager.log").is_file())

    def test_manager_version_is_the_build_output_version_source(self) -> None:
        manager_source = (HERE / "manager_core.py").read_text(encoding="utf-8")
        build_script = (HERE / "build_windows.ps1").read_text(encoding="utf-8")
        version_values = re.findall(
            r'(?m)^\s*MANAGER_VERSION\s*=\s*["\'](\d+\.\d+\.\d+)["\']\s*$',
            manager_source,
        )
        self.assertEqual(version_values, [manager_core.MANAGER_VERSION])
        self.assertIn('DinoPatchManager-v$managerVersion', build_script)
        self.assertNotRegex(build_script, r'DinoPatchManager-v\d+\.\d+\.\d+')

    def test_update_completion_replaces_loading_status_and_hides_progress(self) -> None:
        class Value:
            def __init__(self) -> None:
                self.value = ""

            def set(self, value: str) -> None:
                self.value = value

        manager = type("FakeManager", (), {})()
        manager._update_info = None
        manager.update_var = Value()
        manager.update_apply_button = mock.Mock()
        manager.recent_var = Value()
        manager.status_var = Value()
        manager._log = mock.Mock()
        manager_gui.DinoPatchManager._handle_success(
            manager,
            "update",
            {"status": "UP_TO_DATE", "currentVersion": "0.5.54", "latestVersion": "0.5.54"},
        )
        self.assertIn("조회가 끝났습니다", manager.status_var.value)

        manager = type("FakeManager", (), {})()
        manager._closing = False
        manager._busy = True
        manager._events = queue.Queue()
        manager._events.put(("done", ("update", {"status": "UP_TO_DATE"})))
        manager.progress = mock.Mock()
        manager._handle_success = mock.Mock()
        manager._set_controls = mock.Mock()
        manager._poll_events = mock.Mock()
        manager.root = mock.Mock()
        manager_gui.DinoPatchManager._poll_events(manager)
        manager.progress.stop.assert_called_once()
        manager.progress.grid_remove.assert_called_once()
        self.assertFalse(manager._busy)

    def test_legacy_preview_lists_manifest_connections_and_runtime_modules(self) -> None:
        class Tree:
            def __init__(self) -> None:
                self.rows: list[tuple[str, str, tuple[str, str, str]]] = []

            def get_children(self) -> list[str]:
                return [str(index) for index, _row in enumerate(self.rows)]

            def delete(self, item: str) -> None:
                self.rows.pop(int(item))

            def insert(self, _parent: str, _where: str, *, values: tuple[str, str, str]) -> None:
                self.rows.append(("", "end", values))

        manager = type("FakeManager", (), {})()
        manager.change_tree = Tree()
        manager._log = mock.Mock()
        with mock.patch.object(manager_gui, "patch_source_root", return_value=manager_core.PROJECT_ROOT):
            manager_gui.DinoPatchManager._populate_preview(manager)

        _root, manifest = manager_core.load_manifest(manager_core.PROJECT_ROOT)
        expected_paths = [item["file"] for item in manifest["connections"]]
        expected_paths.extend(item["destination"] for item in manifest["runtimeModules"])
        self.assertCountEqual([row[2][1] for row in manager.change_tree.rows], expected_paths)
        self.assertEqual(len(manager.change_tree.rows), len(expected_paths))
        self.assertFalse(manager._log.called)

    def test_legacy_main_log_mirrors_manager_events(self) -> None:
        class Text:
            def __init__(self) -> None:
                self.value = ""

            def winfo_exists(self) -> bool:
                return True

            def configure(self, **_kwargs) -> None:
                pass

            def delete(self, _start: str, _end: str) -> None:
                self.value = ""

            def insert(self, _where: str, value: str) -> None:
                self.value += value

            def see(self, _where: str) -> None:
                pass

        manager = type("FakeManager", (), {})()
        manager._closing = False
        manager._log_messages = []
        manager.main_log = Text()
        manager._diagnostics_window = None
        manager._text_views = []
        manager._set_text = manager_gui.DinoPatchManager._set_text
        manager_gui.DinoPatchManager._log(manager, "상태 확인 시작")

        self.assertEqual(manager.main_log.value, "상태 확인 시작")
        self.assertEqual(manager._log_messages, ["상태 확인 시작"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
