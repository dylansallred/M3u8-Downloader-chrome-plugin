(function bootstrapStreamPlayer() {
  const titleEl = document.getElementById('title');
  const sourceEl = document.getElementById('source');
  const statusEl = document.getElementById('status');
  const videoEl = document.getElementById('player');
  const debugLogEl = document.getElementById('debugLog');
  const openSourceBtn = document.getElementById('openSourceBtn');
  const openFallbackBtn = document.getElementById('openFallbackBtn');
  const retryBtn = document.getElementById('retryBtn');

  if (!videoEl || !statusEl || !titleEl || !sourceEl) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const sessionId = String(params.get('session') || '').trim();

  let primaryUrl = String(params.get('src') || '').trim();
  let fallbackUrl = String(params.get('fallback') || '').trim();
  let declaredType = String(params.get('type') || '').trim().toLowerCase();
  let displayTitle = String(params.get('title') || 'Stream Player').trim();
  let sourcePageUrl = '';
  let requestHeaders = {};

  let hls = null;
  let usingFallback = false;
  let currentObjectUrl = '';
  const debugLines = [];

  const BLOCKED_HEADER_NAMES = new Set([
    'origin',
    'referer',
    'host',
    'user-agent',
    'cookie',
    'content-length',
    'connection',
  ]);

  function isHlsUrl(url) {
    return /\.m3u8(\?|$)/i.test(String(url || ''));
  }

  function getCurrentUrl() {
    if (usingFallback && fallbackUrl) return fallbackUrl;
    return primaryUrl || fallbackUrl || '';
  }

  function setStatus(message, tone = 'ok') {
    statusEl.textContent = String(message || '');
    statusEl.className = `status ${tone}`;
  }

  function setSourceLabel() {
    const src = getCurrentUrl();
    sourceEl.textContent = src || 'No stream URL provided.';
  }

  function appendDebug(message, data = null) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${String(message || '').trim()}`;
    if (!line.trim()) return;
    debugLines.push(data ? `${line} ${JSON.stringify(data)}` : line);
    while (debugLines.length > 40) {
      debugLines.shift();
    }
    if (debugLogEl) {
      debugLogEl.textContent = debugLines.join('\n');
      debugLogEl.scrollTop = debugLogEl.scrollHeight;
    }
  }

  function revokeCurrentObjectUrl() {
    if (!currentObjectUrl) return;
    try {
      URL.revokeObjectURL(currentObjectUrl);
    } catch {
      // ignore
    }
    currentObjectUrl = '';
  }

  function destroyHls() {
    if (hls && typeof hls.destroy === 'function') {
      try {
        hls.destroy();
      } catch {
        // ignore
      }
    }
    hls = null;
  }

  function normalizeRequestHeaders(rawHeaders) {
    if (!rawHeaders || typeof rawHeaders !== 'object') {
      return {};
    }
    const output = {};
    const entries = Object.entries(rawHeaders);
    for (const [rawKey, rawValue] of entries) {
      const key = String(rawKey || '').trim();
      const value = String(rawValue || '').trim();
      if (!key || !value) continue;
      const lower = key.toLowerCase();
      if (BLOCKED_HEADER_NAMES.has(lower)) continue;
      if (lower.startsWith('sec-')) continue;
      if (lower.startsWith('proxy-')) continue;
      if (lower.startsWith(':')) continue;
      output[key.slice(0, 64)] = value.slice(0, 1000);
      if (Object.keys(output).length >= 30) break;
    }
    return output;
  }

  function resolveReferrerUrl() {
    const explicitReferrer = String(
      requestHeaders.Referer
      || requestHeaders.referer
      || sourcePageUrl
      || ''
    ).trim();
    if (!explicitReferrer) return '';
    try {
      return new URL(explicitReferrer).toString();
    } catch {
      return '';
    }
  }

  function buildFetchOptions(extra = {}) {
    const headers = normalizeRequestHeaders(requestHeaders);
    const referrer = resolveReferrerUrl();
    const options = {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      ...extra,
      headers: {
        ...(extra.headers || {}),
        ...headers,
      },
    };
    if (referrer) {
      options.referrer = referrer;
      options.referrerPolicy = 'strict-origin-when-cross-origin';
    }
    return options;
  }

  function applyRequestHeadersToXhr(xhr) {
    const headers = normalizeRequestHeaders(requestHeaders);
    Object.entries(headers).forEach(([key, value]) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch {
        // ignore header assignment failures
      }
    });
  }

  async function tryPlay() {
    try {
      await videoEl.play();
    } catch {
      // user gesture may still be required in some cases
    }
  }

  function useDirectVideoUrl(url) {
    destroyHls();
    revokeCurrentObjectUrl();
    videoEl.src = url;
    videoEl.load();
    void tryPlay();
  }

  async function useFetchedMediaUrl(url) {
    destroyHls();
    revokeCurrentObjectUrl();

    const response = await fetch(url, buildFetchOptions({ method: 'GET' }));
    if (!response.ok) {
      throw new Error(`direct fetch failed with status ${response.status}`);
    }

    const blob = await response.blob();
    currentObjectUrl = URL.createObjectURL(blob);
    videoEl.src = currentObjectUrl;
    videoEl.load();
    void tryPlay();
  }

  function fallbackToDirectIfAvailable(reason) {
    if (!fallbackUrl || usingFallback) {
      appendDebug('No fallback available', { reason });
      setStatus(reason, 'error');
      return false;
    }
    usingFallback = true;
    setSourceLabel();
    appendDebug('Switching to fallback source', { reason, fallbackUrl });
    setStatus(`HLS unavailable (${reason}). Using fallback source.`, 'warn');
    useDirectVideoUrl(fallbackUrl);
    return true;
  }

  async function loadCurrentSource() {
    const url = getCurrentUrl();
    if (!url) {
      setStatus('No source URL available for playback.', 'error');
      return;
    }

    setSourceLabel();
    appendDebug('Loading source', {
      url,
      declaredType,
      usingFallback,
      hasSourcePageUrl: !!sourcePageUrl,
      forwardedHeaderKeys: Object.keys(normalizeRequestHeaders(requestHeaders)),
    });

    const hlsCandidate = declaredType === 'hls' || isHlsUrl(url);
    if (!hlsCandidate) {
      setStatus('Loading direct media source.', 'ok');
      try {
        await useFetchedMediaUrl(url);
        appendDebug('Direct media fetched successfully');
        setStatus('Playing direct media source with captured request context.', 'ok');
      } catch (err) {
        appendDebug('Direct fetch failed, falling back to plain video src', {
          error: err && err.message ? err.message : String(err || 'Unknown error'),
        });
        setStatus('Direct fetch failed, retrying without captured request context.', 'warn');
        useDirectVideoUrl(url);
      }
      return;
    }

    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      appendDebug('Native HLS support detected, but forcing HLS.js to preserve request context');
    }

    if (typeof window.Hls === 'undefined' || !window.Hls || !window.Hls.isSupported()) {
      const switched = fallbackToDirectIfAvailable('browser does not support HLS.js');
      if (!switched) {
        setStatus('This browser cannot play HLS in this tab.', 'error');
      }
      return;
    }

    destroyHls();
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 60,
      xhrSetup: (xhr) => {
        xhr.withCredentials = true;
        applyRequestHeadersToXhr(xhr);
      },
      fetchSetup: (context, initParams) => {
        const request = new Request(context.url, buildFetchOptions(initParams || {}));
        appendDebug('Configured HLS fetch request', {
          url: context.url,
          hasReferrer: !!resolveReferrerUrl(),
          headerKeys: Object.keys(normalizeRequestHeaders(requestHeaders)),
        });
        return request;
      },
    });

    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
      appendDebug('HLS media attached', { url });
      hls.loadSource(url);
    });

    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      appendDebug('HLS manifest parsed successfully');
      setStatus('Streaming HLS manifest.', 'ok');
      void tryPlay();
    });

    hls.on(window.Hls.Events.LEVEL_LOADED, (_event, data) => {
      appendDebug('HLS level loaded', {
        level: data && data.level,
        url: data && data.details && data.details.url,
      });
    });

    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      const reason = data.details || data.type || 'unknown HLS error';
      const responseCode = Number(data.response && data.response.code || 0);
      appendDebug('HLS error', {
        fatal: !!(data && data.fatal),
        type: data && data.type,
        details: data && data.details,
        responseCode,
        url: data && data.context && data.context.url,
      });
      if (!data || !data.fatal) return;
      if (fallbackToDirectIfAvailable(reason)) return;
      if (responseCode === 403) {
        setStatus('HLS playback blocked (403). This source likely requires page-bound referrer/origin/cookies.', 'error');
        return;
      }
      setStatus(`HLS playback failed: ${reason}`, 'error');
    });

    hls.attachMedia(videoEl);
    setStatus('Loading HLS stream with captured request context...', 'ok');
  }

  function openInNewTab(url) {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function loadStreamSession(id) {
    if (!id || !chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      return null;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        cmd: 'GET_STREAM_SESSION',
        sessionId: id,
      });
      if (!response || !response.ok || !response.session) return null;
      return response.session;
    } catch {
      return null;
    }
  }

  async function initializeFromSessionIfAvailable() {
    if (!sessionId) return;
    const session = await loadStreamSession(sessionId);
    if (!session) return;

    primaryUrl = String(session.sourceUrl || '').trim();
    fallbackUrl = String(session.fallbackUrl || '').trim();
    declaredType = String(session.declaredType || '').trim().toLowerCase();
    displayTitle = String(session.title || displayTitle || 'Stream Player').trim();
    sourcePageUrl = String(session.sourcePageUrl || '').trim();
    requestHeaders = session.requestHeaders && typeof session.requestHeaders === 'object'
      ? session.requestHeaders
      : {};
  }

  async function init() {
    await initializeFromSessionIfAvailable();
    appendDebug('Stream session initialized', {
      hasPrimaryUrl: !!primaryUrl,
      hasFallbackUrl: !!fallbackUrl,
      declaredType,
      sourcePageUrl: sourcePageUrl || null,
      forwardedHeaderKeys: Object.keys(normalizeRequestHeaders(requestHeaders)),
    });

    titleEl.textContent = displayTitle || 'Stream Player';
    document.title = `${displayTitle || 'Stream Player'} - Stream Player`;

    openSourceBtn?.addEventListener('click', () => openInNewTab(sourcePageUrl || primaryUrl));
    if (!sourcePageUrl && !primaryUrl && openSourceBtn) {
      openSourceBtn.disabled = true;
    }

    openFallbackBtn?.addEventListener('click', () => openInNewTab(fallbackUrl));
    if (!fallbackUrl && openFallbackBtn) {
      openFallbackBtn.disabled = true;
    }

    retryBtn?.addEventListener('click', () => {
      usingFallback = false;
      appendDebug('Retry requested');
      loadCurrentSource();
    });

    videoEl.addEventListener('error', () => {
      appendDebug('Video element emitted error');
      const switched = fallbackToDirectIfAvailable('video element error');
      if (!switched) {
        setStatus('Video element failed to load this source.', 'error');
      }
    });

    setSourceLabel();
    loadCurrentSource();
  }

  void init();

  window.addEventListener('beforeunload', () => {
    destroyHls();
    revokeCurrentObjectUrl();
  });
})();
