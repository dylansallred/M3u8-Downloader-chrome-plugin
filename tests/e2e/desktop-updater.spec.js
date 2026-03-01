const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

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

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for renderer server at ${url}`);
}

async function startDesktopRendererServer() {
  const port = await getFreePort();
  const workspaceRoot = path.resolve(__dirname, '../..');
  const child = spawn(
    'npm',
    [
      'run',
      'dev:renderer',
      '--workspace',
      '@m3u8/desktop',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let startupLog = '';
  child.stdout.on('data', (chunk) => { startupLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { startupLog += chunk.toString(); });

  try {
    await waitForServer(`http://127.0.0.1:${port}`);
  } catch (err) {
    child.kill('SIGTERM');
    throw new Error(`${err.message}\n--- renderer logs ---\n${startupLog}`);
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      if (child.killed) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

test('updates view reflects updater state transitions and enables install when downloaded', async ({ page }) => {
  const renderer = await startDesktopRendererServer();

  try {
    await page.addInitScript(() => {
      const listeners = [];
      const state = {
        updater: { phase: 'idle', message: 'Idle', progress: 0 },
        checkCalls: 0,
        installCalls: 0,
      };

      const emit = (payload) => {
        state.updater = { ...payload };
        listeners.forEach((cb) => cb({ ...payload }));
      };

      window.__desktopTestHarness = {
        emitUpdater: emit,
        getState: () => ({ ...state }),
      };

      window.desktop = {
        getAppInfo: async () => ({ apiBaseUrl: window.location.origin }),
        getSettings: async () => ({
          queueMaxConcurrent: 1,
          queueAutoStart: true,
          checkUpdatesOnStartup: true,
        }),
        saveSettings: async (settings) => ({
          queueMaxConcurrent: settings?.queueMaxConcurrent ?? 1,
          queueAutoStart: settings?.queueAutoStart ?? true,
          checkUpdatesOnStartup: settings?.checkUpdatesOnStartup ?? true,
        }),
        generatePairingCode: async () => ({
          code: 'TEST1234',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
        listTokens: async () => [],
        revokeToken: async () => ({ ok: true }),
        revokeAllTokens: async () => ({ ok: true }),
        getUpdaterState: async () => ({ ...state.updater }),
        checkForUpdates: async () => {
          state.checkCalls += 1;
          emit({ phase: 'checking', message: 'Checking for updates...', progress: 0 });
          return { ok: true };
        },
        installUpdateNow: async () => {
          state.installCalls += 1;
          return { ok: true };
        },
        onUpdaterEvent: (cb) => {
          listeners.push(cb);
          return () => {
            const idx = listeners.indexOf(cb);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
      };
    });

    await page.route('**/api/queue', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ queue: [], settings: { maxConcurrent: 1, autoStart: true } }),
      });
    });

    await page.route('**/api/history', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });

    await page.goto(renderer.baseUrl);

    await page.getByRole('button', { name: 'Updates' }).click();
    await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible();

    await expect(page.locator('p:has-text("Phase:")')).toContainText('idle');
    await expect(page.getByText('Progress: 0%')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart and Install' })).toBeDisabled();

    await page.getByRole('button', { name: 'Check for Updates' }).click();
    await expect(page.locator('p:has-text("Phase:")')).toContainText('checking');
    await expect(page.getByText('Checking for updates...')).toBeVisible();

    await page.evaluate(() => {
      window.__desktopTestHarness.emitUpdater({
        phase: 'available',
        message: 'Update available',
        progress: 0,
      });
    });
    await expect(page.locator('p:has-text("Phase:")')).toContainText('available');
    await expect(page.getByText('Update available')).toBeVisible();

    await page.evaluate(() => {
      window.__desktopTestHarness.emitUpdater({
        phase: 'downloading',
        message: 'Downloading update...',
        progress: 42,
      });
    });
    await expect(page.locator('p:has-text("Phase:")')).toContainText('downloading');
    await expect(page.getByText('Progress: 42%')).toBeVisible();

    await page.evaluate(() => {
      window.__desktopTestHarness.emitUpdater({
        phase: 'downloaded',
        message: 'Update ready to install',
        progress: 100,
      });
    });
    await expect(page.locator('p:has-text("Phase:")')).toContainText('downloaded');
    await expect(page.getByRole('button', { name: 'Restart and Install' })).toBeEnabled();

    await page.getByRole('button', { name: 'Restart and Install' }).click();
    const harnessState = await page.evaluate(() => window.__desktopTestHarness.getState());
    expect(harnessState.checkCalls).toBe(1);
    expect(harnessState.installCalls).toBe(1);
  } finally {
    await renderer.close();
  }
});

test('updates view shows updater error and keeps install disabled', async ({ page }) => {
  const renderer = await startDesktopRendererServer();

  try {
    await page.addInitScript(() => {
      const listeners = [];
      const state = {
        updater: { phase: 'idle', message: 'Idle', progress: 0 },
      };

      const emit = (payload) => {
        state.updater = { ...payload };
        listeners.forEach((cb) => cb({ ...payload }));
      };

      window.__desktopTestHarness = {
        emitUpdater: emit,
      };

      window.desktop = {
        getAppInfo: async () => ({ apiBaseUrl: window.location.origin }),
        getSettings: async () => ({
          queueMaxConcurrent: 1,
          queueAutoStart: true,
          checkUpdatesOnStartup: true,
        }),
        saveSettings: async (settings) => ({
          queueMaxConcurrent: settings?.queueMaxConcurrent ?? 1,
          queueAutoStart: settings?.queueAutoStart ?? true,
          checkUpdatesOnStartup: settings?.checkUpdatesOnStartup ?? true,
        }),
        generatePairingCode: async () => ({
          code: 'TEST1234',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
        listTokens: async () => [],
        revokeToken: async () => ({ ok: true }),
        revokeAllTokens: async () => ({ ok: true }),
        getUpdaterState: async () => ({ ...state.updater }),
        checkForUpdates: async () => ({ ok: true }),
        installUpdateNow: async () => ({ ok: true }),
        onUpdaterEvent: (cb) => {
          listeners.push(cb);
          return () => {
            const idx = listeners.indexOf(cb);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
      };
    });

    await page.route('**/api/queue', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ queue: [], settings: { maxConcurrent: 1, autoStart: true } }),
      });
    });

    await page.route('**/api/history', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });

    await page.goto(renderer.baseUrl);
    await page.getByRole('button', { name: 'Updates' }).click();
    await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible();

    await page.evaluate(() => {
      window.__desktopTestHarness.emitUpdater({
        phase: 'error',
        message: 'Update check failed',
        progress: 0,
        error: 'GitHub API rate limit exceeded',
      });
    });

    await expect(page.locator('p:has-text("Phase:")')).toContainText('error');
    await expect(page.getByText('Update check failed')).toBeVisible();
    await expect(page.getByText('Error: GitHub API rate limit exceeded')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart and Install' })).toBeDisabled();
  } finally {
    await renderer.close();
  }
});

test('desktop queue controls mutate queue state via API actions', async ({ page }) => {
  const renderer = await startDesktopRendererServer();

  try {
    await page.addInitScript(() => {
      const listeners = [];
      const state = {
        updater: { phase: 'idle', message: 'Idle', progress: 0 },
      };

      window.desktop = {
        getAppInfo: async () => ({ apiBaseUrl: window.location.origin }),
        getSettings: async () => ({
          queueMaxConcurrent: 1,
          queueAutoStart: true,
          checkUpdatesOnStartup: true,
        }),
        saveSettings: async (settings) => ({
          queueMaxConcurrent: settings?.queueMaxConcurrent ?? 1,
          queueAutoStart: settings?.queueAutoStart ?? true,
          checkUpdatesOnStartup: settings?.checkUpdatesOnStartup ?? true,
        }),
        generatePairingCode: async () => ({
          code: 'TEST1234',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
        listTokens: async () => [],
        revokeToken: async () => ({ ok: true }),
        revokeAllTokens: async () => ({ ok: true }),
        getUpdaterState: async () => ({ ...state.updater }),
        checkForUpdates: async () => ({ ok: true }),
        installUpdateNow: async () => ({ ok: true }),
        onUpdaterEvent: (cb) => {
          listeners.push(cb);
          return () => {
            const idx = listeners.indexOf(cb);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
      };
    });

    const queueState = {
      settings: { maxConcurrent: 1, autoStart: true },
      queue: [
        {
          id: 'job-1',
          title: 'Fixture Job',
          queueStatus: 'queued',
          progress: 0,
          status: 'pending',
          totalSegments: 100,
          completedSegments: 0,
          bytesDownloaded: 0,
        },
      ],
    };

    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      const pathname = url.pathname;

      const json = (body) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

      if (pathname === '/api/queue' && method === 'GET') {
        await json({
          queue: queueState.queue.map((job) => ({
            id: job.id,
            title: job.title,
            queueStatus: job.queueStatus,
            progress: job.progress,
          })),
          settings: queueState.settings,
        });
        return;
      }

      if (pathname === '/api/history' && method === 'GET') {
        await json({ items: [] });
        return;
      }

      if (pathname === '/api/queue/settings' && method === 'POST') {
        const body = req.postDataJSON();
        queueState.settings.maxConcurrent = Number(body.maxConcurrent || 1);
        queueState.settings.autoStart = body.autoStart !== false;
        await json({ ok: true });
        return;
      }

      if (pathname === '/api/queue/job-1/start' && method === 'POST') {
        queueState.queue[0].queueStatus = 'downloading';
        queueState.queue[0].status = 'running';
        queueState.queue[0].progress = 10;
        await json({ ok: true });
        return;
      }

      if (pathname === '/api/queue/job-1/pause' && method === 'POST') {
        queueState.queue[0].queueStatus = 'paused';
        queueState.queue[0].status = 'paused';
        await json({ ok: true });
        return;
      }

      if (pathname === '/api/queue/job-1/resume' && method === 'POST') {
        queueState.queue[0].queueStatus = 'downloading';
        queueState.queue[0].status = 'running';
        queueState.queue[0].progress = 35;
        queueState.queue[0].completedSegments = 35;
        await json({ ok: true });
        return;
      }

      if (pathname === '/api/jobs/job-1' && method === 'GET') {
        await json({
          id: queueState.queue[0].id,
          title: queueState.queue[0].title,
          status: queueState.queue[0].status,
          progress: queueState.queue[0].progress,
          totalSegments: queueState.queue[0].totalSegments,
          completedSegments: queueState.queue[0].completedSegments,
          bytesDownloaded: queueState.queue[0].bytesDownloaded,
        });
        return;
      }

      if (pathname === '/api/jobs/job-1/cancel' && method === 'POST') {
        queueState.queue[0].queueStatus = 'cancelled';
        queueState.queue[0].status = 'cancelled';
        await json({ ok: true });
        return;
      }

      if (pathname === '/api/queue/job-1' && method === 'DELETE') {
        queueState.queue = [];
        await json({ ok: true });
        return;
      }

      await route.fulfill({ status: 404, body: 'Not found' });
    });

    await page.goto(renderer.baseUrl);
    await page.getByRole('button', { name: 'Queue' }).click();
    await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
    const queueCard = page.locator('article.card').first();
    await expect(queueCard).toContainText('queued | 0%');

    await queueCard.getByRole('button', { name: 'Start' }).click();
    await expect(queueCard).toContainText('downloading | 10%');

    await queueCard.getByRole('button', { name: 'Pause' }).click();
    await expect(queueCard).toContainText('paused | 10%');

    await queueCard.getByRole('button', { name: 'Resume' }).click();
    await expect(queueCard).toContainText('downloading | 35%');

    await queueCard.getByRole('button', { name: 'Focus' }).click();
    await page.getByRole('button', { name: 'Active Download' }).click();
    await expect(page.getByText('Status:')).toContainText('running');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Queue' }).click();
    await expect(queueCard).toContainText('cancelled | 35%');

    await queueCard.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Queue is empty.')).toBeVisible();
  } finally {
    await renderer.close();
  }
});
