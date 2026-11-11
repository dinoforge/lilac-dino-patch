"""Isolated ASAR compatibility, safe transactional backup and restore tests."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import installed_asar as ia
import manager_bridge as bridge
import manager_core as core


def synthetic_asar(path: Path, files: dict[str, bytes]):
    header = {"files": {}}
    offset = 0
    for relative, blob in files.items():
        directory = header
        parts = relative.split("/")
        for name in parts[:-1]:
            directory = directory["files"].setdefault(name, {"files": {}})
        directory["files"][parts[-1]] = {"size": len(blob), "offset": str(offset)}
        offset += len(blob)
    payload = json.dumps(header, separators=(",", ":")).encode()
    pickle = struct.pack("<II", 4 + len(payload), len(payload)) + payload + b"\0" * ((-len(payload)) % 4)
    with path.open("wb") as out:
        out.write(struct.pack("<II", 4, len(pickle)) + pickle)
        for value in files.values():
            out.write(value)


class TestInstalledAsar(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.install = self.base / "LilacAnime"
        (self.install / "resources").mkdir(parents=True)
        (self.install / "LilacAnime.exe").write_bytes(b"fake installed executable")
        self.archive = self.install / "resources" / "app.asar"
        package = {"version": "0.5.54", "build": {"appId": "com.lilac.anime.desktop"}}
        self.original = {
            "package.json": json.dumps(package).encode(),
            "src/app.js": b"// original app\nconst source = 'reanime';\n",
            "src/index.html": b"<html><script src=\"app.js\"></script></html>",
            "electron/main.cjs": b"const { app } = require('electron');",
            "src/other.js": b"const doNotTouch = 123;",
        }
        synthetic_asar(self.archive, self.original)
        fixture_sha = {name: core._git_blob_sha1(value) for name, value in self.original.items()
                       if name in ia.SUPPORTED["0.5.54"]}
        self.hash_patch = mock.patch.dict(ia.SUPPORTED, {"0.5.54": fixture_sha})
        self.hash_patch.start()
        self.addCleanup(self.hash_patch.stop)
        self.patch = self.base / "patch"
        (self.patch / "src").mkdir(parents=True)
        mod = b"console.log('new module');"
        (self.patch / "src" / "integrated-search.js").write_bytes(mod)
        self.manifest = {
            "_profilePinned": True,
            "connections": [
                {"file": "src/app.js", "before": "const source = 'reanime';",
                 "after": "const source = 'integrated';", "description": "source switch"},
                {"file": "src/index.html", "before": 'src="app.js"',
                 "after": 'src="integrated-search.js"', "description": "module loading"},
            ],
            "runtimeModules": [
                {"source": "src/integrated-search.js", "destination": "src/integrated-search.js",
                 "sha256": hashlib.sha256(mod).hexdigest().upper()},
            ],
        }
        self.manifest_patch = mock.patch.object(ia, "_manifest", return_value=(self.patch, self.manifest))
        self.manifest_patch.start()
        self.addCleanup(self.manifest_patch.stop)
        self.preflight_patch = mock.patch.object(ia, "_preflight_patch")
        self.preflight_patch.start()
        self.addCleanup(self.preflight_patch.stop)
        self.environment = mock.patch.dict(os.environ, {"APPDATA": str(self.base / "AppData")})
        (self.base / "AppData").mkdir()
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_inspect_installed_root_without_visible_package_file(self):
        self.assertFalse((self.install / "package.json").exists())
        result = bridge.dispatch({"operation": "inspect", "root": str(self.install)})
        self.assertEqual(result["status"], "UNPATCHED")
        self.assertEqual(result["version"], "0.5.54")
        self.assertEqual(result["targetKind"], "INSTALLED_ASAR")

    def test_repack_keeps_other_files_unchanged(self):
        source = ia.Archive(self.archive)
        self.assertEqual(set(source.files), set(self.original))
        target = self.install / "resources" / "copy.asar"
        source.write_modified(target, {"src/app.js": b"patched", "src/new.js": b"new"})
        packed = ia.Archive(target)
        self.assertEqual(packed.read("src/app.js"), b"patched")
        self.assertEqual(packed.read("src/new.js"), b"new")
        for name in self.original:
            if name != "src/app.js":
                self.assertEqual(packed.read(name), self.original[name], name)

    def test_startup_backups_then_uninstall_restores_byte_identical_asar(self):
        old = self.archive.read_bytes()
        result = ia.startup(self.install, process_check=lambda root: None)
        self.assertEqual(result["status"], "APPLIED")
        self.assertNotEqual(self.archive.read_bytes(), old)
        self.assertEqual(ia.inspect(self.install)["status"], "APPLIED")
        packed = ia.Archive(self.archive)
        self.assertEqual(packed.read("src/other.js"), self.original["src/other.js"])
        self.assertEqual(packed.read("src/integrated-search.js"), b"console.log('new module');")
        recovered = ia.uninstall(self.install, process_check=lambda root: None)
        self.assertEqual(recovered["status"], "UNPATCHED")
        self.assertEqual(self.archive.read_bytes(), old)
        # A post-operation fs.watch notification must never reinstall a patch
        # that the user explicitly removed.
        checked = ia.inspect(self.install)
        self.assertTrue(checked["manualUninstall"])
        checked_again = ia.startup(self.install, process_check=lambda root: None)
        self.assertEqual(checked_again["status"], "UNPATCHED")
        self.assertTrue(checked_again["manualUninstall"])
        self.assertEqual(self.archive.read_bytes(), old)

    def test_unknown_original_changes_fail_closed(self):
        changed = dict(self.original)
        changed["src/app.js"] += b"\nconsole.log('modified by user')"
        synthetic_asar(self.archive, changed)
        result = ia.inspect(self.install)
        self.assertEqual(result["status"], "CONFLICT")
        self.assertEqual(ia.startup(self.install, process_check=lambda root: None)["status"], "CONFLICT")
        self.assertEqual(ia.backups(self.install)["items"], [])

    def test_existing_untracked_patch_module_blocks_overwrite(self):
        changed = dict(self.original)
        changed["src/integrated-search.js"] = b"other patch"
        synthetic_asar(self.archive, changed)
        self.assertEqual(ia.inspect(self.install)["status"], "PARTIAL_OR_UNKNOWN")

    def _unknown_version_fixture(self, version="0.5.63"):
        """Select five unambiguous connection anchors for an unseen installed version."""
        package = {"version": version, "build": {"appId": "com.lilac.anime.desktop"}}
        files = dict(self.original)
        files["package.json"] = json.dumps(package).encode()
        files["src/player.js"] = b"const player = true;\\n"
        files["electron/preload.cjs"] = b"const preload = true;\\n"
        files["src/index.html"] = b"""<html><head><link id='one'></head><body><button id='two'></button><select id='three'></select><script src="app.js"></script></body></html>"""
        synthetic_asar(self.archive, files)
        html = files["src/index.html"].decode("utf-8")
        connections = [
            {"file": "src/app.js", "before": "const source = 'reanime';",
             "after": "const source = 'integrated';", "description": "source selection"},
            {"file": "src/index.html", "before": "<link id='one'>",
             "after": "<link id='one'><link id='dino'>", "description": "stylesheet"},
            {"file": "src/index.html", "before": "<button id='two'>",
             "after": "<button id='two'><button id='dino'>", "description": "source button"},
            {"file": "src/index.html", "before": "<select id='three'>",
             "after": "<select id='three'><option id='dino'>", "description": "source options"},
            {"file": "src/index.html", "before": '<script src="app.js"></script>',
             "after": '<script src="patch.js"></script><script src="app.js"></script>',
             "description": "script loading"},
        ]
        self.assertIn("<button id='two'>", html)
        manifest = dict(self.manifest)
        manifest["_profilePinned"] = False
        manifest["connections"] = connections
        manifest["_connectionProfiles"] = [{"officialVersion": "0.5.54", "connections": connections}]
        self.manifest_patch.stop()
        mocked = mock.patch.object(core, "load_manifest", return_value=(self.patch, manifest))
        mocked.start()
        self.addCleanup(mocked.stop)
        return files

    def test_unknown_version_with_safe_contracts_is_compatible_and_restorable(self):
        self._unknown_version_fixture("0.5.63")
        original = self.archive.read_bytes()
        with mock.patch.object(core, "_verify_structural_official_contracts",
                               return_value={"apis": {"providerCatalog": True}}) as check:
            detected = ia.inspect(self.install)
            self.assertEqual(detected["status"], "UNPATCHED")
            self.assertEqual(detected["version"], "0.5.63")
            self.assertEqual(detected["compatibilityMode"], "STRUCTURAL")
            self.assertFalse(detected["sourceIdentityVerified"])
            applied = ia.startup(self.install, process_check=lambda root: None)
            self.assertEqual(applied["status"], "APPLIED")
            self.assertGreaterEqual(check.call_count, 2)
            self.assertNotEqual(self.archive.read_bytes(), original)
            self.assertEqual(ia.uninstall(self.install, process_check=lambda root: None)["status"], "UNPATCHED")
            self.assertEqual(self.archive.read_bytes(), original)

    def test_unknown_version_without_connection_anchor_fails_closed(self):
        self._unknown_version_fixture("0.6.10")
        asar = ia.Archive(self.archive)
        changed = {name: asar.read(name) for name in asar.files}
        changed["src/index.html"] = changed["src/index.html"].replace(b"<button id='two'>", b"<button id='new'>")
        synthetic_asar(self.archive, changed)
        original = self.archive.read_bytes()
        with mock.patch.object(core, "_verify_structural_official_contracts", return_value={}):
            detected = ia.inspect(self.install)
            self.assertEqual(detected["status"], "UNSUPPORTED")
            self.assertEqual(ia.startup(self.install, process_check=lambda root: None)["status"], "UNSUPPORTED")
        self.assertEqual(self.archive.read_bytes(), original)
        self.assertFalse((self.base / "AppData" / "DinoPatchManager").exists())

    def test_unknown_version_with_changed_ipc_contract_fails_closed(self):
        self._unknown_version_fixture("1.0.0")
        original = self.archive.read_bytes()
        with mock.patch.object(core, "_verify_structural_official_contracts",
                               side_effect=core.ManagerError("provider:detail changed")):
            detected = ia.inspect(self.install)
            self.assertEqual(detected["status"], "UNSUPPORTED")
            self.assertIn("provider:detail", detected["reason"])
            self.assertEqual(ia.startup(self.install, process_check=lambda root: None)["status"], "UNSUPPORTED")
        self.assertEqual(self.archive.read_bytes(), original)
        self.assertFalse((self.base / "AppData" / "DinoPatchManager").exists())

    def test_missing_app_asar_does_not_fallback_to_source_mode(self):
        original = self.archive.read_bytes()
        temporary = self.archive.with_name("app.asar.replacing")
        self.archive.rename(temporary)
        self.assertTrue(ia.looks_like_installed_directory(self.install))
        self.assertFalse(ia.is_installed_target(self.install))
        with mock.patch.object(core, "inspect_managed_target") as source_inspect, \
             mock.patch.object(core, "automatic_startup_check") as source_startup, \
             mock.patch.object(core, "apply_patch_in_place") as source_apply:
            for operation in ("inspect", "startup", "apply"):
                result = bridge.dispatch({"operation": operation, "root": str(self.install)})
                self.assertEqual(result["status"], "PARTIAL_OR_UNKNOWN")
                self.assertEqual(result["targetKind"], "INSTALLED_ASAR")
                self.assertTrue(result["readOnly"])
                self.assertIn("resources/app.asar", result["reason"])
                self.assertNotIn("package.json", result["reason"])
            source_inspect.assert_not_called()
            source_startup.assert_not_called()
            source_apply.assert_not_called()
        self.assertFalse((self.install / "package.json").exists())
        temporary.rename(self.archive)
        self.assertEqual(self.archive.read_bytes(), original)
        self.assertEqual(bridge.dispatch({"operation": "inspect", "root": str(self.install))["status"], "UNPATCHED")

    def test_pending_transaction_blocks_changes(self):
        state_root = ia._state_root(ia._root(self.install))
        state_root.mkdir(parents=True)
        (state_root / "pending.json").write_text("{}")
        result = ia.inspect(self.install)
        self.assertEqual(result["status"], "PARTIAL_OR_UNKNOWN")
        self.assertEqual(ia.startup(self.install, process_check=lambda root: None)["status"], "PARTIAL_OR_UNKNOWN")


if __name__ == "__main__":
    unittest.main()
