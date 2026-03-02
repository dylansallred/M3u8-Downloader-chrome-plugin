import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HistoryItem } from '@/types/history';
import { createApiClient } from '@/lib/api';
import { toast } from 'sonner';

const FALLBACK_POLL_MS = 10_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 12_000;
const WS_CONNECT_DEFER_MS = 80;

function toWebSocketUrl(apiBase: string): string {
  return apiBase.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
}

export function useHistory(apiBase: string) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [filterText, setFilterText] = useState('');
  const [filterType, setFilterType] = useState('all');

  const api = useMemo(() => createApiClient(apiBase), [apiBase]);

  const loadHistory = useCallback(async () => {
    const data = await api.getHistory();
    setItems(data?.items || []);
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
        loadHistory().catch(() => {
          // keep fallback polling active
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
        socket.send(JSON.stringify({ type: 'subscribe', channel: 'history' }));
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const message = JSON.parse(String(event.data || ''));
          if (message?.type !== 'history:update') return;
          loadHistory().catch(() => {
            // keep running; fallback polling handles transient failures
          });
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

    loadHistory().catch(() => {
      // initial load best-effort
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
  }, [apiBase, loadHistory]);

  const visibleItems = useMemo(() => {
    const text = String(filterText || '').trim().toLowerCase();
    return (items || []).filter((item) => {
      if (filterType !== 'all') {
        const ext = String(item.ext || '').toLowerCase().replace(/^\./, '');
        if (ext !== filterType) return false;
      }
      if (!text) return true;
      const label = String(item.label || '').toLowerCase();
      const fileName = String(item.fileName || '').toLowerCase();
      return label.includes(text) || fileName.includes(text);
    });
  }, [items, filterText, filterType]);

  const clearAll = useCallback(async () => {
    await api.clearHistory();
    await loadHistory();
    toast.success('History cleared');
  }, [api, loadHistory]);

  const deleteItem = useCallback(async (fileName: string) => {
    await api.deleteHistoryItem(fileName);
    await loadHistory();
    toast.success(`Deleted ${fileName}`);
  }, [api, loadHistory]);

  const openFile = useCallback(async (fileName: string) => {
    try {
      const result = await window.desktop.openHistoryFile(fileName);
      if (!result?.ok) throw new Error(result?.error || 'Failed to open file');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to open file: ${message}`);
    }
  }, []);

  const openFolder = useCallback(async (fileName: string) => {
    try {
      const result = await window.desktop.openHistoryFolder(fileName);
      if (!result?.ok) throw new Error(result?.error || 'Failed to open folder');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to open folder: ${message}`);
    }
  }, []);

  return {
    items,
    visibleItems,
    filterText,
    filterType,
    setFilterText,
    setFilterType,
    clearAll,
    deleteItem,
    openFile,
    openFolder,
    apiBase,
  };
}
