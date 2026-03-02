const MAX_ITEMS_PER_TAB = 60;
const MAX_PAGE_TITLE_CANDIDATES = 24;
const MAX_RESOURCE_SIGNALS = 20;
const SEGMENT_MANIFEST_CACHE_TTL_MS = 2 * 60 * 1000;
const SEGMENT_MANIFEST_CACHE_MAX = 300;
const STREAM_SESSION_TTL_MS = 10 * 60 * 1000;
const STREAM_SESSION_KEY_PREFIX = 'streamSession:';

const segmentManifestCache = new Map();
const segmentManifestInflight = new Map();

function getStorageKey(tabId) {
  return `storage${tabId}`;
}

function getStreamSessionKey(sessionId) {
  return `${STREAM_SESSION_KEY_PREFIX}${sessionId}`;
}

function sanitizeText(value, max = 255) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function cleanYoutubeTitleText(value, max = 255) {
  return sanitizeText(String(value || ''), max)
    .replace(/^\(\d+\)\s*/, '')
    .replace(/^\[\d+\]\s*/, '')
    .replace(/\s*[-|]\s*youtube\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeRequestHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const blocked = new Set([
    'origin',
    'referer',
    'host',
    'user-agent',
    'cookie',
    'content-length',
    'connection',
  ]);

  const output = {};
  const entries = Object.entries(headers);
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey || '').trim();
    const value = String(rawValue || '').trim();
    if (!key || !value) continue;
    const lower = key.toLowerCase();
    if (blocked.has(lower)) continue;
    if (lower.startsWith('sec-')) continue;
    if (lower.startsWith('proxy-')) continue;
    if (lower.startsWith(':')) continue;
    output[key.slice(0, 64)] = value.slice(0, 1000);
    if (Object.keys(output).length >= 30) break;
  }
  return output;
}

function sanitizePageTitleCandidates(value) {
  if (!Array.isArray(value)) return [];
  const output = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const source = sanitizeText(entry.source, 64);
    const text = sanitizeText(entry.value, 200);
    const normalized = sanitizeText(entry.normalized, 200);
    if (!text) continue;
    output.push({
      source: source || 'unknown',
      value: text,
      normalized: normalized || text,
    });
    if (output.length >= MAX_PAGE_TITLE_CANDIDATES) break;
  }

  return output;
}

function sanitizePageEpisodeHint(value) {
  if (!value || typeof value !== 'object') return null;
  const seasonRaw = Number(value.seasonNumber);
  const episodeRaw = Number(value.episodeNumber);
  const seasonNumber = Number.isFinite(seasonRaw) && seasonRaw > 0
    ? Math.min(60, Math.floor(seasonRaw))
    : null;
  const episodeNumber = Number.isFinite(episodeRaw) && episodeRaw > 0
    ? Math.min(999, Math.floor(episodeRaw))
    : null;
  const matchedPattern = sanitizeText(value.matchedPattern, 64);
  const matchedText = sanitizeText(value.matchedText, 120);
  const source = sanitizeText(value.source, 64);

  if (!seasonNumber && !episodeNumber && !matchedPattern && !matchedText) {
    return null;
  }

  return {
    source: source || 'unknown',
    matchedPattern: matchedPattern || null,
    matchedText: matchedText || null,
    seasonNumber,
    episodeNumber,
  };
}

function sanitizeResourceSignals(value) {
  if (!Array.isArray(value)) return [];
  const output = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const url = sanitizeText(entry.url, 240);
    const source = sanitizeText(entry.source, 64);
    const matchedPattern = sanitizeText(entry.matchedPattern, 64);
    const seasonRaw = Number(entry.seasonNumber);
    const episodeRaw = Number(entry.episodeNumber);
    const seasonNumber = Number.isFinite(seasonRaw) && seasonRaw > 0
      ? Math.min(60, Math.floor(seasonRaw))
      : null;
    const episodeNumber = Number.isFinite(episodeRaw) && episodeRaw > 0
      ? Math.min(999, Math.floor(episodeRaw))
      : null;

    if (!url && !matchedPattern && !seasonNumber && !episodeNumber) continue;

    output.push({
      url: url || '',
      source: source || 'unknown',
      matchedPattern: matchedPattern || null,
      seasonNumber,
      episodeNumber,
    });
    if (output.length >= MAX_RESOURCE_SIGNALS) break;
  }

  return output;
}

function sanitizeYoutubeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const videoId = sanitizeText(value.videoId, 32);
  const title = cleanYoutubeTitleText(value.title, 255);
  const channelName = sanitizeText(value.channelName, 180);
  const channelUrl = sanitizeText(value.channelUrl, 4096);
  const channelId = sanitizeText(value.channelId, 80);
  const uploadDate = sanitizeText(value.uploadDate, 64);
  const thumbnailUrl = sanitizeText(value.thumbnailUrl, 4096);
  const description = sanitizeText(value.description, 800);
  const durationSecondsRaw = Number(value.durationSeconds);
  const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
    ? Math.min(24 * 60 * 60, Math.floor(durationSecondsRaw))
    : null;
  const viewCountRaw = Number(value.viewCount);
  const viewCount = Number.isFinite(viewCountRaw) && viewCountRaw > 0
    ? Math.min(9_999_999_999_999, Math.floor(viewCountRaw))
    : null;

  if (
    !videoId
    && !title
    && !channelName
    && !channelUrl
    && !channelId
    && !uploadDate
    && !thumbnailUrl
    && !description
    && !durationSeconds
    && !viewCount
  ) {
    return null;
  }

  return {
    videoId: videoId || '',
    title: title || '',
    channelName: channelName || '',
    channelUrl: channelUrl || '',
    channelId: channelId || '',
    uploadDate: uploadDate || '',
    thumbnailUrl: thumbnailUrl || '',
    description: description || '',
    durationSeconds,
    viewCount,
  };
}

function extractFilenameFromUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const parts = String(parsed.pathname || '').split('/').filter(Boolean);
    if (parts.length === 0) return '';
    return decodeURIComponent(parts[parts.length - 1]);
  } catch {
    return '';
  }
}

function toAbsoluteSiblingUrl(rawUrl, siblingFileName) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const parts = String(parsed.pathname || '').split('/');
    parts[parts.length - 1] = siblingFileName;
    parsed.pathname = parts.join('/');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function deriveManifestCandidatesFromSegmentUrl(segmentUrl) {
  const filename = extractFilenameFromUrl(segmentUrl);
  if (!filename) return [];

  const extMatch = filename.match(/\.(ts|m4s|m4f|cmfa|cmfv)$/i);
  if (!extMatch) return [];

  const stem = filename.slice(0, -extMatch[0].length);
  const candidateNames = [];
  const addCandidateName = (name) => {
    const value = String(name || '').trim();
    if (!value || candidateNames.includes(value)) return;
    candidateNames.push(value);
  };

  addCandidateName(`${stem.replace(/_\d+$/, '')}.m3u8`);
  addCandidateName(`${stem.replace(/(?:_\d+){1,2}$/, '')}.m3u8`);
  addCandidateName(`${stem}.m3u8`);

  if (/^index(?:_\d+)?$/i.test(stem)) {
    addCandidateName('index.m3u8');
    addCandidateName('playlist.m3u8');
    addCandidateName('master.m3u8');
  }

  return candidateNames
    .map((name) => toAbsoluteSiblingUrl(segmentUrl, name))
    .filter(Boolean);
}

function buildSegmentBucketKey(segmentUrl) {
  const filename = extractFilenameFromUrl(segmentUrl);
  if (!filename) return String(segmentUrl || '');
  const normalized = filename
    .replace(/\.(ts|m4s|m4f|cmfa|cmfv)$/i, '')
    .replace(/_\d+$/, '');
  return toAbsoluteSiblingUrl(segmentUrl, `${normalized}.bucket`) || String(segmentUrl || '');
}

async function probeManifestUrl(candidateUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(candidateUrl, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) return false;

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('mpegurl')) return true;

    const bodyText = await response.text();
    return /^#EXTM3U/m.test(bodyText);
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function setSegmentManifestCache(bucketKey, manifestUrl) {
  segmentManifestCache.set(bucketKey, {
    manifestUrl: manifestUrl || null,
    expiresAt: Date.now() + SEGMENT_MANIFEST_CACHE_TTL_MS,
  });

  if (segmentManifestCache.size <= SEGMENT_MANIFEST_CACHE_MAX) return;
  const oldestKey = segmentManifestCache.keys().next().value;
  if (oldestKey) segmentManifestCache.delete(oldestKey);
}

async function resolveManifestFromSegmentUrl(segmentUrl) {
  const bucketKey = buildSegmentBucketKey(segmentUrl);
  const now = Date.now();
  const cached = segmentManifestCache.get(bucketKey);
  if (cached && cached.expiresAt > now) {
    return cached.manifestUrl || null;
  }

  if (segmentManifestInflight.has(bucketKey)) {
    return segmentManifestInflight.get(bucketKey);
  }

  const task = (async () => {
    const candidates = deriveManifestCandidatesFromSegmentUrl(segmentUrl);
    for (const candidateUrl of candidates) {
      if (await probeManifestUrl(candidateUrl)) {
        setSegmentManifestCache(bucketKey, candidateUrl);
        return candidateUrl;
      }
    }
    const fallbackGuess = candidates[0] || null;
    setSegmentManifestCache(bucketKey, fallbackGuess);
    return fallbackGuess;
  })().finally(() => {
    segmentManifestInflight.delete(bucketKey);
  });

  segmentManifestInflight.set(bucketKey, task);
  return task;
}

async function normalizeMedia(item = {}) {
  const originalUrl = String(item.url || '').trim();
  if (!originalUrl) return null;

  const matchedBy = Array.isArray(item.matchedBy) ? [...item.matchedBy] : [];
  let url = originalUrl;
  let contentType = String(item.contentType || '');
  let contentLength = Number(item.contentLength || 0);
  let filename = item.filename || extractFilenameFromUrl(url) || 'media';
  let fallbackUrl = '';

  const incomingMediaKind = String(item.mediaKind || '').trim().toLowerCase();
  const isSegment = incomingMediaKind === 'segment' || isLikelySegmentUrl(originalUrl);

  if (isSegment) {
    const inferredManifestUrl = await resolveManifestFromSegmentUrl(originalUrl);
    if (!inferredManifestUrl) {
      // Avoid flooding the list with raw HLS segments if no manifest can be inferred.
      return null;
    }

    url = inferredManifestUrl;
    filename = extractFilenameFromUrl(inferredManifestUrl) || 'index.m3u8';
    contentType = 'application/vnd.apple.mpegurl';
    contentLength = 0;
    fallbackUrl = originalUrl;
    if (!matchedBy.includes('segment-manifest-inference')) {
      matchedBy.push('segment-manifest-inference');
    }
  }

  const normalizedContentType = String(contentType || '').toLowerCase();
  const isHls = /\.m3u8(\?|$)/i.test(url) || normalizedContentType.includes('mpegurl');
  const isDash = /\.mpd(\?|$)/i.test(url) || normalizedContentType.includes('dash+xml');
  const mediaKind = isSegment
    ? 'hls-manifest-inferred'
    : (String(item.mediaKind || '').trim() || (isHls ? 'hls-manifest' : (isDash ? 'dash-manifest' : 'video')));

  return {
    id: item.requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    method: item.method || 'GET',
    statusCode: Number(item.statusCode || 0) || null,
    contentType,
    contentLength,
    contentDisposition: String(item.contentDisposition || ''),
    filename,
    requestHeaders: item.requestHeaders || {},
    detectedAt: item.detectedAt || Date.now(),
    type: isHls ? 'hls' : 'file',
    streamType: isHls ? 'hls' : (isDash ? 'dash' : null),
    mediaKind,
    matchedBy,
    sourcePageTitle: String(item.sourcePageTitle || '').trim(),
    sourcePageUrl: String(item.sourcePageUrl || '').trim(),
    pageTitleCandidates: sanitizePageTitleCandidates(item.pageTitleCandidates),
    resourceSignals: sanitizeResourceSignals(item.resourceSignals),
    pageEpisodeHint: sanitizePageEpisodeHint(item.pageEpisodeHint),
    youtubeMetadata: sanitizeYoutubeMetadata(item.youtubeMetadata),
    pageIsTvContext: Boolean(item.pageIsTvContext),
    pageContextCollectedAt: Number(item.pageContextCollectedAt || 0) || null,
    fallbackUrl: fallbackUrl || (item.fallbackUrl || ''),
  };
}

function isLikelySegmentUrl(url) {
  return /\.(ts|m4s)(\?|$)/i.test(String(url || ''));
}

function normalizeYoutubeVideoId(value) {
  const candidate = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(candidate)) {
    return '';
  }
  return candidate;
}

function isYoutubeHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return host === 'youtu.be'
    || host.endsWith('.youtu.be')
    || host === 'youtube.com'
    || host.endsWith('.youtube.com');
}

function parseYoutubeVideoFromUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (!isYoutubeHost(parsed.hostname)) {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    const pathParts = String(parsed.pathname || '').split('/').filter(Boolean);
    let videoId = '';
    let pageType = 'watch';

    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      videoId = normalizeYoutubeVideoId(pathParts[0] || '');
      pageType = 'short-link';
    } else {
      const firstPart = String(pathParts[0] || '').toLowerCase();
      if (firstPart === 'watch') {
        videoId = normalizeYoutubeVideoId(parsed.searchParams.get('v') || '');
        pageType = 'watch';
      } else if (firstPart === 'shorts' || firstPart === 'live' || firstPart === 'embed') {
        videoId = normalizeYoutubeVideoId(pathParts[1] || '');
        pageType = firstPart;
      }
    }

    if (!videoId) {
      return null;
    }

    return {
      videoId,
      pageType,
      canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    };
  } catch {
    return null;
  }
}

function createYoutubePageMedia(tabId, tabUrl, tabTitle) {
  const detection = parseYoutubeVideoFromUrl(tabUrl);
  if (!detection) {
    return null;
  }

  const sourcePageUrl = sanitizeText(tabUrl, 4096);
  const sourcePageTitle = sanitizeText(tabTitle, 255);
  const cleanedTitle = cleanYoutubeTitleText(sourcePageTitle, 255);

  return {
    id: `youtube-${tabId}-${detection.videoId}`,
    url: detection.canonicalUrl,
    method: 'PAGE_URL',
    statusCode: 200,
    contentType: 'video/youtube',
    contentLength: 0,
    contentDisposition: '',
    filename: `${detection.videoId}.youtube`,
    requestHeaders: {},
    detectedAt: Date.now(),
    type: 'file',
    streamType: null,
    mediaKind: 'youtube-page',
    matchedBy: ['tab-url-youtube'],
    sourcePageTitle,
    sourcePageUrl: sourcePageUrl || detection.canonicalUrl,
    pageTitleCandidates: sourcePageTitle
      ? [{ source: 'tab.title', value: sourcePageTitle, normalized: sourcePageTitle }]
      : [],
    resourceSignals: [],
    pageEpisodeHint: null,
    youtubeMetadata: {
      videoId: detection.videoId,
      title: cleanedTitle,
      channelName: '',
      channelUrl: '',
      channelId: '',
      uploadDate: '',
      thumbnailUrl: '',
      description: '',
      durationSeconds: null,
      viewCount: null,
    },
    pageIsTvContext: false,
    pageContextCollectedAt: Date.now(),
    fallbackUrl: '',
  };
}

async function detectYoutubePageForTab(tabId, tabUrl, tabTitle = '') {
  const safeTabId = Number(tabId);
  if (!Number.isFinite(safeTabId) || safeTabId <= 0) {
    return { ok: false, error: 'Invalid tab id' };
  }

  const media = createYoutubePageMedia(safeTabId, tabUrl, tabTitle);
  if (!media) {
    return { ok: true, ignored: true };
  }

  return storeMedia(safeTabId, media);
}

function isDirectFallbackCandidate(item) {
  if (!item || item.type !== 'file') return false;

  const url = String(item.url || '');
  const contentType = String(item.contentType || '').toLowerCase();
  const mediaKind = String(item.mediaKind || '').toLowerCase();

  if (isLikelySegmentUrl(url)) return false;
  if (/\.m3u8(\?|$)/i.test(url)) return false;
  if (mediaKind.startsWith('audio') || mediaKind === 'dash-manifest') return false;

  // Prefer full video assets over manifest/chunk requests.
  if (/\.(mp4|m4v|mov|webm|mkv|avi|flv|f4v|wmv|asf|m2ts|mts|mpg|mpeg|3gp|3g2|ogv|ogm|mxf)(\?|$)/i.test(url)) return true;
  if (contentType.startsWith('video/') && !contentType.includes('mpegurl')) return true;
  return false;
}

function attachFallbackUrls(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const directCandidates = items
    .filter(isDirectFallbackCandidate)
    .sort((a, b) => {
      // Prefer larger direct assets, then recency.
      const sizeA = Number(a.contentLength || 0);
      const sizeB = Number(b.contentLength || 0);
      if (sizeA !== sizeB) return sizeB - sizeA;
      return Number(b.detectedAt || 0) - Number(a.detectedAt || 0);
    });

  const fallback = directCandidates[0] || null;
  if (!fallback) return items;

  return items.map((item) => {
    if (!item || item.type !== 'hls') return item;
    return {
      ...item,
      fallbackUrl: fallback.url,
    };
  });
}

function mergeStringField(currentValue, nextValue) {
  const current = String(currentValue || '').trim();
  const next = String(nextValue || '').trim();
  if (!next) return current;
  if (!current) return next;
  return next.length >= current.length ? next : current;
}

function mergeArrayField(currentValue, nextValue) {
  const current = Array.isArray(currentValue) ? currentValue : [];
  const next = Array.isArray(nextValue) ? nextValue : [];
  if (next.length === 0) return current;
  if (current.length === 0) return next;
  return next.length >= current.length ? next : current;
}

function mergeObjectField(currentValue, nextValue) {
  const current = currentValue && typeof currentValue === 'object' ? currentValue : null;
  const next = nextValue && typeof nextValue === 'object' ? nextValue : null;
  if (!next) return current;
  if (!current) return next;

  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (value == null || value === '') continue;
    merged[key] = value;
  }
  return merged;
}

function mergeMediaItems(existingItem, incomingItem) {
  const existing = existingItem && typeof existingItem === 'object' ? existingItem : {};
  const incoming = incomingItem && typeof incomingItem === 'object' ? incomingItem : {};

  const mergedMatchedBy = Array.from(new Set([
    ...(Array.isArray(existing.matchedBy) ? existing.matchedBy : []),
    ...(Array.isArray(incoming.matchedBy) ? incoming.matchedBy : []),
  ]));

  const mergedMediaKind = mergeStringField(existing.mediaKind, incoming.mediaKind);
  const isYoutubePage = String(mergedMediaKind || '').toLowerCase() === 'youtube-page';

  return {
    ...existing,
    ...incoming,
    id: mergeStringField(existing.id, incoming.id) || existing.id || incoming.id || '',
    url: mergeStringField(existing.url, incoming.url) || '',
    filename: mergeStringField(existing.filename, incoming.filename),
    sourcePageTitle: mergeStringField(existing.sourcePageTitle, incoming.sourcePageTitle),
    sourcePageUrl: mergeStringField(existing.sourcePageUrl, incoming.sourcePageUrl),
    contentType: mergeStringField(existing.contentType, incoming.contentType),
    method: mergeStringField(existing.method, incoming.method),
    mediaKind: mergedMediaKind,
    streamType: mergeStringField(existing.streamType, incoming.streamType),
    fallbackUrl: mergeStringField(existing.fallbackUrl, incoming.fallbackUrl),
    matchedBy: mergedMatchedBy,
    pageTitleCandidates: mergeArrayField(existing.pageTitleCandidates, incoming.pageTitleCandidates),
    resourceSignals: isYoutubePage ? [] : mergeArrayField(existing.resourceSignals, incoming.resourceSignals),
    pageEpisodeHint: isYoutubePage ? null : mergeObjectField(existing.pageEpisodeHint, incoming.pageEpisodeHint),
    youtubeMetadata: mergeObjectField(existing.youtubeMetadata, incoming.youtubeMetadata),
    pageIsTvContext: isYoutubePage ? false : Boolean(existing.pageIsTvContext || incoming.pageIsTvContext),
    pageContextCollectedAt: Math.max(
      Number(existing.pageContextCollectedAt || 0) || 0,
      Number(incoming.pageContextCollectedAt || 0) || 0,
    ) || null,
    detectedAt: (() => {
      const existingDetectedAt = Number(existing.detectedAt || 0) || 0;
      const incomingDetectedAt = Number(incoming.detectedAt || 0) || 0;
      if (!existingDetectedAt) return incomingDetectedAt || Date.now();
      if (!incomingDetectedAt) return existingDetectedAt;
      return Math.min(existingDetectedAt, incomingDetectedAt);
    })(),
    contentLength: Math.max(
      Number(existing.contentLength || 0) || 0,
      Number(incoming.contentLength || 0) || 0,
    ) || 0,
  };
}

function setBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
  chrome.action.setBadgeText({ tabId, text });
}

async function storeMedia(tabId, media) {
  const key = getStorageKey(tabId);
  const current = await chrome.storage.local.get([key]);
  const existing = Array.isArray(current[key]) ? current[key] : [];

  const duplicateIndex = existing.findIndex((x) => x && x.url === media.url);
  if (duplicateIndex >= 0) {
    existing[duplicateIndex] = mergeMediaItems(existing[duplicateIndex], media);
    await chrome.storage.local.set({ [key]: existing });
    setBadge(tabId, existing.length);
    return { ok: true, duplicate: true, count: existing.length };
  }

  existing.unshift(media);
  const next = existing.slice(0, MAX_ITEMS_PER_TAB);
  await chrome.storage.local.set({ [key]: next });
  setBadge(tabId, next.length);

  return { ok: true, duplicate: false, count: next.length };
}

async function removeMediaItem(tabId, itemId) {
  const key = getStorageKey(tabId);
  const current = await chrome.storage.local.get([key]);
  const existing = Array.isArray(current[key]) ? current[key] : [];
  const targetId = String(itemId || '').trim();

  if (!targetId) {
    return { ok: false, error: 'Missing item id', count: existing.length };
  }

  const next = existing.filter((item) => String(item && item.id || '') !== targetId);
  if (next.length === existing.length) {
    return { ok: false, error: 'Item not found', count: existing.length };
  }

  await chrome.storage.local.set({ [key]: next });
  setBadge(tabId, next.length);
  return { ok: true, removed: true, count: next.length };
}

async function cleanupExpiredStreamSessions() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const staleKeys = [];

  for (const [key, value] of Object.entries(all || {})) {
    if (!key.startsWith(STREAM_SESSION_KEY_PREFIX)) continue;
    const createdAt = Number(value && value.createdAt || 0);
    if (!Number.isFinite(createdAt) || now - createdAt > STREAM_SESSION_TTL_MS) {
      staleKeys.push(key);
    }
  }

  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys);
  }
}

async function createStreamSession(payload = {}) {
  await cleanupExpiredStreamSessions();

  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const sourceUrl = sanitizeText(payload.sourceUrl || payload.src, 4096);
  const fallbackUrl = sanitizeText(payload.fallbackUrl || payload.fallback, 4096);
  const declaredType = sanitizeText(payload.declaredType || payload.type, 16).toLowerCase();
  const title = sanitizeText(payload.title, 255) || 'Stream Player';
  const sourcePageUrl = sanitizeText(payload.sourcePageUrl, 4096);

  if (!sourceUrl && !fallbackUrl) {
    return { ok: false, error: 'Missing stream URL' };
  }

  const session = {
    id: sessionId,
    createdAt: Date.now(),
    sourceUrl,
    fallbackUrl,
    declaredType: declaredType === 'hls' ? 'hls' : (declaredType === 'file' ? 'file' : ''),
    title,
    sourcePageUrl,
    requestHeaders: sanitizeRequestHeaders(payload.requestHeaders),
  };

  await chrome.storage.local.set({ [getStreamSessionKey(sessionId)]: session });
  return { ok: true, sessionId };
}

async function getStreamSession(sessionId) {
  const safeSessionId = sanitizeText(sessionId, 80);
  if (!safeSessionId) {
    return { ok: false, error: 'Missing session id' };
  }

  const key = getStreamSessionKey(safeSessionId);
  const result = await chrome.storage.local.get([key]);
  const session = result && result[key];
  if (!session || typeof session !== 'object') {
    return { ok: false, error: 'Session not found' };
  }

  const ageMs = Date.now() - Number(session.createdAt || 0);
  if (!Number.isFinite(ageMs) || ageMs > STREAM_SESSION_TTL_MS) {
    await chrome.storage.local.remove([key]);
    return { ok: false, error: 'Session expired' };
  }

  return { ok: true, session };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const cmd = message && message.cmd;

  if (cmd === 'STORE_DETECTED_MEDIA') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Missing tab id' });
      return true;
    }

    normalizeMedia(message.media)
      .then((media) => {
        if (!media) return { ok: true, ignored: true };
        return storeMedia(tabId, media);
      })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (cmd === 'GET_TAB_MEDIA') {
    const tabId = message.tabId;
    if (!tabId) {
      sendResponse({ ok: false, items: [] });
      return true;
    }

    const key = getStorageKey(tabId);
    chrome.storage.local.get([key]).then((result) => {
      const items = Array.isArray(result[key]) ? result[key] : [];
      const enhanced = attachFallbackUrls(items);
      setBadge(tabId, items.length);
      sendResponse({ ok: true, items: enhanced });
    });
    return true;
  }

  if (cmd === 'SYNC_TAB_URL_MEDIA') {
    const tabId = Number(message.tabId || (sender.tab && sender.tab.id) || 0);
    const tabUrl = sanitizeText(
      message.tabUrl
      || (sender.tab && sender.tab.url)
      || '',
      4096
    );
    const tabTitle = sanitizeText(
      message.tabTitle
      || (sender.tab && sender.tab.title)
      || '',
      255
    );

    if (!tabId || !tabUrl) {
      sendResponse({ ok: false, error: 'Missing tab id or tab url' });
      return true;
    }

    detectYoutubePageForTab(tabId, tabUrl, tabTitle)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (cmd === 'CLEAR_TAB_MEDIA') {
    const tabId = message.tabId;
    if (!tabId) {
      sendResponse({ ok: false });
      return true;
    }

    const key = getStorageKey(tabId);
    chrome.storage.local.remove([key]).then(() => {
      setBadge(tabId, 0);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (cmd === 'REMOVE_TAB_MEDIA') {
    const tabId = message.tabId;
    const itemId = message.itemId;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Missing tab id' });
      return true;
    }

    removeMediaItem(tabId, itemId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (cmd === 'GET_EXTENSION_INFO') {
    sendResponse({
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
    });
    return true;
  }

  if (cmd === 'CREATE_STREAM_SESSION') {
    createStreamSession(message && message.session ? message.session : {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (cmd === 'GET_STREAM_SESSION') {
    getStreamSession(message && message.sessionId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || (!changeInfo.url && changeInfo.status !== 'complete')) return;
  const nextUrl = sanitizeText(changeInfo && changeInfo.url ? changeInfo.url : (tab && tab.url) || '', 4096);
  if (!nextUrl) return;

  const nextTitle = sanitizeText((tab && tab.title) || '', 255);
  detectYoutubePageForTab(tabId, nextUrl, nextTitle).catch(() => {});
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  const tabId = Number(activeInfo && activeInfo.tabId);
  if (!Number.isFinite(tabId) || tabId <= 0) return;

  chrome.tabs.get(tabId)
    .then((tab) => {
      const url = sanitizeText(tab && tab.url || '', 4096);
      if (!url) return;
      const title = sanitizeText(tab && tab.title || '', 255);
      return detectYoutubePageForTab(tabId, url, title);
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([getStorageKey(tabId)]);
});
