'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {makeLilacAnimeV0514Manifest}=require('../adapters/lilacanime-v0.5.14.cjs');

test('SIWC is an additive isolated v0.5.14 payload, not a modification to the installed app',()=>{
  const manifest=makeLilacAnimeV0514Manifest();
  const paths=new Set(manifest.actions.filter(action=>action.kind==='add-file').map(action=>action.file));
  for(const filename of [
    'electron/siwc-contract.cjs','electron/siwc-oidc.cjs','electron/siwc-client.cjs',
    'src/siwc-subtitle-bridge.js','src/manual-subtitle-translation.js',
    'electron/manual-translation-session.cjs','src/patch-manager-stage2.js'
  ]) assert.ok(paths.has(filename),filename);
  const codeFor=file=>manifest.actions.find(action=>action.file===file && action.kind==='insert-before')?.content || '';
  const preload=codeFor('electron/preload.cjs');
  const main=codeFor('electron/main.cjs');
  const html=codeFor('src/index.html');
  for(const symbol of ['patchSIWCStatus','patchSIWCConnect','patchSIWCDisconnect',
    'patchSIWCModels','patchSIWCTranslate','patchSIWCCancel']) assert.match(preload,new RegExp(symbol));
  assert.match(main,/registerPatch0102Handlers/);
  assert.match(main,/safeStorage/);
  assert.ok(html.indexOf('patch-manager-stage2.js')>=0);
  assert.ok(html.indexOf('siwc-subtitle-bridge.js')>html.indexOf('patch-manager-stage2.js'));
  assert.ok(manifest.expectedFiles['electron/main.cjs']);
  assert.equal(manifest.version,'0.5.14');
});
