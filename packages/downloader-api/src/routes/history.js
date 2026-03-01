const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { historyFileParamValidation } = require('../utils/validators');

async function registerHistoryRoutes(app, fsPromises, downloadDir) {
  // Simple download history based on files present in downloads directory
  app.get('/api/history', async (req, res) => {
    try {
      const items = await fsPromises.readdir(downloadDir, { withFileTypes: true });
      const files = [];

      for (const entry of items) {
        if (!entry.isFile()) continue;
        const fileName = entry.name;
        const ext = path.extname(fileName).toLowerCase();
        if (ext !== '.mp4' && ext !== '.ts') continue;

        const fullPath = path.join(downloadDir, fileName);
        let stats;
        try {
          stats = await fsPromises.stat(fullPath);
        } catch {
          continue;
        }

        const sizeBytes = stats.size;
        const modifiedAt = stats.mtimeMs || stats.mtime.getTime();

        // Derive a friendly label by stripping the job id prefix when present:
        //   <jobId>-<originalName>
        let label = fileName;
        const dashIndex = fileName.indexOf('-');
        if (dashIndex > 0 && dashIndex < fileName.length - 1) {
          label = fileName.slice(dashIndex + 1);
        }

        // Derive job id prefix from file name to check for matching thumbnail
        const jobIdPrefix = fileName.split('-')[0];

        // Validate jobIdPrefix to prevent path traversal
        // Only allow alphanumeric characters, max 20 chars
        const isValidJobId = /^[a-z0-9]+$/i.test(jobIdPrefix) && jobIdPrefix.length <= 20;

        let hasThumb = false;
        if (isValidJobId) {
          const thumbName = `${jobIdPrefix}-thumb.jpg`;
          const thumbPath = path.join(downloadDir, thumbName);
          try {
            await fsPromises.access(thumbPath);
            hasThumb = true;
          } catch {
            hasThumb = false;
          }
        }

        files.push({
          id: fileName,
          fileName,
          label,
          sizeBytes,
          modifiedAt,
          ext,
          thumbnailUrl: hasThumb ? `/downloads/${thumbName}` : null,
        });
      }

      // Sort descending by modified time (newest first)
      files.sort((a, b) => b.modifiedAt - a.modifiedAt);

      // To keep the UI responsive even when many files exist, only return the
      // most recent subset here. The client can still operate quickly when
      // rendering this smaller list.
      const MAX_HISTORY_ITEMS = 200;
      const limited = files.slice(0, MAX_HISTORY_ITEMS);

      res.json({ items: limited });
    } catch (err) {
      logger.error('Failed to read download history', { error: err.message });
      res.status(500).json({ error: 'Failed to read download history' });
    }
  });

  // Delete all history files
  app.delete('/api/history', async (req, res) => {
    try {
      const items = await fsPromises.readdir(downloadDir, { withFileTypes: true });
      const deletions = items
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => {
          const ext = path.extname(name).toLowerCase();
          return ext === '.mp4' || ext === '.ts' || name.endsWith('-thumb.jpg');
        })
        .map((name) => fsPromises.unlink(path.join(downloadDir, name)).catch(() => null));

      await Promise.all(deletions);
      logger.info('History cleared');
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to clear history', { error: err.message });
      res.status(500).json({ error: 'Failed to clear history' });
    }
  });

  // Download a previously completed file from history
  app.get('/api/history/file/:fileName', historyFileParamValidation, async (req, res) => {
    const fileName = req.params.fileName;
    if (!fileName) {
      return res.status(400).send('Missing fileName');
    }

    const safeName = path.basename(fileName);
    const fullPath = path.join(downloadDir, safeName);

    try {
      await fsPromises.access(fullPath);
    } catch {
      logger.warn('History download requested for missing file', { fileName: safeName, fullPath });
      return res.status(404).send('File not found');
    }

    // Use the friendly part of the name (without job id prefix) as the download name
    let downloadName = safeName;
    const dashIndex = safeName.indexOf('-');
    if (dashIndex > 0 && dashIndex < safeName.length - 1) {
      downloadName = safeName.slice(dashIndex + 1);
    }

    logger.info('History file download started', { fileName: safeName, downloadName });
    res.download(fullPath, downloadName);
  });

  // Stream a previously completed file from history for inline playback
  app.get('/api/history/stream/:fileName', historyFileParamValidation, async (req, res) => {
    const fileName = req.params.fileName;
    if (!fileName) {
      return res.status(400).send('Missing fileName');
    }

    const safeName = path.basename(fileName);
    const fullPath = path.join(downloadDir, safeName);
    try {
      await fsPromises.access(fullPath);
    } catch {
      return res.status(404).send('File not found');
    }

    const ext = path.extname(safeName).toLowerCase();
    if (ext === '.mp4') {
      res.setHeader('Content-Type', 'video/mp4');
    } else {
      // Default to TS container for other extensions we expose in history.
      res.setHeader('Content-Type', 'video/mp2t');
    }

    try {
      const stats = await fsPromises.stat(fullPath);
      const fileSize = stats.size;
      const range = req.headers.range;

      if (range) {
        // Example: "bytes=start-end"
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
        // No range header; stream the whole file.
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
      logger.error('Failed to stream history file', { fileName: safeName, error: err.message });
      if (!res.headersSent) {
        res.status(500).end('Error reading file');
      } else {
        res.end();
      }
    }
  });

  // Delete a file from history
  app.delete('/api/history/:fileName', historyFileParamValidation, async (req, res) => {
    const fileName = req.params.fileName;
    if (!fileName) {
      return res.status(400).json({ error: 'Missing fileName' });
    }

    const safeName = path.basename(fileName);
    const fullPath = path.join(downloadDir, safeName);

    try {
      await fsPromises.access(fullPath);
    } catch {
      logger.warn('History delete requested for missing file', { fileName: safeName, fullPath });
      return res.status(404).json({ error: 'File not found' });
    }

    try {
      await fsPromises.unlink(fullPath);
      logger.info('History file deleted', { fileName: safeName, fullPath });
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to delete history file', { fileName: safeName, error: err.message });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });
}

module.exports = registerHistoryRoutes;
