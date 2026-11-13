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
      if(selector.startsWith('.') && !selector.includes(' '))
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
  const replay={resolve:null},playerContext={};
  const sandbox=vm.createContext({window,document,localStorage,
    currentPlaybackContext:playerContext,
    resolveIntoPlayer:(...args)=>replay.resolve?.(...args),
    setTimeout:(fn,delay)=>{fn.__testDelay=delay;scheduled.push(fn);return scheduled.length;},console});
  vm.runInContext(bridge,sandbox,{filename:'patch03-bridge.js'});
  assert.equal(window.__dinoPatch03Bridge?.active,true);
  return {window,document,storage,nodes,calls,events,home,other,unrelated,video,psQuality,psQualityList,sandbox,status,sourceSelect,playbackStatus,scheduled,replay};
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
  // A separate 20-second episode refresh now exists, so select the
  // existing 2.3-second supplier-mapping timer explicitly.
  app.scheduled.find(fn=>fn.__testDelay===2300)();
  await settle();
  assert.equal(app.calls.search.length,0,'detail modal takes priority over background prefetch');
  assert.equal(app.window.__dinoPatch03Bridge.getPrefetchStatus().queued,1);
  app.nodes.get('#detailDialog').open=false;
  // Episode polling has its own timer; this test only drives the existing
  // supplier-discovery retry after the detail dialog is closed.
  assert.equal(app.scheduled.filter(fn=>fn.__testDelay===15000).length,1);
  app.scheduled.find(fn=>fn.__testDelay===15000)();
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


test('original on-disk catalog imports 36 per idle batch and another 36 immediately, not tomorrow',async()=>{
  const works=Array.from({length:72},(_,i)=>({
    provider:'reanime',id:'local-'+i,mal_id:'reanime:local-'+i,
    title:'Local Indexed Anime '+i,anilistId:100000+i,year:2026,type:'TV'
  }));
  const state={sources:[{provider:'reanime',total:works.length,status:'ready'}]};
  const storage=new Map([['contentSource','reanime']]);
  const first=harness({persistedStorage:storage,catalogState:state,catalogItems:works});
  first.nodes.get('#detailDialog').open=false;
  assert.equal(first.calls.search.length,0,'import starts after UI initialization');
  assert.equal(first.scheduled.filter(fn=>fn.__testDelay===5000).length,1);
  first.scheduled.find(fn=>fn.__testDelay===5000)();
  await settle();await settle();await settle();
  assert.equal(first.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().indexed,36);
  assert.equal(first.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().batchSize,36);
  assert.equal(first.calls.search.length,1);
  assert.ok(first.calls.search.every(x=>x.provider==='reanime'&&x.query===''&&x.sort==='popular'));
  const next=first.scheduled.find(fn=>fn.__testDelay===1400);
  assert.ok(next,'a second local batch should run without waiting a day');
  next();
  await settle();await settle();await settle();
  assert.equal(first.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().indexed,72);
  assert.equal(first.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().status,'catalog-end-reached');
  assert.ok(!first.scheduled.some(fn=>fn.__testDelay===86401000),'no daily quota or daily timer');
  first.window.__dinoPatch03Bridge.flushWorkIndex();
  const saved=JSON.parse(storage.get(api.WORK_INDEX_KEY));
  assert.equal(saved.works.length,72);
  assert.ok(saved.works.every(row=>row.checkedAt===0&&!row.outcome));
  assert.equal(first.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().nextOffset,0);
  const repeat=harness({persistedStorage:storage,catalogState:state,catalogItems:works});
  repeat.nodes.get('#detailDialog').open=false;
  assert.equal(repeat.calls.search.length,0);
  const recheck=repeat.scheduled.find(fn=>fn.__testDelay===5000);
  assert.ok(recheck,'a cheap original index state check may be scheduled');
  recheck();
  await settle();await settle();
  assert.equal(repeat.calls.search.length,0,'completed catalog does not re-read local pages');
});

test('missing original index and non-integrated mode cause no new catalog or supplier requests', async()=>{
  const empty=harness({catalogState:{sources:[]},catalogItems:[]});
  empty.nodes.get('#detailDialog').open=false;
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
  read.nodes.get('#detailDialog').open=false;
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


test('idle import reaches 1000 local titles without any calendar-day transitions',async()=>{
  const target=1000;
  const catalogItems=Array.from({length:1100},(_,i)=>({
    provider:'reanime',id:'stream-'+i,mal_id:'reanime:stream-'+i,
    title:'Stream Work '+i,anilistId:300000+i,year:2026,type:'TV'
  }));
  const catalogState={sources:[{provider:'reanime',total:catalogItems.length,status:'ready'}]};
  const storage=new Map([['contentSource','reanime']]);
  const app=harness({persistedStorage:storage,catalogState,catalogItems});
  app.nodes.get('#detailDialog').open=false;
  let indexed=0,turns=0,callback=app.scheduled.find(fn=>fn.__testDelay===5000);
  while(callback&&turns<30){
    callback();
    await settle();await settle();await settle();
    const state=app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus();
    const added=state.indexed-indexed;
    assert.ok(added>0&&added<=36,'each idle batch imports at most 36 distinct works');
    indexed=state.indexed;
    turns++;
    callback=app.scheduled.filter(fn=>fn.__testDelay===1400).at(-1);
    if(state.status==='target-reached')break;
  }
  assert.equal(indexed,target);
  assert.equal(turns,28);
  const end=app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus();
  assert.equal(end.status,'target-reached');
  assert.equal(end.localPageReads,28);
  assert.ok(app.calls.search.every(x=>x.provider==='reanime'&&x.query===''&&x.sort==='popular'));
  assert.equal(app.calls.search.length,28);
  app.window.__dinoPatch03Bridge.flushWorkIndex();
  const restart=harness({persistedStorage:storage,catalogState,catalogItems});
  assert.equal(restart.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().indexed,target);
  assert.equal(restart.scheduled.length,0,'target reached: no new automatic work');
  assert.equal(restart.calls.search.length,0);
});

test('already seen cards are free, with no daily limit or repeated supplier searches',async()=>{
  const catalogItems=Array.from({length:160},(_,i)=>({
    provider:'reanime',id:'duplicate-'+i,mal_id:'reanime:duplicate-'+i,
    title:'Duplicate Work '+i,anilistId:500000+i,year:2026,type:'TV'
  }));
  const state={sources:[{provider:'reanime',total:catalogItems.length,status:'ready'}]};
  const app=harness({catalogState:state,catalogItems});
  app.nodes.get('#detailDialog').open=false;
  app.window.renderCards('#topRail',catalogItems.slice(0,20));
  assert.equal(app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().indexed,20);
  app.scheduled.find(fn=>fn.__testDelay===5000)();
  await settle();await settle();await settle();
  const seed=app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus();
  assert.equal(seed.importedThisSession,36);
  assert.equal(seed.indexed,56);
  assert.equal(seed.localPageReads,2);
  assert.equal(seed.nextOffset,56);
  assert.ok(app.scheduled.some(fn=>fn.__testDelay===1400),'next batch does not wait a day');
  assert.ok(app.calls.search.every(x=>x.provider==='reanime'&&x.sort==='popular'));
});

test('active detail playback postpones offline indexing but never burns a daily quota',async()=>{
  const works=Array.from({length:72},(_,i)=>({
    provider:'reanime',id:'paused-'+i,mal_id:'reanime:paused-'+i,
    title:'Paused Work '+i,year:2025,anilistId:700000+i
  }));
  const app=harness({
    catalogState:{sources:[{provider:'reanime',total:works.length,status:'ready'}]},
    catalogItems:works
  });
  // The harness starts with the detail dialog open.
  app.scheduled.find(fn=>fn.__testDelay===5000)();
  await settle();await settle();
  assert.equal(app.calls.search.length,0);
  assert.equal(app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().status,'paused-for-playback');
  app.nodes.get('#detailDialog').open=false;
  app.scheduled.find(fn=>fn.__testDelay===15000)();
  await settle();await settle();await settle();
  assert.equal(app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().indexed,36);
  assert.equal(app.calls.search.length,1);
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
  app.nodes.get('#detailDialog').open=false;
  app.scheduled.find(fn=>fn.__testDelay===5000)();
  await settle();await settle();await settle();
  assert.equal(app.window.__dinoPatch03Bridge.getOriginalCatalogSeedStatus().status,'write-failed');
  assert.equal(storage.has('lilacDinoPatch.workIndex.originalCatalogSeed.v1'),false);
  assert.equal(storage.has(api.WORK_INDEX_KEY),false);
});


test('original resolver writes one work-level Korean title shared by both suppliers',async()=>{
  const storage=new Map([['contentSource','reanime']]);
  const first=harness({persistedStorage:storage});
  let resolves=0;
  first.window.lilac.resolveTitles=async()=>{resolves++;
    return [{ko:'두 공급원이 공유하는 한국어 대표 제목',en:'English Work'}];
  };
  await first.window.openDetail(first.home.mal_id);
  assert.equal(resolves,1,'first detail uses the official title resolver once');
  const reanime=first.window.__dinoPatch03Bridge.getWorkTitles(first.home.mal_id);
  const miruro=first.window.__dinoPatch03Bridge.getWorkTitles(first.other.mal_id);
  assert.equal(reanime.ko,'두 공급원이 공유하는 한국어 대표 제목');
  assert.equal(miruro.ko,reanime.ko);
  assert.equal(reanime.koSource,'official');
  assert.equal(reanime.manual,false);
  assert.ok(reanime.koCheckedAt>0);
  first.window.__dinoPatch03Bridge.flushWorkIndex();

  const second=harness({persistedStorage:storage});
  let repeated=0;
  second.window.lilac.resolveTitles=async()=>{repeated++;
    return [{ko:'나중에 바뀐 원본 제목',en:'English Work'}];
  };
  await second.window.openDetail(second.home.mal_id);
  assert.equal(repeated,0,'canonical official result is reused after restart');
  assert.equal(second.window.__dinoPatch03Bridge.getWorkTitles(second.home.mal_id).ko,
    '두 공급원이 공유하는 한국어 대표 제목');
  assert.equal(second.window.__dinoPatch03Bridge.getWorkTitles(second.other.mal_id).ko,
    '두 공급원이 공유하는 한국어 대표 제목');
});

test('detail editor overrides work-level Korean title, protects it from automatic changes, and can reset it',async()=>{
  const app=harness();
  app.window.lilac.resolveTitles=async()=>[{ko:'자동으로 찾은 한국어 제목',en:'English Work'}];
  await app.window.openDetail(app.home.mal_id);
  const detail=app.nodes.get('#detailContent');
  let picker=detail.querySelector('.detail-source-picker');
  assert.ok(picker);
  assert.match(picker.querySelector('.dino-work-title-edit').textContent,/한국어 제목 수정/);
  const edit=picker.querySelector('.dino-work-title-edit');
  edit.send('click');
  let input=detail.querySelector('.dino-work-title-input');
  assert.equal(input.value,'자동으로 찾은 한국어 제목');
  input.value='사용자가 직접 수정한 제목';
  detail.querySelector('.dino-work-title-save').send('click');
  const titles=app.window.__dinoPatch03Bridge.getWorkTitles(app.home.mal_id);
  assert.equal(titles.ko,'사용자가 직접 수정한 제목');
  assert.equal(titles.koSource,'manual');
  assert.equal(titles.manual,true);
  assert.equal(app.window.__dinoPatch03Bridge.getWorkTitles(app.other.mal_id).ko,
    '사용자가 직접 수정한 제목','both providers read same manual work-level title');

  app.window.__dinoPatch03Bridge.flushWorkIndex();
  const stored=JSON.parse(app.storage.get(api.WORK_INDEX_KEY));
  assert.equal(stored.works[0].titles.ko,'사용자가 직접 수정한 제목');
  assert.equal(stored.works[0].sources[0].mal_id,app.home.mal_id,
    'provider ID remains untouched by the title editor');
  picker=detail.querySelector('.detail-source-picker');
  picker.querySelector('.dino-work-title-edit').send('click');
  detail.querySelector('.dino-work-title-reset').send('click');
  assert.equal(app.window.__dinoPatch03Bridge.getWorkTitles(app.home.mal_id).manual,false);
  assert.equal(app.window.__dinoPatch03Bridge.getWorkTitles(app.home.mal_id).koSource,'provider');
});

test('manual Korean title survives original resolver updates after restart',async()=>{
  const storage=new Map([['contentSource','reanime']]);
  const first=harness({persistedStorage:storage});
  first.window.lilac.resolveTitles=async()=>[{ko:'처음 확인된 제목',en:'English Work'}];
  await first.window.openDetail(first.home.mal_id);
  let detail=first.nodes.get('#detailContent');
  detail.querySelector('.dino-work-title-edit').send('click');
  detail.querySelector('.dino-work-title-input').value='내가 정한 표준 작품명';
  detail.querySelector('.dino-work-title-save').send('click');
  first.window.__dinoPatch03Bridge.flushWorkIndex();

  const second=harness({persistedStorage:storage});
  let officialCalls=0;
  second.window.lilac.resolveTitles=async()=>{officialCalls++;
    return [{ko:'다른 자동 제목',en:'English Work'}];
  };
  await second.window.openDetail(second.home.mal_id);
  assert.equal(officialCalls,0,'manual title avoids automatic title resolution');
  assert.equal(second.window.__dinoPatch03Bridge.getWorkTitles(second.home.mal_id).ko,
    '내가 정한 표준 작품명');
  assert.equal(second.window.__dinoPatch03Bridge.getWorkTitles(second.other.mal_id).ko,
    '내가 정한 표준 작품명');
});


test('integrated picker highlights the active supplier and shows common title and count', async()=>{
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  await settle();await settle();
  const picker=app.nodes.get('#detailContent').querySelector('.detail-source-picker');
  assert.ok(picker);
  const title=picker.querySelector('.dino-source-heading-name');
  assert.match(title.textContent,/일본어 한글 제목/);
  assert.equal(picker.querySelector('.dino-source-linked-count').textContent,'2/5개 연결');
  assert.match(picker.querySelector('.dino-source-hint').textContent,/회차.*화질/);
  const tabs=buttons(app);
  assert.equal(tabs.length,2);
  assert.ok(tabs.some(b=>b.attributes.get('aria-pressed')==='true'));
  assert.ok(tabs.some(b=>b.attributes.get('aria-pressed')==='false'));
  assert.ok(tabs.every(b=>b.dataset.availability==='ready'));
  assert.ok(tabs.every(b=>['measured','reported','unknown'].includes(b.dataset.quality)));
  assert.ok(tabs.every(b=>b.attributes.has('aria-label')));
  const css=fs.readFileSync(path.join(__dirname,'../src/integrated-search.css'),'utf8');
  assert.match(css,/\.dino-source-option\[aria-pressed="true"\]::after\s*\{[^}]*content:"선택 중"/s);
  assert.match(css,/\.search-provider-chip:focus-visible\s*\{/s);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
});


test('async source episode-count updates preserve title-edit input and Enter saves it', async()=>{
  const app=harness();
  const pending=[];
  app.window.lilac.providerDetail=item=>new Promise(resolve=>pending.push({item,resolve}));
  await app.window.openDetail(app.home.mal_id);
  const detail=app.nodes.get('#detailContent');
  assert.equal(pending.length,2);
  detail.querySelector('.dino-work-title-edit').send('click');
  const initial=detail.querySelector('.dino-work-title-input');
  assert.ok(initial);
  initial.value='회차 확인 중 수정한 한국어 제목';
  pending[0].resolve({data:{},episodes:Array.from({length:12},(_,i)=>({number:i+1}))});
  await settle();await settle();
  assert.equal(detail.querySelector('.dino-work-title-input').value,'회차 확인 중 수정한 한국어 제목');
  pending[1].resolve({data:{},episodes:Array.from({length:10},(_,i)=>({number:i+1}))});
  await settle();await settle();
  const input=detail.querySelector('.dino-work-title-input');
  assert.equal(input.value,'회차 확인 중 수정한 한국어 제목');
  let prevented=false;
  input.listeners.get('keydown')({key:'Enter',preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(app.window.__dinoPatch03Bridge.getWorkTitles(app.home.mal_id).ko,'회차 확인 중 수정한 한국어 제목');
  assert.equal(detail.querySelector('.dino-work-title-form'),null);
  assert.equal(detail.querySelector('.dino-source-heading-name').textContent,'회차 확인 중 수정한 한국어 제목');
});

test('Escape closes Korean title editor without saving an unfinished change',async()=>{
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  const detail=app.nodes.get('#detailContent');
  const prior=app.window.__dinoPatch03Bridge.getWorkTitles(app.home.mal_id)?.ko;
  detail.querySelector('.dino-work-title-edit').send('click');
  const input=detail.querySelector('.dino-work-title-input');
  input.value='취소할 제목';
  input.listeners.get('keydown')({key:'Escape',preventDefault:()=>{}});
  assert.equal(detail.querySelector('.dino-work-title-form'),null);
  assert.equal(app.window.__dinoPatch03Bridge.getWorkTitles(app.home.mal_id)?.ko,prior);
});

test('broken supplier detail is shown as an error, not an episode count',async()=>{
  const app=harness();
  app.window.lilac.providerDetail=async item=>{
    if(item.provider==='miruro')throw new Error('provider unavailable');
    return {data:item,episodes:[{number:1}]};
  };
  await app.window.openDetail(app.home.mal_id);
  await settle();await settle();
  const tabs=buttons(app);
  const unavailable=tabs.find(b=>b.dataset.providerSource===app.other.mal_id);
  const healthy=tabs.find(b=>b.dataset.providerSource===app.home.mal_id);
  assert.equal(unavailable.dataset.availability,'error');
  assert.match(unavailable.textContent,/회차 확인 실패/);
  assert.equal(healthy.dataset.availability,'ready');
  assert.match(healthy.textContent,/1화/);
});


test('only ongoing works schedule episode updates; completed and ordinary catalog cards do not',async()=>{
  const app=harness();
  app.nodes.get('#detailDialog').open=false;
  const finished={...app.home,id:'done',mal_id:'reanime:done',anilistId:112231,
    title:'완결 작품',status:'FINISHED'};
  app.window.renderCards('#airingRail',[finished]);
  assert.equal(app.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().queued,0);
  app.window.renderCards('#topRail',[{...app.home,status:''}]);
  assert.equal(app.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().queued,0);
  app.window.renderCards('#topRail',[{...app.home,status:'ongoing'}]);
  assert.equal(app.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().queued,1);
  assert.equal(app.scheduled.filter(fn=>fn.__testDelay===20000).length,1);
  assert.equal(app.calls.detail.length,0,'no user navigation from automatic episode updates');
});

test('airing rail background detail check saves a real episode count with zero catalog searches',async()=>{
  const storage=new Map([['contentSource','reanime']]);
  const app=harness({persistedStorage:storage});
  app.nodes.get('#detailDialog').open=false;
  let detailCalls=0;
  app.window.lilac.providerDetail=async()=>{
    detailCalls++;
    return {episodes:Array.from({length:10},(_,i)=>({number:i+1,playable:true}))};
  };
  app.window.renderCards('#airingRail',[{...app.home,status:'airing'}]);
  const queued=app.window.__dinoPatch03Bridge.getEpisodeRefreshStatus();
  assert.equal(queued.queued,1);
  assert.equal(detailCalls,0,'rendering cards alone sends no detail request');
  const job=app.scheduled.find(fn=>fn.__testDelay===20000);
  assert.ok(job);
  job();
  await settle();await settle();
  const meta=app.window.__dinoPatch03Bridge.getEpisodeState(app.home.mal_id);
  assert.equal(meta.latest,10);
  assert.equal(meta.count,10);
  assert.equal(meta.state,'ready');
  assert.ok(meta.checkedAt>0);
  assert.equal(detailCalls,1);
  assert.equal(app.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().daily,1);
  assert.equal(app.calls.search.length,0,'no live catalog search is needed for episode verification');
  app.window.__dinoPatch03Bridge.flushWorkIndex();
  const persisted=JSON.parse(storage.get(api.WORK_INDEX_KEY));
  assert.equal(persisted.works[0].sources[0].dinoEpisode.latest,10);
  assert.equal(persisted.works[0].titles.ko,'일본어 한글 제목',
    'the shared Korean title must be unchanged by episode polling');

  const next=harness({persistedStorage:storage});
  next.nodes.get('#detailDialog').open=false;
  next.window.renderCards('#airingRail',[{...next.home,status:'airing'}]);
  assert.equal(next.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().queued,0,
    'recently confirmed episodes must not be queried again after restart');
});

test('a later ongoing check detects new episodes and shows them in the supplier picker',async()=>{
  const storage=new Map([['contentSource','reanime']]);
  const first=harness({persistedStorage:storage});
  first.nodes.get('#detailDialog').open=false;
  first.window.lilac.providerDetail=async()=>({episodes:Array.from({length:10},(_,i)=>({number:i+1}))});
  first.window.renderCards('#airingRail',[{...first.home,status:'airing'}]);
  first.scheduled.find(fn=>fn.__testDelay===20000)();
  await settle();await settle();
  first.window.__dinoPatch03Bridge.flushWorkIndex();
  // Simulate the legitimate 12-hour expiration without changing the clock.
  const indexData=JSON.parse(storage.get(api.WORK_INDEX_KEY));
  const old=indexData.works[0].sources[0].dinoEpisode;
  old.checkedAt-=13*60*60*1000;
  old.attemptedAt-=13*60*60*1000;
  storage.set(api.WORK_INDEX_KEY,JSON.stringify(indexData));

  const second=harness({persistedStorage:storage});
  second.nodes.get('#detailDialog').open=false;
  second.window.lilac.providerDetail=async()=>({episodes:Array.from({length:12},(_,i)=>({number:i+1}))});
  second.window.renderCards('#airingRail',[{...second.home,status:'airing'}]);
  assert.equal(second.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().queued,1);
  second.scheduled.find(fn=>fn.__testDelay===20000)();
  await settle();await settle();
  const meta=second.window.__dinoPatch03Bridge.getEpisodeState(second.home.mal_id);
  assert.equal(meta.latest,12);
  assert.equal(meta.newEpisodes,2);
  assert.equal(second.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().newEpisodes,1);
  second.nodes.get('#detailDialog').open=true;
  await second.window.openDetail(second.home.mal_id);
  await settle();await settle();
  const tab=buttons(second).find(b=>b.dataset.providerSource===second.home.mal_id);
  assert.ok(tab,'original supplier must remain available in detail picker');
  assert.equal(tab.dataset.newEpisodes,'2');
  assert.match(tab.textContent,/새 회차 \+2/);
  assert.equal(second.window.__dinoPatch03Bridge.getWorkTitles(second.home.mal_id).ko,
    '일본어 한글 제목');
});

test('provider outage keeps last confirmed episode count and rate-limits automatic retry',async()=>{
  const storage=new Map([['contentSource','reanime']]);
  const app=harness({persistedStorage:storage});
  app.nodes.get('#detailDialog').open=false;
  app.window.lilac.providerDetail=async()=>({episodes:Array.from({length:8},(_,i)=>({number:i+1}))});
  app.window.renderCards('#airingRail',[{...app.home,status:'airing'}]);
  app.scheduled.find(fn=>fn.__testDelay===20000)();
  await settle();await settle();
  app.window.__dinoPatch03Bridge.flushWorkIndex();
  const rows=JSON.parse(storage.get(api.WORK_INDEX_KEY));
  rows.works[0].sources[0].dinoEpisode.checkedAt-=13*60*60*1000;
  rows.works[0].sources[0].dinoEpisode.attemptedAt-=13*60*60*1000;
  storage.set(api.WORK_INDEX_KEY,JSON.stringify(rows));
  const broken=harness({persistedStorage:storage});
  broken.nodes.get('#detailDialog').open=false;
  broken.window.lilac.providerDetail=async()=>{throw Error('upstream timeout')};
  broken.window.renderCards('#airingRail',[{...broken.home,status:'airing'}]);
  broken.scheduled.find(fn=>fn.__testDelay===20000)();
  await settle();await settle();
  const after=broken.window.__dinoPatch03Bridge.getEpisodeState(broken.home.mal_id);
  assert.equal(after.latest,8);
  assert.equal(after.state,'error');
  assert.equal(after.newEpisodes,0);
  broken.window.__dinoPatch03Bridge.flushWorkIndex();
  const restarted=harness({persistedStorage:storage});
  restarted.nodes.get('#detailDialog').open=false;
  restarted.window.renderCards('#airingRail',[{...restarted.home,status:'airing'}]);
  assert.equal(restarted.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().queued,0,
    'failed provider has a six-hour cooldown, not a false zero-episode result');
});

test('background episode polling is bounded to eight supplier requests in one session',async()=>{
  const app=harness();
  app.nodes.get('#detailDialog').open=false;
  let calls=0;
  app.window.lilac.providerDetail=async()=>{calls++;return {episodes:[{number:1}]}};
  const cards=Array.from({length:24},(_,i)=>({...app.home,
    provider:'reanime',id:'session-'+i,mal_id:'reanime:session-'+i,
    anilistId:990000+i,title:'Air Work '+i,status:'airing'}));
  app.window.renderCards('#airingRail',cards);
  const first=app.scheduled.find(fn=>fn.__testDelay===20000);
  assert.ok(first);
  first();
  await settle();await settle();
  for(let n=1;n<8;n++){
    const timer=app.scheduled.filter(fn=>fn.__testDelay===14000)[n-1];
    assert.ok(timer,'one delayed provider query is scheduled at a time');
    timer();
    await settle();await settle();
  }
  const info=app.window.__dinoPatch03Bridge.getEpisodeRefreshStatus();
  assert.equal(calls,8);
  assert.equal(info.attempted,8);
  assert.equal(info.daily,8);
  assert.equal(info.sessionLimit,8);
  assert.equal(app.scheduled.filter(fn=>fn.__testDelay===14000).length,7);
});


test('an airing title that becomes completed before its scheduled poll is not queried',async()=>{
  const app=harness();
  app.nodes.get('#detailDialog').open=false;
  let calls=0;
  app.window.lilac.providerDetail=async()=>{calls++;return {episodes:[{number:1}]}};
  app.window.renderCards('#airingRail',[{...app.home,status:'airing'}]);
  const scheduled=app.scheduled.find(fn=>fn.__testDelay===20000);
  assert.ok(scheduled);
  app.window.renderCards('#airingRail',[{...app.home,status:'FINISHED'}]);
  scheduled();
  await settle();await settle();
  assert.equal(calls,0,'a title completed before the timer fires must not generate supplier IPC');
  assert.equal(app.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().attempted,0);
  app.window.renderCards('#airingRail',[{...app.home,status:'airing'}]);
  assert.equal(app.window.__dinoPatch03Bridge.getEpisodeRefreshStatus().queued,1,
    'new airing announcements can be scheduled after a skipped old request');
});

test('episode scheduler can pause and resume without touching provider settings',()=>{
  const app=harness();
  const bridge=app.window.__dinoPatch03Bridge;
  const sourceBefore=app.storage.get('contentSource');
  assert.equal(bridge.getEpisodeRefreshStatus().paused,false);
  bridge.pauseEpisodeRefresh();
  assert.equal(bridge.getEpisodeRefreshStatus().paused,true);
  bridge.resumeEpisodeRefresh();
  assert.equal(bridge.getEpisodeRefreshStatus().paused,false);
  assert.equal(app.storage.get('contentSource'),sourceBefore);
  assert.equal(bridge.getEpisodeRefreshStatus().dailyLimit,18);
});

test('yearless Animenosub list candidate is matched only after detail verifies its release year',async()=>{
  const app=harness();
  const candidate={
    provider:'animenosub',id:'same-work',mal_id:'animenosub:same-work',
    title:'English Work',title_english:'',year:'',type:'Anime'
  };
  const detailCalls=[];
  app.window.lilac.providerCatalog=async(provider,query)=>
    provider==='animenosub'&&query==='English Work'?{data:[candidate]}:{data:[]};
  app.window.lilac.providerDetail=async item=>{
    detailCalls.push(item.provider);
    return {data:item.provider==='animenosub'?{...item,year:2026}:item,episodes:[]};
  };
  await app.window.openDetail(app.home.mal_id);
  assert.ok(buttons(app).some(button=>button.dataset.providerSource==='animenosub:same-work'),
    'same-year candidate should link after loading official provider detail');
  assert.ok(detailCalls.includes('animenosub'),'yearless provider metadata should be loaded from its detail page');
});

test('yearless candidate whose detailed release year conflicts stays separate',async()=>{
  const app=harness();
  const candidate={
    provider:'animenosub',id:'different-season',mal_id:'animenosub:different-season',
    title:'English Work',title_english:'',year:'',type:'Anime'
  };
  app.window.lilac.providerCatalog=async(provider,query)=>
    provider==='animenosub'&&query==='English Work'?{data:[candidate]}:{data:[]};
  app.window.lilac.providerDetail=async item=>({
    data:item.provider==='animenosub'?{...item,year:2025}:item,episodes:[]
  });
  await app.window.openDetail(app.home.mal_id);
  assert.equal(buttons(app).length,1,
    'identical title is not evidence enough when detailed year differs');
  const picker=app.nodes.get('#detailContent').querySelector('.detail-source-picker');
  assert.ok(!picker.children.some(node=>String(node.textContent).includes('작품 확인 필요')),
    'a proven different release year is a rejection, not an unverified match');
});

test('a matching-title candidate without a verifiable year is shown as unverified',async()=>{
  const app=harness();
  const candidate={
    provider:'animenosub',id:'unknown-year',mal_id:'animenosub:unknown-year',
    title:'English Work',title_english:'',year:'',type:'Anime'
  };
  app.window.lilac.providerCatalog=async(provider,query)=>
    provider==='animenosub'&&query==='English Work'?{data:[candidate]}:{data:[]};
  app.window.lilac.providerDetail=async item=>({data:item,episodes:[]});
  await app.window.openDetail(app.home.mal_id);
  assert.equal(buttons(app).length,1);
  const picker=app.nodes.get('#detailContent').querySelector('.detail-source-picker');
  assert.ok(picker.children.some(node=>String(node.textContent).includes('작품 확인 필요')),
    'an unresolved exact-title candidate must not be reported as a confirmed miss');
});

test('manual supplier refresh overrides a previously fresh scan without deleting SQLite history',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../patches/patch03/patch03-bridge.js'),'utf8');
  assert.match(source,/if \(!force && stored\?\.fresh/);
  assert.match(source,/discoverSources\(current, group, \{ force: true \}\)/);
  assert.doesNotMatch(source,/localStorage\.clear\(|DROP TABLE|DELETE FROM dino_work/);
});

test('global Korean search spends limited aliases on Japanese and English supplier titles',async()=>{
  const app=harness();
  app.window.lilac.titleVariants=async()=>[
    '한국어 제목 여러 개','또다른 한국어 별명','日本語のタイトル','English Work'
  ];
  await app.window.doSearch('일본어 한글 제목');
  assert.ok(app.calls.search.some(x=>x.provider==='miruro'&&x.query==='English Work'),
    'foreign-language providers must receive Latin title aliases');
  assert.ok(app.calls.search.some(x=>x.query==='日本語のタイトル'),
    'Japanese alias should not be displaced by Korean-only alternatives');
});

test('terminal playback fallback refuses duplicate same-number editions and keeps the old player',async()=>{
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  Object.assign(app.sandbox.currentPlaybackContext,{
    anime:app.home,episode:{provider:'reanime',number:3,url:'https://original.example/3'}
  });
  let switchCalls=0,resolveCalls=0;
  app.replay.resolve=async()=>{switchCalls++;};
  app.window.lilac.providerDetail=async item=>({
    data:item,episodes:[{provider:item.provider,number:3,dub:false,url:'https://other.example/3'},
      {provider:item.provider,number:3,dub:false,url:'https://other.example/3-alt'}]
  });
  app.window.lilac.providerResolve=async()=>{resolveCalls++;return {url:'https://other.example/stream'}};
  app.events.get('DOMContentLoaded')();
  app.video.send('error');
  await settle();await settle();
  const offer=app.playbackStatus.children.find(x=>x.id==='dinoPlaybackAlternate');
  assert.ok(offer,'same-work source should be offered after terminal error');
  offer.send('click');
  await settle();await settle();
  assert.equal(resolveCalls,0,'duplicate episodes must be rejected before stream lookup');
  assert.equal(switchCalls,0,'original player must not be changed');
  assert.equal(app.sandbox.currentPlaybackContext.episode.provider,'reanime');
});

test('failed fallback pre-resolution leaves existing playback context unchanged',async()=>{
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  const context={anime:app.home,episode:{provider:'reanime',number:3,url:'https://original.example/3'}};
  Object.assign(app.sandbox.currentPlaybackContext,context);
  let switchCalls=0;
  app.replay.resolve=async()=>{switchCalls++;};
  app.window.lilac.providerDetail=async item=>({
    data:item,episodes:[{provider:item.provider,number:3,dub:false,url:'https://other.example/3'}]
  });
  app.window.lilac.providerResolve=async()=>{throw Error('provider stream offline')};
  app.events.get('DOMContentLoaded')();
  app.video.send('error');
  await settle();await settle();
  const offer=app.playbackStatus.children.find(x=>x.id==='dinoPlaybackAlternate');
  assert.ok(offer);
  offer.send('click');
  await settle();await settle();
  assert.equal(switchCalls,0,'do not enter a new player when pre-resolution fails');
  assert.equal(app.sandbox.currentPlaybackContext.episode,context.episode);
});

test('a uniquely verified alternative can keep the old playback position',async()=>{
  const app=harness();
  await app.window.openDetail(app.home.mal_id);
  Object.assign(app.sandbox.currentPlaybackContext,{
    anime:app.home,episode:{provider:'reanime',number:3,url:'https://original.example/3'}
  });
  app.video.currentTime=98;app.video.duration=540;
  const switched=[];
  app.replay.resolve=async (...args)=>switched.push(args);
  app.window.lilac.providerDetail=async item=>({
    data:item,episodes:[{provider:item.provider,number:3,dub:false,url:'https://other.example/3'}]
  });
  app.window.lilac.providerResolve=async()=>({url:'https://other.example/video.m3u8'});
  app.events.get('DOMContentLoaded')();
  app.video.send('error');
  await settle();await settle();
  const offer=app.playbackStatus.children.find(x=>x.id==='dinoPlaybackAlternate');
  assert.ok(offer);
  offer.send('click');
  await settle();await settle();
  assert.equal(switched.length,1);
  assert.equal(switched[0][2].anime.provider,'miruro');
  assert.equal(switched[0][2].episode.number,3);
  assert.equal(switched[0][2].resumeSeconds,98);
  assert.equal((await switched[0][0]()).url,'https://other.example/video.m3u8');
});

test('manual Korean title edits request an immediate SQLite flush',()=>{
  assert.match(bridge,/if \(sqlite\.isReady\(\)\) sqlite\.flush\(\)\.then\(ok =>/);
  assert.match(bridge,/if \(!workIndex\.flush\(\)\)/);
  assert.doesNotMatch(bridge,/localStorage\.clear\(\)/);
});
