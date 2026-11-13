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
