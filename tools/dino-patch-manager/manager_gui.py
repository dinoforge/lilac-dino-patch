"""Tkinter desktop interface for safely applying the verified Dino patch."""

from __future__ import annotations

import json
import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk
from typing import Any, Callable

from manager_core import (
    EXPECTED_PROJECT_ROOT,
    PROJECT_ROOT,
    ManagerError,
    apply_patch,
    assert_project_root,
    check_compatibility,
    existing_validator,
    load_manifest,
    preview_changes,
)


DEFAULT_OUTPUT = Path(r"D:\Codex-Coding-Folder\LilacAnime-Patched")


def _format_exception(exc: BaseException) -> str:
    lines = [str(exc)]
    lines.extend(getattr(exc, "__notes__", []))
    return "\n".join(line for line in lines if line)


class DinoPatchManager:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("디노 패치 관리자")
        self.root.geometry("1080x850")
        self.root.minsize(920, 730)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self.source_var = tk.StringVar()
        self.patch_var = tk.StringVar(value=str(PROJECT_ROOT))
        self.output_var = tk.StringVar(value=str(DEFAULT_OUTPUT))
        self.dependencies_var = tk.StringVar()
        self.version_var = tk.StringVar(value="확인 전")
        self.integrity_var = tk.StringVar(value="확인 전")
        self.compat_var = tk.StringVar(value="검사 전")
        self.recent_var = tk.StringVar(value="아직 실행한 검사가 없습니다.")
        self.status_var = tk.StringVar(value="공식 원본과 패치 구성을 선택한 뒤 검사를 시작하세요.")
        self.external_electron_var = tk.BooleanVar(value=False)

        self._events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._busy = False
        self._validated_key: tuple[str, str] | None = None
        self._latest_check: dict[str, Any] | None = None
        self._manifest: dict[str, Any] | None = None
        self._closing = False

        self._build_ui()
        self._load_initial_patch_status()
        self._poll_events()

    def _build_ui(self) -> None:
        self.root.configure(padx=14, pady=12)
        outer = ttk.Frame(self.root)
        outer.pack(fill="both", expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(4, weight=1)
        outer.rowconfigure(5, weight=1)

        header = ttk.Frame(outer)
        header.grid(row=0, column=0, sticky="ew", pady=(0, 12))
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text="디노 패치 관리자", font=("맑은 고딕", 20, "bold")).grid(row=0, column=0, sticky="w")
        ttk.Label(
            header,
            text="공식 LilacAnime 원본을 검사하고, 원본을 보존한 채 새 폴더에 최소 연결 패치를 적용합니다.",
            wraplength=900,
        ).grid(row=1, column=0, sticky="w", pady=(3, 0))

        inputs = ttk.LabelFrame(outer, text="입력 및 출력")
        inputs.grid(row=1, column=0, sticky="ew", pady=(0, 10))
        inputs.columnconfigure(1, weight=1)

        self._path_row(inputs, 0, "공식 원본 ZIP / 폴더", self.source_var, self._choose_source)
        self._path_row(inputs, 1, "패치 구성 경로", self.patch_var, self._choose_patch)
        self._path_row(inputs, 2, "새 출력 폴더", self.output_var, self._choose_output)

        status_box = ttk.LabelFrame(outer, text="현재 상태")
        status_box.grid(row=2, column=0, sticky="ew", pady=(0, 10))
        status_box.columnconfigure(1, weight=1)
        ttk.Label(status_box, text="원본 버전").grid(row=0, column=0, sticky="w", padx=9, pady=4)
        ttk.Label(status_box, textvariable=self.version_var).grid(row=0, column=1, sticky="w", padx=9, pady=4)
        ttk.Label(status_box, text="원본 무결성").grid(row=0, column=2, sticky="w", padx=9, pady=4)
        ttk.Label(status_box, textvariable=self.integrity_var).grid(row=0, column=3, sticky="w", padx=9, pady=4)
        ttk.Label(status_box, text="호환성").grid(row=1, column=0, sticky="w", padx=9, pady=4)
        self.compat_label = ttk.Label(status_box, textvariable=self.compat_var, font=("맑은 고딕", 10, "bold"))
        self.compat_label.grid(row=1, column=1, sticky="w", padx=9, pady=4)
        ttk.Label(status_box, text="최근 결과").grid(row=1, column=2, sticky="w", padx=9, pady=4)
        ttk.Label(status_box, textvariable=self.recent_var, wraplength=480).grid(row=1, column=3, sticky="w", padx=9, pady=4)

        summary = ttk.LabelFrame(outer, text="검사 후 적용 미리보기")
        summary.grid(row=3, column=0, sticky="ew", pady=(0, 10))
        summary.columnconfigure(0, weight=1)
        tree = ttk.Treeview(summary, columns=("kind", "path", "description"), show="headings", height=5)
        tree.heading("kind", text="작업")
        tree.heading("path", text="파일")
        tree.heading("description", text="설명")
        tree.column("kind", width=115, stretch=False)
        tree.column("path", width=270, stretch=False)
        tree.column("description", width=580, stretch=True)
        tree.grid(row=0, column=0, sticky="ew", padx=8, pady=8)
        self.change_tree = tree
        for path, text in (
            ("src/app.js", "수정 · 통합 모드의 마지막 개별 공급원 초기값 연결"),
            ("src/index.html", "수정 · 설정 옵션, 스타일 및 브리지 스크립트 연결"),
            ("src/integrated-search.js", "추가 · 공급원 검색 및 작품 그룹화"),
            ("src/integrated-search.css", "추가 · 통합 검색 결과 스타일"),
            ("src/patch03-bridge.js", "추가 · 공식 검색·상세 호출 연결"),
        ):
            kind = "공식 연결 수정" if path in {"src/app.js", "src/index.html"} else "패치 모듈 추가"
            tree.insert("", "end", values=(kind, path, text))

        details = ttk.LabelFrame(outer, text="동작 구분")
        details.grid(row=4, column=0, sticky="nsew", pady=(0, 10))
        details.columnconfigure(0, weight=1)
        details.rowconfigure(1, weight=1)
        ttk.Label(
            details,
            text="기본 검사는 네트워크와 의존성 설치 없이 수행합니다. 실제 외부 공급원 검색·영상 재생은 아래 선택 검증에서만 실행합니다.",
            wraplength=980,
        ).grid(row=0, column=0, sticky="w", padx=9, pady=(7, 4))
        self.log = tk.Text(details, height=9, wrap="word", state="disabled", font=("Consolas", 9))
        scroll = ttk.Scrollbar(details, orient="vertical", command=self.log.yview)
        self.log.configure(yscrollcommand=scroll.set)
        self.log.grid(row=1, column=0, sticky="nsew", padx=(9, 0), pady=(3, 9))
        scroll.grid(row=1, column=1, sticky="ns", padx=(0, 9), pady=(3, 9))

        actions = ttk.Frame(outer)
        actions.grid(row=5, column=0, sticky="ew")
        actions.columnconfigure(0, weight=1)
        left = ttk.Frame(actions)
        left.grid(row=0, column=0, sticky="w")
        self.check_button = ttk.Button(left, text="호환성 검사", command=self._check)
        self.check_button.grid(row=0, column=0, padx=(0, 6))
        self.preview_button = ttk.Button(left, text="변경 내용 미리보기", command=self._preview, state="disabled")
        self.preview_button.grid(row=0, column=1, padx=6)
        self.electron_button = ttk.Button(left, text="격리 Electron 검사…", command=self._electron_check)
        self.electron_button.grid(row=0, column=2, padx=6)
        self.external_toggle = ttk.Checkbutton(left, text="실제 공급원 요청 포함", variable=self.external_electron_var)
        self.external_toggle.grid(row=0, column=3, padx=8)

        self.apply_button = ttk.Button(actions, text="새 출력 폴더에 적용", command=self._apply, state="disabled")
        self.apply_button.grid(row=0, column=1, sticky="e", padx=(8, 0))
        self.progress = ttk.Progressbar(outer, mode="indeterminate")
        self.progress.grid(row=6, column=0, sticky="ew", pady=(9, 3))
        ttk.Label(outer, textvariable=self.status_var, wraplength=980).grid(row=7, column=0, sticky="w")

    def _path_row(self, parent: ttk.LabelFrame, row: int, label: str, variable: tk.StringVar, command: Callable[[], None]) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=9, pady=5)
        entry = ttk.Entry(parent, textvariable=variable)
        entry.grid(row=row, column=1, sticky="ew", padx=6, pady=5)
        ttk.Button(parent, text="찾아보기…", command=command).grid(row=row, column=2, sticky="e", padx=9, pady=5)
        variable.trace_add("write", lambda *_args: self._invalidate_check())

    def _load_initial_patch_status(self) -> None:
        try:
            _, manifest = load_manifest(self.patch_var.get())
            self._manifest = manifest
            self.version_var.set(f"원본 선택 전 · 기준 v{manifest['officialVersion']}")
            self.integrity_var.set("패치 모듈 SHA-256 확인")
            self._log(f"패치 manifest와 필수 모듈 {len(manifest['runtimeModules'])}개 SHA-256을 확인했습니다.")
            self._log("원본 입력은 읽기 전용이며, 출력 폴더는 기존 경로를 덮어쓰지 않습니다.")
        except Exception as exc:
            self.compat_var.set("적용 불가")
            self._log(f"패치 구성을 읽지 못했습니다: {_format_exception(exc)}")

    def _choose_source(self) -> None:
        choice = messagebox.askyesnocancel("공식 원본 선택", "예: 공식 ZIP/TAR 선택\n아니오: 이미 압축 해제된 공식 원본 폴더 선택", parent=self.root)
        if choice is None:
            return
        if choice:
            path = filedialog.askopenfilename(
                parent=self.root,
                title="공식 LilacAnime 원본 아카이브 선택",
                filetypes=(("원본 아카이브", "*.zip *.tar *.tar.gz *.tgz"), ("모든 파일", "*.*")),
            )
        else:
            path = filedialog.askdirectory(parent=self.root, title="공식 LilacAnime 원본 폴더 선택", mustexist=True)
        if path:
            self.source_var.set(path)
            self._log(f"원본 입력 선택: {path}")

    def _choose_patch(self) -> None:
        path = filedialog.askdirectory(parent=self.root, title="patches/patch03/manifest.json을 포함한 패치 구성 루트", mustexist=True)
        if path:
            self.patch_var.set(path)

    def _choose_output(self) -> None:
        parent = filedialog.askdirectory(parent=self.root, title="새 출력 폴더를 만들 상위 위치 선택", mustexist=True)
        if not parent:
            return
        name = simpledialog.askstring("새 출력 폴더 이름", "새 폴더 이름을 입력하세요. 이미 존재하는 폴더는 덮어쓰지 않습니다.", parent=self.root, initialvalue="LilacAnime-Dino")
        if not name:
            return
        self.output_var.set(str(Path(parent) / name))

    def _invalidate_check(self) -> None:
        if not hasattr(self, "apply_button"):
            return
        self._validated_key = None
        self._latest_check = None
        if not self._busy:
            self.apply_button.configure(state="disabled")
            self.preview_button.configure(state="disabled")
            self.compat_var.set("검사 필요")

    def _inputs(self) -> tuple[str, str, str]:
        source = self.source_var.get().strip()
        patch = self.patch_var.get().strip()
        output = self.output_var.get().strip()
        if not source:
            raise ManagerError("공식 원본 ZIP 또는 폴더를 선택하세요.")
        if not patch:
            raise ManagerError("패치 구성 경로를 선택하세요.")
        return source, patch, output

    def _source_patch_key(self) -> tuple[str, str]:
        return (str(Path(self.source_var.get().strip()).expanduser()), str(Path(self.patch_var.get().strip()).expanduser()))

    def _check(self) -> None:
        try:
            source, patch, _ = self._inputs()
        except Exception as exc:
            messagebox.showerror("검사할 수 없습니다", _format_exception(exc), parent=self.root)
            return

        def work(progress: Callable[[str], None]) -> dict[str, Any]:
            return check_compatibility(source, patch, progress=progress)

        self._start_job("compatibility", "공식 원본과 패치 호환성을 검사합니다…", work)

    def _preview(self) -> None:
        try:
            source, patch, _ = self._inputs()
            if (
                self._validated_key != self._source_patch_key()
                or not self._latest_check
                or self._latest_check.get("status") != "PASS"
            ):
                raise ManagerError("먼저 현재 원본과 패치 구성의 호환성 검사를 통과해야 합니다.")
        except Exception as exc:
            messagebox.showerror("미리보기를 만들 수 없습니다", _format_exception(exc), parent=self.root)
            return
        try:
            result = preview_changes(source, patch)
            self._show_preview(result)
        except Exception as exc:
            messagebox.showerror("미리보기를 만들 수 없습니다", _format_exception(exc), parent=self.root)

    def _show_preview(self, result: dict[str, Any]) -> None:
        window = tk.Toplevel(self.root)
        window.title("디노 패치 적용 미리보기")
        window.geometry("900x650")
        window.transient(self.root)
        frame = ttk.Frame(window, padding=10)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="공식 런타임 파일 2개만 수정하고 모듈 3개만 추가합니다.", font=("맑은 고딕", 11, "bold")).pack(anchor="w", pady=(0, 8))
        ttk.Label(frame, text="다른 공식 런타임 파일 변경: 없음").pack(anchor="w", pady=(0, 6))
        text = tk.Text(frame, wrap="none", font=("Consolas", 9))
        ybar = ttk.Scrollbar(frame, orient="vertical", command=text.yview)
        xbar = ttk.Scrollbar(frame, orient="horizontal", command=text.xview)
        text.configure(yscrollcommand=ybar.set, xscrollcommand=xbar.set)
        text.pack(side="top", fill="both", expand=True)
        ybar.pack(side="right", fill="y")
        xbar.pack(side="bottom", fill="x")
        for item in result["connections"]:
            text.insert("end", f"\n## {item['file']} — {item['description']}\n")
            text.insert("end", item["diff"] or "(변경 내용 없음)\n")
        text.insert("end", "\n## 새 패치 모듈\n")
        for path in result["added"]:
            text.insert("end", f"+ {path}\n")
        text.configure(state="disabled")

    def _apply(self) -> None:
        try:
            source, patch, output = self._inputs()
            if self._validated_key != self._source_patch_key() or not self._latest_check:
                raise ManagerError("현재 입력에 대한 호환성 검사를 먼저 통과해야 적용할 수 있습니다.")
            if self._latest_check.get("status") != "PASS":
                raise ManagerError("호환성 검사가 완전히 통과하지 않아 적용을 막았습니다.")
            if not output:
                raise ManagerError("새 출력 폴더 경로를 입력하세요.")
        except Exception as exc:
            messagebox.showerror("적용할 수 없습니다", _format_exception(exc), parent=self.root)
            return
        ok = messagebox.askyesno(
            "새 출력 폴더에 적용",
            "선택한 공식 원본을 읽기 전용으로 유지하고, 새 출력 폴더에 패치를 적용합니다.\n\n"
            f"출력 경로:\n{output}\n\n"
            "출력 폴더가 이미 있거나 보호 경로와 겹치면 작업을 중단합니다. 계속할까요?",
            parent=self.root,
        )
        if not ok:
            return

        def work(progress: Callable[[str], None]) -> dict[str, Any]:
            return apply_patch(source, patch, output, progress=progress)

        self._start_job("apply", "별도 출력 폴더를 준비하고 변경 범위를 검증합니다…", work)

    def _electron_check(self) -> None:
        if not self.external_electron_var.get():
            messagebox.showinfo(
                "선택 검증",
                "실제 Electron 외부 공급원 검증을 하려면 ‘실제 공급원 요청 포함’을 먼저 선택하세요. 기본 검사는 네트워크를 사용하지 않습니다.",
                parent=self.root,
            )
            return
        source = self.source_var.get().strip()
        patch = self.patch_var.get().strip()
        if not source.lower().endswith((".zip", ".tar", ".tar.gz", ".tgz")):
            messagebox.showerror("검증할 수 없습니다", "기존 Electron 검증기는 고정 공식 아카이브를 요구합니다. 공식 원본 아카이브를 선택하세요.", parent=self.root)
            return
        try:
            patch_root, manifest = load_manifest(patch)
            if str(patch_root).casefold() != str(PROJECT_ROOT).casefold():
                raise ManagerError("Electron 검증은 이 프로젝트의 고정 manifest와 검증기를 사용합니다. 패치 구성 경로를 프로젝트 루트로 선택하세요.")
        except Exception as exc:
            messagebox.showerror("검증할 수 없습니다", _format_exception(exc), parent=self.root)
            return
        dependencies = filedialog.askdirectory(
            parent=self.root,
            title="OS Temp에 준비된 공식 package-lock 호환 Node 의존성 폴더 선택",
            mustexist=True,
        )
        if not dependencies:
            return
        ok = messagebox.askyesno(
            "실제 공급원 요청 확인",
            "선택한 Electron 검증은 격리 프로필을 사용하지만 실제 공급원에 검색·상세·재생 요청을 보낼 수 있습니다.\n"
            "의존성은 선택된 임시 폴더만 재사용하며 npm 설치는 하지 않습니다.\n\n계속할까요?",
            parent=self.root,
        )
        if not ok:
            return

        def work(progress: Callable[[str], None]) -> dict[str, Any]:
            progress("기존 검증기를 재사용합니다. npm 설치는 수행하지 않습니다.")
            return existing_validator(source, electron=True, dependencies_from=dependencies)

        self._start_job("electron", "격리 Electron 실서비스 검증을 실행합니다…", work)

    def _start_job(self, kind: str, initial: str, worker: Callable[[Callable[[str], None]], dict[str, Any]]) -> None:
        if self._busy:
            return
        self._busy = True
        self._set_actions(False)
        self.status_var.set(initial)
        self.progress.start(10)
        self._log(initial)

        def progress(message: str) -> None:
            self._events.put(("progress", message))

        def run() -> None:
            try:
                result = worker(progress)
                self._events.put(("done", (kind, result)))
            except BaseException as exc:
                self._events.put(("error", (kind, _format_exception(exc))))

        threading.Thread(target=run, name=f"dino-manager-{kind}", daemon=True).start()

    def _poll_events(self) -> None:
        if self._closing:
            return
        try:
            while True:
                event, payload = self._events.get_nowait()
                if event == "progress":
                    self.status_var.set(str(payload))
                    self._log(str(payload))
                elif event == "done":
                    kind, result = payload
                    self._busy = False
                    self.progress.stop()
                    self._set_actions(True)
                    self._handle_success(kind, result)
                elif event == "error":
                    kind, error = payload
                    self._busy = False
                    self.progress.stop()
                    self._set_actions(True)
                    self._handle_failure(kind, error)
        except queue.Empty:
            pass
        self.root.after(100, self._poll_events)

    def _set_actions(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        self.check_button.configure(state=state)
        self.electron_button.configure(state=state)
        self.external_toggle.configure(state=state)
        can_use_check = (
            enabled
            and self._validated_key == self._source_patch_key()
            and self._latest_check is not None
            and self._latest_check.get("status") == "PASS"
        )
        self.preview_button.configure(state="normal" if can_use_check else "disabled")
        self.apply_button.configure(state="normal" if can_use_check and self._latest_check.get("status") == "PASS" else "disabled")

    def _handle_success(self, kind: str, result: dict[str, Any]) -> None:
        if kind == "compatibility":
            status = str(result.get("status", result.get("result", "PASS")))
            self._latest_check = result
            self._validated_key = self._source_patch_key()
            version = result.get("officialVersion") or result.get("version")
            version_text = f"v{version}" if version else f"원본 버전 미확인 · 기준 v{self._manifest['officialVersion']}"
            commit = result.get("officialCommit", result.get("commit"))
            self.version_var.set(f"{version_text} · {commit or '커밋/아카이브 기준 추가 확인 필요'}")
            integrity = result.get("archiveSha256") or result.get("treeSha256") or result.get("officialTreeSha256") or "원본 지문 검사"
            integrity_label = "일치" if status == "PASS" else "기준과 차이 · 추가 검증 필요"
            self.integrity_var.set(f"{integrity_label} · {str(integrity)[:16]}…")
            if status == "PASS":
                self.compat_var.set("호환 확인")
                self.status_var.set("호환성 검사 통과. 변경 미리보기 후 새 폴더에 적용할 수 있습니다.")
                self.recent_var.set("검사 통과 · 설치 및 외부 요청 없음")
                self._log("호환성 검사 통과: 공식 경로를 유지하고 지정된 5개 패치 파일 범위만 확인했습니다.")
            else:
                self.compat_var.set("추가 검증 필요")
                self.status_var.set("공식 기준과 차이가 있습니다. 새 버전 호환 검토 전에는 적용할 수 없습니다.")
                self.recent_var.set("기준 버전·파일·계약 추가 확인 필요")
                self._log("적용은 비활성화했습니다. 새 공식 버전은 별도 기준 지문과 연결 검토가 필요합니다.")
                for finding in result.get("findings", []):
                    self._log(f"확인 항목: {finding}")
            if result.get("reportPath"):
                self._log(f"검사 보고서: {result['reportPath']}")
        elif kind == "apply":
            self._latest_check = None
            self._validated_key = None
            self.apply_button.configure(state="disabled")
            self.compat_var.set("적용 완료")
            self.recent_var.set("새 출력본 적용 및 무결성 확인 완료")
            self.status_var.set(f"새 출력본을 만들었습니다: {result['output']}")
            self._log(f"완료 · 공식 파일 수정 {len(result['modifiedOfficialFiles'])}개 · 모듈 추가 {len(result['addedPatchFiles'])}개")
            self._log(f"원본은 변경되지 않았습니다: {result['source'].get('path')}")
            if result.get("reportPath"):
                self._log(f"적용 보고서: {result['reportPath']}")
            elif result.get("reportWarning"):
                self._log(result["reportWarning"])
            messagebox.showinfo("적용 완료", f"새 출력본을 만들었습니다.\n\n{result['output']}\n\n원본은 변경되지 않았습니다.", parent=self.root)
        elif kind == "electron":
            self.compat_var.set("Electron 검사 완료")
            self.recent_var.set("외부 공급원 포함 격리 Electron 검사 실행 완료")
            self.status_var.set("Electron 검증이 끝났습니다. 결과 세부 사항을 로그에 기록했습니다.")
            self._log(json.dumps(result, ensure_ascii=False, indent=2)[:9000])
        self._set_actions(True)

    def _handle_failure(self, kind: str, error: str) -> None:
        if kind == "compatibility":
            self._latest_check = None
            self._validated_key = None
            self.version_var.set("확인 실패")
            self.integrity_var.set("불일치 또는 미확인")
            self.compat_var.set("적용 불가")
            self.recent_var.set("호환성 검사 실패")
        elif kind == "apply":
            self.recent_var.set("적용 실패 · 원본과 기존 출력 보호")
        elif kind == "electron":
            self.recent_var.set("Electron 검증 실패 또는 외부 공급원 제한")
        self.status_var.set(error.splitlines()[0] if error else "작업을 완료하지 못했습니다.")
        self._log(f"실패 ({kind}):\n{error}")
        self._set_actions(True)
        messagebox.showerror("작업을 완료하지 못했습니다", error, parent=self.root)

    def _log(self, message: str) -> None:
        if self._closing:
            return
        self.log.configure(state="normal")
        self.log.insert("end", message.rstrip() + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _on_close(self) -> None:
        if self._busy:
            messagebox.showinfo(
                "작업 진행 중",
                "현재 검증 작업이 끝날 때까지 창을 열어 두세요. 작업 완료 후 안전하게 닫을 수 있습니다.",
                parent=self.root,
            )
            return
        self._closing = True
        self.root.destroy()


def main() -> None:
    assert_project_root()
    app = tk.Tk()
    try:
        ttk.Style(app).theme_use("vista")
    except tk.TclError:
        pass
    DinoPatchManager(app)
    app.mainloop()


if __name__ == "__main__":
    main()
