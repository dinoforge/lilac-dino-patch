'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

function missingInstalledArchive(root) {
  const error = new Error(
    `공식 LilacAnime 설치본의 resources/app.asar를 찾지 못했습니다: ${root}. `
    + '앱 업데이트나 파일 교체 중일 수 있으므로 파일이 안정된 뒤 다시 검사합니다.',
  );
  error.code = 'ENOENT';
  return error;
}

/**
 * Filesystem-only snapshot. The installed-layout discriminator must NOT depend
 * on app.asar being present: Windows installers replace it during updates.
 * Otherwise a transient missing archive gets mistaken for a source checkout
 * and package.json ENOENT hides the real problem.
 */
function takeSourceSnapshot(rootValue) {
  const root = fs.realpathSync.native(rootValue);
  const exe = path.join(root, 'LilacAnime.exe');
  const resources = path.join(root, 'resources');
  const installedAsar = path.join(resources, 'app.asar');

  if (fs.existsSync(exe)) {
    // Classify using the installed executable, not the archive's temporary
    // existence or shape. An updater can rename app.asar or resources itself.
    if (!fs.existsSync(resources)) throw missingInstalledArchive(root);
    const resourcesStat = fs.lstatSync(resources);
    if (!resourcesStat.isDirectory() || resourcesStat.isSymbolicLink()) {
      const error = new Error(`설치본 resources가 일반 폴더가 아닙니다: ${resources}`);
      error.code = 'INVALID_ARCHIVE';
      throw error;
    }
    if (!fs.existsSync(installedAsar)) throw missingInstalledArchive(root);
    const stat = fs.lstatSync(installedAsar);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const type = stat.isSymbolicLink() ? '바로가기 또는 링크'
        : stat.isDirectory() ? '폴더' : '일반 파일이 아닌 항목';
      const error = new Error(
        `공식 설치본의 resources/app.asar가 파일이 아니라 ${type}입니다: ${installedAsar}. `
        + '자동 감시는 중단하지만 수동 패치 적용 시 독립 검사를 할 수 있습니다. '
        + '정상적인 ASAR 파일인지 확인하세요.',
      );
      error.code = 'INVALID_ARCHIVE';
      throw error;
    }
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(installedAsar, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let length;
      while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, length));
      }
    } finally {
      fs.closeSync(fd);
    }
    const digest = hash.digest('hex').toUpperCase();
    return {
      root, version: 'installed-asar',
      files: { 'resources/app.asar': digest },
      directories: [root, resources],
      signature: digest,
    };
  }

  const files = Object.create(null);
  const directories = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    directories.push(directory);
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (directory === root && entry.name === 'DinoPatchManager') continue;
      if (SOURCE_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`공식 소스 감시 경로에 심볼릭 링크 또는 junction이 있습니다: ${path.relative(root, fullPath)}`);
      }
      if (stat.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`공식 소스 감시 대상에 일반 파일이 아닌 항목이 있습니다: ${path.relative(root, fullPath)}`);
      const relative = path.relative(root, fullPath).split(path.sep).join('/');
      files[relative] = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex').toUpperCase();
    }
  }
  const packagePath = path.join(root, 'package.json');
  const packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (typeof packageInfo.version !== 'string') throw new Error('공식 package.json에 버전 문자열이 없습니다.');
  const hash = crypto.createHash('sha256');
  for (const relative of Object.keys(files).sort()) {
    hash.update(relative, 'utf8').update('\0').update(files[relative], 'ascii').update('\n');
  }
  return { root, version: packageInfo.version, files, directories: directories.sort(), signature: hash.digest('hex').toUpperCase() };
}

module.exports = { takeSourceSnapshot };
