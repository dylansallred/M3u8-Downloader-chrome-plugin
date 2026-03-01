const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

class QueueManager {
  constructor(options) {
    const {
      queueFilePath,
      fsPromises,
      jobs,
      runJob,
      runDirectJob,
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
    };
    this.activeJobs = new Set(); // Set of currently downloading job IDs
    this.queueFilePath = queueFilePath;
    this.maxPersistedJobs = maxPersistedJobs;
    this.completedRetentionMs = completedRetentionMs;
    this.fsPromises = fsPromises;
    this.jobs = jobs;
    this.runJob = runJob;
    this.runDirectJob = runDirectJob;

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
      this.settings = { ...this.settings, ...(parsed.settings || {}) };

      // Restore jobs to the jobs Map and reset states for recovery
      this.queue.forEach((queuedJob) => {
        if (queuedJob.queueStatus === 'downloading') {
          // Reset downloading jobs to queued on server restart
          queuedJob.queueStatus = 'queued';
        }
        // Restore job to jobs Map if not already there
        if (!this.jobs.has(queuedJob.id)) {
          this.jobs.set(queuedJob.id, queuedJob);
        }
      });

      this.pruneQueueForPersistence();

      logger.info('Loaded jobs from queue file', { count: this.queue.length });
    } catch (err) {
      logger.warn('Failed to load queue from disk', { error: err.message });
      this.queue = [];
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
          downloadName,
          downloadNameMp4,
          bytesDownloaded,
          totalSegments,
          completedSegments,
          progress,
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
          downloadName,
          downloadNameMp4,
          bytesDownloaded,
          totalSegments,
          completedSegments,
          progress,
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
          skipThumbnailGeneration: job.skipThumbnailGeneration,
          subtitlePath: job.subtitlePath,
          subtitleZipPath: job.subtitleZipPath,
          subtitleMeta: job.subtitleMeta,
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
      bytesDownloaded: job.bytesDownloaded || 0,
      totalSegments: job.totalSegments || 0,
      completedSegments: job.completedSegments || 0,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      thumbnailUrls: this.buildThumbnailUrls(job),
      tmdbId: job.tmdbId,
      tmdbTitle: job.tmdbTitle,
      tmdbReleaseDate: job.tmdbReleaseDate,
    }));
  }

  buildThumbnailUrls(job) {
    const localThumbs = Array.isArray(job.thumbnailPaths)
      ? job.thumbnailPaths.filter(p => fs.existsSync(p)).map(p => `/downloads/${path.basename(p)}`)
      : (job.thumbnailPath && fs.existsSync(job.thumbnailPath)
          ? [`/downloads/${path.basename(job.thumbnailPath)}`]
          : []);

    const remoteThumbs = Array.isArray(job.thumbnailUrls)
      ? job.thumbnailUrls.filter(u => typeof u === 'string' && u.startsWith('http'))
      : [];

    return [...remoteThumbs, ...localThumbs];
  }

  // Process queue - start next job if we have capacity
  processQueue() {
    const activeCount = this.getActiveCount();

    // Check if we can start more jobs
    if (activeCount >= this.settings.maxConcurrent) {
      return;
    }

    // Find next queued job
    const nextJob = this.queue.find(job => job.queueStatus === 'queued');
    if (!nextJob) {
      return;
    }

    // Start the job
    this.startJob(nextJob.id);
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

    job.title = newTitle;
    job.downloadName = newTitle;
    
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
      this.activeJobs.delete(jobId);
    }

    // Delete files if requested
    if (deleteFiles) {
      try {
        if (job.filePath && fs.existsSync(job.filePath)) {
          fs.unlinkSync(job.filePath);
        }
        if (job.mp4Path && fs.existsSync(job.mp4Path)) {
          fs.unlinkSync(job.mp4Path);
        }
        // Delete thumbnails
        if (Array.isArray(job.thumbnailPaths)) {
          job.thumbnailPaths.forEach(p => {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          });
        }
        // Delete subtitle files
        if (job.subtitlePath && fs.existsSync(job.subtitlePath)) {
          fs.unlinkSync(job.subtitlePath);
        }
        if (job.subtitleZipPath && fs.existsSync(job.subtitleZipPath)) {
          fs.unlinkSync(job.subtitleZipPath);
        }
      } catch (err) {
        console.warn(`Failed to delete files for job ${jobId}:`, err.message);
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
