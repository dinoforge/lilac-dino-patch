'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

// Dino Lilac Patch settings contract. Disk access is explicit and limited to
// DinoLilacPatch/settings.json under the caller-supplied install directory.
const PATCH_IDS=Object.freeze(['patch-01','patch-02']);
const SETTINGS_DIRECTORY='DinoLilacPatch';
const SETTINGS_FILENAME='settings.json';
const MAX_SETTINGS_BYTES=4096;
const DEFAULT_SETTINGS=Object.freeze({
  patches:Object.freeze({'patch-01':false,'patch-02':false})
});
function assertSettings(input){
  if(!input||typeof input!=='object'||Array.isArray(input) ||
    Object.keys(input).some(key=>key!=='patches'))throw new Error('Invalid Dino Lilac Patch settings');
  const patches=input.patches;
  if(!patches||typeof patches!=='object'||Array.isArray(patches) ||
    Object.keys(patches).length!==PATCH_IDS.length ||
    PATCH_IDS.some(id=>!Object.hasOwn(patches,id)||typeof patches[id]!=='boolean')){
    throw new Error('Patch 01 and Patch 02 must each be ON or OFF');
  }
  return {patches:{'patch-01':patches['patch-01'],'patch-02':patches['patch-02']}};
}
function loadSettings(text){
  if(text==null||text==='')return assertSettings(DEFAULT_SETTINGS);
  if(typeof text!=='string'||text.length>4096)throw new Error('Invalid settings file size');
  try{return assertSettings(JSON.parse(text));}
  catch(error){throw new Error('Dino Lilac Patch settings could not be read: '+error.message);}
}
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

function readSettingsFile(installDirectory,{fsImpl=fs}={}){
  const file=settingsFilePath(installDirectory);
  const appDirectory=path.dirname(path.dirname(file)),directory=path.dirname(file);
  if(!safeDirectoryExists(fsImpl,appDirectory,'LilacAnime install path')||
      !safeDirectoryExists(fsImpl,directory,'Dino Lilac Patch settings directory'))return assertSettings(DEFAULT_SETTINGS);
  let stat;
  try{stat=fsImpl.lstatSync(file);}
  catch(error){if(error.code==='ENOENT')return assertSettings(DEFAULT_SETTINGS);throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_SETTINGS_BYTES)throw new Error('Dino Lilac Patch settings file is not a safe regular file');
  return loadSettings(fsImpl.readFileSync(file,'utf8'));
}

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

module.exports={PATCH_IDS,SETTINGS_DIRECTORY,SETTINGS_FILENAME,MAX_SETTINGS_BYTES,DEFAULT_SETTINGS,assertSettings,loadSettings,setPatchEnabled,toSettingsJson,settingsFilePath,readSettingsFile,writeSettingsFile,setPatchEnabledAndSave};
