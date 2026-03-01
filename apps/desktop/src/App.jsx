import React, { useEffect, useMemo, useState } from 'react';

const NAV = [
  { id: 'active', label: 'Active Download' },
  { id: 'queue', label: 'Queue' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
  { id: 'updates', label: 'Updates' },
];

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

  const apiBase = useMemo(() => appInfo?.apiBaseUrl || 'http://127.0.0.1:49732', [appInfo]);

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
  };

  const loadHistory = async () => {
    const data = await request('/api/history');
    setHistoryItems(data?.items || []);
  };

  const loadTokens = async () => {
    if (!window.desktop) return;
    const nextTokens = await window.desktop.listTokens();
    setTokens(nextTokens || []);
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
        await Promise.all([loadQueue(), loadHistory(), loadTokens()]);
      } catch (err) {
        setStatus(`Refresh error: ${err.message}`);
      }
    };

    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [appInfo]);

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

  const callQueueAction = async (endpoint, method = 'POST', body = null) => {
    await request(endpoint, {
      method,
      body: body ? JSON.stringify(body) : undefined,
    });
    await loadQueue();
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
                <p>Progress: <strong>{activeJob.progress || 0}%</strong></p>
                <p>Segments: {activeJob.completedSegments || 0}/{activeJob.totalSegments || 0}</p>
                <p>Downloaded: {Math.round((activeJob.bytesDownloaded || 0) / (1024 * 1024))} MB</p>
                <div className="row">
                  <button onClick={() => callQueueAction(`/api/queue/${activeJob.id}/pause`)}>Pause</button>
                  <button onClick={() => callQueueAction(`/api/queue/${activeJob.id}/resume`)}>Resume</button>
                  <button className="danger" onClick={() => callQueueAction(`/api/jobs/${activeJob.id}/cancel`)}>Cancel</button>
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
              {queueData.queue?.length ? queueData.queue.map((job) => (
                <article key={job.id} className="card">
                  <h3>{job.title}</h3>
                  <p>{job.queueStatus} | {job.progress || 0}%</p>
                  <div className="row">
                    <button onClick={() => setActiveJobId(job.id)}>Focus</button>
                    <button onClick={() => callQueueAction(`/api/queue/${job.id}/start`)}>Start</button>
                    <button onClick={() => callQueueAction(`/api/queue/${job.id}/pause`)}>Pause</button>
                    <button onClick={() => callQueueAction(`/api/queue/${job.id}/resume`)}>Resume</button>
                    <button className="danger" onClick={() => callQueueAction(`/api/queue/${job.id}`, 'DELETE')}>Remove</button>
                  </div>
                </article>
              )) : <p className="muted">Queue is empty.</p>}
            </div>
          </section>
        )}

        {currentView === 'history' && (
          <section>
            <h2>History</h2>
            <div className="row">
              <button onClick={() => callQueueAction('/api/history', 'DELETE').then(loadHistory)}>Clear History</button>
            </div>
            <div className="list">
              {historyItems.length ? historyItems.map((item) => (
                <article key={item.id} className="card">
                  <h3>{item.label}</h3>
                  <p>{Math.round(item.sizeBytes / (1024 * 1024))} MB</p>
                  <div className="row">
                    <a href={`${apiBase}/api/history/file/${encodeURIComponent(item.fileName)}`} target="_blank" rel="noreferrer">Download</a>
                    <a href={`${apiBase}/api/history/stream/${encodeURIComponent(item.fileName)}`} target="_blank" rel="noreferrer">Stream</a>
                    <button className="danger" onClick={() => callQueueAction(`/api/history/${encodeURIComponent(item.fileName)}`, 'DELETE').then(loadHistory)}>Delete</button>
                  </div>
                </article>
              )) : <p className="muted">No history yet.</p>}
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
              <h3>Extension Pairing</h3>
              <button onClick={generatePairingCode}>Generate Pairing Code</button>
              {pairing && (
                <div className="pairing-box">
                  <p>Code: <strong>{pairing.code}</strong></p>
                  <p>Expires: {new Date(pairing.expiresAt).toLocaleString()}</p>
                </div>
              )}

              <h4>Paired Tokens</h4>
              {tokens.length === 0 ? <p className="muted">No paired extensions.</p> : (
                <ul>
                  {tokens.map((token) => (
                    <li key={token.id}>
                      <span>{token.extensionId || 'unknown-extension'} ({token.browser})</span>
                      <button className="danger" onClick={() => window.desktop.revokeToken(token.id).then(loadTokens)}>Revoke</button>
                    </li>
                  ))}
                </ul>
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
              {updater.error && <p className="error">Error: {updater.error}</p>}
              <div className="row">
                <button onClick={() => window.desktop.checkForUpdates()}>Check for Updates</button>
                <button
                  disabled={updater.phase !== 'downloaded'}
                  onClick={() => window.desktop.installUpdateNow()}
                >
                  Restart and Install
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
