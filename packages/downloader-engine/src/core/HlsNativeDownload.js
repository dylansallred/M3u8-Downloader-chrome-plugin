const { URL } = require('url');
const { buildFfmpegMetadataArgs } = require('../utils/mediaTags');

function buildHlsRequestHeaders(headers = {}) {
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = String(rawKey || '').trim();
    const value = String(rawValue || '').trim();
    if (!key || !value) continue;
    normalized[key] = value;
  }

  // Force revalidation for HLS playlists/segments to avoid stale CDN or proxy cache hits.
  normalized['Cache-Control'] = 'no-cache';
  normalized.Pragma = 'no-cache';
  return normalized;
}

function inspectHlsPlaylist(playlistText, playlistUrl) {
  const lines = String(playlistText || '').split(/\r?\n/);
  const segments = [];
  let totalDurationSeconds = 0;
  let hasDiscontinuity = false;
  let hasMap = false;
  let hasByteRange = false;
  let hasFmp4Segments = false;
  let isMasterPlaylist = false;

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;

    if (/^#EXT-X-STREAM-INF:/i.test(trimmed) || /^#EXT-X-MEDIA:/i.test(trimmed)) {
      isMasterPlaylist = true;
      continue;
    }

    if (/^#EXT-X-DISCONTINUITY\b/i.test(trimmed)) {
      hasDiscontinuity = true;
      continue;
    }

    if (/^#EXT-X-MAP:/i.test(trimmed)) {
      hasMap = true;
      if (/\bURI="[^"]+\.(?:mp4|m4s|cmf[av])(?:[?#][^"]*)?"/i.test(trimmed)) {
        hasFmp4Segments = true;
      }
      continue;
    }

    if (/^#EXT-X-BYTERANGE:/i.test(trimmed)) {
      hasByteRange = true;
      continue;
    }

    const extInfMatch = trimmed.match(/^#EXTINF:([0-9.]+)/i);
    if (extInfMatch) {
      const duration = Number.parseFloat(extInfMatch[1]);
      if (Number.isFinite(duration) && duration > 0) {
        totalDurationSeconds += duration;
      }
      continue;
    }

    if (trimmed.startsWith('#')) {
      continue;
    }

    try {
      const segmentUrl = new URL(trimmed, playlistUrl).toString();
      segments.push(segmentUrl);
      if (/\.(?:m4s|mp4|cmfa|cmfv)(?:[?#].*)?$/i.test(segmentUrl)) {
        hasFmp4Segments = true;
      }
    } catch {
      // Ignore malformed entries.
    }
  }

  const hasAdvancedFeatures = (
    isMasterPlaylist
    || hasDiscontinuity
    || hasMap
    || hasByteRange
    || hasFmp4Segments
  );

  return {
    segments,
    totalSegments: segments.length,
    totalDurationSeconds,
    hasDiscontinuity,
    hasMap,
    hasByteRange,
    hasFmp4Segments,
    isMasterPlaylist,
    hasAdvancedFeatures,
  };
}

function shouldPreferNativeHlsDownload(playlistInfo) {
  return !!(playlistInfo && playlistInfo.hasAdvancedFeatures);
}

function buildFfmpegHeaderBlob(headers = {}) {
  const blockedHeaders = new Set([
    'connection',
    'content-length',
    'host',
    'transfer-encoding',
  ]);

  const entries = [];
  for (const [rawKey, rawValue] of Object.entries(buildHlsRequestHeaders(headers))) {
    const key = String(rawKey || '').trim();
    const value = String(rawValue || '').trim();
    if (!key || !value) continue;
    if (blockedHeaders.has(key.toLowerCase())) continue;
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) continue;
    entries.push(`${key}: ${value}`);
  }

  if (entries.length === 0) {
    return '';
  }

  return `${entries.join('\r\n')}\r\n`;
}

function buildNativeHlsArgs({ job, playlistUrl, outputPath, headers }) {
  const metadataArgs = buildFfmpegMetadataArgs(job);
  const headerBlob = buildFfmpegHeaderBlob(headers);
  const args = [
    '-y',
    '-nostdin',
    '-loglevel', 'warning',
    '-nostats',
    '-progress', 'pipe:2',
  ];

  if (headerBlob) {
    args.push('-headers', headerBlob);
  }

  args.push(
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-i', playlistUrl,
    '-map', '0',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-max_interleave_delta', '0',
    ...metadataArgs,
    outputPath,
  );

  return args;
}

module.exports = {
  buildHlsRequestHeaders,
  inspectHlsPlaylist,
  shouldPreferNativeHlsDownload,
  buildFfmpegHeaderBlob,
  buildNativeHlsArgs,
};
