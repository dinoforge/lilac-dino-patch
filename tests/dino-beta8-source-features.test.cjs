'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => readFileSync(path.join(__dirname, '..', file), 'utf8');
const previewPath = process.env.DINO_COMBINED_PREVIEW_ASAR;
const readRenderer = (file) => previewPath
  ? require('@electron/asar').extractFile(previewPath, file).toString('utf8')
  : read(file);
const app = readRenderer('src/app.js');

function loadFunction(name, next, context = {}) {
  const start = app.indexOf(`function ${name}(`);
  const functionEnd = app.indexOf(`\nfunction ${next}(`, start);
  const asyncEnd = app.indexOf(`\nasync function ${next}(`, start);
  const end = functionEnd < 0 ? asyncEnd : asyncEnd < 0 ? functionEnd : Math.min(functionEnd, asyncEnd);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`(${app.slice(start, end).trim()})`, context);
}

function adultCatalogFunctions() {
  const labels={reanime:'RE:Anime',miruro:'Miruro',animenosub:'Animenosub',ohli24:'Ohli24',linkkf:'Linkkf'};
  const origins={reanime:'https://reanime.to',miruro:'https://www.miruro.to',animenosub:'https://animenosub.to',ohli24:'https://www.ohli24.net',linkkf:'https://linkkf.app'};
  const identity=loadFunction('adultCatalogIdentity','adultCatalogSnapshotUrl',{adultCatalogProviderLabels:labels});
  const snapshotUrl=loadFunction('adultCatalogSnapshotUrl','adultCatalogSnapshot',{adultCatalogProviderOrigins:origins,URL});
  const snapshot=loadFunction('adultCatalogSnapshot','readAdultCatalogMetadata',{adultCatalogIdentity:identity,adultCatalogSnapshotUrl:snapshotUrl,adultCatalogProviderOrigins:origins,URL});
  const overrideContext={adultCatalogOverrideKey:'dinoAdultCatalogOverrides',adultCatalogIdentity:identity,adultCatalogSnapshot:snapshot};
  const readOverrides=loadFunction('readAdultCatalogOverrides','writeAdultCatalogOverride',overrideContext);
  const writeOverride=loadFunction('writeAdultCatalogOverride','cancelAdultCatalogPage',{...overrideContext,readAdultCatalogOverrides:readOverrides});
  const classify=loadFunction('classifyAdultCatalogItem','updateAdultCatalogDecision',{adultCatalogIdentity:identity});
  const label=loadFunction('adultClassificationLabel','adultClassificationPanelMarkup');
  const update=loadFunction('updateAdultCatalogDecision','hydrateAdultCatalogManualEntries',{
    adultCatalogIdentity:identity,adultCatalogSnapshot:snapshot,writeAdultCatalogOverride:writeOverride,
    readAdultCatalogOverrides:readOverrides,classifyAdultCatalogItem:classify
  });
  const hydrate=loadFunction('hydrateAdultCatalogManualEntries','adultClassificationLabel',{
    readAdultCatalogOverrides:readOverrides,classifyAdultCatalogItem:classify
  });
  return {identity,snapshot,readOverrides,writeOverride,classify,label,update,hydrate};
}

test('catalog route reuses app navigation and cards without changing the All view', () => {
  const html = readRenderer('src/index.html');
  assert.match(html, /data-view="all"[\s\S]+data-view="adultCatalog"[\s\S]+data-view="history"/);
  assert.match(app, /renderCards\('#adultCatalogGrid',items\)/);
  assert.match(app, /providerCatalog\('reanime','',adultCatalog.offset\)/);
  assert.match(app, /adultCatalog\.scrollTop\s*=\s*(?:document\.querySelector\('main'\)|main)\.scrollTop/);
  if (previewPath) {
    new vm.Script(app);
    assert.equal((html.match(/data-view="adultCatalog"/g) || []).length, 1);
    assert.match(html, /integrated-search\.js/);
    assert.match(app, /if\(name==='adultCatalog'\).*loadAdultCatalogPage/);
    assert.match(app, /fastBufferPlayer\.on\(Hls\.Events\.LEVEL_LOADED/);
    assert.match(app, /addEventListener\('ratechange',event=>updateFastHlsBuffer/);
  }
});

test('catalog accepts only explicit named genre evidence with a matching provider identity', () => {
  const packageClassifier = previewPath ? adultCatalogFunctions().classify : null;
  const qualifies = item => (packageClassifier || adultCatalogFunctions().classify)(item).status === 'CONFIRMED_HENTAI';
  const item = { provider: 'reanime', id: 'example', mal_id: 'reanime:example', genres: [{ name: ' Hentai ' }] };
  assert.equal(qualifies(item), true);
  for (const patch of [
    { genres: [] }, { genres: [{ id: 12 }] }, { genres: [{ name: 'Ecchi' }], adult: true },
    { genres: null, title: 'Hentai' }, { provider: 'miruro' }, { mal_id: 'reanime:other' },
  ]) assert.equal(qualifies({ ...item, ...patch }), false);
});

test('classification requires corroborated identity and preserves conflicts and scoped overrides', () => {
  const classify = adultCatalogFunctions().classify;
  const item = {provider:'reanime', id:'sample', mal_id:'reanime:sample',
    title:'Alternate Title', title_japanese:'Original Title', year:2020, malId:123};
  const evidence = {source:'fixture', status:'CONFIRMED_HENTAI', malId:123, year:2020, titles:['Original Title']};
  const withEvidence = (...verifiedMetadata) => classify(item, {verifiedMetadata});
  assert.equal(classify(item).status, 'UNKNOWN');
  assert.equal(classify({...item, genres:[{name:'Ecchi'}], rating:'18+'}).status, 'REVIEW_REQUIRED');
  assert.equal(withEvidence(evidence).status, 'CONFIRMED_HENTAI');
  assert.equal(withEvidence({...evidence, titles:['Alternate Title']}).status, 'CONFIRMED_HENTAI');
  assert.equal(withEvidence({...evidence, malId:124}).status, 'UNKNOWN');
  assert.equal(withEvidence({...evidence, year:2021}).status, 'REVIEW_REQUIRED');
  assert.equal(withEvidence({...evidence, titles:['Original Titles']}).status, 'REVIEW_REQUIRED');
  const negative = {...evidence, source:'fixture-2', status:'NOT_HENTAI'};
  assert.equal(withEvidence(negative).status, 'NOT_HENTAI');
  const conflict=withEvidence(evidence,negative);
  assert.equal(conflict.status, 'REVIEW_REQUIRED');
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.evidence.length, 2);
  assert.equal(classify(item,{verifiedMetadata:[evidence],manual:{workKey:item.mal_id,action:'exclude'}}).status,'NOT_HENTAI');
  assert.equal(classify(item,{manual:{workKey:item.mal_id,action:'include'}}).manual,'include');
  assert.equal(classify(item,{manual:{workKey:'miruro:sample',action:'include'}}).status,'UNKNOWN');
});

test('detail classification actions persist provider-scoped choices and hydrate included works', () => {
  const {identity,readOverrides,update,hydrate}=adultCatalogFunctions();
  const sources=[
    {provider:'reanime',id:'same-title',mal_id:'reanime:same-title',title:'같은 제목',genres:[{name:'Hentai'}],url:'https://reanime.to/anime/same-title'},
    {provider:'miruro',id:'same-title',mal_id:'miruro:same-title',title:'같은 제목',genres:[],url:'https://www.miruro.to/watch/same-title'},
    {provider:'animenosub',id:'same-title',mal_id:'animenosub:same-title',title:'같은 제목',genres:[],url:'https://animenosub.to/anime/same-title/'},
    {provider:'ohli24',id:'17',mal_id:'ohli24:17',title:'같은 제목',genres:[],url:'https://www.ohli24.net/17/same-title.html'},
    {provider:'linkkf',id:'82',mal_id:'linkkf:82',title:'같은 제목',genres:[],url:'https://linkkf.app/up/82/'},
  ];
  const data=new Map(),storage={
    get:(key,fallback)=>data.has(key)?data.get(key):fallback,
    set:(key,value)=>data.set(key,JSON.parse(JSON.stringify(value)))
  };
  const catalog={items:new Map(),classifications:new Map()};
  for(const item of sources){
    assert.equal(identity(item).workKey,item.mal_id);
    const result=update(item,'include',{storage,catalog,verifiedMetadata:[]});
    assert.equal(result.ok,true,item.provider);
    assert.equal(result.classification.manual,'include');
    assert.ok(catalog.items.has(item.mal_id));
  }
  assert.equal(new Set(sources.map(item=>identity(item).workKey)).size,5);
  const excluded=update(sources[1],'exclude',{storage,catalog,verifiedMetadata:[]});
  assert.equal(excluded.classification.status,'NOT_HENTAI');
  assert.equal(catalog.items.has(sources[1].mal_id),false);
  assert.equal(catalog.items.has(sources[0].mal_id),true);
  assert.equal(readOverrides(storage).get('animenosub:same-title').item.url,'https://animenosub.to/anime/same-title/');

  const restored={items:new Map(),classifications:new Map()};
  hydrate({storage,catalog:restored,verifiedMetadata:[]});
  assert.equal(restored.items.size,4);
  assert.equal(restored.items.get('linkkf:82').adultCatalogManual,true);
  assert.equal(restored.items.has('miruro:same-title'),false);
  const elements=new Map(),rendered=[];
  const $=selector=>{if(!elements.has(selector))elements.set(selector,{value:'',textContent:'',disabled:false,classList:{toggle(){}}});return elements.get(selector)};
  const render=loadFunction('renderAdultCatalog','loadAdultCatalogPage',{
    adultCatalog:restored,$,normalizeSearchText:value=>String(value||'').toLowerCase(),
    normalizeAdultCatalogText:value=>String(value||'').toLowerCase(),titleOf:item=>item.title,
    renderCards:(_,items)=>rendered.splice(0,rendered.length,...items.map(item=>item.mal_id))
  });
  render();
  assert.equal(rendered.length,4);
  $('#adultCatalogSearch').value='같은';
  render();
  assert.equal(rendered.length,4);
  $('#adultCatalogSearch').value='없는 제목';
  render();
  assert.equal(rendered.length,0);
  assert.match($('#adultCatalogStatus').textContent,/검색 결과가 없습니다/);

  const automatic=update(sources[0],'auto',{storage,catalog,verifiedMetadata:[]});
  assert.equal(automatic.classification.status,'CONFIRMED_HENTAI');
  assert.equal(automatic.classification.manual,null);
  assert.equal(readOverrides(storage).has('reanime:same-title'),false);
  assert.equal(catalog.items.get('reanime:same-title').adultCatalogManual,false);
});

test('malformed or cross-source saved overrides are ignored without title-based matching', () => {
  const {readOverrides}=adultCatalogFunctions();
  const storage={get:()=>({version:1,entries:[
    {workKey:'unknown:12',action:'include'},
    {workKey:'reanime:one',action:'include',item:{provider:'reanime',id:'two',mal_id:'reanime:two',title:'같은 제목'}},
    {workKey:'miruro:three',action:'include',item:{provider:'miruro',id:'three',mal_id:'miruro:three',title:'같은 제목',url:'javascript:alert(1)'}},
    {workKey:'linkkf:four',action:'remove'}
  ]})};
  const overrides=readOverrides(storage);
  assert.equal(overrides.has('unknown:12'),false);
  assert.equal(overrides.has('linkkf:four'),false);
  assert.equal(overrides.get('reanime:one').item,undefined);
  assert.equal(overrides.get('miruro:three').item.url,'');
  assert.equal(overrides.get('miruro:three').item.mal_id,'miruro:three');
});

test('detail buttons save the scoped choice, refresh the catalog, and restore automatic status', () => {
  const {identity,readOverrides,classify,label,update}=adultCatalogFunctions();
  const values=new Map(),storage={get:(key,fallback)=>values.has(key)?values.get(key):fallback,set:(key,value)=>values.set(key,value)};
  const catalog={items:new Map(),classifications:new Map()},view={status:{textContent:''},saved:{textContent:''}},listeners=new Map(),pressed=new Map();
  const buttons=['include','exclude','auto'].map(action=>({
    dataset:{adultClassificationAction:action},
    addEventListener:(type,listener)=>listeners.set(action,listener),
    setAttribute:(name,value)=>pressed.set(`${action}:${name}`,value)
  }));
  const panel={querySelector:selector=>selector.includes('status]')?view.status:view.saved,querySelectorAll:()=>buttons};
  const token=Symbol('detail'),item={provider:'linkkf',id:'17',mal_id:'linkkf:17',title:'Fixture',genres:[{name:'Hentai'}],url:'https://linkkf.app/up/17/'};
  let refreshes=0;
  const bind=loadFunction('bindAdultClassificationControls','hydrateAdultCatalogManualEntriesForPage',{
    adultCatalogIdentity:identity,adultClassificationLabel:label,$:()=>panel,readAdultCatalogOverrides:readOverrides,classifyAdultCatalogItem:classify,
    readAdultCatalogMetadata:()=>[],store:storage,updateAdultCatalogDecision:update,adultCatalog:catalog,
    openDetail:{token},renderAdultCatalog:()=>refreshes++,toast:()=>{}
  });
  bind(item,token);
  listeners.get('include')();
  assert.equal(view.status.textContent,'직접 지정 · 야애니 탭에 표시');
  assert.equal(view.saved.textContent,'저장됨 · 이 작품에만 적용');
  assert.equal(pressed.get('include:aria-pressed'),'true');
  assert.equal(catalog.items.has('linkkf:17'),true);
  listeners.get('exclude')();
  assert.equal(view.status.textContent,'직접 제외 · 야애니 탭에 표시되지 않음');
  assert.equal(catalog.items.has('linkkf:17'),false);
  listeners.get('auto')();
  assert.equal(view.status.textContent,'자동 분류 · 야애니');
  assert.equal(view.saved.textContent,'저장됨 · 자동 분류 사용');
  assert.equal(readOverrides(storage).has('linkkf:17'),false);
  assert.equal(refreshes,3);
});

test('detail panel exposes three persisted actions and keeps source identity in the existing detail flow', () => {
  const html=readRenderer('src/index.html');
  const css=readRenderer('src/adult-catalog.css');
  assert.match(html,/adult-catalog\.css/);
  assert.match(html,/<link rel="stylesheet" href="adult-catalog\.css"\s*\/>/);
  assert.match(css,/\.adult-classification-panel/);
  assert.match(css,/\.adult-catalog-manual-badge/);
  assert.match(app,/adultClassificationPanelMarkup\(a,adultClassification,adultManual\)/);
  assert.match(app,/if\(adultIdentity\)bindAdultClassificationControls\(a,token\)/);
  assert.match(app,/dinoAdultCatalogOverrides/);
  assert.match(app,/if\(adultPanel\)\$\('#detailContent \.tags'\)\?\.insertAdjacentHTML\('afterend',adultPanel\)/);
  assert.match(app,/data-adult-classification-action="include"[\s\S]*data-adult-classification-action="exclude"[\s\S]*data-adult-classification-action="auto"/);
  assert.match(app,/adultCatalog\.items\.values\(\)\]\.filter/);
  assert.match(app,/renderCards\('#adultCatalogGrid',items\)/);
  const main=read('electron/main.cjs');
  for(const provider of ['reanime','miruro','animenosub','ohli24','linkkf'])assert.match(main,new RegExp(`provider:\\s*['"]${provider}['"]`));
});

test('catalog paging retries failures, prevents duplicate requests and filters rendered cards', async () => {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', classList: { toggle() {} } });
    return elements.get(id);
  };
  const title = id => ({ provider: 'reanime', id, mal_id: `reanime:${id}`, title: id, genres: [{ name: 'Hentai' }] });
  const offsets = [];
  let result;
  let renderedKeys;
  const localSettings=new Map();
  const context = {
    $,
    store:{get:(key,fallback)=>localSettings.get(key)??fallback,set:(key,value)=>localSettings.set(key,value)},
    normalizeSearchText: value => String(value || '').toLowerCase(),
    normalizeAdultCatalogText: value => String(value || '').toLowerCase(),
    titleOf: item => item.title,
    renderCards: (_, items) => {
      result = items.map(item => item.id).join(',');
      renderedKeys = items.map(item => item.mal_id).join(',');
    },
    window: { lilac: { providerCatalog: async (_, __, offset) => {
      offsets.push(offset);
      if (offsets.length === 1) throw new Error('fixture failure');
      return { data: [title('alpha'), title('beta'), {...title('beta-other'),genres:[],rating:'18+'},
        {...title('beta-matched'),genres:[],malId:789,year:2020},
        {...title('beta-conflict'),genres:[],malId:789,anilistId:456,year:2020}], total: 5 };
    } } },
  };
  const start = app.indexOf('const adultCatalog=');
  const end = app.indexOf('function toggleLibrary(', start);
  assert.ok(start >= 0 && end > start);
  const vmContext=vm.createContext(context);
  vm.runInContext(app.slice(start, end), vmContext);
  if(!previewPath){
    $('#adultCatalogMetadata').textContent=JSON.stringify({version:1,records:[
      {source:'synthetic-fixture',status:'CONFIRMED_HENTAI',malId:789,anilistId:123,year:2020,titles:['beta-matched','beta-conflict']}
    ]});
    localSettings.set('dinoAdultCatalogOverrides',{version:1,entries:[
      {workKey:'reanime:alpha',action:'exclude'}, {workKey:'miruro:beta-other',action:'include'}
    ]});
  }
  await $('#adultCatalogMore').onclick();
  assert.equal($('#adultCatalogMore').textContent, '다시 시도');
  await Promise.all([$('#adultCatalogMore').onclick(), $('#adultCatalogMore').onclick()]);
  assert.deepEqual(offsets, [0, 0]);
  assert.equal(result, previewPath?'alpha,beta':'beta,beta-matched');
  $('#adultCatalogSearch').value = 'beta';
  $('#adultCatalogSearch').oninput();
  assert.equal(result, previewPath?'beta':'beta,beta-matched');
  assert.equal(renderedKeys, previewPath?'reanime:beta':'reanime:beta,reanime:beta-matched');
  if(!previewPath){
    assert.equal(vm.runInContext("adultCatalog.classifications.get('reanime:beta-conflict').status",vmContext),'REVIEW_REQUIRED');
    assert.equal(vm.runInContext("writeAdultCatalogOverride(store,'reanime:alpha','auto')",vmContext),true);
    assert.equal(vm.runInContext("readAdultCatalogOverrides(store).has('reanime:alpha')",vmContext),false);
    assert.equal(vm.runInContext("writeAdultCatalogOverride(store,'reanime:beta-other','include')",vmContext),true);
    assert.equal(vm.runInContext("readAdultCatalogOverrides(store).get('reanime:beta-other').action",vmContext),'include');
    const pending=[];
    vmContext.window.lilac.providerCatalog=()=>new Promise(resolve=>pending.push(resolve));
    vm.runInContext('adultCatalog.done=false',vmContext);
    const old=$('#adultCatalogMore').onclick();
    vm.runInContext('cancelAdultCatalogPage()',vmContext);
    const fresh=$('#adultCatalogMore').onclick();
    pending[1]({data:[],done:true});
    await fresh;
    pending[0]({data:[title('beta-stale')],done:true});
    await old;
    assert.equal(result,'beta,beta-matched');
    $('#adultCatalogSearch').value='unmatched';
    $('#adultCatalogSearch').oninput();
    assert.match($('#adultCatalogStatus').textContent,/검색 결과가 없습니다/);
  }
});

test('fast buffer target applies only to HLS VOD and resets at normal speed', () => {
  const update = loadFunction('updateFastHlsBuffer', previewPath ? 'play' : 'bindHlsPlayerEvents');
  const instance = { config: { maxBufferSize: 1024 ** 3 }, latestLevelDetails: { live: false } };
  update(instance, 2);
  assert.equal(instance.config.maxBufferLength, 90);
  assert.equal(instance.config.maxMaxBufferLength, 90);
  update(instance, 1);
  assert.equal(instance.config.maxMaxBufferLength, 60);
  instance.latestLevelDetails.live = true;
  update(instance, 2);
  assert.equal(instance.config.maxMaxBufferLength, 60);
  assert.equal(instance.config.maxBufferSize, 1024 ** 3);
  assert.doesNotThrow(() => update(null, 2));
});
