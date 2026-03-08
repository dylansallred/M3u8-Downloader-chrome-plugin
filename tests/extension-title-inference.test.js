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
