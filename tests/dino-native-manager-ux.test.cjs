'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const gui=fs.readFileSync(path.resolve(__dirname,
  '../tools/dino-patch-manager/native-rust/src/gui.rs'),'utf8');
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
  const assign=source.indexOf('self.root = candidate;');
  const inspect=source.indexOf('self.enqueue("원본 다시 확인");');
  assert.ok(change>=0 && assign>change && inspect>assign);
  assert.match(source,/self\.backup_id\.clear\(\)/,'stale backup ID must be invalidated on path changes');
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
  assert.match(advanced,/if action\(ui, "백업 복원", ButtonTone::Secondary,[\s\S]*?self\.backup_id\.is_empty\(\)/);
  assert.match(gui,/self\.ask\("디노 패치 수동 적용"\)/);
  assert.match(gui,/self\.confirmation\(ctx\)/);
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
  assert.match(gui,/글자 크기와 창 크기는 다음 실행에도 유지됩니다/);
});
