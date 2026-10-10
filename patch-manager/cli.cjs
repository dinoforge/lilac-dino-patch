#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const { makeSyntheticFixture, makeFixtureManifest, stageSynthetic }=require('./staging.cjs');
const { inspect }=require('./core.cjs');

function main() {
  if (process.argv.length !== 3 || !['--demo','--help'].includes(process.argv[2])) {
    console.error('Usage: node patch-manager/cli.cjs --demo | --help');
    process.exitCode=2;return;
  }
  if (process.argv[2]==='--help') {
    console.log('Synthetic-only demonstration. Never opens or patches the installed LilacAnime app.');return;
  }
  const fixture=makeSyntheticFixture();
  const manifest=makeFixtureManifest(fixture);
  console.log('Read-only candidate decision:', JSON.stringify(inspect(fixture,manifest)));
  const result=stageSynthetic(fixture,manifest);
  // Deliberately do not clean the fixture or the stage automatically after demonstration.
  // Both are uniquely named, user-inspectable temp folders created by this command.
  console.log('Synthetic preview:',JSON.stringify(result));
  console.log('Staged example contains:',fs.readFileSync(result.stagedRoot+'/src/index.html','utf8').trim());
  console.log('No actual Patch 01/02 integration or update persistence is implemented yet.');
}
try{main()}catch(e){console.error('Stopped safely:',e.message);process.exitCode=1;}
