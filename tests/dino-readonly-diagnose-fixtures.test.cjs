'use strict';
// Runs the actual PowerShell read-only inspector on disposable synthetic installs.
// No real LilacAnime installation or user profile is accessed.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../scripts/dino-read-only-diagnose.ps1');
const bins=process.platform==='win32'?['pwsh.exe','powershell.exe']:['pwsh'];
const shell=bins.find(bin=>{
  const r=spawnSync(bin,['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.Major'],{encoding:'utf8',timeout:5000});
  return !r.error && r.status===0;
});
const opts={skip:!shell?'PowerShell is unavailable; fixture was not executed':false};
const hash=data=>crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
const slot=v=>hash(Buffer.from(v)).toLowerCase().slice(0,24);
function put(p,data){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data);}
function fingerprint(root){
  const result=[];
  function scan(dir,rel=''){
    for(const x of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const name=path.join(dir,x.name),relative=path.join(rel,x.name);
      if(x.isDirectory())scan(name,relative);
      else result.push([relative,hash(fs.readFileSync(name))]);
    }
  }
  scan(root);return result;
}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dino-inspect-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const install=path.join(root,'LilacAnime fixture');
  const appdata=path.join(root,'profile');
  const asar=path.join(install,'resources','app.asar');
  const stateDir=path.join(appdata,'DinoPatchManager','installed-asar','fixture');
  put(path.join(install,'LilacAnime.exe'),'not a genuine executable');
  put(asar,'official v0.5.65 synthetic');
  fs.mkdirSync(appdata,{recursive:true});
  function record({version='0.5.65',original='official v0.5.65 synthetic',patched='patched v0.5.65 synthetic',legacy=false,schema=1,backupName}={}){
    const name=legacy?'state.json':'state-'+slot(version)+'.json';
    const backup=backupName===undefined?(legacy?'original-app.asar':'original-'+slot(version)+'.asar'):backupName;
    const state={schemaVersion:schema,target:install,version,patchVersion:'1.0.0',status:'APPLIED',
      originalSha256:hash(original),patchedSha256:hash(patched),backupFile:legacy?null:backup,
      createdAt:'2026-11-14T00:00:00Z'};
    put(path.join(stateDir,name),JSON.stringify(state));
    if(backup)put(path.join(stateDir,backup),original);
    return {name,backup};
  }
  function run(){
    const before=fingerprint(root);
    const r=spawnSync(shell,['-NoProfile','-NonInteractive','-File',script,'-InstalledRoot',install],
      {cwd:root,env:{...process.env,APPDATA:appdata},encoding:'utf8',timeout:15000});
    assert.equal(r.error,undefined,r.error?.message);
    assert.equal(r.status,0,'PowerShell returned '+r.status+'\n'+r.stdout+'\n'+r.stderr);
    const result=JSON.parse(r.stdout.replace(/^\uFEFF/,'').trim());
    assert.deepEqual(fingerprint(root),before,'The diagnostic modified its input fixture');
    return result;
  }
  return {root,install,appdata,asar,stateDir,record,run};
}
test('no state reports NO_MANAGER_STATE without modifications',opts,t=>{
  const f=fixture(t);assert.equal(f.run().result,'NO_MANAGER_STATE');
});
test('legacy original is identified and its backup hash verified',opts,t=>{
  const f=fixture(t);f.record({legacy:true});
  const r=f.run();
  assert.equal(r.result,'READ_ONLY_AUDIT');
  assert.equal(r.currentAsarMatch,'RECORDED_ORIGINAL_ASAR');
  assert.equal(r.originalBackupHashMatchesRecord,true);
  assert.equal(r.recordedStateFile,'state.json');
});
test('current version selects unique generation and keeps old state',opts,t=>{
  const f=fixture(t);
  f.record({legacy:true,version:'0.5.64',original:'old official',patched:'old patched'});
  const current=f.record();
  const r=f.run();
  assert.equal(r.result,'READ_ONLY_AUDIT');
  assert.equal(r.selectionReason,'UNIQUE_CURRENT_ASAR_HASH');
  assert.equal(r.recordedStateFile,current.name);
  assert.equal(r.recordedBackupFile,current.backup);
  assert.equal(r.stateGenerationsForTarget,2);
});
test('duplicate matching generations fail closed',opts,t=>{
  const f=fixture(t);f.record({legacy:true});f.record();
  const r=f.run();
  assert.equal(r.result,'STATE_NOT_UNIQUE');
  assert.equal(r.matchingCurrentAsarHash,2);
});
test('no matching generation across multiple states remains ambiguous',opts,t=>{
  const f=fixture(t);
  f.record({legacy:true,version:'0.5.64',original:'old official',patched:'old patched'});
  f.record({version:'0.5.65',original:'other official',patched:'other patched'});
  assert.equal(f.run().result,'STATE_NOT_UNIQUE');
});
test('invalid matching schema fails closed',opts,t=>{
  const f=fixture(t);f.record({schema:2});
  assert.equal(f.run().result,'INVALID_STATE_RECORD');
});
test('invalid versioned backup filename fails closed',opts,t=>{
  const f=fixture(t);f.record({backupName:'original-incorrect.asar'});
  assert.equal(f.run().result,'INVALID_STATE_RECORD');
});
test('pending recovery record is preserved and reported',opts,t=>{
  const f=fixture(t);f.record();
  put(path.join(f.stateDir,'pending.json'),JSON.stringify({target:f.install}));
  const r=f.run();
  assert.equal(r.pendingRecoveryRecordPresent,true);
  assert.match(r.recommendation,/Pending recovery/i);
});
test('missing backup is explicitly unsafe and never restored',opts,t=>{
  const f=fixture(t),entry=f.record();
  fs.rmSync(path.join(f.stateDir,entry.backup));
  const r=f.run();
  assert.equal(r.originalBackupHashMatchesRecord,false);
  assert.match(r.recommendation,/stop all patch\/restore actions/);
});
test('single historical record does not authorize changed ASAR',opts,t=>{
  const f=fixture(t);
  f.record({legacy:true,original:'past official',patched:'past patched'});
  const r=f.run();
  assert.equal(r.currentAsarMatch,'DIFFERENT_FROM_BOTH_RECORDED_HASHES');
  assert.match(r.recommendation,/Do not restore this old backup/);
});
