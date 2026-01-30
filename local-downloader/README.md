# Local HLS Downloader

A powerful, feature-rich local web server for downloading HLS (HTTP Live Streaming) video streams and direct video files with advanced queue management, multi-threaded downloads, and automatic MP4 conversion.

## 📋 Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Technical Details](#technical-details)
- [Browser Extension Integration](#browser-extension-integration)
- [Troubleshooting](#troubleshooting)
- [File Structure](#file-structure)

## 🎯 Overview

Local HLS Downloader is a Node.js-based web application that provides a sophisticated interface for downloading video content from HLS streams (.m3u8 playlists) and direct video URLs. It features a modern web UI with real-time progress tracking, queue management, download history, and automatic video conversion.

### What Makes This Special?

- **Smart Resume Capability**: Automatically resumes interrupted downloads by reusing previously downloaded segments
- **Multi-threaded Downloads**: Configurable concurrent segment downloads (1-16 threads) for maximum speed
- **Automatic MP4 Conversion**: Uses FFmpeg to remux downloaded TS segments into MP4 format
- **Queue Management**: Download multiple videos with configurable concurrent downloads (1-3 simultaneous)
- **Segment Racing**: Multiple threads can race to download problematic segments for improved reliability
- **Thumbnail Generation**: Automatically generates 5 preview thumbnails from downloaded videos
- **Download History**: Browse, stream, and re-download previously saved videos
- **Real-time Monitoring**: Live segment visualization, thread status, and download statistics

## ✨ Key Features

### Download Management
- **HLS Stream Support**: Download from .m3u8 playlists with segment concatenation
- **Direct File Support**: Download MP4, TS, and other video formats directly
- **Smart Retry Logic**: Exponential backoff retry mechanism with configurable max attempts (1-∞)
- **Segment Caching**: Reuses existing segments from previous download attempts
- **Large File Handling**: Automatically splits TS files into 512MB parts to avoid filesystem limitations
- **Automatic Cleanup**: Removes temporary segment files older than 3 hours

### Queue System
- **Multi-download Queue**: Queue multiple downloads with position management
- **Concurrent Downloads**: Configure 1-3 simultaneous downloads
- **Auto-start Mode**: Automatically start next queued download when one completes
- **Pause/Resume**: Pause and resume individual downloads or all at once
- **Queue Persistence**: Queue state saved to disk and restored on server restart
- **Priority Management**: Reorder queued downloads by dragging or API calls

### User Interface
- **Modern Design**: Clean, responsive interface with glassmorphism effects
- **Real-time Progress**: Live progress bars, speed, ETA, and segment counters
- **Thread Visualization**: See what each download thread is currently doing
- **Segment Map**: Visual grid showing status of every segment (pending/downloading/completed/failed)
- **Download Statistics**: Track average speed, peak speed, elapsed time, retry counts
- **Background Slideshow**: Displays thumbnails from downloaded videos as animated background
- **Inline Video Player**: Preview downloaded videos directly in the history panel

### Video Processing
- **FFmpeg Integration**: Automatic TS to MP4 remuxing (no re-encoding)
- **Multi-part Concatenation**: Handles videos split into multiple TS parts
- **Thumbnail Generation**: Creates 5 thumbnails at 10%, 30%, 50%, 70%, 90% positions
- **Early Thumbnails**: Generates preview thumbnails during download (after 20+ segments)
- **Format Detection**: Automatically detects HLS vs direct downloads

### File Management
- **Smart Naming**: Uses webpage title or resource filename
- **Custom Names**: Override with custom filenames via settings
- **History Browser**: View all previously downloaded files with thumbnails
- **Streaming Support**: Stream videos directly from history with range request support
- **File Deletion**: Remove files from history with one click

## 🏗️ Architecture

### Backend (Node.js + Express)

#### Core Components

1. **QueueManager (src/core/QueueManager.js)**
   - Manages download queue with persistence to `downloads/queue.json`
   - Handles job lifecycle: queued → downloading → completed/failed
   - Enforces concurrent download limits
   - Provides queue manipulation (add, remove, move, pause, resume)

2. **Job Processing (src/core/JobProcessor.js)**
   - `runJob()`: Handles HLS stream downloads with multi-threaded segment fetching
   - `runDirectJob()`: Handles direct file downloads with progress tracking
   - Worker pool pattern for concurrent segment downloads
   - Segment state tracking (pending/downloading/retrying/completed/failed)

3. **Segment & Playlist Utilities (src/core/PlaylistUtils.js, src/core/SegmentDownloader.js)**
   - HTTP client selection and playlist fetching/parsing (M3U8)
   - Per-segment download with exponential backoff and timeouts
   - URL-based temp directories for segment caching
   - Atomic segment file operations with racing support
   - Segment concatenation with 512MB part splitting

4. **FFmpeg Integration (src/core/VideoConverter.js)**
   - TS to MP4 remuxing with concat demuxer for multi-part files
   - FFprobe for video duration detection
   - Thumbnail extraction (final MP4 thumbnails + early thumbnails during download)
   - Error-tolerant processing with fallback to TS format

5. **Cleanup Service (src/services/CleanupService.js)**
   - Schedules periodic cleanup of old temp segment directories
   - Deletes `.ts` files older than configured age (default 3 hours)

6. **Configuration (src/config/index.js)**
   - Centralizes server defaults: port, cleanup intervals, concurrency limits, max segment attempts
   - Keeps defaults aligned with previous hard-coded values

7. **REST API Routes (src/routes/*.js)**
   - `pages.js`: Root and UI HTML routes
   - `jobs.js`: Job creation, status, cancel, file/stream endpoints
   - `queue.js`: Queue operations (pause/resume/move/remove/settings)
   - `history.js`: Download history listing, streaming, and deletion

### Frontend (Vanilla JavaScript)

#### UI Components (`public/js/ui.js` - 72KB)

1. **Download Controller**
   - Real-time job status polling
   - Progress bar updates with animations
   - Speed and ETA calculations
   - Tab title progress indicator

2. **Queue Panel**
   - Live queue status display
   - Drag-and-drop reordering
   - Pause/resume/remove controls
   - Settings management (max concurrent, auto-start)

3. **History Panel**
   - File browser with thumbnails
   - Inline video player with HLS.js support
   - Download and delete actions
   - File size and date formatting

4. **Visualization Panels**
   - **Thread Status**: Shows what each worker thread is doing
   - **Segment Map**: Grid visualization of all segments with color coding
   - **Statistics**: Real-time and cumulative download metrics

5. **Settings Panel**
   - Thread count selection (1-16)
   - Retry attempts configuration
   - Auto-save toggle
   - File naming preferences
   - Resolution selection (future use)

6. **Background Effects**
   - Animated slideshow of video thumbnails
   - Smooth transitions and blur effects
   - Automatic thumbnail loading from downloads

### Styling (`public/css/downloader.css` - 35KB)

- Modern glassmorphism design with backdrop blur
- Responsive layout with flexbox/grid
- Custom animations and transitions
- Dark theme optimized for video content
- Accessibility-friendly controls

## 🚀 Installation

### Prerequisites

1. **Node.js** (v14 or higher)
   ```bash
   node --version
   ```

2. **FFmpeg** (required for MP4 conversion and thumbnails)
   ```bash
   # macOS (Homebrew)
   brew install ffmpeg
   
   # Ubuntu/Debian
   sudo apt-get install ffmpeg
   
   # Windows (Chocolatey)
   choco install ffmpeg
   ```

3. **FFprobe** (usually included with FFmpeg)
   ```bash
   ffprobe -version
   ```

### Setup Steps

1. **Clone or navigate to the project directory**
   ```bash
   cd /path/to/local-downloader
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Ensure FFmpeg is discoverable**
   - If you installed FFmpeg via your system package manager (Homebrew, apt, Chocolatey, etc.), it will usually be found automatically.
   - If FFmpeg lives in a custom location, set the following environment variables before starting the server:
     ```bash
     # Optional overrides if auto-detection doesn't find your binaries
     export FFMPEG_PATH=/custom/path/to/ffmpeg
     export FFPROBE_PATH=/custom/path/to/ffprobe
     ```
   - On startup, the server will auto-detect FFmpeg from:
     - `FFMPEG_PATH` env var (if set)
     - Common macOS/Linux/Windows install paths
     - `ffmpeg` on your system `PATH`
   - If FFmpeg is not found, the server will still run, but **MP4 conversion and thumbnail generation are disabled**.

4. **Start the server**
   ```bash
   npm start
   ```

5. **Access the application**
   ```
   http://localhost:3000
   ```

## ⚙️ Configuration

### Environment Variables

```bash
# Server port (default: 3000)
PORT=3000

# Optional: explicit FFmpeg binary path (otherwise auto-detected)
FFMPEG_PATH=/usr/local/bin/ffmpeg

# Optional: explicit FFprobe binary path
FFPROBE_PATH=/usr/local/bin/ffprobe
```

### Server Configuration (`src/config/index.js`)

Core server defaults are centralized in `src/config/index.js`:

```javascript
const DEFAULT_PORT = process.env.PORT || 3000;
const DEFAULT_CLEANUP_AGE_HOURS = 3;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function resolveDefaultMaxConcurrent() {
  const os = require('os');
  try {
    const cores = os.cpus()?.length || 4;
    return Math.min(8, Math.max(2, cores));
  } catch {
    return 4;
  }
}

const DEFAULT_MAX_CONCURRENT = resolveDefaultMaxConcurrent();
const DEFAULT_MAX_SEGMENT_ATTEMPTS = 30;

module.exports = {
  port: DEFAULT_PORT,
  cleanupAgeHours: DEFAULT_CLEANUP_AGE_HOURS,
  cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
  defaultMaxConcurrent: DEFAULT_MAX_CONCURRENT,
  defaultMaxSegmentAttempts: DEFAULT_MAX_SEGMENT_ATTEMPTS,
};
```

`server.js` now imports this config and uses these values instead of hard-coded constants.

### Queue Settings (configurable via UI or API)

```javascript
{
  "maxConcurrent": 1,    // Number of simultaneous downloads (1-3)
  "autoStart": true      // Automatically start next queued job
}
```

## 📖 Usage

### Basic Workflow

1. **Start the Server**
   ```bash
   npm start
   ```

2. **Open the Web Interface (optional)**
   - Navigate to `http://localhost:3000`
   - The UI will display the downloader dashboard (queue, history, etc.).

3. **Add a Download** (via browser extension or API)
   - From the **browser extension**:
     - In extension **Tab mode**, the extension opens downloader UI pages (e.g. `/m3u8downloader`, `/videodownloader`) and those pages post work into the queue.
     - In extension **Headless mode**, the extension calls `POST /api/jobs` directly from the popup without opening a UI tab.
   - From a **custom client or script**, call the REST API directly (see [API Reference](#-api-reference)).
   - Downloads are automatically added to the queue and the first download starts immediately (if `autoStart` is enabled).

4. **Monitor Progress**
   - View real-time progress, speed, and ETA
   - Toggle thread status to see worker activity
   - Toggle segment map to visualize download progress
   - Toggle stats to see detailed metrics

5. **Manage Queue**
   - Click the queue button (☰) to open the side panel
   - View all queued, active, and completed downloads
   - Pause, resume, or remove downloads
   - Reorder queue by dragging items
   - Adjust concurrent download limit

6. **Access Downloaded Files**
   - Switch to History tab in side panel
   - Click play icon to stream video inline
   - Click download icon to save file
   - Click delete icon to remove file

### Advanced Features

#### Resume Interrupted Downloads

Downloads automatically resume if:
- Server restarts while downloading
- Network connection is lost temporarily
- Download is manually paused and resumed

The system reuses existing segment files from the temp directory based on the M3U8 URL.

#### Segment Racing

When a segment fails repeatedly, idle worker threads will "race" to download it:
- Multiple threads attempt the same problematic segment
- First successful download wins
- Other attempts are discarded
- Improves reliability for unstable connections

#### Custom File Naming

Configure via settings panel:
- **Webpage Title**: Uses the page title from the browser extension
- **Resource Filename**: Uses the filename from the URL
- **Custom Name**: Override with a specific name (via extension)

#### Thumbnail Slideshow

The background automatically displays thumbnails from your downloaded videos:
- Cycles through all available thumbnails
- Smooth fade transitions
- Blur effect for aesthetic appeal
- Updates as new videos are downloaded

## 📡 API Reference

### Job Management

#### Create Job (Add to Queue)
```http
POST /api/jobs
Content-Type: application/json

{
  "queue": {
    "url": "https://example.com/video.m3u8",
    "title": "Video Title",
    "name": "video-name",
    "headers": {
      "Referer": "https://example.com",
      "User-Agent": "Mozilla/5.0..."
    }
  },
  "threads": 8,
  "settings": {
    "customName": "My Custom Name",
    "fileNaming": "title",
    "maxSegmentAttempts": "infinite"
  }
}
```

**Query Parameters:**
- `immediate=true`: Bypass queue and start immediately (legacy mode)

**Response:**
```json
{
  "id": "job-id-123",
  "queuePosition": 0
}
```

#### Get Job Status
```http
GET /api/jobs/:id?full=1
```

**Query Parameters:**
- `full=1`: Return all segment states (default: only changed segments)

**Response:**
```json
{
  "id": "job-id-123",
  "status": "downloading",
  "title": "Video Title",
  "progress": 45,
  "totalSegments": 1000,
  "completedSegments": 450,
  "bytesDownloaded": 123456789,
  "failedSegments": 5,
  "threadStates": [...],
  "segmentStates": {...},
  "thumbnailUrls": ["/downloads/job-id-123-thumb-0.jpg", ...],
  "updatedAt": 1234567890
}
```

#### Cancel Job
```http
POST /api/jobs/:id/cancel
```

#### Download Completed File
```http
GET /api/jobs/:id/file
```

#### Stream Completed File
```http
GET /api/jobs/:id/stream
```

### Queue Management

#### Get Queue
```http
GET /api/queue
```

**Response:**
```json
{
  "queue": [...],
  "settings": {
    "maxConcurrent": 1,
    "autoStart": true
  }
}
```

#### Add to Queue
```http
POST /api/queue/add
Content-Type: application/json

{
  "queue": {...},
  "threads": 8,
  "settings": {...}
}
```

#### Pause Job
```http
POST /api/queue/:id/pause
```

#### Resume Job
```http
POST /api/queue/:id/resume
```

#### Remove Job
```http
DELETE /api/queue/:id?deleteFiles=true
```

#### Move Job in Queue
```http
POST /api/queue/:id/move
Content-Type: application/json

{
  "position": 2
}
```

#### Update Queue Settings
```http
POST /api/queue/settings
Content-Type: application/json

{
  "maxConcurrent": 2,
  "autoStart": true
}
```

#### Queue Bulk Actions
```http
POST /api/queue/start-all
POST /api/queue/pause-all
POST /api/queue/clear-completed
```

### History Management

#### Get History
```http
GET /api/history
```

**Response:**
```json
{
  "items": [
    {
      "id": "filename.mp4",
      "fileName": "job-id-123-video.mp4",
      "label": "video.mp4",
      "sizeBytes": 123456789,
      "modifiedAt": 1234567890,
      "ext": ".mp4",
      "thumbnailUrl": "/downloads/job-id-123-thumb.jpg"
    }
  ]
}
```

#### Download from History
```http
GET /api/history/file/:fileName
```

#### Stream from History
```http
GET /api/history/stream/:fileName
```

Supports HTTP range requests for seeking.

#### Delete from History
```http
DELETE /api/history/:fileName
```

## 🔧 Technical Details

### Download Process Flow

#### HLS Stream Download

1. **Fetch Playlist**
   - Download .m3u8 playlist file
   - Parse segment URLs (relative or absolute)
   - Initialize segment state tracking

2. **Multi-threaded Segment Download**
   - Create worker pool (1-16 threads)
   - Each worker fetches segments concurrently
   - Segments saved to temp directory: `downloads/temp-{url-slug}/seg-{index}.ts`
   - Failed segments queued for retry with exponential backoff

3. **Segment Racing** (for problematic segments)
   - Idle workers race to download failed/retrying segments
   - First successful download wins
   - Duplicate attempts discarded

4. **Segment Concatenation**
   - Concatenate all segments in order
   - Split into 512MB parts if needed
   - Output: `downloads/{job-id}-{name}.ts` (or `-part1.ts`, `-part2.ts`, etc.)

5. **FFmpeg Remuxing**
   - Remux TS to MP4 (no re-encoding)
   - Use concat demuxer for multi-part files
   - Output: `downloads/{job-id}-{name}.mp4`
   - Delete TS file(s) after successful remux

6. **Thumbnail Generation**
   - Extract 5 frames at evenly distributed positions
   - Output: `downloads/{job-id}-thumb-{0-4}.jpg`
   - Early generation: Create thumbnails after 20+ segments downloaded

7. **Cleanup**
   - Delete temp segment files
   - Remove empty temp directories
   - Scheduled cleanup runs hourly for old segments

#### Direct File Download

1. **HTTP GET Request**
   - Stream file directly to disk
   - Track bytes downloaded for progress
   - Support for Content-Length header

2. **Progress Tracking**
   - Calculate percentage from total bytes
   - Update UI in real-time

3. **Completion**
   - Set `mp4Path` to `filePath` (no conversion needed)
   - File ready for download/streaming

### Segment State Machine

Each segment transitions through these states:

```
pending → downloading → completed
                     ↓
                  retrying → completed
                     ↓
                  failed
```

**State Details:**
- `pending`: Not yet attempted
- `downloading`: Currently being fetched by a worker
- `retrying`: Failed but will be retried (in backoff period)
- `completed`: Successfully downloaded
- `failed`: All retry attempts exhausted

### Queue State Machine

Each job transitions through these queue states:

```
queued → downloading → completed
                    ↓
                  failed
                    ↓
                  cancelled

paused ←→ queued (can pause/resume)
```

### Retry Logic

**Exponential Backoff:**
```javascript
function getRetryBackoffMs(attempt) {
  const baseMs = 500;
  const maxMs = 8000;
  const factor = Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(maxMs, baseMs * factor);
}
```

**Backoff Schedule:**
- Attempt 1: 500ms
- Attempt 2: 1000ms
- Attempt 3: 2000ms
- Attempt 4: 4000ms
- Attempt 5+: 8000ms (capped)

### File Naming Convention

**Downloaded Files:**
```
{job-id}-{sanitized-name}.{ext}
```

**Thumbnails:**
```
{job-id}-thumb-{0-4}.jpg
```

**Temp Segments:**
```
temp-{url-slug}/seg-{index}.ts
temp-{url-slug}/seg-{index}-w{worker}-a{attempt}-{timestamp}.tmp
```

**Queue State:**
```
queue.json
```

### Performance Optimizations

1. **Segment Caching**: Reuses existing segments from previous attempts
2. **Delta Updates**: Only sends changed segment states to client
3. **Concurrent Workers**: Parallel segment downloads (configurable 1-16)
4. **Racing**: Multiple threads attempt problematic segments
5. **Streaming**: Uses Node.js streams for memory efficiency
6. **Lazy Cleanup**: Defers segment deletion until after concatenation
7. **History Limiting**: Returns max 200 most recent files

## 🔌 Browser Extension Integration

This server is designed to work with the FetchTV browser extension located in the parent directory.

### Extension Communication

The extension sends download requests to:
```
http://localhost:3000/api/jobs
```

### Request Format

```javascript
{
  queue: {
    url: "https://example.com/video.m3u8",
    title: "Page Title",
    name: "resource-name",
    headers: {
      "Referer": "https://example.com",
      "User-Agent": "Mozilla/5.0...",
      "Cookie": "session=..."
    }
  },
  threads: 8,
  settings: {
    customName: "Custom Name",
    fileNaming: "title",
    maxSegmentAttempts: "infinite"
  }
}
```

### Extension Settings Sync

Settings configured in the extension are passed to the server:
- Thread count
- Retry attempts
- File naming preference
- Custom filename

## 🐛 Troubleshooting

### FFmpeg Not Found

**Error:** `ffmpeg spawn error`, `ENOENT`, or startup warning `FFmpeg not detected`

**Solution:**
1. Install FFmpeg:
   - macOS: `brew install ffmpeg`
   - Ubuntu/Debian: `sudo apt-get install ffmpeg`
   - Windows (Chocolatey): `choco install ffmpeg`
2. Verify installation: `which ffmpeg` (macOS/Linux) or `where ffmpeg` (Windows)
3. If FFmpeg is installed in a non-standard location, set environment variables before starting the server:
   ```bash
   export FFMPEG_PATH=/custom/path/to/ffmpeg
   export FFPROBE_PATH=/custom/path/to/ffprobe   # optional, usually not needed
   ```
4. Restart the server and check the console for "✓ FFmpeg found".

### Port Already in Use

**Error:** `EADDRINUSE: address already in use`

**Solution:**
1. Change port in `server.js` or use environment variable:
   ```bash
   PORT=3001 npm start
   ```
2. Or kill the process using port 3000:
   ```bash
   lsof -ti:3000 | xargs kill -9
   ```

### Download Stuck at 0%

**Possible Causes:**
1. Invalid M3U8 URL
2. Missing required headers (Referer, User-Agent)
3. Network connectivity issues
4. CORS or authentication problems

**Solution:**
1. Check browser console for errors
2. Verify URL is accessible
3. Ensure extension is sending correct headers
4. Check server logs: `console.log` output in terminal

### Segments Failing Repeatedly

**Symptoms:** Many segments in "retrying" or "failed" state

**Solutions:**
1. Increase retry attempts in settings
2. Reduce thread count (network may be throttling)
3. Check if source server is rate-limiting
4. Verify network stability
5. Enable segment racing (automatic with multiple threads)

### MP4 Conversion Failed

**Error:** `TS->MP4 remux failed`

**Solutions:**
1. Check FFmpeg installation
2. Verify TS file is valid (try playing it)
3. Check disk space
4. Review FFmpeg logs in server console
5. TS file will be available as fallback

### Queue Not Persisting

**Issue:** Queue resets after server restart

**Solution:**
1. Check write permissions on `downloads/` directory
2. Verify `downloads/queue.json` exists and is writable
3. Check server logs for save/load errors

### Thumbnails Not Generating

**Possible Causes:**
1. FFmpeg/FFprobe not installed
2. Video file corrupted
3. Unsupported video codec

**Solution:**
1. Verify FFmpeg installation: `ffmpeg -version`
2. Check server logs for thumbnail generation errors
3. Try playing the video file manually
4. Thumbnails are optional; download still succeeds without them

## 📁 File Structure

```
local-downloader/
├── server.js                 # Thin Express entrypoint and wiring
├── package.json              # Node.js dependencies and scripts
├── package-lock.json         # Dependency lock file
├── README.md                 # This file
│
├── src/
│   ├── config/
│   │   └── index.js          # Centralized server configuration
│   ├── core/
│   │   ├── QueueManager.js   # Queue management and persistence
│   │   ├── JobProcessor.js   # Orchestrates HLS/direct downloads
│   │   ├── PlaylistUtils.js  # HTTP + M3U8 helpers
│   │   ├── SegmentDownloader.js # Segment download + retry logic
│   │   └── VideoConverter.js # FFmpeg/FFprobe remux + thumbnails
│   ├── services/
│   │   └── CleanupService.js # Scheduled cleanup of temp segments
│   └── routes/
│       ├── pages.js          # UI routes
│       ├── jobs.js           # Job-related APIs
│       ├── queue.js          # Queue-related APIs
│       └── history.js        # History-related APIs
│
├── downloads/                # Downloaded files and temp segments
│   ├── queue.json           # Persistent queue state
│   ├── {job-id}-{name}.mp4  # Completed video files
│   ├── {job-id}-thumb-*.jpg # Video thumbnails
│   └── temp-{slug}/         # Temporary segment directories
│       └── seg-*.ts         # Individual TS segments
│
├── public/                   # Static web assets
│   ├── m3u8downloader.html  # Main UI
│   ├── css/
│   │   └── downloader.css   # Styles
│   └── js/
│       └── ui.js            # Frontend logic
│
└── node_modules/             # npm dependencies
    └── express/             # Web framework
```

### Key Files

#### `server.js`
- Express server setup and wiring
- Loads configuration from `src/config/index.js`
- Initializes core modules (QueueManager, JobProcessor, CleanupService)
- Registers REST API routes from `src/routes/*.js`

#### `public/m3u8downloader.html` (306 lines)
- Main UI structure
- Progress indicators
- Settings panel
- Queue/History side panel
- Thread and segment visualization
- Video player

#### `public/js/ui.js` (72KB)
- Job status polling
- UI updates and animations
- Queue management
- History browser
- Settings persistence
- Background slideshow
- Event handlers

#### `public/css/downloader.css` (35KB)
- Modern glassmorphism design
- Responsive layout
- Animations and transitions
- Component styles
- Dark theme

## 🎨 UI Components

### Main Interface
- **File Name Input**: Edit download name before/during download
- **Progress Bar**: Animated progress with shimmer effect
- **Status Bar**: Segments, size, speed, ETA
- **Control Buttons**: Stop, Play/Pause, Settings
- **Status Message**: Current download state with icon

### Display Options
- **Threads Toggle**: Show/hide worker thread status
- **Segments Toggle**: Show/hide segment visualization grid
- **Stats Toggle**: Show/hide download statistics

### Settings Panel
- Download threads (1-16)
- Auto-save toggle
- Clear cache toggle
- Tab progress indicator
- Retry attempts (1-∞)
- Resolution selection
- File naming mode

### Side Panel (Queue/History)
- **Queue Tab**:
  - Active and queued downloads
  - Pause/resume/remove controls
  - Drag-to-reorder
  - Max concurrent setting
  - Auto-start toggle
  
- **History Tab**:
  - Previously downloaded files
  - Thumbnail previews
  - Inline video player
  - Download/delete actions
  - File size and date

### Visualizations
- **Thread Status**: Real-time worker activity
- **Segment Map**: Color-coded grid of all segments
- **Statistics**: Speed, time, failures, retries

## 🔐 Security Considerations

1. **File Path Sanitization**: All filenames are sanitized to prevent directory traversal
2. **Input Validation**: Critical endpoints use `express-validator` middleware:
    - `POST /api/jobs` and `POST /api/queue/add` validate `queue.url`, `threads`, and `settings.customName`
    - `POST /api/queue/:id/move` and `/api/queue/settings` validate positions and queue settings
    - History routes validate `fileName` parameters for safe filenames
3. **No Authentication**: This is a local-only server (localhost:3000)
4. **CORS**: Not configured; intended for same-origin requests
5. **File Access**: Limited to `downloads/` directory

**⚠️ Warning:** This server is designed for local use only. Do not expose it to the internet without proper authentication and security measures.

## 🚀 Performance Tips

1. **Thread Count**: Start with 8 threads, adjust based on network speed
2. **Concurrent Downloads**: Use 1 for slow connections, 2-3 for fast
3. **Retry Attempts**: Set to "infinite" for unreliable sources
4. **Disk Space**: Ensure adequate space (videos can be large)
5. **FFmpeg**: Keep updated for best performance and codec support

## 📝 License

No license specified. This appears to be a personal project.

## 🤝 Contributing

This is a standalone local tool. Modifications can be made directly to the source files.

## 📞 Support

For issues or questions:
1. Check server console logs
2. Check browser console for frontend errors
3. Review this README for configuration options
4. Verify FFmpeg installation and paths

---

**Version:** 1.0.0  
**Node.js:** v14+  
**Dependencies:** Express 5.2.1, FFmpeg (external)  
**Platform:** macOS, Linux, Windows (with FFmpeg)
