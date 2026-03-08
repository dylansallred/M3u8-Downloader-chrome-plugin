const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStreamPlayerHelpers() {
  const playerPath = path.join(__dirname, '..', 'apps', 'extension', 'player.js');
  const source = fs.readFileSync(playerPath, 'utf8');
  const blockedStart = source.indexOf('const BLOCKED_HEADER_NAMES = new Set([');
  const applyStart = source.indexOf('function applyRequestHeadersToXhr(');
  const tryPlayStart = source.indexOf('async function tryPlay(');

  if ([blockedStart, applyStart, tryPlayStart].some((idx) => idx < 0)) {
    throw new Error('Failed to locate stream player helper block');
  }

  const script = [
    'let sourcePageUrl = "";',
    'let requestHeaders = {};',
    source.slice(blockedStart, applyStart),
    'globalThis.__streamPlayerHelpers = {',
    '  setContext: (headers, sourceUrl) => { requestHeaders = headers || {}; sourcePageUrl = sourceUrl || ""; },',
    '  normalizeRequestHeaders,',
    '  resolveReferrerUrl,',
    '  buildFetchOptions,',
    '};',
  ].join('\n');

  const context = {
    URL,
    globalThis: {},
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  return context.globalThis.__streamPlayerHelpers;
}

test('stream player fetch options preserve custom headers and derive referrer from source page', () => {
  const helpers = loadStreamPlayerHelpers();
  helpers.setContext(
    {
      Authorization: 'Bearer abc123',
      Referer: 'https://video.example/watch/123',
      Origin: 'https://video.example',
      Cookie: 'session=secret',
      'X-Custom-Token': 'token-value',
    },
    'https://video.example/watch/123',
  );

  const headers = helpers.normalizeRequestHeaders({
    Authorization: 'Bearer abc123',
    Referer: 'https://video.example/watch/123',
    Origin: 'https://video.example',
    Cookie: 'session=secret',
    'X-Custom-Token': 'token-value',
  });
  assert.equal(
    JSON.stringify(headers),
    JSON.stringify({
      Authorization: 'Bearer abc123',
      'X-Custom-Token': 'token-value',
    }),
  );

  const options = helpers.buildFetchOptions({ method: 'GET' });
  assert.equal(options.credentials, 'include');
  assert.equal(options.referrer, 'https://video.example/watch/123');
  assert.equal(options.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(options.headers.Authorization, 'Bearer abc123');
  assert.equal(options.headers['X-Custom-Token'], 'token-value');
  assert.equal('Referer' in options.headers, false);
  assert.equal('Origin' in options.headers, false);
  assert.equal('Cookie' in options.headers, false);
});
