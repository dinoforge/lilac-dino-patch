'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const api=require('../src/integrated-search.js');

test('parallel search dispatch is fair across providers before second query variants',async()=>{
  const calls=[];
  await api.searchProviders({
    providers:['reanime','miruro','ohli24'],terms:['First','Second'],
    concurrency:3,localSearch:async()=>null,
    search:async(provider,query)=>{calls.push([provider,query]);return [];}
  });
  assert.deepEqual(calls.slice(0,3),[
    ['reanime','First'],['miruro','First'],['ohli24','First']
  ]);
});
test('automatic grouping conservatively keeps same-title different seasons apart',()=>{
  const item=(provider,id,season,anilistId)=>({
    provider,id,mal_id:provider+':'+id,year:2026,
    title:'나의 작품',season,anilistId,type:'TV'
  });
  const groups=api.groupResults([
    item('reanime','a',1,101),item('miruro','b',1,101),
    item('ohli24','c',2,102),item('animenosub','d',2,102)
  ]);
  assert.equal(groups.length,2);
  assert.deepEqual(groups.map(x=>x.sourceCount),[2,2]);
});
test('diagnoses partial provider failure without including user query or error details',()=>{
  const hint=api.diagnoseProviderStatuses([
    {provider:'reanime',state:'ready',resultCount:4},
    {provider:'miruro',state:'failed',resultCount:0,message:'secret /Users/me/private'},
    {provider:'unknown',state:'failed'}
  ]);
  assert.equal(hint.category,'provider-error');
  assert.equal(hint.count,1);
  assert.doesNotMatch(JSON.stringify(hint),/secret|private/);
});
test('search diagnosis distinguishes true empty results from provider errors',()=>{
  const empty=api.diagnoseProviderStatuses([
    {provider:'reanime',state:'ready',resultCount:0},
    {provider:'miruro',state:'ready',resultCount:0}
  ]);
  assert.equal(empty.category,'no-results');
  assert.equal(api.diagnoseProviderStatuses([{provider:'reanime',state:'ready',pageLimitReached:true,resultCount:12}]).category,'page-limit');
  assert.equal(api.diagnoseProviderStatuses([{provider:'reanime',state:'ready',resultCount:1}]).category,'ok');
});
test('season detector records precise newly aired titles locally only once',()=>{
  const map=new Map();
  const storage={getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)};
  const clock=()=>Date.UTC(2026,10,14);
  const row={provider:'reanime',mal_id:'r:100',startDate:{year:2026,month:11,day:1}};
  const first=api.createSeasonDetector(storage,{clock});
  assert.equal(first.observe([row]).length,1);
  assert.equal(first.observe([row]).length,0);
  assert.equal(api.createSeasonDetector(storage,{clock}).observe([row]).length,0);
  assert.equal(first.summary().count,1);
});
test('season detector rejects uncertain, impossible, future and old dates',()=>{
  const storage={getItem:()=>null,setItem:()=>{}};
  const watch=api.createSeasonDetector(storage,{clock:()=>Date.UTC(2026,10,14)});
  const row=(id,date)=>({provider:'reanime',mal_id:id,startDate:date});
  assert.deepEqual(watch.observe([
    row('missing',{year:2026}),row('invalid',{year:2026,month:2,day:30}),
    row('future','2026-12-01'),row('old','2025-01-01'),
    row('untrusted','2026-11-01')
  ]).map(x=>x.sourceId),['untrusted']);
});
test('selected feature UI remains scoped to integrated detail picker',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../src/integrated-search.css'),'utf8');
  const bridge=fs.readFileSync(path.join(__dirname,'../patches/patch03/patch03-bridge.js'),'utf8');
  assert.match(css,/\.detail-source-picker\.dino-integrated-picker\[data-dino-accent="mint"\]/);
  assert.match(css,/\.detail-source-picker\.dino-integrated-picker\[data-dino-accent="blue"\]/);
  assert.match(bridge,/seasonDetector\.observe\(flattened\)/);
  assert.match(bridge,/dino-accent-switch/);
  assert.match(bridge,/diagnoseProviderStatuses/);
});


test('partial primary airing date falls back to a precise secondary date',()=>{
  assert.equal(api.preciseReleaseTime({
    startDate:{year:2026},
    started_on:'2026-11-03'
  }),Date.UTC(2026,10,3));
  assert.equal(api.preciseReleaseTime({
    startDate:'2026-02-30',
    aired:'2026-11-02'
  }),Date.UTC(2026,10,2));
});
test('season summary expires old observations without deleting manually owned data',()=>{
  const map=new Map();
  const storage={getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)};
  let current=Date.UTC(2026,10,14);
  const detector=api.createSeasonDetector(storage,{clock:()=>current});
  const row={provider:'miruro',id:'season-77',started_on:'2026-11-01'};
  assert.equal(detector.observe([row]).length,1);
  assert.equal(detector.summary().count,1);
  current=Date.UTC(2027,2,5);
  assert.equal(detector.summary().count,0);
  assert.equal(detector.summary().recent.length,0);
  assert.ok(map.has('lilacDinoPatch.newSeasonObserved.v1'));
});
test('corrupt persisted observation rows do not inflate the current count',()=>{
  const key='lilacDinoPatch.newSeasonObserved.v1';
  const now=Date.UTC(2026,10,14);
  const saved={version:1,seen:[],recent:[
    {provider:'reanime',sourceId:'ok',startedAt:Date.UTC(2026,10,1)},
    {provider:'unsupported',sourceId:'no',startedAt:now},
    {provider:'miruro',sourceId:'no-date',startedAt:'2026-11-01'},
    {provider:'ohli24',sourceId:'very-old',startedAt:Date.UTC(2024,0,1)}
  ]};
  const storage={getItem:input=>input===key?JSON.stringify(saved):null,setItem:()=>{}};
  const detector=api.createSeasonDetector(storage,{clock:()=>now});
  assert.equal(detector.summary().count,1);
  assert.equal(detector.summary().recent[0].sourceId,'ok');
});
test('search term fan-out stays bounded to providers and unique terms',async()=>{
  const calls=[];
  const result=await api.searchProviders({
    providers:['reanime','miruro','reanime'],
    terms:['ABC','abc','ABC','日本語'],
    concurrency:2,maxPages:1,
    search:async(provider,term)=>{calls.push(provider+':'+term);return [];}
  });
  assert.equal(calls.length,4);
  assert.equal(new Set(calls).size,4);
  assert.equal(result.statuses.length,2);
});
