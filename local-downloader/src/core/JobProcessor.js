const fs = require('fs');
const path = require('path');
const { getClient, fetchText, parseM3U8 } = require('./PlaylistUtils');
const { getRetryBackoffMs, downloadSegment } = require('./SegmentDownloader');
const { remuxAndGenerateThumbnails } = require('./VideoConverter');
const logger = require('../utils/logger');

function createJobProcessor({
  downloadDir,
  FFMPEG_PATH,
  FFPROBE_PATH,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_SEGMENT_ATTEMPTS,
  fsPromises,
  getJobTempDirForUrl,
}) {
  const MAX_TS_PART_BYTES = 512 * 1024 * 1024; // ~512 MiB per TS part

  async function concatenateSegmentsStreaming(job, segments, jobTempDir, maxPartBytes) {
    const tsParts = [];
    let partIndex = 0;
    let currentStream = null;
    let currentPartBytes = 0;
    let totalBytesWritten = 0;

    function openNextPartStream() {
      const basePath = job.filePath.replace(/\.ts$/i, '');
      const partPath = partIndex === 0
        ? `${basePath}.ts`
        : `${basePath}-part${partIndex}.ts`;
      partIndex += 1;
      currentPartBytes = 0;
      currentStream = fs.createWriteStream(partPath);
      currentStream.on('error', (err) => {
        console.error('TS part file stream error during concat', {
          jobId: job.id,
          partPath,
          partIndex: partIndex - 1,
          currentPartBytes,
          totalBytesWritten,
          message: err && err.message,
          code: err && err.code,
          info: err && err.info,
        });
      });
      tsParts.push(partPath);
    }

    try {
      for (let i = 0; i < segments.length; i++) {
        const tempSegmentPath = path.join(jobTempDir, `seg-${i}.ts`);
        try {
          await fsPromises.access(tempSegmentPath);
        } catch {
          continue;
        }

        let stats;
        try {
          stats = await fsPromises.stat(tempSegmentPath);
        } catch (err) {
          console.warn('Failed to stat temp segment during concat', {
            jobId: job.id,
            tempSegmentPath,
            message: err && err.message,
          });
          continue;
        }

        if (!currentStream || (currentPartBytes + stats.size) > maxPartBytes) {
          if (currentStream) {
            await new Promise((resolve) => {
              currentStream.once('finish', resolve);
              currentStream.end();
            });
          }
          openNextPartStream();
        }

        await new Promise((resolve, reject) => {
          const readStream = fs.createReadStream(tempSegmentPath);
          readStream.on('error', (err) => {
            console.error('TS segment read error during concat', {
              jobId: job.id,
              tempSegmentPath,
              message: err && err.message,
            });
            reject(err);
          });
          readStream.on('end', resolve);
          readStream.pipe(currentStream, { end: false });
        });

        currentPartBytes += stats.size;
        totalBytesWritten += stats.size;

        try {
          await fsPromises.unlink(tempSegmentPath);
        } catch (_) {
        }
      }

      if (!currentStream) {
        return tsParts;
      }

      await new Promise((resolve, reject) => {
        currentStream.once('finish', resolve);
        currentStream.once('error', (err) => {
          console.error('TS part file stream error on finish', {
            jobId: job.id,
            partIndex: partIndex - 1,
            currentPartBytes,
            totalBytesWritten,
            message: err && err.message,
            code: err && err.code,
            info: err && err.info,
          });
          reject(err);
        });
        currentStream.end();
      });
    } catch (err) {
      if (currentStream) {
        currentStream.destroy();
      }
      throw err;
    }

    return tsParts;
  }

  // Direct file download helper (for non-HLS resources like MP4)
  async function runDirectJob(job) {
    try {
      logger.info('Direct job started', { jobId: job && job.id, url: job && job.url });
      job.status = 'downloading';
      job.updatedAt = Date.now();

      const headers = job.headers || {};
      const client = getClient(job.url);

      await new Promise((resolve, reject) => {
        const req = client.get(job.url, { headers }, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Request failed with status ${res.statusCode}`));
            res.resume();
            return;
          }

          const totalBytesHeader = res.headers['content-length'];
          const totalBytes = totalBytesHeader ? parseInt(totalBytesHeader, 10) : null;
          if (Number.isFinite(totalBytes) && totalBytes > 0) {
            job.totalBytes = totalBytes;
          }

          const outStream = fs.createWriteStream(job.filePath);
          outStream.on('error', (err) => {
            console.error('Direct job file stream error', {
              jobId: job.id,
              message: err && err.message,
            });
            reject(err);
          });

          res.on('data', (chunk) => {
            if (job.cancelled) {
              req.destroy(new Error('Job cancelled'));
              return;
            }
            job.bytesDownloaded += chunk.length;
            if (job.totalBytes) {
              job.progress = Math.max(0, Math.min(100, Math.round((job.bytesDownloaded / job.totalBytes) * 100)));
            }
            job.updatedAt = Date.now();
          });

          res.on('end', () => {
            outStream.end();
            resolve();
          });

          res.on('error', (err) => {
            reject(err);
          });

          res.pipe(outStream);
        });

        req.on('error', reject);

        // Hard timeout to avoid hanging on bad connections
        const timeoutMs = 30_000;
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Direct download timeout after ${timeoutMs} ms`));
        });
      });

      if (job.cancelled) {
        job.status = 'cancelled';
      } else {
        job.status = 'completed';
        job.progress = 100;
        // For direct MP4 downloads, the primary asset is already an MP4 file.
        // Point mp4Path at filePath so the existing /api/jobs/:id/file route works.
        job.mp4Path = job.filePath;
      }
      job.updatedAt = Date.now();
      logger.info('Direct job finished', { jobId: job && job.id, status: job.status });
    } catch (err) {
      logger.error('Direct job failed', { jobId: job && job.id, error: err && err.message });
      if (job) {
        job.status = 'error';
        job.error = (err && err.message) || 'Direct download failure';
        job.updatedAt = Date.now();
      }
    }
  }

  async function runJob(job) {
    try {
      logger.info('HLS job started', { jobId: job && job.id, url: job && job.url });
      job.status = 'fetching-playlist';
      job.updatedAt = Date.now();

      const headers = job.headers || {};
      const playlistText = await fetchText(job.url, headers);
      const segments = parseM3U8(playlistText, job.url);
      job.totalSegments = segments.length;
      job.status = 'downloading';
      job.failedSegments = [];
      job.threadStates = [];
      job.segmentStates = {};
      job.updatedAt = Date.now();

      // Initialize all segments as pending
      for (let i = 0; i < segments.length; i++) {
        job.segmentStates[i] = { status: 'pending', attempt: 0 };
      }

      const maxConcurrent = job.maxConcurrent && job.maxConcurrent > 0
        ? Math.min(16, job.maxConcurrent)
        : DEFAULT_MAX_CONCURRENT;

      // Create or reuse temp directory for this playlist's segment files, based on URL
      const jobTempDir = getJobTempDirForUrl(job.url);
      await fsPromises.mkdir(jobTempDir, { recursive: true });

      // Check for existing segments from previous download attempts
      const existingSegments = new Set();
      try {
        const existingFiles = await fsPromises.readdir(jobTempDir);
        await Promise.all(
          existingFiles.map(async (file) => {
            const match = file.match(/^seg-(\d+)\.ts$/);
            if (!match) return;
            const segIndex = parseInt(match[1], 10);
            const filePathSeg = path.join(jobTempDir, file);
            try {
              const stats = await fsPromises.stat(filePathSeg);
              // Only consider files with non-zero size as valid
              if (stats.size > 0) {
                existingSegments.add(segIndex);
              }
            } catch (err) {
              console.warn('Error stat-ing existing segment file', {
                jobId: job.id,
                filePath: filePathSeg,
                message: err && err.message,
              });
            }
          })
        );
        if (existingSegments.size > 0) {
          console.log(`Found ${existingSegments.size} existing segments for job ${job.id}, resuming...`);
        }
      } catch (err) {
        console.warn('Error checking for existing segments:', err.message);
      }

      // Track how many times each segment has been attempted in total.
      const attempts = new Array(segments.length).fill(0);

      // Track when a segment is next eligible to be retried (for backoff).
      const nextAttemptAt = new Array(segments.length).fill(0);

      // Pre-compute maximum attempts allowed per segment (including racing).
      const maxAttemptsPerSegment =
        job.maxSegmentAttempts === Infinity
          ? Infinity
          : (Number.isFinite(job.maxSegmentAttempts)
              ? job.maxSegmentAttempts
              : DEFAULT_MAX_SEGMENT_ATTEMPTS);

      // Index for new segments; failed segments are managed in a separate queue.
      let nextIndex = 0;
      const failedQueue = [];

      async function worker(workerId) {
        while (!job.cancelled) {
          let i = null;

          // First exhaust all primary segments, then consume retries.
          if (nextIndex < segments.length) {
            i = nextIndex;
            nextIndex += 1;
          } else if (failedQueue.length > 0) {
            // Find the first failed segment whose backoff has elapsed and is still
            // eligible for another attempt. This lets any idle worker pick up
            // retries without blocking on a per-segment sleep.
            const now = Date.now();
            let chosenIndexInQueue = -1;

            for (let q = 0; q < failedQueue.length; q++) {
              const candidate = failedQueue[q];
              const state = job.segmentStates[candidate];

              // Skip segments that have since been marked completed/failed.
              if (!state || state.status === 'completed' || state.status === 'failed') {
                continue;
              }

              // Respect per-segment backoff window.
              if (now < (nextAttemptAt[candidate] || 0)) {
                continue;
              }

              chosenIndexInQueue = q;
              break;
            }

            if (chosenIndexInQueue !== -1) {
              i = failedQueue.splice(chosenIndexInQueue, 1)[0];
            } else {
              // No retryable retry work available right now; fall through to
              // potential race attempts on already-downloading segments below.
              i = null;
            }
          }

          // If we didn't pick a primary or queued retry segment, allow this
          // idle worker to "race" on segments that are already downloading or
          // retrying, as long as they still have remaining attempts.
          if (i == null) {
            const candidates = [];
            for (let idx = 0; idx < segments.length; idx++) {
              const state = job.segmentStates[idx];
              if (!state) continue;
              if (state.status === 'downloading' || state.status === 'retrying') {
                if (attempts[idx] < maxAttemptsPerSegment) {
                  candidates.push(idx);
                }
              }
            }

            if (candidates.length === 0) {
              // Nothing left to do for this worker.
              break;
            }

            // Simple strategy: focus on the "hardest" segments by preferring
            // those with the highest current attempt count.
            candidates.sort((a, b) => attempts[b] - attempts[a]);
            i = candidates[0];
          }

          const segmentUrl = segments[i];
          let success = false;
          const canonicalSegmentPath = path.join(jobTempDir, `seg-${i}.ts`);

          // Check if segment already exists from previous download
          if (existingSegments.has(i)) {
            success = true;
            job.completedSegments += 1;
            
            // Mark segment as completed immediately
            job.segmentStates[i] = {
              status: 'completed',
              attempt: 1,
              completedAt: Date.now(),
              resumed: true,
            };
            
            // Update progress
            const actuallyCompleted = Object.values(job.segmentStates).filter(
              s => s && s.status === 'completed'
            ).length;
            job.progress = job.totalSegments
              ? Math.round((actuallyCompleted / job.totalSegments) * 100)
              : 0;
            job.updatedAt = Date.now();
            
            continue; // Skip to next segment
          }

          // Check if another racing thread already completed this segment
          const currentState = job.segmentStates[i];
          if (currentState && currentState.status === 'completed') {
            // Mark this thread as idle since the segment is already done
            job.threadStates[workerId] = {
              workerId,
              segmentIndex: null,
              url: null,
              status: 'idle',
            };
            continue;
          }

          attempts[i] += 1;
          const attempt = attempts[i];

          // Update segment state to downloading
          job.segmentStates[i] = {
            status: 'downloading',
            attempt,
            startedAt: Date.now(),
          };

          job.threadStates[workerId] = {
            workerId,
            segmentIndex: i,
            url: segmentUrl,
            status: attempt > 1 ? 'retrying' : 'downloading',
            attempt,
            startedAt: Date.now(),
          };

          try {
            // Download this attempt into its own temporary file in the
            // job-specific folder. The first successful attempt will be promoted
            // to the canonical segment file; later successes will be discarded.
            const attemptTempPath = path.join(
              jobTempDir,
              `seg-${i}-w${workerId}-a${attempt}-${Date.now()}.tmp`
            );
            const segmentStream = fs.createWriteStream(attemptTempPath);
            segmentStream.on('error', (err) => {
              console.error('Segment file stream error during download', {
                jobId: job.id,
                workerId,
                segmentIndex: i,
                attempt,
                attemptTempPath,
                message: err && err.message,
                code: err && err.code,
                info: err && err.info,
              });
            });
            await downloadSegment(segmentUrl, headers, segmentStream, job);
            segmentStream.end();

            // Check again if another thread completed this segment while we were downloading
            const stateAfterDownload = job.segmentStates[i];
            if (stateAfterDownload && stateAfterDownload.status === 'completed') {
              // Another thread won the race; discard our temp file and move on
              try {
                fs.unlinkSync(attemptTempPath);
              } catch (_) {
                // ignore cleanup errors
              }
              // Mark this thread as idle since another thread completed the segment
              job.threadStates[workerId] = {
                workerId,
                segmentIndex: null,
                url: null,
                status: 'idle',
              };
              continue;
            }

            success = true;

            // Promote this attempt to the canonical segment file *only if*
            // no other racing attempt has already completed this segment.
            const currentStateAfter = job.segmentStates[i];
            if (!currentStateAfter || currentStateAfter.status !== 'completed') {
              try {
                fs.renameSync(attemptTempPath, canonicalSegmentPath);
              } catch (renameErr) {
                console.warn('Failed to promote temp segment file', {
                  jobId: job.id,
                  segmentIndex: i,
                  message: renameErr.message,
                });
              }

              job.segmentStates[i] = {
                status: 'completed',
                attempt,
                completedAt: Date.now(),
              };
            } else {
              // Another attempt already won the race; discard our temp file.
              try {
                fs.unlinkSync(attemptTempPath);
              } catch (_) {
                // ignore cleanup errors
              }
            }
          } catch (err) {
            console.warn(attempt > 1 ? 'Retry segment failed' : 'Segment download failed', {
              jobId: job.id,
              segmentIndex: i,
              attempt,
              message: err.message,
            });

            // Check if another thread completed this segment while we were downloading
            const stateAfterError = job.segmentStates[i];
            if (stateAfterError && stateAfterError.status === 'completed') {
              // Another thread won the race; don't update state to retrying/failed
              // Mark this thread as idle since another thread completed the segment
              job.threadStates[workerId] = {
                workerId,
                segmentIndex: null,
                url: null,
                status: 'idle',
              };
              continue;
            }

            if (attempt < maxAttemptsPerSegment) {
              // Queue for another retry with a backoff timestamp.
              job.segmentStates[i] = {
                status: 'retrying',
                attempt,
                error: err.message,
              };
              const delayMs = getRetryBackoffMs(attempt);
              nextAttemptAt[i] = Date.now() + delayMs;
              failedQueue.push(i);
            } else {
              // Mark segment as failed after all attempts exhausted
              job.segmentStates[i] = {
                status: 'failed',
                attempt,
                error: err.message,
              };
              job.failedSegments.push({ index: i, url: segmentUrl, error: err.message });
            }
          }

          if (success) {
            const state = job.segmentStates[i];
            if (state && state.status === 'completed') {
              const completedCount = Object.values(job.segmentStates).filter(
                (s) => s && s.status === 'completed'
              ).length;
              job.completedSegments = completedCount;
            }
          }
          
          const segmentStateValues = Object.values(job.segmentStates);
          const actuallyCompleted = segmentStateValues.filter(
            (s) => s && s.status === 'completed'
          ).length;
          const hasInFlight = segmentStateValues.some(
            (s) => s && s.status !== 'completed' && s.status !== 'failed'
          );
          let computedProgress = job.totalSegments
            ? Math.round((actuallyCompleted / job.totalSegments) * 100)
            : 0;
          if (hasInFlight && computedProgress >= 100) {
            computedProgress = 99;
          }
          job.progress = computedProgress;
          job.updatedAt = Date.now();

          job.threadStates[workerId] = {
            workerId,
            segmentIndex: null,
            url: null,
            status: 'idle',
          };
        }
      }

      const workers = [];
      const workerCount = Math.min(maxConcurrent, segments.length || 1);
      logger.info('Starting segment workers', { jobId: job.id, requestedThreads: job.maxConcurrent, maxConcurrent, workerCount, segmentCount: segments.length });
      for (let i = 0; i < workerCount; i++) {
        job.threadStates[i] = { workerId: i, segmentIndex: null, url: null, status: 'idle' };
        workers.push(worker(i));
      }
      await Promise.all(workers);

      const tsParts = await concatenateSegmentsStreaming(job, segments, jobTempDir, MAX_TS_PART_BYTES);
      job.tsParts = tsParts;
      const filePathFinal = tsParts && tsParts.length > 0 ? tsParts[0] : job.filePath;

      try {
        const remainingFiles = await fsPromises.readdir(jobTempDir);
        
        // Delete any leftover temp files (failed attempts, etc.)
        for (const file of remainingFiles) {
          try {
            await fsPromises.unlink(path.join(jobTempDir, file));
          } catch (unlinkErr) {
            logger.warn('Failed to delete temp file during cleanup', {
              jobId: job.id,
              file,
              error: unlinkErr && unlinkErr.message,
            });
          }
        }
        
        // Now delete the empty temp directory
        await fsPromises.rmdir(jobTempDir);
        logger.info('Cleaned up temp segment directory', {
          jobId: job.id,
          tempDir: jobTempDir,
          filesDeleted: remainingFiles.length,
        });
      } catch (err) {
        logger.warn('Failed to cleanup temp directory', {
          jobId: job.id,
          tempDir: jobTempDir,
          error: err && err.message,
        });
      }

      await remuxAndGenerateThumbnails(job, filePathFinal, {
        downloadDir,
        FFMPEG_PATH,
        FFPROBE_PATH,
        skipThumbnailGeneration: job.skipThumbnailGeneration !== false,
      });

      if (job.cancelled) {
        job.status = 'cancelled';
      } else if (job.failedSegments.length > 0 && job.completedSegments === 0) {
        job.status = 'error';
        job.error = 'All segments failed to download.';
      } else if (job.failedSegments.length > 0) {
        job.status = 'completed-with-errors';
      } else {
        job.status = 'completed';
      }
      if (job.status === 'completed' || job.status === 'completed-with-errors' || job.status === 'error') {
        if (job.totalSegments && job.completedSegments > 0) {
          job.progress = 100;
        }
      }
      job.updatedAt = Date.now();
      logger.info('HLS job finished', { jobId: job && job.id, status: job.status });
    } catch (err) {
      logger.error('HLS job failed', { jobId: job && job.id, error: err && err.message });
      if (job) {
        job.status = 'error';
        job.error = (err && err.message) || 'Unknown job failure';
        job.updatedAt = Date.now();
      }
    }
  }

  return { runJob, runDirectJob };
}

module.exports = { createJobProcessor };
