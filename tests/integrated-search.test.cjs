const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { groupResults, filterGroups, chooseSource, searchProviders, mergeSearchResults } = require('../src/integrated-search.js');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');

const item = (provider, id, values = {}) => ({ provider, mal_id: `${provider}:${id}`, title: '같은 제목', ...values });

test('groups exact AniList identities while retaining each provider item', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100, title: '한국어 제목' }),
    item('miruro', 'b', { anilistId: 100, title: 'Same Title' }),
    item('ohli24', 'c', { anilistId: 200, title: '같은 제목' })
  ], 'miruro');

  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, 'Same Title', 'the selected provider supplies the preferred card metadata');
  assert.deepEqual(groups[0].sourceItems.map(source => source.provider), ['miruro', 'reanime']);
  assert.equal(groups[0].sourceCount, 2);
  assert.equal(groups[1].sourceItems.length, 1);
});

test('a unique MAL ID bridges an AniList item and an item without an AniList ID', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100, malId: 900 }),
    item('animenosub', 'b', { malId: 900 })
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sourceItems.map(source => source.provider), ['reanime', 'animenosub']);
});

test('ambiguous MAL bridges stay separate and standalone Linkkf is excluded from aggregation', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100, malId: 900 }),
    item('miruro', 'b', { anilistId: 101, malId: 900 }),
    item('linkkf', 'c', { malId: 900 })
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.sourceItems.length), [1, 1]);
  assert.equal(groups.flatMap(group => group.sourceItems).some(source => source.provider === 'linkkf'), false);
});

test('same-title seasons and candidates without stable IDs remain separate', () => {
  const groups = groupResults([
    item('reanime', 'season-1', { anilistId: 100 }),
    item('miruro', 'season-2', { anilistId: 101 }),
    item('animenosub', 'unknown-1'),
    item('ohli24', 'unknown-2')
  ]);

  assert.equal(groups.length, 4);
  assert.ok(groups.every(group => group.sourceItems.length === 1));
});

test('duplicate provider entries collapse by provider item ID, not by title', () => {
  const groups = groupResults([
    item('reanime', 'same', { anilistId: 100, title: '먼저 온 제목' }),
    item('reanime', 'same', { anilistId: 100, title: '늦게 온 중복' }),
    item('reanime', 'different', { anilistId: 100, title: '같은 작품의 다른 항목' })
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].sourceItems.length, 2);
  assert.equal(groups[0].sourceItems[0].title, '먼저 온 제목');
});

test('provider filters retain groups that include that provider and source choice honors the filter', () => {
  const groups = groupResults([
    item('reanime', 'a', { anilistId: 100 }),
    item('miruro', 'b', { anilistId: 100 }),
    item('ohli24', 'c', { anilistId: 200 })
  ]);

  const filtered = filterGroups(groups, 'miruro');
  assert.equal(filtered.length, 1);
  assert.equal(chooseSource(filtered[0], { provider: 'miruro', preferredProvider: 'reanime' }).provider, 'miruro');
  assert.equal(chooseSource(filtered[0], { preferredProvider: 'reanime' }).provider, 'reanime');
  assert.equal(chooseSource(filtered[0], { sourceId: 'miruro:b' }).provider, 'miruro');
});

test('search checks every provider and records a successful empty result separately from an error', async () => {
  const calls = [];
  const result = await searchProviders({
    providers: ['reanime', 'miruro'],
    query: 'test',
    search: async (provider, query) => {
      calls.push(`${provider}:${query}`);
      if (provider === 'miruro') throw new Error('offline');
      return { data: [] };
    }
  });

  assert.deepEqual(calls, ['reanime:test', 'miruro:test']);
  assert.equal(result.statuses.find(status => status.provider === 'reanime').state, 'ready');
  assert.equal(result.statuses.find(status => status.provider === 'reanime').resultCount, 0);
  assert.equal(result.statuses.find(status => status.provider === 'miruro').state, 'failed');
});

test('Korean query uses the local Korean catalog and skips providers that return newest posts for Korean searches', async () => {
  const calls = [], localCalls = [];
  const result = await searchProviders({
    providers: ['reanime', 'animenosub', 'miruro'],
    query: '한국 제목',
    terms: ['Korean Title'],
    localSearch: async provider => {
      localCalls.push(provider);
      return provider === 'reanime' ? [item('reanime', 'local')] : null;
    },
    search: async (provider, query) => {
      calls.push(`${provider}:${query}`);
      return { data: [item(provider, query)] };
    }
  });

  assert.deepEqual(calls, ['reanime:한국 제목', 'reanime:Korean Title', 'animenosub:Korean Title', 'miruro:Korean Title']);
  assert.deepEqual(localCalls, ['reanime', 'animenosub', 'miruro']);
  assert.equal(result.items.some(anime => anime.mal_id === 'reanime:local'), true);
  assert.equal(result.statuses.find(status => status.provider === 'animenosub').state, 'ready');
});

test('search limits concurrent provider requests and reports partial provider failures', async () => {
  let active = 0, maximum = 0;
  const result = await searchProviders({
    providers: ['reanime'],
    query: 'one',
    terms: ['two', 'three'],
    concurrency: 2,
    search: async (_provider, query) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      if (query === 'two') throw new Error('one title variant failed');
      return { data: [item('reanime', query)] };
    }
  });

  assert.equal(maximum, 2);
  assert.equal(result.statuses[0].state, 'partial');
  assert.equal(result.statuses[0].resultCount, 2);
});

test('merged query and title-variant runs deduplicate provider items and preserve partial errors', () => {
  const merged = mergeSearchResults(
    { items: [item('reanime', 'a')], statuses: [
      { provider: 'reanime', state: 'ready', attempts: 1, successes: 1, failures: 0 },
      { provider: 'miruro', state: 'failed', attempts: 1, successes: 0, failures: 1 }
    ] },
    { items: [item('reanime', 'a', { title: 'duplicate' }), item('miruro', 'b')], statuses: [
      { provider: 'reanime', state: 'partial', attempts: 2, successes: 1, failures: 1 },
      { provider: 'miruro', state: 'partial', attempts: 2, successes: 1, failures: 1 }
    ] }
  );

  assert.equal(merged.items.length, 2);
  assert.deepEqual(merged.statuses.map(status => [status.provider, status.state, status.resultCount]), [
    ['reanime', 'partial', 1], ['miruro', 'partial', 1]
  ]);
});

test('detail source picker identifies the active raw provider item and hides for a single source', () => {
  const start = appSource.indexOf('function detailSourcePickerMarkup(');
  const end = appSource.indexOf('\nasync function openDetail', start);
  assert.ok(start >= 0 && end > start, 'Missing detail source picker');
  const context = vm.createContext({
    SOURCE_LABELS: { reanime: 'RE:Anime', miruro: 'Miruro' },
    escapeHtml: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.renderPicker = detailSourcePickerMarkup;`, context);
  const markup = context.renderPicker({ sourceItems: [item('reanime', 'one'), item('miruro', 'two')] }, item('miruro', 'two'));
  assert.match(markup, /RE:Anime/);
  assert.match(markup, /Miruro/);
  assert.match(markup, /data-detail-source="miruro:two" aria-pressed="true"/);
  assert.equal(context.renderPicker({ sourceItems: [item('reanime', 'one')] }, item('reanime', 'one')), '');
});

test('weekday picker does not count unrelated search results as episode availability', () => {
  const start = appSource.indexOf('function detailSourcePickerMarkup(');
  const end = appSource.indexOf('\nasync function checkWeekdaySourceEpisodes', start);
  assert.ok(start >= 0 && end > start, 'Missing weekday availability helpers');
  const weekdays = require('../src/weekday-schedule.js');
  const context = vm.createContext({
    SOURCE_LABELS: { reanime: 'RE:Anime', miruro: 'Miruro', animenosub: 'Animenosub', ohli24: '애니24', linkkf: 'Linkkf' },
    LilacWeekdaySchedule: weekdays,
    openDetail: { currentGroupKey: '', currentSourceId: '' },
    $: () => null,
    escapeHtml: value => String(value)
  });
  vm.runInContext(`${appSource.slice(start, end)}\nthis.renderPicker = detailSourcePickerMarkup;`, context);
  const group = {
    weekdaySchedule: true, scheduleSearchReady: true, sourceItems: [], scheduleAvailability: {},
    scheduleSearchStatuses: [{ provider: 'reanime', state: 'ready', resultCount: 7 }]
  };
  const markup = context.renderPicker(group, { mal_id: 'reanime:anchor' });
  const reanimeRow = markup.match(/<div class="weekday-source-state" data-schedule-provider="reanime"[^>]*>(.*?)<\/div>/)?.[1] || '';
  assert.match(reanimeRow, /미제공/);
  assert.doesNotMatch(reanimeRow, /제공 확인/);
});

test('search UI loads the grouping model before app code and routes source changes through real item IDs', () => {
  assert.match(htmlSource, /id="searchProviderFilters"[^>]*role="group"/);
  assert.ok(htmlSource.indexOf('src="integrated-search.js"') < htmlSource.indexOf('src="app.js"'));
  assert.match(appSource, /LilacIntegratedSearch\.searchProviders\(/);
  assert.match(appSource, /const first=await LilacIntegratedSearch\.searchProviders\(\{\.\.\.searchOptions,query\}\)/);
  assert.match(appSource, /const extra=await LilacIntegratedSearch\.searchProviders\(\{\.\.\.searchOptions,query:'',terms:variants,localSearch:async\(\)=>null\}\)/);
  assert.match(appSource, /LilacIntegratedSearch\.chooseSource\(group,\{provider:currentSearchFilter,preferredProvider:state\.source,sourceId\}\)/);
  assert.match(appSource, /openDetail\(button\.dataset\.detailSource,\{groupKey:group\?\.groupKey\|\|'',sourceId:button\.dataset\.detailSource\}\)/);
  assert.match(appSource, /function showHomeList\(list,label\)\{invalidateIntegratedSearch\(\);switchView\('search'\);hideIntegratedSearchFilters\(\);\$\('#filterBar'\)\.classList\.toggle\('hidden',state\.source!=='linkkf'\)/);
});


test('Dino work index behaves like the original local Korean title cache without mutating source settings', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const values=new Map([['contentSource','reanime'],['lilacDinoPatch.searchMode','integrated']]);
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value))};
  let now=1900000000000;
  const first=createWorkIndex(storage,{clock:()=>now});
  const anchor=item('reanime','first',{title:'한국 제목',anilistId:12345,year:2026,type:'TV'});
  const secondary=item('miruro','second',{title:'English Title',anilistId:12345,year:2026,type:'TV'});
  first.remember({sourceItems:[anchor,secondary]},{checked:true,names:['원본에서 가져온 한글 제목']});
  first.rememberSearch('한국 제목',{items:[anchor,secondary],statuses:[
    {provider:'reanime',state:'ready',resultCount:1},
    {provider:'miruro',state:'ready',resultCount:1}
  ]});
  assert.equal(first.find(anchor).sources.length,2);
  first.flush();
  assert.equal(values.get('contentSource'),'reanime');
  assert.equal(values.get('lilacDinoPatch.searchMode'),'integrated');
  assert.ok(values.get(WORK_INDEX_KEY));
  const second=createWorkIndex(storage,{clock:()=>now});
  assert.equal(second.find(anchor).fresh,true);
  assert.equal(second.find(anchor).sources.length,2);
  assert.equal(second.find(anchor).names.includes('원본에서 가져온 한글 제목'),true);
  assert.equal(second.readSearch('한국 제목').items.length,2);
  now+=7*60*60*1000;
  assert.equal(second.readSearch('한국 제목'),null,'successful query cache expires');
  assert.equal(second.find(anchor).fresh,true,'verified source mapping lives longer than query results');
  now+=29*24*60*60*1000;
  assert.equal(second.find(anchor).fresh,true,'verified connections remain reusable for 30 days');
  now+=24*60*60*1000;
  assert.equal(second.find(anchor).fresh,false,'verified connection TTL triggers revalidation after 30 days');
  second.invalidate(anchor);
  second.flush();
  assert.equal(second.find(anchor).fresh,false);
});

test('corrupted work cache is isolated from official settings and conflicting seasons never merge', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const values=new Map([['contentSource','miruro'],[WORK_INDEX_KEY],['userTheme','dark']]);
  values.set(WORK_INDEX_KEY,'{invalid JSON');
  const storage={getItem:key=>values.get(key)||null,setItem:(key,v)=>values.set(key,String(v))};
  const index=createWorkIndex(storage);
  assert.equal(index.stats().works,0);
  const first=item('reanime','s1',{anilistId:100,year:2023,title:'Same Title'});
  const other=item('miruro','s2',{anilistId:200,year:2026,title:'Same Title'});
  index.remember({sourceItems:[first]},{checked:true});
  index.remember({sourceItems:[other]},{checked:true});
  assert.equal(index.stats().works,2);
  assert.equal(index.find(first).sources.length,1);
  index.flush();
  assert.equal(values.get('contentSource'),'miruro');
  assert.equal(values.get('userTheme'),'dark');
});


test('verified sources, missing matches and transient errors use distinct 30/7/3-day revalidation TTLs', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  let now=1900000000000;
  const stored=new Map();
  const storage={getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,String(value))};
  const idx=createWorkIndex(storage,{clock:()=>now});
  const anchor=item('reanime','test-unique',{title:'Unique Anime',anilistId:777777,year:2026,type:'TV'});
  const other=item('miruro','test-match',{title:'Unique Anime',anilistId:777777,year:2026,type:'TV'});
  const sources={sourceItems:[anchor,other]};
  const DAY=24*60*60*1000;
  idx.remember(sources,{checked:true,attempted:true,outcome:'verified'});
  assert.equal(idx.find(anchor).outcome,'verified');
  now+=29*DAY;
  assert.equal(idx.find(anchor).fresh,true);
  now+=DAY;
  assert.equal(idx.find(anchor).fresh,false,'30-day positive refresh threshold');

  idx.remember(sources,{checked:true,attempted:true,outcome:'missing'});
  assert.equal(idx.find(anchor).outcome,'missing');
  now+=6*DAY;
  assert.equal(idx.find(anchor).fresh,true);
  now+=DAY;
  assert.equal(idx.find(anchor).fresh,false,'7-day verified-missing refresh threshold');

  idx.remember(sources,{attempted:true,outcome:'error'});
  assert.equal(idx.find(anchor).outcome,'error');
  now+=2*DAY;
  assert.equal(idx.find(anchor).fresh,true);
  now+=DAY;
  assert.equal(idx.find(anchor).fresh,false,'3-day transient-error refresh threshold');
  assert.equal(idx.find(anchor).sources.length,2,'cached verified links survive expiry and temporary errors');
  idx.flush();

  const fresh=createWorkIndex(storage,{clock:()=>now});
  assert.equal(fresh.find(anchor).outcome,'error','scan outcome persists after restart');
  assert.equal(fresh.find(anchor).sources.length,2);
  fresh.invalidate(anchor);
  assert.equal(fresh.find(anchor).fresh,false,'manual refresh bypasses all policy TTLs');
  assert.ok(stored.has(WORK_INDEX_KEY));
});

test('old local-index entries without scan outcome stay readable and revalidate after 7 days', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const DAY=24*60*60*1000,now=1900000000000;
  const anchor=item('reanime','older',{title:'Legacy Work',anilistId:987654,year:2024,type:'TV'});
  const old={version:1,works:[{id:'reanime:older',sources:[anchor],names:['Legacy Work'],checkedAt:now-8*DAY,updatedAt:now-8*DAY}],searches:[]};
  const storage={getItem:key=>key===WORK_INDEX_KEY?JSON.stringify(old):null,setItem:()=>{}};
  const idx=createWorkIndex(storage,{clock:()=>now});
  assert.equal(idx.find(anchor).sources.length,1);
  assert.equal(idx.find(anchor).fresh,false);
});


test('five-source observed catalog cards share one work without being counted as verified', () => {
  const {createWorkIndex,PROVIDERS,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const backing=new Map();
  const storage={getItem:key=>backing.get(key)||null,setItem:(key,value)=>backing.set(key,String(value))};
  let now=1900000000000;
  const index=createWorkIndex(storage,{clock:()=>now});
  const base={title:'Common title',title_english:'Common title',year:2026,type:'TV',anilistId:120091};
  const five=PROVIDERS.map((provider,i)=>({...base,provider,id:'s'+i,mal_id:provider+':s'+i}));
  assert.equal(index.observe(five).added,5);
  assert.equal(index.stats().works,1);
  assert.ok(PROVIDERS.every(provider=>index.stats().providers[provider]===1));
  assert.equal(index.find(five[0]).fresh,false);
  assert.equal(index.observe(five).added,0);
  index.remember({sourceItems:five},{checked:true,attempted:true,outcome:'verified'});
  const verified=index.find(five[0]);
  assert.equal(verified.fresh,true);
  const more={...five[0],displayTitle:'동일 작품'};
  assert.equal(index.observe([more]).updated,1,'new known Korean title is retained');
  assert.equal(index.find(more).outcome,'verified','observing original cards never resets successful verification');
  index.flush();
  const restored=createWorkIndex(storage,{clock:()=>now});
  assert.equal(restored.find(more).sources.length,5);
  assert.ok(backing.has(WORK_INDEX_KEY));
  const conflicting={...five[1],id:'new-season',mal_id:'miruro:new-season',anilistId:120092,year:2025};
  assert.equal(restored.observe([conflicting]).added,1);
  assert.equal(restored.stats().works,2,'conflicting years and media IDs remain separate works');
});

test('identical raw source IDs across providers are namespaced in search snapshots', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const backing=new Map();
  const storage={getItem:key=>backing.get(key)||null,setItem:(key,value)=>backing.set(key,String(value))};
  const one={provider:'reanime',id:'a',mal_id:'same-id',anilistId:900101,title:'Shared ID',year:2026,type:'TV'};
  const two={provider:'miruro',id:'b',mal_id:'same-id',anilistId:900101,title:'Shared ID',year:2026,type:'TV'};
  const index=createWorkIndex(storage);
  index.observe([one,two]);
  assert.equal(index.find(one).sources.length,2,'overlapping raw IDs must not overwrite different suppliers');
  index.rememberSearch('Shared ID',{items:[one,two],statuses:[
    {provider:'reanime',state:'ready'},{provider:'miruro',state:'ready'}
  ]});
  assert.equal(index.readSearch('Shared ID').items.length,2);
  assert.deepEqual(index.readSearch('Shared ID').items.map(x=>x.provider),['reanime','miruro']);
  index.flush();
  const stored=JSON.parse(backing.get(WORK_INDEX_KEY));
  assert.equal(stored.searches[0].sourceIds.length,2);
  const restarted=createWorkIndex(storage);
  assert.deepEqual(restarted.readSearch('Shared ID').items.map(x=>x.provider),['reanime','miruro']);

  const old={version:1,works:stored.works,searches:[{...stored.searches[0],sourceIds:['same-id']}]};
  const legacyStore={getItem:key=>key===WORK_INDEX_KEY?JSON.stringify(old):null,setItem:()=>{}};
  assert.equal(createWorkIndex(legacyStore).readSearch('Shared ID'),null,
    'ambiguous legacy snapshots must be rechecked rather than guessed');
});


test('work index can retain 1200 distinct local works across restart without changing official settings', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const backing=new Map([['contentSource','reanime'],['lilacDinoPatch.searchMode','integrated']]);
  const storage={getItem:key=>backing.get(key)||null,setItem:(key,value)=>backing.set(key,String(value))};
  const index=createWorkIndex(storage);
  for(let i=0;i<1200;i++)index.observe([{
    provider:'reanime',id:'growing-'+i,mal_id:'reanime:growing-'+i,
    title:'Growth Work '+i,year:2025,anilistId:210000+i,type:'TV'
  }],{limit:1});
  assert.equal(index.stats().works,1200);
  assert.equal(index.flush(),true);
  const restored=createWorkIndex(storage);
  assert.equal(restored.stats().providers.reanime,1200);
  assert.ok(backing.get(WORK_INDEX_KEY).length<1900000);
  assert.equal(backing.get('contentSource'),'reanime');
  assert.equal(backing.get('lilacDinoPatch.searchMode'),'integrated');
});

test('work index reports disk quota errors and retains retryable in-memory changes', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const backing=new Map();
  let blocked=true;
  const storage={getItem:key=>backing.get(key)||null,setItem:(key,value)=>{
    if(key===WORK_INDEX_KEY&&blocked)throw Error('Quota exceeded');
    backing.set(key,String(value));
  }};
  const index=createWorkIndex(storage);
  index.observe([{provider:'reanime',id:'keep',mal_id:'reanime:keep',title:'Keep Work'}]);
  assert.equal(index.flush(),false);
  assert.equal(backing.has(WORK_INDEX_KEY),false);
  blocked=false;
  assert.equal(index.flush(),true);
  assert.equal(createWorkIndex(storage).stats().works,1);
});


test('one work keeps shared Korean, English and Japanese titles above all five suppliers', () => {
  const {createWorkIndex,PROVIDERS,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const map=new Map([['contentSource','reanime'],['userTheme','dark']]);
  let now=1900000000000;
  const storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v))};
  const idx=createWorkIndex(storage,{clock:()=>now});
  const sources=PROVIDERS.map((provider,i)=>({
    provider,id:'canonical-'+i,mal_id:provider+':canonical-'+i,
    title:i===3?'공급원 한국어 제목':'Japanese Anime Title',
    title_english:'Japanese Anime Title',
    title_japanese:'日本語の作品名',
    year:2026,type:'TV',anilistId:551199
  }));
  const passive=idx.observe(sources);
  assert.equal(passive.added,5);
  assert.equal(idx.stats().works,1,'all five providers share a single work row');
  assert.equal(idx.find(sources[0]).titles.ko,'공급원 한국어 제목');
  assert.equal(idx.find(sources[0]).titles.koSource,'provider');
  assert.equal(idx.find(sources[0]).titles.en,'Japanese Anime Title');
  assert.equal(idx.find(sources[0]).titles.ja,'日本語の作品名');

  now+=1000;
  idx.rememberTitles(sources[1],{ko:'원본에서 확인한 공식 한국어 제목',en:'Official English Title'},
    {source:'official'});
  for(const source of sources){
    assert.equal(idx.find(source).titles.ko,'원본에서 확인한 공식 한국어 제목');
    assert.equal(idx.find(source).titles.koSource,'official');
    assert.equal(idx.find(source).titles.koCheckedAt,now);
    assert.equal(idx.find(source).titles.manual,false);
  }
  idx.flush();
  const data=JSON.parse(map.get(WORK_INDEX_KEY));
  assert.equal(data.works.length,1);
  assert.equal(data.works[0].sources.length,5);
  assert.equal(data.works[0].titles.ko,'원본에서 확인한 공식 한국어 제목');
  assert.equal(data.works[0].sources[3].title,'공급원 한국어 제목',
    'canonical Korean must not replace the site title needed for its API');

  const restarted=createWorkIndex(storage,{clock:()=>now});
  assert.equal(restarted.find(sources[4]).titles.ko,'원본에서 확인한 공식 한국어 제목');
  assert.equal(map.get('contentSource'),'reanime');
  assert.equal(map.get('userTheme'),'dark');
});

test('user-edited Korean title is authoritative and reset allows original resolver again', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const raw=new Map();
  let now=1900000000000;
  const storage={getItem:k=>raw.get(k)||null,setItem:(k,v)=>raw.set(k,String(v))};
  const db=createWorkIndex(storage,{clock:()=>now});
  const a={provider:'reanime',id:'a',mal_id:'reanime:a',title:'Initial Korean? English',
    anilistId:112233,year:2025,type:'TV'};
  const b={provider:'miruro',id:'b',mal_id:'miruro:b',title:'Initial Korean? English',
    anilistId:112233,year:2025,type:'TV'};
  db.observe([a,b]);
  db.rememberTitles(a,{ko:'원본 한국어 제목'}, {source:'official'});
  now+=3000;
  assert.equal(db.rememberTitles(b,{ko:'내가 지정한 대표 제목'}, {source:'manual'}),true);
  assert.equal(db.find(a).titles.manual,true);
  assert.equal(db.find(b).titles.koCheckedAt,now);
  assert.equal(db.rememberTitles(a,{ko:'다시 조회한 한국어 제목'}, {source:'official'}),false);
  db.remember({sourceItems:[{...a,displayTitle:'공급원 표시 제목'}]},
    {checked:true,outcome:'verified'});
  assert.equal(db.find(a).titles.ko,'내가 지정한 대표 제목');
  assert.equal(db.rememberTitles(a,{ko:'English only'}, {source:'manual'}),false,
    'manual edit cannot accidentally remove the only Korean title');
  db.flush();
  const read=createWorkIndex(storage,{clock:()=>now});
  assert.equal(read.find(b).titles.ko,'내가 지정한 대표 제목');
  assert.equal(read.find(b).titles.koSource,'manual');
  assert.equal(read.find(b).titles.manual,true);
  assert.equal(read.resetManualKoreanTitle(b),true);
  assert.equal(read.find(a).titles.manual,false);
  assert.equal(read.find(a).titles.koSource,'provider');
  assert.equal(read.rememberTitles(a,{ko:'다시 조회한 한국어 제목'}, {source:'official'}),true);
  assert.equal(read.find(b).titles.ko,'다시 조회한 한국어 제목');
  read.flush();
  assert.equal(JSON.parse(raw.get(WORK_INDEX_KEY)).works[0].titles.manual,false);
});

test('legacy v1 work caches gain a conservative Korean representative without losing provider IDs', () => {
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const anchor={provider:'ohli24',id:'old',mal_id:'ohli24:old',title:'기존의 한국어 제목',
    title_english:'Older English Name',anilistId:448899,year:2024,type:'TV'};
  const other={provider:'linkani',id:'other',mal_id:'linkani:other',title:'Older English Name',
    anilistId:448899,year:2024,type:'TV'};
  const old={version:1,works:[{id:'ohli24:old',sources:[anchor,other],
    names:['기존의 한국어 제목','Older English Name'],checkedAt:100,
    updatedAt:100,attemptedAt:100,outcome:'verified'}],searches:[]};
  const raw=new Map([[WORK_INDEX_KEY,JSON.stringify(old)]]);
  const storage={getItem:k=>raw.get(k)||null,setItem:(k,v)=>raw.set(k,String(v))};
  const index=createWorkIndex(storage,{clock:()=>200});
  assert.equal(index.stats().works,1);
  assert.equal(index.find(anchor).titles.ko,'기존의 한국어 제목');
  assert.equal(index.find(other).titles.en,'Older English Name');
  assert.equal(index.find(anchor).titles.koSource,'provider');
  assert.equal(index.find(anchor).sources.length,2);
  assert.equal(index.find(anchor).checkedAt,100);
});


test('per-source episode refresh persists independently of work title and provider verification',()=>{
  const {createWorkIndex,WORK_INDEX_KEY}=require('../src/integrated-search.js');
  const map=new Map(), storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v))};
  let now=1900000000000;
  const idx=createWorkIndex(storage,{clock:()=>now});
  const a={provider:'reanime',mal_id:'reanime:airing',id:'airing',
    title:'방영 작품',anilistId:89001,year:2026,status:'airing'};
  const b={...a,provider:'miruro',id:'miruro-airing',mal_id:'miruro:airing',
    title:'Airing Series'};
  idx.observe([a,b]);
  idx.remember({sourceItems:[a,b]},{checked:true,outcome:'verified'});
  idx.rememberTitles(a,{ko:'내가 직접 정한 한국어 작품명'},{source:'manual'});
  const verifiedAt=idx.find(a).checkedAt;
  assert.equal(idx.rememberEpisode(a,{count:10,latest:10}),true);
  assert.equal(idx.episodeState(b),null);
  now+=10000;
  assert.equal(idx.rememberEpisode(b,{count:9,latest:9}),true);
  assert.equal(idx.rememberEpisode(a,{count:11,latest:11}),true);
  assert.equal(idx.episodeState(a).newEpisodes,1);
  assert.equal(idx.episodeState(b).latest,9);
  assert.equal(idx.find(b).checkedAt,verifiedAt,
    'episode refresh must never alter five-provider matching verification');
  assert.equal(idx.find(a).titles.ko,'내가 직접 정한 한국어 작품명');
  assert.equal(idx.find(a).titles.manual,true);
  const previous=idx.episodeState(a);
  now+=1000;
  assert.equal(idx.rememberEpisode(a,null),true);
  assert.equal(idx.episodeState(a).state,'error');
  assert.equal(idx.episodeState(a).latest,11,'provider outage never means zero available episodes');
  assert.equal(idx.episodeState(a).checkedAt,previous.checkedAt);
  idx.flush();
  assert.equal(JSON.parse(map.get(WORK_INDEX_KEY)).works[0].sources.length,2);
  const reloaded=createWorkIndex(storage,{clock:()=>now});
  assert.equal(reloaded.episodeState(a).latest,11);
  assert.equal(reloaded.episodeState(b).latest,9);
  assert.equal(reloaded.find(a).titles.ko,'내가 직접 정한 한국어 작품명');
  reloaded.observe([a]);
  assert.equal(reloaded.episodeState(a).latest,11,
    'passive catalog card must not erase a saved episode snapshot');
});

test('SQLite hydration preserves the newer per-supplier episode snapshot',()=>{
  const {createWorkIndex}=require('../src/integrated-search.js');
  const cache={getItem:()=>null,setItem:()=>{}};
  let now=1900000000000;
  const idx=createWorkIndex(cache,{clock:()=>now});
  const a={provider:'ohli24',id:'show',mal_id:'ohli24:show',title:'한국 작품',year:2026,
    anilistId:77777};
  idx.observe([a]);
  idx.rememberEpisode(a,{count:15,latest:15});
  const older=idx.exportRows()[0];
  now+=100000;
  idx.rememberEpisode(a,{count:16,latest:16});
  idx.importRows([older]);
  assert.equal(idx.episodeState(a).latest,16);
  const newer=structuredClone(idx.exportRows()[0]);
  newer.sources[0].dinoEpisode={...newer.sources[0].dinoEpisode,
    latest:17,count:17,attemptedAt:now+10,checkedAt:now+10,newEpisodes:1};
  idx.importRows([newer]);
  assert.equal(idx.episodeState(a).latest,17,
    'newer SQLite episode state should hydrate the local cache');
});
