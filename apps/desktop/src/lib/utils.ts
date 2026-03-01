import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { QueueJob, QueueStatus } from '@/types/queue';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const QUEUE_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function parseVersionParts(input: string | undefined | null): number[] {
  return String(input || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .map((value) => (Number.isFinite(value) && value >= 0 ? value : 0));
}

export function compareVersions(a: string | undefined | null, b: string | undefined | null): number {
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

export function formatBytesPerSecond(value: number | undefined | null): string {
  const bps = Number(value || 0);
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

export function formatEta(seconds: number | null | undefined): string {
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

export function normalizeReleaseNotes(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  return [];
}

export function getQueueStatusLabel(status: string | undefined | null): string {
  return QUEUE_STATUS_LABELS[status || ''] || String(status || 'unknown');
}

/** Resolve the effective status from either queueStatus or status field */
export function resolveJobStatus(job: { queueStatus?: string; status?: string } | null | undefined): string {
  return job?.queueStatus || job?.status || 'unknown';
}

export function getQueuePrimaryAction(job: QueueJob | null): { label: string; endpoint: string } | null {
  if (!job?.id) return null;
  const status = resolveJobStatus(job);
  if (status === 'queued') {
    return { label: 'Start', endpoint: `/api/queue/${job.id}/start` };
  }
  if (status === 'downloading') {
    return { label: 'Pause', endpoint: `/api/queue/${job.id}/pause` };
  }
  if (status === 'paused') {
    return { label: 'Resume', endpoint: `/api/queue/${job.id}/resume` };
  }
  if (['failed', 'cancelled'].includes(status)) {
    return { label: 'Retry', endpoint: `/api/jobs/${job.id}/retry` };
  }
  return null;
}

export function resolveThumbnailUrl(url: string | null | undefined, apiBase: string): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `${apiBase}${url}`;
  return url;
}

export function extractYear(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{4})/);
  return match ? match[1] : null;
}

export function formatRuntime(minutes: number | null | undefined): string | null {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
