import React, { useEffect, useMemo, useRef, useState } from 'react';

const NAV = [
  { id: 'active', label: 'Active Download' },
  { id: 'queue', label: 'Queue' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
  { id: 'updates', label: 'Updates' },
];

function parseVersionParts(input) {
  return String(input || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .map((value) => (Number.isFinite(value) && value >= 0 ? value : 0));
}

function compareVersions(a, b) {
  const av = parseVersionParts(a);
  const bv = parseVersionParts(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const left = av[i] || 0;
    const right = bv[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function formatBytesPerSecond(value) {
  const bps = Number(value || 0);
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function formatEta(seconds) {
  const sec = Number(seconds || 0);
  if (!Number.isFinite(sec) || sec <= 0) return 'calculating';
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  if (min < 60) return `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  const minRem = min % 60;
  return `${hr}h ${minRem}m`;
}

function normalizeReleaseNotes(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  return [];
}

function App() {
  const [currentView, setCurrentView] = useState('active');
  const [appInfo, setAppInfo] = useState(null);
  const [status, setStatus] = useState('Initializing...');
  const [queueData, setQueueData] = useState({ queue: [], settings: {} });
  const [historyItems, setHistoryItems] = useState([]);
  const [activeJobId, setActiveJobId] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const [settings, setSettings] = useState({
    queueMaxConcurrent: 1,
    queueAutoStart: true,
    checkUpdatesOnStartup: true,
  });
  const [pairing, setPairing] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [updater, setUpdater] = useState({ phase: 'idle', message: 'Idle', progress: 0 });
  const [compatibility, setCompatibility] = useState({
    loading: true,
    error: null,
    appVersion: null,
    protocolVersion: null,
    supportedProtocolVersions: null,
    minExtensionVersion: null,
    checkedAt: null,
    lastSuccessAt: null,
  });
  const [copyState, setCopyState] = useState('');
  const [revokeState, setRevokeState] = useState('');
  const [tokenFilter, setTokenFilter] = useState('all');
  const [tokenSort, setTokenSort] = useState('status');
  const [clockNow, setClockNow] = useState(Date.now());
  const [diagnosticsState, setDiagnosticsState] = useState({
    type: '',
    message: '',
    details: null,
    lastRunAt: null,
  });
  const [showDiagnosticsDetails, setShowDiagnosticsDetails] = useState(false);
  const [copyDiagnosticsState, setCopyDiagnosticsState] = useState('');
  const [saveDiagnosticsState, setSaveDiagnosticsState] = useState('');
  const [openDiagnosticsState, setOpenDiagnosticsState] = useState('');
  const [exportBundleState, setExportBundleState] = useState('');
  const [queueFilterText, setQueueFilterText] = useState('');
  const [queueFilterStatus, setQueueFilterStatus] = useState('all');
  const [historyFilterText, setHistoryFilterText] = useState('');
  const [historyFilterType, setHistoryFilterType] = useState('all');
  const [historyActionState, setHistoryActionState] = useState('');
  const [activeMetrics, setActiveMetrics] = useState({
    speedBps: 0,
    etaSeconds: null,
  });
  const activeSampleRef = useRef(null);
  const releaseNotes = useMemo(() => normalizeReleaseNotes(updater.releaseNotes), [updater.releaseNotes]);

  const apiBase = useMemo(() => appInfo?.apiBaseUrl || 'http://127.0.0.1:49732', [appInfo]);
  const outdatedTokenCount = useMemo(() => {
    const minExtensionVersion = compatibility.minExtensionVersion;
    if (!minExtensionVersion) return 0;
    return (tokens || []).filter((token) => {
      const version = String(token?.extensionVersion || '').trim();
      if (!version) return false;
      return compareVersions(version, minExtensionVersion) < 0;
    }).length;
  }, [tokens, compatibility.minExtensionVersion]);
  const outdatedTokenIds = useMemo(() => {
    const minExtensionVersion = compatibility.minExtensionVersion;
    if (!minExtensionVersion) return [];
    return (tokens || [])
      .filter((token) => {
        const version = String(token?.extensionVersion || '').trim();
        if (!version) return false;
        return compareVersions(version, minExtensionVersion) < 0;
      })
      .map((token) => token.id)
      .filter(Boolean);
  }, [tokens, compatibility.minExtensionVersion]);
  const tokenRows = useMemo(() => {
    const minVersion = compatibility.minExtensionVersion;
    return (tokens || []).map((token) => {
      const version = String(token?.extensionVersion || '').trim() || 'unknown';
      const isOutdated = Boolean(
        minVersion
        && version !== 'unknown'
        && compareVersions(version, minVersion) < 0,
      );
      return {
        ...token,
        displayVersion: version,
        status: isOutdated ? 'outdated' : 'compatible',
        isOutdated,
      };
    });
  }, [tokens, compatibility.minExtensionVersion]);
  const visibleTokenRows = useMemo(() => {
    const filtered = tokenRows.filter((token) => {
      if (tokenFilter === 'outdated') return token.status === 'outdated';
      if (tokenFilter === 'compatible') return token.status === 'compatible';
      return true;
    });

    const sorted = filtered.slice().sort((a, b) => {
      if (tokenSort === 'extension') {
        return String(a.extensionId || '').localeCompare(String(b.extensionId || ''));
      }
      if (tokenSort === 'version') {
        return compareVersions(b.displayVersion, a.displayVersion);
      }
      if (tokenSort === 'status') {
        if (a.status !== b.status) return a.status === 'outdated' ? -1 : 1;
        return String(a.extensionId || '').localeCompare(String(b.extensionId || ''));
      }
      return 0;
    });

    return sorted;
  }, [tokenRows, tokenFilter, tokenSort]);
  const visibleQueueRows = useMemo(() => {
    const text = String(queueFilterText || '').trim().toLowerCase();
    return (queueData.queue || []).filter((job) => {
      if (queueFilterStatus !== 'all' && job.queueStatus !== queueFilterStatus) {
        return false;
      }
      if (!text) return true;
      const title = String(job.title || '').toLowerCase();
      const id = String(job.id || '').toLowerCase();
      return title.includes(text) || id.includes(text);
    });
  }, [queueData.queue, queueFilterText, queueFilterStatus]);
  const visibleHistoryItems = useMemo(() => {
    const text = String(historyFilterText || '').trim().toLowerCase();
    return (historyItems || []).filter((item) => {
      if (historyFilterType !== 'all') {
        const ext = String(item.ext || '').toLowerCase().replace(/^\./, '');
        if (ext !== historyFilterType) return false;
      }
      if (!text) return true;
      const label = String(item.label || '').toLowerCase();
      const fileName = String(item.fileName || '').toLowerCase();
      return label.includes(text) || fileName.includes(text);
    });
  }, [historyItems, historyFilterText, historyFilterType]);

  const compatibilityWarning = useMemo(() => {
    if (compatibility.error) return compatibility.error;
    if (outdatedTokenCount > 0 && compatibility.minExtensionVersion) {
      return `${outdatedTokenCount} paired extension(s) below required version ${compatibility.minExtensionVersion}`;
    }
    return '';
  }, [compatibility.error, compatibility.minExtensionVersion, outdatedTokenCount]);
  const compatibilityIsStale = useMemo(() => {
    const thresholdMs = 10 * 60 * 1000;
    if (!compatibility.lastSuccessAt) return true;
    return clockNow - compatibility.lastSuccessAt > thresholdMs;
  }, [compatibility.lastSuccessAt, clockNow]);

  const request = async (path, options = {}) => {
    const res = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return null;
  };

  const loadQueue = async () => {
    const data = await request('/api/queue');
    setQueueData(data || { queue: [], settings: {} });
    return data || { queue: [], settings: {} };
  };

  const loadHistory = async () => {
    const data = await request('/api/history');
    setHistoryItems(data?.items || []);
  };

  const loadTokens = async () => {
    if (!window.desktop) return;
    const nextTokens = await window.desktop.listTokens();
    setTokens(nextTokens || []);
    return nextTokens || [];
  };

  const loadCompatibility = async () => {
    const now = Date.now();
    try {
      const res = await fetch(`${apiBase}/v1/health`, {
        headers: {
          'X-Client': 'fetchv-extension',
          'X-Protocol-Version': '1',
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setCompatibility({
        loading: false,
        error: null,
        appVersion: data?.appVersion || null,
        protocolVersion: data?.protocolVersion || null,
        supportedProtocolVersions: data?.supportedProtocolVersions || null,
        minExtensionVersion: data?.minExtensionVersion || null,
        checkedAt: now,
        lastSuccessAt: now,
      });
      return { ok: true };
    } catch (err) {
      setCompatibility((prev) => ({
        loading: false,
        error: `Unable to read compatibility info: ${err.message}`,
        appVersion: prev.appVersion,
        protocolVersion: prev.protocolVersion,
        supportedProtocolVersions: prev.supportedProtocolVersions,
        minExtensionVersion: prev.minExtensionVersion,
        checkedAt: now,
        lastSuccessAt: prev.lastSuccessAt || null,
      }));
      return { ok: false, error: err.message };
    }
  };

  const loadActiveJob = async (jobId) => {
    if (!jobId) {
      setActiveJob(null);
      return;
    }
    const job = await request(`/api/jobs/${jobId}?full=1`);
    setActiveJob(job);
  };

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const info = await window.desktop.getAppInfo();
        const appSettings = await window.desktop.getSettings();
        const updaterState = await window.desktop.getUpdaterState();
        if (!mounted) return;
        setAppInfo(info);
        setSettings(appSettings);
        setUpdater(updaterState);
        setStatus(`Connected to local API at ${info.apiBaseUrl}`);
      } catch (err) {
        setStatus(`Initialization failed: ${err.message}`);
      }
    })();

    const disposeUpdater = window.desktop.onUpdaterEvent((event) => {
      setUpdater({ ...event });
    });

    return () => {
      mounted = false;
      disposeUpdater();
    };
  }, []);

  useEffect(() => {
    if (!appInfo) return;

    const refresh = async () => {
      try {
        await Promise.all([loadQueue(), loadHistory(), loadTokens(), loadCompatibility()]);
      } catch (err) {
        setStatus(`Refresh error: ${err.message}`);
      }
    };

    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [appInfo]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!queueData.queue || queueData.queue.length === 0) {
      setActiveJobId(null);
      setActiveJob(null);
      return;
    }

    const nextActive = queueData.queue.find(
      (j) => j.queueStatus === 'downloading' || j.queueStatus === 'queued' || j.queueStatus === 'paused',
    );

    if (!nextActive) {
      setActiveJobId(null);
      setActiveJob(null);
      return;
    }

    if (!activeJobId || !queueData.queue.some((q) => q.id === activeJobId)) {
      setActiveJobId(nextActive.id);
    }
  }, [queueData, activeJobId]);

  useEffect(() => {
    if (!activeJobId || !appInfo) return;

    let ws = null;
    let wsClosed = false;

    const wsUrl = `${apiBase.replace('http', 'ws')}/ws`;

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', jobId: activeJobId }));
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message?.type === 'job:update' && message?.data?.id === activeJobId) {
          setActiveJob(message.data);
        }
      };
      ws.onerror = () => {
        // Fallback polling covers this.
      };
      ws.onclose = () => {
        wsClosed = true;
      };
    } catch {
      // Ignore; fallback polling below.
    }

    const poll = async () => {
      try {
        await loadActiveJob(activeJobId);
      } catch {
        // ignore polling errors while transitioning jobs
      }
    };

    poll();
    const timer = setInterval(poll, 1000);

    return () => {
      clearInterval(timer);
      if (ws && !wsClosed) ws.close();
    };
  }, [activeJobId, appInfo, apiBase]);

  useEffect(() => {
    const job = activeJob;
    if (!job || !activeJobId) {
      activeSampleRef.current = null;
      setActiveMetrics({ speedBps: 0, etaSeconds: null });
      return;
    }

    const now = Date.now();
    const bytes = Number(job.bytesDownloaded || 0);
    const prev = activeSampleRef.current;
    let speedBps = activeMetrics.speedBps || 0;

    if (prev && prev.jobId === activeJobId) {
      const dt = Math.max(0.001, (now - prev.timeMs) / 1000);
      const db = bytes - prev.bytes;
      if (db >= 0) {
        const instant = db / dt;
        speedBps = speedBps > 0 ? (speedBps * 0.65) + (instant * 0.35) : instant;
      }
    } else {
      speedBps = 0;
    }

    activeSampleRef.current = { jobId: activeJobId, timeMs: now, bytes };

    let etaSeconds = null;
    const progress = Number(job.progress || 0);
    if (speedBps > 1 && progress > 0 && progress < 100) {
      const estimatedTotalBytes = bytes / (progress / 100);
      const remainingBytes = Math.max(0, estimatedTotalBytes - bytes);
      etaSeconds = remainingBytes / speedBps;
    }

    setActiveMetrics({ speedBps, etaSeconds });
  }, [activeJob, activeJobId]);

  const callQueueAction = async (endpoint, method = 'POST', body = null) => {
    await request(endpoint, {
      method,
      body: body ? JSON.stringify(body) : undefined,
    });
    await loadQueue();
  };

  const runBulkQueueAction = async (action) => {
    const targets = (() => {
      if (action === 'retry-failed') return visibleQueueRows.filter((job) => job.queueStatus === 'failed');
      if (action === 'remove-cancelled') return visibleQueueRows.filter((job) => job.queueStatus === 'cancelled');
      if (action === 'remove-completed') return visibleQueueRows.filter((job) => job.queueStatus === 'completed');
      if (action === 'pause-visible') {
        return visibleQueueRows.filter((job) => job.queueStatus === 'queued' || job.queueStatus === 'downloading');
      }
      if (action === 'resume-visible') return visibleQueueRows.filter((job) => job.queueStatus === 'paused');
      if (action === 'start-visible') return visibleQueueRows.filter((job) => job.queueStatus === 'queued');
      return [];
    })();

    if (targets.length === 0) {
      setStatus('Bulk action skipped: no matching queue items.');
      return;
    }

    const requests = targets.map((job) => {
      const id = encodeURIComponent(job.id);
      if (action === 'retry-failed') {
        return request(`/api/jobs/${id}/retry`, { method: 'POST' });
      }
      if (action === 'remove-cancelled' || action === 'remove-completed') {
        return request(`/api/queue/${id}`, { method: 'DELETE' });
      }
      if (action === 'pause-visible') {
        return request(`/api/queue/${id}/pause`, { method: 'POST' });
      }
      if (action === 'resume-visible') {
        return request(`/api/queue/${id}/resume`, { method: 'POST' });
      }
      if (action === 'start-visible') {
        return request(`/api/queue/${id}/start`, { method: 'POST' });
      }
      return Promise.resolve();
    });

    const results = await Promise.allSettled(requests);
    const failed = results.filter((r) => r.status === 'rejected').length;
    await loadQueue();
    if (failed > 0) {
      setStatus(`Bulk action completed with ${failed} error(s).`);
      return;
    }
    setStatus(`Bulk action completed (${targets.length} item(s)).`);
  };

  const saveDesktopSettings = async (nextSettings) => {
    const merged = await window.desktop.saveSettings(nextSettings);
    setSettings(merged);
  };

  const generatePairingCode = async () => {
    const code = await window.desktop.generatePairingCode();
    setPairing(code);
    setCurrentView('settings');
  };

  const copyMinExtensionVersion = async () => {
    const value = compatibility.minExtensionVersion;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('Copied');
      setTimeout(() => setCopyState(''), 1200);
    } catch {
      setCopyState('Copy failed');
      setTimeout(() => setCopyState(''), 1200);
    }
  };

  const revokeOutdatedTokens = async () => {
    if (!outdatedTokenIds.length) return;
    setRevokeState('Revoking...');
    try {
      await Promise.all(outdatedTokenIds.map((id) => window.desktop.revokeToken(id)));
      await loadTokens();
      setRevokeState('Revoked outdated tokens');
      setTimeout(() => setRevokeState(''), 1500);
    } catch {
      setRevokeState('Failed to revoke outdated tokens');
      setTimeout(() => setRevokeState(''), 1500);
    }
  };

  const refreshAllDiagnostics = async () => {
    setDiagnosticsState({
      type: 'info',
      message: 'Refreshing diagnostics...',
      details: null,
      lastRunAt: Date.now(),
    });
    setShowDiagnosticsDetails(false);

    const [queueResult, tokenResult, compatibilityResult] = await Promise.allSettled([
      loadQueue(),
      loadTokens(),
      loadCompatibility(),
    ]);

    const details = {};
    const failures = [];
    if (queueResult.status === 'rejected') {
      failures.push('queue');
      details.queue = String(queueResult.reason?.message || queueResult.reason || 'Unknown queue error');
    }
    if (tokenResult.status === 'rejected') {
      failures.push('tokens');
      details.tokens = String(tokenResult.reason?.message || tokenResult.reason || 'Unknown token error');
    }
    if (
      compatibilityResult.status === 'rejected'
      || (compatibilityResult.status === 'fulfilled' && compatibilityResult.value?.ok === false)
    ) {
      failures.push('compatibility');
      if (compatibilityResult.status === 'rejected') {
        details.compatibility = String(
          compatibilityResult.reason?.message || compatibilityResult.reason || 'Unknown compatibility error',
        );
      } else {
        details.compatibility = String(compatibilityResult.value?.error || 'Unknown compatibility error');
      }
    }

    if (failures.length > 0) {
      setDiagnosticsState({
        type: 'error',
        message: `Diagnostics completed with issues: ${failures.join(', ')}`,
        details,
        lastRunAt: Date.now(),
      });
      return;
    }

    const queueSize =
      queueResult.status === 'fulfilled' && Array.isArray(queueResult.value?.queue)
        ? queueResult.value.queue.length
        : 0;
    const tokenCount =
      tokenResult.status === 'fulfilled' && Array.isArray(tokenResult.value)
        ? tokenResult.value.length
        : 0;
    setDiagnosticsState({
      type: 'success',
      message: `Diagnostics ok: queue=${queueSize}, pairedExtensions=${tokenCount}`,
      details: null,
      lastRunAt: Date.now(),
    });
  };

  const buildDiagnosticsPayload = () => ({
    exportedAt: new Date().toISOString(),
    diagnostics: diagnosticsState,
    compatibility: {
      checkedAt: compatibility.checkedAt,
      lastSuccessAt: compatibility.lastSuccessAt,
      appVersion: compatibility.appVersion,
      protocolVersion: compatibility.protocolVersion,
      supportedProtocolVersions: compatibility.supportedProtocolVersions,
      minExtensionVersion: compatibility.minExtensionVersion,
      isStale: compatibilityIsStale,
    },
    queue: {
      total: Array.isArray(queueData.queue) ? queueData.queue.length : 0,
    },
    pairedExtensions: {
      total: Array.isArray(tokens) ? tokens.length : 0,
      outdated: outdatedTokenCount,
    },
  });

  const copyDiagnosticsJson = async () => {
    const payload = buildDiagnosticsPayload();

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyDiagnosticsState('Copied diagnostics');
      setTimeout(() => setCopyDiagnosticsState(''), 1500);
    } catch {
      setCopyDiagnosticsState('Failed to copy diagnostics');
      setTimeout(() => setCopyDiagnosticsState(''), 1500);
    }
  };

  const saveDiagnosticsFile = async () => {
    const payload = buildDiagnosticsPayload();

    try {
      if (!window.desktop || typeof window.desktop.saveDiagnosticsFile !== 'function') {
        throw new Error('Desktop bridge does not support file save');
      }
      const result = await window.desktop.saveDiagnosticsFile(payload);
      if (!result || !result.ok) {
        throw new Error(result?.error || 'Save failed');
      }
      setSaveDiagnosticsState(`Saved diagnostics file: ${result.filePath}`);
      setTimeout(() => setSaveDiagnosticsState(''), 3000);
    } catch {
      setSaveDiagnosticsState('Failed to save diagnostics file');
      setTimeout(() => setSaveDiagnosticsState(''), 2000);
    }
  };

  const openDiagnosticsFolder = async () => {
    try {
      if (!window.desktop || typeof window.desktop.openDiagnosticsFolder !== 'function') {
        throw new Error('Desktop bridge does not support opening folder');
      }
      const result = await window.desktop.openDiagnosticsFolder();
      if (!result || !result.ok) {
        throw new Error(result?.error || 'Open folder failed');
      }
      setOpenDiagnosticsState(`Opened diagnostics folder: ${result.folderPath}`);
      setTimeout(() => setOpenDiagnosticsState(''), 3000);
    } catch {
      setOpenDiagnosticsState('Failed to open diagnostics folder');
      setTimeout(() => setOpenDiagnosticsState(''), 2000);
    }
  };

  const exportSupportBundle = async () => {
    try {
      if (!window.desktop || typeof window.desktop.exportSupportBundle !== 'function') {
        throw new Error('Desktop bridge does not support support bundle export');
      }
      const payload = buildDiagnosticsPayload();
      const result = await window.desktop.exportSupportBundle(payload);
      if (!result || !result.ok) {
        throw new Error(result?.error || 'Support bundle export failed');
      }
      setExportBundleState(`Exported support bundle: ${result.bundlePath}`);
      setTimeout(() => setExportBundleState(''), 4000);
    } catch {
      setExportBundleState('Failed to export support bundle');
      setTimeout(() => setExportBundleState(''), 2500);
    }
  };

  const openHistoryTarget = async (mode, fileName) => {
    try {
      if (!fileName) {
        throw new Error('Missing file name');
      }
      if (!window.desktop) {
        throw new Error('Desktop bridge unavailable');
      }
      if (mode === 'file') {
        if (typeof window.desktop.openHistoryFile !== 'function') {
          throw new Error('Open file action is not available');
        }
        const result = await window.desktop.openHistoryFile(fileName);
        if (!result?.ok) {
          throw new Error(result?.error || 'Failed to open file');
        }
        setHistoryActionState(`Opened file: ${fileName}`);
      } else {
        if (typeof window.desktop.openHistoryFolder !== 'function') {
          throw new Error('Open folder action is not available');
        }
        const result = await window.desktop.openHistoryFolder(fileName);
        if (!result?.ok) {
          throw new Error(result?.error || 'Failed to open folder');
        }
        setHistoryActionState(`Opened folder for: ${fileName}`);
      }
      setTimeout(() => setHistoryActionState(''), 2000);
    } catch (err) {
      setHistoryActionState(`History action failed: ${err.message}`);
      setTimeout(() => setHistoryActionState(''), 2500);
    }
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>M3U8 Downloader</h1>
        <p className="muted">Electron Desktop</p>
        <button className="pair-btn" onClick={generatePairingCode}>Generate Pairing Code</button>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${currentView === item.id ? 'active' : ''}`}
              onClick={() => setCurrentView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        {compatibilityWarning && (
          <button
            className="warning-banner"
            onClick={() => setCurrentView('settings')}
            title={compatibilityWarning}
          >
            Compatibility Warning
          </button>
        )}
        <div className="status">{status}</div>
      </aside>

      <main className="content">
        {currentView === 'active' && (
          <section>
            <h2>Active Download</h2>
            {!activeJob && <p className="muted">No active job.</p>}
            {activeJob && (
              <div className="card">
                <h3>{activeJob.title || activeJob.id}</h3>
                <p>Status: <strong>{activeJob.status}</strong></p>
                {activeJob.fallbackUsed && <p className="fallback-note">Fallback used: direct media URL</p>}
                <p>Progress: <strong>{activeJob.progress || 0}%</strong></p>
                <p>Segments: {activeJob.completedSegments || 0}/{activeJob.totalSegments || 0}</p>
                <p>Downloaded: {Math.round((activeJob.bytesDownloaded || 0) / (1024 * 1024))} MB</p>
                <p>Speed: <strong>{formatBytesPerSecond(activeMetrics.speedBps)}</strong></p>
                <p>ETA: <strong>{formatEta(activeMetrics.etaSeconds)}</strong></p>
                {activeJob.error && <p className="error">Reason: {activeJob.error}</p>}
                <div className="row">
                  <button onClick={() => callQueueAction(`/api/queue/${activeJob.id}/pause`)}>Pause</button>
                  <button onClick={() => callQueueAction(`/api/queue/${activeJob.id}/resume`)}>Resume</button>
                  <button className="danger" onClick={() => callQueueAction(`/api/jobs/${activeJob.id}/cancel`)}>Cancel</button>
                  {activeJob.fallbackUsed && activeJob.originalHlsUrl && (
                    <button onClick={() => callQueueAction(`/api/jobs/${activeJob.id}/retry-original-hls`)}>
                      Retry Original HLS
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {currentView === 'queue' && (
          <section>
            <h2>Queue</h2>
            <div className="row">
              <button onClick={() => callQueueAction('/api/queue/start-all')}>Start All</button>
              <button onClick={() => callQueueAction('/api/queue/pause-all')}>Pause All</button>
              <button onClick={() => callQueueAction('/api/queue/clear-completed')}>Clear Completed</button>
            </div>
            <div className="row">
              <button onClick={() => runBulkQueueAction('retry-failed')}>Retry Failed (Filtered)</button>
              <button onClick={() => runBulkQueueAction('remove-cancelled')}>Remove Cancelled (Filtered)</button>
              <button onClick={() => runBulkQueueAction('remove-completed')}>Remove Completed (Filtered)</button>
              <button onClick={() => runBulkQueueAction('start-visible')}>Start Visible</button>
              <button onClick={() => runBulkQueueAction('pause-visible')}>Pause Visible</button>
              <button onClick={() => runBulkQueueAction('resume-visible')}>Resume Visible</button>
            </div>
            <div className="row">
              <label>
                Search
                <input
                  type="text"
                  value={queueFilterText}
                  placeholder="Title or job id"
                  onChange={(e) => setQueueFilterText(e.target.value)}
                />
              </label>
              <label>
                Status
                <select
                  value={queueFilterStatus}
                  onChange={(e) => setQueueFilterStatus(e.target.value)}
                >
                  <option value="all">All</option>
                  <option value="queued">Queued</option>
                  <option value="downloading">Downloading</option>
                  <option value="paused">Paused</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label>
                Max concurrent
                <input
                  type="number"
                  min="1"
                  max="16"
                  value={queueData.settings?.maxConcurrent || 1}
                  onChange={(e) => callQueueAction('/api/queue/settings', 'POST', {
                    maxConcurrent: Number(e.target.value || 1),
                    autoStart: queueData.settings?.autoStart !== false,
                  })}
                />
              </label>
              <label>
                Auto start
                <input
                  type="checkbox"
                  checked={queueData.settings?.autoStart !== false}
                  onChange={(e) => callQueueAction('/api/queue/settings', 'POST', {
                    maxConcurrent: queueData.settings?.maxConcurrent || 1,
                    autoStart: e.target.checked,
                  })}
                />
              </label>
            </div>
            <div className="list">
              {visibleQueueRows.length ? visibleQueueRows.map((job) => (
                <article key={job.id} className="card">
                  <h3>{job.title}</h3>
                  <p>{job.queueStatus} | {job.progress || 0}%</p>
                  {job.fallbackUsed && <p className="fallback-note">Fallback used</p>}
                  {job.error && <p className="error">Reason: {job.error}</p>}
                  <div className="row">
                    <button onClick={() => setActiveJobId(job.id)}>Focus</button>
                    <button onClick={() => callQueueAction(`/api/queue/${job.id}/start`)}>Start</button>
                    <button onClick={() => callQueueAction(`/api/queue/${job.id}/pause`)}>Pause</button>
                    <button onClick={() => callQueueAction(`/api/queue/${job.id}/resume`)}>Resume</button>
                    <button className="danger" onClick={() => callQueueAction(`/api/queue/${job.id}`, 'DELETE')}>Remove</button>
                    {['failed', 'cancelled', 'completed'].includes(job.queueStatus) && (
                      <button onClick={() => callQueueAction(`/api/jobs/${job.id}/retry`)}>
                        Retry Job
                      </button>
                    )}
                    {job.fallbackUsed && job.originalHlsUrl && (
                      <button onClick={() => callQueueAction(`/api/jobs/${job.id}/retry-original-hls`)}>
                        Retry Original HLS
                      </button>
                    )}
                  </div>
                </article>
              )) : <p className="muted">No queue items match current filter.</p>}
            </div>
          </section>
        )}

        {currentView === 'history' && (
          <section>
            <h2>History</h2>
            <div className="row">
              <button onClick={() => callQueueAction('/api/history', 'DELETE').then(loadHistory)}>Clear History</button>
            </div>
            <div className="row">
              <label>
                Search
                <input
                  type="text"
                  value={historyFilterText}
                  placeholder="Label or file name"
                  onChange={(e) => setHistoryFilterText(e.target.value)}
                />
              </label>
              <label>
                Type
                <select
                  value={historyFilterType}
                  onChange={(e) => setHistoryFilterType(e.target.value)}
                >
                  <option value="all">All</option>
                  <option value="mp4">MP4</option>
                  <option value="ts">TS</option>
                </select>
              </label>
            </div>
            {historyActionState && <p className="muted">{historyActionState}</p>}
            <div className="list">
              {visibleHistoryItems.length ? visibleHistoryItems.map((item) => (
                <article key={item.id} className="card">
                  <h3>{item.label}</h3>
                  <p>{Math.round(item.sizeBytes / (1024 * 1024))} MB</p>
                  <div className="row">
                    <a href={`${apiBase}/api/history/file/${encodeURIComponent(item.fileName)}`} target="_blank" rel="noreferrer">Download</a>
                    <a href={`${apiBase}/api/history/stream/${encodeURIComponent(item.fileName)}`} target="_blank" rel="noreferrer">Stream</a>
                    <button onClick={() => openHistoryTarget('file', item.fileName)}>Open File</button>
                    <button onClick={() => openHistoryTarget('folder', item.fileName)}>Open Folder</button>
                    <button className="danger" onClick={() => callQueueAction(`/api/history/${encodeURIComponent(item.fileName)}`, 'DELETE').then(loadHistory)}>Delete</button>
                  </div>
                </article>
              )) : <p className="muted">No history items match current filter.</p>}
            </div>
          </section>
        )}

        {currentView === 'settings' && (
          <section>
            <h2>Settings</h2>
            <div className="card">
              <h3>Desktop Settings</h3>
              <label>
                Check updates on startup
                <input
                  type="checkbox"
                  checked={settings.checkUpdatesOnStartup !== false}
                  onChange={(e) => saveDesktopSettings({ checkUpdatesOnStartup: e.target.checked })}
                />
              </label>
              <label>
                Default queue max concurrent
                <input
                  type="number"
                  min="1"
                  max="16"
                  value={settings.queueMaxConcurrent || 1}
                  onChange={(e) => saveDesktopSettings({ queueMaxConcurrent: Number(e.target.value || 1) })}
                />
              </label>
              <label>
                Default queue auto start
                <input
                  type="checkbox"
                  checked={settings.queueAutoStart !== false}
                  onChange={(e) => saveDesktopSettings({ queueAutoStart: e.target.checked })}
                />
              </label>
            </div>

            <div className="card">
              <h3>Compatibility</h3>
              <div className="row">
                <button onClick={refreshAllDiagnostics}>Refresh All Diagnostics</button>
                <button onClick={copyDiagnosticsJson}>Copy Diagnostics JSON</button>
                <button onClick={saveDiagnosticsFile}>Save Diagnostics File</button>
                <button onClick={openDiagnosticsFolder}>Open Diagnostics Folder</button>
                <button onClick={exportSupportBundle}>Export Support Bundle</button>
              </div>
              {diagnosticsState.message && (
                <p className={`diag-text ${diagnosticsState.type || ''}`}>{diagnosticsState.message}</p>
              )}
              {copyDiagnosticsState && <p className="muted">{copyDiagnosticsState}</p>}
              {saveDiagnosticsState && <p className="muted">{saveDiagnosticsState}</p>}
              {openDiagnosticsState && <p className="muted">{openDiagnosticsState}</p>}
              {exportBundleState && <p className="muted">{exportBundleState}</p>}
              {diagnosticsState.lastRunAt && (
                <p className="muted">Diagnostics run at: {new Date(diagnosticsState.lastRunAt).toLocaleString()}</p>
              )}
              {diagnosticsState.details && Object.keys(diagnosticsState.details).length > 0 && (
                <div className="row">
                  <button onClick={() => setShowDiagnosticsDetails((v) => !v)}>
                    {showDiagnosticsDetails ? 'Hide Diagnostics Details' : 'Show Diagnostics Details'}
                  </button>
                </div>
              )}
              {showDiagnosticsDetails && diagnosticsState.details && (
                <div className="diag-details">
                  {Object.entries(diagnosticsState.details).map(([key, value]) => (
                    <p key={key}>
                      <strong>{key}:</strong> {value}
                    </p>
                  ))}
                </div>
              )}
              {compatibility.loading && <p className="muted">Loading compatibility info...</p>}
              {!compatibility.loading && compatibility.error && <p className="error">{compatibility.error}</p>}
              {compatibility.checkedAt && (
                <p className="muted">
                  Last compatibility check: {new Date(compatibility.checkedAt).toLocaleString()}
                </p>
              )}
              {compatibilityIsStale && (
                <p className="warning-text">
                  Compatibility status may be stale (last successful check older than 10 minutes).
                </p>
              )}
              {!compatibility.loading && !compatibility.error && (
                <>
                  <p>App Version: <strong>{compatibility.appVersion || 'unknown'}</strong></p>
                  <p>Current Protocol: <strong>{compatibility.protocolVersion || 'unknown'}</strong></p>
                  <p>
                    Supported Protocol Range:{' '}
                    <strong>
                      {compatibility.supportedProtocolVersions
                        ? `${compatibility.supportedProtocolVersions.min} - ${compatibility.supportedProtocolVersions.max}`
                        : 'unknown'}
                    </strong>
                  </p>
                  <label>
                    Required Extension Version
                    <input
                      type="text"
                      readOnly
                      value={compatibility.minExtensionVersion || ''}
                    />
                  </label>
                  {outdatedTokenCount > 0 && (
                    <p className="error">
                      {outdatedTokenCount} paired extension(s) are below required version {compatibility.minExtensionVersion}.
                    </p>
                  )}
                </>
              )}
              <div className="row">
                <button onClick={loadCompatibility}>Refresh Compatibility</button>
                <button onClick={copyMinExtensionVersion} disabled={!compatibility.minExtensionVersion}>
                  Copy Required Version
                </button>
                <button
                  className="danger"
                  onClick={revokeOutdatedTokens}
                  disabled={!outdatedTokenCount}
                >
                  Revoke Outdated Tokens
                </button>
                {copyState && <span className="muted">{copyState}</span>}
                {revokeState && <span className="muted">{revokeState}</span>}
              </div>
            </div>

            <div className="card">
              <h3>Extension Pairing</h3>
              <button onClick={generatePairingCode}>Generate Pairing Code</button>
              {pairing && (
                <div className="pairing-box">
                  <p>Code: <strong>{pairing.code}</strong></p>
                  <p>Expires: {new Date(pairing.expiresAt).toLocaleString()}</p>
                </div>
              )}

              <h4>Paired Extensions</h4>
              {tokenRows.length === 0 ? <p className="muted">No paired extensions.</p> : (
                <>
                  <div className="token-controls">
                    <label>
                      Filter
                      <select value={tokenFilter} onChange={(e) => setTokenFilter(e.target.value)}>
                        <option value="all">All</option>
                        <option value="outdated">Outdated</option>
                        <option value="compatible">Compatible</option>
                      </select>
                    </label>
                    <label>
                      Sort
                      <select value={tokenSort} onChange={(e) => setTokenSort(e.target.value)}>
                        <option value="status">Status</option>
                        <option value="extension">Extension</option>
                        <option value="version">Version</option>
                      </select>
                    </label>
                  </div>
                  <table className="token-table">
                    <thead>
                      <tr>
                        <th>Extension</th>
                        <th>Version</th>
                        <th>Browser</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTokenRows.map((token) => (
                        <tr key={token.id}>
                          <td>{token.extensionId || 'unknown-extension'}</td>
                          <td>{token.displayVersion}</td>
                          <td>{token.browser || 'chrome'}</td>
                          <td>
                            <span className={`status-pill ${token.status}`}>
                              {token.status}
                            </span>
                          </td>
                          <td>
                            <button className="danger" onClick={() => window.desktop.revokeToken(token.id).then(loadTokens)}>Revoke</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {visibleTokenRows.length === 0 && <p className="muted">No rows match current filter.</p>}
                </>
              )}
              <button className="danger" onClick={() => window.desktop.revokeAllTokens().then(loadTokens)}>Revoke All</button>
            </div>
          </section>
        )}

        {currentView === 'updates' && (
          <section>
            <h2>Updates</h2>
            <div className="card">
              <p>Phase: <strong>{updater.phase}</strong></p>
              <p>{updater.message}</p>
              <p>Progress: {updater.progress || 0}%</p>
              {updater.deferredUntil && (
                <p className="muted">Deferred until: {new Date(updater.deferredUntil).toLocaleString()}</p>
              )}
              {updater.nextReminderAt && (
                <p className="muted">Next reminder: {new Date(updater.nextReminderAt).toLocaleString()}</p>
              )}
              {releaseNotes.length > 0 && (
                <div className="release-notes">
                  <h4>Release Notes</h4>
                  {releaseNotes.map((note, idx) => (
                    <p key={idx} className="muted">{note}</p>
                  ))}
                </div>
              )}
              {updater.error && <p className="error">Error: {updater.error}</p>}
              <div className="row">
                <button onClick={() => window.desktop.checkForUpdates()}>Check for Updates</button>
                <button
                  disabled={updater.phase !== 'downloaded'}
                  onClick={() => window.desktop.installUpdateNow()}
                >
                  Restart and Install
                </button>
                <button
                  disabled={updater.phase !== 'downloaded'}
                  onClick={() => window.desktop.remindLater(30)}
                >
                  Later (30m)
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
