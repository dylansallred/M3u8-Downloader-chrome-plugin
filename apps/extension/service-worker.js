const MAX_ITEMS_PER_TAB = 60;

function getStorageKey(tabId) {
  return `storage${tabId}`;
}

function normalizeMedia(item = {}) {
  const url = String(item.url || '').trim();
  if (!url) return null;

  const contentType = String(item.contentType || '').toLowerCase();
  const isHls = /\.m3u8(\?|$)/i.test(url) || contentType.includes('mpegurl');

  return {
    id: item.requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    method: item.method || 'GET',
    contentType: item.contentType || '',
    contentLength: Number(item.contentLength || 0),
    filename: item.filename || 'media',
    requestHeaders: item.requestHeaders || {},
    detectedAt: item.detectedAt || Date.now(),
    type: isHls ? 'hls' : 'file',
  };
}

function isLikelySegmentUrl(url) {
  return /\.(ts|m4s)(\?|$)/i.test(String(url || ''));
}

function isDirectFallbackCandidate(item) {
  if (!item || item.type !== 'file') return false;

  const url = String(item.url || '');
  const contentType = String(item.contentType || '').toLowerCase();

  if (isLikelySegmentUrl(url)) return false;
  if (/\.m3u8(\?|$)/i.test(url)) return false;

  // Prefer full video assets over manifest/chunk requests.
  if (/\.(mp4|mov|webm|mkv|avi|flv)(\?|$)/i.test(url)) return true;
  if (contentType.startsWith('video/') && !contentType.includes('mpegurl')) return true;
  return false;
}

function attachFallbackUrls(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const directCandidates = items
    .filter(isDirectFallbackCandidate)
    .sort((a, b) => {
      // Prefer larger direct assets, then recency.
      const sizeA = Number(a.contentLength || 0);
      const sizeB = Number(b.contentLength || 0);
      if (sizeA !== sizeB) return sizeB - sizeA;
      return Number(b.detectedAt || 0) - Number(a.detectedAt || 0);
    });

  const fallback = directCandidates[0] || null;
  if (!fallback) return items;

  return items.map((item) => {
    if (!item || item.type !== 'hls') return item;
    return {
      ...item,
      fallbackUrl: fallback.url,
    };
  });
}

function setBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
  chrome.action.setBadgeText({ tabId, text });
}

async function storeMedia(tabId, media) {
  const key = getStorageKey(tabId);
  const current = await chrome.storage.local.get([key]);
  const existing = Array.isArray(current[key]) ? current[key] : [];

  if (existing.some((x) => x.url === media.url)) {
    setBadge(tabId, existing.length);
    return { ok: true, duplicate: true, count: existing.length };
  }

  existing.unshift(media);
  const next = existing.slice(0, MAX_ITEMS_PER_TAB);
  await chrome.storage.local.set({ [key]: next });
  setBadge(tabId, next.length);

  return { ok: true, duplicate: false, count: next.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const cmd = message && message.cmd;

  if (cmd === 'STORE_DETECTED_MEDIA') {
    const tabId = sender.tab && sender.tab.id;
    const media = normalizeMedia(message.media);

    if (!tabId || !media) {
      sendResponse({ ok: false, error: 'Invalid media payload' });
      return true;
    }

    storeMedia(tabId, media)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (cmd === 'GET_TAB_MEDIA') {
    const tabId = message.tabId;
    if (!tabId) {
      sendResponse({ ok: false, items: [] });
      return true;
    }

    const key = getStorageKey(tabId);
    chrome.storage.local.get([key]).then((result) => {
      const items = Array.isArray(result[key]) ? result[key] : [];
      const enhanced = attachFallbackUrls(items);
      setBadge(tabId, items.length);
      sendResponse({ ok: true, items: enhanced });
    });
    return true;
  }

  if (cmd === 'CLEAR_TAB_MEDIA') {
    const tabId = message.tabId;
    if (!tabId) {
      sendResponse({ ok: false });
      return true;
    }

    const key = getStorageKey(tabId);
    chrome.storage.local.remove([key]).then(() => {
      setBadge(tabId, 0);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (cmd === 'GET_EXTENSION_INFO') {
    sendResponse({
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([getStorageKey(tabId)]);
});
