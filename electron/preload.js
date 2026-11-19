'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motorApp', {
  platform: process.platform,
  smokeMode: Boolean(process.env.MOTOMIND_SMOKE_PATH),
  setWindowTheme: theme => ipcRenderer.invoke('window:setTheme', theme),
  run: (operation, params) => ipcRenderer.invoke('backend:run', operation, params),
  cancel: () => ipcRenderer.invoke('backend:cancel'),
  manualIntent: value => ipcRenderer.invoke('backend:manualIntent', value),
  preview: config => ipcRenderer.invoke('backend:preview', config),
  dxl: (operation, params) => ipcRenderer.invoke('dxl:run', operation, params),
  dxlBackups: () => ipcRenderer.invoke('dxl:backups'),
  pickCalibrationOutput: () => ipcRenderer.invoke('calibration:pickOutput'),
  getReferenceAngle: uuid => ipcRenderer.invoke('reference:get', uuid),
  setReferenceAngle: (uuid, angle) => ipcRenderer.invoke('reference:set', uuid, angle),
  updateInfo: () => ipcRenderer.invoke('updates:info'),
  checkUpdate: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('updates:progress', listener);
    return () => ipcRenderer.removeListener('updates:progress', listener);
  },
  listRuns: () => ipcRenderer.invoke('runs:list'),
  pickRun: () => ipcRenderer.invoke('runs:pick'),
  loadRun: directory => ipcRenderer.invoke('runs:load', directory),
  exportRun: (directory, file) => ipcRenderer.invoke('runs:export', directory, file),
  deleteRun: directory => ipcRenderer.invoke('runs:delete', directory),
  showRun: directory => ipcRenderer.invoke('runs:show', directory),
  copyRunPath: directory => ipcRenderer.invoke('runs:copyPath', directory),
  openReleaseNotes: () => ipcRenderer.invoke('links:firmwareRelease'),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('backend:event', listener);
    return () => ipcRenderer.removeListener('backend:event', listener);
  },
});
