'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const INVALID_SEGMENT = /[<>:"|?*\x00-\x1f]/;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_FILE_BYTES / 3);

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function checkedRelative(input) {
  if (typeof input !== 'string' || !input || input.includes('\\') ||
      path.posix.isAbsolute(input) || input.split('/').some(s => !s || s === '.' || s === '..' ||
        INVALID_SEGMENT.test(s) || /[ .]$/.test(s) || RESERVED_WINDOWS_NAME.test(s))) {
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
  if (!manifest || ![1, 2].includes(manifest.schema) || !['isolated-preview', 'isolated-patch-set'].includes(manifest.purpose) ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.expectedFiles ||
      typeof manifest.expectedFiles !== 'object' || Array.isArray(manifest.expectedFiles) ||
      !Array.isArray(manifest.actions) || !manifest.actions.length) {
    throw new Error('Unsupported patch manifest');
  }
  if (Object.keys(manifest.expectedFiles).length < 2) throw new Error('At least two anchor files required');
  const expectedPaths = new Set();
  for (const [file, hash] of Object.entries(manifest.expectedFiles)) {
    checkedRelative(file);
    if (!SHA256.test(hash)) throw new Error('Invalid SHA-256');
    const normalized = file.toLocaleLowerCase('en-US');
    if (expectedPaths.has(normalized)) throw new Error('Duplicate manifest path');
    expectedPaths.add(normalized);
  }
  const actionPaths = new Set();
  for (const action of manifest.actions) {
    if (!action || !['insert-before', 'add-file'].includes(action.kind)) throw new Error('Unsupported patch action');
    checkedRelative(action.file);
    const normalized = action.file.toLocaleLowerCase('en-US');
    if (actionPaths.has(normalized)) throw new Error('Only one action per target in preview');
    actionPaths.add(normalized);
    if (action.kind === 'insert-before') {
      if (typeof action.anchor !== 'string' || !action.anchor || typeof action.content !== 'string' || !action.content ||
          action.content.length > 20000 || action.anchor.length > 2000 || !Object.hasOwn(manifest.expectedFiles, action.file)) {
        throw new Error('Unverified patch target');
      }
    } else {
      if (typeof action.contentBase64 !== 'string' || !action.contentBase64 || action.contentBase64.length > MAX_BASE64_CHARS) {
        throw new Error('Invalid patch payload');
      }
      const decoded = Buffer.from(action.contentBase64, 'base64');
      if (!decoded.length || decoded.byteLength > MAX_FILE_BYTES || decoded.toString('base64') !== action.contentBase64) {
        throw new Error('Invalid patch payload');
      }
    }
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
    if (action.kind === 'add-file') {
      const target = path.join(fs.realpathSync(root), ...action.file.split('/'));
      if (fs.existsSync(target)) return { status: 'incompatible', reason: 'target-exists', file: action.file };
      continue;
    }
    const source = readVerifiedFile(root, action.file).toString('utf8');
    if (source.split(action.anchor).length !== 2) return { status: 'incompatible', reason: 'anchor-not-unique', file: action.file };
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
