const {test}=require('node:test'),assert=require('node:assert/strict');
const failover=require('../src/player-failover.js');

function setup({kind='soft',failed=[]}={}){
  const tracker=failover.createMiruroStallTracker(),video={paused:false,seeking:false,ended:false,currentTime:60,readyState:2};
  const context={episode:{provider:'miruro',number:1},videoServer:'bad',videoServers:[{label:'bad',kind},{label:'good',kind}],miruroFailedServers:failed};
  return{context,video,tick:(now,active=true)=>tracker.tick({context,video,active,now})};
}

test('15 seconds without playback progress triggers one bounded same-kind server switch with the saved position',()=>{
  const run=setup();
  assert.equal(run.tick(0),false);assert.equal(run.tick(14999),false);assert.equal(run.tick(15000),true);
  const plan=failover.createPlan({provider:'miruro',servers:run.context.videoServers,currentServer:run.context.videoServer,
    failedVideoServers:run.context.miruroFailedServers,attemptCount:0});
  const next=failover.begin(run.context,plan,{resumeSeconds:60,resumeProgress:50});
  assert.equal(next.serverOverride,'good');assert.equal(next.resumeProgress,50);assert.equal(next.resumeSeconds,60);
  assert.deepEqual(next.excludeVideoServers,['bad']);
  assert.equal(run.tick(30000),true,'a continued stall may signal again; the shared failover cap prevents another unbounded switch');
});

test('pause, seek, inactivity, offline playback, and progress reset stall detection',()=>{
  for(const flag of ['paused','seeking']){
    const run=setup();assert.equal(run.tick(0),false);run.video[flag]=true;assert.equal(run.tick(20000),false);run.video[flag]=false;
    assert.equal(run.tick(20001),false);assert.equal(run.tick(35001),true);
  }
  const hidden=setup();assert.equal(hidden.tick(0),false);assert.equal(hidden.tick(20000,false),false);assert.equal(hidden.tick(20001),false);assert.equal(hidden.tick(35001),true);
  const offline=setup();offline.context.offline=true;assert.equal(offline.tick(0),false);assert.equal(offline.tick(20000),false);
  const progress=setup();assert.equal(progress.tick(0),false);progress.video.currentTime=61;assert.equal(progress.tick(10000),false);assert.equal(progress.tick(20000),false);assert.equal(progress.tick(25000),true);
});

test('recovery does not switch to another audio kind and stops when candidates are exhausted',()=>{
  const dubbed=setup();dubbed.context.videoServers[1].kind='dub';
  assert.equal(dubbed.tick(0),false);assert.equal(dubbed.tick(15000),true);
  const incompatible=failover.createPlan({provider:'miruro',servers:dubbed.context.videoServers,currentServer:'bad'});
  assert.equal(incompatible,null);
  const exhausted=setup({failed:['bad','good']});
  assert.equal(exhausted.tick(0),false);assert.equal(exhausted.tick(15000),true);
  assert.equal(failover.createPlan({provider:'miruro',servers:exhausted.context.videoServers,currentServer:'bad',failedVideoServers:exhausted.context.miruroFailedServers}),null);
});

test('automatic recovery still resumes exact seconds at the end of a video',()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const app=fs.readFileSync(path.resolve(__dirname,'../src/app.js'),'utf8');
  const at=app.indexOf('function applyPendingResume()'),end=app.indexOf('\n',at);
  const video={currentTime:0},context={pendingResumeSeconds:118,pendingResumeProgress:0,$:()=>video,playbackDuration:()=>120};
  vm.createContext(context);vm.runInContext(app.slice(at,end),context);
  assert.equal(context.applyPendingResume(),true);assert.equal(video.currentTime,118);assert.equal(context.pendingResumeSeconds,null);
});
