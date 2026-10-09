// Launch the packaged Electron app twice against one disposable profile to verify that
// the settings source survives a full process exit, not only a renderer reload.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const electron = require('electron');
const probe = path.join(__dirname, 'phase1-main.electron.cjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-source-restart-'));

function runProcess(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [probe], {
      cwd: repo,
      windowsHide: true,
      env: {
        ...process.env,
        LILAC_PHASE1_RESTART_MODE: mode,
        LILAC_PHASE1_SHARED_ROOT: tempRoot
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      const output = stdout + stderr;
      if (timedOut) return reject(new Error(`${mode} Electron process timed out.\n${output}`));
      if (code !== 0) return reject(new Error(`${mode} Electron process exited ${code ?? signal}.\n${output}`));
      const marker = `Source restart ${mode} passed:`;
      try {
        assert.ok(stdout.includes(marker), `${mode} process printed its success marker.\n${output}`);
        resolve(stdout.trim());
      } catch (error) { reject(error); }
    });
  });
}

(async () => {
  try {
    const seeded = await runProcess('seed');
    console.log(seeded);
    const restored = await runProcess('verify');
    console.log(restored);
    console.log('Packaged source setting survived a full Electron process exit and restart with the same isolated profile.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
