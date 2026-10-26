from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("manager_core", HERE / "manager_core.py")
manager_core = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = manager_core
SPEC.loader.exec_module(manager_core)


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

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write(self, relative: str, value: str) -> None:
        target = self.official / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value, encoding="utf-8", newline="")

    def _make_original(self) -> None:
        package = {"name": "lilac-fixture", "version": "0.5.54"}
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
        with mock.patch.object(manager_core.subprocess, "run", return_value=completed):
            result = manager_core.run_node_contracts(self.official, manager_core.PROJECT_ROOT)
        self.assertEqual((result["testCount"], result["passCount"], result["failCount"]), (10, 10, 0))

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
