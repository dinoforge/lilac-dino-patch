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
GUI_SPEC = importlib.util.spec_from_file_location(
    "manager_gui", HERE / "tests" / "fixtures" / "legacy_tk" / "manager_gui.py"
)
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

    def _make_structural_source(self, version: str = "0.5.56") -> None:
        package = {
            "name": "lilacanime-desktop",
            "version": version,
            "build": {"productName": "LilacAnime", "appId": "com.lilac.anime.desktop"},
        }
        self._write("package.json", json.dumps(package))
        self._write("package-lock.json", json.dumps({"lockfileVersion": 3, "packages": {"": {"name": package["name"], "version": version}}}))
        state_anchor = (
            "const state = { season: [], top: [], library: store.get('library'), history: store.get('history'), "
            "downloads:[], source: localStorage.getItem('contentSource') || 'reanime',"
        )
        self._write(
            "src/app.js",
            state_anchor + "\n"
            "async function doSearch(query) { const search = text => window.lilac.providerCatalog(state.source, text); "
            "const result = await search(query); const data = result.data || []; renderCards(data); }\n"
            "async function openDetail(id) { const dialog = document.querySelector('#detailDialog'); "
            "const known = animeById(id); const providerResult = await window.lilac.providerDetail(known); "
            "const {data:a} = providerResult; if (providerResult?.episodes?.length) mountEpisodeList(episodeBlock, {episodes:providerResult.episodes}); "
            "const playProvider = ep => resolveIntoPlayer(() => window.lilac.providerResolve(ep), 'episode'); }\n"
            "function resolveIntoPlayer() {}\n",
        )
        self._write(
            "src/index.html",
            '<link rel="stylesheet" href="styles.css" />\n'
            '<div id="detailDialog"></div>\n'
            '<div><button data-value="miruro">Miruro</button></div><p>선택한 사이트의 애니 목록·제목·회차·영상 소스를 함께 사용합니다.</p>\n'
            '<select><option value="miruro">Miruro</option></select>\n'
            '<script src="app.js"></script>\n',
        )
        self._write("src/player.js", "function playerRuntime() { return 'official'; }\n")
        self._write("src/styles.css", "/* official unrelated source style */\n")
        self._write(
            "electron/preload.cjs",
            "const api = {\n"
            " providerCatalog: (provider, query = '', offset = 0, sort = '') => ipcRenderer.invoke('provider:catalog', provider, query, offset, sort),\n"
            " providerDetail: anime => ipcRenderer.invoke('provider:detail', anime),\n"
            " providerResolve: episode => ipcRenderer.invoke('provider:resolve', episode),\n"
            "};\n",
        )
        self._write(
            "electron/main.cjs",
            "ipcMain.handle('provider:catalog', async (_, provider, query = '', offset = 0, sort = '') => {\n"
            " if (provider === 'reanime') { const url=new URL('/api/v1/search',REANIME_WEB); if(query)url.searchParams.set('q',query); const root=await providerFetch(url.href,{json:true}); return {data:reanimeItems(root),total:Number(root?.total)||null,offset,limit:36}; }\n"
            " if (provider === 'animenosub') { const url=query?`${ANIMENOSUB_WEB}/?s=${encodeURIComponent(query)}`:`${ANIMENOSUB_WEB}/`; const data=animenosubList(await providerFetch(url),undefined,{onlyResults:Boolean(query)}); return {data,offset:1,nextOffset:2,done:data.length===0}; }\n"
            " if (provider === 'ohli24') { if(query)return {data:await ohliSearch(query)}; const result=await ohliBrowse(offset); return {data:result.data}; }\n"
            " if (provider === 'linkani') { const searchUrl=(text,at=1)=>`/view/${at>1?`page/${at}/`:''}?wd=${encodeURIComponent(text)}`; const url=query?searchUrl(query,offset):'/list/2/'; const data=linkaniItems(await linkaniFetch(url)); return {data,offset,nextOffset:offset+1,done:!data.length}; }\n"
            " if (provider === 'miruro') { const root=await miruroApi('anime',query?{q:query,limit:15,sort:'-popularity',cursor:offset||undefined}:{sort:'-popularity',limit:15,cursor:offset||undefined}); return {data:(root.data||[]).map(miruroItem),offset,nextOffset:root.next_cursor||null,done:!root.has_more||!root.next_cursor}; }\n"
            " throw new Error('unsupported');\n"
            "});\n"
            "async function miruroDetail(anime) { const data=anime,episodes=[]; return {data,episodes,unavailable:false}; }\n"
            "async function ohliDetail(anime) { const data=anime,episodes=[]; return {data,episodes,unavailable:false}; }\n"
            "async function linkaniDetail(anime) { const data=anime,episodes=[]; return {data,episodes,unavailable:false}; }\n"
            "const loadProviderDetail = async anime => {\n"
            " if (anime.provider === 'miruro') return miruroDetail(anime);\n"
            " if (anime.provider === 'ohli24') return ohliDetail(anime);\n"
            " if (anime.provider === 'linkani') return linkaniDetail(anime);\n"
            " if (anime.provider === 'reanime') { const detail=anime; return {data:detail,episodes:await reanimeEpisodes(detail),unavailable:false}; }\n"
            " const html=''; const detail=anime.provider==='animenosub'?animenosubDetail(html,anime):{...anime};\n"
            " const episodes=providerEpisodes(html,anime.provider,detail);\n"
            " return {data:detail,episodes,unavailable:!episodes.length};\n"
            "};\n"
            "ipcMain.handle('provider:detail', (_, anime) => { const promise = loadProviderDetail(anime); return promise; });\n"
            "ipcMain.handle('provider:resolve', async (_, episode) => { const stream = await resolveProviderEpisode(episode); return stream; });\n",
        )

    def _mock_official_identity(self, root: Path | None = None) -> dict:
        source = root or self.official
        files = manager_core._inventory(source)
        return {
            "repository": "https://github.com/whispelyn-byte/LilacAnime-desktop",
            "tag": "v" + json.loads((source / "package.json").read_text(encoding="utf-8"))["version"],
            "commit": "f" * 40,
            "treeSha": "e" * 40,
            "files": {relative: manager_core._git_blob_sha1((source / Path(*relative.split("/"))).read_bytes()) for relative in files},
            "fileCount": len(files),
            "totalBytes": sum((source / Path(*relative.split("/"))).stat().st_size for relative in files),
        }

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

    def test_project_root_is_derived_for_an_independent_checkout(self) -> None:
        self.assertEqual(manager_core.EXPECTED_PROJECT_ROOT, manager_core.PROJECT_ROOT)
        self.assertEqual(manager_core.assert_project_root(manager_core.PROJECT_ROOT), manager_core.PROJECT_ROOT)

    def test_frozen_manager_can_run_from_inside_its_official_source_target(self) -> None:
        deployed_manager = self.official / manager_core.MANAGER_FOLDER_NAME
        deployed_manager.mkdir()
        with (
            mock.patch.object(manager_core, "IS_FROZEN", True),
            mock.patch.object(manager_core, "EXPECTED_PROJECT_ROOT", deployed_manager / "resources"),
            mock.patch.object(manager_core, "manager_home", return_value=deployed_manager),
        ):
            package = manager_core._assert_managed_target(self.official, package_mode=True)

        self.assertEqual(package["version"], "0.5.54")

    def test_frozen_patch_assets_resolve_and_missing_bundle_fails_closed(self) -> None:
        manager_home = self.root / "deployment"
        frozen_assets = self.root / "_internal"
        manifest_path = frozen_assets / manager_core.MANIFEST_RELATIVE
        manifest_path.parent.mkdir(parents=True)
        manifest_path.write_text("{}", encoding="utf-8")

        with mock.patch.object(manager_core, "IS_FROZEN", True), mock.patch.object(
            manager_core, "manager_home", return_value=manager_home
        ), mock.patch.object(sys, "_MEIPASS", str(frozen_assets), create=True):
            self.assertEqual(manager_core.patch_source_root(), manager_core.canonical_path(frozen_assets, strict=True))

        nested_home = self.root / "packaged-engine"
        nested_internal = nested_home / "_internal"
        nested_manifest = nested_internal / manager_core.MANIFEST_RELATIVE
        nested_manifest.parent.mkdir(parents=True)
        nested_manifest.write_text("{}", encoding="utf-8")
        with mock.patch.object(manager_core, "IS_FROZEN", True), mock.patch.object(
            manager_core, "manager_home", return_value=nested_home
        ), mock.patch.object(sys, "_MEIPASS", str(nested_home), create=True):
            self.assertEqual(manager_core.patch_source_root(), manager_core.canonical_path(nested_internal, strict=True))

        executable_manifest = manager_home / manager_core.MANIFEST_RELATIVE
        executable_manifest.parent.mkdir(parents=True)
        executable_manifest.write_text("{}", encoding="utf-8")
        with mock.patch.object(manager_core, "IS_FROZEN", True), mock.patch.object(
            manager_core, "manager_home", return_value=manager_home
        ), mock.patch.object(sys, "_MEIPASS", str(frozen_assets), create=True):
            self.assertEqual(manager_core.patch_source_root(), manager_core.canonical_path(manager_home, strict=True))

        empty_home = self.root / "missing-deployment-assets"
        empty_home.mkdir()
        with mock.patch.object(manager_core, "IS_FROZEN", True), mock.patch.object(
            manager_core, "manager_home", return_value=empty_home
        ), mock.patch.object(sys, "_MEIPASS", str(self.root / "missing-internal-assets"), create=True):
            with self.assertRaisesRegex(manager_core.ManagerError, "manifest"):
                manager_core.patch_source_root()

    def test_manifest_selects_exact_official_source_profile(self) -> None:
        _, default = manager_core.load_manifest(self.patch)
        _, base_version = manager_core.load_manifest(self.patch, "0.5.54")
        _, newer_version = manager_core.load_manifest(self.patch, "0.5.55")
        _, unknown_version = manager_core.load_manifest(self.patch, "0.5.56")
        self.assertEqual(default["officialVersion"], "0.5.54")
        self.assertEqual(base_version["officialVersion"], "0.5.54")
        self.assertEqual(newer_version["officialVersion"], "0.5.55")
        self.assertEqual(newer_version["officialCommit"], "207693ea7ee31b83276ac793b35136055a24de26")
        self.assertEqual(unknown_version["officialVersion"], "0.5.54")
        self.assertFalse(unknown_version["_profilePinned"])
        self.assertTrue(newer_version["_profilePinned"])

    def test_unregistered_source_identity_requires_official_release_tag_commit_and_full_tree(self) -> None:
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        repository = "whispelyn-byte/LilacAnime-desktop"
        commit_sha = "a" * 40
        tree_sha = "b" * 40
        urls = {
            f"https://api.github.com/repos/{repository}/releases/tags/v0.5.56": {
                "tag_name": "v0.5.56",
                "html_url": f"https://github.com/{repository}/releases/tag/v0.5.56",
                "draft": False,
            },
            f"https://api.github.com/repos/{repository}/git/ref/tags/v0.5.56": {
                "ref": "refs/tags/v0.5.56", "object": {"sha": commit_sha, "type": "commit"},
            },
            f"https://api.github.com/repos/{repository}/git/commits/{commit_sha}": {
                "sha": commit_sha, "tree": {"sha": tree_sha},
            },
            f"https://api.github.com/repos/{repository}/git/trees/{tree_sha}?recursive=1": {
                "sha": tree_sha, "truncated": False,
                "tree": [{"path": "src/app.js", "mode": "100644", "type": "blob", "sha": "c" * 40, "size": 120}],
            },
        }
        requested = []

        def opener(request, **_kwargs):
            requested.append(request.full_url)
            if request.full_url not in urls:
                raise AssertionError(f"Unexpected GitHub request: {request.full_url}")
            return Response(json.dumps(urls[request.full_url]).encode("utf-8"))

        identity = manager_core._fetch_official_source_identity("0.5.56", opener=opener)
        self.assertEqual(identity["repository"], f"https://github.com/{repository}")
        self.assertEqual((identity["tag"], identity["commit"], identity["treeSha"]), ("v0.5.56", commit_sha, tree_sha))
        self.assertEqual(identity["files"], {"src/app.js": "c" * 40})
        self.assertEqual(identity["fileCount"], 1)
        self.assertEqual(identity["totalBytes"], 120)
        self.assertEqual(len(requested), 4)
        self.assertTrue(all(url.startswith(f"https://api.github.com/repos/{repository}/") for url in requested))

        urls[f"https://api.github.com/repos/{repository}/releases/tags/v0.5.56"]["html_url"] = "https://example.invalid/not-official"
        with self.assertRaisesRegex(manager_core.CompatibilityBlocked, "일치하지 않습니다"):
            manager_core._fetch_official_source_identity("0.5.56", opener=opener)

    def test_manifest_rejects_duplicate_additional_source_profiles(self) -> None:
        duplicate = copy.deepcopy(self.manifest)
        duplicate["additionalOfficialSources"].append(copy.deepcopy(duplicate["additionalOfficialSources"][0]))
        with self.assertRaisesRegex(manager_core.ManagerError, "중복"):
            manager_core.validate_manifest(duplicate)

    def test_v055_profile_applies_and_restores_the_matching_source_tree(self) -> None:
        package_path = self.official / "package.json"
        package = json.loads(package_path.read_text(encoding="utf-8"))
        package["version"] = "0.5.55"
        package_path.write_text(json.dumps(package), encoding="utf-8")
        before = manager_core._inventory(self.official)
        profile = copy.deepcopy(self.manifest["additionalOfficialSources"][0])
        profile["officialTreeFileCount"] = len(before)
        profile["officialTreeSha256"] = manager_core.tree_sha256(before)
        self.manifest["additionalOfficialSources"] = [profile]
        self._write_manifest()

        inspected = manager_core.inspect_managed_target(self.official, self.patch)
        self.assertEqual(inspected["status"], "UNPATCHED")
        self.assertEqual(inspected["version"], "0.5.55")
        self.assertEqual(inspected["officialCommit"], profile["officialCommit"])

        fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
        with mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts):
            applied = manager_core.apply_patch_in_place(
                self.official,
                self.patch,
                process_check=lambda _root: None,
            )
        self.assertEqual(applied["status"], "APPLIED")
        state = json.loads((self.official / "DinoPatchManager" / "state" / "patch-state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["officialVersion"], "0.5.55")
        self.assertEqual(state["officialCommit"], profile["officialCommit"])
        manager_core.uninstall_patch(self.official, patch_root_value=self.patch, process_check=lambda _root: None)
        self.assertEqual(manager_core._inventory(self.official), before)

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
        self.assertEqual(
            runner.call_args_list[-1].args[0][-1],
            manager_core.CONTRACT_TEST_RELATIVE.as_posix(),
        )
        self.assertEqual(
            runner.call_args_list[-1].kwargs["cwd"],
            manager_core._without_windows_extended_prefix(manager_core.PROJECT_ROOT),
        )
        if manager_core.os.name == "nt":
            self.assertEqual(len(runner.call_args_list), 4)
            self.assertTrue(all(
                call.kwargs.get("creationflags") == manager_core.subprocess.CREATE_NO_WINDOW
                for call in runner.call_args_list
            ))

    def test_packaged_folder_compatibility_uses_bundled_contract_assets(self) -> None:
        fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
        fake_inventory = {"src/app.js": "A" * 64}
        with (
            mock.patch.object(manager_core, "IS_FROZEN", True),
            mock.patch.object(manager_core, "_verify_original_root", return_value=fake_inventory),
            mock.patch.object(manager_core, "_copy_original_folder"),
            mock.patch.object(manager_core, "_apply_connections"),
            mock.patch.object(manager_core, "_copy_modules"),
            mock.patch.object(manager_core, "_verify_patched_tree", return_value={"result": "PASS"}),
            mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts) as run_contracts,
        ):
            result = manager_core._check_folder_compatibility(self.official, self.patch, self.manifest, None)

        self.assertEqual(result["result"], "PASS")
        self.assertEqual(run_contracts.call_args.args[0].name, "source")
        self.assertEqual(run_contracts.call_args.args[1], self.patch)

    @unittest.skipUnless(manager_core.os.name == "nt", "Windows extended paths are required")
    def test_node_contracts_use_relative_paths_from_unprefixed_working_directories(self) -> None:
        completed = __import__("subprocess").CompletedProcess(
            args=[], returncode=0, stdout="ℹ tests 10\nℹ pass 10\nℹ fail 0\n", stderr=""
        )
        project_root = self.root / "long packaged validation assets"
        contract = project_root / manager_core.CONTRACT_TEST_RELATIVE
        contract.parent.mkdir(parents=True)
        contract.write_text("// test fixture\n", encoding="utf-8")
        extended_project_root = manager_core._windows_extended_path(project_root, force=True)
        with mock.patch.object(manager_core.subprocess, "run", return_value=completed) as runner:
            manager_core.run_node_contracts(self.official, extended_project_root)

        expected_source_cwd = manager_core._without_windows_extended_prefix(self.official)
        expected_project_cwd = manager_core._without_windows_extended_prefix(project_root)
        self.assertEqual([call.kwargs["cwd"] for call in runner.call_args_list[:3]], [expected_source_cwd] * 3)
        self.assertEqual(runner.call_args_list[3].kwargs["cwd"], expected_project_cwd)
        self.assertEqual(runner.call_args_list[3].args[0][-1], manager_core.CONTRACT_TEST_RELATIVE.as_posix())

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

    def test_unregistered_version_with_verified_source_contract_applies_idempotently_and_restores(self) -> None:
        self._make_structural_source("0.5.56")
        identity = self._mock_official_identity()
        fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
        before = manager_core._inventory(self.official)
        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=identity), mock.patch.object(
            manager_core, "run_node_contracts", return_value=fake_contracts
        ):
            checked = manager_core.check_compatibility(self.official, self.patch, project_root=manager_core.PROJECT_ROOT)
            self.assertEqual(checked["status"], "PASS")
            self.assertTrue(checked["applyAuthorized"])
            self.assertEqual(checked["compatibilityMode"], "STRUCTURAL")
            self.assertTrue(checked["sourceIdentityVerified"])
            self.assertFalse(checked["runtimePlaybackVerified"])

            first = manager_core.automatic_startup_check(
                self.official, patch_root_value=self.patch, process_check=lambda _root: None
            )
            second = manager_core.automatic_startup_check(
                self.official, patch_root_value=self.patch,
                process_check=lambda _root: self.fail("이미 적용된 구조 호환 소스는 다시 변경하면 안 됩니다."),
            )
            self.assertEqual((first["status"], first["compatibilityMode"]), ("APPLIED", "STRUCTURAL"))
            self.assertEqual(second["status"], "APPLIED")
            self.assertEqual(len(manager_core.list_backups(self.official)), 1)
            inspected = manager_core.inspect_managed_target(self.official, self.patch)
            self.assertEqual(inspected["status"], "APPLIED")
            self.assertFalse(inspected["runtimePlaybackVerified"])
            manager_core.uninstall_patch(self.official, patch_root_value=self.patch, process_check=lambda _root: None)
            self.assertEqual(manager_core._inventory(self.official), before)
            self.assertEqual(manager_core.inspect_managed_target(self.official, self.patch)["status"], "UNPATCHED")

    def test_unregistered_official_unrelated_file_change_is_accepted_with_exact_git_tree(self) -> None:
        self._make_structural_source("0.5.57")
        self._write("docs/official-release-notes.md", "official unrelated change\n")
        identity = self._mock_official_identity()
        fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=identity), mock.patch.object(
            manager_core, "run_node_contracts", return_value=fake_contracts
        ):
            result = manager_core.check_compatibility(self.official, self.patch, project_root=manager_core.PROJECT_ROOT)
        self.assertEqual(result["status"], "PASS")
        self.assertTrue(result["applyAuthorized"])

    def test_unregistered_user_modified_file_is_blocked_against_official_git_tree(self) -> None:
        self._make_structural_source("0.5.58")
        official_identity = self._mock_official_identity()
        self._write("src/styles.css", "user modification\n")
        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=official_identity):
            result = manager_core.inspect_managed_target(self.official, self.patch)
        self.assertEqual(result["status"], "CONFLICT")
        self.assertFalse(result["sourceIdentityVerified"])
        self.assertIn("다른 파일", result["reason"])

    def test_unregistered_changed_contracts_fail_closed(self) -> None:
        cases = (
            ("preload method argument changed", "electron/preload.cjs", "providerDetail: anime =>", "providerDetail: media =>"),
            (
                "catalog argument order changed",
                "electron/preload.cjs",
                "'provider:catalog', provider, query, offset, sort",
                "'provider:catalog', provider, offset, query, sort",
            ),
            ("main catalog argument changed", "electron/main.cjs", "async (_, provider, query", "async (_, source, query"),
            (
                "catalog return shape changed",
                "electron/main.cjs",
                "return {data:reanimeItems(root),total:Number(root?.total)||null,offset,limit:36};",
                "return [];",
            ),
            ("Animenosub catalog list shape changed", "electron/main.cjs", "animenosubList(await providerFetch(url),undefined,{onlyResults:Boolean(query)})", "animenosubItems(await providerFetch(url),undefined,{onlyResults:Boolean(query)})"),
            ("Ohli24 catalog list shape changed", "electron/main.cjs", "data:await ohliSearch(query)", "data:await ohliLookup(query)"),
            ("LinkAni catalog list shape changed", "electron/main.cjs", "linkaniItems(await linkaniFetch(url))", "linkaniEntries(await linkaniFetch(url))"),
            ("Miruro catalog mapping changed", "electron/main.cjs", "map(miruroItem)", "map(miruroTitle)"),
            ("ReAnime detail episode list changed", "electron/main.cjs", "episodes:await reanimeEpisodes(detail)", "episodes:await reanimeEpisodeList(detail)"),
            ("provider detail helper response changed", "electron/main.cjs", "return {data,episodes,unavailable:false};", "return {data,episodeList:episodes,unavailable:false};"),
            ("detail return shape changed", "electron/main.cjs", "return {data:detail,episodes,unavailable:!episodes.length};", "return {data:detail,episodeList:episodes,unavailable:!episodes.length};"),
            ("resolve return shape changed", "electron/main.cjs", "return stream;", "return {url:stream.url};"),
            ("detail dialog changed", "src/index.html", 'id="detailDialog"', 'id="seriesDialog"'),
            ("required player removed", "src/player.js", None, None),
            ("search query argument omitted", "src/app.js", "providerCatalog(state.source, text)", "providerCatalog(state.source)"),
            ("detail episode response key changed", "src/app.js", "episodes:providerResult.episodes", "episodes:providerResult.episodeList"),
            ("resolve called with the wrong object", "src/app.js", "providerResolve(ep)", "providerResolve(episode)"),
        )
        for index, (name, relative, old, new) in enumerate(cases, start=60):
            with self.subTest(contract=name):
                self._make_structural_source(f"0.5.{index}")
                target = self.official / Path(*relative.split("/"))
                if old is None:
                    target.unlink()
                else:
                    original = target.read_text(encoding="utf-8")
                    self.assertIn(old, original)
                    target.write_text(original.replace(old, new), encoding="utf-8")
                identity = self._mock_official_identity()
                with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=identity):
                    result = manager_core.inspect_managed_target(self.official, self.patch)
                self.assertEqual(result["status"], "UNSUPPORTED")
                self.assertFalse(result["sourceIdentityVerified"])

    def test_unregistered_duplicate_patch_anchor_blocks_before_files_change(self) -> None:
        self._make_structural_source("0.5.66")
        app = self.official / "src" / "app.js"
        app.write_text(app.read_text(encoding="utf-8") + "\n" + self.manifest["connections"][0]["before"], encoding="utf-8")
        identity = self._mock_official_identity()
        before = manager_core._inventory(self.official)
        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=identity):
            result = manager_core.inspect_managed_target(self.official, self.patch)
        self.assertEqual(result["status"], "UNSUPPORTED")
        self.assertEqual(manager_core._inventory(self.official), before)
        self.assertFalse((self.official / "DinoPatchManager").exists())

    def test_unregistered_patch_trace_without_state_is_partial_unknown(self) -> None:
        self._make_structural_source("0.5.67")
        (self.official / "src" / "integrated-search.js").write_text("orphaned patch file", encoding="utf-8")
        identity = self._mock_official_identity()
        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=identity):
            result = manager_core.inspect_managed_target(self.official, self.patch)
        self.assertEqual(result["status"], "PARTIAL_OR_UNKNOWN")
        self.assertIn("기록이 없는", result["reason"])

    def test_unregistered_contract_test_failure_stops_before_patch_backup(self) -> None:
        self._make_structural_source("0.5.68")
        identity = self._mock_official_identity()
        failed_contracts = {"status": "FAIL", "testCount": 10, "passCount": 9, "failCount": 1}
        before = manager_core._inventory(self.official)
        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=identity), mock.patch.object(
            manager_core, "run_node_contracts", return_value=failed_contracts
        ):
            with self.assertRaisesRegex(manager_core.ManagerError, "계약 검사가 통과하지 않았습니다"):
                manager_core.apply_patch_in_place(self.official, self.patch, process_check=lambda _root: None)
        self.assertEqual(manager_core._inventory(self.official), before)
        self.assertEqual(manager_core.list_backups(self.official), [])

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

    @unittest.skipUnless(sys.platform == "win32", "Windows-only extended path regression")
    def test_long_windows_path_backup_apply_and_restore(self) -> None:
        base = self.root / "long-path"
        base.mkdir()
        remaining = 190 - len(str(base)) - len("\\official")
        parts: list[str] = []
        while remaining:
            if remaining > 61:
                part = "a" * 60
            else:
                part = "b" * (remaining - 1)
            parts.append(part)
            remaining -= len(part) + 1
        target = base.joinpath(*parts, "official")
        self.assertEqual(len(str(target)), 190)
        shutil.copytree(self.official, target)
        backups_dir = manager_core._windows_extended_path(
            target / "DinoPatchManager" / "backups",
            force=True,
        )
        try:
            before = manager_core._inventory(target)
            fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
            with mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts):
                applied = manager_core.apply_patch_in_place(
                    target,
                    self.patch,
                    process_check=lambda _root: None,
                )

            self.assertEqual(applied["status"], "APPLIED")
            original_backup = manager_core._manager_data_path(
                target,
                Path("backups") / applied["backupId"] / "original",
            )
            plain_backup_path = manager_core._without_windows_extended_prefix(original_backup)
            self.assertGreater(len(plain_backup_path), 248)
            self.assertTrue(str(original_backup).startswith("\\\\?\\"))
            self.assertEqual(len(manager_core.list_backups(target)), 1)

            manager_core.restore_backup(
                target,
                applied["backupId"],
                patch_root_value=self.patch,
                process_check=lambda _root: None,
            )
            self.assertEqual(manager_core._inventory(target), before)
            self.assertFalse(manager_core.list_backups(target)[0]["restorable"])
        finally:
            if backups_dir.exists():
                shutil.rmtree(backups_dir)

    def test_list_backups_returns_empty_only_when_backup_directory_is_absent(self) -> None:
        self.assertEqual(manager_core.list_backups(self.official), [])

        self._apply_in_place()
        backup_dir = manager_core._manager_data_path(self.official, Path("backups"))
        original_scandir = manager_core.os.scandir

        def fail_backup_scan(path):
            if Path(path).name == "backups":
                raise PermissionError(5, "access denied")
            return original_scandir(path)

        with mock.patch.object(manager_core.os, "scandir", side_effect=fail_backup_scan):
            with self.assertRaisesRegex(manager_core.ManagerError, "백업 폴더 내용을 읽을 수 없어"):
                manager_core.list_backups(self.official)

        backup = manager_core.list_backups(self.official)[0]
        metadata = manager_core._manager_data_path(
            self.official,
            Path("backups") / backup["id"] / "backup.json",
        )
        metadata.write_bytes(b"not-json")
        with self.assertRaisesRegex(manager_core.ManagerError, "전체 목록 조회를 중단했습니다"):
            manager_core.list_backups(self.official)

    @unittest.skipUnless(sys.platform == "win32", "Windows-only extended path regression")
    def test_long_windows_backup_list_reads_metadata_past_260_characters(self) -> None:
        base = self.root / "long-backup-list"
        base.mkdir()
        target_length = 210
        remaining = target_length - len(str(base)) - len("\\official")
        parts: list[str] = []
        while remaining:
            part = "a" * 60 if remaining > 61 else "b" * (remaining - 1)
            parts.append(part)
            remaining -= len(part) + 1
        target = base.joinpath(*parts, "official")
        self.assertEqual(len(str(target)), target_length)
        shutil.copytree(self.official, manager_core._windows_extended_path(target, force=True))
        backups_dir = manager_core._windows_extended_path(
            target / "DinoPatchManager" / "backups",
            force=True,
        )
        try:
            before = manager_core._inventory(target)
            fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
            with mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts):
                applied = manager_core.apply_patch_in_place(
                    target,
                    self.patch,
                    process_check=lambda _root: None,
                )

            backup_id = applied["backupId"]
            metadata = manager_core._manager_data_path(
                target,
                Path("backups") / backup_id / "backup.json",
            )
            self.assertGreater(
                len(manager_core._without_windows_extended_prefix(metadata)),
                260,
            )
            self.assertEqual(manager_core._read_json_file(metadata, "백업 정보")["id"], backup_id)
            backups = manager_core.list_backups(target)
            self.assertEqual([item["id"] for item in backups], [backup_id])
            self.assertTrue(backups[0]["restorable"])

            manager_core.restore_backup(
                target,
                backup_id,
                patch_root_value=self.patch,
                process_check=lambda _root: None,
            )
            self.assertEqual(manager_core._inventory(target), before)
            restored_backups = manager_core.list_backups(target)
            self.assertEqual([item["id"] for item in restored_backups], [backup_id])
            self.assertFalse(restored_backups[0]["restorable"])
        finally:
            if backups_dir.exists():
                shutil.rmtree(backups_dir)

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

    def test_automatic_startup_reconciles_new_official_source_and_recovers_interrupted_reapply(self) -> None:
        fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
        with mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts):
            first = manager_core.automatic_startup_check(
                self.official, patch_root_value=self.patch, process_check=lambda _root: None
            )
        self.assertEqual(first["status"], "APPLIED")
        old_backup_id = first["backupId"]
        old_official = self.official
        updated = self.root / "official-v0.5.56"
        updated.mkdir()
        self.official = updated
        try:
            self._make_structural_source("0.5.56")
        finally:
            self.official = old_official
        updated_identity = self._mock_official_identity(updated)
        updated_hashes = manager_core._inventory(updated)

        # Simulate an external source updater replacing official files while
        # leaving the manager-owned patch modules and state folder in place.
        for relative in sorted(updated_hashes):
            source = updated / Path(*relative.split("/"))
            destination = old_official / Path(*relative.split("/"))
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        self.assertTrue(all((old_official / Path(*relative.split("/"))).is_file() for relative in manager_core.EXPECTED_MODULES))
        journal = manager_core._source_update_journal_path(old_official)
        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=updated_identity), mock.patch.object(
            manager_core, "run_node_contracts", return_value=fake_contracts
        ), mock.patch.object(manager_core, "_write_unpatched_update_state", side_effect=RuntimeError("simulated interruption")):
            with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                manager_core.automatic_startup_check(
                    old_official, patch_root_value=self.patch, process_check=lambda _root: None
                )

        self.assertTrue(journal.is_file(), "An interrupted reconciliation must retain its operation journal.")
        self.assertFalse(any((old_official / Path(*relative.split("/"))).exists() for relative in manager_core.EXPECTED_MODULES))
        self.assertEqual(manager_core._inventory(old_official), updated_hashes)

        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=updated_identity), mock.patch.object(
            manager_core, "run_node_contracts", return_value=fake_contracts
        ):
            applied = manager_core.automatic_startup_check(
                old_official, patch_root_value=self.patch, process_check=lambda _root: None
            )
            rerun = manager_core.automatic_startup_check(
                old_official, patch_root_value=self.patch,
                process_check=lambda _root: self.fail("A resumed updated source must already be applied."),
            )

        self.assertEqual(applied["status"], "APPLIED")
        self.assertTrue(applied["sourceUpdateDetected"])
        self.assertEqual(applied["previousOfficialVersion"], "0.5.54")
        self.assertEqual(applied["version"], "0.5.56")
        backups_after_reapply = manager_core.list_backups(old_official)
        self.assertEqual(rerun["status"], "APPLIED")
        self.assertFalse(journal.exists())
        backups_after_rerun = manager_core.list_backups(old_official)
        self.assertEqual([item["id"] for item in backups_after_rerun], [item["id"] for item in backups_after_reapply])
        self.assertEqual(len(backups_after_rerun), 2, "Keep the old superseded backup and one backup for the new source.")
        self.assertEqual(sum(item.get("restorable") is True for item in backups_after_rerun), 1)
        old_backup = manager_core._read_json_file(
            manager_core._manager_data_path(old_official, Path("backups") / old_backup_id / "backup.json"), "old backup"
        )
        self.assertFalse(old_backup["restorable"], "A backup from a superseded official version must not be offered for restore.")
        new_hashes = manager_core._inventory(old_official)
        self.assertEqual(set(new_hashes) - set(updated_hashes), manager_core.EXPECTED_MODULES)
        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=updated_identity), mock.patch.object(
            manager_core, "run_node_contracts", return_value=fake_contracts
        ):
            manager_core.uninstall_patch(old_official, patch_root_value=self.patch, process_check=lambda _root: None)
        self.assertEqual(manager_core._inventory(old_official), updated_hashes)

    def test_source_update_reconciliation_blocks_unverified_user_changes_without_mutation(self) -> None:
        fake_contracts = {"status": "PASS", "testCount": 10, "passCount": 10, "failCount": 0}
        with mock.patch.object(manager_core, "run_node_contracts", return_value=fake_contracts):
            manager_core.automatic_startup_check(self.official, patch_root_value=self.patch, process_check=lambda _root: None)
        old_official = self.official
        updated = self.root / "official-v0.5.56-conflict"
        updated.mkdir()
        self.official = updated
        try:
            self._make_structural_source("0.5.56")
        finally:
            self.official = old_official
        identity = self._mock_official_identity(updated)
        for relative in sorted(manager_core._inventory(updated)):
            source = updated / Path(*relative.split("/"))
            destination = old_official / Path(*relative.split("/"))
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        (old_official / "src" / "player.js").write_text("user edit\n", encoding="utf-8")
        before = manager_core._inventory(old_official)
        backups_before = [item["id"] for item in manager_core.list_backups(old_official)]
        journal = manager_core._source_update_journal_path(old_official)

        with mock.patch.object(manager_core, "_fetch_official_source_identity", return_value=identity), mock.patch.object(
            manager_core, "run_node_contracts", return_value=fake_contracts
        ):
            with self.assertRaises(manager_core.CompatibilityBlocked):
                manager_core.automatic_startup_check(
                    old_official, patch_root_value=self.patch, process_check=lambda _root: None
                )

        self.assertEqual(manager_core._inventory(old_official), before)
        self.assertEqual([item["id"] for item in manager_core.list_backups(old_official)], backups_before)
        self.assertFalse(journal.exists(), "An unverified source must fail before opening a mutation journal.")

    def test_unknown_version_is_rejected_before_manager_state_or_runtime_writes(self) -> None:
        package_path = self.official / "package.json"
        package = json.loads(package_path.read_text(encoding="utf-8"))
        package["version"] = "0.5.99"
        package_path.write_text(json.dumps(package), encoding="utf-8")
        before = manager_core._inventory(self.official)
        with mock.patch.object(
            manager_core,
            "_fetch_official_source_identity",
            side_effect=manager_core.CompatibilityBlocked("official tag metadata unavailable"),
        ):
            result = manager_core.inspect_managed_target(self.official, self.patch)
        self.assertEqual(result["status"], "COMPATIBILITY_UNKNOWN")
        self.assertIn("official tag metadata unavailable", result["reason"])
        self.assertFalse((self.official / "DinoPatchManager").exists())
        self.assertEqual(manager_core._inventory(self.official), before)

    def test_missing_required_source_file_is_rejected_without_manager_writes(self) -> None:
        app_file = self.official / "src" / "app.js"
        app_file.unlink()
        with self.assertRaisesRegex(manager_core.ManagerError, "지원되는 LilacAnime 소스 구조가 아닙니다"):
            manager_core.inspect_managed_target(self.official, self.patch)
        self.assertFalse((self.official / "DinoPatchManager").exists())

    def test_power_shell_lookup_failure_stops_file_changes(self) -> None:
        def missing_power_shell(*_args, **_kwargs):
            raise FileNotFoundError("powershell.exe")

        with mock.patch.object(manager_core.os, "name", "nt"):
            with self.assertRaisesRegex(manager_core.ManagerError, "실행 상태를 확인하지 못해 파일 변경을 중단했습니다: FileNotFoundError"):
                manager_core.assert_app_not_running(self.official, runner=missing_power_shell)

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
        self.assertIn("NSIS", info["reason"])
        self.assertIn("소스 폴더", info["reason"])
        self.assertEqual(manager_core.approve_official_update(info)["status"], "UNSUPPORTED")
        old = Response(json.dumps({"tag_name": "v0.5.54"}).encode())
        current = manager_core.check_official_update(current_version="0.5.54", opener=lambda *_args, **_kwargs: old)
        self.assertEqual(current["status"], "UP_TO_DATE")
        failed = manager_core.check_official_update(current_version="0.5.54", opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.URLError("offline")))
        self.assertEqual(failed["status"], "CHECK_FAILED")

    def test_official_source_update_preflight_reads_release_and_trees_without_downloading(self) -> None:
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        latest_commit = "c" * 40
        latest_tree = "d" * 40
        base_tree = "e" * 40
        repository = "whispelyn-byte/LilacAnime-desktop"
        metadata = {
            f"https://api.github.com/repos/{repository}/releases/latest": {
                "tag_name": "v0.5.55",
                "html_url": f"https://github.com/{repository}/releases/tag/v0.5.55",
                "tarball_url": f"https://api.github.com/repos/{repository}/tarball/v0.5.55",
                "assets": [],
            },
            f"https://api.github.com/repos/{repository}/git/ref/tags/v0.5.55": {
                "ref": "refs/tags/v0.5.55", "object": {"sha": "b" * 40, "type": "tag"},
            },
            f"https://api.github.com/repos/{repository}/git/tags/{'b' * 40}": {
                "tag": "v0.5.55", "object": {"sha": latest_commit, "type": "commit"},
            },
            f"https://api.github.com/repos/{repository}/git/commits/{latest_commit}": {
                "sha": latest_commit, "tree": {"sha": latest_tree},
            },
            f"https://api.github.com/repos/{repository}/git/trees/{latest_tree}?recursive=1": {
                "sha": latest_tree, "truncated": False, "tree": [
                    {"path": "package.json", "mode": "100644", "type": "blob", "sha": "a" * 40, "size": 40},
                    {"path": "src/app.js", "mode": "100644", "type": "blob", "sha": "d" * 40, "size": 80},
                    {"path": "src/new.js", "mode": "100644", "type": "blob", "sha": "f" * 40, "size": 30},
                ],
            },
            f"https://api.github.com/repos/{repository}/git/ref/tags/v0.5.54": {
                "ref": "refs/tags/v0.5.54", "object": {"sha": self.manifest["officialCommit"], "type": "commit"},
            },
            f"https://api.github.com/repos/{repository}/git/commits/{self.manifest['officialCommit']}": {
                "sha": self.manifest["officialCommit"], "tree": {"sha": base_tree},
            },
            f"https://api.github.com/repos/{repository}/git/trees/{base_tree}?recursive=1": {
                "sha": base_tree, "truncated": False, "tree": [
                    {"path": "package.json", "mode": "100644", "type": "blob", "sha": "a" * 40, "size": 40},
                    {"path": "src/app.js", "mode": "100644", "type": "blob", "sha": "b" * 40, "size": 80},
                    {"path": "removed.js", "mode": "100644", "type": "blob", "sha": "7" * 40, "size": 20},
                ],
            },
        }
        requested: list[str] = []

        def opener(request, **_kwargs):
            url = request.full_url
            requested.append(url)
            if url not in metadata:
                raise AssertionError(f"Unexpected network request: {url}")
            return Response(json.dumps(metadata[url]).encode("utf-8"))

        before = manager_core._inventory(self.official)
        process_checks: list[Path] = []
        result = manager_core.preflight_official_source_update(
            current_version="0.5.54",
            root_value=self.official,
            patch_root_value=self.patch,
            opener=opener,
            process_check=process_checks.append,
        )
        self.assertEqual(result["status"], "UPDATE_AVAILABLE_UNSUPPORTED")
        self.assertEqual(result["sourcePreflightStatus"], "READ_ONLY_COMPLETE")
        self.assertEqual(result["releaseCommit"], latest_commit)
        self.assertEqual(result["releaseTreeSha"], latest_tree)
        self.assertEqual(result["currentSourceState"], "UNPATCHED")
        self.assertEqual(result["sourceChangeSummary"]["addedCount"], 1)
        self.assertEqual(result["sourceChangeSummary"]["modifiedCount"], 1)
        self.assertEqual(result["sourceChangeSummary"]["deletedCount"], 1)
        self.assertFalse(result["sourceArchiveDownloaded"])
        self.assertFalse(result["sourceInstallEnabled"])
        self.assertFalse(result["officialArchiveChecksumPublished"])
        self.assertEqual(result["officialReleaseAssetCount"], 0)
        self.assertFalse(result["sourceArchiveAssetPresent"])
        self.assertEqual(len(process_checks), 1)
        self.assertTrue(all(url.startswith(f"https://api.github.com/repos/{repository}/") for url in requested))
        self.assertIn(f"https://api.github.com/repos/{repository}/git/tags/{'b' * 40}", requested)
        self.assertFalse(any("/tarball/" in url or "/zipball/" in url for url in requested))
        self.assertEqual(manager_core._inventory(self.official), before, "Preflight must not modify the source tree.")

    def test_official_source_update_preflight_blocks_incomplete_or_unsafe_trees(self) -> None:
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        repository = "whispelyn-byte/LilacAnime-desktop"
        commit, tree = "c" * 40, "d" * 40
        release = {
            "tag_name": "v0.5.55",
            "html_url": f"https://github.com/{repository}/releases/tag/v0.5.55",
            "tarball_url": f"https://api.github.com/repos/{repository}/tarball/v0.5.55",
            "assets": [],
        }

        def run_with_tree(tree_payload):
            requested: list[str] = []
            responses = {
                f"https://api.github.com/repos/{repository}/releases/latest": release,
                f"https://api.github.com/repos/{repository}/git/ref/tags/v0.5.55": {
                    "ref": "refs/tags/v0.5.55", "object": {"sha": commit, "type": "commit"},
                },
                f"https://api.github.com/repos/{repository}/git/commits/{commit}": {
                    "sha": commit, "tree": {"sha": tree},
                },
                f"https://api.github.com/repos/{repository}/git/trees/{tree}?recursive=1": tree_payload,
            }

            def opener(request, **_kwargs):
                url = request.full_url
                requested.append(url)
                if url not in responses:
                    raise AssertionError(f"Unexpected network request: {url}")
                return Response(json.dumps(responses[url]).encode("utf-8"))

            return manager_core.preflight_official_source_update(current_version="0.5.54", opener=opener), requested

        before = manager_core._inventory(self.official)
        incomplete, incomplete_requests = run_with_tree({"sha": tree, "truncated": True, "tree": []})
        self.assertEqual(incomplete["status"], "UPDATE_PREFLIGHT_BLOCKED")
        self.assertFalse(incomplete["sourceArchiveDownloaded"])
        self.assertFalse(any("/tarball/" in url or "/zipball/" in url for url in incomplete_requests))

        unsafe, unsafe_requests = run_with_tree({
            "sha": tree,
            "truncated": False,
            "tree": [{"path": "../outside.txt", "mode": "100644", "type": "blob", "sha": "f" * 40, "size": 1}],
        })
        self.assertEqual(unsafe["status"], "UPDATE_PREFLIGHT_BLOCKED")
        self.assertFalse(unsafe["sourceArchiveDownloaded"])
        self.assertFalse(any("/tarball/" in url or "/zipball/" in url for url in unsafe_requests))
        self.assertEqual(manager_core._inventory(self.official), before)

    def test_official_source_archive_checksum_metadata_is_not_guessed(self) -> None:
        release = {"assets": [{"name": "source-code.zip", "digest": "sha256:" + "a" * 64}]}
        count, present, checksum = manager_core._source_archive_release_assets(release)
        self.assertEqual((count, present, checksum), (1, True, True))

        release = {"assets": [{"name": "SHA256SUMS.txt", "digest": "sha256:" + "b" * 64}]}
        count, present, checksum = manager_core._source_archive_release_assets(release)
        self.assertEqual((count, present, checksum), (1, False, None))

        with self.assertRaisesRegex(manager_core.ManagerError, "자산 목록"):
            manager_core._source_archive_release_assets({})

    def test_theme_uses_electron_runtime_user_data_name_read_only_and_leveldb_falls_back(self) -> None:
        self._write(
            "package.json",
            json.dumps({"name": "lilacanime-desktop", "version": "0.5.54", "build": {"productName": "LilacAnime"}}),
        )
        app_data = self.root / "profile"
        storage = app_data / "lilacanime-desktop" / "Local Storage"
        storage.mkdir(parents=True)
        decoy_storage = app_data / "LilacAnime" / "Local Storage"
        decoy_storage.mkdir(parents=True)
        for database, value in ((decoy_storage / "file__0.localstorage", b"dark"), (storage / "file__0.localstorage", b"light")):
            db = sqlite3.connect(database)
            db.execute("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)")
            db.execute("INSERT INTO ItemTable(key, value) VALUES (?, ?)", ("theme", value))
            db.commit()
            db.close()
        with mock.patch.dict(manager_core.os.environ, {"APPDATA": str(app_data)}):
            result = manager_core.read_official_theme(self.official)
        self.assertEqual((result["status"], result["theme"], result["readOnly"]), ("READ", "light", True))
        self.assertEqual(result["source"], str(storage / "file__0.localstorage"))
        db = sqlite3.connect(storage / "file__0.localstorage")
        try:
            self.assertEqual(db.execute("SELECT value FROM ItemTable WHERE key='theme'").fetchone()[0], b"light")
        finally:
            db.close()
        db = sqlite3.connect(decoy_storage / "file__0.localstorage")
        try:
            self.assertEqual(db.execute("SELECT value FROM ItemTable WHERE key='theme'").fetchone()[0], b"dark")
        finally:
            db.close()

        (storage / "file__0.localstorage").unlink()
        (storage / "leveldb").mkdir()
        (storage / "leveldb" / "000001.log").write_bytes(b"synthetic-leveldb")
        stale_database = storage / "file__0.localstorage"
        db = sqlite3.connect(stale_database)
        db.execute("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)")
        db.execute("INSERT INTO ItemTable(key, value) VALUES (?, ?)", ("theme", b"dark"))
        db.commit()
        db.close()
        with mock.patch.dict(manager_core.os.environ, {"APPDATA": str(app_data)}), mock.patch.object(manager_core, "manager_home", return_value=self.root / "manager-home"):
            result = manager_core.read_official_theme(self.official)
        self.assertEqual(result["status"], "FALLBACK")
        self.assertIn("LevelDB", result["reason"])
        self.assertEqual(result["readOnly"], True)
        self.assertTrue((self.root / "manager-home" / "manager.log").is_file())
        db = sqlite3.connect(stale_database)
        try:
            self.assertEqual(db.execute("SELECT value FROM ItemTable WHERE key='theme'").fetchone()[0], b"dark")
        finally:
            db.close()

    def test_theme_rejects_unknown_value_without_rewriting_legacy_store(self) -> None:
        self._write(
            "package.json",
            json.dumps({"name": "lilacanime-desktop", "version": "0.5.54", "build": {"productName": "LilacAnime"}}),
        )
        app_data = self.root / "profile"
        storage = app_data / "lilacanime-desktop" / "Local Storage"
        storage.mkdir(parents=True)
        database = storage / "file__0.localstorage"
        db = sqlite3.connect(database)
        db.execute("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)")
        db.execute("INSERT INTO ItemTable(key, value) VALUES (?, ?)", ("theme", b"ultraviolet"))
        db.commit()
        db.close()

        with mock.patch.dict(manager_core.os.environ, {"APPDATA": str(app_data)}), mock.patch.object(
            manager_core, "manager_home", return_value=self.root / "manager-home"
        ):
            result = manager_core.read_official_theme(self.official)

        self.assertEqual(result["status"], "FALLBACK")
        self.assertTrue(result["readOnly"])
        db = sqlite3.connect(database)
        try:
            self.assertEqual(db.execute("SELECT value FROM ItemTable WHERE key='theme'").fetchone()[0], b"ultraviolet")
        finally:
            db.close()

    def test_theme_reads_dark_light_and_system_values_from_legacy_store(self) -> None:
        self._write(
            "package.json",
            json.dumps({"name": "lilacanime-desktop", "version": "0.5.54", "build": {"productName": "LilacAnime"}}),
        )
        app_data = self.root / "profile"
        storage = app_data / "lilacanime-desktop" / "Local Storage"
        storage.mkdir(parents=True)
        database = storage / "file__0.localstorage"

        for saved_theme, resolved_theme in (("dark", "dark"), ("light", "light"), ("system", "light")):
            with self.subTest(saved_theme=saved_theme):
                db = sqlite3.connect(database)
                db.execute("DROP TABLE IF EXISTS ItemTable")
                db.execute("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)")
                db.execute("INSERT INTO ItemTable(key, value) VALUES (?, ?)", ("theme", saved_theme.encode("utf-8")))
                db.commit()
                db.close()
                with mock.patch.dict(manager_core.os.environ, {"APPDATA": str(app_data)}), mock.patch.object(
                    manager_core, "_system_theme", return_value=("light", "Windows AppsUseLightTheme")
                ):
                    result = manager_core.read_official_theme(self.official)
                self.assertEqual((result["status"], result["setting"], result["theme"]), ("READ", saved_theme, resolved_theme))
                self.assertTrue(result["readOnly"])

    def test_missing_or_locked_theme_store_falls_back_without_writes(self) -> None:
        self._write(
            "package.json",
            json.dumps({"name": "lilacanime-desktop", "version": "0.5.54", "build": {"productName": "LilacAnime"}}),
        )
        app_data = self.root / "profile"
        storage = app_data / "lilacanime-desktop" / "Local Storage"
        with mock.patch.dict(manager_core.os.environ, {"APPDATA": str(app_data)}), mock.patch.object(
            manager_core, "_system_theme", return_value=("dark", "Windows AppsUseLightTheme")
        ), mock.patch.object(manager_core, "manager_home", return_value=self.root / "manager-home"):
            missing = manager_core.read_official_theme(self.official)
        self.assertEqual(missing["status"], "FALLBACK")
        self.assertIn("찾지 못했습니다", missing["reason"])
        self.assertFalse(storage.exists())

        storage.mkdir(parents=True)
        database = storage / "file__0.localstorage"
        writer = sqlite3.connect(database, timeout=0.2)
        writer.execute("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)")
        writer.execute("INSERT INTO ItemTable(key, value) VALUES (?, ?)", ("theme", b"light"))
        writer.commit()
        writer.execute("BEGIN EXCLUSIVE")
        try:
            with mock.patch.dict(manager_core.os.environ, {"APPDATA": str(app_data)}), mock.patch.object(
                manager_core, "_system_theme", return_value=("dark", "Windows AppsUseLightTheme")
            ), mock.patch.object(manager_core, "manager_home", return_value=self.root / "manager-home"):
                locked = manager_core.read_official_theme(self.official)
        finally:
            writer.rollback()
            writer.close()
        self.assertEqual((locked["status"], locked["theme"]), ("FALLBACK", "dark"))
        self.assertIn("OperationalError", locked["reason"])
        db = sqlite3.connect(database)
        try:
            self.assertEqual(db.execute("SELECT value FROM ItemTable WHERE key='theme'").fetchone()[0], b"light")
        finally:
            db.close()

    def test_manager_version_is_the_build_output_version_source(self) -> None:
        manager_source = (HERE / "manager_core.py").read_text(encoding="utf-8")
        build_script = (HERE / "tests" / "fixtures" / "legacy_tk" / "build_windows.ps1").read_text(encoding="utf-8")
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
