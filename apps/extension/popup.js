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

let activeTab = null;
let authToken = null;
let health = null;
let extensionInfo = null;
let compatibilityIssue = null;

function setStatus(text, isError = false) {
  connectionStatus.textContent = text;
  connectionStatus.style.color = isError ? '#ff9b9b' : '#9fb0d8';
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

function renderMedia(items) {
  mediaList.innerHTML = '';
  emptyState.style.display = items.length ? 'none' : 'block';

  for (const item of items) {
    const wrapper = document.createElement('div');
    wrapper.className = 'media-item';

    const title = document.createElement('h3');
    title.textContent = item.filename || item.type || 'Media';

    const meta = document.createElement('p');
    const mb = item.contentLength ? `${Math.round(item.contentLength / (1024 * 1024))} MB` : 'size unknown';
    meta.className = 'muted';
    meta.textContent = `${(item.type || 'file').toUpperCase()} | ${mb}`;

    if (item.type === 'hls' && item.fallbackUrl) {
      let fallbackHost = '';
      try {
        fallbackHost = new URL(item.fallbackUrl).hostname;
      } catch {
        fallbackHost = '';
      }

      const fallback = document.createElement('span');
      fallback.className = 'fallback-pill';
      fallback.textContent = fallbackHost
        ? `Fallback: ${fallbackHost}`
        : 'Fallback available';
      fallback.title = item.fallbackUrl;
      meta.appendChild(document.createTextNode(' | '));
      meta.appendChild(fallback);
    }

    const url = document.createElement('p');
    url.className = 'media-url';
    url.textContent = item.url;

    const row = document.createElement('div');
    row.className = 'row';

    const queueBtn = document.createElement('button');
    queueBtn.className = 'primary';
    queueBtn.textContent = 'Send to Desktop';
    queueBtn.addEventListener('click', () => sendJob(item));

    row.appendChild(queueBtn);
    wrapper.appendChild(title);
    wrapper.appendChild(meta);
    wrapper.appendChild(url);
    wrapper.appendChild(row);
    mediaList.appendChild(wrapper);
  }
}

async function refreshMedia() {
  if (!activeTab) return;
  const items = await getTabMedia(activeTab.id);
  renderMedia(items);
}

async function refreshConnection() {
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
