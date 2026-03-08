const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawnSync } = require('child_process');
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
const { HistoryIndexService } = require('./services/historyIndex');
const logger = require('./utils/logger');
const { inferMediaMetadata } = require('./utils/mediaMetadata');
const { lookupPoster } = require('./services/tmdb');
const {
  buildDownloadAssetUrl,
  buildJobStorageDir,
  decodeExternalDownloadPath,
  EXTERNAL_DOWNLOAD_PREFIX,
  isInsideDirectory,
} = require('./utils/downloadPaths');
const appConfig = require('./config');

const TMDB_CACHE_VERSION = 1;
const TMDB_CACHE_MAX_ENTRIES = 2000;
const TMDB_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function detectFFmpegPath(explicitPath, options = {}) {
  const trustExplicitPath = Boolean(options.trustExplicitPath);
  if (trustExplicitPath && explicitPath && fs.existsSync(explicitPath)) {
    logger.info('FFmpeg detected (trusted explicit path)', { ffmpegPath: explicitPath });
    return explicitPath;
  }

  const possiblePaths = [
    explicitPath,
    process.env.FFMPEG_PATH,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'ffmpeg',
  ].filter(Boolean);
  const dedupedPaths = [...new Set(possiblePaths)];

  for (const ffmpegPath of dedupedPaths) {
    try {
      const probe = spawnSync(ffmpegPath, ['-version'], {
        stdio: 'ignore',
        timeout: 20_000,
      });
      if (probe.status !== 0) {
        // Some binaries can exceed the probe timeout in constrained environments.
        if (probe.error && probe.error.code === 'ETIMEDOUT' && fs.existsSync(ffmpegPath)) {
          logger.info('FFmpeg probe timed out; using configured path', { ffmpegPath });
          return ffmpegPath;
        }
        continue;
      }
      logger.info('FFmpeg detected', { ffmpegPath });
      return ffmpegPath;
    } catch {
      continue;
    }
  }

  logger.warn('FFmpeg not detected - conversion and thumbnails disabled');
  return null;
}

function detectYtDlpPath(explicitPath, options = {}) {
  const trustExplicitPath = Boolean(options.trustExplicitPath);
  if (trustExplicitPath && explicitPath && fs.existsSync(explicitPath)) {
    logger.info('yt-dlp detected (trusted explicit path)', { ytDlpPath: explicitPath });
    return explicitPath;
  }

  const possiblePaths = [
    explicitPath,
    process.env.YTDLP_PATH,
    process.env.YT_DLP_PATH,
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp',
  ].filter(Boolean);
  const dedupedPaths = [...new Set(possiblePaths)];

  for (const ytDlpPath of dedupedPaths) {
    try {
      const probe = spawnSync(ytDlpPath, ['--version'], {
        stdio: 'ignore',
        timeout: 20_000,
      });
      if (probe.status === 0) {
        return ytDlpPath;
      }
      if (probe.error && probe.error.code === 'ETIMEDOUT' && fs.existsSync(ytDlpPath)) {
        logger.info('yt-dlp probe timed out; using configured path', { ytDlpPath });
        return ytDlpPath;
      }
    } catch {
      continue;
    }
  }

  return '';
}

function isYouTubeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    const host = String(parsed.hostname || '').toLowerCase();
    return host === 'youtube.com'
      || host.endsWith('.youtube.com')
      || host === 'youtu.be'
      || host.endsWith('.youtu.be');
  } catch {
    return false;
  }
}

function extractYouTubeVideoId(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    const host = String(parsed.hostname || '').toLowerCase();
    const pathParts = String(parsed.pathname || '').split('/').filter(Boolean);
    let videoId = '';

    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      videoId = String(pathParts[0] || '').trim();
    } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const first = String(pathParts[0] || '').toLowerCase();
      if (first === 'watch') {
        videoId = String(parsed.searchParams.get('v') || '').trim();
      } else if (first === 'shorts' || first === 'live' || first === 'embed') {
        videoId = String(pathParts[1] || '').trim();
      }
    }

    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return '';
    return videoId;
  } catch {
    return '';
  }
}

function isJobStorageDirectoryName(name) {
  const value = String(name || '').trim();
  if (!value) return false;
  return /^[a-z0-9]+-[a-z0-9]+$/i.test(value);
}

function createApiServer(options = {}) {
  const {
    host = API.host,
    port = API.port,
    appVersion = '0.0.0',
    dataDir,
    downloadDir,
    initialQueueSettings,
    getCompletedOutputDir,
    ffmpegPath,
    ffprobePath,
    trustBinaryPaths = false,
    onFocus,
    ytDlpPath,
  } = options;

  if (!dataDir) {
    throw new Error('createApiServer requires dataDir');
  }

  const resolvedDownloadDir = downloadDir || path.join(dataDir, 'downloads');
  fs.mkdirSync(resolvedDownloadDir, { recursive: true });

  const FFMPEG_PATH = detectFFmpegPath(ffmpegPath, { trustExplicitPath: trustBinaryPaths });
  const FFPROBE_PATH = ffprobePath || process.env.FFPROBE_PATH
    || (FFMPEG_PATH ? FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : null);
  const YT_DLP_PATH = detectYtDlpPath(
    ytDlpPath || process.env.YTDLP_PATH || process.env.YT_DLP_PATH,
    { trustExplicitPath: trustBinaryPaths },
  );
  if (YT_DLP_PATH) {
    process.env.YTDLP_PATH = YT_DLP_PATH;
    logger.info('yt-dlp detected', { ytDlpPath: YT_DLP_PATH });
  } else {
    logger.warn('yt-dlp not detected - YouTube URL downloads will fail', {
      envHint: 'Set YTDLP_PATH or install yt-dlp in PATH',
    });
  }

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
    max: 600,
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
  app.post('/api/jobs', jobCreationLimiter);
  app.post('/v1/jobs', jobCreationLimiter);

  // Lock /api routes to desktop-local usage boundaries. Extension bridge must use /v1.
  app.use('/api', (req, res, next) => {
    const origin = String(req.headers.origin || '').trim();
    const client = String(req.headers[HEADER.client.toLowerCase()] || '').trim();
    if (origin.startsWith('chrome-extension://') || client === CLIENT.extension) {
      res.status(403).json({ error: 'Use /v1 extension bridge endpoints for extension clients' });
      return;
    }
    next();
  });

  app.post('/api/maintenance/clear-temp-downloads', async (req, res) => {
    try {
      const result = await clearInactiveTempDownloadArtifacts();
      logger.info('Cleared inactive temp download artifacts', result);
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error('Failed to clear temp download artifacts', { error: err && err.message });
      res.status(500).json({ error: 'Failed to clear temp download artifacts' });
    }
  });

  const jobs = new Map();

  function safeFilename(name) {
    return (name || 'video.ts').replace(/[^a-z0-9._-]+/gi, '_');
  }

  function createJobId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getJobTempDirForUrl(m3u8Url, jobId = '') {
    const safeJobId = safeFilename(String(jobId || '')).slice(0, 48);
    const suffix = safeJobId ? `-${safeJobId}` : '';
    try {
      const u = new URL(m3u8Url);
      const base = `${u.hostname}${u.pathname}`;
      const slug = base
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'playlist';
      return path.join(resolvedDownloadDir, `temp-${slug}${suffix}`);
    } catch {
      const slug = safeFilename(String(m3u8Url)).replace(/\.[a-z0-9]{2,4}$/i, '');
      return path.join(resolvedDownloadDir, `temp-${slug}${suffix}`);
    }
  }

  const { runJob: _runJob, runDirectJob: _runDirectJob } = createJobProcessor({
    downloadDir: resolvedDownloadDir,
    FFMPEG_PATH,
    FFPROBE_PATH,
    DEFAULT_MAX_CONCURRENT: engineConfig.defaultMaxConcurrent,
    DEFAULT_MAX_SEGMENT_ATTEMPTS: engineConfig.defaultMaxSegmentAttempts,
    fsPromises,
    getJobTempDirForUrl,
  });

  // Wrap job runners to apply current downloadThreads setting at start time
  const applyThreadSetting = (job) => {
    if (appConfig.downloadThreads > 0) {
      job.maxConcurrent = Math.min(16, Math.max(1, appConfig.downloadThreads));
    }
  };
  const runJob = (job) => { applyThreadSetting(job); return _runJob(job); };
  const runDirectJob = (job) => { applyThreadSetting(job); return _runDirectJob(job); };

  const queueManager = new QueueManager({
    queueFilePath: path.join(resolvedDownloadDir, 'queue.json'),
    fsPromises,
    jobs,
    runJob,
    runDirectJob,
    initialSettings: initialQueueSettings,
    getCompletedOutputDir,
  });

  async function clearInactiveTempDownloadArtifacts() {
    const activeJobIds = new Set(
      (queueManager.getQueue() || [])
        .filter(Boolean)
        .filter((job) => {
          const status = String(job.queueStatus || job.status || '').trim();
          return status === 'queued'
            || status === 'paused'
            || status === 'downloading'
            || status === 'fetching-playlist';
        })
        .map((job) => String(job.id || '').trim())
        .filter(Boolean),
    );

    let tempDirectoriesRemoved = 0;
    let transientFilesRemoved = 0;
    let emptiedJobDirectoriesRemoved = 0;

    const entries = await fsPromises.readdir(resolvedDownloadDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(resolvedDownloadDir, entry.name);

      if (entry.isDirectory() && entry.name.startsWith('temp-')) {
        const linkedJobId = queueManager.extractJobIdFromTempDirName(entry.name);
        const shouldKeep = linkedJobId
          ? activeJobIds.has(linkedJobId)
          : activeJobIds.size > 0;
        if (shouldKeep) continue;

        await fsPromises.rm(fullPath, { recursive: true, force: true });
        tempDirectoriesRemoved += 1;
        continue;
      }

      if (entry.isDirectory() && isJobStorageDirectoryName(entry.name) && !activeJobIds.has(entry.name)) {
        const nestedEntries = await fsPromises.readdir(fullPath, { withFileTypes: true });
        for (const nestedEntry of nestedEntries) {
          if (!nestedEntry.isFile()) continue;
          const nestedName = nestedEntry.name;
          if (
            nestedName.endsWith('.part')
            || nestedName.endsWith('.tmp')
            || /^ts-parts-.*[.]txt$/i.test(nestedName)
          ) {
            await fsPromises.rm(path.join(fullPath, nestedName), { force: true });
            transientFilesRemoved += 1;
          }
        }

        const remaining = await fsPromises.readdir(fullPath);
        if (remaining.length === 0) {
          await fsPromises.rmdir(fullPath);
          emptiedJobDirectoriesRemoved += 1;
        }
        continue;
      }

      if (
        entry.isFile()
        && (entry.name.endsWith('.part') || entry.name.endsWith('.tmp') || /^ts-parts-.*[.]txt$/i.test(entry.name))
      ) {
        await fsPromises.rm(fullPath, { force: true });
        transientFilesRemoved += 1;
      }
    }

    return {
      tempDirectoriesRemoved,
      transientFilesRemoved,
      emptiedJobDirectoriesRemoved,
    };
  }

  let notifyHistoryChange = () => {};
  const historyIndex = new HistoryIndexService({
    downloadDir: resolvedDownloadDir,
    fsPromises,
    jobs,
    onChange: (payload) => notifyHistoryChange(payload),
  });

  function isKnownManagedAssetPath(candidatePath) {
    if (typeof candidatePath !== 'string' || !candidatePath.trim()) return false;
    const resolvedCandidate = path.resolve(candidatePath);

    if (isInsideDirectory(path.resolve(resolvedDownloadDir), resolvedCandidate)) {
      return true;
    }

    const completedOutputDir = typeof getCompletedOutputDir === 'function'
      ? String(getCompletedOutputDir() || '').trim()
      : '';
    if (completedOutputDir && isInsideDirectory(path.resolve(completedOutputDir), resolvedCandidate)) {
      return true;
    }

    for (const job of jobs.values()) {
      if (!job) continue;
      const candidates = [
        job.filePath,
        job.mp4Path,
        job.outputPath,
        job.thumbnailPath,
        job.subtitlePath,
        job.subtitleZipPath,
      ];
      if (Array.isArray(job.thumbnailPaths)) {
        candidates.push(...job.thumbnailPaths);
      }
      if (candidates.some((value) => typeof value === 'string' && path.resolve(value) === resolvedCandidate)) {
        return true;
      }
    }

    return false;
  }

  app.get(`${EXTERNAL_DOWNLOAD_PREFIX}:encodedPath`, (req, res, next) => {
    const resolvedAssetPath = decodeExternalDownloadPath(req.params.encodedPath);
    if (!resolvedAssetPath || !isKnownManagedAssetPath(resolvedAssetPath)) {
      next();
      return;
    }
    if (!fs.existsSync(resolvedAssetPath)) {
      next();
      return;
    }
    res.sendFile(resolvedAssetPath, (err) => {
      if (err && !res.headersSent) {
        next(err);
      }
    });
  });

  function mergeThumbnailUrls(job) {
    const localThumbs = Array.isArray(job.thumbnailPaths)
      ? job.thumbnailPaths
        .filter((p) => fs.existsSync(p))
        .map((p) => buildDownloadAssetUrl(resolvedDownloadDir, p))
        .filter(Boolean)
      : (job.thumbnailPath && fs.existsSync(job.thumbnailPath)
        ? [buildDownloadAssetUrl(resolvedDownloadDir, job.thumbnailPath)].filter(Boolean)
        : []);

    const remoteThumbs = Array.isArray(job.thumbnailUrls)
      ? job.thumbnailUrls.filter((u) => typeof u === 'string' && u.startsWith('http'))
      : [];

    return [...localThumbs, ...remoteThumbs];
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
      totalBytes: Number(job.totalBytes || 0) || 0,
      speedBps: Number(job.speedBps || 0) || 0,
      etaSeconds: Number.isFinite(job.etaSeconds) ? Number(job.etaSeconds) : null,
      failedSegments: Array.isArray(job.failedSegments) ? job.failedSegments.length : 0,
      threadStates: Array.isArray(job.threadStates) ? job.threadStates : [],
      segmentStates: job.segmentStates || {},
      error: job.error,
      fallbackUrl: job.fallbackUrl || null,
      originalHlsUrl: job.originalHlsUrl || null,
      fallbackAttempted: !!job.fallbackAttempted,
      fallbackUsed: !!job.fallbackUsed,
      thumbnailUrls: mergeThumbnailUrls(job),
      updatedAt: job.updatedAt,
      tmdbId: job.tmdbId || null,
      tmdbTitle: job.tmdbTitle || null,
      tmdbReleaseDate: job.tmdbReleaseDate || null,
      tmdbMetadata: job.tmdbMetadata || null,
      youtubeMetadata: job.youtubeMetadata || null,
      mediaHints: job.mediaHints || null,
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
    const requestedFallbackUrl = sanitizeString(
      (settings && settings.fallbackMediaUrl) || queue.fallbackUrl || '',
      4096,
    );
    const fallbackMediaUrl =
      requestedFallbackUrl
      && requestedFallbackUrl !== queue.url
      && isValidHttpUrl(requestedFallbackUrl)
        ? requestedFallbackUrl
        : '';
    const inferredHints = inferMediaMetadata({
      title: queue.title,
      resourceName: queue.name,
      sourcePageTitle: queue.title,
      mediaUrl: queue.url,
      sourcePageUrl: queue.sourcePageUrl,
    });
    const mediaHints = {
      ...inferredHints,
      ...(queue.titleHints && typeof queue.titleHints === 'object' ? queue.titleHints : {}),
      lookupTitle: (
        (queue.titleHints && queue.titleHints.lookupTitle)
        || inferredHints.lookupTitle
        || ''
      ).trim(),
      seasonNumber: Number.isFinite(queue.titleHints && queue.titleHints.seasonNumber)
        ? queue.titleHints.seasonNumber
        : inferredHints.seasonNumber,
      episodeNumber: Number.isFinite(queue.titleHints && queue.titleHints.episodeNumber)
        ? queue.titleHints.episodeNumber
        : inferredHints.episodeNumber,
      isTvCandidate: Boolean(
        (queue.titleHints && queue.titleHints.isTvCandidate)
        || inferredHints.isTvCandidate
        || (
          Number.isFinite(queue.titleHints && queue.titleHints.seasonNumber)
          && Number.isFinite(queue.titleHints && queue.titleHints.episodeNumber)
        )
      ),
    };
    const queueYoutubeMetadata = queue.youtubeMetadata && typeof queue.youtubeMetadata === 'object'
      ? queue.youtubeMetadata
      : null;
    const initialThumbnailUrls = [];
    const pushThumbnailUrl = (value) => {
      const candidate = sanitizeString(value, 4096);
      if (!candidate || !isValidHttpUrl(candidate)) return;
      if (initialThumbnailUrls.includes(candidate)) return;
      initialThumbnailUrls.push(candidate);
    };

    pushThumbnailUrl(queue.thumbnailUrl);
    pushThumbnailUrl(queueYoutubeMetadata && queueYoutubeMetadata.thumbnailUrl);

    if (initialThumbnailUrls.length === 0 && isYouTubeUrl(queue.url)) {
      const videoId = extractYouTubeVideoId(queue.url)
        || sanitizeString(queueYoutubeMetadata && queueYoutubeMetadata.videoId, 32);
      if (/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
        pushThumbnailUrl(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`);
      }
    }

    let filePath;
    let tsName;
    let downloadNameMp4;
    let directFallbackFilePath = null;
    let directFallbackDownloadName = null;
    let directFallbackDownloadNameMp4 = null;
    const storageDir = buildJobStorageDir(resolvedDownloadDir, id);

    if (isHls) {
      tsName = fileNameBase;
      if (/\.m3u8$/i.test(tsName)) {
        tsName = tsName.replace(/\.m3u8$/i, '.ts');
      } else if (!/\.[a-z0-9]{2,4}$/i.test(tsName)) {
        tsName = `${tsName}.ts`;
      }

      filePath = path.join(storageDir, `${id}-${tsName}`);

      downloadNameMp4 = fileNameBase;
      if (/\.m3u8$/i.test(downloadNameMp4)) {
        downloadNameMp4 = downloadNameMp4.replace(/\.m3u8$/i, '.mp4');
      } else if (!/\.[a-z0-9]{2,4}$/i.test(downloadNameMp4)) {
        downloadNameMp4 = `${downloadNameMp4}.mp4`;
      }

      if (fallbackMediaUrl) {
        let ext = '';
        try {
          const fallbackParsed = new URL(fallbackMediaUrl);
          ext = path.extname(fallbackParsed.pathname) || '';
        } catch {
          ext = '';
        }

        if (!ext || !/^\.[a-z0-9]{2,4}$/i.test(ext)) {
          ext = '.mp4';
        }

        directFallbackDownloadName = `${fileNameBase}${ext}`;
        directFallbackDownloadNameMp4 = directFallbackDownloadName;
        directFallbackFilePath = path.join(storageDir, `${id}-${directFallbackDownloadName}`);
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
      filePath = path.join(storageDir, `${id}-${directName}`);
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
      sourcePageUrl: queue.sourcePageUrl || '',
      totalSegments: 0,
      completedSegments: 0,
      bytesDownloaded: 0,
      progress: 0,
      error: null,
      storageDir,
      filePath,
      downloadName: tsName,
      mp4Path: null,
      thumbnailPath: null,
      thumbnailPaths: null,
      thumbnailUrls: initialThumbnailUrls,
      skipThumbnailGeneration: false,
      mediaHints,
      youtubeMetadata: queueYoutubeMetadata,
      downloadNameMp4,
      forcePlaybackCompatibility: isHls,
      fallbackUrl: fallbackMediaUrl || null,
      originalHlsUrl: isHls ? queue.url : null,
      originalHlsDownloadName: isHls ? tsName : null,
      originalHlsDownloadNameMp4: isHls ? downloadNameMp4 : null,
      directFallbackFilePath,
      directFallbackDownloadName,
      directFallbackDownloadNameMp4,
      fallbackAttempted: false,
      fallbackUsed: false,
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

  const tmdbCacheFilePath = path.join(dataDir, 'tmdb-cache.json');
  const tmdbCache = new Map();
  let tmdbCacheLoaded = false;
  let tmdbCacheLoadPromise = null;

  function buildTmdbCacheKey(title, type) {
    const normalizedTitle = String(title || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 200);
    const normalizedType = type === 'tv' ? 'tv' : 'movie';
    return `${normalizedType}:${normalizedTitle}`;
  }

  function sanitizeTmdbResult(result) {
    if (!result || typeof result !== 'object') return null;
    return {
      id: result.id || null,
      title: result.title || null,
      releaseDate: result.releaseDate || null,
      posterUrl: result.posterUrl || null,
      backdropUrl: result.backdropUrl || null,
      overview: result.overview || null,
      runtime: Number.isFinite(result.runtime) ? result.runtime : null,
      tagline: result.tagline || null,
      genres: Array.isArray(result.genres) ? result.genres.filter(Boolean).slice(0, 6) : [],
      imageUrls: Array.isArray(result.imageUrls)
        ? result.imageUrls.filter((url) => typeof url === 'string' && isValidHttpUrl(url)).slice(0, 6)
        : [],
      mediaType: result.mediaType === 'tv' ? 'tv' : 'movie',
    };
  }

  async function loadTmdbCache() {
    if (tmdbCacheLoaded) return;
    if (tmdbCacheLoadPromise) {
      await tmdbCacheLoadPromise;
      return;
    }

    tmdbCacheLoadPromise = (async () => {
      try {
        const raw = await fsPromises.readFile(tmdbCacheFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        const entries = parsed && typeof parsed.entries === 'object' ? parsed.entries : {};
        const now = Date.now();
        Object.entries(entries).forEach(([cacheKey, entry]) => {
          if (!cacheKey || !entry || typeof entry !== 'object') return;
          const cachedAt = Number(entry.cachedAt || 0);
          if (!Number.isFinite(cachedAt) || now - cachedAt > TMDB_CACHE_TTL_MS) return;
          const sanitized = sanitizeTmdbResult(entry.result);
          if (!sanitized) return;
          tmdbCache.set(cacheKey, { cachedAt, result: sanitized });
        });
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          logger.warn('Failed to load TMDB cache file', { error: err.message });
        }
      } finally {
        tmdbCacheLoaded = true;
      }
    })();

    await tmdbCacheLoadPromise;
  }

  async function persistTmdbCache() {
    try {
      await fsPromises.mkdir(path.dirname(tmdbCacheFilePath), { recursive: true });
      const payload = {
        version: TMDB_CACHE_VERSION,
        updatedAt: Date.now(),
        entries: Object.fromEntries(tmdbCache.entries()),
      };
      const tempPath = `${tmdbCacheFilePath}.tmp`;
      await fsPromises.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
      await fsPromises.rename(tempPath, tmdbCacheFilePath);
    } catch (err) {
      logger.warn('Failed to persist TMDB cache file', { error: err.message });
    }
  }

  async function getCachedTmdbResult(cacheKey) {
    await loadTmdbCache();
    const entry = tmdbCache.get(cacheKey);
    if (!entry) return null;

    if (Date.now() - Number(entry.cachedAt || 0) > TMDB_CACHE_TTL_MS) {
      tmdbCache.delete(cacheKey);
      persistTmdbCache();
      return null;
    }

    return sanitizeTmdbResult(entry.result);
  }

  async function cacheTmdbResult(cacheKey, result) {
    const sanitized = sanitizeTmdbResult(result);
    if (!sanitized) return;
    await loadTmdbCache();
    tmdbCache.set(cacheKey, {
      cachedAt: Date.now(),
      result: sanitized,
    });
    while (tmdbCache.size > TMDB_CACHE_MAX_ENTRIES) {
      const oldestKey = tmdbCache.keys().next().value;
      if (!oldestKey) break;
      tmdbCache.delete(oldestKey);
    }
    await persistTmdbCache();
  }

  function downloadRemoteImage(url, destinationPath, redirectBudget = 3) {
    return new Promise((resolve) => {
      if (!isValidHttpUrl(url)) {
        resolve(false);
        return;
      }

      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const tempPath = `${destinationPath}.tmp`;
      let settled = false;

      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const req = client.get(url, {
        timeout: 12000,
        headers: { 'User-Agent': 'M3U8-Downloader/1.0' },
      }, (res) => {
        const status = Number(res.statusCode || 0);
        if (status >= 300 && status < 400 && res.headers.location && redirectBudget > 0) {
          res.resume();
          const redirected = new URL(String(res.headers.location), url).toString();
          downloadRemoteImage(redirected, destinationPath, redirectBudget - 1).then(settle);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          settle(false);
          return;
        }

        const out = fs.createWriteStream(tempPath);
        out.on('error', async () => {
          try { await fsPromises.unlink(tempPath); } catch {}
          settle(false);
        });

        res.on('error', async () => {
          try { await fsPromises.unlink(tempPath); } catch {}
          settle(false);
        });

        out.on('finish', async () => {
          try {
            await fsPromises.rename(tempPath, destinationPath);
            settle(true);
          } catch {
            try { await fsPromises.unlink(tempPath); } catch {}
            settle(false);
          }
        });

        res.pipe(out);
      });

      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', () => {
        settle(false);
      });
    });
  }

  async function ensureLocalTmdbThumbnail(job) {
    const remoteThumb = Array.isArray(job.thumbnailUrls)
      ? job.thumbnailUrls.find((url) => isValidHttpUrl(url))
      : null;
    if (!remoteThumb) return false;

    const storageDir = job.storageDir || (job.filePath ? path.dirname(job.filePath) : resolvedDownloadDir);
    const thumbPath = path.join(storageDir, `${job.id}-thumb.jpg`);
    try {
      await fsPromises.mkdir(storageDir, { recursive: true });
      if (fs.existsSync(thumbPath)) {
        job.thumbnailPath = thumbPath;
        return true;
      }
      const downloaded = await downloadRemoteImage(remoteThumb, thumbPath);
      if (!downloaded) {
        return false;
      }
      job.thumbnailPath = thumbPath;
      return true;
    } catch (err) {
      logger.warn('Failed to persist TMDB thumbnail locally', {
        jobId: job.id,
        thumbPath,
        error: err.message,
      });
      return false;
    }
  }

  function applyTmdbResultToJob(job, result, fallbackType) {
    const mediaType = result && result.mediaType === 'tv'
      ? 'tv'
      : (fallbackType === 'tv' ? 'tv' : 'movie');
    job.thumbnailUrls = Array.isArray(result && result.imageUrls)
      ? result.imageUrls.filter(Boolean)
      : [result && result.posterUrl, result && result.backdropUrl].filter(Boolean);
    job.tmdbId = (result && result.id) || null;
    job.tmdbTitle = (result && result.title) || null;
    job.tmdbReleaseDate = (result && result.releaseDate) || null;
    job.tmdbMetadata = {
      overview: (result && result.overview) || null,
      runtime: (result && result.runtime) || null,
      tagline: (result && result.tagline) || null,
      genres: Array.isArray(result && result.genres) ? result.genres : [],
      mediaType,
    };
    job.skipThumbnailGeneration = true;
  }

  async function enrichTmdb(job) {
    if (!appConfig.tmdbApiKey) return;
    if (isYouTubeUrl(job && job.url)) return;

    try {
      const hints = job.mediaHints || inferMediaMetadata({
        title: job.title,
        resourceName: job.downloadName,
        mediaUrl: job.url,
        sourcePageUrl: job.sourcePageUrl,
      });
      const lookupTitle = hints.lookupTitle || job.title || job.downloadName;
      const type = hints.isTvCandidate ? 'tv' : 'movie';
      const cacheKey = buildTmdbCacheKey(lookupTitle, type);
      let result = await getCachedTmdbResult(cacheKey);
      const usedCache = !!result;

      if (!result) {
        logger.info('TMDB lookup start', {
          jobId: job.id,
          title: lookupTitle,
          type,
          seasonNumber: hints.seasonNumber,
          episodeNumber: hints.episodeNumber,
          matchedPattern: hints.matchedPattern,
          matchedField: hints.matchedField,
        });
        result = await lookupPoster({
          apiKey: appConfig.tmdbApiKey,
          title: lookupTitle,
          type,
        });
        if (result) {
          await cacheTmdbResult(cacheKey, result);
        }
      }

      if (result) {
        applyTmdbResultToJob(job, result, type);
        const localThumbSaved = await ensureLocalTmdbThumbnail(job);
        queueManager.saveQueue();
        logger.info('TMDB metadata applied', {
          jobId: job.id,
          tmdbId: result.id,
          mediaType: (result.mediaType || type),
          thumbnails: Array.isArray(job.thumbnailUrls) ? job.thumbnailUrls.length : 0,
          localThumbSaved,
          cacheHit: usedCache,
        });
      } else {
        logger.info('TMDB lookup returned no results', { jobId: job.id, title: lookupTitle, type });
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

  function findDuplicateQueuedJob(url) {
    if (!isValidHttpUrl(url)) return null;
    const normalizedUrl = String(url).trim();
    for (const job of jobs.values()) {
      if (!job) continue;
      if (String(job.url || '').trim() !== normalizedUrl) continue;
      if (job.queueStatus === 'queued' || job.queueStatus === 'downloading' || job.queueStatus === 'paused') {
        return job;
      }
    }
    return null;
  }

  function parseVersionParts(input) {
    return String(input || '')
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) && part >= 0 ? part : 0));
  }

  function compareVersions(a, b) {
    const ap = parseVersionParts(a);
    const bp = parseVersionParts(b);
    const len = Math.max(ap.length, bp.length);
    for (let i = 0; i < len; i += 1) {
      const av = ap[i] || 0;
      const bv = bp[i] || 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }
    return 0;
  }

  function normalizeProtocolVersion(version) {
    const parsed = Number.parseInt(String(version || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.parseInt(API.protocolVersion, 10);
  }

  function getCompatibilityInfo() {
    const minProtocol = normalizeProtocolVersion(API.minProtocolVersion || API.protocolVersion);
    const maxProtocol = normalizeProtocolVersion(API.maxProtocolVersion || API.protocolVersion);
    const currentProtocol = normalizeProtocolVersion(API.protocolVersion);

    return {
      protocolVersion: currentProtocol,
      supportedProtocolVersions: {
        min: Math.min(minProtocol, maxProtocol),
        max: Math.max(minProtocol, maxProtocol),
      },
      minExtensionVersion: API.minExtensionVersion || '1.0.0',
    };
  }

  function validateV1ClientHeaders(req, res, next) {
    const client = String(req.headers[HEADER.client.toLowerCase()] || '').trim();
    const protocolVersion = String(req.headers[HEADER.protocolVersion.toLowerCase()] || '').trim();
    const compatibility = getCompatibilityInfo();
    const allowedClients = new Set([
      CLIENT.extension,
      'fetchv-extension',
      'vidsnag-extension',
    ]);

    if (client && !allowedClients.has(client)) {
      res.status(400).json({ error: `Invalid ${HEADER.client} header` });
      return;
    }

    if (protocolVersion) {
      const parsed = Number.parseInt(protocolVersion, 10);
      if (!Number.isFinite(parsed)) {
        res.status(400).json({ error: `Invalid ${HEADER.protocolVersion} header` });
        return;
      }
      if (
        parsed < compatibility.supportedProtocolVersions.min
        || parsed > compatibility.supportedProtocolVersions.max
      ) {
        res.status(426).json({
          error: `Unsupported ${HEADER.protocolVersion} header`,
          compatibility,
        });
        return;
      }
    }

    const extensionVersion = sanitizeString(req.headers['x-extension-version'], 64);
    if (
      extensionVersion
      && compareVersions(extensionVersion, compatibility.minExtensionVersion) < 0
    ) {
      res.status(426).json({
        error: 'Extension version too old',
        compatibility,
      });
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

  function sanitizeTitleHints(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const lookupTitle = sanitizeString(value.lookupTitle, 255);
    const seasonNumberRaw = Number(value.seasonNumber);
    const episodeNumberRaw = Number(value.episodeNumber);
    const seasonNumber = Number.isFinite(seasonNumberRaw) && seasonNumberRaw > 0
      ? Math.min(60, Math.floor(seasonNumberRaw))
      : null;
    const episodeNumber = Number.isFinite(episodeNumberRaw) && episodeNumberRaw > 0
      ? Math.min(999, Math.floor(episodeNumberRaw))
      : null;
    const isTvCandidate = Boolean(value.isTvCandidate || (seasonNumber && episodeNumber));

    if (!lookupTitle && !seasonNumber && !episodeNumber && !isTvCandidate) {
      return null;
    }

    return {
      lookupTitle,
      seasonNumber,
      episodeNumber,
      isTvCandidate,
      matchedPattern: sanitizeString(value.matchedPattern, 64),
      matchedField: sanitizeString(value.matchedField, 64),
    };
  }

  function sanitizeYoutubeMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const videoIdRaw = sanitizeString(value.videoId, 32);
    const videoId = /^[A-Za-z0-9_-]{6,20}$/.test(videoIdRaw) ? videoIdRaw : '';
    const thumbnailUrlRaw = sanitizeString(value.thumbnailUrl, 4096);
    const thumbnailUrl = isValidHttpUrl(thumbnailUrlRaw) ? thumbnailUrlRaw : '';

    const output = {
      videoId,
      title: sanitizeString(value.title, 255),
      channelName: sanitizeString(value.channelName, 180),
      channelUrl: sanitizeString(value.channelUrl, 4096),
      channelId: sanitizeString(value.channelId, 80),
      uploadDate: sanitizeString(value.uploadDate, 80),
      thumbnailUrl,
      description: sanitizeString(value.description, 1000),
      durationSeconds: (() => {
        const n = Number(value.durationSeconds);
        return Number.isFinite(n) && n > 0 ? Math.min(24 * 60 * 60, Math.floor(n)) : null;
      })(),
      viewCount: (() => {
        const n = Number(value.viewCount);
        return Number.isFinite(n) && n > 0 ? Math.min(9_999_999_999_999, Math.floor(n)) : null;
      })(),
    };

    if (!Object.values(output).some((entry) => entry != null && entry !== '')) {
      return null;
    }

    return output;
  }

  function resolveIncomingThumbnailUrl(payload) {
    const explicit = sanitizeString(payload && payload.thumbnailUrl, 4096);
    if (isValidHttpUrl(explicit)) {
      return explicit;
    }

    const youtubeMetadata = sanitizeYoutubeMetadata(payload && payload.youtubeMetadata);
    if (youtubeMetadata && isValidHttpUrl(youtubeMetadata.thumbnailUrl)) {
      return youtubeMetadata.thumbnailUrl;
    }

    const videoId = extractYouTubeVideoId(String(payload && payload.mediaUrl || '').trim())
      || String(youtubeMetadata && youtubeMetadata.videoId || '').trim();
    if (videoId) {
      return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
    }

    return '';
  }

  function validateCreateJobRequest(body) {
    const payload = body && typeof body === 'object' ? body : {};
    const mediaUrl = sanitizeString(payload.mediaUrl, 4096);
    const mediaType = sanitizeString(payload.mediaType, 16).toLowerCase();
    const fallbackMediaUrl = sanitizeString(payload.fallbackMediaUrl, 4096);
    const titleHints = sanitizeTitleHints(payload.titleHints);
    const youtubeMetadata = sanitizeYoutubeMetadata(payload.youtubeMetadata);
    const thumbnailUrl = resolveIncomingThumbnailUrl({ ...payload, mediaUrl, youtubeMetadata });

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

    if (fallbackMediaUrl && !isValidHttpUrl(fallbackMediaUrl)) {
      const err = new Error('fallbackMediaUrl must be a valid http/https URL');
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
      fallbackMediaUrl,
      titleHints,
      youtubeMetadata,
      thumbnailUrl,
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

  app.get('/v1/health', (req, res) => {
    const compatibility = getCompatibilityInfo();
    res.json({
      status: 'ok',
      appVersion,
      apiVersion: API.apiVersion,
      protocolVersion: String(compatibility.protocolVersion),
      supportedProtocolVersions: compatibility.supportedProtocolVersions,
      minExtensionVersion: compatibility.minExtensionVersion,
      pairingRequired: false,
      wsPath: '/ws',
    });
  });

  app.post('/v1/pair/complete', (req, res) => {
    // Pairing is deprecated; extension bridge works locally without auth.
    res.status(410).json({
      error: 'Pairing is no longer required. Update extension to latest version.',
    });
  });

  app.post('/v1/jobs', (req, res) => {
    let body;
    try {
      body = validateCreateJobRequest(req.body || {});
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: err.message || 'Invalid job request' });
      return;
    }

    if (isYouTubeUrl(body.mediaUrl) && !YT_DLP_PATH) {
      res.status(400).json({
        error: 'YouTube URL detected, but yt-dlp is not installed. Install yt-dlp and restart the desktop app.',
      });
      return;
    }

    const queue = {
      url: body.mediaUrl,
      title: body.title || body.sourcePageTitle || body.resourceName || 'Download',
      name: body.resourceName || body.title || 'media',
      headers: body.headers || {},
      sourcePageUrl: body.sourcePageUrl || '',
      titleHints: body.titleHints || null,
      youtubeMetadata: body.youtubeMetadata || null,
      thumbnailUrl: body.thumbnailUrl || '',
    };

    const settings = {
      fileNaming: body.settings.fileNaming,
      customName: body.settings.customName,
      maxSegmentAttempts: body.settings.maxSegmentAttempts,
      fallbackMediaUrl: body.fallbackMediaUrl || '',
    };

    const threads = body.settings.threads;

    const duplicate = findDuplicateQueuedJob(queue.url);
    if (duplicate) {
      res.json({
        jobId: duplicate.id,
        queuePosition: duplicate.queuePosition || 0,
        status: duplicate.queueStatus || 'queued',
        acceptedAt: new Date().toISOString(),
        duplicate: true,
      });
      return;
    }

    const { id, queuePosition } = enqueueLegacyRequest({ queue, threads, settings });

    res.json({
      jobId: id,
      queuePosition,
      status: 'queued',
      acceptedAt: new Date().toISOString(),
    });
  });

  app.get('/v1/queue', (req, res) => {
    res.json({
      queue: queueManager.getQueue(),
      settings: queueManager.getSettings(),
    });
  });

  app.post('/v1/app/focus', async (req, res) => {
    if (typeof onFocus === 'function') {
      try {
        await Promise.resolve(onFocus());
      } catch (err) {
        logger.warn('onFocus callback failed', { error: err.message });
      }
    }
    res.json({ ok: true });
  });

  app.post('/api/jobs/:id/retry-original-hls', (req, res) => {
    const sourceJob = jobs.get(req.params.id);
    if (!sourceJob) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (!sourceJob.originalHlsUrl || !isValidHttpUrl(sourceJob.originalHlsUrl)) {
      res.status(400).json({ error: 'Original HLS URL not available for retry' });
      return;
    }

    const queue = {
      url: sourceJob.originalHlsUrl,
      title: sourceJob.title || 'HLS Retry',
      name: sourceJob.title || 'HLS Retry',
      headers: sourceJob.headers || {},
      sourcePageUrl: sourceJob.sourcePageUrl || '',
      youtubeMetadata: sourceJob.youtubeMetadata || null,
      thumbnailUrl: Array.isArray(sourceJob.thumbnailUrls) ? String(sourceJob.thumbnailUrls[0] || '') : '',
    };

    const settings = {
      fileNaming: 'title',
      customName: '',
      maxSegmentAttempts: sourceJob.maxSegmentAttempts === Infinity
        ? 'infinite'
        : String(sourceJob.maxSegmentAttempts || engineConfig.defaultMaxSegmentAttempts),
      fallbackMediaUrl: sourceJob.fallbackUrl || '',
    };

    const threads = Number.isFinite(sourceJob.maxConcurrent) && sourceJob.maxConcurrent > 0
      ? sourceJob.maxConcurrent
      : engineConfig.defaultMaxConcurrent;

    const result = enqueueLegacyRequest({ queue, threads, settings });
    res.json({
      ...result,
      retryOf: sourceJob.id,
    });
  });

  app.post('/api/jobs/:id/retry', (req, res) => {
    const sourceJob = jobs.get(req.params.id);
    if (!sourceJob) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (sourceJob.status === 'downloading' || sourceJob.status === 'fetching-playlist') {
      res.status(400).json({ error: 'Cannot retry an active job' });
      return;
    }

    const retryUrl = sanitizeString(sourceJob.url, 4096);
    if (!isValidHttpUrl(retryUrl)) {
      res.status(400).json({ error: 'Source job URL is invalid for retry' });
      return;
    }

    const queue = {
      url: retryUrl,
      title: sourceJob.title || 'Retry Job',
      name: sourceJob.title || 'Retry Job',
      headers: sourceJob.headers || {},
      sourcePageUrl: sourceJob.sourcePageUrl || '',
      youtubeMetadata: sourceJob.youtubeMetadata || null,
      thumbnailUrl: Array.isArray(sourceJob.thumbnailUrls) ? String(sourceJob.thumbnailUrls[0] || '') : '',
    };

    const settings = {
      fileNaming: 'title',
      customName: '',
      maxSegmentAttempts: sourceJob.maxSegmentAttempts === Infinity
        ? 'infinite'
        : String(sourceJob.maxSegmentAttempts || engineConfig.defaultMaxSegmentAttempts),
      fallbackMediaUrl: sourceJob.fallbackUrl || '',
    };

    const threads = Number.isFinite(sourceJob.maxConcurrent) && sourceJob.maxConcurrent > 0
      ? sourceJob.maxConcurrent
      : engineConfig.defaultMaxConcurrent;

    const result = enqueueLegacyRequest({ queue, threads, settings });
    res.json({
      ...result,
      retryOf: sourceJob.id,
    });
  });

  registerHistoryRoutes(app, historyIndex, fsPromises, resolvedDownloadDir);
  registerQueueRoutes(app, queueManager, {
    onRenameJob: async (jobId, title) => {
      const job = jobs.get(jobId);
      if (!job) return;

      const inferredHints = inferMediaMetadata({
        title,
        resourceName: job.downloadName,
        sourcePageTitle: title,
        mediaUrl: job.url,
        sourcePageUrl: job.sourcePageUrl,
      });
      const previousHints = job.mediaHints && typeof job.mediaHints === 'object'
        ? job.mediaHints
        : {};
      const seasonNumber = Number.isFinite(inferredHints.seasonNumber)
        ? inferredHints.seasonNumber
        : (Number.isFinite(previousHints.seasonNumber) ? previousHints.seasonNumber : null);
      const episodeNumber = Number.isFinite(inferredHints.episodeNumber)
        ? inferredHints.episodeNumber
        : (Number.isFinite(previousHints.episodeNumber) ? previousHints.episodeNumber : null);

      job.mediaHints = {
        ...previousHints,
        ...inferredHints,
        lookupTitle: String(inferredHints.lookupTitle || title || '').trim(),
        seasonNumber,
        episodeNumber,
        isTvCandidate: Boolean(
          inferredHints.isTvCandidate
          || previousHints.isTvCandidate
          || (Number.isFinite(seasonNumber) && Number.isFinite(episodeNumber))
        ),
      };
      job.updatedAt = Date.now();

      if (appConfig.tmdbApiKey) {
        await enrichTmdb(job);
      } else {
        queueManager.saveQueue();
      }
    },
  });
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
  const channelSubscriptions = new Map();
  const clientSubscriptions = new Map();
  const lastSentTimestamps = new Map();
  let lastQueueSignature = '';

  const CHANNELS = new Set(['queue', 'history', 'compatibility']);

  function subscribeClientToJob(ws, jobId) {
    if (!jobId) return;

    let subscriptions = clientSubscriptions.get(ws);
    if (!subscriptions) {
      subscriptions = { jobs: new Set(), channels: new Set() };
      clientSubscriptions.set(ws, subscriptions);
    }
    subscriptions.jobs.add(jobId);

    let subscribers = jobSubscriptions.get(jobId);
    if (!subscribers) {
      subscribers = new Set();
      jobSubscriptions.set(jobId, subscribers);
    }
    subscribers.add(ws);
  }

  function subscribeClientToChannel(ws, channel) {
    if (!CHANNELS.has(channel)) return false;

    let subscriptions = clientSubscriptions.get(ws);
    if (!subscriptions) {
      subscriptions = { jobs: new Set(), channels: new Set() };
      clientSubscriptions.set(ws, subscriptions);
    }
    subscriptions.channels.add(channel);

    let subscribers = channelSubscriptions.get(channel);
    if (!subscribers) {
      subscribers = new Set();
      channelSubscriptions.set(channel, subscribers);
    }
    subscribers.add(ws);
    return true;
  }

  function unsubscribeClient(ws) {
    const subscriptions = clientSubscriptions.get(ws);
    if (!subscriptions) return;

    subscriptions.jobs.forEach((jobId) => {
      const subscribers = jobSubscriptions.get(jobId);
      if (subscribers) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          jobSubscriptions.delete(jobId);
          lastSentTimestamps.delete(jobId);
        }
      }
    });

    subscriptions.channels.forEach((channel) => {
      const subscribers = channelSubscriptions.get(channel);
      if (!subscribers) return;
      subscribers.delete(ws);
      if (subscribers.size === 0) {
        channelSubscriptions.delete(channel);
      }
    });

    clientSubscriptions.delete(ws);
  }

  function sendWsMessage(ws, type, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type, data: payload }));
  }

  function sendChannelMessage(channel, type, payload) {
    const subscribers = channelSubscriptions.get(channel);
    if (!subscribers || subscribers.size === 0) return;
    subscribers.forEach((ws) => sendWsMessage(ws, type, payload));
  }

  function getQueuePayload() {
    return {
      queue: queueManager.getQueue(),
      settings: queueManager.getSettings(),
      updatedAt: Date.now(),
    };
  }

  function getQueueSignature(payload) {
    const queue = Array.isArray(payload.queue) ? payload.queue : [];
    const settings = payload.settings || {};
    return [
      `${settings.maxConcurrent || 1}:${settings.autoStart !== false ? 1 : 0}`,
      ...queue.map((job) => [
        job.id,
        job.queueStatus,
        job.status,
        Number(job.progress || 0),
        Number(job.bytesDownloaded || 0),
        Number(job.completedSegments || 0),
      ].join(':')),
    ].join('|');
  }

  function broadcastQueueUpdate(payloadOverride = null) {
    const payload = payloadOverride || getQueuePayload();
    const signature = getQueueSignature(payload);
    if (signature === lastQueueSignature) {
      return false;
    }
    lastQueueSignature = signature;
    sendChannelMessage('queue', 'queue:update', payload);
    return true;
  }

  function broadcastCompatibilityUpdate(ws = null) {
    const compatibility = getCompatibilityInfo();
    const payload = {
      appVersion,
      apiVersion: API.apiVersion,
      protocolVersion: compatibility.protocolVersion,
      supportedProtocolVersions: compatibility.supportedProtocolVersions,
      minExtensionVersion: compatibility.minExtensionVersion,
      pairingRequired: false,
      wsPath: '/ws',
      updatedAt: Date.now(),
    };

    if (ws) {
      sendWsMessage(ws, 'compatibility:update', payload);
      return;
    }
    sendChannelMessage('compatibility', 'compatibility:update', payload);
  }

  function broadcastHistoryUpdate(payload = {}) {
    sendChannelMessage('history', 'history:update', {
      changedAt: payload.changedAt || Date.now(),
      reason: payload.reason || 'refresh',
      total: Number(payload.total || 0),
    });
  }

  notifyHistoryChange = (payload) => {
    broadcastHistoryUpdate(payload);
  };

  function broadcastJobUpdate(job) {
    if (!job || !job.id) return;
    const subscribers = jobSubscriptions.get(job.id);
    if (!subscribers || subscribers.size === 0) return;

    const payload = buildJobStatusPayload(job);
    if (!payload) return;

    subscribers.forEach((ws) => sendWsMessage(ws, 'job:update', payload));
  }

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (!message || message.type !== 'subscribe') {
          return;
        }

        // Backward compatibility: { type: 'subscribe', jobId }
        if (message.jobId && !message.channel) {
          const jobId = String(message.jobId);
          subscribeClientToJob(ws, jobId);
          const job = jobs.get(jobId);
          if (job) {
            lastSentTimestamps.set(job.id, job.updatedAt || Date.now());
            broadcastJobUpdate(job);
          }
          return;
        }

        const channel = String(message.channel || '').trim();
        if (!channel) return;

        if (channel === 'job') {
          const jobId = String(message.jobId || '').trim();
          if (!jobId) return;
          subscribeClientToJob(ws, jobId);
          const job = jobs.get(jobId);
          if (job) {
            lastSentTimestamps.set(job.id, job.updatedAt || Date.now());
            broadcastJobUpdate(job);
          }
          return;
        }

        const subscribed = subscribeClientToChannel(ws, channel);
        if (!subscribed) return;

        if (channel === 'queue') {
          sendWsMessage(ws, 'queue:update', getQueuePayload());
        } else if (channel === 'history') {
          sendWsMessage(ws, 'history:update', {
            changedAt: Date.now(),
            reason: 'subscribe',
            total: historyIndex.items.length,
          });
        } else if (channel === 'compatibility') {
          broadcastCompatibilityUpdate(ws);
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
    const queueChanged = broadcastQueueUpdate();
    if (queueChanged) {
      historyIndex.refreshFromDisk().catch((err) => {
        logger.warn('History index refresh failed after queue update', { error: err && err.message });
      });
    }

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
  let historyRefreshTimer = null;

  async function start() {
    if (started) return Promise.resolve({ host, port });

    started = true;
    await historyIndex.init();
    lastQueueSignature = '';
    broadcastQueueUpdate();
    broadcastCompatibilityUpdate();

    cleanupTimer = startCleanupScheduler({
      fsPromises,
      downloadDir: resolvedDownloadDir,
      intervalMs: engineConfig.cleanupIntervalMs,
      tempMaxAgeHours: engineConfig.cleanupAgeHours,
      downloadMaxAgeHours: engineConfig.downloadRetentionHours,
    });
    historyRefreshTimer = setInterval(() => {
      historyIndex.refreshFromDisk().catch((err) => {
        logger.warn('History index refresh failed', { error: err && err.message });
      });
    }, 15_000);

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
    if (historyRefreshTimer) {
      clearInterval(historyRefreshTimer);
      historyRefreshTimer = null;
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
    getQueueSettings: () => queueManager.getSettings(),
    updateQueueSettings: (settings) => queueManager.updateSettings(settings || {}),
    applyLegacyQueueSettings: (legacy) => queueManager.applyLegacySettingsIfNeeded(legacy || {}),
    getState: () => ({
      queue: queueManager.getQueue(),
      settings: queueManager.getSettings(),
      pairingRequired: false,
      appVersion,
      apiVersion: API.apiVersion,
    }),
  };
}

module.exports = {
  createApiServer,
};
