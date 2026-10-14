'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

// Dino Lilac Patch settings contract. Disk access is explicit and limited to
// DinoLilacPatch/settings.json under the caller-supplied install directory.
const PATCH_IDS=Object.freeze(['patch-01','patch-02','patch-03','patch-04']);
const SETTINGS_DIRECTORY='DinoLilacPatch';
const SETTINGS_FILENAME='settings.json';
const MAX_SETTINGS_BYTES=4096;
const DEFAULT_SETTINGS=Object.freeze({
  patches:Object.freeze({'patch-01':false,'patch-02':false,'patch-03':false,'patch-04':false})
});
function assertSettings(input){
  if(!input||typeof input!=='object'||Array.isArray(input) ||
    Object.keys(input).some(key=>key!=='patches'))throw new Error('Invalid Dino Lilac Patch settings');
  const patches=input.patches;
  if(!patches||typeof patches!=='object'||Array.isArray(patches) ||
    Object.keys(patches).some(id=>!PATCH_IDS.includes(id)&&id!=='patch-05') ||
    !Object.hasOwn(patches,'patch-01') || !Object.hasOwn(patches,'patch-02') ||
    typeof patches['patch-01']!=='boolean' || typeof patches['patch-02']!=='boolean' ||
    Object.hasOwn(patches,'patch-03')&&typeof patches['patch-03']!=='boolean' ||
    Object.hasOwn(patches,'patch-04')&&typeof patches['patch-04']!=='boolean' ||
    Object.hasOwn(patches,'patch-05')&&typeof patches['patch-05']!=='boolean'){
    throw new Error('Patch 01 through Patch 04 must each be ON or OFF');
  }
  // Patch 05 was merged into Patch 03. Drop its legacy key and preserve the
  // saved Patch 03 value exactly; a legacy Patch 05 selection never enables it.
  return {patches:{
    'patch-01':patches['patch-01'],
    'patch-02':patches['patch-02'],
    'patch-03':patches['patch-03']===true,
    'patch-04':patches['patch-04']===true
  }};
}
function loadSettingsState(text){
  if(text==null||text==='')return {settings:assertSettings(DEFAULT_SETTINGS),legacyPatch05:false};
  if(typeof text!=='string'||text.length>4096)throw new Error('Invalid settings file size');
  try{
    const parsed=JSON.parse(text);
    return {settings:assertSettings(parsed),legacyPatch05:Object.hasOwn(parsed?.patches||{},'patch-05')};
  }
  catch(error){throw new Error('Dino Lilac Patch settings could not be read: '+error.message);}
}
function loadSettings(text){return loadSettingsState(text).settings;}
function setPatchEnabled(current,id,enabled){
  const checked=assertSettings(current);
  if(!PATCH_IDS.includes(id)||typeof enabled!=='boolean')throw new Error('Unknown patch toggle');
  checked.patches[id]=enabled;
  return checked;
}
function toSettingsJson(current){return JSON.stringify(assertSettings(current),null,2)+'\n';}

function settingsFilePath(installDirectory){
  if(typeof installDirectory!=='string'||!installDirectory.trim())throw new TypeError('LilacAnime install directory is required');
  return path.join(path.resolve(installDirectory),SETTINGS_DIRECTORY,SETTINGS_FILENAME);
}

function safeDirectoryExists(fsImpl,directory,label){
  let stat;
  try{stat=fsImpl.lstatSync(directory);}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`${label} is not a safe directory`);
  return true;
}

function readSettingsFileState(installDirectory,{fsImpl=fs}={}){
  const file=settingsFilePath(installDirectory);
  const appDirectory=path.dirname(path.dirname(file)),directory=path.dirname(file);
  if(!safeDirectoryExists(fsImpl,appDirectory,'LilacAnime install path')||
      !safeDirectoryExists(fsImpl,directory,'Dino Lilac Patch settings directory'))return {settings:assertSettings(DEFAULT_SETTINGS),legacyPatch05:false,stored:false};
  let stat;
  try{stat=fsImpl.lstatSync(file);}
  catch(error){if(error.code==='ENOENT')return {settings:assertSettings(DEFAULT_SETTINGS),legacyPatch05:false,stored:false};throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_SETTINGS_BYTES)throw new Error('Dino Lilac Patch settings file is not a safe regular file');
  return {...loadSettingsState(fsImpl.readFileSync(file,'utf8')),stored:true};
}
function readSettingsFile(installDirectory,options){return readSettingsFileState(installDirectory,options).settings;}

function writeSettingsFile(installDirectory,current,{fsImpl=fs}={}){
  const settings=assertSettings(current);
  const file=settingsFilePath(installDirectory),directory=path.dirname(file),appDirectory=path.dirname(directory);
  if(!safeDirectoryExists(fsImpl,appDirectory,'LilacAnime install path'))throw new Error('LilacAnime install path does not exist');
  try{fsImpl.mkdirSync(directory);}
  catch(error){if(error.code!=='EEXIST')throw error;}
  if(!safeDirectoryExists(fsImpl,directory,'Dino Lilac Patch settings directory'))throw new Error('Dino Lilac Patch settings directory could not be created');
  try{
    const existing=fsImpl.lstatSync(file);
    if(!existing.isFile()||existing.isSymbolicLink())throw new Error('Dino Lilac Patch settings file is not a safe regular file');
  }catch(error){if(error.code!=='ENOENT')throw error;}

  const temporary=path.join(directory,`.settings-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  try{
    descriptor=fsImpl.openSync(temporary,'wx',0o600);
    fsImpl.writeFileSync(descriptor,toSettingsJson(settings),'utf8');
    try{fsImpl.fsyncSync(descriptor);}catch{}
    fsImpl.closeSync(descriptor);
    descriptor=undefined;
    fsImpl.renameSync(temporary,file);
  }catch(error){
    if(descriptor!==undefined)try{fsImpl.closeSync(descriptor);}catch{}
    try{fsImpl.unlinkSync(temporary);}catch{}
    throw error;
  }
  return settings;
}

function setPatchEnabledAndSave(installDirectory,id,enabled,{fsImpl=fs}={}){
  const updated=setPatchEnabled(readSettingsFile(installDirectory,{fsImpl}),id,enabled);
  return writeSettingsFile(installDirectory,updated,{fsImpl});
}

module.exports={PATCH_IDS,SETTINGS_DIRECTORY,SETTINGS_FILENAME,MAX_SETTINGS_BYTES,DEFAULT_SETTINGS,assertSettings,loadSettings,loadSettingsState,setPatchEnabled,toSettingsJson,settingsFilePath,readSettingsFile,readSettingsFileState,writeSettingsFile,setPatchEnabledAndSave};
