'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DEFAULT_SETTINGS,loadSettings,loadSettingsState,setPatchEnabled,toSettingsJson,settingsFilePath,readSettingsFile,readSettingsFileState,writeSettingsFile,setPatchEnabledAndSave}=require('../settings.cjs');
const {evaluateStructure}=require('../compatibility.cjs');

function fixture(version='0.5.14'){
  return {
    'package.json':JSON.stringify({name:'lilac',version}),
    'electron/main.cjs':"app.whenReady().then(async () => { const subtitleStore=new SubtitleStore({app,reconvert:reconvertSubtitle}); };\nconst providerFetch,REANIME_WEB,ANIMENOSUB_WEB,reanimeItems,miruroApi,miruroItem,miruroHasEpisodes,animenosubList,cheerio;\nasync function resolveProviderEpisode() {}\nasync function resolveStreamPage() {}\n  ipcMain.handle('provider:season', (_, provider) => homeShows(provider,'season'));\n  ipcMain.handle('provider:catalog', fake);\n  ipcMain.handle('provider:detail', fake);\n  ipcMain.handle('provider:resolve', fake);\n  ipcMain.handle('linkkf:home', fake);\n  ipcMain.handle('linkkf:detail', fake);\n  ipcMain.handle('linkkf:episodes', fake);\n  ipcMain.handle('linkkf:resolve', fake);\n  ipcMain.handle('catalog:search-korean', fake);",
    'electron/preload.cjs':"  providerSeason: provider => ipcRenderer.invoke('provider:season', provider),\n  providerCatalog: (provider, query = '', offset = 0, sort = '') => ipcRenderer.invoke('provider:catalog', provider, query, offset, sort),\n  providerDetail: anime => ipcRenderer.invoke('provider:detail', anime),\n  providerResolve: episode => ipcRenderer.invoke('provider:resolve', episode),\n  linkkfHome: (page = 1, limit = 20) => ipcRenderer.invoke('linkkf:home', page, limit),\n  linkkfDetail: id => ipcRenderer.invoke('linkkf:detail', id),\n  linkkfEpisodes: id => ipcRenderer.invoke('linkkf:episodes', id),\n  linkkfResolve: episode => ipcRenderer.invoke('linkkf:resolve', episode),\n  catalogKoreanSearch: (provider, query) => ipcRenderer.invoke('catalog:search-korean', provider, query),",
    'electron/subtitle-store.cjs':"const sources=['gemini'];",
    'src/index.html':'<main id="homeView"><div id="seasonRail"></div><div id="scheduleRail"></div><button id="seeAllSeason"></button><div id="subtitleTranslateRow"></div><section data-settings-pane="translate"></section><div id="videoStage"><video id="video"></video></div><aside id="playerSettings"></aside></main></body>',
    'src/app.js':'function animeById() {}\nfunction renderCards() {}\nfunction resolveIntoPlayer() {}\nfunction mountEpisodeList() {}\nfunction attachSubtitle() {}\nfunction subtitleStoreKey() {}',
    'src/player.js':"function renderQualityChoices() {}\nfunction applyDefaultQuality() {\n  const wanted = parseInt(localStorage.getItem('defaultQuality') || '1080p', 10);\n}"
  };
}
function enabled(p1,p2,p3=false,p4=false){return {patches:{'patch-01':p1,'patch-02':p2,'patch-03':p3,'patch-04':p4}};}

test('one local settings file persists four switches and migrates a legacy Patch 05 key without enabling Patch 03',()=>{
  assert.deepEqual(loadSettings(''),DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(toSettingsJson(enabled(true,false))),enabled(true,false));
  assert.deepEqual(loadSettings('{"patches":{"patch-01":true,"patch-02":false}}'),enabled(true,false));
  const migrated=loadSettingsState('{"patches":{"patch-01":true,"patch-02":false,"patch-03":false,"patch-04":true,"patch-05":true}}');
  assert.deepEqual(migrated,{settings:enabled(true,false,false,true),legacyPatch05:true});
  assert.equal(migrated.settings.patches['patch-03'],false,'legacy Patch 05 never turns Patch 03 on');
  assert.deepEqual(setPatchEnabled(enabled(false,false),'patch-02',true),enabled(false,true));
  const original=enabled(true,false);
  const after=setPatchEnabled(original,'patch-02',true);
  assert.deepEqual(original,enabled(true,false));
  assert.deepEqual(after,enabled(true,true));
  for(const broken of [
    {patches:{'patch-01':'on','patch-02':false}},
    {patches:{'patch-01':false}},
    {patches:{'patch-01':false,'patch-02':false,'patch-03':'on'}},
    {patches:{'patch-01':false,'patch-02':false,'patch-04':true,'patch-05':'on'}}
  ])assert.throws(()=>toSettingsJson(broken));
  assert.throws(()=>setPatchEnabled(original,'unknown',true));
  assert.throws(()=>loadSettings('{bad json'));
});

test('settings persist all 16 combinations in the single DinoLilacPatch/settings.json file',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dino-lilac-settings-'));
  const install=path.join(root,'LilacAnime');
  fs.mkdirSync(install);
  try{
    const file=settingsFilePath(install),directory=path.dirname(file);
    assert.equal(file,path.join(install,'DinoLilacPatch','settings.json'));
    const missingInstall=path.join(root,'MissingLilacAnime');
    assert.throws(()=>writeSettingsFile(missingInstall,enabled(true,false)));
    assert.equal(fs.existsSync(missingInstall),false,'a mistyped app path is never created implicitly');
    assert.deepEqual(readSettingsFile(install),enabled(false,false));
    assert.equal(fs.existsSync(directory),false,'reading a missing settings file does not create extra folders');
    for(const patch01 of [false,true])for(const patch02 of [false,true])for(const patch03 of [false,true])for(const patch04 of [false,true]){
      const selected=enabled(patch01,patch02,patch03,patch04);
      writeSettingsFile(install,selected);
      assert.deepEqual(readSettingsFile(install),selected);
    }
    assert.deepEqual(setPatchEnabledAndSave(install,'patch-01',false),enabled(false,true,true,true));
    assert.deepEqual(readSettingsFile(install),enabled(false,true,true,true));
    fs.writeFileSync(file,'{"patches":{"patch-01":true,"patch-02":false,"patch-03":false,"patch-04":false,"patch-05":true}}','utf8');
    assert.deepEqual(readSettingsFileState(install),{settings:enabled(true,false,false,false),legacyPatch05:true,stored:true});
    writeSettingsFile(install,readSettingsFile(install));
    assert.doesNotMatch(fs.readFileSync(file,'utf8'),/patch-05/,'writing migrated settings removes the retired toggle without changing Patch 03');
    assert.deepEqual(fs.readdirSync(directory),['settings.json'],'the four switches share one settings file and no temp file remains');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('malformed persisted settings fail closed and are not overwritten by a toggle',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dino-lilac-settings-invalid-'));
  const install=path.join(root,'LilacAnime');
  fs.mkdirSync(path.join(install,'DinoLilacPatch'),{recursive:true});
  const file=settingsFilePath(install),invalid='{"patches":{"patch-01":true}}';
  fs.writeFileSync(file,invalid,'utf8');
  try{
    assert.throws(()=>readSettingsFile(install),/could not be read/);
    assert.throws(()=>setPatchEnabledAndSave(install,'patch-02',true),/could not be read/);
    assert.equal(fs.readFileSync(file,'utf8'),invalid);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('all 16 ON/OFF combinations produce independent read-only compatibility reports',()=>{
  for(const a of [false,true])for(const b of [false,true])for(const c of [false,true])for(const d of [false,true]){
    const result=evaluateStructure(fixture(),enabled(a,b,c,d));
    assert.equal(result.patches['patch-01'].status,a?'structural-candidate':'disabled');
    assert.equal(result.patches['patch-02'].status,b?'structural-candidate':'disabled');
    assert.equal(result.patches['patch-03'].status,c?'structural-candidate':'disabled');
    assert.equal(result.patches['patch-04'].status,d?'structural-candidate':'disabled');
    assert.equal(Object.hasOwn(result.patches,'patch-05'),false);
    assert.equal(result.automaticApplyAuthorized,false);
    assert.equal(result.mayWriteInstalledFiles,false);
  }
});

test('Patch 03 compatibility requires the integrated episode list and quality selection hooks',()=>{
  const files=fixture();
  delete files['src/player.js'];
  const report=evaluateStructure(files,enabled(false,false,true,false));
  assert.equal(report.patches['patch-03'].status,'blocked');
  assert.ok(report.patches['patch-03'].issues.some(issue=>issue.file==='src/player.js'));
});

test('legacy standalone Patch 05 payload is rejected as already patched Patch 03 state',()=>{
  const files=fixture();
  files['src/patch-manager-feature-flags.js']='window.DinoLilacPatchFeatures = Object.freeze({"patch-01":false,"patch-02":false,"patch-03":false,"patch-04":false,"patch-05":true});';
  const report=evaluateStructure(files,enabled(false,false,true,false));
  assert.equal(report.patches['patch-03'].status,'blocked');
  assert.ok(report.patches['patch-03'].issues.some(issue=>issue.kind==='already-patched-or-modified'));
});

test('new version with unchanged required structure is a candidate, not a pre-whitelisted version',()=>{
  const newer=evaluateStructure(fixture('12.34.56'),enabled(true,true));
  assert.equal(newer.version,'12.34.56');
  assert.equal(newer.patches['patch-01'].status,'structural-candidate');
  assert.equal(newer.patches['patch-02'].status,'structural-candidate');
  assert.equal(newer.patches['patch-02'].needsIsolatedValidation,true);
  assert.equal(newer.automaticApplyAuthorized,false);
});

test('same version cannot bypass missing or duplicated patch hooks',()=>{
  const files=fixture();
  files['src/index.html']=files['src/index.html'].replace('id="subtitleTranslateRow"','id="removed"');
  let report=evaluateStructure(files,enabled(true,true));
  assert.equal(report.patches['patch-01'].status,'structural-candidate');
  assert.equal(report.patches['patch-02'].status,'blocked');
  assert.ok(report.patches['patch-02'].issues.some(issue=>issue.kind==='missing-point'));
  files['src/index.html']=fixture()['src/index.html'];
  files['electron/main.cjs']+='\n'+files['electron/main.cjs'];
  report=evaluateStructure(files,enabled(true,true));
  assert.equal(report.patches['patch-01'].status,'blocked');
  assert.equal(report.patches['patch-02'].status,'blocked');
  assert.ok(report.patches['patch-01'].issues.some(issue=>issue.kind==='ambiguous-point'));
});

test('patch 01 can be blocked while patch 02 remains a candidate',()=>{
  const files=fixture();
  files['src/index.html']=files['src/index.html'].replace('id="seasonRail"','id="unknownRail"');
  const report=evaluateStructure(files,enabled(true,true));
  assert.equal(report.patches['patch-01'].status,'blocked');
  assert.equal(report.patches['patch-02'].status,'structural-candidate');
});

test('already injected code is not blindly injected again',()=>{
  const files=fixture();
  files['src/index.html']+='<script src="siwc-subtitle-bridge.js"></script>';
  const report=evaluateStructure(files,enabled(true,true));
  assert.equal(report.patches['patch-01'].status,'structural-candidate');
  assert.equal(report.patches['patch-02'].status,'blocked');
  assert.ok(report.patches['patch-02'].issues.some(i=>i.kind==='already-patched-or-modified'));
});

test('the compatibility inspector never mutates a source snapshot',()=>{
  const files=fixture(),original=JSON.stringify(files);
  Object.freeze(files);
  evaluateStructure(files,enabled(true,true));
  assert.equal(JSON.stringify(files),original);
});

const upstream=process.env.LILAC_UPSTREAM_SOURCE||'';
let isolated=false;
try{
  const tmp=fs.realpathSync(os.tmpdir()),source=fs.realpathSync(upstream);
  const rel=path.relative(tmp,source);
  isolated=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel) &&
    fs.statSync(path.join(source,'.git')).isDirectory());
}catch{}
test('official isolated LilacAnime source has independent structural candidates',{
  skip:isolated?false:'No isolated official upstream fixture was supplied'
},()=>{
  const entries=['package.json','electron/main.cjs','electron/preload.cjs','electron/subtitle-store.cjs','src/index.html','src/app.js'];
  const files=Object.fromEntries(entries.map(name=>[name,fs.readFileSync(path.join(upstream,...name.split('/')),'utf8')]));
  const report=evaluateStructure(files,enabled(true,true));
  assert.equal(report.patches['patch-01'].status,'structural-candidate',JSON.stringify(report.patches['patch-01'].issues));
  assert.equal(report.patches['patch-02'].status,'structural-candidate',JSON.stringify(report.patches['patch-02'].issues));
  assert.equal(report.automaticApplyAuthorized,false);
});
