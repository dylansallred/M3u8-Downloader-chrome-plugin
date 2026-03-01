let API_BASE = 'http://127.0.0.1:49732';
const STORAGE_TOKEN_KEY = 'desktopAuthToken';
const EXTENSION_PROTOCOL_VERSION = 1;

try {
  const params = new URLSearchParams(window.location.search);
  const candidate = String(params.get('apiBase') || '').trim();
  if (/^http:\/\/127\.0\.0\.1:\d+$/i.test(candidate)) {
    API_BASE = candidate;
  }
} catch {
  // ignore malformed URL params and keep default API base
}

const connectionStatus = document.getElementById('connectionStatus');
const pairingCard = document.getElementById('pairingCard');
const pairingCodeInput = document.getElementById('pairingCode');
const pairButton = document.getElementById('pairButton');
const pairingResult = document.getElementById('pairingResult');
const mediaList = document.getElementById('mediaList');
const emptyState = document.getElementById('emptyState');
const refreshButton = document.getElementById('refreshButton');
const clearButton = document.getElementById('clearButton');
const statusDot = document.getElementById('statusDot');

let activeTab = null;
let authToken = null;
let health = null;
let extensionInfo = null;
let compatibilityIssue = null;

function setStatus(text, isError = false) {
  connectionStatus.textContent = text;
  connectionStatus.style.color = isError ? 'var(--color-danger)' : 'var(--color-fg-muted)';

  statusDot.className = 'status-dot';
  if (isError) {
    statusDot.classList.add('disconnected');
  } else if (text.startsWith('Checking') || text.startsWith('Desktop app not')) {
    statusDot.classList.add('checking');
  } else {
    statusDot.classList.add('connected');
  }
}

function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_TOKEN_KEY], (result) => {
      resolve(result[STORAGE_TOKEN_KEY] || null);
    });
  });
}

function setToken(token) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_TOKEN_KEY]: token }, () => resolve());
  });
}

async function fetchHealth() {
  try {
    const res = await fetch(`${API_BASE}/v1/health`, {
      headers: {
        'X-Client': 'fetchv-extension',
        'X-Protocol-Version': String(EXTENSION_PROTOCOL_VERSION),
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    health = data;
    return data;
  } catch (err) {
    health = null;
    throw err;
  }
}

function parseVersionParts(input) {
  return String(input || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .map((value) => (Number.isFinite(value) && value >= 0 ? value : 0));
}

function compareVersions(a, b) {
  const av = parseVersionParts(a);
  const bv = parseVersionParts(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const left = av[i] || 0;
    const right = bv[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function updateCompatibilityState() {
  compatibilityIssue = null;
  if (!health) return;

  const minProtocol = Number(health?.supportedProtocolVersions?.min ?? health?.protocolVersion ?? EXTENSION_PROTOCOL_VERSION);
  const maxProtocol = Number(health?.supportedProtocolVersions?.max ?? health?.protocolVersion ?? EXTENSION_PROTOCOL_VERSION);

  if (Number.isFinite(minProtocol) && Number.isFinite(maxProtocol)) {
    if (EXTENSION_PROTOCOL_VERSION < minProtocol || EXTENSION_PROTOCOL_VERSION > maxProtocol) {
      compatibilityIssue = `Protocol mismatch. Extension protocol ${EXTENSION_PROTOCOL_VERSION}, app supports ${minProtocol}-${maxProtocol}.`;
      return;
    }
  }

  const minExtensionVersion = String(health?.minExtensionVersion || '').trim();
  const currentExtensionVersion = String(extensionInfo?.version || '').trim();
  if (minExtensionVersion && currentExtensionVersion) {
    if (compareVersions(currentExtensionVersion, minExtensionVersion) < 0) {
      compatibilityIssue = `Extension ${currentExtensionVersion} is too old. Update to ${minExtensionVersion}+`;
    }
  }
}

function applyCompatibilityUi() {
  const blocked = Boolean(compatibilityIssue);
  pairButton.disabled = blocked;
  if (blocked) {
    setStatus('Desktop connected, but update required', true);
    pairingCard.style.display = 'block';
    pairingResult.textContent = compatibilityIssue;
    return;
  }

  pairButton.disabled = false;
}

async function pairExtension() {
  if (compatibilityIssue) {
    pairingResult.textContent = compatibilityIssue;
    return;
  }

  const code = String(pairingCodeInput.value || '').trim().toUpperCase();
  if (!code) {
    pairingResult.textContent = 'Enter pairing code first.';
    return;
  }

  if (!extensionInfo) {
    extensionInfo = await chrome.runtime.sendMessage({ cmd: 'GET_EXTENSION_INFO' });
  }

  try {
    const res = await fetch(`${API_BASE}/v1/pair/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client': 'fetchv-extension',
        'X-Protocol-Version': String(EXTENSION_PROTOCOL_VERSION),
        'X-Extension-Version': String(extensionInfo?.version || ''),
      },
      body: JSON.stringify({
        pairingCode: code,
        extensionId: extensionInfo.id,
        extensionVersion: extensionInfo.version,
        browser: 'chrome',
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    authToken = data.token;
    await setToken(authToken);
    pairingResult.textContent = 'Paired successfully. You can now send jobs.';
    await refreshConnection();
  } catch (err) {
    pairingResult.textContent = `Pairing failed: ${err.message}`;
  }
}

async function getTabMedia(tabId) {
  const response = await chrome.runtime.sendMessage({
    cmd: 'GET_TAB_MEDIA',
    tabId,
  });
  return response && response.items ? response.items : [];
}

function buildJobPayload(item) {
  const mediaUrl = item.url;
  const title = (activeTab && activeTab.title) || item.filename || 'Download';

  return {
    mediaUrl,
    mediaType: item.type || (/\.m3u8(\?|$)/i.test(mediaUrl) ? 'hls' : 'file'),
    title,
    resourceName: item.filename || title,
    headers: item.requestHeaders || {},
    sourcePageUrl: (activeTab && activeTab.url) || '',
    sourcePageTitle: title,
    fallbackMediaUrl: item.fallbackUrl || '',
    settings: {
      fileNaming: 'title',
      maxSegmentAttempts: 'infinite',
      threads: 8,
    },
  };
}

async function sendJob(item) {
  if (compatibilityIssue) {
    alert(`Update required before sending jobs: ${compatibilityIssue}`);
    return;
  }

  if (!authToken) {
    alert('Pair this extension with the desktop app first.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/v1/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'X-Client': 'fetchv-extension',
        'X-Protocol-Version': String(EXTENSION_PROTOCOL_VERSION),
        'X-Extension-Version': String(extensionInfo?.version || ''),
      },
      body: JSON.stringify(buildJobPayload(item)),
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
      await setToken(null);
      authToken = null;
      throw new Error('Token expired or invalid. Pair again.');
    }

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (data.duplicate) {
      alert(`Already queued: ${data.jobId} (position ${data.queuePosition + 1})`);
      return;
    }

    alert(`Queued: ${data.jobId} (position ${data.queuePosition + 1})`);
  } catch (err) {
    if (!health) {
      alert('Desktop app is not reachable. Open M3U8 Downloader desktop app and retry.');
      return;
    }
    alert(`Failed to queue download: ${err.message}`);
  }
}

function tryDecodeBase64(str) {
  try {
    const cleaned = str.replace(/[~]/g, '/');
    const decoded = atob(cleaned);
    if (/^[\x20-\x7E]+$/.test(decoded)) return decoded;
  } catch { /* not valid base64 */ }
  return null;
}

function extractResolution(url) {
  // Check for common resolution patterns in URL path
  const plainMatch = url.match(/[\/_\-.](\d{3,4})[pP](?:[\/_\-.]|$)/);
  if (plainMatch) return `${plainMatch[1]}p`;

  // Try decoding base64 path segments that might contain resolution
  try {
    const pathSegments = new URL(url).pathname.split('/').filter(Boolean);
    for (const seg of pathSegments) {
      if (/^[A-Za-z0-9+/=]{2,8}$/.test(seg)) {
        const decoded = tryDecodeBase64(seg);
        if (decoded && /^\d{3,4}$/.test(decoded)) {
          return `${decoded}p`;
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

function getDisplayTitle(item) {
  // Use page title if available (more meaningful than encoded filenames)
  const pageTitle = activeTab && activeTab.title;

  const filename = item.filename || '';

  // Check if filename is base64-encoded
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
  if (/^[A-Za-z0-9+/=~]{8,}$/.test(nameWithoutExt)) {
    const decoded = tryDecodeBase64(nameWithoutExt);
    if (decoded) {
      // If decoded is generic (index, playlist, master), prefer page title
      if (/^(index|playlist|master|chunklist|media)\b/i.test(decoded) && pageTitle) {
        return pageTitle;
      }
      return decoded;
    }
  }

  // If filename is generic, prefer page title
  if (/^(index|playlist|master|media)\.(m3u8|mpd)$/i.test(filename) && pageTitle) {
    return pageTitle;
  }

  return filename || pageTitle || 'Media';
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatContentType(contentType) {
  if (!contentType) return null;
  const ct = contentType.split(';')[0].trim();
  const friendly = {
    'application/x-mpegurl': 'HLS Playlist',
    'application/vnd.apple.mpegurl': 'HLS Playlist',
    'application/dash+xml': 'DASH Manifest',
    'video/mp4': 'MP4 Video',
    'video/webm': 'WebM Video',
    'video/mp2t': 'MPEG-TS',
    'audio/mpeg': 'MP3 Audio',
    'audio/mp4': 'M4A Audio',
  };
  return friendly[ct.toLowerCase()] || ct;
}

function formatSize(bytes) {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function makeDot() {
  const dot = document.createElement('span');
  dot.className = 'text-fg-subtle text-[0.625rem]';
  dot.textContent = '\u00B7';
  return dot;
}

function renderMedia(items) {
  mediaList.innerHTML = '';
  emptyState.style.display = items.length ? 'none' : 'flex';

  for (const item of items) {
    const wrapper = document.createElement('div');
    wrapper.className = 'glass-subtle glass-glow p-3 animate-slide-up';

    // Row 1: title + pills
    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-start justify-between gap-2';

    const title = document.createElement('h3');
    title.className = 'text-[0.8125rem] font-medium text-fg truncate flex-1';
    title.textContent = getDisplayTitle(item);

    const pillGroup = document.createElement('div');
    pillGroup.className = 'flex items-center gap-1 flex-shrink-0';

    const resolution = extractResolution(item.url);
    if (resolution) {
      const resPill = document.createElement('span');
      resPill.className = 'pill pill-muted';
      resPill.textContent = resolution;
      pillGroup.appendChild(resPill);
    }

    const typePill = document.createElement('span');
    typePill.className = 'pill pill-accent';
    typePill.textContent = (item.type || 'file').toUpperCase();
    pillGroup.appendChild(typePill);

    titleRow.appendChild(title);
    titleRow.appendChild(pillGroup);

    // Row 2: domain + content type
    const infoRow = document.createElement('div');
    infoRow.className = 'flex items-center gap-1.5 mt-1.5 flex-wrap text-[0.6875rem] text-fg-muted';

    const hostname = getHostname(item.url);
    if (hostname) {
      const domainEl = document.createElement('span');
      domainEl.textContent = hostname;
      infoRow.appendChild(domainEl);
    }

    const friendlyType = formatContentType(item.contentType);
    if (friendlyType) {
      if (hostname) infoRow.appendChild(makeDot());
      const typeEl = document.createElement('span');
      typeEl.textContent = friendlyType;
      infoRow.appendChild(typeEl);
    }

    // Row 3: size + time + fallback
    const metaRow = document.createElement('div');
    metaRow.className = 'flex items-center gap-1.5 mt-1 flex-wrap text-[0.6875rem] text-fg-subtle';

    const sizeText = formatSize(item.contentLength);
    if (sizeText) {
      const sizeEl = document.createElement('span');
      sizeEl.textContent = sizeText;
      metaRow.appendChild(sizeEl);
    }

    const timeText = formatTimeAgo(item.detectedAt);
    if (timeText) {
      if (sizeText) metaRow.appendChild(makeDot());
      const timeEl = document.createElement('span');
      timeEl.textContent = timeText;
      metaRow.appendChild(timeEl);
    }

    if (item.type === 'hls' && item.fallbackUrl) {
      const fallbackHost = getHostname(item.fallbackUrl);
      if (sizeText || timeText) metaRow.appendChild(makeDot());
      const fallback = document.createElement('span');
      fallback.className = 'pill pill-accent text-[0.625rem]';
      fallback.textContent = fallbackHost
        ? `Fallback: ${fallbackHost}`
        : 'Fallback available';
      fallback.title = item.fallbackUrl;
      metaRow.appendChild(fallback);
    }

    // Row 4: URL + copy button
    const urlRow = document.createElement('div');
    urlRow.className = 'url-row';

    const url = document.createElement('p');
    url.className = 'url-text';
    url.textContent = item.url;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy';
    copyBtn.title = 'Copy URL';
    copyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(item.url).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        }, 1500);
      });
    });

    urlRow.appendChild(url);
    urlRow.appendChild(copyBtn);

    // Row 5: Action button
    const actionRow = document.createElement('div');
    actionRow.className = 'flex justify-end mt-2.5';

    const queueBtn = document.createElement('button');
    queueBtn.className = 'btn btn-primary text-xs';
    queueBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg> Send to Desktop';
    queueBtn.addEventListener('click', () => sendJob(item));

    actionRow.appendChild(queueBtn);
    wrapper.appendChild(titleRow);
    wrapper.appendChild(infoRow);
    wrapper.appendChild(metaRow);
    wrapper.appendChild(urlRow);
    wrapper.appendChild(actionRow);
    mediaList.appendChild(wrapper);
  }
}

async function refreshMedia() {
  if (!activeTab) return;
  const items = await getTabMedia(activeTab.id);
  renderMedia(items);
}

async function refreshConnection() {
  statusDot.className = 'status-dot checking';
  try {
    const data = await fetchHealth();
    updateCompatibilityState();
    setStatus(`Desktop connected (${data.appVersion})`);

    if (compatibilityIssue) {
      applyCompatibilityUi();
      return;
    }

    if (!authToken || data.pairingRequired) {
      pairingCard.style.display = 'block';
      pairingResult.textContent = data.pairingRequired
        ? 'Desktop app requires pairing.'
        : 'Token missing, pair extension.';
    } else {
      pairingCard.style.display = 'none';
      pairingResult.textContent = '';
    }
  } catch (err) {
    compatibilityIssue = null;
    applyCompatibilityUi();
    pairingCard.style.display = 'block';
    setStatus('Desktop app not running at 127.0.0.1:49732', true);
    pairingResult.textContent = 'Open desktop app, then click Refresh.';
  }
}

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  const forcedTabId = Number(params.get('tabId'));
  const forcedTabUrl = String(params.get('tabUrl') || '').trim();

  if (Number.isFinite(forcedTabId) && forcedTabId > 0) {
    try {
      activeTab = await chrome.tabs.get(forcedTabId);
    } catch {
      activeTab = null;
    }
  }

  if (!activeTab && forcedTabUrl) {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      activeTab = tabs.find((tab) => (tab.url || '').startsWith(forcedTabUrl)) || null;
    } catch {
      activeTab = null;
    }
  }

  if (!activeTab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
  }

  authToken = await getToken();
  extensionInfo = await chrome.runtime.sendMessage({ cmd: 'GET_EXTENSION_INFO' });

  pairButton.addEventListener('click', pairExtension);
  refreshButton.addEventListener('click', async () => {
    await refreshConnection();
    await refreshMedia();
  });

  clearButton.addEventListener('click', async () => {
    if (!activeTab) return;
    await chrome.runtime.sendMessage({ cmd: 'CLEAR_TAB_MEDIA', tabId: activeTab.id });
    await refreshMedia();
  });

  await refreshConnection();
  await refreshMedia();
}

initialize();
