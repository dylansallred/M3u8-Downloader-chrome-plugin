import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CompatibilityInfo } from '@/types/compatibility';

const LONG_REFRESH_MS = 5 * 60 * 1000;
const FALLBACK_REFRESH_MS = 60 * 1000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 12_000;
const WS_CONNECT_DEFER_MS = 80;

function toWebSocketUrl(apiBase: string): string {
  return apiBase.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
}

export function useCompatibility(apiBase: string) {
  const [compatibility, setCompatibility] = useState<CompatibilityInfo>({
    loading: true,
    error: null,
    appVersion: null,
    protocolVersion: null,
    supportedProtocolVersions: null,
    minExtensionVersion: null,
    checkedAt: null,
    lastSuccessAt: null,
  });
  const [clockNow, setClockNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    const now = Date.now();
    try {
      const res = await fetch(`${apiBase}/v1/health`, {
        headers: { 'X-Client': 'vidsnag-extension', 'X-Protocol-Version': '1' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCompatibility((prev) => ({
        loading: false,
        error: `Unable to read compatibility info: ${message}`,
        appVersion: prev.appVersion,
        protocolVersion: prev.protocolVersion,
        supportedProtocolVersions: prev.supportedProtocolVersions,
        minExtensionVersion: prev.minExtensionVersion,
        checkedAt: now,
        lastSuccessAt: prev.lastSuccessAt || null,
      }));
      return { ok: false, error: message };
    }
  }, [apiBase]);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectDelay = WS_RECONNECT_BASE_MS;

    const stopFallback = () => {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const startFallback = () => {
      if (fallbackTimer || disposed) return;
      fallbackTimer = setInterval(() => {
        refresh().catch(() => {
          // keep fallback active while websocket is disconnected
        });
      }, FALLBACK_REFRESH_MS);
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
        startFallback();
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
        stopFallback();
        socket.send(JSON.stringify({ type: 'subscribe', channel: 'compatibility' }));
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const message = JSON.parse(String(event.data || ''));
          if (message?.type !== 'compatibility:update' || !message?.data) return;
          const now = Date.now();
          setCompatibility({
            loading: false,
            error: null,
            appVersion: message.data.appVersion || null,
            protocolVersion: message.data.protocolVersion || null,
            supportedProtocolVersions: message.data.supportedProtocolVersions || null,
            minExtensionVersion: message.data.minExtensionVersion || null,
            checkedAt: now,
            lastSuccessAt: now,
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
        startFallback();
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

    refresh().catch(() => {
      // initial load is best-effort
    });
    const periodicTimer = setInterval(() => {
      refresh().catch(() => {
        // keep periodic check best-effort
      });
    }, LONG_REFRESH_MS);

    startFallback();
    scheduleConnect();

    return () => {
      disposed = true;
      stopFallback();
      clearInterval(periodicTimer);
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
  }, [apiBase, refresh]);

  const isStale = useMemo(() => {
    const thresholdMs = 10 * 60 * 1000;
    if (!compatibility.lastSuccessAt) return true;
    return clockNow - compatibility.lastSuccessAt > thresholdMs;
  }, [compatibility.lastSuccessAt, clockNow]);

  return { compatibility, isStale, refresh, clockNow };
}
