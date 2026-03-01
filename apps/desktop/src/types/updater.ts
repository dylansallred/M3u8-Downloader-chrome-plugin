export type UpdaterPhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';

export interface UpdaterState {
  phase: UpdaterPhase;
  message: string;
  progress: number;
  updateInfo?: { version: string } | null;
  releaseNotes?: string | string[];
  deferredUntil?: number | null;
  nextReminderAt?: number | null;
  error?: string | null;
}
