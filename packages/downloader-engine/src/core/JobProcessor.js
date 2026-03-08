const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { fetchText, parseM3U8, requestWithRedirects } = require('./PlaylistUtils');
const { getRetryBackoffMs, downloadSegment } = require('./SegmentDownloader');
const { buildNativeHlsArgs, inspectHlsPlaylist, shouldPreferNativeHlsDownload } = require('./HlsNativeDownload');
const { generateThumbnailFromMp4, remuxAndGenerateThumbnails } = require('./VideoConverter');
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
  const DIRECT_MAX_ATTEMPTS = 4;
  const YT_DLP_PATH = String(process.env.YTDLP_PATH || process.env.YT_DLP_PATH || 'yt-dlp').trim() || 'yt-dlp';
  let ytDlpAvailable = null;
  const isExplicitYtDlpPath = /[\\/]/.test(YT_DLP_PATH);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function summarizeSegmentIndexes(indexes, limit = 8) {
    if (!Array.isArray(indexes) || indexes.length === 0) {
      return '';
    }
    const normalized = indexes
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value >= 0)
      .sort((a, b) => a - b);

    if (normalized.length === 0) {
      return '';
    }

    const sample = normalized.slice(0, limit).join(', ');
    if (normalized.length <= limit) {
      return sample;
    }
    return `${sample} ...`;
  }

  function buildIncompleteHlsError(totalSegments, indexes, reason = 'missing or failed') {
    const count = Array.isArray(indexes) ? indexes.length : 0;
    const sample = summarizeSegmentIndexes(indexes);
    const sampleSuffix = sample ? ` Segment indexes: ${sample}.` : '';
    return `Incomplete HLS download: ${count} of ${totalSegments} segment(s) are ${reason}.${sampleSuffix}`;
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

  function hasYtDlp() {
    if (typeof ytDlpAvailable === 'boolean') {
      return ytDlpAvailable;
    }

    try {
      const probe = spawnSync(YT_DLP_PATH, ['--version'], {
        stdio: 'ignore',
        timeout: 5000,
      });
      if (probe.status === 0) {
        ytDlpAvailable = true;
      } else if (probe.error && probe.error.code === 'ETIMEDOUT' && isExplicitYtDlpPath && fs.existsSync(YT_DLP_PATH)) {
        // Keep parity with API startup detection: trust explicit/bundled binary path on probe timeout.
        ytDlpAvailable = true;
        logger.info('yt-dlp probe timed out; using configured path', { ytDlpPath: YT_DLP_PATH });
      } else {
        ytDlpAvailable = false;
      }
    } catch {
      ytDlpAvailable = isExplicitYtDlpPath && fs.existsSync(YT_DLP_PATH);
    }

    if (!ytDlpAvailable) {
      logger.warn('yt-dlp not detected; YouTube URLs cannot be downloaded', {
        ytDlpPath: YT_DLP_PATH,
      });
    }

    return ytDlpAvailable;
  }

  async function findLatestJobAsset(storageDir, jobId) {
    if (!storageDir || !jobId) return '';
    try {
      const entries = await fsPromises.readdir(storageDir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry && entry.isFile && entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => name.startsWith(`${jobId}-`) && !name.endsWith('.part'));
      if (files.length === 0) return '';

      const withStats = await Promise.all(
        files.map(async (name) => {
          const fullPath = path.join(storageDir, name);
          const stats = await fsPromises.stat(fullPath);
          return {
            fullPath,
            mtimeMs: Number(stats && stats.mtimeMs || 0),
            size: Number(stats && stats.size || 0),
          };
        })
      );

      withStats.sort((a, b) => {
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return b.size - a.size;
      });
      return withStats[0] ? withStats[0].fullPath : '';
    } catch {
      return '';
    }
  }

  async function resolveAccessibleOutputPath(candidatePath, storageDir, jobId) {
    const raw = String(candidatePath || '').trim();
    if (raw) {
      const fullPath = path.isAbsolute(raw) ? raw : path.resolve(storageDir, raw);
      try {
        await fsPromises.access(fullPath);
        return fullPath;
      } catch {
        // Fall back to scanning known outputs if reported path is stale/missing.
      }
    }

    const latest = await findLatestJobAsset(storageDir, jobId);
    if (!latest) return '';
    try {
      await fsPromises.access(latest);
      return latest;
    } catch {
      return '';
    }
  }

  async function runYouTubeDirectJob(job) {
    if (!job || !job.url) {
      throw new Error('Missing job URL for yt-dlp download');
    }
    if (!hasYtDlp()) {
      throw new Error('yt-dlp is not installed. Install yt-dlp, restart the desktop app, and retry.');
    }

    if (!job.storageDir && job.filePath) {
      job.storageDir = path.dirname(job.filePath);
    }
    const storageDir = job.storageDir || (job.filePath ? path.dirname(job.filePath) : downloadDir);
    await fsPromises.mkdir(storageDir, { recursive: true });
    job.storageDir = storageDir;

    const outputTemplate = path.join(storageDir, `${job.id}-%(title).120B.%(ext)s`);
    let ffmpegLocation = '';
    if (typeof FFMPEG_PATH === 'string' && FFMPEG_PATH.trim()) {
      const normalizedFfmpegPath = FFMPEG_PATH.trim();
      try {
        if (fs.existsSync(normalizedFfmpegPath)) {
          const stats = fs.statSync(normalizedFfmpegPath);
          ffmpegLocation = stats.isDirectory()
            ? normalizedFfmpegPath
            : path.dirname(normalizedFfmpegPath);
        }
      } catch {
        ffmpegLocation = '';
      }
    }

    const args = [
      '--ignore-config',
      '--no-playlist',
      '--no-part',
      '--no-keep-video',
      '--progress',
      '--no-quiet',
      '--newline',
      '--no-mtime',
      '--restrict-filenames',
      '--merge-output-format',
      'mp4',
      '--remux-video',
      'mp4',
      '-f',
      // Prefer MP4-compatible streams first to avoid split mp4(video)+webm(audio) outputs.
      'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '--progress-template',
      'download:bytes=%(progress.downloaded_bytes)s,total=%(progress.total_bytes)s,total_estimate=%(progress.total_bytes_estimate)s,speed=%(progress.speed)s,eta=%(progress.eta)s',
      '--print',
      'after_move:filepath=%(filepath)s',
      '-o',
      outputTemplate,
      job.url,
    ];

    if (ffmpegLocation) {
      args.push('--ffmpeg-location', ffmpegLocation);
    }

    const rawHeaders = job.headers && typeof job.headers === 'object' ? job.headers : {};
    for (const [rawKey, rawValue] of Object.entries(rawHeaders)) {
      const key = String(rawKey || '').trim();
      const value = String(rawValue || '').trim();
      if (!key || !value) continue;
      if (key.includes('\n') || value.includes('\n')) continue;
      args.push('--add-header', `${key}: ${value}`);
    }

    let resolvedPath = '';
    let lastErrorLine = '';
    let totalDownloadPhases = 1;
    let currentDownloadPhaseIndex = 0;
    let currentPhaseProgress = 0;
    let destinationLineCount = 0;
    const ytDebugEnabled = String(process.env.DEBUG_YTDLP_PROGRESS || '').trim() === '1';
    let ytDebugLineCount = 0;
    logger.info('yt-dlp debug mode', {
      jobId: job && job.id,
      enabled: ytDebugEnabled,
      envValue: String(process.env.DEBUG_YTDLP_PROGRESS || ''),
    });
    const parseMetricNumber = (raw) => {
      const text = String(raw || '').trim();
      if (!text || text.toLowerCase() === 'na' || text.toLowerCase() === 'none') return 0;
      const normalized = text.replace(/,/g, '');
      const value = Number(normalized);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };
    const parseByteMetric = (raw) => {
      const text = String(raw || '').trim();
      if (!text) return 0;

      const numeric = parseMetricNumber(text);
      if (numeric > 0) return numeric;

      const normalized = text
        .replace(/\/s$/i, '')
        .replace(/\s+/g, '')
        .trim();
      const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)([kmgtp]?i?b)$/i);
      if (!match) return 0;

      const value = Number(match[1]);
      if (!Number.isFinite(value) || value < 0) return 0;
      const unit = String(match[2] || 'b').toLowerCase();
      const multiplier = {
        b: 1,
        kb: 1_000,
        mb: 1_000_000,
        gb: 1_000_000_000,
        tb: 1_000_000_000_000,
        pb: 1_000_000_000_000_000,
        kib: 1_024,
        mib: 1_048_576,
        gib: 1_073_741_824,
        tib: 1_099_511_627_776,
        pib: 1_125_899_906_842_624,
      }[unit] || 0;
      if (!multiplier) return 0;
      return Math.max(0, Math.floor(value * multiplier));
    };
    const parseEtaSeconds = (raw) => {
      const text = String(raw || '').trim();
      if (!text || /^na$/i.test(text) || /^none$/i.test(text)) return 0;

      const numeric = parseMetricNumber(text);
      if (numeric > 0) return Math.floor(numeric);

      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) {
        const parts = text.split(':').map((part) => Number.parseInt(part, 10));
        if (parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
        if (parts.length === 2) return (parts[0] * 60) + parts[1];
        if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
      }
      return 0;
    };

    await new Promise((resolve, reject) => {
      const child = spawn(YT_DLP_PATH, args, {
        cwd: storageDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (ytDebugEnabled) {
        logger.info('yt-dlp spawned', {
          jobId: job && job.id,
          pid: child && child.pid,
          hasStdout: Boolean(child && child.stdout),
          hasStderr: Boolean(child && child.stderr),
        });
      }

      const cancelPoll = setInterval(() => {
        if (!job.cancelled) return;
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      }, 250);

      const finalize = (cb) => {
        clearInterval(cancelPoll);
        cb();
      };

      const handleYtDlpLine = (line, fromStderr = false) => {
        const text = String(line || '').trim();
        if (!text) return;

        if (/^\[info\].*Downloading\s+\d+\s+format\(s\):/i.test(text)) {
          const formatMatch = text.match(/format\(s\):\s*(.+)$/i);
          const rawFormats = formatMatch ? String(formatMatch[1] || '').trim() : '';
          const formatCount = rawFormats
            ? rawFormats.split(',').reduce((count, group) => {
              const parts = String(group || '')
                .split('+')
                .map((part) => String(part || '').trim())
                .filter(Boolean);
              return count + (parts.length || 0);
            }, 0)
            : 0;
          if (formatCount > 0) {
            totalDownloadPhases = Math.max(1, Math.min(6, formatCount));
            currentDownloadPhaseIndex = 0;
            currentPhaseProgress = 0;
            destinationLineCount = 0;
          }
        }

        if (/^\[download\]\s+Destination:/i.test(text)) {
          destinationLineCount += 1;
          currentDownloadPhaseIndex = Math.min(
            Math.max(0, destinationLineCount - 1),
            Math.max(0, totalDownloadPhases - 1),
          );
          currentPhaseProgress = 0;
        }

        if (text.startsWith('filepath=')) {
          resolvedPath = text.slice('filepath='.length).trim();
          return;
        }

        const applyProgress = (phasePercent = 0) => {
          const boundedPhasePercent = Math.max(0, Math.min(100, Math.round(phasePercent)));
          if (boundedPhasePercent > currentPhaseProgress) {
            currentPhaseProgress = boundedPhasePercent;
          }

          let nextProgress = 0;
          if (totalDownloadPhases > 1) {
            const completedPhases = Math.max(0, Math.min(currentDownloadPhaseIndex, totalDownloadPhases));
            const combinedPercent = ((completedPhases + (currentPhaseProgress / 100)) / totalDownloadPhases) * 100;
            nextProgress = Math.max(0, Math.min(99, Math.round(combinedPercent)));
          } else {
            nextProgress = Math.max(0, Math.min(99, currentPhaseProgress));
          }

          // Keep in-flight progress monotonic; final 100 is set only after yt-dlp exits.
          job.progress = Math.max(Number(job.progress || 0), nextProgress);
        };

        let progressUpdated = false;
        const customProgressMatch = text.match(
          /(?:download:)?bytes=([^,]+),total=([^,]+),total_estimate=([^,]+),speed=([^,]+),eta=([^,]+)$/i
        );
        if (customProgressMatch) {
          const downloadedBytes = parseByteMetric(customProgressMatch[1]);
          const totalBytes = parseByteMetric(customProgressMatch[2]);
          const estimatedTotalBytes = parseByteMetric(customProgressMatch[3]);
          const speedBps = parseByteMetric(customProgressMatch[4]);
          const etaSeconds = parseEtaSeconds(customProgressMatch[5]);
          const resolvedTotalBytes = totalBytes > 0 ? totalBytes : estimatedTotalBytes;
          const computedPercent = resolvedTotalBytes > 0
            ? (downloadedBytes / resolvedTotalBytes) * 100
            : 0;

          if (downloadedBytes > 0) {
            job.bytesDownloaded = downloadedBytes;
          }
          if (resolvedTotalBytes > 0) {
            job.totalBytes = resolvedTotalBytes;
          }
          if (speedBps > 0) {
            job.speedBps = speedBps;
          }
          if (etaSeconds > 0) {
            job.etaSeconds = etaSeconds;
          }
          applyProgress(computedPercent);
          progressUpdated = true;
        }

        if (!progressUpdated && /^\[download\]/i.test(text)) {
          const percentMatch = text.match(/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/i);
          const totalMatch = text.match(/\bof\s+~?\s*([0-9.]+\s*[kmgtp]?i?b)\b/i);
          const speedMatch = text.match(/\bat\s+([0-9.]+\s*[kmgtp]?i?b\/s)\b/i);
          const etaMatch = text.match(/\bETA\s+([0-9:]+)\b/i);
          const downloadedOnlyMatch = text.match(/\[download\]\s+([0-9.]+\s*[kmgtp]?i?b)(?:\s+at|\s+ETA|\s*$)/i);

          const percent = percentMatch ? parseMetricNumber(percentMatch[1]) : 0;
          const totalBytes = totalMatch ? parseByteMetric(totalMatch[1]) : 0;
          const speedBps = speedMatch ? parseByteMetric(speedMatch[1]) : 0;
          const etaSeconds = etaMatch ? parseEtaSeconds(etaMatch[1]) : 0;
          const downloadedBytes = downloadedOnlyMatch ? parseByteMetric(downloadedOnlyMatch[1]) : 0;
          let computedPercent = percent;

          if (downloadedBytes > 0) {
            job.bytesDownloaded = downloadedBytes;
            progressUpdated = true;
          }
          if (totalBytes > 0) {
            job.totalBytes = totalBytes;
            if (job.bytesDownloaded > 0) {
              computedPercent = (job.bytesDownloaded / totalBytes) * 100;
            }
            progressUpdated = true;
          }
          if (percent > 0 || (Number.isFinite(computedPercent) && computedPercent > 0)) {
            applyProgress(computedPercent);
            if (job.totalBytes > 0 && job.progress > 0 && job.bytesDownloaded <= 0) {
              job.bytesDownloaded = Math.round((job.totalBytes * job.progress) / 100);
            }
            progressUpdated = true;
          }
          if (speedBps > 0) {
            job.speedBps = speedBps;
            progressUpdated = true;
          }
          if (etaSeconds > 0) {
            job.etaSeconds = etaSeconds;
            progressUpdated = true;
          }
        }

        if (progressUpdated) {
          if (ytDebugEnabled && ytDebugLineCount < 40) {
            ytDebugLineCount += 1;
            logger.info('yt-dlp progress parsed', {
              jobId: job && job.id,
              progress: Number(job.progress || 0),
              bytesDownloaded: Number(job.bytesDownloaded || 0),
              totalBytes: Number(job.totalBytes || 0),
              speedBps: Number(job.speedBps || 0),
              etaSeconds: Number(job.etaSeconds || 0),
            });
          }
          job.updatedAt = Date.now();
          return;
        }

        if (fromStderr && /error/i.test(text)) {
          lastErrorLine = text;
        }

        if (ytDebugEnabled && ytDebugLineCount < 40) {
          ytDebugLineCount += 1;
          logger.info('yt-dlp raw line', {
            jobId: job && job.id,
            from: fromStderr ? 'stderr' : 'stdout',
            line: text.slice(0, 240),
          });
        }
      };
      const bindStreamLines = (stream, fromStderr = false) => {
        if (!stream) return () => {};
        let pending = '';
        const onData = (chunk) => {
          const text = `${pending}${String(chunk || '')}`;
          const parts = text.split(/\r?\n|\r/g);
          pending = parts.pop() || '';
          for (const part of parts) {
            handleYtDlpLine(part, fromStderr);
          }
        };
        stream.on('data', onData);
        return () => {
          if (pending) {
            handleYtDlpLine(pending, fromStderr);
            pending = '';
          }
          stream.off('data', onData);
        };
      };

      const flushStdout = bindStreamLines(child.stdout, false);
      const flushStderr = bindStreamLines(child.stderr, true);

      child.on('error', (err) => finalize(() => reject(err)));
      child.on('close', (code) => finalize(() => {
        flushStdout();
        flushStderr();

        if (job.cancelled) {
          resolve();
          return;
        }

        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(lastErrorLine || `yt-dlp exited with code ${code}`));
      }));
    });

    if (job.cancelled) {
      if (job.cleanupOnCancel) {
        await cleanupCancelledDirectArtifacts(job);
      }
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      return;
    }

    if (!resolvedPath) {
      resolvedPath = await findLatestJobAsset(storageDir, job.id);
    }

    const finalPath = await resolveAccessibleOutputPath(resolvedPath, storageDir, job.id);
    if (!finalPath) {
      throw new Error('yt-dlp completed but no output file was reported');
    }

    const stats = await fsPromises.stat(finalPath);

    job.filePath = finalPath;
    job.mp4Path = finalPath;
    job.downloadName = path.basename(finalPath);
    job.downloadNameMp4 = path.basename(finalPath);
    job.bytesDownloaded = Number(stats && stats.size || 0);
    job.totalBytes = Number(stats && stats.size || 0);
    job.progress = 100;
    job.speedBps = 0;
    job.etaSeconds = 0;
    job.status = 'completed';
    job.updatedAt = Date.now();
  }

  async function unlinkIfExists(filePath, context = {}) {
    if (!filePath) return;
    try {
      await fsPromises.unlink(filePath);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      logger.warn('Failed to delete file during job cleanup', {
        filePath,
        error: err && err.message,
        ...context,
      });
    }
  }

  async function cleanupCancelledHlsArtifacts(job, jobTempDir, options = {}) {
    const preserveSegments = Boolean(options.preserveSegments);
    const context = { jobId: job && job.id, preserveSegments };
    const jobStorageDir = (() => {
      if (job && typeof job.storageDir === 'string' && job.storageDir.trim()) {
        return job.storageDir;
      }
      if (job && typeof job.filePath === 'string' && job.filePath.trim()) {
        return path.dirname(job.filePath);
      }
      return downloadDir;
    })();

    try {
      if (jobTempDir) {
        if (preserveSegments) {
          const files = await fsPromises.readdir(jobTempDir);
          await Promise.all(
            files
              .filter((fileName) => fileName.endsWith('.tmp'))
              .map((fileName) => unlinkIfExists(path.join(jobTempDir, fileName), context))
          );
        } else {
          await fsPromises.rm(jobTempDir, { recursive: true, force: true });
        }
      }
    } catch (err) {
      logger.warn('Failed to cleanup cancelled HLS temp directory', {
        ...context,
        tempDir: jobTempDir,
        error: err && err.message,
      });
    }

    if (preserveSegments || !job) {
      return;
    }

    const cleanupPaths = new Set();
    const addPath = (candidatePath) => {
      if (typeof candidatePath === 'string' && candidatePath.trim()) {
        cleanupPaths.add(candidatePath);
      }
    };

    addPath(job.filePath);
    addPath(job.mp4Path);
    addPath(job.filePath ? `${job.filePath}.part` : null);
    addPath(job.mp4Path ? `${job.mp4Path}.part` : null);
    addPath(job.subtitlePath);
    addPath(job.subtitleZipPath);
    addPath(job.thumbnailPath);
    addPath(job.id && jobStorageDir ? path.join(jobStorageDir, `ts-parts-${job.id}.txt`) : null);

    if (Array.isArray(job.tsParts)) {
      job.tsParts.forEach((candidate) => addPath(candidate));
    }

    await Promise.all(Array.from(cleanupPaths).map((candidatePath) => unlinkIfExists(candidatePath, context)));

    if (
      job
      && job.id
      && typeof jobStorageDir === 'string'
      && path.resolve(path.dirname(jobStorageDir)) === path.resolve(downloadDir)
      && path.basename(jobStorageDir) === String(job.id)
    ) {
      try {
        await fsPromises.rm(jobStorageDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn('Failed to remove job storage directory during cancellation cleanup', {
          ...context,
          jobStorageDir,
          error: err && err.message,
        });
      }
    }
  }

  async function cleanupCancelledDirectArtifacts(job) {
    if (!job) return;
    const context = { jobId: job && job.id, preserveSegments: false, mode: 'direct' };
    const cleanupPaths = new Set();
    const addPath = (candidatePath) => {
      if (typeof candidatePath === 'string' && candidatePath.trim()) {
        cleanupPaths.add(candidatePath);
      }
    };

    addPath(job.filePath);
    addPath(job.mp4Path);
    addPath(job.filePath ? `${job.filePath}.part` : null);
    addPath(job.mp4Path ? `${job.mp4Path}.part` : null);
    addPath(job.subtitlePath);
    addPath(job.subtitleZipPath);
    addPath(job.thumbnailPath);
    addPath(job.id && job.storageDir ? path.join(job.storageDir, `${job.id}-thumb.jpg`) : null);
    addPath(job.id && job.storageDir ? path.join(job.storageDir, `${job.id}-subtitles.srt`) : null);
    addPath(job.id && job.storageDir ? path.join(job.storageDir, `${job.id}-subtitles.zip`) : null);

    if (Array.isArray(job.thumbnailPaths)) {
      job.thumbnailPaths.forEach((candidatePath) => addPath(candidatePath));
    }

    await Promise.all(Array.from(cleanupPaths).map((candidatePath) => unlinkIfExists(candidatePath, context)));

    const jobStorageDir = (() => {
      if (typeof job.storageDir === 'string' && job.storageDir.trim()) {
        return job.storageDir;
      }
      if (typeof job.filePath === 'string' && job.filePath.trim()) {
        return path.dirname(job.filePath);
      }
      return '';
    })();

    if (
      jobStorageDir
      && job.id
      && path.resolve(path.dirname(jobStorageDir)) === path.resolve(downloadDir)
      && path.basename(jobStorageDir) === String(job.id)
    ) {
      try {
        await fsPromises.rm(jobStorageDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn('Failed to remove direct job storage directory during cancellation cleanup', {
          ...context,
          jobStorageDir,
          error: err && err.message,
        });
      }
    }
  }

  async function runNativeHlsJob(job, playlistUrl, playlistInfo) {
    if (!job || !playlistUrl) {
      throw new Error('Missing playlist URL for native HLS download');
    }
    if (!FFMPEG_PATH) {
      throw new Error('FFmpeg not available');
    }

    const outputDir = job.storageDir || (job.filePath ? path.dirname(job.filePath) : downloadDir);
    await fsPromises.mkdir(outputDir, { recursive: true });
    job.storageDir = outputDir;

    const mp4Path = path.join(outputDir, `${job.id}-${job.downloadNameMp4}`);
    const tempMp4Path = `${mp4Path}.part`;
    const estimatedDurationSeconds = Number(playlistInfo && playlistInfo.totalDurationSeconds) || 0;
    const nativeArgs = buildNativeHlsArgs({
      job,
      playlistUrl,
      outputPath: tempMp4Path,
      headers: job.headers || {},
    });

    job.status = 'downloading';
    job.updatedAt = Date.now();
    job.progress = 0;
    job.bytesDownloaded = 0;
    job.totalBytes = 0;
    job.speedBps = 0;
    job.etaSeconds = estimatedDurationSeconds > 0 ? Math.round(estimatedDurationSeconds) : null;
    job.threadStates = [];
    job.segmentStates = {};
    job.failedSegments = [];

    const parseProgressLine = (line) => {
      const text = String(line || '').trim();
      if (!text) return;
      const [rawKey, ...rest] = text.split('=');
      if (!rawKey || rest.length === 0) return;
      const key = rawKey.trim();
      const value = rest.join('=').trim();

      if (key === 'total_size') {
        const totalSize = Number.parseInt(value, 10);
        if (Number.isFinite(totalSize) && totalSize >= 0) {
          job.bytesDownloaded = totalSize;
        }
      }

      if (key === 'out_time_ms') {
        const outTimeMs = Number.parseInt(value, 10);
        if (Number.isFinite(outTimeMs) && outTimeMs >= 0 && estimatedDurationSeconds > 0) {
          const playedSeconds = outTimeMs / 1_000_000;
          const percent = Math.max(0, Math.min(99, Math.round((playedSeconds / estimatedDurationSeconds) * 100)));
          job.progress = Math.max(Number(job.progress || 0), percent);
          const remainingSeconds = Math.max(0, estimatedDurationSeconds - playedSeconds);
          job.etaSeconds = Number.isFinite(remainingSeconds) ? Math.round(remainingSeconds) : null;
        }
      }

      if (key === 'progress' && value === 'end') {
        job.progress = 99;
      }

      job.updatedAt = Date.now();
    };

    let lastErrorSummary = '';
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(FFMPEG_PATH, nativeArgs, {
          stdio: ['ignore', 'ignore', 'pipe'],
        });

        let progressBuffer = '';
        const cancelPoll = setInterval(() => {
          if (!job.cancelled || child.killed) return;
          child.kill('SIGTERM');
        }, 250);

        const finalize = (cb) => {
          clearInterval(cancelPoll);
          cb();
        };

        if (child.stderr) {
          child.stderr.on('data', (chunk) => {
            const text = Buffer.from(chunk).toString('utf8');
            if (!text) return;
            lastErrorSummary = text
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .slice(-8)
              .join(' | ')
              .slice(0, 1200);

            progressBuffer += text;
            const lines = progressBuffer.split(/\r?\n/);
            progressBuffer = lines.pop() || '';
            for (const line of lines) {
              parseProgressLine(line);
            }
          });
        }

        child.on('error', (err) => finalize(() => reject(err)));
        child.on('close', (code) => finalize(() => {
          if (progressBuffer) {
            parseProgressLine(progressBuffer);
            progressBuffer = '';
          }

          if (job.cancelled) {
            resolve();
            return;
          }

          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(lastErrorSummary || `ffmpeg exited with code ${code}`));
        }));
      });
    } catch (err) {
      try {
        await fsPromises.unlink(tempMp4Path);
      } catch (_) {
      }
      throw err;
    }

    if (job.cancelled) {
      try {
        await fsPromises.unlink(tempMp4Path);
      } catch (_) {
      }
      if (job.cleanupOnCancel) {
        await cleanupCancelledHlsArtifacts(job, null, { preserveSegments: false });
      }
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      return;
    }

    await fsPromises.rename(tempMp4Path, mp4Path);

    try {
      await generateThumbnailFromMp4(job, mp4Path, {
        outputDir,
        FFMPEG_PATH,
        FFPROBE_PATH,
        skipThumbnailGeneration: job.skipThumbnailGeneration !== false,
      });
    } catch (thumbErr) {
      logger.warn('Thumbnail generation failed after native HLS ingest', {
        jobId: job.id,
        message: thumbErr && thumbErr.message,
      });
    }

    job.mp4Path = mp4Path;
    job.completedSegments = Number(playlistInfo && playlistInfo.totalSegments) || 0;
    job.totalSegments = Number(playlistInfo && playlistInfo.totalSegments) || 0;
    job.progress = 100;
    job.speedBps = 0;
    job.etaSeconds = 0;
    job.status = 'completed';
    job.error = null;
    job.updatedAt = Date.now();
  }

  async function concatenateSegmentsStreaming(job, segments, jobTempDir, maxPartBytes, options = {}) {
    const deleteTempSegments = options.deleteTempSegments !== false;
    const tsParts = [];
    let partIndex = 0;
    let currentStream = null;
    let currentPartBytes = 0;
    let totalBytesWritten = 0;
    const missingSegments = [];

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
          missingSegments.push(i);
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
          missingSegments.push(i);
          continue;
        }

        if (!stats || !Number.isFinite(stats.size) || stats.size <= 0) {
          logger.warn('Temp segment missing content during concat', {
            jobId: job.id,
            tempSegmentPath,
            size: stats && stats.size,
          });
          missingSegments.push(i);
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

        if (deleteTempSegments) {
          try {
            await fsPromises.unlink(tempSegmentPath);
          } catch (_) {
          }
        }
      }

      if (missingSegments.length > 0) {
        throw new Error(buildIncompleteHlsError(segments.length, missingSegments));
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
      await Promise.all(
        tsParts.map(async (partPath) => {
          try {
            await fsPromises.unlink(partPath);
          } catch (_) {
          }
        })
      );
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
      job.speedBps = 0;
      job.etaSeconds = null;

      if (isYouTubeUrl(job && job.url)) {
        await runYouTubeDirectJob(job);
        logger.info('Direct job finished via yt-dlp', { jobId: job && job.id, status: job && job.status });
        return;
      }

      if (!job.storageDir && job.filePath) {
        job.storageDir = path.dirname(job.filePath);
      }
      if (job.filePath) {
        await fsPromises.mkdir(path.dirname(job.filePath), { recursive: true });
      }

      const headers = job.headers || {};
      const tempFilePath = `${job.filePath}.part`;
      let downloaded = false;
      let lastErr = null;

      // Direct retries write to temp + rename to avoid exposing partial files.
      for (let attempt = 1; attempt <= DIRECT_MAX_ATTEMPTS && !job.cancelled; attempt += 1) {
        try {
          job.bytesDownloaded = 0;
          job.totalBytes = 0;
          job.progress = 0;
          job.updatedAt = Date.now();

          try {
            await fsPromises.unlink(tempFilePath);
          } catch (_) {
          }

          await requestWithRedirects(job.url, headers, (res, _finalUrl, req) => {
            return new Promise((resolve, reject) => {
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

              const outStream = fs.createWriteStream(tempFilePath);
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

              res.on('error', reject);
              outStream.on('finish', resolve);
              res.pipe(outStream);
            });
          }, { timeoutMs: 30_000 });

          await fsPromises.rename(tempFilePath, job.filePath);
          downloaded = true;
          break;
        } catch (err) {
          lastErr = err;
          if (job.cancelled || attempt >= DIRECT_MAX_ATTEMPTS) {
            break;
          }

          const delayMs = getRetryBackoffMs(attempt);
          logger.warn('Direct job attempt failed, retrying', {
            jobId: job.id,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
            error: err && err.message,
          });
          await sleep(delayMs);
        }
      }

      if (!downloaded && job.cancelled) {
        await unlinkIfExists(tempFilePath, { jobId: job && job.id, reason: 'direct-cancelled' });
        if (job.cleanupOnCancel) {
          await cleanupCancelledDirectArtifacts(job);
        }
        job.status = 'cancelled';
        job.updatedAt = Date.now();
        return;
      }

      if (!downloaded) {
        throw lastErr || new Error('Direct download failed after retries');
      }

      if (job.cancelled) {
        if (job.cleanupOnCancel) {
          await cleanupCancelledDirectArtifacts(job);
        }
        job.status = 'cancelled';
        job.speedBps = 0;
        job.etaSeconds = null;
      } else {
        job.status = 'completed';
        job.progress = 100;
        // For direct MP4 downloads, the primary asset is already an MP4 file.
        // Point mp4Path at filePath so the existing /api/jobs/:id/file route works.
        job.mp4Path = job.filePath;
        job.speedBps = 0;
        job.etaSeconds = 0;
      }
      job.updatedAt = Date.now();
      logger.info('Direct job finished', { jobId: job && job.id, status: job.status });
    } catch (err) {
      logger.error('Direct job failed', { jobId: job && job.id, error: err && err.message });
      if (job) {
        if (job.cancelled) {
          if (job.cleanupOnCancel) {
            await cleanupCancelledDirectArtifacts(job);
          }
          job.status = 'cancelled';
          job.error = null;
          job.speedBps = 0;
          job.etaSeconds = null;
        } else {
          job.status = 'error';
          job.error = (err && err.message) || 'Direct download failure';
          job.speedBps = 0;
          job.etaSeconds = null;
        }
        job.updatedAt = Date.now();
      }
    }
  }

  async function tryDirectFallback(job, cause) {
    if (!job || !job.fallbackUrl || job.cancelled || job.fallbackAttempted) {
      return false;
    }

    // Fallback is intended for HLS jobs that made no usable progress.
    if ((job.completedSegments || 0) > 0) {
      return false;
    }

    job.fallbackAttempted = true;

    const original = {
      url: job.url,
      filePath: job.filePath,
      downloadName: job.downloadName,
      downloadNameMp4: job.downloadNameMp4,
      totalSegments: job.totalSegments,
      completedSegments: job.completedSegments,
      threadStates: job.threadStates,
      segmentStates: job.segmentStates,
      failedSegments: job.failedSegments,
      error: job.error,
      progress: job.progress,
    };

    if (!job.originalHlsUrl) {
      job.originalHlsUrl = original.url;
    }
    if (!job.originalHlsDownloadName) {
      job.originalHlsDownloadName = original.downloadName;
    }
    if (!job.originalHlsDownloadNameMp4) {
      job.originalHlsDownloadNameMp4 = original.downloadNameMp4;
    }

    job.url = job.fallbackUrl;
    job.filePath = job.directFallbackFilePath || job.filePath;
    job.downloadName = job.directFallbackDownloadName || job.downloadName;
    job.downloadNameMp4 = job.directFallbackDownloadNameMp4 || job.downloadNameMp4;
    job.totalSegments = 0;
    job.completedSegments = 0;
    job.threadStates = [];
    job.segmentStates = {};
    job.failedSegments = [];
    job.error = null;
    job.progress = 0;
    job.updatedAt = Date.now();

    logger.warn('Switching HLS job to direct fallback URL', {
      jobId: job.id,
      originalUrl: original.url,
      fallbackUrl: job.fallbackUrl,
      cause: cause && cause.message,
    });

    await runDirectJob(job);

    if (job.status === 'error') {
      const fallbackError = job.error || 'Direct fallback failed';
      job.error = `${fallbackError} (original HLS failure: ${(cause && cause.message) || original.error || 'unknown'})`;
      job.fallbackUsed = false;
    } else {
      job.fallbackUsed = true;
    }

    return true;
  }

  async function runJob(job) {
    try {
      logger.info('HLS job started', { jobId: job && job.id, url: job && job.url });
      job.status = 'fetching-playlist';
      job.updatedAt = Date.now();
      if (!job.storageDir && job.filePath) {
        job.storageDir = path.dirname(job.filePath);
      }
      if (job.filePath) {
        await fsPromises.mkdir(path.dirname(job.filePath), { recursive: true });
      }

      const headers = job.headers || {};
      const { text: playlistText, finalUrl: playlistUrl } = await fetchText(job.url, headers);
      const playlistInfo = inspectHlsPlaylist(playlistText, playlistUrl || job.url);
      const segments = playlistInfo.segments.length > 0
        ? playlistInfo.segments
        : parseM3U8(playlistText, playlistUrl || job.url);
      job.totalSegments = playlistInfo.totalSegments || segments.length;
      job.status = 'downloading';
      job.failedSegments = [];
      job.threadStates = [];
      job.segmentStates = {};
      job.updatedAt = Date.now();

      if (FFMPEG_PATH && shouldPreferNativeHlsDownload(playlistInfo)) {
        logger.info('Using native FFmpeg HLS ingest for advanced playlist', {
          jobId: job.id,
          playlistUrl: playlistUrl || job.url,
          totalSegments: playlistInfo.totalSegments,
          isMasterPlaylist: playlistInfo.isMasterPlaylist,
          hasDiscontinuity: playlistInfo.hasDiscontinuity,
          hasMap: playlistInfo.hasMap,
          hasByteRange: playlistInfo.hasByteRange,
          hasFmp4Segments: playlistInfo.hasFmp4Segments,
        });
        try {
          await runNativeHlsJob(job, playlistUrl || job.url, playlistInfo);
          return;
        } catch (nativeErr) {
          logger.warn('Native FFmpeg HLS ingest failed; falling back to segmented downloader', {
            jobId: job.id,
            message: nativeErr && nativeErr.message,
          });
          job.progress = 0;
          job.bytesDownloaded = 0;
          job.totalBytes = 0;
          job.speedBps = 0;
          job.etaSeconds = null;
          job.threadStates = [];
          job.segmentStates = {};
          job.failedSegments = [];
        }
      }

      // Initialize all segments as pending
      for (let i = 0; i < segments.length; i++) {
        job.segmentStates[i] = { status: 'pending', attempt: 0 };
      }

      const maxConcurrent = job.maxConcurrent && job.maxConcurrent > 0
        ? Math.min(16, job.maxConcurrent)
        : DEFAULT_MAX_CONCURRENT;

      // Create or reuse temp directory for this playlist's segment files, based on URL
      const jobTempDir = getJobTempDirForUrl(job.url, job.id);
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
      const effectiveMaxAttemptsPerSegment =
        maxAttemptsPerSegment === Infinity && job.fallbackUrl
          ? 5
          : maxAttemptsPerSegment;

      // Index for new segments; failed segments are managed in a separate queue.
      let nextIndex = 0;
      const failedQueue = [];
      const areAllSegmentsTerminal = () => {
        for (let idx = 0; idx < segments.length; idx += 1) {
          const state = job.segmentStates[idx];
          if (!state) return false;
          if (state.status !== 'completed' && state.status !== 'failed') {
            return false;
          }
        }
        return true;
      };

      async function worker(workerId) {
        while (!job.cancelled) {
          if (nextIndex >= segments.length && failedQueue.length === 0 && areAllSegmentsTerminal()) {
            break;
          }

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
          // idle worker to "race" only on actively downloading segments.
          // Backoff-managed retries stay in failedQueue until due.
          if (i == null) {
            const candidates = [];
            for (let idx = 0; idx < segments.length; idx++) {
              const state = job.segmentStates[idx];
              if (!state) continue;
              if (state.status === 'downloading') {
                if (attempts[idx] < effectiveMaxAttemptsPerSegment) {
                  candidates.push(idx);
                }
              }
            }

            if (candidates.length === 0) {
              if (areAllSegmentsTerminal()) {
                break;
              }

              // No immediate race work. If retries are scheduled for the future,
              // wait briefly and poll again instead of exiting early.
              if (failedQueue.length > 0) {
                const now = Date.now();
                let nextDueAt = Infinity;

                for (const segIdx of failedQueue) {
                  const dueAt = nextAttemptAt[segIdx] || 0;
                  if (dueAt > now && dueAt < nextDueAt) {
                    nextDueAt = dueAt;
                  }
                }

                if (Number.isFinite(nextDueAt)) {
                  const waitMs = Math.max(25, Math.min(300, nextDueAt - now));
                  await sleep(waitMs);
                } else {
                  await sleep(25);
                }
                continue;
              }

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
          let attemptTempPath = null;

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
            attemptTempPath = path.join(
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
            await new Promise((resolve, reject) => {
              segmentStream.once('finish', resolve);
              segmentStream.once('error', reject);
              segmentStream.end();
            });

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
            if (attemptTempPath) {
              try {
                await fsPromises.unlink(attemptTempPath);
              } catch (_) {
              }
            }
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

            if (attempt < effectiveMaxAttemptsPerSegment) {
              // Queue for another retry with a backoff timestamp.
              job.segmentStates[i] = {
                status: 'retrying',
                attempt,
                error: err.message,
              };
              const delayMs = getRetryBackoffMs(attempt);
              nextAttemptAt[i] = Date.now() + delayMs;
              if (!failedQueue.includes(i)) {
                failedQueue.push(i);
              }
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
          // Keep progress below 100 while post-download finalize steps are pending.
          // "100%" should only mean the download is fully complete and usable.
          if (computedProgress >= 100) {
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

      const incompleteSegmentIndexes = [];
      for (let i = 0; i < segments.length; i += 1) {
        const state = job.segmentStates[i];
        if (!state || state.status !== 'completed') {
          incompleteSegmentIndexes.push(i);
        }
      }

      if (!job.cancelled && incompleteSegmentIndexes.length > 0) {
        throw new Error(buildIncompleteHlsError(segments.length, incompleteSegmentIndexes));
      }

      if (job.cancelled) {
        const preserveSegmentsForPause = !!job.pauseRequested && !job.cleanupOnCancel;
        await cleanupCancelledHlsArtifacts(job, jobTempDir, { preserveSegments: preserveSegmentsForPause });
        job.status = 'cancelled';
        job.updatedAt = Date.now();
        logger.info('HLS job cancelled before finalization', {
          jobId: job && job.id,
          preserveSegmentsForPause,
          cleanupOnCancel: !!job.cleanupOnCancel,
        });
        return;
      }

      if (!job.cancelled && job.failedSegments.length > 0 && job.completedSegments === 0) {
        throw new Error('All segments failed to download.');
      }

      if (!job.cancelled) {
        job.status = 'finalizing';
        if (job.progress >= 100) {
          job.progress = 99;
        }
        job.updatedAt = Date.now();
      }

      const segmentFiles = segments.map((_, index) => path.join(jobTempDir, `seg-${index}.ts`));
      job.segmentFiles = segmentFiles;

      const tsParts = await concatenateSegmentsStreaming(job, segments, jobTempDir, MAX_TS_PART_BYTES, {
        deleteTempSegments: !FFMPEG_PATH,
      });
      job.tsParts = tsParts;
      const filePathFinal = tsParts && tsParts.length > 0 ? tsParts[0] : job.filePath;

      const remuxResult = await remuxAndGenerateThumbnails(job, filePathFinal, {
        downloadDir,
        FFMPEG_PATH,
        FFPROBE_PATH,
        skipThumbnailGeneration: job.skipThumbnailGeneration !== false,
      });
      if (remuxResult && remuxResult.usedTsFallback && remuxResult.error) {
        job.error = remuxResult.error;
      }

      try {
        const remainingFiles = await fsPromises.readdir(jobTempDir);

        // Delete any leftover temp files after remux/fallback has finished using them.
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
      job.segmentFiles = null;

      if (job.cancelled) {
        job.status = 'cancelled';
      } else if (job.failedSegments.length > 0 && job.completedSegments === 0) {
        job.status = 'error';
        job.error = 'All segments failed to download.';
      } else if (remuxResult && remuxResult.usedTsFallback) {
        job.status = 'completed-with-errors';
      } else if (job.failedSegments.length > 0) {
        job.status = 'error';
        if (!job.error) {
          job.error = buildIncompleteHlsError(
            job.totalSegments || job.failedSegments.length,
            job.failedSegments.map((segment) => segment && segment.index)
          );
        }
      } else {
        job.status = 'completed';
        job.error = null;
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
      const usedFallback = await tryDirectFallback(job, err);
      if (usedFallback) {
        return;
      }
      if (job) {
        if (job.cancelled) {
          const cleanupOnCancel = !!job.cleanupOnCancel;
          const jobTempDir = getJobTempDirForUrl(job.url, job.id);
          await cleanupCancelledHlsArtifacts(job, jobTempDir, {
            preserveSegments: !!job.pauseRequested && !cleanupOnCancel,
          });
          job.status = 'cancelled';
          job.error = null;
        } else {
          job.status = 'error';
          job.error = (err && err.message) || 'Unknown job failure';
        }
        job.updatedAt = Date.now();
      }
    }
  }

  return { runJob, runDirectJob };
}

module.exports = { createJobProcessor };
