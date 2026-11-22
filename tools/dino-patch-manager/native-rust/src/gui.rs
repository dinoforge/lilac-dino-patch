//! Native Rust desktop manager styled after the existing Electron DinoPatch UI.
//! All operations are backed by the same independently checked Rust transactions.
use crate::{diagnostics, patch_set, release_update, transaction, updater_engine, Result};
use eframe::egui::{
    self, Align, Align2, Button, Color32, CornerRadius, FontFamily, FontId, Frame, Layout, Margin,
    Response, RichText, Stroke, Ui, Vec2,
};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant, SystemTime};

const PAGE: u32 = 0xF3F5FA;
const CARD: u32 = 0xFFFFFF;
const BORDER: u32 = 0xD6DDE8;
const ACCENT: u32 = 0x6244B4;
const BUTTON: u32 = 0x6848C5;
const TEXT: u32 = 0x202638;
const MUTED: u32 = 0x4C596E;
const SURFACE: u32 = 0xEDF0F6;
const DISABLED_FILL: u32 = 0xE8ECF3;
const DISABLED_TEXT: u32 = 0x536074;
const DISABLED_BORDER: u32 = 0xC7D0DE;
const ERROR_TEXT: u32 = 0x982D3B;
const WARNING_TEXT: u32 = 0x745000;
const HOVER_SURFACE: u32 = 0xE6E0F4;
const ACTIVE_SURFACE: u32 = 0xDAD0F0;

const ADVANCED_PANEL_KEY: &str = "dino.manager.ui.advancedOpen.v1";
const AUTO_APPLY_KEY: &str = "dino.manager.autoApply.v1";
const CONFIRMED_PATCH_SELECTION_KEY: &str = "dino.manager.confirmedPatchSelection.v1";
const GUI_PERSISTENCE_VERSION: &str = "ui-v2";
const PATH_TOOLTIP_MAX_CHARS: usize = 88;
const PATH_TOOLTIP_MAX_SIZE: Vec2 = Vec2::new(320.0, 100.0);
const BODY_TEXT_SIZE: f32 = 14.0;
const HELP_TEXT_SIZE: f32 = 13.0;
const SECTION_TEXT_SIZE: f32 = 16.0;
const STATUS_TEXT_SIZE: f32 = 16.0;
const BUTTON_TEXT_SIZE: f32 = 14.0;
const PATCH_LIST_COMPACT_MAX_HEIGHT: f32 = 78.0;
const PATCH_LIST_STANDARD_MAX_HEIGHT: f32 = 88.0;
const BUTTON_HEIGHT: f32 = 38.0;

fn integrated_patch_status(status: &str) -> &'static str {
    match status {
        "APPLIED" | "ALREADY_APPLIED" => "적용됨",
        "UNPATCHED" | "ALREADY_UNPATCHED" => "미적용",
        "UNSUPPORTED" => "지원되지 않음",
        _ => "확인 불가",
    }
}

fn integrated_patch_status_tone(status: &str) -> StatusTone {
    match status {
        "APPLIED" | "ALREADY_APPLIED" => StatusTone::Good,
        "UNPATCHED" | "ALREADY_UNPATCHED" => StatusTone::Neutral,
        "CONFLICT" | "PARTIAL_OR_UNKNOWN" | "UNSUPPORTED" => StatusTone::Bad,
        _ => StatusTone::Warning,
    }
}

fn parse_auto_apply_setting(value: Option<&str>) -> bool {
    match value {
        Some("true") => true,
        Some("false") => false,
        // A missing setting preserves the pre-existing enabled monitor policy;
        // a malformed persisted value fails closed.
        None => true,
        Some(_) => false,
    }
}

fn parse_confirmed_patch_selection(value: Option<&str>) -> patch_set::PatchSelection {
    value
        .and_then(|raw| patch_set::PatchSelection::parse_id(raw).ok())
        .unwrap_or(patch_set::PatchSelection::DEFAULT)
}

fn automatic_apply_config_block(
    enabled: bool,
    busy: bool,
    has_root: bool,
    root_selected_by_user: bool,
    draft: patch_set::PatchSelection,
    confirmed: patch_set::PatchSelection,
) -> Option<&'static str> {
    if !enabled {
        return Some("자동 적용 꺼짐 · 수동 작업 가능");
    }
    if busy {
        return Some("작업 중 · 자동 적용 대기");
    }
    if !has_root {
        return Some("원본 확인 대기");
    }
    if !root_selected_by_user {
        return Some("설치 경로를 직접 확인하면 자동 적용됩니다");
    }
    if draft != confirmed {
        return Some("선택 변경 미확정 · 자동 적용 보류");
    }
    if confirmed.is_empty() {
        return Some("선택된 패치 없음 · 자동 적용하지 않습니다");
    }
    if !confirmed.manager_install_supported() {
        return Some("선택 조합 설치 미지원 · 자동 적용 보류");
    }
    None
}

fn automatic_apply_status_block(status: &str) -> Option<&'static str> {
    match status {
        "UNPATCHED" | "ALREADY_UNPATCHED" | "APPLIED" | "ALREADY_APPLIED" => None,
        "SOURCE_FOUND" => Some("원본 상태 검사 필요 · 자동 적용 보류"),
        "SOURCE_MISSING" => Some("원본 확인 대기 · 자동 적용 보류"),
        "UNSUPPORTED" => Some("지원되지 않는 원본 · 자동 적용 보류"),
        "CONFLICT" => Some("파일 충돌 · 자동 적용 보류"),
        "PARTIAL_OR_UNKNOWN" => Some("상태 확인 불가 · 자동 적용 보류"),
        _ => Some("원본 상태 확인 필요 · 자동 적용 보류"),
    }
}

fn automatic_apply_needed(
    status: &transaction::Status,
    desired: patch_set::PatchSelection,
) -> bool {
    let Some(desired_set) = desired.as_patch_set() else { return false; };
    if !desired.manager_install_supported() {
        return false;
    }
    match status.status.as_str() {
        "UNPATCHED" | "ALREADY_UNPATCHED" => !status.manually_uninstalled,
        "APPLIED" | "ALREADY_APPLIED" => status.composition_id.as_deref()
            .and_then(|id| patch_set::PatchSet::parse_id(id).ok())
            .is_some_and(|installed| installed != desired_set),
        _ => false,
    }
}

fn automatic_apply_waiting_for_source(enabled: bool, has_root: bool, status: &str) -> bool {
    enabled && (!has_root || status == "SOURCE_MISSING")
}

fn automatic_monitor_operation(
    status: &str,
    archive_changed: bool,
    automatic_apply_ready: bool,
) -> Option<&'static str> {
    if archive_changed || matches!(status, "SOURCE_FOUND" | "SOURCE_MISSING") {
        Some("원본 다시 확인")
    } else if automatic_apply_ready && matches!(status, "UNPATCHED" | "ALREADY_UNPATCHED" | "APPLIED" | "ALREADY_APPLIED") {
        Some("자동 검사")
    } else {
        None
    }
}

fn actual_patch_status(
    id: patch_set::PatchId,
    status: &transaction::Status,
) -> (&'static str, StatusTone) {
    match status.status.as_str() {
        "APPLIED" | "ALREADY_APPLIED" => {
            if let Some(set) = status.composition_id.as_deref()
                .and_then(|value| patch_set::PatchSet::parse_id(value).ok()) {
                if set.contains(id) {
                    ("적용됨", StatusTone::Good)
                } else {
                    ("미적용", StatusTone::Neutral)
                }
            } else if id == patch_set::PatchId::IntegratedSearchProviderSwitch {
                (integrated_patch_status(&status.status), integrated_patch_status_tone(&status.status))
            } else {
                ("확인 불가", StatusTone::Warning)
            }
        }
        "UNPATCHED" | "ALREADY_UNPATCHED" => ("미적용", StatusTone::Neutral),
        "UNSUPPORTED" => ("지원되지 않음", StatusTone::Warning),
        _ => ("확인 불가", StatusTone::Warning),
    }
}

fn patch_row_status(
    feature: patch_set::PatchDefinition,
    status: &transaction::Status,
) -> (&'static str, StatusTone) {
    match feature.availability {
        patch_set::FeatureAvailability::ManagerSelectable => actual_patch_status(feature.id, status),
        patch_set::FeatureAvailability::PreviewOnly => ("미리보기", StatusTone::Preview),
    }
}

fn patch_list_max_height(viewport_height: f32) -> f32 {
    if viewport_height <= 400.0 {
        PATCH_LIST_COMPACT_MAX_HEIGHT
    } else {
        PATCH_LIST_STANDARD_MAX_HEIGHT
    }
}

fn patch_support_summary(
    availability: impl IntoIterator<Item = patch_set::FeatureAvailability>,
) -> String {
    let (install_supported, preview_only) = availability.into_iter().fold(
        (0usize, 0usize),
        |(install_supported, preview_only), item| match item {
            patch_set::FeatureAvailability::ManagerSelectable => {
                (install_supported + 1, preview_only)
            }
            patch_set::FeatureAvailability::PreviewOnly => {
                (install_supported, preview_only + 1)
            }
        },
    );

    match (install_supported, preview_only) {
        (0, 0) => "등록된 패치가 없습니다".to_owned(),
        (0, preview_only) => format!("미리보기 전용 {preview_only}개"),
        (install_supported, 0) => format!("관리자 설치 지원 {install_supported}개"),
        (install_supported, preview_only) => {
            format!("설치 지원 {install_supported}개 · 미리보기 전용 {preview_only}개")
        }
    }
}

fn patch_selection_summary(
    selection: patch_set::PatchSelection,
    state: &str,
    catalog: &[patch_set::PatchDefinition],
) -> String {
    let selected_count = catalog
        .iter()
        .filter(|feature| selection.contains(feature.id))
        .count();
    let selected = match selected_count {
        0 => "선택 없음".to_owned(),
        count => format!("선택 {count}개"),
    };
    format!("{selected} · {state}")
}

fn empty_state_vertical_offset(
    panel_height: f32,
    used_height: f32,
    summary_height: f32,
    action_height: f32,
    item_spacing: f32,
) -> f32 {
    (panel_height - used_height - summary_height - action_height - item_spacing * 2.0)
        .max(0.0)
        / 2.0
}

fn rgb(value: u32) -> Color32 {
    Color32::from_rgb((value >> 16) as u8, (value >> 8) as u8, value as u8)
}

#[derive(Clone, Copy)]
enum ButtonTone {
    Primary,
    Secondary,
    Danger,
}

fn action_button_palette(tone: ButtonTone, enabled: bool) -> (u32, u32, u32) {
    if !enabled {
        return (DISABLED_FILL, DISABLED_TEXT, DISABLED_BORDER);
    }
    match tone {
        ButtonTone::Primary => (BUTTON, 0xFFFFFF, BUTTON),
        ButtonTone::Secondary => (SURFACE, TEXT, BORDER),
        ButtonTone::Danger => (0xFBE8EA, 0x922B39, 0xD9AAB2),
    }
}

fn action_button(
    ui: &mut Ui,
    label: &str,
    tone: ButtonTone,
    enabled: bool,
    min_size: Vec2,
) -> Response {
    let (fill, ink, edge) = action_button_palette(tone, enabled);
    let response = ui.add_enabled(
        enabled,
        Button::new(RichText::new(label).size(BUTTON_TEXT_SIZE).strong().color(rgb(ink)))
            .fill(rgb(fill))
            .stroke(Stroke::new(1.0_f32, rgb(edge)))
            .corner_radius(CornerRadius::same(8))
            .min_size(min_size),
    );
    // Disabled actions need a visible explanation, not just a dim button.
    if enabled {
        response
    } else {
        response
            .on_disabled_hover_text(
                "현재 상태에서는 실행할 수 없습니다. 설치 원본과 패치 상태를 먼저 확인하세요.",
            )
    }
}

fn action(ui: &mut Ui, label: &str, tone: ButtonTone, enabled: bool) -> bool {
    action_button(
        ui,
        label,
        tone,
        enabled,
        Vec2::new(76.0, BUTTON_HEIGHT),
    )
    .clicked()
}

fn card(ui: &mut Ui, body: impl FnOnce(&mut Ui)) -> f32 {
    card_with_min_height(ui, None, body)
}

fn card_with_min_height(
    ui: &mut Ui,
    min_height: Option<f32>,
    body: impl FnOnce(&mut Ui),
) -> f32 {
    let response = Frame::new()
        .fill(rgb(CARD))
        .stroke(Stroke::new(0.75_f32, rgb(BORDER)))
        .corner_radius(CornerRadius::same(10))
        .inner_margin(Margin::symmetric(10, 6))
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            if let Some(height) = min_height {
                ui.set_min_height((height - 14.0).max(0.0));
            }
            body(ui);
        });
    response.response.rect.height()
}

fn label(ui: &mut Ui, text: impl Into<String>) {
    ui.label(RichText::new(text).size(BODY_TEXT_SIZE).color(rgb(MUTED)));
}

fn heading(ui: &mut Ui, text: &str) {
    ui.label(RichText::new(text).size(SECTION_TEXT_SIZE).strong().color(rgb(TEXT)));
}

fn path_tooltip_preview(path: &str) -> String {
    let chars = path.chars().collect::<Vec<_>>();
    if chars.len() <= PATH_TOOLTIP_MAX_CHARS {
        return path.to_owned();
    }

    let start = chars.iter().take(42).collect::<String>();
    let end = chars
        .iter()
        .skip(chars.len().saturating_sub(42))
        .collect::<String>();
    format!("{start}…\n{end}")
}

fn display_installation_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn compact_backup_id(id: &str) -> String {
    const MAX_CHARS: usize = 28;
    let chars = id.chars().collect::<Vec<_>>();
    if chars.len() <= MAX_CHARS {
        return id.to_owned();
    }
    let head = chars.iter().take(13).collect::<String>();
    let tail = chars
        .iter()
        .skip(chars.len().saturating_sub(14))
        .collect::<String>();
    format!("{head}…{tail}")
}

fn path_label(ui: &mut Ui, path: &str, width: f32, show_tooltip: bool) {
    let response = ui.add_sized(
        Vec2::new(width, BUTTON_HEIGHT),
        egui::Label::new(RichText::new(path).size(BODY_TEXT_SIZE).color(rgb(TEXT))).truncate(),
    );
    if show_tooltip {
        let preview = path_tooltip_preview(path);
        let include_copy_hint = preview.len() < path.len();
        response.on_hover_ui(move |tooltip| {
            tooltip.set_max_size(PATH_TOOLTIP_MAX_SIZE);
            Frame::new()
                .fill(rgb(CARD))
                .stroke(Stroke::new(0.75_f32, rgb(BORDER)))
                .corner_radius(CornerRadius::same(7))
                .inner_margin(Margin::same(8))
                .show(tooltip, |popup| {
                    popup.set_max_size(PATH_TOOLTIP_MAX_SIZE);
                    popup.label(RichText::new(preview).size(HELP_TEXT_SIZE).color(rgb(TEXT)));
                    if include_copy_hint {
                        popup.add_space(4.0);
                        label(popup, "전체 경로는 ‘경로 복사’ 버튼으로 복사하세요.");
                    }
                });
        });
    }
}

fn path_action_row(
    ui: &mut Ui,
    path: &str,
    action_text: &str,
    action_width: f32,
    enabled: bool,
    show_tooltip: bool,
) -> bool {
    let mut clicked = false;
    ui.horizontal(|row| {
        let spacing = row.spacing().item_spacing.x;
        let path_width = (row.available_width() - action_width - spacing).max(0.0);
        path_label(row, path, path_width, show_tooltip);
        clicked = action_button(
            row,
            action_text,
            ButtonTone::Secondary,
            enabled,
            Vec2::new(action_width, BUTTON_HEIGHT),
        )
        .clicked();
    });
    clicked
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatusTone {
    Neutral,
    Good,
    Warning,
    Bad,
    Preview,
}

#[derive(Debug, PartialEq, Eq)]
enum ArchiveWatch {
    Available(u64, Option<SystemTime>),
    Missing,
    Invalid(String),
}

fn inspect_monitored_archive(path: &PathBuf) -> ArchiveWatch {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ArchiveWatch::Missing,
        Err(error) => ArchiveWatch::Invalid(format!(
            "app.asar 상태를 확인하지 못했습니다: {error}. 자동 적용을 중단했습니다."
        )),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            ArchiveWatch::Invalid("app.asar가 링크라서 자동 적용을 중단했습니다.".into())
        }
        Ok(metadata) if !metadata.is_file() => ArchiveWatch::Invalid(
            "app.asar가 일반 파일이 아니라서 자동 적용을 중단했습니다.".into(),
        ),
        Ok(metadata) => ArchiveWatch::Available(metadata.len(), metadata.modified().ok()),
    }
}

fn status_style(tone: StatusTone) -> (u32, u32) {
    match tone {
        StatusTone::Neutral => (0xEBEFF5, 0x39465A),
        StatusTone::Good => (0xE4F3E9, 0x21613A),
        StatusTone::Warning => (0xFFF1CC, 0x745000),
        StatusTone::Bad => (0xFBE7E9, 0x982D3B),
        StatusTone::Preview => (0xEFE9FA, 0x583A99),
    }
}

fn pill(ui: &mut Ui, text: &str, tone: StatusTone) {
    let (fill, color) = status_style(tone);
    Frame::new()
        .fill(rgb(fill))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::symmetric(9, 5))
        .show(ui, |ui| {
            ui.label(
                RichText::new(text)
                    .size(STATUS_TEXT_SIZE)
                    .strong()
                    .color(rgb(color)),
            );
        });
}

fn compact_pill(ui: &mut Ui, text: &str, tone: StatusTone) {
    let (fill, color) = status_style(tone);
    Frame::new()
        .fill(rgb(fill))
        .corner_radius(CornerRadius::same(10))
        .inner_margin(Margin::symmetric(7, 2))
        .show(ui, |ui| {
            ui.label(
                RichText::new(text)
                    .size(HELP_TEXT_SIZE)
                    .strong()
                    .color(rgb(color)),
            );
        });
}

fn badge_for(status: &transaction::Status) -> (&'static str, StatusTone) {
    match status.status.as_str() {
        "APPLIED" | "ALREADY_APPLIED" => ("적용됨 · 호환", StatusTone::Good),
        "UNPATCHED" if status.manually_uninstalled => ("수동 해제 · 미적용", StatusTone::Warning),
        "UNPATCHED" | "ALREADY_UNPATCHED" => ("호환 · 미적용", StatusTone::Warning),
        "NO_SOURCE" => ("원본 미발견", StatusTone::Neutral),
        "SOURCE_MISSING" => ("원본 파일 없음", StatusTone::Warning),
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
        "SOURCE_MISSING" => Some((
            "원본 파일을 찾을 수 없습니다",
            "선택한 폴더에 resources/app.asar가 없습니다. 실제 LilacAnime 소스 폴더를 선택하세요.",
        )),
        "NO_SOURCE" => Some((
            "원본 폴더를 선택하세요",
            "기존 LilacAnime.exe가 설치된 폴더를 선택해야 합니다. 원본을 별도로 배포하지 않습니다.",
        )),
        _ => None,
    }
}

// Short, advisory guidance; file-mutating work remains guarded by transactions.
fn next_step(status: &transaction::Status, busy: bool) -> &'static str {
    if busy {
        return "작업 결과를 확인하는 중";
    }
    match status.status.as_str() {
        "NO_SOURCE" => "공식 설치 폴더를 선택하세요.",
        "SOURCE_MISSING" => "실제 LilacAnime 소스 폴더를 선택하세요.",
        "SOURCE_FOUND" => "원본 검사를 실행하세요.",
        "UNPATCHED" | "ALREADY_UNPATCHED" if status.manually_uninstalled => {
            "수동 해제 상태 · 재적용은 직접 선택할 수 있습니다."
        }
        "UNPATCHED" | "ALREADY_UNPATCHED" => "호환 확인됨 · 패치를 적용할 수 있습니다.",
        "APPLIED" | "ALREADY_APPLIED" => "필요하면 패치 상태를 다시 검사하세요.",
        "CONFLICT" | "PARTIAL_OR_UNKNOWN" | "UNSUPPORTED" => "진단을 펼쳐 원인을 확인하세요.",
        _ => "원본 상태를 확인하세요.",
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

#[derive(Clone)]
enum UpdateState {
    Checking,
    UpToDate,
    Available(release_update::ReleaseCandidate),
    Downloading {
        candidate: release_update::ReleaseCandidate,
        received: u64,
        total: Option<u64>,
    },
    ReadyToInstall {
        candidate: release_update::ReleaseCandidate,
        digest: String,
    },
    Installing,
    Failed(String),
}

enum UpdateMessage {
    CheckFinished(std::result::Result<Option<release_update::ReleaseCandidate>, String>),
    DownloadProgress {
        tag: String,
        received: u64,
        total: Option<u64>,
    },
    DownloadFinished {
        candidate: release_update::ReleaseCandidate,
        result: std::result::Result<String, String>,
    },
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

#[derive(Debug, PartialEq, Eq)]
enum ConfirmationChoice {
    Pending,
    Cancel,
    Start(&'static str),
}

fn confirmation_choice(
    operation: &'static str,
    can_continue: bool,
    cancel_clicked: bool,
    continue_clicked: bool,
) -> ConfirmationChoice {
    if cancel_clicked {
        ConfirmationChoice::Cancel
    } else if continue_clicked && can_continue {
        ConfirmationChoice::Start(operation)
    } else {
        ConfirmationChoice::Pending
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
        Some("APPLIED") | Some("ALREADY_APPLIED") => "완료 · 통합 검색·공급원 전환 적용 확인",
        Some("UNPATCHED") | Some("ALREADY_UNPATCHED") => "완료 · 원본 상태 확인",
        Some("NO_SOURCE") => "확인 완료 · 설치 원본 미발견",
        _ => "작업 완료 · 결과 상태 확인",
    }
}

struct DinoUi {
    root: String,
    root_selected_by_user: bool,
    status: transaction::Status,
    auto_enabled: bool,
    draft_patch_selection: patch_set::PatchSelection,
    confirmed_patch_selection: patch_set::PatchSelection,
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
    show_update_details: bool,
    pending_action: Option<&'static str>,
    update_state: UpdateState,
    update_receiver: Option<Receiver<UpdateMessage>>,
    update_check_started: bool,
    pending_update_install: bool,
}

fn first_valid_installed_root(
    roots: impl IntoIterator<Item = PathBuf>,
    is_valid_install: impl Fn(&std::path::Path) -> bool,
) -> String {
    for root in roots {
        if is_valid_install(&root) {
            return root.to_string_lossy().to_string();
        }
    }
    String::new()
}

fn detect_installed_root() -> String {
    let mut guesses = Vec::new();
    if let Some(value) = std::env::var_os("DINO_ORIGINAL_ROOT") {
        if !value.is_empty() {
            guesses.push(PathBuf::from(value));
        }
    }
    if let Some(value) = std::env::var_os("ProgramFiles") {
        guesses.push(PathBuf::from(value).join("LilacAnime"));
    }
    if let Some(value) = std::env::var_os("LOCALAPPDATA") {
        guesses.push(PathBuf::from(value).join("Programs").join("LilacAnime"));
    }
    guesses.push(PathBuf::from(r"D:\LilacAnime"));
    first_valid_installed_root(guesses, |guess| transaction::installed_root(guess).is_ok())
}

impl Default for DinoUi {
    fn default() -> Self {
        let root = detect_installed_root();
        let path_draft = root.clone();
        let has_root = !root.is_empty();
        diagnostics::write("Electron-style native Rust management UI initialized");
        let mut activity = vec!["DinoPatch Rust 관리자가 시작됐습니다.".into()];
        let update_result = updater_engine::read_update_result_for_manager();
        if let Some(message) = &update_result {
            activity.push(message.clone());
        }
        Self {
            root,
            root_selected_by_user: false,
            status: if has_root {
                transaction::Status::new("SOURCE_FOUND", "", "공식 원본 구조를 확인하고 있습니다.")
            } else {
                transaction::Status::new("NO_SOURCE", "", "원본 폴더를 선택해 주세요.")
            },
            auto_enabled: true,
            draft_patch_selection: patch_set::PatchSelection::DEFAULT,
            confirmed_patch_selection: patch_set::PatchSelection::DEFAULT,
            busy: false,
            operation_state: "대기 중".into(),
            task_generation: 0,
            activity,
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
            show_advanced: update_result.is_some(),
            show_update_details: false,
            pending_action: None,
            update_state: UpdateState::Checking,
            update_receiver: None,
            update_check_started: false,
            pending_update_install: false,
        }
    }
}

impl DinoUi {
    // Persist only explicit preferences. Never persist the installed root,
    // draft patch selection, backup identifiers, or transaction status.
    fn with_storage(storage: Option<&dyn eframe::Storage>) -> Self {
        let mut app = Self::default();
        if let Some(storage) = storage {
            app.show_advanced = storage
                .get_string(ADVANCED_PANEL_KEY)
                .is_some_and(|raw| raw == "true");
            app.auto_enabled = parse_auto_apply_setting(
                storage.get_string(AUTO_APPLY_KEY).as_deref(),
            );
            app.confirmed_patch_selection = parse_confirmed_patch_selection(
                storage.get_string(CONFIRMED_PATCH_SELECTION_KEY).as_deref(),
            );
            app.draft_patch_selection = app.confirmed_patch_selection;
        }
        app
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
            self.root_selected_by_user = false;
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

    fn requested_backup_id(&self, kind: &str) -> Option<String> {
        (kind == "백업 복원")
            .then(|| self.selected_backup_id.clone())
            .flatten()
    }

    fn task_is_current(&self, root: &str, generation: u64) -> bool {
        self.task_generation == generation && self.root.trim() == root
    }

    fn can_restore_selected_backup(&self) -> bool {
        !self.busy
            && matches!(self.status.status.as_str(), "APPLIED" | "ALREADY_APPLIED")
            && self.selected_backup().is_some_and(|item| item.restorable)
    }

    fn auto_apply_config_block(&self) -> Option<&'static str> {
        automatic_apply_config_block(
            self.auto_enabled,
            self.busy,
            !self.root.trim().is_empty(),
            self.root_selected_by_user,
            self.draft_patch_selection,
            self.confirmed_patch_selection,
        )
    }

    fn can_apply_confirmed_selection(&self) -> bool {
        let Some(desired) = self.confirmed_patch_selection.as_patch_set() else { return false; };
        let different_from_installed = self.status.status == "UNPATCHED"
            || (self.status.status == "APPLIED"
                && self.status.composition_id.as_deref()
                    .and_then(|id| patch_set::PatchSet::parse_id(id).ok())
                    .is_some_and(|installed| installed != desired));
        !self.busy
            && !self.root.trim().is_empty()
            && self.draft_patch_selection == self.confirmed_patch_selection
            && self.confirmed_patch_selection.manager_install_supported()
            && different_from_installed
    }

    fn apply_button_reason(&self) -> &'static str {
        if self.busy {
            "현재 작업이 끝난 뒤 다시 시도하세요."
        } else if self.draft_patch_selection != self.confirmed_patch_selection {
            "선택 구성을 먼저 확정하세요. 확정만으로 파일을 변경하지 않습니다."
        } else if self.confirmed_patch_selection.is_empty() {
            "선택된 패치가 없습니다. 전체 해제는 별도 해제 버튼에서 확인하세요."
        } else if !self.confirmed_patch_selection.manager_install_supported() {
            "선택한 패치 조합은 검증된 관리자 설치 대상이 아닙니다."
        } else if self.root.trim().is_empty() {
            "LilacAnime 설치 경로를 먼저 선택하세요."
        } else if self.status.status == "APPLIED"
            && self.status.composition_id.as_deref()
                .and_then(|id| patch_set::PatchSet::parse_id(id).ok())
                .is_some_and(|installed| self.confirmed_patch_selection.as_patch_set() == Some(installed)) {
            "선택한 조합이 이미 적용돼 있습니다."
        } else if !matches!(self.status.status.as_str(), "UNPATCHED" | "APPLIED") {
            "호환되는 원본 또는 검증된 적용 상태를 확인한 뒤 진행할 수 있습니다."
        } else {
            ""
        }
    }

    fn confirm_draft_selection(&mut self) {
        if self.busy || self.draft_patch_selection == self.confirmed_patch_selection {
            return;
        }
        self.confirmed_patch_selection = self.draft_patch_selection;
        let id = self.confirmed_patch_selection.id();
        self.record(format!("목표 패치 구성 {id}을(를) 확정했습니다. 파일은 변경하지 않았습니다."));
        self.operation_state = if self.confirmed_patch_selection.manager_install_supported() {
            "목표 구성 저장 · 패치 적용은 별도 확인이 필요합니다".into()
        } else if self.confirmed_patch_selection.is_empty() {
            "목표 구성 저장 · 자동 해제는 실행하지 않습니다".into()
        } else {
            "목표 구성 저장 · 관리자 설치 미지원 조합입니다".into()
        };
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
                self.show_advanced = true;
                self.show_log = true;
            }
        }
    }

    fn enqueue(&mut self, kind: &'static str) {
        if self.busy || self.root.trim().is_empty() {
            return;
        }
        if kind == "자동 검사" {
            if let Some(reason) = self
                .auto_apply_config_block()
                .or_else(|| automatic_apply_status_block(&self.status.status))
            {
                self.operation_state = reason.into();
                return;
            }
        }
        if kind == "디노 패치 수동 적용" && !self.can_apply_confirmed_selection() {
            self.record("현재 확정된 패치 선택은 설치할 수 없어 적용을 시작하지 않았습니다.");
            self.operation_state = self.apply_button_reason().into();
            return;
        }
        if kind == "백업 복원" && !self.can_restore_selected_backup() {
            self.record("복원 가능한 백업이 선택되지 않아 작업을 시작하지 않았습니다.");
            self.operation_state = "안전 중단 · 복원 가능한 백업을 선택하세요".into();
            return;
        }

        self.busy = true;
        self.operation_state = "작업 요청 접수".into();
        self.record(format!("{kind} 작업 요청 접수"));
        self.task_generation = self.task_generation.wrapping_add(1);
        let generation = self.task_generation;
        let root_label = self.root.trim().to_owned();
        let root = PathBuf::from(&root_label);
        let backup_id = self.requested_backup_id(kind);
        let confirmed_selection = self.confirmed_patch_selection;
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
                        "자동 검사" => {
                            let checked = transaction::inspect(&root);
                            if automatic_apply_needed(&checked, confirmed_selection) {
                                // The transaction engine repeats its complete SHA-256 and
                                // recovery checks before writing; this read-only inspect keeps
                                // automatic application from doing work for an already patched,
                                // unsupported, conflicting, or manually uninstalled source.
                                match confirmed_selection.as_patch_set() {
                                    Some(set) => transaction::apply_selection(&root, set, false).map(|_| ()),
                                    None => Err(crate::fail("자동 적용할 패치 조합이 확정되지 않았습니다.")),
                                }
                            } else {
                                Ok(())
                            }
                        }
                        "디노 패치 수동 적용" => match confirmed_selection.as_patch_set() {
                            Some(set) => transaction::apply_selection(&root, set, true).map(|_| ()),
                            None => Err(crate::fail("적용할 패치 조합이 선택되지 않았습니다.")),
                        },
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
            self.show_advanced = true;
            self.show_log = true;
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
                            self.show_advanced = true;
                            self.show_log = true;
                        } else if let Some(error) = event.status_error {
                            self.record(format!("{} 후 상태 재검사 실패: {error}", event.name));
                            self.operation_state = completed_operation_state(
                                Some(&error), Some(&self.status)
                            ).into();
                            self.show_advanced = true;
                            self.show_log = true;
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
            self.show_advanced = true;
            self.show_log = true;
        }
    }

    fn start_update_check(&mut self) {
        if self.update_check_started {
            return;
        }
        self.update_check_started = true;
        self.update_state = UpdateState::Checking;
        if let Err(error) = updater_engine::validate_online_update_installation() {
            self.record(format!("온라인 업데이트를 사용할 수 없습니다: {error}"));
            self.update_state = UpdateState::Failed(error);
            return;
        }
        if release_update::current_target() != release_update::Target::WindowsX64 {
            self.update_state = UpdateState::Failed("자동 업데이트는 Windows x64에서만 지원됩니다.".into());
            return;
        }
        let installed_version = updater_engine::compiled_manager_version();
        let (sender, receiver) = mpsc::channel();
        self.update_receiver = Some(receiver);
        let spawned = std::thread::Builder::new()
            .name("dino-release-check".into())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(|| {
                    release_update::check_latest_release(&installed_version)
                })
                .unwrap_or_else(|_| Err("GitHub 업데이트 확인 중 내부 오류가 발생했습니다.".into()));
                let _ = sender.send(UpdateMessage::CheckFinished(outcome));
            });
        if let Err(error) = spawned {
            self.update_receiver = None;
            self.update_state = UpdateState::Failed(format!("업데이트 확인 스레드를 시작하지 못했습니다: {error}"));
        }
    }

    fn restart_update_check(&mut self) {
        if self.busy {
            return;
        }
        self.update_check_started = false;
        self.start_update_check();
    }

    fn poll_update(&mut self) {
        let mut events = Vec::new();
        let mut disconnected = false;
        if let Some(receiver) = self.update_receiver.as_ref() {
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
                UpdateMessage::CheckFinished(Ok(Some(candidate))) => {
                    self.update_state = UpdateState::Available(candidate);
                }
                UpdateMessage::CheckFinished(Ok(None)) => {
                    self.update_state = UpdateState::UpToDate;
                }
                UpdateMessage::CheckFinished(Err(error)) => {
                    self.record(format!("업데이트 확인 실패: {error}"));
                    self.update_state = UpdateState::Failed(error);
                }
                UpdateMessage::DownloadProgress { tag, received, total } => {
                    if let UpdateState::Downloading { candidate, .. } = &self.update_state {
                        if candidate.tag == tag {
                            self.update_state = UpdateState::Downloading {
                                candidate: candidate.clone(),
                                received,
                                total,
                            };
                        }
                    }
                }
                UpdateMessage::DownloadFinished { candidate, result } => match result {
                    Ok(digest) => {
                        self.record(format!("{} 다운로드와 GitHub API SHA-256 확인 완료", candidate.tag));
                        self.update_state = UpdateState::ReadyToInstall { candidate, digest };
                    }
                    Err(error) => {
                        self.record(format!("{} 다운로드 실패: {error}", candidate.tag));
                        self.update_state = UpdateState::Failed(error);
                        self.show_advanced = true;
                        self.show_log = true;
                    }
                },
            }
        }
        if disconnected {
            self.update_receiver = None;
            if matches!(&self.update_state, UpdateState::Checking | UpdateState::Downloading { .. }) {
                let error = "업데이트 작업이 응답 없이 종료됐습니다.".to_owned();
                self.record(error.clone());
                self.update_state = UpdateState::Failed(error);
            }
        }
    }

    fn start_update_download(&mut self, candidate: release_update::ReleaseCandidate) {
        if self.busy || matches!(&self.update_state, UpdateState::Downloading { .. } | UpdateState::Installing) {
            return;
        }
        self.update_state = UpdateState::Downloading {
            candidate: candidate.clone(),
            received: 0,
            total: None,
        };
        self.record(format!("{} 관리자 EXE 다운로드 시작", candidate.tag));
        let (sender, receiver) = mpsc::channel();
        self.update_receiver = Some(receiver);
        let worker_sender = sender.clone();
        let spawned = std::thread::Builder::new()
            .name("dino-manager-update-download".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let staged = updater_engine::stage_path_for_current_manager()?;
                    release_update::download_asset_to(&candidate, &staged, |received, total| {
                        let _ = worker_sender.send(UpdateMessage::DownloadProgress {
                            tag: candidate.tag.clone(),
                            received,
                            total,
                        });
                    })
                }))
                .unwrap_or_else(|_| Err("관리자 다운로드 작업에서 내부 오류가 발생했습니다.".into()));
                let _ = sender.send(UpdateMessage::DownloadFinished { candidate, result });
            });
        if let Err(error) = spawned {
            self.update_receiver = None;
            self.update_state = UpdateState::Failed(format!("다운로드 작업을 시작하지 못했습니다: {error}"));
        }
    }

    fn update_confirmation(&mut self, ctx: &egui::Context) {
        if !self.pending_update_install {
            return;
        }
        let UpdateState::ReadyToInstall { candidate, digest } = &self.update_state else {
            self.pending_update_install = false;
            return;
        };
        let candidate = candidate.clone();
        let digest = digest.clone();
        let mut cancel = false;
        let mut approve = false;
        egui::Window::new("DinoPatch 업데이트 설치 확인")
            .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
            .resizable(false)
            .collapsible(false)
            .default_width(440.0)
            .max_width((ctx.content_rect().width() - 24.0).max(260.0))
            .show(ctx, |ui| {
                heading(ui, &format!("{} 설치", candidate.title));
                label(ui, format!("버전: {}", candidate.tag));
                label(ui, "검증: 고정 GitHub HTTPS 저장소와 API SHA-256 일치");
                label(ui, format!("SHA-256: {digest}"));
                ui.add_space(4.0);
                ui.add(
                    egui::Label::new(
                        RichText::new("승인하면 관리자가 닫히고, 기존 EXE를 백업한 뒤 검증된 파일로 교체합니다. 새 관리자의 시작 검사가 실패하면 이전 EXE를 복원합니다.")
                            .size(BODY_TEXT_SIZE)
                            .color(rgb(TEXT)),
                    )
                    .wrap(),
                );
                ui.add_space(8.0);
                ui.horizontal_wrapped(|ui| {
                    cancel = action(ui, "취소", ButtonTone::Secondary, true);
                    approve = action(ui, "승인 후 설치", ButtonTone::Primary, !self.busy);
                });
            });
        if cancel {
            self.pending_update_install = false;
        } else if approve {
            self.pending_update_install = false;
            match updater_engine::approve_and_launch_update(&candidate, &digest, true) {
                Ok(()) => {
                    self.record(format!("{} 설치 승인 완료 · updater에 안전 교체를 요청했습니다", candidate.tag));
                    self.update_state = UpdateState::Installing;
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
                Err(error) => {
                    self.record(format!("업데이트 설치 시작 실패: {error}"));
                    self.update_state = UpdateState::Failed(error);
                    self.show_advanced = true;
                    self.show_log = true;
                }
            }
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
        let current = match inspect_monitored_archive(&archive) {
            ArchiveWatch::Available(size, modified) => (size, modified),
            ArchiveWatch::Missing => {
                let changed = self.last_archive_change.take().is_some();
                if changed || self.status.status == "SOURCE_FOUND" {
                    self.status = transaction::Status::new(
                        "SOURCE_MISSING",
                        &self.status.version,
                        "선택한 폴더에서 resources/app.asar를 찾을 수 없습니다.",
                    );
                    self.operation_state = "원본 확인 대기 · 자동 적용을 보류했습니다".into();
                    self.record("선택한 원본 경로에 resources/app.asar가 없습니다.");
                }
                return;
            }
            ArchiveWatch::Invalid(reason) => {
                let changed = self.last_archive_change.take().is_some();
                if changed || self.status.status == "SOURCE_FOUND" {
                    self.status = transaction::Status::new(
                        "PARTIAL_OR_UNKNOWN",
                        &self.status.version,
                        reason.clone(),
                    );
                    self.operation_state = "원본 확인 실패 · 자동 적용을 보류했습니다".into();
                    self.record(reason);
                }
                return;
            }
        };
        if !self.root_selected_by_user {
            self.operation_state = self
                .auto_apply_config_block()
                .unwrap_or("설치 경로를 직접 확인하세요")
                .into();
            return;
        }
        let changed = self.last_archive_change.as_ref() != Some(&current);
        self.last_archive_change = Some(current);
        let automatic_apply_ready = self.auto_apply_config_block().is_none()
            && automatic_apply_status_block(&self.status.status).is_none()
            && automatic_apply_needed(&self.status, self.confirmed_patch_selection);
        match automatic_monitor_operation(&self.status.status, changed, automatic_apply_ready) {
            Some("원본 다시 확인") => self.enqueue("원본 다시 확인"),
            Some("자동 검사") => self.enqueue("자동 검사"),
            _ => {
                if let Some(reason) = self
                    .auto_apply_config_block()
                    .or_else(|| automatic_apply_status_block(&self.status.status))
                {
                    self.operation_state = reason.into();
                }
            }
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
            self.root_selected_by_user = true;
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

    fn status_summary(&self) -> String {
        if self.busy {
            self.operation_state.as_str()
        } else {
            match self.status.status.as_str() {
                "APPLIED" | "ALREADY_APPLIED" => "통합 검색·공급원 전환 · 적용됨",
                "UNPATCHED" | "ALREADY_UNPATCHED" if self.status.manually_uninstalled => {
                    "수동 해제 상태 · 원할 때 다시 적용할 수 있습니다."
                }
                "UNPATCHED" | "ALREADY_UNPATCHED" => {
                    "호환성 검사 완료 · 패치를 적용할 수 있습니다."
                }
                "SOURCE_MISSING" => "원본 파일을 찾을 수 없습니다 · resources/app.asar",
                "CONFLICT" => "파일 충돌 · 사용자 수정 파일을 보호했습니다.",
                "UNSUPPORTED" => "비호환 소스 · 안전을 위해 적용을 차단했습니다.",
                "PARTIAL_OR_UNKNOWN" => "상태 확인 필요 · 원본과 백업을 유지했습니다.",
                "NO_SOURCE" => "원본 폴더를 선택해 안전 검사를 시작하세요.",
                "SOURCE_FOUND" => "원본이 확인됐습니다. 상태 검사를 실행하세요.",
                _ => next_step(&self.status, false),
            }
        }
        .to_owned()
    }

    fn installation_path_section(&mut self, ui: &mut Ui) {
        let path_text = if self.root.trim().is_empty() {
            "선택된 원본 폴더 없음".to_owned()
        } else {
            display_installation_path(self.root.trim())
        };
        let mut choose_folder = false;
        let mut edit_path = false;
        ui.horizontal_wrapped(|row| {
            let spacing = row.spacing().item_spacing.x;
            let path_width = (row.available_width()
                - 70.0
                - 80.0
                - 88.0
                - 88.0
                - spacing * 4.0
                - 24.0)
                .max(48.0);
            row.add_sized(
                Vec2::new(70.0, BUTTON_HEIGHT),
                egui::Label::new(
                    RichText::new("설치 경로")
                        .size(BODY_TEXT_SIZE)
                        .color(rgb(MUTED)),
                )
                .truncate(),
            );
            path_label(row, &path_text, path_width, !self.root.trim().is_empty());
            if action_button(
                row,
                "경로 복사",
                ButtonTone::Secondary,
                !self.root.trim().is_empty(),
                Vec2::new(80.0, BUTTON_HEIGHT),
            )
            .clicked()
            {
                row.ctx().copy_text(self.root.clone());
            }
            choose_folder = action_button(
                row,
                "폴더 선택",
                ButtonTone::Secondary,
                !self.busy,
                Vec2::new(88.0, BUTTON_HEIGHT),
            )
            .clicked();
            edit_path = action_button(
                row,
                "직접 입력",
                ButtonTone::Secondary,
                !self.busy,
                Vec2::new(88.0, BUTTON_HEIGHT),
            )
            .clicked();
        });
        if choose_folder {
            self.choose_folder();
        }
        if edit_path {
            self.path_draft = self.root.clone();
            self.show_path_editor = true;
        }
    }

    fn path_editor_window(&mut self, ctx: &egui::Context) {
        if !self.show_path_editor {
            return;
        }
        let mut open = self.show_path_editor;
        let mut close_after_action = false;
        let viewport = ctx.content_rect().size();
        egui::Window::new("설치 경로 변경")
            .id(egui::Id::new("dino-installation-path-editor"))
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .default_size(Vec2::new(480.0, 150.0))
            .max_size(Vec2::new(
                (viewport.x - 24.0).max(280.0),
                (viewport.y - 24.0).max(130.0),
            ))
            .show(ctx, |ui| {
                label(ui, "새 경로를 검사하기 전까지 현재 원본은 유지됩니다.");
                ui.add_enabled(
                    !self.busy,
                    egui::TextEdit::singleline(&mut self.path_draft)
                        .hint_text(r"D:\LilacAnime")
                        .desired_width(ui.available_width()),
                );
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    let check = action(
                        ui,
                        "경로 검사",
                        ButtonTone::Primary,
                        !self.busy && !self.path_draft.trim().is_empty(),
                    );
                    let cancel = action(ui, "취소", ButtonTone::Secondary, !self.busy);
                    if check {
                        let candidate = self.path_draft.trim().to_owned();
                        if self.root != candidate {
                            self.set_root(candidate);
                            self.root_selected_by_user = true;
                            self.status = transaction::Status::new(
                                "SOURCE_FOUND",
                                "",
                                "새 설치 폴더를 선택했습니다. 구조 검사 중입니다.",
                            );
                        }
                        else {
                            self.root_selected_by_user = true;
                        }
                        self.last_archive_change = None;
                        close_after_action = true;
                        self.enqueue("원본 다시 확인");
                    } else if cancel {
                        self.path_draft = self.root.clone();
                        close_after_action = true;
                    }
                });
            });
        self.show_path_editor = open && !close_after_action;
    }

    fn patch_actions_section(&mut self, ui: &mut Ui) {
        heading(ui, "패치 관리");
        let (_, support_ink) = status_style(StatusTone::Preview);
        let support_summary = patch_support_summary(
            patch_set::PATCH_CATALOG
                .iter()
                .map(|feature| feature.availability),
        );
        ui.add_sized(
            Vec2::new(ui.available_width(), 16.0),
            egui::Label::new(
                RichText::new(support_summary)
                    .size(HELP_TEXT_SIZE)
                    .strong()
                    .color(rgb(support_ink)),
            )
            .truncate(),
        )
        .on_hover_text("각 패치 상태는 현재 설치 기록으로 확인하며, 체크한 선택 구성은 별도로 확정해야 합니다.");
        let compact = ui.ctx().content_rect().height() <= 400.0;
        egui::ScrollArea::vertical()
            .id_salt("native-patch-catalog-list")
            .max_height(patch_list_max_height(ui.ctx().content_rect().height()))
            .auto_shrink([false, true])
            .show(ui, |list| {
                list.spacing_mut().interact_size.y = if compact { 20.0 } else { 22.0 };
                list.spacing_mut().item_spacing.y = if compact { 2.0 } else { 4.0 };
                for feature in patch_set::PATCH_CATALOG {
                    let selected_before = self.draft_patch_selection.contains(feature.id);
                    let mut selected = selected_before;
                    let actual_status = actual_patch_status(feature.id, &self.status).0;
                    let (row_status, tone) = patch_row_status(feature, &self.status);
                    let availability = match feature.availability {
                        patch_set::FeatureAvailability::ManagerSelectable => "검증된 선택 조합 설치 지원",
                        patch_set::FeatureAvailability::PreviewOnly => "미리보기 전용 · 설치 미지원",
                    };
                    list.horizontal_wrapped(|row| {
                        row.spacing_mut().item_spacing.x = 4.0;
                        let response = row.checkbox(
                            &mut selected,
                            RichText::new(format!(
                                "{} · {}",
                                feature.id.code(),
                                feature.display_name
                            ))
                            .size(BODY_TEXT_SIZE)
                            .strong()
                            .color(rgb(TEXT)),
                        );
                        compact_pill(row, row_status, tone);
                        response
                    })
                    .response
                    .on_hover_text(format!(
                        "체크 여부는 선택 구성입니다. 실제 설치 상태: {actual_status}. 지원 상태: {availability}. {}",
                        feature.description,
                    ));
                    if selected != selected_before {
                        self.draft_patch_selection =
                            self.draft_patch_selection.with(feature.id, selected);
                    }
                }
            });
        let selection_id = self.draft_patch_selection.id();
        let selection_state = if self.draft_patch_selection != self.confirmed_patch_selection {
            "변경 대기"
        } else if self.draft_patch_selection.is_empty() {
            "저장됨 · 적용 안 함"
        } else if !self.draft_patch_selection.manager_install_supported() {
            "저장됨 · 설치 미지원"
        } else {
            "저장됨"
        };
        let target_summary = patch_selection_summary(
            self.draft_patch_selection,
            selection_state,
            &patch_set::PATCH_CATALOG,
        );
        ui.add_sized(
            Vec2::new(ui.available_width(), 16.0),
            egui::Label::new(
                RichText::new(&target_summary)
                    .size(HELP_TEXT_SIZE)
                    .color(rgb(MUTED)),
            )
            .truncate(),
        )
        .on_hover_text(format!(
            "저장된 선택: {} · 현재 선택: {} · 체크박스 변경은 파일을 바꾸지 않습니다.",
            self.confirmed_patch_selection.id(),
            selection_id
        ));
        let has_root = !self.root.trim().is_empty();
        let selection_is_pending = self.draft_patch_selection != self.confirmed_patch_selection;
        let apply_label = if selection_is_pending {
            "선택 저장"
        } else if self.confirmed_patch_selection.is_empty() {
            "선택 없음"
        } else if !self.confirmed_patch_selection.manager_install_supported() {
            "설치 미지원"
        } else {
            "패치 적용"
        };
        let apply_enabled = if selection_is_pending {
            !self.busy
        } else {
            self.can_apply_confirmed_selection()
        };
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            if action_button(
                ui,
                "상태 검사",
                ButtonTone::Secondary,
                !self.busy && has_root,
                Vec2::new(72.0, BUTTON_HEIGHT),
            )
            .clicked()
            {
                self.enqueue("원본 다시 확인");
            }
            let apply_response = action_button(
                ui,
                apply_label,
                ButtonTone::Primary,
                apply_enabled,
                Vec2::new(78.0, BUTTON_HEIGHT),
            );
            apply_response.clone().on_hover_text(if selection_is_pending {
                "선택한 구성을 저장합니다. 파일 적용은 지원 조합을 별도로 확인한 뒤 진행합니다."
            } else {
                self.apply_button_reason()
            });
            if apply_response.clicked() {
                if selection_is_pending {
                    self.confirm_draft_selection();
                } else {
                    self.ask("디노 패치 수동 적용");
                }
            }
            if action_button(
                ui,
                "패치 해제",
                ButtonTone::Danger,
                !self.busy
                    && has_root
                    && matches!(
                        self.status.status.as_str(),
                        "APPLIED" | "ALREADY_APPLIED"
                    ),
                Vec2::new(76.0, BUTTON_HEIGHT),
            )
            .clicked()
            {
                self.ask("디노 패치 해제");
            }
        });
    }

    fn backup_item_row(&mut self, ui: &mut Ui, backup: &BackupItem) {
        ui.horizontal(|row| {
            row.radio_value(
                &mut self.selected_backup_id,
                Some(backup.id.clone()),
                "",
            );
            let status_width = 66.0;
            let gap = row.spacing().item_spacing.x;
            let details_width = (row.available_width() - status_width - gap).max(48.0);
            row.vertical(|details| {
                details.add_sized(
                    Vec2::new(details_width, 20.0),
                    egui::Label::new(
                        RichText::new(&backup.id)
                            .size(BODY_TEXT_SIZE)
                            .strong()
                            .color(rgb(TEXT)),
                    )
                    .truncate(),
                );
                let date = format!("v{} · {}", backup.version, backup.created_at);
                details.add_sized(
                    Vec2::new(details_width, 19.0),
                    egui::Label::new(
                        RichText::new(date)
                            .size(HELP_TEXT_SIZE)
                            .color(rgb(MUTED)),
                    )
                    .truncate(),
                );
            });
            row.with_layout(Layout::right_to_left(Align::Center), |status| {
                let (fill, color) = status_style(if backup.restorable {
                    StatusTone::Good
                } else {
                    StatusTone::Bad
                });
                Frame::new()
                    .fill(rgb(fill))
                    .corner_radius(CornerRadius::same(8))
                    .inner_margin(Margin::symmetric(6, 4))
                    .show(status, |status| {
                        status.label(
                            RichText::new(if backup.restorable {
                                "복원 가능"
                            } else {
                                "복원 불가"
                            })
                            .size(HELP_TEXT_SIZE)
                            .strong()
                            .color(rgb(color)),
                        );
                    });
            });
        });
    }

    fn backup_restore_section(&mut self, ui: &mut Ui, panel_content_height: f32) {
        let panel_content_top = ui.min_rect().top();
        let list_is_current = self.backup_list_root.as_deref() == Some(self.root.trim());
        let items = if list_is_current {
            self.backup_items.clone()
        } else {
            Vec::new()
        };
        let error = list_is_current && self.backup_error.is_some();

        heading(ui, "백업 · 복원");
        let original_missing = self.root.trim().is_empty()
            || self.status.status == "SOURCE_MISSING";
        let summary = if error {
            "백업 조회 오류 · 진단에서 자세히 확인".to_owned()
        } else if items.is_empty() && original_missing {
            "원본 연결 후 백업을 확인할 수 있습니다.".to_owned()
        } else if !list_is_current {
            "설치 경로가 변경됨 · 새로고침 필요".to_owned()
        } else if items.is_empty() {
            "복원 가능한 백업이 없습니다".to_owned()
        } else {
            format!("백업 {}개 · 목록에서 선택", items.len())
        };
        let summary_height = if items.is_empty() { 20.0 } else { 18.0 };
        if items.is_empty() {
            let used_height = ui.cursor().top() - panel_content_top;
            let empty_state_offset = empty_state_vertical_offset(
                panel_content_height,
                used_height,
                summary_height,
                BUTTON_HEIGHT,
                ui.spacing().item_spacing.y,
            );
            if empty_state_offset > 1.0 {
                ui.add_space(empty_state_offset);
            }
        }
        let summary_color = if error {
            rgb(ERROR_TEXT)
        } else if items.is_empty() {
            rgb(TEXT)
        } else {
            rgb(MUTED)
        };
        let summary_text = RichText::new(summary)
            .size(if items.is_empty() {
                BODY_TEXT_SIZE
            } else {
                HELP_TEXT_SIZE
            })
            .color(summary_color);
        let summary_text = if items.is_empty() {
            summary_text.strong()
        } else {
            summary_text
        };
        ui.add_sized(
            Vec2::new(ui.available_width(), summary_height),
            egui::Label::new(summary_text).truncate(),
        );

        if !items.is_empty() {
            let selected = self.selected_backup().cloned();
            let selector_text = selected
                .as_ref()
                .map(|backup| {
                    format!("{} · v{}", compact_backup_id(&backup.id), backup.version)
                })
                .unwrap_or_else(|| "백업 선택".to_owned());
            ui.add_enabled_ui(list_is_current && !self.busy, |ui| {
                egui::ComboBox::from_id_salt("native-backup-selection")
                    .selected_text(selector_text)
                    .width(ui.available_width())
                    .show_ui(ui, |options| {
                        for backup in &items {
                            let availability = if backup.restorable {
                                "복원 가능"
                            } else {
                                "복원 불가"
                            };
                            let option = format!(
                                "{} · v{} · {}",
                                compact_backup_id(&backup.id),
                                backup.version,
                                availability
                            );
                            options.selectable_value(
                                &mut self.selected_backup_id,
                                Some(backup.id.clone()),
                                option,
                            );
                        }
                    });
            });
            let selected_summary = selected
                .map(|backup| {
                    format!(
                        "v{} · {} · {}",
                        backup.version,
                        backup.created_at,
                        if backup.restorable {
                            "복원 가능"
                        } else {
                            "복원 불가"
                        }
                    )
                })
                .unwrap_or_else(|| "선택 백업의 버전·날짜·복원 상태가 표시됩니다.".to_owned());
            ui.add_sized(
                Vec2::new(ui.available_width(), 17.0),
                egui::Label::new(
                    RichText::new(selected_summary)
                        .size(HELP_TEXT_SIZE)
                        .color(rgb(MUTED)),
                )
                .truncate(),
            );
            ui.add_space(2.0);
        }
        if list_is_current && !items.is_empty() && !self.can_restore_selected_backup() {
            let reason = if self.busy {
                "다른 작업이 끝날 때까지 복원할 수 없습니다."
            } else if self.selected_backup_id.is_none() {
                "복원 가능한 백업을 선택하세요."
            } else if !matches!(self.status.status.as_str(), "APPLIED" | "ALREADY_APPLIED") {
                "패치 적용 상태를 확인한 뒤 복원할 수 있습니다."
            } else {
                "선택한 백업은 복원할 수 없습니다."
            };
            ui.add_sized(
                Vec2::new(ui.available_width(), 16.0),
                egui::Label::new(
                    RichText::new(reason)
                        .size(HELP_TEXT_SIZE)
                        .color(rgb(MUTED)),
                )
                .truncate(),
            );
        }

        let used_content_height = ui.cursor().top() - panel_content_top;
        let action_gap = (panel_content_height - used_content_height - BUTTON_HEIGHT).max(0.0);
        if action_gap > 1.0 {
            ui.add_space(action_gap);
        }
        ui.horizontal_wrapped(|ui| {
            if action(
                ui,
                "새로고침",
                ButtonTone::Secondary,
                !self.busy && !self.root.trim().is_empty(),
            ) {
                self.enqueue("백업 목록 새로 고침");
            }
            if action(
                ui,
                "선택 백업 복원",
                ButtonTone::Danger,
                self.can_restore_selected_backup(),
            ) {
                self.ask("백업 복원");
            }
        });
    }

    fn settings_section(&mut self, ui: &mut Ui) {
        let changed = ui
            .add_enabled(
                !self.busy,
                egui::Checkbox::new(
                    &mut self.auto_enabled,
                    RichText::new("자동 적용")
                        .size(BODY_TEXT_SIZE)
                        .strong()
                        .color(rgb(TEXT)),
                ),
            )
            .on_hover_text(
                "호환되는 공식 v0.5.65 원본을 확인하면 저장된 선택 구성을 자동으로 유지합니다. 검증된 일곱 조합만 적용하며, 임시 선택·미지원 조합·충돌·검증 실패에서는 자동 적용을 보류합니다.",
            )
            .changed();
        if changed {
            if self.auto_enabled {
                self.last_archive_change = None;
                self.operation_state = "자동 적용 켬 · 호환성과 백업을 검사합니다".into();
            } else {
                self.operation_state = "자동 적용 끔 · 수동 작업은 사용할 수 있습니다".into();
            }
            self.record(if self.auto_enabled {
                "자동 적용을 켰습니다. 지원되는 확정 조합만 검사합니다."
            } else {
                "자동 적용을 껐습니다. 수동 조작은 계속 사용할 수 있습니다."
            });
        }
    }

    fn diagnostics_section(&mut self, ui: &mut Ui, ctx: &egui::Context) {
        self.result_card(ui);
        ui.add_space(8.0);
        heading(ui, "최근 작업");
        let log_path = diagnostics::log_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "로그 경로 확인 불가".to_owned());
        if path_action_row(ui, &log_path, "경로 복사", 82.0, true, false) {
            ctx.copy_text(log_path);
        }
        if self.activity.is_empty() {
            label(ui, "기록된 작업이 없습니다.");
        } else {
            let start = if self.show_log {
                0
            } else {
                self.activity.len().saturating_sub(8)
            };
            egui::ScrollArea::vertical()
                .id_salt("native-diagnostic-log")
                .max_height(180.0)
                .stick_to_bottom(self.show_log)
                .show(ui, |ui| {
                    for line in &self.activity[start..] {
                        ui.add(
                            egui::Label::new(
                                RichText::new(line)
                                    .font(FontId::new(HELP_TEXT_SIZE, FontFamily::Monospace))
                                    .color(rgb(MUTED)),
                            )
                            .wrap(),
                        );
                    }
                });
            let toggle = if self.show_log {
                "최근 8개만"
            } else {
                "전체 기록"
            };
            if action(ui, toggle, ButtonTone::Secondary, true) {
                self.show_log = !self.show_log;
            }
        }
        ui.add_space(8.0);
        heading(ui, "백업 상세");
        if self.backup_list_root.as_deref() != Some(self.root.trim()) {
            label(ui, "현재 설치 경로의 백업 목록이 아직 조회되지 않았습니다.");
        } else if let Some(error) = &self.backup_error {
            ui.add(
                egui::Label::new(
                    RichText::new(error)
                        .size(HELP_TEXT_SIZE)
                        .color(rgb(ERROR_TEXT)),
                )
                .wrap(),
            );
        } else if self.backup_items.is_empty() {
            label(ui, "복원 가능한 백업이 없습니다.");
        } else {
            for backup in self.backup_items.clone() {
                self.backup_item_row(ui, &backup);
            }
        }
        egui::CollapsingHeader::new("관련 릴리스")
            .default_open(false)
            .show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                if action(ui, "LilacAnime", ButtonTone::Secondary, true) {
                    ctx.open_url(egui::OpenUrl::new_tab(
                        "https://github.com/whispelyn-byte/LilacAnime-desktop/releases",
                    ));
                }
                if action(ui, "DinoPatch", ButtonTone::Secondary, true) {
                    ctx.open_url(egui::OpenUrl::new_tab(
                        format!("{}/releases", release_update::RELEASES_BASE),
                    ));
                }
            });
            });
    }

    fn update_section(&mut self, ui: &mut Ui, _ctx: &egui::Context) {
        let (state, tone) = match &self.update_state {
            UpdateState::Checking => ("업데이트 확인 중".to_owned(), StatusTone::Warning),
            UpdateState::UpToDate => ("최신 버전".to_owned(), StatusTone::Good),
            UpdateState::Available(candidate) => {
                (format!("새 버전 {}", candidate.tag), StatusTone::Preview)
            }
            UpdateState::Downloading {
                received, total, ..
            } => {
                let progress = total
                    .filter(|total| *total > 0)
                    .map(|total| format!("다운로드 {}%", (received.saturating_mul(100) / total).min(100)))
                    .unwrap_or_else(|| format!("다운로드 {} MiB", received / 1_048_576));
                (progress, StatusTone::Warning)
            }
            UpdateState::ReadyToInstall { .. } => {
                ("설치 준비 완료 · 승인 필요".to_owned(), StatusTone::Good)
            }
            UpdateState::Installing => ("업데이트 설치 중".to_owned(), StatusTone::Warning),
            UpdateState::Failed(_) => ("업데이트 오류 · 자세히 확인".to_owned(), StatusTone::Bad),
        };
        let (_, state_color) = status_style(tone);
        let action_kind = match &self.update_state {
            UpdateState::Checking => 0,
            UpdateState::Available(_) | UpdateState::Downloading { .. } => 1,
            UpdateState::ReadyToInstall { .. } => 2,
            UpdateState::Installing => 3,
            UpdateState::UpToDate | UpdateState::Failed(_) => 4,
        };
        card(ui, |row| {
            row.horizontal(|row| {
                heading(row, "DinoPatch 업데이트");
                row.label(
                    RichText::new(format!("v{}", updater_engine::compiled_manager_version()))
                        .size(HELP_TEXT_SIZE)
                        .color(rgb(MUTED)),
                );
                let state_width = (row.available_width() - 112.0).max(76.0);
                row.add_sized(
                    Vec2::new(state_width, 22.0),
                    egui::Label::new(
                        RichText::new(state)
                            .size(HELP_TEXT_SIZE)
                            .strong()
                            .color(rgb(state_color)),
                    )
                    .truncate(),
                );
                let action_label = match action_kind {
                    0 => "확인 중",
                    1 => "세부 정보",
                    2 => "설치 승인",
                    3 => "설치 중",
                    _ => "업데이트 확인",
                };
                let enabled = !self.busy
                    && !matches!(
                        &self.update_state,
                        UpdateState::Checking
                            | UpdateState::Downloading { .. }
                            | UpdateState::Installing
                    );
                if action_button(
                    row,
                    action_label,
                    if action_kind == 2 {
                        ButtonTone::Primary
                    } else {
                        ButtonTone::Secondary
                    },
                    enabled,
                    Vec2::new(104.0, BUTTON_HEIGHT),
                )
                .clicked()
                {
                    match action_kind {
                        1 => self.show_update_details = true,
                        2 => self.pending_update_install = true,
                        4 if matches!(&self.update_state, UpdateState::Failed(_)) => {
                            self.restart_update_check()
                        }
                        4 => self.restart_update_check(),
                        _ => {}
                    }
                }
            });
        });
    }

    fn update_details_content(&mut self, ui: &mut Ui, ctx: &egui::Context) {
        label(ui, format!("현재 버전: {}", updater_engine::compiled_manager_version()));
        label(ui, format!("고정 저장소: {}", release_update::REPOSITORY));
        ui.add(
            egui::Label::new(
                RichText::new("릴리스와 파일은 HTTPS 및 GitHub API SHA-256으로 확인합니다. Attestation/전자서명은 사용하지 않습니다.")
                    .size(HELP_TEXT_SIZE)
                    .color(rgb(MUTED)),
            )
            .wrap(),
        );
        ui.add_space(4.0);
        match self.update_state.clone() {
            UpdateState::Checking => {
                ui.horizontal(|ui| {
                    ui.spinner();
                    label(ui, "GitHub에서 최신 베타 릴리스 확인 중");
                });
            }
            UpdateState::UpToDate => {
                label(ui, "최신 버전을 사용 중입니다.");
                if action(ui, "업데이트 다시 확인", ButtonTone::Secondary, !self.busy) {
                    self.restart_update_check();
                }
            }
            UpdateState::Available(candidate) => {
                heading(ui, &format!("새 버전: {}", candidate.tag));
                label(ui, &candidate.title);
                if !candidate.published_at.is_empty() {
                    label(ui, format!("게시일: {}", candidate.published_at));
                }
                ui.add_space(3.0);
                label(ui, "변경 내역");
                egui::ScrollArea::vertical()
                    .id_salt("dino-update-changelog-details")
                    .max_height((ctx.content_rect().height() - 210.0).max(96.0))
                    .show(ui, |ui| {
                        ui.add(
                            egui::Label::new(
                                RichText::new(candidate.changelog.clone())
                                    .size(HELP_TEXT_SIZE)
                                    .color(rgb(MUTED)),
                            )
                            .wrap(),
                        );
                    });
                if action(ui, "업데이트 다운로드", ButtonTone::Primary, !self.busy) {
                    self.start_update_download(candidate);
                }
            }
            UpdateState::Downloading {
                candidate,
                received,
                total,
            } => {
                ui.horizontal(|ui| {
                    ui.spinner();
                    label(ui, format!("{} 다운로드 중", candidate.tag));
                });
                if let Some(total) = total.filter(|total| *total > 0) {
                    ui.add(
                        egui::ProgressBar::new(
                            (received as f32 / total as f32).clamp(0.0, 1.0),
                        )
                        .show_percentage(),
                    );
                    label(
                        ui,
                        format!(
                            "{} / {} MiB",
                            received / 1_048_576,
                            total / 1_048_576
                        ),
                    );
                } else {
                    label(ui, format!("{} MiB 수신", received / 1_048_576));
                }
            }
            UpdateState::ReadyToInstall { candidate, digest } => {
                label(
                    ui,
                    format!("{} 다운로드 완료 · GitHub API SHA-256 확인됨", candidate.tag),
                );
                label(ui, format!("SHA-256: {digest}"));
                if action(ui, "설치 승인…", ButtonTone::Primary, !self.busy) {
                    self.pending_update_install = true;
                }
            }
            UpdateState::Installing => {
                ui.horizontal(|ui| {
                    ui.spinner();
                    label(ui, "관리자를 종료하고 기존 Rust updater가 EXE를 교체합니다.");
                });
            }
            UpdateState::Failed(error) => {
                ui.add(
                    egui::Label::new(
                        RichText::new(format!("업데이트 확인/다운로드 실패: {error}"))
                            .size(BODY_TEXT_SIZE)
                            .color(rgb(ERROR_TEXT)),
                    )
                    .wrap(),
                );
                if action(ui, "다시 확인", ButtonTone::Secondary, !self.busy) {
                    self.restart_update_check();
                }
            }
        }
        if action(ui, "GitHub 릴리스 페이지", ButtonTone::Secondary, true) {
            ctx.open_url(egui::OpenUrl::new_tab(format!(
                "{}/releases",
                release_update::RELEASES_BASE
            )));
        }
    }

    fn update_details_window(&mut self, ctx: &egui::Context) {
        if !self.show_update_details {
            return;
        }
        let mut open = self.show_update_details;
        let viewport = ctx.content_rect().size();
        let max_size = Vec2::new(
            (viewport.x - 24.0).max(280.0),
            (viewport.y - 24.0).max(220.0),
        );
        egui::Window::new("DinoPatch 업데이트 정보")
            .id(egui::Id::new("dino-manager-update-details"))
            .open(&mut open)
            .collapsible(false)
            .resizable(true)
            .default_size(Vec2::new(max_size.x.min(560.0), max_size.y.min(480.0)))
            .max_size(max_size)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt("dino-update-details")
                    .max_height((max_size.y - 72.0).max(120.0))
                    .show(ui, |ui| self.update_details_content(ui, ctx));
            });
        self.show_update_details = open;
    }

    fn recovery_tools_section(&mut self, ui: &mut Ui) {
        ui.add_space(8.0);
        heading(ui, "복구 도구");
        label(ui, "중단된 작업은 엔진의 파일 검증을 통과할 때만 복구합니다.");
        ui.horizontal_wrapped(|ui| {
            if action(
                ui,
                "복구 상태 검사",
                ButtonTone::Secondary,
                !self.busy && !self.root.trim().is_empty(),
            ) {
                self.enqueue("복구 상태 검사");
            }
            if action(
                ui,
                "복구 실행",
                ButtonTone::Secondary,
                !self.busy && !self.root.trim().is_empty(),
            ) {
                self.enqueue("복구 기록 정리");
            }
            if self.status.recovery_available
                && action(
                    ui,
                    "검증된 복구 기록 정리",
                    ButtonTone::Danger,
                    !self.busy,
                )
            {
                self.ask("복구 기록 정리");
            }
        });
    }

    fn diagnostics_window(&mut self, ctx: &egui::Context) {
        if !self.show_advanced {
            return;
        }
        let mut open = self.show_advanced;
        let viewport = ctx.content_rect().size();
        let max_size = Vec2::new(
            (viewport.x - 24.0).max(280.0),
            (viewport.y - 24.0).max(220.0),
        );
        egui::Window::new("진단 · 복구")
            .id(egui::Id::new("dino-manager-diagnostics"))
            .open(&mut open)
            .collapsible(false)
            .resizable(true)
            .default_size(Vec2::new(max_size.x.min(620.0), max_size.y.min(540.0)))
            .max_size(max_size)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt("dino-manager-diagnostics-details")
                    .max_height((max_size.y - 72.0).max(120.0))
                    .show(ui, |ui| {
                        self.diagnostics_section(ui, ctx);
                        self.recovery_tools_section(ui);
                    });
            });
        self.show_advanced = open;
    }

    fn settings_diagnostics_section(&mut self, ui: &mut Ui, ctx: &egui::Context) {
        card(ui, |row| {
            row.horizontal(|controls| {
                let fixed_width = 82.0 + 98.0 + controls.spacing().item_spacing.x * 3.0;
                let status_width = (controls.available_width() - fixed_width).max(92.0);
                let idle = !self.busy && self.operation_state == "대기 중";
                let operation_error = self.operation_state.starts_with("오류")
                    || self.operation_state.starts_with("안전 중단");
                let source_warning = matches!(
                    self.status.status.as_str(),
                    "SOURCE_MISSING" | "CONFLICT" | "PARTIAL_OR_UNKNOWN" | "UNSUPPORTED"
                );
                let tone = if self.busy {
                    StatusTone::Warning
                } else if operation_error {
                    if self.operation_state.starts_with("오류") {
                        StatusTone::Bad
                    } else {
                        StatusTone::Warning
                    }
                } else if source_warning {
                    match self.status.status.as_str() {
                        "SOURCE_MISSING" => StatusTone::Warning,
                        "CONFLICT" | "PARTIAL_OR_UNKNOWN" | "UNSUPPORTED" => StatusTone::Bad,
                        _ => StatusTone::Neutral,
                    }
                } else if idle {
                    match self.status.status.as_str() {
                        "APPLIED" | "ALREADY_APPLIED" => StatusTone::Good,
                        _ => StatusTone::Neutral,
                    }
                } else if self.operation_state.starts_with("완료") {
                    StatusTone::Good
                } else {
                    StatusTone::Neutral
                };
                let (fill, color) = status_style(tone);
                let display_status = if self.busy || operation_error {
                    self.operation_state.clone()
                } else if idle || source_warning {
                    self.status_summary()
                } else {
                    self.operation_state.clone()
                };
                Frame::new()
                    .fill(rgb(fill))
                    .corner_radius(CornerRadius::same(8))
                    .inner_margin(Margin::symmetric(7, 5))
                    .show(controls, |status| {
                        status.horizontal(|status| {
                            let spinner_width = if self.busy { 18.0 } else { 0.0 };
                            let label_width = (status_width - 14.0 - spinner_width).max(48.0);
                            if self.busy {
                                status.spinner();
                            }
                            status
                                .add_sized(
                                    Vec2::new(label_width, BUTTON_HEIGHT - 10.0),
                                    egui::Label::new(
                                        RichText::new(&display_status)
                                            .size(HELP_TEXT_SIZE)
                                            .strong()
                                            .color(rgb(color)),
                                    )
                                    .truncate(),
                                );
                        });
                    });
                if action_button(
                    controls,
                    "로그 복사",
                    ButtonTone::Secondary,
                    !self.activity.is_empty(),
                    Vec2::new(82.0, BUTTON_HEIGHT),
                )
                .clicked()
                {
                    ctx.copy_text(self.activity.join("\n"));
                    self.operation_state = "완료 · 작업 로그를 복사했습니다".into();
                }
                if action_button(
                    controls,
                    if self.show_advanced { "진단 닫기" } else { "진단 · 복구" },
                    ButtonTone::Secondary,
                    true,
                    Vec2::new(98.0, BUTTON_HEIGHT),
                )
                .clicked()
                {
                    self.show_advanced = !self.show_advanced;
                    if self.show_advanced && self.operation_state.starts_with("오류") {
                        self.show_log = true;
                    }
                }
            });
        });
    }

    fn result_card(&mut self, ui: &mut Ui) {
        card(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                heading(ui, "작업 상태");
                if self.busy {
                    ui.spinner();
                }
                let tone = if self.busy {
                    StatusTone::Warning
                } else if self.operation_state.starts_with("오류") {
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
            ui.add(
                egui::Label::new(
                    RichText::new(&self.status.reason)
                        .size(BODY_TEXT_SIZE)
                        .color(rgb(TEXT)),
                )
                .wrap(),
            );
            if let Some((title, note)) = safety_for(&self.status) {
                ui.add_space(6.0);
                ui.label(
                    RichText::new(title)
                        .size(BODY_TEXT_SIZE)
                        .strong()
                        .color(rgb(WARNING_TEXT)),
                );
                label(ui, note);
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
        let mut cancel_clicked = false;
        let mut continue_clicked = false;
        let viewport = ctx.content_rect();
        let dialog_max_width = (viewport.width() - 24.0).max(260.0);
        let dialog_max_height = (viewport.height() - 24.0).max(200.0);
        let body_max_height = (viewport.height() - 144.0).max(96.0);
        egui::Window::new("DinoPatch · 작업 확인")
            .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
            .resizable(false)
            .collapsible(false)
            .default_width(420.0)
            .max_width(dialog_max_width)
            .max_height(dialog_max_height)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .max_height(body_max_height)
                    .show(ui, |ui| {
                        heading(ui, operation);
                        ui.add_space(6.0);
                        ui.add(
                            egui::Label::new(
                                RichText::new(explanation).size(BODY_TEXT_SIZE).color(rgb(TEXT)),
                            )
                            .wrap(),
                        );
                        if !backup_details.is_empty() {
                            ui.add_space(6.0);
                            ui.add(
                                egui::Label::new(
                                    RichText::new(&backup_details)
                                        .size(HELP_TEXT_SIZE)
                                        .color(rgb(MUTED)),
                                )
                                .wrap(),
                            );
                        }
                    });
                ui.add_space(6.0);
                ui.horizontal_wrapped(|ui| {
                    if action(ui, "취소", ButtonTone::Secondary, true) {
                        cancel_clicked = true;
                    }
                    if action(ui, "계속", ButtonTone::Primary, can_continue) {
                        continue_clicked = true;
                    }
                });
            });
        match confirmation_choice(operation, can_continue, cancel_clicked, continue_clicked) {
            ConfirmationChoice::Pending => {}
            ConfirmationChoice::Cancel => self.pending_action = None,
            ConfirmationChoice::Start(operation) => {
                self.pending_action = None;
                self.enqueue(operation);
            }
        }
    }

    fn render_integrated_content(&mut self, ui: &mut Ui, ctx: &egui::Context) {
        self.installation_path_section(ui);
        ui.columns(2, |columns| {
            let patch_card_height = card(&mut columns[0], |panel| self.patch_actions_section(panel));
            card_with_min_height(
                &mut columns[1],
                Some(patch_card_height),
                |panel| {
                    self.backup_restore_section(panel, (patch_card_height - 14.0).max(0.0))
                },
            );
        });
        self.update_section(ui, ctx);
    }

    fn render_main(&mut self, ctx: &egui::Context) {
        let compact = ctx.content_rect().height() <= 400.0;
        let vertical_inset = if compact {
            6
        } else {
            10
        };
        egui::CentralPanel::default()
            .frame(
                Frame::new()
                    .fill(rgb(PAGE))
                    .inner_margin(Margin::symmetric(14, vertical_inset)),
            )
            .show(ctx, |ui| {
                ui.spacing_mut().item_spacing =
                    Vec2::new(6.0, if compact { 2.0 } else { 6.0 });
                ui.horizontal(|row| {
                    row.spacing_mut().item_spacing.x = 10.0;
                    row.label(
                        RichText::new("DinoPatch")
                            .size(20.0)
                            .strong()
                            .color(rgb(TEXT)),
                    );
                    if !self.status.version.is_empty() {
                        row.label(
                            RichText::new(format!("LilacAnime v{}", self.status.version))
                                .size(HELP_TEXT_SIZE)
                                .color(rgb(MUTED)),
                        );
                    }
                    row.with_layout(Layout::right_to_left(Align::Center), |status_row| {
                        let (status, tone) = if automatic_apply_waiting_for_source(
                            self.auto_enabled,
                            !self.root.trim().is_empty(),
                            &self.status.status,
                        ) {
                            ("원본 확인 대기", StatusTone::Warning)
                        } else {
                            badge_for(&self.status)
                        };
                        pill(status_row, status, tone);
                        if self.busy {
                            status_row.spinner();
                        }
                        self.settings_section(status_row);
                    });
                });
                self.render_integrated_content(ui, ctx);
                let footer_reserve = BUTTON_HEIGHT + 12.0 + ui.spacing().item_spacing.y;
                let flexible_gap = (ui.available_height() - footer_reserve).max(0.0);
                if flexible_gap > 4.0 {
                    ui.add_space(flexible_gap);
                }
                self.settings_diagnostics_section(ui, ctx);
            });
        self.path_editor_window(ctx);
        self.update_details_window(ctx);
        self.diagnostics_window(ctx);
        self.confirmation(ctx);
        self.update_confirmation(ctx);
    }
}

impl eframe::App for DinoUi {
    fn persist_egui_memory(&self) -> bool {
        // The path editor may contain a draft installation path. Persist only
        // the whitelisted UI preferences, never egui memory or window geometry.
        false
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        storage.set_string(ADVANCED_PANEL_KEY, self.show_advanced.to_string());
        storage.set_string(AUTO_APPLY_KEY, self.auto_enabled.to_string());
        storage.set_string(
            CONFIRMED_PATCH_SELECTION_KEY,
            self.confirmed_patch_selection.id(),
        );
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.start_update_check();
        self.poll_result();
        self.poll_update();
        self.monitor();
        ctx.request_repaint_after(Duration::from_millis(if self.busy { 120 } else { 500 }));
        self.render_main(ctx);
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
    let mut visuals = egui::Visuals::light();
    visuals.panel_fill = rgb(PAGE);
    visuals.window_fill = rgb(CARD);
    visuals.override_text_color = Some(rgb(TEXT));
    visuals.faint_bg_color = rgb(PAGE);
    visuals.extreme_bg_color = rgb(CARD);
    visuals.hyperlink_color = rgb(ACCENT);
    visuals.warn_fg_color = rgb(WARNING_TEXT);
    visuals.error_fg_color = rgb(ERROR_TEXT);
    visuals.window_stroke = Stroke::new(1.0_f32, rgb(BORDER));
    visuals.widgets.noninteractive.bg_fill = rgb(CARD);
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, rgb(BORDER));
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, rgb(MUTED));
    visuals.widgets.inactive.bg_fill = rgb(SURFACE);
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, rgb(BORDER));
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, rgb(TEXT));
    visuals.widgets.hovered.bg_fill = rgb(HOVER_SURFACE);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, rgb(ACCENT));
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, rgb(TEXT));
    visuals.widgets.active.bg_fill = rgb(ACTIVE_SURFACE);
    visuals.widgets.active.bg_stroke = Stroke::new(2.0_f32, rgb(ACCENT));
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, rgb(TEXT));
    visuals.selection.bg_fill = rgb(ACTIVE_SURFACE);
    visuals.selection.stroke = Stroke::new(1.0_f32, rgb(ACCENT));
    ctx.set_visuals(visuals);
    let mut style = (*ctx.style()).clone();
    style.text_styles.insert(
        egui::TextStyle::Body,
        FontId::new(BODY_TEXT_SIZE, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Button,
        FontId::new(BUTTON_TEXT_SIZE, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Small,
        FontId::new(HELP_TEXT_SIZE, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Heading,
        FontId::new(20.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Monospace,
        FontId::new(HELP_TEXT_SIZE, FontFamily::Monospace),
    );
    style.spacing.item_spacing = Vec2::new(8.0, 8.0);
    style.spacing.button_padding = Vec2::new(10.0, 8.0);
    style.spacing.interact_size = Vec2::new(40.0, BUTTON_HEIGHT);
    style.spacing.tooltip_width = PATH_TOOLTIP_MAX_SIZE.x;
    ctx.set_style(style);
}

fn persistence_path_for(appdata: Option<PathBuf>, temp: PathBuf) -> PathBuf {
    let root = appdata.filter(|path| path.is_absolute()).unwrap_or(temp);
    root.join("LilacAnime DinoPatch")
        .join("data")
        .join(GUI_PERSISTENCE_VERSION)
        .join("app.ron")
}

fn gui_persistence_path() -> PathBuf {
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let temp = std::env::var_os("TEMP")
        .or_else(|| std::env::var_os("TMP"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(std::env::temp_dir);
    persistence_path_for(appdata, temp)
}

fn native_options(persistence_path: PathBuf) -> eframe::NativeOptions {
    eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([680.0, 420.0])
            .with_min_inner_size([600.0, 380.0]),
        centered: true,
        persist_window: false,
        // Supplying a file path prevents eframe from querying the Windows known
        // folder directly. The versioned path also ignores old saved geometry
        // without modifying the previous settings file.
        persistence_path: Some(persistence_path),
        ..Default::default()
    }
}

pub fn start() -> Result<()> {
    let options = native_options(gui_persistence_path());
    eframe::run_native(
        "LilacAnime DinoPatch",
        options,
        Box::new(|cc| {
            register_windows_fonts(&cc.egui_ctx);
            setup_style(&cc.egui_ctx);
            let app = DinoUi::with_storage(cc.storage);
            Ok(Box::new(app))
        })
    ).map_err(|error| crate::fail(format!("Rust GUI 실행 실패: {error}")))
}

#[cfg(test)]
mod backup_list_tests {
    use super::{
        action_button_palette, badge_for, integrated_patch_status,
        integrated_patch_status_tone, inspect_monitored_archive, native_options,
        operation_stage, parse_backup_items, persistence_path_for, status_style, ArchiveWatch,
        BackupItem, ButtonTone, ConfirmationChoice, DinoUi, GUI_PERSISTENCE_VERSION, StatusTone,
        UpdateState,
    };
    use crate::transaction;
    use eframe::egui::{
        epaint::ClippedShape, Context, Pos2, RawInput, Rect, Shape, Vec2, ViewportId,
    };
    use serde_json::json;
    use std::path::PathBuf;
    use std::time::Instant;

    fn test_ui(root: &str) -> DinoUi {
        DinoUi {
            root: root.to_owned(),
            root_selected_by_user: true,
            status: transaction::Status::new("APPLIED", "0.5.65", "호환성 확인 완료"),
            auto_enabled: false,
            draft_patch_selection: crate::patch_set::PatchSelection::DEFAULT,
            confirmed_patch_selection: crate::patch_set::PatchSelection::DEFAULT,
            busy: false,
            operation_state: "완료 · 패치 상태 확인".into(),
            task_generation: 1,
            activity: Vec::new(),
            response: None,
            last_archive_change: None,
            last_monitor: Instant::now(),
            backup_items: Vec::new(),
            backup_list_root: Some(root.to_owned()),
            backup_error: None,
            selected_backup_id: None,
            show_log: false,
            show_path_editor: false,
            path_draft: root.to_owned(),
            show_advanced: false,
            show_update_details: false,
            pending_action: None,
            update_state: super::UpdateState::UpToDate,
            update_receiver: None,
            update_check_started: true,
            pending_update_install: false,
        }
    }

    #[test]
    fn invalid_explicit_original_root_does_not_hide_valid_install_fallback() {
        let roots = [
            PathBuf::from(r"D:\Codex-Coding-Folder\Lilac-Dino-Patch"),
            PathBuf::from(r"D:\LilacAnime"),
        ];

        let selected = super::first_valid_installed_root(roots, |root| {
            root == std::path::Path::new(r"D:\LilacAnime")
        });

        assert_eq!(selected, r"D:\LilacAnime");
    }

    #[test]
    fn stored_auto_apply_and_confirmed_selection_values_are_validated() {
        use crate::patch_set::PatchSelection;

        assert!(super::parse_auto_apply_setting(None));
        assert!(!super::parse_auto_apply_setting(Some("false")));
        assert!(!super::parse_auto_apply_setting(Some("unexpected")));
        assert_eq!(
            super::parse_confirmed_patch_selection(Some("01+02")),
            PatchSelection::parse_id("01+02").unwrap()
        );
        assert_eq!(
            super::parse_confirmed_patch_selection(Some("01+03")),
            PatchSelection::parse_id("01+03").unwrap()
        );
        assert_eq!(
            super::parse_confirmed_patch_selection(Some("not-a-set")),
            PatchSelection::DEFAULT
        );
    }

    #[test]
    fn automatic_apply_requires_explicit_root_confirmed_supported_selection_and_idle_state() {
        use crate::patch_set::{PatchId, PatchSelection};

        let supported = PatchSelection::DEFAULT;
        let multi_patch = supported.with(PatchId::AdultOnlyTab, true);
        assert_eq!(
            super::automatic_apply_config_block(
                true, false, true, false, supported, supported
            ),
            Some("설치 경로를 직접 확인하면 자동 적용됩니다")
        );
        assert_eq!(
            super::automatic_apply_config_block(
                true, false, false, false, supported, supported
            ),
            Some("원본 확인 대기")
        );
        assert!(super::automatic_apply_waiting_for_source(true, false, "NO_SOURCE"));
        assert!(super::automatic_apply_waiting_for_source(true, true, "SOURCE_MISSING"));
        assert!(!super::automatic_apply_waiting_for_source(true, true, "UNPATCHED"));
        assert!(!super::automatic_apply_waiting_for_source(false, false, "SOURCE_MISSING"));
        assert_eq!(
            super::automatic_apply_config_block(
                true, false, true, true, multi_patch, supported
            ),
            Some("선택 변경 미확정 · 자동 적용 보류")
        );
        assert_eq!(
            super::automatic_apply_config_block(
                true, false, true, true, multi_patch, multi_patch
            ),
            None
        );
        assert_eq!(
            super::automatic_apply_config_block(
                true, true, true, true, supported, supported
            ),
            Some("작업 중 · 자동 적용 대기")
        );
        assert_eq!(
            super::automatic_apply_config_block(
                false, false, true, true, supported, supported
            ),
            Some("자동 적용 꺼짐 · 수동 작업 가능")
        );
        assert_eq!(
            super::automatic_apply_config_block(
                true, false, true, true, PatchSelection::NONE, PatchSelection::NONE
            ),
            Some("선택된 패치 없음 · 자동 적용하지 않습니다")
        );
    }

    #[test]
    fn automatic_apply_requires_a_verified_nonconflicting_source_state() {
        for blocked in [
            "SOURCE_FOUND",
            "SOURCE_MISSING",
            "UNSUPPORTED",
            "CONFLICT",
            "PARTIAL_OR_UNKNOWN",
            "NO_SOURCE",
        ] {
            assert!(
                super::automatic_apply_status_block(blocked).is_some(),
                "automatic apply must be blocked for {blocked}"
            );
        }
        for ready in ["UNPATCHED", "ALREADY_UNPATCHED", "APPLIED", "ALREADY_APPLIED"] {
            assert_eq!(super::automatic_apply_status_block(ready), None);
        }
        let desired = crate::patch_set::PatchSelection::DEFAULT;
        assert!(super::automatic_apply_needed(
            &transaction::Status::new("UNPATCHED", "0.5.65", "verified"),
            desired
        ));
        let mut same = transaction::Status::new("APPLIED", "0.5.65", "already patched");
        same.composition_id = Some("01".into());
        assert!(!super::automatic_apply_needed(&same, desired));
        let mut different = transaction::Status::new("APPLIED", "0.5.65", "other composition");
        different.composition_id = Some("02".into());
        assert!(super::automatic_apply_needed(&different, desired));
        let mut manually_removed = transaction::Status::new("UNPATCHED", "0.5.65", "manual");
        manually_removed.manually_uninstalled = true;
        assert!(!super::automatic_apply_needed(&manually_removed, desired));
    }

    #[test]
    fn actual_patch_rows_follow_the_verified_installed_composition() {
        use crate::patch_set::PatchId;

        let mut applied = transaction::Status::new("APPLIED", "0.5.65", "verified");
        applied.composition_id = Some("01+02".into());
        assert_eq!(super::actual_patch_status(PatchId::IntegratedSearchProviderSwitch, &applied),
            ("적용됨", super::StatusTone::Good));
        assert_eq!(super::actual_patch_status(PatchId::AdultOnlyTab, &applied),
            ("적용됨", super::StatusTone::Good));
        assert_eq!(super::actual_patch_status(PatchId::DoubleSpeedBuffering, &applied),
            ("미적용", super::StatusTone::Neutral));
        let unpatched = transaction::Status::new("UNPATCHED", "0.5.65", "verified original");
        assert_eq!(super::actual_patch_status(PatchId::AdultOnlyTab, &unpatched),
            ("미적용", super::StatusTone::Neutral));
        let unavailable = transaction::Status::new("SOURCE_MISSING", "0.5.65", "missing");
        assert_eq!(
            super::actual_patch_status(PatchId::IntegratedSearchProviderSwitch, &unavailable),
            ("확인 불가", super::StatusTone::Warning)
        );
    }

    #[test]
    fn patch_rows_show_support_scope_while_preserving_actual_state_separately() {
        let mut selected = transaction::Status::new("APPLIED", "0.5.65", "verified");
        selected.composition_id = Some("02+03".into());
        assert_eq!(super::patch_row_status(crate::patch_set::PATCH_CATALOG[1], &selected),
            ("적용됨", super::StatusTone::Good));
        assert_eq!(super::patch_row_status(crate::patch_set::PATCH_CATALOG[2], &selected),
            ("적용됨", super::StatusTone::Good));
        assert_eq!(super::patch_row_status(crate::patch_set::PATCH_CATALOG[0], &selected),
            ("미적용", super::StatusTone::Neutral));
        let missing = transaction::Status::new("SOURCE_MISSING", "0.5.65", "missing");
        assert_eq!(
            super::patch_row_status(crate::patch_set::PATCH_CATALOG[0], &missing),
            ("확인 불가", super::StatusTone::Warning)
        );
    }

    #[test]
    fn automatic_monitor_inspects_changed_sources_before_applying() {
        assert_eq!(
            super::automatic_monitor_operation("SOURCE_FOUND", false, false),
            Some("원본 다시 확인")
        );
        assert_eq!(
            super::automatic_monitor_operation("SOURCE_MISSING", true, false),
            Some("원본 다시 확인")
        );
        assert_eq!(
            super::automatic_monitor_operation("CONFLICT", true, false),
            Some("원본 다시 확인")
        );
        assert_eq!(
            super::automatic_monitor_operation("UNPATCHED", false, true),
            Some("자동 검사")
        );
        assert_eq!(
            super::automatic_monitor_operation("UNPATCHED", false, false),
            None,
            "pending or unsupported configurations must not trigger application"
        );
        assert_eq!(
            super::automatic_monitor_operation("APPLIED", false, false),
            None
        );
        assert_eq!(
            super::automatic_monitor_operation("APPLIED", false, true),
            Some("자동 검사")
        );
    }

    #[test]
    fn confirming_a_verified_patch_selection_is_nonmutating_until_separately_applied() {
        use crate::patch_set::PatchId;

        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.auto_enabled = true;
        ui.status.composition_id = Some("01".into());
        ui.draft_patch_selection = ui
            .confirmed_patch_selection
            .with(PatchId::AdultOnlyTab, true);
        let status_code = ui.status.status.clone();
        let status_version = ui.status.version.clone();
        let status_reason = ui.status.reason.clone();
        assert!(!ui.can_apply_confirmed_selection());
        assert_eq!(
            ui.auto_apply_config_block(),
            Some("선택 변경 미확정 · 자동 적용 보류")
        );
        ui.confirm_draft_selection();

        assert_eq!(ui.confirmed_patch_selection.id(), "01+02");
        assert_eq!(ui.status.status, status_code);
        assert_eq!(ui.status.version, status_version);
        assert_eq!(ui.status.reason, status_reason);
        assert!(!ui.busy);
        assert!(ui.response.is_none());
        assert_eq!(ui.auto_apply_config_block(), None);
        assert!(ui.can_apply_confirmed_selection());
        assert!(ui.activity.last().is_some_and(|entry| {
            entry.contains("파일은 변경하지 않았습니다")
        }));
        assert!(ui.operation_state.contains("패치 적용은 별도 확인"));
    }

    fn render_shapes(
        app: &mut DinoUi,
        width: f32,
        height: f32,
        native_scale: f32,
    ) -> Vec<ClippedShape> {
        let ctx = Context::default();
        super::register_windows_fonts(&ctx);
        super::setup_style(&ctx);
        let mut input = RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(width, height))),
            ..Default::default()
        };
        input
            .viewports
            .get_mut(&ViewportId::ROOT)
            .unwrap()
            .native_pixels_per_point = Some(native_scale);
        // Let egui settle anchored window geometry and native scale once
        // before collecting the final layout for assertions.
        let _ = ctx.run(input.clone(), |ctx| app.render_main(ctx));
        let output = ctx.run(input, |ctx| app.render_main(ctx));
        output.shapes
    }

    fn render_text_bounds(
        app: &mut DinoUi,
        width: f32,
        height: f32,
        native_scale: f32,
    ) -> Vec<(String, Rect)> {
        render_shapes(app, width, height, native_scale)
            .into_iter()
            .filter_map(|clipped| {
                let clip_rect = clipped.clip_rect;
                match clipped.shape {
                Shape::Text(text) => {
                    Some((
                        text.galley.text().to_owned(),
                        text.visual_bounding_rect().intersect(clip_rect),
                    ))
                }
                _ => None,
                }
            })
            .collect()
    }

    fn item(id: &str, restorable: bool) -> BackupItem {
        BackupItem {
            id: id.into(),
            version: "0.5.65".into(),
            created_at: "2026-11-14T12:00:00Z".into(),
            restorable,
        }
    }

    #[test]
    fn backup_list_accepts_zero_items() {
        assert!(parse_backup_items(&json!({ "items": [] })).unwrap().is_empty());
    }

    #[test]
    fn patch_status_labels_and_tones_are_separate_and_semantic() {
        assert_eq!(integrated_patch_status("APPLIED"), "적용됨");
        assert_eq!(integrated_patch_status("UNPATCHED"), "미적용");
        assert_eq!(integrated_patch_status("SOURCE_MISSING"), "확인 불가");
        assert_eq!(integrated_patch_status("CONFLICT"), "확인 불가");
        assert_eq!(
            integrated_patch_status_tone("APPLIED"),
            StatusTone::Good
        );
        assert_eq!(
            integrated_patch_status_tone("UNPATCHED"),
            StatusTone::Neutral
        );
        assert_eq!(
            integrated_patch_status_tone("SOURCE_MISSING"),
            StatusTone::Warning
        );
        assert_eq!(
            integrated_patch_status_tone("CONFLICT"),
            StatusTone::Bad
        );
        assert_ne!(status_style(StatusTone::Preview), status_style(StatusTone::Neutral));
        assert_eq!(
            badge_for(&transaction::Status::new("SOURCE_MISSING", "", "")),
            ("원본 파일 없음", StatusTone::Warning)
        );
    }

    #[test]
    fn disabled_buttons_keep_readable_text_and_a_clear_neutral_surface() {
        let (fill, ink, edge) = action_button_palette(ButtonTone::Primary, false);
        assert_eq!(
            (fill, ink, edge),
            (
                super::DISABLED_FILL,
                super::DISABLED_TEXT,
                super::DISABLED_BORDER
            )
        );
        assert_ne!(ink, 0x777777, "disabled labels should not fade into gray");
        assert_eq!(
            action_button_palette(ButtonTone::Primary, true),
            (super::BUTTON, 0xFFFFFF, super::BUTTON)
        );
    }

    #[test]
    fn light_palette_preserves_text_contrast_for_states_and_controls() {
        fn luminance(color: u32) -> f32 {
            let linear = |channel: u32| {
                let value = channel as f32 / 255.0;
                if value <= 0.04045 {
                    value / 12.92
                } else {
                    ((value + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * linear((color >> 16) & 0xff)
                + 0.7152 * linear((color >> 8) & 0xff)
                + 0.0722 * linear(color & 0xff)
        }
        fn contrast(ink: u32, fill: u32) -> f32 {
            let ink = luminance(ink);
            let fill = luminance(fill);
            (ink.max(fill) + 0.05) / (ink.min(fill) + 0.05)
        }

        assert!(contrast(super::MUTED, super::PAGE) >= 4.5);
        assert!(contrast(super::MUTED, super::CARD) >= 4.5);
        for tone in [
            StatusTone::Neutral,
            StatusTone::Good,
            StatusTone::Warning,
            StatusTone::Bad,
            StatusTone::Preview,
        ] {
            let (fill, ink) = status_style(tone);
            assert!(
                contrast(ink, fill) >= 4.5,
                "status text contrast is too low for {tone:?}"
            );
        }
        for (fill, ink, _) in [
            action_button_palette(ButtonTone::Primary, true),
            action_button_palette(ButtonTone::Secondary, true),
            action_button_palette(ButtonTone::Danger, true),
            action_button_palette(ButtonTone::Primary, false),
        ] {
            assert!(contrast(ink, fill) >= 4.5);
        }
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

    #[test]
    fn gui_persistence_uses_isolated_appdata_or_temp_without_known_folder_fallback() {
        let test_appdata = PathBuf::from(r"C:\DinoPatchTest\manager-appdata");
        let test_temp = PathBuf::from(r"C:\DinoPatchTest\temp");
        assert_eq!(
            persistence_path_for(Some(test_appdata.clone()), test_temp.clone()),
            test_appdata
                .join("LilacAnime DinoPatch")
                .join("data")
                .join(GUI_PERSISTENCE_VERSION)
                .join("app.ron")
        );
        assert_eq!(
            persistence_path_for(Some(PathBuf::from("relative-appdata")), test_temp.clone()),
            test_temp
                .join("LilacAnime DinoPatch")
                .join("data")
                .join(GUI_PERSISTENCE_VERSION)
                .join("app.ron")
        );
        assert_eq!(
            persistence_path_for(None, test_temp.clone()),
            test_temp
                .join("LilacAnime DinoPatch")
                .join("data")
                .join(GUI_PERSISTENCE_VERSION)
                .join("app.ron")
        );
    }

    #[test]
    fn native_window_uses_compact_centered_geometry_without_window_persistence() {
        let options = native_options(PathBuf::from(r"C:\DinoPatchTest\ui-v2\app.ron"));
        assert_eq!(options.viewport.inner_size, Some(Vec2::new(680.0, 420.0)));
        assert_eq!(
            options.viewport.min_inner_size,
            Some(Vec2::new(600.0, 380.0))
        );
        assert!(options.centered);
        assert!(!options.persist_window);
        assert!(options
            .persistence_path
            .unwrap()
            .ends_with(PathBuf::from("ui-v2").join("app.ron")));
    }

    #[test]
    fn backup_selection_requires_current_path_and_a_returned_id() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.backup_items = vec![item("backup-a", true)];
        ui.selected_backup_id = Some("backup-a".into());
        assert_eq!(
            ui.selected_backup().map(|value| value.id.as_str()),
            Some("backup-a")
        );

        ui.selected_backup_id = Some("unknown".into());
        assert!(ui.selected_backup().is_none());

        ui.selected_backup_id = Some("backup-a".into());
        ui.backup_list_root = Some(r"C:\old\LilacAnime".into());
        assert!(ui.selected_backup().is_none());
    }

    #[test]
    fn restore_requires_applied_state_idle_worker_and_restorable_selection() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.backup_items = vec![item("backup-a", true)];
        ui.selected_backup_id = Some("backup-a".into());
        assert!(ui.can_restore_selected_backup());

        ui.busy = true;
        assert!(!ui.can_restore_selected_backup());
        ui.busy = false;
        ui.backup_items[0].restorable = false;
        assert!(!ui.can_restore_selected_backup());
        ui.backup_items[0].restorable = true;
        ui.status.status = "UNPATCHED".into();
        assert!(!ui.can_restore_selected_backup());
    }

    #[test]
    fn confirmation_cancel_does_not_start_an_operation() {
        for operation in ["백업 복원", "디노 패치 수동 적용", "디노 패치 해제"] {
            assert_eq!(
                super::confirmation_choice(operation, true, true, false),
                ConfirmationChoice::Cancel,
                "cancel must not start {operation}"
            );
            assert_eq!(
                super::confirmation_choice(operation, true, false, true),
                ConfirmationChoice::Start(operation),
                "approval should start only the confirmed {operation}"
            );
            assert_eq!(
                super::confirmation_choice(operation, false, false, true),
                ConfirmationChoice::Pending,
                "operation must remain pending without a user choice: {operation}"
            );
            assert_eq!(
                super::confirmation_choice(operation, true, true, true),
                ConfirmationChoice::Cancel,
                "cancel must take precedence for {operation}"
            );
        }
    }

    #[test]
    fn enqueue_while_busy_does_not_start_a_duplicate_operation() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.busy = true;
        ui.task_generation = 41;
        ui.operation_state = "첫 작업 진행 중".into();
        let activity = ui.activity.clone();

        ui.enqueue("디노 패치 수동 적용");

        assert!(ui.busy);
        assert_eq!(ui.task_generation, 41);
        assert_eq!(ui.operation_state, "첫 작업 진행 중");
        assert_eq!(ui.activity, activity);
        assert!(ui.response.is_none());
    }

    #[test]
    fn approved_restore_request_carries_only_the_selected_backup_id() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.selected_backup_id = Some("backup-b".into());
        assert_eq!(ui.requested_backup_id("백업 복원"), Some("backup-b".into()));
        assert_eq!(ui.requested_backup_id("디노 패치 해제"), None);
    }

    #[test]
    fn backup_refresh_clears_stale_selection_and_keeps_errors_distinct() {
        let root = r"C:\test\LilacAnime";
        let mut ui = test_ui(root);
        ui.backup_items = vec![item("backup-old", true)];
        ui.selected_backup_id = Some("backup-old".into());
        ui.update_backup_list(root, Ok(vec![item("backup-new", true)]));
        assert!(ui.selected_backup_id.is_none());
        assert_eq!(ui.backup_items[0].id, "backup-new");

        ui.update_backup_list(root, Err("fixture lookup failed".into()));
        assert!(ui.backup_items.is_empty());
        assert!(ui.selected_backup_id.is_none());
        assert_eq!(ui.backup_error.as_deref(), Some("fixture lookup failed"));
        assert!(ui.show_log);
        assert!(ui.show_advanced);
    }

    #[test]
    fn task_generation_and_root_reject_old_results() {
        let ui = test_ui(r"C:\test\LilacAnime");
        assert!(ui.task_is_current(r"C:\test\LilacAnime", 1));
        assert!(!ui.task_is_current(r"C:\old\LilacAnime", 1));
        assert!(!ui.task_is_current(r"C:\test\LilacAnime", 0));
    }

    #[test]
    fn backup_list_renders_zero_one_and_multiple_items_truthfully() {
        let root = r"C:\test\LilacAnime";
        let cases = [
            (vec![], vec!["복원 가능한 백업이 없습니다"]),
            (
                vec![item("backup-one", true)],
                vec!["backup-one", "LilacAnime v0.5.65", "복원 가능"],
            ),
            (
                vec![item("backup-a", true), item("backup-b", false)],
                vec!["backup-a", "backup-b", "복원 가능", "복원 불가"],
            ),
        ];
        for (items, expected) in cases {
            let mut ui = test_ui(root);
            ui.backup_items = items;
            ui.backup_list_root = Some(root.into());
            ui.selected_backup_id = ui.backup_items.first().map(|backup| backup.id.clone());
            ui.show_advanced = true;
            let rendered = render_text_bounds(&mut ui, 940.0, 2200.0, 1.0);
            let texts = rendered
                .iter()
                .into_iter()
                .map(|(text, _)| text.clone())
                .collect::<Vec<_>>();
            for needle in expected {
                assert!(
                    texts.iter().any(|text| text.contains(needle)),
                    "rendered backup list did not contain {needle:?}: {rendered:?}"
                );
            }
        }
    }

    #[test]
    fn backup_empty_messages_explain_path_and_lookup_state() {
        let cases = [
            (
                "",
                Some(""),
                "원본 연결 후 백업을 확인할 수 있습니다.",
            ),
            (
                r"C:\test\LilacAnime",
                None,
                "설치 경로가 변경됨 · 새로고침 필요",
            ),
            (
                r"C:\test\LilacAnime",
                Some(r"C:\test\LilacAnime"),
                "복원 가능한 백업이 없습니다",
            ),
        ];
        for (root, list_root, expected) in cases {
            let mut ui = test_ui(root);
            ui.backup_items.clear();
            ui.backup_list_root = list_root.map(str::to_owned);
            let texts = render_text_bounds(&mut ui, 680.0, 1000.0, 1.0);
            assert!(
                texts.iter().any(|(text, _)| text == expected),
                "backup empty state omitted {expected:?}: {texts:?}"
            );
            if root.is_empty() {
                let message_count = texts
                    .iter()
                    .filter(|(text, _)| text == "원본 연결 후 백업을 확인할 수 있습니다.")
                    .count();
                assert_eq!(message_count, 1, "empty-source guidance must appear once: {texts:?}");
                assert!(!texts.iter().any(|(text, _)| {
                    text.contains("선택 가능한 백업 없음")
                        || text.contains("백업을 선택하면")
                        || text.contains("설치 폴더를 선택하면")
                }));
            }
        }
    }

    #[test]
    fn missing_original_shows_auto_apply_waiting_and_preview_support_separately() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.auto_enabled = true;
        ui.status = transaction::Status::new(
            "SOURCE_MISSING",
            "0.5.65",
            "선택한 폴더에서 resources/app.asar를 찾을 수 없습니다.",
        );
        let rendered = render_text_bounds(&mut ui, 680.0, 420.0, 1.0);
        for expected in ["자동 적용", "원본 확인 대기", "관리자 설치 지원"] {
            assert!(
                rendered.iter().any(|(text, rect)| text.contains(expected) && rect.is_positive()),
                "missing-source UI omitted {expected:?}: {rendered:?}"
            );
        }
        assert_eq!(
            rendered
                .iter()
                .filter(|(text, rect)| text == "원본 확인 대기" && rect.is_positive())
                .count(),
            1,
            "missing source and automatic waiting should share one header badge"
        );
        assert!(rendered
            .iter()
            .any(|(text, rect)| text == "확인 불가" && rect.is_positive()));
        assert!(rendered
            .iter()
            .any(|(text, rect)| text.contains("관리자 설치 지원") && rect.is_positive()));
        assert!(!rendered.iter().any(|(text, _)| text.contains("목표 01 확정")));
    }

    #[test]
    fn collapsed_update_header_shows_version_and_state_inside_viewport() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.update_state = UpdateState::UpToDate;
        let texts = render_text_bounds(&mut ui, 600.0, 1200.0, 1.0);
        let header = texts
            .iter()
            .find(|(text, _)| text.contains("DinoPatch 업데이트"))
            .expect("update section heading should be visible");
        assert!(header.1.left() >= 14.0 && header.1.right() <= 586.0);
        assert!(texts
            .iter()
            .any(|(text, rect)| text == "최신 버전" && rect.is_positive()));
        assert!(texts
            .iter()
            .any(|(text, rect)| text == "v0.2.0-beta.9" && rect.is_positive()));
    }

    #[test]
    fn integrated_screen_keeps_all_core_controls_inside_small_viewports_without_scrolling() {
        let long_path = format!(r"C:\DinoPatchTest\{}\LilacAnime", "segment\\".repeat(18));
        for (width, height) in [(600.0, 380.0), (680.0, 420.0)] {
            for native_scale in [1.0, 1.25, 1.5] {
                let mut ui = test_ui(&long_path);
                let shapes = render_shapes(&mut ui, width, height, native_scale);
                let outside = shapes
                    .iter()
                    .map(|clipped| clipped.shape.visual_bounding_rect().intersect(clipped.clip_rect))
                    .filter(|rect| rect.is_positive())
                    .filter(|rect| {
                        rect.left() < -1.0
                            || rect.right() > width + 1.0
                            || rect.top() < -1.0
                            || rect.bottom() > height + 1.0
                    })
                    .collect::<Vec<_>>();
                assert!(
                    outside.is_empty(),
                    "visual escaped a {width}x{height} viewport at native DPI {native_scale}: {outside:?}"
                );

                let text_bounds = shapes
                    .iter()
                    .filter_map(|clipped| match &clipped.shape {
                        Shape::Text(text) => Some((
                            text.galley.text().to_owned(),
                            text.visual_bounding_rect().intersect(clipped.clip_rect),
                        )),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                for required in [
                    "DinoPatch",
                    "설치 경로",
                    "경로 복사",
                    "폴더 선택",
                    "직접 입력",
                    "상태 검사",
                    "패치 적용",
                    "패치 해제",
                    "통합 검색·공급원 전환",
                    "야애니 전용 탭",
                    "2배속 버퍼링 최적화",
                    "관리자 설치 지원",
                    "백업 · 복원",
                    "선택 백업 복원",
                    "자동 적용",
                    "로그 복사",
                    "진단 · 복구",
                ] {
                    assert!(
                        text_bounds.iter().any(|(text, rect)| {
                            text.contains(required)
                                && rect.is_positive()
                                && rect.left() >= 14.0
                                && rect.right() <= width - 14.0
                                && rect.top() >= 14.0
                                && rect.bottom() <= height - 14.0
                        }),
                        "single-screen control {required:?} is not visible within {width}x{height} at DPI {native_scale}: {text_bounds:?}"
                    );
                }

                let path_rect = text_bounds
                    .iter()
                    .find(|(text, _)| text.contains("DinoPatchTest"))
                    .map(|(_, rect)| *rect)
                    .expect("long install path should be rendered");
                let copy_rect = text_bounds
                    .iter()
                    .find(|(text, _)| text == "경로 복사")
                    .map(|(_, rect)| *rect)
                    .expect("full path copy action should be rendered");
                let folder_rect = text_bounds
                    .iter()
                    .find(|(text, _)| text == "폴더 선택")
                    .map(|(_, rect)| *rect)
                    .expect("folder selection action should be rendered");
                assert!(
                    path_rect.right() <= copy_rect.left() && copy_rect.right() <= folder_rect.left(),
                    "path text/copy/folder actions overlap at {width}px: path={path_rect:?}, copy={copy_rect:?}, folder={folder_rect:?}"
                );
            }
        }

        let mut ui = test_ui(&long_path);
        ui.show_advanced = true;
        let texts = render_text_bounds(&mut ui, 680.0, 1600.0, 1.0);
        for required in [
            "백업 · 복원",
            "새로고침",
            "선택 백업 복원",
            "진단",
            "자동 적용",
            "최근 작업",
            "복구 도구",
        ] {
            assert!(
                texts.iter().any(|(text, _)| text.contains(required)),
                "independent diagnostics window omitted {required:?}: {texts:?}"
            );
        }
    }

    #[test]
    fn footer_uses_standard_window_space_and_remains_inside_minimum_window() {
        for (width, height, min_footer_top) in [
            (600.0, 380.0, 0.0),
            (680.0, 420.0, 344.0),
        ] {
            let mut ui = test_ui(r"C:\test\LilacAnime");
            let rendered = render_text_bounds(&mut ui, width, height, 1.0);
            let footer = rendered
                .iter()
                .find(|(text, rect)| text == "로그 복사" && rect.is_positive())
                .map(|(_, rect)| *rect)
                .expect("footer must retain the log-copy control");
            assert!(
                footer.left() >= 14.0 && footer.right() <= width - 14.0,
                "footer escaped horizontally at {width}x{height}: {footer:?}"
            );
            assert!(
                footer.bottom() <= height - 6.0,
                "footer clipped at {width}x{height}: {footer:?}"
            );
            if min_footer_top > 0.0 {
                assert!(
                    footer.top() >= min_footer_top,
                    "standard-size footer did not use the lower window area: {footer:?}"
                );
            }
        }
    }

    #[test]
    fn main_management_cards_share_height_and_action_rows_align() {
        for (width, height) in [(600.0, 380.0), (680.0, 420.0)] {
            let mut ui = test_ui(r"C:\test\LilacAnime");
            let shapes = render_shapes(&mut ui, width, height, 1.0);
            let mut panels = shapes
                .iter()
                .filter_map(|clipped| match &clipped.shape {
                    Shape::Rect(rect)
                        if rect.fill == super::rgb(super::CARD)
                            && rect.rect.width() < width * 0.7
                            && rect.rect.top() < height * 0.72 =>
                    {
                        Some(rect.rect)
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            panels.sort_by(|left, right| left.left().total_cmp(&right.left()));
            assert_eq!(panels.len(), 2, "expected the two management cards: {panels:?}");
            assert!(
                (panels[0].top() - panels[1].top()).abs() <= 1.0,
                "management cards should share a top edge: {panels:?}"
            );
            assert!(
                (panels[0].height() - panels[1].height()).abs() <= 1.0,
                "management cards should share a bottom edge: {panels:?}"
            );

            let texts = render_text_bounds(&mut ui, width, height, 1.0);
            let action_center_y = |label: &str| {
                texts
                    .iter()
                    .find(|(text, rect)| text == label && rect.is_positive())
                    .map(|(_, rect)| rect.center().y)
                    .unwrap_or_else(|| panic!("missing management action {label:?}"))
            };
            let patch_action_y = action_center_y("상태 검사");
            let backup_action_y = action_center_y("새로고침");
            assert!(
                (patch_action_y - backup_action_y).abs() <= 2.0,
                "patch and backup actions should align at {width}x{height}: patch={patch_action_y}, backup={backup_action_y}, panels={panels:?}"
            );
        }
    }

    #[test]
    fn patch_catalog_summaries_and_list_budget_scale_with_catalog_growth() {
        use crate::patch_set::{FeatureAvailability, PatchSelection};

        let availability = [
            FeatureAvailability::ManagerSelectable,
            FeatureAvailability::PreviewOnly,
            FeatureAvailability::PreviewOnly,
            FeatureAvailability::ManagerSelectable,
            FeatureAvailability::PreviewOnly,
        ];
        assert_eq!(
            super::patch_support_summary(availability),
            "설치 지원 2개 · 미리보기 전용 3개"
        );
        assert_eq!(
            super::patch_support_summary(std::iter::empty::<FeatureAvailability>()),
            "등록된 패치가 없습니다"
        );
        assert_eq!(
            super::patch_selection_summary(
                PatchSelection::parse_id("01+02").unwrap(),
                "변경 대기",
                &crate::patch_set::PATCH_CATALOG,
            ),
            "선택 2개 · 변경 대기"
        );
        assert_eq!(super::patch_list_max_height(380.0), 78.0);
        assert_eq!(super::patch_list_max_height(420.0), 88.0);
    }

    #[test]
    fn empty_backup_state_is_centered_and_patch_catalog_stays_visible() {
        for (width, height, scale) in [
            (600.0, 380.0, 1.0),
            (600.0, 380.0, 1.25),
            (600.0, 380.0, 1.5),
            (680.0, 420.0, 1.0),
            (680.0, 420.0, 1.25),
            (680.0, 420.0, 1.5),
        ] {
            let root = r"C:\test\LilacAnime";
            let mut ui = test_ui(root);
            ui.status = transaction::Status::new(
                "SOURCE_MISSING",
                "0.5.65",
                "선택한 폴더에서 resources/app.asar를 찾을 수 없습니다.",
            );
            let texts = render_text_bounds(&mut ui, width, height, scale);
            let bounds = |expected: &str| {
                texts
                    .iter()
                    .find(|(text, rect)| text.contains(expected) && rect.is_positive())
                    .map(|(_, rect)| *rect)
                    .unwrap_or_else(|| panic!("missing {expected:?} at {width}x{height} DPI {scale}"))
            };
            let heading = bounds("백업 · 복원");
            let empty = bounds("원본 연결 후 백업을 확인할 수 있습니다.");
            let refresh = bounds("새로고침");
            let content_center = (heading.bottom() + refresh.top()) / 2.0;
            assert!(
                (empty.center().y - content_center).abs() <= 16.0,
                "empty backup guidance should be visually centered between the heading and actions at {width}x{height} DPI {scale}: heading={heading:?}, empty={empty:?}, refresh={refresh:?}"
            );

            for patch in [
                "01 · 통합 검색·공급원 전환",
                "02 · 야애니 전용 탭",
                "03 · 2배속 버퍼링 최적화",
            ] {
                let rect = bounds(patch);
                assert!(
                    rect.left() >= 14.0
                        && rect.right() <= width - 14.0
                        && rect.top() >= 14.0
                        && rect.bottom() <= height - 14.0,
                    "catalog row {patch:?} clipped at {width}x{height} DPI {scale}: {rect:?}"
                );
            }
        }
    }

    #[test]
    fn long_errors_keep_the_main_view_fixed_and_details_remain_in_diagnostics() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        let long_error = "network error C:\\very-long-path\\segment ".repeat(80);
        ui.status = transaction::Status::new("SOURCE_MISSING", "0.5.65", long_error.clone());
        ui.operation_state = format!("오류 · {long_error}");
        ui.backup_error = Some(long_error.clone());
        ui.update_state = UpdateState::Failed(long_error.clone());
        let texts = render_text_bounds(&mut ui, 600.0, 380.0, 1.0);
        for expected in [
            "원본 파일 없음",
            "오류 ·",
            "백업 조회 오류",
            "업데이트 오류 · 자세히 확인",
            "상태 검사",
            "패치 적용",
            "패치 해제",
            "선택 백업 복원",
            "로그 복사",
            "진단 · 복구",
        ] {
            assert!(
                texts.iter().any(|(text, rect)| text.contains(expected) && rect.is_positive()),
                "fixed main view omitted {expected:?}: {texts:?}"
            );
        }
        let main_error = texts
            .iter()
            .find(|(text, _)| text.contains("오류 ·"))
            .expect("one-line result status should remain visible");
        assert!(
            main_error.1.height() <= 18.0,
            "long errors must truncate to one main-screen line: {main_error:?}"
        );
        ui.show_advanced = true;
        ui.show_update_details = true;
        let details = render_text_bounds(&mut ui, 900.0, 700.0, 1.0);
        assert!(details.iter().any(|(text, _)| text.contains("network error")));
    }

    #[test]
    fn minimum_layout_keeps_restore_and_patch_actions_visible_for_backup_and_status_variants() {
        let root = format!(r"C:\DinoPatchTest\{}\LilacAnime", "long-segment\\".repeat(12));
        let backup_scenarios = [
            (Vec::new(), None),
            (vec![item("backup-one", true)], Some("backup-one")),
            (
                vec![item("backup-a", true), item("backup-b", false)],
                Some("backup-b"),
            ),
        ];
        for (items, selected_id) in backup_scenarios {
            for status in ["APPLIED", "SOURCE_MISSING", "PARTIAL_OR_UNKNOWN"] {
                for (width, height, scale) in [
                    (600.0, 380.0, 1.0),
                    (600.0, 380.0, 1.25),
                    (600.0, 380.0, 1.5),
                    (680.0, 420.0, 1.0),
                    (680.0, 420.0, 1.25),
                    (680.0, 420.0, 1.5),
                ] {
                    let mut ui = test_ui(&root);
                    ui.status.status = status.to_owned();
                    ui.backup_items = items.clone();
                    ui.backup_list_root = Some(root.clone());
                    ui.selected_backup_id = selected_id.map(str::to_owned);
                    let texts = render_text_bounds(&mut ui, width, height, scale);
                    for required in [
                        "상태 검사",
                        "패치 적용",
                        "패치 해제",
                        "새로고침",
                        "선택 백업 복원",
                        "로그 복사",
                        "진단 · 복구",
                    ] {
                        let rect = texts
                            .iter()
                            .find(|(text, rect)| {
                                text.contains(required)
                                    && rect.is_positive()
                                    && rect.left() >= 14.0
                                    && rect.right() <= width - 14.0
                            })
                            .map(|(_, rect)| *rect)
                            .unwrap_or_else(|| {
                                panic!(
                                    "{required:?} missing for {status}, {} backups at {width}x{height} DPI {scale}: {texts:?}",
                                    items.len()
                                )
                            });
                        assert!(
                            rect.top() >= 14.0 && rect.bottom() <= height - 14.0,
                            "{required:?} clipped for {status}, {} backups at {width}x{height} DPI {scale}: {rect:?}",
                            items.len()
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn available_update_summary_stays_compact_and_changelog_is_separate() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        let candidate = super::release_update::ReleaseCandidate {
            tag: "v0.2.1-beta.1".into(),
            version: super::release_update::BetaVersion::parse_installed("0.2.1-beta.1").unwrap(),
            title: "UI verification fixture".into(),
            changelog: "long release note ".repeat(100),
            published_at: "2026-11-21".into(),
            asset_name: "dino-native-manager.exe".into(),
            download_url: "https://example.invalid/manager.exe".into(),
            sha256: "a".repeat(64),
        };
        ui.update_state = UpdateState::Available(candidate);
        for (width, height, scale) in [
            (600.0, 380.0, 1.0),
            (600.0, 380.0, 1.25),
            (600.0, 380.0, 1.5),
            (680.0, 420.0, 1.0),
            (680.0, 420.0, 1.25),
            (680.0, 420.0, 1.5),
        ] {
            let texts = render_text_bounds(&mut ui, width, height, scale);
            for required in ["새 버전 v0.2.1-beta.1", "세부 정보", "상태 검사", "로그 복사"] {
                let rect = texts
                    .iter()
                    .find(|(text, rect)| text.contains(required) && rect.is_positive())
                    .map(|(_, rect)| *rect)
                    .unwrap_or_else(|| panic!("update summary omitted {required:?}: {texts:?}"));
                assert!(
                    rect.top() >= 14.0 && rect.bottom() <= height - 14.0,
                    "update summary {required:?} clipped at {width}x{height} DPI {scale}: {rect:?}"
                );
            }
            assert!(
                !texts.iter().any(|(text, _)| text.contains("long release note")),
                "release notes must stay out of the fixed main surface"
            );
        }
        ui.show_update_details = true;
        let details = render_text_bounds(&mut ui, 680.0, 420.0, 1.0);
        assert!(details.iter().any(|(text, _)| text.contains("long release note")));
    }

    #[test]
    fn monitor_distinguishes_missing_asar_from_invalid_or_present_file() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "dino-gui-archive-watch-{}-{nonce}",
            std::process::id()
        ));
        let archive = root.join("resources").join("app.asar");

        assert_eq!(inspect_monitored_archive(&archive), ArchiveWatch::Missing);
        std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
        std::fs::write(&archive, b"fixture").unwrap();
        assert!(matches!(
            inspect_monitored_archive(&archive),
            ArchiveWatch::Available(7, _)
        ));
        std::fs::remove_file(&archive).unwrap();
        std::fs::create_dir(&archive).unwrap();
        assert!(matches!(
            inspect_monitored_archive(&archive),
            ArchiveWatch::Invalid(_)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn monitor_reports_missing_asar_without_queueing_patch_work() {
        let root = std::env::temp_dir().join(format!(
            "dino-gui-missing-source-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut ui = test_ui(&root.to_string_lossy());
        ui.auto_enabled = true;
        ui.status = transaction::Status::new("SOURCE_FOUND", "", "호환성 검사 대기");
        ui.last_monitor = Instant::now() - std::time::Duration::from_secs(5);

        ui.monitor();

        assert_eq!(ui.status.status, "SOURCE_MISSING");
        assert!(ui.status.reason.contains("resources/app.asar"));
        assert!(ui.operation_state.contains("자동 적용을 보류"));
        assert!(!ui.busy);
        assert!(ui.response.is_none());
        assert!(ui.pending_action.is_none());
    }

    #[test]
    fn missing_original_home_message_is_not_a_patch_failure() {
        let root = std::env::temp_dir().join(format!(
            "dino-gui-empty-source-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut ui = test_ui(&root.to_string_lossy());
        ui.status = transaction::Status::new(
            "SOURCE_MISSING",
            "",
            "선택한 폴더에서 resources/app.asar를 찾을 수 없습니다.",
        );
        let rendered = render_text_bounds(&mut ui, 680.0, 420.0, 1.0);
        let texts = rendered
            .iter()
            .map(|(text, _)| text.as_str())
            .collect::<Vec<_>>();
        assert!(texts
            .iter()
            .any(|text| text.contains("원본 파일을 찾을 수 없습니다")));
        assert!(texts.iter().any(|text| text.contains("resources/app.asar")));
        assert!(!texts.iter().any(|text| text.contains("변경이 중단됨")));
    }

    #[test]
    fn compact_confirmation_keeps_wrapped_restore_details_and_actions_on_screen() {
        let root = format!(
            r"C:\DinoPatchTest\{}\LilacAnime",
            "very-long-install-segment\\".repeat(8)
        );
        let mut ui = test_ui(&root);
        ui.backup_items = vec![item("backup-20261114T120000Z", true)];
        ui.selected_backup_id = Some("backup-20261114T120000Z".into());
        ui.pending_action = Some("백업 복원");
        for native_scale in [1.0, 1.25, 1.5] {
            let texts = render_text_bounds(&mut ui, 600.0, 380.0, native_scale);
            for required in ["취소", "계속", "백업 ID:"] {
                let rect = texts
                    .iter()
                    .find(|(text, _)| text.contains(required))
                    .map(|(_, rect)| *rect);
                assert!(
                    rect.is_some(),
                    "confirmation omitted {required:?} at DPI {native_scale}: {texts:?}"
                );
                let rect = rect.unwrap();
                assert!(
                    rect.left() >= -1.0 && rect.right() <= 601.0,
                    "confirmation action {required:?} overflowed horizontally: {rect:?}"
                );
                if required == "취소" || required == "계속" {
                    assert!(rect.top() >= -1.0 && rect.bottom() <= 441.0,
                        "confirmation action {required:?} is outside the 600x380 viewport: {rect:?}");
                }
            }
        }
    }

    #[test]
    fn integrated_render_exposes_status_patch_backup_and_management_controls() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.show_advanced = true;
        let rendered = render_text_bounds(&mut ui, 680.0, 1600.0, 1.0);
        let texts = rendered
            .iter()
            .map(|(text, _)| text.as_str())
            .collect::<Vec<_>>();
        for required in [
            "DinoPatch",
            "통합 검색·공급원 전환",
            "야애니 전용 탭",
            "2배속 버퍼링 최적화",
            "LilacAnime v0.5.65",
            "C:/test/LilacAnime",
            "상태 검사",
            "패치 적용",
            "패치 해제",
            "백업 · 복원",
            "선택 백업 복원",
            "자동 적용",
            "로그 복사",
            "진단 닫기",
            "적용됨",
            "관리자 설치 지원",
            "복원 가능한 백업이 없습니다",
            "DinoPatch 업데이트",
            "최신 버전",
            "0.2.0-beta.9",
            "최근 작업",
            "복구 도구",
        ] {
            assert!(
                texts.iter().any(|text| text.contains(required)),
                "integrated view omitted {required:?}: {texts:?}"
            );
        }
        assert!(texts.iter().any(|text| text.contains("호환성 확인 완료")));
        assert!(!texts.iter().any(|text| ["홈"].contains(text)));
    }

    #[test]
    fn long_path_tooltip_preview_is_bounded_but_keeps_copy_source_intact() {
        let path = format!(r"C:\DinoPatchTest\{}\LilacAnime", "very-long-segment\\".repeat(60));
        let preview = super::path_tooltip_preview(&path);
        assert!(preview.chars().count() <= super::PATH_TOOLTIP_MAX_CHARS);
        assert!(preview.contains('…'));
        assert!(preview.contains('\n'));
        assert!(path.len() > preview.len());
        assert!(preview.starts_with(r"C:\DinoPatchTest\"));
        assert!(preview.ends_with(r"\LilacAnime"));
    }

    #[test]
    fn installation_path_display_uses_unambiguous_separators() {
        let actual_path = r"D:\Codex-Coding-Folder\Lilac-Dino-Patch";
        assert_eq!(
            super::display_installation_path(actual_path),
            "D:/Codex-Coding-Folder/Lilac-Dino-Patch"
        );
        assert_eq!(actual_path, r"D:\Codex-Coding-Folder\Lilac-Dino-Patch");
    }

    #[test]
    fn management_controls_stay_visible_and_diagnostic_details_expand_on_demand() {
        let mut ui = test_ui(r"C:\test\LilacAnime");
        ui.show_advanced = false;
        let compact = render_text_bounds(&mut ui, 680.0, 420.0, 1.0)
            .into_iter()
            .map(|(text, _)| text)
            .collect::<Vec<_>>();
        assert!(compact
            .iter()
            .any(|text| text == "자동 적용"));
        assert!(compact.iter().any(|text| text == "로그 복사"));
        assert!(compact.iter().any(|text| text == "진단 · 복구"));
        assert!(!compact.iter().any(|text| text == "최근 작업"));
        assert!(!compact.iter().any(|text| text == "복구 도구"));

        ui.show_advanced = true;
        let diagnostics_open = render_text_bounds(&mut ui, 680.0, 1600.0, 1.0)
            .into_iter()
            .map(|(text, _)| text)
            .collect::<Vec<_>>();
        assert!(diagnostics_open
            .iter()
            .any(|text| text == "자동 적용"));
        assert!(diagnostics_open
            .iter()
            .any(|text| text == "최근 작업"));
        assert!(diagnostics_open
            .iter()
            .any(|text| text == "복구 도구"));
    }
}
