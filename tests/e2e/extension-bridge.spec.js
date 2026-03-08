const { test, expect, chromium } = require('@playwright/test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.DISABLE_FILE_LOGS = process.env.DISABLE_FILE_LOGS || '1';

const { createApiServer } = require('../../packages/downloader-api/src');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close((err) => {
        if (err) return reject(err);
        resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}

async function startMediaFixtureServer() {
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

    if (req.url === '/page') {
      const html = `<!doctype html>
<html>
  <head><title>Fixture Stream Page</title></head>
  <body>
    <h1>Fixture Stream Page</h1>
    <button id="trigger">Trigger Media Fetch</button>
    <script>
      const run = () => fetch(window.location.origin + '/sample.mp4').catch(() => null);
      document.getElementById('trigger').addEventListener('click', run);
      setTimeout(run, 200);
    </script>
  </body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
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

async function startCompatibilityFixtureServer() {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/health') {
      const body = JSON.stringify({
        status: 'ok',
        appVersion: 'e2e-test',
        apiVersion: '1',
        protocolVersion: '1',
        supportedProtocolVersions: { min: 1, max: 1 },
        minExtensionVersion: '99.0.0',
        pairingRequired: false,
        wsPath: '/ws',
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
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

async function waitForJobQueued(baseUrl, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/queue`);
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json.queue) && json.queue.length > 0) {
        return json.queue[0];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for queued job');
}

async function waitForQueueCount(baseUrl, expectedCount, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/queue`);
    if (res.ok) {
      const json = await res.json();
      const count = Array.isArray(json.queue) ? json.queue.length : 0;
      if (count >= expectedCount) return count;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for queue count >= ${expectedCount}`);
}

async function startTestApiServer({ dataRoot, port }) {
  const apiServer = createApiServer({
    dataDir: dataRoot,
    host: '127.0.0.1',
    port,
    appVersion: 'e2e-test',
    downloadDir: path.join(dataRoot, 'downloads'),
  });
  await apiServer.start();
  return apiServer;
}

async function withFixtureApp(run) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-e2e-api-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-e2e-chromium-'));
  const extensionPath = path.resolve(__dirname, '../../apps/extension');
  const apiPort = await getFreePort();
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const apiServer = createApiServer({
    dataDir: dataRoot,
    host: '127.0.0.1',
    port: apiPort,
    appVersion: 'e2e-test',
    downloadDir: path.join(dataRoot, 'downloads'),
  });

  const mediaServer = await startMediaFixtureServer();

  let context;
  let popupPage;
  let extensionId;

  try {
    await apiServer.start();

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const fixturePage = await context.newPage();
    await fixturePage.goto(`${mediaServer.baseUrl}/page`);
    await fixturePage.waitForTimeout(1200);
    await fixturePage.click('#trigger');

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }

    extensionId = new URL(serviceWorker.url()).host;

    popupPage = await context.newPage();
    await popupPage.addInitScript(() => {
      window.__e2eAlerts = [];
      window.alert = (message) => {
        window.__e2eAlerts.push(String(message));
      };
    });
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html?tabUrl=${encodeURIComponent(`${mediaServer.baseUrl}/page`)}&apiBase=${encodeURIComponent(apiBaseUrl)}`);

    await run({
      apiServer,
      apiBaseUrl,
      popupPage,
    });
  } finally {
    if (context) {
      await context.close();
    }
    await mediaServer.close();
    await apiServer.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

async function withExtensionOnly(apiBaseUrl, run) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-e2e-chromium-'));
  const extensionPath = path.resolve(__dirname, '../../apps/extension');
  const mediaServer = await startMediaFixtureServer();

  let context;
  let popupPage;
  let extensionId;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const fixturePage = await context.newPage();
    await fixturePage.goto(`${mediaServer.baseUrl}/page`);
    await fixturePage.waitForTimeout(1200);
    await fixturePage.click('#trigger');

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }

    extensionId = new URL(serviceWorker.url()).host;

    popupPage = await context.newPage();
    await popupPage.addInitScript(() => {
      window.__e2eAlerts = [];
      window.alert = (message) => {
        window.__e2eAlerts.push(String(message));
      };
    });
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html?tabUrl=${encodeURIComponent(`${mediaServer.baseUrl}/page`)}&apiBase=${encodeURIComponent(apiBaseUrl)}`);

    await run({
      popupPage,
    });
  } finally {
    if (context) {
      await context.close();
    }
    await mediaServer.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

test('extension popup can send detected media to local API queue', async () => {
  test.skip(process.platform === 'win32', 'Extension automation is validated in CI on Linux runner');

  await withFixtureApp(async ({ apiBaseUrl, popupPage }) => {
    await expect(popupPage.locator('#connectionStatus')).toContainText('App connected');

    await popupPage.click('#refreshButton');
    await expect(popupPage.locator('.media-item').first()).toBeVisible();

    await popupPage.click('button:has-text("Send to App")');
    await popupPage.waitForTimeout(600);

    await expect(popupPage.locator('#toastRegion')).toContainText('Queued:');

    const queued = await waitForJobQueued(apiBaseUrl);
    expect(queued).toBeTruthy();
    expect(queued.title).toContain('Fixture Stream Page');
  });
});

test('extension shows desktop app unreachable guidance when local API is down', async () => {
  test.skip(process.platform === 'win32', 'Extension automation is validated in CI on Linux runner');

  const unusedPort = await getFreePort();
  const unreachableApiBase = `http://127.0.0.1:${unusedPort}`;

  await withExtensionOnly(unreachableApiBase, async ({ popupPage }) => {
    await expect(popupPage.locator('#connectionStatus')).toContainText('not running');

    await popupPage.click('#refreshButton');
    await expect(popupPage.locator('#connectionStatus')).toContainText('not running');
  });
});

test('extension blocks enqueue when app requires newer extension version', async () => {
  test.skip(process.platform === 'win32', 'Extension automation is validated in CI on Linux runner');

  const compatibilityServer = await startCompatibilityFixtureServer();

  try {
    await withExtensionOnly(compatibilityServer.baseUrl, async ({ popupPage }) => {
      await expect(popupPage.locator('#connectionStatus')).toContainText('update required');
      await popupPage.click('#refreshButton');
      await expect(popupPage.locator('.media-item').first()).toBeVisible();
      await popupPage.click('button:has-text("Send to App")');
      await expect(popupPage.locator('#toastRegion')).toContainText('Update required before sending jobs');
    });
  } finally {
    await compatibilityServer.close();
  }
});

test('extension recovers after local desktop API restarts and can enqueue again', async () => {
  test.skip(process.platform === 'win32', 'Extension automation is validated in CI on Linux runner');

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-e2e-restart-api-'));
  const apiPort = await getFreePort();
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  let apiServer = await startTestApiServer({ dataRoot, port: apiPort });

  try {
    await withExtensionOnly(apiBaseUrl, async ({ popupPage }) => {
      await expect(popupPage.locator('#connectionStatus')).toContainText('App connected');

      await popupPage.click('#refreshButton');
      await expect(popupPage.locator('.media-item').first()).toBeVisible();

      await popupPage.click('button:has-text("Send to App")');
      await waitForQueueCount(apiBaseUrl, 1, 10_000);

      await apiServer.stop();
      await popupPage.click('#refreshButton');
      await expect(popupPage.locator('#connectionStatus')).toContainText('not running');

      apiServer = await startTestApiServer({ dataRoot, port: apiPort });
      await popupPage.waitForTimeout(350);
      await popupPage.click('#refreshButton');
      await expect(popupPage.locator('#connectionStatus')).toContainText('App connected');

      await popupPage.click('button:has-text("Send to App")');
      await waitForQueueCount(apiBaseUrl, 2, 10_000);
    });
  } finally {
    if (apiServer) {
      await apiServer.stop();
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
