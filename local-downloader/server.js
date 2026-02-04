const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');

// Route modules
const registerPageRoutes = require('./src/routes/pages');
const registerHistoryRoutes = require('./src/routes/history');
const registerQueueRoutes = require('./src/routes/queue');
const registerJobRoutes = require('./src/routes/jobs');

// Core modules
const QueueManager = require('./src/core/QueueManager');
const { createJobProcessor } = require('./src/core/JobProcessor');
const { startCleanupScheduler: startCleanupServiceScheduler } = require('./src/services/CleanupService');
const { lookupPoster } = require('./src/services/tmdb');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const { jobValidation } = require('./src/utils/validators');

const fsPromises = fs.promises;

function detectFFmpegPath() {
  const possiblePaths = [
    process.env.FFMPEG_PATH,
    '/opt/homebrew/bin/ffmpeg',      // macOS ARM Homebrew
    '/usr/local/bin/ffmpeg',         // macOS Intel Homebrew
    '/usr/bin/ffmpeg',               // Linux
    'C:\\ffmpeg\\bin\\ffmpeg.exe',   // Windows default
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'ffmpeg'                         // System PATH
  ];

  for (const ffmpegPath of possiblePaths) {
    if (!ffmpegPath) continue;
    try {
      execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore', timeout: 5000 });
      logger.info('FFmpeg detected', { ffmpegPath });
      return ffmpegPath;
    } catch (e) {
      continue;
    }
  }
  logger.warn('FFmpeg not detected - video conversion and thumbnails will be disabled');
  return null;
}

const FFMPEG_PATH = detectFFmpegPath();
const FFPROBE_PATH = process.env.FFPROBE_PATH
  || (FFMPEG_PATH ? FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : null);

const app = express();
const PORT = config.port;

const publicDir = path.join(__dirname, 'public');
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir, { recursive: true });
}

// Serve static downloads (e.g., thumbnails, completed files) under /downloads
app.use('/downloads', express.static(downloadDir));

// Cleanup configuration
const CLEANUP_AGE_HOURS = config.cleanupAgeHours; // temp segments
const DOWNLOAD_RETENTION_HOURS = config.downloadRetentionHours; // completed files
const CLEANUP_INTERVAL_MS = config.cleanupIntervalMs;

app.use(express.static(publicDir));
app.use(express.json({ limit: '1mb' }));

// Rate limiting middleware
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
});

const jobCreationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 job creations per minute
  message: 'Too many download jobs created, please slow down',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limiter to all API routes
app.use('/api/', apiLimiter);

// Apply stricter rate limiter to job creation endpoints
app.use('/api/jobs', jobCreationLimiter);
app.use('/api/queue/add', jobCreationLimiter);

if (!FFMPEG_PATH) {
  logger.warn(`
╔════════════════════════════════════════════════════════════╗
║  WARNING: FFmpeg not detected                              ║
║  Video conversion and thumbnails will be disabled          ║
║                                                            ║
║  Install FFmpeg:                                           ║
║    macOS:    brew install ffmpeg                           ║
║    Ubuntu:   sudo apt-get install ffmpeg                   ║
║    Windows:  choco install ffmpeg                          ║
║                                                            ║
║  Or set FFMPEG_PATH env var to your ffmpeg binary.         ║
╚════════════════════════════════════════════════════════════╝
`);
}

// In-memory job store. This is simple and resets when the server restarts.
const jobs = new Map();

const DEFAULT_MAX_CONCURRENT = config.defaultMaxConcurrent;

// Default maximum total attempts per segment (initial + retries).
const DEFAULT_MAX_SEGMENT_ATTEMPTS = config.defaultMaxSegmentAttempts;

// Helper to get temp directory for segment files.
// Historically this used the job id; we now derive it from the m3u8 URL so
// that repeated downloads of the same playlist can reuse existing segments.
function getJobTempDirForUrl(m3u8Url) {
  try {
    const u = new URL(m3u8Url);
    // Build a stable, filesystem-safe slug from host + pathname.
    const base = `${u.hostname}${u.pathname}`;
    const slug = base
      .replace(/[^a-z0-9._-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'playlist';
    return path.join(downloadDir, `temp-${slug}`);
  } catch {
    // Fallback: use a generic temp directory based on a safe filename of the raw URL.
    const slug = safeFilename(String(m3u8Url)).replace(/\.[a-z0-9]{2,4}$/i, '');
    return path.join(downloadDir, `temp-${slug}`);
  }
}

// Job processor (HLS + direct download logic)
const { runJob, runDirectJob } = createJobProcessor({
  downloadDir,
  FFMPEG_PATH,
  FFPROBE_PATH,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_SEGMENT_ATTEMPTS,
  fsPromises,
  getJobTempDirForUrl,
});

// Schedule periodic cleanup using CleanupService
function initializeCleanupScheduler() {
  startCleanupServiceScheduler({
    fsPromises,
    downloadDir,
    intervalMs: CLEANUP_INTERVAL_MS,
    tempMaxAgeHours: CLEANUP_AGE_HOURS,
    downloadMaxAgeHours: DOWNLOAD_RETENTION_HOURS,
  });
}

function createJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeFilename(name) {
  return (name || 'video.ts').replace(/[^a-z0-9._-]+/gi, '_');
}

// Register routes (QueueManager is initialized below, after job functions are defined)
registerPageRoutes(app, publicDir);

// History API routes
registerHistoryRoutes(app, fsPromises, downloadDir);

// POST /api/queue/add - Add job to queue
app.post('/api/queue/add', jobValidation, (req, res) => {
  const { queue, threads, settings } = req.body || {};
  if (!queue || !queue.url) {
    return res.status(400).json({ error: 'Missing queue.url in request body' });
  }

  const id = createJobId();

  // Decide base name using client settings when available.
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

    filePath = path.join(downloadDir, `${id}-${tsName}`);

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
    filePath = path.join(downloadDir, `${id}-${directName}`);
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
    maxConcurrent: Number.isFinite(threads) && threads > 0 ? threads : DEFAULT_MAX_CONCURRENT,
    maxSegmentAttempts: (() => {
      const raw = settings && typeof settings.maxSegmentAttempts === 'string'
        ? settings.maxSegmentAttempts
        : null;
      if (raw === 'infinite') {
        return Infinity;
      }
      const n = raw != null ? parseInt(raw, 10) : DEFAULT_MAX_SEGMENT_ATTEMPTS;
      if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_MAX_SEGMENT_ATTEMPTS;
      }
      return n;
    })(),
    lastSentSegmentStates: {},
  };
  
  const result = queueManager.addJob(job);
  (async () => {
    if (!config.tmdbApiKey) {
      logger.info('TMDB lookup skipped (no TMDB_API_KEY set)', { jobId: job.id, title: job.title });
      return;
    }

    const title = job.title || job.downloadName;
    logger.info('TMDB lookup start', { jobId: job.id, title });

    try {
      const tmdbResult = await lookupPoster({ apiKey: config.tmdbApiKey, title });
      if (tmdbResult) {
        job.thumbnailUrls = [tmdbResult.posterUrl, tmdbResult.backdropUrl].filter(Boolean);
        job.tmdbId = tmdbResult.id;
        job.tmdbTitle = tmdbResult.title;
        job.tmdbReleaseDate = tmdbResult.releaseDate;
        job.skipThumbnailGeneration = true;
        queueManager.saveQueue();
        logger.info('TMDB lookup success', { jobId: job.id, tmdbId: tmdbResult.id, thumbnails: job.thumbnailUrls.length });
      } else {
        logger.info('TMDB lookup returned no results', { jobId: job.id, title });
      }
    } catch (err) {
      logger.warn('TMDB lookup failed', { jobId: job.id, error: err.message });
    }
  })();
  res.json(result);
});

// Initialize queue manager now that jobs map and job functions are defined
const queueManager = new QueueManager({
  queueFilePath: path.join(downloadDir, 'queue.json'),
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

// Helper to build a job status snapshot (mirrors /api/jobs/:id response shape)
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
    tmdbId: job.tmdbId,
    tmdbTitle: job.tmdbTitle,
    tmdbReleaseDate: job.tmdbReleaseDate,
    tmdbMetadata: job.tmdbMetadata,
    updatedAt: job.updatedAt,
  };
}

// HTTP server (shared between Express and WebSocket server)
const server = http.createServer(app);

// WebSocket server for real-time job updates
const wss = new WebSocket.Server({ server, path: '/ws' });

// jobId -> Set<WebSocket>
const jobSubscriptions = new Map();
// WebSocket -> Set<jobId>
const clientSubscriptions = new Map();
// jobId -> last sent updatedAt
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
  logger.info('WebSocket client connected');

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message && message.type === 'subscribe' && message.jobId) {
        subscribeClientToJob(ws, String(message.jobId));

        // On initial subscription, immediately send the current snapshot if we have it
        const job = jobs.get(String(message.jobId));
        if (job) {
          lastSentTimestamps.set(job.id, job.updatedAt || Date.now());
          broadcastJobUpdate(job);
        }
      }
    } catch (err) {
      logger.warn('Failed to parse WebSocket message', { error: err && err.message });
    }
  });

  ws.on('close', () => {
    unsubscribeClient(ws);
    logger.info('WebSocket client disconnected');
  });

  ws.on('error', (err) => {
    unsubscribeClient(ws);
    logger.warn('WebSocket client error', { error: err && err.message });
  });
});

// Periodically scan for updated jobs and broadcast changes to subscribed clients
setInterval(() => {
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

// Queue API Endpoints
registerQueueRoutes(app, queueManager);

// Job API routes
registerJobRoutes(
  app,
  jobs,
  queueManager,
  downloadDir,
  createJobId,
  safeFilename,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_SEGMENT_ATTEMPTS,
  runJob,
  runDirectJob
);

server.listen(PORT, () => {
  logger.info('Local downloader UI listening', { url: `http://localhost:${PORT}` });

  // Start the cleanup scheduler
  initializeCleanupScheduler();
});
