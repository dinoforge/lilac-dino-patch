'use strict';

// Run only against a new OS-temp test profile. It must NEVER use the installed
// LilacAnime app, real Electron profile, user account cookies or user downloads.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const base = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(base, 'dino-chatgpt-logged-out-smoke-'));
const temporary = path.resolve(root);
if (path.dirname(temporary) !== base ||
    !path.basename(temporary).startsWith('dino-chatgpt-logged-out-smoke-') ||
    fs.lstatSync(temporary).isSymbolicLink()) {
  throw new Error('Refusing unsafe temporary test workspace');
}

let code = 1;
try {
  const child = spawnSync(process.execPath, [
    path.join(repo, 'node_modules', 'electron', 'cli.js'),
    path.join(repo, 'tests', 'chatgpt-logged-out-live.electron.cjs')
  ], {
    cwd: repo,
    stdio: 'inherit',
    timeout: 45000,
    env: { ...process.env, DINO_LOGGED_OUT_SMOKE_ROOT: temporary }
  });
  if (child.error) {
    console.error('anonymous_site_smoke_error=' + child.error.message);
  } else {
    code = Number.isInteger(child.status) ? child.status : 1;
  }
} finally {
  try {
    const current = fs.realpathSync(temporary);
    if (path.dirname(current) !== base ||
        !path.basename(current).startsWith('dino-chatgpt-logged-out-smoke-') ||
        fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Refusing unsafe smoke test cleanup');
    }
    fs.rmSync(current, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch (error) {
    console.warn('Anonymous test-only temporary profile cleanup failed: ' + error.message);
    code = 1;
  }
}
process.exitCode = code;
