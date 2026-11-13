from __future__ import annotations

import unittest
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import manager_bridge
import manager_core


class ManagerBridgeTests(unittest.TestCase):
    def test_info_reports_the_existing_engine_and_patch_manifest(self) -> None:
        result = manager_bridge.dispatch({"operation": "info"})
        self.assertEqual(result["managerVersion"], manager_core.MANAGER_VERSION)
        self.assertEqual(result["patchVersion"], manager_core.PATCH_VERSION)
        self.assertEqual(result["officialVersion"], "0.5.54")
        self.assertEqual(result["officialCommit"], "e4ac62214f5c4863eebae5052633e7f9f33dcbaa")

    def test_unknown_action_is_rejected_without_calling_engine_mutations(self) -> None:
        with patch.object(manager_core, "apply_patch_in_place") as apply:
            with self.assertRaises(manager_core.ManagerError):
                manager_bridge.dispatch({"operation": "runShell", "command": "whoami"})
            apply.assert_not_called()

    def test_path_values_must_be_strings(self) -> None:
        with self.assertRaises(manager_core.ManagerError):
            manager_bridge.dispatch({"operation": "inspect", "root": ["C:\\"]})

    def test_update_approval_cannot_install_an_unverified_official_release(self) -> None:
        result = manager_bridge.dispatch({
            "operation": "updateApprove",
            "updateInfo": {"status": "UPDATE_AVAILABLE_UNSUPPORTED", "latestVersion": "v9.9.9"},
        })
        self.assertEqual(result["status"], "UNSUPPORTED")
        self.assertIn("원본 파일을 변경하지 않았습니다", result["reason"])

    def test_update_check_routes_a_selected_source_to_read_only_preflight(self) -> None:
        expected = {"status": "UPDATE_AVAILABLE_UNSUPPORTED", "sourcePreflightStatus": "READ_ONLY_COMPLETE"}
        with patch.object(manager_core, "preflight_official_source_update", return_value=expected) as preflight:
            result = manager_bridge.dispatch({
                "operation": "updateCheck",
                "currentVersion": "0.5.54",
                "root": r"C:\Temp\LilacAnime source",
            })
        self.assertIs(result, expected)
        preflight.assert_called_once_with(current_version="0.5.54", root_value=r"C:\Temp\LilacAnime source")

    def test_theme_fallback_is_explicit_and_read_only(self) -> None:
        with patch.object(manager_core, "_system_theme", return_value=("dark", "테스트 시스템 테마")):
            result = manager_bridge.dispatch({"operation": "themeFallback"})
        self.assertEqual(result["status"], "FALLBACK")
        self.assertTrue(result["readOnly"])
        self.assertEqual(result["theme"], "dark")

    def test_bridge_forces_utf8_for_progress_result_error_and_stderr_under_cp949(self) -> None:
        script = r'''import sys
import manager_bridge

def dispatch(request, progress=None):
    if request.get("operation") == "fail":
        sys.stderr.write("\u2714 \ud55c\uae00 stderr error\n")
        raise RuntimeError("\u2714 \ud55c\uae00 \uc5d4\uc9c4 \uc624\ub958")
    sys.stderr.write("\u2714 \ud55c\uae00 stderr 정상\n")
    progress("\u2714 \ud55c\uae00 진행")
    return {"message": "\u2714 \ud55c\uae00 결과"}

manager_bridge.dispatch = dispatch
raise SystemExit(manager_bridge.main())
'''
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "cp949"
        env["PYTHONUTF8"] = "0"
        env.pop("PYTHONLEGACYWINDOWSSTDIO", None)

        def invoke(operation: str) -> subprocess.CompletedProcess[bytes]:
            return subprocess.run(
                [sys.executable, "-c", script],
                input=json.dumps({"operation": operation}).encode("ascii"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=Path(__file__).resolve().parents[1],
                env=env,
                check=False,
            )

        success = invoke("success")
        stdout_text = success.stdout.decode("utf-8")
        stderr_text = success.stderr.decode("utf-8")
        self.assertEqual(success.returncode, 0, stderr_text)
        self.assertIn("✔ 한글 진행", stdout_text)
        self.assertIn("✔ 한글 결과", stdout_text)
        self.assertIn("✔ 한글 stderr 정상", stderr_text)
        messages = [json.loads(line) for line in stdout_text.splitlines()]
        self.assertEqual([message["type"] for message in messages], ["progress", "result"])

        failure = invoke("fail")
        failure_stdout = failure.stdout.decode("utf-8")
        failure_stderr = failure.stderr.decode("utf-8")
        self.assertEqual(failure.returncode, 1)
        self.assertIn("✔ 한글 stderr error", failure_stderr)
        error_message = json.loads(failure_stdout.splitlines()[-1])
        self.assertEqual(error_message["type"], "error")
        self.assertIn("✔ 한글 엔진 오류", error_message["error"])


if __name__ == "__main__":
    unittest.main()
