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

function markerPath(base) {
  return `${path.resolve(base)}${FIXTURE_MARKER}`;
}

function assertSyntheticFixture(root) {
  const full = fs.realpathSync(root);
  const temp = fs.realpathSync(os.tmpdir());
  const rel = path.relative(temp, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Only synthetic fixtures under the OS temp folder are permitted');
  }
  const marker = markerPath(full);
  if (!fs.existsSync(marker) || !fs.lstatSync(marker).isFile()) throw new Error('Missing synthetic fixture marker');
  const info = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (info.root !== path.basename(full) || info.kind !== 'synthetic' || info.safety !== 'no-real-installation' ||
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

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Fixture contains symlink');
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: false, mode: stat.mode & 0o777 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Fixture contains symlink');
      copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Fixture contains unsupported content');
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(destination, stat.mode & 0o777); } catch {}
}

function makeSyntheticFixture(version='0.5.14') {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid synthetic version');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-patch-manager-fixture-'));
  fs.mkdirSync(path.join(root, 'src'));
  const marker = { root:path.basename(root), kind:'synthetic', safety:'no-real-installation', nonce:crypto.randomBytes(16).toString('hex') };
  fs.writeFileSync(markerPath(root), JSON.stringify(marker), { flag:'wx' });
  fs.writeFileSync(path.join(root, FIXTURE_MARKER), JSON.stringify(marker));
  fs.writeFileSync(path.join(root,'package.json'), JSON.stringify({ name:'synthetic-lilac',version })+'\n');
  fs.writeFileSync(path.join(root,'src','index.html'), '<!doctype html>\n<div id="homeView">\n<!--FIXTURE_SCHEDULE_SLOT-->\n<!--PATCH_FEATURE_SCRIPTS-->\n</div>\n');
  return root;
}

function cleanupSyntheticFixture(root) {
  const full = assertSyntheticFixture(root);
  const temp = fs.realpathSync(os.tmpdir());
  const rel = path.relative(temp, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Refusing to clean a non-fixture path');
  fs.rmSync(full, { recursive:true, force:true });
  fs.rmSync(`${full}.patch-manager`, { recursive:true, force:true });
  fs.rmSync(markerPath(full), { force:true });
}

function makeFixtureManifest(root) {
  return makeFixtureManifestForVersion(root, '0.5.14');
}

function makeFixtureManifestForVersion(root, version) {
  return {
    schema:1, purpose:'isolated-preview',version,
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
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-patch-manager-stage-'));
  const dest = path.join(container, 'app');
  try {
    copyTree(base, dest);
    for (const action of manifest.actions) {
      const file = path.join(dest, ...action.file.split('/'));
      if (action.kind === 'add-file') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(action.contentBase64, 'base64'), { flag: 'wx' });
      } else {
        const source = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, renderPatchedSource(source, action), 'utf8');
      }
    }
    return { status:'staged-synthetic-preview', stagedRoot:dest, stageContainer:container, originalRootUnchanged:true };
  } catch (error) {
    // Only this function's fresh, unique temp folder is eligible for cleanup.
    fs.rmSync(container,{recursive:true,force:true});
    throw error;
  }
}

module.exports={ FIXTURE_MARKER, assertSyntheticFixture, noLinksRecursive, copyTree, makeSyntheticFixture, cleanupSyntheticFixture, makeFixtureManifest, makeFixtureManifestForVersion, stageSynthetic };
