export type UpdaterPhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'installing' | 'error';

export interface UpdaterState {
  phase: UpdaterPhase;
  message: string;
  progress: number;
  currentVersion?: string | null;
  updateInfo?: { version: string } | null;
  lastCheckedAt?: number | null;
  releaseNotes?: string | string[];
  deferredUntil?: number | null;
  nextReminderAt?: number | null;
  error?: string | null;
}
