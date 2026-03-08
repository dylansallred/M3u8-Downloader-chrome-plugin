const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlexBaseName } = require('../packages/downloader-engine/src/utils/plexNaming');
const { buildFfmpegMetadataArgs } = require('../packages/downloader-engine/src/utils/mediaTags');

test('buildPlexBaseName uses tmdb title and year for movies', () => {
  const result = buildPlexBaseName({
    title: 'random-release-name',
    tmdbTitle: 'Dune: Part Two',
    tmdbReleaseDate: '2024-03-01',
    tmdbMetadata: { mediaType: 'movie' },
  });

  assert.equal(result, 'Dune: Part Two (2024)');
});

test('buildPlexBaseName uses show year and episode numbering for tv', () => {
  const result = buildPlexBaseName({
    title: 'severance.2x03.web-dl',
    tmdbTitle: 'Severance',
    tmdbReleaseDate: '2022-02-18',
    tmdbMetadata: { mediaType: 'tv' },
    mediaHints: { seasonNumber: 2, episodeNumber: 3 },
  });

  assert.equal(result, 'Severance (2022) - S02E03');
});

test('buildPlexBaseName prefers manual title override over stale tmdb title', () => {
  const result = buildPlexBaseName({
    title: 'Alien',
    manualTitleOverride: true,
    tmdbTitle: 'Aliens',
    tmdbReleaseDate: '1979-05-25',
    tmdbMetadata: { mediaType: 'movie' },
    mediaHints: { lookupTitle: 'Alien' },
  });

  assert.equal(result, 'Alien (1979)');
});

test('buildFfmpegMetadataArgs emits movie metadata tags', () => {
  const args = buildFfmpegMetadataArgs({
    title: 'release-name',
    tmdbTitle: 'Alien',
    tmdbReleaseDate: '1979-05-25',
    tmdbMetadata: {
      mediaType: 'movie',
      overview: 'A crew encounters a deadly organism.',
      genres: ['Science Fiction', 'Horror'],
    },
  });

  assert.deepEqual(args, [
    '-metadata', 'title=Alien',
    '-metadata', 'comment=A crew encounters a deadly organism.',
    '-metadata', 'description=A crew encounters a deadly organism.',
    '-metadata', 'genre=Science Fiction, Horror',
    '-metadata', 'date=1979',
    '-metadata', 'media_type=9',
  ]);
});

test('buildFfmpegMetadataArgs emits tv season and episode tags', () => {
  const args = buildFfmpegMetadataArgs({
    title: 'release-name',
    tmdbTitle: 'Severance',
    tmdbReleaseDate: '2022-02-18',
    tmdbMetadata: {
      mediaType: 'tv',
      overview: 'Lumon separates work and life.',
      genres: ['Drama'],
    },
    mediaHints: {
      seasonNumber: 2,
      episodeNumber: 3,
    },
  });

  assert.deepEqual(args, [
    '-metadata', 'title=Severance',
    '-metadata', 'comment=Lumon separates work and life.',
    '-metadata', 'description=Lumon separates work and life.',
    '-metadata', 'genre=Drama',
    '-metadata', 'date=2022',
    '-metadata', 'show=Severance',
    '-metadata', 'media_type=10',
    '-metadata', 'season_number=2',
    '-metadata', 'episode_sort=3',
    '-metadata', 'episode_id=S02E03',
  ]);
});
