const http = require('http');
const https = require('https');
const { URL } = require('url');

function getClient(url) {
  return url.startsWith('https') ? https : http;
}

async function fetchText(url, headers) {
  return new Promise((resolve, reject) => {
    const client = getClient(url);
    const req = client.get(url, { headers }, (res) => {
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
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
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
  fetchText,
  parseM3U8,
};
