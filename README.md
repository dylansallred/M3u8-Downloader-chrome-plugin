# M3U8 Downloader Workspace

This repository now contains a phased Electron rebuild of the original local downloader + Chrome extension flow.

## Workspace Layout

- `apps/desktop`: Electron desktop app (main process, preload, React renderer).
- `apps/extension`: Chrome extension v1 (detection + send-to-desktop API bridge).
- `packages/downloader-engine`: Reused downloader core modules (queue, HLS/direct job processing, FFmpeg integration).
- `packages/downloader-api`: Local API server (`127.0.0.1:49732`) with pairing/token auth for extension endpoints.
- `packages/contracts`: Shared API constants.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Run desktop app in dev mode:

```bash
npm run dev:desktop
```

This starts:

- Vite renderer on `http://localhost:5173`
- Electron shell loading the renderer
- Local downloader API on `http://127.0.0.1:49732`

3. Load extension:

- Open `chrome://extensions`
- Enable Developer Mode
- Load unpacked from `apps/extension`

4. Pair extension with desktop app:

- In desktop app Settings, click `Generate Pairing Code`
- In extension popup, enter the code and click `Pair`

## Current Capabilities

- Desktop app:
  - Queue management with pause/resume/start/remove and bulk filtered actions
  - Active download view with progress, speed, ETA, and failure reason
  - History view with search/filter plus open-file/open-folder actions
  - Updater view with release notes, restart install, and `Later (30m)` reminder flow
  - Settings diagnostics tools:
    - Refresh all diagnostics
    - Copy diagnostics JSON
    - Save diagnostics file
    - Open diagnostics folder
    - Export support bundle
- Extension:
  - Stream/media detection and send-to-desktop over local `/v1` bridge
  - Pairing flow and token-based auth
  - Protocol/version compatibility checks and update-required UX

## API Summary

Extension bridge contract (`/v1`, extension-only, auth where noted):

- `GET /v1/health`
- `POST /v1/pair/complete`
- `POST /v1/jobs` (auth required)
- `GET /v1/queue` (auth required)
- `POST /v1/app/focus` (auth required)

Desktop-internal endpoints (`/api`, not for extension clients):

- Existing queue/history/job endpoints under `/api/*`
- Extension-origin or `X-Client: fetchv-extension` requests to `/api/*` are rejected.

## Build and Release

- Build renderer only: `npm run build:desktop`
- Package desktop app: `npm run pack:desktop`
- Build distributables: `npm run dist:desktop`
- Trigger signed/notarized release from a tag:
  - Optional preflight checks before tagging:
    - `npm run release:preflight -- --target all --allow-missing-tools`
    - Use `--target macos` or `--target windows` for focused checks.
  - `npm run release:tag -- 1.2.3`
  - This creates/pushes `v1.2.3` and triggers `.github/workflows/release.yml`

GitHub release workflow (tags `v*.*.*`) is in `.github/workflows/release.yml`.

### Release Hardening Gates

- macOS release job fails fast when any signing/notarization secret is missing.
- macOS artifacts are validated with `xcrun stapler validate` (DMG must be notarized/stapled).
- Windows builds can run unsigned when code-sign secrets are not configured.
- Windows installers are validated with `signtool verify` when signing secrets are configured.
- Extension artifact attachment runs only after successful macOS + Windows release jobs.

## CI and Checks

- Required branch-protection checks:
  - `test-and-build`
  - `e2e`
- Local equivalents:
  - `npm test`
  - `npm run test:e2e -- --project=chromium`
  - `npm run build:desktop`

## Updater Smoke Test (Release-to-Release)

Use this flow to validate in-app auto-update behavior against real GitHub releases:

1. Publish `v2.0.0` and install it on test machines (macOS + Windows).
2. Publish `v2.0.1` from the same release pipeline.
3. On installed `v2.0.0`, run `Check for updates` from Settings > Updates.
4. Verify update is found, release notes render, and download completes.
5. Click `Restart now` and confirm app relaunches on `v2.0.1`.
6. Repeat once with `Later (30m)` and confirm reminder appears again after 30 minutes.
