'use strict';

const fs = require('node:fs');
const path = require('node:path');

function canonicalPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('A non-empty path is required.');
  let candidate = path.resolve(input);
  const suffix = [];
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error(`No existing parent can resolve path: ${input}`);
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  return path.resolve(fs.realpathSync.native(candidate), ...suffix);
}

function comparePath(input) {
  const normalized = path.normalize(input).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isSameOrWithin(candidate, parent) {
  const child = canonicalPath(candidate);
  const base = canonicalPath(parent);
  const relative = path.relative(base, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertProjectWorkingDirectory(projectRoot, workingDirectory) {
  const project = canonicalPath(projectRoot);
  const current = canonicalPath(workingDirectory);
  if (comparePath(project) !== comparePath(current)) {
    throw new Error(`Refusing to validate from an unexpected working directory: ${current}`);
  }
  return project;
}

function assertIsolatedTempTarget({ projectRoot, targetRoot, tempRoot }) {
  const project = canonicalPath(projectRoot);
  const temp = canonicalPath(tempRoot);
  const target = canonicalPath(targetRoot);
  if (comparePath(temp) === comparePath(project) || isSameOrWithin(temp, project) || isSameOrWithin(project, temp)) {
    throw new Error('The OS Temp root overlaps the development project.');
  }
  if (comparePath(target) === comparePath(temp) || !isSameOrWithin(target, temp)) {
    throw new Error('The validation target must be a child of the verified OS Temp root.');
  }
  if (isSameOrWithin(target, project) || isSameOrWithin(project, target)) {
    throw new Error('The validation target overlaps the development project.');
  }
  return { projectRoot: project, tempRoot: temp, targetRoot: target };
}

function assertInstallIdentity({ projectRoot, targetRoot, tempRoot, identityFile, expectedVersion, expectedCommit }) {
  const paths = assertIsolatedTempTarget({ projectRoot, targetRoot, tempRoot });
  const identityPath = canonicalPath(identityFile);
  if (!isSameOrWithin(identityPath, paths.tempRoot) || isSameOrWithin(identityPath, paths.targetRoot)) {
    throw new Error('The source identity record must be outside the app tree and inside OS Temp.');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  if (comparePath(canonicalPath(identity.targetRoot)) !== comparePath(paths.targetRoot)) {
    throw new Error('The source identity record does not belong to this validation target.');
  }
  if (identity.officialVersion !== expectedVersion || identity.officialCommit !== expectedCommit || !/^[a-f0-9]{64}$/i.test(identity.archiveSha256 || '')) {
    throw new Error('The official source identity record is missing or invalid.');
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(paths.targetRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== expectedVersion) throw new Error('The validation package version does not match the pinned official version.');
  if (!fs.statSync(path.join(paths.targetRoot, 'package-lock.json')).isFile()) throw new Error('A package-lock.json is required before dependency installation.');
  return { ...paths, identity, packageJson };
}

function installRequested(args) {
  return args.includes('--install-dependencies');
}

module.exports = {
  canonicalPath,
  isSameOrWithin,
  assertProjectWorkingDirectory,
  assertIsolatedTempTarget,
  assertInstallIdentity,
  installRequested
};
