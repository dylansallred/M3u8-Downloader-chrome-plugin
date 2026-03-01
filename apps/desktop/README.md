# Desktop App

Electron + React desktop application for download queue management and updates.

## Scripts

- `npm run dev --workspace @m3u8/desktop`
- `npm run build --workspace @m3u8/desktop`
- `npm run pack --workspace @m3u8/desktop`
- `npm run dist --workspace @m3u8/desktop`

## Runtime

On startup the desktop app:

- Starts local API server on `127.0.0.1:49732`
- Hosts queue/history/download management endpoints
- Exposes extension pairing and token controls via Settings
- Checks GitHub Releases for updates (startup + every 6 hours)
