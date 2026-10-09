// Packaged renderer smoke test with synthetic IPC only; run with:
// node node_modules/electron/cli.js tests/integrated-search.electron.cjs
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');

const repo = path.resolve(__dirname, '..');
const asarPath = path.join(repo, 'dist', 'win-unpacked', 'resources', 'app.asar');
assert.ok(fs.existsSync(asarPath), `packaged app.asar exists: ${asarPath}`);
const appRoot = path.join(asarPath, 'src');
const htmlPath = path.join(appRoot, 'index.html');
const preloadPath = path.join(asarPath, 'electron', 'preload.cjs');
const preloadSource = asar.extractFile(asarPath, 'electron/preload.cjs').toString('utf8');
const channels = [...new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]))];
assert.ok(channels.includes('provider:catalog'));
assert.ok(channels.includes('provider:detail'));
assert.ok(fs.existsSync(htmlPath));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-integrated-search-'));
process.on('exit', () => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {} });
const userData = path.join(tempRoot, 'profile');
const downloadsRoot = path.join(tempRoot, 'downloads');
fs.mkdirSync(downloadsRoot);
assert.equal(path.dirname(tempRoot), os.tmpdir(), 'Electron user data is isolated under the OS temp folder');

app.setPath('userData', userData);
app.disableHardwareAcceleration();

const blockedRequests = [];
const ipcCalls = [];
const rendererErrors = [];
let titleVariantsResolved = false;
let win;

function fail(error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
  try { win?.destroy(); } catch {}
  app.exit(1);
}

const items = {
  reanime: {
    provider: 'reanime', id: 'ra-smoke', mal_id: 'reanime:ra-smoke', title: '통합 검색 테스트',
    title_english: 'Unified Search Test', anilistId: 100, malId: 900, year: 2026, type: 'TV'
  },
  animenosub: {
    provider: 'animenosub', id: 'as-smoke', mal_id: 'animenosub:as-smoke', title: '통합 검색 테스트',
    title_english: 'Unified Search Test', malId: 900, year: 2026, type: 'TV'
  },
  miruro: {
    provider: 'miruro', id: 'mi-smoke', mal_id: 'miruro:mi-smoke', title: '통합 검색 테스트',
    title_english: 'Unified Search Test', anilistId: 100, malId: 900, year: 2026, type: 'TV'
  },
  ohli24: {
    provider: 'ohli24', id: 'oh-smoke', mal_id: 'ohli24:oh-smoke', title: '별도 작품',
    title_english: 'Separate Work', anilistId: 200, year: 2025, type: 'TV'
  },
  linkkf: {
    provider: 'linkkf', id: 'lk-smoke', mal_id: 'linkkf:lk-smoke', title: '식별자 없는 작품',
    title_english: 'Unlinked Work', year: 2024, type: 'TV'
  }
};

function providerSearch(provider, query) {
  if (!String(query || '').trim()) return { data: [], total: 0, nextOffset: null, done: true };
  const item = items[provider];
  return { data: item ? [{ ...item }] : [], total: item ? 1 : 0, nextOffset: null, done: true };
}

function linkkfSearch(query) {
  return String(query || '').trim() ? [{ ...items.linkkf }] : [];
}

async function fixture(channel, args) {
  ipcCalls.push({ channel, args });
  switch (channel) {
    case 'anime:season':
    case 'anime:top': return { data: [] };
    case 'downloads:list': return [];
    case 'downloads:root': return downloadsRoot;
    case 'provider:catalog': return providerSearch(args[0], args[1]);
    case 'provider:season': return { data: [], label: '모의 시즌' };
    case 'provider:quarter': return { items: [], label: '모의 분기' };
    case 'provider:airing':
    case 'provider:latest-episodes': return { data: [] };
    case 'provider:detail': return { data: { ...args[0], synopsis: '모의 상세 정보' }, episodes: [], unavailable: false };
    case 'linkkf:search': return linkkfSearch(args[0]);
    case 'catalog:search-korean': return args[0] === 'reanime' ? [{ ...items.reanime }]
      : args[0] === 'animenosub' ? [{ ...items.animenosub }] : [];
    case 'titles:variants':
      await new Promise(resolve => setTimeout(resolve, 1000));
      titleVariantsResolved = true;
      return ['Unified Search Test'];
    case 'titles:resolve': return [];
    case 'catalog:index:state': return { sources: [], tmdb: false };
    case 'tmdb:get': return { key: '' };
    case 'gemini:get': return { localModels: [] };
    case 'subtitle-cache:usage': return { total: 0, removable: 0 };
    case 'update:state': return { status: 'disabled', current: 'smoke' };
    case 'catalog:activate': return { sources: [], tmdb: false };
    case 'cover:data': return args[0] || '';
    case 'anime:overview': return { synopsis: '' };
    default: return undefined;
  }
}

async function waitFor(label, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(?:file:|data:|blob:)/i.test(details.url)) callback({ cancel: false });
    else { blockedRequests.push(details.url); callback({ cancel: true }); }
  });

  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => fixture(channel, args));

  win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (_event, details) => {
    if (details.level >= 3) rendererErrors.push(`${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  win.webContents.on('render-process-gone', (_event, details) => fail(new Error(`Renderer exited: ${details.reason}`)));
  await win.loadFile(htmlPath);

  await waitFor('initial app render', () => win.webContents.executeJavaScript('Boolean(window.lilac && document.querySelector("#searchButton"))'));
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#pageSearch');
    input.value = '통합 검색 테스트';
    document.querySelector('#searchButton').click();
  })()`);

  await waitFor('first phase results before title variants return', async () => {
    const state = await win.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('#searchGrid .anime-card').length,
      status: document.querySelector('#searchStatus')?.textContent || '',
      providers: [...document.querySelectorAll('#searchProviderFilters [data-provider]')].map(button => button.dataset.provider)
    })`);
    return !titleVariantsResolved && state.cards >= 3 && state.status.includes('다른 제목 표기 준비 중') ? state : null;
  });
  assert.equal(titleVariantsResolved, false, 'first-page cards appear while title-variant lookup is still pending');

  await waitFor('merged variant results', async () => {
    const state = await win.webContents.executeJavaScript(`({
      cards: document.querySelectorAll('#searchGrid .anime-card').length,
      count: document.querySelector('#searchGrid .source-count-badge')?.textContent || '',
      providers: [...document.querySelectorAll('#searchProviderFilters [data-provider]')].map(button => button.dataset.provider)
    })`);
    return titleVariantsResolved && state.cards === 3 && state.count === '3개 소스' && state.providers.length === 6 ? state : null;
  });

  await win.webContents.executeJavaScript(`document.querySelector('#searchProviderFilters [data-provider="miruro"]').click()`);
  const miruroView = await waitFor('Miruro provider filter', async () => win.webContents.executeJavaScript(`({
    cards: document.querySelectorAll('#searchGrid .anime-card').length,
    pressed: document.querySelector('#searchProviderFilters [data-provider="miruro"]')?.getAttribute('aria-pressed')
  })`));
  assert.deepEqual(miruroView, { cards: 1, pressed: 'true' });

  await win.webContents.executeJavaScript(`document.querySelector('#searchGrid .anime-card').click()`);
  await waitFor('detail source picker', () => win.webContents.executeJavaScript('Boolean(document.querySelector("#detailContent [data-detail-source]"))'));
  const initialSelection = await win.webContents.executeJavaScript(`({
    count: document.querySelectorAll('#detailContent [data-detail-source]').length,
    selected: document.querySelector('#detailContent [data-detail-source][aria-pressed="true"]')?.dataset.detailSource || ''
  })`);
  assert.equal(initialSelection.count, 3);
  assert.equal(initialSelection.selected, items.miruro.mal_id, 'details initially follow the active Miruro result filter');

  await win.webContents.executeJavaScript(`document.querySelector('#detailContent [data-detail-source="${items.reanime.mal_id}"]').click()`);
  await waitFor('selected Re:Anime detail refresh', async () => win.webContents.executeJavaScript(`
    document.querySelector('#detailContent [data-detail-source="${items.reanime.mal_id}"]')?.getAttribute('aria-pressed') === 'true'
  `));
  assert.ok(ipcCalls.some(call => call.channel === 'provider:detail' && call.args[0]?.provider === 'reanime'));
  assert.ok(ipcCalls.some(call => call.channel === 'provider:detail' && call.args[0]?.provider === 'miruro'));

  assert.deepEqual(blockedRequests, [], `unexpected external request attempts were blocked: ${blockedRequests.join(', ')}`);
  assert.deepEqual(rendererErrors, [], `renderer console errors: ${rendererErrors.join('; ')}`);
  const searchCalls = ipcCalls.filter(call => ['provider:catalog', 'catalog:search-korean', 'linkkf:search'].includes(call.channel));
  assert.ok(searchCalls.length >= 8, `synthetic provider search calls recorded (${searchCalls.length})`);
  console.log(`Packaged integrated search passed: first results shown before title variants; 3 final groups; provider filter and source picker worked.`);
  console.log(`Synthetic search IPC calls: ${searchCalls.length}; renderer errors: ${rendererErrors.length}; blocked external request attempts: ${blockedRequests.length}; userData: isolated temp profile.`);
  win.destroy();
  app.quit();
}).catch(fail);
