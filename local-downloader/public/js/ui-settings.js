// Settings persistence helpers for Local HLS Downloader UI
// Provides load/save functions for UI-related settings stored in localStorage.

const SETTINGS_KEY = 'localDownloaderSettings';

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSettings(partial) {
  try {
    const current = loadSettings();
    const next = Object.assign({}, current, partial);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

export function initSettingsUI({
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
  onThreadsChange,
}) {
  const settings = savedSettings || {};

  // Initialize default threads, preferring saved setting if present.
  if (threadButtons && threadButtons.length > 0) {
    threadButtons.forEach((b) => b.classList.remove('selected'));

    let initialThreads = null;
    if (typeof settings.threads === 'number') {
      initialThreads = settings.threads;
    }

    let initialBtn = null;
    if (initialThreads != null) {
      initialBtn = Array.from(threadButtons).find(
        (b) => parseInt(b.getAttribute('data-threads') || '0', 10) === initialThreads
      );
    }

    if (!initialBtn) {
      // Fallback to highest option when nothing saved or not found.
      initialBtn = threadButtons[threadButtons.length - 1];
      initialThreads = parseInt(initialBtn.getAttribute('data-threads') || '1', 10) || 1;
    }

    initialBtn.classList.add('selected');
    if (typeof onThreadsChange === 'function') {
      onThreadsChange(initialThreads);
    }
    if (statusMessage) {
      statusMessage.textContent = `Using ${initialThreads} download threads.`;
    }
  }

  if (threadButtons && threadButtons.length > 0) {
    threadButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        threadButtons.forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        const threads = parseInt(btn.getAttribute('data-threads') || '1', 10) || 1;
        if (typeof onThreadsChange === 'function') {
          onThreadsChange(threads);
        }
        if (statusMessage) {
          statusMessage.textContent = `Using ${threads} download thread${threads === 1 ? '' : 's'}.`;
        }
        saveSettings({ threads });
      });
    });
  }

  // Restore Auto Save toggle from settings
  if (autoSaveToggle && typeof settings.autoSave === 'boolean') {
    autoSaveToggle.checked = settings.autoSave;
  }

  if (autoSaveToggle) {
    autoSaveToggle.addEventListener('change', () => {
      saveSettings({ autoSave: !!autoSaveToggle.checked });
    });
  }

  // Restore Clear Cache
  if (clearCacheToggle && typeof settings.clearCache === 'boolean') {
    clearCacheToggle.checked = settings.clearCache;
  }
  if (clearCacheToggle) {
    clearCacheToggle.addEventListener('change', () => {
      saveSettings({ clearCache: !!clearCacheToggle.checked });
    });
  }

  // Restore Tab Progress
  if (tabProgressToggle && typeof settings.tabProgress === 'boolean') {
    tabProgressToggle.checked = settings.tabProgress;
  }
  if (tabProgressToggle) {
    tabProgressToggle.addEventListener('change', () => {
      saveSettings({ tabProgress: !!tabProgressToggle.checked });
    });
  }

  // Restore Retry Attempts setting
  if (retryAttemptsSelect && typeof settings.retryAttempts === 'string') {
    if (Array.from(retryAttemptsSelect.options).some((o) => o.value === settings.retryAttempts)) {
      retryAttemptsSelect.value = settings.retryAttempts;
    }
  }
  if (retryAttemptsSelect) {
    retryAttemptsSelect.addEventListener('change', () => {
      saveSettings({ retryAttempts: retryAttemptsSelect.value });
    });
  }

  // Restore Resolution select and "Default" toggle
  if (resolutionSelect && typeof settings.resolution === 'string') {
    if (Array.from(resolutionSelect.options).some((o) => o.value === settings.resolution)) {
      resolutionSelect.value = settings.resolution;
    }
  }
  if (resolutionDefaultToggle && typeof settings.resolutionDefault === 'boolean') {
    resolutionDefaultToggle.checked = settings.resolutionDefault;
  }
  if (resolutionSelect) {
    resolutionSelect.addEventListener('change', () => {
      saveSettings({ resolution: resolutionSelect.value });
    });
  }
  if (resolutionDefaultToggle) {
    resolutionDefaultToggle.addEventListener('change', () => {
      saveSettings({ resolutionDefault: !!resolutionDefaultToggle.checked });
    });
  }

  // Restore File Naming preference (radio group)
  if (fileNamingRadios && fileNamingRadios.length > 0 && typeof settings.fileNaming === 'string') {
    fileNamingRadios.forEach((r) => {
      if (r.value === settings.fileNaming) {
        r.checked = true;
      }
    });
  }
  if (fileNamingRadios && fileNamingRadios.length > 0) {
    fileNamingRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) {
          saveSettings({ fileNaming: r.value });
        }
      });
    });
  }
}
