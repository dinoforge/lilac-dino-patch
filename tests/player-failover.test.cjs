const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const failover = require('../src/player-failover.js');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');

function appFunction(name,nextName){
  const start=appSource.indexOf(`function ${name}(`),end=appSource.indexOf(`\nfunction ${nextName}(`,start);
  assert.ok(start>=0&&end>start,`Missing app function ${name}`);
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
