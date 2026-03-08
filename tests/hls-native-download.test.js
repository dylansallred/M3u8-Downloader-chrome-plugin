const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFfmpegHeaderBlob,
  buildNativeHlsArgs,
  inspectHlsPlaylist,
  shouldPreferNativeHlsDownload,
} = require('../packages/downloader-engine/src/core/HlsNativeDownload');

test('inspectHlsPlaylist flags discontinuity and init-map playlists as advanced', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.000,',
    'seg-1.m4s',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:4.000,',
    'seg-2.m4s',
  ].join('\n');

  const info = inspectHlsPlaylist(playlist, 'https://media.example/video/master.m3u8');

  assert.equal(info.totalSegments, 2);
  assert.equal(info.hasMap, true);
  assert.equal(info.hasDiscontinuity, true);
  assert.equal(info.hasFmp4Segments, true);
  assert.equal(info.hasAdvancedFeatures, true);
  assert.equal(shouldPreferNativeHlsDownload(info), true);
});

test('inspectHlsPlaylist keeps simple transport-stream playlists on segmented path', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.0,',
    'seg-0.ts',
    '#EXTINF:6.0,',
    'seg-1.ts',
  ].join('\n');

  const info = inspectHlsPlaylist(playlist, 'https://media.example/video/index.m3u8');

  assert.equal(info.totalSegments, 2);
  assert.equal(info.totalDurationSeconds, 12);
  assert.equal(info.hasAdvancedFeatures, false);
  assert.equal(shouldPreferNativeHlsDownload(info), false);
});

test('buildNativeHlsArgs forwards headers and uses ffmpeg native HLS demuxing options', () => {
  const args = buildNativeHlsArgs({
    job: { id: 'job-123' },
    playlistUrl: 'https://media.example/video/index.m3u8',
    outputPath: '/tmp/job-123.mp4.part',
    headers: {
      Authorization: 'Bearer abc',
      Referer: 'https://site.example/watch',
      Host: 'should-be-dropped.example',
    },
  });

  const joinedArgs = args.join(' ');
  assert.ok(joinedArgs.includes('-progress pipe:2'));
  assert.ok(joinedArgs.includes('-allowed_extensions ALL'));
  assert.ok(joinedArgs.includes('-protocol_whitelist file,http,https,tcp,tls,crypto,data'));
  assert.ok(joinedArgs.includes('-c copy'));
  assert.ok(joinedArgs.includes('/tmp/job-123.mp4.part'));
  const headerBlob = buildFfmpegHeaderBlob({
    Authorization: 'Bearer abc',
    Referer: 'https://site.example/watch',
    Host: 'should-be-dropped.example',
  });
  assert.ok(headerBlob.includes('Authorization: Bearer abc'));
  assert.ok(headerBlob.includes('Referer: https://site.example/watch'));
  assert.equal(headerBlob.includes('Host:'), false);
});
