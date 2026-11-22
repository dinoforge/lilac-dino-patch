(function(root){
  'use strict';
  // Optional bridge from legacy synchronous v1 work cache to the dedicated
  // SQLite main-process store. Never clears/renames localStorage or original
  // LilacAnime Korean title files. Works without IPC on older installations.
  function connect(index,invoke,{delay=(fn,ms)=>setTimeout(fn,ms)}={}){
    let active=false,phase='legacy',reason='',timer=null,flushing=null,started=null;
    const pending=new Map(), hydrated=new Set();
    const sourceId=item=>String(item?.provider||'')+':'+String(item?.mal_id
      ??(item?.provider&&item?.id!=null?item.provider+':'+item.id:''));
    const key=row=>sourceId(row?.sources?.[0]);
    const markHydrated=row=>{
      for(const item of row?.sources||[])if(item?.provider)hydrated.add(sourceId(item));
      if(hydrated.size>1200)hydrated.clear();
    };
    const safeInvoke=async(method,payload)=>invoke(method,payload);
    let skippedConflicts=0;
    // Old v1 cards may contain a now-invalid cross-season match or two links
    // for the same supplier. Reject that row, not the entire SQLite backend.
    const staleConflict=value=>/conflicting existing work identities|manually separated provider sources|provider source identity conflicts|invalid row/.test(String(value||''));
    const report=()=>({active,phase,reason,pending:pending.size,skippedConflicts});
    async function send(rows){
      for(let i=0;i<rows.length;i+=36){
        const part=rows.slice(i,i+36);
        const result=await safeInvoke('upsert',{works:part});
        if(result?.ok&&result.saved===part.length)continue;
        // A legacy cache can still contain a group the user manually split.
        // Keep SQLite available and preserve the user-chosen ownership.
        if(!staleConflict(result?.reason))
          throw Error(String(result?.reason||'SQLite batch confirmation missing'));
        for(const row of part){
          const single=await safeInvoke('upsert',{works:[row]});
          if(single?.ok&&single.saved===1)continue;
          if(!staleConflict(single?.reason))
            throw Error(String(single?.reason||'SQLite write failed'));
          skippedConflicts++;
        }
      }
    }
    function schedule(){
      if(!active||timer!==null)return;
      timer=delay(()=>{timer=null;flush().catch(()=>{});},750);
    }
    async function flush(){
      if(!active)return false;
      if(flushing)return flushing;
      flushing=(async()=>{
        try{
          while(pending.size){
            const values=[...pending.entries()].slice(0,36);
            await send(values.map(([,row])=>row));
            for(const [id,original] of values)
              if(pending.get(id)===original)pending.delete(id);
          }
          phase='ready';reason='';
          return true;
        }catch(error){
          phase='write-failed';
          reason=String(error?.message||error).slice(0,200);
          return false;
        }
      })();
      try{return await flushing}finally{flushing=null;}
    }
    const initialRows=index.exportRows();
    index.setPersistenceHook(row=>{
      if(!row?.sources?.length)return;
      pending.set(key(row),row);
      schedule();
    });
    async function start(){
      if(started)return started;
      started=(async()=>{
        if(typeof invoke!=='function'){phase='legacy';return false;}
        phase='checking';
        try{
          const status=await safeInvoke('status');
          if(!status?.available){phase='legacy';reason=String(status?.reason||'SQLite unavailable');return false;}
          // V1 remains intact. The SQLite transaction must acknowledge EVERY
          // imported batch before the store becomes authoritative for reads.
          phase='migrating';
          await send(initialRows);
          active=true;
          // Recent SQLite rows hydrate the synchronous cache. Older works
          // are fetched by exact supplier ID on demand, never all at startup.
          const recent=await safeInvoke('recent',{limit:180});
          // The database is authoritative after explicit detach/attach.
          // An old merged memory group must never swallow separate works.
          if(Array.isArray(recent)&&recent.length) {
            index.replaceRows(recent,[],{persist:false});
            for(const row of recent)markHydrated(row);
          }
          phase='ready';
          if(pending.size)schedule();
          return true;
        }catch(error){
          active=false;phase='legacy';
          reason=String(error?.message||error).slice(0,200);
          return false;
        }
      })();
      return started;
    }
    async function ensure(anchor){
      await start();
      if(!active||!anchor?.provider)return index.find(anchor);
      const cached=index.find(anchor);
      const id=String(anchor.mal_id??(anchor.id!=null?anchor.provider+':'+anchor.id:''));
      // Fuzzy title matching is not proof of exact supplier ownership.
      // The hot localStorage cache can be older than SQLite (especially
      // beyond the 180-work startup page). Hydrate each exact source once
      // before trusting a fresh local cache or a prior manual split.
      const identity=sourceId({provider:anchor.provider,mal_id:id});
      // Even a hydrated cache must flush new manual edits before navigating
      // away from the detail view or another source card.
      if(pending.size && !await flush())return index.find(anchor);
      if(hydrated.has(identity)&&cached?.sources?.some(item=>item.provider===anchor.provider
        && String(item.mal_id)===id))return cached;
      try{
        const work=await safeInvoke('lookup',{provider:anchor.provider,mal_id:anchor.mal_id,id:anchor.id});
        if(work?.sources?.length) {
          // SQLite owns the exact source split/attach mapping. Do not heuristically
          // add stale legacy sources to the authoritative work on hydration.
          index.replaceRows([work],[anchor],{persist:false});
          markHydrated(work);
        }else hydrated.add(identity);
      }catch{ /* SQLite outages never break original provider detail flow */ }
      return index.find(anchor);
    }
    async function stats(){
      await start();
      return active?await safeInvoke('stats').catch(()=>({available:false})):
        {available:false,reason};
    }
    async function diagnostic(method,payload=null){
      await start();
      if(!active)return method==='search'||method==='titleHistory'||method==='linkHistory'
        ?[]:{available:false,reason};
      const result=await safeInvoke(method,payload).catch(error=>({
        ok:false,available:false,reason:String(error?.message||error).slice(0,180)
      }));
      return result;
    }
    async function backup(){
      await start();
      if(!active)return {ok:false,reason:reason||'SQLite DB를 사용할 수 없습니다.'};
      // A snapshot must contain pending title and manual-link changes.
      if(!await flush())return {ok:false,reason:'저장 대기 중인 변경사항이 있어 백업을 중단했습니다.'};
      try{return await safeInvoke('snapshot')||{ok:false,reason:'백업 확인 없음'};}
      catch(error){return {ok:false,reason:String(error?.message||error).slice(0,180)};}
    }
    async function repair(method,anchor,source){
      await start();
      if(!active)return {ok:false,reason:'SQLite 작품 DB를 사용할 수 없습니다.'};
      // Flush all pending observations before re-parenting source identities.
      if(!await flush())return {ok:false,reason:'저장되지 않은 작품 정보가 있어 연결 수정을 중단했습니다.'};
      if(!['attach','detach'].includes(method))return {ok:false,reason:'invalid repair action'};
      try{
        const result=await safeInvoke(method,{anchor,source});
        if(!result?.ok)return result||{ok:false,reason:'SQLite repair failed'};
        const cacheUpdated=index.replaceRows(result.works,result.affected);
        return {...result,cacheUpdated};
      }catch(error){return {ok:false,reason:String(error?.message||error).slice(0,200)};}
    }
    return {start,ensure,flush,stats,backup,repair,diagnostic,report,isReady:()=>active};
  }
  const api={connect};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.DinoSqliteSync=api;
})(typeof window!=='undefined'?window:globalThis);
