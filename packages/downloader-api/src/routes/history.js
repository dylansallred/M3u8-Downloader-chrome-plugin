const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { historyFileParamValidation } = require('../utils/validators');
const { decodeHistoryItemId } = require('../services/historyIndex');

const HISTORY_MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.ts',
  '.mkv',
  '.mov',
  '.webm',
  '.m4v',
  '.avi',
]);

const HISTORY_STREAM_CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.ts': 'video/mp2t',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
};

const PROTECTED_TOP_LEVEL_FILES = new Set(['queue.json', 'history-index.json']);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'completed-with-errors', 'failed', 'cancelled']);

function isHistoryMediaFileName(fileName) {
  return HISTORY_MEDIA_EXTENSIONS.has(path.extname(String(fileName || '')).toLowerCase());
}

function isManagedHistoryArtifactFileName(fileName) {
  const name = String(fileName || '');
  if (!name) return false;
  if (isHistoryMediaFileName(name)) return true;
  if (name.endsWith('-thumb.jpg')) return true;
  if (name.endsWith('-subtitles.srt')) return true;
  if (name.endsWith('-subtitles.zip')) return true;
  if (name.endsWith('.part')) return true;
  if (/^ts-parts-[a-z0-9]+(?:-[a-z0-9]+)?[.]txt$/i.test(name)) return true;
  return false;
}

function extractJobIdFromArtifactName(fileName) {
  const name = path.basename(String(fileName || '').trim());
  if (!name) return null;

  const tsPartsMatch = name.match(/^ts-parts-([a-z0-9]+-[a-z0-9]+)[.]txt$/i);
  if (tsPartsMatch) {
    return tsPartsMatch[1];
  }

  const legacyTsPartsMatch = name.match(/^ts-parts-([a-z0-9]+)[.]txt$/i);
  if (legacyTsPartsMatch) {
    return legacyTsPartsMatch[1];
  }

  const normalized = name.replace(/[.]part$/i, '');
  const modernMatch = normalized.match(/^([a-z0-9]+-[a-z0-9]+)-/i);
  if (modernMatch) {
    return modernMatch[1];
  }

  const legacyMatch = normalized.match(/^([a-z0-9]+)-/i);
  if (legacyMatch) {
    return legacyMatch[1];
  }

  return null;
}

async function walkDownloadEntries(fsPromises, rootDir, currentDir = rootDir, relativeDir = '') {
  const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
  const files = [];
  const directories = [];

  for (const entry of entries) {
    const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      directories.push({ fullPath, relativePath: relPath, entry });
      const nested = await walkDownloadEntries(fsPromises, rootDir, fullPath, relPath);
      files.push(...nested.files);
      directories.push(...nested.directories);
      continue;
    }

    if (entry.isFile()) {
      files.push({ fullPath, relativePath: relPath, entry });
    }
  }

  return { files, directories };
}

async function deleteFilePaths(fsPromises, filePaths) {
  const deleted = [];
  for (const filePath of filePaths) {
    try {
      await fsPromises.unlink(filePath);
      deleted.push(filePath);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        logger.warn('Failed to delete history artifact', { filePath, error: err.message });
      }
    }
  }
  return deleted;
}

async function removeEmptyDirectories(fsPromises, rootDir, currentDir = rootDir) {
  const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(currentDir, entry.name);
    await removeEmptyDirectories(fsPromises, rootDir, dirPath);
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
      logger.warn('Failed to remove empty history directory', {
        directory: currentDir,
        error: err.message,
      });
    }
  }
}

function collectActiveJobIds(historyIndex) {
  const activeJobIds = new Set();
  if (!historyIndex || typeof historyIndex.buildActiveJobFiles !== 'function') {
    return activeJobIds;
  }

  const activeFiles = historyIndex.buildActiveJobFiles();
  for (const fileName of activeFiles || []) {
    const jobId = extractJobIdFromArtifactName(fileName);
    if (jobId) {
      activeJobIds.add(jobId);
    }
  }
  return activeJobIds;
}

function collectActiveJobIdsFromJobsMap(historyIndex) {
  const activeJobIds = new Set();
  if (!historyIndex || !historyIndex.jobs || typeof historyIndex.jobs.values !== 'function') {
    return activeJobIds;
  }

  for (const job of historyIndex.jobs.values()) {
    if (!job || !job.id) continue;
    const status = String(job.queueStatus || job.status || '').trim().toLowerCase();
    if (!status || TERMINAL_JOB_STATUSES.has(status)) continue;
    activeJobIds.add(String(job.id));
  }

  return activeJobIds;
}

function extractTrailingJobIdFromTempDirName(name) {
  const value = String(name || '').trim();
  if (!value) return '';
  const modern = value.match(/-([a-z0-9]+-[a-z0-9]+)$/i);
  if (modern && modern[1]) return modern[1];
  const legacy = value.match(/-([a-z0-9]+)$/i);
  if (legacy && legacy[1]) return legacy[1];
  return '';
}

async function resolveHistoryFilePath(fsPromises, historyIndex, downloadDir, historyId) {
  const identifier = String(historyId || '').trim();
  if (!identifier) return null;

  const indexResolved = historyIndex && typeof historyIndex.resolveFilePath === 'function'
    ? historyIndex.resolveFilePath(identifier)
    : null;
  if (indexResolved) {
    try {
      await fsPromises.access(indexResolved);
      return indexResolved;
    } catch {
      // fall through
    }
  }

  const decodedIdentifier = decodeHistoryItemId(identifier);
  const safeName = path.basename(decodedIdentifier || identifier);
  if (!safeName) return null;

  const directPath = path.join(downloadDir, safeName);
  try {
    await fsPromises.access(directPath);
    return directPath;
  } catch {
    // Fall through to recursive lookup for nested job folders.
  }

  try {
    const { files } = await walkDownloadEntries(fsPromises, downloadDir);
    const match = files.find((entry) => entry.entry.name === safeName);
    return match ? match.fullPath : null;
  } catch {
    return null;
  }
}

function buildLegacyRelatedArtifactPaths(primaryFilePath, allFilePaths) {
  const related = new Set([primaryFilePath, `${primaryFilePath}.part`]);
  const jobId = extractJobIdFromArtifactName(path.basename(primaryFilePath));
  if (!jobId) {
    return Array.from(related).filter((candidate) => allFilePaths.has(candidate));
  }

  const jobPrefix = `${jobId}-`;
  for (const filePath of allFilePaths) {
    const fileName = path.basename(filePath);
    if (fileName === `ts-parts-${jobId}.txt`) {
      related.add(filePath);
      continue;
    }
    if (!fileName.startsWith(jobPrefix)) continue;
    if (isManagedHistoryArtifactFileName(fileName)) {
      related.add(filePath);
    }
  }

  return Array.from(related).filter((candidate) => allFilePaths.has(candidate));
}

async function deleteTempDirectoriesForJobIds(fsPromises, downloadDir, jobIds) {
  if (!jobIds || jobIds.size === 0) return 0;

  let removedCount = 0;
  try {
    const entries = await fsPromises.readdir(downloadDir, { withFileTypes: true });
    const deletions = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name.startsWith('temp-'))
      .filter((entry) => Array.from(jobIds).some((jobId) => entry.name.endsWith(`-${jobId}`)))
      .map(async (entry) => {
        const fullPath = path.join(downloadDir, entry.name);
        try {
          await fsPromises.rm(fullPath, { recursive: true, force: true });
          removedCount += 1;
        } catch (err) {
          logger.warn('Failed to delete temp directory for history cleanup', {
            directory: entry.name,
            error: err.message,
          });
        }
      });
    await Promise.all(deletions);
  } catch (err) {
    logger.warn('Failed to enumerate temp directories for history cleanup', { error: err.message });
  }
  return removedCount;
}

async function deleteOrphanTempDirectories(fsPromises, downloadDir, activeJobIds) {
  let removedCount = 0;
  try {
    const entries = await fsPromises.readdir(downloadDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('temp-')) continue;
      const linkedJobId = extractTrailingJobIdFromTempDirName(entry.name);
      const shouldKeep = linkedJobId
        ? activeJobIds.has(linkedJobId)
        : activeJobIds.size > 0;
      if (shouldKeep) continue;

      const fullPath = path.join(downloadDir, entry.name);
      try {
        await fsPromises.rm(fullPath, { recursive: true, force: true });
        removedCount += 1;
      } catch (err) {
        logger.warn('Failed to delete orphan temp directory during history cleanup', {
          directory: entry.name,
          error: err.message,
        });
      }
    }
  } catch (err) {
    logger.warn('Failed to enumerate temp directories during history cleanup', { error: err.message });
  }

  return removedCount;
}

function isJobStorageDirectoryName(name) {
  const value = String(name || '').trim();
  if (!value) return false;
  return /^[a-z0-9]+-[a-z0-9]+$/i.test(value);
}

async function deleteInactiveJobDirectories(fsPromises, downloadDir, activeJobIds) {
  let removedCount = 0;
  try {
    const entries = await fsPromises.readdir(downloadDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('temp-')) continue;
      if (!isJobStorageDirectoryName(entry.name)) continue;
      if (activeJobIds.has(entry.name)) continue;

      const fullPath = path.join(downloadDir, entry.name);
      try {
        await fsPromises.rm(fullPath, { recursive: true, force: true });
        removedCount += 1;
      } catch (err) {
        logger.warn('Failed to delete inactive job storage directory during history cleanup', {
          directory: entry.name,
          error: err.message,
        });
      }
    }
  } catch (err) {
    logger.warn('Failed to enumerate inactive job storage directories', { error: err.message });
  }

  return removedCount;
}

async function registerHistoryRoutes(app, historyIndex, fsPromises, downloadDir) {
  if (!historyIndex) {
    throw new Error('registerHistoryRoutes requires historyIndex');
  }

  app.get('/api/history', async (req, res) => {
    try {
      const limit = req.query.limit;
      const cursor = req.query.cursor;
      const result = await historyIndex.list({ limit, cursor });

      const response = { items: result.items };
      if (cursor || limit) {
        response.nextCursor = result.nextCursor;
        response.total = result.total;
      }
      res.json(response);
    } catch (err) {
      logger.error('Failed to read download history', { error: err.message });
      res.status(500).json({ error: 'Failed to read download history' });
    }
  });

  app.delete('/api/history', async (req, res) => {
    try {
      const activeJobIds = new Set([
        ...collectActiveJobIds(historyIndex),
        ...collectActiveJobIdsFromJobsMap(historyIndex),
      ]);
      const { files } = await walkDownloadEntries(fsPromises, downloadDir);

      const filePathsToDelete = files
        .filter((entry) => {
          const rel = entry.relativePath;
          if (!rel.includes('/') && PROTECTED_TOP_LEVEL_FILES.has(entry.entry.name)) {
            return false;
          }
          if (!isManagedHistoryArtifactFileName(entry.entry.name)) {
            return false;
          }
          const jobId = extractJobIdFromArtifactName(entry.entry.name);
          return !jobId || !activeJobIds.has(jobId);
        })
        .map((entry) => entry.fullPath);

      const deleted = await deleteFilePaths(fsPromises, filePathsToDelete);
      const deletedJobIds = new Set(
        deleted
          .map((fullPath) => extractJobIdFromArtifactName(path.basename(fullPath)))
          .filter(Boolean)
      );
      await deleteTempDirectoriesForJobIds(fsPromises, downloadDir, deletedJobIds);
      const orphanTempRemoved = await deleteOrphanTempDirectories(fsPromises, downloadDir, activeJobIds);
      const inactiveJobDirsRemoved = await deleteInactiveJobDirectories(fsPromises, downloadDir, activeJobIds);
      await removeEmptyDirectories(fsPromises, downloadDir);

      if (typeof historyIndex.refreshFromDisk === 'function') {
        await historyIndex.refreshFromDisk({ force: true });
      }

      logger.info('History cleared', {
        filesDeleted: deleted.length,
        jobIdsAffected: deletedJobIds.size,
        orphanTempRemoved,
        inactiveJobDirsRemoved,
      });
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to clear history', { error: err.message });
      res.status(500).json({ error: 'Failed to clear history' });
    }
  });

  app.get('/api/history/file/:fileName', historyFileParamValidation, async (req, res) => {
    const historyId = path.basename(req.params.fileName || '');
    if (!historyId) {
      return res.status(400).send('Missing fileName');
    }

    const fullPath = await resolveHistoryFilePath(fsPromises, historyIndex, downloadDir, historyId);
    if (!fullPath) {
      logger.warn('History download requested for missing file', { historyId });
      return res.status(404).send('File not found');
    }

    const safeName = path.basename(fullPath);
    let downloadName = safeName;
    const dashIndex = safeName.indexOf('-');
    if (dashIndex > 0 && dashIndex < safeName.length - 1) {
      downloadName = safeName.slice(dashIndex + 1);
    }

    logger.info('History file download started', { historyId, fileName: safeName, fullPath, downloadName });
    res.download(fullPath, downloadName);
  });

  app.get('/api/history/stream/:fileName', historyFileParamValidation, async (req, res) => {
    const historyId = path.basename(req.params.fileName || '');
    if (!historyId) {
      return res.status(400).send('Missing fileName');
    }

    const fullPath = await resolveHistoryFilePath(fsPromises, historyIndex, downloadDir, historyId);
    if (!fullPath) {
      return res.status(404).send('File not found');
    }

    const safeName = path.basename(fullPath);
    const ext = path.extname(safeName).toLowerCase();
    const contentType = HISTORY_STREAM_CONTENT_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    try {
      const stats = await fsPromises.stat(fullPath);
      const fileSize = stats.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
          return res.end();
        }

        const chunkSize = end - start + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', chunkSize);

        const stream = fs.createReadStream(fullPath, { start, end });
        stream.on('error', () => {
          if (!res.headersSent) {
            res.status(500).end('Error reading file');
          } else {
            res.end();
          }
        });
        stream.pipe(res);
      } else {
        res.setHeader('Content-Length', fileSize);
        const stream = fs.createReadStream(fullPath);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.status(500).end('Error reading file');
          } else {
            res.end();
          }
        });
        stream.pipe(res);
      }
    } catch (err) {
      logger.error('Failed to stream history file', {
        historyId,
        fileName: safeName,
        fullPath,
        error: err.message,
      });
      if (!res.headersSent) {
        res.status(500).end('Error reading file');
      } else {
        res.end();
      }
    }
  });

  app.delete('/api/history/:fileName', historyFileParamValidation, async (req, res) => {
    const historyId = path.basename(req.params.fileName || '');
    if (!historyId) {
      return res.status(400).json({ error: 'Missing fileName' });
    }

    const fullPath = await resolveHistoryFilePath(fsPromises, historyIndex, downloadDir, historyId);
    if (!fullPath) {
      logger.warn('History delete requested for missing file', { historyId });
      return res.status(404).json({ error: 'File not found' });
    }

    try {
      const safeName = path.basename(fullPath);
      const activeJobIds = new Set([
        ...collectActiveJobIds(historyIndex),
        ...collectActiveJobIdsFromJobsMap(historyIndex),
      ]);
      const jobId = extractJobIdFromArtifactName(safeName);
      const fileDir = path.dirname(fullPath);
      const isNestedJobDir = (
        fileDir !== downloadDir
        && path.resolve(path.dirname(fileDir)) === path.resolve(downloadDir)
        && jobId
        && path.basename(fileDir) === jobId
      );

      let deleted = [];
      if (isNestedJobDir) {
        const entries = await fsPromises.readdir(fileDir, { withFileTypes: true });
        const filesInDir = entries
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(fileDir, entry.name));
        const managed = filesInDir.filter((candidatePath) => isManagedHistoryArtifactFileName(path.basename(candidatePath)));
        deleted = await deleteFilePaths(fsPromises, managed);

        try {
          const remaining = await fsPromises.readdir(fileDir);
          if (remaining.length === 0 || (jobId && !activeJobIds.has(jobId))) {
            await fsPromises.rm(fileDir, { recursive: true, force: true });
          }
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            logger.warn('Failed to remove empty job history directory', { fileDir, error: err.message });
          }
        }
      } else {
        let filesInDir = new Set([fullPath]);
        try {
          const siblingEntries = await fsPromises.readdir(fileDir, { withFileTypes: true });
          filesInDir = new Set(
            siblingEntries
              .filter((entry) => entry.isFile())
              .map((entry) => path.join(fileDir, entry.name))
          );
          filesInDir.add(fullPath);
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            logger.warn('Failed to enumerate history file siblings for delete', {
              fileDir,
              error: err.message,
            });
          }
        }

        const related = buildLegacyRelatedArtifactPaths(fullPath, filesInDir);
        deleted = await deleteFilePaths(fsPromises, related);
      }

      const deletedJobIds = new Set(
        deleted
          .map((deletedPath) => extractJobIdFromArtifactName(path.basename(deletedPath)))
          .filter(Boolean)
      );
      await deleteTempDirectoriesForJobIds(fsPromises, downloadDir, deletedJobIds);
      await deleteOrphanTempDirectories(fsPromises, downloadDir, activeJobIds);
      await removeEmptyDirectories(fsPromises, downloadDir);

      if (typeof historyIndex.refreshFromDisk === 'function') {
        await historyIndex.refreshFromDisk({ force: true });
      } else {
        await historyIndex.removeById(historyId);
      }

      logger.info('History file deleted', {
        historyId,
        fileName: safeName,
        fullPath,
        artifactsDeleted: deleted.length,
      });
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to delete history file', { fileName: safeName, error: err.message });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });
}

module.exports = registerHistoryRoutes;
