'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-patch-stage2-electron-'));
const realTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(fs.realpathSync(tempRoot)) !== realTemp || !path.basename(tempRoot).startsWith('lilac-patch-stage2-electron-')) {
  throw new Error('Refusing unexpected Electron test workspace.');
}

let status = 1;
try {
  const result = spawnSync(process.execPath, [
    path.join(repo, 'node_modules', 'electron', 'cli.js'),
    path.join(repo, 'tests', 'patch-manager-stage2-v0514.electron.cjs')
  ], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, LILAC_STAGE2_ELECTRON_TEMP_ROOT: tempRoot }
  });
  if (result.error) throw result.error;
  status = Number.isInteger(result.status) ? result.status : 1;
} finally {
  const current = fs.realpathSync(tempRoot);
  const relative = path.relative(realTemp, current);
  const stat = fs.lstatSync(current);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || stat.isSymbolicLink() ||
      !path.basename(current).startsWith('lilac-patch-stage2-electron-')) {
    throw new Error('Refusing to clean an unexpected Electron test path.');
  }
  fs.rmSync(current, { recursive: true, force: true });
}

process.exitCode = status;
