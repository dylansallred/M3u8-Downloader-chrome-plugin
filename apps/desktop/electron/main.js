const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { API } = require('@m3u8/contracts');

let mainWindow = null;
let apiServer = null;
let updaterTimer = null;
let updaterReminderTimer = null;
const apiHost = process.env.M3U8_API_HOST || API.host;
const apiPort = Number(process.env.M3U8_API_PORT || API.port);

const updaterState = {
  phase: 'idle',
  message: 'Idle',
  progress: 0,
  updateInfo: null,
  releaseNotes: [],
  deferredUntil: null,
  nextReminderAt: null,
  reminderIntervalMs: null,
  lastCheckedAt: null,
  error: null,
};

const appSettingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function getLogsDirPath() {
  const logsDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function readSettings() {
  try {
    const file = appSettingsPath();
    if (!fs.existsSync(file)) {
      return {
        queueMaxConcurrent: 1,
        queueAutoStart: true,
        checkUpdatesOnStartup: true,
        tmdbApiKey: '',
        subdlApiKey: '',
        downloadThreads: 8,
      };
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      queueMaxConcurrent: parsed.queueMaxConcurrent ?? 1,
      queueAutoStart: parsed.queueAutoStart ?? true,
      checkUpdatesOnStartup: parsed.checkUpdatesOnStartup ?? true,
      tmdbApiKey: parsed.tmdbApiKey ?? '',
      subdlApiKey: parsed.subdlApiKey ?? '',
      downloadThreads: parsed.downloadThreads ?? 8,
    };
  } catch {
    return {
      queueMaxConcurrent: 1,
      queueAutoStart: true,
      checkUpdatesOnStartup: true,
      tmdbApiKey: '',
      subdlApiKey: '',
      downloadThreads: 8,
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

function buildDiagnosticsFilePath() {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\..+$/, '')
    .replace('T', '_');
  const diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  return path.join(diagnosticsDir, `diagnostics-${stamp}.json`);
}

function getDiagnosticsDirPath() {
  const diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  return diagnosticsDir;
}

function getDownloadDirPath() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  const downloadDir = path.join(dataDir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  return downloadDir;
}

function buildSupportBundleDirPath() {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\..+$/, '')
    .replace('T', '_');
  const bundlesDir = path.join(app.getPath('userData'), 'support-bundles');
  const bundleDir = path.join(bundlesDir, `support-bundle-${stamp}`);
  fs.mkdirSync(bundleDir, { recursive: true });
  return bundleDir;
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function copyPathIfExists(sourcePath, destPath) {
  if (!fs.existsSync(sourcePath)) return false;
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, destPath, { recursive: true });
    return true;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
  return true;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function clearUpdaterReminderTimer() {
  if (updaterReminderTimer) {
    clearTimeout(updaterReminderTimer);
    updaterReminderTimer = null;
  }
}

function normalizeReleaseNotes(updateInfo) {
  const source = updateInfo?.releaseNotes;
  if (!source) return [];
  if (typeof source === 'string') {
    return source.trim() ? [source.trim()] : [];
  }
  if (Array.isArray(source)) {
    return source
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry.note === 'string') return entry.note.trim();
        return '';
      })
      .filter(Boolean);
  }
  return [];
}

function scheduleUpdaterReminder(delayMs, intervalMs) {
  clearUpdaterReminderTimer();
  const safeDelay = Math.max(5_000, Number(delayMs) || 0);
  const safeInterval = Math.max(5 * 60 * 1000, Number(intervalMs) || 30 * 60 * 1000);
  updaterState.reminderIntervalMs = safeInterval;
  updaterState.nextReminderAt = Date.now() + safeDelay;
  sendToRenderer('updater:event', updaterState);

  updaterReminderTimer = setTimeout(() => {
    updaterReminderTimer = null;
    if (updaterState.phase !== 'downloaded') {
      updaterState.nextReminderAt = null;
      updaterState.deferredUntil = null;
      sendToRenderer('updater:event', updaterState);
      return;
    }

    const version = updaterState.updateInfo?.version || 'new';
    updaterState.message = `Reminder: Update ${version} is ready. Restart to install.`;
    updaterState.deferredUntil = null;
    sendToRenderer('updater:event', updaterState);

    scheduleUpdaterReminder(safeInterval, safeInterval);
  }, safeDelay);
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    clearUpdaterReminderTimer();
    updaterState.phase = 'checking';
    updaterState.message = 'Checking for updates...';
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
    updaterState.lastCheckedAt = Date.now();
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('update-available', (info) => {
    clearUpdaterReminderTimer();
    updaterState.phase = 'downloading';
    updaterState.message = `Downloading version ${info.version}...`;
    updaterState.updateInfo = info;
    updaterState.releaseNotes = normalizeReleaseNotes(info);
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('update-not-available', (info) => {
    clearUpdaterReminderTimer();
    updaterState.phase = 'idle';
    updaterState.message = 'You are up to date.';
    updaterState.updateInfo = info || null;
    updaterState.releaseNotes = normalizeReleaseNotes(info);
    updaterState.progress = 0;
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
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
    clearUpdaterReminderTimer();
    updaterState.phase = 'downloaded';
    updaterState.message = `Update ${info.version} downloaded. Restart to install.`;
    updaterState.updateInfo = info;
    updaterState.releaseNotes = normalizeReleaseNotes(info);
    updaterState.progress = 100;
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('error', (error) => {
    clearUpdaterReminderTimer();
    updaterState.phase = 'error';
    updaterState.message = 'Update check failed';
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
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
  process.env.LOG_DIR = process.env.LOG_DIR || getLogsDirPath();

  const savedSettings = readSettings();
  if (savedSettings.tmdbApiKey) {
    process.env.TMDB_API_KEY = savedSettings.tmdbApiKey;
  }
  if (savedSettings.subdlApiKey) {
    process.env.SUBDL_API_KEY = savedSettings.subdlApiKey;
  }

  const { createApiServer } = require('@m3u8/downloader-api');
  const apiConfig = require('@m3u8/downloader-api/src/config');
  if (savedSettings.downloadThreads > 0) {
    apiConfig.downloadThreads = savedSettings.downloadThreads;
  }
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

  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  const cspParts = [
    `default-src 'self'`,
    `script-src 'self'${isDev ? " 'unsafe-eval' 'unsafe-inline'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*`,
    `img-src 'self' data: http://127.0.0.1:* https://image.tmdb.org`,
    `font-src 'self' data:`,
  ];
  const csp = cspParts.join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
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
    const apiConfig = require('@m3u8/downloader-api/src/config');
    if ('tmdbApiKey' in (nextSettings || {})) {
      apiConfig.tmdbApiKey = merged.tmdbApiKey || '';
    }
    if ('subdlApiKey' in (nextSettings || {})) {
      apiConfig.subdlApiKey = merged.subdlApiKey || '';
    }
    if ('downloadThreads' in (nextSettings || {})) {
      apiConfig.downloadThreads = Number(merged.downloadThreads) || 0;
    }
    return merged;
  });

  ipcMain.handle('app:save-diagnostics-file', async (event, payload) => {
    try {
      const filePath = buildDiagnosticsFilePath();
      fs.writeFileSync(filePath, JSON.stringify(payload || {}, null, 2), 'utf8');
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('app:open-diagnostics-folder', async () => {
    try {
      const folderPath = getDiagnosticsDirPath();
      const openResult = await shell.openPath(folderPath);
      if (openResult) {
        return { ok: false, error: openResult, folderPath };
      }
      return { ok: true, folderPath };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('app:open-history-file', async (event, fileName) => {
    try {
      const safeName = path.basename(String(fileName || ''));
      if (!safeName) {
        return { ok: false, error: 'Missing file name' };
      }
      const filePath = path.join(getDownloadDirPath(), safeName);
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: 'File not found' };
      }
      const openResult = await shell.openPath(filePath);
      if (openResult) {
        return { ok: false, error: openResult, filePath };
      }
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('app:open-history-folder', async (event, fileName) => {
    try {
      const safeName = path.basename(String(fileName || ''));
      if (!safeName) {
        return { ok: false, error: 'Missing file name' };
      }
      const filePath = path.join(getDownloadDirPath(), safeName);
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: 'File not found' };
      }
      shell.showItemInFolder(filePath);
      return { ok: true, filePath, folderPath: path.dirname(filePath) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('app:export-support-bundle', async (event, payload) => {
    try {
      const userDataDir = app.getPath('userData');
      const dataDir = path.join(userDataDir, 'data');
      const downloadDir = path.join(dataDir, 'downloads');
      const queueFile = path.join(downloadDir, 'queue.json');
      const settingsFile = appSettingsPath();

      const bundleDir = buildSupportBundleDirPath();
      const included = [];

      const diagnosticsPath = path.join(bundleDir, 'diagnostics.json');
      fs.writeFileSync(diagnosticsPath, JSON.stringify(payload || {}, null, 2), 'utf8');
      included.push('diagnostics.json');

      const settingsSnapshotPath = path.join(bundleDir, 'settings.snapshot.json');
      fs.writeFileSync(settingsSnapshotPath, JSON.stringify(readSettings(), null, 2), 'utf8');
      included.push('settings.snapshot.json');

      const queueSnapshotPath = path.join(bundleDir, 'queue.snapshot.json');
      fs.writeFileSync(
        queueSnapshotPath,
        JSON.stringify(safeReadJson(queueFile, { queue: [], settings: {} }), null, 2),
        'utf8',
      );
      included.push('queue.snapshot.json');

      const metaPath = path.join(bundleDir, 'bundle.meta.json');
      fs.writeFileSync(metaPath, JSON.stringify({
        exportedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        apiBaseUrl: `http://${apiHost}:${apiPort}`,
        userDataDir,
      }, null, 2), 'utf8');
      included.push('bundle.meta.json');

      const logsDirInBundle = path.join(bundleDir, 'logs');
      const logCandidates = [
        path.join(userDataDir, 'logs'),
        path.join(dataDir, 'logs'),
        path.join(downloadDir, 'logs'),
        path.join(downloadDir, 'app.log'),
        path.join(downloadDir, 'download.log'),
        path.join(downloadDir, 'updater.log'),
      ];

      let copiedLogs = 0;
      for (const candidate of logCandidates) {
        const baseName = path.basename(candidate);
        const target = path.join(logsDirInBundle, baseName);
        try {
          if (copyPathIfExists(candidate, target)) {
            copiedLogs += 1;
          }
        } catch {
          // Continue copying the rest of available logs.
        }
      }
      if (copiedLogs > 0) {
        included.push('logs/');
      }

      // Keep original raw files when available for easier support diffing.
      if (copyPathIfExists(settingsFile, path.join(bundleDir, 'settings.raw.json'))) {
        included.push('settings.raw.json');
      }
      if (copyPathIfExists(queueFile, path.join(bundleDir, 'queue.raw.json'))) {
        included.push('queue.raw.json');
      }

      return { ok: true, bundlePath: bundleDir, included };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('updater:get-state', async () => ({ ...updaterState }));

  ipcMain.handle('updater:check-now', async () => checkForUpdatesNow());

  ipcMain.handle('updater:install-now', async () => {
    clearUpdaterReminderTimer();
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });

  ipcMain.handle('updater:remind-later', async (event, minutes = 30) => {
    if (updaterState.phase !== 'downloaded') {
      return { ok: false, error: 'No downloaded update to defer' };
    }
    const delayMs = Math.max(1, Number(minutes) || 30) * 60 * 1000;
    updaterState.deferredUntil = Date.now() + delayMs;
    updaterState.message = `Update deferred until ${new Date(updaterState.deferredUntil).toLocaleString()}`;
    scheduleUpdaterReminder(delayMs, delayMs);
    return { ok: true, deferredUntil: updaterState.deferredUntil };
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
  clearUpdaterReminderTimer();

  if (apiServer) {
    try {
      await apiServer.stop();
    } catch {
      // ignore shutdown error
    }
  }
});

bootstrap();
