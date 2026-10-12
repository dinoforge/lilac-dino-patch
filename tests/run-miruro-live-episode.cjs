'use strict';
// Explicit, temporary, Windows-only real-provider smoke. Never uses installed user data.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.platform !== 'win32') throw new Error('Windows Electron runner required');
if (process.env.DINO_MIRURO_LIVE_OPT_IN !== '1') throw new Error('Live provider network test requires DINO_MIRURO_LIVE_OPT_IN=1');
const base = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(base, 'dino-miruro-live-fixture-'));
const safe = () => path.dirname(path.resolve(root)) === base &&
  /^dino-miruro-live-fixture-[a-zA-Z0-9_-]+$/.test(path.basename(root)) &&
  fs.existsSync(root) && !fs.lstatSync(root).isSymbolicLink();
if (!safe()) throw new Error('Refusing unexpected temporary workspace');
let code = 1;
try {
  const child = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'node_modules', 'electron', 'cli.js'),
    path.resolve(__dirname, 'miruro-live-episode.electron.cjs')
  ], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', timeout: 180000,
    env: { ...process.env, DINO_MIRURO_LIVE_ROOT: root } });
  if (child.error) throw child.error;
  code = Number.isInteger(child.status) ? child.status : 1;
} catch (error) {
  console.error('miruro_live_test_error=' + error.message);
} finally {
  if (!safe()) throw new Error('Refusing unsafe temporary workspace cleanup');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
}
process.exitCode = code;
