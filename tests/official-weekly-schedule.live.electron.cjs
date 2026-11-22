'use strict';

// Live verification of the official one-day-at-a-time schedule UI and existing providerSchedule IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-official-weekly-live-'));
const paths = Object.fromEntries(['appData', 'userData', 'sessionData'].map(name => [name, path.join(tempRoot, name)]));
for (const value of Object.values(paths)) fs.mkdirSync(value, { recursive: true });
for (const [name, value] of Object.entries(paths)) app.setPath(name, value);
for (const [name, value] of Object.entries(paths)) assert.equal(path.resolve(app.getPath(name)), path.resolve(value), `${name} must stay inside the isolated profile`);
assert.ok(Object.values(paths).every(value => path.resolve(value).startsWith(path.resolve(os.tmpdir()))));
app.disableHardwareAcceleration();

const root = path.resolve(__dirname, '..'), windows = [], scheduleCalls = [], consoleErrors = [];
let mainWindow = null;
app.on('browser-window-created', (_event, win) => {
  windows.push({ id: win.id, webContentsId: win.webContents.id });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2 && !/Failed to load resource|Content Security Policy|GPU/.test(message)) consoleErrors.push({ level, message, line, sourceId });
  });
  win.webContents.on('did-finish-load', () => {
    if (/[/\\]src[/\\]index\.html(?:$|[?#])/.test(win.webContents.getURL())) mainWindow = win;
  });
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function evaluate(code, label) {
  assert.ok(mainWindow && !mainWindow.isDestroyed(), `the app-owned BrowserWindow is required for ${label}`);
  return mainWindow.webContents.executeJavaScript(code);
}

async function run() {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => channel === 'provider:schedule'
    ? handle(channel, async (event, provider, day, ...rest) => {
      const record = { provider: String(provider || ''), day: Number(day), state: 'pending', at: Date.now() };
      scheduleCalls.push(record);
      try {
        const result = await listener(event, provider, day, ...rest);
        record.state = result?.failed ? 'failed' : result?.native === true ? 'native' : result?.items?.length ? 'fallback' : 'empty';
        record.items = Array.isArray(result?.items) ? result.items.length : null;
        record.note = String(result?.note || '');
        record.failure = result?.nativeFailure?.code || result?.fallbackFailure?.code || '';
        return result;
      } catch (error) {
        record.state = 'threw'; record.failure = String(error?.code || error?.message || error).slice(0, 160); throw error;
      }
    })
    : handle(channel, listener);

  require('../electron/main.cjs');
  await app.whenReady();
  await waitFor(() => mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading(), 45000, 'home window');
  await waitFor(() => evaluate(`Boolean(window.LilacWeeklySchedule && document.querySelector('#scheduleSection')?.classList.contains('hidden') === false
    && document.querySelectorAll('#scheduleTabs [role="tab"]').length === 7)`, 'weekly schedule initialization'), 15000, 'official schedule tabs');
  await waitFor(() => evaluate(`document.querySelector('#scheduleRail')?.getAttribute('aria-busy') === 'false'`, 'schedule response'), 35000, 'initial schedule response');
  await evaluate(`document.querySelector('#changelogDialog')?.open && document.querySelector('#changelogClose')?.click(); void 0`, 'close release notes if shown');

  const startup = await evaluate(`(() => ({
    homeVisible: document.querySelector('#homeView')?.classList.contains('active') === true,
    scheduleVisible: document.querySelector('#scheduleSection')?.classList.contains('hidden') === false,
    tabCount: document.querySelectorAll('#scheduleTabs [role="tab"]').length,
    selectedDay: [...document.querySelectorAll('#scheduleTabs [role="tab"]')].findIndex(button => button.getAttribute('aria-selected') === 'true'),
    week: document.querySelector('#scheduleWeek')?.textContent || '',
    status: document.querySelector('#scheduleStatus')?.textContent || '',
    itemCount: document.querySelectorAll('#scheduleRail .schedule-show').length,
    provider: state.source,
    patch01CalendarAbsent: !document.querySelector('#seasonCalendarView') && typeof window.LilacSeasonCalendar === 'undefined'
  }))()`, 'startup state');
  startup.captureOwner = { windowId: mainWindow.id, webContentsId: mainWindow.webContents.id };
  assert.equal(startup.homeVisible, true);
  assert.equal(startup.scheduleVisible, true);
  assert.equal(startup.tabCount, 7);
  assert.ok(startup.selectedDay >= 0);
  assert.equal(startup.patch01CalendarAbsent, true);
  assert.ok(scheduleCalls.length >= 1, 'the UI must use the existing providerSchedule IPC');
  fs.writeFileSync(path.join(tempRoot, 'weekly-home.png'), (await mainWindow.capturePage()).toPNG());

  const days = [];
  for (let index = 0; index < 7; index++) {
    await evaluate(`document.querySelectorAll('#scheduleTabs [role="tab"]')[${index}].click(); void 0`, `select weekday ${index}`);
    await waitFor(() => evaluate(`document.querySelector('#scheduleRail')?.getAttribute('aria-busy') === 'false'`, `weekday ${index} response`), 35000, `weekday ${index} schedule response`);
    days.push(await evaluate(`(() => ({
      day: ${index}, selected: document.querySelectorAll('#scheduleTabs [role="tab"]')[${index}].getAttribute('aria-selected') === 'true',
      status: document.querySelector('#scheduleStatus')?.textContent || '',
      itemCount: document.querySelectorAll('#scheduleRail .schedule-show').length,
      sourceNote: document.querySelector('.schedule-credit')?.textContent || ''
    }))()`, `weekday ${index} status`));
  }
  const dayWithRows = days.find(day => day.itemCount > 0);
  let detail = null;
  if (dayWithRows) {
    await evaluate(`document.querySelectorAll('#scheduleTabs [role="tab"]')[${dayWithRows.day}].click(); void 0`, 'return to a day with an entry');
    await waitFor(() => evaluate(`document.querySelector('#scheduleRail')?.getAttribute('aria-busy') === 'false'`, 'return schedule response'), 35000, 'return schedule response');
    await evaluate(`document.querySelector('.schedule-show')?.click(); void 0`, 'open schedule work detail');
    await waitFor(() => evaluate(`Boolean(document.querySelector('#detailDialog')?.open)`, 'detail dialog open'), 20000, 'schedule-linked detail dialog');
    await waitFor(() => evaluate(`Boolean(document.querySelector('#detailContent h1') || document.querySelector('#detailContent .empty-state h3'))`, 'detail result rendered'), 30000, 'schedule-linked detail result');
    detail = await evaluate(`(() => ({
      title: document.querySelector('#detailContent h1')?.textContent || '',
      dialogOpen: document.querySelector('#detailDialog')?.open === true,
      episodeRows: document.querySelectorAll('#episodeBlock .episode-row.rich').length,
      error: document.querySelector('#detailContent .empty-state h3')?.textContent || ''
    }))()`, 'detail result');
    fs.writeFileSync(path.join(tempRoot, 'weekly-detail.png'), (await mainWindow.capturePage()).toPNG());
  }

  const report = {
    tempRoot, paths, electronVersion: process.versions.electron, mainPid: process.pid,
    rendererPid: mainWindow.webContents.getOSProcessId(), windows, startup, days, scheduleCalls, detail, consoleErrors
  };
  fs.writeFileSync(path.join(tempRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`OFFICIAL_WEEKLY_SCHEDULE_LIVE_REPORT ${JSON.stringify(report)}`);
  assert.equal(consoleErrors.some(item => /Uncaught (?:TypeError|ReferenceError|SyntaxError)/.test(item.message)), false,
    'the renderer must initialize without an uncaught JavaScript error');
  return report;
}

run().then(() => app.quit(), error => {
  console.error(error?.stack || error);
  try { app.quit(); } catch {}
  process.exitCode = 1;
});
