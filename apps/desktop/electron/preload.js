const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  generatePairingCode: () => ipcRenderer.invoke('auth:generate-pairing-code'),
  listTokens: () => ipcRenderer.invoke('auth:list-tokens'),
  revokeToken: (tokenId) => ipcRenderer.invoke('auth:revoke-token', tokenId),
  revokeAllTokens: () => ipcRenderer.invoke('auth:revoke-all'),
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check-now'),
  installUpdateNow: () => ipcRenderer.invoke('updater:install-now'),
  onUpdaterEvent: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('updater:event', handler);
    return () => ipcRenderer.removeListener('updater:event', handler);
  },
});
