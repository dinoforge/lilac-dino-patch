"""Single-window GUI for safely managing the Dino patch in a source install."""

from __future__ import annotations

import ctypes
import json
import os
import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any, Callable

from manager_core import (
    IS_FROZEN,
    MANAGER_VERSION,
    PATCH_VERSION,
    ManagerError,
    _system_theme,
    apply_patch_in_place,
    approve_official_update,
    assert_project_root,
    automatic_startup_check,
    check_official_update,
    inspect_managed_target,
    list_backups,
    load_manifest,
    manager_home,
    patch_source_root,
    read_history,
    read_official_theme,
    restore_backup,
    uninstall_patch,
)

PALETTES: dict[str, dict[str, str]] = {
    "dark": {
        "bg": "#121212", "surface": "#1E1E1E", "surface2": "#28252B", "fg": "#F5F1F7",
        "muted": "#B8B1BC", "border": "#3B3740", "accent": "#C8A2C8", "accent2": "#9A7B9A",
        "accentText": "#241D27", "input": "#171619",
    },
    "light": {
        "bg": "#FFFFFF", "surface": "#F5F5F5", "surface2": "#ECE8EF", "fg": "#29252D",
        "muted": "#655E69", "border": "#DDD6E1", "accent": "#C8A2C8", "accent2": "#9A7B9A",
        "accentText": "#241D27", "input": "#FFFFFF",
    },
}


def _format_exception(exc: BaseException) -> str:
    return "\n".join(line for line in [str(exc), *getattr(exc, "__notes__", [])] if line)


def _enable_dpi_awareness() -> tuple[float, float]:
    """Set per-monitor awareness before Tk creates a window and return UI/DPI scales."""
    if os.name != "nt" or not IS_FROZEN:
        return 1.0, 96 / 72
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except (AttributeError, OSError):
            pass
    try:
        dpi = int(ctypes.windll.user32.GetDpiForSystem())
    except (AttributeError, OSError):
        dpi = 96
    if dpi < 72 or dpi > 768:
        dpi = 96
    return dpi / 96, dpi / 72


class DinoPatchManager:
    def __init__(self, root: tk.Tk, *, dpi_scale: float = 1.0) -> None:
        self.root = root
        self.root.title("디노 패치 관리자")
        self.root.geometry(f"{round(1080 * dpi_scale)}x{round(850 * dpi_scale)}")
        self.root.minsize(round(920 * dpi_scale), round(730 * dpi_scale))
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self._events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._busy = False
        self._closing = False
        self._theme = "dark"
        self._current_root: Path | None = None
        self._current_info: dict[str, Any] | None = None
        self._backups: list[dict[str, Any]] = []
        self._backup_ids: list[str] = []
        self._update_info: dict[str, Any] | None = None
        self._last_theme_log_key: tuple[str, str] | None = None
        self._log_messages: list[str] = []
        self._text_views: list[tk.Text] = []
        self._diagnostics_window: tk.Toplevel | None = None

        self.path_var = tk.StringVar(value="원본 폴더를 찾는 중…")
        self.official_var = tk.StringVar(value="확인 중")
        self.patch_var = tk.StringVar(value=f"디노 패치 v{PATCH_VERSION}")
        self.state_var = tk.StringVar(value="검사 중")
        self.compat_var = tk.StringVar(value="검증 중")
        self.recent_var = tk.StringVar(value="원본 폴더와 호환성을 확인합니다.")
        self.theme_var = tk.StringVar(value="LilacAnime 테마를 확인하는 중입니다.")
        self.update_var = tk.StringVar(value="공식 업데이트를 확인하지 않았습니다.")
        self.status_var = tk.StringVar(value="원본 폴더를 찾고 있습니다…")
        self.backup_var = tk.StringVar()

        self._build_ui()
        self._apply_palette("dark")
        self.root.bind("<FocusIn>", self._on_focus)
        self.root.after(120, self._begin_startup)
        self.root.after(100, self._poll_events)
        self.root.after(900, self._poll_theme)

    def _build_ui(self) -> None:
        self.style = ttk.Style(self.root)
        try:
            self.style.theme_use("clam")
        except tk.TclError:
            pass
        self.outer = ttk.Frame(self.root, style="App.TFrame", padding=(14, 12, 14, 10))
        self.outer.pack(fill="both", expand=True)
        self.outer.columnconfigure(0, weight=1)
        self.outer.rowconfigure(6, weight=1)

        header = ttk.Frame(self.outer, style="App.TFrame")
        header.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text="디노 패치 관리자", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(
            header,
            text="공식 LilacAnime 원본을 확인하고, 안전한 백업 후 패치를 관리합니다.",
            style="Subtitle.TLabel",
            wraplength=850,
        ).grid(row=1, column=0, sticky="w", pady=(3, 0))
        ttk.Label(header, text=f"관리자 v{MANAGER_VERSION}", style="Badge.TLabel", padding=(8, 4)).grid(row=0, column=1, rowspan=2, sticky="e")

        inputs = ttk.LabelFrame(self.outer, text="원본 폴더", padding=(9, 7))
        inputs.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        inputs.columnconfigure(0, weight=1)
        self.path_entry = ttk.Entry(inputs, textvariable=self.path_var, state="readonly", style="Path.TEntry")
        self.path_entry.grid(row=0, column=0, sticky="ew", padx=(0, 7))
        self.choose_button = ttk.Button(inputs, text="폴더 선택…", command=self._choose_root)
        self.choose_button.grid(row=0, column=1, sticky="e")

        status_box = ttk.LabelFrame(self.outer, text="현재 상태", padding=(8, 5))
        status_box.grid(row=2, column=0, sticky="ew", pady=(0, 8))
        for column in (1, 3, 5, 7):
            status_box.columnconfigure(column, weight=1)
        facts = (
            ("원본 버전", self.official_var),
            ("디노 패치", self.patch_var),
            ("패치 상태", self.state_var),
            ("호환성", self.compat_var),
        )
        for index, (label, variable) in enumerate(facts):
            column = index * 2
            ttk.Label(status_box, text=label).grid(row=0, column=column, sticky="w", padx=(4, 6), pady=3)
            ttk.Label(status_box, textvariable=variable, style="Fact.TLabel" if label != "호환성" else "Compat.TLabel").grid(
                row=0, column=column + 1, sticky="w", padx=(0, 10), pady=3
            )
        ttk.Label(status_box, text="최근 결과").grid(row=1, column=0, sticky="w", padx=(4, 6), pady=3)
        ttk.Label(status_box, textvariable=self.recent_var, wraplength=900, justify="left").grid(
            row=1, column=1, columnspan=7, sticky="w", padx=(0, 4), pady=3
        )

        summary = ttk.LabelFrame(self.outer, text="검사 후 적용 미리보기", padding=(7, 5))
        summary.grid(row=3, column=0, sticky="ew", pady=(0, 8))
        summary.columnconfigure(0, weight=1)
        tree = ttk.Treeview(summary, columns=("kind", "path", "description"), show="headings", height=4)
        tree.heading("kind", text="작업")
        tree.heading("path", text="파일")
        tree.heading("description", text="설명")
        tree.column("kind", width=125, stretch=False)
        tree.column("path", width=275, stretch=False)
        tree.column("description", width=560, stretch=True)
        tree.grid(row=0, column=0, sticky="ew")
        self.change_tree = tree

        actions = ttk.Frame(self.outer, style="App.TFrame")
        actions.grid(row=4, column=0, sticky="ew", pady=(0, 8))
        self.refresh_button = ttk.Button(actions, text="상태 확인", command=self._refresh_status)
        self.refresh_button.grid(row=0, column=0, padx=(0, 6))
        self.apply_button = ttk.Button(actions, text="패치 적용", command=self._apply, state="disabled")
        self.apply_button.grid(row=0, column=1, padx=6)
        self.uninstall_button = ttk.Button(actions, text="패치 해제", command=self._uninstall, state="disabled")
        self.uninstall_button.grid(row=0, column=2, padx=6)
        self.history_button = ttk.Button(actions, text="작업 기록", command=self._show_history)
        self.history_button.grid(row=0, column=3, padx=(8, 6))
        self.diagnostics_button = ttk.Button(actions, text="상세 진단", command=self._show_diagnostics)
        self.diagnostics_button.grid(row=0, column=4, padx=6)

        support = ttk.Frame(self.outer, style="App.TFrame")
        support.grid(row=5, column=0, sticky="ew", pady=(0, 8))
        support.columnconfigure(0, weight=1, uniform="support")
        support.columnconfigure(1, weight=1, uniform="support")

        backup_card = ttk.LabelFrame(support, text="백업 및 복원", padding=(8, 5))
        backup_card.grid(row=0, column=0, sticky="ew", padx=(0, 5))
        backup_card.columnconfigure(0, weight=1)
        ttk.Label(backup_card, text="파일 지문이 맞는 백업만 복원할 수 있습니다.", style="Muted.TLabel", wraplength=420).grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 4)
        )
        self.backup_combo = ttk.Combobox(backup_card, textvariable=self.backup_var, state="readonly", values=())
        self.backup_combo.grid(row=1, column=0, sticky="ew", padx=(0, 5))
        self.restore_button = ttk.Button(backup_card, text="백업 복원", command=self._restore, state="disabled")
        self.restore_button.grid(row=1, column=1, sticky="e")

        update_card = ttk.LabelFrame(support, text="공식 업데이트", padding=(8, 5))
        update_card.grid(row=0, column=1, sticky="ew", padx=(5, 0))
        update_card.columnconfigure(0, weight=1)
        ttk.Label(update_card, textvariable=self.update_var, style="Muted.TLabel", wraplength=440, justify="left").grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 4)
        )
        update_actions = ttk.Frame(update_card, style="App.TFrame")
        update_actions.grid(row=1, column=0, sticky="ew")
        update_actions.columnconfigure(0, weight=1)
        update_actions.columnconfigure(1, weight=1)
        self.update_button = ttk.Button(update_actions, text="최신 버전 확인", command=self._check_updates)
        self.update_button.grid(row=0, column=0, sticky="ew", padx=(0, 4))
        self.update_apply_button = ttk.Button(update_actions, text="승인 후 적용 확인…", command=self._approve_update, state="disabled")
        self.update_apply_button.grid(row=0, column=1, sticky="ew", padx=(4, 0))

        details = ttk.LabelFrame(self.outer, text="작업 기록", padding=(8, 5))
        details.grid(row=6, column=0, sticky="nsew", pady=(0, 7))
        details.columnconfigure(0, weight=1)
        details.rowconfigure(1, weight=1)
        ttk.Label(
            details,
            text="자동 확인·백업·적용 과정과 결과가 여기에 기록됩니다. 자세한 오류 내용은 ‘상세 진단’에서 확인할 수 있습니다.",
            style="Muted.TLabel",
            wraplength=950,
        ).grid(row=0, column=0, sticky="w", pady=(0, 4))
        self.main_log = tk.Text(details, height=7, wrap="word", state="disabled", font=("Consolas", 9), relief="sunken", borderwidth=1)
        log_scroll = ttk.Scrollbar(details, orient="vertical", command=self.main_log.yview)
        self.main_log.configure(yscrollcommand=log_scroll.set)
        self.main_log.grid(row=1, column=0, sticky="nsew", padx=(0, 2))
        log_scroll.grid(row=1, column=1, sticky="ns")
        self._text_views.append(self.main_log)

        footer = ttk.Frame(self.outer, style="App.TFrame")
        footer.grid(row=7, column=0, sticky="ew")
        footer.columnconfigure(0, weight=1)
        self.status_label = ttk.Label(footer, textvariable=self.status_var, style="Status.TLabel", wraplength=850, justify="left")
        self.status_label.grid(row=0, column=0, sticky="w")
        self.progress = ttk.Progressbar(footer, mode="indeterminate", length=150)
        self.progress.grid(row=0, column=1, sticky="e", padx=(10, 0))
        self.progress.grid_remove()
        ttk.Separator(self.outer, orient="horizontal").grid(row=8, column=0, sticky="ew", pady=(7, 5))
        ttk.Label(self.outer, textvariable=self.theme_var, style="Theme.TLabel", anchor="w").grid(row=9, column=0, sticky="ew")
        self.backup_combo.bind("<<ComboboxSelected>>", lambda _event: self._set_controls(not self._busy))
        self._populate_preview()
        self._log(f"디노 패치 관리자 v{MANAGER_VERSION} · 패치 v{PATCH_VERSION}")
        self._log("시작 위치의 상위 폴더에서 소스형 LilacAnime를 자동 확인합니다.")

    def _populate_preview(self) -> None:
        for item in self.change_tree.get_children():
            self.change_tree.delete(item)
        try:
            _, manifest = load_manifest(patch_source_root())
        except Exception as exc:
            self.change_tree.insert(
                "",
                "end",
                values=("확인 필요", "patches/patch03/manifest.json", "패치 구성을 읽지 못해 적용을 진행할 수 없습니다."),
            )
            self._log(f"패치 미리보기 생성 실패: {type(exc).__name__}")
            return
        for item in manifest.get("connections", []):
            self.change_tree.insert(
                "",
                "end",
                values=("공식 연결 수정", item.get("file", ""), item.get("description", "공식 UI와 통합 기능 연결")),
            )
        for item in manifest.get("runtimeModules", []):
            self.change_tree.insert(
                "",
                "end",
                values=("패치 모듈 추가", item.get("destination", ""), "통합 검색·작품 매칭 및 상세 공급원 연결"),
            )

    def _apply_palette(self, theme: str) -> None:
        self._theme = "light" if theme == "light" else "dark"
        c = PALETTES[self._theme]
        self.root.configure(background=c["bg"])
        s = self.style
        s.configure("App.TFrame", background=c["bg"])
        s.configure("Card.TFrame", background=c["surface"], relief="flat", borderwidth=0)
        s.configure("TLabel", background=c["surface"], foreground=c["fg"], font=("맑은 고딕", 9))
        s.configure("Title.TLabel", background=c["bg"], foreground=c["fg"], font=("맑은 고딕", 20, "bold"))
        s.configure("Subtitle.TLabel", background=c["bg"], foreground=c["muted"], font=("맑은 고딕", 9))
        s.configure("Brand.TLabel", background=c["accent"], foreground=c["accentText"], font=("Segoe UI", 16, "bold"), padding=(8, 7))
        s.configure("Badge.TLabel", background=c["surface2"], foreground=c["muted"], font=("맑은 고딕", 8, "bold"))
        s.configure("Section.TLabel", background=c["surface"], foreground=c["fg"], font=("맑은 고딕", 10, "bold"))
        s.configure("DialogSection.TLabel", background=c["bg"], foreground=c["fg"], font=("맑은 고딕", 13, "bold"))
        s.configure("Muted.TLabel", background=c["surface"], foreground=c["muted"], font=("맑은 고딕", 8))
        s.configure("StateValue.TLabel", background=c["surface"], foreground=c["fg"], font=("맑은 고딕", 15, "bold"))
        s.configure("Fact.TLabel", background=c["surface"], foreground=c["fg"], font=("맑은 고딕", 9, "bold"))
        s.configure("StateMark.TLabel", background=c["surface"], foreground=c["accent"])
        s.configure("Compat.TLabel", background=c["surface2"], foreground=c["muted"], font=("맑은 고딕", 8, "bold"))
        s.configure("Status.TLabel", background=c["bg"], foreground=c["fg"], font=("맑은 고딕", 9))
        s.configure("Theme.TLabel", background=c["bg"], foreground=c["muted"], font=("맑은 고딕", 8))
        s.configure("TLabelframe", background=c["surface"], foreground=c["fg"], bordercolor=c["border"], borderwidth=1, relief="groove")
        s.configure("TLabelframe.Label", background=c["surface"], foreground=c["fg"], font=("맑은 고딕", 9, "bold"))
        s.configure("TButton", background=c["surface2"], foreground=c["fg"], bordercolor=c["border"], borderwidth=1, padding=(9, 4), font=("맑은 고딕", 9), focuscolor=c["accent2"], relief="raised")
        s.map("TButton", background=[("disabled", c["surface"]), ("active", c["border"])], foreground=[("disabled", c["muted"])])
        s.configure("Primary.TButton", background=c["surface2"], foreground=c["fg"], bordercolor=c["border"], borderwidth=1, padding=(9, 4), font=("맑은 고딕", 9, "bold"), relief="raised")
        s.configure("Secondary.TButton", background=c["surface2"], foreground=c["fg"], bordercolor=c["border"], borderwidth=1, padding=(9, 4), relief="raised")
        s.configure("Danger.TButton", background=c["surface2"], foreground="#C75B67" if self._theme == "dark" else "#A52637", bordercolor=c["border"], borderwidth=1, padding=(9, 4), relief="raised")
        s.configure("Treeview", background=c["input"], fieldbackground=c["input"], foreground=c["fg"], bordercolor=c["border"], rowheight=24, font=("맑은 고딕", 9))
        s.configure("Treeview.Heading", background=c["surface2"], foreground=c["fg"], bordercolor=c["border"], font=("맑은 고딕", 9, "bold"))
        s.map("Treeview", background=[("selected", c["accent2"])], foreground=[("selected", c["accentText"])])
        s.map("Treeview.Heading", background=[("active", c["border"])])
        s.configure("TEntry", fieldbackground=c["input"], foreground=c["fg"], insertcolor=c["fg"], bordercolor=c["border"], padding=(8, 7))
        s.configure("Path.TEntry", fieldbackground=c["input"], foreground=c["muted"], padding=(8, 7))
        s.configure("TCombobox", fieldbackground=c["input"], background=c["surface2"], foreground=c["fg"], arrowcolor=c["fg"], bordercolor=c["border"], padding=(5, 4))
        s.map("TCombobox", fieldbackground=[("readonly", c["input"])], foreground=[("readonly", c["fg"])])
        s.configure("TProgressbar", background=c["accent2"], troughcolor=c["surface2"], bordercolor=c["surface2"])
        s.configure("TSeparator", background=c["border"])
        for text_view in self._text_views:
            try:
                text_view.configure(background=c["input"], foreground=c["fg"], insertbackground=c["fg"], selectbackground=c["accent2"], selectforeground=c["accentText"])
            except tk.TclError:
                pass

    def _on_focus(self, _event: tk.Event | None = None) -> None:
        self._refresh_theme()

    def _poll_theme(self) -> None:
        if not self._closing:
            self._refresh_theme()
            self.root.after(4000, self._poll_theme)

    def _refresh_theme(self) -> None:
        if self._current_root is None or not self._current_root.exists():
            theme, source = _system_theme()
            self.theme_var.set(f"LilacAnime 테마 확인 전 · {source} 사용")
            self._apply_palette(theme)
            return
        try:
            result = read_official_theme(self._current_root)
            self._apply_palette(result.get("theme", "dark"))
            if result.get("status") == "READ":
                self.theme_var.set(f"LilacAnime 테마 자동 연동 · {result.get('setting')}")
            else:
                notice = f"LilacAnime 테마 읽기 불가 · {result.get('source')} 적용"
                self.theme_var.set(notice)
                key = (str(result.get("reason")), str(result.get("theme")))
                if key != self._last_theme_log_key:
                    self._log(f"{notice} · {result.get('reason')}")
                    self._last_theme_log_key = key
        except Exception as exc:
            self.theme_var.set(f"LilacAnime 테마 확인 실패 · Windows/기본 테마 적용")
            self._log(f"LilacAnime 테마 확인 실패: {type(exc).__name__}")
            self._apply_palette(_system_theme()[0])

    def _begin_startup(self) -> None:
        def work(progress: Callable[[str], None]) -> dict[str, Any]:
            progress("실행 파일 상위 경로에서 LilacAnime 소스 폴더를 자동 탐색합니다.")
            return automatic_startup_check(progress=progress)
        self._start_job("startup", "원본 확인 및 필요한 경우 안전 적용을 진행합니다…", work)

    def _choose_root(self) -> None:
        chosen = filedialog.askdirectory(parent=self.root, title="공식 LilacAnime 소스 폴더 선택", mustexist=True)
        if not chosen:
            return
        self._current_root = Path(chosen)
        self.path_var.set(str(self._current_root))
        def work(progress: Callable[[str], None]) -> dict[str, Any]:
            progress("선택한 소스 폴더를 검사하고, 호환되면 백업 후 자동 적용합니다.")
            return automatic_startup_check(self._current_root, progress=progress)
        self._start_job("startup", "선택한 원본을 검사합니다…", work)

    def _root_or_message(self) -> Path | None:
        if self._current_root is not None:
            return self._current_root
        messagebox.showinfo("원본 폴더 선택", "LilacAnime 소스 폴더를 찾지 못했습니다. ‘폴더 선택’을 눌러 소스 폴더를 지정하세요.", parent=self.root)
        return None

    def _refresh_status(self) -> None:
        target = self._root_or_message()
        if target is not None:
            self._start_job("inspect", "현재 상태와 원본 파일 지문을 확인합니다…", lambda _progress: inspect_managed_target(target))

    def _apply(self) -> None:
        target = self._root_or_message()
        if target is None:
            return
        if not self._current_info or self._current_info.get("status") != "UNPATCHED":
            messagebox.showerror("패치를 적용할 수 없습니다", "상태 확인을 완료하고 ‘미적용 · 호환 확인’ 상태인지 확인하세요.", parent=self.root)
            return
        def work(progress: Callable[[str], None]) -> dict[str, Any]:
            operation = apply_patch_in_place(target, progress=progress)
            return {"operation": operation, "inspection": inspect_managed_target(target)}
        self._start_job("apply", "변경 대상 백업 후 원본에 패치를 적용합니다…", work)

    def _uninstall(self) -> None:
        if self._current_root is None:
            return
        if not messagebox.askyesno("패치 해제", "관리자가 기록한 변경 파일만 원본으로 복원합니다. 패치 후 파일이 달라졌다면 해제를 중단합니다. 계속할까요?", parent=self.root):
            return
        target = self._current_root
        self._start_job("uninstall", "패치 파일과 공식 연결부를 복원합니다…", lambda _progress: uninstall_patch(target))

    def _restore(self) -> None:
        index = self.backup_combo.current()
        if self._current_root is None or index < 0 or index >= len(self._backup_ids):
            return
        backup_id = self._backup_ids[index]
        if not messagebox.askyesno("백업 복원", "선택한 백업 시점과 현재 파일 지문이 모두 일치할 때만 복원합니다. 사용자 변경이 있으면 중단합니다. 진행할까요?", parent=self.root):
            return
        target = self._current_root
        self._start_job("restore", "선택한 백업의 파일 지문을 확인합니다…", lambda _progress: restore_backup(target, backup_id))

    def _check_updates(self) -> None:
        try:
            current = self._current_info.get("version") if self._current_info else None
            if not current:
                patch_root = patch_source_root()
                _, manifest = load_manifest(patch_root)
                current = manifest["officialVersion"]
        except Exception as exc:
            self.update_var.set(f"기준 버전을 확인하지 못했습니다 · {type(exc).__name__}")
            return
        self._start_job("update", "GitHub에서 공식 최신 버전을 확인합니다…", lambda _progress: check_official_update(current_version=str(current)))

    def _approve_update(self) -> None:
        if not self._update_info:
            return
        info = self._update_info
        if not messagebox.askyesno("공식 업데이트 승인", f"공식 {info.get('latestVersion')} 업데이트를 적용할 수 있는지 확인합니다. 새 버전의 검증 지문과 패치 계약이 없으면 안전을 위해 거부됩니다. 진행할까요?", parent=self.root):
            return
        result = approve_official_update(info)
        self.update_var.set(str(result.get("reason", result.get("status"))))
        self._log(f"공식 업데이트 승인 처리: {result.get('status')} · {result.get('reason')}")
        messagebox.showinfo("원본 변경 없음", f"{result.get('reason')}\n\n원본 파일은 변경하지 않았습니다.", parent=self.root)

    def _start_job(self, kind: str, initial: str, worker: Callable[[Callable[[str], None]], dict[str, Any]]) -> None:
        if self._busy:
            return
        self._busy = True
        self._set_controls(False)
        self.status_var.set(initial)
        self.progress.grid()
        self.progress.start(12)
        self._log(initial)
        def progress(message: str) -> None:
            self._events.put(("progress", message))
        def run() -> None:
            try:
                self._events.put(("done", (kind, worker(progress))))
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
                    self.progress.grid_remove()
                    self._handle_success(kind, result)
                elif event == "error":
                    kind, error = payload
                    self._busy = False
                    self.progress.stop()
                    self.progress.grid_remove()
                    self._handle_failure(kind, error)
        except queue.Empty:
            pass
        self._set_controls(not self._busy)
        self.root.after(100, self._poll_events)

    def _handle_success(self, kind: str, result: dict[str, Any]) -> None:
        if kind == "update":
            self._update_info = result
            status = result.get("status")
            if status == "UP_TO_DATE":
                self.update_var.set(f"최신 상태 · 현재 {result.get('currentVersion')} / 최신 {result.get('latestVersion')}")
                self.update_apply_button.configure(state="disabled")
            elif status == "UPDATE_AVAILABLE_UNSUPPORTED":
                self.update_var.set(f"새 공식 버전 {result.get('latestVersion')} 발견 · 호환성 검증 필요, 자동 적용 불가")
                self.update_apply_button.configure(state="normal")
            else:
                self.update_var.set(str(result.get("reason", "공식 업데이트를 확인하지 못했습니다.")))
                self.update_apply_button.configure(state="disabled")
            self.recent_var.set("공식 업데이트 조회 완료 · 원본 파일 변경 없음")
            self.status_var.set("공식 업데이트 조회가 끝났습니다. 원본 파일은 변경되지 않았습니다.")
            self._log(f"공식 업데이트 조회: {status} · {result.get('reason', result.get('latestVersion', ''))}")
            return
        if kind == "apply":
            operation = result.get("operation", {})
            result = result.get("inspection", {})
            self._log(f"백업 ID: {operation.get('backupId', '미생성')}")
            self._log(f"공식 원본 수정: {', '.join(operation.get('modifiedOfficialFiles', [])) or '없음'}")
            self._log(f"패치 모듈 추가: {', '.join(operation.get('addedPatchFiles', [])) or '없음'}")
        elif kind in {"uninstall", "restore"}:
            self._log(f"복원 완료: {result.get('status')} · {', '.join(result.get('files', []))}")
            if self._current_root:
                try:
                    result = inspect_managed_target(self._current_root)
                except Exception as exc:
                    self._log(f"복원 후 상태 확인 실패: {type(exc).__name__}")
        if kind in {"startup", "inspect", "apply", "uninstall", "restore"}:
            if result.get("path"):
                self._current_root = Path(result["path"])
                self.path_var.set(str(self._current_root))
            self._current_info = result
            status = result.get("status", "UNKNOWN")
            version = result.get("version") or result.get("officialVersion") or "확인 불가"
            self.official_var.set(f"v{version}" if str(version) != "확인 불가" else str(version))
            labels = {"APPLIED": "적용 완료", "UNPATCHED": "미적용", "NO_SOURCE": "원본 미발견", "CONFLICT": "변경 충돌", "PARTIAL_OR_UNKNOWN": "상태 미확인"}
            self.state_var.set(labels.get(status, status))
            self.compat_var.set("호환 확인" if status in {"APPLIED", "UNPATCHED"} else "추가 확인 필요")
            if status == "APPLIED":
                self.recent_var.set("패치 적용 상태와 전체 파일 지문 확인 완료")
                self.status_var.set("패치가 적용된 상태입니다. 공식 기능과 연결부를 유지하고 있습니다.")
            elif status == "UNPATCHED":
                self.recent_var.set("호환 가능한 미적용 원본 · 백업 후 적용 가능")
                self.status_var.set("공식 기준과 일치합니다. ‘패치 적용’을 누르면 대상 파일 백업 후 적용합니다.")
            elif status == "NO_SOURCE":
                self.official_var.set("원본 미발견")
                self.recent_var.set("소스 폴더 미발견 · 원본 파일 변경 없음")
                self.status_var.set(str(result.get("reason", "공식 소스 폴더를 선택하세요.")))
            else:
                reason = str(result.get("reason", "상태를 안전하게 확인할 수 없습니다."))
                self.recent_var.set("호환성 또는 파일 충돌 · 변경 중단")
                self.status_var.set(reason)
                self._log(reason)
            self._reload_backups()
            self._refresh_theme()
            self._set_controls(not self._busy)
            if kind == "startup" and status != "NO_SOURCE":
                self.root.after(350, self._check_updates)

    def _handle_failure(self, kind: str, error: str) -> None:
        label = {"startup": "원본 호환성 또는 자동 적용", "apply": "패치 적용", "inspect": "상태 확인", "uninstall": "패치 해제", "restore": "백업 복원", "update": "공식 업데이트 조회"}.get(kind, "작업")
        self.recent_var.set(f"{label} 실패 · 상세 원인은 작업 기록에 표시")
        self.status_var.set(error.splitlines()[0] if error else f"{label} 실패")
        self._log(f"{label} 실패:\n{error}")
        if kind == "update":
            self.update_var.set(error.splitlines()[0] if error else "공식 업데이트 조회 실패")
            self.status_var.set("공식 업데이트 조회 실패 · 패치 상태와 원본 파일은 변경되지 않았습니다.")
        else:
            messagebox.showerror(f"{label}을 완료하지 못했습니다", f"{error}\n\n호환성 검사 실패라면 원본은 변경하지 않았습니다. 적용 중 실패라면 작업 기록의 자동 복구 결과를 확인하세요.", parent=self.root)

    def _reload_backups(self) -> None:
        if self._current_root is None:
            self._backups, self._backup_ids = [], []
            self.backup_combo.configure(values=())
            self.backup_var.set("")
            return
        try:
            self._backups = list_backups(self._current_root)
            self._backup_ids = [str(item.get("id", "")) for item in self._backups]
            values = [f"{item.get('id')} · {'복원 가능' if item.get('restorable') else '복원 완료'}" for item in self._backups]
            self.backup_combo.configure(values=values)
            if values:
                self.backup_combo.current(0)
                self.backup_var.set(values[0])
            else:
                self.backup_var.set("")
        except Exception as exc:
            self._log(f"백업 목록을 읽지 못했습니다: {type(exc).__name__}")

    def _show_history(self) -> None:
        if self._current_root is None:
            messagebox.showinfo("작업 기록", "원본 폴더를 선택하면 해당 관리자의 기록을 볼 수 있습니다.", parent=self.root)
            return
        try:
            records = read_history(self._current_root)
        except Exception as exc:
            messagebox.showerror("작업 기록을 읽을 수 없습니다", _format_exception(exc), parent=self.root)
            return
        window = tk.Toplevel(self.root)
        window.title("디노 패치 작업 기록")
        window.geometry("720x460")
        window.transient(self.root)
        frame = ttk.Frame(window, style="Card.TFrame", padding=14)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(1, weight=1)
        ttk.Label(frame, text="작업 기록", style="Section.TLabel").grid(row=0, column=0, sticky="w", pady=(0, 8))
        log = tk.Text(frame, wrap="none", relief="flat", borderwidth=0, padx=9, pady=8, font=("Consolas", 9))
        scroll = ttk.Scrollbar(frame, orient="vertical", command=log.yview)
        log.configure(yscrollcommand=scroll.set)
        log.grid(row=1, column=0, sticky="nsew")
        scroll.grid(row=1, column=1, sticky="ns")
        log.insert("end", "\n".join(json.dumps(item, ensure_ascii=False, indent=2) for item in records) or "기록이 없습니다.")
        c = PALETTES[self._theme]
        log.configure(state="disabled", background=c["input"], foreground=c["fg"])
        self._text_views.append(log)

    def _show_diagnostics(self) -> None:
        if self._diagnostics_window is not None and self._diagnostics_window.winfo_exists():
            self._diagnostics_window.deiconify()
            self._diagnostics_window.lift()
            return
        window = tk.Toplevel(self.root)
        self._diagnostics_window = window
        window.title("디노 패치 진단 기록")
        window.geometry("700x420")
        window.minsize(520, 300)
        window.transient(self.root)
        window.protocol("WM_DELETE_WINDOW", lambda: (setattr(self, "_diagnostics_window", None), window.destroy()))
        frame = ttk.Frame(window, style="App.TFrame", padding=16)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(1, weight=1)
        ttk.Label(frame, text="상세 진단", style="DialogSection.TLabel").grid(row=0, column=0, sticky="w", pady=(0, 9))
        log = tk.Text(frame, wrap="word", relief="flat", borderwidth=0, padx=10, pady=9, font=("Segoe UI", 9), state="disabled")
        scroll = ttk.Scrollbar(frame, orient="vertical", command=log.yview)
        log.configure(yscrollcommand=scroll.set)
        log.grid(row=1, column=0, sticky="nsew")
        scroll.grid(row=1, column=1, sticky="ns")
        self._text_views.append(log)
        self._set_text(log, "\n".join(self._log_messages) or "진단 기록이 없습니다.")
        ttk.Button(frame, text="닫기", style="Secondary.TButton", command=window.destroy).grid(row=2, column=0, sticky="e", pady=(10, 0))
        window.bind("<Destroy>", lambda event: setattr(self, "_diagnostics_window", None) if event.widget is window else None)

    @staticmethod
    def _set_text(widget: tk.Text, value: str) -> None:
        widget.configure(state="normal")
        widget.delete("1.0", "end")
        widget.insert("end", value)
        widget.see("end")
        widget.configure(state="disabled")

    def _set_controls(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        for button in (self.choose_button, self.refresh_button, self.history_button, self.diagnostics_button, self.update_button):
            button.configure(state=state)
        info = self._current_info or {}
        self.apply_button.configure(state="normal" if enabled and info.get("status") == "UNPATCHED" else "disabled")
        self.uninstall_button.configure(state="normal" if enabled and info.get("status") == "APPLIED" else "disabled")
        index = self.backup_combo.current()
        can_restore = index >= 0 and index < len(self._backups) and bool(self._backups[index].get("restorable"))
        self.restore_button.configure(state="normal" if enabled and can_restore else "disabled")
        self.backup_combo.configure(state="readonly" if enabled else "disabled")
        can_approve = bool(enabled and self._update_info and self._update_info.get("status") == "UPDATE_AVAILABLE_UNSUPPORTED")
        self.update_apply_button.configure(state="normal" if can_approve else "disabled")

    def _log(self, message: str) -> None:
        if self._closing:
            return
        normalized = message.rstrip()
        self._log_messages.append(normalized)
        if len(self._log_messages) > 1200:
            del self._log_messages[:-1200]
        main_log = getattr(self, "main_log", None)
        if main_log is not None:
            try:
                if main_log.winfo_exists():
                    self._set_text(main_log, "\n".join(self._log_messages))
            except tk.TclError:
                pass
        window = self._diagnostics_window
        if window is not None and window.winfo_exists():
            for widget in self._text_views:
                try:
                    if widget.winfo_exists() and str(widget.winfo_toplevel()) == str(window):
                        self._set_text(widget, "\n".join(self._log_messages))
                except tk.TclError:
                    continue

    def _on_close(self) -> None:
        if self._busy:
            messagebox.showinfo("작업 진행 중", "현재 파일 작업이 끝날 때까지 창을 열어 두세요.", parent=self.root)
            return
        self._closing = True
        self.root.destroy()


def main() -> None:
    checked_root = manager_home() if IS_FROZEN else manager_home().parents[1]
    assert_project_root(checked_root)
    dpi_scale, tk_scale = _enable_dpi_awareness()
    app = tk.Tk()
    try:
        app.tk.call("tk", "scaling", tk_scale)
    except tk.TclError:
        pass
    DinoPatchManager(app, dpi_scale=dpi_scale)
    app.mainloop()


if __name__ == "__main__":
    main()
