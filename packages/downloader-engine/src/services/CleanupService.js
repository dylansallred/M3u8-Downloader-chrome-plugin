const path = require('path');
const logger = require('../utils/logger');

const CLEANABLE_DOWNLOAD_EXTENSIONS = new Set([
  '.mp4',
  '.ts',
  '.mkv',
  '.mov',
  '.webm',
  '.m4v',
  '.avi',
  '.jpg',
  '.jpeg',
  '.png',
  '.srt',
  '.zip',
  '.tmp',
]);

function isCleanupCandidateFile(fileName) {
  const name = String(fileName || '');
  if (!name) return false;
  const ext = path.extname(name).toLowerCase();
  if (CLEANABLE_DOWNLOAD_EXTENSIONS.has(ext)) return true;
  if (name.endsWith('.part')) return true;
  if (/^ts-parts-[a-z0-9]+(?:-[a-z0-9]+)?[.]txt$/i.test(name)) return true;
  return false;
}

async function listFilesRecursive(fsPromises, rootDir, currentDir = rootDir, collector = []) {
  const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (currentDir === rootDir && entry.name.startsWith('temp-')) {
        continue;
      }
      await listFilesRecursive(fsPromises, rootDir, fullPath, collector);
      continue;
    }
    if (entry.isFile()) {
      collector.push(fullPath);
    }
  }
  return collector;
}

async function pruneEmptyDirectories(fsPromises, rootDir, currentDir = rootDir) {
  const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (currentDir === rootDir && entry.name.startsWith('temp-')) {
      continue;
    }
    await pruneEmptyDirectories(fsPromises, rootDir, fullPath);
  }

  if (currentDir === rootDir) {
    return;
  }

  try {
    const remaining = await fsPromises.readdir(currentDir);
    if (remaining.length === 0) {
      await fsPromises.rmdir(currentDir);
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      logger.warn('Failed to prune empty directory', { currentDir, error: err.message });
    }
  }
}

async function cleanupOldSegmentFiles({ fsPromises, downloadDir, maxAgeHours }) {
  const CLEANUP_AGE_HOURS = maxAgeHours;
  try {
    const now = Date.now();
    const maxAgeMs = CLEANUP_AGE_HOURS * 60 * 60 * 1000;

    const items = await fsPromises.readdir(downloadDir);
    let deletedCount = 0;
    let removedTempDirectories = 0;

    for (const item of items) {
      if (!item.startsWith('temp-')) continue;

      const tempDirPath = path.join(downloadDir, item);
      const stats = await fsPromises.stat(tempDirPath);

      if (!stats.isDirectory()) continue;

      const ageMs = now - stats.mtimeMs;
      if (ageMs > maxAgeMs) {
        try {
          const files = await fsPromises.readdir(tempDirPath);
          deletedCount += files.length;
          await fsPromises.rm(tempDirPath, { recursive: true, force: true });
          removedTempDirectories += 1;
        } catch (err) {
          logger.warn('Failed to cleanup temp directory', { dir: item, error: err.message });
        }
      }
    }

    if (deletedCount > 0 || removedTempDirectories > 0) {
      logger.info('Cleaned up old segment files', { deletedCount, removedTempDirectories });
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
    const files = await listFilesRecursive(fsPromises, downloadDir);
    for (const itemPath of files) {
      const relative = path.relative(downloadDir, itemPath).replace(/\\/g, '/');
      if (!relative || relative.startsWith('..')) continue;
      if (relative === 'queue.json' || relative === 'history-index.json') continue;

      const fileName = path.basename(itemPath);
      let stats;
      try {
        stats = await fsPromises.stat(itemPath);
      } catch (err) {
        logger.warn('Failed to stat download item during cleanup', { itemPath, error: err.message });
        continue;
      }

      if (!stats.isFile()) continue;

      // Consider completed media artifacts and stale temporary leftovers.
      if (!isCleanupCandidateFile(fileName)) {
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

    await pruneEmptyDirectories(fsPromises, downloadDir);
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
