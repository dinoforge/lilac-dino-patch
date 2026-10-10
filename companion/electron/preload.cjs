'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lilacCompanion', Object.freeze({
  calendarState: () => ipcRenderer.invoke('companion:calendar-state'),
  selectQuarter: (year, quarter) => ipcRenderer.invoke('companion:select-quarter', year, quarter),
  resetQuarter: () => ipcRenderer.invoke('companion:reset-quarter'),
  loadDemoSubtitle: language => ipcRenderer.invoke('subtitle:load-demo', language),
  chooseSubtitle: () => ipcRenderer.invoke('subtitle:choose'),
  makePrompt: (batchIndex, details) => ipcRenderer.invoke('subtitle:prompt', batchIndex, details),
  applyResponse: (batchIndex, response) => ipcRenderer.invoke('subtitle:apply-response', batchIndex, response),
  copyText: text => ipcRenderer.invoke('subtitle:copy', text),
  openChatGPT: () => ipcRenderer.invoke('subtitle:open-chatgpt'),
  exportSubtitle: () => ipcRenderer.invoke('subtitle:export')
}));
