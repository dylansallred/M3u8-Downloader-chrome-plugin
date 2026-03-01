// Centralized configuration for the m3u8-downloader server.
// Keeps default values aligned with previous hard-coded settings.

const DEFAULT_PORT = process.env.PORT || 3000;
const DEFAULT_CLEANUP_AGE_HOURS = 3; // temp segments
const DEFAULT_DOWNLOAD_RETENTION_HOURS = 24 * 14; // 14 days for completed files
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function resolveDefaultMaxConcurrent() {
  const os = require('os');
  try {
    const cores = os.cpus()?.length || 4;
    return Math.min(16, Math.max(2, cores));
  } catch {
    return 4;
  }
}

const DEFAULT_MAX_CONCURRENT = resolveDefaultMaxConcurrent();
const DEFAULT_MAX_SEGMENT_ATTEMPTS = 30;

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

module.exports = {
  port: DEFAULT_PORT,
  cleanupAgeHours: DEFAULT_CLEANUP_AGE_HOURS,
  downloadRetentionHours: DEFAULT_DOWNLOAD_RETENTION_HOURS,
  cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
  defaultMaxConcurrent: DEFAULT_MAX_CONCURRENT,
  defaultMaxSegmentAttempts: DEFAULT_MAX_SEGMENT_ATTEMPTS,
  tmdbApiKey: TMDB_API_KEY,
};
