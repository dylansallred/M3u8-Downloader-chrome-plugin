// Segment heatmap / grid controller for Local HLS Downloader UI
// Encapsulates grid initialization and batched segment state updates.

export function createSegmentController({
  segmentGrid,
  ENABLE_PERF_LOGGING,
}) {
  const HEATMAP_UPDATE_THROTTLE = 150; // ms between heatmap updates (reduced UI load)

  let segmentStates = new Map();
  let pendingSegmentUpdates = new Map();
  let segmentUpdateScheduled = false;
  let lastHeatmapUpdate = 0;
  let segmentCellCache = [];
  let perfStats = { flushCount: 0, totalFlushTime: 0, maxFlushTime: 0 };

  function initSegmentGrid(totalSegments) {
    if (!segmentGrid || !totalSegments) return;
    segmentGrid.innerHTML = '';
    segmentStates.clear();
    segmentCellCache = [];

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < totalSegments; i++) {
      const cell = document.createElement('div');
      cell.className = 'segment-cell';
      cell.setAttribute('data-segment', i);
      cell.title = `Segment ${i}`;
      fragment.appendChild(cell);
      segmentCellCache[i] = cell;
      segmentStates.set(i, 'pending');
    }

    segmentGrid.appendChild(fragment);
  }

  function updateSegmentCell(index, state, attempt) {
    if (!segmentGrid) return;

    // Queue the update instead of applying immediately
    pendingSegmentUpdates.set(index, { state, attempt });

    if (!segmentUpdateScheduled) {
      segmentUpdateScheduled = true;
      requestAnimationFrame(flushSegmentUpdates);
    }
  }

  function flushSegmentUpdates() {
    const startTime = ENABLE_PERF_LOGGING ? performance.now() : 0;
    segmentUpdateScheduled = false;

    if (pendingSegmentUpdates.size === 0) return;

    const updateCount = pendingSegmentUpdates.size;

    for (const [index, { state, attempt }] of pendingSegmentUpdates) {
      const cell = segmentCellCache[index];
      if (!cell) continue;

      let className = 'segment-cell';
      let labelStatus = '';

      if (state === 'completed') {
        className += ' completed';
        segmentStates.set(index, 'completed');
        labelStatus = 'completed';
      } else if (state === 'failed') {
        className += ' failed';
        segmentStates.set(index, 'failed');
        labelStatus = 'failed';
      } else if (state === 'retrying') {
        className += ' retrying';
        const attemptNum = attempt || 1;
        if (attemptNum >= 2 && attemptNum <= 4) {
          className += ' retry-1';
        } else if (attemptNum >= 5 && attemptNum <= 7) {
          className += ' retry-2';
        } else if (attemptNum >= 8 && attemptNum <= 10) {
          className += ' retry-3';
        } else if (attemptNum >= 11 && attemptNum <= 14) {
          className += ' retry-4';
        } else if (attemptNum >= 15) {
          className += ' retry-5-plus';
        }
        segmentStates.set(index, `retrying-${attemptNum}`);
        labelStatus = 'retrying';
      } else if (state === 'downloading') {
        className += ' downloading';
        const attemptNum = attempt || 1;
        if (attemptNum >= 2 && attemptNum <= 4) {
          className += ' retry-1';
        } else if (attemptNum >= 5 && attemptNum <= 7) {
          className += ' retry-2';
        } else if (attemptNum >= 8 && attemptNum <= 10) {
          className += ' retry-3';
        } else if (attemptNum >= 11 && attemptNum <= 14) {
          className += ' retry-4';
        } else if (attemptNum >= 15) {
          className += ' retry-5-plus';
        }
        segmentStates.set(index, `downloading-${attemptNum}`);
        labelStatus = 'downloading';
      }

      cell.className = className;

      if (labelStatus) {
        const pending = pendingSegmentUpdates.get(index);
        const attemptNum = (pending && typeof pending.attempt === 'number' ? pending.attempt : 1) || 1;
        const attemptLabel = attemptNum > 1 ? ` – attempt ${attemptNum}` : '';
        cell.title = `Segment ${index} – ${labelStatus}${attemptLabel}`;
      }
    }

    pendingSegmentUpdates.clear();

    if (ENABLE_PERF_LOGGING) {
      const duration = performance.now() - startTime;
      perfStats.flushCount++;
      perfStats.totalFlushTime += duration;
      perfStats.maxFlushTime = Math.max(perfStats.maxFlushTime, duration);

      if (duration > 16) {
        console.warn(`[PERF] Slow heatmap flush: ${duration.toFixed(2)}ms for ${updateCount} updates`);
      }

      if (perfStats.flushCount % 50 === 0) {
        console.log(`[PERF] Heatmap stats: avg=${(perfStats.totalFlushTime / perfStats.flushCount).toFixed(2)}ms, max=${perfStats.maxFlushTime.toFixed(2)}ms, count=${perfStats.flushCount}`);
      }
    }
  }

  function applySegmentStates(jobSegmentStates) {
    const now = Date.now();
    if (!jobSegmentStates || !segmentGrid) return;

    if (now - lastHeatmapUpdate < HEATMAP_UPDATE_THROTTLE) {
      return;
    }

    const heatmapStart = ENABLE_PERF_LOGGING ? performance.now() : 0;
    lastHeatmapUpdate = now;

    let changedCount = 0;

    for (const indexStr in jobSegmentStates) {
      const segState = jobSegmentStates[indexStr];
      if (!segState) continue;

      const index = parseInt(indexStr, 10);
      if (Number.isNaN(index)) continue;

      const currentState = segmentStates.get(index);
      const newStatus = segState.status;
      const attempt = segState.attempt || 1;
      const newStateKey = `${newStatus}-${attempt}`;

      if (currentState !== newStateKey) {
        changedCount++;
        if (newStatus === 'completed') {
          updateSegmentCell(index, 'completed', attempt);
        } else if (newStatus === 'failed') {
          updateSegmentCell(index, 'failed', attempt);
        } else if (newStatus === 'retrying') {
          updateSegmentCell(index, 'retrying', attempt);
        } else if (newStatus === 'downloading') {
          updateSegmentCell(index, 'downloading', attempt);
        }
      }
    }

    if (ENABLE_PERF_LOGGING && heatmapStart) {
      const heatmapDuration = performance.now() - heatmapStart;
      if (heatmapDuration > 10) {
        console.warn(`[PERF] Slow heatmap processing: ${heatmapDuration.toFixed(2)}ms for ${changedCount} changes out of ${Object.keys(jobSegmentStates).length} total`);
      }
    }
  }

  function resetSegments() {
    segmentStates.clear();
    pendingSegmentUpdates.clear();
    segmentCellCache = [];
    segmentUpdateScheduled = false;
    lastHeatmapUpdate = 0;
  }

  return {
    initSegmentGrid,
    applySegmentStates,
    resetSegments,
  };
}

