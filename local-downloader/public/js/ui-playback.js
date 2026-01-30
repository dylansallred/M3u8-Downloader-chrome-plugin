// Playback and queue interaction controller for Local HLS Downloader UI
// Handles starting jobs, adding to the queue, and play/pause/stop wiring.

export function createPlaybackController({
  getLastTask,
  setLastTask,
  getSelectedThreads,
  getActiveJobId,
  setActiveJobId,
  getIsPlaying,
  setIsPlaying,
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
  requestFullSnapshot,
}) {
  async function startJobIfNeeded() {
    const lastTask = getLastTask();
    if (!lastTask) {
      statusMessage.textContent = 'No task loaded from extension yet.';
      return;
    }

    // If we already have this job in the queue (selected from side panel), start/resume it instead of adding
    try {
      const queueRes = await fetch('/api/queue');
      if (queueRes.ok) {
        const queueData = await queueRes.json();
        const queue = queueData.queue || [];

        if (lastTask.id) {
          const existingById = queue.find((job) => job.id === lastTask.id);
          if (existingById) {
            // If already downloading, just re-focus
            if (existingById.queueStatus === 'downloading' || existingById.queueStatus === 'fetching-playlist') {
              setActiveJobId(existingById.id);
              setIsPlaying(true);
              statusMessage.textContent = 'Resuming active download from queue.';
              updateStatusIcon('downloading');
              startPolling();
              return;
            }

            // If queued or paused, start it
            if (existingById.queueStatus === 'queued' || existingById.queueStatus === 'paused' || existingById.queueStatus === 'pending') {
              try {
                const startResp = await fetch(`/api/queue/${existingById.id}/start`, { method: 'POST' });
                if (!startResp.ok) {
                  const txt = await startResp.text();
                  statusMessage.textContent = `Failed to start job: ${txt || startResp.status}`;
                  return;
                }
                setActiveJobId(existingById.id);
                setIsPlaying(true);
                statusMessage.textContent = 'Starting selected job...';
                updateStatusIcon('downloading');
                startPolling();
                try { await loadQueueOnce(); } catch {}
                return;
              } catch (err) {
                console.warn('[LocalUI] Failed to start queued job', err);
                statusMessage.textContent = 'Failed to start queued job.';
                return;
              }
            }

            // If completed, fall through to duplicate check to avoid add
          }
        }

        // Check duplicate by URL only if not the same selected job
        const isDuplicate = queue.some((job) =>
          job.url === lastTask.url &&
          (job.queueStatus === 'queued' || job.queueStatus === 'downloading' || job.queueStatus === 'paused')
        );

        if (isDuplicate) {
          statusMessage.textContent = 'This video is already in the queue or downloading.';
          return;
        }
      }
    } catch (err) {
      console.warn('[LocalUI] Failed to check for duplicates', err);
      // Continue anyway if duplicate check fails
    }

    const activeJobId = getActiveJobId();

    // If a job is already active, add new task to queue instead
    if (activeJobId) {
      const threadsToSend = getSelectedThreads() || 1;
      console.log('[LocalUI] Adding to queue with threads:', threadsToSend);
      try {
        const response = await fetch('/api/queue/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            queue: lastTask,
            threads: threadsToSend,
            settings: {
              fileNaming: (savedSettings && savedSettings.fileNaming) || 'title',
              customName: fileNameInput && fileNameInput.value
                ? fileNameInput.value.trim()
                : '',
              maxSegmentAttempts: retryAttemptsSelect && retryAttemptsSelect.value
                ? retryAttemptsSelect.value
                : (savedSettings && savedSettings.retryAttempts) || 'infinite',
            },
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          statusMessage.textContent = `Failed to add to queue: ${text || response.status}`;
          return;
        }

        const { queuePosition } = await response.json();
        statusMessage.textContent = `Added to queue at position ${queuePosition + 1}. Check side panel to manage.`;

        // Always refresh queue data after a successful add
        try {
          await loadQueueOnce();
        } catch (e) {
          console.warn('[LocalUI] Failed to refresh queue after add', e);
        }

        // Clear the task so a new one can be received
        setLastTask(null);
        if (fileNameInput) {
          fileNameInput.value = '';
        }
      } catch (err) {
        console.warn('[LocalUI] Failed to add to queue', err);
        statusMessage.textContent = 'Failed to add job to queue.';
      }
      return;
    }

    // No active job, add to queue (will auto-start if autoStart is enabled)
    try {
      const threadsToSend = getSelectedThreads() || 1;
      console.log('[LocalUI] Adding first job with threads:', threadsToSend);
      const response = await fetch('/api/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queue: lastTask,
          threads: threadsToSend,
          settings: {
            fileNaming: (savedSettings && savedSettings.fileNaming) || 'title',
            customName: fileNameInput && fileNameInput.value
              ? fileNameInput.value.trim()
              : '',
            maxSegmentAttempts: retryAttemptsSelect && retryAttemptsSelect.value
              ? retryAttemptsSelect.value
              : (savedSettings && savedSettings.retryAttempts) || 'infinite',
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        statusMessage.textContent = `Failed to add to queue: ${text || response.status}`;
        return;
      }

      const { id } = await response.json();
      setActiveJobId(id);
      try {
        localStorage.setItem(JOB_ID_STORAGE_KEY, id);
      } catch {}
      statusMessage.textContent = 'Job added to queue and starting...';
      resetStatistics();
      updateStatusIcon('downloading');

      if (downloadFileBtn) {
        downloadFileBtn.classList.add('hidden');
        downloadFileBtn.onclick = null;
      }

      startPolling();

      // Refresh queue so the first job shows immediately in the list
      try {
        await loadQueueOnce();
      } catch (e) {
        console.warn('[LocalUI] Failed to refresh queue after first add', e);
      }

      // Hint about side panel
      setTimeout(() => {
        statusMessage.textContent += ' (Open side panel to see all downloads)';
      }, 1000);
    } catch (err) {
      console.warn('[LocalUI] Failed to add to queue', err);
      statusMessage.textContent = 'Failed to add job to queue.';
    }
  }

  function attachPlaybackHandlers() {
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', () => {
        const lastTask = getLastTask();
        if (!lastTask) {
          statusMessage.textContent = 'No task loaded from extension yet.';
          return;
        }

        const isPlaying = getIsPlaying();

        if (!isPlaying) {
          setIsPlaying(true);
          playPauseBtn.textContent = '❚❚';
          // If a job is already active, startJobIfNeeded will just resume polling.
          startJobIfNeeded();
        } else {
          // Pause is not wired to the server yet; just stop polling UI.
          setIsPlaying(false);
          playPauseBtn.textContent = '▶';
          stopPolling();
          statusMessage.textContent = 'Download pause requested (server continues in background).';
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        setIsPlaying(false);
        playPauseBtn.textContent = '▶';

        stopPolling();

        const activeJobId = getActiveJobId();
        if (activeJobId) {
          fetch(`/api/jobs/${activeJobId}/cancel`, { method: 'POST' }).catch((err) => {
            console.warn('[LocalUI] Failed to cancel job', err);
          });
        }

        setActiveJobId(null);
        statusMessage.textContent = 'Download stopped.';
        updateStatusIcon('paused');
        if (etaStatus) etaStatus.textContent = 'ETA: --';
      });
    }
  }

  function restoreExistingJobIfAny() {
    try {
      const storedJobId = localStorage.getItem(JOB_ID_STORAGE_KEY);
      if (!storedJobId) return;
      setActiveJobId(storedJobId);
      setIsPlaying(true);
      if (playPauseBtn) {
        playPauseBtn.textContent = '❚❚';
      }
      statusMessage.textContent = 'Reconnected to active download job.';
      updateStatusIcon('downloading');
      // First poll after reconnect should request a full snapshot so the heatmap
      // has complete state before switching back to deltas.
      if (typeof requestFullSnapshot === 'function') {
        requestFullSnapshot();
      }
      startPolling();
    } catch {
      // ignore storage issues
    }
  }

  return {
    startJobIfNeeded,
    attachPlaybackHandlers,
    restoreExistingJobIfAny,
  };
}
