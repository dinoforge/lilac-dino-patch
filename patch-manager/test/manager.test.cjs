'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { inspect, hashBytes, checkedRelative }=require('../core.cjs');
const { makeSyntheticFixture,makeFixtureManifest,stageSynthetic,assertSyntheticFixture }=require('../staging.cjs');

function withFixture(fn,version='0.5.14') {
  const root=makeSyntheticFixture(version);const dirs=[];
  try { return fn(root, dirs); }
  finally {for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});}
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
  const result=stageSynthetic(root,manifest);dirs.push(result.stagedRoot);
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
  for(const p of ['../app.asar','/etc/passwd','C:/windows/system32','src/../index.html','./src/app.js','src\\app.js']) {
    assert.throws(()=>checkedRelative(p));
  }
});
test('symlinks in the fixture cannot be traversed or staged',()=>withFixture((root,dirs)=>{
  const target=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-external-'));dirs.push(target);
  fs.symlinkSync(target,path.join(root,'outside'),'dir');
  assert.throws(()=>stageSynthetic(root,makeFixtureManifest(root)),/symlink/i);
}));
test('an unrecognized action is refused before any write',()=>withFixture(root=>{
  const m=makeFixtureManifest(root);
  m.actions[0].kind='overwrite';
  assert.throws(()=>stageSynthetic(root,m),/Unsupported patch action/);
}));
test('non-unique anchor refuses eligibility',()=>withFixture(root=>{
  const m=makeFixtureManifest(root);
  m.actions[0].anchor='div';
  assert.equal(inspect(root,m).reason,'anchor-not-unique');
}));
