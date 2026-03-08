const { app, BrowserWindow, ipcMain, shell, session, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { API } = require('@m3u8/contracts');

let mainWindow = null;
let apiServer = null;
let updaterTimer = null;
let updaterReminderTimer = null;
let updaterInstallTimer = null;
let updaterInstallRequested = false;
const apiHost = process.env.M3U8_API_HOST || API.host;
const apiPort = Number(process.env.M3U8_API_PORT || API.port);

const updaterState = {
  phase: 'idle',
  message: 'Idle',
  progress: 0,
  currentVersion: null,
  updateInfo: null,
  releaseNotes: [],
  deferredUntil: null,
  nextReminderAt: null,
  reminderIntervalMs: null,
  lastCheckedAt: null,
  error: null,
};

const appSettingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const updaterInstallStatePath = () => path.join(app.getPath('userData'), 'updater-install-state.json');

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
        outputDirectory: '',
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
      outputDirectory: parsed.outputDirectory ?? '',
      tmdbApiKey: parsed.tmdbApiKey ?? '',
      subdlApiKey: parsed.subdlApiKey ?? '',
      downloadThreads: parsed.downloadThreads ?? 8,
    };
  } catch {
    return {
      queueMaxConcurrent: 1,
      queueAutoStart: true,
      checkUpdatesOnStartup: true,
      outputDirectory: '',
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

function readUpdaterInstallState() {
  try {
    const file = updaterInstallStatePath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeUpdaterInstallState(next) {
  try {
    const file = updaterInstallStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[desktop] Failed to persist updater install state', err);
  }
}

function clearUpdaterInstallState() {
  try {
    const file = updaterInstallStatePath();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    console.warn('[desktop] Failed to clear updater install state', err);
  }
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

function getBundledYtDlpPath() {
  const explicit = String(process.env.YTDLP_PATH || process.env.YT_DLP_PATH || '').trim();
  if (explicit) {
    return explicit;
  }

  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', binaryName),
    path.join(app.getAppPath(), 'bin', binaryName),
    path.join(__dirname, '..', 'bin', binaryName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      if (process.platform !== 'win32') {
        fs.chmodSync(candidate, 0o755);
      }
      return candidate;
    } catch {
      continue;
    }
  }

  return '';
}

function getBundledBinaryPath(binaryNames = []) {
  const names = Array.isArray(binaryNames) ? binaryNames.filter(Boolean) : [];
  if (names.length === 0) return '';

  const candidates = [];
  for (const name of names) {
    candidates.push(path.join(process.resourcesPath || '', 'bin', name));
    candidates.push(path.join(app.getAppPath(), 'bin', name));
    candidates.push(path.join(__dirname, '..', 'bin', name));
  }

  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      if (process.platform !== 'win32') {
        fs.chmodSync(candidate, 0o755);
      }
      return candidate;
    } catch {
      continue;
    }
  }

  return '';
}

function getWindowIconPath() {
  const candidateNames = ['icon.png'];
  const candidates = [];
  for (const name of candidateNames) {
    candidates.push(path.join(process.resourcesPath || '', 'build', name));
    candidates.push(path.join(app.getAppPath(), 'build', name));
    candidates.push(path.join(__dirname, '..', 'build', name));
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function resolveHistoryFilePath(fileName) {
  const safeName = path.basename(String(fileName || ''));
  if (!safeName) return null;

  const downloadDir = getDownloadDirPath();
  const directPath = path.join(downloadDir, safeName);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  const indexPath = path.join(downloadDir, 'history-index.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
    const match = items.find((item) => item && item.fileName === safeName);
    if (match && typeof match.absolutePath === 'string' && match.absolutePath.trim()) {
      const absolutePath = String(match.absolutePath).trim();
      if (fs.existsSync(absolutePath)) {
        return absolutePath;
      }
    }
    if (match && typeof match.relativePath === 'string') {
      const normalizedRelative = String(match.relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!normalizedRelative.includes('..') && !normalizedRelative.includes('\0')) {
        const fullPath = path.join(downloadDir, normalizedRelative);
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }
    }
  } catch {
    // Index read failures fall through to filesystem scan.
  }

  const pending = [downloadDir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isFile() && entry.name === safeName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        pending.push(fullPath);
      }
    }
  }

  return null;
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

function clearUpdaterInstallTimer() {
  if (updaterInstallTimer) {
    clearTimeout(updaterInstallTimer);
    updaterInstallTimer = null;
  }
}

function isTranslocatedMacApp() {
  if (process.platform !== 'darwin') return false;
  try {
    const exePath = String(app.getPath('exe') || '');
    return exePath.includes('/AppTranslocation/') || exePath.startsWith('/private/var/folders/');
  } catch {
    return false;
  }
}

function isInstalledInApplicationsFolder() {
  if (process.platform !== 'darwin') return true;
  try {
    if (typeof app.isInApplicationsFolder === 'function') {
      return app.isInApplicationsFolder();
    }
  } catch {
    // Fall through to path heuristic.
  }

  try {
    const exePath = String(app.getPath('exe') || '');
    const homeApplications = path.join(app.getPath('home'), 'Applications') + path.sep;
    return exePath.startsWith('/Applications/') || exePath.startsWith(homeApplications);
  } catch {
    return false;
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

function showUpdateNotification(title, body) {
  try {
    if (!Notification || !Notification.isSupported()) return;
    new Notification({
      title,
      body,
      silent: false,
    }).show();
  } catch {
    // Notification delivery is best-effort.
  }
}

function reconcileUpdaterInstallState() {
  const state = readUpdaterInstallState();
  const currentVersion = app.getVersion();
  updaterState.currentVersion = currentVersion;
  if (!state || !state.targetVersion) return;

  if (state.targetVersion === currentVersion || state.fromVersion !== currentVersion) {
    console.info('[desktop] Previous updater install appears to have completed', {
      fromVersion: state.fromVersion,
      targetVersion: state.targetVersion,
      currentVersion,
    });
    clearUpdaterInstallState();
    return;
  }

  const attemptedAt = state.attemptedAt ? new Date(state.attemptedAt).toLocaleString() : 'an unknown time';
  updaterState.phase = 'error';
  updaterState.message = 'Previous update install did not complete';
  updaterState.error = `Tried to install ${state.targetVersion} on ${attemptedAt}, but the app reopened on ${currentVersion}. Move the app to /Applications and retry.`;
  updaterState.lastCheckedAt = Date.now();
  console.warn('[desktop] Previous updater install did not complete', {
    fromVersion: state.fromVersion,
    targetVersion: state.targetVersion,
    currentVersion,
    attemptedAt: state.attemptedAt,
  });
  clearUpdaterInstallState();
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
    clearUpdaterInstallTimer();
    updaterInstallRequested = false;
    clearUpdaterReminderTimer();
    updaterState.phase = 'checking';
    updaterState.message = 'Checking for updates...';
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
    updaterState.lastCheckedAt = Date.now();
    updaterState.error = null;
    updaterState.currentVersion = app.getVersion();
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('update-available', (info) => {
    clearUpdaterInstallTimer();
    updaterInstallRequested = false;
    clearUpdaterReminderTimer();
    updaterState.phase = 'downloading';
    updaterState.message = `Downloading version ${info.version}...`;
    updaterState.updateInfo = info;
    updaterState.releaseNotes = normalizeReleaseNotes(info);
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
    updaterState.error = null;
    updaterState.currentVersion = app.getVersion();
    sendToRenderer('updater:event', updaterState);
    showUpdateNotification(
      'VidSnag update available',
      `Version ${info.version} is available and is downloading now.`,
    );
  });

  autoUpdater.on('update-not-available', (info) => {
    clearUpdaterInstallTimer();
    updaterInstallRequested = false;
    clearUpdaterReminderTimer();
    updaterState.phase = 'idle';
    updaterState.message = `You are up to date on version ${app.getVersion()}.`;
    updaterState.updateInfo = info || null;
    updaterState.releaseNotes = normalizeReleaseNotes(info);
    updaterState.progress = 0;
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
    updaterState.error = null;
    updaterState.currentVersion = app.getVersion();
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('download-progress', (progress) => {
    updaterState.phase = 'downloading';
    updaterState.progress = Math.round(progress.percent || 0);
    updaterState.message = `Downloading update... ${updaterState.progress}%`;
    updaterState.error = null;
    updaterState.currentVersion = app.getVersion();
    sendToRenderer('updater:event', updaterState);
  });

  autoUpdater.on('update-downloaded', (info) => {
    clearUpdaterInstallTimer();
    updaterInstallRequested = false;
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
    updaterState.currentVersion = app.getVersion();
    sendToRenderer('updater:event', updaterState);
    showUpdateNotification(
      'VidSnag update ready',
      `Version ${info.version} has been downloaded. Restart the app to install it.`,
    );
  });

  autoUpdater.on('error', (error) => {
    clearUpdaterInstallTimer();
    updaterInstallRequested = false;
    clearUpdaterReminderTimer();
    updaterState.phase = 'error';
    updaterState.message = 'Update check failed';
    updaterState.deferredUntil = null;
    updaterState.nextReminderAt = null;
    updaterState.reminderIntervalMs = null;
    updaterState.error = error ? String(error.message || error) : 'Unknown updater error';
    updaterState.currentVersion = app.getVersion();
    sendToRenderer('updater:event', updaterState);
  });
}

async function checkForUpdatesNow() {
  updaterState.phase = 'checking';
  updaterState.message = 'Checking for updates...';
  updaterState.error = null;
  updaterState.currentVersion = app.getVersion();
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
  const bundledYtDlpPath = getBundledYtDlpPath();
  if (bundledYtDlpPath) {
    process.env.YTDLP_PATH = bundledYtDlpPath;
    process.env.YT_DLP_PATH = bundledYtDlpPath;
    console.info(`[desktop] Using bundled yt-dlp at ${bundledYtDlpPath}`);
  }
  const ffmpegBinaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffprobeBinaryName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const bundledFfmpegPath = getBundledBinaryPath([ffmpegBinaryName]);
  const bundledFfprobePath = getBundledBinaryPath([ffprobeBinaryName]);
  if (bundledFfmpegPath) {
    process.env.FFMPEG_PATH = bundledFfmpegPath;
    console.info(`[desktop] Using bundled ffmpeg at ${bundledFfmpegPath}`);
  }
  if (bundledFfprobePath) {
    process.env.FFPROBE_PATH = bundledFfprobePath;
    console.info(`[desktop] Using bundled ffprobe at ${bundledFfprobePath}`);
  }

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
    getCompletedOutputDir: () => String(readSettings().outputDirectory || '').trim(),
    ffmpegPath: bundledFfmpegPath || process.env.FFMPEG_PATH,
    ffprobePath: bundledFfprobePath || process.env.FFPROBE_PATH,
    ytDlpPath: bundledYtDlpPath || process.env.YTDLP_PATH || process.env.YT_DLP_PATH,
    trustBinaryPaths: Boolean(bundledFfmpegPath || bundledYtDlpPath),
    initialQueueSettings: {
      maxConcurrent: Number(savedSettings.queueMaxConcurrent) || 1,
      autoStart: savedSettings.queueAutoStart !== false,
    },
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
  if (apiServer && typeof apiServer.applyLegacyQueueSettings === 'function') {
    apiServer.applyLegacyQueueSettings({
      maxConcurrent: Number(savedSettings.queueMaxConcurrent) || 1,
      autoStart: savedSettings.queueAutoStart !== false,
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    icon: getWindowIconPath(),
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
    `img-src 'self' data: http://127.0.0.1:* https://image.tmdb.org https://i.ytimg.com https://*.ytimg.com`,
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
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('settings:get', async () => {
    const saved = readSettings();
    const queueSettings = apiServer && typeof apiServer.getQueueSettings === 'function'
      ? apiServer.getQueueSettings()
      : null;

    if (queueSettings) {
      return {
        ...saved,
        queueMaxConcurrent: Number(queueSettings.maxConcurrent) || 1,
        queueAutoStart: queueSettings.autoStart !== false,
      };
    }

    return saved;
  });

  ipcMain.handle('settings:save', async (event, nextSettings) => {
    const input = nextSettings || {};
    const queuePatch = {};
    if (typeof input.queueMaxConcurrent === 'number') {
      queuePatch.maxConcurrent = Math.max(1, Math.min(16, Number(input.queueMaxConcurrent) || 1));
    }
    if (typeof input.queueAutoStart === 'boolean') {
      queuePatch.autoStart = input.queueAutoStart;
    }
    if (
      Object.keys(queuePatch).length > 0
      && apiServer
      && typeof apiServer.updateQueueSettings === 'function'
    ) {
      apiServer.updateQueueSettings(queuePatch);
    }

    // Keep legacy queue keys readable for compatibility, but runtime canonical
    // values come from queue settings in queue.json.
    const merged = writeSettings(input);
    const apiConfig = require('@m3u8/downloader-api/src/config');
    if ('tmdbApiKey' in input) {
      apiConfig.tmdbApiKey = merged.tmdbApiKey || '';
    }
    if ('subdlApiKey' in input) {
      apiConfig.subdlApiKey = merged.subdlApiKey || '';
    }
    if ('downloadThreads' in input) {
      apiConfig.downloadThreads = Number(merged.downloadThreads) || 0;
    }
    const queueSettings = apiServer && typeof apiServer.getQueueSettings === 'function'
      ? apiServer.getQueueSettings()
      : null;
    return {
      ...merged,
      queueMaxConcurrent: Number(queueSettings?.maxConcurrent || merged.queueMaxConcurrent || 1),
      queueAutoStart: (queueSettings?.autoStart ?? merged.queueAutoStart) !== false,
    };
  });

  ipcMain.handle('settings:choose-output-directory', async () => {
    try {
      const current = readSettings();
      const result = await dialog.showOpenDialog(mainWindow || undefined, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: String(current.outputDirectory || '').trim() || app.getPath('downloads'),
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { ok: false, cancelled: true };
      }
      return { ok: true, path: result.filePaths[0] };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
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
      const filePath = resolveHistoryFilePath(safeName);
      if (!filePath || !fs.existsSync(filePath)) {
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
      const filePath = resolveHistoryFilePath(safeName);
      if (!filePath || !fs.existsSync(filePath)) {
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
    if (updaterState.phase !== 'downloaded') {
      return { ok: false, error: 'No downloaded update available' };
    }
    if (!app.isPackaged) {
      return { ok: false, error: 'Install update is only available in packaged builds' };
    }
    if (isTranslocatedMacApp()) {
      const error = 'Move the app to /Applications before installing updates';
      updaterState.phase = 'error';
      updaterState.message = 'Update install blocked';
      updaterState.error = error;
      sendToRenderer('updater:event', updaterState);
      return { ok: false, error };
    }
    if (!isInstalledInApplicationsFolder()) {
      const error = 'Auto-update only works when VidSnag is installed in /Applications';
      updaterState.phase = 'error';
      updaterState.message = 'Update install blocked';
      updaterState.error = error;
      sendToRenderer('updater:event', updaterState);
      return { ok: false, error };
    }

    updaterInstallRequested = true;
    clearUpdaterInstallTimer();
    updaterState.phase = 'installing';
    updaterState.message = 'Installing update and restarting...';
    updaterState.error = null;
    sendToRenderer('updater:event', updaterState);

    try {
      autoUpdater.autoInstallOnAppQuit = true;
      writeUpdaterInstallState({
        attemptedAt: new Date().toISOString(),
        fromVersion: app.getVersion(),
        targetVersion: updaterState.updateInfo?.version || null,
        platform: process.platform,
        exePath: app.getPath('exe'),
      });
      setImmediate(() => {
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (err) {
          updaterInstallRequested = false;
          clearUpdaterInstallState();
          updaterState.phase = 'error';
          updaterState.message = 'Update install failed';
          updaterState.error = String((err && err.message) || err || 'Unknown updater error');
          sendToRenderer('updater:event', updaterState);
          console.error('[desktop] quitAndInstall failed', err);
        }
      });

      return { ok: true };
    } catch (err) {
      updaterInstallRequested = false;
      clearUpdaterInstallState();
      updaterState.phase = 'error';
      updaterState.message = 'Update install failed';
      updaterState.error = String((err && err.message) || err || 'Unknown updater error');
      sendToRenderer('updater:event', updaterState);
      return { ok: false, error: updaterState.error };
    }
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
  reconcileUpdaterInstallState();

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
  updaterInstallRequested = false;
  clearUpdaterInstallTimer();
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
