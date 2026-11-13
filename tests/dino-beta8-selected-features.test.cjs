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
