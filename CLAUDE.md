# CLAUDE.md

## Project Overview

M3u8-Downloader-chrome-plugin is a dual-component system for detecting and downloading HLS video streams:

1. **FetchV Browser Extension** (`FetchTVPlugin/`) - Chrome extension (Manifest V3) that detects `.m3u8` streams and direct video files on web pages
2. **Local HLS Downloader** (`local-downloader/`) - Node.js/Express backend for queue management, multi-threaded downloading, and MP4 conversion

## Tech Stack

**Browser Extension:**
- Vanilla JavaScript, Chrome Manifest V3
- HTML5, CSS3, Bootstrap 5
- Chrome Storage API, BroadcastChannel

**Backend:**
- Node.js with Express.js 5.2.1
- WebSocket (ws) for real-time updates
- FFmpeg/FFprobe for video processing
- Winston for logging

## Project Structure

```
moscow/
├── FetchTVPlugin/           # Chrome extension (unpacked)
│   ├── manifest.json        # MV3 config
│   ├── service-worker.js    # Background tasks
│   ├── js/                  # Extension scripts
│   └── _locales/            # 30+ language translations
├── local-downloader/        # Backend server
│   ├── server.js            # Entry point
│   ├── src/
│   │   ├── core/            # Download logic
│   │   ├── routes/          # API endpoints
│   │   ├── services/        # Business logic
│   │   └── config/          # Configuration
│   └── public/              # Web UI
└── README.md
```

## Development Commands

```bash
# Backend
cd local-downloader
npm install
npm start              # Starts server on port 3000

# Extension
# No build needed - load unpacked via chrome://extensions
```

## Key Architecture

**Extension Flow:**
- Service worker manages background tasks and message routing
- Injection scripts hook `fetch`/`XMLHttpRequest` for media detection
- Content scripts coordinate with downloader pages via BroadcastChannel
- Popup displays detected media and sends to local backend

**Backend Flow:**
- `QueueManager` - Persists queue to `downloads/queue.json`
- `JobProcessor` - Handles HLS (parse M3U8 → download segments → concat → convert) and direct downloads
- `SegmentDownloader` - Multi-threaded segment fetching with retry
- `VideoConverter` - FFmpeg integration for TS→MP4 remuxing

**Job States:** `queued` → `downloading` → `completed/failed`

## Key Files

- `local-downloader/server.js` - Express app entry point
- `local-downloader/src/core/QueueManager.js` - Queue persistence and lifecycle
- `local-downloader/src/core/JobProcessor.js` - Download orchestration
- `FetchTVPlugin/js/service-worker.js` - Extension background script
- `FetchTVPlugin/js/popup.js` - Extension UI controller

## API Endpoints

- `POST /api/jobs` - Create download job
- `GET /api/jobs/{id}` - Get job status
- `DELETE /api/jobs/{id}` - Cancel job
- `GET /api/queue` - Queue status
- `POST /api/queue/settings` - Update settings

## Configuration

Environment variables:
- `PORT` - Server port (default: 3000)
- `FFMPEG_PATH` - FFmpeg binary (auto-detected)
- `TMDB_API_KEY` - Optional metadata lookup

Backend config in `src/config/index.js`:
- `DEFAULT_MAX_CONCURRENT` - Worker threads (auto from CPU cores, 2-16)
- `DEFAULT_MAX_SEGMENT_ATTEMPTS` - Retry limit (default: 30)
- `CLEANUP_AGE_HOURS` - Temp file retention (default: 3)

## Notes

- No automated tests currently configured
- FFmpeg optional but required for MP4 conversion
- Extension requires broad permissions for media detection
- Queue state survives server restarts
