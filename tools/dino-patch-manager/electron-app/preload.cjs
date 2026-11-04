const { contextBridge, ipcRenderer } = require('electron');

const api = Object.freeze({
  getInfo: () => ipcRenderer.invoke('manager:getInfo'),
  startup: () => ipcRenderer.invoke('manager:startup'),
  chooseRoot: () => ipcRenderer.invoke('manager:chooseRoot'),
  inspect: () => ipcRenderer.invoke('manager:inspect'),
  apply: () => ipcRenderer.invoke('manager:apply'),
  uninstall: () => ipcRenderer.invoke('manager:uninstall'),
  backups: () => ipcRenderer.invoke('manager:backups'),
  restore: (backupId) => ipcRenderer.invoke('manager:restore', backupId),
  history: () => ipcRenderer.invoke('manager:history'),
  diagnostics: () => ipcRenderer.invoke('manager:diagnostics'),
  checkUpdates: () => ipcRenderer.invoke('manager:checkUpdates'),
  approveUpdate: () => ipcRenderer.invoke('manager:approveUpdate'),
  refreshTheme: () => ipcRenderer.invoke('manager:refreshTheme'),
  runtimeInfo: () => ipcRenderer.invoke('manager:runtimeInfo'),
  confirm: (action) => ipcRenderer.invoke('manager:confirm', action),
  onProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('manager:progress', wrapped);
    return () => ipcRenderer.removeListener('manager:progress', wrapped);
  },
  onTheme: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('manager:theme', wrapped);
    return () => ipcRenderer.removeListener('manager:theme', wrapped);
  },
  onSourceChange: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('manager:source-change', wrapped);
    return () => ipcRenderer.removeListener('manager:source-change', wrapped);
  },
});

contextBridge.exposeInMainWorld('dinoManager', api);
