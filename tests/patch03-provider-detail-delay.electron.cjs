const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const tempRoot = path.resolve(process.env.PATCH03_TEST_ROOT || '');
const allowedTempRoot = path.resolve(process.env.PATCH03_ALLOWED_TEMP_ROOT || '');
const isInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
assert.ok(allowedTempRoot && isInside(allowedTempRoot, tempRoot), 'test root must be inside the explicitly approved OS Temp directory');
assert.ok(fs.existsSync(tempRoot), 'test root must be prepared before launching Electron');

const appPaths = {};
for (const name of ['appData', 'userData', 'sessionData']) {
  const target = path.join(tempRoot, name);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(name, target);
  appPaths[name] = path.resolve(app.getPath(name));
  assert.equal(appPaths[name], path.resolve(target), name + ' must use the isolated test path');
}

let rendererLoads = 0;
const events = [];
const reportPath = path.join(tempRoot, 'patch03-provider-detail-delay-report.json');
function writeReport(stage, detail = {}) {
  try {
    fs.writeFileSync(reportPath, JSON.stringify({ stage, detail, electronVersion: process.versions.electron, executable: process.execPath, appPaths, rendererLoads, events }, null, 2));
  } catch {}
}
writeReport('harness-started');
const originalRequestSingleInstanceLock = app.requestSingleInstanceLock.bind(app);
app.requestSingleInstanceLock = (...args) => {
  const acquired = originalRequestSingleInstanceLock(...args);
  events.push({ stage: 'single-instance-lock', acquired, at: new Date().toISOString() });
  writeReport('single-instance-lock', { acquired });
  return acquired;
};
const originalQuit = app.quit.bind(app);
app.quit = (...args) => {
  events.push({ stage: 'app-quit-requested', at: new Date().toISOString() });
  writeReport('app-quit-requested');
  return originalQuit(...args);
};
for (const stage of ['before-quit', 'will-quit', 'quit']) app.on(stage, () => writeReport(stage));
process.on('exit', code => writeReport('process-exit', { code }));
const reportTimer = setInterval(() => writeReport('running'), 1000);
reportTimer.unref();
const pendingDetails = new Map();
const originalHandle = ipcMain.handle.bind(ipcMain);
function mockDetail(anime) {
  return { data: { ...anime, synopsis: 'Mock detail response', genres: [], studios: [], status: 'Finished' }, episodes: [], unavailable: false };
}
ipcMain.handle = function(channel, listener) {
  if (channel === 'provider:detail') {
    return originalHandle(channel, async (event, anime, ...args) => {
      const id = String(anime && anime.id || '');
      const startedAt = Date.now();
      events.push({ stage: 'provider-detail-start', id, provider: anime && anime.provider || '', at: new Date().toISOString() });
      try {
        let result;
        if (id === '__p03_delay_slow__' || id === '__p03_delay_mode__') {
          result = await new Promise(resolve => pendingDetails.set(id, () => {
            events.push({ stage: 'provider-detail-mock-response', id, at: new Date().toISOString() });
            resolve(mockDetail(anime));
          }));
        } else if (id === '__p03_delay_fast__') {
          events.push({ stage: 'provider-detail-mock-response', id, at: new Date().toISOString() });
          result = mockDetail(anime);
        } else {
          result = await listener(event, anime, ...args);
        }
        events.push({ stage: 'provider-detail-finished', id, state: 'resolved', durationMs: Date.now() - startedAt, at: new Date().toISOString() });
        return result;
      } catch (error) {
        events.push({ stage: 'provider-detail-error', id, message: String(error && error.message || error), at: new Date().toISOString() });
        throw error;
      }
    });
  }
  if (channel === 'anime:overview') return originalHandle(channel, async () => null);
  return originalHandle(channel, listener);
};

let mainWindow = null;
app.on('browser-window-created', (_event, window) => {
  mainWindow = window;
  window.webContents.on('did-start-loading', () => events.push({ stage: 'renderer-load-start', at: new Date().toISOString() }));
  window.webContents.on('did-finish-load', () => {
    rendererLoads++;
    events.push({ stage: 'renderer-load-finished', rendererLoads, at: new Date().toISOString() });
  });
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for ' + label);
}
const evaluate = code => mainWindow.webContents.executeJavaScript(code, true);
async function selectSetting(value, stateCheck) {
  const previousLoads = rendererLoads;
  const clicked = await evaluate("(() => { switchView('settings'); window.showSettingsPane?.('playback'); const button = document.querySelector('#sourceChoices button[data-value=" + JSON.stringify(value) + "]'); if (!button) return false; button.click(); return true; })()");
  assert.equal(clicked, true, 'the original settings UI must expose ' + value);
  await waitFor(() => rendererLoads > previousLoads && !mainWindow.webContents.isLoading(), 20000, value + ' renderer reload');
  events.push({ stage: 'source-mode-reload-complete', value, rendererLoads, at: new Date().toISOString() });
  await waitFor(() => evaluate(stateCheck), 10000, value + ' setting state');
}
async function addAndOpen(id, groupKey, title) {
  const anime = {
    provider: 'ohli24', id, mal_id: 'ohli24:' + id,
    title, title_english: title, title_japanese: title,
    year: 2026, type: 'TV', status: 'Finished', aired: '', synopsis: 'Mock detail',
    genres: [], studios: [], images: { webp: { large_image_url: '' } },
    url: 'https://ani.ohli24.com/c/' + id
  };
  const expression = "(() => { const anime = " + JSON.stringify(anime)
    + "; knownAnime.set(anime.mal_id, anime); const groupKey = " + JSON.stringify(groupKey)
    + "; searchGroupsByKey.set(groupKey, { groupKey, workIdentityKey: groupKey, sourceItems: [anime], preferenceKeys: [], sourceSearchPending: false, sourceSearchResolved: true, sourceSearchStatuses: [] }); void openDetail(anime.mal_id, { groupKey }); return true; })()";
  return evaluate(expression);
}

let completed = false;
const watchdog = setTimeout(() => {
  if (completed) return;
  completed = true;
  console.error('PATCH03_DELAY_FAILURE ' + JSON.stringify({ error: '60-second watchdog', appPaths, rendererLoads, events: events.slice(-40) }));
  app.quit();
  setTimeout(() => process.exit(124), 500);
}, 60000);

async function run() {
  require('../electron/main.cjs');
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length > 0, 30000, 'BrowserWindow');
  if (!mainWindow) mainWindow = BrowserWindow.getAllWindows()[0];
  await waitFor(() => !mainWindow.webContents.isLoading(), 30000, 'initial renderer load');
  await waitFor(() => evaluate("typeof state !== 'undefined' && Boolean(document.querySelector('#sourceChoices'))"), 15000, 'renderer initialization');

  await selectSetting('ohli24', "state.contentSourceMode === 'provider' && state.source === 'ohli24' && document.querySelector('#contentSource')?.value === 'ohli24'");

  await addAndOpen('__p03_delay_slow__', '__p03-delay-slow-group__', 'DINO SLOW DETAIL');
  await waitFor(() => pendingDetails.has('__p03_delay_slow__'), 10000, 'delayed detail IPC start');
  await addAndOpen('__p03_delay_fast__', '__p03-delay-fast-group__', 'DINO MOCK FAST DETAIL');
  await waitFor(() => evaluate("document.querySelector('#detailContent h1')?.textContent === 'DINO MOCK FAST DETAIL'"), 12000, 'new detail render');
  pendingDetails.get('__p03_delay_slow__')();
  await waitFor(() => events.some(event => event.stage === 'provider-detail-finished' && event.id === '__p03_delay_slow__'), 5000, 'late detail response');
  assert.equal(await evaluate("document.querySelector('#detailContent h1')?.textContent || ''"), 'DINO MOCK FAST DETAIL', 'late detail must not replace the newer detail');

  await addAndOpen('__p03_delay_mode__', '__p03-delay-mode-group__', 'DINO MODE DELAY DETAIL');
  await waitFor(() => pendingDetails.has('__p03_delay_mode__'), 10000, 'detail IPC pending during mode switch');
  await evaluate("document.querySelector('#detailDialog')?.close()");
  await selectSetting('integrated', "state.contentSourceMode === 'integrated' && state.source === 'ohli24' && localStorage.getItem('contentSource') === 'integrated' && localStorage.getItem('contentSourceProvider') === 'ohli24' && document.querySelector('#contentSource')?.value === 'integrated'");
  assert.equal(events.some(event => event.stage === 'provider-detail-finished' && event.id === '__p03_delay_mode__'), false, 'mode reload must finish while detail IPC remains pending');
  pendingDetails.get('__p03_delay_mode__')();
  await waitFor(() => events.some(event => event.stage === 'provider-detail-finished' && event.id === '__p03_delay_mode__'), 5000, 'mock response after mode reload');
  await delay(250);
  const afterReload = await evaluate("({ mode: state.contentSourceMode, provider: state.source, detailOpen: document.querySelector('#detailDialog')?.open || false, detailTitle: document.querySelector('#detailContent h1')?.textContent || '' })");
  assert.equal(afterReload.mode, 'integrated');
  assert.equal(afterReload.provider, 'ohli24');
  assert.equal(afterReload.detailOpen, false);
  assert.equal(afterReload.detailTitle, '');
  events.push({ stage: 'assertions-completed', at: new Date().toISOString() });

  completed = true;
  clearTimeout(watchdog);
  console.log('PATCH03_DELAY_RESULT ' + JSON.stringify({ electronVersion: process.versions.electron, executable: process.execPath, appPaths, rendererLoads, events }));
  writeReport('success');
  app.quit();
  setTimeout(() => process.exit(0), 500);
}
run().catch(error => {
  if (completed) return;
  completed = true;
  clearTimeout(watchdog);
  console.error('PATCH03_DELAY_FAILURE ' + JSON.stringify({ error: String(error && error.stack || error), appPaths, rendererLoads, events: events.slice(-50) }));
  writeReport('failure', { error: String(error && error.stack || error) });
  app.quit();
  setTimeout(() => process.exit(1), 500);
});
