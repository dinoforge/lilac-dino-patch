'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const electronCli = process.env.LILAC_ELECTRON_CLI || path.join(repo, 'node_modules', 'electron', 'cli.js');
if (!path.isAbsolute(electronCli) || !fs.existsSync(electronCli)) {
  throw new Error('Set LILAC_ELECTRON_CLI to an installed Electron CLI or install the repository dependencies.');
}
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-unified-catalog-electron-'));
const realTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(fs.realpathSync(tempRoot)) !== realTemp || !path.basename(tempRoot).startsWith('lilac-unified-catalog-electron-')) {
  throw new Error('Refusing unexpected isolated Electron workspace.');
}

let status = 1;
try {
  const result = spawnSync(process.execPath, [electronCli, path.join(repo, 'tests', 'unified-catalog.electron.cjs')], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, LILAC_UNIFIED_CATALOG_TEMP_ROOT: tempRoot }
  });
  if (result.error) throw result.error;
  status = Number.isInteger(result.status) ? result.status : 1;
} finally {
  const current = fs.realpathSync(tempRoot), relative = path.relative(realTemp, current), stat = fs.lstatSync(current);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || stat.isSymbolicLink() ||
      !path.basename(current).startsWith('lilac-unified-catalog-electron-')) throw new Error('Refusing to clean an unexpected Electron test path.');
  fs.rmSync(current, { recursive: true, force: true });
}
process.exitCode = status;
