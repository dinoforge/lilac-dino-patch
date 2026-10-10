// Bundles the JASSUB (libass WebAssembly) ASS renderer into src/vendor/jassub so the
// renderer can load it without a bundler. Runs before `npm start` and `npm run dist`.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'jassub', 'dist');
const out = path.join(root, 'src', 'vendor', 'jassub');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'worker'), { recursive: true });
fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'inline',
  logLevel: 'warning',
  // Electron's Chromium has native requestVideoFrameCallback. JASSUB's optional
  // fallback is GPL-3.0 and only needed by older browsers.
  // This app asks for local fonts only. Replace JASSUB's optional Google Fonts
  // fallback so a future option change cannot introduce remote font requests.
  alias: {
    'rvfc-polyfill': path.join(__dirname, 'jassub-rvfc-native.js'),
    'lfa-ponyfill': path.join(__dirname, 'jassub-fonts-disabled.js')
  }
};
esbuild.buildSync({ ...common, entryPoints: [path.join(pkg, 'jassub.js')], outfile: path.join(out, 'jassub.js') });
const browserBundle = fs.readFileSync(path.join(out, 'jassub.js'), 'utf8');
if (!browserBundle.includes('requestVideoFrameCallback') || browserBundle.includes('_rvfcpolyfillmap')) {
  throw new Error('JASSUB must use Chromium native requestVideoFrameCallback without bundling the GPL fallback.');
}
esbuild.buildSync({ ...common, entryPoints: [path.join(pkg, 'worker', 'worker.js')], outfile: path.join(out, 'worker', 'worker.js') });
const workerBundle = fs.readFileSync(path.join(out, 'worker', 'worker.js'), 'utf8');
if (/fonts\.(?:googleapis|gstatic)\.com|fonts\.json/i.test(workerBundle)) {
  throw new Error('JASSUB worker must not bundle remote Google Fonts lookup or its catalog.');
}
for (const file of ['jassub-worker.wasm', 'jassub-worker-modern.wasm']) fs.copyFileSync(path.join(pkg, 'wasm', file), path.join(out, 'wasm', file));
fs.copyFileSync(path.join(pkg, 'default.woff2'), path.join(out, 'default.woff2'));
fs.copyFileSync(path.join(root, 'node_modules', 'jassub', 'LICENSE'), path.join(out, 'LICENSE'));
console.log('jassub bundled ->', path.relative(root, out));
