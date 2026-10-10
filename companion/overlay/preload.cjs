'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lilacOverlay', Object.freeze({
  calendar: () => ipcRenderer.invoke('overlay:calendar'),
  start: () => ipcRenderer.invoke('overlay:start'),
  stop: () => ipcRenderer.invoke('overlay:stop'),
  onStatus: handler => {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('overlay:status', (_event, state) => handler(state));
  }
}));
