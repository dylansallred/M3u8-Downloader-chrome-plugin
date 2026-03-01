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

## API Summary

New extension bridge endpoints:

- `GET /v1/health`
- `POST /v1/pair/complete`
- `POST /v1/jobs` (auth required)
- `GET /v1/queue` (auth required)
- `POST /v1/app/focus` (auth required)

Compatibility endpoints retained:

- `POST /api/jobs`
- `POST /api/queue/add`
- Existing queue/history/job endpoints under `/api/*`

## Build and Release

- Build renderer only: `npm run build:desktop`
- Package desktop app: `npm run pack:desktop`
- Build distributables: `npm run dist:desktop`

GitHub release workflow (tags `v*.*.*`) is in `.github/workflows/release.yml`.
