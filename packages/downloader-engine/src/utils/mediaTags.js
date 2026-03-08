const { extractYear, resolvePreferredMediaTitle } = require('./plexNaming');

function pushTag(args, key, value) {
  const text = String(value || '').trim();
  if (!text) return;
  args.push('-metadata', `${key}=${text}`);
}

function buildFfmpegMetadataArgs(job) {
  const args = [];
  const title = resolvePreferredMediaTitle(job);
  const mediaType = job && job.tmdbMetadata && job.tmdbMetadata.mediaType === 'tv' ? 'tv' : 'movie';
  const year = extractYear(job && job.tmdbReleaseDate);
  const genres = Array.isArray(job && job.tmdbMetadata && job.tmdbMetadata.genres)
    ? job.tmdbMetadata.genres.filter(Boolean)
    : [];

  pushTag(args, 'title', title);
  pushTag(args, 'comment', job && job.tmdbMetadata && job.tmdbMetadata.overview);
  pushTag(args, 'description', job && job.tmdbMetadata && job.tmdbMetadata.overview);
  pushTag(args, 'genre', genres.join(', '));
  pushTag(args, 'date', year);

  if (mediaType === 'tv') {
    pushTag(args, 'show', title);
    pushTag(args, 'media_type', '10');
    if (Number.isFinite(job && job.mediaHints && job.mediaHints.seasonNumber)) {
      pushTag(args, 'season_number', job.mediaHints.seasonNumber);
    }
    if (Number.isFinite(job && job.mediaHints && job.mediaHints.episodeNumber)) {
      pushTag(args, 'episode_sort', job.mediaHints.episodeNumber);
      pushTag(args, 'episode_id', `S${String(job.mediaHints.seasonNumber || 0).padStart(2, '0')}E${String(job.mediaHints.episodeNumber).padStart(2, '0')}`);
    }
  } else {
    pushTag(args, 'media_type', '9');
  }

  return args;
}

module.exports = {
  buildFfmpegMetadataArgs,
};
