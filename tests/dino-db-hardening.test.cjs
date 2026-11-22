'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStore,FILE}=require('../patches/patch03/dino-work-db.cjs');

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dino-db-v3-'));
  const app={getPath:()=>root};
  const store=createStore({app});
  return {root,app,store,close(){store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
function sample(id,title='원래 한국어 제목',providers=['reanime','miruro']){
  const sources=providers.map(provider=>({
    provider,mal_id:provider+':'+id,id:provider+'-'+id,
    title,year:2026,type:'TV',anilistId:30000+Number(id)
  }));
  return {sources,names:[title],titles:{ko:title,koSource:'manual',
    koCheckedAt:1900000000000,manual:true,en:'English Name',ja:''},
    checkedAt:0,attemptedAt:0,outcome:'',updatedAt:1900000000000};
}
test('schema v3 migrates safely and retains titles, suppliers and history across restart',()=>{
  const env=fixture();
  try{
    assert.equal(env.store.status().schema,3);
    const before=sample(11,'사용자 한국어 제목');
    assert.equal(env.store.upsert([before]).ok,true);
    const changed=sample(11,'수정된 한국어 제목');
    changed.titles.koCheckedAt+=100;
    assert.equal(env.store.upsert([changed]).ok,true);
    const item=before.sources[0];
    const history=env.store.titleHistory(item);
    assert.equal(history[0].old_title,'사용자 한국어 제목');
    assert.equal(history[0].new_title,'수정된 한국어 제목');
    assert.equal(env.store.search({query:'수정된'}).length,1);
    assert.equal(env.store.search({query:'%%%'}).length,0,'search wildcards must be escaped');
    assert.equal(env.store.diagnostics().healthy,true);
    env.store.close();
    const resumed=createStore({app:env.app});
    try{
      assert.equal(resumed.status().schema,3);
      assert.equal(resumed.lookup(item).titles.ko,'수정된 한국어 제목');
      assert.equal(resumed.lookup(item).sources.length,2);
      assert.equal(resumed.titleHistory(item).length,1);
      assert.equal(resumed.diagnostics().healthy,true);
      assert.ok(fs.existsSync(path.join(env.root,FILE)));
    }finally{resumed.close();}
  }finally{env.close();}
});
test('link preview prevents cross-season/manual duplicate sources without writes',()=>{
  const env=fixture();
  try{
    const anchor=sample(21,'스물하나',['reanime']);
    const candidate=sample(21,'스물하나',['miruro']);
    const other=sample(22,'다른 시즌',['linkani']);
    assert.equal(env.store.upsert([anchor,candidate,other]).ok,true);
    const review=env.store.preview({anchor:anchor.sources[0],source:candidate.sources[0]});
    assert.equal(review.ok,true);
    assert.equal(review.compatible,true);
    assert.equal(review.sameWork,false);
    assert.equal(env.store.stats().works,3,'preview cannot move a supplier');
    const blocked=env.store.preview({anchor:anchor.sources[0],source:other.sources[0]});
    assert.equal(blocked.ok,true);
    assert.equal(blocked.compatible,false);
    assert.equal(env.store.repair('attach',{anchor:anchor.sources[0],source:candidate.sources[0]}).ok,true);
    assert.equal(env.store.stats().works,2);
    assert.equal(env.store.linkHistory()[0].action,'attach');
    assert.equal(env.store.lookup(candidate.sources[0]).sources.length,2);
    const split=env.store.repair('detach',{anchor:anchor.sources[0],source:candidate.sources[0]});
    assert.equal(split.ok,true);
    assert.equal(env.store.linkHistory()[0].action,'detach');
    assert.equal(env.store.upsert([{...anchor,sources:[...anchor.sources,...candidate.sources]}]).ok,false);
    assert.equal(env.store.lookup(candidate.sources[0]).sources.length,1);
  }finally{env.close();}
});
test('search is bounded and diagnostics are read-only for more than the hot cache size',()=>{
  const env=fixture();
  try{
    for(let i=0;i<1850;i+=48){
      const batch=Array.from({length:Math.min(48,1850-i)},(_,j)=>
        sample(i+j+1000,'저장 작품 '+(i+j+1000),['reanime']));
      assert.equal(env.store.upsert(batch).ok,true);
    }
    const stats=env.store.stats();
    assert.equal(stats.works,1850);
    assert.equal(env.store.search({query:'저장',limit:12}).length,12);
    assert.ok(env.store.search({query:'저장',limit:999}).length<=40);
    assert.equal(env.store.diagnostics().works,1850);
    assert.equal(env.store.diagnostics().foreignKeyErrors,0);
    assert.equal(env.store.stats().works,1850);
  }finally{env.close();}
});
