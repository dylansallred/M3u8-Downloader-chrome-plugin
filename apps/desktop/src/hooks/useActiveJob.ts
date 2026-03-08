import { useEffect, useMemo, useRef, useState } from 'react';
import type { QueueData, QueueJob, ActiveMetrics } from '@/types/queue';
import { createApiClient } from '@/lib/api';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SPEED_HOLD_WINDOW_MS = 4_000;
const ETA_HOLD_WINDOW_MS = 6_000;
const SPEED_DROP_TO_ZERO_MS = 20_000;
const MIN_SAMPLE_INTERVAL_MS = 750;
const MIN_SAMPLE_BYTES = 32 * 1024;

interface JobSample {
  timeMs: number;
  bytes: number;
  lastByteChangeAt: number;
}

interface JobMetricState {
  speedBps: number;
  etaSeconds: number | null;
  lastEtaAt: number;
}

// Keep estimator state across Queue tab unmount/remount.
const persistedSampleByJobId = new Map<string, JobSample>();
const persistedMetricStateByJobId = new Map<string, JobMetricState>();
const persistedMetricsByJobId = new Map<string, ActiveMetrics>();
const persistedJobDetailsById = new Map<string, QueueJob>();

function resolveJobStatus(job: QueueJob): string {
  return String(job.queueStatus || job.status || '').toLowerCase();
}

function buildJobMetrics(job: QueueJob): ActiveMetrics {
  const status = resolveJobStatus(job);
  if (status !== 'downloading') {
    return { speedBps: 0, etaSeconds: null };
  }

  const bytes = Number(job.bytesDownloaded || 0);
  const totalBytes = Number(job.totalBytes || 0);
  const progress = Number(job.progress || 0);
  const serverSpeed = Number(job.speedBps || 0);
  const speedBps = Number.isFinite(serverSpeed) && serverSpeed > 0 ? serverSpeed : 0;

  const rawEta = Number(job.etaSeconds);
  if (Number.isFinite(rawEta) && rawEta > 0) {
    return { speedBps, etaSeconds: rawEta };
  }

  if (speedBps > 1 && Number.isFinite(totalBytes) && totalBytes > bytes) {
    return { speedBps, etaSeconds: (totalBytes - bytes) / speedBps };
  }

  if (speedBps > 1 && progress > 0 && progress < 100) {
    const estimatedTotalBytes = bytes / (progress / 100);
    const remainingBytes = Math.max(0, estimatedTotalBytes - bytes);
    return { speedBps, etaSeconds: remainingBytes / speedBps };
  }

  return { speedBps, etaSeconds: null };
}

export function useActiveJob(queueData: QueueData, apiBase: string) {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobDetails, setActiveJobDetails] = useState<QueueJob | null>(null);
  const [metricsByJobId, setMetricsByJobId] = useState<Map<string, ActiveMetrics>>(
    () => new Map(persistedMetricsByJobId),
  );
  const sampleByJobIdRef = useRef<Map<string, JobSample>>(persistedSampleByJobId);
  const metricStateByJobIdRef = useRef<Map<string, JobMetricState>>(persistedMetricStateByJobId);

  const queue = Array.isArray(queueData.queue) ? queueData.queue : [];
  const api = useMemo(() => createApiClient(apiBase), [apiBase]);

  const activeJob = useMemo(() => {
    if (!activeJobId) return null;
    const baseJob = queue.find((job) => job.id === activeJobId) || null;
    if (!baseJob) return null;
    if (activeJobDetails && activeJobDetails.id === baseJob.id) {
      return { ...baseJob, ...activeJobDetails };
    }
    return baseJob;
  }, [queue, activeJobId, activeJobDetails]);

  const mergedQueue = useMemo(() => (
    queue.map((job) => {
      if (activeJobDetails && activeJobDetails.id === job.id) {
        return { ...job, ...activeJobDetails };
      }
      return job;
    })
  ), [queue, activeJobDetails]);

  useEffect(() => {
    if (queue.length === 0) {
      setActiveJobId(null);
      return;
    }

    const preferred = queue.find((j) => {
      const status = resolveJobStatus(j);
      return status === 'downloading' || status === 'queued' || status === 'paused';
    });

    if (!preferred) {
      setActiveJobId(null);
      return;
    }

    const hasCurrent = !!activeJobId && queue.some((j) => j.id === activeJobId);
    if (!hasCurrent) {
      setActiveJobId(preferred.id);
      return;
    }

    const current = queue.find((j) => j.id === activeJobId);
    if (current && TERMINAL_STATUSES.has(resolveJobStatus(current))) {
      setActiveJobId(preferred.id);
    }
  }, [queue, activeJobId]);

  // Subscribe to active job detail so segment/thread state is always available for the heatmap.
  useEffect(() => {
    if (!activeJobId) {
      setActiveJobDetails(null);
      return;
    }

    setActiveJobDetails(persistedJobDetailsById.get(activeJobId) || null);

    let ws: WebSocket | null = null;
    let wsConnected = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const wsUrl = `${apiBase.replace('http', 'ws').replace(/\/+$/, '')}/ws`;

    const applyDetail = (job: QueueJob | null) => {
      if (!job || job.id !== activeJobId || cancelled) return;
      persistedJobDetailsById.set(job.id, job);
      setActiveJobDetails(job);
    };

    const poll = async () => {
      if (wsConnected || cancelled) return;
      try {
        const job = await api.getJob(activeJobId);
        applyDetail(job || null);
        if (!cancelled) schedulePoll(1000);
      } catch {
        if (!cancelled) schedulePoll(3000);
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
        ws?.send(JSON.stringify({ type: 'subscribe', jobId: activeJobId }));
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data || ''));
          if (message?.type === 'job:update' && message?.data?.id === activeJobId) {
            applyDetail(message.data as QueueJob);
          }
        } catch {
          // Ignore malformed messages.
        }
      };
      ws.onclose = () => {
        wsConnected = false;
        if (!cancelled) schedulePoll(1000);
      };
      ws.onerror = () => {
        // onclose handles fallback polling
      };
    } catch {
      // Fall through to polling.
    }

    poll();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, [activeJobId, api, apiBase]);

  useEffect(() => {
    const now = Date.now();
    const nextMetrics = new Map<string, ActiveMetrics>();
    const sampleByJobId = sampleByJobIdRef.current;
    const metricStateByJobId = metricStateByJobIdRef.current;
    const seenJobIds = new Set<string>();

    for (const job of mergedQueue) {
      seenJobIds.add(job.id);
      const status = resolveJobStatus(job);
      const bytes = Number(job.bytesDownloaded || 0);
      const totalBytes = Number(job.totalBytes || 0);
      const progress = Number(job.progress || 0);
      const rawServerSpeed = Number(job.speedBps || 0);
      const serverSpeed = Number.isFinite(rawServerSpeed) && rawServerSpeed > 0 ? rawServerSpeed : 0;
      const rawServerEta = Number(job.etaSeconds);
      const serverEta = Number.isFinite(rawServerEta) && rawServerEta > 0 ? rawServerEta : null;
      const sampleTime = Number.isFinite(Number(job.updatedAt)) && Number(job.updatedAt) > 0
        ? Number(job.updatedAt)
        : now;

      const prevSample = (sampleByJobId.get(job.id) || {
        timeMs: sampleTime,
        bytes,
        lastByteChangeAt: sampleTime,
      }) as JobSample;
      const prevMetric = metricStateByJobId.get(job.id) || {
        speedBps: 0,
        etaSeconds: null,
        lastEtaAt: 0,
      };

      let speedBps = Number(prevMetric.speedBps || 0);
      if (status !== 'downloading') {
        speedBps = 0;
      } else if (serverSpeed > 0) {
        speedBps = speedBps > 0 ? (speedBps * 0.2) + (serverSpeed * 0.8) : serverSpeed;
      } else {
        const dtMs = Math.max(0, sampleTime - prevSample.timeMs);
        const dt = Math.max(0.001, dtMs / 1000);
        const db = Math.max(0, bytes - prevSample.bytes);
        if (db >= MIN_SAMPLE_BYTES && dtMs >= MIN_SAMPLE_INTERVAL_MS) {
          const instant = db / dt;
          const clampedInstant = speedBps > 0 ? Math.min(instant, speedBps * 2.5) : instant;
          speedBps = speedBps > 0 ? (speedBps * 0.75) + (clampedInstant * 0.25) : clampedInstant;
        } else {
          const idleMs = sampleTime - prevSample.lastByteChangeAt;
          if (idleMs > SPEED_HOLD_WINDOW_MS) {
            speedBps = idleMs >= SPEED_DROP_TO_ZERO_MS ? 0 : speedBps * 0.92;
          }
        }
      }

      if (!Number.isFinite(speedBps) || speedBps < 0) {
        speedBps = 0;
      }

      let etaSeconds: number | null = null;
      if (status !== 'downloading') {
        etaSeconds = null;
      } else if (serverEta != null) {
        etaSeconds = serverEta;
      } else if (speedBps > 1 && Number.isFinite(totalBytes) && totalBytes > bytes) {
        etaSeconds = (totalBytes - bytes) / speedBps;
      } else if (speedBps > 1 && progress > 0 && progress < 100) {
        const estimatedTotalBytes = bytes / (progress / 100);
        const remainingBytes = Math.max(0, estimatedTotalBytes - bytes);
        etaSeconds = remainingBytes / speedBps;
      } else if (
        prevMetric.etaSeconds != null
        && now - Number(prevMetric.lastEtaAt || 0) <= ETA_HOLD_WINDOW_MS
      ) {
        etaSeconds = prevMetric.etaSeconds;
      }

      nextMetrics.set(job.id, { speedBps, etaSeconds });
      sampleByJobId.set(job.id, {
        timeMs: sampleTime,
        bytes,
        lastByteChangeAt: bytes > prevSample.bytes ? sampleTime : prevSample.lastByteChangeAt,
      });
      metricStateByJobId.set(job.id, {
        speedBps,
        etaSeconds,
        lastEtaAt: etaSeconds != null ? now : prevMetric.lastEtaAt,
      });
    }

    for (const jobId of Array.from(sampleByJobId.keys())) {
      if (!seenJobIds.has(jobId)) {
        sampleByJobId.delete(jobId);
        metricStateByJobId.delete(jobId);
        persistedMetricsByJobId.delete(jobId);
        persistedJobDetailsById.delete(jobId);
      }
    }

    persistedMetricsByJobId.clear();
    for (const [jobId, metric] of nextMetrics.entries()) {
      persistedMetricsByJobId.set(jobId, metric);
    }
    setMetricsByJobId(nextMetrics);
  }, [mergedQueue]);

  const activeMetrics = activeJob
    ? (metricsByJobId.get(activeJob.id) || buildJobMetrics(activeJob))
    : { speedBps: 0, etaSeconds: null };

  return { activeJob, activeJobId, activeMetrics, setActiveJobId };
}
