# Desktop App

Electron + React desktop application for download queue management and updates.

## Scripts

- `npm run dev --workspace @m3u8/desktop`
- `npm run build --workspace @m3u8/desktop`
- `npm run pack --workspace @m3u8/desktop`
- `npm run dist --workspace @m3u8/desktop`
- `npm run fetch:yt-dlp --workspace @m3u8/desktop`
- `npm run fetch:ffmpeg --workspace @m3u8/desktop`

## Runtime

On startup the desktop app:

- Starts local API server on `127.0.0.1:49732`
- Hosts queue/history/download management endpoints
- Accepts extension bridge requests from local machine without pairing
- Checks GitHub Releases for updates (startup + every 6 hours)

## Bundled yt-dlp

To bundle `yt-dlp` inside the desktop app:

1. Run `npm run fetch:yt-dlp --workspace @m3u8/desktop` on each target OS.
2. This saves the binary to `apps/desktop/bin/yt-dlp` (or `yt-dlp.exe` on Windows).
3. `electron-builder` copies `apps/desktop/bin/*` into app resources via `extraResources`.

At runtime, Electron sets `YTDLP_PATH` to the bundled binary when present, so end users do not need to install `yt-dlp` manually.

## Bundled ffmpeg/ffprobe

To bundle `ffmpeg` and `ffprobe` inside the desktop app:

1. Run `npm run fetch:ffmpeg --workspace @m3u8/desktop`.
2. This saves binaries to `apps/desktop/bin/ffmpeg` + `apps/desktop/bin/ffprobe` (or `.exe` on Windows).
3. `electron-builder` copies `apps/desktop/bin/*` into app resources via `extraResources`.

At runtime, Electron sets `FFMPEG_PATH` and `FFPROBE_PATH` to bundled binaries when present, so users do not need to install ffmpeg manually.

Note: default download URLs are only provided for macOS. For Linux/Windows, set `FFMPEG_DOWNLOAD_URL` and `FFPROBE_DOWNLOAD_URL` before running the fetch script.
