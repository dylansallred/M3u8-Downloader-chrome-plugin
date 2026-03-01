const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { createApiServer } = require('@m3u8/downloader-api');
const { API } = require('@m3u8/contracts');

let mainWindow = null;
let apiServer = null;
let updaterTimer = null;
const apiHost = process.env.M3U8_API_HOST || API.host;
const apiPort = Number(process.env.M3U8_API_PORT || API.port);

const updaterState = {
  phase: 'idle',
  message: 'Idle',
  progress: 0,
  updateInfo: null,
  lastCheckedAt: null,
  error: null,
};

const appSettingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    const file = appSettingsPath();
    if (!fs.existsSync(file)) {
      return {
        queueMaxConcurrent: 1,
        queueAutoStart: true,
        checkUpdatesOnStartup: true,
      };
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      queueMaxConcurrent: parsed.queueMaxConcurrent ?? 1,
      queueAutoStart: parsed.queueAutoStart ?? true,
      checkUpdatesOnStartup: parsed.checkUpdatesOnStartup ?? true,
    };
  } catch {
    return {
      queueMaxConcurrent: 1,
      queueAutoStart: true,
      checkUpdatesOnStartup: true,
    };
  }
}

function writeSettings(next) {
  const merged = {
    ...readSettings(),
    ...next,
  };
  fs.mkdirSync(path.dirname(appSettingsPath()), { recursive: true });
  fs.writeFileSync(appSettingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    updaterState.phase = 'checking';
    updaterState.message = 'Checking for updates...';
    updaterState.lastCheckedAt = Date.now();
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('update-available', (info) => {
    updaterState.phase = 'downloading';
    updaterState.message = `Downloading version ${info.version}...`;
    updaterState.updateInfo = info;
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('update-not-available', (info) => {
    updaterState.phase = 'idle';
    updaterState.message = 'You are up to date.';
    updaterState.updateInfo = info || null;
    updaterState.progress = 0;
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('download-progress', (progress) => {
    updaterState.phase = 'downloading';
    updaterState.progress = Math.round(progress.percent || 0);
    updaterState.message = `Downloading update... ${updaterState.progress}%`;
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('update-downloaded', (info) => {
    updaterState.phase = 'downloaded';
    updaterState.message = `Update ${info.version} downloaded. Restart to install.`;
    updaterState.updateInfo = info;
    updaterState.progress = 100;
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('error', (error) => {
    updaterState.phase = 'error';
    updaterState.message = 'Update check failed';
    updaterState.error = error ? String(error.message || error) : 'Unknown updater error';
    sendToRenderer('updater:event', updaterState);
  });
}

async function checkForUpdatesNow() {
  updaterState.lastCheckedAt = Date.now();
  sendToRenderer('updater:event', updaterState);
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    updaterState.phase = 'error';
    updaterState.message = 'Update check failed';
    updaterState.error = String(err.message || err);
    sendToRenderer('updater:event', updaterState);
    return { ok: false, error: updaterState.error };
  }
}

async function startLocalApi() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  const downloadDir = path.join(dataDir, 'downloads');

  apiServer = createApiServer({
    host: apiHost,
    port: apiPort,
    appVersion: app.getVersion(),
    dataDir,
    downloadDir,
    onFocus: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    },
  });

  await apiServer.start();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function registerIpc() {
  ipcMain.handle('app:get-info', async () => ({
    version: app.getVersion(),
    apiBaseUrl: `http://${apiHost}:${apiPort}`,
    apiVersion: API.apiVersion,
  }));

  ipcMain.handle('settings:get', async () => readSettings());

  ipcMain.handle('settings:save', async (event, nextSettings) => {
    const merged = writeSettings(nextSettings || {});
    return merged;
  });

  ipcMain.handle('auth:generate-pairing-code', async () => {
    if (!apiServer) {
      throw new Error('API server not started');
    }
    return apiServer.authManager.generatePairingCode();
  });

  ipcMain.handle('auth:list-tokens', async () => {
    if (!apiServer) return [];
    return apiServer.authManager.listTokens();
  });

  ipcMain.handle('auth:revoke-token', async (event, tokenId) => {
    if (!apiServer) return { ok: false };
    return { ok: apiServer.authManager.revokeToken(tokenId) };
  });

  ipcMain.handle('auth:revoke-all', async () => {
    if (!apiServer) return { ok: false };
    return { ok: apiServer.authManager.revokeAll() };
  });

  ipcMain.handle('updater:get-state', async () => ({ ...updaterState }));

  ipcMain.handle('updater:check-now', async () => checkForUpdatesNow());

  ipcMain.handle('updater:install-now', async () => {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
}

async function bootstrap() {
  const skipSingleInstanceLock = process.env.E2E_ALLOW_MULTI_INSTANCE === '1';
  if (!skipSingleInstanceLock) {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return;
    }
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  await app.whenReady();

  registerIpc();
  configureAutoUpdater();
  await startLocalApi();
  createWindow();

  const settings = readSettings();
  if (settings.checkUpdatesOnStartup !== false) {
    setTimeout(() => {
      checkForUpdatesNow();
    }, 15_000);

    updaterTimer = setInterval(() => {
      checkForUpdatesNow();
    }, 6 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.on('before-quit', async () => {
  if (updaterTimer) {
    clearInterval(updaterTimer);
    updaterTimer = null;
  }

  if (apiServer) {
    try {
      await apiServer.stop();
    } catch {
      // ignore shutdown error
    }
  }
});

bootstrap();
