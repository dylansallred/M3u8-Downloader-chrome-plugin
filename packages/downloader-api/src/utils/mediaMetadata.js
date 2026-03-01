const path = require('path');

const GENERIC_TITLE_RE = /^(index|playlist|master|chunklist|manifest|media|video|stream)$/i;

const SEASON_EPISODE_PATTERNS = [
  {
    id: 'sxe',
    regex: /(?:^|[^a-z0-9])s(?:eason)?\s*0*(\d{1,2})\s*[-_. ]*e(?:pisode)?\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i,
  },
  {
    id: 'x-format',
    regex: /(?:^|[^a-z0-9])(\d{1,2})\s*x\s*(\d{1,3})(?:[^a-z0-9]|$)/i,
  },
  {
    id: 'season-episode-words',
    regex: /(?:^|[^a-z0-9])season\s*0*(\d{1,2})\s*[-_. ]*(?:episode|ep)\s*0*(\d{1,3})(?:[^a-z0-9]|$)/i,
  },
];

const SEASON_ONLY_PATTERNS = [
  {
    id: 'season-word',
    regex: /(?:^|[^a-z0-9])season\s*0*(\d{1,2})(?:[^a-z0-9]|$)/i,
  },
  {
    id: 's-word',
    regex: /(?:^|[^a-z0-9])s(?:eason)?\s*0*(\d{1,2})(?:[^a-z0-9]|$)/i,
  },
];

const LOOKUP_CLEANUP_PATTERNS = [
  /(?:^|[^a-z0-9])s(?:eason)?\s*0*\d{1,2}\s*[-_. ]*e(?:pisode)?\s*0*\d{1,3}(?:[^a-z0-9]|$)/gi,
  /(?:^|[^a-z0-9])\d{1,2}\s*x\s*\d{1,3}(?:[^a-z0-9]|$)/gi,
  /(?:^|[^a-z0-9])season\s*0*\d{1,2}\s*[-_. ]*(?:episode|ep)\s*0*\d{1,3}(?:[^a-z0-9]|$)/gi,
  /(?:^|[^a-z0-9])season\s*0*\d{1,2}(?:[^a-z0-9]|$)/gi,
  /\b(2160p|1080p|720p|480p|360p|4k|8k)\b/gi,
  /\b(web[-_. ]?dl|web[-_. ]?rip|bluray|brrip|hdrip|dvdrip|hdtv|remux|proper|repack)\b/gi,
  /\b(x264|x265|h[._-]?264|h[._-]?265|hevc|av1|aac|ac3|eac3|ddp(?:5[._-]?1)?|atmos)\b/gi,
  /\b(multi|dubbed|subbed|internal|limited|extended|uncut)\b/gi,
];

function normalizeText(input) {
  const text = String(input || '').trim();
  if (!text) return '';

  return text
    .replace(/[._]+/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFilenameExtension(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  return value.replace(/\.[a-z0-9]{2,5}$/i, '');
}

function parseUrlCandidate(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const file = path.basename(url.pathname || '').trim();
    const decoded = file ? decodeURIComponent(file) : '';
    return stripFilenameExtension(decoded);
  } catch {
    return '';
  }
}

function parseUrlPathCandidate(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const pathname = decodeURIComponent(url.pathname || '');
    if (!pathname) return '';
    return normalizeText(pathname.replace(/[\/_-]+/g, ' '));
  } catch {
    return '';
  }
}

function hasTvContextFromUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const path = decodeURIComponent(url.pathname || '').toLowerCase();
    const query = String(url.search || '').toLowerCase();
    if (/(^|\/)(tv|series|show|shows|season|episode)(\/|$)/.test(path)) return true;
    if (/[?&](type|media|mediatype)=tv(?:&|$)/.test(query)) return true;
    if (/[?&](season|episode)=\d+/.test(query)) return true;
    return false;
  } catch {
    return false;
  }
}

function parseNumeric(matchValue, { min, max }) {
  const parsed = Number.parseInt(String(matchValue || '').trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

function extractSeasonEpisode(text, field) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  for (const pattern of SEASON_EPISODE_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (!match) continue;
    const seasonNumber = parseNumeric(match[1], { min: 1, max: 60 });
    const episodeNumber = parseNumeric(match[2], { min: 1, max: 999 });
    if (!seasonNumber || !episodeNumber) continue;
    return {
      seasonNumber,
      episodeNumber,
      matchedPattern: pattern.id,
      matchedValue: match[0] ? match[0].trim() : null,
      matchedField: field,
    };
  }

  return null;
}

function extractSeasonOnly(text, field) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  for (const pattern of SEASON_ONLY_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (!match) continue;
    const seasonNumber = parseNumeric(match[1], { min: 1, max: 60 });
    if (!seasonNumber) continue;
    return {
      seasonNumber,
      episodeNumber: null,
      matchedPattern: pattern.id,
      matchedValue: match[0] ? match[0].trim() : null,
      matchedField: field,
    };
  }

  return null;
}

function cleanLookupTitle(text) {
  let value = normalizeText(stripFilenameExtension(text));
  if (!value) return '';

  for (const pattern of LOOKUP_CLEANUP_PATTERNS) {
    value = value.replace(pattern, ' ');
  }

  value = value
    .replace(/[()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!value || GENERIC_TITLE_RE.test(value)) return '';
  return value;
}

function inferMediaMetadata({
  title,
  resourceName,
  sourcePageTitle,
  mediaUrl,
  sourcePageUrl,
} = {}) {
  const directCandidates = [
    { field: 'title', value: title },
    { field: 'resourceName', value: resourceName },
    { field: 'sourcePageTitle', value: sourcePageTitle },
    { field: 'mediaUrl', value: parseUrlCandidate(mediaUrl) },
    { field: 'sourcePageUrl', value: parseUrlCandidate(sourcePageUrl) },
    { field: 'sourcePageUrlPath', value: parseUrlPathCandidate(sourcePageUrl) },
  ].filter((candidate) => String(candidate.value || '').trim());

  let match = null;
  for (const candidate of directCandidates) {
    match = extractSeasonEpisode(candidate.value, candidate.field);
    if (match) break;
  }

  if (!match) {
    for (const candidate of directCandidates) {
      match = extractSeasonOnly(candidate.value, candidate.field);
      if (match) break;
    }
  }

  const preferredLookupSources = [];
  if (match && match.matchedField) {
    const matchedCandidate = directCandidates.find((candidate) => candidate.field === match.matchedField);
    if (matchedCandidate) preferredLookupSources.push(matchedCandidate.value);
  }
  preferredLookupSources.push(title, sourcePageTitle, resourceName, parseUrlCandidate(mediaUrl), parseUrlCandidate(sourcePageUrl));

  let lookupTitle = '';
  for (const source of preferredLookupSources) {
    lookupTitle = cleanLookupTitle(source);
    if (lookupTitle) break;
  }

  const isTvCandidate = Boolean(
    match
    || hasTvContextFromUrl(sourcePageUrl)
    || hasTvContextFromUrl(mediaUrl)
    || /\b(episode|ep\.?|season|series)\b/i.test(
      [
        title,
        resourceName,
        sourcePageTitle,
        parseUrlCandidate(mediaUrl),
        parseUrlCandidate(sourcePageUrl),
        parseUrlPathCandidate(sourcePageUrl),
      ]
        .filter(Boolean)
        .join(' ')
    )
  );

  return {
    lookupTitle: lookupTitle || cleanLookupTitle(title) || cleanLookupTitle(resourceName) || '',
    seasonNumber: match && Number.isFinite(match.seasonNumber) ? match.seasonNumber : null,
    episodeNumber: match && Number.isFinite(match.episodeNumber) ? match.episodeNumber : null,
    isTvCandidate,
    matchedPattern: match ? match.matchedPattern : null,
    matchedField: match ? match.matchedField : null,
    matchedValue: match ? match.matchedValue : null,
  };
}

module.exports = {
  inferMediaMetadata,
  cleanLookupTitle,
};
