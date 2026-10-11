'use strict';

// Dino Lilac Patch settings contract. No disk I/O here: the future manager UI
// may store exactly this JSON beside DinoLilacPatch.exe after user interaction.
const PATCH_IDS=Object.freeze(['patch-01','patch-02']);
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
module.exports={PATCH_IDS,DEFAULT_SETTINGS,assertSettings,loadSettings,setPatchEnabled,toSettingsJson};
