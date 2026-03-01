/**
 * FetchV Media Detector
 *
 * Hooks fetch and XMLHttpRequest APIs to detect media files by analyzing
 * response headers, content types, and file extensions. This replaces the
 * deprecated chrome.webRequest API for Manifest V3 compliance.
 */

(function() {
  'use strict';

  // Media detection patterns
  const MEDIA_EXTENSIONS = /\.(m3u8|mpd|mp4|webm|mkv|avi|mov|flv|ts|m4s)(\?.*)?$/i;
  const MEDIA_CONTENT_TYPES = /^(video|audio|application\/(x-mpegURL|vnd\.apple\.mpegURL|dash\+xml))/i;

  // Minimum file size to consider (avoid tiny files like favicons)
  const MIN_MEDIA_SIZE = 1024 * 100; // 100KB

  // Track detected media to avoid duplicates
  const detectedMedia = new Set();

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

      // Check URL extension
      const hasMediaExtension = MEDIA_EXTENSIONS.test(url);

      // Check Content-Type header
      const contentType = headers['content-type'] || '';
      const hasMediaContentType = MEDIA_CONTENT_TYPES.test(contentType);

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

      // Extract filename from Content-Disposition
      const contentDisposition = headers['content-disposition'] || '';
      let filename = '';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1].replace(/['"]/g, '').trim();
        }
      }

      // If no filename from header, extract from URL
      if (!filename) {
        try {
          const urlObj = new URL(url);
          const pathname = urlObj.pathname;
          const pathParts = pathname.split('/').filter(p => p.length > 0);
          if (pathParts.length > 0) {
            filename = pathParts[pathParts.length - 1];
            // Remove query params from filename
            filename = filename.split('?')[0];
          }
        } catch (e) {
          // URL parsing failed, use fallback
          filename = 'media';
        }
      }

      // Create unique key for deduplication
      const uniqueKey = `${url}|${contentLength}`;
      if (detectedMedia.has(uniqueKey)) {
        return null; // Already detected
      }
      detectedMedia.add(uniqueKey);

      return {
        url,
        contentType,
        contentLength,
        filename,
        detectedAt: Date.now(),
        method: 'unknown' // Will be set by caller
      };
    } catch (error) {
      console.error('[FetchV MediaDetector] Error analyzing response:', error);
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
      console.error('[FetchV MediaDetector] Error sending detection message:', error);
    }
  }

  // ===================================================================
  // FETCH API HOOKING
  // ===================================================================

  const originalFetch = window.fetch;

  window.fetch = function(...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request.url;
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
        console.error('[FetchV MediaDetector] Error processing fetch response:', error);
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
        console.error('[FetchV MediaDetector] Error processing XHR response:', error);
      }
    });

    return originalXHRSend.apply(this, args);
  };

  // ===================================================================
  // INITIALIZATION
  // ===================================================================

  console.log('[FetchV] Media detection hooks installed');

  // Optional: Clean up detected media set periodically to prevent memory leaks
  setInterval(() => {
    const now = Date.now();
    const RETENTION_TIME = 60 * 60 * 1000; // 1 hour

    // Note: Set doesn't have a direct way to filter, so we recreate it
    // This is a simplification - in production, you might want to use a Map
    // with timestamps instead
    if (detectedMedia.size > 1000) {
      detectedMedia.clear();
      console.log('[FetchV MediaDetector] Cleared detection cache (size limit reached)');
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

})();
