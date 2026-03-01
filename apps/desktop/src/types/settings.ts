export interface DesktopSettings {
  queueMaxConcurrent: number;
  queueAutoStart: boolean;
  checkUpdatesOnStartup: boolean;
  tmdbApiKey?: string;
  subdlApiKey?: string;
  downloadThreads: number;
}
