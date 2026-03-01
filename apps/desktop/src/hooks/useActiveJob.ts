import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueueData, QueueJob, ActiveMetrics } from '@/types/queue';
import { createApiClient } from '@/lib/api';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function useActiveJob(queueData: QueueData, apiBase: string) {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<QueueJob | null>(null);
  const [activeMetrics, setActiveMetrics] = useState<ActiveMetrics>({ speedBps: 0, etaSeconds: null });
  const activeSampleRef = useRef<{ jobId: string; timeMs: number; bytes: number } | null>(null);
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

    let etaSeconds: number | null = null;
    const progress = Number(job.progress || 0);
    if (speedBps > 1 && progress > 0 && progress < 100) {
      const estimatedTotalBytes = bytes / (progress / 100);
      const remainingBytes = Math.max(0, estimatedTotalBytes - bytes);
      etaSeconds = remainingBytes / speedBps;
    }

    setActiveMetrics({ speedBps, etaSeconds });
  }, [activeJob, activeJobId]);

  return { activeJob, activeJobId, activeMetrics };
}
