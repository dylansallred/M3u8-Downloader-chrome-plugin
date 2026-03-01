const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
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
      // keep polling
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
      env: { ...process.env, CI: '1' },
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

test('electron preload exposes real updater IPC bridge and updates view loads', async () => {
  test.skip(
    process.platform === 'win32' || (process.platform === 'linux' && process.env.CI === '1'),
    'Electron launch automation is validated locally; hosted CI runners can fail to launch Electron reliably.',
  );

  const renderer = await startDesktopRendererServer();
  const desktopAppPath = path.resolve(__dirname, '../../apps/desktop');
  const apiPort = await getFreePort();
  let electronApp;

  try {
    electronApp = await electron.launch({
      args: [desktopAppPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        E2E_ALLOW_MULTI_INSTANCE: '1',
        M3U8_API_HOST: '127.0.0.1',
        M3U8_API_PORT: String(apiPort),
        VITE_DEV_SERVER_URL: renderer.baseUrl,
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    await expect(window.getByRole('heading', { name: 'M3U8 Downloader' })).toBeVisible();
    await window.getByRole('button', { name: 'Updates' }).click();
    await expect(window.getByRole('heading', { name: 'Updates' })).toBeVisible();

    const updaterState = await window.evaluate(async () => {
      if (!window.desktop) return { missingDesktop: true };
      const state = await window.desktop.getUpdaterState();
      const checkResult = await Promise.race([
        window.desktop.checkForUpdates(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 4000)),
      ]);
      return {
        hasBridge: typeof window.desktop.getUpdaterState === 'function'
          && typeof window.desktop.checkForUpdates === 'function',
        state,
        checkResult,
      };
    });

    expect(updaterState.missingDesktop).not.toBeTruthy();
    expect(updaterState.hasBridge).toBeTruthy();
    expect(typeof updaterState.state.phase).toBe('string');
    expect(typeof updaterState.state.message).toBe('string');
    expect(
      updaterState.checkResult.timeout === true
      || typeof updaterState.checkResult.ok === 'boolean',
    ).toBeTruthy();
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    await renderer.close();
  }
});
