const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../utils/logger');
const { buildFfmpegMetadataArgs } = require('../utils/mediaTags');

function escapeConcatEntry(filePath) {
  return `file '${String(filePath || '').replace(/'/g, "'\\''")}'`;
}

function resolveRemuxInput(job, filePathFinal, outputDir) {
  const segmentFiles = Array.isArray(job && job.segmentFiles)
    ? job.segmentFiles.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  if (segmentFiles.length > 1) {
    return {
      mode: 'concat',
      entries: segmentFiles,
      concatListPath: path.join(outputDir, `ts-segments-${job.id}.txt`),
    };
  }

  const tsParts = Array.isArray(job && job.tsParts)
    ? job.tsParts.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  if (tsParts.length > 1) {
    return {
      mode: 'concat',
      entries: tsParts,
      concatListPath: path.join(outputDir, `ts-parts-${job.id}.txt`),
    };
  }

  if (segmentFiles.length === 1) {
    return { mode: 'single', inputPath: segmentFiles[0] };
  }

  return { mode: 'single', inputPath: filePathFinal };
}

function buildRemuxArgs({ job, input, mp4Path, withSubs }) {
  const metadataArgs = buildFfmpegMetadataArgs(job);
  const args = [
    '-y',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
  ];

  if (input && input.mode === 'concat') {
    args.push(
      '-f', 'concat',
      '-safe', '0',
      '-i', input.concatListPath,
    );
  } else {
    args.push('-i', input.inputPath);
  }

  if (withSubs) {
    args.push('-i', job.subtitlePath);
  }

  args.push('-map', '0:v?', '-map', '0:a?');

  if (withSubs) {
    args.push('-map', '1:s');
  }

  args.push(
    '-c:v', 'copy',
    '-c:a', 'copy',
  );

  if (withSubs) {
    args.push('-c:s', 'mov_text');
  }

  args.push(
    '-movflags', '+faststart',
    '-max_interleave_delta', '0',
    ...metadataArgs,
    mp4Path,
  );

  return args;
}

function buildPlaybackCompatibilityArgs({ job, inputPath, outputPath, withSubs = true }) {
  const metadataArgs = buildFfmpegMetadataArgs(job);
  const aggressiveAudioRepair = job && job.aggressiveAudioRepair === true;
  const args = [
    '-y',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-avoid_negative_ts', 'make_zero',
    '-i', inputPath,
    '-map', '0:v?',
    '-map', '0:a?',
  ];

  if (withSubs) {
    args.push('-map', '0:s?');
  }

  if (aggressiveAudioRepair) {
    args.push(
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-af', 'aresample=async=1000:min_comp=0.001:min_hard_comp=0.100:first_pts=0,asetpts=N/SR/TB',
    );
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level:v', '4.1',
      '-vsync', 'cfr',
      '-video_track_timescale', '90000',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-af', 'aresample=async=1000:first_pts=0',
    );
  }

  if (withSubs) {
    args.push('-c:s', 'mov_text');
  }

  args.push(
    '-movflags', '+faststart+use_metadata_tags',
    '-max_interleave_delta', '0',
    ...metadataArgs,
    outputPath,
  );

  return args;
}

function normalizeNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function analyzeAudioPacketTimeline(packetRows, {
  gapThresholdSeconds = 0.03,
  overlapThresholdSeconds = 0.03,
  maxExamples = 5,
} = {}) {
  const rows = Array.isArray(packetRows) ? packetRows : [];
  let packetCount = 0;
  let gapCount = 0;
  let overlapCount = 0;
  let maxGapSeconds = 0;
  let maxOverlapSeconds = 0;
  let previousEndSeconds = null;
  const issues = [];

  for (const row of rows) {
    if (!row) continue;
    const ptsSeconds = normalizeNumber(Array.isArray(row) ? row[0] : row.pts_time);
    const durationSeconds = normalizeNumber(Array.isArray(row) ? row[1] : row.duration_time);
    if (ptsSeconds === null || durationSeconds === null || durationSeconds <= 0) {
      continue;
    }

    packetCount += 1;

    if (previousEndSeconds !== null) {
      const deltaSeconds = ptsSeconds - previousEndSeconds;
      const rowGapThreshold = Math.max(gapThresholdSeconds, durationSeconds * 1.5);
      const rowOverlapThreshold = Math.max(overlapThresholdSeconds, durationSeconds * 1.5);

      if (deltaSeconds > rowGapThreshold) {
        gapCount += 1;
        maxGapSeconds = Math.max(maxGapSeconds, deltaSeconds);
        if (issues.length < maxExamples) {
          issues.push({
            type: 'gap',
            previousEndSeconds: Number(previousEndSeconds.toFixed(6)),
            nextPtsSeconds: Number(ptsSeconds.toFixed(6)),
            deltaSeconds: Number(deltaSeconds.toFixed(6)),
          });
        }
      } else if (deltaSeconds < -rowOverlapThreshold) {
        const overlapSeconds = Math.abs(deltaSeconds);
        overlapCount += 1;
        maxOverlapSeconds = Math.max(maxOverlapSeconds, overlapSeconds);
        if (issues.length < maxExamples) {
          issues.push({
            type: 'overlap',
            previousEndSeconds: Number(previousEndSeconds.toFixed(6)),
            nextPtsSeconds: Number(ptsSeconds.toFixed(6)),
            deltaSeconds: Number(deltaSeconds.toFixed(6)),
          });
        }
      }
    }

    previousEndSeconds = ptsSeconds + durationSeconds;
  }

  return {
    packetCount,
    gapCount,
    overlapCount,
    maxGapSeconds: Number(maxGapSeconds.toFixed(6)),
    maxOverlapSeconds: Number(maxOverlapSeconds.toFixed(6)),
    issues,
    shouldRepair: gapCount > 0,
  };
}

async function probeAudioPacketTimeline(filePath, {
  FFPROBE_PATH,
  timeoutMs = 20000,
} = {}) {
  if (!filePath || !FFPROBE_PATH) {
    return {
      ok: false,
      skipped: true,
      analysis: analyzeAudioPacketTimeline([]),
    };
  }

  try {
    await fs.promises.access(filePath);
  } catch {
    return {
      ok: false,
      skipped: false,
      analysis: analyzeAudioPacketTimeline([]),
      error: `Missing file for audio timeline probe: ${filePath}`,
    };
  }

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'packet=pts_time,duration_time',
      '-show_packets',
      '-of', 'csv=p=0',
      filePath,
    ];
    const child = spawn(FFPROBE_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    const packetRows = [];

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const consumeBuffer = (flush = false) => {
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          const parts = line.split(',').map((value) => String(value || '').trim());
          packetRows.push(parts);
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }

      if (flush) {
        const line = stdoutBuffer.trim();
        stdoutBuffer = '';
        if (line) {
          const parts = line.split(',').map((value) => String(value || '').trim());
          packetRows.push(parts);
        }
      }
    };

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({
        ok: false,
        skipped: false,
        analysis: analyzeAudioPacketTimeline(packetRows),
        error: `ffprobe timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += Buffer.from(chunk).toString('utf8');
        consumeBuffer(false);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += Buffer.from(chunk).toString('utf8');
      });
    }

    child.on('error', (err) => {
      clearTimeout(killTimer);
      settle({
        ok: false,
        skipped: false,
        analysis: analyzeAudioPacketTimeline(packetRows),
        error: err && err.message ? err.message : 'ffprobe failed to start',
      });
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      consumeBuffer(true);
      if (code !== 0) {
        settle({
          ok: false,
          skipped: false,
          analysis: analyzeAudioPacketTimeline(packetRows),
          error: stderr.trim() || `ffprobe exited with code ${code}`,
        });
        return;
      }

      settle({
        ok: true,
        skipped: false,
        analysis: analyzeAudioPacketTimeline(packetRows),
      });
    });
  });
}

async function replaceFileWithTempOutput(targetPath, tempOutputPath) {
  const backupPath = `${targetPath}.bak`;

  try {
    fs.unlinkSync(backupPath);
  } catch (_) {}

  await fs.promises.rename(targetPath, backupPath);
  try {
    await fs.promises.rename(tempOutputPath, targetPath);
    await fs.promises.unlink(backupPath);
  } catch (err) {
    try {
      await fs.promises.rename(backupPath, targetPath);
    } catch (_) {}
    throw err;
  }
}

async function normalizeMp4ForPlayback(job, mp4Path, {
  FFMPEG_PATH,
  FFPROBE_PATH,
}) {
  if (!job || !mp4Path || !FFMPEG_PATH || job.forcePlaybackCompatibility === false) {
    return { ok: false, skipped: true };
  }

  const tempOutputPath = `${mp4Path}.normalize.part`;
  const aggressiveTempOutputPath = `${mp4Path}.normalize-aggressive.part`;
  let normalizationError = null;

  const runFfmpeg = ({ withSubs, inputPath, outputPath, aggressiveAudioRepair = false }) => new Promise((resolve, reject) => {
    const args = buildPlaybackCompatibilityArgs({
      job: {
        ...job,
        aggressiveAudioRepair,
      },
      inputPath,
      outputPath,
      withSubs,
    });
    const stderrChunks = [];
    const ff = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    if (ff.stderr) {
      ff.stderr.on('data', (chunk) => {
        if (!chunk) return;
        stderrChunks.push(Buffer.from(chunk).toString('utf8'));
      });
    }

    const summarizeStderr = () => stderrChunks
      .join('')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
      .join(' | ')
      .slice(0, 1200);

    ff.on('error', (err) => {
      const stderrSummary = summarizeStderr();
      reject(new Error(stderrSummary ? `${err.message} (${stderrSummary})` : err.message));
    });

    ff.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const stderrSummary = summarizeStderr();
      reject(new Error(
        stderrSummary
          ? `ffmpeg exited with code ${code}: ${stderrSummary}`
          : `ffmpeg exited with code ${code}`
      ));
    });
  });

  logger.info('Starting playback compatibility normalization', {
    jobId: job.id,
    mp4Path,
  });

  try {
    let normalizedWithSubs = true;
    try {
      await runFfmpeg({
        withSubs: true,
        inputPath: mp4Path,
        outputPath: tempOutputPath,
        aggressiveAudioRepair: false,
      });
    } catch (err) {
      normalizationError = err;
      logger.warn('Playback compatibility normalization failed with subtitles; retrying without subtitles', {
        jobId: job.id,
        message: err && err.message,
      });
      try {
        fs.unlinkSync(tempOutputPath);
      } catch (_) {}
      normalizedWithSubs = false;
      await runFfmpeg({
        withSubs: false,
        inputPath: mp4Path,
        outputPath: tempOutputPath,
        aggressiveAudioRepair: false,
      });
    }

    await replaceFileWithTempOutput(mp4Path, tempOutputPath);

    const initialTimelineProbe = await probeAudioPacketTimeline(mp4Path, { FFPROBE_PATH });
    if (!initialTimelineProbe.skipped) {
      job.playbackDiagnostics = {
        ...(job.playbackDiagnostics || {}),
        audioTimeline: {
          detectedAt: Date.now(),
          analysis: initialTimelineProbe.analysis,
          probeOk: !!initialTimelineProbe.ok,
          probeError: initialTimelineProbe.error || null,
          aggressiveRepairAttempted: false,
          aggressiveRepairApplied: false,
          aggressiveRepairImproved: false,
          aggressiveRepairProbeOk: null,
          aggressiveRepairError: null,
        },
      };
    }

    if (initialTimelineProbe.ok && initialTimelineProbe.analysis.shouldRepair) {
      logger.warn('Detected audio timeline gaps after playback normalization; retrying with aggressive audio repair', {
        jobId: job.id,
        mp4Path,
        gapCount: initialTimelineProbe.analysis.gapCount,
        maxGapSeconds: initialTimelineProbe.analysis.maxGapSeconds,
      });

      job.playbackDiagnostics = {
        ...(job.playbackDiagnostics || {}),
        audioTimeline: {
          ...(job.playbackDiagnostics && job.playbackDiagnostics.audioTimeline
            ? job.playbackDiagnostics.audioTimeline
            : {}),
          aggressiveRepairAttempted: true,
        },
      };

      try {
        await runFfmpeg({
          withSubs: normalizedWithSubs,
          inputPath: mp4Path,
          outputPath: aggressiveTempOutputPath,
          aggressiveAudioRepair: true,
        });

        const aggressiveTimelineProbe = await probeAudioPacketTimeline(aggressiveTempOutputPath, { FFPROBE_PATH });
        const improved = aggressiveTimelineProbe.ok && (
          aggressiveTimelineProbe.analysis.gapCount < initialTimelineProbe.analysis.gapCount
          || aggressiveTimelineProbe.analysis.maxGapSeconds < initialTimelineProbe.analysis.maxGapSeconds
          || !aggressiveTimelineProbe.analysis.shouldRepair
        );

        job.playbackDiagnostics = {
          ...(job.playbackDiagnostics || {}),
          audioTimeline: {
            ...(job.playbackDiagnostics && job.playbackDiagnostics.audioTimeline
              ? job.playbackDiagnostics.audioTimeline
              : {}),
            aggressiveRepairProbeOk: !!aggressiveTimelineProbe.ok,
            aggressiveRepairAnalysis: aggressiveTimelineProbe.analysis,
            aggressiveRepairError: aggressiveTimelineProbe.error || null,
            aggressiveRepairImproved: improved,
          },
        };

        if (improved) {
          await replaceFileWithTempOutput(mp4Path, aggressiveTempOutputPath);
          job.playbackDiagnostics.audioTimeline.aggressiveRepairApplied = true;
          logger.info('Aggressive audio repair reduced timeline gaps', {
            jobId: job.id,
            mp4Path,
            originalGapCount: initialTimelineProbe.analysis.gapCount,
            originalMaxGapSeconds: initialTimelineProbe.analysis.maxGapSeconds,
            repairedGapCount: aggressiveTimelineProbe.analysis.gapCount,
            repairedMaxGapSeconds: aggressiveTimelineProbe.analysis.maxGapSeconds,
          });
        } else {
          try {
            fs.unlinkSync(aggressiveTempOutputPath);
          } catch (_) {}
          logger.warn('Aggressive audio repair did not improve detected timeline gaps; keeping prior MP4', {
            jobId: job.id,
            mp4Path,
            originalGapCount: initialTimelineProbe.analysis.gapCount,
            originalMaxGapSeconds: initialTimelineProbe.analysis.maxGapSeconds,
            repairedGapCount: aggressiveTimelineProbe.analysis.gapCount,
            repairedMaxGapSeconds: aggressiveTimelineProbe.analysis.maxGapSeconds,
          });
        }
      } catch (err) {
        try {
          fs.unlinkSync(aggressiveTempOutputPath);
        } catch (_) {}
        job.playbackDiagnostics = {
          ...(job.playbackDiagnostics || {}),
          audioTimeline: {
            ...(job.playbackDiagnostics && job.playbackDiagnostics.audioTimeline
              ? job.playbackDiagnostics.audioTimeline
              : {}),
            aggressiveRepairError: err && err.message ? err.message : 'Unknown aggressive repair failure',
          },
        };
        logger.warn('Aggressive audio repair failed; keeping prior MP4', {
          jobId: job.id,
          mp4Path,
          message: err && err.message,
        });
      }
    }

    logger.info('Playback compatibility normalization completed', {
      jobId: job.id,
      mp4Path,
    });
    return { ok: true, skipped: false };
  } catch (err) {
    try {
      fs.unlinkSync(tempOutputPath);
    } catch (_) {}
    try {
      fs.unlinkSync(aggressiveTempOutputPath);
    } catch (_) {}
    logger.warn('Playback compatibility normalization failed; keeping original MP4', {
      jobId: job.id,
      mp4Path,
      message: err && err.message,
      previousError: normalizationError && normalizationError.message,
    });
    return {
      ok: false,
      skipped: false,
      error: err,
    };
  }
}

async function generateThumbnailFromMp4(job, mp4Path, {
  outputDir,
  FFMPEG_PATH,
  FFPROBE_PATH,
  skipThumbnailGeneration = false,
}) {
  const hasEarlyThumbnails =
    Array.isArray(job.thumbnailPaths) &&
    job.thumbnailPaths.length >= 5 &&
    job.thumbnailPaths.every((p) => fs.existsSync(p));

  if (hasEarlyThumbnails || skipThumbnailGeneration) {
    const thumbnailCount = Array.isArray(job.thumbnailPaths) ? job.thumbnailPaths.length : 0;
    logger.info('Skipping MP4 thumbnail generation', {
      jobId: job.id,
      reason: skipThumbnailGeneration ? 'skipThumbnailGeneration' : 'earlyThumbnailsAlreadyPresent',
      thumbnailCount,
    });
    return;
  }

  logger.info('Starting thumbnail generation from MP4', { jobId: job.id });

  let duration = 0;
  if (!FFPROBE_PATH) {
    logger.warn('FFprobe not available - skipping duration-based thumbnail positions', { jobId: job.id });
  } else {
    duration = await new Promise((resolve, reject) => {
      logger.info('Starting ffprobe to read duration', {
        jobId: job.id,
        mp4Path,
        ffprobePath: FFPROBE_PATH,
      });
      const ffprobe = spawn(FFPROBE_PATH, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        mp4Path,
      ]);
      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });
      ffprobe.on('error', (err) => {
        logger.warn('ffprobe spawn error during duration read', {
          jobId: job.id,
          message: err && err.message,
        });
        reject(err);
      });
      ffprobe.on('exit', (code) => {
        if (code === 0) {
          const parsed = parseFloat(output.trim());
          resolve(Number.isFinite(parsed) ? parsed : 0);
        } else {
          logger.warn('ffprobe exited with non-zero code', {
            jobId: job.id,
            code,
            rawOutput: output,
          });
          reject(new Error(`ffprobe exited with code ${code}`));
        }
      });
    });
  }

  logger.info('Thumbnail generation source duration', {
    jobId: job.id,
    durationSeconds: duration,
  });

  const seekTime = duration > 0 ? Math.min(duration * 0.1, 5) : 1;
  const thumbPath = path.join(outputDir, `${job.id}-thumb.jpg`);

  logger.info('Extracting thumbnail frame', {
    jobId: job.id,
    seekTime,
    thumbPath,
  });

  await new Promise((resolve) => {
    const ffThumb = spawn(FFMPEG_PATH, [
      '-ss', String(seekTime),
      '-i', mp4Path,
      '-vframes', '1',
      '-q:v', '4',
      '-vf', 'scale=320:-2',
      '-y',
      thumbPath,
    ], { stdio: 'ignore' });

    ffThumb.on('error', (err) => {
      logger.warn('ffmpeg thumbnail spawn error', {
        jobId: job.id,
        message: err && err.message,
      });
      resolve();
    });

    ffThumb.on('exit', (code, signal) => {
      if (code === 0) {
        logger.info('Thumbnail extracted successfully', {
          jobId: job.id,
          thumbPath,
          seekTime,
        });
        job.thumbnailPath = thumbPath;
      } else {
        logger.warn('ffmpeg thumbnail extraction exited with non-zero code', {
          jobId: job.id,
          code,
          signal,
        });
      }
      resolve();
    });
  });
}

async function remuxAndGenerateThumbnails(job, filePathFinal, {
  downloadDir,
  FFMPEG_PATH,
  FFPROBE_PATH,
  skipThumbnailGeneration = false,
}) {
  try {
    const outputDir = (() => {
      if (job && typeof job.storageDir === 'string' && job.storageDir.trim()) {
        return job.storageDir;
      }
      if (job && typeof job.filePath === 'string' && job.filePath.trim()) {
        return path.dirname(job.filePath);
      }
      return downloadDir;
    })();
    job.storageDir = outputDir;
    fs.mkdirSync(outputDir, { recursive: true });

    if (!FFMPEG_PATH) {
      logger.warn('TS->MP4 remux skipped - FFmpeg not available (using TS as fallback)', {
        jobId: job.id,
      });
      job.mp4Path = null;
      job.thumbnailPath = null;
      throw new Error('FFmpeg not available');
    }
    const mp4Path = path.join(outputDir, `${job.id}-${job.downloadNameMp4}`);
    const remuxInput = resolveRemuxInput(job, filePathFinal, outputDir);

    const hasSubtitle = (() => {
      if (!job.subtitlePath || !fs.existsSync(job.subtitlePath)) {
        logger.info('Subtitle check: no path or file does not exist', { 
          jobId: job.id, 
          subtitlePath: job.subtitlePath,
          exists: job.subtitlePath ? fs.existsSync(job.subtitlePath) : false
        });
        return false;
      }
      const ext = path.extname(job.subtitlePath).toLowerCase();
      if (ext !== '.srt') {
        logger.info('Subtitle check: wrong extension', { jobId: job.id, ext });
        return false;
      }
      try {
        const { size } = fs.statSync(job.subtitlePath);
        const hasContent = size > 0;
        logger.info('Subtitle check: file validated', { 
          jobId: job.id, 
          subtitlePath: job.subtitlePath,
          size,
          hasContent
        });
        return hasContent;
      } catch (err) {
        logger.warn('Subtitle file stat failed, skipping embed', { jobId: job.id, subtitlePath: job.subtitlePath, message: err && err.message });
        return false;
      }
    })();

    logger.info('Starting TS->MP4 remux', {
      jobId: job.id,
      tsPath: filePathFinal,
      segmentFiles: job.segmentFiles,
      tsParts: job.tsParts,
      mp4Path,
      ffmpegPath: FFMPEG_PATH,
      remuxInputMode: remuxInput.mode,
      hasSubtitle,
      subtitlePath: job.subtitlePath,
    });

    const runFfmpeg = (withSubs, concatListPathRef) => new Promise((resolve, reject) => {
      let args;
      let concatListPath = concatListPathRef || null;

      if (remuxInput.mode === 'concat') {
        try {
          concatListPath = concatListPath || remuxInput.concatListPath;
          const listLines = remuxInput.entries.map(escapeConcatEntry).join('\n');
          fs.writeFileSync(concatListPath, listLines, 'utf8');
        } catch (err) {
          logger.warn('Failed to write concat list file for remux input', {
            jobId: job.id,
            message: err && err.message,
          });
          reject(err);
          return;
        }
        args = buildRemuxArgs({
          job,
          input: { ...remuxInput, concatListPath },
          mp4Path,
          withSubs,
        });
      } else {
        args = buildRemuxArgs({
          job,
          input: remuxInput,
          mp4Path,
          withSubs,
        });
      }

      const stderrChunks = [];
      const ff = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      if (ff.stderr) {
        ff.stderr.on('data', (chunk) => {
          if (!chunk) return;
          stderrChunks.push(Buffer.from(chunk).toString('utf8'));
        });
      }
      const summarizeStderr = () => stderrChunks
        .join('')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-8)
        .join(' | ')
        .slice(0, 1200);
      ff.on('error', (err) => {
        const stderrSummary = summarizeStderr();
        logger.warn('ffmpeg spawn error during remux', {
          jobId: job.id,
          message: err && err.message,
          stderrSummary,
        });
        reject(new Error(stderrSummary ? `${err.message} (${stderrSummary})` : err.message));
      });
      ff.on('exit', (code, signal) => {
        if (code === 0) {
          logger.info('ffmpeg remux completed successfully', {
            jobId: job.id,
            code,
            withSubs,
          });
          if (concatListPath) {
            try {
              fs.unlinkSync(concatListPath);
            } catch (_) {}
          }
          resolve();
        } else {
          const stderrSummary = summarizeStderr();
          logger.warn('ffmpeg remux exited with non-zero code', {
            jobId: job.id,
            code,
            signal,
            withSubs,
            stderrSummary,
          });
          if (concatListPath) {
            try {
              fs.unlinkSync(concatListPath);
            } catch (_) {}
          }
          reject(new Error(
            stderrSummary
              ? `ffmpeg exited with code ${code}: ${stderrSummary}`
              : `ffmpeg exited with code ${code}`
          ));
        }
      });
    });

    try {
      await runFfmpeg(hasSubtitle, null);
    } catch (err) {
      if (hasSubtitle) {
        logger.warn('Retrying remux without subtitles due to previous failure', { jobId: job.id, message: err && err.message });
        await runFfmpeg(false, null);
      } else {
        throw err;
      }
    }
    job.mp4Path = mp4Path;

    if (job.forcePlaybackCompatibility !== false) {
      await normalizeMp4ForPlayback(job, mp4Path, { FFMPEG_PATH, FFPROBE_PATH });
    }

    // IMPORTANT: failure in the thumbnail step should not be treated as a remux failure.
    try {
      await generateThumbnailFromMp4(job, mp4Path, {
        outputDir,
        FFMPEG_PATH,
        FFPROBE_PATH,
        skipThumbnailGeneration,
      });
    } catch (thumbErr) {
      logger.warn('Thumbnail generation failed (remux kept)', {
        jobId: job.id,
        message: thumbErr && thumbErr.message,
      });
      job.thumbnailPaths = null;
    }

    // Cleanup temporary files after successful MP4 creation
    const filesToCleanup = [];
    
    // Add main TS file
    if (filePathFinal && fs.existsSync(filePathFinal)) {
      filesToCleanup.push(filePathFinal);
    }
    
    // Add TS parts if they exist
    if (Array.isArray(job.tsParts)) {
      job.tsParts.forEach(partPath => {
        if (partPath && fs.existsSync(partPath)) {
          filesToCleanup.push(partPath);
        }
      });
    }
    
    // Add subtitle files
    if (job.subtitlePath && fs.existsSync(job.subtitlePath)) {
      filesToCleanup.push(job.subtitlePath);
    }
    if (job.subtitleZipPath && fs.existsSync(job.subtitleZipPath)) {
      filesToCleanup.push(job.subtitleZipPath);
    }
    
    // Delete all temporary files
    let cleanedCount = 0;
    filesToCleanup.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      } catch (err) {
        // Only warn if error is not "file doesn't exist"
        if (err.code !== 'ENOENT') {
          logger.warn('Failed to delete temporary file', {
            jobId: job.id,
            filePath,
            error: err && err.message,
          });
        }
      }
    });
    
    if (cleanedCount > 0) {
      logger.info('Cleaned up temporary files after MP4 creation', {
        jobId: job.id,
        filesDeleted: cleanedCount,
        mp4Path,
      });
    }
    return { ok: true, usedTsFallback: false, error: null };
  } catch (err) {
    const message = err && err.message ? err.message : 'Unknown remux failure';
    logger.warn('TS->MP4 remux failed (using TS as fallback)', {
      jobId: job.id,
      message,
      stack: err && err.stack,
    });
    job.mp4Path = null;
    job.thumbnailPath = null;
    return {
      ok: false,
      usedTsFallback: true,
      error: `MP4 remux failed, kept TS output: ${message}`,
    };
  }
}

module.exports = {
  generateThumbnailFromMp4,
  normalizeMp4ForPlayback,
  remuxAndGenerateThumbnails,
  __test: {
    analyzeAudioPacketTimeline,
    buildPlaybackCompatibilityArgs,
    buildRemuxArgs,
    probeAudioPacketTimeline,
    resolveRemuxInput,
  },
};
