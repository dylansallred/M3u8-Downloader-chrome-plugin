import { useCallback, useEffect, useMemo, useState } from 'react';
import type { QueueData, QueueJob, QueueSummary } from '@/types/queue';
import { createApiClient } from '@/lib/api';

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
    loadQueue();
    const timer = setInterval(loadQueue, 2000);
    return () => clearInterval(timer);
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
