const http = require('http');
const https = require('https');
const { URL } = require('url');

function getClient(url) {
  return url.startsWith('https') ? https : http;
}

function isRedirectResponse(res) {
  const status = Number(res && res.statusCode || 0);
  return status >= 300 && status < 400 && !!(res && res.headers && res.headers.location);
}

function resolveRedirectUrl(location, currentUrl) {
  return new URL(String(location || ''), currentUrl).toString();
}

async function requestWithRedirects(url, headers, onResponse, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const maxRedirects = Number.isFinite(Number(options.maxRedirects))
    ? Math.max(0, Math.floor(Number(options.maxRedirects)))
    : 5;
  const visited = new Set();

  return new Promise((resolve, reject) => {
    let settled = false;

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const run = (currentUrl, redirectsRemaining) => {
      if (visited.has(currentUrl)) {
        settleReject(new Error('Redirect loop detected'));
        return;
      }
      visited.add(currentUrl);

      const client = getClient(currentUrl);
      const req = client.get(currentUrl, { headers }, (res) => {
        if (isRedirectResponse(res)) {
          if (redirectsRemaining <= 0) {
            res.resume();
            settleReject(new Error('Too many redirects'));
            return;
          }

          let nextUrl = '';
          try {
            nextUrl = resolveRedirectUrl(res.headers.location, currentUrl);
          } catch (err) {
            res.resume();
            settleReject(err);
            return;
          }

          res.resume();
          run(nextUrl, redirectsRemaining - 1);
          return;
        }

        Promise.resolve(onResponse(res, currentUrl, req)).then(settleResolve, settleReject);
      });

      req.on('error', settleReject);
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Request timeout after ${timeoutMs} ms`));
        });
      }
    };

    run(url, maxRedirects);
  });
}

async function fetchText(url, headers) {
  return requestWithRedirects(url, headers, (res, finalUrl) => {
    return new Promise((resolve, reject) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Request failed with status ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ text: data, finalUrl }));
      res.on('error', reject);
    });
  }, { timeoutMs: 30_000 });
}

function parseM3U8(playlistText, playlistUrl) {
  const lines = playlistText.split(/\r?\n/);
  const urls = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      const u = new URL(trimmed, playlistUrl);
      urls.push(u.toString());
    } catch {
      // ignore malformed lines
    }
  }
  return urls;
}

module.exports = {
  getClient,
  requestWithRedirects,
  fetchText,
  parseM3U8,
};
