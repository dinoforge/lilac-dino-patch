const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--native-pip') || args.filter(arg => arg === '--native-pip').length > 1) {
  throw new Error(`Unknown Phase 1 main test options: ${args.join(' ')}`);
}
const nativePip = args.includes('--native-pip');
const tempParent = path.resolve(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'lilac-phase1-main-'));
const electronCli = path.resolve(__dirname, '../node_modules/electron/cli.js');
const testFile = path.join(__dirname, 'phase1-main.electron.cjs');

function removeTaskTemp() {
  const target = path.resolve(tempRoot);
  if (path.dirname(target) !== tempParent || !/^lilac-phase1-main-[A-Za-z0-9_-]+$/.test(path.basename(target))) {
    throw new Error(`Refusing to remove unexpected Phase 1 test path: ${target}`);
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove a non-directory or linked Phase 1 test path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

async function main() {
  let exitCode = 1;
  try {
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [electronCli, testFile], {
        env: {
          ...process.env,
          LILAC_PHASE1_TEMP_ROOT: tempRoot,
          LILAC_PHASE1_NATIVE_PIP: nativePip ? '1' : ''
        },
        stdio: 'inherit',
        windowsHide: true
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 1)));
    });
  } finally {
    removeTaskTemp();
  }
  process.exitCode = exitCode;
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
