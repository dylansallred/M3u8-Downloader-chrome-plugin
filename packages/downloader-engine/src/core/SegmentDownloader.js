const { getClient } = require('./PlaylistUtils');

function getRetryBackoffMs(attempt) {
  const baseMs = 500;
  const maxMs = 8000;
  const factor = Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(maxMs, baseMs * factor);
}

async function downloadSegment(segmentUrl, headers, stream, job) {
  return new Promise((resolve, reject) => {
    const client = getClient(segmentUrl);
    const req = client.get(segmentUrl, { headers }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Segment failed with status ${res.statusCode}`));
        res.resume();
        return;
      }
      res.on('data', (chunk) => {
        job.bytesDownloaded += chunk.length;
      });
      res.on('end', resolve);
      res.on('error', reject);
      res.pipe(stream, { end: false });
    });
    req.on('error', reject);

    const timeoutMs = 10000; // 10 seconds
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Segment request timeout after ${timeoutMs} ms`));
    });
  });
}

module.exports = {
  getRetryBackoffMs,
  downloadSegment,
};
