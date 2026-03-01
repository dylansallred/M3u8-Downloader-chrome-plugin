const path = require('path');
const logger = require('../utils/logger');

async function cleanupOldSegmentFiles({ fsPromises, downloadDir, maxAgeHours }) {
  const CLEANUP_AGE_HOURS = maxAgeHours;
  try {
    const now = Date.now();
    const maxAgeMs = CLEANUP_AGE_HOURS * 60 * 60 * 1000;

    const items = await fsPromises.readdir(downloadDir);
    let deletedCount = 0;

    for (const item of items) {
      if (!item.startsWith('temp-')) continue;

      const tempDirPath = path.join(downloadDir, item);
      const stats = await fsPromises.stat(tempDirPath);

      if (!stats.isDirectory()) continue;

      const ageMs = now - stats.mtimeMs;
      if (ageMs > maxAgeMs) {
        try {
          const files = await fsPromises.readdir(tempDirPath);
          await Promise.all(
            files
              .filter(file => file.endsWith('.ts'))
              .map(async (file) => {
                const filePath = path.join(tempDirPath, file);
                try {
                  await fsPromises.unlink(filePath);
                  deletedCount++;
                } catch (err) {
                  logger.warn('Failed to delete old segment file', { filePath, error: err.message });
                }
              })
          );
          const remainingFiles = await fsPromises.readdir(tempDirPath);
          if (remainingFiles.length === 0) {
            await fsPromises.rmdir(tempDirPath);
          }
        } catch (err) {
          logger.warn('Failed to cleanup temp directory', { dir: item, error: err.message });
        }
      }
    }

    if (deletedCount > 0) {
      logger.info('Cleaned up old segment files', { deletedCount });
    }
  } catch (err) {
    logger.error('Error during cleanup', { error: err.message });
  }
}

async function cleanupOldCompletedFiles({ fsPromises, downloadDir, maxAgeHours }) {
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();
  let deletedCount = 0;

  try {
    const items = await fsPromises.readdir(downloadDir);
    for (const item of items) {
      // Skip temp directories; handled by segment cleanup above
      if (item.startsWith('temp-')) continue;
      // Skip queue state and non-media artifacts
      if (item === 'queue.json') continue;

      const itemPath = path.join(downloadDir, item);
      let stats;
      try {
        stats = await fsPromises.stat(itemPath);
      } catch (err) {
        logger.warn('Failed to stat download item during cleanup', { itemPath, error: err.message });
        continue;
      }

      if (!stats.isFile()) continue;

      // Consider common download outputs: video files and thumbnails
      if (!/[.](mp4|ts|mkv|mov|webm|m3u8|jpg|jpeg|png)$/i.test(item)) {
        continue;
      }

      if (now - stats.mtimeMs > maxAgeMs) {
        try {
          await fsPromises.unlink(itemPath);
          deletedCount++;
        } catch (err) {
          logger.warn('Failed to delete old download file', { itemPath, error: err.message });
        }
      }
    }

    if (deletedCount > 0) {
      logger.info('Cleaned up old completed download files', { deletedCount });
    }
  } catch (err) {
    logger.error('Error during completed file cleanup', { error: err.message });
  }
}

function startCleanupScheduler({
  fsPromises,
  downloadDir,
  intervalMs,
  tempMaxAgeHours,
  downloadMaxAgeHours,
}) {
  cleanupOldSegmentFiles({ fsPromises, downloadDir, maxAgeHours: tempMaxAgeHours });
  cleanupOldCompletedFiles({ fsPromises, downloadDir, maxAgeHours: downloadMaxAgeHours });

  const timer = setInterval(() => {
    cleanupOldSegmentFiles({ fsPromises, downloadDir, maxAgeHours: tempMaxAgeHours });
    cleanupOldCompletedFiles({ fsPromises, downloadDir, maxAgeHours: downloadMaxAgeHours });
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
}

module.exports = {
  cleanupOldSegmentFiles,
  cleanupOldCompletedFiles,
  startCleanupScheduler,
};
