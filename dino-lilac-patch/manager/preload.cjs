'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dinoPatchManager', Object.freeze({
  chooseSource: () => ipcRenderer.invoke('manager:choose-source'),
  openIsolated: () => ipcRenderer.invoke('manager:open-isolated'),
  inspect: () => ipcRenderer.invoke('manager:inspect'),
  apply: settings => ipcRenderer.invoke('manager:apply', settings),
  restore: () => ipcRenderer.invoke('manager:restore')
}));
