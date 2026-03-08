const fs = require('fs');
const path = require('path');
const { buildDownloadAssetUrl, normalizeRelativePath, resolveDownloadPath, toPosixPath } = require('../utils/downloadPaths');

const INDEX_VERSION = 2;
const DEFAULT_LIMIT = 200;
const HISTORY_MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.ts',
  '.mkv',
  '.mov',
  '.webm',
  '.m4v',
  '.avi',
]);

const TERMINAL_STATUSES = new Set(['completed', 'completed-with-errors', 'failed', 'cancelled']);

function isVideoHistoryFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return HISTORY_MEDIA_EXTENSIONS.has(ext);
}

function isValidHistoryJobId(jobIdPrefix) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)?$/i.test(jobIdPrefix) && jobIdPrefix.length <= 80;
}

function extractHistoryJobId(fileName) {
  const name = String(fileName || '').trim().replace(/[.]part$/i, '');
  if (!name) return null;

  const modernMatch = name.match(/^([a-z0-9]+-[a-z0-9]+)-/i);
  if (modernMatch) {
    return modernMatch[1];
  }

  const legacyMatch = name.match(/^([a-z0-9]+)-/i);
  if (legacyMatch) {
    return legacyMatch[1];
  }

  return null;
}

function deriveLabel(fileName) {
  const dashIndex = fileName.indexOf('-');
  if (dashIndex > 0 && dashIndex < fileName.length - 1) {
    return fileName.slice(dashIndex + 1);
  }
  return fileName;
}

function safeParsePositiveInt(value, fallback, { min = 1, max = 1000 } = {}) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const offset = Number.parseInt(decoded, 10);
    if (!Number.isFinite(offset) || offset < 0) return 0;
    return offset;
  } catch {
    return 0;
  }
}

function encodeHistoryItemId(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  return Buffer.from(source, 'utf8').toString('base64url');
}

function decodeHistoryItemId(value) {
  const encoded = String(value || '').trim();
  if (!encoded) return '';
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    return Buffer.from(decoded, 'utf8').toString('base64url') === encoded
      ? decoded
      : '';
  } catch {
    return '';
  }
}

function getHistoryItemLocator(item) {
  if (!item || typeof item !== 'object') return '';
  const absolutePath = typeof item.absolutePath === 'string' && item.absolutePath.trim()
    ? item.absolutePath.trim()
    : '';
  const safeRelativePath = normalizeRelativePath(item.relativePath || item.fileName);
  return safeRelativePath || absolutePath || String(item.fileName || '').trim();
}

function mergeHistoryItems(existingItem, incomingItem) {
  if (!existingItem) return incomingItem;
  if (!incomingItem) return existingItem;

  return {
    ...incomingItem,
    ...existingItem,
    id: existingItem.id || incomingItem.id,
    fileName: existingItem.fileName || incomingItem.fileName,
    relativePath: existingItem.relativePath || incomingItem.relativePath,
    absolutePath: existingItem.absolutePath || incomingItem.absolutePath,
    label: existingItem.label || incomingItem.label,
    jobId: existingItem.jobId || incomingItem.jobId,
    title: existingItem.title || incomingItem.title,
    sizeBytes: Number(existingItem.sizeBytes || incomingItem.sizeBytes || 0),
    modifiedAt: Math.max(Number(existingItem.modifiedAt || 0), Number(incomingItem.modifiedAt || 0)),
    ext: existingItem.ext || incomingItem.ext,
    thumbnailUrl: incomingItem.thumbnailUrl || existingItem.thumbnailUrl,
    tmdbReleaseDate: existingItem.tmdbReleaseDate || incomingItem.tmdbReleaseDate || null,
    tmdbMetadata: existingItem.tmdbMetadata || incomingItem.tmdbMetadata || null,
    youtubeMetadata: existingItem.youtubeMetadata || incomingItem.youtubeMetadata || null,
  };
}

function normalizeStoredItem(item) {
  if (!item || typeof item.fileName !== 'string') return null;
  const absolutePath = typeof item.absolutePath === 'string' && item.absolutePath.trim()
    ? item.absolutePath.trim()
    : null;
  const rawRelativePath = item.relativePath || item.fileName;
  const safeRelativePath = normalizeRelativePath(rawRelativePath);
  if (!safeRelativePath && !absolutePath) return null;
  const normalized = {
    ...item,
    fileName: path.basename(item.fileName),
    relativePath: safeRelativePath || item.fileName,
    absolutePath,
  };
  const storedId = typeof item.id === 'string' ? item.id.trim() : '';
  const decodedStoredId = storedId ? decodeHistoryItemId(storedId) : '';
  const nextId = (
    decodedStoredId
    && (
      decodedStoredId === normalized.relativePath
      || decodedStoredId === normalized.absolutePath
      || decodedStoredId === normalized.fileName
    )
  )
    ? storedId
    : encodeHistoryItemId(getHistoryItemLocator(normalized));
  return {
    ...normalized,
    id: nextId,
  };
}

class HistoryIndexService {
  constructor(options = {}) {
    const {
      downloadDir,
      fsPromises,
      jobs,
      onChange,
      minRefreshIntervalMs = 1_000,
    } = options;

    if (!downloadDir) {
      throw new Error('HistoryIndexService requires downloadDir');
    }
    if (!fsPromises) {
      throw new Error('HistoryIndexService requires fsPromises');
    }

    this.downloadDir = downloadDir;
    this.fsPromises = fsPromises;
    this.jobs = jobs || new Map();
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.minRefreshIntervalMs = Math.max(1_000, Number(minRefreshIntervalMs) || 5_000);
    this.indexFilePath = path.join(downloadDir, 'history-index.json');
    this.items = [];
    this.lastRefreshAt = 0;
    this.lastSavedAt = 0;
    this.refreshInFlight = null;
  }

  async init() {
    await this.fsPromises.mkdir(this.downloadDir, { recursive: true });
    await this.loadPersistedIndex();
    await this.refreshFromDisk({ force: true });
  }

  async loadPersistedIndex() {
    try {
      const raw = await this.fsPromises.readFile(this.indexFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed
        && (parsed.version === INDEX_VERSION || parsed.version === 1)
        && Array.isArray(parsed.items)
      ) {
        this.items = parsed.items
          .map(normalizeStoredItem)
          .filter(Boolean)
          .sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0));
      } else {
        this.items = [];
      }
    } catch {
      this.items = [];
    }
  }

  async persistIndex() {
    const payload = {
      version: INDEX_VERSION,
      updatedAt: Date.now(),
      items: this.items,
    };
    const tempPath = `${this.indexFilePath}.tmp`;
    await this.fsPromises.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    await this.fsPromises.rename(tempPath, this.indexFilePath);
    this.lastSavedAt = Date.now();
  }

  toRelativePath(absolutePath) {
    if (typeof absolutePath !== 'string' || !absolutePath.trim()) return null;
    const rel = path.relative(this.downloadDir, absolutePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return toPosixPath(rel);
  }

  buildActiveJobFiles() {
    const activeFiles = new Set();
    if (!this.jobs || typeof this.jobs.values !== 'function') {
      return activeFiles;
    }

    for (const job of this.jobs.values()) {
      if (!job) continue;
      const status = String(job.status || job.queueStatus || '');
      if (TERMINAL_STATUSES.has(status)) continue;

      if (job.filePath) {
        const rel = this.toRelativePath(job.filePath);
        if (rel) {
          activeFiles.add(rel);
          activeFiles.add(path.basename(rel));
        }
      }
      if (job.mp4Path) {
        const rel = this.toRelativePath(job.mp4Path);
        if (rel) {
          activeFiles.add(rel);
          activeFiles.add(path.basename(rel));
        }
      }
    }
    return activeFiles;
  }

  buildJobLookup() {
    const byFile = new Map();
    if (!this.jobs || typeof this.jobs.values !== 'function') {
      return byFile;
    }

    for (const job of this.jobs.values()) {
      if (!job) continue;
      if (job.filePath) {
        const rel = this.toRelativePath(job.filePath);
        if (rel) {
          byFile.set(rel, job);
        }
      }
      if (job.mp4Path) {
        const rel = this.toRelativePath(job.mp4Path);
        if (rel) {
          byFile.set(rel, job);
        }
      }
    }
    return byFile;
  }

  async walkMediaFiles(currentDir = this.downloadDir, relativeDir = '') {
    const entries = await this.fsPromises.readdir(currentDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (!entry) continue;
      const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!relativeDir && entry.name.startsWith('temp-')) {
          continue;
        }
        const nested = await this.walkMediaFiles(fullPath, childRelative);
        files.push(...nested);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!isVideoHistoryFile(entry.name)) continue;

      let stat = null;
      try {
        stat = await this.fsPromises.stat(fullPath);
      } catch {
        stat = null;
      }
      if (!stat) continue;

      files.push({
        fullPath,
        relativePath: childRelative,
        fileName: entry.name,
        dirRelative: relativeDir,
        stat,
      });
    }

    return files;
  }

  collectExternalJobMediaFiles() {
    const files = [];
    if (!this.jobs || typeof this.jobs.values !== 'function') {
      return files;
    }

    for (const job of this.jobs.values()) {
      if (!job) continue;
      const status = String(job.queueStatus || job.status || '').trim();
      if (!status || !TERMINAL_STATUSES.has(status)) continue;

      const candidatePath = job.mp4Path && fs.existsSync(job.mp4Path) ? job.mp4Path : job.filePath;
      if (typeof candidatePath !== 'string' || !candidatePath.trim()) continue;
      if (!fs.existsSync(candidatePath)) continue;
      const relative = this.toRelativePath(candidatePath);
      if (relative) continue;

      try {
        const stat = fs.statSync(candidatePath);
        if (!stat.isFile()) continue;
        files.push({
          fullPath: candidatePath,
          absolutePath: candidatePath,
          relativePath: path.basename(candidatePath),
          fileName: path.basename(candidatePath),
          dirRelative: '',
          stat,
          job,
        });
      } catch {
        continue;
      }
    }

    return files;
  }

  collectPersistedExternalMediaFiles() {
    const files = [];
    const seen = new Set();

    for (const item of this.items) {
      if (!item || typeof item.absolutePath !== 'string' || !item.absolutePath.trim()) continue;
      const absolutePath = item.absolutePath.trim();
      const relative = this.toRelativePath(absolutePath);
      if (relative) continue;
      if (seen.has(absolutePath)) continue;
      if (!fs.existsSync(absolutePath)) continue;

      try {
        const stat = fs.statSync(absolutePath);
        if (!stat.isFile()) continue;
        files.push({
          fullPath: absolutePath,
          absolutePath,
          relativePath: path.basename(absolutePath),
          fileName: path.basename(absolutePath),
          dirRelative: '',
          stat,
          persistedItem: item,
        });
        seen.add(absolutePath);
      } catch {
        continue;
      }
    }

    return files;
  }

  findThumbnailUrl({ validJobId, dirAbsolute, dirRelative, job, persistedItem }) {
    const localThumbCandidates = [];
    if (validJobId) {
      localThumbCandidates.push(`${validJobId}-thumb.jpg`);
    }
    if (job && typeof job.thumbnailPath === 'string' && job.thumbnailPath.trim()) {
      localThumbCandidates.push(path.basename(job.thumbnailPath));
    }

    for (const thumbName of localThumbCandidates) {
      const sameDirPath = path.join(dirAbsolute, thumbName);
      if (fs.existsSync(sameDirPath)) {
        const thumbRelative = dirRelative ? `${dirRelative}/${thumbName}` : thumbName;
        return `/downloads/${toPosixPath(thumbRelative)}`;
      }

      const legacyPath = path.join(this.downloadDir, thumbName);
      if (fs.existsSync(legacyPath)) {
        return `/downloads/${thumbName}`;
      }
    }

    if (job && typeof job.thumbnailPath === 'string' && job.thumbnailPath.trim() && fs.existsSync(job.thumbnailPath)) {
      const url = buildDownloadAssetUrl(this.downloadDir, job.thumbnailPath);
      if (url) return url;
    }

    if (job && Array.isArray(job.thumbnailPaths)) {
      for (const thumbPath of job.thumbnailPaths) {
        if (typeof thumbPath !== 'string') continue;
        if (!fs.existsSync(thumbPath)) continue;
        const url = buildDownloadAssetUrl(this.downloadDir, thumbPath);
        if (url) return url;
      }
    }

    const persistedThumbCandidates = [];
    if (persistedItem && typeof persistedItem.thumbnailUrl === 'string') {
      persistedThumbCandidates.push(persistedItem.thumbnailUrl);
    }

    for (const candidate of persistedThumbCandidates) {
      const value = String(candidate || '').trim();
      if (!value) continue;
      if (/^https?:\/\//i.test(value)) {
        return value;
      }
      if (value.startsWith('/downloads/')) {
        const relative = value.slice('/downloads/'.length);
        const resolved = resolveDownloadPath(this.downloadDir, relative);
        if (resolved && fs.existsSync(resolved)) {
          return `/downloads/${toPosixPath(relative)}`;
        }
      }
    }

    if (
      job
      && Array.isArray(job.thumbnailUrls)
      && job.thumbnailUrls.length > 0
      && typeof job.thumbnailUrls[0] === 'string'
    ) {
      return job.thumbnailUrls[0];
    }

    return null;
  }

  buildItem(mediaFile, filesByDir, activeJobFiles, jobLookup) {
    const fileName = mediaFile.fileName;
    const relativePath = toPosixPath(mediaFile.relativePath);
    const ext = path.extname(fileName).toLowerCase();
    const dirRelative = mediaFile.dirRelative || '';
    const dirAbsolute = path.dirname(mediaFile.fullPath);

    if (ext === '.ts') {
      const mp4Variant = fileName.replace(/\.ts$/i, '.mp4');
      const siblingNames = filesByDir.get(dirRelative) || new Set();
      if (siblingNames.has(mp4Variant)) return null;
      if (activeJobFiles.has(relativePath) || activeJobFiles.has(fileName)) return null;
    }

    const extractedJobId = extractHistoryJobId(fileName);
    const validJobId = extractedJobId && isValidHistoryJobId(extractedJobId)
      ? extractedJobId
      : null;
    const persistedItem = mediaFile.persistedItem || null;
    const job = mediaFile.job
      || jobLookup.get(relativePath)
      || (validJobId ? this.jobs.get(validJobId) : null)
      || null;
    const resolvedJobId = (job && job.id) || validJobId || null;

    if (resolvedJobId) {
      const associatedJob = this.jobs.get(resolvedJobId) || job;
      if (associatedJob) {
        const associatedStatus = String(associatedJob.queueStatus || associatedJob.status || '').trim();
        if (associatedStatus && !TERMINAL_STATUSES.has(associatedStatus)) {
          return null;
        }
      }
    }

    const thumbnailUrl = this.findThumbnailUrl({
      validJobId: resolvedJobId,
      dirAbsolute,
      dirRelative,
      job,
      persistedItem,
    });

    return {
      id: encodeHistoryItemId(mediaFile.absolutePath || relativePath),
      fileName,
      relativePath,
      absolutePath: mediaFile.absolutePath || mediaFile.fullPath,
      label: deriveLabel(fileName),
      jobId: resolvedJobId,
      title: (job && job.title) || (persistedItem && persistedItem.title) || null,
      sizeBytes: Number(mediaFile.stat.size || 0),
      modifiedAt: Number(mediaFile.stat.mtimeMs || Date.now()),
      ext,
      thumbnailUrl,
      tmdbReleaseDate: (job && job.tmdbReleaseDate) || (persistedItem && persistedItem.tmdbReleaseDate) || null,
      tmdbMetadata: (job && job.tmdbMetadata) || (persistedItem && persistedItem.tmdbMetadata) || null,
      youtubeMetadata: (job && job.youtubeMetadata) || (persistedItem && persistedItem.youtubeMetadata) || null,
    };
  }

  static buildSignature(items) {
    return items
      .map((item) => `${item.absolutePath || item.relativePath || item.fileName}:${item.sizeBytes}:${item.modifiedAt}:${item.thumbnailUrl || ''}`)
      .join('|');
  }

  async refreshFromDisk(options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    if (!force && now - this.lastRefreshAt < this.minRefreshIntervalMs) {
      return { changed: false, reason: 'throttled' };
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      this.lastRefreshAt = Date.now();

      const mediaFiles = await this.walkMediaFiles();
      mediaFiles.push(...this.collectExternalJobMediaFiles());
      mediaFiles.push(...this.collectPersistedExternalMediaFiles());
      const filesByDir = new Map();
      for (const mediaFile of mediaFiles) {
        const key = mediaFile.dirRelative || '';
        if (!filesByDir.has(key)) {
          filesByDir.set(key, new Set());
        }
        filesByDir.get(key).add(mediaFile.fileName);
      }

      const activeJobFiles = this.buildActiveJobFiles();
      const jobLookup = this.buildJobLookup();

      const nextItemsByLocator = new Map();
      for (const mediaFile of mediaFiles) {
        const item = this.buildItem(mediaFile, filesByDir, activeJobFiles, jobLookup);
        if (!item) continue;

        const locator = getHistoryItemLocator(item);
        if (!locator) continue;

        const existing = nextItemsByLocator.get(locator);
        nextItemsByLocator.set(locator, mergeHistoryItems(existing, item));
      }

      const nextItems = Array.from(nextItemsByLocator.values());

      nextItems.sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0));

      const currentSignature = HistoryIndexService.buildSignature(this.items);
      const nextSignature = HistoryIndexService.buildSignature(nextItems);

      if (currentSignature === nextSignature) {
        return { changed: false, reason: 'unchanged' };
      }

      this.items = nextItems;
      await this.persistIndex();
      this.emitChange('refresh');
      return { changed: true };
    })().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  emitChange(reason) {
    if (!this.onChange) return;
    try {
      this.onChange({
        reason,
        changedAt: Date.now(),
        total: this.items.length,
      });
    } catch {
      // Ignore observer failures.
    }
  }

  async list(options = {}) {
    await this.refreshFromDisk({ force: this.items.length === 0 });

    const limit = safeParsePositiveInt(options.limit, DEFAULT_LIMIT, { min: 1, max: 1_000 });
    const offset = decodeCursor(options.cursor);
    const nextOffset = offset + limit;
    const slice = this.items.slice(offset, nextOffset);
    const nextCursor = nextOffset < this.items.length ? encodeCursor(nextOffset) : null;

    return {
      items: slice,
      total: this.items.length,
      nextCursor,
    };
  }

  findByFileName(fileName) {
    const safeName = path.basename(String(fileName || ''));
    if (!safeName) return null;
    return this.items.find((item) => item.fileName === safeName) || null;
  }

  findById(historyId) {
    const safeId = String(historyId || '').trim();
    if (!safeId) return null;

    const exact = this.items.find((item) => item.id === safeId);
    if (exact) return exact;

    const decoded = decodeHistoryItemId(safeId);
    if (!decoded) {
      return this.findByFileName(safeId);
    }

    const safeRelative = normalizeRelativePath(decoded);
    if (safeRelative) {
      const byRelative = this.items.find((item) => item.relativePath === safeRelative);
      if (byRelative) return byRelative;
    }

    const byAbsolute = this.items.find((item) => item.absolutePath === decoded);
    if (byAbsolute) return byAbsolute;

    return this.findByFileName(decoded);
  }

  resolveFilePath(historyId) {
    const item = this.findById(historyId);
    if (!item) return null;
    if (item.absolutePath && fs.existsSync(item.absolutePath)) {
      return item.absolutePath;
    }
    const safeRelative = normalizeRelativePath(item.relativePath || item.fileName);
    if (!safeRelative) return null;
    const resolved = path.resolve(this.downloadDir, safeRelative);
    const relative = path.relative(this.downloadDir, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return resolved;
  }

  async removeById(historyId) {
    const item = this.findById(historyId);
    if (!item) return false;
    const before = this.items.length;
    this.items = this.items.filter((candidate) => candidate.id !== item.id);
    if (this.items.length === before) return false;
    await this.persistIndex();
    this.emitChange('delete');
    return true;
  }

  async removeByFileNames(fileNames) {
    if (!Array.isArray(fileNames) || fileNames.length === 0) return 0;
    const safeNames = new Set(fileNames.map((name) => path.basename(String(name || ''))).filter(Boolean));
    if (safeNames.size === 0) return 0;
    const before = this.items.length;
    this.items = this.items.filter((item) => !safeNames.has(item.fileName));
    const removed = before - this.items.length;
    if (removed > 0) {
      await this.persistIndex();
      this.emitChange('delete-many');
    }
    return removed;
  }

  async clear() {
    if (this.items.length === 0) return;
    this.items = [];
    await this.persistIndex();
    this.emitChange('clear');
  }
}

module.exports = {
  HistoryIndexService,
  decodeHistoryItemId,
  encodeHistoryItemId,
};
