(function bootstrapStreamPlayer() {
  const titleEl = document.getElementById('title');
  const sourceEl = document.getElementById('source');
  const statusEl = document.getElementById('status');
  const videoEl = document.getElementById('player');
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
    videoEl.src = url;
    videoEl.load();
    void tryPlay();
  }

  function fallbackToDirectIfAvailable(reason) {
    if (!fallbackUrl || usingFallback) {
      setStatus(reason, 'error');
      return false;
    }
    usingFallback = true;
    setSourceLabel();
    setStatus(`HLS unavailable (${reason}). Using fallback source.`, 'warn');
    useDirectVideoUrl(fallbackUrl);
    return true;
  }

  function loadCurrentSource() {
    const url = getCurrentUrl();
    if (!url) {
      setStatus('No source URL available for playback.', 'error');
      return;
    }

    setSourceLabel();

    const hlsCandidate = declaredType === 'hls' || isHlsUrl(url);
    if (!hlsCandidate) {
      setStatus('Playing direct media source.', 'ok');
      useDirectVideoUrl(url);
      return;
    }

    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      setStatus('Using native HLS playback.', 'ok');
      useDirectVideoUrl(url);
      return;
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
    });

    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(url);
    });

    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      setStatus('Streaming HLS manifest.', 'ok');
      void tryPlay();
    });

    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (!data || !data.fatal) return;
      const reason = data.details || data.type || 'unknown HLS error';
      const responseCode = Number(data.response && data.response.code || 0);
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
      loadCurrentSource();
    });

    videoEl.addEventListener('error', () => {
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
  });
})();
