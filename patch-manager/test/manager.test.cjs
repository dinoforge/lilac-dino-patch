'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { inspect, hashBytes, checkedRelative }=require('../core.cjs');
const { FIXTURE_MARKER,makeSyntheticFixture,cleanupSyntheticFixture,makeFixtureManifest,stageSynthetic,assertSyntheticFixture }=require('../staging.cjs');
const { makePatch0102Manifest }=require('../feature-payload.cjs');
const { readState, applyPersistent, rollbackPersistent, reconcileAfterUpdate }=require('../persistent.cjs');

function withFixture(fn,version='0.5.14') {
  const root=makeSyntheticFixture(version);const dirs=[];
  try { return fn(root, dirs); }
  finally {for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});cleanupSyntheticFixture(root);}
}

test('exact 0.5.14 synthetic fingerprint enables preview only',()=>withFixture(root=>{
  const manifest=makeFixtureManifest(root);
  assert.deepEqual(inspect(root,manifest),{status:'eligible-for-isolated-preview',version:'0.5.14'});
}));
test('upstream version update fails closed rather than silently reapplying',()=>withFixture(root=>{
  const baseline=makeSyntheticFixture();
  try {assert.deepEqual(inspect(root,makeFixtureManifest(baseline)), {status:'incompatible',reason:'version-unverified',version:'0.5.15'});}
  finally{fs.rmSync(baseline,{recursive:true,force:true});}
},'0.5.15'));
test('changed app bytes fail closed even without a version change',()=>withFixture(root=>{
  const manifest=makeFixtureManifest(root);
  fs.appendFileSync(path.join(root,'src/index.html'),'<!-- changed -->');
  assert.deepEqual(inspect(root,manifest),{status:'incompatible',reason:'hash-mismatch',file:'src/index.html'});
}));
test('synthetic preview creates new tree; leaves source files completely unchanged',()=>withFixture((root, dirs)=>{
  const manifest=makeFixtureManifest(root);
  const before=hashBytes(fs.readFileSync(path.join(root,'src/index.html')));
  const result=stageSynthetic(root,manifest);dirs.push(result.stageContainer);
  assert.equal(result.status,'staged-synthetic-preview');
  assert.notEqual(result.stagedRoot,root);
  assert.equal(hashBytes(fs.readFileSync(path.join(root,'src/index.html'))),before);
  assert.match(fs.readFileSync(path.join(result.stagedRoot,'src/index.html'),'utf8'),/data-lilac-patch="01-02"/);
  assert.equal(inspect(result.stagedRoot,manifest).reason,'hash-mismatch');
}));
test('no preview may operate on a normal folder without synthetic marker',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-unmarked-'));
  try{assert.throws(()=>assertSyntheticFixture(root),/marker/);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('path traversal and absolute manifest paths are rejected',()=>{
  for(const p of ['../app.asar','/etc/passwd','C:/windows/system32','src/../index.html','./src/app.js','src\\app.js',
    'src/CON.txt','src/trailing.','src/trailing ']) {
    assert.throws(()=>checkedRelative(p));
  }
});
test('cleanup refuses unmarked temp directories and never removes their contents',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-unmarked-cleanup-'));
  const keep=path.join(root,'keep.txt');
  fs.writeFileSync(keep,'user data');
  try {
    assert.throws(()=>cleanupSyntheticFixture(root),/marker/);
    assert.equal(fs.readFileSync(keep,'utf8'),'user data');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('symlink entries are rejected without requiring Windows symlink privileges',()=>withFixture(root=>{
  const original=fs.readdirSync;
  const fakeLink={name:'outside',isSymbolicLink:()=>true,isDirectory:()=>false,isFile:()=>false};
  fs.readdirSync=function(location,options){
    const entries=original.call(fs,location,options);
    return options?.withFileTypes&&path.resolve(location)===path.resolve(root)?[...entries,fakeLink]:entries;
  };
  try { assert.throws(()=>stageSynthetic(root,makeFixtureManifest(root)),/symlink/i); }
  finally { fs.readdirSync=original; }
}));
test('an unrecognized action is refused before any write',()=>withFixture(root=>{
  const m=makeFixtureManifest(root);
  m.actions[0].kind='overwrite';
  assert.throws(()=>stageSynthetic(root,m),/Unsupported patch action/);
}));
test('empty or oversized file payloads are rejected before staging',()=>withFixture(root=>{
  const empty=makeFixtureManifest(root);
  empty.actions=[{kind:'add-file',file:'src/empty.txt',contentBase64:''}];
  assert.throws(()=>stageSynthetic(root,empty),/Invalid patch payload/);
  const oversized=makeFixtureManifest(root);
  oversized.actions=[{kind:'add-file',file:'src/large.txt',contentBase64:Buffer.alloc(8*1024*1024+1).toString('base64')}];
  assert.throws(()=>stageSynthetic(root,oversized),/Invalid patch payload/);
}));
test('non-unique anchor refuses eligibility',()=>withFixture(root=>{
  const m=makeFixtureManifest(root);
  m.actions[0].anchor='div';
  assert.equal(inspect(root,m).reason,'anchor-not-unique');
}));

async function withPatchFixture(fn) {
  const root=makeSyntheticFixture('0.5.9');
  try { return await fn(root); }
  finally { cleanupSyntheticFixture(root); }
}

function simulateUpdate(root,{version='0.5.10',html}={}) {
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'synthetic-lilac',version})+'\n');
  fs.writeFileSync(path.join(root,'src','index.html'),html||'<!doctype html>\n<div id="homeView">\n<!--FIXTURE_SCHEDULE_SLOT-->\n<!--PATCH_FEATURE_SCRIPTS-->\n</div>\n');
  for(const file of require('../feature-payload.cjs').FILES.map(item=>item[1])) {
    const target=path.join(root,...file.split('/'));
    if(fs.existsSync(target))fs.unlinkSync(target);
  }
  const marker=path.join(root,FIXTURE_MARKER);
  if(fs.existsSync(marker))fs.unlinkSync(marker); // the updater replaced the whole app tree; sidecar state remains
}

function syntheticAdapterManifest(root,version='0.5.10') {
  const manifest=makePatch0102Manifest(root,{version:'0.5.9'});
  manifest.version=version;
  manifest.expectedFiles['package.json']=hashBytes(fs.readFileSync(path.join(root,'package.json')));
  manifest.expectedFiles['src/index.html']=hashBytes(fs.readFileSync(path.join(root,'src','index.html')));
  return manifest;
}

test('actual Patch 01/02 helper modules and original prompt bytes stage, apply, and restore',()=>withPatchFixture(root=>{
  const manifest=makePatch0102Manifest(root);
  const before=fs.readFileSync(path.join(root,'src','index.html'));
  const applied=applyPersistent(root,manifest);
  assert.equal(applied.status,'applied');
  assert.match(fs.readFileSync(path.join(root,'src','index.html'),'utf8'),/quarter-selection\.js[\s\S]*weekday-schedule\.js[\s\S]*manual-subtitle-translation\.js/);
  const quarter=require(path.join(root,'src','quarter-selection.js'));
  const schedule=require(path.join(root,'src','weekday-schedule.js'));
  const manual=require(path.join(root,'src','manual-subtitle-translation.js'));
  const episodes=require(path.join(root,'electron','weekday-episodes.cjs'));
  assert.equal(quarter.quarterForDate(new Date(2026,9,1)).quarter,4);
  assert.equal(schedule.episodeAvailability([{number:3,playable:true}],3),'playable');
  assert.equal(episodes.mapWeekdayEpisodes('reanime',new Map([[1,{anime:{provider:'reanime'}}]]),[{media:{id:1},episode:3,airingAt:200}],100,500)[0].episode,3);
  const parser=manual.parseWebVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nこんにちは\n');
  assert.equal(parser.cues[0].id,1);
  const prompts=require(path.join(root,'electron','translation-prompts.cjs'));
  for(const [language,file,expected] of [
    ['english','docs/prompts/영어 번역 프롬프트.txt','582EAF421CABBCF89279579E5723AA07B070E5B1DF2E28EE044994B2E951E37E'],
    ['japanese','docs/prompts/일본어 번역 프롬프트.txt','9FF7E860CF0C79396621C2EF65B364596EBB884AA5B3CE68E60AB0D4B42EC584'],
    [null,'docs/prompts/Reazon_작품용_단어사전_예시.txt','2DCB15B42D31BD6413D74E9A91303F0055574E030F875720CB1A1C07B814CCF8']
  ]) {
    const target=path.join(root,...file.split('/'));
    assert.equal(hashBytes(fs.readFileSync(target)).toUpperCase(),expected);
    if(language)assert.equal(Buffer.from(prompts.loadTranslationPrompt(language)).toString('hex'),fs.readFileSync(target).toString('hex'));
  }
  assert.equal(rollbackPersistent(root).status,'rolled-back');
  assert.deepEqual(fs.readFileSync(path.join(root,'src','index.html')),before);
  assert.equal(fs.existsSync(path.join(root,'src','weekday-schedule.js')),false);
  assert.equal(readState(root).latest.status,'rolled-back');
}));

test('a mid-apply write failure restores the original fixture and removes newly added files',()=>withPatchFixture(root=>{
  const manifest=makePatch0102Manifest(root);
  const originalHtml=fs.readFileSync(path.join(root,'src','index.html'));
  const failTarget=path.join(root,'src','manual-subtitle-translation.js');
  const originalRename=fs.renameSync;
  let injected=false;
  fs.renameSync=function(source,target,...rest){
    if(!injected&&path.resolve(String(target))===path.resolve(failTarget)) {
      injected=true;
      const error=new Error('Injected synthetic write failure');
      error.code='EIO';
      throw error;
    }
    return originalRename.call(fs,source,target,...rest);
  };
  try { assert.throws(()=>applyPersistent(root,manifest),/Injected synthetic write failure/); }
  finally { fs.renameSync=originalRename; }
  assert.equal(injected,true);
  assert.deepEqual(fs.readFileSync(path.join(root,'src','index.html')),originalHtml);
  assert.equal(fs.existsSync(path.join(root,'src','quarter-selection.js')),false);
  assert.equal(fs.existsSync(path.join(root,'src','weekday-schedule.js')),false);
  assert.equal(readState(root).latest.status,'rolled-back-after-failure');
}));

test('persistent apply is idempotent and waits for confirmed, stable, stopped updates',async()=>withPatchFixture(async root=>{
  const firstManifest=makePatch0102Manifest(root);
  const first=applyPersistent(root,firstManifest);
  assert.equal(first.status,'applied');
  assert.equal(applyPersistent(root,firstManifest).status,'already-applied');
  assert.equal((await reconcileAfterUpdate(root,firstManifest,{settleMs:0})).status,'update-not-confirmed');
  simulateUpdate(root);
  const nextManifest={...structuredClone(firstManifest),version:'0.5.10',expectedFiles:{...firstManifest.expectedFiles,
    'package.json':hashBytes(fs.readFileSync(path.join(root,'package.json')))}};
  assert.equal((await reconcileAfterUpdate(root,nextManifest,{updateCompleteConfirmed:true,isAppRunning:()=>true,settleMs:0})).status,'app-running');
  let changed=false;
  const unstable=await reconcileAfterUpdate(root,nextManifest,{
    updateCompleteConfirmed:true,
    settleMs:0,
    delay:async()=>{if(!changed){changed=true;fs.appendFileSync(path.join(root,'src','index.html'),'<!-- update still writing -->');}}
  });
  assert.equal(unstable.status,'update-still-changing');
  nextManifest.expectedFiles['src/index.html']=hashBytes(fs.readFileSync(path.join(root,'src','index.html')));
  const stable=await reconcileAfterUpdate(root,nextManifest,{updateCompleteConfirmed:true,settleMs:0});
  assert.equal(stable.status,'reapplied');
  assert.equal(readState(root).lastApplied.version,'0.5.10');
  assert.equal((await reconcileAfterUpdate(root,nextManifest,{updateCompleteConfirmed:true,settleMs:0})).status,'already-applied');
}));

test('unsupported update stays untouched and rollback never overwrites updater-owned bytes',async()=>withPatchFixture(async root=>{
  const manifest=makePatch0102Manifest(root);
  applyPersistent(root,manifest);
  simulateUpdate(root,{version:'0.5.11',html:'<!doctype html>\n<div id="new-host-layout"></div>\n'});
  const before=hashBytes(fs.readFileSync(path.join(root,'src','index.html')));
  const unsupported={...structuredClone(manifest),version:'0.5.10',expectedFiles:{...manifest.expectedFiles,
    'package.json':hashBytes(fs.readFileSync(path.join(root,'package.json')))}};
  const result=await reconcileAfterUpdate(root,unsupported,{updateCompleteConfirmed:true,settleMs:0});
  assert.equal(result.status,'unsupported-update');
  assert.equal(result.reason,'version-unverified');
  assert.equal(hashBytes(fs.readFileSync(path.join(root,'src','index.html'))),before);
  assert.equal(readState(root).latest.status,'unsupported-update');
}));

test('manager refuses to edit an app that is running and does not remove backups',()=>withPatchFixture(root=>{
  const manifest=makePatch0102Manifest(root);
  assert.equal(applyPersistent(root,manifest,{isAppRunning:()=>true}).status,'app-running');
  assert.equal(fs.existsSync(path.join(root,'src','weekday-schedule.js')),false);
  const applied=applyPersistent(root,manifest);
  const backup=path.join(`${root}.patch-manager`,'backups',applied.receiptId);
  assert.equal(fs.existsSync(backup),true);
  assert.equal(rollbackPersistent(root,{isAppRunning:()=>true}).status,'app-running');
  assert.equal(fs.existsSync(backup),true);
}));
