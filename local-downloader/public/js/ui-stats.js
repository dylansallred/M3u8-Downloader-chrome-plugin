// Statistics and progress handling for Local HLS Downloader UI
// Encapsulates speed/ETA/progress/segment/thread stats and related DOM updates.

export function createStatsController({
  segmentStatus,
  sizeStatus,
  speedStatus,
  avgSpeed,
  peakSpeed,
  timeElapsed,
  failedCount,
  retryCount,
  etaStatus,
  progressBarFill,
  progressBarText,
  segmentGrid,
  tabProgressToggle,
  baseTitle,
  formatTime,
  initializeSegmentGrid,
  applySegmentStates,
  threadStatusList,
  updateThreads,
}) {
  let downloadStartTime = null;
  let speedSamples = [];
  let maxSpeed = 0;
  let totalRetries = 0;
  let lastBytesSample = 0;
  let lastTimeSample = 0;

  function resetStatistics() {
    downloadStartTime = null;
    speedSamples = [];
    maxSpeed = 0;
    totalRetries = 0;
    lastBytesSample = 0;
    lastTimeSample = 0;
    if (avgSpeed) avgSpeed.textContent = '0 KB/s';
    if (peakSpeed) peakSpeed.textContent = '0 KB/s';
    if (timeElapsed) timeElapsed.textContent = '0s';
    if (failedCount) failedCount.textContent = '0';
    if (retryCount) retryCount.textContent = '0';
    if (etaStatus) etaStatus.textContent = 'ETA: --';
    if (progressBarText) progressBarText.textContent = '0%';
    if (segmentGrid) segmentGrid.innerHTML = '';
  }

  function applyJobUpdate(job) {
    if (!job) return;

    if (typeof job.totalSegments === 'number' && segmentStatus) {
      const done = job.completedSegments || 0;
      const remaining = job.totalSegments - done;
      segmentStatus.textContent = `${done}/${job.totalSegments} (${remaining} left)`;
    }

    if (typeof job.bytesDownloaded === 'number') {
      const mb = job.bytesDownloaded / (1024 * 1024);
      if (sizeStatus) {
        sizeStatus.textContent = `${mb.toFixed(1)} MB`;
      }

      const now = Date.now();
      if (lastTimeSample && now > lastTimeSample && job.bytesDownloaded >= lastBytesSample) {
        const deltaBytes = job.bytesDownloaded - lastBytesSample;
        const deltaSeconds = (now - lastTimeSample) / 1000;
        const kbps = deltaSeconds > 0 ? (deltaBytes / 1024) / deltaSeconds : 0;
        if (speedStatus) {
          speedStatus.textContent = `${kbps.toFixed(1)} KB/s`;
        }

        if (kbps > maxSpeed) {
          maxSpeed = kbps;
          if (peakSpeed) peakSpeed.textContent = `${kbps.toFixed(1)} KB/s`;
        }

        speedSamples.push(kbps);
        if (speedSamples.length > 30) speedSamples.shift();
        const avgKbps = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        if (avgSpeed) avgSpeed.textContent = `${avgKbps.toFixed(1)} KB/s`;

        if (etaStatus && job.totalSegments && job.completedSegments < job.totalSegments) {
          const remainingSegments = job.totalSegments - (job.completedSegments || 0);
          const avgBytesPerSegment = job.bytesDownloaded / (job.completedSegments || 1);
          const remainingBytes = remainingSegments * avgBytesPerSegment;
          const etaSeconds = avgKbps > 0 ? (remainingBytes / 1024) / avgKbps : 0;
          etaStatus.textContent = `ETA: ${formatTime(etaSeconds)}`;
        }
      }
      lastBytesSample = job.bytesDownloaded;
      lastTimeSample = now;
    }

    if (downloadStartTime && timeElapsed) {
      const elapsed = Math.floor((Date.now() - downloadStartTime) / 1000);
      timeElapsed.textContent = formatTime(elapsed);
    }

    const jobFailedCount = typeof job.failedSegments === 'number' ? job.failedSegments : 0;
    if (failedCount) {
      failedCount.textContent = String(jobFailedCount);
    }

    if (!downloadStartTime && job.status === 'downloading') {
      downloadStartTime = Date.now();
      if (job.totalSegments && typeof initializeSegmentGrid === 'function') {
        initializeSegmentGrid(job.totalSegments);
      }
    }

    // Tab Progress: show NN% in the tab title while downloading, if enabled.
    if (tabProgressToggle && tabProgressToggle.checked && job.status === 'downloading') {
      const pct = typeof job.progress === 'number' ? job.progress : 0;
      document.title = `${pct}% – ${baseTitle}`;
    } else if (document.title !== baseTitle && job.status !== 'downloading') {
      document.title = baseTitle;
    }

    // Update progress bar for the main job
    if (typeof job.progress === 'number') {
      if (progressBarFill) {
        const pct = Math.max(0, Math.min(100, job.progress));
        progressBarFill.style.width = `${pct}%`;
      }
      if (progressBarText) {
        progressBarText.textContent = `${job.progress}%`;
      }
    }

    // Update heatmap using segmentStates dictionary from server
    if (job.segmentStates && typeof job.segmentStates === 'object' && segmentGrid && typeof applySegmentStates === 'function') {
      applySegmentStates(job.segmentStates);
    }

    // Update thread stats / retries using controller and existing DOM
    if (job.threadStates && Array.isArray(job.threadStates)) {
      if (typeof updateThreads === 'function') {
        updateThreads(job.threadStates);
      }

      const currentRetries = job.threadStates.reduce((sum, t) => {
        return sum + (t && typeof t.attempt === 'number' && t.attempt > 1 ? t.attempt - 1 : 0);
      }, 0);
      if (currentRetries > totalRetries) {
        totalRetries = currentRetries;
        if (retryCount) retryCount.textContent = String(totalRetries);
      }
    }
  }

  return {
    resetStatistics,
    applyJobUpdate,
  };
}
