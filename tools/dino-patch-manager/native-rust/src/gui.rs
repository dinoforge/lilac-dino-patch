//! Native Rust desktop manager styled after the existing Electron DinoPatch UI.
//! All operations are backed by the same independently checked Rust transactions.
use crate::{diagnostics, transaction, Result};
use eframe::egui::{
    self, Align, Align2, Button, Color32, CornerRadius, FontFamily, FontId, Frame, Layout, Margin,
    RichText, Stroke, Ui, Vec2,
};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant, SystemTime};

const PAGE: u32 = 0x111820;
const CARD: u32 = 0x172029;
const BORDER: u32 = 0x3B4C5B;
const ACCENT: u32 = 0x91C9B6;
const BUTTON: u32 = 0x9AD6B7;
const TEXT: u32 = 0xE8EDF2;
// Readable secondary text against dark panels, including small status labels.
const MUTED: u32 = 0xCAD6DF;
const SURFACE: u32 = 0x222F39;
const SURFACE_DARK: u32 = 0x19252E;

const TEXT_ZOOM: [f32; 3] = [1.0, 1.2, 1.4];
const TEXT_ZOOM_KEY: &str = "dino.manager.ui.textZoom.v1";
const ADVANCED_PANEL_KEY: &str = "dino.manager.ui.advancedOpen.v1";

fn rgb(value: u32) -> Color32 {
    Color32::from_rgb((value >> 16) as u8, (value >> 8) as u8, value as u8)
}

#[derive(Clone, Copy)]
enum ButtonTone {
    Primary,
    Secondary,
    Danger,
}

fn action(ui: &mut Ui, label: &str, tone: ButtonTone, enabled: bool) -> bool {
    let (fill, ink, edge) = match tone {
        ButtonTone::Primary => (BUTTON, 0x0D1A16, BUTTON),
        ButtonTone::Secondary => (SURFACE, TEXT, BORDER),
        ButtonTone::Danger => (0x332528, 0xF1CBCB, 0x654147),
    };
    let response = ui.add_enabled(
        enabled,
        Button::new(RichText::new(label).size(13.0).strong().color(rgb(ink)))
            .fill(rgb(fill))
            .stroke(Stroke::new(1.0, rgb(edge)))
            .corner_radius(CornerRadius::same(9))
            .min_size(Vec2::new(0.0, 36.0)),
    );
    // Disabled actions need a visible explanation, not just a dim button.
    if enabled {
        response.clicked()
    } else {
        response.on_disabled_hover_text(
            "현재 상태에서는 실행할 수 없습니다. 설치 원본과 패치 상태를 먼저 확인하세요."
        ).clicked()
    }
}

fn card(ui: &mut Ui, body: impl FnOnce(&mut Ui)) {
    Frame::new()
        .fill(rgb(CARD))
        .stroke(Stroke::new(1.0, rgb(BORDER)))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::symmetric(17, 14))
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            body(ui);
        });
}

fn label(ui: &mut Ui, text: impl Into<String>) {
    ui.label(RichText::new(text).size(12.5).color(rgb(MUTED)));
}

fn heading(ui: &mut Ui, text: &str) {
    ui.label(RichText::new(text).size(17.0).strong().color(rgb(TEXT)));
}

#[derive(Clone, Copy)]
enum StatusTone {
    Neutral,
    Good,
    Warning,
    Bad,
}

fn status_style(tone: StatusTone) -> (u32, u32) {
    match tone {
        StatusTone::Neutral => (0x28343C, MUTED),
        StatusTone::Good => (0x1E392B, 0xA6E0BB),
        StatusTone::Warning => (0x40351E, 0xEFCF88),
        StatusTone::Bad => (0x43292B, 0xF0A5A5),
    }
}

fn pill(ui: &mut Ui, text: &str, tone: StatusTone) {
    let (fill, color) = status_style(tone);
    Frame::new()
        .fill(rgb(fill))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::symmetric(11, 6))
        .show(ui, |ui| {
            ui.label(RichText::new(text).size(12.0).strong().color(rgb(color)));
        });
}

fn badge_for(status: &transaction::Status) -> (&'static str, StatusTone) {
    match status.status.as_str() {
        "APPLIED" | "ALREADY_APPLIED" => ("적용됨 · 호환", StatusTone::Good),
        "UNPATCHED" if status.manually_uninstalled => ("수동 해제 · 미적용", StatusTone::Warning),
        "UNPATCHED" | "ALREADY_UNPATCHED" => ("호환 · 미적용", StatusTone::Warning),
        "NO_SOURCE" => ("원본 미발견", StatusTone::Neutral),
        "SOURCE_FOUND" => ("원본 확인", StatusTone::Neutral),
        "CONFLICT" => ("파일 충돌", StatusTone::Bad),
        "PARTIAL_OR_UNKNOWN" => ("상태 확인 필요", StatusTone::Bad),
        "UNSUPPORTED" => ("소스 비호환", StatusTone::Bad),
        _ => ("검사 대기", StatusTone::Neutral),
    }
}

fn safety_for(status: &transaction::Status) -> Option<(&'static str, &'static str)> {
    match status.status.as_str() {
        "CONFLICT" => Some((
            "사용자 수정 파일을 보호했습니다",
            "기록과 일치하지 않는 원본에는 패치나 복원을 적용하지 않습니다.",
        )),
        "PARTIAL_OR_UNKNOWN" => Some((
            "패치 상태를 확인할 수 없습니다",
            "원본과 백업을 유지한 채 변경을 중단했습니다. 아래 사유와 작업 로그를 확인하세요.",
        )),
        "UNSUPPORTED" => Some((
            "호환되지 않는 공식 원본입니다",
            "원본 지문 또는 연결 구조가 예상과 달라 적용을 차단했습니다.",
        )),
        "NO_SOURCE" => Some((
            "원본 폴더를 선택하세요",
            "기존 LilacAnime.exe가 설치된 폴더를 선택해야 합니다. 원본을 별도로 배포하지 않습니다.",
        )),
        _ => None,
    }
}

// Short, actionable guidance for the status-first screen. This is advisory
// text only: all file-mutating operations still use checked Rust transactions.
fn next_step(status: &transaction::Status, busy: bool) -> &'static str {
    if busy {
        return "다음 단계 · 작업 결과를 확인한 뒤 필요한 작업을 선택하세요.";
    }
    match status.status.as_str() {
        "NO_SOURCE" => "다음 단계 · 공식 LilacAnime 설치 폴더를 선택하세요.",
        "SOURCE_FOUND" => "다음 단계 · 원본 호환성 및 현재 패치 상태를 검사하세요.",
        "UNPATCHED" | "ALREADY_UNPATCHED" if status.manually_uninstalled =>
            "다음 단계 · 수동 해제 상태를 유지합니다. 재적용은 직접 선택할 수 있습니다.",
        "UNPATCHED" | "ALREADY_UNPATCHED" =>
            "다음 단계 · 준비가 되면 안전한 패치 적용을 선택하세요.",
        "APPLIED" | "ALREADY_APPLIED" =>
            "다음 단계 · 필요 시 원본 상태를 다시 검사하거나 고급 관리에서 원복하세요.",
        "CONFLICT" | "PARTIAL_OR_UNKNOWN" | "UNSUPPORTED" =>
            "다음 단계 · 적용을 중단하고 원본과 백업을 보존한 채 진단을 확인하세요.",
        _ => "다음 단계 · 원본 상태를 먼저 확인하세요.",
    }
}

struct ResultMessage {
    root: String,
    generation: u64,
    name: String,
    operation_error: Option<String>,
    status: Option<transaction::Status>,
    status_error: Option<String>,
    backups: std::result::Result<Vec<BackupItem>, String>,
}

enum WorkerMessage {
    Progress {
        root: String,
        generation: u64,
        text: &'static str,
    },
    Completed(ResultMessage),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BackupItem {
    id: String,
    version: String,
    created_at: String,
    restorable: bool,
}

fn parse_backup_items(value: &serde_json::Value) -> std::result::Result<Vec<BackupItem>, String> {
    let items = value.get("items").and_then(serde_json::Value::as_array)
        .ok_or_else(|| "백업 목록 응답에 items 배열이 없습니다.".to_owned())?;
    items.iter().enumerate().map(|(index, item)| {
        let required_text = |key: &str| item.get(key).and_then(serde_json::Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("백업 목록 {index}번 항목의 {key} 값이 올바르지 않습니다."));
        let restorable = item.get("restorable").and_then(serde_json::Value::as_bool)
            .ok_or_else(|| format!("백업 목록 {index}번 항목의 복원 가능 상태가 없습니다."))?;
        Ok(BackupItem {
            id: required_text("id")?,
            version: required_text("version")?,
            created_at: required_text("createdAt")?,
            restorable,
        })
    }).collect()
}

fn operation_stage(kind: &str) -> &'static str {
    match kind {
        "원본 다시 확인" => "원본 구조와 현재 파일 상태 확인 중",
        "자동 검사" | "디노 패치 수동 적용" => "원본·백업 검증 및 패치 적용 작업 중",
        "디노 패치 해제" | "백업 복원" => "원본·백업 SHA-256 검증 및 복원 작업 중",
        "복구 상태 검사" | "복구 기록 정리" => "복구 기록·원본·백업 검증 중",
        "백업 목록 새로 고침" => "현재 버전 백업 목록 읽는 중",
        _ => "작업 진행 중",
    }
}

fn completed_operation_state(
    error: Option<&str>,
    status: Option<&transaction::Status>,
) -> &'static str {
    if error.is_some() {
        return "오류 발생 · 진단 로그를 확인하세요";
    }
    match status.map(|value| value.status.as_str()) {
        Some("CONFLICT") => "확인 완료 · 파일 충돌 감지",
        Some("PARTIAL_OR_UNKNOWN") => "확인 완료 · 상태 재검증 필요",
        Some("UNSUPPORTED") => "검사 완료 · 호환되지 않는 소스",
        Some("APPLIED") | Some("ALREADY_APPLIED") => "완료 · 패치 상태 확인",
        Some("UNPATCHED") | Some("ALREADY_UNPATCHED") => "완료 · 원본 상태 확인",
        Some("NO_SOURCE") => "확인 완료 · 설치 원본 미발견",
        _ => "작업 완료 · 결과 상태 확인",
    }
}

struct DinoUi {
    root: String,
    status: transaction::Status,
    auto_enabled: bool,
    busy: bool,
    operation_state: String,
    task_generation: u64,
    activity: Vec<String>,
    response: Option<Receiver<WorkerMessage>>,
    last_archive_change: Option<(u64, Option<SystemTime>)>,
    last_monitor: Instant,
    backup_items: Vec<BackupItem>,
    backup_list_root: Option<String>,
    backup_error: Option<String>,
    selected_backup_id: Option<String>,
    show_log: bool,
    show_path_editor: bool,
    path_draft: String,
    show_advanced: bool,
    text_zoom_index: usize,
    pending_action: Option<&'static str>,
}

fn detect_installed_root() -> String {
    if let Some(value) = std::env::var_os("DINO_ORIGINAL_ROOT") {
        if !value.is_empty() {
            return PathBuf::from(value).to_string_lossy().to_string();
        }
    }
    let mut guesses = Vec::new();
    if let Some(value) = std::env::var_os("ProgramFiles") {
        guesses.push(PathBuf::from(value).join("LilacAnime"));
    }
    if let Some(value) = std::env::var_os("LOCALAPPDATA") {
        guesses.push(PathBuf::from(value).join("Programs").join("LilacAnime"));
    }
    guesses.push(PathBuf::from(r"D:\LilacAnime"));
    for guess in guesses {
        if transaction::installed_root(&guess).is_ok() {
            return guess.to_string_lossy().to_string();
        }
    }
    String::new()
}

impl Default for DinoUi {
    fn default() -> Self {
        let root = detect_installed_root();
        let path_draft = root.clone();
        let has_root = !root.is_empty();
        diagnostics::write("Electron-style native Rust management UI initialized");
        Self {
            root,
            status: if has_root {
                transaction::Status::new("SOURCE_FOUND", "", "공식 원본 구조를 확인하고 있습니다.")
            } else {
                transaction::Status::new("NO_SOURCE", "", "원본 폴더를 선택해 주세요.")
            },
            auto_enabled: true,
            busy: false,
            operation_state: "대기 중".into(),
            task_generation: 0,
            activity: vec!["DinoPatch Rust 관리자가 시작됐습니다.".into()],
            response: None,
            last_archive_change: None,
            last_monitor: Instant::now() - Duration::from_secs(5),
            backup_items: Vec::new(),
            backup_list_root: None,
            backup_error: None,
            selected_backup_id: None,
            show_log: false,
            show_path_editor: false,
            path_draft,
            show_advanced: false,
            text_zoom_index: 0,
            pending_action: None,
        }
    }
}

impl DinoUi {
    // Save only cosmetic preferences. Never persist the installed root,
    // backup identifiers, auto-patch policy, or transaction status.
    fn with_storage(storage: Option<&dyn eframe::Storage>) -> Self {
        let mut app = Self::default();
        if let Some(storage) = storage {
            app.text_zoom_index = storage.get_string(TEXT_ZOOM_KEY)
                .and_then(|raw| raw.parse::<usize>().ok())
                .filter(|index| *index < TEXT_ZOOM.len())
                .unwrap_or(0);
            app.show_advanced = storage.get_string(ADVANCED_PANEL_KEY)
                .is_some_and(|raw| raw == "true");
        }
        app
    }

    // A visible, keyboard-accessible control. Zoom changes the entire egui
    // layout, including explicitly sized Korean labels and diagnostic logs.
    // No font files or settings are written to the user's app profile.
    fn readability_controls(&mut self, ui: &mut Ui, ctx: &egui::Context) {
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new("글자 크기")
                .size(13.0).strong().color(rgb(TEXT)));
            for (index, title) in ["기본 100%", "크게 120%", "매우 크게 140%"]
                .iter().enumerate()
            {
                if ui.selectable_label(self.text_zoom_index == index, *title)
                    .on_hover_text("관리자 전체의 글자와 버튼 크기를 조절합니다.")
                    .clicked()
                {
                    self.text_zoom_index = index;
                    ctx.set_zoom_factor(TEXT_ZOOM[index]);
                }
            }
        });
        label(ui, "글자가 흐리면 크기를 높여 주세요. 글자 크기와 창 크기는 다음 실행에도 유지됩니다.");
    }

    fn record(&mut self, text: impl Into<String>) {
        let message = text.into();
        diagnostics::write(&message);
        let time = chrono::Local::now().format("%H:%M:%S");
        self.activity.push(format!("[{time}] {message}"));
        if self.activity.len() > 250 {
            self.activity.drain(..self.activity.len() - 250);
        }
    }

    fn clear_backup_list(&mut self) {
        self.backup_items.clear();
        self.backup_list_root = None;
        self.backup_error = None;
        self.selected_backup_id = None;
    }

    fn set_root(&mut self, root: String) {
        if self.root != root {
            self.root = root;
            self.task_generation = self.task_generation.wrapping_add(1);
            self.clear_backup_list();
            self.operation_state = "새 설치 경로에서 원본과 백업을 확인해야 합니다.".into();
        }
    }

    fn selected_backup(&self) -> Option<&BackupItem> {
        if self.backup_list_root.as_deref() != Some(self.root.trim()) {
            return None;
        }
        let id = self.selected_backup_id.as_deref()?;
        self.backup_items.iter().find(|item| item.id == id)
    }

    fn task_is_current(&self, root: &str, generation: u64) -> bool {
        self.task_generation == generation && self.root.trim() == root
    }

    fn can_restore_selected_backup(&self) -> bool {
        !self.busy
            && matches!(self.status.status.as_str(), "APPLIED" | "ALREADY_APPLIED")
            && self.selected_backup().is_some_and(|item| item.restorable)
    }

    fn update_backup_list(
        &mut self,
        root: &str,
        result: std::result::Result<Vec<BackupItem>, String>,
    ) {
        if root != self.root.trim() {
            return;
        }
        self.backup_list_root = Some(root.to_owned());
        match result {
            Ok(items) => {
                if self.selected_backup_id.as_ref().is_some_and(|selected| {
                    !items.iter().any(|item| &item.id == selected)
                }) {
                    self.selected_backup_id = None;
                }
                self.backup_items = items;
                self.backup_error = None;
            }
            Err(error) => {
                self.backup_items.clear();
                self.selected_backup_id = None;
                self.backup_error = Some(error.clone());
                self.record(format!("백업 목록 조회 실패: {error}"));
                self.show_log = true;
                self.show_advanced = true;
            }
        }
    }

    fn enqueue(&mut self, kind: &'static str) {
        if self.busy || self.root.trim().is_empty() {
            return;
        }
        if kind == "백업 복원" && !self.can_restore_selected_backup() {
            self.record("복원 가능한 백업이 선택되지 않아 작업을 시작하지 않았습니다.");
            self.operation_state = "안전 중단 · 복원 가능한 백업을 선택하세요".into();
            self.show_log = true;
            self.show_advanced = true;
            return;
        }

        self.busy = true;
        self.operation_state = "작업 요청 접수".into();
        self.record(format!("{kind} 작업 요청 접수"));
        self.task_generation = self.task_generation.wrapping_add(1);
        let generation = self.task_generation;
        let root_label = self.root.trim().to_owned();
        let root = PathBuf::from(&root_label);
        let backup_id = if kind == "백업 복원" {
            self.selected_backup_id.clone()
        } else {
            None
        };
        if kind != "백업 목록 새로 고침" {
            self.selected_backup_id = None;
        }
        let (sender, receiver) = mpsc::channel();
        self.response = Some(receiver);
        let spawned = std::thread::Builder::new()
            .name("dino-native-gui-task".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let _ = sender.send(WorkerMessage::Progress {
                    root: root_label.clone(),
                    generation,
                    text: operation_stage(kind),
                });
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    match kind {
                        "원본 다시 확인" | "백업 목록 새로 고침" => Ok(()),
                        "자동 검사" => transaction::apply(&root, false).map(|_| ()),
                        "디노 패치 수동 적용" => transaction::apply(&root, true).map(|_| ()),
                        "디노 패치 해제" => transaction::uninstall(&root).map(|_| ()),
                        "복구 상태 검사" => transaction::review_recovery(&root).map(|_| ()),
                        "복구 기록 정리" => transaction::recover(&root).map(|_| ()),
                        "백업 복원" => match backup_id.as_deref() {
                            Some(id) => transaction::restore(&root, id).map(|_| ()),
                            None => Err(crate::fail("복원할 백업 ID가 선택되지 않았습니다.")),
                        },
                        _ => Err(crate::fail("지원하지 않는 관리자 작업입니다.")),
                    }
                }));
                let operation_error = match outcome {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error.to_string()),
                    Err(_) => Some(
                        "Rust 작업 내부 오류가 발생했습니다. 원본과 백업을 유지하고 진단 로그를 확인하세요.".into(),
                    ),
                };
                let _ = sender.send(WorkerMessage::Progress {
                    root: root_label.clone(),
                    generation,
                    text: "작업 결과와 현재 파일 상태 확인 중",
                });
                let (status, status_error) = match std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| transaction::inspect(&root)),
                ) {
                    Ok(status) => (Some(status), None),
                    Err(_) => (
                        None,
                        Some("작업 결과 뒤 현재 파일 상태를 확인하는 중 내부 오류가 발생했습니다.".into()),
                    ),
                };
                let backups = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    transaction::backups(&root)
                })) {
                    Ok(Ok(value)) => parse_backup_items(&value),
                    Ok(Err(error)) => Err(error.to_string()),
                    Err(_) => Err("백업 목록 조회 중 내부 오류가 발생했습니다.".into()),
                };
                let _ = sender.send(WorkerMessage::Completed(ResultMessage {
                    root: root_label,
                    generation,
                    name: kind.to_string(),
                    operation_error,
                    status,
                    status_error,
                    backups,
                }));
            });
        if let Err(error) = spawned {
            self.record(format!("작업 스레드를 실행할 수 없습니다: {error}"));
            self.busy = false;
            self.operation_state = "오류 발생 · 작업 스레드를 시작하지 못했습니다".into();
            self.response = None;
            self.show_log = true;
            self.show_advanced = true;
        }
    }

    fn poll_result(&mut self) {
        let mut events = Vec::new();
        let mut disconnected = false;
        if let Some(receiver) = self.response.as_ref() {
            loop {
                match receiver.try_recv() {
                    Ok(event) => events.push(event),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }
        for event in events {
            match event {
                WorkerMessage::Progress { root, generation, text }
                    if self.task_is_current(&root, generation) => {
                        self.operation_state = text.into();
                    }
                WorkerMessage::Progress { .. } => {}
                WorkerMessage::Completed(event)
                    if self.task_is_current(&event.root, event.generation) => {
                        self.busy = false;
                        self.response = None;
                        if let Some(status) = event.status {
                            self.status = status;
                        } else {
                            self.status = transaction::Status::new(
                                "PARTIAL_OR_UNKNOWN", &self.status.version,
                                "작업은 종료됐지만 현재 파일 상태를 다시 확인하지 못했습니다. 진단 로그를 확인하세요."
                            );
                        }
                        self.update_backup_list(&event.root, event.backups);
                        if let Some(error) = event.operation_error {
                            self.record(format!("{} 실패: {error}", event.name));
                            self.operation_state = completed_operation_state(
                                Some(&error), Some(&self.status)
                            ).into();
                            self.show_log = true;
                            self.show_advanced = true;
                        } else if let Some(error) = event.status_error {
                            self.record(format!("{} 후 상태 재검사 실패: {error}", event.name));
                            self.operation_state = completed_operation_state(
                                Some(&error), Some(&self.status)
                            ).into();
                            self.show_log = true;
                            self.show_advanced = true;
                        } else {
                            self.record(format!("{} · {} · {}", event.name,
                                self.status.status, self.status.reason));
                            self.operation_state = completed_operation_state(
                                None, Some(&self.status)
                            ).into();
                        }
                    }
                WorkerMessage::Completed(_) => {}
            }
        }
        if disconnected && self.busy {
            let message = "작업 스레드가 응답 없이 종료됐습니다. native-manager.log에서 오류를 확인하세요.";
            self.record(message);
            self.status = transaction::Status::new(
                "PARTIAL_OR_UNKNOWN", &self.status.version, message
            );
            self.operation_state = "오류 발생 · 작업 응답이 끊겼습니다".into();
            self.busy = false;
            self.response = None;
            self.show_log = true;
            self.show_advanced = true;
        }
    }

    fn monitor(&mut self) {
        if !self.auto_enabled || self.busy || self.root.is_empty() {
            return;
        }
        if self.last_monitor.elapsed() < Duration::from_secs(4) {
            return;
        }
        self.last_monitor = Instant::now();
        let archive = PathBuf::from(&self.root).join("resources").join("app.asar");
        let current = std::fs::symlink_metadata(&archive)
            .ok()
            .filter(|meta| meta.is_file() && !meta.file_type().is_symlink())
            .map(|meta| (meta.len(), meta.modified().ok()));
        if current.is_none() {
            // Do not try to repair directory-valued app.asar or loop forever.
            if self.last_archive_change.take().is_some()
                || self.status.status == "SOURCE_FOUND" {
                self.status = transaction::Status::new(
                    "PARTIAL_OR_UNKNOWN", &self.status.version,
                    "app.asar가 일반 파일이 아니거나 존재하지 않아 자동 적용을 중단했습니다."
                );
                self.record("ASAR 구조가 불안정해 자동 적용을 보류합니다.");
            }
            return;
        }
        let changed = self.last_archive_change.as_ref() != current.as_ref();
        self.last_archive_change = current;
        if changed {
            self.enqueue("자동 검사");
        }
    }

    fn choose_folder(&mut self) {
        if self.busy {
            return;
        }
        if let Some(path) = rfd::FileDialog::new()
            .set_title("공식 LilacAnime 설치 폴더 선택")
            .pick_folder()
        {
            let root = if path.file_name().is_some_and(|x| x == "resources")
                && path.join("app.asar").exists() {
                path.parent().map(PathBuf::from).unwrap_or(path)
            } else {
                path
            };
            self.set_root(root.to_string_lossy().to_string());
            self.path_draft = self.root.clone();
            self.last_archive_change = None;
            self.last_monitor = Instant::now();
            self.status = transaction::Status::new(
                "SOURCE_FOUND", "", "선택한 설치 폴더를 검사할 수 있습니다."
            );
            self.record(format!("원본 설치 폴더 선택: {}", self.root));
            self.enqueue("원본 다시 확인");
        }
    }

    fn ask(&mut self, operation: &'static str) {
        if !self.busy {
            self.pending_action = Some(operation);
        }
    }

    // The first screen answers three questions without requiring a user to
    // read a long transaction log: was the original found, is it safe to
    // modify, and has the patch already been applied?
    fn overview_card(&mut self, ui: &mut Ui) {
        let status = self.status.status.clone();
        let applied = matches!(status.as_str(), "APPLIED" | "ALREADY_APPLIED");
        let compatible = matches!(status.as_str(),
            "APPLIED" | "ALREADY_APPLIED" | "UNPATCHED" | "ALREADY_UNPATCHED");
        let has_root = !self.root.trim().is_empty();
        let blocked = matches!(status.as_str(), "CONFLICT" | "UNSUPPORTED" | "PARTIAL_OR_UNKNOWN");
        let (headline, details, tone) = if self.busy {
            ("안전한 패치 작업을 진행하고 있습니다",
             "호환성과 백업 상태를 확인하고 있어요. 완료될 때까지 다른 작업은 시작하지 않습니다.",
             StatusTone::Neutral)
        } else if applied {
            ("패치가 적용되어 있습니다",
             "설치된 LilacAnime에 DinoPatch가 적용된 상태입니다. 필요할 때 다시 검사할 수 있습니다.",
             StatusTone::Good)
        } else if compatible {
            ("원본 확인 완료 · 패치 적용 가능",
             "공식 원본의 호환성이 확인됐습니다. 적용 전 백업과 원본 지문을 다시 검사합니다.",
             StatusTone::Warning)
        } else if blocked {
            ("안전을 위해 작업이 중단됐습니다",
             "현재 원본·백업 상태가 확인되지 않았습니다. 추가 변경을 중단하고 진단 기록을 확인하세요.",
             StatusTone::Bad)
        } else if !has_root || status == "NO_SOURCE" {
            ("먼저 LilacAnime 설치 폴더를 선택하세요",
             "설치된 공식 LilacAnime만 지원하며 원본 프로그램은 DinoPatch에 포함되지 않습니다.",
             StatusTone::Neutral)
        } else {
            ("패치 적용 전 원본 확인이 필요합니다",
             "원본 구조와 호환성을 확인한 후 패치 적용 여부를 판단합니다.",
             StatusTone::Neutral)
        };
        let (badge_fill, badge_ink) = status_style(tone);
        Frame::new()
            .fill(rgb(SURFACE_DARK))
            .stroke(Stroke::new(1.0, rgb(if blocked { 0x725054 } else { 0x41695F })))
            .corner_radius(CornerRadius::same(16))
            .inner_margin(Margin::symmetric(20, 19))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new("현재 패치 상태")
                        .size(12.0).strong().color(rgb(ACCENT)));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let (title, status_tone) = badge_for(&self.status);
                        pill(ui, title, status_tone);
                    });
                });
                ui.add_space(7.0);
                ui.label(RichText::new(headline).size(21.0).strong().color(rgb(TEXT)));
                ui.add_space(3.0);
                ui.label(RichText::new(details).size(13.0).color(rgb(MUTED)));
                ui.add_space(7.0);
                ui.label(RichText::new(next_step(&self.status, self.busy))
                    .size(13.0).strong().color(rgb(ACCENT)));
                ui.add_space(14.0);
                ui.horizontal_wrapped(|ui| {
                    pill(ui, "1. 원본 선택", if has_root {
                        StatusTone::Good
                    } else { StatusTone::Neutral });
                    pill(ui, "2. 호환성 확인", if compatible {
                        StatusTone::Good
                    } else if blocked { StatusTone::Bad } else { StatusTone::Neutral });
                    pill(ui, "3. 패치 적용", if applied {
                        StatusTone::Good
                    } else { StatusTone::Neutral });
                });
                ui.add_space(12.0);
                ui.horizontal_wrapped(|ui| {
                    if self.busy {
                        ui.spinner();
                        label(ui, "처리 중 · 잠시 다른 패치 작업은 비활성화됩니다.");
                    } else if !has_root || status == "NO_SOURCE" {
                        if action(ui, "원본 폴더 선택", ButtonTone::Primary, true) {
                            self.choose_folder();
                        }
                    } else if compatible && !applied {
                        if action(ui, "안전하게 패치 적용", ButtonTone::Primary, true) {
                            self.ask("디노 패치 수동 적용");
                        }
                    } else if applied {
                        if action(ui, "현재 상태 다시 검사", ButtonTone::Secondary, true) {
                            self.enqueue("원본 다시 확인");
                        }
                    } else if blocked {
                        if action(ui, "진단 기록 열기", ButtonTone::Secondary, true) {
                            self.show_log = true;
                            self.show_advanced = true;
                        }
                    } else if action(ui, "원본 호환성 확인", ButtonTone::Primary, true) {
                        self.enqueue("원본 다시 확인");
                    }
                    ui.add_space(7.0);
                    Frame::new()
                        .fill(rgb(badge_fill))
                        .corner_radius(CornerRadius::same(7))
                        .inner_margin(Margin::symmetric(9, 7))
                        .show(ui, |ui| {
                            ui.label(RichText::new(if self.auto_enabled {
                                "자동 감시 사용 중"
                            } else {
                                "자동 감시 일시 중지"
                            }).size(10.5).color(rgb(badge_ink)));
                        });
                });
            });
    }

    fn source_card(&mut self, ui: &mut Ui) {
        card(ui, |ui| {
            heading(ui, "설치 원본");
            label(ui, "경로 입력만으로 원본 파일을 변경하지 않습니다. 자동 감시가 켜져 있으면 검사 후 패치가 적용될 수 있습니다.");
            ui.add_space(9.0);

            let version_text = if self.status.version.is_empty() {
                "확인 전".to_owned()
            } else {
                format!("v{}", self.status.version)
            };
            let path_text = if self.root.trim().is_empty() {
                "원본 폴더가 선택되지 않았습니다.".to_owned()
            } else {
                self.root.clone()
            };
            // Keep the full path accessible through a hover tooltip. At the
            // minimum window size the path moves to its own full-width row.
            if ui.available_width() < 720.0 {
                label(ui, "LilacAnime 버전");
                ui.label(RichText::new(&version_text).size(13.0).strong().color(rgb(TEXT)));
                ui.add_space(7.0);
                label(ui, "원본 폴더");
                ui.add(egui::Label::new(
                    RichText::new(&path_text).size(12.0).strong().color(rgb(TEXT))
                ).truncate()).on_hover_text(path_text.as_str());
                ui.add_space(9.0);
                if action(ui, "원본 폴더 변경", ButtonTone::Secondary, !self.busy) {
                    self.choose_folder();
                }
            } else {
                ui.horizontal(|ui| {
                    ui.allocate_ui_with_layout(
                        Vec2::new(112.0, 44.0),
                        Layout::top_down(Align::Min),
                        |ui| {
                            label(ui, "LilacAnime 버전");
                            ui.label(RichText::new(&version_text)
                                .size(13.0).strong().color(rgb(TEXT)));
                        },
                    );
                    ui.add_space(10.0);
                    let path_width = (ui.available_width() - 152.0).max(160.0);
                    ui.allocate_ui_with_layout(
                        Vec2::new(path_width, 44.0),
                        Layout::top_down(Align::Min),
                        |ui| {
                            label(ui, "원본 폴더");
                            ui.add(egui::Label::new(
                                RichText::new(&path_text).size(12.0).strong().color(rgb(TEXT))
                            ).truncate()).on_hover_text(path_text.as_str());
                        },
                    );
                    if action(ui, "원본 폴더 변경", ButtonTone::Secondary, !self.busy) {
                        self.choose_folder();
                    }
                });
            }

            ui.add_space(7.0);
            if self.show_path_editor {
                label(ui, "검사할 새 경로 · 입력 중에는 기존 설치 경로가 유지됩니다.");
                let input_width = ui.available_width();
                ui.add_enabled(
                    !self.busy,
                    egui::TextEdit::singleline(&mut self.path_draft)
                        .hint_text(r"D:\LilacAnime")
                        .desired_width(input_width),
                );
                ui.add_space(6.0);
                ui.horizontal_wrapped(|ui| {
                    if action(ui, "경로 검사", ButtonTone::Primary,
                        !self.busy && !self.path_draft.trim().is_empty()) {
                        let candidate = self.path_draft.trim().to_owned();
                        if self.root != candidate {
                            self.set_root(candidate);
                            self.status = transaction::Status::new(
                                "SOURCE_FOUND", "", "새 설치 폴더를 선택했습니다. 구조 검사 중입니다."
                            );
                        }
                        self.last_archive_change = None;
                        self.show_path_editor = false;
                        self.enqueue("원본 다시 확인");
                    }
                    if action(ui, "입력 취소", ButtonTone::Secondary, !self.busy) {
                        self.path_draft = self.root.clone();
                        self.show_path_editor = false;
                    }
                });
            } else if ui.small_button("경로 직접 입력").clicked() {
                self.path_draft = self.root.clone();
                self.show_path_editor = true;
            }
        });
    }

    fn patch_list_card(&mut self, ui: &mut Ui) {
        card(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.vertical(|ui| {
                    heading(ui, "패치 목록");
                    ui.add_space(2.0);
                    let note = if self.busy {
                        "자동 검사 중 · 패치 작업을 처리하고 있습니다."
                    } else if !self.auto_enabled {
                        "자동 감시 일시 중지 · 수동 검사 및 적용 가능"
                    } else if self.status.manually_uninstalled {
                        "수동 해제 유지 · 자동 재적용하지 않습니다."
                    } else {
                        "실행 시 자동 검사 · 필요 시 적용"
                    };
                    pill(ui, note, if self.auto_enabled {
                        StatusTone::Neutral
                    } else {
                        StatusTone::Warning
                    });
                });
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.checkbox(&mut self.auto_enabled, "자동 감시");
                });
            });
            ui.add_space(11.0);
            Frame::new()
                .fill(rgb(SURFACE_DARK))
                .stroke(Stroke::new(1.0, rgb(BORDER)))
                .corner_radius(CornerRadius::same(13))
                .inner_margin(Margin::symmetric(16, 15))
                .show(ui, |ui| {
                    ui.set_min_width(ui.available_width());
                    ui.horizontal_wrapped(|ui| {
                        Frame::new()
                            .fill(rgb(0x223934))
                            .stroke(Stroke::new(1.0, rgb(0x476B5D)))
                            .corner_radius(CornerRadius::same(11))
                            .inner_margin(Margin::symmetric(13, 9))
                            .show(ui, |ui| {
                                ui.label(RichText::new("D").size(17.0).strong().color(rgb(ACCENT)));
                            });
                        ui.add_space(6.0);
                        ui.vertical(|ui| {
                            ui.horizontal(|ui| {
                                ui.label(RichText::new("LilacAnime DinoPatch")
                                    .size(16.0).strong().color(rgb(TEXT)));
                                label(ui, "v1.0.0");
                            });
                            ui.label(RichText::new("통합 검색 · 동일 작품 묶기 · 공급원 선택")
                                .size(12.0).color(rgb(MUTED)));
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let (title, tone) = badge_for(&self.status);
                            pill(ui, title, tone);
                        });
                    });
                });
        });
    }

    fn advanced_card(&mut self, ui: &mut Ui, ctx: &egui::Context) {
        let backup_list_current = self.backup_list_root.as_deref() == Some(self.root.trim());
        let backup_items = if backup_list_current {
            self.backup_items.clone()
        } else {
            Vec::new()
        };
        let backup_error = if backup_list_current {
            self.backup_error.clone()
        } else {
            None
        };
        card(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new("수동 관리").size(14.0).strong().color(rgb(TEXT)));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    label(ui, "자동 감시와 별도로 원본을 다시 검증합니다.");
                });
            });
            ui.add_space(7.0);
            ui.horizontal_wrapped(|ui| {
                let has_root = !self.root.trim().is_empty();
                if action(ui, "원본 다시 확인", ButtonTone::Secondary, !self.busy && has_root) {
                    self.enqueue("원본 다시 확인");
                }
                if action(ui, "디노 패치 수동 적용", ButtonTone::Primary,
                    !self.busy && has_root && matches!(self.status.status.as_str(),
                        "UNPATCHED" | "ALREADY_UNPATCHED")) {
                    self.ask("디노 패치 수동 적용");
                }
                if action(ui, "복구 기록 확인", ButtonTone::Secondary,
                    !self.busy && has_root) {
                    self.enqueue("복구 상태 검사");
                }
                if action(ui, "디노 패치 해제", ButtonTone::Danger,
                    !self.busy && matches!(self.status.status.as_str(),
                        "APPLIED" | "ALREADY_APPLIED")) {
                    self.ask("디노 패치 해제");
                }
            });
            ui.add_space(11.0);
            Frame::new()
                .fill(rgb(SURFACE_DARK))
                .stroke(Stroke::new(1.0, rgb(BORDER)))
                .corner_radius(CornerRadius::same(12))
                .inner_margin(Margin::symmetric(14, 11))
                .show(ui, |ui| {
                    ui.set_min_width(ui.available_width());
                    ui.label(RichText::new("백업 목록 및 작업 기록")
                        .size(14.0).strong().color(rgb(TEXT)));
                    label(ui, "현재 설치 경로에서 엔진이 반환한 백업만 표시합니다. 복원 직전 엔진이 경로·버전·SHA-256을 다시 확인합니다.");
                    ui.add_space(6.0);
                    if !backup_list_current {
                        label(ui, "현재 설치 경로의 백업 목록을 아직 확인하지 않았습니다.");
                    } else if let Some(error) = backup_error {
                        ui.label(RichText::new(format!("백업 목록 오류: {error}"))
                            .size(12.0).color(rgb(0xF0A5A5)));
                    } else if backup_items.is_empty() {
                        label(ui, "현재 버전에서 조회된 백업이 없습니다.");
                    } else {
                        label(ui, format!("현재 엔진 반환 항목 {}개", backup_items.len()));
                        for backup in &backup_items {
                            Frame::new()
                                .fill(rgb(PAGE))
                                .stroke(Stroke::new(1.0, rgb(BORDER)))
                                .corner_radius(CornerRadius::same(9))
                                .inner_margin(Margin::symmetric(11, 8))
                                .show(ui, |ui| {
                                    ui.set_min_width(ui.available_width());
                                    ui.horizontal_wrapped(|ui| {
                                        ui.radio_value(
                                            &mut self.selected_backup_id,
                                            Some(backup.id.clone()),
                                            "",
                                        );
                                        ui.vertical(|ui| {
                                            label(ui, format!("백업 ID  {}", backup.id));
                                            label(ui, format!("LilacAnime v{} · 생성 {}",
                                                backup.version, backup.created_at));
                                        });
                                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                            pill(ui,
                                                if backup.restorable { "복원 가능" } else { "복원 불가" },
                                                if backup.restorable { StatusTone::Good } else { StatusTone::Bad });
                                        });
                                    });
                                });
                        }
                    }
                    ui.add_space(6.0);
                    ui.horizontal_wrapped(|ui| {
                        if action(ui, "백업 목록 새로 고침", ButtonTone::Secondary,
                            !self.busy && !self.root.trim().is_empty()) {
                            self.enqueue("백업 목록 새로 고침");
                        }
                        if action(ui, "백업 복원", ButtonTone::Primary,
                            self.can_restore_selected_backup()) {
                            self.ask("백업 복원");
                        }
                        if action(ui, "작업 기록", ButtonTone::Secondary, !self.busy) {
                            self.show_log = true;
                            self.show_advanced = true;
                        }
                    });
                });
            ui.add_space(11.0);
            ui.horizontal_wrapped(|ui| {
                ui.vertical(|ui| {
                    ui.label(RichText::new("공식 릴리스 조회")
                        .size(14.0).strong().color(rgb(TEXT)));
                    label(ui, "원본 앱과 DinoPatch 릴리스 페이지를 각각 엽니다. 자동 설치나 무단 변경은 하지 않습니다.");
                });
                ui.horizontal_wrapped(|ui| {
                    if action(ui, "원본 앱 릴리스", ButtonTone::Secondary, true) {
                        ctx.open_url(egui::OpenUrl::new_tab(
                            "https://github.com/whispelyn-byte/LilacAnime-desktop/releases"
                        ));
                    }
                    // The manager repository can be private. Never claim an
                    // automatic version comparison without authenticated release
                    // metadata; opening its page does not patch or download.
                    if action(ui, "DinoPatch 릴리스 보기", ButtonTone::Secondary, true) {
                        ctx.open_url(egui::OpenUrl::new_tab(
                            "https://github.com/dinoforge/lilac-dino-patch/releases"
                        ));
                    }
                    if action(ui, "진단 정보", ButtonTone::Secondary, true) {
                        self.show_log = true;
                        self.record(format!(
                            "진단 로그: {}",
                            diagnostics::log_path()
                                .map(|path| path.display().to_string())
                                .unwrap_or_else(|| "경로 확인 실패".to_owned())
                        ));
                    }
                });
            });
            if self.status.recovery_available {
                ui.add_space(8.0);
                label(ui, "백업 및 복구 기록의 SHA-256이 확인됐습니다.");
                if action(ui, "검증된 복구 기록 정리", ButtonTone::Secondary, !self.busy) {
                    self.ask("복구 기록 정리");
                }
            }
            if self.show_log {
                ui.add_space(12.0);
                ui.separator();
                ui.add_space(5.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("상세 작업 로그")
                        .size(12.0).strong().color(rgb(MUTED)));
                    if ui.small_button("접기").clicked() {
                        self.show_log = false;
                    }
                });
                Frame::new().fill(rgb(PAGE))
                    .corner_radius(CornerRadius::same(8))
                    .inner_margin(Margin::symmetric(10, 8))
                    .show(ui, |ui| {
                        egui::ScrollArea::vertical().max_height(125.0)
                            .stick_to_bottom(true).show(ui, |ui| {
                                for line in &self.activity {
                                    ui.label(RichText::new(line)
                                        .font(FontId::new(12.0, FontFamily::Monospace))
                                        .color(rgb(MUTED)));
                                }
                            });
                    });
            } else if ui.small_button("상세 작업 로그 열기").clicked() {
                self.show_log = true;
            }
        });
    }

    fn result_card(&mut self, ui: &mut Ui) {
        Frame::new()
            .fill(rgb(CARD))
            .stroke(Stroke::new(1.0, rgb(BORDER)))
            .corner_radius(CornerRadius::same(13))
            .inner_margin(Margin::symmetric(15, 12))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new("현재 진단").size(12.0).strong().color(rgb(ACCENT)));
                    if self.busy {
                        ui.spinner();
                    }
                    let tone = if self.busy {
                        StatusTone::Warning
                    } else if self.operation_state.starts_with("오류 발생") {
                        StatusTone::Bad
                    } else if self.operation_state.starts_with("안전 중단") {
                        StatusTone::Warning
                    } else if self.operation_state.starts_with("완료") {
                        StatusTone::Good
                    } else {
                        StatusTone::Neutral
                    };
                    pill(ui, &self.operation_state, tone);
                });
                ui.add_space(5.0);
                // Reason text gets the entire card width instead of sharing
                // a single line with the status badge/spinner.
                ui.label(RichText::new(&self.status.reason)
                    .size(13.0).color(rgb(TEXT)));
                if let Some((title, note)) = safety_for(&self.status) {
                    ui.add_space(9.0);
                    Frame::new()
                        .fill(rgb(0x26221C))
                        .stroke(Stroke::new(1.0, rgb(0x725F39)))
                        .corner_radius(CornerRadius::same(9))
                        .inner_margin(Margin::symmetric(11, 9))
                        .show(ui, |ui| {
                            ui.label(RichText::new(title).size(12.0).strong()
                                .color(rgb(0xEFCF88)));
                            label(ui, note);
                        });
                }
            });
    }

    fn confirmation(&mut self, ctx: &egui::Context) {
        let Some(operation) = self.pending_action else {
            return;
        };
        let explanation = match operation {
            "디노 패치 수동 적용" =>
                "공식 원본과 호환성·백업 해시를 다시 확인합니다. 직접 해제했던 패치를 재적용할 수 있습니다.",
            "디노 패치 해제" =>
                "기록된 변경 파일만 SHA-256으로 검증한 백업본으로 복원합니다.",
            "백업 복원" =>
                "선택한 백업을 검증한 뒤에만 원본 ASAR를 복원합니다.",
            "복구 기록 정리" =>
                "원본과 백업·중단된 작업 기록이 일치할 때만 복구 기록을 별도로 보존하고 정리합니다.",
            _ => "선택한 작업을 진행하시겠습니까?",
        };
        let backup_details = if operation == "백업 복원" {
            self.selected_backup().map(|backup| format!(
                "대상 경로: {}\n현재 앱 버전: v{}\n선택 백업 버전: v{}\n백업 ID: {}",
                self.root.trim(), self.status.version, backup.version, backup.id
            )).unwrap_or_else(|| "복원 대상 백업을 현재 경로에서 확인할 수 없습니다.".into())
        } else {
            String::new()
        };
        let can_continue = operation != "백업 복원" || self.can_restore_selected_backup();
        egui::Window::new("DinoPatch · 작업 확인")
            .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
            .resizable(false)
            .collapsible(false)
            .default_width(440.0)
            .show(ctx, |ui| {
                heading(ui, operation);
                ui.add_space(8.0);
                ui.label(RichText::new(explanation).size(12.0).color(rgb(TEXT)));
                if !backup_details.is_empty() {
                    ui.add_space(8.0);
                    ui.label(RichText::new(backup_details).size(11.5).color(rgb(MUTED)));
                }
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    if action(ui, "취소", ButtonTone::Secondary, true) {
                        self.pending_action = None;
                    }
                    if action(ui, "계속", ButtonTone::Primary, can_continue) {
                        self.pending_action = None;
                        self.enqueue(operation);
                    }
                });
            });
    }
}

impl eframe::App for DinoUi {
    fn persist_egui_memory(&self) -> bool {
        // The path editor may contain a draft installation path. Only save
        // the whitelisted UI keys and the native window geometry.
        false
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        storage.set_string(TEXT_ZOOM_KEY, self.text_zoom_index.to_string());
        storage.set_string(ADVANCED_PANEL_KEY, self.show_advanced.to_string());
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_result();
        self.monitor();
        ctx.request_repaint_after(Duration::from_millis(if self.busy { 120 } else { 500 }));
        egui::CentralPanel::default()
            .frame(Frame::new().fill(rgb(PAGE)))
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.add_space(18.0);
                        ui.vertical_centered(|ui| {
                            ui.set_max_width(860.0);
                            ui.set_min_width(ui.available_width().min(860.0));
                            ui.horizontal_wrapped(|ui| {
                                ui.vertical(|ui| {
                                    ui.label(RichText::new("DinoPatch Manager")
                                        .size(28.0).strong().color(rgb(TEXT)));
                                    label(ui, "LilacAnime · 원본 보존형 패치 관리자");
                                });
                                pill(ui, "Rust 네이티브 · v0.2.0", StatusTone::Neutral);
                            });
                            ui.add_space(10.0);
                            self.readability_controls(ui, ctx);
                            ui.add_space(15.0);
                            self.overview_card(ui);
                            ui.add_space(12.0);
                            self.result_card(ui);
                            ui.add_space(12.0);
                            self.source_card(ui);
                            ui.add_space(12.0);
                            self.patch_list_card(ui);
                            ui.add_space(12.0);
                            let advanced_title = if self.show_advanced {
                                "고급 관리 접기"
                            } else {
                                "고급 관리 열기 · 원복 / 백업 / 작업 로그 / 업데이트"
                            };
                            let toggle_width = ui.available_width();
                            if ui.add_sized(
                                [toggle_width, 38.0],
                                Button::new(advanced_title)
                                    .fill(rgb(SURFACE))
                                    .stroke(Stroke::new(1.0, rgb(BORDER)))
                                    .corner_radius(CornerRadius::same(9)),
                            ).clicked() {
                                self.show_advanced = !self.show_advanced;
                            }
                            if self.show_advanced {
                                ui.add_space(9.0);
                                self.advanced_card(ui, ctx);
                            }
                            ui.add_space(10.0);
                            label(ui, "설치된 공식 원본만 수정합니다. 검사에 실패하면 변경하지 않고 백업을 보존합니다.");
                            ui.add_space(12.0);
                        });
                    });
            });
        self.confirmation(ctx);
    }
}

fn register_windows_fonts(ctx: &egui::Context) {
    #[cfg(windows)]
    {
        let windows = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
        let directory = PathBuf::from(windows).join("Fonts");
        // Use the regular Korean font first. Some Windows installations omit
        // a particular family file, so try other preinstalled Korean fonts.
        // Font data is loaded only into egui; no font is bundled or exported.
        let candidates = ["malgun.ttf", "malgunbd.ttf", "malgunsl.ttf"];
        let found = candidates.iter().find_map(|name| {
            std::fs::read(directory.join(name)).ok().map(|bytes| (*name, bytes))
        });
        if let Some((name, bytes)) = found {
            let mut fonts = egui::FontDefinitions::default();
            fonts.font_data.insert(
                "dino-hangul".into(),
                egui::FontData::from_owned(bytes).into()
            );
            for family in [FontFamily::Proportional, FontFamily::Monospace] {
                fonts.families.entry(family).or_default().insert(0, "dino-hangul".into());
            }
            ctx.set_fonts(fonts);
            diagnostics::write(&format!("Korean UI font loaded: {name}"));
        } else {
            diagnostics::write("Windows Korean font missing; bundled fallback may not contain Hangul glyphs");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = ctx;
    }
}

fn setup_style(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = rgb(PAGE);
    visuals.window_fill = rgb(CARD);
    visuals.override_text_color = Some(rgb(TEXT));
    visuals.widgets.noninteractive.bg_fill = rgb(CARD);
    visuals.widgets.inactive.bg_fill = rgb(SURFACE);
    visuals.widgets.hovered.bg_fill = rgb(0x2C4149);
    visuals.widgets.active.bg_fill = rgb(0x34594D);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, rgb(TEXT));
    visuals.selection.bg_fill = rgb(0x426E62);
    ctx.set_visuals(visuals);
    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = Vec2::new(8.0, 8.0);
    ctx.set_style(style);
}

pub fn start() -> Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([940.0, 840.0])
            .with_min_inner_size([640.0, 560.0]),
        persist_window: true,
        ..Default::default()
    };
    eframe::run_native(
        "LilacAnime DinoPatch",
        options,
        Box::new(|cc| {
            register_windows_fonts(&cc.egui_ctx);
            setup_style(&cc.egui_ctx);
            let app = DinoUi::with_storage(cc.storage);
            cc.egui_ctx.set_zoom_factor(TEXT_ZOOM[app.text_zoom_index]);
            Ok(Box::new(app))
        })
    ).map_err(|error| crate::fail(format!("Rust GUI 실행 실패: {error}")))
}

#[cfg(test)]
mod backup_list_tests {
    use super::{operation_stage, parse_backup_items, BackupItem};
    use serde_json::json;

    #[test]
    fn backup_list_accepts_zero_items() {
        assert!(parse_backup_items(&json!({ "items": [] })).unwrap().is_empty());
    }

    #[test]
    fn backup_list_preserves_single_item_metadata() {
        let items = parse_backup_items(&json!({
            "items": [{
                "id": "backup-1",
                "version": "0.5.65",
                "createdAt": "2026-11-14T12:00:00Z",
                "restorable": true
            }]
        })).unwrap();

        assert_eq!(items, vec![BackupItem {
            id: "backup-1".into(),
            version: "0.5.65".into(),
            created_at: "2026-11-14T12:00:00Z".into(),
            restorable: true,
        }]);
    }

    #[test]
    fn backup_list_keeps_all_items_and_non_restorable_state() {
        let items = parse_backup_items(&json!({
            "items": [
                {"id":"backup-a","version":"0.5.65","createdAt":"t1","restorable":true},
                {"id":"backup-b","version":"0.5.65","createdAt":"t2","restorable":false}
            ]
        })).unwrap();

        assert_eq!(items.len(), 2);
        assert!(items[0].restorable);
        assert!(!items[1].restorable);
        assert_eq!(items[1].id, "backup-b");
    }

    #[test]
    fn malformed_backup_list_fails_closed() {
        assert!(parse_backup_items(&json!({})).is_err());
        assert!(parse_backup_items(&json!({ "items": [{
            "id":"backup-a","version":"0.5.65","createdAt":"t1"
        }]})).is_err());
        assert!(parse_backup_items(&json!({ "items": [{
            "id":" ","version":"0.5.65","createdAt":"t1","restorable":true
        }]})).is_err());
    }

    #[test]
    fn operation_stages_are_truthful_and_do_not_claim_percentages() {
        assert_eq!(operation_stage("원본 다시 확인"), "원본 구조와 현재 파일 상태 확인 중");
        assert_eq!(operation_stage("백업 복원"), "원본·백업 SHA-256 검증 및 복원 작업 중");
        assert!(!operation_stage("자동 검사").contains('%'));
    }
}
