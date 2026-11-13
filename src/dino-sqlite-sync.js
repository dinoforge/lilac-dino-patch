(function(root){
  'use strict';
  // Optional bridge from legacy synchronous v1 work cache to the dedicated
  // SQLite main-process store. Never clears/renames localStorage or original
  // LilacAnime Korean title files. Works without IPC on older installations.
  function connect(index,invoke,{delay=(fn,ms)=>setTimeout(fn,ms)}={}){
    let active=false,phase='legacy',reason='',timer=null,flushing=null,started=null;
    const pending=new Map();
    const key=row=>String(row?.sources?.[0]?.provider||'')+':'+String(row?.sources?.[0]?.mal_id||'');
    const safeInvoke=async(method,payload)=>invoke(method,payload);
    const report=()=>({active,phase,reason,pending:pending.size});
    async function send(rows){
      for(let i=0;i<rows.length;i+=36){
        const part=rows.slice(i,i+36);
        const result=await safeInvoke('upsert',{works:part});
        if(!result?.ok||result.saved!==part.length)
          throw Error(String(result?.reason||'SQLite batch confirmation missing'));
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
          if(Array.isArray(recent)&&recent.length)index.importRows(recent);
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
      if(cached?.fresh)return cached;
      try{
        const work=await safeInvoke('lookup',{provider:anchor.provider,mal_id:anchor.mal_id,id:anchor.id});
        if(work?.sources?.length)index.importRows([work]);
      }catch{ /* SQLite outages never break original provider detail flow */ }
      return index.find(anchor);
    }
    async function stats(){
      await start();
      return active?await safeInvoke('stats').catch(()=>({available:false})):
        {available:false,reason};
    }
    return {start,ensure,flush,stats,report,isReady:()=>active};
  }
  const api={connect};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.DinoSqliteSync=api;
})(typeof window!=='undefined'?window:globalThis);
