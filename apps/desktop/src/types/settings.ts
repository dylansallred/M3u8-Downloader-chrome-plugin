export interface DesktopSettings {
  queueMaxConcurrent: number;
  queueAutoStart: boolean;
  checkUpdatesOnStartup: boolean;
  outputDirectory: string;
  tmdbApiKey?: string;
  subdlApiKey?: string;
  downloadThreads: number;
}
