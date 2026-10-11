#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const { makeSyntheticFixture }=require('./staging.cjs');
const { inspect }=require('./core.cjs');
const { makePatch0102Manifest, FIXTURE_VERSION }=require('./feature-payload.cjs');
const { applyPersistent }=require('./persistent.cjs');

function main() {
  if (process.argv.length !== 3 || !['--demo','--help'].includes(process.argv[2])) {
    console.error('Usage: node patch-manager/cli.cjs --demo | --help');
    process.exitCode=2;return;
  }
  if (process.argv[2]==='--help') {
    console.log('Synthetic-only demonstration. Never opens or patches the installed LilacAnime app.');return;
  }
  const fixture=makeSyntheticFixture(FIXTURE_VERSION);
  const manifest=makePatch0102Manifest(fixture);
  console.log('Read-only candidate decision:', JSON.stringify(inspect(fixture,manifest)));
  const result=applyPersistent(fixture,manifest);
  // Deliberately retain this uniquely named, marked fixture for inspection.
  // The demo never accepts a path and cannot target an installed application.
  console.log('Isolated Patch 01/02 payload demo:',JSON.stringify(result));
  console.log('Fixture path:',fixture);
  console.log('Staged scripts:',fs.readFileSync(fixture+'/src/index.html','utf8').trim());
  console.log('This is a synthetic 0.5.9 payload fixture; no official v0.5.14 adapter or updater integration is present.');
}
try{main()}catch(e){console.error('Stopped safely:',e.message);process.exitCode=1;}
