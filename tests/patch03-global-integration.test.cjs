'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = require('../src/integrated-search.js');
const bridge = fs.readFileSync(path.join(__dirname, '../patches/patch03/patch03-bridge.js'), 'utf8');

class Elements {
  constructor(name='div') {
    this.name=name; this.children=[]; this.parentElement=null; this.dataset={};
    this.attributes=new Map(); this.listeners=new Map(); this.textContent='';
    this.value=''; this.open=false; this.isConnected=true; this.className='';
    const classes=new Set();
    this.classList={
      add:value=>classes.add(value),remove:value=>classes.delete(value),
      contains:value=>classes.has(value),
      toggle:(value,force)=>{const on=force===undefined?!classes.has(value):!!force; if(on)classes.add(value);else classes.delete(value);return on;}
    };
  }
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  addEventListener(name,fn){this.listeners.set(name,fn);}
  send(name){this.listeners.get(name)?.({target:this});}
  append(...items){for(const x of items){x.parentElement=this;this.children.push(x);}}
  replaceChildren(...items){for(const old of this.children)old.parentElement=null;this.children=[];this.append(...items);}
  before(item){if(!this.parentElement)return;const list=this.parentElement.children;item.parentElement=this.parentElement;list.splice(list.indexOf(this),0,item);}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(i=>i!==this);this.parentElement=null;this.isConnected=false;}
  insertAdjacentElement(_position,item){this.append(item);}
  querySelectorAll(selector){
    const matching = element => {
      if(selector==='.detail-source-picker'||selector==='.detail-actions'||selector==='.detail-meta'||selector==='.dino-source-track')
        return element.className.split(' ').includes(selector.slice(1));
      if(selector==='[data-provider-source]')
        return element.dataset.providerSource!==undefined;
      if(selector==='button')return element.name==='button';
      if(selector==='.detail-source-picker button')return element.name==='button'&&element.dataset.providerSource!==undefined;
      return false;
    };
    const out=[];
    const visit = root=>{for(const child of root.children){if(matching(child))out.push(child);visit(child);}};
    visit(this);return out;
  }
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}

function harness({ integrated=true, firstReturnsUnrelated=false, persistedStorage=null, catalogState=null, catalogItems=[] }={}) {
  const nodes=new Map();
  const element=(id,name='div')=>{const node=new Elements(name);nodes.set('#'+id,node);return node;};
  const sourceSelect=element('contentSource','select');
  element('sourceChoices');
  const detail=element('detailContent');
  const meta=new Elements();meta.className='detail-meta';
  const actions=new Elements();actions.className='detail-actions';detail.append(meta,actions);
  element('detailDialog').open=true;
  const searchView=element('searchView');
  const status=element('searchStatus'); element('searchGrid');
  const playbackStatus=element('downloadStatus');
  element('pageSearch');element('globalSearch');
  const video=element('video','video');
  const psQuality=element('psQuality');psQuality.classList.add('hidden');
  const psQualityList=element('psQualityList');
  const events=new Map(), scheduled=[];
  const document={
    querySelector:selector=>nodes.get(selector)||null,
    createElement:name=>new Elements(name),
    addEventListener:(name,fn)=>{const previous=events.get(name);events.set(name,previous?()=>{previous();fn()}:fn);}
  };
  const storage=persistedStorage||new Map([['contentSource','reanime']]);
  if(integrated)storage.set('lilacDinoPatch.searchMode','integrated');
  const localStorage={
    getItem:key=>storage.get(key)??null,
    setItem:(key,value)=>storage.set(key,String(value)),
    removeItem:key=>storage.delete(key)
  };
  const home={
    provider:'reanime',id:'home-show',mal_id:'reanime:home-show',
    anilistId:77701,malId:87001,title:'일본어 한글 제목',title_english:'English Work',
    title_japanese:'日本語のタイトル',displayTitle:'일본어 한글 제목',year:2026,type:'TV'
  };
  const other={...home,provider:'miruro',id:'miruro-show',mal_id:'miruro:miruro-show',title:'English Work'};
  const unrelated={...home,provider:'miruro',id:'unrelated',mal_id:'miruro:unrelated',
    anilistId:77702,malId:87002,title:'다른 작품',title_english:'Other Work'};
  const known=new Map([[home.mal_id,home]]);
  const calls={search:[],detail:[],local:[],render:[]};
  const window={
    LilacIntegratedSearch:api,
    animeById:id=>known.get(String(id)),
    rememberAnime:item=>known.set(String(item.mal_id),item),
    titleOf:item=>item.displayTitle||item.title,
    doSearch:async()=>{},
    openDetail:async id=>{calls.detail.push(String(id));return id;},
    switchView:view=>searchView.classList.toggle('active',view==='search'),
    showHomeList:()=>{},
    syncSettingChoices:()=>{},
    renderCards:(target,items)=>calls.render.push({target,items}),
    cancelPendingPlaybackLookups:()=>{},saveRecentSearch:()=>{},
    lilac:{
      providerCatalog:async(provider,query,offset=0,sort='')=>{
        calls.search.push({provider,query,offset,sort});
        if(provider==='reanime' && !query && sort==='popular')
          return {data:catalogItems.slice(Number(offset)||0,(Number(offset)||0)+36),
            offset:Number(offset)||0,total:catalogItems.length,done:(Number(offset)||0)+36>=catalogItems.length};
        if(provider==='miruro'){
          if(firstReturnsUnrelated&&query==='English Work')return {data:[unrelated]};
          if(query==='English Work'||query==='Alternate Title')return {data:[other]};
        }
        if(provider==='reanime'&&query==='일본어 한글 제목')return {data:[home]};
        return {data:[]};
      },
      catalogKoreanSearch:async(provider,query)=>{calls.local.push({provider,query});return provider==='reanime'?[home]:[];},
      titleVariants:async()=>firstReturnsUnrelated?['Alternate Title']:['English Work'],
      providerDetail:async item=>({data:item,episodes:Array.from({length:item.provider==='miruro'?10:12},(_,i)=>({number:i+1}))}),
      providerResolve:async episode=>episode
    }
  };
  if(catalogState) window.lilac.catalogIndexState=async()=>catalogState;
  const sandbox=vm.createContext({window,document,localStorage,
    setTimeout:(fn,delay)=>{fn.__testDelay=delay;scheduled.push(fn);return scheduled.length;},console});
  vm.runInContext(bridge,sandbox,{filename:'patch03-bridge.js'});
  assert.equal(window.__dinoPatch03Bridge?.active,true);
  return {window,document,storage,nodes,calls,events,home,other,unrelated,video,psQuality,psQualityList,sandbox,status,sourceSelect,playbackStatus,scheduled};
}
const buttons=app=>app.nodes.get('#detailContent').querySelector('.detail-source-picker')?.querySelectorAll('[data-provider-source]')||[];
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('integrated settings apply to home cards and resolve all matching provider sources',async()=>{
  const app=harness();
  assert.equal(app.nodes.get('#searchView').classList.contains('active'),false);
  await app.window.openDetail(app.home.mal_id);
  await settle();await settle();
  const sources=buttons(app);
  assert.equal(sources.length,2);
  assert.deepEqual(sources.map(x=>x.dataset.providerSource).sort(),['miruro:miruro-show','reanime:home-show']);
  assert.ok(!app.calls.search.some(x=>x.provider==='reanime'),
    'the already selected provider must not be queried again to verify its own card');
  assert.ok(app.calls.search.some(x=>x.provider==='miruro'&&x.query==='English Work'));
  assert.ok(sources.some(x=>x.textContent.includes('12화')));
  assert.ok(sources.some(x=>x.textContent.includes('10화')));
  assert.ok(sources.every(x=>x.textContent.includes('화질 미확인')));
  sources.find(x=>x.dataset.providerSource==='miruro:miruro-show').send('click');
  await settle();
  assert.equal(app.calls.detail.at(-1),'miruro:miruro-show');
});
test('a provider with unrelated successful hits is retried by alternate title',async()=>{
  const app=harness({firstReturnsUnrelated:true});
  await app.window.openDetail(app.home.mal_id);
  assert.deepEqual(buttons(app).map(x=>x.dataset.providerSource).sort(),['miruro:miruro-show','reanime:home-show']);
  assert.ok(app.calls.search.some(x=>x.provider==='miruro'&&x.query==='Alternate Title'));
  assert.ok(!buttons(app).some(x=>x.dataset.providerSource==='miruro:unrelated'));
});
test('an individual provider mode delegates without any integrated probing',async()=>{
  const app=harness({integrated:false});
  await app.window.openDetail(app.home.mal_id);
  assert.deepEqual(app.calls.detail,['reanime:home-show']);
  assert.deepEqual(app.calls.search,[]);
  assert.equal(buttons(app).length,0);
});
test('fixed quality displays measured decoded video pixels and never invents 1080p from catalog',async()=>{
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  assert.ok(buttons(app).every(x=>x.textContent.includes('화질 미확인')));
  app.sandbox.currentPlaybackContext={episode:{provider:'reanime'},anime:{mal_id:app.home.mal_id}};
  app.video.videoWidth=1920;app.video.videoHeight=1080;
  app.events.get('DOMContentLoaded')();
  app.video.send('loadedmetadata');
  assert.equal(app.psQuality.classList.contains('hidden'),false);
  assert.match(app.psQualityList.children[0].textContent,/1920×1080/);
  await app.window.openDetail(app.home.mal_id);
  assert.ok(buttons(app).some(x=>x.textContent.includes('재생 1080p')));
});

test('a missing supplier can be retried explicitly without changing the global integrated preference', async () => {
  const app=harness();
  const original=app.window.lilac.providerCatalog;
  let miruroChecks=0;
  app.window.lilac.providerCatalog=async(provider,query)=>{
    if(provider==='miruro' && query==='English Work'){
      miruroChecks++;
      if(miruroChecks===1)return {data:[]};
    }
    return original(provider,query);
  };
  await app.window.openDetail(app.home.mal_id);
  assert.equal(buttons(app).length,1);
  const section=app.nodes.get('#detailContent').querySelector('.detail-source-picker');
  const retry=section.children.find(item=>item.className==='dino-source-retry');
  assert.ok(retry, 'an unmatched source should be recoverable through a manual retry');
  retry.send('click');
  await settle();
  await settle();
  assert.equal(buttons(app).length,2);
  assert.equal(app.storage.get('lilacDinoPatch.searchMode'),'integrated');
  assert.ok(miruroChecks>=2);
});

test('translated aliases recover ID-less providers only for the same season and year', async () => {
  const makeCandidate = year => {
    const app=harness();
    const candidate={...app.other,anilistId:undefined,malId:undefined,
      title:'Alternate Title',title_english:'Alternate Title',year};
    app.window.lilac.titleVariants=async()=>['Alternate Title'];
    app.window.lilac.providerCatalog=async(provider,query)=>
      provider==='miruro'&&query==='Alternate Title'?{data:[candidate]}:{data:[]};
    return app;
  };
  const same=makeCandidate(2026);
  await same.window.openDetail(same.home.mal_id);
  assert.equal(buttons(same).length,2);
  const different=makeCandidate(2025);
  await different.window.openDetail(different.home.mal_id);
  assert.equal(buttons(different).length,1,'an alternate title must not override a conflicting release year');
});


test('integrated picker keeps providers on one horizontally scrollable row and preserves scroll during updates',async()=>{
  const style=fs.readFileSync(path.join(__dirname,'../src/integrated-search.css'),'utf8');
  assert.match(style,/\.detail-source-picker \.dino-source-track\s*\{[^}]*display:flex;[^}]*flex-wrap:nowrap;[^}]*overflow-x:auto;/s);
  assert.match(style,/\.dino-source-option\s*\{[^}]*flex:0 0 218px;/s);
  assert.doesNotMatch(style,/grid-template-columns:repeat\(auto-fit/);
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  await settle();await settle();
  const picker=app.nodes.get('#detailContent').querySelector('.detail-source-picker');
  const rail=picker.querySelector('.dino-source-track');
  assert.ok(rail,'source tabs must render in one horizontal scroll track');
  assert.equal(buttons(app).length,2);
  assert.ok(buttons(app).every(button=>button.textContent.includes("\n")),'source labels use compact two-line tabs');
  rail.scrollLeft=113;
  await app.window.openDetail(app.home.mal_id);
  assert.equal(app.nodes.get('#detailContent').querySelector('.dino-source-track').scrollLeft,113);
});

test('a paginated provider search finds the second page and keeps first-page hits on a later failure', async()=>{
  const requests=[];
  const paged=await api.searchProviders({
    providers:['miruro'],query:'English Work',maxPages:2,
    search:async(_provider,_query,cursor)=>{
      requests.push(cursor);
      return cursor===null
        ? {data:[{provider:'miruro',mal_id:'miruro:other',title:'Other'}],nextOffset:'second',done:false}
        : {data:[{provider:'miruro',mal_id:'miruro:found',title:'English Work'}],done:true};
    }
  });
  assert.deepEqual(requests,[null,'second']);
  assert.equal(paged.items.length,2);
  assert.equal(paged.statuses[0].pages,2);
  assert.equal(paged.statuses[0].pageLimitReached,false);
  const partial=await api.searchProviders({
    providers:['miruro'],query:'English Work',maxPages:2,
    search:async(_provider,_query,cursor)=>{
      if(cursor!==null)throw Error('second page unavailable');
      return {data:[{provider:'miruro',mal_id:'miruro:kept'}],nextOffset:'second'};
    }
  });
  assert.equal(partial.statuses[0].state,'partial');
  assert.equal(partial.items.length,1);
});

test('global detail discovery finds a verified match beyond the first provider page',async()=>{
  const app=harness();
  const catalog=app.window.lilac.providerCatalog;
  app.window.lilac.providerCatalog=async(provider,query,offset)=>{
    if(provider==='miruro'&&query==='English Work')
      return offset==='next' ? {data:[app.other],done:true}
        : {data:[app.unrelated],nextOffset:'next',done:false};
    return catalog(provider,query,offset);
  };
  await app.window.openDetail(app.home.mal_id);
  assert.equal(buttons(app).length,2);
  assert.ok(!buttons(app).some(button=>button.dataset.providerSource==='miruro:unrelated'));
  assert.equal(app.window.__dinoPatch03Bridge.getDetailSnapshot(app.home.mal_id).length,2);
});

test('verified episode comparison reports the latest supplier and the count gap',async()=>{
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  await settle();await settle();
  const values=buttons(app).map(button=>button.textContent);
  assert.ok(values.some(value=>value.includes('RE:Anime')&&value.includes('최신화')));
  assert.ok(values.some(value=>value.includes('Miruro')&&value.includes('2화 차이')));
});

test('quality announced by a provider is labeled as reported, not measured',async()=>{
  const app=harness();
  app.window.lilac.providerDetail=async item=>({
    data:{...item,quality:item.provider==='miruro'?'720p':undefined},
    episodes:Array.from({length:8},(_,i)=>({provider:item.provider,number:i+1}))
  });
  await app.window.openDetail(app.home.mal_id);
  await settle();await settle();
  const miruro=buttons(app).find(button=>button.dataset.providerSource===app.other.mal_id);
  assert.match(miruro.textContent,/표기 720p/);
  assert.doesNotMatch(miruro.textContent,/재생 720p/);
});

test('integrated search distinguishes verified missing results from provider failure',async()=>{
  const app=harness();
  const search=app.window.lilac.providerCatalog;
  app.window.lilac.providerCatalog=(provider,query,offset)=>
    provider==='miruro'?Promise.reject(Error('source offline')):search(provider,query,offset);
  await app.window.doSearch('absent work');
  const diagnostics=app.window.__dinoPatch03Bridge.getSearchDiagnostics();
  assert.equal(diagnostics.find(s=>s.provider==='miruro').state,'failed');
  assert.equal(diagnostics.find(s=>s.provider==='linkani').state,'ready');
  assert.equal(diagnostics.find(s=>s.provider==='linkani').results,0);
  assert.match(app.status.textContent,/응답 오류/);
  assert.match(app.status.textContent,/미발견/);
});

test('terminal playback error offers a verified same-episode alternative and preserves position',async()=>{
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  app.sandbox.currentPlaybackContext={
    anime:app.home,episode:{provider:'reanime',number:7,id:'ep-7'},
    subtitleTitle:'English Work',resolving:false
  };
  let switched=null;
  app.sandbox.resolveIntoPlayer=async(_resolver,title,context,subtitleTitle,number)=>{
    switched={title,context,subtitleTitle,number};
  };
  app.video.currentTime=123;
  app.video.duration=1200;
  app.events.get('DOMContentLoaded')();
  app.video.send('timeupdate');
  app.video.send('error');
  await settle();await settle();
  const button=app.playbackStatus.children.find(el=>el.id==='dinoPlaybackAlternate');
  assert.ok(button,'same-episode fallback offered after terminal playback error');
  button.send('click');
  await settle();await settle();
  assert.ok(switched);
  assert.equal(switched.context.episode.provider,'miruro');
  assert.equal(switched.context.episode.number,7);
  assert.equal(switched.context.resumeSeconds,123);
  assert.equal(switched.context.anime.mal_id,app.other.mal_id);
});


test('a verified source mapping survives restart and does not search five sites again',async()=>{
  const persistedStorage=new Map([['contentSource','reanime']]);
  const first=harness({persistedStorage});
  await first.window.openDetail(first.home.mal_id);
  await settle();await settle();
  assert.equal(buttons(first).length,2);
  first.window.__dinoPatch03Bridge.flushWorkIndex();
  assert.ok(persistedStorage.has(api.WORK_INDEX_KEY));
  const second=harness({persistedStorage});
  await second.window.openDetail(second.home.mal_id);
  await settle();await settle();
  assert.equal(buttons(second).length,2);
  assert.equal(second.calls.search.length,0,'fresh local work index must avoid remote providerCatalog requests');
  assert.equal(second.window.__dinoPatch03Bridge.getWorkIndexStats().works,1);
});

test('original Korean-title resolver aliases are reused for missing suppliers',async()=>{
  const app=harness();
  app.home.title_english='';
  app.window.lilac.titleVariants=async()=>[];
  let titleCalls=0;
  app.window.lilac.resolveTitles=async()=>{titleCalls++;return [{ko:'원본 한국어 제목',en:'English Work'}];};
  await app.window.openDetail(app.home.mal_id);
  assert.equal(titleCalls,1);
  assert.ok(app.calls.search.some(x=>x.provider==='miruro'&&x.query==='English Work'));
  assert.equal(buttons(app).length,2);
  assert.ok(app.window.__dinoPatch03Bridge.getWorkIndexStats().works>=1);
});

test('integrated exact-query results are read from local DB without repeat catalog calls',async()=>{
  const persistedStorage=new Map([['contentSource','reanime']]);
  const first=harness({persistedStorage});
  await first.window.doSearch('일본어 한글 제목');
  first.window.__dinoPatch03Bridge.flushWorkIndex();
  const second=harness({persistedStorage});
  await second.window.doSearch('일본어 한글 제목');
  assert.equal(second.calls.search.length,0);
  assert.ok(second.calls.render.length>0);
  assert.match(second.status.textContent,/로컬 DB 결과/);
});


test('original home rails enqueue background verified source mappings without opening any detail', async () => {
  const persistedStorage=new Map([['contentSource','reanime']]);
  const app=harness({persistedStorage});
  app.nodes.get('#detailDialog').open=false;
  app.window.renderCards('#seasonRail',[app.home,app.home]);
  assert.equal(app.calls.search.length,0,'rendering does not synchronously call providers');
  assert.equal(app.window.__dinoPatch03Bridge.getPrefetchStatus().queued,1,'repeat cards are deduplicated');
  assert.equal(app.scheduled.length,1,'only one delayed background pass is scheduled');
  app.scheduled.shift()();
  for(let i=0;i<12;i++)await settle();
  assert.ok(app.calls.search.some(request=>request.provider==='miruro'&&request.query==='English Work'));
  assert.equal(app.window.__dinoPatch03Bridge.getPrefetchStatus().startedThisSession,1);
  app.window.__dinoPatch03Bridge.flushWorkIndex();
  assert.ok(persistedStorage.has(api.WORK_INDEX_KEY),'verified source mapping persisted');
  const second=harness({persistedStorage});
  await second.window.openDetail(second.home.mal_id);
  // Background mode deliberately caches an incomplete discovery as an
  // error (3-day cooldown), not a seven-day verified absence. An explicit
  // foreground detail visit can fill the missing sources after a restart.
  assert.ok(second.calls.search.length>0,'foreground detail can complete a limited background pass');
  assert.ok(!second.calls.search.some(request=>request.provider==='reanime'),
    'the already indexed anchor provider is never re-queried');
  assert.equal(buttons(second).length,2);
});

test('background source indexing pauses for detail playback and ignores non-integrated mode',async()=>{
  const app=harness();
  app.window.renderCards('#airingRail',[app.home]);
  assert.equal(app.window.__dinoPatch03Bridge.getPrefetchStatus().queued,1);
  app.scheduled.shift()();
  await settle();
  assert.equal(app.calls.search.length,0,'detail modal takes priority over background prefetch');
  assert.equal(app.window.__dinoPatch03Bridge.getPrefetchStatus().queued,1);
  app.nodes.get('#detailDialog').open=false;
  assert.equal(app.scheduled.length,1);
  app.scheduled.shift()();
  for(let i=0;i<12;i++)await settle();
  assert.ok(app.calls.search.length>0);
  const individual=harness({integrated:false});
  individual.window.renderCards('#topRail',[individual.home]);
  assert.equal(individual.window.__dinoPatch03Bridge.getPrefetchStatus().queued,0);
  assert.equal(individual.scheduled.length,0);
});

test('background prefetch obeys session cap and deduplicates repeated visible lists',async()=>{
  const app=harness();
  app.nodes.get('#detailDialog').open=false;
  const works=Array.from({length:15},(_,i)=>({
    ...app.home,id:'home-'+i,mal_id:'reanime:home-'+i,
    anilistId:90000+i,malId:80000+i,
    title:'Unrelated New Work '+i,title_english:'Unique Work '+i
  }));
  app.window.renderCards('#seasonRail',works);
  app.window.renderCards('#seasonRail',works);
  assert.equal(app.window.__dinoPatch03Bridge.getPrefetchStatus().queued,15);
  assert.equal(app.scheduled.length,1);
  for(let pass=0;pass<16 && app.scheduled.length;pass++) {
    app.scheduled.shift()();
    for(let i=0;i<10;i++)await settle();
  }
  const progress=app.window.__dinoPatch03Bridge.getPrefetchStatus();
  assert.equal(progress.startedThisSession,8);
  assert.equal(progress.usedToday,8);
  assert.equal(progress.running,false);
  assert.equal(app.scheduled.length,0,'session cap prevents further background requests');
});


test('already searched cards never trigger duplicate background scans',async()=>{
  const app=harness();
  app.nodes.get('#detailDialog').open=false;
  app.window.renderCards('#searchGrid',[app.home]);
  assert.equal(app.window.__dinoPatch03Bridge.getPrefetchStatus().queued,0);
  assert.equal(app.scheduled.length,0);
});


test('source index records missing versus provider outage for separate expiry policies',async()=>{
  const missing=harness();
  await missing.window.openDetail(missing.home.mal_id);
  missing.window.__dinoPatch03Bridge.flushWorkIndex();
  const missingStore=JSON.parse(missing.storage.get(api.WORK_INDEX_KEY));
  const missingRow=missingStore.works.find(row=>row.sources.some(item=>item.mal_id===missing.home.mal_id));
  assert.equal(missingRow.outcome,'missing','fully answered scan with unmatched providers is a 7-day missing check');
  assert.ok(missingRow.checkedAt>0);

  const failed=harness();
  const original=failed.window.lilac.providerCatalog;
  failed.window.lilac.providerCatalog=(provider,...args)=>
    provider==='ohli24'?Promise.reject(Error('provider unavailable')):original(provider,...args);
  await failed.window.openDetail(failed.home.mal_id);
  failed.window.__dinoPatch03Bridge.flushWorkIndex();
  const failedStore=JSON.parse(failed.storage.get(api.WORK_INDEX_KEY));
  const failedRow=failedStore.works.find(row=>row.sources.some(item=>item.mal_id===failed.home.mal_id));
  assert.equal(failedRow.outcome,'error','incomplete scan gets short retry without deleting known links');
  assert.ok(failedRow.attemptedAt>0);
});


test('original local Re:Anime index seeds 36 titles without a five-provider network search', async()=>{
  const works=Array.from({length:72},(_,i)=>({
    provider:'reanime',id:'local-'+i,mal_id:'reanime:local-'+i,
    title:'Local Indexed Anime '+i,anilistId:100000+i,year:2026,type:'TV'
  }));
  const state={sources:[{provider:'reanime',total:works.length,status:'ready'}]};
  const storage=new Map([['contentSource','reanime']]);
  const first=harness({persistedStorage:storage,catalogState:state,catalogItems:works});
  assert.equal(first.calls.search.length,0,'index import starts after the UI is ready');
  assert.equal(first.scheduled.length,1,'one deferred local read');
  first.scheduled.shift()();
  await settle();await settle();await settle();
  const originalCalls=first.calls.search;
  assert.equal(originalCalls.length,1,'one original indexed page only');
  assert.equal(originalCalls[0].provider,'reanime');
  assert.equal(originalCalls[0].query,'');
  assert.equal(originalCalls[0].sort,'popular');
  assert.ok(!originalCalls.some(request=>request.provider==='miruro'),'no remote supplier searches');
  assert.equal(first.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().importedThisSession,36);
  assert.equal(first.window.__dinoPatch03Bridge.getWorkIndexStats().works,36);
  first.window.__dinoPatch03Bridge.flushWorkIndex();
  const data=JSON.parse(storage.get(api.WORK_INDEX_KEY));
  assert.equal(data.works.length,36);
  assert.ok(data.works.every(row=>row.checkedAt===0 && !row.outcome),'catalog-only titles must not be marked verified');
  assert.equal(first.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().nextOffset,36);

  const repeat=harness({persistedStorage:storage,catalogState:state,catalogItems:works});
  assert.equal(repeat.scheduled.length,1,'the next local read is scheduled for tomorrow, not startup');
  assert.equal(repeat.calls.search.length,0);
  assert.equal(repeat.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().indexed,36);
  const checkpointKey='lilacDinoPatch.workIndex.originalCatalogSeed.v1';
  const checkpoint=JSON.parse(storage.get(checkpointKey));
  storage.set(checkpointKey,JSON.stringify({...checkpoint,time:Date.now()-25*60*60*1000}));
  const next=harness({persistedStorage:storage,catalogState:state,catalogItems:works});
  assert.equal(next.scheduled.length,1);
  next.scheduled.shift()();
  await settle();await settle();await settle();
  assert.equal(next.calls.search[0].offset,36,'next day imports next page, not first page');
  assert.equal(next.window.__dinoPatch03Bridge.getWorkIndexStats().works,72);
  assert.equal(next.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().nextOffset,0);
});

test('missing original index and non-integrated mode cause no new catalog or supplier requests', async()=>{
  const empty=harness({catalogState:{sources:[]},catalogItems:[]});
  assert.equal(empty.scheduled.length,1);
  empty.scheduled.shift()();
  await settle();await settle();
  assert.equal(empty.calls.search.length,0);
  assert.equal(empty.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().status,'no-local-index');
  const individual=harness({integrated:false,catalogState:{sources:[{provider:'reanime',total:900}]},
    catalogItems:[{provider:'reanime',id:'a',mal_id:'reanime:a',title:'A'}]});
  assert.equal(individual.scheduled.length,0);
  assert.equal(individual.calls.search.length,0);
});

test('already verified connections are not overwritten by the original catalog seed',async()=>{
  const storage=new Map([['contentSource','reanime']]);
  const first=harness({persistedStorage:storage});
  await first.window.openDetail(first.home.mal_id);
  first.window.__dinoPatch03Bridge.flushWorkIndex();
  const before=JSON.parse(storage.get(api.WORK_INDEX_KEY));
  const original=before.works.find(row=>row.sources.some(source=>source.mal_id===first.home.mal_id));
  assert.ok(original && original.sources.length===2 && original.checkedAt>0);
  const read=harness({
    persistedStorage:storage,
    catalogState:{sources:[{provider:'reanime',total:1,status:'ready'}]},
    catalogItems:[first.home]
  });
  assert.equal(read.scheduled.length,1);
  read.scheduled.shift()();
  await settle();await settle();
  read.window.__dinoPatch03Bridge.flushWorkIndex();
  const after=JSON.parse(storage.get(api.WORK_INDEX_KEY));
  const saved=after.works.find(row=>row.sources.some(source=>source.mal_id===first.home.mal_id));
  assert.equal(saved.sources.length,2,'existing verified supplier mapping survives');
  assert.equal(saved.checkedAt,original.checkedAt,'local list data does not change verification timestamp');
});


test('visible original cards from all five providers populate one conservative local identity without extra queries',async()=>{
  const app=harness();
  const providers=api.PROVIDERS;
  const cards=providers.map((provider,i)=>({
    ...app.home,provider,id:'observed-'+i,mal_id:provider+':observed-'+i,
    title:'Observed work',title_english:'Observed work',anilistId:770900
  }));
  const before=app.calls.search.length;
  for(const card of cards)
    app.window.renderCards('#seasonRail',[card]);
  const snapshot=app.window.__dinoPatch03Bridge.getWorkIndexStats();
  assert.equal(snapshot.works,1,'the exact same AniList identity must coalesce');
  assert.deepEqual(Object.keys(snapshot.providers).sort(),providers.slice().sort());
  assert.ok(providers.every(provider=>snapshot.providers[provider]===1));
  assert.equal(app.calls.search.length,before,'observing already fetched cards must not call provider APIs');
  app.window.__dinoPatch03Bridge.flushWorkIndex();
  const saved=JSON.parse(app.storage.get(api.WORK_INDEX_KEY));
  assert.equal(saved.works[0].sources.length,5);
  assert.equal(saved.works[0].checkedAt,0,'mere observation does not count as provider verification');
  assert.equal(saved.works[0].outcome,'');
});

test('an observed five-source work opens from cached IDs without redundant searches',async()=>{
  const app=harness();
  const cards=api.PROVIDERS.map((provider,i)=>provider==='reanime'?app.home:({
    ...app.home,provider,id:'cached-'+i,mal_id:provider+':cached-'+i,
    title:'Common work',year:2026,anilistId:app.home.anilistId
  }));
  for(const card of cards)app.window.renderCards('#topRail',[card]);
  assert.equal(app.calls.search.length,0);
  await app.window.openDetail(app.home.mal_id);
  assert.equal(app.calls.search.length,0,'verified matching cards already provide five supplier IDs');
  assert.equal(buttons(app).length,5);
  assert.equal(app.window.__dinoPatch03Bridge.getWorkIndexStats().works,1);
});

test('observed cards with different seasons or conflicting media IDs never merge',async()=>{
  const app=harness();
  const first={...app.home,provider:'reanime',id:'season-one',mal_id:'reanime:season-one',
    anilistId:880001,title:'Same title',year:2026};
  const second={...first,provider:'miruro',id:'season-two',mal_id:'miruro:season-two',
    anilistId:880002,title:'Same title',year:2026};
  app.window.renderCards('#topRail',[first,second]);
  const snapshot=app.window.__dinoPatch03Bridge.getWorkIndexStats();
  assert.equal(snapshot.providers.reanime,1);
  assert.equal(snapshot.providers.miruro,1);
  const cached=JSON.parse((()=>{
    app.window.__dinoPatch03Bridge.flushWorkIndex();return app.storage.get(api.WORK_INDEX_KEY)
  })());
  assert.equal(cached.works.length,2);
});

test('background matching excludes known suppliers and keeps explicit detail retries available',async()=>{
  const app=harness();
  app.nodes.get('#detailDialog').open=false;
  app.window.renderCards('#seasonRail',[app.home]);
  assert.equal(app.scheduled.length,1);
  app.scheduled.shift()();
  for(let i=0;i<14;i++)await settle();
  assert.ok(app.calls.search.length>0);
  assert.ok(!app.calls.search.some(req=>req.provider==='reanime'),
    'already known source should not be searched in background');
  app.window.__dinoPatch03Bridge.flushWorkIndex();
  const before=JSON.parse(app.storage.get(api.WORK_INDEX_KEY)).works
    .find(row=>row.sources.some(source=>source.mal_id===app.home.mal_id));
  assert.equal(before.outcome,'error','limited background scan must not cache missing as definitive');
  app.nodes.get('#detailDialog').open=true;
  await app.window.openDetail(app.home.mal_id);
  app.window.__dinoPatch03Bridge.flushWorkIndex();
  const after=JSON.parse(app.storage.get(api.WORK_INDEX_KEY)).works
    .find(row=>row.sources.some(source=>source.mal_id===app.home.mal_id));
  assert.equal(after.outcome,'missing',
    'foreground evaluates the background result fully, reusing recent requests where possible');
  assert.ok(buttons(app).length>=2);
});

test('provider mode does not modify the hybrid observed-work cache',async()=>{
  const app=harness({integrated:false});
  app.window.renderCards('#seasonRail',[app.home]);
  assert.equal(app.window.__dinoPatch03Bridge.getWorkIndexStats().works,0);
  assert.equal(app.calls.search.length,0);
});


test('original rememberAnime callback passively indexes sorted catalog cards across all providers',async()=>{
  const app=harness();
  const cards=api.PROVIDERS.map((provider,i)=>({
    ...app.home,provider,id:'sorted-'+i,mal_id:provider+':sorted-'+i,
    title:'The Same Sorted Work',anilistId:470001,year:2026,type:'TV'
  }));
  for(const anime of cards) {
    app.window.rememberAnime(anime);
    assert.equal(app.window.animeById(anime.mal_id),anime,
      'original in-memory card lookup must remain intact');
  }
  assert.equal(app.calls.search.length,0,'no provider lookup from original card path');
  const stats=app.window.__dinoPatch03Bridge.getWorkIndexStats();
  assert.equal(stats.works,1);
  assert.ok(api.PROVIDERS.every(provider=>stats.providers[provider]===1));
  app.window.__dinoPatch03Bridge.flushWorkIndex();
  const saved=JSON.parse(app.storage.get(api.WORK_INDEX_KEY));
  assert.equal(saved.works[0].sources.length,5);
  assert.equal(saved.works[0].checkedAt,0);
});


test('offline catalog import continues 36 NEW works a day until 1000 then stops permanently',async()=>{
  const limit=1000,day=24*60*60*1000;
  const catalogItems=Array.from({length:1100},(_,i)=>({
    provider:'reanime',id:'daily-'+i,mal_id:'reanime:daily-'+i,
    title:'Daily Catalog Work '+i,anilistId:300000+i,year:2026,type:'TV'
  }));
  const catalogState={sources:[{provider:'reanime',total:catalogItems.length,status:'ready'}]};
  const storage=new Map([['contentSource','reanime']]);
  let imported=0;
  const checkpointKey='lilacDinoPatch.workIndex.originalCatalogSeed.v1';
  for(let dayIndex=0;dayIndex<29;dayIndex++){
    const app=harness({persistedStorage:storage,catalogState,catalogItems});
    const pending=app.scheduled.shift();
    if(dayIndex<28)assert.ok(pending,'new day must schedule a local read');
    if(!pending){
      assert.equal(imported,limit);
      break;
    }
    pending();
    await settle();await settle();await settle();
    app.window.__dinoPatch03Bridge.flushWorkIndex();
    const indexed=app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus();
    const added=indexed.indexed-imported;
    assert.ok(added>=0 && added<=36,'at most 36 distinct indexed sources per day');
    if(dayIndex<27)assert.equal(added,36,'a full local catalog should supply 36 new works');
    imported=indexed.indexed;
    assert.equal(indexed.target,limit);
    assert.ok(app.calls.search.every(query=>query.provider==='reanime'
      && query.query==='' && query.sort==='popular'),'no five-provider search requests');
    if(imported>=limit){
      assert.equal(indexed.status,'target-reached');
      assert.equal(app.scheduled.filter(fn=>fn.__testDelay>=60000).length,0,
        'no daily wake-up timer after the target is reached');
      break;
    }
    const checkpoint=JSON.parse(storage.get(checkpointKey));
    storage.set(checkpointKey,JSON.stringify({...checkpoint,time:Date.now()-25*60*60*1000}));
  }
  assert.equal(imported,limit,'28 daily batches must reach 1,000 and stop');
  const final=harness({persistedStorage:storage,catalogState,catalogItems});
  assert.equal(final.scheduled.length,0,'restarting after target never re-seeds');
  assert.equal(final.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().indexed,limit);
  assert.equal(final.window.__dinoPatch03Bridge.getWorkIndexStats().works,limit);
  assert.equal(final.calls.search.length,0);
});

test('duplicates already observed from native cards do not consume daily 36 new-work quota',async()=>{
  const catalogItems=Array.from({length:160},(_,i)=>({
    provider:'reanime',id:'duplicate-'+i,mal_id:'reanime:duplicate-'+i,
    title:'Duplicate Work '+i,anilistId:500000+i,year:2026,type:'TV'
  }));
  const state={sources:[{provider:'reanime',total:catalogItems.length,status:'ready'}]};
  const app=harness({catalogState:state,catalogItems});
  app.window.renderCards('#topRail',catalogItems.slice(0,20));
  assert.equal(app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().indexed,20);
  app.scheduled.shift()();
  await settle();await settle();await settle();
  const seed=app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus();
  assert.equal(seed.importedThisSession,36,'duplicates do not spend daily new-work budget');
  assert.equal(seed.indexed,56);
  assert.equal(seed.localPageReads,2,'the importer skips duplicate cards using only local pages');
  assert.equal(seed.nextOffset,56,'the next daily cursor skips exactly the scanned entries');
  assert.ok(app.calls.search.every(query=>query.provider==='reanime'&&query.sort==='popular'));
});

test('failed local index persistence cannot advance daily checkpoint and skip unsaved works',async()=>{
  class StorageFull extends Map {
    set(key,value) {
      if(key===api.WORK_INDEX_KEY)throw Error('quota exceeded');
      return super.set(key,value);
    }
  }
  const storage=new StorageFull([['contentSource','reanime']]);
  const catalogItems=Array.from({length:60},(_,i)=>({
    provider:'reanime',id:'quota-'+i,mal_id:'reanime:quota-'+i,
    title:'Quota Work '+i,anilistId:600000+i,year:2026,type:'TV'
  }));
  const app=harness({persistedStorage:storage,
    catalogState:{sources:[{provider:'reanime',total:catalogItems.length,status:'ready'}]},
    catalogItems});
  app.scheduled.shift()();
  await settle();await settle();await settle();
  assert.equal(app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().status,'write-failed');
  assert.equal(storage.has('lilacDinoPatch.workIndex.originalCatalogSeed.v1'),false);
  assert.equal(storage.has(api.WORK_INDEX_KEY),false);
});
