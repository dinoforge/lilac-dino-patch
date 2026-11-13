'use strict';
// Optional work index inside Electron's userData. Original title caches,
// profiles, downloads, and renderer localStorage are never modified here.
const path=require('node:path');
const PROVIDERS=new Set(['reanime','miruro','animenosub','ohli24','linkani']);
const BATCH_LIMIT=48;
const FILE='dino-work-index.sqlite';
const clean=x=>typeof x==='string'?x.trim().slice(0,240):'';
const number=x=>Number.isFinite(Number(x))?Math.max(0,Math.trunc(Number(x))):0;
const korean=x=>/[가-힣]/.test(x||'')?clean(x):'';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const sourceKey=x=>String(x?.mal_id??(x?.provider&&x?.id!=null?x.provider+':'+x.id:'')).slice(0,300);
const external=x=>String(x??'').trim().replace(/^0+/, '')||'';
const identityConflict=(a,b)=>{
  if(!object(a)||!object(b))return false;
  const ids=[['anilistId','anilist_id'],['malId','malId']];
  for(const [first,second] of ids){
    const left=external(a[first]??a[second]),right=external(b[first]??b[second]);
    if(left&&right&&left!==right)return true;
  }
  const leftYear=number(a.year),rightYear=number(b.year);
  if(leftYear&&rightYear&&leftYear!==rightYear)return true;
  if(clean(a.type)&&clean(b.type)&&clean(a.type).toUpperCase()!==clean(b.type).toUpperCase())
    return true;
  return false;
};
const parse=x=>{try{return JSON.parse(x)}catch{return null}};
// Canonical ordering makes manual separation independent of which work opened it.
function pairFields(a,b){
  const aa={provider:a?.provider,id:sourceKey(a)},bb={provider:b?.provider,id:sourceKey(b)};
  if(!PROVIDERS.has(aa.provider)||!PROVIDERS.has(bb.provider)||!aa.id||!bb.id
    ||aa.provider===bb.provider&&aa.id===bb.id)return null;
  const left=(aa.provider+'\0'+aa.id)<(bb.provider+'\0'+bb.id)?aa:bb;
  const right=left===aa?bb:aa;
  return [left.provider,left.id,right.provider,right.id];
}
function normalize(raw){
  if(!object(raw)||!Array.isArray(raw.sources)||!raw.sources.length||raw.sources.length>8
    || JSON.stringify(raw).length>40000)return null;
  const sources=[],seen=new Set(),seenProviders=new Set();
  for(const src of raw.sources){
    if(!object(src)||!PROVIDERS.has(src.provider)||JSON.stringify(src).length>16000)continue;
    const id=sourceKey(src),key=src.provider+':'+id;
    if(!id||seen.has(key))continue;
    // One canonical work should not contain multiple episodes/season entries
    // from the same supplier: ask for a manual selection instead.
    if(seenProviders.has(src.provider))return null;
    seen.add(key);seenProviders.add(src.provider);sources.push({...src,mal_id:id});
  }
  if(!sources.length)return null;
  const title=object(raw.titles)?raw.titles:{};
  const ko=korean(title.ko),manual=title.manual===true&&!!ko;
  return {sources,
    names:[...new Set((Array.isArray(raw.names)?raw.names:[]).map(clean).filter(Boolean))].slice(0,24),
    titles:{ko,en:clean(title.en),ja:clean(title.ja),
      koSource:manual?'manual':ko&&['official','provider'].includes(title.koSource)?title.koSource:'',
      koCheckedAt:number(title.koCheckedAt),manual},
    explicitManualReset:raw.dinoResetManual===true,
    checkedAt:number(raw.checkedAt),attemptedAt:number(raw.attemptedAt),
    outcome:['verified','missing','error'].includes(raw.outcome)?raw.outcome:'',
    updatedAt:number(raw.updatedAt)};
}
function createStore({app,DatabaseSync}={}){
  let db=null,ready=false,problem='';
  function init(){
    if(ready)return true;
    if(problem)return false;
    try{
      const Driver=DatabaseSync||require('node:sqlite').DatabaseSync;
      if(typeof Driver!=='function')throw Error('node:sqlite not available');
      db=new Driver(path.join(app.getPath('userData'),FILE));
      db.exec('PRAGMA foreign_keys=ON');
      db.exec('PRAGMA busy_timeout=3000');
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA synchronous=NORMAL');
      const version=Number(db.prepare('PRAGMA user_version').get().user_version)||0;
      if(version>2)throw Error('newer SQLite schema: read-only fallback');
      db.exec('CREATE TABLE IF NOT EXISTS works(work_id TEXT PRIMARY KEY,names_json TEXT NOT NULL,title_ko TEXT NOT NULL,title_en TEXT NOT NULL,title_ja TEXT NOT NULL,ko_source TEXT NOT NULL,ko_checked_at INTEGER NOT NULL,manual INTEGER NOT NULL,checked_at INTEGER NOT NULL,attempted_at INTEGER NOT NULL,outcome TEXT NOT NULL,updated_at INTEGER NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS work_sources(provider TEXT NOT NULL,source_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES works(work_id),item_json TEXT NOT NULL,PRIMARY KEY(provider,source_id))');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dino_source_work ON work_sources(work_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dino_work_updated ON works(updated_at DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dino_work_ko ON works(title_ko)');
      db.exec('CREATE TABLE IF NOT EXISTS manual_pair_blocks(left_provider TEXT NOT NULL,left_id TEXT NOT NULL,right_provider TEXT NOT NULL,right_id TEXT NOT NULL,PRIMARY KEY(left_provider,left_id,right_provider,right_id))');
      if(version<2)db.exec('PRAGMA user_version=2');
      ready=true;return true;
    }catch(error){
      problem=String(error?.message||error).slice(0,250);
      try{db?.close()}catch{}
      db=null;return false;
    }
  }
  function status(){return {available:init(),schema:ready?2:0,reason:ready?'':problem,engine:'node:sqlite'};}
  function readRow(id){
    const row=db.prepare('SELECT * FROM works WHERE work_id=?').get(id);
    if(!row)return null;
    const sources=db.prepare('SELECT item_json FROM work_sources WHERE work_id=? ORDER BY provider').all(id)
      .map(x=>parse(x.item_json)).filter(Boolean);
    return {id, sources,names:parse(row.names_json)||[],
      titles:{ko:row.title_ko,en:row.title_en,ja:row.title_ja,koSource:row.ko_source,
        koCheckedAt:Number(row.ko_checked_at),manual:!!row.manual},
      checkedAt:Number(row.checked_at),attemptedAt:Number(row.attempted_at),
      outcome:row.outcome,updatedAt:Number(row.updated_at)};
  }
  function upsert(rows){
    if(!init())return {ok:false,reason:problem};
    if(!Array.isArray(rows)||rows.length>BATCH_LIMIT)return {ok:false,reason:'invalid batch'};
    const normalized=rows.map(normalize);
    if(normalized.some(x=>!x))return {ok:false,reason:'invalid row'};
    const sourceFind=db.prepare('SELECT work_id,item_json FROM work_sources WHERE provider=? AND source_id=?');
    const workFind=db.prepare('SELECT * FROM works WHERE work_id=?');
    const blockFind=db.prepare('SELECT 1 AS blocked FROM manual_pair_blocks WHERE left_provider=? AND left_id=? AND right_provider=? AND right_id=?');
    const members=db.prepare('SELECT provider,source_id,item_json FROM work_sources WHERE work_id=?');
    const putWork=db.prepare('INSERT INTO works(work_id,names_json,title_ko,title_en,title_ja,ko_source,ko_checked_at,manual,checked_at,attempted_at,outcome,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET names_json=excluded.names_json,title_ko=excluded.title_ko,title_en=excluded.title_en,title_ja=excluded.title_ja,ko_source=excluded.ko_source,ko_checked_at=excluded.ko_checked_at,manual=excluded.manual,checked_at=excluded.checked_at,attempted_at=excluded.attempted_at,outcome=excluded.outcome,updated_at=excluded.updated_at');
    const putSource=db.prepare('INSERT INTO work_sources(provider,source_id,work_id,item_json) VALUES(?,?,?,?) ON CONFLICT(provider,source_id) DO UPDATE SET item_json=excluded.item_json WHERE work_sources.work_id=excluded.work_id');
    try{
      db.exec('BEGIN IMMEDIATE');
      for(const work of normalized){
        // Never silently reassign a source URL/ID to a different season,
        // movie, or AniList identity. Nor merge two already distinct works.
        const knownIds=new Set();
        for(const src of work.sources){
          const known=sourceFind.get(src.provider,sourceKey(src));
          if(!known)continue;
          if(identityConflict(parse(known.item_json),src))
            throw Error('provider source identity conflicts with the stored work');
          knownIds.add(known.work_id);
        }
        if(knownIds.size>1)throw Error('conflicting existing work identities');
        const id=[...knownIds][0]||work.sources[0].provider+':'+sourceKey(work.sources[0]);
        const existing=members.all(id);
        // Exact ID ownership alone cannot prove a newly discovered supplier
        // belongs to this season. Validate it against all stored work members.
        for(let i=0;i<work.sources.length;i++){
          const src=work.sources[i];
          for(let j=0;j<i;j++)if(identityConflict(src,work.sources[j]))
            throw Error('incoming provider source identity conflicts with its work');
          for(const old of existing){
            const earlier=parse(old.item_json);
            if(identityConflict(earlier,src))
              throw Error('incoming provider source identity conflicts with the stored work');
            const pair=pairFields(src,{provider:old.provider,mal_id:old.source_id});
            if(pair&&blockFind.get(...pair))
              throw Error('manually separated provider sources cannot be auto-linked');
          }
        }
        const previous=workFind.get(id),titles={...work.titles};
        if(previous){
          const previousTime=Number(previous.ko_checked_at)||0;
          // Never roll back user-edited Korean titles through old cached data.
          if((previous.manual&&!titles.manual&&!work.explicitManualReset)
            ||(previous.manual&&titles.manual&&previousTime>titles.koCheckedAt)){
            titles.ko=previous.title_ko;titles.koSource='manual';
            titles.koCheckedAt=previousTime;titles.manual=true;
          }else if(!titles.ko&&previous.title_ko&&!work.explicitManualReset){
            titles.ko=previous.title_ko;titles.koSource=previous.ko_source;
            titles.koCheckedAt=previousTime;
          }
          // A verified Korean title outranks an unverified provider label.
          if(previous.ko_source==='official'&&!titles.manual
            &&(titles.koSource!=='official'
              ||previousTime>titles.koCheckedAt)){
            titles.ko=previous.title_ko;titles.koSource='official';
            titles.koCheckedAt=previousTime;
          }
          if(!titles.en)titles.en=previous.title_en;
          if(!titles.ja)titles.ja=previous.title_ja;
        }
        const names=[...new Set([...work.names,
          ...(previous?parse(previous.names_json)||[]:[]),titles.ko,titles.en,titles.ja]
          .map(clean).filter(Boolean))].slice(0,24);
        putWork.run(id,JSON.stringify(names),titles.ko,titles.en,titles.ja,
          titles.koSource,titles.koCheckedAt,Number(titles.manual),
          Math.max(work.checkedAt,Number(previous?.checked_at)||0),
          Math.max(work.attemptedAt,Number(previous?.attempted_at)||0),
          previous&&Number(previous.checked_at)>work.checkedAt?previous.outcome:work.outcome,
          Math.max(work.updatedAt,Number(previous?.updated_at)||0));
        for(const src of work.sources){
          const previousSource=sourceFind.get(src.provider,sourceKey(src));
          const earlier=previousSource?parse(previousSource.item_json):null;
          const incomingEpisode=src.dinoEpisode;
          const storedEpisode=earlier?.dinoEpisode;
          // Passive catalog cards do not include episode metadata. Preserve
          // the last verified snapshot across a legacy-cache migration or a
          // delayed provider search response.
          const older=Number(incomingEpisode?.attemptedAt)||0;
          const newer=Number(storedEpisode?.attemptedAt)||0;
          const selected=storedEpisode && newer>=older ? storedEpisode : incomingEpisode;
          // Passive cards omit episode/status fields; never erase richer details.
          const item={...(earlier||{}),...src};
          if(selected)item.dinoEpisode=selected;
          putSource.run(src.provider,sourceKey(src),id,JSON.stringify(item));
        }
      }
      db.exec('COMMIT');return {ok:true,saved:normalized.length};
    }catch(error){
      try{db.exec('ROLLBACK')}catch{}
      return {ok:false,reason:String(error?.message||error).slice(0,250)};
    }
  }
  function lookup(request){
    if(!init()||!object(request)||!PROVIDERS.has(request.provider))return null;
    const id=sourceKey(request);
    if(!id)return null;
    const found=db.prepare('SELECT work_id FROM work_sources WHERE provider=? AND source_id=?')
      .get(request.provider,id);
    return found?readRow(found.work_id):null;
  }
  function recent(request={}){
    if(!init())return [];
    const limit=Math.min(300,Math.max(1,number(request?.limit)||100));
    const offset=Math.min(200000,number(request?.offset));
    return db.prepare('SELECT work_id FROM works ORDER BY updated_at DESC,work_id LIMIT ? OFFSET ?')
      .all(limit,offset).map(x=>readRow(x.work_id)).filter(Boolean);
  }
  function stats(){
    if(!init())return {available:false,reason:problem};
    return {available:true,works:Number(db.prepare('SELECT COUNT(*) AS n FROM works').get().n),
      sources:db.prepare('SELECT provider,COUNT(*) AS n FROM work_sources GROUP BY provider').all()
        .map(x=>({provider:x.provider,count:Number(x.n)}))};
  }
  // Explicit user repair is transactional: never use the ordinary automatic
  // upsert to move a source between works.
  function repair(method,request){
    if(!init())return {ok:false,reason:problem};
    const anchor=request?.anchor,source=request?.source;
    if(!object(anchor)||!object(source)||!PROVIDERS.has(anchor.provider)
      ||!PROVIDERS.has(source.provider)||!sourceKey(anchor)||!sourceKey(source))
      return {ok:false,reason:'invalid source identity'};
    const find=db.prepare('SELECT work_id,item_json FROM work_sources WHERE provider=? AND source_id=?');
    const origin=find.get(anchor.provider,sourceKey(anchor));
    const moving=find.get(source.provider,sourceKey(source));
    if(!origin||!moving)return {ok:false,reason:'공급원을 먼저 검색하여 작품 DB에 저장해 주세요.'};
    const targetId=origin.work_id,sourceId=moving.work_id;
    if(anchor.provider===source.provider&&sourceKey(anchor)===sourceKey(source))
      return {ok:false,reason:'대표 공급원 자체는 이동할 수 없습니다.'};
    const primary=readRow(targetId),item=parse(moving.item_json);
    if(!primary||!item)return {ok:false,reason:'stored source is invalid'};
    if(method==='detach'&&targetId!==sourceId)
      return {ok:false,reason:'이 공급원은 이미 다른 작품으로 분리돼 있습니다.'};
    if(method==='detach'&&primary.sources.length<2)
      return {ok:false,reason:'마지막 공급원은 분리할 수 없습니다.'};
    if(method==='attach'&&targetId===sourceId)
      return {ok:true,unchanged:true,works:[primary],affected:[anchor,source]};
    if(method==='attach'&&primary.sources.some(existing=>existing.provider===source.provider))
      return {ok:false,reason:'이 작품에는 같은 공급원이 이미 연결돼 있습니다.'};
    if(method==='attach'&&primary.sources.some(existing=>identityConflict(existing,item)))
      return {ok:false,reason:'연도·형식·AniList ID가 달라 잘못된 시즌/극장판 연결을 차단했습니다.'};
    if(!['attach','detach'].includes(method))return {ok:false,reason:'unsupported repair'};
    const block=db.prepare('INSERT OR IGNORE INTO manual_pair_blocks(left_provider,left_id,right_provider,right_id) VALUES(?,?,?,?)');
    const unblock=db.prepare('DELETE FROM manual_pair_blocks WHERE left_provider=? AND left_id=? AND right_provider=? AND right_id=?');
    const mark=db.prepare("UPDATE works SET checked_at=0,attempted_at=0,outcome='',updated_at=? WHERE work_id=?");
    const now=Date.now();
    let destination=targetId;
    try{
      db.exec('BEGIN IMMEDIATE');
      if(method==='detach'){
        const base='manual:'+source.provider+':'+sourceKey(source);
        destination=base;
        let salt=0;
        const exists=db.prepare('SELECT 1 FROM works WHERE work_id=?');
        while(exists.get(destination))destination=base+':'+(++salt);
        if(salt>1000)throw Error('cannot allocate detached work identity');
        const ko=korean(item.displayTitle)||korean(item.title),en=clean(item.title_english)
          ||(!ko?clean(item.title):''),ja=clean(item.title_japanese||item.title_native);
        const names=[...new Set([ko,en,ja,clean(item.title),clean(item.displayTitle)].filter(Boolean))].slice(0,24);
        db.prepare('INSERT INTO works(work_id,names_json,title_ko,title_en,title_ja,ko_source,ko_checked_at,manual,checked_at,attempted_at,outcome,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(destination,JSON.stringify(names),ko,en,ja,ko?'provider':'',0,0,0,0,'',now);
        for(const previous of primary.sources){
          const pair=pairFields(previous,source);
          if(pair)block.run(...pair);
        }
      }else{
        const oldWork=readRow(sourceId);
        for(const previous of oldWork.sources){
          const pair=pairFields(previous,source);
          if(pair)block.run(...pair);
        }
        for(const next of primary.sources){
          const pair=pairFields(next,source);
          if(pair)unblock.run(...pair);
        }
      }
      db.prepare('UPDATE work_sources SET work_id=? WHERE provider=? AND source_id=?')
        .run(destination,source.provider,sourceKey(source));
      mark.run(now,targetId);
      if(method==='attach'){
        if(db.prepare('SELECT 1 FROM work_sources WHERE work_id=? LIMIT 1').get(sourceId))
          mark.run(now,sourceId);
        else db.prepare('DELETE FROM works WHERE work_id=?').run(sourceId);
      }
      db.exec('COMMIT');
      const works=[readRow(targetId),readRow(method==='detach'?destination:sourceId)].filter(Boolean);
      return {ok:true,works,affected:[anchor,source]};
    }catch(error){
      try{db.exec('ROLLBACK')}catch{}
      return {ok:false,reason:String(error?.message||error).slice(0,250)};
    }
  }
  function close(){if(db){db.close();db=null;ready=false;}}
  return {status,upsert,lookup,recent,stats,repair,close};
}
function register({app,ipcMain,DatabaseSync}={}){
  const store=createStore({app,DatabaseSync});
  ipcMain.handle('dino:work-index',(_event,method,payload)=>{
    switch(method){
      case 'status':return store.status();
      case 'upsert':return store.upsert(payload?.works);
      case 'lookup':return store.lookup(payload);
      case 'recent':return store.recent(payload);
      case 'stats':return store.stats();
      case 'attach':case 'detach':return store.repair(method,payload);
      default:return {ok:false,reason:'unknown method'};
    }
  });
  return store;
}
module.exports={createStore,register,normalize,FILE};
