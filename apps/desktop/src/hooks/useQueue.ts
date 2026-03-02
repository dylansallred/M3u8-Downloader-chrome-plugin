import { useCallback, useEffect, useMemo, useState } from 'react';
import type { QueueData, QueueJob, QueueSummary } from '@/types/queue';
import { createApiClient } from '@/lib/api';

const FALLBACK_POLL_MS = 5_000;
const ACTIVE_REFRESH_MS = 1_000;
const IDLE_REFRESH_MS = 2_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 12_000;
const WS_CONNECT_DEFER_MS = 80;

function toWebSocketUrl(apiBase: string): string {
  return apiBase.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
}

export function useQueue(apiBase: string) {
  const [queueData, setQueueData] = useState<QueueData>({ queue: [], settings: { maxConcurrent: 1, autoStart: true } });
  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  const api = useMemo(() => createApiClient(apiBase), [apiBase]);

  const loadQueue = useCallback(async () => {
    const data = await api.getQueue();
    setQueueData(data || { queue: [], settings: { maxConcurrent: 1, autoStart: true } });
    return data;
  }, [api]);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectDelay = WS_RECONNECT_BASE_MS;

    const stopFallbackPolling = () => {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const startFallbackPolling = () => {
      if (fallbackTimer || disposed) return;
      fallbackTimer = setInterval(() => {
        loadQueue().catch(() => {
          // keep fallback polling alive until websocket reconnects
        });
      }, FALLBACK_POLL_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        scheduleConnect();
      }, reconnectDelay);
      reconnectDelay = Math.min(WS_RECONNECT_MAX_MS, reconnectDelay * 2);
    };

    const connect = () => {
      if (disposed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(toWebSocketUrl(apiBase));
      } catch {
        startFallbackPolling();
        scheduleReconnect();
        return;
      }
      ws = socket;

      socket.onopen = () => {
        if (disposed) {
          socket.close();
          return;
        }
        reconnectDelay = WS_RECONNECT_BASE_MS;
        stopFallbackPolling();
        socket.send(JSON.stringify({ type: 'subscribe', channel: 'queue' }));
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const message = JSON.parse(String(event.data || ''));
          if (message?.type !== 'queue:update' || !message?.data) return;
          const incoming = message.data as QueueData;
          if (!Array.isArray(incoming.queue) || !incoming.settings) return;
          setQueueData(incoming);
        } catch {
          // Ignore malformed websocket payloads.
        }
      };

      socket.onerror = () => {
        // onclose handles reconnect/poll fallback
      };

      socket.onclose = () => {
        if (disposed) return;
        startFallbackPolling();
        scheduleReconnect();
      };
    };

    const scheduleConnect = () => {
      if (disposed || connectTimer) return;
      connectTimer = setTimeout(() => {
        connectTimer = null;
        connect();
      }, WS_CONNECT_DEFER_MS);
    };

    loadQueue().catch(() => {
      // initial fallback happens through polling if websocket cannot connect
    });
    startFallbackPolling();
    scheduleConnect();

    return () => {
      disposed = true;
      stopFallbackPolling();
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        // Avoid "closed before established" warnings in React StrictMode.
        ws.onopen = () => ws?.close();
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
      }
    };
  }, [apiBase, loadQueue]);

  useEffect(() => {
    const hasActiveDownloads = (queueData.queue || []).some((job) =>
      job.queueStatus === 'downloading' || job.queueStatus === 'queued',
    );
    const intervalMs = hasActiveDownloads ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;

    const timer = setInterval(() => {
      loadQueue().catch(() => {
        // WebSocket is primary; this is a safety refresh path.
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [queueData.queue, loadQueue]);

  useEffect(() => {
    const onVisibleOrFocused = () => {
      loadQueue().catch(() => {
        // best effort refresh when window regains visibility/focus
      });
    };

    window.addEventListener('focus', onVisibleOrFocused);
    document.addEventListener('visibilitychange', onVisibleOrFocused);
    return () => {
      window.removeEventListener('focus', onVisibleOrFocused);
      document.removeEventListener('visibilitychange', onVisibleOrFocused);
    };
  }, [loadQueue]);

  const callAction = useCallback(async (endpoint: string, method = 'POST', body?: unknown) => {
    await api.request(endpoint, {
      method,
      body: body ? JSON.stringify(body) : undefined,
    });
    await loadQueue();
  }, [api, loadQueue]);

  const visibleRows = useMemo(() => {
    const text = String(filterText || '').trim().toLowerCase();
    return (queueData.queue || []).filter((job: QueueJob) => {
      if (filterStatus !== 'all' && job.queueStatus !== filterStatus) return false;
      if (!text) return true;
      const title = String(job.title || '').toLowerCase();
      const id = String(job.id || '').toLowerCase();
      return title.includes(text) || id.includes(text);
    });
  }, [queueData.queue, filterText, filterStatus]);

  const summary = useMemo((): QueueSummary => {
    const queue = Array.isArray(queueData.queue) ? queueData.queue : [];
    const counts = queue.reduce<Record<string, number>>((acc, job) => {
      const key = String(job.queueStatus || 'unknown');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      total: queue.length,
      queued: counts.queued || 0,
      downloading: counts.downloading || 0,
      paused: counts.paused || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      cancelled: counts.cancelled || 0,
    };
  }, [queueData.queue]);

  return {
    queueData,
    visibleRows,
    summary,
    filterText,
    filterStatus,
    setFilterText,
    setFilterStatus,
    callAction,
    loadQueue,
    api,
  };
}
