const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.DISABLE_FILE_LOGS = process.env.DISABLE_FILE_LOGS || '1';

if (process.env.TEST_VERBOSE !== '1') {
  // Keep test output focused; use TEST_VERBOSE=1 for deep troubleshooting.
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
}

const { createApiServer } = require('../packages/downloader-api/src');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}

async function startFixtureMediaServer() {
  const port = await getFreePort();

  const server = http.createServer((req, res) => {
    if (req.url === '/sample.mp4') {
      const body = Buffer.alloc(512 * 1024, 1);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    if (req.url === '/slow.m3u8') {
      setTimeout(() => {
        const base = `http://127.0.0.1:${port}`;
        const playlist = [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:3',
          '#EXTINF:3,',
          `${base}/seg-1.ts`,
          '#EXTINF:3,',
          `${base}/seg-2.ts`,
          '#EXT-X-ENDLIST',
          '',
        ].join('\n');

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': Buffer.byteLength(playlist),
        });
        res.end(playlist);
      }, 1500);
      return;
    }

    if (req.url === '/broken.m3u8') {
      const base = `http://127.0.0.1:${port}`;
      const playlist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:3',
        '#EXTINF:3,',
        `${base}/missing-seg.ts`,
        '#EXT-X-ENDLIST',
        '',
      ].join('\n');

      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': Buffer.byteLength(playlist),
      });
      res.end(playlist);
      return;
    }

    if (req.url === '/seg-1.ts' || req.url === '/seg-2.ts') {
      const body = Buffer.alloc(64 * 1024, 2);
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    if (req.url === '/missing-seg.ts') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Missing segment');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function apiFetch(baseUrl, pathName, {
  method = 'GET',
  body,
  token,
  includeV1Headers = true,
  extraHeaders = {},
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (includeV1Headers) {
    headers['X-Client'] = 'fetchv-extension';
    headers['X-Protocol-Version'] = '1';
  }
  Object.assign(headers, extraHeaders || {});
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return {
    status: res.status,
    data,
  };
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 150 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await predicate();
    if (result) return result;

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await delay(intervalMs);
  }
}

async function waitForJobQueueState(baseUrl, jobId, expectedStates, opts = {}) {
  const states = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
  return waitFor(async () => {
    const queueRes = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
    const job = queueRes.data.queue.find((j) => j.id === jobId);
    if (!job) return false;
    return states.includes(job.queueStatus) ? job : false;
  }, opts);
}

async function startApi({ dataDir, port }) {
  const server = createApiServer({
    dataDir,
    port,
    host: '127.0.0.1',
    appVersion: 'test-version',
    downloadDir: path.join(dataDir, 'downloads'),
  });
  await server.start();
  return server;
}

async function issueToken(server, baseUrl) {
  const pairing = server.authManager.generatePairingCode();
  const pairRes = await apiFetch(baseUrl, '/v1/pair/complete', {
    method: 'POST',
    body: {
      pairingCode: pairing.code,
      extensionId: 'test-extension-id',
      extensionVersion: '1.0.0-test',
      browser: 'chrome',
    },
  });
  assert.equal(pairRes.status, 200);
  assert.equal(typeof pairRes.data.token, 'string');
  return pairRes.data.token;
}

test('v1 health, pairing, auth, validation, queue lifecycle, and restart recovery', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    const healthRes = await apiFetch(baseUrl, '/v1/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.data.pairingRequired, true);
    assert.equal(typeof healthRes.data.protocolVersion, 'string');
    assert.ok(healthRes.data.supportedProtocolVersions);
    assert.equal(typeof healthRes.data.minExtensionVersion, 'string');

    const badProtocolRes = await apiFetch(baseUrl, '/v1/health', {
      extraHeaders: { 'X-Protocol-Version': '999' },
    });
    assert.equal(badProtocolRes.status, 426);

    const badPairRes = await apiFetch(baseUrl, '/v1/pair/complete', {
      method: 'POST',
      body: { pairingCode: 'ABC12345' },
    });
    assert.equal(badPairRes.status, 400);

    const oldPairing = apiServer.authManager.generatePairingCode();
    const oldPairRes = await apiFetch(baseUrl, '/v1/pair/complete', {
      method: 'POST',
      body: {
        pairingCode: oldPairing.code,
        extensionId: 'test-extension-id',
        extensionVersion: '0.0.1',
        browser: 'chrome',
      },
    });
    assert.equal(oldPairRes.status, 426);

    const token = await issueToken(apiServer, baseUrl);

    const unauthorizedCreate = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      body: { mediaUrl: `${mediaServer.baseUrl}/sample.mp4`, mediaType: 'file' },
      token: null,
    });
    assert.equal(unauthorizedCreate.status, 401);

    const invalidPayloadRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      token,
      body: { mediaUrl: 'not-a-url', mediaType: 'file' },
    });
    assert.equal(invalidPayloadRes.status, 400);

    const queueSettingsRes = await apiFetch(baseUrl, '/api/queue/settings', {
      method: 'POST',
      includeV1Headers: false,
      body: { maxConcurrent: 1, autoStart: false },
    });
    assert.equal(queueSettingsRes.status, 200);

    const blockedDesktopApiFromExtensionRes = await apiFetch(baseUrl, '/api/queue', {
      method: 'GET',
      includeV1Headers: true,
      extraHeaders: { Origin: 'chrome-extension://test-extension-id' },
    });
    assert.equal(blockedDesktopApiFromExtensionRes.status, 403);

    const removedLegacyAddRes = await apiFetch(baseUrl, '/api/queue/add', {
      method: 'POST',
      includeV1Headers: false,
      body: {
        queue: { url: `${mediaServer.baseUrl}/sample.mp4`, title: 'legacy' },
      },
    });
    assert.equal(removedLegacyAddRes.status, 404);

    const createHlsRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      token,
      body: {
        mediaUrl: `${mediaServer.baseUrl}/slow.m3u8`,
        mediaType: 'hls',
        title: 'Slow HLS Job',
      },
    });
    assert.equal(createHlsRes.status, 200);

    const hlsJobId = createHlsRes.data.jobId;

    const startRes = await apiFetch(baseUrl, `/api/queue/${hlsJobId}/start`, {
      method: 'POST',
      includeV1Headers: false,
    });
    assert.equal(startRes.status, 200);

    await waitForJobQueueState(baseUrl, hlsJobId, 'downloading', { timeoutMs: 3000, intervalMs: 100 });

    const pauseRes = await apiFetch(baseUrl, `/api/queue/${hlsJobId}/pause`, {
      method: 'POST',
      includeV1Headers: false,
    });
    assert.equal(pauseRes.status, 200);

    await waitForJobQueueState(baseUrl, hlsJobId, 'paused', { timeoutMs: 5000, intervalMs: 150 });

    const resumeRes = await apiFetch(baseUrl, `/api/queue/${hlsJobId}/resume`, {
      method: 'POST',
      includeV1Headers: false,
    });
    assert.equal(resumeRes.status, 200);
    await waitForJobQueueState(baseUrl, hlsJobId, ['queued', 'downloading'], { timeoutMs: 3000, intervalMs: 100 });

    const createDirectRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      token,
      body: {
        mediaUrl: `${mediaServer.baseUrl}/sample.mp4`,
        mediaType: 'file',
        title: 'Direct File Job',
      },
    });
    assert.equal(createDirectRes.status, 200);

    const directJobId = createDirectRes.data.jobId;

    const duplicateDirectRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      token,
      body: {
        mediaUrl: `${mediaServer.baseUrl}/sample.mp4`,
        mediaType: 'file',
        title: 'Direct File Job Duplicate',
      },
    });
    assert.equal(duplicateDirectRes.status, 200);
    assert.equal(duplicateDirectRes.data.duplicate, true);
    assert.equal(duplicateDirectRes.data.jobId, directJobId);

    await apiFetch(baseUrl, '/api/queue/settings', {
      method: 'POST',
      includeV1Headers: false,
      body: { maxConcurrent: 1, autoStart: true },
    });

    await waitFor(async () => {
      const queueRes = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
      const job = queueRes.data.queue.find((j) => j.id === directJobId);
      if (!job) return false;
      return job.queueStatus === 'completed' ? job : false;
    }, { timeoutMs: 12000, intervalMs: 200 });

    const historyRes = await apiFetch(baseUrl, '/api/history', { includeV1Headers: false });
    assert.equal(historyRes.status, 200);
    assert.ok(Array.isArray(historyRes.data.items));
    assert.ok(historyRes.data.items.length >= 1);

    await apiFetch(baseUrl, '/api/queue/settings', {
      method: 'POST',
      includeV1Headers: false,
      body: { maxConcurrent: 1, autoStart: false },
    });

    const recoveryJobRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      token,
      body: {
        mediaUrl: `${mediaServer.baseUrl}/slow.m3u8`,
        mediaType: 'hls',
        title: 'Recovery Job',
      },
    });
    assert.equal(recoveryJobRes.status, 200);

    const queueBeforeRestart = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
    assert.equal(queueBeforeRestart.status, 200);
    assert.ok(queueBeforeRestart.data.queue.length > 0);
    const recoveryJobBefore = queueBeforeRestart.data.queue.find((job) => job.id === recoveryJobRes.data.jobId);
    assert.ok(recoveryJobBefore);
    assert.equal(recoveryJobBefore.queueStatus, 'queued');

    const queueFilePath = path.join(tmpRoot, 'downloads', 'queue.json');
    await waitFor(() => {
      try {
        const raw = fs.readFileSync(queueFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        const persistedQueue = Array.isArray(parsed.queue) ? parsed.queue : [];
        return persistedQueue.some((job) => job && job.id === recoveryJobRes.data.jobId);
      } catch {
        return false;
      }
    }, { timeoutMs: 3000, intervalMs: 100 });

    await apiServer.stop();

    const restarted = await startApi({ dataDir: tmpRoot, port });
    try {
      const queueAfterRestart = await waitFor(async () => {
        try {
          return await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
        } catch {
          return null;
        }
      }, { timeoutMs: 3000, intervalMs: 100 });

      assert.equal(queueAfterRestart.status, 200);
      assert.ok(queueAfterRestart.data.queue.length > 0);
      const recoveryJobAfter = queueAfterRestart.data.queue.find((job) => job.id === recoveryJobRes.data.jobId);
      assert.ok(recoveryJobAfter);
      assert.equal(recoveryJobAfter.queueStatus, 'queued');
    } finally {
      await restarted.stop();
    }
  } finally {
    await mediaServer.close();
    try {
      await apiServer.stop();
    } catch {
      // ignore if already stopped
    }
  }
});

test('cancel endpoint stops an active job', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-cancel-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    const token = await issueToken(apiServer, baseUrl);

    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      token,
      body: {
        mediaUrl: `${mediaServer.baseUrl}/slow.m3u8`,
        mediaType: 'hls',
        title: 'Cancelable Job',
      },
    });
    assert.equal(createRes.status, 200);

    const cancelRes = await apiFetch(baseUrl, `/api/jobs/${createRes.data.jobId}/cancel`, {
      method: 'POST',
      includeV1Headers: false,
    });
    assert.equal(cancelRes.status, 200);

    await waitFor(async () => {
      const statusRes = await apiFetch(baseUrl, `/api/jobs/${createRes.data.jobId}`, {
        includeV1Headers: false,
      });
      const status = statusRes.data && statusRes.data.status;
      if (status === 'cancelled' || status === 'error') {
        return true;
      }
      return false;
    }, { timeoutMs: 7000, intervalMs: 150 });
  } finally {
    await apiServer.stop();
    await mediaServer.close();
  }
});

test('hls job falls back to direct media URL when all segments fail', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-fallback-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    const token = await issueToken(apiServer, baseUrl);

    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      token,
      body: {
        mediaUrl: `${mediaServer.baseUrl}/broken.m3u8`,
        mediaType: 'hls',
        fallbackMediaUrl: `${mediaServer.baseUrl}/sample.mp4`,
        title: 'Fallback Job',
      },
    });
    assert.equal(createRes.status, 200);

    const jobId = createRes.data.jobId;
    await waitForJobQueueState(baseUrl, jobId, 'completed', { timeoutMs: 12000, intervalMs: 200 });

    const jobRes = await apiFetch(baseUrl, `/api/jobs/${jobId}`, { includeV1Headers: false });
    assert.equal(jobRes.status, 200);
    assert.equal(jobRes.data.status, 'completed');
    assert.equal(jobRes.data.progress, 100);
    assert.equal(jobRes.data.fallbackAttempted, true);
    assert.equal(jobRes.data.fallbackUsed, true);

    const fileRes = await fetch(`${baseUrl}/api/jobs/${jobId}/file`);
    assert.equal(fileRes.status, 200);
    const contentType = fileRes.headers.get('content-type') || '';
    assert.match(contentType, /^video\/(mp4|mp2t)/i);
    await fileRes.arrayBuffer();

    const disableAutoStartRes = await apiFetch(baseUrl, '/api/queue/settings', {
      method: 'POST',
      includeV1Headers: false,
      body: { autoStart: false },
    });
    assert.equal(disableAutoStartRes.status, 200);

    const retryRes = await apiFetch(baseUrl, `/api/jobs/${jobId}/retry-original-hls`, {
      method: 'POST',
      includeV1Headers: false,
    });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.data.retryOf, jobId);
    assert.ok(retryRes.data.id);

    const retryGenericRes = await apiFetch(baseUrl, `/api/jobs/${jobId}/retry`, {
      method: 'POST',
      includeV1Headers: false,
    });
    assert.equal(retryGenericRes.status, 200);
    assert.equal(retryGenericRes.data.retryOf, jobId);
    assert.ok(retryGenericRes.data.id);
  } finally {
    await apiServer.stop();
    await mediaServer.close();
  }
});
