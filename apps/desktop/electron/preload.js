const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check-now'),
  installUpdateNow: () => ipcRenderer.invoke('updater:install-now'),
  remindLater: (minutes) => ipcRenderer.invoke('updater:remind-later', minutes),
  saveDiagnosticsFile: (payload) => ipcRenderer.invoke('app:save-diagnostics-file', payload),
  openDiagnosticsFolder: () => ipcRenderer.invoke('app:open-diagnostics-folder'),
  exportSupportBundle: (payload) => ipcRenderer.invoke('app:export-support-bundle', payload),
  openHistoryFile: (fileName) => ipcRenderer.invoke('app:open-history-file', fileName),
  openHistoryFolder: (fileName) => ipcRenderer.invoke('app:open-history-folder', fileName),
  onUpdaterEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('updater:event', handler);
    return () => ipcRenderer.removeListener('updater:event', handler);
  },
});
