/**
 * VidSnag Media Detector
 *
 * Hooks fetch and XMLHttpRequest APIs to detect media files by analyzing
 * response headers, content types, and file extensions. This replaces the
 * deprecated chrome.webRequest API for Manifest V3 compliance.
 */

(function() {
  'use strict';

  // Media detection patterns
  const MEDIA_EXTENSIONS = /\.(m3u8|m3u|mpd|mp4|m4v|webm|mkv|avi|mov|flv|f4v|wmv|asf|ts|m2ts|mts|m4s|mpg|mpeg|3gp|3g2|ogv|ogm|mxf|ism|ismc|m4a|aac|mp3|ogg|oga|wav|flac)(\?.*)?$/i;
  const MEDIA_CONTENT_TYPES = /^(video\/|audio\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml))/i;
  const HLS_MARKERS = /(\.m3u8(\?|$)|application\/x-mpegurl|application\/vnd\.apple\.mpegurl)/i;
  const DASH_MARKERS = /(\.mpd(\?|$)|application\/dash\+xml|application\/vnd\.ms-sstr\+xml)/i;
  const SEGMENT_MARKERS = /(\.(ts|m4s|m4f|cmfa|cmfv)(\?|$)|video\/mp2t)/i;
  const AUDIO_MARKERS = /(\.(m4a|aac|mp3|ogg|oga|wav|flac)(\?|$)|^audio\/)/i;

  // Minimum file size to consider (avoid tiny files like favicons)
  const MIN_MEDIA_SIZE = 1024 * 100; // 100KB

  // Track detected media to avoid duplicates
  const detectedMedia = new Set();

  function extractFilename(url, contentDisposition) {
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch && filenameMatch[1]) {
        return filenameMatch[1].replace(/['"]/g, '').trim();
      }
    }

    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const pathParts = pathname.split('/').filter((part) => part.length > 0);
      if (pathParts.length > 0) {
        const finalPart = pathParts[pathParts.length - 1];
        return decodeURIComponent(finalPart.split('?')[0]);
      }
    } catch (_) {
      // ignore URL parsing errors
    }

    return 'media';
  }

  function detectMediaKind(url, contentType, filename) {
    const target = `${String(url || '')} ${String(filename || '')} ${String(contentType || '').toLowerCase()}`;
    if (HLS_MARKERS.test(target)) return 'hls-manifest';
    if (DASH_MARKERS.test(target)) return 'dash-manifest';
    if (SEGMENT_MARKERS.test(target)) return 'segment';
    if (AUDIO_MARKERS.test(target)) return 'audio';
    return 'video';
  }

  function hasKnownMediaExtension(value) {
    return MEDIA_EXTENSIONS.test(String(value || '').toLowerCase());
  }

  /**
   * Analyze a response to determine if it's a media file
   * @param {string} url - Request URL
   * @param {Object} headers - Response headers (lowercase keys)
   * @param {number} statusCode - HTTP status code
   * @returns {Object|null} Media info object or null if not media
   */
  function analyzeResponse(url, headers, statusCode) {
    try {
      // Only process successful responses
      if (statusCode < 200 || statusCode >= 300) {
        return null;
      }

      const contentDisposition = headers['content-disposition'] || '';
      const filename = extractFilename(url, contentDisposition);
      const hasMediaExtension = hasKnownMediaExtension(url) || hasKnownMediaExtension(filename);

      // Check Content-Type header
      const contentType = headers['content-type'] || '';
      const hasMediaContentType = MEDIA_CONTENT_TYPES.test(contentType);
      const matchedBy = [];
      if (hasKnownMediaExtension(url)) matchedBy.push('url-extension');
      if (hasKnownMediaExtension(filename) && !matchedBy.includes('url-extension')) {
        matchedBy.push('content-disposition');
      }
      if (hasMediaContentType) matchedBy.push('content-type');

      // Check Content-Length
      const contentLength = parseInt(headers['content-length'] || '0', 10);
      const isSufficientSize = contentLength >= MIN_MEDIA_SIZE || contentLength === 0; // 0 means unknown/streaming

      // Only proceed if it looks like media
      if (!hasMediaExtension && !hasMediaContentType) {
        return null;
      }

      // Skip if file is too small (unless size is unknown)
      if (contentLength > 0 && !isSufficientSize) {
        return null;
      }

      // Create unique key for deduplication
      const uniqueKey = `${url}|${contentLength}`;
      if (detectedMedia.has(uniqueKey)) {
        return null; // Already detected
      }
      detectedMedia.add(uniqueKey);

      return {
        url,
        statusCode,
        contentType,
        contentLength,
        contentDisposition,
        filename,
        detectedAt: Date.now(),
        method: 'unknown', // Will be set by caller
        mediaKind: detectMediaKind(url, contentType, filename),
        matchedBy,
      };
    } catch (error) {
      console.error('[VidSnag MediaDetector] Error analyzing response:', error);
      return null;
    }
  }

  /**
   * Send detected media to content script
   * @param {Object} mediaInfo - Media information object
   */
  function notifyMediaDetected(mediaInfo) {
    try {
      window.postMessage({
        source: 'fetchv-page-detector',
        cmd: 'MEDIA_DETECTED',
        data: mediaInfo
      }, '*');
    } catch (error) {
      console.error('[VidSnag MediaDetector] Error sending detection message:', error);
    }
  }

  // ===================================================================
  // FETCH API HOOKING
  // ===================================================================

  const originalFetch = window.fetch;

  function resolveRequestUrl(request) {
    if (typeof request === 'string') return request;
    if (request instanceof URL) return request.toString();
    if (request && typeof request.url === 'string') return request.url;
    if (request && typeof request.href === 'string') return request.href;
    return '';
  }

  window.fetch = function(...args) {
    const request = args[0];
    const url = resolveRequestUrl(request);
    const options = args[1] || {};

    // Capture request headers
    const requestHeaders = {};

    // Add common browser headers
    requestHeaders['User-Agent'] = navigator.userAgent;
    requestHeaders['Referer'] = window.location.href;
    requestHeaders['Origin'] = window.location.origin;

    // Extract headers from options or Request object
    if (typeof request === 'object' && request.headers) {
      // Request object
      if (typeof request.headers.forEach === 'function') {
        request.headers.forEach((value, key) => {
          requestHeaders[key] = value;
        });
      } else if (typeof request.headers === 'object') {
        Object.assign(requestHeaders, request.headers);
      }
    } else if (options.headers) {
      // Options object
      if (typeof options.headers.forEach === 'function') {
        options.headers.forEach((value, key) => {
          requestHeaders[key] = value;
        });
      } else if (typeof options.headers === 'object') {
        Object.assign(requestHeaders, options.headers);
      }
    }

    return originalFetch.apply(this, args).then(response => {
      try {
        // Clone response to avoid consuming body
        const clonedResponse = response.clone();

        // Extract response headers
        const responseHeaders = {};
        clonedResponse.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });

        // Analyze for media
        const mediaInfo = analyzeResponse(url, responseHeaders, clonedResponse.status);
        if (mediaInfo) {
          mediaInfo.method = 'fetch';
          mediaInfo.requestHeaders = requestHeaders; // Include request headers
          notifyMediaDetected(mediaInfo);
        }
      } catch (error) {
        // Non-critical error, don't break the fetch
        console.error('[VidSnag MediaDetector] Error processing fetch response:', error);
      }

      return response;
    }).catch(error => {
      // Pass through fetch errors
      throw error;
    });
  };

  // ===================================================================
  // XMLHttpRequest HOOKING
  // ===================================================================

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  // WeakMap to store request data per XHR instance
  const xhrRequestData = new WeakMap();

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    // Store request method, URL, and initialize headers
    xhrRequestData.set(this, {
      method,
      url,
      requestHeaders: {
        'User-Agent': navigator.userAgent,
        'Referer': window.location.href,
        'Origin': window.location.origin
      }
    });
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const requestData = xhrRequestData.get(this);
    if (requestData && requestData.requestHeaders) {
      requestData.requestHeaders[name] = value;
    }
    return originalXHRSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const requestData = xhrRequestData.get(this);

    // Add load event listener to detect successful responses
    this.addEventListener('load', function() {
      try {
        if (this.status >= 200 && this.status < 300 && requestData) {
          // Extract response headers
          const responseHeaders = {};
          const rawHeaders = this.getAllResponseHeaders();
          if (rawHeaders) {
            const headerLines = rawHeaders.split('\r\n');
            headerLines.forEach(line => {
              const parts = line.split(': ');
              if (parts.length >= 2) {
                const key = parts[0].toLowerCase();
                const value = parts.slice(1).join(': '); // Handle colons in value
                responseHeaders[key] = value;
              }
            });
          }

          // Analyze for media
          const mediaInfo = analyzeResponse(requestData.url, responseHeaders, this.status);
          if (mediaInfo) {
            mediaInfo.method = 'xhr';
            mediaInfo.requestHeaders = requestData.requestHeaders; // Include request headers
            notifyMediaDetected(mediaInfo);
          }
        }
      } catch (error) {
        // Non-critical error, don't break the XHR
        console.error('[VidSnag MediaDetector] Error processing XHR response:', error);
      }
    });

    return originalXHRSend.apply(this, args);
  };

  // ===================================================================
  // INITIALIZATION
  // ===================================================================

  console.log('[VidSnag] Media detection hooks installed');

  // Optional: Clean up detected media set periodically to prevent memory leaks
  setInterval(() => {
    const now = Date.now();
    const RETENTION_TIME = 60 * 60 * 1000; // 1 hour

    // Note: Set doesn't have a direct way to filter, so we recreate it
    // This is a simplification - in production, you might want to use a Map
    // with timestamps instead
    if (detectedMedia.size > 1000) {
      detectedMedia.clear();
      console.log('[VidSnag MediaDetector] Cleared detection cache (size limit reached)');
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

})();
