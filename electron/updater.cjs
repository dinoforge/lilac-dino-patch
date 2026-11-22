// Project-owned GitHub release updater; disabled until this project has an approved release feed.
// Releases need a Windows installer, a macOS disk image, or an architecture-specific Linux .deb.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// No release feed is configured until this project has an approved, versioned release.
// Never fall back to the upstream LilacAnime release feed.
const RELEASES = null;
// This build's installer among a release's files.
function installerAsset(assets = [], platform = process.platform, arch = process.arch) {
  const named = test => assets.find(item => test(String(item.name || '')));
  if (platform === 'linux') return named(name => new RegExp(`-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}\\.deb$`, 'i').test(name));
  if (platform === 'darwin') return named(name => new RegExp(`-mac-${arch}\\.dmg$`, 'i').test(name));
  return named(name => /\.exe$/i.test(name) && /setup/i.test(name)) || named(name => /\.exe$/i.test(name));
}

function parseVersion(value = '') {
  return String(value).trim().replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
}
function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

class Updater {
  constructor({ app, broadcast, releaseSource = RELEASES, platform = process.platform, arch = process.arch,
    executablePath = process.execPath, existsSync = fs.existsSync, spawnProcess = spawn }) {
    this.app = app;
    this.broadcast = broadcast;
    this.platform = platform;
    this.arch = arch;
    this.existsSync = existsSync;
    this.spawnProcess = spawnProcess;
    this.debInstall = platform === 'linux' && executablePath.startsWith('/opt/') && existsSync('/var/lib/dpkg/info/lilacanime-desktop.list');
    this.releaseSource = typeof releaseSource === 'string' ? releaseSource.replace(/\/$/, '') : null;
    this.releaseApi = this.releaseSource ? `${this.releaseSource}/latest` : null;
    this.state = { status: this.releaseApi ? 'idle' : 'disabled', current: app.getVersion() };
    this.downloading = null;
  }

  set(patch) { this.state = { ...this.state, ...patch }; this.broadcast('update:state', this.state); return this.state; }

  async check() {
    if (!this.releaseApi) return this.state;
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: null });
    try {
      const response = await fetch(this.releaseApi, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LilacAnime-Desktop/${this.app.getVersion()}` } });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const release = await response.json();
      const latest = String(release.tag_name || release.name || '').replace(/^v/i, '');
      const asset = installerAsset(release.assets || [], this.platform, this.arch);
      if (!latest || !isNewer(latest, this.app.getVersion())) return this.set({ status: 'latest', latest: latest || this.app.getVersion() });
      if (!asset) throw new Error(this.platform === 'darwin' ? '릴리스에 이 Mac용 설치 파일(.dmg)이 없습니다.' : this.platform === 'linux' ? '릴리스에 이 Linux용 설치 파일(.deb)이 없습니다.' : '릴리스에 설치 파일(.exe)이 없습니다.');
      if (this.platform === 'linux' && !this.debInstall) throw new Error(`새 버전 v${latest}이 있습니다. Linux는 .deb로 설치합니다. 릴리스 페이지에서 .deb를 받아 설치해 주세요.`);
      this.asset = asset;
      this.set({ status: 'available', latest, notes: String(release.body || '').slice(0, 20000), url: release.html_url || '', size: Number(asset.size) || 0 });
      // Match the official updater: download the offered installer in the background,
      // but leave installation behind the user's explicit action.
      void this.download();
      return this.state;
    } catch (error) {
      return this.set({ status: 'error', error: error.message || '업데이트 확인 실패' });
    }
  }

  async download() {
    if (!this.releaseApi) return this.state;
    if (this.state.status === 'ready') return this.state;
    if (this.downloading) return this.downloading;
    if (!this.asset) await this.check();
    // check() starts the download itself once it finds the release.
    if (this.downloading) return this.downloading;
    if (!this.asset) return this.state;
    this.downloading = (async () => {
      const dir = path.join(this.app.getPath('temp'), 'LilacAnime-update');
      fs.mkdirSync(dir, { recursive: true });
      // The saved copy is named by the release, so an
      // older one is never overwritten while it may still be open.
      const extension = this.platform === 'darwin' ? '.dmg' : this.platform === 'linux' ? '.deb' : '.exe';
      const file = path.join(dir, `LilacAnime-Setup-${String(this.state.latest || 'update').replace(/[^\w.-]/g, '_')}${extension}`);
      const partial = `${file}.part`;
      this.set({ status: 'downloading', percent: 0 });
      try {
        const response = await fetch(this.asset.browser_download_url, { headers: { 'User-Agent': `LilacAnime-Desktop/${this.app.getVersion()}`, Accept: 'application/octet-stream' } });
        if (!response.ok || !response.body) throw new Error(`다운로드 HTTP ${response.status}`);
        const total = Number(response.headers.get('content-length')) || Number(this.asset.size) || 0;
        let received = 0, lastPercent = -1;
        const stream = Readable.fromWeb(response.body);
        stream.on('data', chunk => {
          received += chunk.length;
          const percent = total ? Math.floor(received / total * 100) : null;
          if (percent !== lastPercent) { lastPercent = percent; this.set({ percent }); }
        });
        await pipeline(stream, fs.createWriteStream(partial));
        if (this.asset.size && fs.statSync(partial).size !== Number(this.asset.size)) throw new Error('설치 파일 크기가 릴리스와 다릅니다.');
        fs.renameSync(partial, file);
        this.installer = file;
        return this.set({ status: 'ready', percent: 100 });
      } catch (error) {
        try { fs.unlinkSync(partial); } catch {}
        return this.set({ status: 'error', error: error.message || '다운로드 실패' });
      } finally { this.downloading = null; }
    })();
    return this.downloading;
  }

  get notesFile() { return path.join(this.app.getPath('userData'), 'update-notes.json'); }

  install(relaunch = true) {
    if (!this.installer || !fs.existsSync(this.installer)) throw new Error('다운로드된 설치 파일이 없습니다.');
    if (this.installing) return true;
    if (this.platform === 'linux' && !this.debInstall) throw new Error('Linux 업데이트 자동 설치는 LilacAnime .deb 패키지에서만 사용할 수 있습니다.');
    this.installing = true;
    // The new version shows these notes on its first start, even offline.
    try { fs.writeFileSync(this.notesFile, JSON.stringify({ version: this.state.latest, notes: this.state.notes || '', url: this.state.url || '' })); } catch { /* fetched by tag instead */ }
    // macOS: an app that is not signed by Apple cannot replace itself, so the disk image is opened for the person to
    // drag the app into Applications, and the app closes so the old one is not in use.
    if (this.platform === 'darwin') {
      shell.openPath(this.installer).then(error => { if (error) this.installing = false; else if (relaunch) setTimeout(() => this.app.quit(), 300); });
      return true;
    }
    if (this.platform === 'linux') {
      const apt = this.existsSync('/usr/bin/apt-get');
      const child = this.spawnProcess('pkexec', apt ? ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', this.installer] : ['/usr/bin/dpkg', '-i', this.installer], { stdio: 'ignore' });
      const failed = message => { this.installing = false; this.set({ status: 'error', error: message }); };
      child.once('error', () => failed('pkexec이 없어 설치하지 못했습니다. 릴리스 페이지에서 .deb를 받아 설치해 주세요.'));
      child.once('close', code => {
        if (code !== 0) { failed(code === 126 || code === 127 ? '설치가 취소되었습니다.' : `설치하지 못했습니다 (코드 ${code}).`); return; }
        if (relaunch) this.app.relaunch(); this.app.quit();
      });
      return true;
    }
    // NSIS assisted installer: /S installs silently into the existing directory, --updated relaunches.
    const child = this.spawnProcess(this.installer, relaunch ? ['/S', '--updated', '--force-run'] : ['/S', '--updated'], { detached: true, stdio: 'ignore' });
    child.unref();
    if (relaunch) setTimeout(() => this.app.quit(), 300);
    return true;
  }

  // Finish an already downloaded update when the application is closed. This does
  // not contact the release feed and preserves the local updater's disabled feed.
  installOnQuit() { if (this.platform === 'win32' && this.state.status === 'ready' && !this.installing) try { this.install(false); } catch { /* next start */ } }
}

// Release notes of this build: the ones saved when it was installed, else the GitHub release of its tag.
Updater.prototype.notes = async function notes() {
  const version = this.app.getVersion();
  if (!this.releaseSource) return { version, notes: '', url: '' };
  const same = value => parseVersion(value).join('.') === parseVersion(version).join('.');
  try {
    const saved = JSON.parse(fs.readFileSync(this.notesFile, 'utf8'));
    fs.rmSync(this.notesFile, { force: true });
    if (same(saved.version) && saved.notes) return { version, notes: String(saved.notes), url: String(saved.url || '') };
  } catch { /* none saved */ }
  for (const tag of [`v${version}`, version]) {
    try {
      const response = await fetch(`${this.releaseSource}/tags/${encodeURIComponent(tag)}`, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LilacAnime-Desktop/${version}` } });
      if (!response.ok) continue;
      const release = await response.json();
      return { version, notes: String(release.body || '').slice(0, 20000), url: release.html_url || '' };
    } catch { /* next tag spelling */ }
  }
  return { version, notes: '', url: this.releaseSource.replace(/^https:\/\/api\.github\.com\/repos\//, 'https://github.com/') };
};

module.exports = { Updater, installerAsset, isNewer };
