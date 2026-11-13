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
const parse=x=>{try{return JSON.parse(x)}catch{return null}};
function normalize(raw){
  if(!object(raw)||!Array.isArray(raw.sources)||!raw.sources.length||raw.sources.length>8
    || JSON.stringify(raw).length>40000)return null;
  const sources=[],seen=new Set();
  for(const src of raw.sources){
    if(!object(src)||!PROVIDERS.has(src.provider)||JSON.stringify(src).length>16000)continue;
    const id=sourceKey(src),key=src.provider+':'+id;
    if(!id||seen.has(key))continue;
    seen.add(key);sources.push({...src,mal_id:id});
  }
  if(!sources.length)return null;
  const title=object(raw.titles)?raw.titles:{};
  const ko=korean(title.ko),manual=title.manual===true&&!!ko;
  return {sources,
    names:[...new Set((Array.isArray(raw.names)?raw.names:[]).map(clean).filter(Boolean))].slice(0,24),
    titles:{ko,en:clean(title.en),ja:clean(title.ja),
      koSource:manual?'manual':ko&&['official','provider'].includes(title.koSource)?title.koSource:'',
      koCheckedAt:number(title.koCheckedAt),manual},
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
      if(version>1)throw Error('newer SQLite schema: read-only fallback');
      db.exec('CREATE TABLE IF NOT EXISTS works(work_id TEXT PRIMARY KEY,names_json TEXT NOT NULL,title_ko TEXT NOT NULL,title_en TEXT NOT NULL,title_ja TEXT NOT NULL,ko_source TEXT NOT NULL,ko_checked_at INTEGER NOT NULL,manual INTEGER NOT NULL,checked_at INTEGER NOT NULL,attempted_at INTEGER NOT NULL,outcome TEXT NOT NULL,updated_at INTEGER NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS work_sources(provider TEXT NOT NULL,source_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES works(work_id),item_json TEXT NOT NULL,PRIMARY KEY(provider,source_id))');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dino_source_work ON work_sources(work_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dino_work_updated ON works(updated_at DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_dino_work_ko ON works(title_ko)');
      if(!version)db.exec('PRAGMA user_version=1');
      ready=true;return true;
    }catch(error){
      problem=String(error?.message||error).slice(0,250);
      try{db?.close()}catch{}
      db=null;return false;
    }
  }
  function status(){return {available:init(),schema:ready?1:0,reason:ready?'':problem,engine:'node:sqlite'};}
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
    const sourceFind=db.prepare('SELECT work_id FROM work_sources WHERE provider=? AND source_id=?');
    const workFind=db.prepare('SELECT * FROM works WHERE work_id=?');
    const putWork=db.prepare('INSERT INTO works(work_id,names_json,title_ko,title_en,title_ja,ko_source,ko_checked_at,manual,checked_at,attempted_at,outcome,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET names_json=excluded.names_json,title_ko=excluded.title_ko,title_en=excluded.title_en,title_ja=excluded.title_ja,ko_source=excluded.ko_source,ko_checked_at=excluded.ko_checked_at,manual=excluded.manual,checked_at=excluded.checked_at,attempted_at=excluded.attempted_at,outcome=excluded.outcome,updated_at=excluded.updated_at');
    const putSource=db.prepare('INSERT INTO work_sources(provider,source_id,work_id,item_json) VALUES(?,?,?,?) ON CONFLICT(provider,source_id) DO UPDATE SET item_json=excluded.item_json WHERE work_sources.work_id=excluded.work_id');
    try{
      db.exec('BEGIN IMMEDIATE');
      for(const work of normalized){
        let id='';
        for(const src of work.sources){
          const known=sourceFind.get(src.provider,sourceKey(src));
          if(known){id=known.work_id;break;}
        }
        if(!id)id=work.sources[0].provider+':'+sourceKey(work.sources[0]);
        const previous=workFind.get(id),titles={...work.titles};
        if(previous){
          const previousTime=Number(previous.ko_checked_at)||0;
          // Never roll back user-edited Korean titles through old cached data.
          if((previous.manual&&!titles.manual)
            ||(previous.manual&&titles.manual&&previousTime>titles.koCheckedAt)){
            titles.ko=previous.title_ko;titles.koSource='manual';
            titles.koCheckedAt=previousTime;titles.manual=true;
          }else if(!titles.ko&&previous.title_ko){
            titles.ko=previous.title_ko;titles.koSource=previous.ko_source;
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
        for(const src of work.sources)putSource.run(src.provider,sourceKey(src),id,JSON.stringify(src));
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
  function close(){if(db){db.close();db=null;ready=false;}}
  return {status,upsert,lookup,recent,stats,close};
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
      default:return {ok:false,reason:'unknown method'};
    }
  });
  return store;
}
module.exports={createStore,register,normalize,FILE};
