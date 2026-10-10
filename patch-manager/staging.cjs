'use strict';

// This module deliberately cannot patch an installed LilacAnime copy.
// It only copies a uniquely marked, synthetic fixture inside the OS temp root
// to a new temp directory and applies preview insertions to that NEW copy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspect, readVerifiedFile, renderPatchedSource, hashBytes } = require('./core.cjs');

const FIXTURE_MARKER = '.lilac-patch-manager-synthetic-fixture.json';

function assertSyntheticFixture(root) {
  const full = fs.realpathSync(root);
  const temp = fs.realpathSync(os.tmpdir());
  const rel = path.relative(temp, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Only synthetic fixtures under the OS temp folder are permitted');
  }
  const marker = path.join(full, FIXTURE_MARKER);
  if (!fs.existsSync(marker) || !fs.lstatSync(marker).isFile()) throw new Error('Missing synthetic fixture marker');
  const info = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (info.kind !== 'synthetic' || info.safety !== 'no-real-installation' ||
      !/^[a-f0-9]{32}$/.test(info.nonce)) throw new Error('Invalid synthetic fixture marker');
  return full;
}

function noLinksRecursive(base, depth = 0) {
  if (depth > 12) throw new Error('Fixture tree is too deep');
  for (const dirent of fs.readdirSync(base, { withFileTypes: true })) {
    const loc = path.join(base, dirent.name);
    if (dirent.isSymbolicLink()) throw new Error('Fixture contains symlink');
    if (dirent.isDirectory()) noLinksRecursive(loc, depth + 1);
    else if (!dirent.isFile() || fs.statSync(loc).size > 8 * 1024 * 1024)
      throw new Error('Fixture contains unsupported content');
  }
}

function makeSyntheticFixture(version='0.5.14') {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid synthetic version');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-patch-manager-fixture-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, FIXTURE_MARKER), JSON.stringify({
    kind:'synthetic', safety:'no-real-installation', nonce:crypto.randomBytes(16).toString('hex')
  }));
  fs.writeFileSync(path.join(root,'package.json'), JSON.stringify({ name:'synthetic-lilac',version })+'\n');
  fs.writeFileSync(path.join(root,'src','index.html'), '<!doctype html>\n<div id="homeView">\n<!--FIXTURE_SCHEDULE_SLOT-->\n</div>\n');
  return root;
}

function makeFixtureManifest(root) {
  return {
    schema:1, purpose:'isolated-preview',version:'0.5.14',
    expectedFiles:{
      'package.json':hashBytes(readVerifiedFile(root,'package.json')),
      'src/index.html':hashBytes(readVerifiedFile(root,'src/index.html'))
    },
    actions:[{kind:'insert-before',file:'src/index.html',anchor:'<!--FIXTURE_SCHEDULE_SLOT-->',
      content:'<section data-lilac-patch="01-02">요일표/번역 테스트 연결 자리 — 실제 기능 미연결</section>\n'}]
  };
}

function stageSynthetic(root, manifest) {
  const base = assertSyntheticFixture(root);
  noLinksRecursive(base);
  const eligibility = inspect(base, manifest);
  if (eligibility.status !== 'eligible-for-isolated-preview') return { ...eligibility, stagedRoot:null };
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-patch-manager-stage-'));
  try {
    fs.cpSync(base, dest, { recursive: true, force:false, errorOnExist:true, dereference:false });
    for (const action of manifest.actions) {
      const file = path.join(dest, ...action.file.split('/'));
      const source = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, renderPatchedSource(source, action), 'utf8');
    }
    return { status:'staged-synthetic-preview', stagedRoot:dest, originalRootUnchanged:true };
  } catch (error) {
    // Only this function's fresh, unique temp folder is eligible for cleanup.
    fs.rmSync(dest,{recursive:true,force:true});
    throw error;
  }
}

module.exports={ FIXTURE_MARKER, assertSyntheticFixture, makeSyntheticFixture, makeFixtureManifest, stageSynthetic };
