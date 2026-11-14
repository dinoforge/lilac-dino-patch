'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const gui=fs.readFileSync(path.resolve(__dirname,
  '../tools/dino-patch-manager/native-rust/src/gui.rs'),'utf8');
const transaction=fs.readFileSync(path.resolve(__dirname,
  '../tools/dino-patch-manager/native-rust/src/transaction.rs'),'utf8');
const method=(begin,end)=>{
  const start=gui.indexOf(begin);
  const finish=gui.indexOf(end,start+begin.length);
  assert.ok(start>=0 && finish>start,'UI function anchor not found: '+begin);
  return gui.slice(start,finish);
};
const source=method('    fn source_card(&mut self, ui: &mut Ui) {',
  '    fn patch_list_card(&mut self, ui: &mut Ui) {');
const advanced=method('    fn advanced_card(&mut self, ui: &mut Ui, ctx: &egui::Context) {',
  '    fn result_card(&mut self, ui: &mut Ui) {');

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
  assert.match(source,/ui\.add_enabled\(\s*!self\.busy,\s*egui::TextEdit::singleline/);
  assert.match(source,/if action\(ui, "입력 취소", ButtonTone::Secondary, !self\.busy\)/);
  assert.match(source,/self\.path_draft = self\.root\.clone\(\)/);
  assert.match(source,/self\.show_path_editor = false/);
});

test('manual patch controls only enable after a compatible unpatched status',()=>{
  assert.match(advanced,/if action\(ui, "디노 패치 수동 적용", ButtonTone::Primary,[\s\S]*?"UNPATCHED" \| "ALREADY_UNPATCHED"/);
  assert.doesNotMatch(advanced,/self\.status\.status != "APPLIED"/);
  assert.match(advanced,/if action\(ui, "디노 패치 해제", ButtonTone::Danger,[\s\S]*?"APPLIED" \| "ALREADY_APPLIED"/);
  assert.match(advanced,/if action\(ui, "백업 복원", ButtonTone::Primary,[\s\S]*?self\.can_restore_selected_backup\(\)/);
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
  assert.match(gui,/self\.show_log = true;\s*self\.show_advanced = true;/);
});

test('backup lookup uses only engine output off the UI thread and retains each returned item',()=>{
  assert.match(transaction,/pub fn backups\(root:&Path\)->Result<Value>/);
  assert.match(gui,/let backups = match std::panic::catch_unwind[\s\S]*?transaction::backups\(&root\)/);
  assert.match(gui,/fn parse_backup_items\(value: &serde_json::Value\)[\s\S]*?items\.iter\(\)\.enumerate\(\)\.map/);
  assert.match(gui,/for backup in &backup_items/);
  assert.match(gui,/백업 ID  \{\}[\s\S]*?LilacAnime v\{\} · 생성 \{\}/);
  assert.match(gui,/if backup\.restorable \{ "복원 가능" \} else \{ "복원 불가" \}/);
  assert.doesNotMatch(advanced,/transaction::backups|std::fs::|sha256|sha\(/,
    'rendering the list must not perform disk access or hash work');
  assert.match(gui,/"백업 목록 새로 고침"/);
});

test('restore sends only the selected restorable ID and preserves engine verification',()=>{
  assert.match(gui,/fn selected_backup\(&self\)[\s\S]*?self\.backup_items\.iter\(\)\.find\(\|item\| item\.id == id\)/);
  assert.match(gui,/fn can_restore_selected_backup\(&self\) -> bool[\s\S]*?"APPLIED" \| "ALREADY_APPLIED"[\s\S]*?item\.restorable/);
  assert.match(gui,/let backup_id = if kind == "백업 복원"[\s\S]*?self\.selected_backup_id\.clone\(\)/);
  assert.match(gui,/transaction::restore\(&root, id\)/);
  assert.match(transaction,/if state\["backupId"\]\.as_str\(\)!=Some\(backup_id\)/);
  assert.match(gui,/대상 경로: \{\}/);
  assert.match(gui,/현재 앱 버전: v\{\}/);
  assert.match(gui,/선택 백업 버전: v\{\}/);
  assert.match(gui,/백업 ID: \{\}/);
  assert.match(gui,/if action\(ui, "취소", ButtonTone::Secondary, true\) \{\s*self\.pending_action = None;/);
  assert.match(gui,/let can_continue = operation != "백업 복원" \|\| self\.can_restore_selected_backup\(\)/);
});

test('failed operations reveal logs rather than leaving them hidden in collapsed controls',()=>{
  assert.match(gui,/show_advanced: bool/);
  assert.match(gui,/self\.show_log = true;\s*self\.show_advanced = true;/);
  assert.match(gui,/if self\.show_advanced \{\s*ui\.add_space\(9\.0\);\s*self\.advanced_card\(ui, ctx\)/);
  assert.match(gui,/"고급 관리 열기 · 원복 \/ 백업 \/ 작업 로그 \/ 업데이트"/);
});

test('status diagnosis and next steps precede the advanced actions',()=>{
  const screen=method('impl eframe::App for DinoUi {','fn register_windows_fonts(');
  const overview=screen.indexOf('self.overview_card(ui);');
  const result=screen.indexOf('self.result_card(ui);');
  const actions=screen.indexOf('self.advanced_card(ui, ctx);');
  assert.ok(overview>=0 && result>overview && actions>result);
  assert.match(gui,/fn next_step\(status: &transaction::Status, busy: bool\)/);
  assert.match(gui,/CONFLICT" \| "PARTIAL_OR_UNKNOWN" \| "UNSUPPORTED"/);
});

test('compact window keeps path readable and exposes the full path on hover',()=>{
  assert.match(gui,/with_min_inner_size\(\[640\.0, 560\.0\]\)/);
  assert.match(source,/if ui\.available_width\(\) < 720\.0/);
  assert.equal((source.match(/\.on_hover_text\(path_text\.as_str\(\)\)/g)||[]).length,2);
  assert.match(source,/원본 폴더 변경/);
  assert.match(source,/ui\.horizontal_wrapped/);
});

test('update links are read-only and the GUI never starts a shell subprocess',()=>{
  assert.match(advanced,/DinoPatch 릴리스 보기/);
  assert.match(advanced,/https:\/\/github\.com\/dinoforge\/lilac-dino-patch\/releases/);
  assert.match(advanced,/https:\/\/github\.com\/whispelyn-byte\/LilacAnime-desktop\/releases/);
  assert.doesNotMatch(gui,/Command::new|std::process::Command|cmd\.exe|powershell\.exe/i);
});


test('readability controls expose 100, 120 and 140 percent zoom sizes',()=>{
  assert.match(gui,/const TEXT_ZOOM: \[f32; 3\] = \[1\.0, 1\.2, 1\.4\];/);
  assert.match(gui,/text_zoom_index: usize/);
  assert.match(gui,/text_zoom_index: 0/);
  assert.match(gui,/"기본 100%", "크게 120%", "매우 크게 140%"/);
  assert.match(gui,/ctx\.set_zoom_factor\(TEXT_ZOOM\[index\]\)/);
  assert.match(gui,/self\.readability_controls\(ui, ctx\)/);
  assert.match(gui,/self\.text_zoom_index == index/);
});
test('text controls appear before the status-first primary card',()=>{
  const screen=method('impl eframe::App for DinoUi {','fn register_windows_fonts(');
  const controls=screen.indexOf('self.readability_controls(ui, ctx);');
  const status=screen.indexOf('self.overview_card(ui);');
  assert.ok(controls>=0 && status>controls);
  assert.match(gui,/ui\.horizontal_wrapped\(\|ui\| \{\s*ui\.label\(RichText::new\("글자 크기"\)/);
  assert.match(gui,/글자가 흐리면 크기를 높여 주세요/);
});
test('secondary UI text has high default contrast against both dark panels',()=>{
  const foreground=Number(gui.match(/const MUTED: u32 = (0x[0-9A-F]+);/)?.[1]);
  const bgColors=[0x172029,0x19252E];
  const luminance=color=>{
    const rgb=[color>>16&255,color>>8&255,color&255]
      .map(x=>x/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);
    return 0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2];
  };
  for(const background of bgColors){
    const a=luminance(foreground),b=luminance(background);
    assert.ok((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=7,
      'secondary text must remain readable against card/surface backgrounds');
  }
  assert.match(gui,/FontId::new\(12\.0, FontFamily::Monospace\)/);
});
test('Windows Korean fonts use multiple local fallback candidates without embedding files',()=>{
  assert.match(gui,/let candidates = \["malgun\.ttf", "malgunbd\.ttf", "malgunsl\.ttf"\]/);
  assert.match(gui,/ctx\.set_fonts\(fonts\)/);
  assert.match(gui,/Windows Korean font missing/);
  assert.doesNotMatch(gui,/include_bytes!\([^)]*\.(?:ttf|otf)/);
});
test('zoomed headers and patch labels may wrap rather than clipping',()=>{
  const patch=method('    fn patch_list_card(&mut self, ui: &mut Ui) {',
    '    fn advanced_card(&mut self, ui: &mut Ui, ctx: &egui::Context) {');
  const overview=method('    fn overview_card(&mut self, ui: &mut Ui) {',
    '    fn source_card(&mut self, ui: &mut Ui) {');
  assert.match(patch,/ui\.horizontal_wrapped\(\|ui\|/);
  assert.match(overview,/ui\.horizontal_wrapped\(\|ui\|/);
  assert.match(source,/if ui\.available_width\(\) < 720\.0/);
});


test('native UI saves cosmetic settings and restores text zoom and advanced panel',()=>{
  const cargo=fs.readFileSync(path.resolve(__dirname,
    '../tools/dino-patch-manager/native-rust/Cargo.toml'),'utf8');
  assert.match(cargo,/features = \["wgpu", "default_fonts", "x11", "wayland", "persistence"\]/);
  assert.match(gui,/const TEXT_ZOOM_KEY: &str = "dino\.manager\.ui\.textZoom\.v1"/);
  assert.match(gui,/const ADVANCED_PANEL_KEY: &str = "dino\.manager\.ui\.advancedOpen\.v1"/);
  assert.match(gui,/fn with_storage\(storage: Option<&dyn eframe::Storage>\) -> Self/);
  assert.match(gui,/storage\.set_string\(TEXT_ZOOM_KEY, self\.text_zoom_index\.to_string\(\)\)/);
  assert.match(gui,/storage\.set_string\(ADVANCED_PANEL_KEY, self\.show_advanced\.to_string\(\)\)/);
  assert.match(gui,/cc\.egui_ctx\.set_zoom_factor\(TEXT_ZOOM\[app\.text_zoom_index\]\)/);
  assert.match(gui,/persist_window: true/);
});
test('saved UI zoom is validated and does not persist source or automatic patch policy',()=>{
  const section=method('    fn with_storage(storage: Option<&dyn eframe::Storage>) -> Self {',
    '    // A visible, keyboard-accessible control.');
  assert.match(section,/\.and_then\(\|raw\| raw\.parse::<usize>\(\)\.ok\(\)\)/);
  assert.match(section,/\.filter\(\|index\| \*index < TEXT_ZOOM\.len\(\)\)/);
  assert.match(section,/\.unwrap_or\(0\)/);
  const save=method('    fn save(&mut self, storage: &mut dyn eframe::Storage) {',
    '    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {');
  assert.doesNotMatch(save,/root|backup|auto_enabled|path_draft|transaction|status/);
  assert.match(gui,/fn persist_egui_memory\(&self\) -> bool \{[\s\S]*?false/);
  assert.match(gui,/글자 크기와 창 크기는 다음 실행에도 유지됩니다/);
});


test('disabled actions explain why they cannot run',()=>{
  const helper=gui.slice(gui.indexOf('fn action(ui: &mut Ui'),
    gui.indexOf('fn card(ui: &mut Ui',gui.indexOf('fn action(ui: &mut Ui')));
  assert.match(helper,/if enabled \{[\s\S]*?response\.clicked\(\)/);
  assert.match(helper,/on_disabled_hover_text\(/);
  assert.match(helper,/설치 원본과 패치 상태를 먼저 확인하세요/);
});
