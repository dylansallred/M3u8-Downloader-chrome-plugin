import type { QueueData, QueueSettings, QueueJob } from '@/types/queue';
import type { HistoryItem } from '@/types/history';

async function request<T = unknown>(baseUrl: string, path: string, options: RequestInit = {}): Promise<T | null> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
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
}

export function createApiClient(baseUrl: string) {
  const req = <T = unknown>(path: string, options?: RequestInit) =>
    request<T>(baseUrl, path, options);

  return {
    // Queue
    getQueue: () => req<QueueData>('/api/queue'),
    startJob: (id: string) => req(`/api/queue/${id}/start`, { method: 'POST' }),
    pauseJob: (id: string) => req(`/api/queue/${id}/pause`, { method: 'POST' }),
    resumeJob: (id: string) => req(`/api/queue/${id}/resume`, { method: 'POST' }),
    removeJob: (id: string) => req(`/api/queue/${id}`, { method: 'DELETE' }),
    startAll: () => req('/api/queue/start-all', { method: 'POST' }),
    pauseAll: () => req('/api/queue/pause-all', { method: 'POST' }),
    clearCompleted: () => req('/api/queue/clear-completed', { method: 'POST' }),
    updateQueueSettings: (settings: Partial<QueueSettings>) =>
      req('/api/queue/settings', { method: 'POST', body: JSON.stringify(settings) }),

    // Jobs
    getJob: (id: string) => req<QueueJob>(`/api/jobs/${id}?full=1`),
    cancelJob: (id: string) => req(`/api/jobs/${id}/cancel`, { method: 'POST' }),
    retryJob: (id: string) => req(`/api/jobs/${id}/retry`, { method: 'POST' }),
    retryOriginalHls: (id: string) => req(`/api/jobs/${id}/retry-original-hls`, { method: 'POST' }),

    // History
    getHistory: () => req<{ items: HistoryItem[] }>('/api/history'),
    clearHistory: () => req('/api/history', { method: 'DELETE' }),
    deleteHistoryItem: (fileName: string) =>
      req(`/api/history/${encodeURIComponent(fileName)}`, { method: 'DELETE' }),

    // Health
    getHealth: () =>
      fetch(`${baseUrl}/v1/health`, {
        headers: { 'X-Client': 'vidsnag-extension', 'X-Protocol-Version': '1' },
      }).then((r) => r.json()),

    // Raw request for custom calls
    request: req,
    baseUrl,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
