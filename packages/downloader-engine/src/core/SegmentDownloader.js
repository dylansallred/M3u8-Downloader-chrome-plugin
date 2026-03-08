const { requestWithRedirects } = require('./PlaylistUtils');

function getRetryBackoffMs(attempt) {
  const baseMs = 500;
  const maxMs = 8000;
  const factor = Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(maxMs, baseMs * factor);
}

async function downloadSegment(segmentUrl, headers, stream, job) {
  return requestWithRedirects(segmentUrl, headers, (res, _finalUrl, req) => {
    return new Promise((resolve, reject) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Segment failed with status ${res.statusCode}`));
        res.resume();
        return;
      }
      res.on('data', (chunk) => {
        if (job && job.cancelled) {
          req.destroy(new Error('Job cancelled'));
          return;
        }
        job.bytesDownloaded += chunk.length;
      });
      res.on('end', resolve);
      res.on('error', reject);
      res.pipe(stream, { end: false });
    });
  }, { timeoutMs: 10_000 });
}

module.exports = {
  getRetryBackoffMs,
  downloadSegment,
};
