const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('../utils/logger');
const { jobValidation, jobIdValidation } = require('../utils/validators');
const { lookupPoster } = require('../services/tmdb');
const { fetchAndSaveSubtitles } = require('../services/subdl');
const { inferMediaMetadata } = require('../utils/mediaMetadata');
const { buildDownloadAssetUrl, buildJobStorageDir } = require('../utils/downloadPaths');
const config = require('../config');

if (!config.subdlApiKey) {
  logger.warn('SUBDL_API_KEY environment variable not set - subtitle download will be disabled');
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function downloadRemoteImage(url, destinationPath, redirectBudget = 3) {
  return new Promise((resolve) => {
    if (!isHttpUrl(url)) {
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
      timeout: 12_000,
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
      out.on('error', () => {
        try { fs.unlinkSync(tempPath); } catch {}
        settle(false);
      });
      res.on('error', () => {
        try { fs.unlinkSync(tempPath); } catch {}
        settle(false);
      });
      out.on('finish', () => {
        try {
          fs.renameSync(tempPath, destinationPath);
          settle(true);
        } catch {
          try { fs.unlinkSync(tempPath); } catch {}
          settle(false);
        }
      });
      res.pipe(out);
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => settle(false));
  });
}

async function persistRemoteThumbnailLocally(job, downloadDir) {
  if (!job) return false;
  const remoteThumb = Array.isArray(job.thumbnailUrls)
    ? job.thumbnailUrls.find((url) => isHttpUrl(url))
    : null;
  if (!remoteThumb) return false;

  const storageDir = job.storageDir || (job.filePath ? path.dirname(job.filePath) : downloadDir);
  const thumbPath = path.join(storageDir, `${job.id}-thumb.jpg`);
  try {
    await fs.promises.mkdir(storageDir, { recursive: true });
    if (fs.existsSync(thumbPath)) {
      job.thumbnailPath = thumbPath;
      return true;
    }
    const ok = await downloadRemoteImage(remoteThumb, thumbPath);
    if (ok) {
      job.thumbnailPath = thumbPath;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchSubtitlesForJob(job, downloadDir, queueManager, opts = {}) {
  if (!job) return;

  // Skip subtitle fetch if API key is not configured
  if (!config.subdlApiKey) {
    logger.debug('Skipping subtitle fetch - SUBDL_API_KEY not configured', { jobId: job.id });
    return;
  }

  try {
    const { seasonNumber, episodeNumber, type, lookupTitle } = opts;
    const targetDir = job.storageDir || (job.filePath ? path.dirname(job.filePath) : downloadDir);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const result = await fetchAndSaveSubtitles({
      apiKey: config.subdlApiKey,
      title: lookupTitle || job.title,
      tmdbId: job.tmdbId,
      imdbId: job.imdbId,
      downloadDir: targetDir,
      jobId: job.id,
      logger,
      seasonNumber,
      episodeNumber,
      type,
      lookupTitle,
    });

    if (result && result.path) {
      job.subtitleZipPath = result.path;
      job.subtitleMeta = result.subtitle || null;
      job.subtitlePath = result.subtitlePath || null;
      queueManager.saveQueue();
    }
  } catch (err) {
    logger.warn('SubDL subtitle fetch failed', { jobId: job.id, error: err && err.message });
  }
}

function registerJobRoutes(
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
) {
  // Create a new download job from the extension queue
  // Supports ?immediate=true to bypass queue and start immediately (legacy behavior)
  app.post('/api/jobs', jobValidation, async (req, res) => {
    const { queue, settings } = req.body || {};
    if (!queue || !queue.url) {
      return res.status(400).json({ error: 'Missing queue.url in request body' });
    }

    // Check if immediate start is requested (bypass queue)
    const immediate = req.query.immediate === 'true';

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
      // Prefer resource-style name when requested.
      baseName = queue.name || queue.title || 'video';
    } else {
      // Default: prefer webpage title.
      baseName = queue.title || queue.name || 'video';
    }

    const fileNameBase = safeFilename(baseName);

    // Detect whether this is an HLS playlist by URL extension.
    const isHls = /\.m3u8(\?|$)/i.test(queue.url || '');

    let filePath;
    let tsName;
    let downloadNameMp4;
    const storageDir = buildJobStorageDir(downloadDir, id);

    if (isHls) {
      // HLS flow: use TS container internally and MP4 as the final remuxed output.
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
    } else {
      // Direct file flow (e.g., MP4): save with the original or inferred extension
      // so the resulting file is immediately usable.
      let ext = '';
      try {
        const u = new URL(queue.url);
        ext = path.extname(u.pathname) || '';
      } catch {
        ext = '';
      }

      // Fallback to .mp4 when we don't recognize a safe extension.
      if (!ext || !/^\.[a-z0-9]{2,4}$/i.test(ext)) {
        ext = '.mp4';
      }

      const directName = `${fileNameBase}${ext}`;
      filePath = path.join(storageDir, `${id}-${directName}`);

      // For direct downloads, this is already the final user-facing name.
      tsName = directName;
      downloadNameMp4 = directName;
    }

    // Use server-configured downloadThreads if set, otherwise engine default
    const serverThreads = config.downloadThreads > 0 ? config.downloadThreads : DEFAULT_MAX_CONCURRENT;
    const clampedThreads = Math.min(16, Math.max(1, serverThreads));

    const job = {
      id,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // Use the resolved baseName (which already prefers customName) for display.
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
      thumbnailUrls: [],
      skipThumbnailGeneration: false,
      tmdbMetadata: null,
      downloadNameMp4,
      cancelled: false,
      maxConcurrent: clampedThreads,
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
      lastSentSegmentStates: {}, // Track what we last sent to client for delta updates
    };

    const inferredHints = inferMediaMetadata({
      title: job.title,
      resourceName: queue.name,
      sourcePageTitle: queue.title,
      mediaUrl: queue.url,
      sourcePageUrl: queue.sourcePageUrl,
    });
    const mediaHints = {
      ...inferredHints,
      ...(queue.titleHints && typeof queue.titleHints === 'object' ? queue.titleHints : {}),
      lookupTitle: (
        (queue.titleHints && typeof queue.titleHints.lookupTitle === 'string' ? queue.titleHints.lookupTitle : '')
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
    job.mediaHints = mediaHints;

    const lookupTitle = mediaHints.lookupTitle || job.title || job.downloadName;
    const seasonNumber = Number.isFinite(mediaHints.seasonNumber) ? mediaHints.seasonNumber : undefined;
    const episodeNumber = Number.isFinite(mediaHints.episodeNumber) ? mediaHints.episodeNumber : undefined;
    const isTv = !!mediaHints.isTvCandidate;

    // Add to queue or start immediately based on query parameter
    logger.info('Job create request', {
      jobId: id,
      maxConcurrent: clampedThreads,
      url: queue.url,
      lookupTitle,
      isTvCandidate: isTv,
      seasonNumber: seasonNumber || null,
      episodeNumber: episodeNumber || null,
      matchedPattern: mediaHints.matchedPattern,
      matchedField: mediaHints.matchedField,
    });

    if (immediate) {
      // Legacy behavior: start immediately without queue
      jobs.set(id, job);
      if (isHls) {
        runJob(job);
      } else {
        runDirectJob(job);
      }
      logger.info('Job created (immediate)', { jobId: id, url: queue.url, isHls });
      (async () => {
        if (!config.tmdbApiKey) {
          logger.info('TMDB lookup skipped (no TMDB_API_KEY set)', { jobId: job.id, title: job.title });
        } else {
          const title = lookupTitle || job.title || job.downloadName;
          const type = isTv ? 'tv' : 'movie';
          logger.info('TMDB lookup start', {
            jobId: job.id,
            title,
            type,
            seasonNumber: seasonNumber || null,
            episodeNumber: episodeNumber || null,
            matchedPattern: mediaHints.matchedPattern,
            matchedField: mediaHints.matchedField,
          });

          try {
            const tmdbResult = await lookupPoster({ apiKey: config.tmdbApiKey, title, type });
            if (tmdbResult) {
              job.thumbnailUrls = Array.isArray(tmdbResult.imageUrls)
                ? tmdbResult.imageUrls.filter(Boolean)
                : [tmdbResult.posterUrl, tmdbResult.backdropUrl].filter(Boolean);
              job.tmdbId = tmdbResult.id;
              job.tmdbTitle = tmdbResult.title;
              job.tmdbReleaseDate = tmdbResult.releaseDate;
              job.tmdbMetadata = {
                overview: tmdbResult.overview,
                runtime: tmdbResult.runtime,
                tagline: tmdbResult.tagline,
                genres: tmdbResult.genres,
                mediaType: tmdbResult.mediaType || type,
              };
              job.skipThumbnailGeneration = true;
              await persistRemoteThumbnailLocally(job, downloadDir);
              queueManager.saveQueue();
              logger.info('TMDB lookup success', { jobId: job.id, tmdbId: tmdbResult.id, thumbnails: job.thumbnailUrls.length });
            } else {
              logger.info('TMDB lookup returned no results', { jobId: job.id, title });
            }
          } catch (err) {
            logger.warn('TMDB lookup failed', { jobId: job.id, error: err.message });
          }
        }

        logger.info('SubDL: fetch start (immediate)', { jobId: job.id, title: job.title, tmdbId: job.tmdbId, imdbId: job.imdbId });
        try {
          await fetchSubtitlesForJob(job, downloadDir, queueManager, {
            seasonNumber,
            episodeNumber,
            type: isTv ? 'tv' : 'movie',
            lookupTitle,
          });
        } catch (err) {
          logger.warn('SubDL fetch errored (immediate)', { jobId: job.id, error: err && err.message });
        }
      })();
      res.json({ id });
    } else {
      // New behavior: add to queue
      const result = queueManager.addJob(job);
      logger.info('Job enqueued', { jobId: id, url: queue.url, queuePosition: result.queuePosition, isHls });
      (async () => {
        if (!config.tmdbApiKey) {
          logger.info('TMDB lookup skipped (no TMDB_API_KEY set)', { jobId: job.id, title: job.title });
        } else {
          const title = lookupTitle || job.title || job.downloadName;
          const type = isTv ? 'tv' : 'movie';
          logger.info('TMDB lookup start', {
            jobId: job.id,
            title,
            type,
            seasonNumber: seasonNumber || null,
            episodeNumber: episodeNumber || null,
            matchedPattern: mediaHints.matchedPattern,
            matchedField: mediaHints.matchedField,
          });

          try {
            const tmdbResult = await lookupPoster({ apiKey: config.tmdbApiKey, title, type });
            if (tmdbResult) {
              job.thumbnailUrls = Array.isArray(tmdbResult.imageUrls)
                ? tmdbResult.imageUrls.filter(Boolean)
                : [tmdbResult.posterUrl, tmdbResult.backdropUrl].filter(Boolean);
              job.tmdbId = tmdbResult.id;
              job.tmdbTitle = tmdbResult.title;
              job.tmdbReleaseDate = tmdbResult.releaseDate;
              job.tmdbMetadata = {
                overview: tmdbResult.overview,
                runtime: tmdbResult.runtime,
                tagline: tmdbResult.tagline,
                genres: tmdbResult.genres,
                mediaType: tmdbResult.mediaType || type,
              };
              job.skipThumbnailGeneration = true;
              await persistRemoteThumbnailLocally(job, downloadDir);
              queueManager.saveQueue();
              logger.info('TMDB lookup success', { jobId: job.id, tmdbId: tmdbResult.id, thumbnails: job.thumbnailUrls.length });
            } else {
              logger.info('TMDB lookup returned no results', { jobId: job.id, title });
            }
          } catch (err) {
            logger.warn('TMDB lookup failed', { jobId: job.id, error: err.message });
          }

          // Fetch English subtitles via SubDL
          try {
            await fetchSubtitlesForJob(job, downloadDir, queueManager, {
              seasonNumber,
              episodeNumber,
              type: isTv ? 'tv' : 'movie',
              lookupTitle,
            });
          } catch (err) {
            logger.warn('SubDL fetch errored', { jobId: job.id, error: err && err.message });
          }
        }
      })();
      res.json(result);
    }
  });

  // Get current job status/progress
  app.get('/api/jobs/:id', jobIdValidation, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      logger.warn('Job status requested for missing job', { jobId: req.params.id });
      return res.status(404).json({ error: 'Job not found' });
    }

    const full = req.query && (req.query.full === '1' || req.query.full === 'true');

    // Only send changed segments (delta update) by default to reduce data transfer
    // and client processing. When full=1 is requested, send all segmentStates once
    // (useful for a freshly reconnected UI).
    let changedSegments = {};
    let changeCount = 0;

    if (job.segmentStates && typeof job.segmentStates === 'object') {
      if (full) {
        changedSegments = { ...job.segmentStates };
        changeCount = Object.keys(changedSegments).length;
        job.lastSentSegmentStates = {};
        for (const index in job.segmentStates) {
          const currentState = job.segmentStates[index];
          job.lastSentSegmentStates[index] = currentState ? { ...currentState } : currentState;
        }
      } else {
        for (const index in job.segmentStates) {
          const currentState = job.segmentStates[index];
          const lastSentState = job.lastSentSegmentStates[index];

          // Send if state changed or never sent before
          if (!lastSentState ||
              currentState.status !== lastSentState.status ||
              currentState.attempt !== lastSentState.attempt) {
            changedSegments[index] = currentState;
            job.lastSentSegmentStates[index] = currentState ? { ...currentState } : currentState;
            changeCount++;
          }
        }
      }
    }

    const localThumbs = Array.isArray(job.thumbnailPaths)
      ? job.thumbnailPaths
        .filter((p) => fs.existsSync(p))
        .map((p) => buildDownloadAssetUrl(downloadDir, p))
        .filter(Boolean)
      : (job.thumbnailPath && fs.existsSync(job.thumbnailPath)
          ? [buildDownloadAssetUrl(downloadDir, job.thumbnailPath)].filter(Boolean)
          : []);

    const remoteThumbs = Array.isArray(job.thumbnailUrls)
      ? job.thumbnailUrls.filter(u => typeof u === 'string' && u.startsWith('http'))
      : [];

    const subtitleDownloadUrl = job.subtitlePath && fs.existsSync(job.subtitlePath)
      ? buildDownloadAssetUrl(downloadDir, job.subtitlePath)
      : null;

    res.json({
      id: job.id,
      status: job.status,
      title: job.title,
      progress: job.progress,
      totalSegments: job.totalSegments,
      completedSegments: job.completedSegments,
      bytesDownloaded: job.bytesDownloaded,
      failedSegments: Array.isArray(job.failedSegments) ? job.failedSegments.length : 0,
      threadStates: Array.isArray(job.threadStates) ? job.threadStates : [],
      segmentStates: changedSegments, // Only send changed segments
      segmentStatesCount: changeCount, // For debugging
      error: job.error,
      fallbackUrl: job.fallbackUrl || null,
      originalHlsUrl: job.originalHlsUrl || null,
      fallbackAttempted: !!job.fallbackAttempted,
      fallbackUsed: !!job.fallbackUsed,
      thumbnailUrls: [...localThumbs, ...remoteThumbs],
      subtitlePath: job.subtitlePath || null,
      subtitleDownloadUrl,
      updatedAt: job.updatedAt,
      tmdbId: job.tmdbId || null,
      tmdbTitle: job.tmdbTitle || null,
      tmdbReleaseDate: job.tmdbReleaseDate || null,
      tmdbMetadata: job.tmdbMetadata || null,
      mediaHints: job.mediaHints || null,
    });
  });

  // Cancel a running job
  app.post('/api/jobs/:id/cancel', jobIdValidation, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      logger.warn('Cancel requested for missing job', { jobId: req.params.id });
      return res.status(404).json({ error: 'Job not found' });
    }

    job.cancelled = true;
    job.cleanupOnCancel = true;
    if (job.status === 'pending' || job.status === 'fetching-playlist' || job.status === 'downloading') {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
    }

    logger.info('Job cancelled', { jobId: job.id, status: job.status });
    res.json({ ok: true });
  });

  // Download the completed file (attachment)
  app.get('/api/jobs/:id/file', jobIdValidation, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      logger.warn('File download requested for missing job', { jobId: req.params.id });
      return res.status(404).send('Job not found');
    }
    if (job.status !== 'completed' && job.status !== 'completed-with-errors') {
      logger.warn('File download requested for incomplete job', { jobId: job.id, status: job.status });
      return res.status(400).send('Job not completed yet');
    }

    // Prefer MP4 if remuxed successfully; otherwise, fall back to TS.
    let filePath = job.mp4Path && fs.existsSync(job.mp4Path) ? job.mp4Path : job.filePath;
    if (!fs.existsSync(filePath)) {
      logger.warn('File download requested but file missing on disk', { jobId: job.id, filePath });
      return res.status(404).send('File not found');
    }

    const downloadName = job.mp4Path && fs.existsSync(job.mp4Path)
      ? job.downloadNameMp4
      : job.downloadName || safeFilename(job.title || path.basename(filePath));

    logger.info('Job file download started', { jobId: job.id, filePath, downloadName });
    res.download(filePath, downloadName);
  });

  // Stream the completed file for inline playback (e.g., video preview)
  app.get('/api/jobs/:id/stream', jobIdValidation, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      logger.warn('Stream requested for missing job', { jobId: req.params.id });
      return res.status(404).send('Job not found');
    }
    if (job.status !== 'completed' && job.status !== 'completed-with-errors') {
      logger.warn('Stream requested for incomplete job', { jobId: job.id, status: job.status });
      return res.status(400).send('Job not completed yet');
    }
    // Prefer MP4 if available for browser playback.
    let filePath = job.mp4Path && fs.existsSync(job.mp4Path) ? job.mp4Path : job.filePath;
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    // Basic content type for video; MP4 preferred when available.
    if (job.mp4Path && fs.existsSync(job.mp4Path)) {
      res.setHeader('Content-Type', 'video/mp4');
    } else {
      res.setHeader('Content-Type', 'video/mp2t');
    }

    logger.info('Job stream started', { jobId: job.id, filePath });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).end('Error reading file');
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  });
}

module.exports = registerJobRoutes;
