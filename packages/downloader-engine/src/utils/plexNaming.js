function extractYear(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

function padNumber(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return String(parsed).padStart(2, '0');
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleAlreadyIncludesYear(title, year) {
  const normalizedTitle = normalizeWhitespace(title);
  const normalizedYear = String(year || '').trim();
  if (!normalizedTitle || !normalizedYear) return false;
  return (
    normalizedTitle.endsWith(`(${normalizedYear})`)
    || new RegExp(`\\b${normalizedYear}\\b`).test(normalizedTitle)
  );
}

function getMediaType(job) {
  return job && job.tmdbMetadata && job.tmdbMetadata.mediaType === 'tv' ? 'tv' : 'movie';
}

function resolvePreferredMediaTitle(job) {
  const manualTitle = normalizeWhitespace(job && job.title);
  const hintedTitle = normalizeWhitespace(job && job.mediaHints && job.mediaHints.lookupTitle);
  const tmdbTitle = normalizeWhitespace(job && job.tmdbTitle);
  const rawTitle = normalizeWhitespace(job && job.title);

  if (job && job.manualTitleOverride) {
    return hintedTitle || manualTitle || 'Download';
  }

  return tmdbTitle || hintedTitle || rawTitle || 'Download';
}

function buildPlexBaseName(job) {
  const mediaType = getMediaType(job);
  const fallbackTitle = resolvePreferredMediaTitle(job);
  const year = extractYear(job && job.tmdbReleaseDate);

  if (mediaType === 'tv') {
    const season = padNumber(job && job.mediaHints && job.mediaHints.seasonNumber);
    const episode = padNumber(job && job.mediaHints && job.mediaHints.episodeNumber);
    const showName = year && !titleAlreadyIncludesYear(fallbackTitle, year)
      ? `${fallbackTitle} (${year})`
      : fallbackTitle;

    if (season && episode) {
      return `${showName} - S${season}E${episode}`;
    }
    if (season) {
      return `${showName} - Season ${season}`;
    }
    return showName;
  }

  if (year && !titleAlreadyIncludesYear(fallbackTitle, year)) {
    return `${fallbackTitle} (${year})`;
  }
  return fallbackTitle;
}

module.exports = {
  buildPlexBaseName,
  extractYear,
  resolvePreferredMediaTitle,
};
