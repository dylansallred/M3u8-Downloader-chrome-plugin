let API_BASE = 'http://127.0.0.1:49732';
const EXTENSION_PROTOCOL_VERSION = 1;

try {
  const params = new URLSearchParams(window.location.search);
  const candidate = String(params.get('apiBase') || '').trim();
  if (/^http:\/\/127\.0\.0\.1:\d+$/i.test(candidate)) {
    API_BASE = candidate;
  }
} catch {
  // ignore malformed URL params and keep default API base
}

const connectionStatus = document.getElementById('connectionStatus');
const mediaList = document.getElementById('mediaList');
const emptyState = document.getElementById('emptyState');
const refreshButton = document.getElementById('refreshButton');
const clearButton = document.getElementById('clearButton');
const statusDot = document.getElementById('statusDot');

let activeTab = null;
let health = null;
let extensionInfo = null;
let compatibilityIssue = null;

function setStatus(text, isError = false) {
  connectionStatus.textContent = text;
  connectionStatus.style.color = isError ? 'var(--color-danger)' : 'var(--color-fg-muted)';

  statusDot.className = 'status-dot';
  if (isError) {
    statusDot.classList.add('disconnected');
  } else if (text.startsWith('Checking') || text.startsWith('Desktop app not')) {
    statusDot.classList.add('checking');
  } else {
    statusDot.classList.add('connected');
  }
}

async function fetchHealth() {
  try {
    const res = await fetch(`${API_BASE}/v1/health`, {
      headers: {
        'X-Client': 'fetchv-extension',
        'X-Protocol-Version': String(EXTENSION_PROTOCOL_VERSION),
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    health = data;
    return data;
  } catch (err) {
    health = null;
    throw err;
  }
}

function parseVersionParts(input) {
  return String(input || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .map((value) => (Number.isFinite(value) && value >= 0 ? value : 0));
}

function compareVersions(a, b) {
  const av = parseVersionParts(a);
  const bv = parseVersionParts(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const left = av[i] || 0;
    const right = bv[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function updateCompatibilityState() {
  compatibilityIssue = null;
  if (!health) return;

  const minProtocol = Number(health?.supportedProtocolVersions?.min ?? health?.protocolVersion ?? EXTENSION_PROTOCOL_VERSION);
  const maxProtocol = Number(health?.supportedProtocolVersions?.max ?? health?.protocolVersion ?? EXTENSION_PROTOCOL_VERSION);

  if (Number.isFinite(minProtocol) && Number.isFinite(maxProtocol)) {
    if (EXTENSION_PROTOCOL_VERSION < minProtocol || EXTENSION_PROTOCOL_VERSION > maxProtocol) {
      compatibilityIssue = `Protocol mismatch. Extension protocol ${EXTENSION_PROTOCOL_VERSION}, app supports ${minProtocol}-${maxProtocol}.`;
      return;
    }
  }

  const minExtensionVersion = String(health?.minExtensionVersion || '').trim();
  const currentExtensionVersion = String(extensionInfo?.version || '').trim();
  if (minExtensionVersion && currentExtensionVersion) {
    if (compareVersions(currentExtensionVersion, minExtensionVersion) < 0) {
      compatibilityIssue = `Extension ${currentExtensionVersion} is too old. Update to ${minExtensionVersion}+`;
    }
  }
}

function applyCompatibilityUi() {
  if (compatibilityIssue) {
    setStatus('Desktop connected, but update required', true);
  }
}

async function getTabMedia(tabId) {
  const response = await chrome.runtime.sendMessage({
    cmd: 'GET_TAB_MEDIA',
    tabId,
  });
  return response && response.items ? response.items : [];
}

async function removeTabMediaItem(tabId, itemId) {
  const response = await chrome.runtime.sendMessage({
    cmd: 'REMOVE_TAB_MEDIA',
    tabId,
    itemId,
  });
  return response && response.ok;
}

function buildJobPayload(item) {
  const mediaUrl = item.url;
  const pageTitle = String(item.sourcePageTitle || (activeTab && activeTab.title) || '').trim();
  const sourcePageUrl = String(item.sourcePageUrl || (activeTab && activeTab.url) || '').trim();
  const displayTitle = getDisplayTitle(item);
  const titleHints = pickJobTitleHints(inferTitleHints(item, pageTitle, displayTitle));
  const baseTitle = displayTitle || pageTitle || item.filename || 'Download';
  const title = appendEpisodeTagToTitle(baseTitle, titleHints);

  return {
    mediaUrl,
    mediaType: item.type || (/\.m3u8(\?|$)/i.test(mediaUrl) ? 'hls' : 'file'),
    title,
    resourceName: item.filename || title,
    headers: item.requestHeaders || {},
    sourcePageUrl,
    sourcePageTitle: pageTitle || title,
    fallbackMediaUrl: item.fallbackUrl || '',
    titleHints,
    settings: {
      fileNaming: 'title',
      maxSegmentAttempts: 'infinite',
      threads: 8,
    },
  };
}

async function sendJob(item) {
  if (compatibilityIssue) {
    alert(`Update required before sending jobs: ${compatibilityIssue}`);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/v1/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client': 'fetchv-extension',
        'X-Protocol-Version': String(EXTENSION_PROTOCOL_VERSION),
        'X-Extension-Version': String(extensionInfo?.version || ''),
      },
      body: JSON.stringify(buildJobPayload(item)),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (data.duplicate) {
      alert(`Already queued: ${data.jobId} (position ${data.queuePosition + 1})`);
      return;
    }

    alert(`Queued: ${data.jobId} (position ${data.queuePosition + 1})`);
  } catch (err) {
    if (!health) {
      alert('Desktop app is not reachable. Open M3U8 Downloader desktop app and retry.');
      return;
    }
    alert(`Failed to queue download: ${err.message}`);
  }
}

function tryDecodeBase64(str) {
  try {
    const cleaned = str.replace(/[~]/g, '/');
    const decoded = atob(cleaned);
    if (/^[\x20-\x7E]+$/.test(decoded)) return decoded;
  } catch { /* not valid base64 */ }
  return null;
}

function extractResolution(url) {
  // Check for common resolution patterns in URL path
  const plainMatch = url.match(/[\/_\-.](\d{3,4})[pP](?:[\/_\-.]|$)/);
  if (plainMatch) return `${plainMatch[1]}p`;

  // Try decoding base64 path segments that might contain resolution
  try {
    const pathSegments = new URL(url).pathname.split('/').filter(Boolean);
    for (const seg of pathSegments) {
      if (/^[A-Za-z0-9+/=]{2,8}$/.test(seg)) {
        const decoded = tryDecodeBase64(seg);
        if (decoded && /^\d{3,4}$/.test(decoded)) {
          return `${decoded}p`;
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

function decodeFilenameCandidate(filename) {
  const raw = String(filename || '').trim();
  if (!raw) return '';
  const nameWithoutExt = raw.replace(/\.[^.]+$/, '');
  if (!/^[A-Za-z0-9+/=~]{8,}$/.test(nameWithoutExt)) return '';
  return String(tryDecodeBase64(nameWithoutExt) || '').trim();
}

function isLikelySiteSlogan(value) {
  const text = normalizeTitleText(value).toLowerCase();
  if (!text) return false;
  return /\bwatch free movies online\b/.test(text)
    || /\bfree movies online\b/.test(text)
    || /\bwatch movies online\b/.test(text)
    || /\bfmovies\b/.test(text);
}

function extractSeriesTitleFromPageTitle(pageTitle) {
  const raw = String(pageTitle || '').trim();
  if (!raw) return '';

  const patterns = [
    /watch\s+(.+?)\s+s\d{1,2}\s*e\d{1,3}\b/i,
    /^(.+?)\s+s\d{1,2}\s*e\d{1,3}\b/i,
    /watch\s+(.+?)\s+season\s*\d{1,2}\s*(?:episode|ep)\s*\d{1,3}\b/i,
    /^(.+?)\s+season\s*\d{1,2}\s*(?:episode|ep)\s*\d{1,3}\b/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match || !match[1]) continue;
    const candidate = normalizeTitleText(match[1])
      .replace(/^watch\s+/i, '')
      .replace(/\s*\|\s*.*$/g, '')
      .trim();
    if (candidate && !isLikelySiteSlogan(candidate)) {
      return candidate;
    }
  }

  return '';
}

function extractQuotedEpisodeTitleFromPageTitle(pageTitle) {
  const raw = String(pageTitle || '').trim();
  if (!raw) return '';
  const match = raw.match(/["“]([^"”]{2,140})["”]/);
  if (!match || !match[1]) return '';
  return normalizeTitleText(match[1]);
}

function isLikelyTitleNoise(value, source = '') {
  const raw = String(value || '').trim();
  const text = normalizeTitleText(raw);
  const lower = text.toLowerCase();
  const sourceLower = String(source || '').toLowerCase();

  if (!text) return true;
  if (text.length < 2 || text.length > 140) return true;
  if (/^https?:\/\//i.test(raw)) return true;
  if (/^\d+(?:\s+\d+)*$/.test(lower)) return true;
  if (/^(go back|back|home|menu|close|play|pause|next|previous)$/i.test(lower)) return true;
  if (/^season\s*\d{1,2}(?:\s*episode(?:\s*\d{1,3})?)?$/i.test(lower)) return true;

  if (sourceLower.startsWith('resource.')) {
    if (/\b(db|users)\s+videasy\s+net\b/.test(lower)) return true;
    if (/\b(trending|popular|top rated|discover|collection)\b/.test(lower)) return true;
  }

  return false;
}

function scoreDisplayTitleCandidate(value, source, pageTitle, tvContextFromUrl) {
  if (isLikelyTitleNoise(value, source)) return -1000;

  const sourceLower = String(source || '').toLowerCase();
  const text = normalizeTitleText(value);
  let score = 0;

  if (sourceLower.startsWith('jsonld.')) score += 120;
  else if (sourceLower.includes('og:title') || sourceLower.includes('twitter:title') || sourceLower.includes('meta[name="title"]')) score += 95;
  else if (sourceLower === 'player.text') score += 90;
  else if (sourceLower === 'dom.data-title' || sourceLower === 'dom.data-name') score += 80;
  else if (sourceLower === 'document.title') score += 45;
  else if (sourceLower.startsWith('dom.')) score += 55;
  else if (sourceLower.startsWith('resource.query.')) score += 35;
  else if (sourceLower.startsWith('resource.')) score += 10;
  else if (sourceLower === 'url.pathname') score += 5;

  if (isLikelySiteSlogan(text)) score -= 140;
  if (normalizeTitleText(text) === normalizeTitleText(pageTitle) && isLikelySiteSlogan(pageTitle)) score -= 100;
  if (/\bseason\b|\bepisode\b/i.test(text) && !/[a-z]{3,}/i.test(stripTitleNoise(text))) score -= 70;

  if (tvContextFromUrl) {
    const quotedEpisodeTitle = extractQuotedEpisodeTitleFromPageTitle(pageTitle);
    if (quotedEpisodeTitle && normalizeTitleText(text) === quotedEpisodeTitle) {
      score -= 220;
    }
    if (sourceLower === 'player.text') score += 24;
    if (sourceLower.startsWith('jsonld.')) score += 10;
  }

  if (text.length >= 4 && text.length <= 80) score += 8;
  if (/[A-Za-z].*[:\-].*[A-Za-z]/.test(text)) score += 6;

  return score;
}

function pickPreferredContentTitle(item, pageTitle, tvContextFromUrl) {
  const candidates = Array.isArray(item && item.pageTitleCandidates) ? item.pageTitleCandidates : [];
  let bestValue = '';
  let bestScore = -Infinity;

  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const source = String(entry.source || '').trim();
    const value = String(entry.value || '').trim();
    if (!value) continue;

    const score = scoreDisplayTitleCandidate(value, source, pageTitle, tvContextFromUrl);
    if (score > bestScore) {
      bestScore = score;
      bestValue = value;
    }
  }

  if (bestScore >= 30 && bestValue) return bestValue;
  return '';
}

function getDisplayTitle(item) {
  // Use stored source page title first so titles stay stable across navigation.
  const pageTitle = String(item.sourcePageTitle || (activeTab && activeTab.title) || '').trim();
  const sourcePageUrl = String(item.sourcePageUrl || (activeTab && activeTab.url) || '').trim();
  const tvContextFromUrl = detectTvContextFromUrl(sourcePageUrl);
  const seriesTitleFromPageTitle = tvContextFromUrl ? extractSeriesTitleFromPageTitle(pageTitle) : '';
  const preferredContentTitle = pickPreferredContentTitle(item, pageTitle, tvContextFromUrl);

  if (seriesTitleFromPageTitle) {
    return seriesTitleFromPageTitle;
  }

  const filename = item.filename || '';
  const decodedFilename = decodeFilenameCandidate(filename);
  if (decodedFilename) {
    // If decoded is generic (index, playlist, master), prefer page title
    if (/^(index|playlist|master|chunklist|media)\b/i.test(decodedFilename)) {
      if (preferredContentTitle) return preferredContentTitle;
      if (pageTitle && !isLikelySiteSlogan(pageTitle)) return pageTitle;
    }
    return decodedFilename;
  }

  if (preferredContentTitle) {
    return preferredContentTitle;
  }

  // If filename is generic, prefer page title
  if (/^(index|playlist|master|media)\.(m3u8|mpd)$/i.test(filename) && pageTitle && !isLikelySiteSlogan(pageTitle)) {
    return pageTitle;
  }

  if (pageTitle && !isLikelySiteSlogan(pageTitle)) {
    return pageTitle;
  }

  return filename || pageTitle || 'Media';
}

const TITLE_SEASON_EPISODE_PATTERNS = [
  { id: 'sxe', regex: /(?:^|[^a-z0-9])s(?:eason)?\s*0*(\d{1,2})\s*[-_. ]*e(?:pisode)?\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i },
  { id: 'x-format', regex: /(?:^|[^a-z0-9])(\d{1,2})\s*x\s*(\d{1,3})(?:[^a-z0-9]|$)/i },
  { id: 'season-episode-words', regex: /(?:^|[^a-z0-9])season\s*0*(\d{1,2})\s*[-_. ]*(?:episode|ep)\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i },
];

const TITLE_SEASON_ONLY_PATTERNS = [
  { id: 'season-word', regex: /(?:^|[^a-z0-9])season\s*0*(\d{1,2})(?:[^a-z0-9]|$)/i },
  { id: 's-word', regex: /(?:^|[^a-z0-9])s\s*0*(\d{1,2})(?:[^a-z0-9]|$)/i },
];

const TITLE_EPISODE_ONLY_PATTERNS = [
  { id: 'episode-word', regex: /(?:^|[^a-z0-9])episode\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i },
  { id: 'ep-word', regex: /(?:^|[^a-z0-9])ep\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i },
  { id: 'e-word', regex: /(?:^|[^a-z0-9])e\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i },
];

function parseBoundedInteger(value, min, max) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

function normalizeTitleText(value) {
  return String(value || '')
    .replace(/[._]+/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTitleNoise(value) {
  return normalizeTitleText(value)
    .replace(/(?:^|[^a-z0-9])s(?:eason)?\s*0*\d{1,2}\s*[-_. ]*e(?:pisode)?\s*0*\d{1,3}(?:[^a-z0-9]|$)/gi, ' ')
    .replace(/(?:^|[^a-z0-9])\d{1,2}\s*x\s*\d{1,3}(?:[^a-z0-9]|$)/gi, ' ')
    .replace(/(?:^|[^a-z0-9])season\s*0*\d{1,2}(?:[^a-z0-9]|$)/gi, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|8k|x264|x265|h264|h265|hevc|webrip|web[-_. ]?dl|bluray)\b/gi, ' ')
    .replace(/[()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimDebugText(value, max = 260) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function detectTvContextFromUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const path = decodeURIComponent(parsed.pathname || '').toLowerCase();
    const query = String(parsed.search || '').toLowerCase();
    if (/(^|\/)(tv|series|show|shows|season|episode)(\/|$)/.test(path)) return true;
    if (/[?&](type|media|mediatype)=tv(?:&|$)/.test(query)) return true;
    if (/[?&](season|episode)=\d+/.test(query)) return true;
    return false;
  } catch {
    return false;
  }
}

function inferHintFromSourcePageUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const decodedPath = decodeURIComponent(parsed.pathname || '');
    const pathParts = decodedPath.split('/').filter(Boolean);

    let seasonNumber = parseBoundedInteger(
      parsed.searchParams.get('season')
      || parsed.searchParams.get('seasonNumber')
      || parsed.searchParams.get('s'),
      1,
      60
    );
    let episodeNumber = parseBoundedInteger(
      parsed.searchParams.get('episode')
      || parsed.searchParams.get('episodeNumber')
      || parsed.searchParams.get('ep')
      || parsed.searchParams.get('e'),
      1,
      999
    );

    if (!(seasonNumber && episodeNumber)) {
      const tvRoots = new Set(['tv', 'series', 'show', 'shows']);
      for (let i = 0; i < pathParts.length - 3; i += 1) {
        const root = String(pathParts[i] || '').toLowerCase();
        if (!tvRoots.has(root)) continue;
        const seasonCandidate = parseBoundedInteger(pathParts[i + 2], 1, 60);
        const episodeCandidate = parseBoundedInteger(pathParts[i + 3], 1, 999);
        if (seasonCandidate && episodeCandidate) {
          seasonNumber = seasonCandidate;
          episodeNumber = episodeCandidate;
          break;
        }
      }
    }

    if (!(seasonNumber && episodeNumber)) {
      return null;
    }

    return {
      seasonNumber,
      episodeNumber,
      matchedPattern: 'source-url-route',
      matchedField: 'sourcePageUrl.route',
      matchedText: value,
    };
  } catch {
    return null;
  }
}

function inferHintFromText(text, field) {
  const normalized = normalizeTitleText(text);
  if (!normalized) return null;

  for (const pattern of TITLE_SEASON_EPISODE_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (!match) continue;
    const seasonNumber = parseBoundedInteger(match[1], 1, 60);
    const episodeNumber = parseBoundedInteger(match[2], 1, 999);
    if (!seasonNumber || !episodeNumber) continue;
    return {
      seasonNumber,
      episodeNumber,
      matchedPattern: pattern.id,
      matchedField: field,
    };
  }

  let seasonOnly = null;
  for (const pattern of TITLE_SEASON_ONLY_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (!match) continue;
    const seasonNumber = parseBoundedInteger(match[1], 1, 60);
    if (!seasonNumber) continue;
    seasonOnly = {
      seasonNumber,
      episodeNumber: null,
      matchedPattern: pattern.id,
      matchedField: field,
    };
    break;
  }

  for (const pattern of TITLE_EPISODE_ONLY_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (!match) continue;
    const episodeNumber = parseBoundedInteger(match[1], 1, 999);
    if (!episodeNumber) continue;
    return {
      seasonNumber: seasonOnly ? seasonOnly.seasonNumber : null,
      episodeNumber,
      matchedPattern: seasonOnly ? `${seasonOnly.matchedPattern}+${pattern.id}` : pattern.id,
      matchedField: field,
    };
  }

  return seasonOnly;
}

function scoreEpisodeHint(hint) {
  const seasonNumber = parseBoundedInteger(hint && hint.seasonNumber, 1, 60);
  const episodeNumber = parseBoundedInteger(hint && hint.episodeNumber, 1, 999);
  if (!seasonNumber && !episodeNumber) return -1;

  let score = 0;
  if (seasonNumber) score += 100;
  if (episodeNumber) score += 220;
  if (seasonNumber && episodeNumber) score += 120;

  const pattern = String(hint && hint.matchedPattern || '').toLowerCase();
  if (pattern.includes('sxe') || pattern.includes('season-episode') || pattern.includes('x-format')) {
    score += 15;
  }

  const field = String(hint && hint.matchedField || '').toLowerCase();
  if (field.includes('sourcepageurl.route') || field.includes('pageepisodehint.url-route')) {
    score += 1000;
  }

  return score;
}

function pickPreferredEpisodeHint(currentHint, nextHint) {
  const currentScore = scoreEpisodeHint(currentHint);
  const nextScore = scoreEpisodeHint(nextHint);
  if (nextScore < 0) return currentHint;
  if (currentScore < 0 || nextScore > currentScore) return nextHint;

  if (nextScore === currentScore) {
    const currentEpisode = parseBoundedInteger(currentHint && currentHint.episodeNumber, 1, 999);
    const nextEpisode = parseBoundedInteger(nextHint && nextHint.episodeNumber, 1, 999);
    if (nextEpisode && !currentEpisode) return nextHint;
    if (nextEpisode && currentEpisode) return nextHint;
  }

  return currentHint;
}

function inferTitleHints(item, pageTitle, displayTitle) {
  const sourcePageUrl = String(item && item.sourcePageUrl || (activeTab && activeTab.url) || '').trim();
  const sourceUrlHint = inferHintFromSourcePageUrl(sourcePageUrl);
  const decodedFilename = decodeFilenameCandidate(item && item.filename);
  const pageCandidates = Array.isArray(item && item.pageTitleCandidates)
    ? item.pageTitleCandidates
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry, index) => ({
        field: `pageCandidate.${index}`,
        label: `Page Candidate (${String(entry.source || 'unknown')})`,
        value: String(entry.value || '').trim(),
      }))
      .filter((entry) => entry.value)
    : [];

  const resourceSignalCandidates = Array.isArray(item && item.resourceSignals)
    ? item.resourceSignals
      .filter((entry) => entry && typeof entry === 'object')
      .flatMap((entry, index) => {
        const output = [];
        const source = String(entry.source || 'resource').trim() || 'resource';
        const urlValue = String(entry.url || '').trim();
        if (urlValue) {
          output.push({
            field: `resourceSignal.${index}.url`,
            label: `Resource Signal URL (${source})`,
            value: urlValue,
          });
        }

        const seasonNumber = parseBoundedInteger(entry.seasonNumber, 1, 60);
        const episodeNumber = parseBoundedInteger(entry.episodeNumber, 1, 999);
        if (seasonNumber || episodeNumber) {
          output.push({
            field: `resourceSignal.${index}.episodeHint`,
            label: `Resource Episode Hint (${source})`,
            value: `season ${seasonNumber || ''} episode ${episodeNumber || ''}`.trim(),
          });
        }

        const patternValue = String(entry.matchedPattern || '').trim();
        if (patternValue) {
          output.push({
            field: `resourceSignal.${index}.pattern`,
            label: `Resource Pattern (${source})`,
            value: patternValue,
          });
        }

        return output;
      })
      .filter((entry) => entry.value)
    : [];

  const candidates = [
    { field: 'displayTitle', label: 'Display Title', value: displayTitle },
    { field: 'pageTitle', label: 'Page Title', value: pageTitle },
    ...pageCandidates,
    ...resourceSignalCandidates,
    { field: 'filename', label: 'Filename', value: item && item.filename },
    { field: 'filenameDecoded', label: 'Decoded Filename', value: decodedFilename },
    { field: 'url', label: 'Request URL', value: item && item.url },
  ].filter((candidate) => String(candidate.value || '').trim());

  const pageEpisodeHint = item && item.pageEpisodeHint && typeof item.pageEpisodeHint === 'object'
    ? item.pageEpisodeHint
    : null;

  let matched = null;
  if (sourceUrlHint) {
    matched = pickPreferredEpisodeHint(matched, sourceUrlHint);
  }

  let pageEpisodeHintMatch = null;
  if (pageEpisodeHint) {
    const seasonNumber = parseBoundedInteger(pageEpisodeHint.seasonNumber, 1, 60);
    const episodeNumber = parseBoundedInteger(pageEpisodeHint.episodeNumber, 1, 999);
    if (seasonNumber || episodeNumber) {
      pageEpisodeHintMatch = {
        seasonNumber: seasonNumber || null,
        episodeNumber: episodeNumber || null,
        matchedPattern: String(pageEpisodeHint.matchedPattern || 'page-episode-hint').trim(),
        matchedField: `pageEpisodeHint.${String(pageEpisodeHint.source || 'unknown').trim() || 'unknown'}`,
      };
      matched = pickPreferredEpisodeHint(matched, pageEpisodeHintMatch);
    }
  }

  const candidateTitles = [];
  for (const candidate of candidates) {
    const normalized = normalizeTitleText(candidate.value);
    const candidateMatch = inferHintFromText(candidate.value, candidate.field);
    if (candidateMatch) {
      matched = pickPreferredEpisodeHint(matched, candidateMatch);
    }

    candidateTitles.push({
      field: candidate.field,
      label: candidate.label,
      value: trimDebugText(candidate.value),
      normalized: trimDebugText(normalized),
      lookupCandidate: trimDebugText(stripTitleNoise(candidate.value)),
      matchedPattern: candidateMatch ? candidateMatch.matchedPattern : null,
      seasonNumber: candidateMatch ? candidateMatch.seasonNumber : null,
      episodeNumber: candidateMatch ? candidateMatch.episodeNumber : null,
    });
  }

  if (pageEpisodeHint) {
    candidateTitles.unshift({
      field: `pageEpisodeHint.${String(pageEpisodeHint.source || 'unknown').trim() || 'unknown'}`,
      label: 'Page Episode Hint',
      value: String(pageEpisodeHint.matchedText || '').trim() || '(from structured page context)',
      normalized: String(pageEpisodeHint.matchedText || '').trim() || '(from structured page context)',
      lookupCandidate: '',
      matchedPattern: String(pageEpisodeHint.matchedPattern || 'page-episode-hint').trim(),
      seasonNumber: pageEpisodeHintMatch ? pageEpisodeHintMatch.seasonNumber : null,
      episodeNumber: pageEpisodeHintMatch ? pageEpisodeHintMatch.episodeNumber : null,
    });
  }

  if (sourceUrlHint) {
    candidateTitles.unshift({
      field: 'sourcePageUrl.route',
      label: 'Source URL Episode Hint',
      value: String(sourceUrlHint.matchedText || sourcePageUrl).trim(),
      normalized: String(sourceUrlHint.matchedText || sourcePageUrl).trim(),
      lookupCandidate: '',
      matchedPattern: sourceUrlHint.matchedPattern,
      seasonNumber: sourceUrlHint.seasonNumber,
      episodeNumber: sourceUrlHint.episodeNumber,
    });
  }

  const matchedSource = matched
    ? String(candidates.find((candidate) => candidate.field === matched.matchedField)?.value || '').trim()
    : '';
  const matchedLookup = stripTitleNoise(matchedSource);
  const source = matchedLookup
    ? matchedSource
    : (displayTitle || pageTitle || (item && item.filename) || '');
  const lookupTitle = stripTitleNoise(source);
  const tvContextFromUrl = detectTvContextFromUrl(sourcePageUrl);
  const pageIsTvContext = Boolean(item && item.pageIsTvContext);
  const hasEpisodeSignal = Boolean(
    matched
    && (Number.isFinite(matched.episodeNumber) || Number.isFinite(matched.seasonNumber))
  );
  const isTvCandidate = Boolean(hasEpisodeSignal || pageIsTvContext || tvContextFromUrl);

  return {
    lookupTitle,
    seasonNumber: matched && Number.isFinite(matched.seasonNumber) ? matched.seasonNumber : null,
    episodeNumber: matched && Number.isFinite(matched.episodeNumber) ? matched.episodeNumber : null,
    isTvCandidate,
    matchedPattern: matched ? matched.matchedPattern : null,
    matchedField: matched ? matched.matchedField : null,
    mediaGuess: isTvCandidate ? 'tv' : (lookupTitle ? 'movie_or_unknown' : 'unknown'),
    candidateTitles,
    tvContextFromUrl,
    pageIsTvContext,
  };
}

function pickJobTitleHints(hints) {
  return {
    lookupTitle: String(hints && hints.lookupTitle ? hints.lookupTitle : '').trim(),
    seasonNumber: Number.isFinite(hints && hints.seasonNumber) ? hints.seasonNumber : null,
    episodeNumber: Number.isFinite(hints && hints.episodeNumber) ? hints.episodeNumber : null,
    isTvCandidate: Boolean(hints && hints.isTvCandidate),
    matchedPattern: String(hints && hints.matchedPattern ? hints.matchedPattern : '').trim(),
    matchedField: String(hints && hints.matchedField ? hints.matchedField : '').trim(),
  };
}

function formatEpisodeTag(seasonNumber, episodeNumber) {
  if (!seasonNumber && !episodeNumber) return '';
  const seasonPart = Number.isFinite(seasonNumber) ? `S${String(seasonNumber).padStart(2, '0')}` : 'S??';
  const episodePart = Number.isFinite(episodeNumber) ? `E${String(episodeNumber).padStart(2, '0')}` : 'E??';
  return `${seasonPart}${episodePart}`;
}

function appendEpisodeTagToTitle(titleValue, titleHints) {
  const title = String(titleValue || '').trim();
  if (!title) return title;

  const seasonNumber = parseBoundedInteger(titleHints && titleHints.seasonNumber, 1, 60);
  const episodeNumber = parseBoundedInteger(titleHints && titleHints.episodeNumber, 1, 999);
  if (!seasonNumber || !episodeNumber) return title;

  const seasonText = String(seasonNumber);
  const episodeText = String(episodeNumber);
  if (
    new RegExp(`\\bs\\s*0*${seasonText}\\s*e\\s*0*${episodeText}\\b`, 'i').test(title)
    || new RegExp(`\\b${seasonText}\\s*x\\s*0*${episodeText}\\b`, 'i').test(title)
    || new RegExp(`\\bseason\\s*0*${seasonText}\\s*(?:-|\\s)*(?:episode|ep)\\s*0*${episodeText}\\b`, 'i').test(title)
  ) {
    return title;
  }

  const tag = formatEpisodeTag(seasonNumber, episodeNumber);
  return tag ? `${title} ${tag}` : title;
}

function appendDisplayEpisodeTagToTitle(titleValue, titleHints) {
  const title = String(titleValue || '').trim();
  if (!title) return title;

  const tag = formatEpisodeTag(
    titleHints && titleHints.seasonNumber,
    titleHints && titleHints.episodeNumber
  );
  if (!tag) return title;

  const normalizedTitle = title.toUpperCase().replace(/\s+/g, '');
  if (normalizedTitle.includes(tag.toUpperCase())) {
    return title;
  }

  return `${title} ${tag}`;
}

function formatMediaGuess(titleHints) {
  if (titleHints && titleHints.isTvCandidate) {
    const tag = formatEpisodeTag(titleHints.seasonNumber, titleHints.episodeNumber);
    return tag ? `TV Show (${tag})` : 'TV Show';
  }
  if (titleHints && titleHints.lookupTitle) return 'Movie / Unknown';
  return 'Unknown';
}

function buildDebugPayload(item, pageTitle, displayTitle, titleHints, resolution, friendlyType) {
  return {
    classification: {
      guess: formatMediaGuess(titleHints),
      lookupTitle: titleHints && titleHints.lookupTitle ? titleHints.lookupTitle : '',
      isTvCandidate: Boolean(titleHints && titleHints.isTvCandidate),
      seasonNumber: titleHints && titleHints.seasonNumber ? titleHints.seasonNumber : null,
      episodeNumber: titleHints && titleHints.episodeNumber ? titleHints.episodeNumber : null,
      matchedPattern: titleHints && titleHints.matchedPattern ? titleHints.matchedPattern : null,
      matchedField: titleHints && titleHints.matchedField ? titleHints.matchedField : null,
      tvContextFromUrl: Boolean(titleHints && titleHints.tvContextFromUrl),
      pageIsTvContext: Boolean(titleHints && titleHints.pageIsTvContext),
      resourceSignalCount: Array.isArray(item && item.resourceSignals) ? item.resourceSignals.length : 0,
    },
    titleCandidates: Array.isArray(titleHints && titleHints.candidateTitles)
      ? titleHints.candidateTitles
      : [],
    detection: {
      mediaType: item.type || null,
      streamType: item.streamType || null,
      mediaKind: item.mediaKind || null,
      requestMethod: item.method ? String(item.method).toUpperCase() : null,
      matchedBy: Array.isArray(item.matchedBy) ? item.matchedBy : [],
      statusCode: Number.isFinite(item.statusCode) ? item.statusCode : null,
      contentType: item.contentType || null,
      friendlyContentType: friendlyType || null,
      contentDisposition: item.contentDisposition || null,
      contentLength: Number(item.contentLength || 0) || null,
      resolution: resolution || null,
      fallbackUrl: item.fallbackUrl || null,
      detectedAt: item.detectedAt ? new Date(item.detectedAt).toISOString() : null,
      pageContextCollectedAt: item.pageContextCollectedAt ? new Date(item.pageContextCollectedAt).toISOString() : null,
    },
    pageContext: {
      sourcePageTitle: pageTitle || null,
      sourcePageUrl: String(item.sourcePageUrl || (activeTab && activeTab.url) || '').trim() || null,
      displayTitle: displayTitle || null,
      filename: item.filename || null,
      url: item.url || null,
      pageEpisodeHint: item.pageEpisodeHint || null,
      resourceSignals: Array.isArray(item.resourceSignals) ? item.resourceSignals : [],
    },
  };
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatContentType(contentType) {
  if (!contentType) return null;
  const ct = contentType.split(';')[0].trim();
  const friendly = {
    'application/x-mpegurl': 'HLS Playlist',
    'application/vnd.apple.mpegurl': 'HLS Playlist',
    'application/dash+xml': 'DASH Manifest',
    'video/mp4': 'MP4 Video',
    'video/webm': 'WebM Video',
    'video/mp2t': 'MPEG-TS',
    'audio/mpeg': 'MP3 Audio',
    'audio/mp4': 'M4A Audio',
  };
  return friendly[ct.toLowerCase()] || ct;
}

function formatSize(bytes) {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function makeDot() {
  const dot = document.createElement('span');
  dot.className = 'text-fg-subtle text-[0.625rem]';
  dot.textContent = '\u00B7';
  return dot;
}

function renderMedia(items) {
  mediaList.innerHTML = '';
  emptyState.style.display = items.length ? 'none' : 'flex';

  for (const item of items) {
    const pageTitle = String(item.sourcePageTitle || (activeTab && activeTab.title) || '').trim();
    const displayTitle = getDisplayTitle(item);
    const titleHints = inferTitleHints(item, pageTitle, displayTitle);
    const displayTitleWithEpisode = appendDisplayEpisodeTagToTitle(displayTitle, titleHints);

    const wrapper = document.createElement('div');
    wrapper.className = 'media-item glass-subtle glass-glow p-3 animate-slide-up';

    // Row 1: title + pills
    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-start justify-between gap-2';

    const title = document.createElement('h3');
    title.className = 'text-[0.8125rem] font-medium text-fg truncate flex-1';
    title.textContent = displayTitleWithEpisode;

    const pillGroup = document.createElement('div');
    pillGroup.className = 'flex items-center gap-1 flex-shrink-0';

    const resolution = extractResolution(item.url);
    if (resolution) {
      const resPill = document.createElement('span');
      resPill.className = 'pill pill-muted';
      resPill.textContent = resolution;
      pillGroup.appendChild(resPill);
    }

    const typePill = document.createElement('span');
    typePill.className = 'pill pill-accent';
    typePill.textContent = (item.type || 'file').toUpperCase();
    pillGroup.appendChild(typePill);

    const episodeTag = formatEpisodeTag(titleHints.seasonNumber, titleHints.episodeNumber);
    if (episodeTag || titleHints.isTvCandidate) {
      const tvPill = document.createElement('span');
      tvPill.className = 'pill pill-muted';
      tvPill.textContent = episodeTag || 'TV';
      pillGroup.appendChild(tvPill);
    }

    titleRow.appendChild(title);
    titleRow.appendChild(pillGroup);

    // Row 2: domain + content type
    const infoRow = document.createElement('div');
    infoRow.className = 'flex items-center gap-1.5 mt-1.5 flex-wrap text-[0.6875rem] text-fg-muted';

    const hostname = getHostname(item.url);
    if (hostname) {
      const domainEl = document.createElement('span');
      domainEl.textContent = hostname;
      infoRow.appendChild(domainEl);
    }

    const friendlyType = formatContentType(item.contentType);
    if (friendlyType) {
      if (hostname) infoRow.appendChild(makeDot());
      const typeEl = document.createElement('span');
      typeEl.textContent = friendlyType;
      infoRow.appendChild(typeEl);
    }

    if (titleHints.lookupTitle && normalizeTitleText(titleHints.lookupTitle) !== normalizeTitleText(displayTitle)) {
      if (hostname || friendlyType) infoRow.appendChild(makeDot());
      const lookupEl = document.createElement('span');
      lookupEl.textContent = `Lookup: ${titleHints.lookupTitle}`;
      lookupEl.title = 'Title sent for TMDB lookup';
      infoRow.appendChild(lookupEl);
    }

    // Row 3: size + time + fallback
    const metaRow = document.createElement('div');
    metaRow.className = 'flex items-center gap-1.5 mt-1 flex-wrap text-[0.6875rem] text-fg-subtle';

    const sizeText = formatSize(item.contentLength);
    if (sizeText) {
      const sizeEl = document.createElement('span');
      sizeEl.textContent = sizeText;
      metaRow.appendChild(sizeEl);
    }

    const timeText = formatTimeAgo(item.detectedAt);
    if (timeText) {
      if (sizeText) metaRow.appendChild(makeDot());
      const timeEl = document.createElement('span');
      timeEl.textContent = timeText;
      metaRow.appendChild(timeEl);
    }

    if (item.type === 'hls' && item.fallbackUrl) {
      const fallbackHost = getHostname(item.fallbackUrl);
      if (sizeText || timeText) metaRow.appendChild(makeDot());
      const fallback = document.createElement('span');
      fallback.className = 'pill pill-accent text-[0.625rem]';
      fallback.textContent = fallbackHost
        ? `Fallback: ${fallbackHost}`
        : 'Fallback available';
      fallback.title = item.fallbackUrl;
      metaRow.appendChild(fallback);
    }

    // Row 4: URL + copy button
    const urlRow = document.createElement('div');
    urlRow.className = 'url-row';

    const url = document.createElement('p');
    url.className = 'url-text';
    url.textContent = item.url;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy';
    copyBtn.title = 'Copy URL';
    copyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(item.url).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        }, 1500);
      });
    });

    urlRow.appendChild(url);
    urlRow.appendChild(copyBtn);

    const debugPayload = buildDebugPayload(
      item,
      pageTitle,
      displayTitle,
      titleHints,
      resolution,
      friendlyType,
    );

    // Row 5: Action buttons
    const actionRow = document.createElement('div');
    actionRow.className = 'flex items-center justify-between mt-2.5 gap-2';

    const detailsBtn = document.createElement('button');
    detailsBtn.className = 'btn btn-ghost text-xs px-2 py-1';
    detailsBtn.textContent = 'Show Details';
    detailsBtn.setAttribute('aria-expanded', 'false');

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon-danger';
    removeBtn.title = 'Remove this detected media';
    removeBtn.setAttribute('aria-label', 'Remove detected media');
    removeBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/><path d="M4 7h16"/></svg>';
    removeBtn.addEventListener('click', async () => {
      if (!activeTab || !item || !item.id) return;
      removeBtn.disabled = true;
      const removed = await removeTabMediaItem(activeTab.id, item.id);
      if (!removed) {
        removeBtn.disabled = false;
        return;
      }
      await refreshMedia();
    });

    const queueBtn = document.createElement('button');
    queueBtn.className = 'btn btn-primary text-xs';
    queueBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg> Send to Desktop';
    queueBtn.addEventListener('click', () => sendJob(item));

    const detailsPanel = document.createElement('div');
    detailsPanel.className = 'details-panel';
    detailsPanel.style.display = 'none';

    const detailsHeader = document.createElement('div');
    detailsHeader.className = 'details-header';

    const detailsSummary = document.createElement('p');
    detailsSummary.className = 'details-summary';
    detailsSummary.textContent = `Guess: ${formatMediaGuess(titleHints)}${titleHints.lookupTitle ? ` · Lookup: ${titleHints.lookupTitle}` : ''}`;

    const detailsJson = document.createElement('pre');
    detailsJson.className = 'details-json';
    detailsJson.textContent = JSON.stringify(debugPayload, null, 2);

    const detailsCopyBtn = document.createElement('button');
    detailsCopyBtn.className = 'btn-copy';
    detailsCopyBtn.title = 'Copy details JSON';
    detailsCopyBtn.setAttribute('aria-label', 'Copy details JSON');
    detailsCopyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    detailsCopyBtn.addEventListener('click', async () => {
      const payload = detailsJson.textContent || '';
      if (!payload) return;
      try {
        await navigator.clipboard.writeText(payload);
        detailsCopyBtn.classList.add('copied');
        detailsCopyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
        setTimeout(() => {
          detailsCopyBtn.classList.remove('copied');
          detailsCopyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        }, 1500);
      } catch {
        // Ignore clipboard failures to avoid interrupting popup interactions.
      }
    });

    detailsHeader.appendChild(detailsSummary);
    detailsHeader.appendChild(detailsCopyBtn);
    detailsPanel.appendChild(detailsHeader);
    detailsPanel.appendChild(detailsJson);

    detailsBtn.addEventListener('click', () => {
      const isOpen = detailsPanel.style.display !== 'none';
      detailsPanel.style.display = isOpen ? 'none' : 'block';
      detailsBtn.textContent = isOpen ? 'Show Details' : 'Hide Details';
      detailsBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    });

    const leftActions = document.createElement('div');
    leftActions.className = 'flex items-center gap-2';
    leftActions.appendChild(detailsBtn);
    leftActions.appendChild(removeBtn);

    actionRow.appendChild(leftActions);
    actionRow.appendChild(queueBtn);
    wrapper.appendChild(titleRow);
    wrapper.appendChild(infoRow);
    wrapper.appendChild(metaRow);
    wrapper.appendChild(urlRow);
    wrapper.appendChild(actionRow);
    wrapper.appendChild(detailsPanel);
    mediaList.appendChild(wrapper);
  }
}

async function refreshMedia() {
  if (!activeTab) return;
  const items = await getTabMedia(activeTab.id);
  renderMedia(items);
}

async function refreshConnection() {
  statusDot.className = 'status-dot checking';
  try {
    const data = await fetchHealth();
    updateCompatibilityState();
    if (compatibilityIssue) {
      applyCompatibilityUi();
    } else {
      setStatus(`Desktop connected (${data.appVersion})`);
    }
  } catch (err) {
    compatibilityIssue = null;
    setStatus('Desktop app not running at 127.0.0.1:49732', true);
  }
}

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  const forcedTabId = Number(params.get('tabId'));
  const forcedTabUrl = String(params.get('tabUrl') || '').trim();

  if (Number.isFinite(forcedTabId) && forcedTabId > 0) {
    try {
      activeTab = await chrome.tabs.get(forcedTabId);
    } catch {
      activeTab = null;
    }
  }

  if (!activeTab && forcedTabUrl) {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      activeTab = tabs.find((tab) => (tab.url || '').startsWith(forcedTabUrl)) || null;
    } catch {
      activeTab = null;
    }
  }

  if (!activeTab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
  }

  extensionInfo = await chrome.runtime.sendMessage({ cmd: 'GET_EXTENSION_INFO' });

  refreshButton.addEventListener('click', async () => {
    await refreshConnection();
    await refreshMedia();
  });

  clearButton.addEventListener('click', async () => {
    if (!activeTab) return;
    await chrome.runtime.sendMessage({ cmd: 'CLEAR_TAB_MEDIA', tabId: activeTab.id });
    await refreshMedia();
  });

  await refreshConnection();
  await refreshMedia();
}

initialize();
