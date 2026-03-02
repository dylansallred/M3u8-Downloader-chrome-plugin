import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueueData, QueueJob, ActiveMetrics } from '@/types/queue';
import { createApiClient } from '@/lib/api';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SPEED_HOLD_WINDOW_MS = 4_000;
const ETA_HOLD_WINDOW_MS = 6_000;
const SPEED_DROP_TO_ZERO_MS = 20_000;

interface ActiveSample {
  jobId: string;
  timeMs: number;
  bytes: number;
  lastByteChangeAt: number;
}

interface MetricsState {
  speedBps: number;
  etaSeconds: number | null;
  lastEtaAt: number;
}

export function useActiveJob(queueData: QueueData, apiBase: string) {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<QueueJob | null>(null);
  const [activeMetrics, setActiveMetrics] = useState<ActiveMetrics>({ speedBps: 0, etaSeconds: null });
  const activeSampleRef = useRef<ActiveSample | null>(null);
  const metricsRef = useRef<MetricsState>({ speedBps: 0, etaSeconds: null, lastEtaAt: 0 });
  const activeJobIdRef = useRef<string | null>(null);

  const api = useMemo(() => createApiClient(apiBase), [apiBase]);

  // Keep ref in sync with state
  useEffect(() => {
    activeJobIdRef.current = activeJobId;
  }, [activeJobId]);

  // Handle incoming job data — clear immediately if terminal
  const handleJobUpdate = useCallback((job: QueueJob) => {
    if (job.id !== activeJobIdRef.current) return;

    const status = job.queueStatus || job.status;
    if (TERMINAL_STATUSES.has(status || '')) {
      activeJobIdRef.current = null;
      setActiveJobId(null);
      setActiveJob(null);
      return;
    }

    setActiveJob(job);
  }, []);

  // Auto-select active job from queue
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

  // WebSocket subscription + poll fallback (only polls when WS is down)
  useEffect(() => {
    if (!activeJobId) return;

    let ws: WebSocket | null = null;
    let wsConnected = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const wsUrl = `${apiBase.replace('http', 'ws')}/ws`;

    const poll = async () => {
      if (wsConnected || cancelled) return;
      try {
        const job = await api.getJob(activeJobId);
        if (!cancelled && job) handleJobUpdate(job);
        if (!cancelled) schedulePoll(1000);
      } catch {
        if (!cancelled) schedulePoll(5000);
      }
    };

    const schedulePoll = (delay: number) => {
      if (pollTimer) clearTimeout(pollTimer);
      if (cancelled) return;
      pollTimer = setTimeout(poll, delay);
    };

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        wsConnected = true;
        ws!.send(JSON.stringify({ type: 'subscribe', jobId: activeJobId }));
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message?.type === 'job:update' && message?.data?.id === activeJobId) {
          if (!cancelled) handleJobUpdate(message.data);
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        wsConnected = false;
        if (!cancelled) schedulePoll(1000);
      };
    } catch {
      // WS failed to connect; fall back to polling immediately
    }

    // Initial fetch + start polling as fallback until WS connects
    poll();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, [activeJobId, apiBase, api, handleJobUpdate]);

  // Speed/ETA metrics calculation
  useEffect(() => {
    const job = activeJob;
    if (!job || !activeJobId) {
      activeSampleRef.current = null;
      metricsRef.current = { speedBps: 0, etaSeconds: null, lastEtaAt: 0 };
      setActiveMetrics({ speedBps: 0, etaSeconds: null });
      return;
    }

    const status = String(job.queueStatus || job.status || '');
    const now = Date.now();
    const bytes = Number(job.bytesDownloaded || 0);
    const totalBytes = Number(job.totalBytes || 0);
    const serverSpeedBps = Number(job.speedBps || 0);
    const serverEtaRaw = Number(job.etaSeconds);
    const serverEtaSeconds = Number.isFinite(serverEtaRaw) && serverEtaRaw > 0
      ? serverEtaRaw
      : null;
    const prev = activeSampleRef.current;
    let speedBps = Number(metricsRef.current.speedBps || 0);

    if (prev && prev.jobId === activeJobId && bytes >= prev.bytes) {
      const dt = Math.max(0.001, (now - prev.timeMs) / 1000);
      const db = bytes - prev.bytes;
      if (db > 0) {
        const instant = db / dt;
        speedBps = speedBps > 0 ? (speedBps * 0.72) + (instant * 0.28) : instant;
        prev.lastByteChangeAt = now;
      } else if (status === 'downloading') {
        const idleMs = now - prev.lastByteChangeAt;
        if (idleMs > SPEED_HOLD_WINDOW_MS) {
          if (idleMs >= SPEED_DROP_TO_ZERO_MS) {
            speedBps = 0;
          } else {
            // Gradual decay for brief stalls so speed/ETA do not flicker.
            speedBps *= 0.92;
          }
        }
      } else {
        speedBps = 0;
      }
    } else {
      speedBps = 0;
    }

    if (!Number.isFinite(speedBps) || speedBps < 0) {
      speedBps = 0;
    }

    if (status === 'downloading' && Number.isFinite(serverSpeedBps) && serverSpeedBps > 0) {
      speedBps = speedBps > 0
        ? (speedBps * 0.4) + (serverSpeedBps * 0.6)
        : serverSpeedBps;
    }

    activeSampleRef.current = {
      jobId: activeJobId,
      timeMs: now,
      bytes,
      lastByteChangeAt: prev && prev.jobId === activeJobId ? prev.lastByteChangeAt : now,
    };

    let etaSeconds: number | null = null;
    const progress = Number(job.progress || 0);
    if (status === 'downloading' && serverEtaSeconds != null) {
      etaSeconds = serverEtaSeconds;
    } else if (
      status === 'downloading'
      && speedBps > 1
      && Number.isFinite(totalBytes)
      && totalBytes > bytes
    ) {
      etaSeconds = (totalBytes - bytes) / speedBps;
    } else if (status === 'downloading' && speedBps > 1 && progress > 0 && progress < 100) {
      const estimatedTotalBytes = bytes / (progress / 100);
      const remainingBytes = Math.max(0, estimatedTotalBytes - bytes);
      etaSeconds = remainingBytes / speedBps;
    } else if (
      status === 'downloading'
      && metricsRef.current.etaSeconds != null
      && now - metricsRef.current.lastEtaAt <= ETA_HOLD_WINDOW_MS
    ) {
      etaSeconds = metricsRef.current.etaSeconds;
    }

    metricsRef.current = {
      speedBps,
      etaSeconds,
      lastEtaAt: etaSeconds != null ? now : metricsRef.current.lastEtaAt,
    };
    setActiveMetrics({ speedBps, etaSeconds });
  }, [activeJob, activeJobId]);

  return { activeJob, activeJobId, activeMetrics };
}
