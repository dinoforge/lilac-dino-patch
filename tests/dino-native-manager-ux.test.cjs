'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const gui=fs.readFileSync(path.resolve(__dirname,
  '../tools/dino-patch-manager/native-rust/src/gui.rs'),'utf8');
const patchModel=fs.readFileSync(path.resolve(__dirname,
  '../tools/dino-patch-manager/native-rust/src/patch_set.rs'),'utf8');
const transaction=fs.readFileSync(path.resolve(__dirname,
  '../tools/dino-patch-manager/native-rust/src/transaction.rs'),'utf8');
const method=(begin,end)=>{
  const start=gui.indexOf(begin);
  const finish=gui.indexOf(end,start+begin.length);
  assert.ok(start>=0 && finish>start,'UI function anchor not found: '+begin);
  return gui.slice(start,finish);
};
const source=method('    fn installation_path_section(&mut self, ui: &mut Ui) {',
  '    fn patch_actions_section(&mut self, ui: &mut Ui) {');
const pathHelpers=gui.slice(gui.indexOf('fn path_tooltip_preview('),
  gui.indexOf('#[derive(Clone, Copy)]\nenum StatusTone'));
const patchActions=method('    fn patch_actions_section(&mut self, ui: &mut Ui) {',
  '    fn backup_restore_section(&mut self, ui: &mut Ui, panel_content_height: f32) {');
const backupScreen=method('    fn backup_restore_section(&mut self, ui: &mut Ui, panel_content_height: f32) {',
  '    fn settings_section(&mut self, ui: &mut Ui) {');
const updateSection=method('    fn update_section(&mut self, ui: &mut Ui, _ctx: &egui::Context) {',
  '    fn update_details_content(&mut self, ui: &mut Ui, ctx: &egui::Context) {');
const updateDetails=method('    fn update_details_content(&mut self, ui: &mut Ui, ctx: &egui::Context) {',
  '    fn update_details_window(&mut self, ctx: &egui::Context) {');
const settingsScreen=method('    fn settings_section(&mut self, ui: &mut Ui) {',
  '    fn diagnostics_section(&mut self, ui: &mut Ui, ctx: &egui::Context) {');
const diagnosticsScreen=method('    fn diagnostics_section(&mut self, ui: &mut Ui, ctx: &egui::Context) {',
  '    fn recovery_tools_section(&mut self, ui: &mut Ui) {');
const footer=method('    fn settings_diagnostics_section(&mut self, ui: &mut Ui, ctx: &egui::Context) {',
  '    fn result_card(&mut self, ui: &mut Ui) {');
const integratedContent=method('    fn render_integrated_content(&mut self, ui: &mut Ui, ctx: &egui::Context) {',
  '    fn render_main(&mut self, ctx: &egui::Context) {');

test('path editor drafts user input before committing the selected root',()=>{
  assert.match(gui,/path_draft: String/);
  assert.match(source,/TextEdit::singleline\(&mut self\.path_draft\)/);
  assert.doesNotMatch(source,/TextEdit::singleline\(&mut self\.root\)/);
  const change=source.indexOf('let candidate = self.path_draft.trim().to_owned();');
  const assign=source.indexOf('self.set_root(candidate);');
  const inspect=source.indexOf('self.enqueue("원본 다시 확인");');
  assert.ok(change>=0 && assign>change && inspect>assign);
  assert.match(gui,/fn set_root\(&mut self, root: String\)[\s\S]*?self\.task_generation = self\.task_generation\.wrapping_add\(1\);[\s\S]*?self\.clear_backup_list\(\)/,
    'changing the installation root must invalidate list, selection, and stale task results');
  assert.match(gui,/fn clear_backup_list\(&mut self\)[\s\S]*?self\.backup_items\.clear\(\)[\s\S]*?self\.selected_backup_id = None/);
});

test('path edits are cancelable and disabled while another operation is running',()=>{
  const editor=method('    fn path_editor_window(&mut self, ctx: &egui::Context) {',
    '    fn patch_actions_section(&mut self, ui: &mut Ui) {');
  assert.match(editor,/ui\.add_enabled\(\s*!self\.busy,\s*egui::TextEdit::singleline/);
  assert.match(editor,/action\(ui, "취소", ButtonTone::Secondary, !self\.busy\)/);
  assert.match(source,/self\.path_draft = self\.root\.clone\(\)/);
  assert.match(editor,/self\.show_path_editor = open && !close_after_action/);
});

test('manual patch controls require a supported selection and valid transition state',()=>{
  assert.match(gui,/fn can_apply_confirmed_selection\(&self\) -> bool/);
  assert.match(patchActions,/self\.can_apply_confirmed_selection\(\)/,
    'manual installation is limited to the explicitly confirmed supported target');
  assert.match(gui,/let Some\(desired\) = self\.confirmed_patch_selection\.as_patch_set\(\)/);
  assert.match(gui,/self\.confirmed_patch_selection\.manager_install_supported\(\)/);
  assert.match(gui,/different_from_installed[\s\S]*?installed != desired/);
  assert.doesNotMatch(patchActions,/transaction::apply\(/,
    'the UI delegates all file changes through the guarded worker');
  assert.match(patchActions,/action_button\(\s*ui,\s*"패치 해제",\s*ButtonTone::Danger,[\s\S]*?"APPLIED"\s*\|\s*"ALREADY_APPLIED"/,
    'uninstall remains gated by a verified applied state in the fixed-size action row');
  assert.match(backupScreen,/if action\(\s*ui,\s*"선택 백업 복원",\s*ButtonTone::Danger,[\s\S]*?self\.can_restore_selected_backup\(\)/);
  assert.match(gui,/self\.ask\("디노 패치 수동 적용"\)/);
  assert.match(gui,/self\.confirmation\(ctx\)/);
});

test('operation progress is event-driven and stale worker results are discarded',()=>{
  assert.match(gui,/enum WorkerMessage \{\s*Progress\s*\{\s*root: String,\s*generation: u64,\s*text: &'static str/);
  assert.match(gui,/fn operation_stage\(kind: &str\) -> &'static str/);
  assert.match(gui,/"작업 결과와 현재 파일 상태 확인 중"/);
  assert.match(gui,/fn task_is_current\(&self, root: &str, generation: u64\) -> bool/);
  assert.match(gui,/if self\.task_is_current\(&root, generation\)/);
  assert.match(gui,/if self\.task_is_current\(&event\.root, event\.generation\)/);
  const stages=method('fn operation_stage(kind: &str) -> &\'static str {',
    'fn completed_operation_state(');
  assert.doesNotMatch(stages,/\b\d{1,3}%|progress_fraction|percent_complete/,
    'operation stage labels must not imply measured percentage progress');
});

test('worker success, engine errors, state recheck failure and disconnect all clear busy safely',()=>{
  assert.match(gui,/std::panic::catch_unwind\(std::panic::AssertUnwindSafe\(\|\|\s*\{\s*match kind/);
  assert.match(gui,/status_error: Option<String>/);
  assert.match(gui,/self\.busy = false;\s*self\.response = None;/);
  assert.match(gui,/if disconnected && self\.busy/);
  assert.match(gui,/self\.operation_state = "오류 발생 · 작업 응답이 끊겼습니다"/);
  assert.match(gui,/self\.show_advanced = true;\s*self\.show_log = true;/);
});

test('backup lookup uses only engine output off the UI thread and retains each returned item',()=>{
  assert.match(transaction,/pub fn backups\(root:&Path\)->Result<Value>/);
  assert.match(gui,/let backups = match std::panic::catch_unwind[\s\S]*?transaction::backups\(&root\)/);
  assert.match(gui,/fn parse_backup_items\(value: &serde_json::Value\)[\s\S]*?items\.iter\(\)\.enumerate\(\)\.map/);
  assert.match(backupScreen,/for backup in &items/);
  assert.match(backupScreen,/selectable_value\([\s\S]*?self\.selected_backup_id/);
  assert.match(gui,/RichText::new\(&backup\.id\)[\s\S]*?\.truncate\(\)/);
  assert.match(gui,/let date = format!\("v\{\} · \{\}", backup\.version, backup\.created_at\)/);
  assert.match(gui,/if backup\.restorable \{[\s\S]*?"복원 가능"[\s\S]*?"복원 불가"/);
  assert.doesNotMatch(backupScreen,/transaction::backups|std::fs::|sha256|sha\(/,
    'rendering the list must not perform disk access or hash work');
  assert.match(gui,/"백업 목록 새로 고침"/);
});

test('restore sends only the selected restorable ID and preserves engine verification',()=>{
  assert.match(gui,/fn selected_backup\(&self\)[\s\S]*?self\.backup_items\.iter\(\)\.find\(\|item\| item\.id == id\)/);
  assert.match(gui,/fn can_restore_selected_backup\(&self\) -> bool[\s\S]*?"APPLIED" \| "ALREADY_APPLIED"[\s\S]*?item\.restorable/);
  assert.match(gui,/fn requested_backup_id\(&self, kind: &str\) -> Option<String>[\s\S]*?kind == "백업 복원"[\s\S]*?self\.selected_backup_id\.clone\(\)/);
  assert.match(gui,/transaction::restore\(&root, id\)/);
  assert.match(transaction,/if state\["backupId"\]\.as_str\(\)!=Some\(backup_id\)/);
  assert.match(gui,/대상 경로: \{\}/);
  assert.match(gui,/현재 앱 버전: v\{\}/);
  assert.match(gui,/선택 백업 버전: v\{\}/);
  assert.match(gui,/백업 ID: \{\}/);
  assert.match(gui,/ConfirmationChoice::Cancel => self\.pending_action = None/);
  assert.match(gui,/ConfirmationChoice::Start\(operation\) => \{\s*self\.pending_action = None;\s*self\.enqueue\(operation\);/);
  assert.match(gui,/let can_continue = operation != "백업 복원" \|\| self\.can_restore_selected_backup\(\)/);
});

test('errors expand settings and diagnostics details and preserve the recent log',()=>{
  assert.match(gui,/self\.show_advanced = true;\s*self\.show_log = true;/);
  assert.match(diagnosticsScreen,/heading\(ui, "최근 작업"\)/);
  assert.match(footer,/"로그 복사"/);
  assert.match(footer,/ctx\.copy_text\(self\.activity\.join\("\\n"\)\)/);
});

test('all core manager functions fit on one fixed screen without page navigation',()=>{
  const sections=['installation_path_section','patch_actions_section',
    'backup_restore_section'];
  let previous=-1;
  for(const section of sections){
    const at=integratedContent.indexOf(`self.${section}(`);
    assert.ok(at>previous,`integrated screen is missing or misorders ${section}`);
    previous=at;
  }
  assert.match(integratedContent,/ui\.columns\(2,[\s\S]*?patch_actions_section[\s\S]*?backup_restore_section/);
  assert.match(footer,/self\.status_summary\(\)/,
    'idle source status is summarized in the fixed result bar');
  const renderMain=method('    fn render_main(&mut self, ctx: &egui::Context) {',
    'impl eframe::App for DinoUi');
  assert.doesNotMatch(renderMain,/ScrollArea::/,
    'the main surface has no vertical or horizontal scrolling area');
  assert.match(renderMain,/self\.settings_diagnostics_section\(ui, ctx\)/,
    'the compact operation and diagnostic controls stay fixed at the bottom');
  assert.match(gui,/fn diagnostics_window\([\s\S]*?self\.diagnostics_section\(ui, ctx\);[\s\S]*?self\.recovery_tools_section\(ui\)/,
    'diagnostics and recovery remain available in a separately scrollable window');
  assert.doesNotMatch(gui,/ManagerScreen|compact_navigation|navigation_button|fn sidebar\(/);
  assert.match(gui,/fn next_step\(status: &transaction::Status, busy: bool\)/);
  assert.match(gui,/CONFLICT" \| "PARTIAL_OR_UNKNOWN" \| "UNSUPPORTED"/);
});

test('integrated header prioritizes current state and preserves source version details',()=>{
  const summary=method('    fn status_summary(&self) -> String {',
    '    fn installation_path_section(&mut self, ui: &mut Ui) {');
  assert.match(summary,/통합 검색·공급원 전환 · 적용됨/);
  assert.match(summary,/패치를 적용할 수 있습니다/);
  const renderMain=method('    fn render_main(&mut self, ctx: &egui::Context) {',
    'impl eframe::App for DinoUi');
  assert.match(renderMain,/badge_for\(&self\.status\)/);
  assert.match(renderMain,/automatic_apply_waiting_for_source\([\s\S]*?"원본 확인 대기"/);
  assert.match(renderMain,/format!\("LilacAnime v\{\}", self\.status\.version\)/);
  assert.match(renderMain,/RichText::new\("DinoPatch"\)[\s\S]*?size\(20\.0\)/);
});

test('patch catalog exposes stable IDs and labels while blocking uninstalled preview features',()=>{
  assert.match(patchModel,/IntegratedSearchProviderSwitch/);
  assert.match(patchModel,/IntegratedSearchProviderSwitch => "통합 검색·공급원 전환"/);
  assert.match(patchModel,/AdultOnlyTab => "야애니 전용 탭"/);
  assert.match(patchModel,/DoubleSpeedBuffering => "2배속 버퍼링 최적화"/);
  assert.match(patchActions,/for feature in patch_set::PATCH_CATALOG/);
  assert.match(patchModel,/enum FeatureAvailability\s*\{[\s\S]*?ManagerSelectable[\s\S]*?PreviewOnly/);
  assert.match(patchActions,/let actual_status = actual_patch_status\(feature\.id, &self\.status\)\.0/);
  assert.match(patchActions,/patch_row_status\(feature, &self\.status\)/);
  assert.match(patchActions,/FeatureAvailability::PreviewOnly => "미리보기 전용 · 설치 미지원"/);
  assert.match(gui,/FeatureAvailability::PreviewOnly => \("미리보기", StatusTone::Preview\)/,
    'compact row badge fits the narrow layout while the tooltip retains the full support label');
  assert.match(patchActions,/feature\.display_name/);
  assert.match(patchActions,/row\.checkbox\(/,
    'target selection is an actual checkbox distinct from the installed-status badge');
  assert.match(patchActions,/compact_pill\(row, row_status, tone\)/,
    'the row badge shows actual status for supported patches and preview-only support for blocked patches');
  assert.match(patchActions,/실제 설치 상태: \{actual_status\}\. 지원 상태: \{availability\}/,
    'hover details keep actual installation status separate from support capability');
  assert.match(gui,/fn integrated_patch_status_tone\(status: &str\)/);
  assert.match(gui,/StatusTone::Preview => \(0xEFE9FA, 0x583A99\)/);
  assert.match(patchActions,/미리보기 전용 · 설치 미지원/);
  assert.match(patchActions,/실제 설치 상태: \{actual_status\}\. 지원 상태: \{availability\}/);
  assert.match(gui,/선택 변경 미확정 · 자동 적용 보류/);
  assert.match(gui,/선택 조합 설치 미지원 · 자동 적용 보류/);
  assert.match(patchActions,/selection_id/);
  assert.match(patchActions,/selection_state/);
});

test('update section is compact and keeps long release details in its own window',()=>{
  assert.match(updateSection,/card\(ui,[\s\S]*?DinoPatch 업데이트/);
  assert.match(updateSection,/compiled_manager_version\(\)/);
  assert.match(updateSection,/UpdateState::Available\(candidate\)[\s\S]*?새 버전 \{\}/);
  assert.match(updateSection,/업데이트 확인/);
  assert.match(updateSection,/세부 정보/);
  assert.match(updateDetails,/UpdateState::Available\(candidate\)[\s\S]*?ScrollArea::vertical\(\)/);
  assert.match(updateDetails,/candidate\.changelog\.clone\(\)/);
  assert.match(gui,/fn update_details_window\([\s\S]*?max_size\(max_size\)/);
  assert.match(gui,/UpdateState::Failed\(error\)[\s\S]*?\.wrap\(\)/);
});

test('main footer exposes auto-monitor toggle, recent work, log copy and diagnostic access',()=>{
  assert.match(patchActions,/heading\(ui, "패치 관리"\)/);
  assert.match(settingsScreen,/egui::Checkbox::new\(\s*&mut self\.auto_enabled/);
  assert.match(settingsScreen,/RichText::new\("자동 적용"\)/);
  assert.match(settingsScreen,/호환되는 공식 v0\.5\.65 원본을 확인하면 저장된 선택 구성을 자동으로 유지합니다/);
  assert.match(settingsScreen,/검증된 일곱 조합만 적용하며,[\s\S]*?미지원 조합·충돌·검증 실패에서는 자동 적용을 보류합니다/);
  assert.doesNotMatch(settingsScreen,/compact_pill\(ui, "원본 확인 대기"/,
    'source waiting is consolidated into the single header status badge');
  const renderMain=method('    fn render_main(&mut self, ctx: &egui::Context) {',
    'impl eframe::App for DinoUi');
  assert.match(renderMain,/Vec2::new\(6\.0, if compact \{ 2\.0 \} else \{ 6\.0 \}\)/,
    'standard windows use more breathing room while the minimum viewport stays compact');
  assert.doesNotMatch(settingsScreen,/화면 표시/);
  assert.match(footer,/진단 · 복구/);
  assert.match(footer,/ctx\.copy_text\(self\.activity\.join\("\\n"\)\)/);
  assert.match(footer,/self\.operation_state/);
  assert.match(diagnosticsScreen,/max_height\(180\.0\)/);
  assert.match(diagnosticsScreen,/경로 복사/);
  assert.doesNotMatch(footer,/self\.diagnostics_section|self\.recovery_tools_section/,
    'the fixed footer contains only compact controls');
  assert.doesNotMatch(integratedContent,/self\.diagnostics_section|self\.recovery_tools_section/,
    'opening diagnostics must not expand the fixed main screen');
  assert.match(gui,/fn diagnostics_window\(&mut self, ctx: &egui::Context\)[\s\S]*?Window::new\("진단 · 복구"\)[\s\S]*?self\.diagnostics_section\(ui, ctx\)/,
    'diagnostic details open independently of the main layout');
  assert.match(gui,/self\.show_advanced = !self\.show_advanced/);
  assert.doesNotMatch(gui,/CollapsingHeader::new\("설정"\)/);
});

test('compact window truncates long paths and keeps copy and change actions separate',()=>{
  assert.match(gui,/with_inner_size\(\[680\.0, 420\.0\]\)/);
  assert.match(gui,/with_min_inner_size\(\[600\.0, 380\.0\]\)/);
  assert.match(gui,/centered: true/);
  assert.match(pathHelpers,/Label::new\([\s\S]*?\.truncate\(\)/);
  assert.match(source,/"경로 복사"[\s\S]*?"폴더 선택"[\s\S]*?"직접 입력"/);
  assert.match(source,/let path_width = \(row\.available_width\(\)[\s\S]*?spacing \* 4\.0[\s\S]*?row\.add_sized\(\s*Vec2::new\(70\.0, BUTTON_HEIGHT\)/,
    'path width calculation includes the label, all three buttons and their four gaps');
  assert.match(source,/row\.ctx\(\)\.copy_text\(self\.root\.clone\(\)\)/);
  assert.match(pathHelpers,/on_hover_ui\(move \|tooltip\|/);
  assert.match(pathHelpers,/set_max_size\(PATH_TOOLTIP_MAX_SIZE\)/);
  assert.match(gui,/const PATH_TOOLTIP_MAX_SIZE: Vec2 = Vec2::new\(320\.0, 100\.0\)/);
  assert.match(pathHelpers,/fill\(rgb\(CARD\)\)/);
  assert.doesNotMatch(pathHelpers,/on_hover_text\(path\)/);
  assert.match(source,/choose_folder = action_button\([\s\S]*?"폴더 선택"/);
  assert.match(source,/Vec2::new\(88\.0, BUTTON_HEIGHT\)[\s\S]*?"직접 입력"/);
  assert.match(gui,/const BUTTON_HEIGHT: f32 = 38\.0/);
  assert.match(gui,/fn action_button_palette\(tone: ButtonTone, enabled: bool\)/);
  assert.match(gui,/return \(DISABLED_FILL, DISABLED_TEXT, DISABLED_BORDER\)/,
    'disabled controls use a named light neutral palette with readable labels');
  assert.match(gui,/const MUTED: u32 = 0x4C596E/);
  assert.match(gui,/let compact = ctx\.content_rect\(\)\.height\(\) <= 400\.0;[\s\S]*?let vertical_inset = if compact[\s\S]*?inner_margin\(Margin::symmetric\(14, vertical_inset\)\)/);
  assert.doesNotMatch(method('    fn render_main(&mut self, ctx: &egui::Context) {',
    'impl eframe::App for DinoUi'),/ScrollArea::/);
  assert.match(gui,/tooltip_width = PATH_TOOLTIP_MAX_SIZE\.x/);
});

test('diagnostic path uses a copy action without a tooltip overlay',()=>{
  assert.match(diagnosticsScreen,/path_action_row\(ui, &log_path, "경로 복사", 82\.0, true, false\)/);
  assert.match(gui,/fn action_button\([\s\S]*?min_size\(min_size\)[\s\S]*?on_disabled_hover_text/);
  assert.match(source,/edit_path = action_button\([\s\S]*?"직접 입력"/);
});

test('installation path display avoids yen-like backslash glyphs but copy retains the real path',()=>{
  assert.match(gui,/fn display_installation_path\(path: &str\) -> String\s*\{\s*path\.replace\('\\\\', "\/"\)\s*\}/);
  assert.match(source,/display_installation_path\(self\.root\.trim\(\)\)/,
    'only the displayed label and tooltip use normalized separators');
  assert.match(source,/copy_text\(self\.root\.clone\(\)\)/,
    'clipboard contents retain the actual Windows path');
});

test('backup empty and unavailable states explain why restore cannot run',()=>{
  assert.match(backupScreen,/원본 연결 후 백업을 확인할 수 있습니다\./);
  assert.match(backupScreen,/if !items\.is_empty\(\)[\s\S]*?native-backup-selection/,
    'empty backup state omits redundant empty selector and detail prompt');
  assert.match(backupScreen,/설치 경로가 변경됨 · 새로고침 필요/);
  assert.match(backupScreen,/복원 가능한 백업이 없습니다/);
  assert.match(gui,/상태 확인 필요 · 원본과 백업을 유지했습니다/);
});

test('patch selection, actual installation status and support status are distinct',()=>{
  assert.match(patchActions,/let actual_status = actual_patch_status\(feature\.id, &self\.status\)\.0/);
  assert.match(patchActions,/patch_row_status\(feature, &self\.status\)/);
  assert.match(gui,/else if id == patch_set::PatchId::IntegratedSearchProviderSwitch \{[\s\S]*?integrated_patch_status\(&status\.status\)[\s\S]*?else \{\s*\("확인 불가", StatusTone::Warning\)/);
  assert.match(patchActions,/patch_support_summary\([\s\S]*?PATCH_CATALOG/);
  assert.match(gui,/fn patch_support_summary\(/,
    'support counts are derived from availability metadata, not hard-coded patch IDs');
  assert.match(patchActions,/egui::ScrollArea::vertical\(\)[\s\S]*?max_height\(patch_list_max_height/,
    'additional catalog rows are contained to the patch list instead of expanding the window');
  assert.match(gui,/fn patch_list_max_height\(viewport_height: f32\)/);
  assert.match(patchActions,/status_style\(StatusTone::Preview\)/,
    'preview support is visually distinct from an unknown installation state');
  assert.match(patchActions,/compact_pill\(row, row_status, tone\)/);
  assert.match(patchActions,/!self\.confirmed_patch_selection\.manager_install_supported\(\)[\s\S]*?"설치 미지원"/);
  assert.match(patchActions,/patch_selection_summary\([\s\S]*?self\.draft_patch_selection/);
  assert.match(gui,/fn patch_selection_summary\([\s\S]*?선택 \{count\}개/,
    'selection status summarizes a catalog-sized target instead of listing IDs inline');
  assert.match(patchActions,/"선택 저장"/);
  assert.match(patchActions,/실제 설치 상태: \{actual_status\}\. 지원 상태: \{availability\}/);
});

test('the footer uses leftover height without hiding main controls',()=>{
  const renderMain=method('    fn render_main(&mut self, ctx: &egui::Context) {',
    'impl eframe::App for DinoUi');
  assert.match(renderMain,/let footer_reserve = BUTTON_HEIGHT \+ 12\.0 \+ ui\.spacing\(\)\.item_spacing\.y/);
  assert.match(renderMain,/let flexible_gap = \(ui\.available_height\(\) - footer_reserve\)\.max\(0\.0\)/);
  assert.match(renderMain,/ui\.add_space\(flexible_gap\)/);
  assert.match(patchActions,/interact_size\.y = if compact \{ 20\.0 \} else \{ 22\.0 \}/);
});

test('management columns use a shared card height and align their action rows',()=>{
  assert.match(integratedContent,/let patch_card_height = card\([\s\S]*?patch_actions_section/);
  assert.match(integratedContent,/card_with_min_height\([\s\S]*?backup_restore_section/);
  assert.match(backupScreen,/action_gap = \(panel_content_height - used_content_height - BUTTON_HEIGHT\)/);
  assert.match(gui,/fn main_management_cards_share_height_and_action_rows_align\(\)/,
    'render tests verify equal card edges and aligned controls at both supported window sizes');
  assert.match(gui,/fn empty_state_vertical_offset\(/);
  assert.match(backupScreen,/empty_state_vertical_offset\([\s\S]*?summary_height[\s\S]*?BUTTON_HEIGHT/,
    'empty backup guidance is centered while actions stay aligned at the card bottom');
  assert.match(gui,/fn empty_backup_state_is_centered_and_patch_catalog_stays_visible\(\)/,
    'render tests cover the empty state and all patch rows at compact and standard sizes');
});

test('update links are read-only and the GUI never starts a shell subprocess',()=>{
  assert.match(diagnosticsScreen,/DinoPatch/);
  assert.match(diagnosticsScreen,/release_update::RELEASES_BASE/);
  assert.doesNotMatch(diagnosticsScreen,/dinoforge\/lilac-dino-patch\/releases/);
  assert.match(diagnosticsScreen,/https:\/\/github\.com\/whispelyn-byte\/LilacAnime-desktop\/releases/);
  assert.doesNotMatch(gui,/Command::new|std::process::Command|cmd\.exe|powershell\.exe/i);
});


test('manual text zoom controls and persistence are removed in favor of system DPI',()=>{
  assert.match(settingsScreen,/egui::Checkbox::new\(\s*&mut self\.auto_enabled/);
  assert.match(gui,/self\.settings_section\(status_row\)/);
  assert.doesNotMatch(settingsScreen,/화면 표시|Windows 표시 배율/);
  assert.doesNotMatch(gui,/TEXT_ZOOM|text_zoom_index|readability_controls|set_zoom_factor/);
  assert.doesNotMatch(gui,/기본 100%|크게 120%|매우 크게 140%|글자 크기 선택/);
});
test('light UI palette keeps secondary text readable against page and cards',()=>{
  const foreground=Number(gui.match(/const MUTED: u32 = (0x[0-9A-F]+);/)?.[1]);
  const bgColors=['CARD','PAGE'].map(name=>
    Number(gui.match(new RegExp(`const ${name}: u32 = (0x[0-9A-F]+);`))?.[1]));
  const luminance=color=>{
    const rgb=[color>>16&255,color>>8&255,color&255]
      .map(x=>x/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);
    return 0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2];
  };
  for(const background of bgColors){
    const a=luminance(foreground),b=luminance(background);
    assert.ok((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5,
      'secondary text must remain readable against card/page backgrounds');
  }
  assert.match(gui,/Visuals::light\(\)/);
  assert.match(gui,/const PAGE: u32 = 0xF3F5FA/);
  assert.match(gui,/const CARD: u32 = 0xFFFFFF/);
  assert.match(gui,/StatusTone::Warning => \(0xFFF1CC, 0x745000\)/);
  assert.match(gui,/StatusTone::Bad => \(0xFBE7E9, 0x982D3B\)/);
  assert.match(gui,/FontId::new\(HELP_TEXT_SIZE, FontFamily::Monospace\)/);
});
test('Windows Korean fonts use multiple local fallback candidates without embedding files',()=>{
  assert.match(gui,/let candidates = \["malgun\.ttf", "malgunbd\.ttf", "malgunsl\.ttf"\]/);
  assert.match(gui,/ctx\.set_fonts\(fonts\)/);
  assert.match(gui,/Windows Korean font missing/);
  assert.doesNotMatch(gui,/include_bytes!\([^)]*\.(?:ttf|otf)/);
});
test('small-window headers and patch labels wrap rather than clipping',()=>{
  const patch=patchActions;
  const overview=method('    fn status_summary(&self) -> String {',
    '    fn installation_path_section(&mut self, ui: &mut Ui) {');
  assert.match(patch,/list\.horizontal_wrapped\(\|row\|/,
    'patch name and actual-state rows may wrap inside the narrow card');
  assert.match(patch,/let apply_label = if selection_is_pending[\s\S]*?"선택 저장"[\s\S]*?ui\.horizontal\(\|ui\|[\s\S]*?"상태 검사"[\s\S]*?apply_label[\s\S]*?"패치 해제"/,
    'the three primary patch actions stay together in one predictable row');
  assert.match(footer,/Label::new\([\s\S]*?display_status[\s\S]*?\.truncate\(\)/);
  assert.match(source,/"경로 복사"[\s\S]*?Vec2::new\(80\.0, BUTTON_HEIGHT\)[\s\S]*?"폴더 선택"[\s\S]*?Vec2::new\(88\.0, BUTTON_HEIGHT\)[\s\S]*?"직접 입력"[\s\S]*?Vec2::new\(88\.0, BUTTON_HEIGHT\)/);
  assert.match(gui,/fn path_label\([\s\S]*?Label::new\([\s\S]*?\.truncate\(\)[\s\S]*?on_hover_ui\(move \|tooltip\|/);
  assert.doesNotMatch(gui,/\.on_hover_text\(path\)/);
  assert.doesNotMatch(method('    fn render_main(&mut self, ctx: &egui::Context) {',
    'impl eframe::App for DinoUi'),/ScrollArea::/);
  assert.doesNotMatch(gui,/ManagerScreen|compact_navigation|navigation_button/);
  assert.match(gui,/ArchiveWatch::Missing/);
  assert.match(gui,/선택한 폴더에서 resources\/app\.asar를 찾을 수 없습니다\./);
  assert.doesNotMatch(gui,/SOURCE_MISSING"[\s\S]{0,120}변경이 중단됨/);
});


test('native UI preserves diagnostic detail preference while resetting old window geometry',()=>{
  const cargo=fs.readFileSync(path.resolve(__dirname,
    '../tools/dino-patch-manager/native-rust/Cargo.toml'),'utf8');
  assert.match(cargo,/features = \["wgpu", "default_fonts", "x11", "wayland", "persistence"\]/);
  assert.match(gui,/const ADVANCED_PANEL_KEY: &str = "dino\.manager\.ui\.advancedOpen\.v1"/);
  assert.match(gui,/fn with_storage\(storage: Option<&dyn eframe::Storage>\) -> Self/);
  assert.match(gui,/storage\.set_string\(ADVANCED_PANEL_KEY, self\.show_advanced\.to_string\(\)\)/);
  assert.doesNotMatch(gui,/SETTINGS_PANEL_KEY|show_settings/);
  assert.match(gui,/persist_window: false/);
  assert.match(gui,/centered: true/);
  assert.match(gui,/const GUI_PERSISTENCE_VERSION: &str = "ui-v2"/);
  assert.match(gui,/join\("data"\)[\s\S]*?join\(GUI_PERSISTENCE_VERSION\)[\s\S]*?join\("app\.ron"\)/);
});
test('old zoom state is no longer loaded or saved and protected state remains non-persistent',()=>{
  const section=method('    fn with_storage(storage: Option<&dyn eframe::Storage>) -> Self {',
    '    fn record(');
  assert.doesNotMatch(section,/textZoom|text_zoom_index|TEXT_ZOOM/);
  assert.match(section,/ADVANCED_PANEL_KEY/);
  const save=method('    fn save(&mut self, storage: &mut dyn eframe::Storage) {',
    '    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {');
  assert.doesNotMatch(save,/root|backup|path_draft|transaction|status/);
  assert.match(save,/ADVANCED_PANEL_KEY/);
  assert.match(save,/storage\.set_string\(AUTO_APPLY_KEY, self\.auto_enabled\.to_string\(\)\)/);
  assert.match(save,/CONFIRMED_PATCH_SELECTION_KEY[\s\S]*?self\.confirmed_patch_selection\.id\(\)/);
  assert.match(section,/parse_auto_apply_setting\([\s\S]*?AUTO_APPLY_KEY/);
  assert.match(section,/parse_confirmed_patch_selection\([\s\S]*?CONFIRMED_PATCH_SELECTION_KEY/);
  assert.match(gui,/fn persist_egui_memory\(&self\) -> bool \{[\s\S]*?false/);
  assert.doesNotMatch(gui,/TEXT_ZOOM_KEY|textZoom\.v1/);
});
test('GUI persistence uses isolated APPDATA instead of eframe known-folder lookup',()=>{
  assert.match(gui,/fn persistence_path_for\(appdata: Option<PathBuf>, temp: PathBuf\) -> PathBuf/);
  assert.match(gui,/appdata\.filter\(\|path\| path\.is_absolute\(\)\)\.unwrap_or\(temp\)/);
  assert.match(gui,/native_options\(gui_persistence_path\(\)\)/);
  assert.match(gui,/\.join\(GUI_PERSISTENCE_VERSION\)/);
});


test('disabled actions explain why they cannot run',()=>{
  const helper=gui.slice(gui.indexOf('fn action_button('),
    gui.indexOf('fn action(ui: &mut Ui'));
  assert.match(helper,/on_disabled_hover_text\(/);
  assert.match(helper,/설치 원본과 패치 상태를 먼저 확인하세요/);
  const summary=method('    fn status_summary(&self) -> String {',
    '    fn installation_path_section(&mut self, ui: &mut Ui) {');
  assert.match(summary,/패치를 적용할 수 있습니다/);
  assert.match(footer,/display_status/);
  assert.match(backupScreen,/복원 가능한 백업을 선택하세요/);
});
