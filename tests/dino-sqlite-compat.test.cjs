'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStore,FILE}=require('../patches/patch03/dino-work-db.cjs');
const sync=require('../src/dino-sqlite-sync.js');
const api=require('../src/integrated-search.js');

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dino-sqlite-compat-'));
  const store=createStore({app:{getPath:key=>{assert.equal(key,'userData');return root;}}});
  return {root,store,close:()=>{store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
const work=(id,title='공통 작품 이름',manual=false)=>({
  id:'reanime:'+id,names:[title,'English Name','日本語タイトル'],
  sources:api.PROVIDERS.map((provider,i)=>({
    provider,id:provider+'-'+id,mal_id:provider+':'+id,
    title:i===0?'English Name':title,
    title_english:'English Name',anilistId:120000+Number(id),year:2026,type:'TV'
  })),
  titles:{ko:title,en:'English Name',ja:'日本語タイトル',
    koSource:manual?'manual':'official',koCheckedAt:1700000000000,manual},
  checkedAt:1700000001000,attemptedAt:1700000001000,outcome:'verified',updatedAt:1700000001000
});

test('works and five suppliers persist in SQLite with no artificial global work limit',()=>{
  const env=fixture();
  try{
    assert.equal(env.store.status().available,true);
    const original=work('100');
    assert.equal(env.store.upsert([original]).ok,true);
    assert.equal(env.store.upsert([original]).ok,true,'legacy migration is idempotent');
    for(let i=101;i<901;i+=48){
      const rows=Array.from({length:Math.min(48,901-i)},(_,j)=>work(String(i+j),'한국어 작품 '+(i+j)));
      assert.equal(env.store.upsert(rows).ok,true);
    }
    const stats=env.store.stats();
    assert.equal(stats.works,801);
    assert.ok(stats.sources.every(source=>source.count===801));
    const loaded=env.store.lookup({provider:'miruro',mal_id:'miruro:100'});
    assert.equal(loaded.titles.ko,'공통 작품 이름');
    assert.equal(loaded.sources.length,5);
    assert.equal(loaded.titles.koSource,'official');
    assert.ok(fs.existsSync(path.join(env.root,FILE)));
    assert.ok(env.store.recent({limit:12}).length===12);
  }finally{env.close();}
});

test('existing manual Korean title is never replaced by a late legacy import',()=>{
  const env=fixture();
  try{
    const user=work('2','내가 수정한 제목',true);
    assert.equal(env.store.upsert([user]).ok,true);
    const stale=work('2','자동으로 조회한 제목',false);
    stale.updatedAt-=5000;
    assert.equal(env.store.upsert([stale]).ok,true);
    const title=env.store.lookup({provider:'ohli24',mal_id:'ohli24:2'}).titles;
    assert.equal(title.ko,'내가 수정한 제목');
    assert.equal(title.koSource,'manual');
    assert.equal(title.manual,true);
    const reset=work('2','공급원 제목',false);
    reset.dinoResetManual=true;
    reset.updatedAt+=10000;
    assert.equal(env.store.upsert([reset]).ok,true);
    assert.equal(env.store.lookup({provider:'ohli24',mal_id:'ohli24:2'}).titles.manual,false);
    assert.equal(env.store.lookup({provider:'ohli24',mal_id:'ohli24:2'}).titles.ko,'공급원 제목');
  }finally{env.close();}
});

test('original LilacAnime title cache and application preferences remain byte-for-byte untouched',()=>{
  const env=fixture();
  try{
    const official=path.join(env.root,'display-title-cache.json');
    const existing='{"ko":"저장된 공식 제목","nonce":123}';
    fs.writeFileSync(official,existing,'utf8');
    const prefs=path.join(env.root,'korean-title-cache.json');
    fs.writeFileSync(prefs,'KOREAN-ORIGINAL');
    assert.equal(env.store.upsert([work('3')]).ok,true);
    assert.equal(fs.readFileSync(official,'utf8'),existing);
    assert.equal(fs.readFileSync(prefs,'utf8'),'KOREAN-ORIGINAL');
    assert.equal(env.store.upsert(Array.from({length:49},(_,i)=>work(String(4000+i)))).ok,false);
    assert.equal(env.store.stats().works,1,'invalid oversized batch must be rejected atomically');
    assert.equal(env.store.lookup({provider:'unknown',mal_id:'invalid'}),null);
  }finally{env.close();}
});

test('SQLite absence leaves original v1 synchronous index operational and untouched',async()=>{
  const env=fixture();
  try{
    const bag=new Map(),local={getItem:k=>bag.get(k)||null,setItem:(k,v)=>bag.set(k,String(v))};
    const index=api.createWorkIndex(local);
    const adapter=sync.connect(index,null);
    assert.equal(await adapter.start(),false);
    const first=work('42');
    index.observe(first.sources,{limit:24});
    index.rememberTitles(first.sources[0],{ko:'사용자 제목'},{source:'manual'});
    index.flush();
    assert.equal(index.find(first.sources[1]).titles.ko,'사용자 제목');
    assert.equal(adapter.report().active,false);
    assert.ok(bag.has(api.WORK_INDEX_KEY));
    assert.equal(fs.existsSync(path.join(env.root,FILE)),false);
  }finally{env.close();}
});

test('existing v1 work cache migrates without deletion and older SQLite works hydrate on demand',async()=>{
  const env=fixture();
  try{
    const bag=new Map(),local={getItem:k=>bag.get(k)||null,setItem:(k,v)=>bag.set(k,String(v))};
    const index=api.createWorkIndex(local);
    const initial=work('51','내가 선택한 한국어 이름',true);
    index.observe(initial.sources,{limit:24});
    index.rememberTitles(initial.sources[0],{ko:'내가 선택한 한국어 이름'},{source:'manual'});
    index.flush();
    const old=bag.get(api.WORK_INDEX_KEY);
    const extra=work('71','다른 곳에서 저장했던 작품',false);
    assert.equal(env.store.upsert([extra]).ok,true);
    const rpc=async(name,payload)=>{
      if(name==='status')return env.store.status();
      if(name==='upsert')return env.store.upsert(payload.works);
      if(name==='lookup')return env.store.lookup(payload);
      if(name==='recent')return env.store.recent(payload);
      if(name==='stats')return env.store.stats();
      throw Error('Unsupported method');
    };
    const adapter=sync.connect(index,rpc,{delay:()=>1});
    assert.equal(await adapter.start(),true);
    assert.equal(adapter.report().active,true);
    assert.equal(bag.get(api.WORK_INDEX_KEY),old,'migration cannot erase or rename the original v1 cache');
    assert.equal((await adapter.stats()).works,2);
    assert.equal((await adapter.ensure(extra.sources[2])).titles.ko,'다른 곳에서 저장했던 작품');
    assert.equal(env.store.lookup({provider:'miruro',mal_id:'miruro:51'}).titles.ko,'내가 선택한 한국어 이름');
    index.rememberTitles(initial.sources[1],{ko:'새로 수정한 제목'},{source:'manual'});
    assert.equal(await adapter.flush(),true);
    assert.equal(env.store.lookup({provider:'reanime',mal_id:'reanime:51'}).titles.ko,'새로 수정한 제목');
  }finally{env.close();}
});


test('an existing supplier identity cannot be overwritten by a different season or external ID',()=>{
  const env=fixture();
  try{
    const first=work('401','동일 이름의 첫 시즌');
    assert.equal(env.store.upsert([first]).ok,true);
    const wrong=work('401','다른 시즌으로 잘못 연결된 제목');
    wrong.sources[0]={...wrong.sources[0],anilistId:999999,year:2027};
    const outcome=env.store.upsert([wrong]);
    assert.equal(outcome.ok,false);
    assert.match(outcome.reason,/identity conflicts/i);
    const stored=env.store.lookup({provider:'reanime',mal_id:'reanime:401'});
    assert.equal(stored.titles.ko,'동일 이름의 첫 시즌');
    assert.equal(stored.sources.length,5);
    assert.equal(env.store.stats().works,1);
  }finally{env.close();}
});

test('official Korean title is not downgraded to an older provider-only title',()=>{
  const env=fixture();
  try{
    const original=work('202','원본이 확인한 한국어 제목',false);
    assert.equal(env.store.upsert([original]).ok,true);
    const provider=work('202','공급원이 임시로 쓴 제목',false);
    provider.titles.koSource='provider';
    provider.updatedAt+=10000;
    assert.equal(env.store.upsert([provider]).ok,true);
    const row=env.store.lookup({provider:'linkani',mal_id:'linkani:202'});
    assert.equal(row.titles.ko,'원본이 확인한 한국어 제목');
    assert.equal(row.titles.koSource,'official');
  }finally{env.close();}
});


test('more than the v1 hot-cache limit survives SQLite restart across five suppliers',()=>{
  const env=fixture();
  let reopened=null;
  try{
    const count=1901;
    for(let i=0;i<count;i+=48){
      const batch=Array.from({length:Math.min(48,count-i)},(_,j)=>
        work(String(5000+i+j),'한국어 작품 '+(i+j)));
      assert.equal(env.store.upsert(batch).ok,true);
    }
    assert.equal(env.store.stats().works,count);
    env.store.close();
    reopened=createStore({app:{getPath:()=>env.root}});
    assert.equal(reopened.stats().works,count);
    assert.ok(reopened.stats().sources.every(s=>s.count===count));
    assert.equal(reopened.lookup({provider:'linkani',mal_id:'linkani:6900'}).sources.length,5);
    assert.equal(reopened.lookup({provider:'miruro',mal_id:'miruro:5000'}).titles.ko,'한국어 작품 0');
  }finally{reopened?.close();env.close();}
});

test('automatic linking rejects cross-season IDs and duplicate supplier rows atomically',()=>{
  const env=fixture();
  try{
    const initial=work('1211','첫 시즌');
    initial.sources=[initial.sources[0]];
    assert.equal(env.store.upsert([initial]).ok,true);
    const newSource={provider:'miruro',mal_id:'miruro:other-season',id:'wrong',
      title:'잘못된 두 번째 시즌',anilistId:555555,year:2027,type:'TV'};
    const inconsistent={...initial,sources:[...initial.sources,newSource]};
    const rejected=env.store.upsert([inconsistent]);
    assert.equal(rejected.ok,false);
    assert.match(rejected.reason,/identity conflicts/);
    assert.equal(env.store.stats().works,1);
    assert.equal(env.store.lookup(newSource),null);
    const duplicate={...initial,sources:[initial.sources[0],
      {...initial.sources[0],mal_id:'reanime:another-season'}]};
    assert.equal(env.store.upsert([duplicate]).ok,false);
    assert.equal(env.store.lookup(initial.sources[0]).sources.length,1);
  }finally{env.close();}
});

test('legacy invalid season groups are skipped without disabling the SQLite writer',async()=>{
  const data=new Map();
  const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,String(value))};
  const index=api.createWorkIndex(storage);
  index.remember({sourceItems:work('11111').sources});
  const calls=[];
  const rpc=async(method,payload)=>{
    calls.push(method);
    if(method==='status')return {available:true};
    if(method==='upsert')return {ok:false,reason:'incoming provider source identity conflicts with the stored work'};
    if(method==='recent')return [];
    throw Error('unexpected');
  };
  const adapter=sync.connect(index,rpc,{delay:()=>null});
  assert.equal(await adapter.start(),true);
  assert.equal(adapter.report().active,true);
  assert.equal(adapter.report().skippedConflicts,1);
  assert.equal(calls.filter(m=>m==='upsert').length,2);
});

test('SQLite retains last confirmed latest episode across stale passive cards, restarts and five suppliers',()=>{
  const env=fixture();
  try{
    const episodeWork=work('808','공통 한국어 제목',true);
    episodeWork.sources[0].dinoEpisode={
      state:'ready',latest:12,count:12,checkedAt:1900000000000,
      attemptedAt:1900000000000,newEpisodes:2
    };
    assert.equal(env.store.upsert([episodeWork]).ok,true);
    const cached=work('808','공급원 원래 제목',false);
    assert.equal(env.store.upsert([cached]).ok,true);
    const kept=env.store.lookup({provider:'reanime',mal_id:'reanime:808'});
    assert.equal(kept.sources.find(s=>s.provider==='reanime').dinoEpisode.latest,12);
    assert.equal(kept.titles.ko,'공통 한국어 제목');
    assert.equal(kept.titles.manual,true);
    const next=work('808','공급원 원래 제목',false);
    next.sources[0].dinoEpisode={
      state:'ready',latest:13,count:13,checkedAt:1900000005000,
      attemptedAt:1900000005000,newEpisodes:1
    };
    assert.equal(env.store.upsert([next]).ok,true);
    assert.equal(env.store.lookup({provider:'reanime',mal_id:'reanime:808'})
      .sources.find(s=>s.provider==='reanime').dinoEpisode.latest,13);
    assert.equal(env.store.lookup({provider:'miruro',mal_id:'miruro:808'})
      .sources.find(s=>s.provider==='miruro').dinoEpisode,undefined);
  }finally{env.close();}
});

test('manual title revisions win over stale equal-time cache writes across SQLite restart',()=>{
  const env=fixture();
  try{
    const first=work('9501','내가 확정한 제목',true);
    assert.equal(env.store.upsert([first]).ok,true);
    const stale=work('9501','이전 세션에서 남은 잘못된 제목',true);
    stale.titles.koCheckedAt=first.titles.koCheckedAt;
    assert.equal(env.store.upsert([stale]).ok,true);
    assert.equal(env.store.lookup(first.sources[0]).titles.ko,'내가 확정한 제목');
    const revised=work('9501','최신 수동 제목',true);
    revised.titles.koCheckedAt=first.titles.koCheckedAt+1;
    assert.equal(env.store.upsert([revised]).ok,true);
    env.store.close();
    const reopened=createStore({app:{getPath:()=>env.root}});
    try {
      assert.equal(reopened.lookup(first.sources[4]).titles.ko,'최신 수동 제목');
      assert.equal(reopened.lookup(first.sources[4]).titles.manual,true);
      assert.equal(reopened.lookup(first.sources[4]).sources.length,5);
    }finally{reopened.close();}
  }finally{env.close();}
});

test('an older hot-cache entry hydrates its current SQLite titles and links before use',async()=>{
  const env=fixture();
  try{
    const bag=new Map(),local={getItem:k=>bag.get(k)||null,setItem:(k,v)=>bag.set(k,String(v))};
    const index=api.createWorkIndex(local,{clock:()=>1900000000000});
    const canonical=work('9511','SQLite에서 확정한 한국어 제목',true);
    canonical.titles.koCheckedAt=2000000000000;
    assert.equal(env.store.upsert([canonical]).ok,true);
    index.remember({sourceItems:[canonical.sources[0]]},{checked:true,attempted:true,outcome:'verified'});
    index.rememberTitles(canonical.sources[0],{ko:'과거 로컬 제목'},{source:'manual'});
    assert.equal(index.flush(),true);
    let exactLookups=0;
    const rpc=async(method,payload)=>{
      if(method==='status')return env.store.status();
      if(method==='upsert')return env.store.upsert(payload.works);
      if(method==='recent')return []; // Simulate a work older than startup's 180-row page.
      if(method==='lookup'){exactLookups++;return env.store.lookup(payload);}
      throw Error('unexpected '+method);
    };
    const adapter=sync.connect(index,rpc,{delay:()=>1});
    assert.equal(await adapter.start(),true);
    const restored=await adapter.ensure(canonical.sources[0]);
    assert.equal(restored.titles.ko,'SQLite에서 확정한 한국어 제목');
    assert.equal(restored.titles.manual,true);
    assert.equal(restored.sources.length,5);
    assert.equal(exactLookups,1);
    await adapter.ensure(canonical.sources[0]);
    assert.equal(exactLookups,1,'one authoritative hydration per source is sufficient');
  }finally{env.close();}
});

test('corrupt SQLite pages trigger read-only local-cache fallback before WAL or schema mutation',()=>{
  const changes=[];
  let closed=0;
  class CorruptDatabase {
    prepare(sql){
      if(sql==='PRAGMA quick_check(1)')return {all:()=>[{quick_check:'database disk image is malformed'}]};
      throw Error('unexpected query on corrupted database: '+sql);
    }
    exec(sql){changes.push(sql);}
    close(){closed++;}
  }
  const store=createStore({app:{getPath:()=>'/profile'},DatabaseSync:CorruptDatabase});
  const state=store.status();
  assert.equal(state.available,false);
  assert.equal(state.recovery,'local-cache-fallback');
  assert.equal(state.dbPreserved,true);
  assert.match(state.reason,/무결성 검사 실패/);
  assert.deepEqual(changes,[],'must not enable WAL or rewrite schema on broken DB');
  assert.equal(closed,1);
  assert.equal(store.upsert([work('9901')]).ok,false);
  assert.deepEqual(changes,[],'later writes must also remain blocked');
});

test('invalid SQLite foreign keys are preserved and reported without automatic database repair',()=>{
  const changes=[];
  class DamagedRelations {
    prepare(sql){
      if(sql==='PRAGMA quick_check(1)')return {all:()=>[{quick_check:'ok'}]};
      if(sql==='PRAGMA foreign_key_check')return {all:()=>[{table:'work_sources',rowid:3}]};
      throw Error(sql);
    }
    exec(sql){changes.push(sql);}
    close(){}
  }
  const store=createStore({app:{getPath:()=>'/profile'},DatabaseSync:DamagedRelations});
  const state=store.status();
  assert.equal(state.available,false);
  assert.equal(state.recovery,'local-cache-fallback');
  assert.match(state.reason,/외래키 오류/);
  assert.deepEqual(changes,[]);
});

test('SQLite integrity checks occur before journal configuration and never remove user backups',()=>{
  const dbSource=fs.readFileSync(path.join(__dirname,'../patches/patch03/dino-work-db.cjs'),'utf8');
  const init=dbSource.split('function init()')[1].split('function status()')[0];
  assert.ok(init.indexOf("PRAGMA quick_check(1)") < init.indexOf('PRAGMA journal_mode=WAL'));
  assert.ok(init.indexOf('PRAGMA foreign_key_check') < init.indexOf('CREATE TABLE IF NOT EXISTS works'));
  assert.doesNotMatch(init,/unlinkSync|rmSync|renameSync|DROP TABLE|VACUUM|DELETE FROM/);
});

test('invalid SQLite status falls back to the intact five-source cache without deleting manual titles',async()=>{
  const bag=new Map(),local={getItem:key=>bag.get(key)||null,setItem:(key,v)=>bag.set(key,String(v))};
  const index=api.createWorkIndex(local);
  const record=work('9981','사용자가 저장한 제목',true);
  index.remember({sourceItems:record.sources});
  index.rememberTitles(record.sources[0],{ko:'사용자가 저장한 제목'},{source:'manual'});
  assert.equal(index.flush(),true);
  const before=bag.get(api.WORK_INDEX_KEY);
  const invoked=[];
  const adapter=sync.connect(index,async method=>{
    invoked.push(method);
    if(method==='status')return {available:false,reason:'SQLite 무결성 검사 실패'};
    throw Error('Must not read or write a corrupt database');
  });
  assert.equal(await adapter.start(),false);
  const cached=await adapter.ensure(record.sources[3]);
  assert.equal(cached.titles.ko,'사용자가 저장한 제목');
  assert.equal(cached.titles.manual,true);
  assert.equal(cached.sources.length,5);
  assert.equal(adapter.report().phase,'legacy');
  assert.deepEqual(invoked,['status']);
  assert.equal(bag.get(api.WORK_INDEX_KEY),before);
});
