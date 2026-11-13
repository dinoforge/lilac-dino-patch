'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const main = read('tools/dino-patch-manager/native-rust/src/main.rs');
const gui = read('tools/dino-patch-manager/native-rust/src/gui.rs');
const cargo = read('tools/dino-patch-manager/native-rust/Cargo.toml');
const workflow = read('.github/workflows/build-dino-native-gui.yml');

test('GUI feature selects native Windows GUI subsystem without changing CLI-only output', () => {
  assert.match(main, /^#!\[cfg_attr\(all\(windows, feature = "gui"\), windows_subsystem = "windows"\)\]/m);
  assert.doesNotMatch(main, /^#!\[windows_subsystem/m,
    'a global Windows subsystem attribute would disable the default CLI console');
  assert.match(cargo, /^default = \[\]/m);
  assert.match(cargo, /^gui = \[/m);
  assert.match(main, /if args\.is_empty\(\) \|\| args\.first\(\)/);
  assert.match(main, /println!\("\{output\}"\)/,
    'headless CLI must continue returning machine-readable JSON');
});

test('Native GUI never spawns cmd or PowerShell and reports failures using GUI dialog', () => {
  assert.doesNotMatch(gui, /Command::new|std::process::Command|cmd\.exe|powershell\.exe/i);
  assert.match(main, /diagnostics::show_fatal_error\(&failure\)/);
  assert.match(workflow, /\$subsystem -ne 2/,
    'manual Windows release build must reject any console subsystem regression');
});

test('Patch manager provides a safe status-first overview and direct actions', () => {
  assert.match(gui, /fn overview_card\(&mut self, ui: &mut Ui\)/);
  assert.match(gui, /self\.overview_card\(ui\)/);
  assert.match(gui, /"1\. 원본 선택"/);
  assert.match(gui, /"2\. 호환성 확인"/);
  assert.match(gui, /"3\. 패치 적용"/);
  assert.match(gui, /"원본 폴더 선택"/);
  assert.match(gui, /"안전하게 패치 적용"/);
  assert.match(gui, /self\.ask\("디노 패치 수동 적용"\)/,
    'patch action must still require the original confirmation dialog');
  assert.match(gui, /"진단 기록 열기"/);
  assert.match(gui, /"현재 상태 다시 검사"/);
  assert.match(gui, /self\.confirmation\(ctx\)/,
    'destructive operations must keep the safety confirmation');
  assert.match(gui, /self\.monitor\(\)/,
    'automatic monitoring behavior is unchanged');
});
