'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const quarterSelection = require('../../src/quarter-selection.js');
const catalog = require('../core/catalog.cjs');
const subtitleWorkflow = require('../core/subtitle-workflow.cjs');

const APP_NAME = 'LilacAnime Companion Prototype';
const APP_ID = 'com.dinoforge.animeplayer.companion.prototype';
const INDEX_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const PROFILE_ROOT = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'LilacAnime-Companion-Prototype');
const USER_DATA_PATH = path.join(PROFILE_ROOT, 'userData');
const SESSION_DATA_PATH = path.join(PROFILE_ROOT, 'sessionData');
const CACHE_PATH = path.join(PROFILE_ROOT, 'cache');

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.setPath('userData', USER_DATA_PATH);
app.setPath('sessionData', SESSION_DATA_PATH);
app.setPath('cache', CACHE_PATH);

const gotLock = app.requestSingleInstanceLock();
let mainWindow = null;
const workflows = new Map();
const selectedSubtitlePaths = new Map();
const statePath = path.join(USER_DATA_PATH, 'companion-state.json');

if (!gotLock) app.quit();
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function trustedSender(event) {
  try {
    return event.senderFrame?.url && path.resolve(fileURLToPath(event.senderFrame.url)).toLocaleLowerCase('en-US') === INDEX_PATH.toLocaleLowerCase('en-US');
  } catch {
    return false;
  }
}

function register(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('허용되지 않은 Companion 요청입니다.');
    return handler(event, ...args);
  });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(USER_DATA_PATH, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function calendarState() {
  const now = new Date();
  const state = readState();
  const resolved = quarterSelection.resolveSelection(state.selectedQuarter, now);
  if (resolved.migrated) writeState({ ...state, selectedQuarter: resolved.record });
  return {
    currentQuarter: quarterSelection.quarterForDate(now),
    selectedQuarter: resolved.selection,
    todayIndex: (now.getDay() + 6) % 7,
    today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    schedule: catalog.buildDemoWeek(resolved.selection, now)
  };
}

function workflowFor(event) {
  const current = workflows.get(event.sender.id);
  if (!current) throw new Error('먼저 VTT 자막을 불러와 주세요.');
  return current;
}

function saveSubtitleDialogOptions(sourcePath, fileName) {
  const base = path.basename(fileName || 'subtitle.vtt', path.extname(fileName || 'subtitle.vtt'));
  return {
    title: '번역 자막을 새 파일로 저장',
    defaultPath: sourcePath
      ? path.join(path.dirname(sourcePath), `${base}.ko.vtt`)
      : path.join(app.getPath('userData'), `${base}.ko.vtt`),
    filters: [{ name: 'WebVTT subtitle', extensions: ['vtt'] }]
  };
}

function installIpc() {
  register('companion:calendar-state', () => calendarState());
  register('companion:select-quarter', (_, year, quarter) => {
    const now = new Date();
    const state = readState();
    const selectedQuarter = quarterSelection.selectionRecord(year, quarter, now);
    writeState({ ...state, selectedQuarter });
    return calendarState();
  });
  register('companion:reset-quarter', () => {
    const state = readState();
    const now = new Date();
    writeState({ ...state, selectedQuarter: quarterSelection.selectionRecord(now.getFullYear(), Math.floor(now.getMonth() / 3) + 1, now) });
    return calendarState();
  });
  register('subtitle:load-demo', (event, language) => {
    const workflow = subtitleWorkflow.createDemoWorkflow(language);
    workflows.set(event.sender.id, workflow);
    selectedSubtitlePaths.delete(event.sender.id);
    return subtitleWorkflow.summarizeWorkflow(workflow);
  });
  register('subtitle:choose', async event => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '번역할 VTT 자막을 직접 선택',
      properties: ['openFile'],
      filters: [{ name: 'WebVTT subtitle', extensions: ['vtt'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const sourcePath = path.resolve(result.filePaths[0]);
    const workflow = subtitleWorkflow.createWorkflow(path.basename(sourcePath), fs.readFileSync(sourcePath, 'utf8'), sourcePath);
    workflows.set(event.sender.id, workflow);
    selectedSubtitlePaths.set(event.sender.id, sourcePath);
    return subtitleWorkflow.summarizeWorkflow(workflow);
  });
  register('subtitle:prompt', (event, batchIndex, details) => subtitleWorkflow.makeBatchPrompt(workflowFor(event), batchIndex, details || {}));
  register('subtitle:apply-response', (event, batchIndex, response) => subtitleWorkflow.applyBatchResponse(workflowFor(event), batchIndex, response));
  register('subtitle:copy', (_, text) => {
    clipboard.writeText(String(text || '').slice(0, 500_000));
    return true;
  });
  register('subtitle:open-chatgpt', () => shell.openExternal('https://chatgpt.com/'));
  register('subtitle:export', async event => {
    const workflow = workflowFor(event);
    const contents = subtitleWorkflow.renderCompleteTranslation(workflow);
    const sourcePath = selectedSubtitlePaths.get(event.sender.id) || null;
    const result = await dialog.showSaveDialog(mainWindow, saveSubtitleDialogOptions(sourcePath, workflow.fileName));
    if (result.canceled || !result.filePath) return null;
    const savedPath = subtitleWorkflow.writeNewSubtitle({ sourcePath, targetPath: result.filePath, contents });
    return { fileName: path.basename(savedPath) };
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    backgroundColor: '#111118',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const target = path.resolve(fileURLToPath(targetUrl)).toLocaleLowerCase('en-US');
      if (target !== INDEX_PATH.toLocaleLowerCase('en-US')) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    workflows.delete(win.webContents.id);
    selectedSubtitlePaths.delete(win.webContents.id);
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile(INDEX_PATH);
}

app.whenReady().then(() => {
  if (!gotLock) return;
  const defaultSession = session.defaultSession;
  defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_, callback) => callback({ cancel: true }));
  installIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  workflows.clear();
  selectedSubtitlePaths.clear();
});
