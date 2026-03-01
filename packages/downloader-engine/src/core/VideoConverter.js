const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../utils/logger');

async function remuxAndGenerateThumbnails(job, filePathFinal, {
  downloadDir,
  FFMPEG_PATH,
  FFPROBE_PATH,
  skipThumbnailGeneration = false,
}) {
  try {
    if (!FFMPEG_PATH) {
      logger.warn('TS->MP4 remux skipped - FFmpeg not available (using TS as fallback)', {
        jobId: job.id,
      });
      job.mp4Path = null;
      job.thumbnailPath = null;
      throw new Error('FFmpeg not available');
    }
    const mp4Path = path.join(downloadDir, `${job.id}-${job.downloadNameMp4}`);

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

    const useConcatDemuxer = Array.isArray(job.tsParts) && job.tsParts.length > 1;

    logger.info('Starting TS->MP4 remux', {
      jobId: job.id,
      tsPath: filePathFinal,
      tsParts: job.tsParts,
      mp4Path,
      ffmpegPath: FFMPEG_PATH,
      useConcatDemuxer,
      hasSubtitle,
      subtitlePath: job.subtitlePath,
    });

    const runFfmpeg = (withSubs, concatListPathRef) => new Promise((resolve, reject) => {
      let args;
      let concatListPath = concatListPathRef || null;

      if (useConcatDemuxer) {
        try {
          concatListPath = concatListPath || path.join(downloadDir, `ts-parts-${job.id}.txt`);
          const listLines = job.tsParts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
          fs.writeFileSync(concatListPath, listLines, 'utf8');
        } catch (err) {
          logger.warn('Failed to write concat list file for TS parts', {
            jobId: job.id,
            message: err && err.message,
          });
          reject(err);
          return;
        }

        args = [
          '-y',
          '-fflags', '+discardcorrupt',
          '-err_detect', 'ignore_err',
          '-f', 'concat',
          '-safe', '0',
          '-i', concatListPath,
          ...(withSubs ? ['-i', job.subtitlePath] : []),
          ...(withSubs ? ['-map', '0:v', '-map', '0:a', '-map', '1:s'] : ['-map', '0']),
          '-c:v', 'copy',
          '-c:a', 'copy',
          ...(withSubs ? ['-c:s', 'mov_text'] : []),
          mp4Path,
        ];
      } else {
        args = [
          '-y',
          '-fflags', '+discardcorrupt',
          '-err_detect', 'ignore_err',
          '-i', filePathFinal,
          ...(withSubs ? ['-i', job.subtitlePath] : []),
          ...(withSubs ? ['-map', '0:v', '-map', '0:a', '-map', '1:s'] : ['-map', '0']),
          '-c:v', 'copy',
          '-c:a', 'copy',
          ...(withSubs ? ['-c:s', 'mov_text'] : []),
          mp4Path,
        ];
      }

      const ff = spawn(FFMPEG_PATH, args, { stdio: 'ignore' });
      ff.on('error', (err) => {
        logger.warn('ffmpeg spawn error during remux', {
          jobId: job.id,
          message: err && err.message,
        });
        reject(err);
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
          logger.warn('ffmpeg remux exited with non-zero code', {
            jobId: job.id,
            code,
            signal,
            withSubs,
          });
          if (concatListPath) {
            try {
              fs.unlinkSync(concatListPath);
            } catch (_) {}
          }
          reject(new Error(`ffmpeg exited with code ${code}`));
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

    const hasEarlyThumbnails =
      Array.isArray(job.thumbnailPaths) &&
      job.thumbnailPaths.length >= 5 &&
      job.thumbnailPaths.every((p) => fs.existsSync(p));

    // IMPORTANT: failure in the thumbnail step should not be treated as a remux failure.
    try {
      if (!hasEarlyThumbnails && !skipThumbnailGeneration) {
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
                const dur = parseFloat(output.trim());
                resolve(isNaN(dur) ? 0 : dur);
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

        // Extract a single representative frame from the MP4.
        // Seek to 10% into the video or 5 seconds (whichever is less) so we
        // land past title cards but don't overshoot short clips.
        const seekTime = duration > 0 ? Math.min(duration * 0.1, 5) : 1;
        const thumbPath = path.join(downloadDir, `${job.id}-thumb.jpg`);

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
            resolve(); // Non-fatal: continue without thumbnail
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
            resolve(); // Non-fatal either way
          });
        });
      } else {
        const thumbnailCount = Array.isArray(job.thumbnailPaths) ? job.thumbnailPaths.length : 0;
        logger.info('Skipping MP4 thumbnail generation', {
          jobId: job.id,
          reason: skipThumbnailGeneration ? 'skipThumbnailGeneration' : 'earlyThumbnailsAlreadyPresent',
          thumbnailCount,
        });
      }
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
  } catch (err) {
    logger.warn('TS->MP4 remux failed (using TS as fallback)', {
      jobId: job.id,
      message: err && err.message,
      stack: err && err.stack,
    });
    job.mp4Path = null;
    job.thumbnailPath = null;
  }
}

module.exports = { remuxAndGenerateThumbnails };
