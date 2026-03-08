const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

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
const { inferMediaMetadata } = require('../packages/downloader-api/src/utils/mediaMetadata');

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
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;

    if (pathname === '/sample.mp4') {
      const body = Buffer.alloc(512 * 1024, 1);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    if (pathname === '/slow.m3u8') {
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

    if (pathname === '/long.m3u8') {
      const base = `http://127.0.0.1:${port}`;
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
      ];
      for (let i = 1; i <= 18; i += 1) {
        lines.push('#EXTINF:2,');
        lines.push(`${base}/slow-seg-${i}.ts`);
      }
      lines.push('#EXT-X-ENDLIST', '');
      const playlist = lines.join('\n');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': Buffer.byteLength(playlist),
      });
      res.end(playlist);
      return;
    }

    if (pathname === '/broken.m3u8') {
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

    if (pathname === '/seg-1.ts' || pathname === '/seg-2.ts') {
      const body = Buffer.alloc(64 * 1024, 2);
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    if (/^\/slow-seg-\d+[.]ts$/.test(pathname)) {
      const body = Buffer.alloc(96 * 1024, 3);
      setTimeout(() => {
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Content-Length': body.length,
        });
        res.end(body);
      }, 250);
      return;
    }

    if (pathname === '/missing-seg.ts') {
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
  while (true) {
    const result = await predicate();
    if (result) return result;

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await delay(intervalMs);
  }
}

async function waitForWsMessage(ws, predicate, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (raw) => {
      try {
        const parsed = JSON.parse(String(raw || ''));
        if (!predicate(parsed)) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(parsed);
      } catch {
        // ignore malformed frames
      }
    };

    ws.on('message', onMessage);
  });
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

async function startApi({ dataDir, port, ...options }) {
  const server = createApiServer({
    dataDir,
    port,
    host: '127.0.0.1',
    appVersion: 'test-version',
    downloadDir: path.join(dataDir, 'downloads'),
    ...options,
  });
  await server.start();
  return server;
}

test('media metadata inference detects common TV episode patterns', () => {
  const patterns = [
    {
      input: { title: 'The Office S02E05 1080p WEB-DL' },
      expected: { lookupTitle: 'The Office', seasonNumber: 2, episodeNumber: 5 },
    },
    {
      input: { title: 'Severance 1x09 Finale', resourceName: 'severance.1x09.m3u8' },
      expected: { lookupTitle: 'Severance Finale', seasonNumber: 1, episodeNumber: 9 },
    },
    {
      input: { title: 'Show Name', resourceName: 'Show.Name.Season.03.Episode.07.mp4' },
      expected: { lookupTitle: 'Show Name', seasonNumber: 3, episodeNumber: 7 },
    },
  ];

  for (const sample of patterns) {
    const hints = inferMediaMetadata(sample.input);
    assert.equal(hints.isTvCandidate, true);
    assert.equal(hints.seasonNumber, sample.expected.seasonNumber);
    assert.equal(hints.episodeNumber, sample.expected.episodeNumber);
    assert.equal(hints.lookupTitle, sample.expected.lookupTitle);
  }

  const movieLike = inferMediaMetadata({ title: 'Dune Part Two 2024 2160p' });
  assert.equal(movieLike.isTvCandidate, false);
  assert.equal(movieLike.seasonNumber, null);
  assert.equal(movieLike.episodeNumber, null);
  assert.equal(movieLike.lookupTitle, 'Dune Part Two 2024');

  const tvRouteHint = inferMediaMetadata({
    title: 'Scrubs',
    sourcePageUrl: 'https://www.cineby.gd/tv/295778',
  });
  assert.equal(tvRouteHint.isTvCandidate, true);
  assert.equal(tvRouteHint.lookupTitle, 'Scrubs');
});

test('queued jobs can be renamed before download', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-rename-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    const queueSettingsRes = await apiFetch(baseUrl, '/api/queue/settings', {
      method: 'POST',
      includeV1Headers: false,
      body: { maxConcurrent: 1, autoStart: false },
    });
    assert.equal(queueSettingsRes.status, 200);

    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      body: {
        mediaUrl: `${mediaServer.baseUrl}/sample.mp4`,
        mediaType: 'file',
        title: 'Wrong Title',
      },
    });
    assert.equal(createRes.status, 200);

    const jobId = createRes.data.jobId;
    const renameRes = await apiFetch(baseUrl, `/api/queue/${jobId}/rename`, {
      method: 'POST',
      includeV1Headers: false,
      body: { title: 'Correct Title (2024)' },
    });
    assert.equal(renameRes.status, 200);

    const queueRes = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
    const job = queueRes.data.queue.find((entry) => entry.id === jobId);
    assert.ok(job);
    assert.equal(job.title, 'Correct Title (2024)');
    assert.equal(job.manualTitleOverride, true);
  } finally {
    await apiServer.stop();
    await mediaServer.close();
  }
});

test('v1 health, validation, queue lifecycle, and restart recovery', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    const healthRes = await apiFetch(baseUrl, '/v1/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.data.pairingRequired, false);
    assert.equal(typeof healthRes.data.protocolVersion, 'string');
    assert.ok(healthRes.data.supportedProtocolVersions);
    assert.equal(typeof healthRes.data.minExtensionVersion, 'string');

    const badProtocolRes = await apiFetch(baseUrl, '/v1/health', {
      extraHeaders: { 'X-Protocol-Version': '999' },
    });
    assert.equal(badProtocolRes.status, 426);

    const noAuthQueueRes = await apiFetch(baseUrl, '/v1/queue');
    assert.equal(noAuthQueueRes.status, 200);

    const invalidPayloadRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
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
    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
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

test('pause then delete during active HLS download does not leave top-level .ts artifacts', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-pause-delete-cleanup-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const downloadDir = path.join(tmpRoot, 'downloads');

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    await apiFetch(baseUrl, '/api/queue/settings', {
      method: 'POST',
      includeV1Headers: false,
      body: { maxConcurrent: 1, autoStart: true },
    });

    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      body: {
        mediaUrl: `${mediaServer.baseUrl}/long.m3u8`,
        mediaType: 'hls',
        title: 'Pause Delete Cleanup Job',
      },
    });
    assert.equal(createRes.status, 200);
    const jobId = createRes.data.jobId;

    await waitForJobQueueState(baseUrl, jobId, 'downloading', { timeoutMs: 8_000, intervalMs: 120 });

    const pauseRes = await apiFetch(baseUrl, `/api/queue/${jobId}/pause`, {
      method: 'POST',
      includeV1Headers: false,
    });
    assert.equal(pauseRes.status, 200);
    await waitForJobQueueState(baseUrl, jobId, 'paused', { timeoutMs: 8_000, intervalMs: 150 });

    const deleteRes = await apiFetch(baseUrl, `/api/queue/${jobId}?deleteFiles=true`, {
      method: 'DELETE',
      includeV1Headers: false,
    });
    assert.equal(deleteRes.status, 200);

    await delay(500);

    const files = fs.readdirSync(downloadDir, { withFileTypes: true });
    const topLevelJobArtifacts = files
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(`${jobId}-`));
    const topLevelTsArtifacts = topLevelJobArtifacts.filter((name) => /[.]ts$/i.test(name));
    assert.deepEqual(topLevelTsArtifacts, []);

    const tempJobDirs = files
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('temp-') && name.endsWith(`-${jobId}`));
    assert.deepEqual(tempJobDirs, []);
    assert.equal(fs.existsSync(path.join(downloadDir, jobId)), false, 'expected job folder to be removed');
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
    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
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

test('queue auto-start fills available concurrency slots up to maxConcurrent', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-concurrency-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    const settingsRes = await apiFetch(baseUrl, '/api/queue/settings', {
      method: 'POST',
      includeV1Headers: false,
      body: { maxConcurrent: 3, autoStart: true },
    });
    assert.equal(settingsRes.status, 200);

    const createdIds = [];
    for (let i = 0; i < 4; i += 1) {
      const createRes = await apiFetch(baseUrl, '/v1/jobs', {
        method: 'POST',
        body: {
          mediaUrl: `${mediaServer.baseUrl}/slow.m3u8?job=${i}`,
          mediaType: 'hls',
          title: `Concurrency Job ${i + 1}`,
        },
      });
      assert.equal(createRes.status, 200);
      createdIds.push(createRes.data.jobId);
    }

    await waitFor(async () => {
      const queueRes = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
      const active = queueRes.data.queue.filter((job) => job.queueStatus === 'downloading').length;
      return active >= 3 ? queueRes.data.queue : false;
    }, { timeoutMs: 6000, intervalMs: 120 });

    await waitFor(async () => {
      const queueRes = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
      const completed = queueRes.data.queue.filter((job) => job.queueStatus === 'completed').length;
      return completed === createdIds.length ? true : false;
    }, { timeoutMs: 20_000, intervalMs: 250 });
  } finally {
    await apiServer.stop();
    await mediaServer.close();
  }
});

test('completed downloads are stored under a per-job folder', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-job-folder-layout-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const downloadDir = path.join(tmpRoot, 'downloads');

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      body: {
        mediaUrl: `${mediaServer.baseUrl}/sample.mp4`,
        mediaType: 'file',
        title: 'Folder Layout Job',
      },
    });
    assert.equal(createRes.status, 200);
    const jobId = createRes.data.jobId;

    await waitFor(async () => {
      const queueRes = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
      const job = queueRes.data.queue.find((entry) => entry.id === jobId);
      return job && job.queueStatus === 'completed' ? true : false;
    }, { timeoutMs: 12_000, intervalMs: 200 });

    const queueFilePath = path.join(downloadDir, 'queue.json');
    const queuePayload = JSON.parse(fs.readFileSync(queueFilePath, 'utf8'));
    const persisted = (queuePayload.queue || []).find((entry) => entry.id === jobId);
    assert.ok(persisted);
    assert.equal(path.dirname(persisted.filePath), path.join(downloadDir, jobId));
    assert.equal(fs.existsSync(persisted.filePath), true);
  } finally {
    await apiServer.stop();
    await mediaServer.close();
  }
});

test('removing a completed queue item does not remove external history entries', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-external-history-retention-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const externalCompletedDir = path.join(tmpRoot, 'plex-output');

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({
    dataDir: tmpRoot,
    port,
    getCompletedOutputDir: () => externalCompletedDir,
  });

  try {
    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      body: {
        mediaUrl: `${mediaServer.baseUrl}/sample.mp4`,
        mediaType: 'file',
        title: 'External History Retention Job',
      },
    });
    assert.equal(createRes.status, 200);
    const jobId = createRes.data.jobId;

    const completedJob = await waitFor(async () => {
      const queueRes = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
      const job = queueRes.data.queue.find((entry) => entry.id === jobId);
      return job && job.queueStatus === 'completed' ? job : false;
    }, { timeoutMs: 12_000, intervalMs: 200 });

    const historyBeforeDelete = await apiFetch(baseUrl, '/api/history', { includeV1Headers: false });
    assert.equal(historyBeforeDelete.status, 200);
    const historyItemBeforeDelete = historyBeforeDelete.data.items.find((entry) => entry.jobId === jobId);
    assert.ok(historyItemBeforeDelete);
    assert.equal(fs.existsSync(historyItemBeforeDelete.absolutePath), true);
    assert.equal(path.dirname(historyItemBeforeDelete.absolutePath), externalCompletedDir);

    const deleteRes = await apiFetch(baseUrl, `/api/queue/${jobId}`, {
      method: 'DELETE',
      includeV1Headers: false,
    });
    assert.equal(deleteRes.status, 200);

    const historyAfterDelete = await waitFor(async () => {
      const historyRes = await apiFetch(baseUrl, '/api/history', { includeV1Headers: false });
      const item = historyRes.data.items.find((entry) => entry.absolutePath === historyItemBeforeDelete.absolutePath);
      return item ? historyRes : false;
    }, { timeoutMs: 5_000, intervalMs: 200 });

    assert.equal(historyAfterDelete.status, 200);
    assert.equal(
      historyAfterDelete.data.items.some((entry) => entry.absolutePath === historyItemBeforeDelete.absolutePath),
      true,
    );

    const queueAfterDelete = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
    assert.equal(queueAfterDelete.status, 200);
    assert.equal(queueAfterDelete.data.queue.some((entry) => entry.id === completedJob.id), false);
  } finally {
    await apiServer.stop();
    await mediaServer.close();
  }
});

test('websocket channels publish compatibility and queue updates', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-ws-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  try {
    const compatibilityMessagePromise = waitForWsMessage(
      ws,
      (message) => message && message.type === 'compatibility:update',
      { timeoutMs: 5000 },
    );
    const initialQueueMessagePromise = waitForWsMessage(
      ws,
      (message) => message && message.type === 'queue:update',
      { timeoutMs: 5000 },
    );

    ws.send(JSON.stringify({ type: 'subscribe', channel: 'compatibility' }));
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'queue' }));

    const compatibilityMessage = await compatibilityMessagePromise;
    assert.equal(compatibilityMessage.type, 'compatibility:update');
    assert.equal(typeof compatibilityMessage.data.appVersion, 'string');

    const initialQueueMessage = await initialQueueMessagePromise;
    assert.equal(initialQueueMessage.type, 'queue:update');
    assert.ok(Array.isArray(initialQueueMessage.data.queue));

    const createRes = await apiFetch(baseUrl, '/v1/jobs', {
      method: 'POST',
      body: {
        mediaUrl: `${mediaServer.baseUrl}/sample.mp4`,
        mediaType: 'file',
        title: 'WebSocket Queue Event Job',
      },
    });
    assert.equal(createRes.status, 200);

    const updateMessage = await waitForWsMessage(
      ws,
      (message) => (
        message
        && message.type === 'queue:update'
        && Array.isArray(message.data?.queue)
        && message.data.queue.some((job) => job.id === createRes.data.jobId)
      ),
      { timeoutMs: 7000 },
    );
    assert.equal(updateMessage.type, 'queue:update');
  } finally {
    ws.close();
    await apiServer.stop();
    await mediaServer.close();
  }
});

test('history endpoint supports cursor pagination with persisted index', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-history-pagination-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const mediaServer = await startFixtureMediaServer();
  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    await apiFetch(baseUrl, '/api/queue/settings', {
      method: 'POST',
      includeV1Headers: false,
      body: { maxConcurrent: 1, autoStart: true },
    });

    for (let i = 0; i < 3; i += 1) {
      const createRes = await apiFetch(baseUrl, '/v1/jobs', {
        method: 'POST',
        body: {
          mediaUrl: `${mediaServer.baseUrl}/sample.mp4`,
          mediaType: 'file',
          title: `History Pagination ${i + 1}`,
        },
      });
      assert.equal(createRes.status, 200);

      const jobId = createRes.data.jobId;
      await waitFor(async () => {
        const queueRes = await apiFetch(baseUrl, '/api/queue', { includeV1Headers: false });
        const job = queueRes.data.queue.find((entry) => entry.id === jobId);
        return job && job.queueStatus === 'completed' ? true : false;
      }, { timeoutMs: 12_000, intervalMs: 200 });
    }

    const page1 = await apiFetch(baseUrl, '/api/history?limit=1', { includeV1Headers: false });
    assert.equal(page1.status, 200);
    assert.equal(page1.data.items.length, 1);
    assert.equal(typeof page1.data.nextCursor, 'string');

    const page2 = await apiFetch(
      baseUrl,
      `/api/history?limit=1&cursor=${encodeURIComponent(page1.data.nextCursor)}`,
      { includeV1Headers: false },
    );
    assert.equal(page2.status, 200);
    assert.equal(page2.data.items.length, 1);
    assert.notEqual(page2.data.items[0].fileName, page1.data.items[0].fileName);
  } finally {
    await apiServer.stop();
    await mediaServer.close();
  }
});

test('history delete removes related sidecar files and temp directories for the same job', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-history-delete-artifacts-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const downloadDir = path.join(tmpRoot, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const jobId = 'abc123-def456';
  const targetFile = `${jobId}-cleanup-target.mp4`;
  const jobDir = path.join(downloadDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const relatedArtifacts = [
    targetFile,
    `${targetFile}.part`,
    `${jobId}-thumb.jpg`,
    `${jobId}-subtitles.srt`,
    `${jobId}-subtitles.zip`,
    `ts-parts-${jobId}.txt`,
    `${jobId}-cleanup-target.ts`,
  ];
  const unrelatedFile = 'keep-this-file.mp4';
  const unrelatedJobDir = path.join(downloadDir, 'otherjob-keep');
  fs.mkdirSync(unrelatedJobDir, { recursive: true });
  const unrelatedJobFile = path.join(unrelatedJobDir, 'otherjob-keep.ts');

  relatedArtifacts.forEach((fileName) => {
    fs.writeFileSync(path.join(jobDir, fileName), Buffer.from('artifact'));
  });
  fs.writeFileSync(path.join(downloadDir, unrelatedFile), Buffer.from('keep'));
  fs.writeFileSync(unrelatedJobFile, Buffer.from('keep'));

  const tempDir = path.join(downloadDir, `temp-history-cleanup-${jobId}`);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'seg-1.ts'), Buffer.from('segment'));
  fs.writeFileSync(path.join(tempDir, 'leftover.tmp'), Buffer.from('tmp'));

  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    await waitFor(async () => {
      const historyRes = await apiFetch(baseUrl, '/api/history', { includeV1Headers: false });
      const item = historyRes.data.items.find((entry) => entry.fileName === targetFile);
      if (!item) return false;
      return item.thumbnailUrl === `/downloads/${jobId}/${jobId}-thumb.jpg` ? true : false;
    }, { timeoutMs: 4000, intervalMs: 120 });

    const deleteRes = await apiFetch(baseUrl, `/api/history/${encodeURIComponent(targetFile)}`, {
      method: 'DELETE',
      includeV1Headers: false,
    });
    assert.equal(deleteRes.status, 200);

    relatedArtifacts.forEach((fileName) => {
      assert.equal(fs.existsSync(path.join(jobDir, fileName)), false, `expected ${fileName} to be removed`);
    });
    assert.equal(fs.existsSync(jobDir), false, 'expected nested job folder to be removed');
    assert.equal(fs.existsSync(tempDir), false, 'expected job temp directory to be removed');
    assert.equal(fs.existsSync(path.join(downloadDir, unrelatedFile)), true, 'expected unrelated file to remain');
    assert.equal(fs.existsSync(unrelatedJobFile), true, 'expected unrelated job file to remain');

    const historyAfterDelete = await apiFetch(baseUrl, '/api/history', { includeV1Headers: false });
    assert.equal(historyAfterDelete.status, 200);
    assert.equal(
      historyAfterDelete.data.items.some((entry) => entry.fileName === targetFile),
      false,
    );
  } finally {
    await apiServer.stop();
  }
});

test('history clear removes stale managed artifacts including subtitles and partial files', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-tests-history-clear-artifacts-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const downloadDir = path.join(tmpRoot, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const managedGroups = [
    {
      dir: path.join(downloadDir, 'job1'),
      files: ['job1-clip.mp4', 'job1-clip.mp4.part', 'job1-thumb.jpg', 'job1-subtitles.srt'],
    },
    {
      dir: path.join(downloadDir, 'job2'),
      files: ['job2-clip.ts', 'job2-subtitles.zip', 'ts-parts-job2.txt'],
    },
  ];
  for (const group of managedGroups) {
    fs.mkdirSync(group.dir, { recursive: true });
    group.files.forEach((fileName) => {
      fs.writeFileSync(path.join(group.dir, fileName), Buffer.from('managed'));
    });
  }
  const legacyManaged = path.join(downloadDir, 'legacy-job3-clip.mp4.part');
  fs.writeFileSync(legacyManaged, Buffer.from('managed'));

  const managedTempDirs = [
    path.join(downloadDir, 'temp-orphan-job1'),
    path.join(downloadDir, 'temp-orphan-job2'),
  ];
  managedTempDirs.forEach((dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'seg-0.ts'), Buffer.from('segment'));
  });

  const keepFile = 'keep-notes.txt';
  fs.writeFileSync(path.join(downloadDir, keepFile), Buffer.from('keep'));

  const apiServer = await startApi({ dataDir: tmpRoot, port });

  try {
    const clearRes = await apiFetch(baseUrl, '/api/history', {
      method: 'DELETE',
      includeV1Headers: false,
    });
    assert.equal(clearRes.status, 200);

    for (const group of managedGroups) {
      group.files.forEach((fileName) => {
        assert.equal(fs.existsSync(path.join(group.dir, fileName)), false, `expected ${fileName} to be removed`);
      });
      assert.equal(fs.existsSync(group.dir), false, `expected ${path.basename(group.dir)} to be removed`);
    }
    assert.equal(fs.existsSync(legacyManaged), false, 'expected legacy managed file to be removed');
    managedTempDirs.forEach((dirPath) => {
      assert.equal(fs.existsSync(dirPath), false, `expected ${path.basename(dirPath)} to be removed`);
    });
    assert.equal(fs.existsSync(path.join(downloadDir, keepFile)), true, 'expected unmanaged file to remain');

    const historyRes = await apiFetch(baseUrl, '/api/history', { includeV1Headers: false });
    assert.equal(historyRes.status, 200);
    assert.equal(Array.isArray(historyRes.data.items), true);
    assert.equal(historyRes.data.items.length, 0);
  } finally {
    await apiServer.stop();
  }
});
