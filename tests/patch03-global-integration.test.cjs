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

function harness({ integrated=true, firstReturnsUnrelated=false }={}) {
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
  element('pageSearch');element('globalSearch');
  const video=element('video','video');
  const psQuality=element('psQuality');psQuality.classList.add('hidden');
  const psQualityList=element('psQualityList');
  const events=new Map();
  const document={
    querySelector:selector=>nodes.get(selector)||null,
    createElement:name=>new Elements(name),
    addEventListener:(name,fn)=>events.set(name,fn)
  };
  const storage=new Map([['contentSource','reanime']]);
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
      providerCatalog:async(provider,query)=>{
        calls.search.push({provider,query});
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
  const sandbox=vm.createContext({window,document,localStorage,setTimeout:()=>1,console});
  vm.runInContext(bridge,sandbox,{filename:'patch03-bridge.js'});
  assert.equal(window.__dinoPatch03Bridge?.active,true);
  return {window,document,storage,nodes,calls,events,home,other,unrelated,video,psQuality,psQualityList,sandbox,status,sourceSelect};
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
  assert.ok(app.calls.local.some(x=>x.provider==='reanime'));
  assert.ok(app.calls.search.some(x=>x.provider==='miruro'&&x.query==='English Work'));
  assert.ok(sources.some(x=>x.textContent.includes('12화')));
  assert.ok(sources.some(x=>x.textContent.includes('10화')));
  assert.ok(sources.every(x=>x.textContent.includes('화질 재생 시 확인')));
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
  assert.ok(buttons(app).every(x=>x.textContent.includes('화질 재생 시 확인')));
  app.sandbox.currentPlaybackContext={episode:{provider:'reanime'},anime:{mal_id:app.home.mal_id}};
  app.video.videoWidth=1920;app.video.videoHeight=1080;
  app.events.get('DOMContentLoaded')();
  app.video.send('loadedmetadata');
  assert.equal(app.psQuality.classList.contains('hidden'),false);
  assert.match(app.psQualityList.children[0].textContent,/1920×1080/);
  await app.window.openDetail(app.home.mal_id);
  assert.ok(buttons(app).some(x=>x.textContent.includes('최근 재생 1080p')));
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
  assert.ok(buttons(app).every(button=>button.textContent.includes('\\n')),'source labels use compact two-line tabs');
  rail.scrollLeft=113;
  await app.window.openDetail(app.home.mal_id);
  assert.equal(app.nodes.get('#detailContent').querySelector('.dino-source-track').scrollLeft,113);
});
