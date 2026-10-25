const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const path = require('node:path');
const { Updater, installerAsset, isNewer } = require('../electron/updater.cjs');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const updaterSource = fs.readFileSync(path.join(__dirname, '../electron/updater.cjs'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');

test('the app has no update or release-note network source until its own release feed is configured', async t => {
  const originalFetch = global.fetch, requests = [];
  global.fetch = async url => { requests.push(String(url)); throw new Error('unexpected network request'); };
  t.after(() => { global.fetch = originalFetch; });

  const updater = new Updater({ app: { getVersion: () => '0.5.6' }, broadcast() { assert.fail('disabled updates should not broadcast a transition'); } });
  assert.equal(updater.state.status, 'disabled');
  assert.equal((await updater.check()).status, 'disabled');
  assert.equal((await updater.download()).status, 'disabled');
  assert.deepEqual(await updater.notes(), { version: '0.5.6', notes: '', url: '' });
  assert.deepEqual(requests, []);
});

test('checking an app-owned feed downloads the installer but does not install it', async t => {
  const originalFetch = global.fetch, requests = [], root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-updater-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  global.fetch = async url => {
    requests.push(String(url));
    if (String(url).endsWith('/latest')) return { ok: true, async json() { return {
      tag_name: 'v0.5.7', body: 'Release notes', html_url: 'https://github.com/example/player/releases/tag/v0.5.7',
      assets: [{ name: 'LilacAnime-Setup.exe', size: 3, browser_download_url: 'https://example.invalid/setup.exe' }]
    }; } };
    return new Response(Buffer.from('exe'), { headers: { 'content-length': '3' } });
  };
  t.after(() => { global.fetch = originalFetch; });

  const updater = new Updater({
    app: { getVersion: () => '0.5.6', getPath: name => name === 'temp' ? root : path.join(root, 'profile') }, releaseSource: 'https://api.github.com/repos/example/player/releases',
    broadcast() {}
  });
  const state = await updater.check();
  assert.equal(state.status, 'downloading');
  assert.equal(state.latest, '0.5.7');
  await updater.downloading;
  assert.equal(updater.state.status, 'ready');
  assert.equal(fs.readFileSync(updater.installer, 'utf8'), 'exe');
  assert.deepEqual(requests, ['https://api.github.com/repos/example/player/releases/latest', 'https://example.invalid/setup.exe']);
});

test('an older app-owned release is treated as current and never advertised', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return { tag_name: 'v0.5.5', assets: [] }; } });
  t.after(() => { global.fetch = originalFetch; });

  const updater = new Updater({ app: { getVersion: () => '0.5.6' }, releaseSource: 'https://api.github.com/repos/example/player/releases', broadcast() {} });
  const state = await updater.check();
  assert.equal(state.status, 'latest');
  assert.equal(state.current, '0.5.6');
  assert.equal(updater.asset, undefined);
});

test('older release tags never become downgrade offers', () => {
  assert.equal(isNewer('0.5.7', '0.5.6'), true);
  assert.equal(isNewer('0.5.6', '0.5.6'), false);
  assert.equal(isNewer('0.5.5', '0.5.6'), false);
});

test('installer assets match the selected operating system and architecture', () => {
  const assets = [
    { name: 'LilacAnime-Setup.exe' },
    { name: 'LilacAnime-mac-arm64.dmg' },
    { name: 'LilacAnime-linux-amd64.deb' },
    { name: 'LilacAnime-linux-arm64.deb' }
  ];
  assert.equal(installerAsset(assets, 'win32', 'x64')?.name, 'LilacAnime-Setup.exe');
  assert.equal(installerAsset(assets, 'darwin', 'arm64')?.name, 'LilacAnime-mac-arm64.dmg');
  assert.equal(installerAsset(assets, 'linux', 'x64')?.name, 'LilacAnime-linux-amd64.deb');
  assert.equal(installerAsset(assets, 'linux', 'arm64')?.name, 'LilacAnime-linux-arm64.deb');
  assert.equal(installerAsset(assets, 'linux', 'x64')?.name.endsWith('.exe'), false);
});

test('Linux .deb releases are offered only to the supported installed package', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return {
    tag_name: 'v0.5.7', assets: [{ name: 'LilacAnime-linux-amd64.deb', size: 100, browser_download_url: 'https://example.invalid/app.deb' }]
  }; } });
  t.after(() => { global.fetch = originalFetch; });

  const updater = new Updater({
    app: { getVersion: () => '0.5.6' }, releaseSource: 'https://api.github.com/repos/example/player/releases',
    platform: 'linux', arch: 'x64', executablePath: '/usr/bin/lilacanime', existsSync: () => false, broadcast() {}
  });
  const state = await updater.check();
  assert.equal(state.status, 'error');
  assert.match(state.error, /Linux는 \.deb로 설치합니다/);
  assert.equal(updater.asset, undefined);
});

test('Linux .deb installation uses the injected privilege helper without invoking a real installer', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-updater-linux-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'release.deb');
  fs.writeFileSync(installer, 'test package placeholder');

  let spawnArgs, relaunches = 0, quits = 0;
  const child = new EventEmitter();
  const updater = new Updater({
    app: {
      getVersion: () => '0.5.6', getPath: name => name === 'userData' ? root : os.tmpdir(),
      relaunch() { relaunches++; }, quit() { quits++; }
    },
    platform: 'linux', arch: 'x64', executablePath: '/opt/LilacAnime/lilacanime',
    existsSync: target => target === '/var/lib/dpkg/info/lilacanime-desktop.list' || target === '/usr/bin/apt-get' || fs.existsSync(target),
    spawnProcess(...args) { spawnArgs = args; return child; }, broadcast() {}
  });
  updater.installer = installer;
  updater.state = { ...updater.state, status: 'ready', latest: '0.5.7', notes: 'test' };

  assert.equal(updater.install(true), true);
  assert.equal(spawnArgs[0], 'pkexec');
  assert.deepEqual(spawnArgs[1], ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', installer]);
  assert.deepEqual(spawnArgs[2], { stdio: 'ignore' });
  assert.equal(relaunches, 0);
  assert.equal(quits, 0);

  child.emit('close', 0);
  assert.equal(relaunches, 1);
  assert.equal(quits, 1);
  assert.equal(fs.existsSync(path.join(root, 'update-notes.json')), true);
});

test('Linux manual installation refusal does not leave the updater locked in installing state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-updater-manual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'release.deb');
  fs.writeFileSync(installer, 'test package placeholder');
  const updater = new Updater({
    app: { getVersion: () => '0.5.6' }, platform: 'linux', executablePath: '/usr/bin/lilacanime',
    existsSync: () => false, spawnProcess() { assert.fail('unsupported package must not spawn an installer'); }, broadcast() {}
  });
  updater.installer = installer;
  assert.throws(() => updater.install(), /\.deb 패키지에서만/);
  assert.equal(updater.installing, undefined);
});

test('disabled update status is clear and cannot be manually started', () => {
  const $html = require('cheerio').load(indexHtml);
  assert.match($html('#updateStatus').text(), /이 프로젝트의 업데이트 릴리스는 아직 설정되지 않았습니다/);
  assert.equal($html('#checkUpdate').attr('disabled'), 'disabled');
  const start = appSource.indexOf('function renderUpdate(state={})'), end = appSource.indexOf('async function runUpdateAction()', start);
  assert.ok(start >= 0 && end > start, 'Missing update renderer');
  const states = new Map(), element = () => ({
    textContent: '', disabled: false, classList: { toggle(name, enabled) { states.set(name, enabled); } }
  });
  const elements = Object.fromEntries(['#updateStatus', '#checkUpdate', '#applyUpdate', '#updateBanner', '#updateBannerText', '#updateBannerAction'].map(selector => [selector, element()]));
  const context = vm.createContext({ $: selector => elements[selector] });
  vm.runInContext(appSource.slice(start, end), context);
  context.renderUpdate({ status: 'disabled', current: '0.5.6' });
  assert.match(elements['#updateStatus'].textContent, /업데이트 릴리스는 아직 설정되지 않았습니다/);
  assert.equal(elements['#checkUpdate'].disabled, true);
  assert.equal(states.get('hidden'), true);
  assert.doesNotMatch(updaterSource, /whispelyn-byte\/LilacAnime-desktop\/releases/);
  assert.match(mainSource, /updater\?\.installOnQuit/);
});

test('first start skips an empty changelog instead of showing an upstream release prompt', async () => {
  const start = appSource.indexOf('async function showChangelogIfUpdated(version)'), end = appSource.indexOf("$('#changelogClose').onclick", start);
  assert.ok(start >= 0 && end > start, 'Missing changelog flow');
  const values = new Map(), dialog = { open: false, showModal() { this.open = true; } };
  const context = vm.createContext({
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    window: { lilac: { async updateNotes() { return { version: '0.5.6', notes: '', url: '' }; } } },
    $: selector => selector === '#changelogDialog' ? dialog : { textContent: '', classList: { toggle() {} } }
  });
  vm.runInContext(appSource.slice(start, end), context);
  await context.showChangelogIfUpdated('0.5.6');
  assert.equal(dialog.open, false);
  assert.equal(values.get('lastSeenVersion'), '0.5.6');
});
