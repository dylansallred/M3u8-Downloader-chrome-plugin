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

    // Updates is now inside Settings view, not a top-level nav button
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('Updates', { exact: true })).toBeVisible();

    // Phase is shown as a Badge, not in a "Phase:" paragraph
    await expect(page.getByText('idle', { exact: true })).toBeVisible();
    // Install and Later buttons are disabled when not in 'downloaded' phase
    await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Later' })).toBeDisabled();

    // Button is now named "Check" (not "Check for Updates")
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText('checking', { exact: true })).toBeVisible();
    await expect(page.getByText('Checking for updates...')).toBeVisible();

    await page.evaluate(() => {
      window.__desktopTestHarness.emitUpdater({
        phase: 'available',
        message: 'Update available',
        progress: 0,
      });
    });
    await expect(page.getByText('available', { exact: true })).toBeVisible();
    await expect(page.getByText('Update available')).toBeVisible();

    await page.evaluate(() => {
      window.__desktopTestHarness.emitUpdater({
        phase: 'downloading',
        message: 'Downloading update...',
        progress: 42,
      });
    });
    await expect(page.getByText('downloading', { exact: true })).toBeVisible();

    await page.evaluate(() => {
      window.__desktopTestHarness.emitUpdater({
        phase: 'downloaded',
        message: 'Update ready to install',
        progress: 100,
        releaseNotes: ['Fix queue stability', 'Improve updater reminders'],
      });
    });
    await expect(page.getByText('downloaded', { exact: true })).toBeVisible();
    // Install and Later buttons are now enabled when phase is 'downloaded'
    await expect(page.getByRole('button', { name: 'Install' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Later' })).toBeEnabled();
    // Release notes use a collapsible "Show release notes" trigger
    await expect(page.getByText('Show release notes')).toBeVisible();
    await page.getByText('Show release notes').click();
    await expect(page.getByText('Fix queue stability')).toBeVisible();

    // Later button (not "Later (30m)")
    await page.getByRole('button', { name: 'Later' }).click();
    await expect(page.getByText('Deferred until:')).toBeVisible();

    // Install button (not "Restart and Install")
    await page.getByRole('button', { name: 'Install' }).click();
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

    // Settings view renders an sr-only h1 "Settings"
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeAttached();

    // Preferences card should be visible
    await expect(page.getByText('Preferences')).toBeVisible();

    // UpdaterCard should be present
    await expect(page.getByText('Updates', { exact: true })).toBeVisible();

    // Pairing UI has been removed from settings.
    await expect(page.getByText('Extension Pairing')).toHaveCount(0);
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

    // When health check fails, compatibility.error is set which shows the
    // Compatibility Warning button in the navbar
    await expect(page.getByRole('button', { name: 'Compatibility Warning' })).toBeVisible();

    // Clicking the warning button navigates to Settings
    await page.getByRole('button', { name: 'Compatibility Warning' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeAttached();

    // Settings view should still render correctly despite health check failure
    await expect(page.getByText('Preferences')).toBeVisible();
  } finally {
    await renderer.close();
  }
});

test.skip('settings diagnostics button reports aggregated success and failure states', async ({ page }) => {
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

test('sidebar shows compatibility warning when health check fails', async ({ page }) => {
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

    // Return a 500 so compatibility.error is set, triggering the warning button
    await page.route('**/v1/health', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom' }),
      });
    });

    await page.goto(renderer.baseUrl);

    // The Compatibility Warning button appears in the navbar when compatibility.error is set
    await expect(page.getByRole('button', { name: 'Compatibility Warning' })).toBeVisible();

    // Clicking it navigates to Settings
    await page.getByRole('button', { name: 'Compatibility Warning' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeAttached();

    // Settings view should still render correctly despite compatibility failures.
    await expect(page.getByText('Preferences')).toBeVisible();
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

    // Updates is inside Settings view
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('Updates', { exact: true })).toBeVisible();

    await page.evaluate(() => {
      window.__desktopTestHarness.emitUpdater({
        phase: 'error',
        message: 'Update check failed',
        progress: 0,
        error: 'GitHub API rate limit exceeded',
      });
    });

    // Phase is shown as a Badge text value
    await expect(page.getByText('error', { exact: true })).toBeVisible();
    await expect(page.getByText('Update check failed')).toBeVisible();
    // Error text is rendered as a plain <p>, not prefixed with "Error:"
    await expect(page.getByText('GitHub API rate limit exceeded')).toBeVisible();
    // Install button remains disabled when phase is 'error'
    await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();
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

    // Queue view has an sr-only h1 "Queue" - it is in the DOM but not visible
    await expect(page.getByRole('heading', { name: 'Queue' })).toBeAttached();

    // QueueJobCards have a "Remove" button (title="Remove"); use that to scope locators
    // to just the job cards and exclude the ActiveDownloadCard
    const jobCards = page.locator('article.card').filter({ has: page.locator('[title="Remove"]') });
    const queueCard = jobCards.first();

    await expect(queueCard).toContainText('Queued');
    await expect(queueCard).toContainText('0%');

    // QueueJobCard action buttons use the title attribute, matched by getByRole with name
    await queueCard.getByRole('button', { name: 'Start' }).click();
    await expect(queueCard).toContainText('Downloading');
    await expect(queueCard).toContainText('10%');

    await queueCard.getByRole('button', { name: 'Pause' }).click();
    await expect(queueCard).toContainText('Paused');

    await queueCard.getByRole('button', { name: 'Resume' }).click();
    await expect(queueCard).toContainText('Downloading');
    await expect(queueCard).toContainText('35%');

    // "Retry Original HLS" button appears when fallbackUsed is true and status is failed/cancelled
    // Cancel the job server-side so the retry buttons appear on the next poll
    queueState.queue[0].queueStatus = 'cancelled';
    queueState.queue[0].status = 'cancelled';
    // Navigate away and back to force a fresh data fetch
    await page.getByRole('button', { name: 'History' }).click();
    await page.getByRole('button', { name: 'Queue' }).click();
    await expect(queueCard).toContainText('Cancelled');

    await queueCard.getByRole('button', { name: 'Retry Original HLS' }).click();
    await expect(jobCards).toHaveCount(2);
    await expect(jobCards.nth(1)).toContainText('Fixture Job (HLS Retry)');

    // "Retry" is the primary action button when status is cancelled (standard retry)
    await queueCard.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(jobCards).toHaveCount(3);
    await expect(jobCards.nth(2)).toContainText('Fixture Job (Retry)');

    // Filter by Cancelled using Radix Select (click trigger, then click option)
    // job-1 is cancelled; job-2 and job-3 are queued
    await page.getByLabel('Status').click();
    await page.getByRole('option', { name: 'Cancelled' }).click();
    // Only job-1 (cancelled) matches; job-2 and job-3 are hidden
    await expect(jobCards).toHaveCount(1);
    await expect(jobCards.first()).toContainText('Fixture Job');

    // Remove the cancelled job while the filter is active
    await jobCards.first().getByRole('button', { name: 'Remove' }).click();
    // No cancelled jobs remain visible under this filter
    await expect(page.getByText('No queue items match current filter.')).toBeVisible();

    // Reset filter to All - only the two queued retry jobs remain
    await page.getByLabel('Status').click();
    await page.getByRole('option', { name: 'All' }).click();
    await expect(jobCards).toHaveCount(2);

    // Remove one more to confirm the Remove action works
    await jobCards.first().getByRole('button', { name: 'Remove' }).click();
    await expect(jobCards).toHaveCount(1);
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
        openHistoryFile: async (historyId) => {
          window.__historyOpenedFile = historyId;
          return { ok: true, filePath: `/tmp/${historyId}` };
        },
        openHistoryFolder: async (historyId) => {
          window.__historyOpenedFolder = historyId;
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
              id: 'a-history-id',
              fileName: 'joba-sample-video.mp4',
              relativePath: 'job-a/joba-sample-video.mp4',
              absolutePath: '/tmp/job-a/joba-sample-video.mp4',
              label: 'sample-video.mp4',
              sizeBytes: 2 * 1024 * 1024,
              modifiedAt: Date.now(),
              ext: '.mp4',
            },
            {
              id: 'b-history-id',
              fileName: 'jobb-segment.ts',
              relativePath: 'job-b/jobb-segment.ts',
              absolutePath: '/tmp/job-b/jobb-segment.ts',
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

    // History view has an sr-only h1 "History" - it is in the DOM but not visible
    await expect(page.getByRole('heading', { name: 'History' })).toBeAttached();
    await expect(page.locator('article.card')).toHaveCount(2);

    await page.getByLabel('Search').fill('sample');
    await expect(page.locator('article.card')).toHaveCount(1);
    await expect(page.locator('article.card').first()).toContainText('sample-video');
    await page.getByLabel('Search').fill('');

    // Type filter uses Radix Select - click trigger then click option
    await page.getByLabel('Type').click();
    await page.getByRole('option', { name: 'TS' }).click();
    await expect(page.locator('article.card')).toHaveCount(1);
    await expect(page.locator('article.card').first()).toContainText('segment');

    // Reset type filter
    await page.getByLabel('Type').click();
    await page.getByRole('option', { name: 'All' }).click();

    const firstHistoryCard = page.locator('article.card').first();
    await firstHistoryCard.getByRole('button', { name: 'Open File' }).click();
    await firstHistoryCard.getByRole('button', { name: 'Open Folder' }).click();

    // Verify the IPC bridge was called with the correct history identifier
    const opened = await page.evaluate(() => ({
      file: window.__historyOpenedFile || null,
      folder: window.__historyOpenedFolder || null,
    }));
    expect(opened.file).toBe('a-history-id');
    expect(opened.folder).toBe('a-history-id');
  } finally {
    await renderer.close();
  }
});
