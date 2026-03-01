const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');
const { API, HEADER, CLIENT } = require('@m3u8/contracts');
const {
  QueueManager,
  createJobProcessor,
  startCleanupScheduler,
  config: engineConfig,
} = require('@m3u8/downloader-engine');

const registerHistoryRoutes = require('./routes/history');
const registerQueueRoutes = require('./routes/queue');
const registerJobRoutes = require('./routes/jobs');
const logger = require('./utils/logger');
const { jobValidation } = require('./utils/validators');
const { lookupPoster } = require('./services/tmdb');
const appConfig = require('./config');
const AuthManager = require('./auth/AuthManager');

function detectFFmpegPath(explicitPath) {
  const possiblePaths = [
    explicitPath,
    process.env.FFMPEG_PATH,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'ffmpeg',
  ];

  for (const ffmpegPath of possiblePaths) {
    if (!ffmpegPath) continue;
    try {
      execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore', timeout: 5000 });
      logger.info('FFmpeg detected', { ffmpegPath });
      return ffmpegPath;
    } catch {
      continue;
    }
  }

  logger.warn('FFmpeg not detected - conversion and thumbnails disabled');
  return null;
}

function createApiServer(options = {}) {
  const {
    host = API.host,
    port = API.port,
    appVersion = '0.0.0',
    dataDir,
    downloadDir,
    ffmpegPath,
    ffprobePath,
    onFocus,
  } = options;

  if (!dataDir) {
    throw new Error('createApiServer requires dataDir');
  }

  const resolvedDownloadDir = downloadDir || path.join(dataDir, 'downloads');
  fs.mkdirSync(resolvedDownloadDir, { recursive: true });

  const authManager = new AuthManager({ dataDir });

  const FFMPEG_PATH = detectFFmpegPath(ffmpegPath);
  const FFPROBE_PATH = ffprobePath || process.env.FFPROBE_PATH
    || (FFMPEG_PATH ? FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : null);

  const fsPromises = fs.promises;

  const app = express();
  const server = http.createServer(app);

  app.use((req, res, next) => {
    res.setHeader(HEADER.apiVersion, API.apiVersion);
    next();
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = !origin
      || origin.startsWith('chrome-extension://')
      || origin === 'null'
      || origin.startsWith('file://')
      || origin.startsWith('http://127.0.0.1')
      || origin.startsWith('http://localhost');

    if (!allowed) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Headers', `${HEADER.authorization},Content-Type,${HEADER.client},${HEADER.protocolVersion}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use('/downloads', express.static(resolvedDownloadDir));

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const jobCreationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    message: 'Too many jobs submitted. Try again shortly.',
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api', apiLimiter);
  app.use('/v1', apiLimiter);
  app.use('/api/jobs', jobCreationLimiter);
  app.use('/api/queue/add', jobCreationLimiter);
  app.use('/v1/jobs', jobCreationLimiter);

  const jobs = new Map();

  function safeFilename(name) {
    return (name || 'video.ts').replace(/[^a-z0-9._-]+/gi, '_');
  }

  function createJobId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getJobTempDirForUrl(m3u8Url) {
    try {
      const u = new URL(m3u8Url);
      const base = `${u.hostname}${u.pathname}`;
      const slug = base
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'playlist';
      return path.join(resolvedDownloadDir, `temp-${slug}`);
    } catch {
      const slug = safeFilename(String(m3u8Url)).replace(/\.[a-z0-9]{2,4}$/i, '');
      return path.join(resolvedDownloadDir, `temp-${slug}`);
    }
  }

  const { runJob, runDirectJob } = createJobProcessor({
    downloadDir: resolvedDownloadDir,
    FFMPEG_PATH,
    FFPROBE_PATH,
    DEFAULT_MAX_CONCURRENT: engineConfig.defaultMaxConcurrent,
    DEFAULT_MAX_SEGMENT_ATTEMPTS: engineConfig.defaultMaxSegmentAttempts,
    fsPromises,
    getJobTempDirForUrl,
  });

  const queueManager = new QueueManager({
    queueFilePath: path.join(resolvedDownloadDir, 'queue.json'),
    fsPromises,
    jobs,
    runJob,
    runDirectJob,
  });

  function mergeThumbnailUrls(job) {
    const localThumbs = Array.isArray(job.thumbnailPaths)
      ? job.thumbnailPaths.filter((p) => fs.existsSync(p)).map((p) => `/downloads/${path.basename(p)}`)
      : (job.thumbnailPath && fs.existsSync(job.thumbnailPath)
        ? [`/downloads/${path.basename(job.thumbnailPath)}`]
        : []);

    const remoteThumbs = Array.isArray(job.thumbnailUrls)
      ? job.thumbnailUrls.filter((u) => typeof u === 'string' && u.startsWith('http'))
      : [];

    return [...remoteThumbs, ...localThumbs];
  }

  function buildJobStatusPayload(job) {
    if (!job) return null;

    return {
      id: job.id,
      status: job.status,
      title: job.title,
      progress: job.progress,
      totalSegments: job.totalSegments,
      completedSegments: job.completedSegments,
      bytesDownloaded: job.bytesDownloaded,
      failedSegments: Array.isArray(job.failedSegments) ? job.failedSegments.length : 0,
      threadStates: Array.isArray(job.threadStates) ? job.threadStates : [],
      segmentStates: job.segmentStates || {},
      error: job.error,
      thumbnailUrls: mergeThumbnailUrls(job),
      updatedAt: job.updatedAt,
    };
  }

  function buildLegacyJobFromQueue(queue, threads, settings) {
    const id = createJobId();

    let baseName = 'video';
    const customName = settings && typeof settings.customName === 'string'
      ? settings.customName.trim()
      : '';
    const namingMode = settings && typeof settings.fileNaming === 'string'
      ? settings.fileNaming
      : 'title';

    if (customName) {
      baseName = customName;
    } else if (namingMode === 'resource') {
      baseName = queue.name || queue.title || 'video';
    } else {
      baseName = queue.title || queue.name || 'video';
    }

    const fileNameBase = safeFilename(baseName);
    const isHls = /\.m3u8(\?|$)/i.test(queue.url || '');

    let filePath;
    let tsName;
    let downloadNameMp4;

    if (isHls) {
      tsName = fileNameBase;
      if (/\.m3u8$/i.test(tsName)) {
        tsName = tsName.replace(/\.m3u8$/i, '.ts');
      } else if (!/\.[a-z0-9]{2,4}$/i.test(tsName)) {
        tsName = `${tsName}.ts`;
      }

      filePath = path.join(resolvedDownloadDir, `${id}-${tsName}`);

      downloadNameMp4 = fileNameBase;
      if (/\.m3u8$/i.test(downloadNameMp4)) {
        downloadNameMp4 = downloadNameMp4.replace(/\.m3u8$/i, '.mp4');
      } else if (!/\.[a-z0-9]{2,4}$/i.test(downloadNameMp4)) {
        downloadNameMp4 = `${downloadNameMp4}.mp4`;
      }
    } else {
      let ext = '';
      try {
        const u = new URL(queue.url);
        ext = path.extname(u.pathname) || '';
      } catch {
        ext = '';
      }

      if (!ext || !/^\.[a-z0-9]{2,4}$/i.test(ext)) {
        ext = '.mp4';
      }

      const directName = `${fileNameBase}${ext}`;
      filePath = path.join(resolvedDownloadDir, `${id}-${directName}`);
      tsName = directName;
      downloadNameMp4 = directName;
    }

    const job = {
      id,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: baseName || queue.title || queue.name || 'Download',
      url: queue.url,
      headers: queue.headers || {},
      totalSegments: 0,
      completedSegments: 0,
      bytesDownloaded: 0,
      progress: 0,
      error: null,
      filePath,
      downloadName: tsName,
      mp4Path: null,
      thumbnailPath: null,
      thumbnailPaths: null,
      thumbnailUrls: [],
      skipThumbnailGeneration: true,
      downloadNameMp4,
      cancelled: false,
      maxConcurrent: Number.isFinite(threads) && threads > 0
        ? Math.min(16, threads)
        : engineConfig.defaultMaxConcurrent,
      maxSegmentAttempts: (() => {
        const raw = settings && typeof settings.maxSegmentAttempts === 'string'
          ? settings.maxSegmentAttempts
          : null;
        if (raw === 'infinite') {
          return Infinity;
        }
        const n = raw != null ? parseInt(raw, 10) : engineConfig.defaultMaxSegmentAttempts;
        if (!Number.isFinite(n) || n <= 0) {
          return engineConfig.defaultMaxSegmentAttempts;
        }
        return n;
      })(),
      lastSentSegmentStates: {},
    };

    return { job, isHls };
  }

  async function enrichTmdb(job) {
    if (!appConfig.tmdbApiKey) return;

    try {
      const result = await lookupPoster({
        apiKey: appConfig.tmdbApiKey,
        title: job.title || job.downloadName,
      });

      if (result) {
        job.thumbnailUrls = [result.posterUrl, result.backdropUrl].filter(Boolean);
        job.tmdbId = result.id;
        job.tmdbTitle = result.title;
        job.tmdbReleaseDate = result.releaseDate;
        queueManager.saveQueue();
      }
    } catch (err) {
      logger.warn('TMDB lookup failed', { jobId: job.id, error: err.message });
    }
  }

  function enqueueLegacyRequest({ queue, threads, settings }) {
    const { job } = buildLegacyJobFromQueue(queue, threads, settings);
    const result = queueManager.addJob(job);
    enrichTmdb(job);
    return { ...result, job };
  }

  function parseBearerToken(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || typeof authHeader !== 'string') return null;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
  }

  function validateV1ClientHeaders(req, res, next) {
    const client = String(req.headers[HEADER.client.toLowerCase()] || '').trim();
    const protocolVersion = String(req.headers[HEADER.protocolVersion.toLowerCase()] || '').trim();

    if (client && client !== CLIENT.extension) {
      res.status(400).json({ error: `Invalid ${HEADER.client} header` });
      return;
    }

    if (protocolVersion && protocolVersion !== API.protocolVersion) {
      res.status(400).json({ error: `Unsupported ${HEADER.protocolVersion} header` });
      return;
    }

    next();
  }

  function isValidHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return false;
    }

    try {
      const parsed = new URL(value.trim());
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function sanitizeString(value, max = 255) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, max);
  }

  function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
      return {};
    }

    const output = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        continue;
      }
      const normalizedKey = key.trim();
      if (!normalizedKey || normalizedKey.length > 128) {
        continue;
      }
      output[normalizedKey] = value.slice(0, 4096);
    }
    return output;
  }

  function validatePairRequest(body) {
    const payload = body && typeof body === 'object' ? body : {};
    const pairingCode = sanitizeString(payload.pairingCode, 32).toUpperCase();
    const extensionId = sanitizeString(payload.extensionId, 128);
    const extensionVersion = sanitizeString(payload.extensionVersion, 64);
    const browser = sanitizeString(payload.browser, 32) || 'chrome';

    if (!pairingCode) {
      const err = new Error('pairingCode is required');
      err.statusCode = 400;
      throw err;
    }

    if (!extensionId) {
      const err = new Error('extensionId is required');
      err.statusCode = 400;
      throw err;
    }

    return {
      pairingCode,
      extensionId,
      extensionVersion,
      browser,
    };
  }

  function validateCreateJobRequest(body) {
    const payload = body && typeof body === 'object' ? body : {};
    const mediaUrl = sanitizeString(payload.mediaUrl, 4096);
    const mediaType = sanitizeString(payload.mediaType, 16).toLowerCase();

    if (!isValidHttpUrl(mediaUrl)) {
      const err = new Error('mediaUrl must be a valid http/https URL');
      err.statusCode = 400;
      throw err;
    }

    if (mediaType && mediaType !== 'hls' && mediaType !== 'file') {
      const err = new Error('mediaType must be one of: hls, file');
      err.statusCode = 400;
      throw err;
    }

    const settingsInput = payload.settings && typeof payload.settings === 'object'
      ? payload.settings
      : {};

    const rawThreads = Number(settingsInput.threads);
    const threads = Number.isFinite(rawThreads)
      ? Math.max(1, Math.min(16, Math.floor(rawThreads)))
      : engineConfig.defaultMaxConcurrent;

    const fileNaming = ['title', 'resource', 'custom'].includes(settingsInput.fileNaming)
      ? settingsInput.fileNaming
      : 'title';

    const maxSegmentAttempts = settingsInput.maxSegmentAttempts === 'infinite'
      ? 'infinite'
      : (() => {
        const value = Number(settingsInput.maxSegmentAttempts);
        if (!Number.isFinite(value) || value <= 0) return 'infinite';
        return String(Math.floor(value));
      })();

    return {
      mediaUrl,
      mediaType: mediaType || (/\.m3u8(\?|$)/i.test(mediaUrl) ? 'hls' : 'file'),
      title: sanitizeString(payload.title, 255),
      resourceName: sanitizeString(payload.resourceName, 255),
      sourcePageUrl: sanitizeString(payload.sourcePageUrl, 4096),
      sourcePageTitle: sanitizeString(payload.sourcePageTitle, 255),
      headers: sanitizeHeaders(payload.headers),
      settings: {
        fileNaming,
        customName: sanitizeString(settingsInput.customName, 255),
        maxSegmentAttempts,
        threads,
      },
    };
  }

  app.use('/v1', validateV1ClientHeaders);

  function requireAuth(req, res, next) {
    const token = parseBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }

    const tokenRecord = authManager.verifyToken(token);
    if (!tokenRecord) {
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }

    req.authToken = tokenRecord;
    next();
  }

  app.get('/v1/health', (req, res) => {
    res.json({
      status: 'ok',
      appVersion,
      apiVersion: API.apiVersion,
      pairingRequired: authManager.isPairingRequired(),
      wsPath: '/ws',
    });
  });

  app.post('/v1/pair/complete', (req, res) => {
    try {
      const payload = validatePairRequest(req.body || {});
      const response = authManager.completePairing(payload);
      res.json(response);
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: err.message || 'Pairing failed' });
    }
  });

  app.post('/v1/jobs', requireAuth, (req, res) => {
    let body;
    try {
      body = validateCreateJobRequest(req.body || {});
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: err.message || 'Invalid job request' });
      return;
    }

    const queue = {
      url: body.mediaUrl,
      title: body.title || body.sourcePageTitle || body.resourceName || 'Download',
      name: body.resourceName || body.title || 'media',
      headers: body.headers || {},
      sourcePageUrl: body.sourcePageUrl || '',
    };

    const settings = {
      fileNaming: body.settings.fileNaming,
      customName: body.settings.customName,
      maxSegmentAttempts: body.settings.maxSegmentAttempts,
    };

    const threads = body.settings.threads;

    const { id, queuePosition } = enqueueLegacyRequest({ queue, threads, settings });

    res.json({
      jobId: id,
      queuePosition,
      status: 'queued',
      acceptedAt: new Date().toISOString(),
    });
  });

  app.get('/v1/queue', requireAuth, (req, res) => {
    res.json({
      queue: queueManager.getQueue(),
      settings: queueManager.getSettings(),
    });
  });

  app.post('/v1/app/focus', requireAuth, async (req, res) => {
    if (typeof onFocus === 'function') {
      try {
        await Promise.resolve(onFocus());
      } catch (err) {
        logger.warn('onFocus callback failed', { error: err.message });
      }
    }
    res.json({ ok: true });
  });

  // Temporary compatibility endpoints for legacy clients.
  app.post('/api/queue/add', jobValidation, (req, res) => {
    const { queue, threads, settings } = req.body || {};
    if (!queue || !queue.url) {
      res.status(400).json({ error: 'Missing queue.url in request body' });
      return;
    }

    const result = enqueueLegacyRequest({ queue, threads, settings });
    res.json({ id: result.id, queuePosition: result.queuePosition });
  });

  registerHistoryRoutes(app, fsPromises, resolvedDownloadDir);
  registerQueueRoutes(app, queueManager);
  registerJobRoutes(
    app,
    jobs,
    queueManager,
    resolvedDownloadDir,
    createJobId,
    safeFilename,
    engineConfig.defaultMaxConcurrent,
    engineConfig.defaultMaxSegmentAttempts,
    runJob,
    runDirectJob,
  );

  const wss = new WebSocket.Server({ server, path: '/ws' });
  const jobSubscriptions = new Map();
  const clientSubscriptions = new Map();
  const lastSentTimestamps = new Map();

  function subscribeClientToJob(ws, jobId) {
    if (!jobId) return;

    let jobsForClient = clientSubscriptions.get(ws);
    if (!jobsForClient) {
      jobsForClient = new Set();
      clientSubscriptions.set(ws, jobsForClient);
    }
    jobsForClient.add(jobId);

    let subscribers = jobSubscriptions.get(jobId);
    if (!subscribers) {
      subscribers = new Set();
      jobSubscriptions.set(jobId, subscribers);
    }
    subscribers.add(ws);
  }

  function unsubscribeClient(ws) {
    const jobsForClient = clientSubscriptions.get(ws);
    if (!jobsForClient) return;

    jobsForClient.forEach((jobId) => {
      const subscribers = jobSubscriptions.get(jobId);
      if (subscribers) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          jobSubscriptions.delete(jobId);
          lastSentTimestamps.delete(jobId);
        }
      }
    });

    clientSubscriptions.delete(ws);
  }

  function broadcastJobUpdate(job) {
    if (!job || !job.id) return;
    const subscribers = jobSubscriptions.get(job.id);
    if (!subscribers || subscribers.size === 0) return;

    const payload = buildJobStatusPayload(job);
    if (!payload) return;

    const message = JSON.stringify({ type: 'job:update', data: payload });
    subscribers.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message && message.type === 'subscribe' && message.jobId) {
          subscribeClientToJob(ws, String(message.jobId));

          const job = jobs.get(String(message.jobId));
          if (job) {
            lastSentTimestamps.set(job.id, job.updatedAt || Date.now());
            broadcastJobUpdate(job);
          }
        }
      } catch (err) {
        logger.warn('Failed to parse WebSocket message', { error: err.message });
      }
    });

    ws.on('close', () => {
      unsubscribeClient(ws);
    });

    ws.on('error', () => {
      unsubscribeClient(ws);
    });
  });

  const broadcastInterval = setInterval(() => {
    jobSubscriptions.forEach((subscribers, jobId) => {
      if (!subscribers || subscribers.size === 0) {
        jobSubscriptions.delete(jobId);
        lastSentTimestamps.delete(jobId);
        return;
      }

      const job = jobs.get(jobId);
      if (!job) {
        jobSubscriptions.delete(jobId);
        lastSentTimestamps.delete(jobId);
        return;
      }

      const lastSent = lastSentTimestamps.get(jobId) || 0;
      const updatedAt = job.updatedAt || 0;
      if (updatedAt > lastSent) {
        lastSentTimestamps.set(jobId, updatedAt);
        broadcastJobUpdate(job);
      }
    });
  }, 500);

  let started = false;
  let cleanupTimer = null;

  function start() {
    if (started) return Promise.resolve({ host, port });

    started = true;

    cleanupTimer = startCleanupScheduler({
      fsPromises,
      downloadDir: resolvedDownloadDir,
      intervalMs: engineConfig.cleanupIntervalMs,
      tempMaxAgeHours: engineConfig.cleanupAgeHours,
      downloadMaxAgeHours: engineConfig.downloadRetentionHours,
    });

    return new Promise((resolve) => {
      server.listen(port, host, () => {
        logger.info('Downloader API listening', { host, port });
        resolve({ host, port });
      });
    });
  }

  function stop() {
    if (!started) return Promise.resolve();
    started = false;

    clearInterval(broadcastInterval);
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }

    return new Promise((resolve, reject) => {
      wss.close(() => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    });
  }

  return {
    app,
    server,
    start,
    stop,
    authManager,
    getState: () => ({
      queue: queueManager.getQueue(),
      settings: queueManager.getSettings(),
      pairingRequired: authManager.isPairingRequired(),
      appVersion,
      apiVersion: API.apiVersion,
    }),
  };
}

module.exports = {
  createApiServer,
};
