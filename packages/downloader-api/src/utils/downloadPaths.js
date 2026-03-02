const path = require('path');

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function safeJobIdSegment(jobId) {
  return String(jobId || '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'job';
}

function buildJobStorageDir(downloadDir, jobId) {
  return path.join(downloadDir, safeJobIdSegment(jobId));
}

function normalizeRelativePath(value) {
  const normalized = toPosixPath(String(value || '').replace(/^[/\\]+/, ''));
  if (!normalized || normalized.includes('..') || normalized.includes('\0')) {
    return null;
  }
  return normalized;
}

function isInsideDirectory(rootDir, absolutePath) {
  const relative = path.relative(rootDir, absolutePath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function buildDownloadAssetUrl(downloadDir, absolutePath) {
  if (typeof absolutePath !== 'string' || !absolutePath.trim()) return null;
  const resolvedRoot = path.resolve(downloadDir);
  const resolvedTarget = path.resolve(absolutePath);
  if (!isInsideDirectory(resolvedRoot, resolvedTarget)) {
    return `/downloads/${path.basename(resolvedTarget)}`;
  }
  const relative = toPosixPath(path.relative(resolvedRoot, resolvedTarget));
  return `/downloads/${relative}`;
}

function resolveDownloadPath(downloadDir, relativePath) {
  const safeRelative = normalizeRelativePath(relativePath);
  if (!safeRelative) return null;
  const fullPath = path.resolve(downloadDir, safeRelative);
  if (!isInsideDirectory(path.resolve(downloadDir), fullPath)) {
    return null;
  }
  return fullPath;
}

module.exports = {
  buildDownloadAssetUrl,
  buildJobStorageDir,
  normalizeRelativePath,
  resolveDownloadPath,
  safeJobIdSegment,
  toPosixPath,
};
