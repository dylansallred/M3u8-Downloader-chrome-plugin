const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const logger = require('../utils/logger');
const { jobValidation } = require('../utils/validators');
const { lookupPoster } = require('../services/tmdb');
const { fetchAndSaveSubtitles } = require('../services/subdl');
const config = require('../config');

const SUBDL_API_KEY = process.env.SUBDL_API_KEY || 'rsjvucfBa45xnvbd3XTB8bP3LqHTs0D6';

// Remove season/episode tokens for external lookups (TMDB/SubDL) while keeping display name intact.
const deriveLookupTitle = (raw) => {
  if (!raw) return '';
  const cleaned = raw.replace(/s\d{1,2}e\d{1,2}/i, '').trim();
  return cleaned || raw;
};

async function fetchSubtitlesForJob(job, downloadDir, queueManager, opts = {}) {
  if (!job) return;
  try {
    const { seasonNumber, episodeNumber, type, lookupTitle } = opts;
    const result = await fetchAndSaveSubtitles({
      apiKey: SUBDL_API_KEY,
      title: lookupTitle || job.title,
      tmdbId: job.tmdbId,
      imdbId: job.imdbId,
      downloadDir,
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
    const { queue, threads, settings } = req.body || {};
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

    if (isHls) {
      // HLS flow: use TS container internally and MP4 as the final remuxed output.
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
      filePath = path.join(downloadDir, `${id}-${directName}`);

      // For direct downloads, this is already the final user-facing name.
      tsName = directName;
      downloadNameMp4 = directName;
    }

    const parsedThreads = Number(threads);
    const clampedThreads = Number.isFinite(parsedThreads) && parsedThreads > 0
      ? Math.min(16, parsedThreads)
      : DEFAULT_MAX_CONCURRENT;

    const job = {
      id,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // Use the resolved baseName (which already prefers customName) for display.
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

    // Derive a TMDB/SubDL-friendly title by stripping SxxExx and trimming.
    const lookupTitle = deriveLookupTitle(job.title);
    const matchSeasonEp = (job.title || "").match(/s(\d{1,2})e(\d{1,2})/i);
    const seasonNumber = matchSeasonEp ? parseInt(matchSeasonEp[1], 10) : undefined;
    const episodeNumber = matchSeasonEp ? parseInt(matchSeasonEp[2], 10) : undefined;
    const isTv = !!matchSeasonEp;

    // Add to queue or start immediately based on query parameter
    logger.info('Job create request', { jobId: id, requestedThreads: threads, parsedThreads, maxConcurrent: clampedThreads, url: queue.url });

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
          logger.info('TMDB lookup start', { jobId: job.id, title, type });

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
              };
              job.skipThumbnailGeneration = true;
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
          logger.info('TMDB lookup start', { jobId: job.id, title, type });

          try {
            const tmdbResult = await lookupPoster({ apiKey: config.tmdbApiKey, title, type });
            if (tmdbResult) {
              job.thumbnailUrls = Array.isArray(tmdbResult.imageUrls)
                ? tmdbResult.imageUrls.filter(Boolean)
                : [tmdbResult.posterUrl, tmdbResult.backdropUrl].filter(Boolean);
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
  app.get('/api/jobs/:id', (req, res) => {
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
      ? job.thumbnailPaths.filter(p => fs.existsSync(p)).map(p => `/downloads/${path.basename(p)}`)
      : (job.thumbnailPath && fs.existsSync(job.thumbnailPath)
          ? [`/downloads/${path.basename(job.thumbnailPath)}`]
          : []);

    const remoteThumbs = Array.isArray(job.thumbnailUrls)
      ? job.thumbnailUrls.filter(u => typeof u === 'string' && u.startsWith('http'))
      : [];

    const subtitleDownloadUrl = job.subtitlePath && fs.existsSync(job.subtitlePath)
      ? `/downloads/${path.basename(job.subtitlePath)}`
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
      thumbnailUrls: [...remoteThumbs, ...localThumbs],
      subtitlePath: job.subtitlePath || null,
      subtitleDownloadUrl,
      updatedAt: job.updatedAt,
    });
  });

  // Cancel a running job
  app.post('/api/jobs/:id/cancel', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      logger.warn('Cancel requested for missing job', { jobId: req.params.id });
      return res.status(404).json({ error: 'Job not found' });
    }

    job.cancelled = true;
    if (job.status === 'pending' || job.status === 'fetching-playlist' || job.status === 'downloading') {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
    }

    logger.info('Job cancelled', { jobId: job.id, status: job.status });
    res.json({ ok: true });
  });

  // Download the completed file (attachment)
  app.get('/api/jobs/:id/file', (req, res) => {
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
  app.get('/api/jobs/:id/stream', (req, res) => {
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
