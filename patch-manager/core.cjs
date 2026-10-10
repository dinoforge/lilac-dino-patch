'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RELATIVE = /^(?!\.{1,2}(?:[\\/]|$))(?!.*(?:^|[\\/])\.{1,2}(?:[\\/]|$))[a-zA-Z0-9_.\-/]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function checkedRelative(input) {
  if (typeof input !== 'string' || !RELATIVE.test(input) || input.includes('\\') ||
      path.posix.isAbsolute(input) || input.split('/').some(s => !s || s === '.' || s === '..')) {
    throw new Error('Invalid relative path in patch manifest');
  }
  return input;
}

function readVerifiedFile(root, relative) {
  const clean = checkedRelative(relative);
  const base = fs.realpathSync(root);
  const parts = clean.split('/');
  let candidate = base;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    candidate = path.join(candidate, part);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error('Symlink is forbidden in candidate app tree');
    if (i !== parts.length - 1 && !stat.isDirectory()) throw new Error('Expected directory');
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Unexpected file type or size');
  return fs.readFileSync(candidate);
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || manifest.purpose !== 'isolated-preview' ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.expectedFiles ||
      typeof manifest.expectedFiles !== 'object' || Array.isArray(manifest.expectedFiles) ||
      !Array.isArray(manifest.actions) || !manifest.actions.length) {
    throw new Error('Unsupported patch manifest');
  }
  if (Object.keys(manifest.expectedFiles).length < 2) throw new Error('At least two anchor files required');
  const seen = new Set();
  for (const [file, hash] of Object.entries(manifest.expectedFiles)) {
    checkedRelative(file);
    if (!SHA256.test(hash)) throw new Error('Invalid SHA-256');
  }
  for (const action of manifest.actions) {
    if (!action || action.kind !== 'insert-before' || typeof action.anchor !== 'string' ||
        !action.anchor || typeof action.content !== 'string' || !action.content ||
        action.content.length > 20000 || action.anchor.length > 2000) throw new Error('Unsupported patch action');
    checkedRelative(action.file);
    if (!Object.hasOwn(manifest.expectedFiles, action.file)) throw new Error('Unverified patch target');
    if (seen.has(action.file)) throw new Error('Only one action per target in preview');
    seen.add(action.file);
  }
  return manifest;
}

function inspect(root, manifest) {
  validateManifest(manifest);
  let version;
  try {
    const pkg = JSON.parse(readVerifiedFile(root, 'package.json').toString('utf8'));
    version = String(pkg.version || '');
  } catch (error) {
    return { status: 'incompatible', reason: 'package-unreadable', detail: error.message };
  }
  if (version !== manifest.version) return { status: 'incompatible', reason: 'version-unverified', version };
  for (const [file, expected] of Object.entries(manifest.expectedFiles)) {
    let actual;
    try { actual = hashBytes(readVerifiedFile(root, file)); }
    catch (error) { return { status: 'incompatible', reason: 'file-unreadable', file, detail: error.message }; }
    if (actual !== expected) return { status: 'incompatible', reason: 'hash-mismatch', file };
  }
  for (const action of manifest.actions) {
    const source = readVerifiedFile(root, action.file).toString('utf8');
    if (source.split(action.anchor).length !== 2) {
      return { status: 'incompatible', reason: 'anchor-not-unique', file: action.file };
    }
    if (source.includes(action.content)) return { status: 'incompatible', reason: 'already-modified', file: action.file };
  }
  return { status: 'eligible-for-isolated-preview', version };
}

function renderPatchedSource(source, action) {
  if (source.split(action.anchor).length !== 2 || source.includes(action.content)) {
    throw new Error('Unsafe or already-patched file');
  }
  return source.replace(action.anchor, action.content + action.anchor);
}

module.exports = { hashBytes, checkedRelative, readVerifiedFile, validateManifest, inspect, renderPatchedSource };
