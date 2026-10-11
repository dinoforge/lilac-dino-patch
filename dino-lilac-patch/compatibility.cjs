'use strict';

const {assertSettings,PATCH_IDS}=require('./settings.cjs');

// Read-only structural probes. This file intentionally does NOT import fs,
// manipulate app.asar, recognize arbitrary versions as safe, or patch any path.
// Probes are based on connection points of the official v0.5.14 source.
// A passing probe is only a CANDIDATE for further isolated runtime testing.
const SHARED=Object.freeze([
  {file:'electron/main.cjs',needle:"  ipcMain.handle('provider:season', (_, provider) => homeShows(provider,'season'));",one:true},
  {file:'electron/preload.cjs',needle:"  providerSeason: provider => ipcRenderer.invoke('provider:season', provider),",one:true},
  {file:'src/index.html',needle:'</body>',one:true}
]);
const CONTRACTS=Object.freeze({
  'patch-01':Object.freeze([
    {file:'src/index.html',needle:'id="seasonRail"',one:true},
    {file:'src/index.html',needle:'id="scheduleRail"',one:true},
    {file:'src/app.js',needle:'function animeById(',one:true},
    {file:'src/app.js',needle:'function renderCards(',one:true}
  ]),
  'patch-02':Object.freeze([
    {file:'src/index.html',needle:'id="subtitleTranslateRow"',one:true},
    {file:'src/index.html',needle:'data-settings-pane="translate"',one:true},
    {file:'src/app.js',needle:'function attachSubtitle(',one:true},
    {file:'src/app.js',needle:'function subtitleStoreKey(',one:true},
    {file:'electron/subtitle-store.cjs',needle:"'gemini'];",one:true}
  ])
});
const ALREADY_PATCHED=Object.freeze({
  'patch-01':Object.freeze([
    {file:'src/index.html',needle:'patch-manager-stage2-core.js'}
  ]),
  'patch-02':Object.freeze([
    {file:'src/index.html',needle:'siwc-subtitle-bridge.js'},
    {file:'src/index.html',needle:'manual-subtitle-translation.js'}
  ])
});

function probe(files,rule){
  const content=files[rule.file];
  if(typeof content!=='string'||content.length>8_000_000)
    return {kind:'unreadable',file:rule.file};
  const count=content.split(rule.needle).length-1;
  if(!count)return {kind:'missing-point',file:rule.file,point:rule.needle.slice(0,100)};
  if(rule.one&&count!==1)return {kind:'ambiguous-point',file:rule.file,point:rule.needle.slice(0,100),count};
  return null;
}

function evaluateStructure(files,settings){
  const selected=assertSettings(settings);
  if(!files||typeof files!=='object'||Array.isArray(files))throw new TypeError('Isolated source snapshot is required');
  // Version is only informative. An unseen version can still be a structural
  // candidate. An old "supported version" can still fail these probes.
  let version='unknown';
  try{
    const raw=files['package.json'];
    if(typeof raw==='string' && raw.length<200_000){
      const parsed=JSON.parse(raw);
      if(typeof parsed.version==='string'&&/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(parsed.version)) version=parsed.version;
    }
  }catch{/* version is not sufficient evidence of compatibility */}
  const patches={};
  for(const id of PATCH_IDS){
    if(!selected.patches[id]){
      patches[id]={selection:'off',status:'disabled',issues:[],needsIsolatedValidation:false};
      continue;
    }
    const issues=[];
    for(const rule of [...SHARED,...CONTRACTS[id]]){
      const failure=probe(files,rule);
      if(failure)issues.push(failure);
    }
    for(const marker of ALREADY_PATCHED[id]){
      if(typeof files[marker.file]==='string' && files[marker.file].includes(marker.needle))
        issues.push({kind:'already-patched-or-modified',file:marker.file,point:marker.needle});
    }
    patches[id]={
      selection:'on',status:issues.length?'blocked':'structural-candidate',
      issues,needsIsolatedValidation:issues.length===0
    };
  }
  const candidates=PATCH_IDS.filter(id=>patches[id].status==='structural-candidate');
  const blocked=PATCH_IDS.filter(id=>patches[id].status==='blocked');
  return {
    version,patches,candidates,blocked,
    status:blocked.length?'partially-or-fully-blocked':
      candidates.length?'awaiting-isolated-validation':'all-disabled',
    mayWriteInstalledFiles:false,
    // A structural match cannot prove semantics, UI safety or update stability.
    automaticApplyAuthorized:false
  };
}
module.exports={SHARED,CONTRACTS,ALREADY_PATCHED,evaluateStructure};
