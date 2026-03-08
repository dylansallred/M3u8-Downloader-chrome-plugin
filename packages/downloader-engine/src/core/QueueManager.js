const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { buildPlexBaseName } = require('../utils/plexNaming');

class QueueManager {
  constructor(options) {
    const {
      queueFilePath,
      fsPromises,
      jobs,
      runJob,
      runDirectJob,
      initialSettings,
      getCompletedOutputDir = null,
      maxPersistedJobs = 200,
      completedRetentionMs = 7 * 24 * 60 * 60 * 1000,
    } = options || {};

    if (!queueFilePath) {
      throw new Error('QueueManager requires a queueFilePath');
    }
    if (!fsPromises) {
      throw new Error('QueueManager requires fsPromises');
    }
    if (!jobs) {
      throw new Error('QueueManager requires a jobs Map');
    }
    if (typeof runJob !== 'function' || typeof runDirectJob !== 'function') {
      throw new Error('QueueManager requires runJob and runDirectJob functions');
    }

    this.queue = []; // Array of job objects with queue metadata
    this.settings = {
      maxConcurrent: 1, // Number of simultaneous downloads (1-16)
      autoStart: true,  // Automatically start next queued job
      ...(initialSettings || {}),
    };
    this.hasPersistedSettings = false;
    this.activeJobs = new Set(); // Set of currently downloading job IDs
    this.queueFilePath = queueFilePath;
    this.downloadDir = path.dirname(queueFilePath);
    this.maxPersistedJobs = maxPersistedJobs;
    this.completedRetentionMs = completedRetentionMs;
    this.fsPromises = fsPromises;
    this.jobs = jobs;
    this.runJob = runJob;
    this.runDirectJob = runDirectJob;
    this.getCompletedOutputDir = typeof getCompletedOutputDir === 'function'
      ? getCompletedOutputDir
      : null;

    this.loadQueue();
  }

  // Load queue from disk
  async loadQueue() {
    try {
      try {
        await this.fsPromises.access(this.queueFilePath);
      } catch {
        return;
      }

      const data = await this.fsPromises.readFile(this.queueFilePath, 'utf8');
      const parsed = JSON.parse(data);
      this.queue = Array.isArray(parsed.queue) ? parsed.queue : [];
      const persistedSettings = parsed.settings && typeof parsed.settings === 'object'
        ? parsed.settings
        : null;
      if (persistedSettings) {
        this.settings = { ...this.settings, ...persistedSettings };
        this.hasPersistedSettings = true;
      }

      // Restore jobs to the jobs Map and reset states for recovery
      this.queue.forEach((queuedJob) => {
        if (!queuedJob.storageDir && queuedJob.filePath) {
          queuedJob.storageDir = path.dirname(queuedJob.filePath);
        }
        if (
          queuedJob.queueStatus === 'downloading'
          || queuedJob.status === 'downloading'
          || queuedJob.status === 'fetching-playlist'
        ) {
          // Reset in-flight jobs to queued/pending on server restart so they can be started again.
          queuedJob.queueStatus = 'queued';
          queuedJob.status = 'pending';
          queuedJob.pauseRequested = false;
          queuedJob.resumeRequested = false;
          queuedJob.cancelled = false;
          queuedJob.speedBps = 0;
          queuedJob.etaSeconds = null;
        }
        // Restore job to jobs Map if not already there
        if (!this.jobs.has(queuedJob.id)) {
          this.jobs.set(queuedJob.id, queuedJob);
        }
      });

      this.pruneQueueForPersistence();
      await this.cleanupOrphanTempDirectories();

      logger.info('Loaded jobs from queue file', { count: this.queue.length });

      if (this.settings.autoStart) {
        this.processQueue();
      }
    } catch (err) {
      logger.warn('Failed to load queue from disk', { error: err.message });
      this.queue = [];
    }
  }

  extractJobIdFromTempDirName(name) {
    const value = String(name || '').trim();
    if (!value) return '';
    const modern = value.match(/-([a-z0-9]+-[a-z0-9]+)$/i);
    if (modern && modern[1]) return modern[1];
    const legacy = value.match(/-([a-z0-9]+)$/i);
    if (legacy && legacy[1]) return legacy[1];
    return '';
  }

  async cleanupOrphanTempDirectories() {
    const keepJobIds = new Set(
      (this.queue || [])
        .filter(Boolean)
        .filter((job) => {
          const status = String(job.queueStatus || job.status || '');
          return status === 'queued'
            || status === 'paused'
            || status === 'downloading'
            || status === 'fetching-playlist';
        })
        .map((job) => String(job.id || '').trim())
        .filter(Boolean),
    );

    let removedCount = 0;
    try {
      const entries = await this.fsPromises.readdir(this.downloadDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry || !entry.isDirectory() || !entry.name.startsWith('temp-')) continue;

        const entryPath = path.join(this.downloadDir, entry.name);
        const linkedJobId = this.extractJobIdFromTempDirName(entry.name);
        const shouldKeep = linkedJobId
          ? keepJobIds.has(linkedJobId)
          : keepJobIds.size > 0;
        if (shouldKeep) continue;

        try {
          await this.fsPromises.rm(entryPath, { recursive: true, force: true });
          removedCount += 1;
        } catch (err) {
          logger.warn('Failed to remove orphan temp directory', {
            tempDir: entry.name,
            error: err && err.message,
          });
        }
      }
    } catch (err) {
      logger.warn('Failed to enumerate temp directories for orphan cleanup', {
        error: err && err.message,
      });
      return;
    }

    if (removedCount > 0) {
      logger.info('Removed orphan temp directories', { removedCount });
    }
  }

  sanitizeFinalFileName(rawName, fallbackExt = '') {
    const raw = String(rawName || '').trim();
    const normalized = raw
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim();

    let safeName = normalized || 'Download';
    if (fallbackExt) {
      const ext = String(fallbackExt || '').trim();
      if (ext && !safeName.toLowerCase().endsWith(ext.toLowerCase())) {
        safeName = safeName.replace(/\.[a-z0-9]{2,4}$/i, '').trim();
        safeName = `${safeName}${ext}`;
      }
    }
    return safeName;
  }

  buildCompletedArtifactFolderName(preferredBaseName) {
    const ext = path.extname(preferredBaseName || '');
    const baseName = ext ? String(preferredBaseName || '').slice(0, -ext.length) : String(preferredBaseName || '');
    return this.sanitizeFinalFileName(baseName || 'Download').replace(/\.[ ]*$/g, '') || 'Download';
  }

  resolveUniqueOutputPath(targetDir, fileName) {
    const ext = path.extname(fileName);
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    let attempt = 0;
    let candidate = path.join(targetDir, fileName);
    while (fs.existsSync(candidate)) {
      attempt += 1;
      candidate = path.join(targetDir, `${base} (${attempt})${ext}`);
    }
    return candidate;
  }

  relocateSidecarArtifact(candidatePath, resolvedTargetDir) {
    if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
      return candidatePath;
    }

    const resolvedCandidate = path.resolve(candidatePath);
    if (!fs.existsSync(resolvedCandidate)) {
      return candidatePath;
    }

    const currentBaseName = path.basename(resolvedCandidate);
    let targetPath = path.join(resolvedTargetDir, currentBaseName);
    if (targetPath !== resolvedCandidate && fs.existsSync(targetPath)) {
      targetPath = this.resolveUniqueOutputPath(resolvedTargetDir, currentBaseName);
    }

    if (targetPath !== resolvedCandidate) {
      fs.renameSync(resolvedCandidate, targetPath);
    }

    return targetPath;
  }

  relocateCompletedArtifact(job) {
    if (!job) return;

    const primaryPath = job.mp4Path && fs.existsSync(job.mp4Path) ? job.mp4Path : job.filePath;
    if (!primaryPath || !fs.existsSync(primaryPath)) return;

    const ext = path.extname(primaryPath) || (job.mp4Path ? '.mp4' : '');
    const preferredBaseName = this.sanitizeFinalFileName(buildPlexBaseName(job), ext);
    const preferredDir = this.getCompletedOutputDir ? String(this.getCompletedOutputDir() || '').trim() : '';
    const targetDir = preferredDir
      ? path.join(preferredDir, this.buildCompletedArtifactFolderName(preferredBaseName))
      : path.dirname(primaryPath);
    if (!targetDir) return;

    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const resolvedCurrent = path.resolve(primaryPath);
      const resolvedTargetDir = path.resolve(targetDir);
      const currentDir = path.dirname(resolvedCurrent);
      const sameDir = currentDir === resolvedTargetDir;
      const currentBaseName = path.basename(resolvedCurrent);

      let targetPath = path.join(resolvedTargetDir, preferredBaseName);
      if (sameDir && currentBaseName === preferredBaseName) {
        targetPath = resolvedCurrent;
      } else if (fs.existsSync(targetPath)) {
        if (path.resolve(targetPath) !== resolvedCurrent) {
          targetPath = this.resolveUniqueOutputPath(resolvedTargetDir, preferredBaseName);
        }
      }

      if (targetPath !== resolvedCurrent) {
        fs.renameSync(resolvedCurrent, targetPath);
      }

      if (job.mp4Path && path.resolve(job.mp4Path) === resolvedCurrent) {
        job.mp4Path = targetPath;
        job.downloadNameMp4 = path.basename(targetPath);
        if (!job.filePath || path.resolve(job.filePath) === resolvedCurrent) {
          job.filePath = targetPath;
          job.downloadName = path.basename(targetPath);
        }
      } else {
        job.filePath = targetPath;
        job.downloadName = path.basename(targetPath);
        if (!job.mp4Path) {
          job.downloadNameMp4 = path.basename(targetPath).replace(/\.[a-z0-9]{2,4}$/i, '.mp4');
        }
      }

      job.thumbnailPath = this.relocateSidecarArtifact(job.thumbnailPath, resolvedTargetDir);
      if (Array.isArray(job.thumbnailPaths)) {
        job.thumbnailPaths = job.thumbnailPaths.map((thumbPath) =>
          this.relocateSidecarArtifact(thumbPath, resolvedTargetDir)
        );
      }
      job.subtitlePath = this.relocateSidecarArtifact(job.subtitlePath, resolvedTargetDir);
      job.subtitleZipPath = this.relocateSidecarArtifact(job.subtitleZipPath, resolvedTargetDir);

      job.outputPath = targetPath;
      job.outputDirectory = path.dirname(targetPath);
      job.storageDir = resolvedTargetDir;
      job.updatedAt = Date.now();
    } catch (err) {
      logger.warn('Failed to relocate completed artifact', {
        jobId: job.id,
        preferredDir,
        primaryPath,
        error: err && err.message,
      });
      if (!job.error) {
        job.error = `Completed file move failed: ${(err && err.message) || 'Unknown error'}`;
        job.status = 'completed-with-errors';
      }
    }
  }

  // Save queue to disk
  async saveQueue() {
    try {
      this.pruneQueueForPersistence();

      const serializedQueue = this.queue.map((job) => {
        const {
          id,
          title,
          url,
          headers,
          filePath,
          mp4Path,
          storageDir,
          downloadName,
          downloadNameMp4,
          bytesDownloaded,
          totalBytes,
          totalSegments,
          completedSegments,
          progress,
          speedBps,
          etaSeconds,
          status,
          queueStatus,
          queuePosition,
          queuedAt,
          startedAt,
          completedAt,
          error,
          thumbnailPath,
          thumbnailPaths,
          cancelled,
          maxConcurrent,
          maxSegmentAttempts,
          pauseRequested,
          resumeRequested,
          createdAt,
          updatedAt,
        } = job;

        return {
          id,
          title,
          url,
          headers,
          filePath,
          mp4Path,
          storageDir,
          downloadName,
          downloadNameMp4,
          bytesDownloaded,
          totalBytes,
          totalSegments,
          completedSegments,
          progress,
          speedBps,
          etaSeconds,
          status,
          queueStatus,
          queuePosition,
          queuedAt,
          startedAt,
          completedAt,
          error,
          thumbnailPath,
          thumbnailPaths,
          thumbnailUrls: job.thumbnailUrls,
          cancelled,
          pauseRequested: !!pauseRequested,
          resumeRequested: !!resumeRequested,
          maxConcurrent,
          maxSegmentAttempts,
          createdAt,
          updatedAt,
          tmdbId: job.tmdbId,
          tmdbTitle: job.tmdbTitle,
          tmdbReleaseDate: job.tmdbReleaseDate,
          tmdbMetadata: job.tmdbMetadata || null,
          mediaHints: job.mediaHints || null,
          manualTitleOverride: !!job.manualTitleOverride,
          skipThumbnailGeneration: job.skipThumbnailGeneration,
          subtitlePath: job.subtitlePath,
          subtitleZipPath: job.subtitleZipPath,
          subtitleMeta: job.subtitleMeta,
          fallbackUrl: job.fallbackUrl,
          directFallbackFilePath: job.directFallbackFilePath,
          directFallbackDownloadName: job.directFallbackDownloadName,
          directFallbackDownloadNameMp4: job.directFallbackDownloadNameMp4,
          originalHlsUrl: job.originalHlsUrl,
          originalHlsDownloadName: job.originalHlsDownloadName,
          originalHlsDownloadNameMp4: job.originalHlsDownloadNameMp4,
          fallbackAttempted: !!job.fallbackAttempted,
          fallbackUsed: !!job.fallbackUsed,
          youtubeMetadata: job.youtubeMetadata || null,
        };
      });

      const data = {
        queue: serializedQueue,
        settings: this.settings,
        savedAt: Date.now(),
      };
      await this.fsPromises.writeFile(this.queueFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger.warn('Failed to save queue to disk', { error: err.message });
    }
  }

  // Add job to queue
  addJob(job) {
    const queuePosition = this.queue.length;

    // Extend job with queue metadata
    job.queuePosition = queuePosition;
    job.queuedAt = Date.now();
    job.queueStatus = 'queued';
    job.startedAt = null;
    job.completedAt = null;

    this.queue.push(job);
    this.jobs.set(job.id, job);
    this.saveQueue();

    if (this.settings.autoStart) {
      this.processQueue();
    }

    return { id: job.id, queuePosition };
  }

  // Get all jobs in queue
  getQueue() {
    return this.queue.map((job) => ({
      id: job.id,
      title: job.title,
      queueStatus: job.queueStatus,
      queuePosition: job.queuePosition,
      progress: job.progress || 0,
      status: job.status || 'pending',
      bytesDownloaded: job.bytesDownloaded || 0,
      totalBytes: Number(job.totalBytes || 0) || 0,
      totalSegments: job.totalSegments || 0,
      completedSegments: job.completedSegments || 0,
      speedBps: Number(job.speedBps || 0) || 0,
      etaSeconds: Number.isFinite(job.etaSeconds) ? Number(job.etaSeconds) : null,
      failedSegments: Array.isArray(job.failedSegments) ? job.failedSegments.length : 0,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      originalHlsUrl: job.originalHlsUrl || null,
      fallbackAttempted: !!job.fallbackAttempted,
      fallbackUsed: !!job.fallbackUsed,
      thumbnailUrls: this.buildThumbnailUrls(job),
      tmdbId: job.tmdbId,
      tmdbTitle: job.tmdbTitle,
      tmdbReleaseDate: job.tmdbReleaseDate,
      tmdbMetadata: job.tmdbMetadata || null,
      mediaHints: job.mediaHints || null,
      manualTitleOverride: !!job.manualTitleOverride,
      youtubeMetadata: job.youtubeMetadata || null,
    }));
  }

  buildThumbnailUrls(job) {
    const toDownloadUrl = (candidatePath) => {
      if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
        return null;
      }

      const resolvedRoot = path.resolve(this.downloadDir);
      const resolvedPath = path.resolve(candidatePath);
      const relative = path.relative(resolvedRoot, resolvedPath);

      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return `/downloads/${relative.replace(/\\/g, '/')}`;
      }

      return null;
    };

    const localThumbs = Array.isArray(job.thumbnailPaths)
      ? job.thumbnailPaths
        .filter((p) => fs.existsSync(p))
        .map((p) => toDownloadUrl(p))
        .filter(Boolean)
      : (job.thumbnailPath && fs.existsSync(job.thumbnailPath)
          ? [toDownloadUrl(job.thumbnailPath)].filter(Boolean)
          : []);

    const remoteThumbs = Array.isArray(job.thumbnailUrls)
      ? job.thumbnailUrls.filter(u => typeof u === 'string' && u.startsWith('http'))
      : [];

    return [...localThumbs, ...remoteThumbs];
  }

  // Process queue - start next job if we have capacity
  processQueue() {
    if (!this.settings.autoStart) return;

    const attemptedJobIds = new Set();
    const maxIterations = Math.max(1, this.queue.length * 2);
    let iterations = 0;

    while (this.getActiveCount() < this.settings.maxConcurrent && iterations < maxIterations) {
      iterations += 1;

      const nextJob = this.queue.find((job) =>
        job
        && job.queueStatus === 'queued'
        && !attemptedJobIds.has(job.id)
      );
      if (!nextJob) {
        break;
      }

      attemptedJobIds.add(nextJob.id);
      const started = this.startJob(nextJob.id);
      if (!started) {
        continue;
      }
    }
  }

  // Count active jobs that are actually downloading/fetching
  getActiveCount() {
    return Array.from(this.activeJobs).filter((id) => {
      const job = this.jobs.get(id);
      return job && (job.status === 'downloading' || job.status === 'fetching-playlist');
    }).length;
  }

  // Start a specific job
  startJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      logger.warn('Cannot start job - not found', { jobId });
      return false;
    }

    if (job.status === 'downloading' || job.status === 'fetching-playlist') {
      logger.warn('Cannot start job - already active', { jobId, status: job.status });
      return false;
    }

    if (job.queueStatus !== 'queued' && job.queueStatus !== 'paused') {
      logger.warn('Cannot start job - invalid queueStatus', { jobId, queueStatus: job.queueStatus });
      return false;
    }

    // Respect maxConcurrent setting for manual starts too
    if (this.getActiveCount() >= this.settings.maxConcurrent) {
      logger.warn('Cannot start job - at max concurrent limit', { jobId, maxConcurrent: this.settings.maxConcurrent });
      return false;
    }

    job.queueStatus = 'downloading';
    job.pauseRequested = false;
    job.resumeRequested = false;
    job.cancelled = false;
    job.startedAt = Date.now();
    this.activeJobs.add(jobId);
    this.saveQueue();

    // Detect whether this is an HLS playlist
    const isHls = /\.m3u8(\?|$)/i.test(job.url || '');

    // Start the download
    if (isHls) {
      this.runJob(job).then(() => this.onJobComplete(jobId));
    } else {
      this.runDirectJob(job).then(() => this.onJobComplete(jobId));
    }

    return true;
  }

  // Rename a job's title/download name
  renameJob(jobId, newTitle) {
    const job = this.queue.find((j) => j.id === jobId);
    if (!job) return false;
    if (job.queueStatus !== 'queued' && job.queueStatus !== 'paused') return false;

    job.title = newTitle;
    job.downloadName = newTitle;
    job.manualTitleOverride = true;
    
    // Ensure downloadNameMp4 has .mp4 extension
    let mp4Name = newTitle;
    if (!/\.mp4$/i.test(mp4Name)) {
      // Remove other extensions if present
      mp4Name = mp4Name.replace(/\.[a-z0-9]{2,4}$/i, '');
      mp4Name = `${mp4Name}.mp4`;
    }
    job.downloadNameMp4 = mp4Name;
    
    job.updatedAt = Date.now();
    this.saveQueue();
    return true;
  }

  // Called when a job completes
  onJobComplete(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (job.pauseRequested && job.status === 'cancelled') {
      // Pause is implemented as cooperative cancellation + resumable re-queue.
      // Keep the job resumable instead of treating it as a terminal cancel.
      const shouldAutoResume = !!job.resumeRequested;
      job.pauseRequested = false;
      job.resumeRequested = false;
      job.cancelled = false;
      job.status = shouldAutoResume ? 'pending' : 'paused';
      job.queueStatus = shouldAutoResume ? 'queued' : 'paused';
      job.updatedAt = Date.now();
      this.activeJobs.delete(jobId);
      this.saveQueue();

      if (this.settings.autoStart) {
        this.processQueue();
      }
      return;
    }

    // Update queue status based on job status
    if (job.status === 'completed' || job.status === 'completed-with-errors') {
      this.relocateCompletedArtifact(job);
      job.queueStatus = 'completed';
      job.completedAt = Date.now();
    } else if (job.status === 'error') {
      job.queueStatus = 'failed';
      job.completedAt = Date.now();
    } else if (job.status === 'cancelled') {
      job.queueStatus = 'cancelled';
      job.completedAt = Date.now();
    }

    this.activeJobs.delete(jobId);
    this.saveQueue();

    // Start next job if auto-start is enabled
    if (this.settings.autoStart) {
      this.processQueue();
    }
  }

  // Pause a job
  pauseJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.queueStatus === 'downloading') {
      job.pauseRequested = true;
      job.resumeRequested = false;
      job.cancelled = true;
      job.queueStatus = 'paused';
      this.activeJobs.delete(jobId);
      this.saveQueue();
      return true;
    }

    return false;
  }

  // Resume a paused job
  resumeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.status === 'downloading' || job.status === 'fetching-playlist') {
      if (job.queueStatus === 'paused') {
        // Accept resume intent while cooperative pause is still winding down.
        job.resumeRequested = true;
        this.saveQueue();
        return true;
      }
      return false;
    }

    if (job.queueStatus === 'paused') {
      job.cancelled = false;
      job.pauseRequested = false;
      job.queueStatus = 'queued';
      job.status = 'pending';
      job.updatedAt = Date.now();
      this.saveQueue();

      // Try to start immediately if we have capacity
      if (this.settings.autoStart) {
        this.processQueue();
      }
      return true;
    }

    return false;
  }

  // Remove job from queue
  removeJob(jobId, deleteFiles = false) {
    const jobIndex = this.queue.findIndex(j => j.id === jobId);
    if (jobIndex === -1) return false;

    const job = this.queue[jobIndex];

    // Cancel if currently downloading
    if (job.queueStatus === 'downloading') {
      job.cancelled = true;
      // Ensure in-flight job processors cleanup partial artifacts before exiting.
      job.cleanupOnCancel = true;
      this.activeJobs.delete(jobId);
    }

    const isActiveDownload = job.queueStatus === 'downloading'
      || job.status === 'downloading'
      || job.status === 'fetching-playlist';
    const deleteTransientOnly = !deleteFiles;

    // Delete files if requested; otherwise still remove transient artifacts for removed jobs.
    if (deleteFiles || !isActiveDownload) {
      try {
        job.cleanupOnCancel = true;
        const filesToDelete = new Set();
        const addFile = (filePath) => {
          if (typeof filePath === 'string' && filePath.trim()) {
            filesToDelete.add(filePath);
          }
        };

        if (!deleteTransientOnly) {
          addFile(job.filePath);
          addFile(job.mp4Path);
          addFile(job.thumbnailPath);
          addFile(job.subtitlePath);
          addFile(job.subtitleZipPath);

          if (Array.isArray(job.thumbnailPaths)) {
            job.thumbnailPaths.forEach((thumbPath) => addFile(thumbPath));
          }
        }

        if (job.filePath) {
          addFile(`${job.filePath}.part`);
        }
        if (job.mp4Path) {
          addFile(`${job.mp4Path}.part`);
        }

        if (job.id) {
          const referenceDir = job.filePath
            ? path.dirname(job.filePath)
            : (typeof job.storageDir === 'string' ? job.storageDir : null);
          if (referenceDir) {
            addFile(path.join(referenceDir, `ts-parts-${job.id}.txt`));
            if (!deleteTransientOnly) {
              addFile(path.join(referenceDir, `${job.id}-thumb.jpg`));
              addFile(path.join(referenceDir, `${job.id}-subtitles.srt`));
              addFile(path.join(referenceDir, `${job.id}-subtitles.zip`));
            }
          }
        }

        filesToDelete.forEach((filePath) => {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        });

        const jobStorageDir = (() => {
          if (typeof job.storageDir === 'string' && job.storageDir.trim()) {
            return job.storageDir;
          }
          if (typeof job.filePath === 'string' && job.filePath.trim()) {
            return path.dirname(job.filePath);
          }
          return null;
        })();

        if (
          jobStorageDir
          && fs.existsSync(jobStorageDir)
          && path.resolve(path.dirname(jobStorageDir)) === path.resolve(this.downloadDir)
          && path.basename(jobStorageDir) === String(job.id || '')
        ) {
          if (deleteTransientOnly) {
            try {
              const storageEntries = fs.readdirSync(jobStorageDir, { withFileTypes: true });
              storageEntries
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name)
                .filter((name) => name.endsWith('.part') || name.endsWith('.tmp') || /^ts-parts-.*[.]txt$/i.test(name))
                .forEach((name) => {
                  const target = path.join(jobStorageDir, name);
                  if (fs.existsSync(target)) {
                    fs.unlinkSync(target);
                  }
                });
              const remaining = fs.readdirSync(jobStorageDir);
              if (remaining.length === 0) {
                fs.rmdirSync(jobStorageDir);
              }
            } catch (err) {
              console.warn(`Failed to prune transient files in storage dir for job ${jobId}:`, err.message);
            }
          } else {
            fs.rmSync(jobStorageDir, { recursive: true, force: true });
          }
        }

        if (job.id) {
          const queueDir = path.dirname(this.queueFilePath);
          if (fs.existsSync(queueDir)) {
            const entries = fs.readdirSync(queueDir, { withFileTypes: true });
            entries
              .filter((entry) => entry.isDirectory())
              .filter((entry) => entry.name.startsWith('temp-'))
              .filter((entry) => this.extractJobIdFromTempDirName(entry.name) === String(job.id))
              .forEach((entry) => {
                const tempPath = path.join(queueDir, entry.name);
                fs.rmSync(tempPath, { recursive: true, force: true });
              });
          }
        }
      } catch (err) {
        console.warn(`Failed to cleanup files for job ${jobId}:`, err.message);
      }
    }

    // Remove from queue and jobs map
    this.queue.splice(jobIndex, 1);
    this.jobs.delete(jobId);

    // Update queue positions
    this.queue.forEach((j, idx) => {
      j.queuePosition = idx;
    });

    this.saveQueue();

    // Start next job if we freed up a slot
    if (this.settings.autoStart) {
      this.processQueue();
    }

    return true;
  }

  // Move job to new position in queue
  moveJob(jobId, newPosition) {
    const jobIndex = this.queue.findIndex(j => j.id === jobId);
    if (jobIndex === -1) return false;

    const job = this.queue[jobIndex];

    // Can't move jobs that are downloading or completed
    if (job.queueStatus !== 'queued' && job.queueStatus !== 'paused') {
      return false;
    }

    // Remove from current position
    this.queue.splice(jobIndex, 1);

    // Insert at new position
    const targetIndex = Math.max(0, Math.min(newPosition, this.queue.length));
    this.queue.splice(targetIndex, 0, job);

    // Update all queue positions
    this.queue.forEach((j, idx) => {
      j.queuePosition = idx;
    });

    this.saveQueue();
    return true;
  }

  // Update queue settings
  updateSettings(newSettings) {
    if (typeof newSettings.maxConcurrent === 'number') {
      this.settings.maxConcurrent = Math.max(1, Math.min(16, newSettings.maxConcurrent));
    }
    if (typeof newSettings.autoStart === 'boolean') {
      this.settings.autoStart = newSettings.autoStart;
    }

    this.saveQueue();

    // If we increased capacity or enabled auto-start, try to start more jobs
    if (this.settings.autoStart) {
      this.processQueue();
    }

    return this.settings;
  }

  applyLegacySettingsIfNeeded(legacySettings = {}) {
    if (this.hasPersistedSettings) {
      return { migrated: false, reason: 'persisted-settings-present' };
    }

    const next = {};
    if (typeof legacySettings.maxConcurrent === 'number') {
      next.maxConcurrent = legacySettings.maxConcurrent;
    }
    if (typeof legacySettings.autoStart === 'boolean') {
      next.autoStart = legacySettings.autoStart;
    }

    if (Object.keys(next).length === 0) {
      return { migrated: false, reason: 'no-legacy-settings' };
    }

    this.updateSettings(next);
    this.hasPersistedSettings = true;
    return { migrated: true, settings: this.getSettings() };
  }

  // Get queue settings
  getSettings() {
    return { ...this.settings };
  }

  pruneQueueForPersistence() {
    const now = Date.now();

    let filtered = this.queue.filter((job) => {
      if (!job) {
        return false;
      }

      const status = job.queueStatus;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        const completedAt = job.completedAt || job.updatedAt || job.queuedAt;
        if (!completedAt) {
          return false;
        }
        if (now - completedAt > this.completedRetentionMs) {
          if (job.id && this.jobs.has(job.id)) {
            this.jobs.delete(job.id);
          }
          return false;
        }
      }

      return true;
    });

    if (filtered.length > this.maxPersistedJobs) {
      const activeStatuses = new Set(['queued', 'paused', 'downloading', 'fetching-playlist']);
      const activeOrPending = filtered.filter((job) => activeStatuses.has(job.queueStatus));
      const rest = filtered.filter((job) => !activeStatuses.has(job.queueStatus));

      rest.sort((a, b) => {
        const aTime = a.completedAt || a.updatedAt || a.queuedAt || 0;
        const bTime = b.completedAt || b.updatedAt || b.queuedAt || 0;
        return aTime - bTime;
      });

      const availableSlots = Math.max(this.maxPersistedJobs - activeOrPending.length, 0);
      const keepRest = rest.slice(Math.max(rest.length - availableSlots, 0));
      const keepIds = new Set([...activeOrPending, ...keepRest].map((job) => job.id));

      filtered.forEach((job) => {
        if (job && job.id && !keepIds.has(job.id) && this.jobs.has(job.id)) {
          this.jobs.delete(job.id);
        }
      });

      filtered = filtered.filter((job) => keepIds.has(job.id));
    }

    this.queue = filtered;
    this.queue.forEach((job, idx) => {
      job.queuePosition = idx;
    });
  }
}

module.exports = QueueManager;
