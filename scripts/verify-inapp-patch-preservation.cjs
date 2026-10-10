#!/usr/bin/env node
'use strict';

// Static preservation gate for the patch 01/02 + upstream in-app integration.
// This is NOT a substitute for runtime/provider/Windows tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');
const errors = [];
function assert(value, description) { if (!value) errors.push(description); }
function mustContain(file, values) {
  const content = read(file);
  for(const value of values) assert(content.includes(value), file + ' missing ' + value);
}
const promptHashes = {
  'docs/prompts/영어 번역 프롬프트.txt': '582eaf421cabbcf89279579e5723aa07b070e5b1df2e28ee044994b2e951e37e',
  'docs/prompts/일본어 번역 프롬프트.txt': '9ff7e860cf0c79396621c2ef65b364596ebb884aa5b3ce68e60ab0d4b42ec584',
  'docs/prompts/Reazon_작품용_단어사전_예시.txt': '2dcb15b42d31bd6413d74e9a91303f0055574e030f875720cb1a1c07b814ccf8'
};

try {
  for (const [file,digest] of Object.entries(promptHashes)) {
    assert(fs.existsSync(path.join(root,file)), 'missing original prompt: '+file);
    if (fs.existsSync(path.join(root,file))) assert(sha256(file)===digest, 'original prompt changed: '+file);
  }
  const patchFiles = [
    'src/quarter-selection.js', 'src/weekday-schedule.js', 'src/manual-subtitle-translation.js',
    'electron/weekday-episodes.cjs', 'electron/translation-prompts.cjs',
    'tests/quarter-catalog.test.cjs','tests/weekday-schedule.test.cjs',
    'tests/manual-subtitle-translation.test.cjs','tests/translation-prompts.test.cjs'
  ];
  for(const p of patchFiles) assert(fs.existsSync(path.join(root,p)), 'missing patch code/test: '+p);
  mustContain('electron/main.cjs', ['provider:quarter','provider:weekday-episodes','subtitle:translation-prompt','clipboard:copy-text']);
  mustContain('electron/preload.cjs', ['providerQuarter','providerWeekdayEpisodes','translationPrompt','copyText']);
  mustContain('src/app.js', ['openWeekdayScheduleAnime','checkWeekdaySourceEpisodes','LilacQuarterSelection','manualChatgptPanel']);
  mustContain('src/index.html', ['scheduleTabs','scheduleRail','manualChatgptRow','manualChatgptPanel','translateChatgpt']);
  const html=read('src/index.html');
  for(const p of ['reanime','miruro','animenosub','ohli24','linkkf']) {
    assert(html.includes('value="'+p+'"')||html.includes("value='"+p+"'"), 'missing selectable source: '+p);
  }
  assert(!/\bvalue\s*=\s*["']linkani["']/i.test(html), 'LinkAni selectable source reintroduced');
  assert(!/data-source\s*=\s*["']linkani["']/i.test(html), 'LinkAni source button reintroduced');
  const pkg=JSON.parse(read('package.json'));
  const included=pkg.build?.files || [];
  for(const p of ['electron/**/*','src/**/*','docs/prompts/**/*'])
    assert(included.includes(p), 'packaged files missing: '+p);
  // "nextEpisode" is a MANUAL control in the original player, not auto-play.
  // Automated next-episode prevention MUST be confirmed with behavioral tests,
  // not an unreliable ban on the word 'autoplay' used by media player policy.
} catch(error) {
  errors.push(String(error?.stack||error));
}
if(errors.length) {
  console.error('IN-APP PRESERVATION GATE FAILED ('+errors.length+')');
  for(const error of errors) console.error('- '+error);
  process.exitCode=1;
} else {
  console.log('Patch 01/02 static preservation gate PASSED.');
  console.log('Still required: test suite, isolated unpacked Electron UI, provider and Windows compatibility, no next-episode autoplay.');
}
