const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempParent = path.resolve(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'lilac-pip-native-'));
const electronCli = path.resolve(__dirname, '../node_modules/electron/cli.js');
const testFile = path.join(__dirname, 'pip-native.electron.cjs');

function removeTaskTemp() {
  const target = path.resolve(tempRoot);
  if (path.dirname(target) !== tempParent || !path.basename(target).startsWith('lilac-pip-native-')) {
    throw new Error(`Refusing to remove unexpected PIP test path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

const child = spawn(process.execPath, [electronCli, testFile], {
  env: { ...process.env, LILAC_PIP_NATIVE_ROOT: tempRoot },
  stdio: 'inherit',
  windowsHide: true
});

child.once('error', error => {
  console.error(error?.stack || error);
  try { removeTaskTemp(); } catch (cleanupError) { console.error(cleanupError?.message || cleanupError); }
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  try { removeTaskTemp(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? (signal ? 1 : 1);
});
