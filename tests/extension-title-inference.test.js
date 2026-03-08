const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPopupTitleHelpers() {
  const popupPath = path.join(__dirname, '..', 'apps', 'extension', 'popup.js');
  const source = fs.readFileSync(popupPath, 'utf8');
  const start = source.indexOf('function tryDecodeBase64(');
  const end = source.indexOf('function formatEpisodeTag(');

  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Failed to locate popup title helper block');
  }

  const script = [
    'let activeTab = null;',
    source.slice(start, end),
    'globalThis.__popupTitleHelpers = { getDisplayTitle, inferTitleHints, stripTitleNoise };',
  ].join('\n');

  const context = {
    URL,
    atob: (value) => Buffer.from(String(value || ''), 'base64').toString('binary'),
    globalThis: {},
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  return context.globalThis.__popupTitleHelpers;
}

function loadPopupJobPayloadHelpers() {
  const popupPath = path.join(__dirname, '..', 'apps', 'extension', 'popup.js');
  const source = fs.readFileSync(popupPath, 'utf8');
  const keyStart = source.indexOf('function getSendKey(');
  const keyEnd = source.indexOf('function setQueueButtonBusy(');
  const titleHelpersStart = source.indexOf('function tryDecodeBase64(');
  const titleHelpersEnd = source.indexOf('function appendDisplayEpisodeTagToTitle(');
  const payloadStart = source.indexOf('function buildJobPayload(');
  const payloadEnd = source.indexOf('async function sendJob(');

  if ([keyStart, keyEnd, titleHelpersStart, titleHelpersEnd, payloadStart, payloadEnd].some((idx) => idx < 0)) {
    throw new Error('Failed to locate popup payload helper block');
  }

  const script = [
    'let activeTab = { title: "Fallback Page", url: "https://example.com/watch" };',
    'const customTitleOverrides = new Map();',
    source.slice(keyStart, keyEnd),
    source.slice(titleHelpersStart, titleHelpersEnd),
    source.slice(payloadStart, payloadEnd),
    'globalThis.__popupJobPayloadHelpers = { buildJobPayload, setCustomTitleOverride };',
  ].join('\n');

  const context = {
    URL,
    atob: (value) => Buffer.from(String(value || ''), 'base64').toString('binary'),
    globalThis: {},
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  return context.globalThis.__popupJobPayloadHelpers;
}

function loadServiceWorkerHelpers() {
  const workerPath = path.join(__dirname, '..', 'apps', 'extension', 'service-worker.js');
  const source = fs.readFileSync(workerPath, 'utf8');
  const start = source.indexOf('function isDirectFallbackCandidate(');
  const end = source.indexOf('function mergeStringField(');
  const filterStart = source.indexOf('function filterOutYoutubePageItems(');
  const filterEnd = source.indexOf('async function clearSyntheticYoutubePageMedia(');

  if ([start, end, filterStart, filterEnd].some((idx) => idx < 0)) {
    throw new Error('Failed to locate service worker helper block');
  }

  const script = [
    'globalThis.__serviceWorkerHelpers = {};',
    'function isLikelySegmentUrl(url) { return /\\.(ts|m4s)(\\?|$)/i.test(String(url || "")); }',
    source.slice(start, end),
    source.slice(filterStart, filterEnd),
    'globalThis.__serviceWorkerHelpers = { attachFallbackUrls, filterOutYoutubePageItems };',
  ].join('\n');

  const context = {
    URL,
    Math,
    globalThis: {},
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  return context.globalThis.__serviceWorkerHelpers;
}

function loadMediaDetectorHelpers() {
  const detectorPath = path.join(__dirname, '..', 'apps', 'extension', 'js', 'media-detector.js');
  const source = fs.readFileSync(detectorPath, 'utf8');
  const start = source.indexOf('function resolveRequestUrl(');
  const end = source.indexOf('window.fetch = function(...args) {');

  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Failed to locate media detector helper block');
  }

  const script = [
    source.slice(start, end),
    'globalThis.__mediaDetectorHelpers = { resolveRequestUrl };',
  ].join('\n');

  const context = {
    URL,
    globalThis: {},
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  return context.globalThis.__mediaDetectorHelpers;
}

test('popup title inference ignores generic subtitles labels', () => {
  const { getDisplayTitle, inferTitleHints, stripTitleNoise } = loadPopupTitleHelpers();

  const item = {
    sourcePageTitle: 'Step Up',
    sourcePageUrl: 'https://www.cineby.gd/movie/9762',
    filename: 'aW5kZXgubTN1OA==.m3u8',
    url: 'https://example.com/aW5kZXgubTN1OA==.m3u8',
    pageTitleCandidates: [
      { source: 'document.title', value: 'Step Up' },
      { source: 'dom.text', value: 'Subtitles' },
      { source: 'url.pathname', value: 'movie 9762' },
    ],
    resourceSignals: [],
    pageEpisodeHint: null,
    youtubeMetadata: null,
    pageIsTvContext: false,
    mediaKind: 'hls-manifest',
    contentType: 'application/vnd.apple.mpegurl',
  };

  assert.equal(stripTitleNoise('Subtitles'), '');

  const displayTitle = getDisplayTitle(item);
  assert.equal(displayTitle, 'Step Up');

  const hints = inferTitleHints(item, item.sourcePageTitle, displayTitle);
  assert.equal(hints.lookupTitle, 'Step Up');
  assert.equal(hints.isTvCandidate, false);
});

test('popup job payload prefers a custom title override before sending to app', () => {
  const { buildJobPayload, setCustomTitleOverride } = loadPopupJobPayloadHelpers();

  const item = {
    id: 'media-1',
    type: 'hls',
    url: 'https://example.com/severance.1x09.m3u8',
    filename: 'severance.1x09.m3u8',
    sourcePageTitle: 'Wrong Title',
    sourcePageUrl: 'https://example.com/watch',
    requestHeaders: {},
    fallbackUrl: '',
    youtubeMetadata: null,
    pageTitleCandidates: [],
    resourceSignals: [],
    pageEpisodeHint: null,
    pageIsTvContext: false,
    mediaKind: 'hls-manifest',
    contentType: 'application/vnd.apple.mpegurl',
  };

  setCustomTitleOverride(item, 'Severance 1x09 The We We Are');
  const payload = buildJobPayload(item, 'Severance 1x09 The We We Are');

  assert.equal(payload.title, 'Severance 1x09 The We We Are');
  assert.equal(payload.resourceName, 'Severance 1x09 The We We Are');
  assert.equal(payload.titleHints.lookupTitle, 'Severance 1x09 The We We Are');
  assert.equal(payload.titleHints.seasonNumber, 1);
  assert.equal(payload.titleHints.episodeNumber, 9);
});

test('popup job payload does not auto-append episode tag when title override is manual', () => {
  const { buildJobPayload, setCustomTitleOverride } = loadPopupJobPayloadHelpers();

  const item = {
    id: 'media-2',
    type: 'hls',
    url: 'https://example.com/thedinosaurs.1x01.m3u8',
    filename: 'thedinosaurs.1x01.m3u8',
    sourcePageTitle: 'The Dinosaurs',
    sourcePageUrl: 'https://example.com/watch',
    requestHeaders: {},
    fallbackUrl: '',
    youtubeMetadata: null,
    pageTitleCandidates: [],
    resourceSignals: [],
    pageEpisodeHint: null,
    pageIsTvContext: false,
    mediaKind: 'hls-manifest',
    contentType: 'application/vnd.apple.mpegurl',
  };

  setCustomTitleOverride(item, 'The Dinosaurs');
  const payload = buildJobPayload(item, 'The Dinosaurs');

  assert.equal(payload.title, 'The Dinosaurs');
  assert.equal(payload.resourceName, 'The Dinosaurs');
  assert.equal(payload.titleHints.seasonNumber, 1);
  assert.equal(payload.titleHints.episodeNumber, 1);
});

test('manual title override remains exact text even when source looks episodic', () => {
  const { getDisplayTitle } = loadPopupTitleHelpers();
  const item = {
    sourcePageTitle: 'The Dinosaurs',
    sourcePageUrl: 'https://example.com/show/1',
    filename: 'thedinosaurs.1x01.m3u8',
    url: 'https://example.com/thedinosaurs.1x01.m3u8',
    pageTitleCandidates: [],
    resourceSignals: [],
    pageEpisodeHint: null,
    youtubeMetadata: null,
    pageIsTvContext: false,
    mediaKind: 'hls-manifest',
    contentType: 'application/vnd.apple.mpegurl',
  };

  assert.equal(getDisplayTitle(item), 'The Dinosaurs');
});

test('service worker attaches the nearest matching fallback per HLS item', () => {
  const { attachFallbackUrls } = loadServiceWorkerHelpers();

  const items = [
    {
      id: 'hls-1',
      type: 'hls',
      url: 'https://cdn.example.com/video-one/master.m3u8',
      sourcePageUrl: 'https://app.example.com/watch/room',
      sourcePageTitle: 'Example Room',
      detectedAt: 1_000,
      fallbackUrl: '',
    },
    {
      id: 'direct-2',
      type: 'file',
      url: 'https://cdn.example.com/video-two.mp4',
      sourcePageUrl: 'https://app.example.com/watch/room',
      sourcePageTitle: 'Example Room',
      detectedAt: 9_050,
      contentType: 'video/mp4',
      contentLength: 10 * 1024 * 1024,
    },
    {
      id: 'direct-1',
      type: 'file',
      url: 'https://cdn.example.com/video-one.mp4',
      sourcePageUrl: 'https://app.example.com/watch/room',
      sourcePageTitle: 'Example Room',
      detectedAt: 1_050,
      contentType: 'video/mp4',
      contentLength: 3 * 1024 * 1024,
    },
    {
      id: 'hls-2',
      type: 'hls',
      url: 'https://cdn.example.com/video-two/master.m3u8',
      sourcePageUrl: 'https://app.example.com/watch/room',
      sourcePageTitle: 'Example Room',
      detectedAt: 9_000,
      fallbackUrl: '',
    },
  ];

  const withFallbacks = attachFallbackUrls(items);
  const byId = Object.fromEntries(withFallbacks.map((item) => [item.id, item]));

  assert.equal(byId['hls-1'].fallbackUrl, 'https://cdn.example.com/video-one.mp4');
  assert.equal(byId['hls-2'].fallbackUrl, 'https://cdn.example.com/video-two.mp4');
});

test('service worker filters synthetic youtube page items without removing real media', () => {
  const { filterOutYoutubePageItems } = loadServiceWorkerHelpers();

  const filtered = filterOutYoutubePageItems([
    { id: 'yt-1', mediaKind: 'youtube-page', url: 'https://www.youtube.com/watch?v=abc123' },
    { id: 'real-1', mediaKind: 'hls-manifest', url: 'https://cdn.example.com/master.m3u8' },
    { id: 'real-2', mediaKind: 'video', url: 'https://cdn.example.com/video.mp4' },
  ]);

  assert.deepEqual(
    filtered.map((item) => item.id),
    ['real-1', 'real-2'],
  );
});

test('media detector resolves URL objects passed to fetch', () => {
  const { resolveRequestUrl } = loadMediaDetectorHelpers();
  const url = new URL('https://media.example.com/master.m3u8');

  assert.equal(resolveRequestUrl(url), 'https://media.example.com/master.m3u8');
});
