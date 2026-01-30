// Polling control for Local HLS Downloader UI
// Encapsulates the timer that repeatedly calls a provided poll function.

export function createPollingController({ pollFn, intervalMs = 1000 }) {
  let pollTimer = null;

  function startPolling() {
    if (pollTimer || typeof pollFn !== 'function') return;
    pollTimer = setInterval(pollFn, intervalMs);
    console.log(`[LocalUI] Started polling at ${intervalMs}ms interval`);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function isPolling() {
    return !!pollTimer;
  }

  return {
    startPolling,
    stopPolling,
    isPolling,
  };
}
