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
        remindCalls: 0,
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
        remindLater: async () => {
          state.remindCalls += 1;
          emit({
            phase: 'downloaded',
            message: 'Update deferred until 2099-01-01 00:30',
            progress: 100,
            deferredUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            nextReminderAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            releaseNotes: ['Fix queue stability', 'Improve updater reminders'],
          });
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
        releaseNotes: ['Fix queue stability', 'Improve updater reminders'],
      });
    });
    await expect(page.locator('p:has-text("Phase:")')).toContainText('downloaded');
    await expect(page.getByRole('button', { name: 'Restart and Install' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Release Notes' })).toBeVisible();
    await expect(page.getByText('Fix queue stability')).toBeVisible();

    await page.getByRole('button', { name: 'Later (30m)' }).click();
    await expect(page.getByText('Deferred until:')).toBeVisible();
    await expect(page.getByText('Next reminder:')).toBeVisible();

    await page.getByRole('button', { name: 'Restart and Install' }).click();
    const harnessState = await page.evaluate(() => window.__desktopTestHarness.getState());
    expect(harnessState.checkCalls).toBe(1);
    expect(harnessState.installCalls).toBe(1);
    expect(harnessState.remindCalls).toBe(1);
  } finally {
    await renderer.close();
  }
});

test('settings view shows API compatibility details from health endpoint', async ({ page }) => {
  const renderer = await startDesktopRendererServer();

  try {
    await page.addInitScript(() => {
      const listeners = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copiedDiagnostics = String(text);
          },
        },
      });
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
        getUpdaterState: async () => ({ phase: 'idle', message: 'Idle', progress: 0 }),
        checkForUpdates: async () => ({ ok: true }),
        installUpdateNow: async () => ({ ok: true }),
        saveDiagnosticsFile: async (payload) => {
          window.__savedDiagnosticsPayload = payload;
          return { ok: true, filePath: '/tmp/diagnostics-test.json' };
        },
        openDiagnosticsFolder: async () => {
          window.__openedDiagnosticsFolder = '/tmp/diagnostics';
          return { ok: true, folderPath: '/tmp/diagnostics' };
        },
        exportSupportBundle: async (payload) => {
          window.__exportedSupportBundlePayload = payload;
          return { ok: true, bundlePath: '/tmp/support-bundles/support-bundle-test' };
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

    await page.route('**/v1/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          appVersion: '9.9.9',
          apiVersion: '1',
          protocolVersion: '1',
          supportedProtocolVersions: { min: 1, max: 1 },
          minExtensionVersion: '1.2.3',
          pairingRequired: false,
          wsPath: '/ws',
        }),
      });
    });

    await page.goto(renderer.baseUrl);
    await page.getByRole('button', { name: 'Settings' }).click();

    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Compatibility' })).toBeVisible();
    await expect(page.getByText('App Version:')).toContainText('9.9.9');
    await expect(page.getByText('Current Protocol:')).toContainText('1');
    await expect(page.getByText('Supported Protocol Range:')).toContainText('1 - 1');
    await expect(page.getByLabel('Required Extension Version')).toHaveValue('1.2.3');
    await expect(page.getByText('Last compatibility check:')).toBeVisible();
  } finally {
    await renderer.close();
  }
});

test('settings shows stale warning when compatibility health check fails', async ({ page }) => {
  const renderer = await startDesktopRendererServer();

  try {
    await page.addInitScript(() => {
      const listeners = [];
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
        getUpdaterState: async () => ({ phase: 'idle', message: 'Idle', progress: 0 }),
        checkForUpdates: async () => ({ ok: true }),
        installUpdateNow: async () => ({ ok: true }),
        saveDiagnosticsFile: async (payload) => {
          window.__savedDiagnosticsPayload = payload;
          return { ok: true, filePath: '/tmp/diagnostics-test.json' };
        },
        openDiagnosticsFolder: async () => {
          window.__openedDiagnosticsFolder = '/tmp/diagnostics';
          return { ok: true, folderPath: '/tmp/diagnostics' };
        },
        exportSupportBundle: async (payload) => {
          window.__exportedSupportBundlePayload = payload;
          return { ok: true, bundlePath: '/tmp/support-bundles/support-bundle-test' };
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

    await page.route('**/v1/health', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom' }),
      });
    });

    await page.goto(renderer.baseUrl);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByText('Last compatibility check:')).toBeVisible();
    await expect(page.getByText('Compatibility status may be stale')).toBeVisible();
  } finally {
    await renderer.close();
  }
});

test('settings diagnostics button reports aggregated success and failure states', async ({ page }) => {
  const renderer = await startDesktopRendererServer();

  try {
    await page.addInitScript(() => {
      const listeners = [];
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
        listTokens: async () => [
          {
            id: 'token-1',
            extensionId: 'test-ext',
            extensionVersion: '1.2.3',
            browser: 'chrome',
            createdAt: Date.now(),
            lastUsedAt: null,
          },
        ],
        revokeToken: async () => ({ ok: true }),
        revokeAllTokens: async () => ({ ok: true }),
        getUpdaterState: async () => ({ phase: 'idle', message: 'Idle', progress: 0 }),
        checkForUpdates: async () => ({ ok: true }),
        installUpdateNow: async () => ({ ok: true }),
        saveDiagnosticsFile: async (payload) => {
          window.__savedDiagnosticsPayload = payload;
          return { ok: true, filePath: '/tmp/diagnostics-test.json' };
        },
        openDiagnosticsFolder: async () => {
          window.__openedDiagnosticsFolder = '/tmp/diagnostics';
          return { ok: true, folderPath: '/tmp/diagnostics' };
        },
        exportSupportBundle: async (payload) => {
          window.__exportedSupportBundlePayload = payload;
          return { ok: true, bundlePath: '/tmp/support-bundles/support-bundle-test' };
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

    let failQueue = false;
    await page.route('**/api/queue', async (route) => {
      if (failQueue) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'queue failed' }),
        });
        return;
      }
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

    let failHealth = false;
    await page.route('**/v1/health', async (route) => {
      if (failHealth) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'boom' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          appVersion: '9.9.9',
          apiVersion: '1',
          protocolVersion: '1',
          supportedProtocolVersions: { min: 1, max: 1 },
          minExtensionVersion: '1.2.3',
          pairingRequired: false,
          wsPath: '/ws',
        }),
      });
    });

    await page.goto(renderer.baseUrl);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Refresh All Diagnostics' }).click();
    await expect(page.getByText('Diagnostics ok: queue=0, pairedExtensions=1')).toBeVisible();
    await expect(page.getByText('Diagnostics run at:')).toBeVisible();
    await page.getByRole('button', { name: 'Copy Diagnostics JSON' }).click();
    await page.waitForTimeout(100);
    const copiedPayload = await page.evaluate(() => window.__copiedDiagnostics || null);
    if (copiedPayload) {
      await expect(page.getByText('Copied diagnostics')).toBeVisible();
    } else {
      await expect(page.getByText('Failed to copy diagnostics')).toBeVisible();
    }
    const copiedOk = await page.evaluate(() => {
      if (!window.__copiedDiagnostics) return true;
      try {
        const parsed = JSON.parse(window.__copiedDiagnostics || '{}');
        return parsed?.diagnostics?.message === 'Diagnostics ok: queue=0, pairedExtensions=1';
      } catch {
        return false;
      }
    });
    expect(copiedOk).toBeTruthy();

    await page.getByRole('button', { name: 'Save Diagnostics File' }).click();
    await expect(page.getByText('Saved diagnostics file: /tmp/diagnostics-test.json')).toBeVisible();
    const savedOk = await page.evaluate(() => {
      return Boolean(
        window.__savedDiagnosticsPayload
        && window.__savedDiagnosticsPayload.diagnostics
        && typeof window.__savedDiagnosticsPayload.exportedAt === 'string',
      );
    });
    expect(savedOk).toBeTruthy();

    await page.getByRole('button', { name: 'Open Diagnostics Folder' }).click();
    await expect(page.getByText('Opened diagnostics folder: /tmp/diagnostics')).toBeVisible();
    const openedOk = await page.evaluate(() => window.__openedDiagnosticsFolder === '/tmp/diagnostics');
    expect(openedOk).toBeTruthy();

    await page.getByRole('button', { name: 'Export Support Bundle' }).click();
    await expect(page.getByText('Exported support bundle: /tmp/support-bundles/support-bundle-test')).toBeVisible();
    const exportOk = await page.evaluate(() => {
      return Boolean(
        window.__exportedSupportBundlePayload
        && window.__exportedSupportBundlePayload.diagnostics
        && window.__exportedSupportBundlePayload.compatibility,
      );
    });
    expect(exportOk).toBeTruthy();

    failQueue = true;
    failHealth = true;
    await page.getByRole('button', { name: 'Refresh All Diagnostics' }).click();
    await expect(page.getByText('Diagnostics completed with issues: queue, compatibility')).toBeVisible();
    await page.getByRole('button', { name: 'Show Diagnostics Details' }).click();
    await expect(page.getByText('queue:')).toBeVisible();
    await expect(page.getByText('compatibility: HTTP 500')).toBeVisible();
  } finally {
    await renderer.close();
  }
});

test('sidebar shows compatibility warning when paired extension is below minimum version', async ({ page }) => {
  const renderer = await startDesktopRendererServer();

  try {
    await page.addInitScript(() => {
      const listeners = [];
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
        listTokens: async () => [
          {
            id: 'token-1',
            extensionId: 'test-ext',
            extensionVersion: '1.0.0',
            browser: 'chrome',
            createdAt: Date.now(),
            lastUsedAt: null,
          },
        ],
        revokeToken: async () => ({ ok: true }),
        revokeAllTokens: async () => ({ ok: true }),
        getUpdaterState: async () => ({ phase: 'idle', message: 'Idle', progress: 0 }),
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

    await page.route('**/v1/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          appVersion: '9.9.9',
          apiVersion: '1',
          protocolVersion: '1',
          supportedProtocolVersions: { min: 1, max: 1 },
          minExtensionVersion: '1.2.3',
          pairingRequired: false,
          wsPath: '/ws',
        }),
      });
    });

    await page.goto(renderer.baseUrl);
    await expect(page.getByRole('button', { name: 'Compatibility Warning' })).toBeVisible();

    await page.getByRole('button', { name: 'Compatibility Warning' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByText('paired extension(s) are below required version 1.2.3.')).toBeVisible();
  } finally {
    await renderer.close();
  }
});

test('settings can revoke only outdated tokens and clear compatibility warning', async ({ page }) => {
  const renderer = await startDesktopRendererServer();

  try {
    await page.addInitScript(() => {
      const listeners = [];
      const tokensState = [
        {
          id: 'token-old',
          extensionId: 'test-ext-old',
          extensionVersion: '1.0.0',
          browser: 'chrome',
          createdAt: Date.now(),
          lastUsedAt: null,
        },
        {
          id: 'token-new',
          extensionId: 'test-ext-new',
          extensionVersion: '1.3.0',
          browser: 'chrome',
          createdAt: Date.now(),
          lastUsedAt: null,
        },
      ];

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
        listTokens: async () => tokensState.slice(),
        revokeToken: async (tokenId) => {
          const idx = tokensState.findIndex((token) => token.id === tokenId);
          if (idx >= 0) tokensState.splice(idx, 1);
          return { ok: idx >= 0 };
        },
        revokeAllTokens: async () => ({ ok: true }),
        getUpdaterState: async () => ({ phase: 'idle', message: 'Idle', progress: 0 }),
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

    await page.route('**/v1/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          appVersion: '9.9.9',
          apiVersion: '1',
          protocolVersion: '1',
          supportedProtocolVersions: { min: 1, max: 1 },
          minExtensionVersion: '1.2.3',
          pairingRequired: false,
          wsPath: '/ws',
        }),
      });
    });

    await page.goto(renderer.baseUrl);
    await expect(page.getByRole('button', { name: 'Compatibility Warning' })).toBeVisible();

    await page.getByRole('button', { name: 'Compatibility Warning' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Paired Extensions' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'test-ext-old' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'test-ext-new' })).toBeVisible();
    await expect(page.locator('.status-pill.outdated')).toBeVisible();
    await expect(page.locator('.status-pill.compatible')).toBeVisible();

    await page.getByLabel('Filter').selectOption('outdated');
    await expect(page.getByRole('cell', { name: 'test-ext-old' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'test-ext-new' })).toHaveCount(0);
    await expect(page.locator('.status-pill.compatible')).toHaveCount(0);

    await page.getByLabel('Filter').selectOption('all');
    await expect(page.getByRole('button', { name: 'Revoke Outdated Tokens' })).toBeEnabled();

    await page.getByRole('button', { name: 'Revoke Outdated Tokens' }).click();
    await expect(page.getByText('Revoked outdated tokens')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke Outdated Tokens' })).toBeDisabled();
    await expect(page.getByRole('cell', { name: 'test-ext-old' })).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'test-ext-new' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compatibility Warning' })).toHaveCount(0);
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
          fallbackUsed: true,
          originalHlsUrl: 'https://example.com/source.m3u8',
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
            fallbackUsed: !!job.fallbackUsed,
            originalHlsUrl: job.originalHlsUrl || null,
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

      if (pathname === '/api/jobs/job-1/retry-original-hls' && method === 'POST') {
        queueState.queue.push({
          id: 'job-2',
          title: 'Fixture Job (HLS Retry)',
          queueStatus: 'queued',
          progress: 0,
          status: 'pending',
          totalSegments: 0,
          completedSegments: 0,
          bytesDownloaded: 0,
          fallbackUsed: false,
          originalHlsUrl: 'https://example.com/source.m3u8',
        });
        await json({ id: 'job-2', queuePosition: 1, retryOf: 'job-1' });
        return;
      }

      if (pathname === '/api/jobs/job-1/retry' && method === 'POST') {
        queueState.queue.push({
          id: 'job-3',
          title: 'Fixture Job (Retry)',
          queueStatus: 'queued',
          progress: 0,
          status: 'pending',
          totalSegments: 0,
          completedSegments: 0,
          bytesDownloaded: 0,
          fallbackUsed: false,
          originalHlsUrl: null,
        });
        await json({ id: 'job-3', queuePosition: 2, retryOf: 'job-1' });
        return;
      }

      if (pathname.startsWith('/api/queue/') && method === 'DELETE') {
        const id = decodeURIComponent(pathname.split('/').pop() || '');
        queueState.queue = queueState.queue.filter((job) => job.id !== id);
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

    await queueCard.getByRole('button', { name: 'Retry Original HLS' }).click();
    await expect(page.locator('article.card')).toHaveCount(2);
    await expect(page.locator('article.card').nth(1)).toContainText('Fixture Job (HLS Retry)');

    await queueCard.getByRole('button', { name: 'Focus' }).click();
    await page.getByRole('button', { name: 'Active Download' }).click();
    await expect(page.getByText('Status:')).toContainText('running');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Queue' }).click();
    await expect(queueCard).toContainText('cancelled | 35%');

    await queueCard.getByRole('button', { name: 'Retry Job' }).click();
    await expect(page.locator('article.card')).toHaveCount(3);
    await expect(page.locator('article.card').nth(2)).toContainText('Fixture Job (Retry)');

    await page.getByLabel('Status').selectOption('cancelled');
    await page.getByRole('button', { name: 'Remove Cancelled (Filtered)' }).click();
    await expect(page.getByText('No queue items match current filter.')).toBeVisible();
    await page.getByLabel('Status').selectOption('all');
    await expect(page.locator('article.card')).toHaveCount(2);

    await queueCard.getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('article.card')).toHaveCount(1);
  } finally {
    await renderer.close();
  }
});

test('desktop history supports search/filter and open file/folder actions', async ({ page }) => {
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
        openHistoryFile: async (fileName) => {
          window.__historyOpenedFile = fileName;
          return { ok: true, filePath: `/tmp/${fileName}` };
        },
        openHistoryFolder: async (fileName) => {
          window.__historyOpenedFolder = fileName;
          return { ok: true, folderPath: '/tmp' };
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
        body: JSON.stringify({
          items: [
            {
              id: 'a',
              fileName: 'joba-sample-video.mp4',
              label: 'sample-video.mp4',
              sizeBytes: 2 * 1024 * 1024,
              modifiedAt: Date.now(),
              ext: '.mp4',
            },
            {
              id: 'b',
              fileName: 'jobb-segment.ts',
              label: 'segment.ts',
              sizeBytes: 1 * 1024 * 1024,
              modifiedAt: Date.now() - 1000,
              ext: '.ts',
            },
          ],
        }),
      });
    });

    await page.goto(renderer.baseUrl);
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.locator('article.card')).toHaveCount(2);

    await page.getByLabel('Search').fill('sample');
    await expect(page.locator('article.card')).toHaveCount(1);
    await expect(page.locator('article.card').first()).toContainText('sample-video.mp4');
    await page.getByLabel('Search').fill('');

    await page.getByLabel('Type').selectOption('ts');
    await expect(page.locator('article.card')).toHaveCount(1);
    await expect(page.locator('article.card').first()).toContainText('segment.ts');
    await page.getByLabel('Type').selectOption('all');

    const firstHistoryCard = page.locator('article.card').first();
    await firstHistoryCard.getByRole('button', { name: 'Open File' }).click();
    await expect(page.getByText('Opened file: joba-sample-video.mp4')).toBeVisible();
    await firstHistoryCard.getByRole('button', { name: 'Open Folder' }).click();
    await expect(page.getByText('Opened folder for: joba-sample-video.mp4')).toBeVisible();

    const opened = await page.evaluate(() => ({
      file: window.__historyOpenedFile || null,
      folder: window.__historyOpenedFolder || null,
    }));
    expect(opened.file).toBe('joba-sample-video.mp4');
    expect(opened.folder).toBe('joba-sample-video.mp4');
  } finally {
    await renderer.close();
  }
});
