'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const transaction=read('tools/dino-patch-manager/native-rust/src/transaction.rs');
const gui=read('tools/dino-patch-manager/native-rust/src/gui.rs');
const bridge=read('patches/patch03/patch03-bridge.js');
const db=read('patches/patch03/dino-work-db.cjs');
const workflow=read('.github/workflows/build-dino-native-gui.yml');
const release=read('docs/releases/DINO_BETA8_PREVIEW.md');

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
