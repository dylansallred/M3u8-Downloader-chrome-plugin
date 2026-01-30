// Queue and side panel module for Local HLS Downloader UI
// Responsible for loading/rendering the queue, managing side panel visibility,
// tab switching between Queue/History, and queue-related controls/settings.

export function createQueueController({
  // DOM
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
  queueSelectJob,
  // Helpers/state
  formatBytes,
  statusMessage,
  loadHistoryOnce,
}) {
  let sidePanelVisible = sidePanel ? !sidePanel.classList.contains('hidden') : false;
  let activeTab = 'queue'; // 'queue' or 'history'
  let queuePollTimer = null;
  let editingJobId = null;
  let editingValue = '';

  async function loadQueueOnce() {
    if (!queueList) return;
    try {
      const res = await fetch('/api/queue');
      if (!res.ok) {
        throw new Error(`Queue request failed with status ${res.status}`);
      }
      const data = await res.json();
      const queue = (data && Array.isArray(data.queue)) ? data.queue : [];
      const settings = data.settings || {};

      // Update settings UI
      if (queueMaxConcurrent && settings.maxConcurrent) {
        queueMaxConcurrent.value = String(settings.maxConcurrent);
      }
      if (queueAutoStart) {
        queueAutoStart.checked = settings.autoStart !== false;
      }

      // Update stats
      const queuedCount = queue.filter(j => j.queueStatus === 'queued' || j.queueStatus === 'paused').length;
      const activeCount = queue.filter(j => j.queueStatus === 'downloading').length;
      if (queueCount) queueCount.textContent = `${queuedCount} queued`;
      if (queueActive) queueActive.textContent = `${activeCount} active`;

      // Render queue items
      queueList.innerHTML = '';

      if (!queue.length) {
        const empty = document.createElement('div');
        empty.className = 'queue-empty';
        empty.textContent = 'No downloads in queue';
        queueList.appendChild(empty);
        return;
      }

      const isActiveJob = (job) => job.queueStatus !== 'completed';

      const getPreviousActivePosition = (startIndex) => {
        for (let i = startIndex - 1; i >= 0; i -= 1) {
          const candidate = queue[i];
          if (isActiveJob(candidate)) {
            return typeof candidate.queuePosition === 'number' ? candidate.queuePosition : i;
          }
        }
        return null;
      };

      const getNextActivePosition = (startIndex) => {
        for (let i = startIndex + 1; i < queue.length; i += 1) {
          const candidate = queue[i];
          if (isActiveJob(candidate)) {
            return typeof candidate.queuePosition === 'number' ? candidate.queuePosition : i;
          }
        }
        return null;
      };

      let nextPosition = 0;
      queue.forEach((job, index) => {
        const item = document.createElement('div');
        item.className = `queue-item queue-item--${job.queueStatus}`;
        item.setAttribute('data-job-id', job.id);

        // Allow clicking anywhere on the item to select/show details
        item.addEventListener('click', () => {
          if (typeof queueSelectJob === 'function') {
            queueSelectJob(job.id);
          }
        });

        // Thumbnail
        const thumb = document.createElement('div');
        thumb.className = 'queue-item-thumb';
        const isCompletable = isActiveJob(job);
        const positionLabel = isCompletable ? (++nextPosition) : null;
        if (positionLabel !== null) {
          const posBadge = document.createElement('div');
          posBadge.className = 'queue-position-badge';
          posBadge.textContent = positionLabel;
          posBadge.title = `Queue position: ${positionLabel}`;
          thumb.appendChild(posBadge);
        }
        if (job.thumbnailUrls && job.thumbnailUrls.length > 0) {
          const img = document.createElement('img');
          img.src = job.thumbnailUrls[0];
          img.alt = 'Thumbnail';
          thumb.appendChild(img);
        } else {
          thumb.textContent = '📹';
        }

        // Info
        const info = document.createElement('div');
        info.className = 'queue-item-info';

        const titleRow = document.createElement('div');
        titleRow.className = 'queue-title-row';

        const title = document.createElement('div');
        title.className = 'queue-item-title';
        title.textContent = job.title || 'Download';
        titleRow.appendChild(title);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'queue-inline-btn';
        editBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="m4 15.17 9.192-9.192a1.5 1.5 0 0 1 2.122 0l2.708 2.708a1.5 1.5 0 0 1 0 2.122L8.83 20H4v-4.83Z"/><path d="M5 18h2.586l8.95-8.95-2.586-2.586L5 15.414V18Zm14.207-9.207-2.95-2.95 1.414-1.414a1.5 1.5 0 0 1 2.122 0l0.828 0.828a1.5 1.5 0 0 1 0 2.122l-1.414 1.414Z"/></svg>';
        editBtn.title = 'Rename';
        titleRow.appendChild(editBtn);

        const renameForm = document.createElement('div');
        renameForm.className = 'queue-rename-form hidden';
        const renameInput = document.createElement('input');
        renameInput.type = 'text';
        renameInput.className = 'queue-rename-input';
        renameInput.value = job.title || '';

        const renameSave = document.createElement('button');
        renameSave.type = 'button';
        renameSave.className = 'queue-inline-btn';
        renameSave.textContent = '✔';

        const renameCancel = document.createElement('button');
        renameCancel.type = 'button';
        renameCancel.className = 'queue-inline-btn';
        renameCancel.textContent = '✕';

        renameForm.appendChild(renameInput);
        renameForm.appendChild(renameSave);
        renameForm.appendChild(renameCancel);

        function closeRename() {
          if (editingJobId === job.id) {
            editingJobId = null;
            editingValue = '';
          }
          renameForm.classList.add('hidden');
          titleRow.classList.remove('hidden');
          renameInput.value = title.textContent;
        }

        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          editingJobId = job.id;
          editingValue = renameInput.value;
          titleRow.classList.add('hidden');
          renameForm.classList.remove('hidden');
          renameInput.focus();
          renameInput.select();
        });

        renameCancel.addEventListener('click', (e) => {
          e.stopPropagation();
          closeRename();
        });

        renameSave.addEventListener('click', async (e) => {
          e.stopPropagation();
          const newTitle = renameInput.value.trim();
          if (!newTitle) {
            closeRename();
            return;
          }
          try {
            const resp = await fetch(`/api/queue/${job.id}/rename`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: newTitle }),
            });
            if (!resp.ok) {
              const txt = await resp.text();
              if (statusMessage) {
                statusMessage.textContent = `Failed to rename: ${txt || resp.status}`;
              }
              closeRename();
              return;
            }
            title.textContent = newTitle;
            editingJobId = null;
            editingValue = '';
            closeRename();
          } catch (err) {
            if (statusMessage) {
              statusMessage.textContent = 'Failed to rename file.';
            }
            closeRename();
          }
        });

        renameInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            renameSave.click();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            closeRename();
          }
        });

        renameInput.addEventListener('input', () => {
          if (editingJobId === job.id) {
            editingValue = renameInput.value;
          }
        });

        // Restore editing state if this job was being renamed when the list refreshed
        if (editingJobId === job.id) {
          titleRow.classList.add('hidden');
          renameForm.classList.remove('hidden');
          renameInput.value = editingValue || job.title || '';
          queueMicrotask(() => {
            renameInput.focus();
            const len = renameInput.value.length;
            renameInput.setSelectionRange(len, len);
          });
        }

        const meta = document.createElement('div');
        meta.className = 'queue-item-meta';
        const statusText = job.queueStatus.charAt(0).toUpperCase() + job.queueStatus.slice(1);
        const progressText = job.progress ? `${job.progress}%` : '0%';
        const sizeText = formatBytes(job.bytesDownloaded || 0);
        meta.textContent = `${statusText} · ${progressText} · ${sizeText}`;

        info.appendChild(titleRow);
        info.appendChild(renameForm);
        info.appendChild(meta);

        // Progress bar
        const progressBar = document.createElement('div');
        progressBar.className = 'queue-item-progress';
        const progressFill = document.createElement('div');
        progressFill.className = 'queue-item-progress-fill';
        progressFill.style.width = `${job.progress || 0}%`;
        progressBar.appendChild(progressFill);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'queue-item-actions';

        if (job.queueStatus === 'queued' || job.queueStatus === 'paused') {
          const moveUpBtn = document.createElement('button');
          moveUpBtn.className = 'queue-item-btn';
          moveUpBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M12 6.5a1 1 0 0 1 .76.35l6 7a1 1 0 1 1-1.52 1.3L12 9.27l-5.24 5.88a1 1 0 0 1-1.52-1.3l6-7a1 1 0 0 1 .76-.35Z"/></svg>';
          moveUpBtn.title = 'Move up';
          moveUpBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const targetPos = getPreviousActivePosition(index);
            if (targetPos === null) return;
            await fetch(`/api/queue/${job.id}/move`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ position: targetPos }),
            });
            loadQueueOnce();
          });

          const moveDownBtn = document.createElement('button');
          moveDownBtn.className = 'queue-item-btn';
          moveDownBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M12 17.5a1 1 0 0 1-.76-.35l-6-7a1 1 0 0 1 1.52-1.3L12 14.73l5.24-5.88a1 1 0 1 1 1.52 1.3l-6 7a1 1 0 0 1-.76.35Z"/></svg>';
          moveDownBtn.title = 'Move down';
          moveDownBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const targetPos = getNextActivePosition(index);
            if (targetPos === null) return;
            await fetch(`/api/queue/${job.id}/move`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ position: targetPos }),
            });
            loadQueueOnce();
          });

          const startBtn = document.createElement('button');
          startBtn.className = 'queue-item-btn';
          startBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M8.5 5.75a1 1 0 0 1 1.5-.87l8 4.75a1 1 0 0 1 0 1.74l-8 4.75a1 1 0 0 1-1.5-.87V5.75Z"/></svg>';
          startBtn.title = 'Start now';
          startBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await fetch(`/api/queue/${job.id}/start`, { method: 'POST' });
            if (typeof queueSelectJob === 'function') {
              queueSelectJob(job.id);
            }
            loadQueueOnce();
          });

          actions.appendChild(moveUpBtn);
          actions.appendChild(moveDownBtn);
          actions.appendChild(startBtn);
        }

        if (job.queueStatus === 'downloading') {
          const pauseBtn = document.createElement('button');
          pauseBtn.className = 'queue-item-btn';
          pauseBtn.textContent = '⏸';
          pauseBtn.title = 'Pause';
          pauseBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await fetch(`/api/queue/${job.id}/pause`, { method: 'POST' });
            loadQueueOnce();
          });
          actions.appendChild(pauseBtn);
        }

        if (job.queueStatus === 'paused') {
          const resumeBtn = document.createElement('button');
          resumeBtn.className = 'queue-item-btn';
          resumeBtn.textContent = '▶';
          resumeBtn.title = 'Resume';
          resumeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await fetch(`/api/queue/${job.id}/resume`, { method: 'POST' });
            loadQueueOnce();
          });
          actions.appendChild(resumeBtn);
        }

        if (job.queueStatus === 'completed') {
          const downloadBtn = document.createElement('button');
          downloadBtn.className = 'queue-item-btn';
          downloadBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false" class="icon-download"><path d="M12 3a1 1 0 0 1 1 1v9.586l2.293-2.293a1 1 0 1 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 1.414-1.414L11 13.586V4a1 1 0 0 1 1-1Zm-7 14a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"/></svg>';
          downloadBtn.title = 'Download';
          downloadBtn.addEventListener('click', () => {
            const link = document.createElement('a');
            link.href = `/api/jobs/${job.id}/file`;
            document.body.appendChild(link);
            link.click();
            link.remove();
          });
          actions.appendChild(downloadBtn);
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'queue-item-btn danger';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm('Remove this job from queue?')) {
            await fetch(`/api/queue/${job.id}`, { method: 'DELETE' });
            loadQueueOnce();
          }
        });
        actions.appendChild(removeBtn);

        item.appendChild(thumb);
        item.appendChild(info);
        item.appendChild(progressBar);
        item.appendChild(actions);

        queueList.appendChild(item);
      });
    } catch (err) {
      console.warn('[LocalUI] Failed to load queue', err);
    }
  }

  function toggleSidePanel() {
    if (!sidePanel) return;
    sidePanelVisible = !sidePanelVisible;

    if (sidePanelVisible) {
      sidePanel.classList.remove('hidden');
      if (sidePanelHandle) {
        sidePanelHandle.setAttribute('aria-expanded', 'true');
      }
      // Ensure active tab content and polling are set up
      switchTab(activeTab || 'queue');
    } else {
      sidePanel.classList.add('hidden');
      if (sidePanelHandle) {
        sidePanelHandle.setAttribute('aria-expanded', 'false');
      }

      // Stop queue polling when panel is closed
      if (queuePollTimer) {
        clearInterval(queuePollTimer);
        queuePollTimer = null;
      }
    }
  }

  function switchTab(tab) {
    if (!sidePanel) return;
    activeTab = tab;

    // Update tab buttons
    if (queueTabBtn && historyTabBtn) {
      queueTabBtn.classList.toggle('active', tab === 'queue');
      historyTabBtn.classList.toggle('active', tab === 'history');
    }

    // Show/hide panels
    if (queuePanel && historyPanel) {
      queuePanel.classList.toggle('hidden', tab !== 'queue');
      historyPanel.classList.toggle('hidden', tab !== 'history');
    }

    // Load content and manage polling
    if (tab === 'queue') {
      // Always do an immediate refresh when switching to Queue
      loadQueueOnce();

      // Only poll when side panel is actually visible
      if (sidePanelVisible) {
        if (queuePollTimer) {
          clearInterval(queuePollTimer);
        }
        queuePollTimer = setInterval(loadQueueOnce, 2000);
      }
    } else {
      // Stop queue polling when switching away from Queue
      if (queuePollTimer) {
        clearInterval(queuePollTimer);
        queuePollTimer = null;
      }
      if (tab === 'history' && typeof loadHistoryOnce === 'function') {
        loadHistoryOnce();
      }
    }
  }

  function initQueue() {
    // Side panel handle between main content and panel
    if (sidePanelHandle) {
      sidePanelHandle.addEventListener('click', () => {
        toggleSidePanel();
      });
      sidePanelHandle.setAttribute('aria-expanded', sidePanelVisible ? 'true' : 'false');
    }

    // Side panel close button
    if (sidePanelClose) {
      sidePanelClose.addEventListener('click', () => {
        toggleSidePanel();
      });
    }

    // Tab switching
    if (queueTabBtn) {
      queueTabBtn.addEventListener('click', () => {
        switchTab('queue');
      });
    }

    if (historyTabBtn) {
      historyTabBtn.addEventListener('click', () => {
        switchTab('history');
      });
    }

    // Queue control buttons
    if (queueStartAll) {
      queueStartAll.addEventListener('click', async () => {
        await fetch('/api/queue/start-all', { method: 'POST' });
        loadQueueOnce();
      });
    }

    if (queuePauseAll) {
      queuePauseAll.addEventListener('click', async () => {
        await fetch('/api/queue/pause-all', { method: 'POST' });
        loadQueueOnce();
      });
    }

    if (queueClearCompleted) {
      queueClearCompleted.addEventListener('click', async () => {
        if (confirm('Remove all completed jobs from queue?')) {
          await fetch('/api/queue/clear-completed', { method: 'POST' });
          loadQueueOnce();
        }
      });
    }

    // Queue settings
    if (queueMaxConcurrent) {
      queueMaxConcurrent.addEventListener('change', async () => {
        const maxConcurrent = parseInt(queueMaxConcurrent.value, 10);
        await fetch('/api/queue/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxConcurrent }),
        });
        loadQueueOnce();
      });
    }

    if (queueAutoStart) {
      queueAutoStart.addEventListener('change', async () => {
        const autoStart = queueAutoStart.checked;
        await fetch('/api/queue/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoStart }),
        });
        loadQueueOnce();
      });
    }

    // Background refresh every 5s, independent of side panel visibility.
    try {
      loadQueueOnce();
      setInterval(loadQueueOnce, 5000);
    } catch (err) {
      console.warn('[LocalUI] Failed to start background queue polling', err);
    }
  }

  return {
    initQueue,
    loadQueueOnce,
    toggleSidePanel,
    switchTab,
  };
}
