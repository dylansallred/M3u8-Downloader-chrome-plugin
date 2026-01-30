# FetchV Browser Extension (FetchTV Plugin)

FetchV is a Chrome/Chromium extension for discovering, capturing and downloading streaming media from web pages, with a focus on HLS (`.m3u8`) streams. It provides:

- Automatic detection of streaming media resources on web pages.
- A rich popup UI for viewing detected media and starting downloads.
- Recording and buffer-based capture for streams that are not directly downloadable.
- Integration with a local downloader service (running on `http://localhost:3000`) for advanced download and processing flows.
- Flexible options and filters configurable via the popup’s settings.

This folder contains the extension package itself (suitable for loading as an **unpacked extension** in Chrome/Edge/Brave). The companion Node.js backend lives in `../local-downloader`.

---

## Features

- **Automatic media detection**
  - Injected scripts watch network/media activity on most pages.
  - HLS playlists (`.m3u8`) and other media URLs are surfaced in the popup.

- **Download & recording modes**
  - Direct download via the local downloader web UI (`/m3u8downloader`, `/videodownloader`, `/bufferrecorder`, etc.).
  - Optional **headless mode** where downloads are queued directly via the local API (`POST /api/jobs`) without opening a UI tab.
  - Recording mode for capturing media buffers when direct download is not available.

- **Advanced HLS handling**
  - Uses a custom `hls-player` and media pipeline (`hls-player.js`, `mediabunny.js`, `hook.js`, `injection.js`) to hook into video elements and streaming requests.

- **Per-tab coordination**
  - Uses `chrome.storage`, `BroadcastChannel`, and background messaging to coordinate queues, tasks, and recording across tabs.

- **Offscreen document support**
  - Uses Chrome’s `offscreen` API (via `offscreen.html` + `offscreen.js`) to safely manipulate blobs and URLs in the background.

- **Modern popup UI**
  - Built with Bootstrap 5 and Bootstrap Icons.
  - Custom dark theme and responsive layout.
  - Localized text via `_locales/` and `__MSG_*__` strings in `manifest.json` and `popup.html`.

---

## Repository Structure (Relevant to the Plugin)

```text
FetchTVPlugin/
  manifest.json
  popup.html
  offscreen.html
  service-worker.js
  js/
    content.js
    hls-player.js
    hook.js
    injection.js
    mediabunny.js
    offscreen.js
    options.js
    popup.js
    router.js
  bootstrap/
    css/
    icons/
    js/
  img/
    icon-16.png
    icon-48.png
    icon-128.png
  _locales/
    en/
    ...
```

- **`manifest.json`**
  - Chrome Manifest V3 definition:
    - `action.default_popup` → `popup.html`.
    - `background.service_worker` → `service-worker.js`.
    - `content_scripts`:
      - `router.js` for `http://localhost:3000/router.html*`.
      - `content.js` for the local downloader pages (`/m3u8downloader*`, `/videodownloader*`, `/bufferrecorder*`).
      - `injection.js` on `<all_urls>` to inject hooks (except excluded domains like `fetchv.net`, DoubleClick, Google reCAPTCHA).
    - `web_accessible_resources` → `js/hook.js`, `js/mediabunny.js`, `img/recording.svg`.
    - Permissions: `tabs`, `webRequest`, `storage`, `declarativeNetRequest`, `offscreen`, `scripting`.

- **`service-worker.js`**
  - The background script:
    - Loads `options.js`.
    - Manages extension options (`OPTION`), loading/syncing from `chrome.storage.sync`.
    - Handles migration and cleanup of `chrome.storage.local` data (queues/tasks per tab).
    - Coordinates `declarativeNetRequest` rules per tab.
    - Manages offscreen document lifecycle with `chrome.offscreen`.
    - Handles messages such as:
      - `BG_FETCH` (background fetching via blob URLs).
      - Other command-based messages from content/popup scripts.
    - Sets the action badge text & colors to reflect active items/queue length.

- **`popup.html` & `js/popup.js`**
  - Popup UI:
    - Displays detected media resources for the current tab.
    - Shows loading/empty-states when no resources are found.
    - Supports:
      - Record button (`record`) with mode switching.
      - “Inject” toggle (controls whether injection is active).
      - Filters and size limits for media.
      - Settings/off-canvas options panel (`optionsBtn`).
      - **Downloader mode toggle** (`downloaderMode`) to choose between:
        - **Tab mode** – open the local downloader UI pages for each download.
        - **Headless mode** – send jobs directly to the local API without opening a tab.
      - Header controls including:
        - `home` button to open the FetchV home/docs page on the local server.
        - **Open Downloader UI** button to open the main local-downloader UI (`OPTION.site`).
      - Tooltips and localized strings via `.lang` elements.
    - Includes:
      - `../js/hls-player.js`
      - `../js/options.js`
      - `../js/popup.js`

- **`js/content.js`**
  - Content script injected on the local downloader pages.
  - Responsibilities:
    - Ensures it only initializes once (`window.__fetchvContentInitialized`).
    - Adds `data-version` attribute to `document.body`.
    - Reads `queue` from `chrome.storage.local` and associates it with the current tab (`tabId`, `tabsCount`, `version`).
    - Creates a `BroadcastChannel("channel-<tabId>")` to:
      - Receive commands from the page UI.
      - Relay those commands to `chrome.runtime.sendMessage`.
      - Handle special `BG_FETCH` logic:
        - Fetches blob URLs returned by the background script.
        - Sends the resulting `Blob` back via the channel.
      - Handle `GET_ALL_STORAGE` to read specific storage keys.
    - Pushes recording tasks into `chrome.storage.local.tasks` for the background worker.
    - Handles recording messages (`REC_ON_DATA`, `REC_STOP`) and forwards data back to the page via BroadcastChannel.

- **`js/injection.js`, `js/hook.js`, `js/mediabunny.js`**
  - `injection.js`:
    - Executed on `<all_urls>` (except exclusions).
    - Injects `hook.js` and `mediabunny.js` into the page context where they can hook native browser APIs (e.g., `fetch`, `XMLHttpRequest`, media elements).
    - Bridges communication back to the extension via messaging/BroadcastChannel.
  - `hook.js` & `mediabunny.js`:
    - House the actual interception logic for media requests.
    - Track playable streams, segments, and metadata for the popup UI and downloading pipeline.

- **`offscreen.html` & `js/offscreen.js`**
  - Minimal hidden page for offscreen tasks.
  - Used by `service-worker.js` to perform blob operations and URL conversions in a safe, non-visible context.

- **`js/router.js`**
  - Simple redirect helper used by `router.html` on the local server.
  - Reads `?path=...` and then programmatically redirects the browser to `location.origin + path`.
  - Supports legacy or more complex link flows from the extension to the local downloader.

- **`js/options.js`**
  - Defines the `OPTION` defaults and provides helpers for:
    - Loading options from `chrome.storage.sync`.
    - Applying transformations (e.g., converting MB size limits to bytes).
  - Shared by `service-worker.js`, `popup.js`, and possibly other scripts.

- **`js/hls-player.js`**
  - Custom HLS player integration used in the popup.
  - Powers preview or playback of `.m3u8` resources before/while downloading.

---

## Installation (Developer / Unpacked)

1. **Clone / download the repository**

   ```bash
   git clone <your-repo-url>
   cd NewM3u8\ Plugin
   ```

2. **Install dependencies for the root and local-downloader (if needed)**

   ```bash
   # At repo root:
   npm install

   # Local downloader:
   cd local-downloader
   npm install
   ```

3. **Start the local downloader server**

   In `local-downloader/`:

   ```bash
   node server.js
   ```

   - The extension expects the local server to be reachable at:
     - `http://localhost:3000/m3u8downloader`
     - `http://localhost:3000/videodownloader`
     - `http://localhost:3000/bufferrecorder`
     - `http://localhost:3000/router.html`
   - Ensure `server.js` is configured to listen on port `3000`.

4. **Load the extension into Chrome/Edge/Brave**

   - Open `chrome://extensions/`.
   - Enable **Developer mode**.
   - Click **Load unpacked**.
   - Select the `FetchTVPlugin` directory.

5. **Confirm permissions**

   - The browser will show a permissions dialog (tabs, webRequest, storage, etc.).
   - Accept to enable full media detection and offscreen capabilities.

---

## Usage

1. **Open a page with streaming media**

   - Navigate to a site that uses HLS (`.m3u8`) or other streaming media.

2. **Click the FetchV icon**

   - The popup (`popup.html`) will show:
     - A list of detected media resources.
     - Status indicators.
     - Buttons for download/record.

3. **Start a download or recording**

   - Choose a detected resource.
   - Use:
     - **Direct Download**:
       - In **Tab mode** (default): sends a task/queue entry to the local downloader pages and opens (or focuses) the corresponding UI (`/m3u8downloader`, `/videodownloader`, etc.).
       - In **Headless mode**: sends a job directly to the local API (`POST /api/jobs`), without opening a UI tab. A toast in the popup shows the created job id and queue position (e.g. `Download queued (Job: abc123, Position: 0)`).
     - **Record** (`record` button):
       - Starts capturing data from the active stream.
       - Uses background tasks and `BG_FETCH` to handle segments and blobs.
   - The popup will update based on the current tab’s queue/tasks and options.

4. **Configure options**

   - Click the gear icon in the popup (`optionsBtn`).
   - Modify:
     - Size limits (min/max).
     - Filters and domain rules.
     - UI/behavior toggles (e.g., whether to auto-inject, suppression of hints).
   - Options are saved to `chrome.storage.sync` and applied extension-wide.

5. **Using the local downloader UI**

   - You can open the downloader UI in several ways:
     - Click the **Open Downloader UI** button in the popup header.
     - Click the `home` button to open the FetchV home/docs page on the local server.
     - Manually navigate to `http://localhost:3000` in your browser.
   - In **Tab mode**, the extension will also open specific routes such as:
     - `/m3u8downloader`
     - `/videodownloader`
     - `/bufferrecorder`
   - Those pages are enhanced by `js/content.js` which:
     - Communicates with the background service worker.
     - Coordinates queues and recording data via BroadcastChannel.

---

## Permissions & Security

The extension requests the following key permissions:

- **`<all_urls>` via `content_scripts` + `host_permissions`**
  - Needed to observe media/network activity on most pages to discover playable streams.

- **`tabs`**
  - So the background worker can manage per-tab state, badge counts, and tasks.

- **`webRequest`**
  - For observing requests and applying declarative rules around media fetching.

- **`storage`**
  - To store options (`chrome.storage.sync`) and temporary queues/tasks (`chrome.storage.local`).

- **`declarativeNetRequest`**
  - To dynamically register rules per tab that help detect or rewrite media requests.

- **`offscreen`**
  - To use an offscreen document for safe, non-visible blob and URL handling.

- **`scripting`**
  - To inject helper scripts (like `hook.js`, `mediabunny.js`) into pages where needed.

The code explicitly excludes some domains from injection (e.g., `fetchv.net`, `doubleclick.net`, Google reCAPTCHA) to avoid interfering with critical or ad-related flows.

---

## Localization

- All translatable strings are defined in `_locales/`.
- `manifest.json`, `popup.html`, and scripts use message keys like `__MSG_manifest_name__` and `.lang` elements.
- To add a new language:
  - Create a new folder under `_locales/<lang-code>/`.
  - Provide a `messages.json` with the required keys.
  - The browser will automatically select the correct locale based on user settings.

---

## Development Notes

- **Manifest version**: 3  
  Minimum Chrome version: `92`.

- **Badge behavior**:
  - `service-worker.js` sets the badge text (length of the queue) and colors.
  - Useful for debugging whether tasks are still pending per tab.

- **Routing helper**:
  - `router.js` is used with `router.html` on `localhost:3000` to redirect via `?path=...` query parameters.

- **One-time initialization**:
  - `content.js` guards against multiple initializations via `window.__fetchvContentInitialized`.

---

## Troubleshooting

- **No resources detected in popup**
  - Make sure:
    - The local downloader server is running on port 3000.
    - The page has started playback or is making streaming requests.
    - The site is not in the list of excluded domains (check `manifest.json` content_scripts section).

- **Downloads/recordings fail**
  - Check the browser’s DevTools console for errors in:
    - The page where playback happens.
    - The local downloader pages.
    - The extension’s background page (`chrome://extensions` → “Service worker” console).
  - Verify that `BG_FETCH` messages are not failing due to CORS or blocked requests.

- **Offscreen errors**
  - If `chrome.offscreen` is not available (older browsers), the extension falls back and may have reduced functionality.
  - Check for `chrome.runtime.lastError` messages in the background console.

---

## License

(Add your license information here, for example MIT, or reference a root-level `LICENSE` file.)
