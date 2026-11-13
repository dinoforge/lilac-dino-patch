'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const checkoutAttributes=read('.gitattributes');
const transaction=read('tools/dino-patch-manager/native-rust/src/transaction.rs');
const readOnlyAudit=read('scripts/dino-read-only-diagnose.ps1');
const gui=read('tools/dino-patch-manager/native-rust/src/gui.rs');
const bridge=read('patches/patch03/patch03-bridge.js');
const db=read('patches/patch03/dino-work-db.cjs');
const workflow=read('.github/workflows/build-dino-native-gui.yml');
const release=read('docs/releases/DINO_BETA8_PREVIEW.md');
const localBuild=read('scripts/dino-beta8-build-local.ps1');

test('apply and uninstall preserve a pending crash-recovery record until swap and hash confirmation',()=>{
  const apply=transaction.split('pub fn apply(')[1].split('pub fn uninstall(')[0];
  const uninstall=transaction.split('pub fn uninstall(')[1].split('pub fn review_recovery(')[0];
  assert.ok(apply.indexOf('write_json_atomic(&pending,&state)?') < apply.indexOf('fs::rename(&temp,archive_path(&root))?'));
  assert.match(apply,/if sha\(&archive_path\(&root\)\)\?!=new_sha/);
  assert.ok(uninstall.indexOf('write_json_atomic(&pending,&new)?') < uninstall.indexOf('fs::rename(&temp,&archive)?'));
  assert.match(uninstall,/if sha\(&archive\)\?!=state\["originalSha256"\]/);
  assert.match(transaction,/Some\("APPLIED"\|"UNPATCHED"\)/);
  assert.match(transaction,/fn assert_not_running\(/);
});

test('SQLite diagnostics are read-only, preview checks identity and v3 journals manual edits',()=>{
  assert.match(db,/PRAGMA quick_check/);
  assert.match(db,/PRAGMA foreign_key_check/);
  assert.match(db,/title_history/);
  assert.match(db,/link_history/);
  assert.match(db,/identityConflict\(x,stored\)/);
  assert.match(db,/if\(version>3\)/);
  assert.match(db,/idx_dino_work_ko_nocase/);
});

test('renderer provides provider diagnostics, explicit repair preview and episode controls',()=>{
  assert.match(bridge,/공급원·DB 상태/);
  assert.match(bridge,/연결 후보 작품 검색/);
  assert.match(bridge,/sqlite\.diagnostic\('preview'/);
  assert.match(bridge,/episodeSchedulerControl/);
  assert.match(bridge,/paused:episodePaused/);
  assert.match(bridge,/api\.identityMatch\(reference\.anime,item\)/);
  assert.match(bridge,/전환 실패 · 다시 시도/);
  assert.doesNotMatch(gui,/Command::new|std::process::Command|cmd\.exe|powershell\.exe/i);
});

test('Beta 8 candidate contains source receipt and no original LilacAnime executable',()=>{
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/needs: preflight/);
  assert.match(workflow,/DinoPatch-Beta8-PREVIEW-Windows-x64\.zip/);
  assert.match(workflow,/executableSha256/);
  assert.match(workflow,/embeddedManifestSha256/);
  assert.match(workflow,/originalAppBundled=\$false/);
  assert.match(workflow,/SHA256SUMS\.txt/);
  assert.match(release,/정식 Beta 8 릴리스가 아닙니다/);
  assert.match(release,/별도 테스트 프로필/);
});

test('Local build script refuses dirty source, performs free tests and never writes to LilacAnime installation',()=>{
  assert.match(localBuild,/git status --porcelain/);
  assert.match(localBuild,/dino-release-preflight\.cjs/);
  assert.match(localBuild,/--rust/);
  assert.match(localBuild,/cargo build --release --features gui/);
  assert.match(localBuild,/\$subsystem -ne 2/);
  assert.match(localBuild,/Refusing to overwrite an existing preview ZIP/);
  assert.match(localBuild,/originalAppBundled = \$false/);
  assert.doesNotMatch(localBuild,/(?:Set-Content|Copy-Item|Remove-Item)[^\n]*(?:app\.asar|LilacAnime\\)/i);
});
test('Manual CI release checks Rust CLI before allocating a Windows machine',()=>{
  const first=workflow.indexOf('cargo test --no-default-features');
  const second=workflow.indexOf('gui-windows:');
  assert.ok(first>=0&&second>first);
  assert.match(workflow,/^    needs: preflight$/m);
});

test('an updated official app is assessed by exact anchors, not by a version allowlist',()=>{
  const inspect=transaction.split('pub fn inspect(')[1].split('fn ensure_state_dir(')[0];
  const apply=transaction.split('pub fn apply(')[1].split('pub fn uninstall(')[0];
  assert.doesNotMatch(transaction,/fn official_hashes\(/);
  assert.match(transaction,/fn select_manifest\(archive:&Archive\)/);
  assert.match(transaction,/fn profile_compatible\(archive:&Archive/);
  assert.match(inspect,/replacements\(&archive,&version\)\.is_ok\(\)/);
  assert.match(inspect,/state\["patchVersion"\]==PATCH_VERSION/);
  assert.match(inspect,/sha\(&previous_backup\)\?==expected/);
  assert.match(apply,/if current.status!="UNPATCHED" \{return Ok\(current\);\}/);
  assert.match(apply,/let updated=previous\.as_ref\(\)\.is_some_and/);
  assert.match(apply,/backup_filename\(&version\)/);
  assert.match(apply,/write_state\(&root,&state\)\?/);
  assert.match(transaction,/fn official_updates_keep_historical_backups_and_uninstall_current_version/);
});
test('existing original and state records remain version-specific across official upgrades',()=>{
  assert.match(transaction,/fn read_state\(root:&Path\)/);
  assert.match(transaction,/fn backup_for_state\(root:&Path,state:&Value\)/);
  assert.match(transaction,/let preferred=directory\.join\(state_filename\(&version\)\)/);
  assert.match(transaction,/let backup=backup_for_state\(&root,&pending\)\?/);
  assert.match(transaction,/write_state\(&root,&new\)\?/);
  assert.match(transaction,/sha\(&archived_backup\)\?,original_hash/);
  assert.match(transaction,/assert_eq!\(latest\["version"\],"0\.5\.66"\)/);
});
test('version-mismatch diagnostic script is read-only and checks the exact previous backup hash',()=>{
  assert.match(readOnlyAudit,/Get-FileHash/);
  assert.match(readOnlyAudit,/original-app\.asar/);
  assert.match(readOnlyAudit,/pending\.json/);
  assert.match(readOnlyAudit,/recordedPatchVersion/);
  assert.match(readOnlyAudit,/DIFFERENT_FROM_BOTH_RECORDED_HASHES/);
  assert.doesNotMatch(readOnlyAudit,/(?:^|\n)\s*(?:Remove-Item|Set-Content|Copy-Item|Move-Item|Rename-Item)\b/im);
});

test('Rust CLI exposes versionless structural compatibility rather than claiming a registered-only patch',()=>{
  const main=read('tools/dino-patch-manager/native-rust/src/main.rs');
  assert.match(main,/"registeredVersionsRequired":false/);
  assert.match(main,/"compatibility":"structural-anchor-validation"/);
});

test('all embedded JavaScript and CSS files retain exact bytes on Windows checkout',()=>{
  const pinned=['/src/integrated-search.js','/src/integrated-search.css',
    '/src/dino-sqlite-sync.js','/patches/patch03/**'];
  for(const item of pinned) {
    assert.ok(checkoutAttributes.split('\n').some(line=>line.startsWith(item+' -text')),
      item+' must not be CRLF-transformed during Git checkout');
  }
  const byteCheck=workflow.indexOf('Verify embedded module hashes on Windows before compiling');
  const compile=workflow.indexOf('Compile the entire native Rust desktop manager');
  assert.ok(byteCheck>=0&&compile>byteCheck,
    'byte-level runtime verification must precede expensive Windows compile');
});

test('Windows fixture looks up old backups via the same canonical root as the manager',()=>{
  assert.match(transaction,/let canonical_root=installed_root\(&root\)\?/);
  assert.match(transaction,/let data=state_root\(&canonical_root\)\?/);
  assert.match(transaction,/backup_for_state\(&canonical_root,&active\)\?/);
  const safeTest=workflow.indexOf('Verify versionless patch, backup rollover and safe uninstall on Windows');
  const expensiveCompile=workflow.indexOf('Compile the entire native Rust desktop manager');
  assert.ok(safeTest>=0&&expensiveCompile>safeTest,
    'run the cheap Windows patch regression before the expensive GUI build');
});

test('fixture builds the ASAR before asking installed_root to validate it',()=>{
  const fixture=transaction.split('fn official_updates_keep_historical_backups_and_uninstall_current_version()')[1];
  const create=fixture.indexOf('fixture(&asar_path,"0.5.64",false)?;');
  const check=fixture.indexOf('let canonical_root=installed_root(&root)?;');
  assert.ok(create>=0&&check>create,'test must create resources/app.asar before inspecting it');
});
