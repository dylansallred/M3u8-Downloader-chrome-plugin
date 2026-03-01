# Extension (v1)

Chrome extension that:

- Detects media requests on the current page (HLS/DASH manifests, direct video files, and audio assets)
- Shows detected media in popup
- Sends selected media to desktop queue using `POST /v1/jobs`
- Allows per-item removal from detected media list via icon button

## Media Detection Coverage

- Streaming manifests: `.m3u8`, `.m3u`, `.mpd`, `.ism`, `.ismc`
- Video/container formats: `.mp4`, `.m4v`, `.mov`, `.webm`, `.mkv`, `.avi`, `.flv`, `.f4v`, `.wmv`, `.asf`, `.ts`, `.m2ts`, `.mts`, `.m4s`, `.mpg`, `.mpeg`, `.3gp`, `.3g2`, `.ogv`, `.ogm`, `.mxf`
- Audio formats: `.m4a`, `.aac`, `.mp3`, `.ogg`, `.oga`, `.wav`, `.flac`
- Content-Type detection: `video/*`, `audio/*`, HLS (`application/x-mpegurl`, `application/vnd.apple.mpegurl`), DASH (`application/dash+xml`)

The popup keeps the main list concise and exposes deeper diagnostics behind a per-item **Show Details** toggle (title candidates from DOM/meta/JSON-LD/recent resource URLs, TV/movie guess, episode hints, detection signals, and request metadata).

## Load Unpacked

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `apps/extension`
