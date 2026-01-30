import { createHistoryController } from './ui-history.js';
import { createQueueController } from './ui-queue.js';
import { createSegmentController } from './ui-segments.js';
import { createThreadController } from './ui-threads.js';
import { createThumbnailController } from './ui-thumbnails.js';
import { formatBytes, formatHistoryDate, formatTime } from './ui-format.js';
import { loadSettings, saveSettings, initSettingsUI } from './ui-settings.js';
import { createStatsController } from './ui-stats.js';
import { createPollingController } from './ui-polling.js';
import { createPlaybackController } from './ui-playback.js';

export function initUI() {
  const settingsPanel = document.getElementById('settingsPanel');
  const settingsToggle = document.getElementById('settingsToggle');
  const closeSettings = document.getElementById('closeSettings');

  function toggleSettings(open) {
    const shouldOpen = typeof open === 'boolean' ? open : settingsPanel.classList.contains('hidden');
    settingsPanel.classList.toggle('hidden', !shouldOpen);
  }

  settingsToggle.addEventListener('click', () => toggleSettings());
  closeSettings.addEventListener('click', () => toggleSettings(false));

  const savedSettings = loadSettings();
  const threadButtons = document.querySelectorAll('.thread-buttons .chip-button');
  const statusMessage = document.getElementById('statusMessage');
  const fileThumbnailWrapper = document.getElementById('fileThumbnailWrapper');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const downloadFileBtn = document.getElementById('downloadFileBtn');
  const autoSaveToggle = document.getElementById('autoSaveToggle');
  const clearCacheToggle = document.getElementById('clearCacheToggle');
  const tabProgressToggle = document.getElementById('tabProgressToggle');
  const resolutionSelect = document.getElementById('resolutionSelect');
  const resolutionDefaultToggle = document.getElementById('resolutionDefaultToggle');
  const fileNamingRadios = document.querySelectorAll('input[name="fileNaming"]');
  const fileNameInput = document.getElementById('fileNameInput');
  const segmentStatus = document.getElementById('segmentStatus');
  const sizeStatus = document.getElementById('sizeStatus');
  const speedStatus = document.getElementById('speedStatus');
  const threadStatusList = document.getElementById('threadStatusList');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressBarText = document.getElementById('progressBarText');
  const threadToggleBtn = document.getElementById('threadToggleBtn');
  const threadStatus = document.getElementById('threadStatus');
  const etaStatus = document.getElementById('etaStatus');
  const statusIcon = document.getElementById('statusIcon');
  const statsToggleBtn = document.getElementById('statsToggleBtn');
  const statsPanel = document.getElementById('statsPanel');
  const retryAttemptsSelect = document.getElementById('retryAttemptsSelect');
  const avgSpeed = document.getElementById('avgSpeed');
  const peakSpeed = document.getElementById('peakSpeed');
  const timeElapsed = document.getElementById('timeElapsed');
  const failedCount = document.getElementById('failedCount');
  const retryCount = document.getElementById('retryCount');
  const segmentVisualization = document.getElementById('segmentVisualization');
  const segmentGrid = document.getElementById('segmentGrid');
  const segmentVizToggleBtn = document.getElementById('segmentVizToggleBtn');
  const openSourceTab = document.getElementById('openSourceTab');
  const historyToggleBtn = document.getElementById('historyToggleBtn');
  const historyPanel = document.getElementById('historyPanel');
  const historyList = document.getElementById('historyList');
  const historyEmpty = document.getElementById('historyEmpty');
  const historyClearAll = document.getElementById('historyClearAll');
  const historyPlayer = document.getElementById('historyPlayer');
  const historyVideo = document.getElementById('historyVideo');
  const historyPlayerClose = document.getElementById('historyPlayerClose');

  const getEffectiveStatus = (job) => {
    if (!job) return 'idle';
    return job.status || job.queueStatus || 'idle';
  };

  const setControlStates = (status = 'idle') => {
    const isActive = status === 'downloading' || status === 'fetching-playlist';
    const isStartable = status === 'queued' || status === 'paused' || status === 'pending' || status === 'idle';

    if (playPauseBtn) {
      const playEnabled = isActive || isStartable;
      playPauseBtn.disabled = !playEnabled;
      playPauseBtn.classList.toggle('is-disabled', !playEnabled);
      playPauseBtn.textContent = isActive ? '❚❚' : '▶';
    }

    if (stopBtn) {
      const stopEnabled = isActive;
      stopBtn.disabled = !stopEnabled;
      stopBtn.classList.toggle('is-disabled', !stopEnabled);
    }
  };

  if (playPauseBtn) playPauseBtn.classList.remove('hidden');
  if (stopBtn) stopBtn.classList.remove('hidden');
  setControlStates('idle');
  const appRoot = document.querySelector('.app-root');
  const backgroundSlideshow = document.getElementById('backgroundSlideshow');
  const fileTypeLabel = document.getElementById('fileTypeLabel');
  const taskBanner = document.getElementById('taskBanner');
  const sidePanel = document.getElementById('sidePanel');
  const sidePanelHandle = document.getElementById('sidePanelHandle');
  const sidePanelClose = document.getElementById('sidePanelClose');
  const queueTabBtn = document.getElementById('queueTabBtn');
  const historyTabBtn = document.getElementById('historyTabBtn');
  const queuePanel = document.getElementById('queuePanel');
  const queueList = document.getElementById('queueList');
  const queueCount = document.getElementById('queueCount');
  const queueActive = document.getElementById('queueActive');
  const queueStartAll = document.getElementById('queueStartAll');
  const queuePauseAll = document.getElementById('queuePauseAll');
  const queueClearCompleted = document.getElementById('queueClearCompleted');
  const queueMaxConcurrent = document.getElementById('queueMaxConcurrent');
  const queueAutoStart = document.getElementById('queueAutoStart');

  let isPlaying = false;
  let lastTask = null;
  let activeJobId = null;
  let pollWithFullSnapshotOnce = false;
  let selectedThreads = null;
  const baseTitle = document.title || 'Local HLS Downloader';
  let threadsVisible = true;
  let statsVisible = false;
  let segmentVizVisible = false;
  let sourceTabUrl = null;
  let ws = null;
  let wsConnected = false;
  let wsSupported = typeof WebSocket !== 'undefined';

  const ENABLE_PERF_LOGGING = false;
  const JOB_ID_STORAGE_KEY = 'localDownloaderLastJobId';
  const DISPLAY_STATE_KEY = 'localDownloaderDisplayState';

  async function renameActiveQueueJob(newTitle) {
    const trimmed = (newTitle || '').trim();
    const jobId = activeJobId || (lastTask && lastTask.id);
    if (!jobId || !trimmed) return;

    try {
      const resp = await fetch(`/api/queue/${jobId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        statusMessage.textContent = `Failed to rename: ${txt || resp.status}`;
        return;
      }
      if (lastTask && lastTask.id === jobId) {
        lastTask = { ...lastTask, title: trimmed };
      }
      if (typeof loadQueueOnce === 'function') {
        try {
          await loadQueueOnce();
        } catch (e) {
          console.warn('[LocalUI] Failed to refresh queue after rename', e);
        }
      }
      statusMessage.textContent = 'Filename updated.';
    } catch (err) {
      console.warn('[LocalUI] Rename request failed', err);
      statusMessage.textContent = 'Failed to rename file.';
    }
  }

  if (fileNameInput) {
    const commitRename = () => renameActiveQueueJob(fileNameInput.value);
    fileNameInput.addEventListener('blur', commitRename);
    fileNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename();
      }
    });
  }

  const historyController = createHistoryController({
    historyList,
    historyEmpty,
    historyPanel,
    historyToggleBtn,
    historyClearAll,
    historyPlayer,
    historyVideo,
    historyPlayerClose,
    statusMessage,
    formatBytes,
    formatHistoryDate,
  });
  const { initHistory, hideHistoryView, loadHistoryOnce } = historyController;
  initHistory();

  async function selectJobFromQueue(jobId) {
    if (!jobId) return;

    // Fetch latest job snapshot and bind it to the main view
    try {
      const res = await fetch(`/api/jobs/${jobId}?full=1`);
      if (!res.ok) {
        statusMessage.textContent = 'Unable to load job details from queue.';
        return;
      }
      const job = await res.json();
      const effectiveStatus = getEffectiveStatus(job);

      // Update state and subscribe to updates
      activeJobId = jobId;
      try {
        localStorage.setItem(JOB_ID_STORAGE_KEY, jobId);
      } catch {}
      setLastTaskAndUI(job, { showBanner: false });
      isPlaying = effectiveStatus === 'downloading' || effectiveStatus === 'fetching-playlist';
      ensureWebSocket(jobId);
      handleJobUpdate(job);
      startPolling();
      setControlStates(effectiveStatus);
      statusMessage.textContent = 'Job focused from queue.';
      if (typeof requestFullSnapshot === 'function') {
        requestFullSnapshot();
      }
    } catch (err) {
      console.warn('[LocalUI] Failed to select job from queue', err);
      statusMessage.textContent = 'Failed to focus job from queue.';
    }
  }

  const queueController = createQueueController({
    sidePanel,
    sidePanelHandle,
    sidePanelClose,
    queueTabBtn,
    historyTabBtn,
    queuePanel,
    historyPanel,
    queueList,
    queueCount,
    queueActive,
    queueStartAll,
    queuePauseAll,
    queueClearCompleted,
    queueMaxConcurrent,
    queueAutoStart,
    queueSelectJob: selectJobFromQueue,
    formatBytes,
    statusMessage,
    loadHistoryOnce,
  });
  const { initQueue, loadQueueOnce, toggleSidePanel, switchTab } = queueController;
  initQueue();

  const segmentController = createSegmentController({
    segmentGrid,
    ENABLE_PERF_LOGGING,
  });
  const { initSegmentGrid, applySegmentStates, resetSegments } = segmentController;

  const threadController = createThreadController({
    threadStatusList,
  });
  const { updateThreads } = threadController;

  const thumbnailController = createThumbnailController({
    fileThumbnailWrapper,
    backgroundSlideshow,
  });
  const { updateFromJob: updateThumbnailsFromJob, resetThumbnails } = thumbnailController;

  const statsController = createStatsController({
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
    initializeSegmentGrid: initSegmentGrid,
    applySegmentStates,
    threadStatusList,
    updateThreads,
  });
  const { resetStatistics, applyJobUpdate } = statsController;

  function loadDisplayState() {
    try {
      const raw = localStorage.getItem(DISPLAY_STATE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveDisplayState(state) {
    try {
      const current = loadDisplayState();
      const next = Object.assign({}, current, state);
      localStorage.setItem(DISPLAY_STATE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage errors
    }
  }

  const initialDisplayState = loadDisplayState();
  if (typeof initialDisplayState.threadsVisible === 'boolean') {
    threadsVisible = initialDisplayState.threadsVisible;
  }
  if (typeof initialDisplayState.statsVisible === 'boolean') {
    statsVisible = initialDisplayState.statsVisible;
  }
  if (typeof initialDisplayState.segmentVizVisible === 'boolean') {
    segmentVizVisible = initialDisplayState.segmentVizVisible;
  }

  if (threadStatus) {
    threadStatus.classList.toggle('hidden', !threadsVisible);
  }
  if (threadToggleBtn) {
    threadToggleBtn.classList.toggle('active', !!threadsVisible);
  }
  if (statsPanel) {
    statsPanel.classList.toggle('hidden', !statsVisible);
  }
  if (statsToggleBtn) {
    statsToggleBtn.classList.toggle('active', !!statsVisible);
  }
  if (segmentVisualization) {
    segmentVisualization.classList.toggle('hidden', !segmentVizVisible);
  }
  if (segmentVizToggleBtn) {
    segmentVizToggleBtn.classList.toggle('active', !!segmentVizVisible);
  }

  initSettingsUI({
    threadButtons,
    autoSaveToggle,
    clearCacheToggle,
    tabProgressToggle,
    retryAttemptsSelect,
    resolutionSelect,
    resolutionDefaultToggle,
    fileNamingRadios,
    statusMessage,
    savedSettings,
    onThreadsChange: (threads) => {
      selectedThreads = threads;
      console.log('[LocalUI] Selected threads set to', threads);
    },
  });

  function updateFileTypeLabelForTask() {
    if (!fileTypeLabel) return;

    const task = lastTask;
    if (!task) {
      fileTypeLabel.textContent = '';
      fileTypeLabel.classList.remove('is-mp4', 'is-m3u8', 'is-ts', 'is-ts-part', 'is-unknown');
      return;
    }

    const displayName = task.fileName || task.title || task.name || '';
    const url = task.url || '';

    let sourceForExt = displayName || url;
    let type = 'unknown';
    let ext = '';

    if (typeof sourceForExt === 'string' && sourceForExt.includes('.')) {
      const match = sourceForExt.toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
      if (match && match[1]) {
        ext = match[1];
      }
    }

    if (ext === 'mp4') type = 'mp4';
    else if (ext === 'm3u8') type = 'm3u8';
    else if (ext === 'ts') type = 'ts';

    if (type === 'unknown' && typeof url === 'string') {
      const lowerUrl = url.toLowerCase();
      if (/\.m3u8(\?|#|$)/.test(lowerUrl)) {
        type = 'm3u8';
      } else if (/\.mp4(\?|#|$)/.test(lowerUrl)) {
        type = 'mp4';
      } else if (/\.ts(\?|#|$)/.test(lowerUrl)) {
        type = 'ts';
      }
    }

    fileTypeLabel.classList.remove('is-mp4', 'is-m3u8', 'is-ts', 'is-ts-part', 'is-unknown');

    switch (type) {
      case 'mp4':
        fileTypeLabel.textContent = 'MP4';
        fileTypeLabel.classList.add('is-mp4');
        break;
      case 'm3u8':
        fileTypeLabel.textContent = 'HLS';
        fileTypeLabel.classList.add('is-m3u8');
        break;
      case 'ts':
        fileTypeLabel.textContent = 'TS';
        fileTypeLabel.classList.add('is-ts');
        break;
      default:
        fileTypeLabel.textContent = ext ? ext.toUpperCase() + ' file' : '';
        fileTypeLabel.classList.add('is-unknown');
        break;
    }
  }

  function updateAppRootStatus(status) {
    if (!appRoot) return;

    appRoot.classList.remove(
      'status-downloading',
      'status-completed',
      'status-completed-with-errors',
      'status-error',
      'status-cancelled',
      'status-paused'
    );

    if (!status) return;

    appRoot.classList.add(`status-${status}`);
  }

  if (threadToggleBtn && threadStatus) {
    threadToggleBtn.addEventListener('click', () => {
      threadsVisible = !threadsVisible;
      threadStatus.classList.toggle('hidden', !threadsVisible);
      threadToggleBtn.classList.toggle('active', threadsVisible);
      saveDisplayState({ threadsVisible });
    });
  }

  if (statsToggleBtn && statsPanel) {
    statsToggleBtn.addEventListener('click', () => {
      statsVisible = !statsVisible;
      statsPanel.classList.toggle('hidden', !statsVisible);
      statsToggleBtn.classList.toggle('active', statsVisible);
      saveDisplayState({ statsVisible });
    });
  }

  if (segmentVizToggleBtn && segmentVisualization) {
    segmentVizToggleBtn.addEventListener('click', () => {
      segmentVizVisible = !segmentVizVisible;
      segmentVisualization.classList.toggle('hidden', !segmentVizVisible);
      segmentVizToggleBtn.classList.toggle('active', segmentVizVisible);
      saveDisplayState({ segmentVizVisible });
    });
  }

  function handleJobUpdate(job) {
    if (!job) return;

    const pollStart = ENABLE_PERF_LOGGING ? performance.now() : 0;

    // Auto-select currently downloading job so the left panel reflects it without manual click
    if (job.status === 'downloading' && activeJobId !== job.id) {
      activeJobId = job.id;
      setLastTaskAndUI(job);
      ensureWebSocket(job.id);
    }

    // If server exposes thumbnails for this job, show them in a slideshow.
    updateThumbnailsFromJob(job);

    // If we reconnected to an existing job (or the input is otherwise empty),
    // populate the file name field from the server-side job metadata so the
    // correct title is visible in the UI.
    if (fileNameInput && (!fileNameInput.value || fileNameInput.value.trim() === '')) {
      if (job && typeof job.title === 'string' && job.title.trim()) {
        fileNameInput.value = job.title.trim();
      }
    }

    if (ENABLE_PERF_LOGGING && pollStart) {
      const pollDuration = performance.now() - pollStart;
      const changedCount = job.segmentStatesCount || 0;
      const totalSegs = job.totalSegments || 0;

      if (pollDuration > 100) {
        console.warn(`[PERF] Slow job update handling: ${pollDuration.toFixed(2)}ms`);
      }

      if (changedCount > 0 && totalSegs > 0) {
        const percentChanged = ((changedCount / totalSegs) * 100).toFixed(1);
        console.log(`[PERF] Delta update: ${changedCount}/${totalSegs} segments (${percentChanged}%) changed`);
      }
    }

    // Update all statistics, progress bars, heatmap, and thread retry counts via stats controller.
    applyJobUpdate(job);

    const effectiveStatus = getEffectiveStatus(job);
    const jobFailedCount = typeof job.failedSegments === 'number' ? job.failedSegments : 0;
    const parts = [`Status: ${effectiveStatus}`];
    if (typeof job.progress === 'number') {
      parts.push(`${job.progress}%`);
    }
    if (jobFailedCount > 0) {
      parts.push(`skipped segments: ${jobFailedCount}`);
    }
    if (job.error) {
      parts.push(`error: ${job.error}`);
    }
    statusMessage.textContent = parts.join(' – ');
    updateStatusIcon(effectiveStatus);
    updateAppRootStatus(effectiveStatus);

    setControlStates(effectiveStatus);

    if (effectiveStatus === 'completed' || effectiveStatus === 'completed-with-errors') {
      stopPolling();
      isPlaying = false;
      playPauseBtn.classList.remove('hidden');
      stopBtn?.classList.remove('hidden');
      setControlStates('idle');
      document.title = baseTitle;

      const jobId = activeJobId; // capture stable id before we clear it
      let storedJobId = null;
      try {
        storedJobId = localStorage.getItem(JOB_ID_STORAGE_KEY);
      } catch {}
      const canAutoDownload = !!jobId && storedJobId === jobId;
      const doDownload = () => {
        if (!jobId) return;
        const link = document.createElement('a');
        link.href = `/api/jobs/${jobId}/file`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      };

      const autoSaveEnabled = autoSaveToggle ? autoSaveToggle.checked : true;

      if (autoSaveEnabled && canAutoDownload) {
        doDownload();
        statusMessage.textContent =
          job.status === 'completed'
            ? 'Download complete (served from local Node engine).'
            : 'Download complete with some skipped segments (served from local Node engine).';
      } else if (downloadFileBtn) {
        downloadFileBtn.classList.remove('hidden');
        downloadFileBtn.onclick = () => {
          doDownload();
          downloadFileBtn.classList.add('hidden');
        };
        statusMessage.textContent =
          job.status === 'completed'
            ? 'Download ready. Click "Download File" to save.'
            : 'Download with skipped segments ready. Click "Download File" to save.';
      }

      activeJobId = null;
      try {
        localStorage.removeItem(JOB_ID_STORAGE_KEY);
      } catch {}
    } else if (effectiveStatus === 'error' || effectiveStatus === 'cancelled') {
      stopPolling();
      isPlaying = false;
      playPauseBtn.classList.remove('hidden');
      stopBtn?.classList.remove('hidden');
      setControlStates('idle');
      document.title = baseTitle;
      updateStatusIcon(effectiveStatus);
      updateAppRootStatus(effectiveStatus);
      if (etaStatus) etaStatus.textContent = 'ETA: Complete';
      activeJobId = null;
      try {
        localStorage.removeItem(JOB_ID_STORAGE_KEY);
      } catch {}
    }
  }

  function updateStatusIcon(status) {
    if (!statusIcon) return;
    statusIcon.className = 'status-icon';
    switch (status) {
      case 'downloading':
        statusIcon.textContent = '⬇';
        statusIcon.classList.add('downloading');
        break;
      case 'completed':
      case 'completed-with-errors':
        statusIcon.textContent = '✓';
        statusIcon.classList.add('completed');
        break;
      case 'error':
      case 'cancelled':
        statusIcon.textContent = '✕';
        statusIcon.classList.add('error');
        break;
      case 'paused':
        statusIcon.textContent = '⏸';
        statusIcon.classList.add('paused');
        break;
      default:
        statusIcon.textContent = '⏸';
        statusIcon.classList.add('paused');
    }
  }

  async function pollJobOnce() {
    if (!activeJobId) return;
    // If WebSocket is supported and connected, prefer it over HTTP polling.
    if (wsSupported && wsConnected) {
      return;
    }

    try {
      const url = pollWithFullSnapshotOnce
        ? `/api/jobs/${activeJobId}?full=1`
        : `/api/jobs/${activeJobId}`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          activeJobId = null;
          isPlaying = false;
          playPauseBtn.textContent = '▶';
          setControlStates('idle');
          document.title = baseTitle;
          updateStatusIcon('paused');
          statusMessage.textContent = 'Previous job not found on server. Start a new download.';
          try {
            localStorage.removeItem(JOB_ID_STORAGE_KEY);
          } catch {}
          stopPolling();
        }
        return;
      }
      const job = await res.json();
      handleJobUpdate(job);

      if (pollWithFullSnapshotOnce) {
        pollWithFullSnapshotOnce = false;
      }
    } catch (err) {
      console.warn('[LocalUI] Failed to poll job', err);
    }
  }

  const pollingController = createPollingController({
    pollFn: pollJobOnce,
    intervalMs: 1000,
  });

  function startPolling() {
    // Only start HTTP polling when WebSockets are not available.
    if (wsSupported && wsConnected) {
      return;
    }
    pollingController.startPolling();
  }

  function stopPolling() {
    pollingController.stopPolling();
  }

  function ensureWebSocket(jobId) {
    if (!wsSupported || !jobId) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        console.warn('[LocalUI] Failed to create WebSocket, falling back to polling', err);
        wsSupported = false;
        startPolling();
        return;
      }

      ws.addEventListener('open', () => {
        wsConnected = true;
        console.log('[LocalUI] WebSocket connected for job updates');
        if (activeJobId) {
          ws.send(JSON.stringify({ type: 'subscribe', jobId: activeJobId }));
        }
        // With a healthy WebSocket, HTTP polling is no longer needed.
        stopPolling();
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.type === 'job:update' && msg.data) {
            handleJobUpdate(msg.data);
          }
        } catch (err) {
          console.warn('[LocalUI] Failed to parse WebSocket message', err);
        }
      });

      ws.addEventListener('close', () => {
        wsConnected = false;
        console.log('[LocalUI] WebSocket disconnected; falling back to polling');
        // When WebSocket disconnects, fall back to HTTP polling if we still
        // have an active job.
        if (activeJobId) {
          startPolling();
        }
      });

      ws.addEventListener('error', (err) => {
        wsConnected = false;
        console.warn('[LocalUI] WebSocket error; falling back to polling', err);
        if (activeJobId) {
          startPolling();
        }
      });
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', jobId }));
    }
  }

  function setLastTaskAndUI(task, { showBanner = false } = {}) {
    lastTask = task;
    if (appRoot) {
      appRoot.classList.toggle('has-task', !!task);
    }
    if (taskBanner) {
      const shouldShow = !!task && !!showBanner;
      taskBanner.classList.toggle('hidden', !shouldShow);
    }
  }

  const playbackController = createPlaybackController({
    getLastTask: () => lastTask,
    setLastTask: (task) => {
      setLastTaskAndUI(task, { showBanner: false });
    },
    getSelectedThreads: () => selectedThreads || 1,
    getActiveJobId: () => activeJobId,
    setActiveJobId: (id) => {
      activeJobId = id;
      if (activeJobId) {
        ensureWebSocket(activeJobId);
      }
    },
    getIsPlaying: () => isPlaying,
    setIsPlaying: (value) => {
      isPlaying = !!value;
    },
    startPolling,
    stopPolling,
    resetStatistics,
    loadQueueOnce,
    updateStatusIcon,
    statusMessage,
    playPauseBtn,
    stopBtn,
    downloadFileBtn,
    fileNameInput,
    retryAttemptsSelect,
    etaStatus,
    savedSettings,
    JOB_ID_STORAGE_KEY,
    requestFullSnapshot: () => {
      pollWithFullSnapshotOnce = true;
    },
  });

  playbackController.attachPlaybackHandlers();

  // Listen for the initial task payload from the extension via window.postMessage
  // content.js posts the queue object using window.postMessage
  let lastReceivedTaskSignature = null;
  window.addEventListener('message', (event) => {
    // Only accept messages from the extension content script
    if (event.data && event.data.type === 'FETCHV_QUEUE_DATA' && event.data.source === 'fetchv-extension') {
      // console.log('[LocalUI] Received message from extension:', event.data);
      
      let payload = event.data.payload;
      if (!payload) {
        console.warn('[LocalUI] Received empty payload');
        statusMessage.textContent = 'No task data received from extension.';
        return;
      }

      // Deduplicate messages by checking URL and timestamp
      const taskSignature = payload && payload.url ? `${payload.url}-${payload.tabId || ''}` : null;
      if (taskSignature && taskSignature === lastReceivedTaskSignature) {
        console.log('[LocalUI] Ignoring duplicate task message');
        return;
      }
      lastReceivedTaskSignature = taskSignature;
      console.log('[LocalUI] Processing new task:', taskSignature);

      setLastTaskAndUI(payload, { showBanner: true });

      updateFileTypeLabelForTask();

      // Best-effort mapping: use common fields if present, fall back to URL.
      const nameFromTask =
        (payload && (payload.fileName || payload.title || payload.name)) ||
        (payload && payload.url) ||
        '';

      // Update the file name input
      if (fileNameInput && nameFromTask) {
        fileNameInput.value = nameFromTask;
      }

      // If a job is already active, show message to add to queue
      if (activeJobId) {
        statusMessage.textContent = 'New video detected. Edit name if needed, then click Play to add to queue.';
        // Highlight the play button to draw attention
        if (playPauseBtn) {
          playPauseBtn.style.animation = 'pulse 1s ease-in-out 3';
          setTimeout(() => {
            playPauseBtn.style.animation = '';
          }, 3000);
        }
      } else {
        // No active job, just load the task
        statusMessage.textContent = 'Task loaded from extension. Edit name if needed, then click Play to start.';
      }

      // Store source tab URL if available
      if (payload && (payload.sourceUrl || payload.tabUrl || payload.pageUrl)) {
        sourceTabUrl = payload.sourceUrl || payload.tabUrl || payload.pageUrl;
      }

      // If the task exposes segment / size information, surface it.
      if (payload && typeof payload.totalSegments === 'number') {
        const done = payload.finishedSegments || 0;
        const remaining = payload.totalSegments - done;
        segmentStatus.textContent = `${done}/${payload.totalSegments} (${remaining} left)`;
      }

      if (payload && typeof payload.totalSizeMB === 'number') {
        sizeStatus.textContent = `${payload.totalSizeMB.toFixed(1)} MB`;
      }

      // We generally won't have live speed here yet, so just reset it.
      speedStatus.textContent = '0 KB/s';
    }
  });

  if (!lastTask) {
    statusMessage.textContent = 'Waiting for task from extension (local UI ready).';
  }

  updateStatusIcon('paused');

  playbackController.restoreExistingJobIfAny();

  // History is loaded on demand when the History view is opened.

  // Open source tab button
  if (openSourceTab) {
    openSourceTab.addEventListener('click', () => {
      if (sourceTabUrl) {
        window.open(sourceTabUrl, '_blank');
      } else if (lastTask && lastTask.url) {
        // Fallback: try to extract domain from m3u8 URL
        try {
          const url = new URL(lastTask.url);
          const baseUrl = `${url.protocol}//${url.host}`;
          window.open(baseUrl, '_blank');
        } catch (err) {
          statusMessage.textContent = 'No source URL available to open.';
        }
      } else {
        statusMessage.textContent = 'No source URL available to open.';
      }
    });
  }
}

export default initUI;
