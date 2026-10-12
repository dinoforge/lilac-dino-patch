'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const manager = require('../manager-core.cjs');
const { assertIsolatedTarget } = require('../isolated-target.cjs');
const { settingsFilePath } = require('../settings.cjs');

const profileRoot = path.join(os.tmpdir(), 'DinoLilacPatch-MVP', 'manager-profile');
for (const name of ['userData', 'sessionData', 'cache', 'downloads', 'videos', 'logs', 'temp']) {
  const directory = path.join(profileRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
app.setName('DinoLilacPatchMVP');

let mainWindow;
let activeTarget = null;
const managerTestMode = process.env.DINO_LILAC_MANAGER_TEST === '1';
if (managerTestMode) activeTarget = assertIsolatedTarget(process.env.DINO_LILAC_MANAGER_TEST_TARGET || '');

function inspectActiveTarget() {
  if (!activeTarget) throw new Error('먼저 격리 사본을 선택하세요.');
  const root = assertIsolatedTarget(activeTarget);
  return { targetRoot: root, settingsPath: settingsFilePath(root), state: manager.inspectTarget(root) };
}

function sendError(error) {
  return { ok: false, error: String(error?.message || error || '알 수 없는 오류') };
}

ipcMain.handle('manager:choose-source', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, { title: '공식 LilacAnime v0.5.15 소스 폴더 선택', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const target = manager.createTargetFromSource(result.filePaths[0]);
    activeTarget = target.root;
    return { ok: true, ...inspectActiveTarget() };
  } catch (error) { return sendError(error); }
});

ipcMain.handle('manager:open-isolated', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, { title: '관리자가 만든 임시 격리 사본 선택', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    activeTarget = assertIsolatedTarget(result.filePaths[0]);
    return { ok: true, ...inspectActiveTarget() };
  } catch (error) { return sendError(error); }
});

ipcMain.handle('manager:inspect', async () => {
  try { return { ok: true, ...inspectActiveTarget() }; }
  catch (error) { return sendError(error); }
});

ipcMain.handle('manager:apply', async (_event, settings) => {
  try {
    const target = assertIsolatedTarget(activeTarget);
    const result = manager.applySettings(target, settings);
    return { ok: true, result, ...inspectActiveTarget() };
  } catch (error) { return sendError(error); }
});

ipcMain.handle('manager:restore', async () => {
  try {
    const target = assertIsolatedTarget(activeTarget);
    const result = manager.restoreTarget(target);
    return { ok: true, result, ...inspectActiveTarget() };
  } catch (error) { return sendError(error); }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 780,
    minHeight: 680,
    show: !managerTestMode,
    backgroundColor: '#111820',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => { if (!managerTestMode) mainWindow.show(); });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
