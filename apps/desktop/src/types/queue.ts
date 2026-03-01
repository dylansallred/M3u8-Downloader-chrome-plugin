export type QueueStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type SegmentStatus = 'pending' | 'downloading' | 'completed' | 'retrying' | 'failed';

export interface SegmentState {
  status: SegmentStatus;
  attempt: number;
}

export interface ThreadState {
  workerId: number;
  segmentIndex: number | null;
  status: string;
}

export interface TmdbMetadata {
  overview?: string;
  runtime?: number;
  tagline?: string;
  genres?: string[];
  mediaType?: 'movie' | 'tv';
}

export interface QueueJob {
  id: string;
  title: string;
  url: string;
  queueStatus: QueueStatus;
  status: string;
  progress: number;
  totalSegments: number;
  completedSegments: number;
  bytesDownloaded: number;
  error: string | null;
  fallbackUsed: boolean;
  fallbackUrl: string | null;
  originalHlsUrl: string | null;
  createdAt: number;
  updatedAt: number;
  thumbnailUrls?: string[];
  tmdbId?: number;
  tmdbTitle?: string;
  tmdbReleaseDate?: string;
  tmdbMetadata?: TmdbMetadata | null;
  segmentStates?: Record<string, SegmentState>;
  threadStates?: ThreadState[];
}

export interface QueueSettings {
  maxConcurrent: number;
  autoStart: boolean;
}

export interface QueueData {
  queue: QueueJob[];
  settings: QueueSettings;
}

export interface QueueSummary {
  total: number;
  queued: number;
  downloading: number;
  paused: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface ActiveMetrics {
  speedBps: number;
  etaSeconds: number | null;
}
