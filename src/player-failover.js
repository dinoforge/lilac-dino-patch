(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.LilacPlayerFailover=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  const PROVIDERS=new Set(['reanime','animenosub','miruro']);
  const KINDS=new Set(['sub','soft','raw','dub']);
  const MAX_AUTO_SERVER_FALLBACKS=2;
  const safeLabel=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256?value.trim():'';
  const safeKind=value=>typeof value==='string'&&KINDS.has(value.toLowerCase())?value.toLowerCase():'';
  function labels(values){
    if(!Array.isArray(values))return [];
    return [...new Set(values.slice(0,32).map(safeLabel).filter(Boolean))];
  }
  function filterProviderServers(servers,{excludeVideoServers=[],onlyServerKind=''}={}){
    const excluded=new Set(labels(excludeVideoServers)),kind=safeKind(onlyServerKind);
    if(!Array.isArray(servers))return [];
    const seen=new Set();
    return servers.filter(server=>{
      const label=safeLabel(server?.label),serverKind=safeKind(server?.kind);
      if(!label||!serverKind||seen.has(label)||excluded.has(label)||kind&&serverKind!==kind)return false;
      seen.add(label);return true;
    }).slice(0,64);
  }
  function createPlan({provider,servers,currentServer,failedVideoServers=[],attemptCount=0,offline=false}={}){
    const attempts=Math.max(0,Math.min(MAX_AUTO_SERVER_FALLBACKS,Math.floor(Number(attemptCount)||0)));
    if(offline||!PROVIDERS.has(provider)||attempts>=MAX_AUTO_SERVER_FALLBACKS)return null;
    const currentLabel=safeLabel(currentServer),all=filterProviderServers(servers);
    const current=all.find(server=>safeLabel(server.label)===currentLabel);
    if(!current)return null;
    const failed=labels([...labels(failedVideoServers),currentLabel]);
    const candidates=filterProviderServers(all,{excludeVideoServers:failed,onlyServerKind:current.kind})
      .map(server=>safeLabel(server.label)).filter(Boolean).slice(0,MAX_AUTO_SERVER_FALLBACKS-attempts);
    if(!candidates.length)return null;
    return {kind:safeKind(current.kind),failedVideoServers:failed,candidates,nextAttempt:attempts+1};
  }
  function begin(context,plan,{resumeSeconds,resumeProgress}={}){
    if(!context||!plan?.candidates?.length||!safeKind(plan.kind))return null;
    const [serverOverride,...autoFallbackLabels]=plan.candidates.slice(0,MAX_AUTO_SERVER_FALLBACKS);
    const next={...context,serverOverride,serverOnly:true,onlyServerKind:safeKind(plan.kind),
      excludeVideoServers:labels(plan.failedVideoServers),failedVideoServers:labels(plan.failedVideoServers),
      autoFallbackLabels,autoFallbackCount:Math.min(MAX_AUTO_SERVER_FALLBACKS,Number(plan.nextAttempt)||1)};
    if(Number.isFinite(Number(resumeSeconds))&&Number(resumeSeconds)>0){
      next.resumeSeconds=Number(resumeSeconds);
      next.resumeProgress=Number.isFinite(Number(resumeProgress))?Math.max(0,Math.min(99.9,Number(resumeProgress))):Number(context.resumeProgress)||0;
      next.resumeMode='continue';
    }
    return next;
  }
  function advance(context){
    const attempts=Math.max(0,Math.min(MAX_AUTO_SERVER_FALLBACKS,Math.floor(Number(context?.autoFallbackCount)||0)));
    const queue=Array.isArray(context?.autoFallbackLabels)?context.autoFallbackLabels.map(safeLabel).filter(Boolean):[];
    if(attempts>=MAX_AUTO_SERVER_FALLBACKS||!queue.length)return null;
    const failed=labels([...(context.failedVideoServers||[]),...(context.excludeVideoServers||[]),context.serverOverride]);
    const serverOverride=queue[0];
    if(failed.includes(serverOverride))return null;
    return {...context,serverOverride,serverOnly:true,excludeVideoServers:failed,failedVideoServers:failed,
      autoFallbackLabels:queue.slice(1),autoFallbackCount:attempts+1};
  }
  return {MAX_AUTO_SERVER_FALLBACKS,filterProviderServers,createPlan,begin,advance};
});
