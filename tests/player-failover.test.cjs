const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const failover = require('../src/player-failover.js');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
const playerSource = fs.readFileSync(path.join(__dirname, '../src/player.js'), 'utf8');

function appFunction(name,nextName){
  let start=appSource.indexOf(`function ${name}(`);const end=appSource.indexOf(`\nfunction ${nextName}(`,start);
  assert.ok(start>=0&&end>start,`Missing app function ${name}`);
  if(appSource.slice(start-6,start)==='async ')start-=6;
  return appSource.slice(start,end);
}

test('provider server filtering rejects unknown kinds, exclusions, and malformed labels', () => {
  const servers = [
    { label: 'SUB A', kind: 'sub' }, { label: 'RAW A', kind: 'raw' },
    { label: 'Soft A', kind: 'soft' }, { label: 'Dub A', kind: 'dub' },
    { label: 'Other', kind: 'unsupported' }, { label: '', kind: 'sub' }, { label: 'SUB A', kind: 'sub' }
  ];
  assert.deepEqual(failover.filterProviderServers(servers, { excludeVideoServers: ['SUB A'] }), servers.slice(1, 4));
  assert.deepEqual(failover.filterProviderServers(servers, { onlyServerKind: 'raw' }), [servers[1]]);
});

test('automatic candidates stay on the current provider server kind and respect the two-switch cap', () => {
  const servers = [
    { label: 'SUB A', kind: 'sub' }, { label: 'RAW A', kind: 'raw' },
    { label: 'SUB B', kind: 'sub' }, { label: 'SUB C', kind: 'sub' },
    { label: 'SUB D', kind: 'sub' }
  ];
  const plan = failover.createPlan({ provider: 'animenosub', servers, currentServer: 'SUB A' });
  assert.deepEqual(plan.candidates, ['SUB B', 'SUB C']);
  assert.equal(plan.kind, 'sub');
  assert.deepEqual(failover.createPlan({ provider: 'reanime', servers, currentServer: 'SUB A' }).candidates, ['SUB B', 'SUB C']);
  assert.equal(failover.createPlan({ provider: 'animenosub', servers, currentServer: 'SUB A', attemptCount: 1 }).candidates.length, 1);
  assert.equal(failover.createPlan({ provider: 'animenosub', servers, currentServer: 'SUB A', attemptCount: 2 }), null);
});

test('failed, offline, unknown-provider, and incompatible candidates are not retried', () => {
  const servers = [{ label: 'RAW A', kind: 'raw' }, { label: 'RAW B', kind: 'raw' }, { label: 'SUB A', kind: 'sub' }];
  assert.deepEqual(failover.createPlan({ provider: 'miruro', servers, currentServer: 'RAW A', failedVideoServers: ['RAW B'] }), null);
  assert.equal(failover.createPlan({ provider: 'linkkf', servers, currentServer: 'RAW A' }), null);
  assert.equal(failover.createPlan({ provider: 'miruro', servers, currentServer: 'RAW A', offline: true }), null);
  assert.equal(failover.createPlan({ provider: 'miruro', servers, currentServer: 'missing' }), null);
});

test('Miruro stall tracking waits for 15 seconds and resets on progress or inactive playback', () => {
  const tracker=failover.createMiruroStallTracker(),context={episode:{provider:'miruro'}},video={currentTime:12,readyState:2,paused:false,seeking:false,ended:false};
  assert.equal(tracker.tick({context,video,active:true,now:1000}),false);
  assert.equal(tracker.tick({context,video,active:true,now:15999}),false);
  assert.equal(tracker.tick({context,video,active:true,now:16000}),true);
  assert.equal(tracker.tick({context,video,active:true,now:30999}),false);
  video.currentTime=12.2;
  assert.equal(tracker.tick({context,video,active:true,now:31000}),false,'progress starts a fresh stall window');
  assert.equal(tracker.tick({context,video,active:true,now:45999}),false);
  video.paused=true;
  assert.equal(tracker.tick({context,video,active:true,now:46000}),false,'a pause resets rather than recovers');
  video.paused=false;
  assert.equal(tracker.tick({context,video,active:true,now:61000}),false,'resume establishes a new baseline');
  assert.equal(tracker.tick({context,video,active:true,now:76000}),true);
});

test('Miruro stall recovery reuses the bounded same-kind server failover and resume point', () => {
  assert.match(playerSource,/createMiruroStallTracker\(\)/);
  assert.match(playerSource,/startAutomaticVideoServerFallback\(hlsPlayer,\s*video\)/);
  assert.match(appSource,/videoServers:Array\.isArray\(stream\.servers\)[\s\S]*videoServer:stream\.server/);
  const calls=[],instance={},video={currentTime:123.5};
  const context=vm.createContext({window:{LilacPlayerFailover:failover},hlsPlayer:instance,
    currentPlaybackContext:{episode:{provider:'miruro',number:4},videoServers:[{label:'SOFT A',kind:'soft'},{label:'SOFT B',kind:'soft'},{label:'SOFT C',kind:'soft'}],videoServer:'SOFT A',subtitleTracks:[]},
    currentSubtitle:null,playbackDuration:()=>600,$:()=>({value:'테스트 작품'}),resolveIntoPlayer:(...args)=>calls.push(args)});
  vm.runInContext(appFunction('startAutomaticVideoServerFallback','bindHlsPlayerEvents'),context);
  assert.equal(context.startAutomaticVideoServerFallback(instance,video),true);
  assert.equal(calls.length,1);
  assert.equal(calls[0][2].serverOverride,'SOFT B');
  assert.equal(calls[0][2].resumeSeconds,123.5);
  assert.deepEqual(calls[0][2].excludeVideoServers,['SOFT A']);
});

test('player seek controls share a clamped setting with the settings page', () => {
  const start=playerSource.indexOf('function setSeekSeconds('),end=playerSource.indexOf('\n$$(',start);
  assert.ok(start>=0&&end>start,'missing setSeekSeconds helper');
  const values=new Map(),inputs={'#seekSeconds':{value:''}};let syncs=0;
  const context=vm.createContext({localStorage:{setItem:(key,value)=>values.set(key,value)},$:selector=>inputs[selector]||null,
    syncPlayerSettingsUI:()=>{syncs++}});
  vm.runInContext(playerSource.slice(start,end),context);
  context.setSeekSeconds('200');
  assert.equal(values.get('seekSeconds'),'120');
  assert.equal(inputs['#seekSeconds'].value,'120');
  context.setSeekSeconds('-5');
  assert.equal(values.get('seekSeconds'),'1');
  assert.equal(syncs,2);
  assert.match(indexSource,/id="psSeekSteps"/);
  assert.match(indexSource,/id="psSeekSeconds"/);
});

test('resolution failures advance through at most two exact server picks and carry exact resume time', () => {
  const context = { episode: { provider: 'miruro', number: 4 }, videoServer: 'SOFT A', selectedSubtitleTrack: 'track-url' };
  const plan = failover.createPlan({ provider: 'miruro', servers: [
    { label: 'SOFT A', kind: 'soft' }, { label: 'SOFT B', kind: 'soft' }, { label: 'SOFT C', kind: 'soft' }, { label: 'SOFT D', kind: 'soft' }
  ], currentServer: context.videoServer });
  const first = failover.begin(context, plan, { resumeSeconds: 321.75, resumeProgress: 42.9 });
  assert.equal(first.serverOverride, 'SOFT B');
  assert.equal(first.serverOnly, true);
  assert.equal(first.resumeSeconds, 321.75);
  assert.equal(first.resumeProgress, 42.9);
  assert.equal(first.resumeMode, 'continue');
  assert.equal(first.selectedSubtitleTrack, 'track-url');
  const second = failover.advance(first);
  assert.equal(second.serverOverride, 'SOFT C');
  assert.deepEqual(second.excludeVideoServers, ['SOFT A', 'SOFT B']);
  assert.equal(failover.advance(second), null);
});

test('main resolver and renderer are wired to the failover policy and exact seek restoration', () => {
  assert.match(mainSource, /require\('\.\.\/src\/player-failover\.js'\)/);
  assert.match(mainSource, /filterProviderServers\(allServers,episode\)/);
  assert.match(mainSource, /if\(episode\.serverOnly\)/);
  assert.match(appSource, /startAutomaticVideoServerFallback\(instance,video\)/);
  assert.match(appSource, /pendingResumeSeconds/);
  assert.match(appSource, /preservedSubtitle/);
  assert.match(indexSource, /player-failover\.js[\s\S]*app\.js/);
});

test('the HLS fallback captures the current second and applied subtitle without changing saved preferences', () => {
  const calls=[],video={currentTime:123.5},instance={};
  const subtitle={src:'file:///cached/chosen.vtt',label:'선택 자막',path:'C:/cached/chosen.vtt',assUrl:null,fonts:[],source:'user'};
  const playback={episode:{provider:'animenosub',name:'4',number:4},videoServers:[
    {label:'SUB A',kind:'sub'},{label:'SUB B',kind:'sub'},{label:'SUB C',kind:'sub'}
  ],videoServer:'SUB A',subtitleTitle:'테스트 작품',subtitleTracks:[{url:'track-url',label:'선택 트랙',language:'ko'}],selectedSubtitleTrack:'track-url'};
  const context=vm.createContext({window:{LilacPlayerFailover:failover},hlsPlayer:instance,currentPlaybackContext:playback,currentSubtitle:subtitle,
    playbackDuration:()=>600,$:()=>({value:'테스트 작품'}),resolveIntoPlayer:(...args)=>calls.push(args)});
  vm.runInContext(appFunction('startAutomaticVideoServerFallback','bindHlsPlayerEvents'),context);
  assert.equal(context.startAutomaticVideoServerFallback(instance,video),true);
  assert.equal(calls.length,1);
  const next=calls[0][2];
  assert.equal(next.serverOverride,'SUB B');
  assert.equal(next.resumeSeconds,123.5);
  assert.ok(Math.abs(next.resumeProgress-(123.5/600*100))<1e-9);
  assert.equal(next.preservedSubtitle.src,subtitle.src);
  assert.equal(next.preservedSubtitleTrack.url,'track-url');
  assert.deepEqual(next.excludeVideoServers,['SUB A']);
});

test('pending fallback restoration seeks to exact seconds before falling back to percentage resume', () => {
  const video={currentTime:0},context=vm.createContext({pendingResumeSeconds:123.5,pendingResumeProgress:40,
    playbackDuration:()=>600,$:()=>video});
  vm.runInContext(appFunction('applyPendingResume','showPlayerControls'),context);
  assert.equal(context.applyPendingResume(),true);
  assert.equal(video.currentTime,123.5);
  assert.equal(context.pendingResumeSeconds,null);
  assert.equal(context.pendingResumeProgress,0);
});

test('renderer resolve, exhausted HLS recovery, exact alternate resolve, and subtitle restoration compose end to end', async () => {
  const providerCalls=[],resolvePromises=[],subtitleApplications=[],storageWrites=[];
  const video={currentTime:0,duration:600,paused:true};
  const streamServers=[{label:'HD-1',kind:'soft'},{label:'HD-2',kind:'soft'}];
  const koreanTrack={url:'https://fixture.invalid/ko.vtt',label:'한국어',language:'ko'};
  const streams={
    first:{url:'https://fixture.invalid/first.m3u8',servers:streamServers,server:'HD-1',subtitleTracks:[koreanTrack]},
    second:{url:'https://fixture.invalid/second.m3u8',servers:streamServers,server:'HD-2',subtitleTracks:[koreanTrack]}
  };
  class FakeHls {
    static Events={MANIFEST_PARSED:'manifest',LEVEL_SWITCHED:'level',FRAG_BUFFERED:'buffered',FRAG_CHANGED:'changed',ERROR:'error'};
    static ErrorDetails={FRAG_PARSING_ERROR:'parse'};
    static ErrorTypes={NETWORK_ERROR:'network',MEDIA_ERROR:'media'};
    constructor(){this.handlers=new Map();this.levels=[];this.startLoadCount=0;this.destroyed=false}
    on(event,handler){this.handlers.set(event,handler)}
    emit(event,data){this.handlers.get(event)?.(event,data)}
    startLoad(){this.startLoadCount++}
    recoverMediaError(){}
    swapAudioCodec(){}
    destroy(){this.destroyed=true}
  }
  const ui={textContent:'',value:'통합 테스트 작품'};
  const context=vm.createContext({
    window:{LilacPlayerFailover:failover,lilac:{providerResolve:async episode=>{providerCalls.push({...episode});return episode.server==='HD-2'?streams.second:streams.first}}},
    Hls:FakeHls,playbackRequestId:0,currentPlaybackContext:{},hlsPlayer:null,currentSubtitle:null,pendingResumeProgress:0,pendingResumeSeconds:null,
    subtitleSelectionRequestId:0,playerFailureHistory:[],video,preparedStreams:new Map(),preparedNext:'',playbackDuration:()=>600,
    $:selector=>selector==='#video'?video:ui,onlineSubtitleFor:()=>Promise.resolve(null),episodeRef:episode=>episode.url,jobByRef:()=>null,downloadedSeries:()=>[],
    renderVideoServers:()=>{},renderSubtitleTracks:()=>{},loadMissingSubtitleTracks:()=>{},ensureSubtitle:async()=>false,
    attachSubtitle:(src,label,options)=>{subtitleApplications.push({src,label,options});context.currentSubtitle={src,label,...options}},
    showPlayerFailure:()=>{throw new Error('unexpected player failure')},toast:()=>{throw new Error('unexpected failure toast')},
    cancelPendingPlaybackLookups(){context.playbackRequestId++},
    showPendingPlayer(name,playback){context.cancelPendingPlaybackLookups();if(context.hlsPlayer){context.hlsPlayer.destroy();context.hlsPlayer=null}video.currentTime=0;context.currentSubtitle=null;context.currentPlaybackContext={...playback,resolving:true};return ++context.playbackRequestId},
    play(url,name,playback){context.playbackRequestId++;context.currentPlaybackContext={...playback,currentUrl:url};context.pendingResumeSeconds=Number(playback.resumeSeconds)>0?Number(playback.resumeSeconds):null;context.pendingResumeProgress=Number(playback.resumeProgress)||0;context.applyPendingResume();const instance=new FakeHls();context.hlsPlayer=instance;context.bindHlsPlayerEvents(instance,video)},
    localStorage:{getItem:()=>null,setItem:(key,value)=>storageWrites.push([key,value])},
    applyDefaultQuality(){},renderQualityChoices(){},scheduleOpEdAnalysis(){},playerSettingsOpen:()=>false
  });
  vm.runInContext([
    appFunction('resolveIntoPlayer','startAutomaticVideoServerFallback'),
    appFunction('startAutomaticVideoServerFallback','bindHlsPlayerEvents'),
    appFunction('bindHlsPlayerEvents','play'),
    appFunction('applyPendingResume','showPlayerControls')
  ].join('\n'),context);
  const resolve= context.resolveIntoPlayer,pending=[];
  context.resolveIntoPlayer=(...args)=>{const promise=resolve(...args);pending.push(promise);return promise};
  const episode={provider:'reanime',name:'1',number:1,url:'https://fixture.invalid/episode'};
  await context.resolveIntoPlayer(()=>context.window.lilac.providerResolve(episode),'통합 테스트 작품 · 1화',
    {episode,subtitleTitle:'통합 테스트 작품',selectedSubtitleTrack:koreanTrack.url},'통합 테스트 작품',1);
  const firstPlayer=context.hlsPlayer;
  context.currentSubtitle={src:'file:///fixture/chosen-ko.vtt',label:'선택한 한국어 자막',path:'C:/fixture/chosen-ko.vtt',source:'user'};
  video.currentTime=120.25;
  for(let attempt=0;attempt<4;attempt++)firstPlayer.emit(FakeHls.Events.ERROR,{fatal:true,type:FakeHls.ErrorTypes.NETWORK_ERROR,details:`network-${attempt}`});
  assert.equal(firstPlayer.startLoadCount,3);
  assert.equal(pending.length,2);
  await pending[1];
  assert.equal(providerCalls.length,2);
  assert.equal(providerCalls[1].server,'HD-2');
  assert.equal(providerCalls[1].serverOnly,true);
  assert.deepEqual(providerCalls[1].excludeVideoServers,['HD-1']);
  assert.equal(context.currentPlaybackContext.videoServer,'HD-2');
  assert.equal(context.currentPlaybackContext.resumeSeconds,120.25);
  assert.equal(video.currentTime,120.25);
  assert.equal(context.pendingResumeSeconds,null);
  assert.equal(context.currentSubtitle.src,'file:///fixture/chosen-ko.vtt');
  assert.equal(context.currentPlaybackContext.selectedSubtitleTrack,koreanTrack.url);
  assert.deepEqual(subtitleApplications.map(item=>item.src),['file:///fixture/chosen-ko.vtt']);
  assert.deepEqual(storageWrites,[]);
});
