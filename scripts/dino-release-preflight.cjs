'use strict';
// One-command, dependency-free safety gate for the native Windows release.
// Run locally before spending a single Windows Actions minute.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root,'patches/patch03/manifest.json');
const runtimePath = path.join(root,'tools/dino-patch-manager/native-rust/src/transaction.rs');
const guiWorkflowPath = path.join(root,'.github/workflows/build-dino-native-gui.yml');
const rustMainPath = path.join(root,'tools/dino-patch-manager/native-rust/src/main.rs');
const read = file => fs.readFileSync(file, 'utf8');
const manifest = JSON.parse(read(manifestPath));
const runtime = read(runtimePath);
const workflow = read(guiWorkflowPath);
const rustMain = read(rustMainPath);
const checks = [
  ['src/integrated-search.js','src/integrated-search.js','INTEGRATED_JS'],
  ['src/integrated-search.css','src/integrated-search.css','INTEGRATED_CSS'],
  ['patches/patch03/patch03-bridge.js','src/patch03-bridge.js','PATCH_BRIDGE'],
  ['src/dino-sqlite-sync.js','src/dino-sqlite-sync.js','SQLITE_SYNC'],
  ['patches/patch03/dino-work-db.cjs','electron/dino-work-db.cjs','SQLITE_MAIN']
];

assert.equal(manifest.patchVersion,'1.0.0','unexpected patch manifest version');
assert.equal(manifest.runtimeModules?.length,checks.length,'incomplete embedded runtime list');
const destinations = new Set();
for(const [source,destination,constant] of checks){
  const entry = manifest.runtimeModules.find(x=>x.source===source);
  assert.ok(entry, 'module missing from manifest: '+source);
  assert.equal(entry.destination,destination,'wrong ASAR destination: '+source);
  assert.ok(!destinations.has(destination),'duplicate ASAR destination: '+destination);
  destinations.add(destination);
  const file = path.resolve(root,source);
  assert.ok(file.startsWith(root+path.sep),'path escapes checkout: '+source);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
  assert.equal(entry.sha256,sha,'embedded module hash mismatch: '+source);
  assert.ok(runtime.includes('const '+constant+': &[u8] = include_bytes!("../../../../'+source+'");'),
    'Rust binary does not embed expected source: '+source);
}
assert.ok(runtime.includes('include_str!("../../../../patches/patch03/manifest.json")'),
  'Rust binary must embed the pinned manifest');
assert.match(rustMain,/^#!\[cfg_attr\(all\(windows, feature = "gui"\), windows_subsystem = "windows"\)\]/m,
  'native GUI must use Windows subsystem 2');
assert.match(workflow,/^\s*workflow_dispatch:\s*$/m,
  'Windows release must be explicitly requested');
assert.doesNotMatch(workflow,/^\s*(?:push|pull_request|schedule):\s*$/m,
  'expensive Windows release must never auto-run on pushes or PRs');
console.log('PASS: 5 bundled modules, manifest hashes, GUI subsystem and manual-only build');

const syntaxFiles = [
  'src/integrated-search.js',
  'src/dino-sqlite-sync.js',
  'patches/patch03/patch03-bridge.js',
  'patches/patch03/dino-work-db.cjs'
];
const tests = [
  'tests/integrated-search.test.cjs',
  'tests/patch03-global-integration.test.cjs',
  'tests/patch03-settings-preservation.test.cjs',
  'tests/dino-sqlite-compat.test.cjs',
  'tests/dino-manual-link.test.cjs',
  'tests/dino-db-hardening.test.cjs',
  'tests/dino-episode-refresh.test.cjs',
  'tests/dino-native-manager-ui.test.cjs',
  'tests/dino-native-manager-ux.test.cjs',
  'tests/dino-beta8-hardening.test.cjs',
  'tests/dino-beta8-selected-features.test.cjs',
  'tests/dino-readonly-diagnose-contract.test.cjs'
];
function run(command,args,cwd=root){
  console.log('RUN: '+command+' '+args.join(' '));
  const outcome=spawnSync(command,args,{cwd,stdio:'inherit',shell:false});
  if(outcome.error)throw outcome.error;
  assert.equal(outcome.status,0,'validation failed: '+command+' '+args.join(' '));
}
for(const file of syntaxFiles)run(process.execPath,['--check',file]);
run(process.execPath,['--test',...tests]);
console.log('PASS: DinoPatch preflight completed without a GitHub Actions run');

// Optional local Rust verification; this does not build a Windows GUI EXE on Linux.
if(process.argv.includes('--rust')){
  const cargoDir=path.join(root,'tools/dino-patch-manager/native-rust');
  run('cargo',['test','--no-default-features'],cargoDir);
  console.log('PASS: native Rust CLI checks');
}
