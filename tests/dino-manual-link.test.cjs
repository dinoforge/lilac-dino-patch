'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../patches/patch03/dino-work-db.cjs');
const {createWorkIndex}=require('../src/integrated-search.js');
const {connect}=require('../src/dino-sqlite-sync.js');

function fixture(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dino-manual-link-'));
  const store=createStore({app:{getPath:()=>home}});
  return {store,home,close:()=>{store.close();fs.rmSync(home,{recursive:true,force:true});}};
}
function row(id='42'){
  const sources=['reanime','miruro','animenosub','ohli24','linkani']
    .map(provider=>({provider,mal_id:provider+':'+id,id:provider+id,
      title:'작품 '+id,title_english:'Anime '+id,year:2026,type:'TV',
      anilistId:Number(id)+12000}));
  return {id:'reanime:'+id,sources,names:['작품 '+id],
    titles:{ko:'내가 지정한 이름',manual:true,koSource:'manual',koCheckedAt:1900000000000,en:'Anime '+id,ja:''},
    checkedAt:1900000000000,updatedAt:1900000000000,outcome:'verified'};
}

test('manual detach retains canonical title, preserves other suppliers and rejects stale auto-relink',()=>{
  const env=fixture();
  try{
    const initial=row();
    assert.equal(env.store.upsert([initial]).ok,true);
    const anchor=initial.sources[0],moving=initial.sources[1];
    assert.equal(env.store.status().schema,2);
    const result=env.store.repair('detach',{anchor,source:moving});
    assert.equal(result.ok,true,result.reason);
    assert.equal(env.store.stats().works,2);
    assert.equal(env.store.lookup(anchor).sources.length,4);
    assert.equal(env.store.lookup(anchor).titles.ko,'내가 지정한 이름');
    assert.equal(env.store.lookup(anchor).titles.manual,true);
    assert.equal(env.store.lookup(moving).sources.length,1);
    assert.equal(env.store.lookup(moving).titles.manual,false);
    assert.equal(env.store.upsert([initial]).ok,false,'old merged card must not undo a manual split');
    assert.equal(env.store.lookup(moving).sources.length,1);
    const restored=env.store.repair('attach',{anchor,source:moving});
    assert.equal(restored.ok,true,restored.reason);
    assert.equal(env.store.stats().works,1);
    assert.equal(env.store.lookup(anchor).sources.length,5);
    assert.equal(env.store.lookup(moving).titles.ko,'내가 지정한 이름');
  }finally{env.close();}
});

test('manual move blocks conflicting seasons, duplicate suppliers and unknown IDs atomically',()=>{
  const env=fixture();
  try{
    const first=row('51'),other=row('52');
    assert.equal(env.store.upsert([first,other]).ok,true);
    const anchor=first.sources[0],moving=other.sources[1];
    const rejected=env.store.repair('attach',{anchor,source:moving});
    assert.equal(rejected.ok,false);
    assert.match(rejected.reason,/공급원이 이미 연결/);
    assert.equal(env.store.stats().works,2);
    assert.equal(env.store.lookup(moving).sources.length,5);
    assert.equal(env.store.repair('attach',{anchor,source:{provider:'linkani',mal_id:'missing'}}).ok,false);
    const detach=env.store.repair('detach',{anchor,source:first.sources[2]});
    assert.equal(detach.ok,true);
    const stale=env.store.lookup(anchor),alone=env.store.lookup(first.sources[2]);
    assert.equal(stale.sources.length,4);
    assert.equal(alone.sources.length,1);
    const fake={...alone.sources[0],year:2025};
    assert.equal(env.store.upsert([{...alone,sources:[fake]}]).ok,false);
    assert.equal(env.store.lookup(first.sources[2]).sources[0].year,2026);
  }finally{env.close();}
});

test('renderer memory gets an authoritative split instead of fuzzy rejoining same-title rows',async()=>{
  const env=fixture();
  try{
    const data=new Map();
    const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),
      removeItem:key=>data.delete(key)};
    const index=createWorkIndex(storage);
    const initial=row('61');
    index.remember({sourceItems:initial.sources});
    index.rememberTitles(initial.sources[0],{ko:'직접 쓴 제목'},{source:'manual'});
    const invoke=async(method,payload)=>method==='status'?env.store.status()
      :method==='upsert'?env.store.upsert(payload.works)
      :method==='lookup'?env.store.lookup(payload)
      :method==='recent'?env.store.recent(payload)
      :method==='stats'?env.store.stats()
      :env.store.repair(method,payload);
    const bridge=connect(index,invoke,{delay:()=>null});
    assert.equal(await bridge.start(),true);
    const anchor=initial.sources[0],moving=initial.sources[1];
    const detached=await bridge.repair('detach',anchor,moving);
    assert.equal(detached.ok,true,detached.reason);
    assert.equal(detached.cacheUpdated,true);
    assert.equal(index.separateWorks(anchor,moving),true);
    assert.equal(index.find(anchor).sources.length,4);
    assert.equal(index.find(moving).sources.length,1);
    index.remember({sourceItems:initial.sources});
    assert.equal(index.find(anchor).sources.length,4,'stale discovered cards cannot silently reunite manually split sources');
    const attached=await bridge.repair('attach',anchor,moving);
    assert.equal(attached.ok,true);
    assert.equal(index.find(anchor).sources.length,5);
  }finally{env.close();}
});
