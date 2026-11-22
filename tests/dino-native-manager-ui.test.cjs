'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const main = read('tools/dino-patch-manager/native-rust/src/main.rs');
const gui = read('tools/dino-patch-manager/native-rust/src/gui.rs');
const updater = read('tools/dino-patch-manager/native-rust/src/updater_engine.rs');
const releaseUpdate = read('tools/dino-patch-manager/native-rust/src/release_update.rs');
const cargo = read('tools/dino-patch-manager/native-rust/Cargo.toml');
const localBuild = read('scripts/dino-beta8-build-local.ps1');
const preflight = read('scripts/dino-release-preflight.cjs');

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
  assert.match(localBuild, /\$subsystem -ne 2/,
    'manual Windows release build must reject any console subsystem regression');
});

test('Native manager renders one fixed integrated screen without scrollbars or tabs', () => {
  assert.doesNotMatch(gui, /ManagerScreen|compact_navigation|navigation_button|fn sidebar\(/,
    'page navigation and separate screens must be removed');
  const integrated = gui.slice(gui.indexOf('    fn render_integrated_content('),
    gui.indexOf('    fn render_main('));
  const sections = ['installation_path_section', 'patch_actions_section',
    'backup_restore_section'];
  let previous = -1;
  for (const section of sections) {
    const at = integrated.indexOf(`self.${section}(`);
    assert.ok(at > previous, `integrated view must render ${section} in order`);
    previous = at;
  }
  assert.match(integrated,/ui\.columns\(2,[\s\S]*?patch_actions_section[\s\S]*?backup_restore_section/,
    'patch management and backup/restore use a two-column layout');
  const renderMain = gui.slice(gui.indexOf('    fn render_main(&mut self, ctx: &egui::Context) {'),
    gui.indexOf('impl eframe::App for DinoUi'));
  assert.match(renderMain,/row\.spacing_mut\(\)\.item_spacing\.x = 10\.0/,
    'title, monitor toggle and state badge have deliberate spacing');
  assert.doesNotMatch(integrated, /ScrollArea::/,
    'the main patch and backup surface must not introduce an internal scrollbar');
  assert.doesNotMatch(renderMain, /ScrollArea::/,
    'the fixed main viewport must not scroll or clip its core controls');
  assert.match(renderMain, /badge_for\(&self\.status\)/,
    'current patch state remains visible in the header');
  assert.match(renderMain,/self\.settings_diagnostics_section\(ui, ctx\)/,
    'the one-line result and diagnostic controls remain fixed at the bottom');
  assert.match(gui,/fn diagnostics_window\([\s\S]*?ScrollArea::vertical\(\)/,
    'long diagnostics remain available in an independent detail window');
  assert.match(gui,/fn update_details_window\([\s\S]*?ScrollArea::vertical\(\)/,
    'long release notes remain available in an independent detail window');
  assert.match(gui, /let compact = ctx\.content_rect\(\)\.height\(\) <= 400\.0;[\s\S]*?let vertical_inset = if compact\s*\{\s*6\s*\}\s*else\s*\{\s*10\s*\};[\s\S]*?inner_margin\(Margin::symmetric\(14, vertical_inset\)\)/,
    'short windows keep compact vertical spacing while standard windows gain breathing room');
  assert.match(gui,/with_inner_size\(\[680\.0, 420\.0\]\)/);
  assert.match(gui,/with_min_inner_size\(\[600\.0, 380\.0\]\)/);
});

test('Patch and restore actions retain engine checks, selected IDs and confirmation', () => {
  assert.match(gui, /fn patch_actions_section\(&mut self, ui: &mut Ui\)/);
  assert.match(gui, /fn can_apply_confirmed_selection\(&self\) -> bool[\s\S]*?"UNPATCHED" \| "ALREADY_UNPATCHED"/);
  assert.match(gui, /self\.confirmed_patch_selection\.manager_install_supported\(\)/);
  assert.match(gui, /fn can_apply_confirmed_selection\(&self\) -> bool[\s\S]*?self\.confirmed_patch_selection\.as_patch_set\(\)/,
    'application requires a concrete non-empty patch set');
  const applyGuard = gui.slice(gui.indexOf('    fn can_apply_confirmed_selection(&self) -> bool {'),
    gui.indexOf('    fn apply_button_reason(&self) ->'));
  assert.match(applyGuard, /self\.confirmed_patch_selection\.manager_install_supported\(\)/,
    'application is limited to verified combinations');
  assert.match(applyGuard, /"UNPATCHED"[\s\S]*?"APPLIED"[\s\S]*?installed != desired/,
    'application is allowed only for an unpatched source or a verified composition transition');
  assert.match(gui, /self\.ask\("디노 패치 수동 적용"\)/,
    'patch application still requires explicit confirmation');
  assert.match(gui, /self\.ask\("디노 패치 해제"\)/);
  assert.match(gui, /self\.ask\("백업 복원"\)/);
  assert.match(gui, /self\.confirmation\(ctx\)/,
    'destructive operations must keep the safety confirmation');
  assert.match(gui, /fn requested_backup_id\(&self, kind: &str\) -> Option<String>/);
  assert.match(gui, /transaction::restore\(&root, id\)/);
  const monitor = gui.slice(gui.indexOf('    fn monitor(&mut self) {'),
    gui.indexOf('    fn choose_folder(&mut self) {'));
  assert.match(monitor, /self\.auto_apply_config_block\(\)/);
  assert.match(monitor, /Some\("원본 다시 확인"\) => self\.enqueue\("원본 다시 확인"\)/,
    'new and changed archives are inspected before automatic application');
  assert.match(monitor, /Some\("자동 검사"\) => self\.enqueue\("자동 검사"\)/,
    'automatic apply queues only the existing guarded transaction');
  assert.ok(monitor.indexOf('automatic_apply_ready')
    < monitor.indexOf('self.enqueue("자동 검사")'),
    'selection, status and auto-apply gates run before queueing work');
  assert.match(gui, /fn automatic_apply_needed\(\s*status: &transaction::Status,\s*desired: patch_set::PatchSelection/,
    'automatic application is evaluated against the confirmed patch selection');
  assert.match(gui, /"UNPATCHED" \| "ALREADY_UNPATCHED" => !status\.manually_uninstalled/,
    'a manually removed patch is not automatically rewritten');
});

test('Light palette keeps restrained purple accents and accessible control sizes', () => {
  assert.match(gui, /const PAGE: u32 = 0xF3F5FA/);
  assert.match(gui, /const CARD: u32 = 0xFFFFFF/);
  assert.match(gui, /const ACCENT: u32 = 0x6244B4/);
  assert.match(gui, /const BUTTON: u32 = 0x6848C5/);
  assert.match(gui, /Visuals::light\(\)/,
    'manager controls use the light egui visual set');
  assert.match(gui, /\.min_size\(min_size\)/);
  assert.match(gui, /const BUTTON_HEIGHT: f32 = 38\.0/);
  assert.match(gui, /const BODY_TEXT_SIZE: f32 = 14\.0/);
  assert.match(gui, /const HELP_TEXT_SIZE: f32 = 13\.0/);
  assert.match(gui, /const SECTION_TEXT_SIZE: f32 = 16\.0/);
  assert.match(gui, /const STATUS_TEXT_SIZE: f32 = 16\.0/);
  assert.match(gui, /const BUTTON_TEXT_SIZE: f32 = 14\.0/);
});

test('Native window opens centered at 680x420 with a 600x380 minimum and ignores old geometry', () => {
  assert.match(gui, /\.with_inner_size\(\[680\.0, 420\.0\]\)/);
  assert.match(gui, /\.with_min_inner_size\(\[600\.0, 380\.0\]\)/);
  assert.match(gui, /centered: true/);
  assert.match(gui, /persist_window: false/);
  assert.match(gui, /const GUI_PERSISTENCE_VERSION: &str = "ui-v2"/);
  assert.match(gui, /\.join\(GUI_PERSISTENCE_VERSION\)/);
});

test('Expensive Windows build runs only after the local preflight succeeds', () => {
  const preflightPosition = localBuild.indexOf("& node (Join-Path $root 'scripts/dino-release-preflight.cjs') --rust");
  const failureGate = localBuild.indexOf("if ($LASTEXITCODE -ne 0) { throw 'DinoPatch preflight failed.");
  const managerBuild = localBuild.indexOf('& cargo build --release --features gui --bin dino-native-manager');
  assert.ok(preflightPosition >= 0, 'local package build must run the Node and Rust preflight');
  assert.ok(failureGate > preflightPosition, 'preflight failure must stop before building');
  assert.ok(managerBuild > failureGate, 'Windows release build must start after preflight passes');
  assert.match(preflight,/createHash\('sha256'\)/);
  assert.match(preflight,/tests\/dino-sqlite-compat\.test\.cjs/);
  assert.match(preflight,/tests\/dino-manual-link\.test\.cjs/);
  assert.match(preflight,/tests\/dino-episode-refresh\.test\.cjs/);
  assert.match(preflight,/tests\/patch03-global-integration\.test\.cjs/);
});

test('manager update check, download progress, digest verification and approval are connected', () => {
  const integrated = gui.slice(gui.indexOf('    fn render_integrated_content('),
    gui.indexOf('    fn render_main('));
  const diagnostics = gui.slice(gui.indexOf('    fn diagnostics_section('),
    gui.indexOf('    fn update_section('));
  assert.match(gui, /fn start_update_check\(&mut self\)/);
  assert.match(gui, /release_update::check_latest_release\(&installed_version\)/);
  assert.match(gui, /UpdateMessage::DownloadProgress/);
  assert.match(integrated, /self\.update_section\(ui, ctx\)/,
    'update availability is reachable without opening diagnostics');
  assert.doesNotMatch(diagnostics, /self\.update_section/);
  assert.match(gui, /fn update_confirmation\(&mut self, ctx: &egui::Context\)/);
  assert.match(gui, /approve_and_launch_update\(&candidate, &digest, true\)/,
    'installation is sent only from the explicit confirmation action');
  assert.match(releaseUpdate, /verified_download\(candidate, &mut response/);
  assert.match(releaseUpdate, /actual != candidate\.sha256/);
});

test('production updater binds approval to the fixed asset and preserves recovery handoff', () => {
  assert.match(updater, /fn from_request\(value: &Value, nonce: &str\)/);
  assert.match(updater, /value\.get\("userApproved"\)[\s\S]*Some\(true\)/);
  assert.match(updater, /asset_sha256 != staged_sha256/);
  assert.match(updater, /apply_authorized_under_lock\(layout, &authorization, Faults::default\(\)\)/);
  assert.match(updater, /recover_production\(layout\)/);
  assert.match(updater, /fn restart_verified_manager\(layout: &UpdateLayout\)/);
  assert.match(updater, /fn handoff_pending_recovery\(\)/);
});
